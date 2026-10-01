/**
 * 测试共享辅助（`conftest.py` 的 TS 对应物）。
 *
 * Python 版 conftest.py 只做一件事：把 `src/` 注入 `sys.path` 以便免安装导入
 * `damai_mcp`。TS/vitest 下模块解析由 tsconfig + vite 完成，无需等价的路径
 * 注入；因此本文件只承载各测试文件复用的小型工厂（对应原测试内联定义的
 * `_FakeAdbResult` / `_El` 占位类）。
 */

import { ADBResult } from "../src/device/adb";
import { UIElement, type UIElementInit } from "../src/inspector/models";

/** {@link okAdbResult} 的可选覆盖项。 */
export interface FakeAdbResultOverrides {
  /** 原始 stdout 字节。默认空 Buffer。 */
  stdoutBytes?: Buffer;
  /** 原始 stderr 字节。默认空 Buffer。 */
  stderrBytes?: Buffer;
  /** 退出码。默认 0。 */
  returncode?: number;
}

/**
 * 构造一次 adb 调用的假结果（对应 test_optimizations 的 `_FakeAdbResult`）。
 *
 * 返回真实的 {@link ADBResult} 实例——被测代码只读
 * `returncode` / `stdoutBytes` / `stderrBytes` / `ok`，与生产路径同一类型面。
 */
export function fakeAdbResult(
  overrides: FakeAdbResultOverrides = {},
): ADBResult {
  return new ADBResult({
    stdoutBytes: overrides.stdoutBytes ?? Buffer.alloc(0),
    stderrBytes: overrides.stderrBytes ?? Buffer.alloc(0),
    returncode: overrides.returncode ?? 0,
    durationMs: 0,
  });
}

/**
 * 构造一个最小 {@link UIElement}（对应 test_optimizations 的 `_El` 占位类）。
 *
 * 默认 `tag: "node"`、零 bounds——只填充调用方关心的字段。
 */
export function el(init: Partial<UIElementInit> = {}): UIElement {
  return new UIElement({ tag: "node", ...init });
}

// ---------------------------------------------------------------------------
// 子进程 / UDP socket 桩（test_adb.py、test_ntp.py 共用；追加自 conftest 批次）
// ---------------------------------------------------------------------------

import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

/** {@link makeFakeProc} 的规格（对应 test_adb.py `_fake_proc(stdout, stderr, rc)` 的入参）。 */
export interface FakeProcSpec {
  /** 子进程要吐出的 stdout 原始字节。 */
  stdout?: Buffer;
  /** 子进程要吐出的 stderr 原始字节。 */
  stderr?: Buffer;
  /** 退出码；缺省 0。 */
  returncode?: number;
  /** 为 true 时子进程挂住不退出，仅在 spawn 收到的 AbortSignal 触发时报 error（模拟超时）。 */
  hang?: boolean;
  /** spawn 选项里的 AbortSignal（由 adb() 的超时定时器触发）。 */
  signal?: AbortSignal;
}

/** 假子进程类型：stdout/stderr 为流，stdin 恒为 null（对应 stdio[0] 非 pipe 的形态）。 */
export type FakeChildProcess = Omit<ChildProcess, "stdout" | "stderr" | "stdin" | "kill"> & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: null;
  kill: (signal?: NodeJS.Signals) => boolean;
};

/**
 * 构造假子进程：下一轮事件循环吐出数据并发 "close"（正常路径）；`hang` 模式
 * 下不退出，仅在 signal abort 时发 AbortError——对应 Python 用例里
 * `communicate` 抛 `asyncio.TimeoutError` 的超时路径。
 */
export function makeFakeProc(spec: FakeProcSpec = {}): FakeChildProcess {
  const proc = new EventEmitter() as unknown as FakeChildProcess;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = null;
  proc.kill = () => true;

  if (spec.hang) {
    if (spec.signal) {
      spec.signal.addEventListener("abort", () => {
        setImmediate(() => {
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          proc.emit("error", err);
        });
      });
    }
    return proc;
  }

  setImmediate(() => {
    if (spec.stdout && spec.stdout.length > 0) {
      proc.stdout.write(spec.stdout);
    }
    if (spec.stderr && spec.stderr.length > 0) {
      proc.stderr.write(spec.stderr);
    }
    proc.stdout.end();
    proc.stderr.end();
    setImmediate(() => proc.emit("close", spec.returncode ?? 0, null));
  });
  return proc;
}

/** 创建含可执行假 adb 的临时目录（`fake_adb_bin` fixture 的 TS 等价物），返回目录与 adb 路径。 */
export function makeTempAdbOnPath(): { binDir: string; binPath: string } {
  const binDir = mkdtempSync(join(tmpdir(), "damai-adb-"));
  const binPath = join(binDir, process.platform === "win32" ? "adb.exe" : "adb");
  writeFileSync(binPath, "#!/bin/sh\nexit 0\n");
  chmodSync(binPath, 0o755);
  return { binDir, binPath };
}

/** 递归删除临时目录（force：不存在时不报错）。 */
export function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** 一次 send 的记录（对应 test_ntp.py `_FakeUDPSocket.sent` 的 `(data, (host, port))` 元组）。 */
export interface SentPacket {
  data: Buffer;
  address: string;
  port: number;
}

/**
 * UDP socket 桩（对应 `test_ntp.py` 的 `_FakeUDPSocket`）：send 时记录报文，
 * 有预置响应则以 setImmediate 回放；`response` 为 null 时永不回包（供超时用例）。
 */
export class FakeUdpSocket extends EventEmitter {
  readonly sent: SentPacket[] = [];

  constructor(private readonly response: Buffer | null) {
    super();
  }

  send(data: Buffer, port: number, address: string, cb?: (err: Error | null) => void): this {
    this.sent.push({ data, port, address });
    const response = this.response;
    if (response !== null) {
      setImmediate(() => this.emit("message", response));
    }
    if (cb) {
      cb(null);
    }
    return this;
  }

  close(cb?: () => void): this {
    if (cb) {
      cb();
    }
    return this;
  }
}

/** 构造服务器响应包：字节 0 为 0x1C，字节 40-44 为秒、44-48 为小数部分（大端）。 */
export function fakeNtpResponse(seconds: number, fraction = 0): Buffer {
  const pkt = Buffer.alloc(48);
  pkt[0] = 0x1c; // server response
  pkt.writeUInt32BE(seconds, 40);
  pkt.writeUInt32BE(fraction, 44);
  return pkt;
}

/** `pytest.raises` 的取值侧等价物：等 Promise reject 并返回异常值；resolve 则报错。 */
export async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("预期 Promise reject，但它成功 resolve 了");
}
