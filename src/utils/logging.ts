/**
 * 集中式 pino 日志配置（Python `utils/logging.py` 的 TS 对应物）。
 *
 * 所有模块都从这里导入 {@link logger}，以保证格式 / 沉降（sink）一致：
 * - stderr：彩色（loguru `colorize=True` 语义——即使重定向也输出 ANSI 颜色），
 *   级别由 `configure(level)` 控制，默认（未 configure 时）与 loguru 默认一致为 DEBUG；
 * - 可选文件沉降：DEBUG 级别起记录，按天 + 20 MB 轮转（pino-roll）。
 *
 * 行格式复刻 loguru 的 `_DEFAULT_FMT`：
 * `YYYY-MM-DD HH:mm:ss.SSS | LEVEL(8) | module:function:line - message`
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
// pino-roll 未随包提供 TypeScript 类型定义（其导出是一个异步 build 函数：
// module.exports = async function build(options) => SonicBoom）。
// @ts-expect-error — pino-roll 没有自带类型声明
import pinoRollBuild from "pino-roll";
import pino from "pino";

type PinoLogger = import("pino").Logger;
/** pino 单条日志方法的签名。 */
type PinoLogFn = PinoLogger["error"];

/** 本项目使用的 logger 类型：pino.Logger 附加 loguru 风格的 `warning` 别名。 */
export type DamaiLogger = PinoLogger & { warning: PinoLogFn };

/** 与 Python 版一致的文件沉降句柄最小接口（SonicBoom 满足）。 */
interface RollStream {
  write(chunk: string): void;
  end(): void;
}

/** 各沉降的运行时状态（对应 Python 版 loguru 实例上的 sink 列表）。 */
interface SinkState {
  /** stderr 沉降的最低 pino 数值级别。 */
  stderrLevel: number;
  /** 文件沉降流；null 表示未启用。 */
  fileStream: RollStream | null;
  /** 文件流就绪前缓冲的日志行。 */
  filePending: string[];
}

/** 文件流就绪前最多缓冲多少行（防御性上限，正常启动场景远用不到）。 */
const FILE_PENDING_CAP = 10_000;

/** pino 数值级别 → loguru 风格显示名（warn→WARNING、fatal→CRITICAL）。 */
const LEVEL_LABELS: Record<number, string> = {
  10: "TRACE",
  20: "DEBUG",
  30: "INFO",
  40: "WARNING",
  50: "ERROR",
  60: "CRITICAL",
};

/** loguru 默认严重级别配色（TRACE 蓝 / DEBUG 青 / INFO 加粗 / WARNING 黄 / ERROR 红 / CRITICAL 紫）。 */
const LEVEL_COLORS: Record<string, string> = {
  TRACE: "\x1b[34m",
  DEBUG: "\x1b[36m",
  INFO: "\x1b[1m",
  WARNING: "\x1b[1;33m",
  ERROR: "\x1b[1;31m",
  CRITICAL: "\x1b[1;35m",
};

const ANSI_RESET = "\x1b[0m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_CYAN = "\x1b[36m";

/** 沉降状态（模块级单例；configure 原地更新，logger 身份保持不变——与 Python 版一致）。 */
const sinkState: SinkState = {
  stderrLevel: 20, // 未 configure 时与 loguru 默认 stderr sink 一致：DEBUG
  fileStream: null,
  filePending: [],
};

/** 本模块自身的栈帧（captureCaller 要跳过包装层帧）。 */
const SELF_FRAME_RE = /[\\/]logging\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)(?:\?|$)/;

/**
 * 捕获日志调用方位置，产出 loguru `{name}:{function}:{line}` 风格的串。
 * `{name}` 用文件名去扩展名近似（loguru 用完整模块名）；解析失败返回占位值。
 */
function captureCaller(): string {
  const stack = new Error().stack;
  if (!stack) {
    return "?:?:0";
  }
  for (const raw of stack.split("\n").slice(1)) {
    const line = raw.trim();
    if (!line.startsWith("at ")) {
      continue;
    }
    const body = line.slice(3);
    let fnName = "";
    let location: string;
    const parenIdx = body.lastIndexOf(" (");
    if (parenIdx !== -1 && body.endsWith(")")) {
      fnName = body.slice(0, parenIdx).trim();
      location = body.slice(parenIdx + 2, -1);
    } else {
      location = body.trim();
    }
    if (fnName.startsWith("async ")) {
      fnName = fnName.slice(6).trim();
    }
    const m = /^(.+):(\d+):\d+$/.exec(location);
    if (!m) {
      continue;
    }
    const [, file, lineNo] = m;
    if (!file || file.startsWith("node:") || SELF_FRAME_RE.test(file)) {
      continue;
    }
    const base = file.replace(/\\/g, "/").split("/").pop() ?? "";
    const mod = base.replace(/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/, "") || "?";
    return `${mod}:${fnName || "<anonymous>"}:${lineNo}`;
  }
  return "?:?:0";
}

/** 级别方法包装：为每条记录注入 caller 字段（对应 loguru 每次调用捕获调用方栈帧）。 */
const WRAPPED_LEVELS: readonly string[] = ["trace", "debug", "info", "warn", "error", "fatal"];

function withCallerCapture(base: PinoLogger): DamaiLogger {
  return new Proxy(base, {
    get(target, prop) {
      if (typeof prop !== "string") {
        return Reflect.get(target, prop, target);
      }
      const levelProp = prop === "warning" ? "warn" : prop; // loguru 命名兼容别名
      if (WRAPPED_LEVELS.includes(levelProp)) {
        const orig = (target as unknown as Record<string, PinoLogFn>)[
          levelProp
        ] as unknown as (ctx: object, ...rest: unknown[]) => void;
        return (...args: unknown[]): void => {
          const caller = captureCaller();
          const first = args[0];
          if (first !== null && typeof first === "object" && !(first instanceof Error)) {
            return orig.call(
              target,
              { caller, ...(first as Record<string, unknown>) },
              ...args.slice(1),
            );
          }
          return orig.call(target, { caller }, ...args);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as DamaiLogger;
}

/** 本地时间 `YYYY-MM-DD HH:mm:ss.SSS`（对应 loguru `{time:YYYY-MM-DD HH:mm:ss.SSS}`）。 */
function formatLocalTimestamp(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  );
}

/** 把一行 pino JSON 记录按 loguru 格式分发到 stderr（彩色、按级别过滤）与文件（纯文本）。 */
function emitRecord(chunk: string): void {
  const trimmed = chunk.trimEnd();
  if (!trimmed) {
    return;
  }
  let rec: { level?: number; time?: number; msg?: unknown; caller?: unknown };
  try {
    rec = JSON.parse(trimmed);
  } catch {
    return; // 非 JSON 行（不应发生），静默丢弃
  }
  const levelNum = typeof rec.level === "number" ? rec.level : 30;
  const time = typeof rec.time === "number" ? new Date(rec.time) : new Date();
  const ts = formatLocalTimestamp(time);
  const label = LEVEL_LABELS[levelNum] ?? `LEVEL${levelNum}`;
  const caller = typeof rec.caller === "string" && rec.caller !== "" ? rec.caller : "?";
  const msg =
    typeof rec.msg === "string" ? rec.msg : rec.msg === undefined ? "" : String(rec.msg);
  const padded = label.padEnd(8);

  if (levelNum >= sinkState.stderrLevel) {
    const color = LEVEL_COLORS[label] ?? "";
    process.stderr.write(
      `${ANSI_GREEN}${ts}${ANSI_RESET} | ${color}${padded}${ANSI_RESET} | ` +
        `${ANSI_CYAN}${caller}${ANSI_RESET} - ${color}${msg}${ANSI_RESET}\n`,
    );
  }
  writeToFileLine(`${ts} | ${padded} | ${caller} - ${msg}\n`);
}

/** 文件沉降写入；文件流未就绪时先缓冲。 */
function writeToFileLine(line: string): void {
  if (sinkState.fileStream) {
    sinkState.fileStream.write(line);
    return;
  }
  if (sinkState.filePending.length < FILE_PENDING_CAP) {
    sinkState.filePending.push(line);
  }
}

/** pino 的调度目标（loguru 多 sink 的等价物：一条记录按需分发到各沉降）。 */
const dispatcher = {
  write(chunk: string): void {
    try {
      emitRecord(chunk);
    } catch {
      // 日志系统自身绝不向外抛异常
    }
  },
};

/** 全局 logger。级别恒为 debug（放行到调度器），各 sink 自行过滤级别——
 * 与 Python 版「stderr 按 level、文件按 DEBUG」的分流语义一致。 */
export const logger: DamaiLogger = withCallerCapture(pino({ level: "debug" }, dispatcher));

/**
 * 启动时一次性配置根 logger。
 *
 * 幂等——重复调用不会叠加重复的处理器（对应 Python 版 `logger.remove()` 后重加）。
 *
 * @param level stderr 沉降的最低级别（大小写不敏感；文件沉降恒为 DEBUG 起）。
 * @param logDir 可选日志目录；给出时启用按天 + 20 MB 轮转的文件沉降。
 */
export async function configure(level: string = "INFO", logDir: string | null = null): Promise<void> {
  const normalized = level.trim().toLowerCase();
  const stderrLevel = (pino.levels.values as Record<string, number | undefined>)[normalized];
  if (stderrLevel === undefined) {
    throw new Error(`无效的日志级别: ${level}`);
  }

  if (sinkState.fileStream) {
    try {
      sinkState.fileStream.end();
    } catch {
      // 尽力而为地关闭旧文件流
    }
    sinkState.fileStream = null;
  }
  sinkState.filePending.length = 0;
  sinkState.stderrLevel = stderrLevel;

  if (logDir != null) {
    await mkdir(logDir, { recursive: true });
    const stream = (await pinoRollBuild({
      file: join(logDir, "damai_mcp"),
      frequency: "daily", // 按天分文件（近似 Python 文件名里的 {time:YYYYMMDD}）
      dateFormat: "yyyyMMdd", // 日期段用 yyyyMMdd，贴近 Python 的 {time:YYYYMMDD}
      size: 20, // 对应 rotation="20 MB"（pino-roll 数值单位为 MB）
      // 对应 retention="7 days" 的近似：保留 7 个轮转文件 + 当前文件
      limit: { count: 7, removeOtherLogFiles: true },
    })) as RollStream;
    sinkState.fileStream = stream;
    for (const line of sinkState.filePending) {
      stream.write(line);
    }
    sinkState.filePending.length = 0;
  }
}
