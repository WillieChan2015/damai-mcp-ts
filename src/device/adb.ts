/**
 * adb CLI 的轻量异步封装（Python `device/adb.py` 的 TS 对应物）。
 *
 * 有意避开纯协议的 adb 实现（adb_shell / aioadb 之类），原因与 Python 版一致：
 *   * 用户手头真正拥有的是雷电 / MuMu / 真机自带的本地 adb
 *   * 纯语言实现的 adb 缺少部分 MediaTek 专属的 shell 命令
 *   * 我们希望在安装本包之外零额外二进制下载
 *
 * `adb` 必须在 PATH 上；在 Windows 上这要么是 SDK platform-tools，要么是
 * 模拟器自带的 adb（例如 `C:/Program Files/LDPlayer/ldadb.exe`）。
 *
 * 子进程策略：一律用 `node:child_process` 的 `spawn` 收集**原始 Buffer**，
 * 不经过任何文本编解码管道——下游的 `adb exec-out`（截屏 / UI dump）依赖
 * 二进制通道绕过 Windows 控制台的 GBK 代码页转码。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Readable } from "node:stream";

import { ADBError } from "../utils/errors";
import { logger } from "../utils/logging";

/** Windows 上为 adb.exe，其余平台为 adb（对应 Python 的 `_ADB_BIN`）。 */
const ADB_BIN = process.platform === "win32" ? "adb.exe" : "adb";

/** Python 子进程用负数 returncode 表示「被信号 N 终止」，此处维护 POSIX 信号编号。 */
const SIGNAL_NUMBERS: Readonly<Record<string, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGABRT: 6,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGSEGV: 11,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
};

/** 判断路径是否为已存在的普通文件（不区分可执行位，见 {@link whichBinary} 的平台注释）。 */
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * 通用 PATH 探测（对应 Python 的 `shutil.which`）：在 PATH 各目录中查找
 * 可执行文件；找不到时返回 null。
 *
 * POSIX 上额外校验可执行位（等价 `os.access(X_OK)`）；Windows 上 X_OK 无
 * 实际语义，存在且为文件即视为可执行——与 shutil.which 行为一致。
 */
export function whichBinary(binary: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = join(dir, binary);
    if (!isFile(candidate)) {
      continue;
    }
    if (process.platform === "win32") {
      return candidate;
    }
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 无可执行位，继续找下一目录
    }
  }
  return null;
}

/** 单次 adb 调用的结果。 */
export interface ADBResultInit {
  /** 子进程的原始 stdout 字节。 */
  stdoutBytes: Buffer;
  /** 子进程的原始 stderr 字节。 */
  stderrBytes: Buffer;
  /** 子进程退出码。 */
  returncode: number;
  /** 整次调用耗时（毫秒）。 */
  durationMs: number;
}

/** 单次 adb 调用的结果。 */
export class ADBResult {
  /** 子进程的原始 stdout 字节。 */
  readonly stdoutBytes: Buffer;
  /** 子进程的原始 stderr 字节。 */
  readonly stderrBytes: Buffer;
  /** 子进程退出码。 */
  readonly returncode: number;
  /** 整次调用耗时（毫秒）。 */
  readonly durationMs: number;

  constructor(init: ADBResultInit) {
    this.stdoutBytes = init.stdoutBytes;
    this.stderrBytes = init.stderrBytes;
    this.returncode = init.returncode;
    this.durationMs = init.durationMs;
  }

  /**
   * stdout 的 utf-8 解码视图（坏字节替换为 U+FFFD，等价 Python
   * `decode("utf-8", errors="replace")`）。`screencap` / `cat` 图片等二进制
   * 命令请改用 {@link ADBResult.stdoutBytes}。
   */
  get stdout(): string {
    return this.stdoutBytes.toString("utf8");
  }

  /** stderr 的 utf-8 解码视图（坏字节替换为 U+FFFD）。 */
  get stderr(): string {
    return this.stderrBytes.toString("utf8");
  }

  /** 退出码是否为 0。 */
  get ok(): boolean {
    return this.returncode === 0;
  }
}

/** {@link adb} 的选项（对应 Python 版的关键字参数）。 */
export interface AdbOptions {
  /** 目标设备序列号；省略时与当前唯一连接的设备通信。 */
  deviceId?: string | null;
  /** 超时秒数。默认 30。 */
  timeout?: number;
  /** 为 true 时非零退出码抛 {@link ADBError}。默认 true。 */
  check?: boolean;
  /** 写入 stdin 的字节（极少使用）。 */
  inputData?: Buffer | null;
}

/** {@link shell} 的选项（{@link AdbOptions} 的子集）。 */
export interface ShellOptions {
  /** 目标设备序列号；省略时与当前唯一连接的设备通信。 */
  deviceId?: string | null;
  /** 超时秒数。默认 30。 */
  timeout?: number;
  /** 为 true 时非零退出码抛 {@link ADBError}。默认 true。 */
  check?: boolean;
}

/**
 * 解析「可变 string 参数 + 至多一个末尾选项对象」的调用形态
 * （等价 Python 的 `*args, **kwargs`）。选项对象必须位于末尾。
 */
function parseInvocation<T extends object>(args: readonly (string | T)[]): [string[], T] {
  const argv: string[] = [];
  let options: T | null = null;
  for (const arg of args) {
    if (typeof arg === "string") {
      if (options !== null) {
        throw new TypeError("选项对象必须位于参数列表末尾");
      }
      argv.push(arg);
    } else {
      if (options !== null) {
        throw new TypeError("至多接受一个选项对象");
      }
      options = arg;
    }
  }
  return [argv, options ?? ({} as T)];
}

/**
 * 把 spawn close 事件的 (code, signal) 归一为 Python 风格的 returncode：
 * `code === null`（被信号杀死）时取 `-(信号编号)`，对应 Python 子进程的负数
 * returncode 语义；正常退出的 0 / 正数原样（对应 Python 的 `proc.returncode or 0`）。
 */
export function exitReturncode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) {
    return code;
  }
  if (signal !== null) {
    return -(SIGNAL_NUMBERS[signal] ?? 0);
  }
  return 0;
}

/** 等价 Python `str.splitlines()`（覆盖 \n / \r\n / \r；末尾单个换行不产生空元素）。 */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/** 等价 Python `.strip().splitlines()[-1]`：取末行；空串返回 ""。 */
function lastLine(text: string): string {
  const lines = splitLines(text);
  return lines[lines.length - 1] ?? "";
}

/**
 * 按 Python `str(float)` 的形态格式化数字（整数值补 `.0`），
 * 使嵌入错误信息的超时数值与 Python 版逐字一致（如 30.0）。
 */
export function formatPyFloat(value: number): string {
  return Number.isInteger(value) && Math.abs(value) < 1e16 ? `${value}.0` : String(value);
}

/**
 * 等待子进程退出：close 事件 resolve 退出信息；error 事件（spawn 失败 /
 * AbortSignal 中止）reject。供 {@link adb} 与 ldconsole 封装复用。
 */
export function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

/** 收集流的所有原始字节（错误时以已收集内容尽力 resolve，不 reject）。 */
function collectStream(stream: Readable, chunks: Buffer[]): Promise<void> {
  return new Promise((resolve) => {
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.once("error", () => resolve());
    stream.once("end", () => resolve());
    stream.once("close", () => resolve());
  });
}

/**
 * 定位 adb 二进制。返回完整路径，未找到时返回 null。
 *
 * 先探测 PATH，再依次尝试常见模拟器自带位置（对应 Python 版的候选列表）。
 */
export function whichAdb(): string | null {
  const found = whichBinary(ADB_BIN);
  if (found) {
    return found;
  }
  const candidates = [
    // 本项目使用的雷电 9 默认安装路径。
    join("D:/leidian/LDPlayer9", ADB_BIN),
    join("C:/Program Files/LDPlayer", ADB_BIN),
    join("C:/Program Files/LDPlayer9", ADB_BIN),
    join("C:/Program Files/Nox/bin", ADB_BIN),
    join("C:/Program Files/MuMu", ADB_BIN),
    join("C:/platform-tools", ADB_BIN),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * 异步运行一条 adb 命令。
 *
 * @param args 子命令与参数，如 `"shell"`, `"input"`, `"tap"`, `"100"`, `"200"`，
 *   可在末尾追加一个选项对象：`adb("devices", "-l", { check: false, timeout: 10 })`。
 * @returns 携带 stdout/stderr/退出码/耗时的 {@link ADBResult}。
 * @throws {@link ADBError} adb 未找到、二进制无法执行、超时，或 `check` 为 true
 *   且退出码非零。
 */
export async function adb(...args: (string | AdbOptions)[]): Promise<ADBResult> {
  const [argv, options] = parseInvocation<AdbOptions>(args);
  const { deviceId = null, timeout = 30.0, check = true, inputData = null } = options;

  const binPath = whichAdb();
  if (binPath === null) {
    throw new ADBError(
      "adb 未找到。请安装 Android Platform Tools 或配置模拟器自带的 adb 到 PATH。",
    );
  }

  const cmd: string[] = [binPath];
  if (deviceId) {
    cmd.push("-s", deviceId);
  }
  cmd.push(...argv);

  const t0 = performance.now();

  // 超时经 AbortSignal 触发：abort 时 Node 会向子进程发送 SIGTERM，
  // 随后在异常路径补 SIGKILL 确保进程死亡（Python 版 wait_for 取消并不杀进程）。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  timer.unref();

  const child = spawn(binPath, cmd.slice(1), {
    // stdin：有输入数据时走管道，否则沿用父进程 stdin（对应 Python stdin=None 的继承语义）
    stdio: [inputData !== null ? "pipe" : "inherit", "pipe", "pipe"],
    signal: controller.signal,
  });

  // 收集原始字节——二进制安全（screencap / exec-out 依赖此行为）
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stdoutDone = child.stdout ? collectStream(child.stdout, stdoutChunks) : Promise.resolve();
  const stderrDone = child.stderr ? collectStream(child.stderr, stderrChunks) : Promise.resolve();

  let stdinDone: Promise<void> = Promise.resolve();
  if (child.stdin) {
    const stdin = child.stdin;
    stdin.on("error", () => {}); // 子进程提前退出导致的 EPIPE 不致命（Python communicate 亦容忍）
    if (inputData !== null) {
      stdinDone = new Promise<void>((resolve) => {
        stdin.once("finish", () => resolve());
        stdin.once("close", () => resolve());
        stdin.end(inputData, () => resolve());
      });
    }
  }

  let exit: { code: number | null; signal: NodeJS.Signals | null };
  try {
    exit = await waitForExit(child);
    await Promise.all([stdoutDone, stderrDone, stdinDone]);
  } catch (exc) {
    // abort 只发 SIGTERM，这里补 SIGKILL 确保子进程死亡
    child.kill("SIGKILL");
    if (controller.signal.aborted) {
      throw new ADBError(`adb 命令超时（>${formatPyFloat(timeout)}s）: ${cmd.join(" ")}`);
    }
    if (exc instanceof Error && "code" in exc && (exc as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ADBError(`adb 二进制无法执行: ${binPath}`);
    }
    throw exc;
  } finally {
    clearTimeout(timer);
  }

  const durationMs = Math.trunc(performance.now() - t0);
  const result = new ADBResult({
    stdoutBytes: Buffer.concat(stdoutChunks),
    stderrBytes: Buffer.concat(stderrChunks),
    returncode: exitReturncode(exit.code, exit.signal),
    durationMs,
  });

  if (check && !result.ok) {
    // "device not found" / "device offline" → 抛 DeviceNotFoundError 会更贴心，
    // 但保持 ADBError，让调用方按 stderr 自行分支（与 Python 版一致）。
    const output = result.stderr || result.stdout;
    const snippet = output ? lastLine(output.trim()) : "no output";
    throw new ADBError(`adb 失败（rc=${result.returncode}）: ${snippet.slice(0, 200)}`);
  }

  if (result.durationMs > 1000) {
    logger.debug(`adb ${cmd.slice(1, 6).join(" ")} took ${result.durationMs}ms`);
  }

  return result;
}

/**
 * 便捷封装：`adb [-s DEV] shell <cmd...>` 并返回 stdout。
 *
 * @param args shell 子命令与参数，可在末尾追加一个选项对象：
 *   `shell("getprop", "ro.product.model", { deviceId, timeout: 5, check: false })`。
 * @returns stdout（去除末尾的 \r\n）。
 */
export async function shell(...args: (string | ShellOptions)[]): Promise<string> {
  const [argv, options] = parseInvocation<ShellOptions>(args);
  const result = await adb("shell", ...argv, {
    deviceId: options.deviceId,
    timeout: options.timeout,
    check: options.check,
  });
  return result.stdout.replace(/[\r\n]+$/, "");
}
