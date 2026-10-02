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
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ADBResult,
  AdbShellClosedError,
  AdbShellTimeoutError,
  PersistentAdbShell,
  adb,
  clearAdbPathMemo,
  closeAllPersistentShells,
  disablePersistentShellForDevice,
  enablePersistentShellForDevice,
  persistentShellEnabledFor,
  runShellCommand,
  shell,
  whichAdb,
} from "../src/device/adb";
import { tap } from "../src/actions/actions";
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
  // item-9：whichAdb 的进程内路径 memo 按用例重置，避免跨用例串味
  clearAdbPathMemo();
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

describe("whichAdb 路径 memo（item-9）", () => {
  /** 在目录里放一个可执行的假 adb。 */
  function writeFakeAdb(dir: string): string {
    const bin = join(dir, process.platform === "win32" ? "adb.exe" : "adb");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
    return bin;
  }

  it("首次扫描后 memo 生效：PATH 变化不可见，clearAdbPathMemo 后重新探测", () => {
    const dirA = mkdtempSync(join(tmpdir(), "damai-adb-memo-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "damai-adb-memo-b-"));
    try {
      const binA = writeFakeAdb(dirA);
      const binB = writeFakeAdb(dirB);
      vi.stubEnv("PATH", dirA);
      expect(whichAdb()).toBe(binA); // 首扫并写 memo
      vi.stubEnv("PATH", dirB);
      expect(whichAdb()).toBe(binA); // memo 命中 → 仍返回旧路径
      clearAdbPathMemo();
      expect(whichAdb()).toBe(binB); // 重置后重新探测到新 PATH
    } finally {
      vi.unstubAllEnvs();
      removeTempDir(dirA);
      removeTempDir(dirB);
    }
  });

  it("spawn ENOENT → 清空 memo 并重扫一次（自愈），本次仍按原语义抛错", async () => {
    const dirB = mkdtempSync(join(tmpdir(), "damai-adb-memo-heal-"));
    try {
      // memo 先缓存 binDir（beforeEach 已清 memo 且 PATH=binDir）
      expect(whichAdb()).toBe(join(binDir, process.platform === "win32" ? "adb.exe" : "adb"));
      // PATH 切到 dirB（含新 adb），并让 spawn 以异步 error 事件报 ENOENT
      // （真实 Node spawn 找不到二进制时的行为形态）
      const binB = writeFakeAdb(dirB);
      vi.stubEnv("PATH", dirB);
      mocks.spawnImpl = () => {
        const proc = new EventEmitter() as unknown as ChildProcess;
        proc.kill = () => true; // adb() 的异常路径会补 SIGKILL
        setImmediate(() => {
          const err = new Error("spawn adb ENOENT");
          (err as NodeJS.ErrnoException).code = "ENOENT";
          proc.emit("error", err);
        });
        return proc;
      };
      const err = await captureRejection(adb("devices"));
      expect(err).toBeInstanceOf(ADBError);
      expect((err as Error).message).toMatch(/adb 二进制无法执行/);
      // 自愈：memo 已被清空并按新 PATH 重扫刷新
      expect(whichAdb()).toBe(binB);
    } finally {
      vi.unstubAllEnvs();
      removeTempDir(dirB);
    }
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

// ---------------------------------------------------------------------------
// PersistentAdbShell（借鉴 damai PersistentAdbShell）
//
// 复用上方的 mocks.spawnImpl 注入机制；持久 shell 的假进程在本文件内自定义
// （helpers.ts 的 makeFakeProc stdin 恒为 null，且不在本项名下）：
// EventEmitter + PassThrough 三流，stdin 可写并按 \n 切行分派给用例脚本。
// ---------------------------------------------------------------------------

/**
 * 持久 shell 假进程：stdin/stdout/stderr 均为 PassThrough，结构上与
 * ChildProcess 兼容（kill / exitCode / signalCode / pid），由用例投喂
 * stdout 回放字节并手动触发 EOF。
 */
class FakeShellProc extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid: number | undefined = 4242;
  killed = false;

  /** 收到的 kill 信号序列（用例 ⑧ 断言 SIGTERM → SIGKILL 升级）。 */
  readonly killSignals: NodeJS.Signals[] = [];
  /** 收到的完整 stdin 协议行（按 \n 切分、剥行尾 \r）。 */
  readonly lines: string[] = [];
  /** 收到的原始 stdin 写入（次数 + 字节，用例 ① 断言整条链一次 write）。 */
  readonly rawWrites: Buffer[] = [];

  /** stdin 行分派脚本（由用例注入；回执回放通常经 {@link reply}）。 */
  onLine: (line: string, proc: FakeShellProc) => void = () => {};

  /** 响应哪些 kill 信号时退出；SIGKILL-only 用于用例 ⑧ 的升级路径。 */
  private readonly exitOnSignals: ReadonlySet<string>;

  constructor(opts: { exitOnSignals?: readonly NodeJS.Signals[] } = {}) {
    super();
    this.exitOnSignals = new Set(opts.exitOnSignals ?? ["SIGTERM", "SIGKILL"]);
    let buffered = Buffer.alloc(0);
    this.stdin.on("data", (chunk: Buffer) => {
      this.rawWrites.push(chunk);
      buffered = Buffer.concat([buffered, chunk]);
      let idx = buffered.indexOf(0x0a);
      while (idx >= 0) {
        const line = buffered.subarray(0, idx).toString("utf8").replace(/\r$/, "");
        buffered = buffered.subarray(idx + 1);
        this.lines.push(line);
        this.onLine(line, this);
        idx = buffered.indexOf(0x0a);
      }
    });
    this.stdin.on("error", () => {});
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed = true;
    this.killSignals.push(signal);
    if (this.exitOnSignals.has(signal) && this.exitCode === null && this.signalCode === null) {
      this.exitCode = 0;
      setImmediate(() => {
        this.stdout.end();
        this.stderr.end();
        this.emit("close", 0, null);
      });
    }
    return true;
  }

  /** 用例手动触发 EOF（stdout/stderr end + 进程 close）。 */
  finish(exitCode = 0): void {
    this.exitCode = exitCode;
    setImmediate(() => {
      this.stdout.end();
      this.stderr.end();
      this.emit("close", exitCode, null);
    });
  }

  /**
   * 便捷回放：从协议行提取 `echo <marker>` 并向 stdout 写入
   * `[prefix]<marker><行尾>`；行尾默认 \n，crlf=true 时为 \r\n（Windows 形态）。
   */
  reply(line: string, opts: { prefix?: Buffer; crlf?: boolean } = {}): void {
    const m = line.match(/echo (__DMCTS_[A-Z]+_\d+_DONE__)/);
    if (m === null) {
      return;
    }
    const eol = opts.crlf ? "\r\n" : "\n";
    this.stdout.write(Buffer.concat([opts.prefix ?? Buffer.alloc(0), Buffer.from(`${m[1]}${eol}`)]));
  }
}

/** 注入持久 shell 假进程并 open：返回被测实例、假进程与 spawn 实参快照。 */
async function openFakePersistentShell(
  onLine: (line: string, proc: FakeShellProc) => void,
  options: { deviceId?: string; exitOnSignals?: readonly NodeJS.Signals[] } = {},
): Promise<{ sh: PersistentAdbShell; proc: FakeShellProc; spawnArgs: string[] }> {
  const proc = new FakeShellProc({ exitOnSignals: options.exitOnSignals });
  proc.onLine = onLine;
  let spawnArgs: string[] = [];
  mocks.spawnImpl = (_file, args) => {
    spawnArgs = [...args];
    return proc as unknown as ChildProcess;
  };
  const sh = await PersistentAdbShell.open({ deviceId: options.deviceId ?? null });
  return { sh, proc, spawnArgs };
}

describe("PersistentAdbShell（借鉴 damai PersistentAdbShell）", () => {
  it("taps：单行拼接 + 整条链一次 write + CRLF 回执容忍", async () => {
    const { sh, proc, spawnArgs } = await openFakePersistentShell((line, fake) => {
      fake.reply(line, { crlf: true });
    });
    expect(spawnArgs).toEqual(["shell"]);
    await sh.taps(
      [
        [100, 200],
        [300, 400],
      ],
      { gapMs: 50 },
    );
    expect(proc.rawWrites).toHaveLength(1);
    expect(proc.lines).toEqual([
      "input tap 100 200; sleep 0.05; input tap 300 400; echo __DMCTS_TAP_1_DONE__",
    ]);
    await sh.close();
  });

  it("taps：initialDelayMs 前置 sleep、零间隙省略 sleep、marker 序号实例内自增", async () => {
    const { sh, proc } = await openFakePersistentShell((line, fake) => fake.reply(line));
    await sh.taps([[1, 2]], { initialDelayMs: 250 });
    await sh.taps([
      [1, 2],
      [3, 4],
    ]);
    expect(proc.lines).toEqual([
      "sleep 0.25; input tap 1 2; echo __DMCTS_TAP_1_DONE__",
      "input tap 1 2; input tap 3 4; echo __DMCTS_TAP_2_DONE__",
    ]);
    await sh.close();
  });

  it("swipe：单行拼接与 SWIPE marker", async () => {
    const { sh, proc } = await openFakePersistentShell((line, fake) => fake.reply(line));
    await sh.swipe(10, 20, 300, 400, 300);
    expect(proc.lines).toEqual(["input swipe 10 20 300 400 300; echo __DMCTS_SWIPE_1_DONE__"]);
    await sh.close();
  });

  it("run：marker 前含 0x80-0xFF 噪声字节不破坏字节级搜索，返回噪声行", async () => {
    // 非法 utf-8 序列：解码视图应逐字节替换为 U+FFFD，marker 仍按 ASCII 字节命中
    const noise = Buffer.from([0x80, 0xfe, 0xff, 0x81]);
    const { sh } = await openFakePersistentShell((line, fake) => {
      fake.reply(line, { prefix: Buffer.concat([noise, Buffer.from("\n")]) });
    });
    await expect(sh.run("getprop ro.product.model")).resolves.toBe("\uFFFD\uFFFD\uFFFD\uFFFD");
    await sh.close();
  });

  it("run：无输出命令返回空串", async () => {
    const { sh } = await openFakePersistentShell((line, fake) => fake.reply(line));
    await expect(sh.run("true")).resolves.toBe("");
    await sh.close();
  });

  it("EOF 先于 marker：AdbShellClosedError「在命令完成前结束」", async () => {
    const { sh, proc } = await openFakePersistentShell(() => {}); // 不回放任何回执
    const pending = sh.run("echo hi");
    await new Promise((resolve) => setImmediate(resolve)); // 确保写入与等待器已注册
    proc.finish();
    const err = await captureRejection(pending);
    expect(err).toBeInstanceOf(AdbShellClosedError);
    expect((err as Error).name).toBe("AdbShellClosedError");
    expect((err as Error).message).toMatch(/在命令完成前结束/);
    await sh.close();
  });

  it("close 后调用：run/fire 抛「进程已退出」，close 幂等", async () => {
    const { sh, proc } = await openFakePersistentShell(() => {});
    await sh.close();
    expect(proc.killSignals).toEqual(["SIGTERM"]); // 假进程响应 SIGTERM 即退出
    expect(sh.alive).toBe(false);
    const err = await captureRejection(sh.run("getprop"));
    expect(err).toBeInstanceOf(AdbShellClosedError);
    expect((err as Error).message).toMatch(/进程已退出/);
    expect(() => sh.fire("input tap 1 1")).toThrow(AdbShellClosedError);
    await expect(sh.close()).resolves.toBeUndefined();
  });

  it("回执超时：AdbShellTimeoutError 且通道自动关闭，后续 run 拒绝", async () => {
    const { sh } = await openFakePersistentShell(() => {}); // 不回放 marker
    const err = await captureRejection(sh.run("slow", { receiptTimeoutMs: 20 }));
    expect(err).toBeInstanceOf(AdbShellTimeoutError);
    expect((err as Error).name).toBe("AdbShellTimeoutError");
    expect((err as Error).message).toMatch(/持久 shell 命令超时（>20ms）/);
    expect(sh.alive).toBe(false); // deviation：超时即自动 close()（字节流可能失步）
    const next = await captureRejection(sh.run("next"));
    expect(next).toBeInstanceOf(AdbShellClosedError);
    expect((next as Error).message).toMatch(/进程已退出/);
    await sh.close();
  });

  it("marker 唯一性：fire 的迟到 marker 不使命令 2 误命中", async () => {
    const { sh } = await openFakePersistentShell((line, fake) => {
      const m = line.match(/echo (__DMCTS_CMD_\d+_DONE__)/);
      // 只回放 fire（序号 1）的 marker；命令 2 的 marker 永不回放
      if (m !== null && m[1].endsWith("_1_DONE__")) {
        fake.stdout.write(Buffer.from(`${m[1]}\n`));
      }
    });
    sh.fire("input tap 1 1");
    const err = await captureRejection(sh.run("getprop", { receiptTimeoutMs: 30 }));
    expect(err).toBeInstanceOf(AdbShellTimeoutError);
    expect(sh.alive).toBe(false);
    await sh.close();
  });

  it("fire 即发即忘：不等回执，其 marker 由下一条命令的回执唯一定界", async () => {
    const { sh, proc } = await openFakePersistentShell((line, fake) => {
      fake.reply(line, { prefix: Buffer.from("junk\n") });
    });
    expect(sh.fire("input tap 5 5")).toBeUndefined();
    // fire 的 marker（序号 1）无人消费，落在命令 2 回执之前的输出行里
    await expect(sh.run("getprop ro.product.model")).resolves.toBe(
      "junk\n__DMCTS_CMD_1_DONE__\njunk",
    );
    expect(proc.lines).toHaveLength(2); // fire 与 run 各一次单行写入
    await sh.close();
  });

  it("close：SIGTERM 1s 内未退出则补 SIGKILL", async () => {
    const { sh, proc } = await openFakePersistentShell(() => {}, { exitOnSignals: ["SIGKILL"] });
    await sh.close();
    expect(proc.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(sh.alive).toBe(false);
    await expect(sh.close()).resolves.toBeUndefined(); // 幂等
  });

  it("open：spawn 参数按 deviceId 拼 -s；adb 未找到沿用 adb() 原文案", async () => {
    const withDevice = await openFakePersistentShell(() => {}, { deviceId: "emulator-5554" });
    expect(withDevice.spawnArgs).toEqual(["-s", "emulator-5554", "shell"]);
    await withDevice.sh.close();

    const noDevice = await openFakePersistentShell(() => {});
    expect(noDevice.spawnArgs).toEqual(["shell"]);
    await noDevice.sh.close();

    // PATH 探测落空 + 模拟器候选路径全不存在（等价 patch which_adb → None）
    // （本用例前半段已让 whichAdb 写入 memo，先清空再模拟 adb 消失）
    const emptyDir = mkdtempSync(join(tmpdir(), "damai-adb-empty-"));
    try {
      clearAdbPathMemo();
      vi.stubEnv("PATH", emptyDir);
      mocks.existsSyncImpl = () => false;
      const err = await captureRejection(PersistentAdbShell.open());
      expect(err).toBeInstanceOf(ADBError);
      expect((err as Error).message).toMatch(/adb 未找到/);
    } finally {
      vi.unstubAllEnvs();
      removeTempDir(emptyDir);
    }
  });

  it("命令与坐标校验：中文 TypeError，空 taps 不写任何字节", async () => {
    const { sh, proc } = await openFakePersistentShell(() => {});
    expect(() => sh.run("echo a\necho b")).toThrow(TypeError);
    expect(() => sh.run("echo a\necho b")).toThrow(/命令不能包含换行符/);
    expect(() => sh.run("echo __DMCTS_CMD_9_DONE__")).toThrow(/命令与回执 marker 冲突/);
    expect(() => sh.fire("x\ny")).toThrow(TypeError);
    expect(() => sh.taps([[-1, 0]])).toThrow(/必须为非负整数/);
    expect(() => sh.taps([[1.5, 2]])).toThrow(TypeError);
    expect(() => sh.swipe(0, 0, 100, 100, -1)).toThrow(/必须为非负整数/);
    await expect(sh.taps([])).resolves.toBeUndefined();
    expect(proc.rawWrites).toHaveLength(0);
    await sh.close();
  });
});

// ---------------------------------------------------------------------------
// per-device 持久 shell 复用层（item-2）
//
// 复用本文件的 spawn mock 机制：交互 shell 打开（args 末位为 "shell"）返回
// FakeShellProc；一次性 spawn（adb -s DEV shell <cmd> / exec-out …）返回
// makeFakeProc 形态的进程（stdout 按批吐出后 close）。
// ---------------------------------------------------------------------------

/** 判定 spawn args 是否为持久 shell 的交互进程打开（`adb [-s DEV] shell`）。 */
function isInteractiveShellOpen(args: readonly string[]): boolean {
  return args[args.length - 1] === "shell" && args.length <= 3;
}

describe("per-device 持久 shell 复用层（item-2）", () => {
  afterEach(async () => {
    await closeAllPersistentShells();
  });

  /** 注册 spawn 桩：交互 shell 走 FakeShellProc（onLine 由回调决定），其余走一次性进程。 */
  function useRegistryProcs(onLine: (line: string, fake: FakeShellProc) => void) {
    const interactiveProcs: FakeShellProc[] = [];
    const oneShotArgs: string[][] = [];
    mocks.spawnImpl = (_file, args, opts) => {
      if (isInteractiveShellOpen(args)) {
        const proc = new FakeShellProc();
        proc.onLine = onLine;
        interactiveProcs.push(proc);
        return proc as unknown as ChildProcess;
      }
      const { signal } = (opts ?? {}) as { signal?: AbortSignal };
      oneShotArgs.push([...args]);
      return makeFakeProc({ stdout: Buffer.alloc(0), returncode: 0, signal });
    };
    return { interactiveProcs, oneShotArgs };
  }

  it("enable 后 tap 走持久 shell：单行一次 write（CMD marker），未回落一次性", async () => {
    enablePersistentShellForDevice("DEV", { receiptTimeoutMs: 2000 });
    expect(persistentShellEnabledFor("DEV")).toBe(true);
    const { interactiveProcs, oneShotArgs } = useRegistryProcs((line, fake) => fake.reply(line));
    await tap("DEV", 100, 200);
    expect(interactiveProcs).toHaveLength(1);
    expect(interactiveProcs[0]!.rawWrites).toHaveLength(1);
    expect(interactiveProcs[0]!.lines).toEqual(["input tap 100 200; echo __DMCTS_CMD_1_DONE__"]);
    expect(oneShotArgs).toEqual([]); // 未回落一次性 shell
  });

  it("回执超时 → 回落一次性 shell 重试一次，池条目被摘除（下次重新 open）", async () => {
    enablePersistentShellForDevice("DEV", { receiptTimeoutMs: 30 });
    let replyEnabled = false;
    const { interactiveProcs, oneShotArgs } = useRegistryProcs((line, fake) => {
      if (replyEnabled) {
        fake.reply(line);
      }
    });
    await tap("DEV", 7, 8); // 持久回执超时 → 回落一次性 shell（成功）
    expect(interactiveProcs).toHaveLength(1);
    expect(oneShotArgs).toEqual([["-s", "DEV", "shell", "input tap 7 8"]]);
    // 条目已被摘除：下一条命令重新 open（这次回执正常，不再回落）
    replyEnabled = true;
    await tap("DEV", 7, 8);
    expect(interactiveProcs).toHaveLength(2);
    expect(oneShotArgs).toHaveLength(1);
  });

  it("回执含 Exception 行 → 抛 ADBError「持久 shell 命令执行失败: …」", async () => {
    enablePersistentShellForDevice("DEV");
    const { interactiveProcs } = useRegistryProcs((line, fake) =>
      fake.reply(line, {
        prefix: Buffer.from("Exception: coordinate out of bounds\n"),
      }),
    );
    const err = await captureRejection(
      runShellCommand("input tap 1 2", { deviceId: "DEV", receiptTimeoutMs: 2000 }),
    );
    expect(err).toBeInstanceOf(ADBError);
    expect((err as Error).message).toBe(
      "持久 shell 命令执行失败: Exception: coordinate out of bounds",
    );
    // 启发式报错不摘条目：通道本身健康，同会话可继续执行
    expect(persistentShellEnabledFor("DEV")).toBe(true);
    expect(interactiveProcs).toHaveLength(1);
  });

  it("EOF/会话关闭 → runShellCommand 摘除条目并上抛 AdbShellClosedError", async () => {
    enablePersistentShellForDevice("DEV", { receiptTimeoutMs: 2000 });
    // 第一个会话永不回执（用 finish 触发 EOF）；重建的会话正常回执
    const { interactiveProcs } = useRegistryProcs((line, fake) => {
      if (fake !== interactiveProcs[0]) {
        fake.reply(line);
      }
    });
    const pending = runShellCommand("getprop", { deviceId: "DEV" });
    await new Promise((resolve) => setImmediate(resolve));
    interactiveProcs[0]!.finish(); // 进程死亡 → EOF 先于 marker
    const err = await captureRejection(pending);
    expect(err).toBeInstanceOf(AdbShellClosedError);
    // 条目已摘除：下一条命令重新 open（本桩继续给新进程）
    await expect(runShellCommand("getprop", { deviceId: "DEV" })).resolves.toBe("");
    expect(interactiveProcs).toHaveLength(2);
  });

  it("idle TTL 到期自动 close 并摘除；下一条命令重开（fake timers）", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      enablePersistentShellForDevice("DEV", { idleTtlMs: 1000, receiptTimeoutMs: 2000 });
      const { interactiveProcs } = useRegistryProcs((line, fake) => fake.reply(line));
      await expect(runShellCommand("getprop", { deviceId: "DEV" })).resolves.toBe("");
      expect(interactiveProcs).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      // TTL 到期：会话被 close（SIGTERM 已发出）并摘除
      expect(interactiveProcs[0]!.killSignals).toContain("SIGTERM");
      await expect(runShellCommand("getprop", { deviceId: "DEV" })).resolves.toBe("");
      expect(interactiveProcs).toHaveLength(2); // 按需重开
    } finally {
      vi.useRealTimers();
    }
  });

  it("disable 后回归一次性 shell() 路径（不再打开交互进程）", async () => {
    enablePersistentShellForDevice("DEV", { receiptTimeoutMs: 2000 });
    const { interactiveProcs, oneShotArgs } = useRegistryProcs((line, fake) => fake.reply(line));
    await tap("DEV", 1, 2);
    expect(interactiveProcs).toHaveLength(1);
    expect(oneShotArgs).toEqual([]);
    await disablePersistentShellForDevice("DEV");
    expect(persistentShellEnabledFor("DEV")).toBe(false);
    expect(interactiveProcs[0]!.killSignals).toContain("SIGTERM"); // 会话已关闭
    await tap("DEV", 1, 2); // 回归一次性路径
    expect(interactiveProcs).toHaveLength(1);
    expect(oneShotArgs).toEqual([["-s", "DEV", "shell", "input tap 1 2"]]);
  });
});
