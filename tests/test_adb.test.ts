/**
 * adb 底层封装测试——全部不需要连接真机
 * （Python `tests/test_adb.py` 的对应物，用例一一对应）。
 *
 * Python 侧 patch `asyncio.create_subprocess_exec` + `which_adb` 使测试封闭；
 * TS 侧等价地：
 *   * mock `node:child_process` 的 `spawn`（子进程层，对应 create_subprocess_exec）；
 *   * 「whichAdb 命中 PATH」用例用真实临时目录里的假 adb + `vi.stubEnv("PATH")`
 *     （`whichBinary` 即 `shutil.which` 的对应物）；
 *   * mock `node:fs` 的 `existsSync`（仅「模拟器路径回退」用例需要，
 *     对应 Python patch `pathlib.Path.exists`）。
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ADBResult, adb, shell, whichAdb } from "../src/device/adb";
import { ADBError } from "../src/utils/errors";
import {
  captureRejection,
  makeFakeProc,
  makeTempAdbOnPath,
  removeTempDir,
  type FakeProcSpec,
} from "./helpers";

/** `vi.mock` 工厂（提升到文件顶）与用例体共享的可变桩状态。 */
const mocks = vi.hoisted(() => ({
  /** 当前用例注入的 spawn 实现；null 时说明该用例不应触发子进程。 */
  spawnImpl: null as null | ((file: string, args: readonly string[], opts: unknown) => unknown),
  /** node:fs.existsSync 替身；null 时透传真实实现。 */
  existsSyncImpl: null as null | ((path: string) => boolean),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (file: string, args: readonly string[], opts: unknown) => {
      if (mocks.spawnImpl === null) {
        throw new Error("测试未配置 spawnImpl 却触发了子进程调用");
      }
      return mocks.spawnImpl(file, args, opts);
    },
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) =>
      mocks.existsSyncImpl === null
        ? actual.existsSync(path)
        : mocks.existsSyncImpl(path as string),
  };
});

/** 对应 Python 的 fake_adb_bin fixture：PATH 指向含假 adb 的临时目录。 */
let binDir = "";

beforeEach(() => {
  binDir = makeTempAdbOnPath().binDir;
  vi.stubEnv("PATH", binDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  mocks.spawnImpl = null;
  mocks.existsSyncImpl = null;
  if (binDir) {
    removeTempDir(binDir);
    binDir = "";
  }
});

/** 注入 spawn 桩：按规格造假子进程，AbortSignal 取自 spawn 实际收到的选项。 */
function useFakeProc(spec: Omit<FakeProcSpec, "signal">): void {
  mocks.spawnImpl = (_file, _args, opts) => {
    const { signal } = (opts ?? {}) as { signal?: AbortSignal };
    return makeFakeProc({ ...spec, signal });
  };
}

describe("whichAdb（对应 which_adb）", () => {
  it("test_which_adb_finds_shutil", () => {
    // Python：patch shutil.which 返回 "/usr/bin/adb"。TS 等价：PATH 指向另一
    // 个真实含可执行 adb 的临时目录，断言探测命中并返回该路径。
    const customDir = mkdtempSync(join(tmpdir(), "damai-adb-path-"));
    const customBin = join(customDir, process.platform === "win32" ? "adb.exe" : "adb");
    try {
      writeFileSync(customBin, "#!/bin/sh\nexit 0\n");
      chmodSync(customBin, 0o755);
      vi.stubEnv("PATH", customDir);
      expect(whichAdb()).toBe(customBin);
    } finally {
      vi.unstubAllEnvs();
      removeTempDir(customDir);
    }
  });

  it("test_which_adb_falls_back_to_emulator_path", () => {
    // PATH 探测落空（等价 patch shutil.which → None）且模拟器自带路径存在
    // （等价 patch pathlib.Path.exists → True）时，回退到候选安装位置。
    vi.stubEnv("PATH", "");
    mocks.existsSyncImpl = () => true;
    expect(whichAdb()).not.toBeNull();
  });
});

describe("adb()（对应 adb 协程）", () => {
  it("test_adb_success_returns_stdout", async () => {
    useFakeProc({ stdout: Buffer.from("hello\n"), returncode: 0 });
    const result = await adb("devices", { check: false });
    expect(result).toBeInstanceOf(ADBResult);
    expect(result.stdout).toBe("hello\n");
    expect(result.returncode).toBe(0);
    expect(result.stdoutBytes).toEqual(Buffer.from("hello\n"));
  });

  it("test_adb_binary_stdout_preserved", async () => {
    // screencap 返回 PNG 字节——绝不能被 utf-8 解码破坏（raw Buffer 策略）
    const png = Buffer.from("\x89PNG\r\n\x1a\nFAKE", "latin1");
    useFakeProc({ stdout: png, returncode: 0 });
    const result = await adb("exec-out", "screencap", "-p", { check: false });
    expect(result.stdoutBytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    // 解码视图也应可用（坏字节替换为 U+FFFD，"PNG" 保留）
    expect(result.stdout).toContain("PNG");
  });

  it("test_adb_nonzero_raises_when_check_true", async () => {
    useFakeProc({ stderr: Buffer.from("device not found"), returncode: 1 });
    const err = await captureRejection(adb("shell", "ls", { check: true }));
    expect(err).toBeInstanceOf(ADBError);
    expect((err as Error).message).toMatch(/device not found/);
  });

  it("test_adb_nonzero_silent_when_check_false", async () => {
    useFakeProc({ stderr: Buffer.from("oops"), returncode: 1 });
    const result = await adb("shell", "ls", { check: false });
    expect(result.returncode).toBe(1);
    expect(result.stderr).toContain("oops");
  });

  it("test_adb_missing_binary_raises_adberror", async () => {
    // PATH 上没有 adb（等价 patch which_adb → None）：用不含 adb 的空目录
    const emptyDir = mkdtempSync(join(tmpdir(), "damai-adb-empty-"));
    try {
      vi.stubEnv("PATH", emptyDir);
      mocks.existsSyncImpl = () => false;
      const err = await captureRejection(adb("devices"));
      expect(err).toBeInstanceOf(ADBError);
      expect((err as Error).message).toMatch(/adb 未找到/);
    } finally {
      vi.unstubAllEnvs();
      removeTempDir(emptyDir);
    }
  });

  it("test_adb_timeout_raises", async () => {
    // Python：communicate 抛 asyncio.TimeoutError；TS：假子进程挂住，
    // 由 adb() 的超时定时器经 AbortSignal 触发 error 事件，走同一条超时分支。
    useFakeProc({ hang: true });
    const err = await captureRejection(adb("shell", "sleep", "999", { timeout: 0.1 }));
    expect(err).toBeInstanceOf(ADBError);
    expect((err as Error).message).toMatch(/超时/);
  });
});

describe("shell()（对应 shell 协程）", () => {
  it("test_shell_returns_stdout", async () => {
    useFakeProc({ stdout: Buffer.from("uid=0\n"), returncode: 0 });
    await expect(shell("id")).resolves.toBe("uid=0");
  });
});
