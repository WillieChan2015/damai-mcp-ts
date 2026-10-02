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
import type { Readable, Writable } from "node:stream";

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

// ---------------------------------------------------------------------------
// 持久 ADB shell 进程复用 + ASCII marker 回执（借鉴 damai PersistentAdbShell）
//
// 上方 adb()/shell() 每条命令都要冷启动一次 adb 客户端进程；高频点击链（如
// 票价→确认的多点连击）下这部分冷启动开销占据主要延迟。本节借鉴 damai 的
// PersistentAdbShell（材料：damai_checkout.py:200-207,289-323）与 fire 形态
// （材料：damai_mode0.py:114-130）：每会话一条常驻 `adb [-s DEV] shell` 交互
// 进程，把 N 条设备命令拼成单行一次写入，以实例内自增的 ASCII marker
// （`__DMCTS_<KIND>_<n>_DONE__`）作为回执定界。
//
// 注意：本节为纯新增能力，不替代 shell()——交互式 shell 无法回报远端退出码，
// `check:true` 语义不可平移（MIGRATION_NOTES §2 行为保真边界）。
// ---------------------------------------------------------------------------

/** marker 形态校验：命令文本含该形态会伪造/混淆回执，破坏「一次写入对应一个 marker」不变量。 */
const PERSISTENT_MARKER_RE = /__DMCTS_[A-Z]+_\d+_DONE__/;

/** 默认回执等待上限（毫秒），对齐 damai tap 链的 4s 上限。 */
const PERSISTENT_DEFAULT_RECEIPT_TIMEOUT_MS = 4000;

/** 无回执等待时（纯 fire 模式）stdout 累积缓冲的裁剪上限，防长会话无限累积。 */
const PENDING_BUFFER_CAP_BYTES = 1024 * 1024;

/** {@link PersistentAdbShell} 回执 marker 的类别（对应 marker 文本中的 KIND 段）。 */
type PersistentMarkerKind = "CMD" | "TAP" | "SWIPE";

/** 持久 shell 选项。 */
export interface PersistentShellOptions {
  /** 目标设备序列号；省略时与当前唯一连接的设备通信（同 {@link AdbOptions.deviceId}）。 */
  deviceId?: string | null;
  /** 单条回执等待上限（毫秒）。默认 4000；可被 run/taps/swipe 的逐次选项覆盖。 */
  receiptTimeoutMs?: number;
}

/** 持久 shell 回执超时：marker 未在时限内到达。 */
export class AdbShellTimeoutError extends ADBError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AdbShellTimeoutError";
  }
}

/** 持久 shell 通道已死：进程退出 / EOF / 流缺失 / 写入失败。 */
export class AdbShellClosedError extends ADBError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AdbShellClosedError";
  }
}

/** 把毫秒转为 toybox `sleep` 的秒数字符串（最多 3 位小数；toybox 小数秒要求 Android ≥6）。 */
function msToSleepSeconds(ms: number): string {
  return String(Number((Math.round(ms) / 1000).toFixed(3)));
}

/** 校验坐标类参数：必须为非负整数。 */
function assertCoordinate(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label}必须为非负整数，收到: ${value}`);
  }
}

/**
 * 校验 run/fire 的命令文本：维持「一行写入、一个 marker」的单行协议不变量。
 * 含换行符会把协议行拆成多行；含 marker 形态文本则可能伪造后续回执。
 */
function assertSingleLineCommand(cmd: string): void {
  if (cmd.includes("\n") || cmd.includes("\r")) {
    throw new TypeError("命令不能包含换行符（会破坏持久 shell 的单行拼接与 marker 回执协议）");
  }
  if (PERSISTENT_MARKER_RE.test(cmd)) {
    throw new TypeError("命令与回执 marker 冲突（包含 __DMCTS_*_DONE__ 形态的保留文本）");
  }
}

/**
 * 回执解码：只解码 marker 之前的字节（MIGRATION_NOTES §2 原始字节策略——匹配
 * 阶段不解码），utf-8 坏字节替换为 U+FFFD；Windows adb 输出 CRLF，剥 \r，并
 * 去掉 marker 前最后一行的行尾。
 */
function normalizeReceiptText(bytes: Buffer): string {
  const text = bytes.toString("utf8").replace(/\r\n/g, "\n");
  return text.replace(/\n$/, "");
}

/** 回执等待器（同一时刻至多一个活跃等待器，由实例内 promise 链串行化保证）。 */
interface ReceiptWaiter {
  /** 期望的 marker 文本（ASCII）。 */
  marker: string;
  /** marker 的字节形态（用于原始 Buffer 上的字节级搜索）。 */
  markerBytes: Buffer;
  resolve: (output: string) => void;
  reject: (err: Error) => void;
  /** 回执超时定时器；settle 后清除。 */
  timer: NodeJS.Timeout;
  /** 是否已 settle（超时 / EOF / 命中 / close 多路竞争的去重标志）。 */
  settled: boolean;
}

/** marker 命中结果：outputEnd = 回执输出（marker 前字节）结束偏移；consumeEnd = 应消费偏移。 */
interface MarkerMatch {
  outputEnd: number;
  consumeEnd: number;
}

/**
 * 持久 ADB shell 会话：一条常驻 `adb [-s DEV] shell` 交互进程 + 单行拼接 +
 * ASCII marker 回执（借鉴 damai PersistentAdbShell；fire 形态对应 damai_mode0）。
 *
 * 协议不变量：每次写入都是一行 `<命令>; echo __DMCTS_<KIND>_<n>_DONE__\n`
 * （实例内自增序号保证 marker 唯一），一次写入对应一个 marker；run/taps/swipe/fire
 * 的写入经实例内 promise 链串行化，并发调用不会交错写 stdin。回执匹配在原始
 * Buffer 上做字节级搜索（不整段解码），并要求 marker **独占一行**（行首 +
 * 行尾锚定）——交互式 shell 的 pty 会把命令行本身回显到 stdout（`cmd; echo
 * MARKER` 整行出现），行锚定使回显天然不误命中；Windows adb 输出 CRLF，命中时
 * 剥 \r。`run()` 返回 marker 之前的原始输出行（真实设备上可能含回显的命令行与
 * shell 提示符，与 damai 原版一致，由调用方自行过滤）。
 *
 * 失败三分级（中文）：写入前活性检查失败 → {@link AdbShellClosedError}「持久
 * shell 进程已退出」；stdout end/close 先于 marker → {@link AdbShellClosedError}
 * 「持久 shell 在命令完成前结束」；超时 → {@link AdbShellTimeoutError}「持久
 * shell 命令超时（>Nms）」。
 */
export class PersistentAdbShell {
  private readonly child: ChildProcess;
  private readonly stdout: Readable;
  private readonly stderr: Readable;
  private readonly stdin: Writable;
  private readonly defaultReceiptTimeoutMs: number;

  /** 尚未消费的 stdout 原始字节（命中后从累积缓冲消费掉 marker 及其行尾）。 */
  private pending: Buffer = Buffer.alloc(0);
  /**
   * 累积缓冲 0 偏移是否位于行边界：流起点 / 刚消费掉完整 marker 行尾时为 true，
   * 仅防泄漏裁剪（任意字节处截断）后为 false。允许 marker 出现在缓冲 0 偏移。
   */
  private pendingAtLineStart = true;
  /** 当前回执等待器；fire() 不注册，串行化保证至多一个活跃等待器。 */
  private waiter: ReceiptWaiter | null = null;
  /** 实例内 marker 自增序号（写入时分配）。 */
  private seq = 0;
  /** 串行化队列尾：所有写入（含 fire）经它排队。 */
  private queueTail: Promise<unknown> = Promise.resolve();
  /** close() 是否已启动（幂等标志）。 */
  private closed = false;
  /** close() 的进行中/完成 Promise（重复调用复用）。 */
  private closePromise: Promise<void> | null = null;
  /** stdout 是否已 end/close（EOF 后通道判死）。 */
  private streamEnded = false;

  private readonly onStdoutData = (chunk: Buffer): void => {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const waiter = this.waiter;
    if (waiter !== null && !waiter.settled) {
      const match = this.findMarkerLine(waiter.markerBytes, false);
      if (match !== null) {
        this.settleReceipt(waiter, match);
      }
    }
    this.trimPendingIfRunaway();
  };

  private readonly onStdoutEof = (): void => {
    if (this.streamEnded) {
      return;
    }
    this.streamEnded = true;
    const waiter = this.waiter;
    if (waiter === null || waiter.settled) {
      return;
    }
    // 末次机会：进程死亡截断了行尾但 marker 已整行到达时仍算命中（EOF 并非「先于」marker）
    const match = this.findMarkerLine(waiter.markerBytes, true);
    waiter.settled = true;
    this.waiter = null;
    clearTimeout(waiter.timer);
    if (match !== null) {
      const output = normalizeReceiptText(this.pending.subarray(0, match.outputEnd));
      this.pending = this.pending.subarray(match.consumeEnd);
      waiter.resolve(output);
    } else {
      waiter.reject(new AdbShellClosedError("持久 shell 在命令完成前结束"));
    }
  };

  private readonly onStderrData = (chunk: Buffer): void => {
    // 持续 drain 防 stderr 管道背压阻塞；内容仅 debug 日志（对齐 Python stderr=DEVNULL）
    logger.debug(`持久 shell stderr: ${chunk.toString("utf8").slice(0, 200)}`);
  };

  private readonly onChildError = (err: Error): void => {
    logger.debug(`持久 shell 进程错误: ${err.message}`);
    this.onStdoutEof();
  };

  private constructor(
    child: ChildProcess,
    stdout: Readable,
    stderr: Readable,
    stdin: Writable,
    defaultReceiptTimeoutMs: number,
  ) {
    this.child = child;
    this.stdout = stdout;
    this.stderr = stderr;
    this.stdin = stdin;
    this.defaultReceiptTimeoutMs = defaultReceiptTimeoutMs;
    stdout.on("data", this.onStdoutData);
    stdout.once("end", this.onStdoutEof);
    stdout.once("close", this.onStdoutEof);
    stderr.on("data", this.onStderrData);
    stderr.on("error", () => {}); // stderr 流错误仅忽略（data 侧已持续 drain）
    stdin.on("error", () => {}); // 进程死亡导致的 EPIPE 不致命（Python communicate 亦容忍）
    child.on("error", this.onChildError);
  }

  /**
   * 打开持久 shell：解析 adb 路径（复用 {@link whichAdb}）并 spawn
   * `adb [-s DEV] shell`，stdin/stdout/stderr 全管道。
   *
   * @throws {@link ADBError} adb 未找到（沿用 {@link adb} 的原文案）；
   *   {@link AdbShellClosedError} 流不可用（stdio 全管道下不应发生）。
   */
  static async open(options: PersistentShellOptions = {}): Promise<PersistentAdbShell> {
    const { deviceId = null, receiptTimeoutMs = PERSISTENT_DEFAULT_RECEIPT_TIMEOUT_MS } = options;
    const binPath = whichAdb();
    if (binPath === null) {
      throw new ADBError(
        "adb 未找到。请安装 Android Platform Tools 或配置模拟器自带的 adb 到 PATH。",
      );
    }
    const args = deviceId ? ["-s", deviceId, "shell"] : ["shell"];
    const child = spawn(binPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    const { stdin, stdout, stderr } = child;
    if (!stdin || !stdout || !stderr || child.pid === undefined) {
      try {
        child.kill("SIGKILL");
      } catch {
        // 进程未成功拉起时忽略
      }
      throw new AdbShellClosedError("持久 shell 流不可用");
    }
    logger.debug(`持久 shell 已打开: ${binPath} ${args.join(" ")}`);
    return new PersistentAdbShell(child, stdout, stderr, stdin, receiptTimeoutMs);
  }

  /** 通道是否可用（未 close、进程未退出、流未结束）。 */
  get alive(): boolean {
    if (this.closed || this.streamEnded) {
      return false;
    }
    const child = this.child;
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      return false;
    }
    return !this.stdin.destroyed;
  }

  /**
   * N 个 tap 拼一行等回执：`input tap x y; sleep <gap>; …; echo <marker>`。
   * 间隙延时在设备端执行（最多 3 位小数的 `sleep` 秒数，toybox 小数秒要求
   * Android ≥6），宿主只等一个 marker；一次 write + 单回执。
   *
   * @param points 非负整数坐标序列；空数组直接 resolve（不写任何字节）。
   * @param opts.gapMs 相邻 tap 的间隙（毫秒）；0/缺省时不生成 sleep 子句。
   * @param opts.initialDelayMs 首个 tap 前的延时（毫秒）。
   * @throws {TypeError} 坐标非法（同步抛出，中文信息）。
   */
  taps(
    points: ReadonlyArray<readonly [number, number]>,
    opts?: { gapMs?: number; initialDelayMs?: number; receiptTimeoutMs?: number },
  ): Promise<void> {
    if (points.length === 0) {
      return Promise.resolve();
    }
    const gapMs = opts?.gapMs ?? 0;
    const initialDelayMs = opts?.initialDelayMs ?? 0;
    const parts: string[] = [];
    if (initialDelayMs > 0) {
      parts.push(`sleep ${msToSleepSeconds(initialDelayMs)}`);
    }
    points.forEach(([x, y], index) => {
      assertCoordinate(x, `tap 第 ${index} 个点的 x 坐标`);
      assertCoordinate(y, `tap 第 ${index} 个点的 y 坐标`);
      if (index > 0 && gapMs > 0) {
        parts.push(`sleep ${msToSleepSeconds(gapMs)}`);
      }
      parts.push(`input tap ${x} ${y}`);
    });
    const body = parts.join("; ");
    return this.enqueue(async () => {
      this.assertAlive();
      const marker = this.allocMarker("TAP");
      const timeoutMs = this.resolveTimeoutMs(opts);
      // 先注册回执等待器再写入：响应可能在 write 的同一 tick 内同步到达
      const receipt = this.awaitReceipt(marker, timeoutMs);
      this.writeLine(`${body}; echo ${marker}`);
      await receipt;
    });
  }

  /**
   * 单条 swipe 拼一行等回执：`input swipe x1 y1 x2 y2 <durationMs>; echo <marker>`。
   * durationMs 原样透传为 `input swipe` 的 duration（毫秒）。
   *
   * @throws {TypeError} 坐标或时长非法（同步抛出，中文信息）。
   */
  swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number,
    opts?: { receiptTimeoutMs?: number },
  ): Promise<void> {
    assertCoordinate(x1, "swipe 起点 x");
    assertCoordinate(y1, "swipe 起点 y");
    assertCoordinate(x2, "swipe 终点 x");
    assertCoordinate(y2, "swipe 终点 y");
    assertCoordinate(durationMs, "swipe 时长");
    return this.enqueue(async () => {
      this.assertAlive();
      const marker = this.allocMarker("SWIPE");
      const timeoutMs = this.resolveTimeoutMs(opts);
      // 先注册回执等待器再写入：响应可能在 write 的同一 tick 内同步到达
      const receipt = this.awaitReceipt(marker, timeoutMs);
      this.writeLine(`input swipe ${x1} ${y1} ${x2} ${y2} ${durationMs}; echo ${marker}`);
      await receipt;
    });
  }

  /**
   * 通用单命令：写 `<cmd>; echo <marker>` 并等回执。
   *
   * @returns marker 之前的输出行（utf-8 替换解码、剥 \r、去最后一行行尾）。
   *   真实交互 shell 下可能包含回显的命令行与提示符（与 damai 原版一致）。
   * @throws {TypeError} cmd 含换行符或与 marker 同文（同步抛出，中文信息）。
   * @throws {@link AdbShellClosedError} 通道已死；{@link AdbShellTimeoutError} 回执超时。
   */
  run(cmd: string, opts?: { receiptTimeoutMs?: number }): Promise<string> {
    assertSingleLineCommand(cmd);
    return this.enqueue(async () => {
      this.assertAlive();
      const marker = this.allocMarker("CMD");
      const timeoutMs = this.resolveTimeoutMs(opts);
      // 先注册回执等待器再写入：响应可能在 write 的同一 tick 内同步到达
      const receipt = this.awaitReceipt(marker, timeoutMs);
      this.writeLine(`${cmd}; echo ${marker}`);
      return receipt;
    });
  }

  /**
   * 即发即忘（mode0 语义）：只做活性检查 + 写入即返回，不注册回执等待；
   * 连点环里下一条写入天然串行，省一次 RTT。仍会追加自己的 marker（保证
   * 「一次写入对应一个 marker」不变量），该 marker 无人消费，下一条带等待的
   * 命令以其自身 marker 在字节流上唯一定界。
   *
   * @throws {TypeError} cmd 含换行符或与 marker 同文；
   *   {@link AdbShellClosedError} 通道已死（均同步抛出）。
   */
  fire(cmd: string): void {
    assertSingleLineCommand(cmd);
    this.assertAlive();
    void this.enqueue(async () => {
      // 排队期间通道可能已死：fire 无回执可上报，静默放弃
      if (!this.alive) {
        return;
      }
      const marker = this.allocMarker("CMD");
      this.writeLine(`${cmd}; echo ${marker}`);
    }).catch(() => {}); // fire 无等待方：吞掉写入期的尾部异常（stdin EPIPE 等）
  }

  /**
   * 关闭会话：terminate → 最多等 1s → SIGKILL（SIGKILL 后最多再等 1s 即返回，
   * 真实进程必然死亡）。幂等：重复调用 resolve 同一 Promise；进程已死直接返回。
   */
  close(): Promise<void> {
    if (this.closePromise !== null) {
      return this.closePromise;
    }
    this.closed = true;
    const waiter = this.waiter;
    if (waiter !== null && !waiter.settled) {
      waiter.settled = true;
      this.waiter = null;
      clearTimeout(waiter.timer);
      waiter.reject(new AdbShellClosedError("持久 shell 在命令完成前结束"));
    }
    this.detachStreamListeners();
    const child = this.child;
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      this.closePromise = Promise.resolve();
      return this.closePromise;
    }
    try {
      this.stdin.end();
    } catch {
      // stdin 已销毁则忽略
    }
    child.kill("SIGTERM");
    this.closePromise = (async () => {
      if (!(await this.waitForCloseEvent(1000))) {
        child.kill("SIGKILL");
        await this.waitForCloseEvent(1000);
      }
    })();
    return this.closePromise;
  }

  // ------------------------------------------------------------------
  // 内部实现
  // ------------------------------------------------------------------

  /** 写入前活性检查：通道已死时抛「持久 shell 进程已退出」。 */
  private assertAlive(): void {
    if (!this.alive) {
      throw new AdbShellClosedError("持久 shell 进程已退出");
    }
  }

  /** 实例内 promise 链：所有写入串行化，保证「一次写入对应一个 marker」不变量。 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queueTail.then(task, task);
    this.queueTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 解析生效的回执超时（逐次选项覆盖实例默认）。 */
  private resolveTimeoutMs(opts?: { receiptTimeoutMs?: number }): number {
    return opts?.receiptTimeoutMs ?? this.defaultReceiptTimeoutMs;
  }

  /** 分配实例内唯一的回执 marker（写入时调用，序号自增）。 */
  private allocMarker(kind: PersistentMarkerKind): string {
    this.seq += 1;
    return `__DMCTS_${kind}_${this.seq}_DONE__`;
  }

  /** 单行写入（一次 write，UTF-8 命令字节；行尾由协议固定为 \n）。 */
  private writeLine(line: string): void {
    this.stdin.write(Buffer.from(`${line}\n`, "utf8"));
  }

  /** 注册回执等待器；超时路径会自动废弃通道（见类注释的 deviation）。 */
  private awaitReceipt(marker: string, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const waiter: ReceiptWaiter = {
        marker,
        markerBytes: Buffer.from(marker, "utf8"),
        resolve,
        reject,
        settled: false,
        timer: setTimeout(() => {
          if (waiter.settled) {
            return;
          }
          waiter.settled = true;
          this.waiter = null;
          reject(new AdbShellTimeoutError(`持久 shell 命令超时（>${timeoutMs}ms）`));
          // deviation：超时即自动 close()——字节流可能已失步，迟到的 marker
          // 无法与后续命令区分（marker 唯一序号已是双保险，close 兜底）。
          void this.close();
        }, timeoutMs),
      };
      this.waiter = waiter;
    });
  }

  /**
   * 在累积缓冲中查找「独占一行的 marker」：marker 前必须是行首（\n 或流起点），
   * 后必须是行尾（\n / \r\n）。字节级 indexOf 之上加行锚定，是因为交互式 shell
   * 的 pty 回显会把 `cmd; echo MARKER` 整行写回 stdout，裸 indexOf 会命中回显。
   *
   * @param allowMissingLineEnd true 时（EOF 末次匹配）容忍 marker 后没有行尾字节。
   * @returns 命中结果；行尾尚未到达或无命中时返回 null（继续等待/放弃）。
   */
  private findMarkerLine(markerBytes: Buffer, allowMissingLineEnd: boolean): MarkerMatch | null {
    const buf = this.pending;
    let from = 0;
    for (;;) {
      const idx = buf.indexOf(markerBytes, from);
      if (idx < 0) {
        return null;
      }
      const lineStartOk = idx === 0 ? this.pendingAtLineStart : buf[idx - 1] === 0x0a;
      if (!lineStartOk) {
        from = idx + 1;
        continue;
      }
      const after = idx + markerBytes.length;
      if (after >= buf.length) {
        return allowMissingLineEnd ? { outputEnd: idx, consumeEnd: after } : null;
      }
      if (buf[after] === 0x0a) {
        return { outputEnd: idx, consumeEnd: after + 1 };
      }
      if (buf[after] === 0x0d) {
        if (after + 1 >= buf.length) {
          // \r 之后是否跟 \n 尚未知
          return allowMissingLineEnd ? { outputEnd: idx, consumeEnd: after + 1 } : null;
        }
        if (buf[after + 1] === 0x0a) {
          return { outputEnd: idx, consumeEnd: after + 2 };
        }
        from = idx + 1;
        continue;
      }
      from = idx + 1; // 行中还有后续内容 → 不是独占一行的 marker
    }
  }

  /** 命中回执：解码 marker 前的输出、消费缓冲、清除定时器并 resolve。 */
  private settleReceipt(waiter: ReceiptWaiter, match: MarkerMatch): void {
    waiter.settled = true;
    this.waiter = null;
    clearTimeout(waiter.timer);
    const output = normalizeReceiptText(this.pending.subarray(0, match.outputEnd));
    this.pending = this.pending.subarray(match.consumeEnd);
    waiter.resolve(output);
  }

  /** 无回执等待期间的累积上限（纯 fire 模式防泄漏）；未来命令的 marker 必然晚于裁剪点写入，不受影响。 */
  private trimPendingIfRunaway(): void {
    if (this.waiter === null && this.pending.length > PENDING_BUFFER_CAP_BYTES) {
      this.pending = this.pending.subarray(this.pending.length - PENDING_BUFFER_CAP_BYTES);
      this.pendingAtLineStart = false; // 裁剪点可能落在行中
    }
  }

  /** 等待子进程 close/error 事件，最多 ms 毫秒；返回是否观察到退出。 */
  private waitForCloseEvent(ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, ms);
      const onDone = (): void => {
        cleanup();
        resolve(true);
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        this.child.removeListener("close", onDone);
        this.child.removeListener("error", onDone);
      };
      this.child.once("close", onDone);
      this.child.once("error", onDone);
    });
  }

  /** 解绑 stdout/stderr/child 上的监听，释放流引用。 */
  private detachStreamListeners(): void {
    this.stdout.removeListener("data", this.onStdoutData);
    this.stdout.removeListener("end", this.onStdoutEof);
    this.stdout.removeListener("close", this.onStdoutEof);
    this.stderr.removeListener("data", this.onStderrData);
    this.child.removeListener("error", this.onChildError);
  }
}
