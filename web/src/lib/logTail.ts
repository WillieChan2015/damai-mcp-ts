/**
 * 日志尾随 SSE 流构建器（Phase 2+3 logs 项）。
 *
 * 独立成文件的原因：Next 16 对 route.ts 的导出面有类型守卫（next-types-plugin 生成
 * `checkFields<Diff<…>>`），route.ts 只允许 HTTP 方法与段配置导出——实测（tsc 复刻
 * 该守卫）额外导出 `buildLogTailStream` 会使 `next build` 类型检查失败，故实现放本文件，
 * `app/api/logs/tail/route.ts` 只留薄 GET 封装，测试直调本文件导出。
 *
 * 数据源：`resolveLogDir()` 目录里 pino-roll 沉降的当前日志文件（instrumentation
 * register 时经 core `configure` 开启，按天 + 20MB 轮转）。协议与清理复用 tasks
 * events 路由骨架（`web/src/app/api/tasks/[id]/events/route.ts:29-105`）：
 * - `event: log` `data: {"line":"…"}` —— 一行一条（含初始 backlog 与实时增量）；
 *   系统提示行以 `—— … ——` 形式混入同一事件（滚动/空目录/读异常等）；
 * - 心跳注释行 `: heartbeat` 每 15s 防代理超时断连；
 * - 客户端断开（signal abort）即停止轮询并清理定时器。
 *
 * 增量算法：记录已消费字节 offset；每 pollMs 重解析当前文件——文件变更（跨天 /
 * 20MB 轮转）发滚动系统行并重读 backlog；同文件且变大则从 offset 读到文件尾，
 * 按 `\n` 切行，不完整尾行（含跨轮读到的半个多字节字符）留待下一轮从 offset
 * 重读时自然补全。目录暂无文件 / 读取异常发中文系统行并继续监听，不关流。
 */

import { open } from "node:fs/promises";
import { basename } from "node:path";

import { resolveCurrentLogFile } from "./logPaths";

/** SSE 心跳间隔（15s，与 tasks events 路由一致）。 */
const HEARTBEAT_MS = 15_000;
/** 初始 backlog：文件 ≤4MB 全读。 */
const FULL_READ_LIMIT_BYTES = 4 * 1024 * 1024;
/** 初始 backlog：文件 >4MB 时从尾部 1MB 起读（起点落在行中间的部分行会被丢弃）。 */
const TAIL_WINDOW_BYTES = 1024 * 1024;
/** backlog 最大行数默认值。 */
const DEFAULT_MAX_LINES = 500;
/** backlog 最大行数硬上限。 */
const MAX_LINES_CAP = 5000;
/** 轮询间隔默认值（毫秒）；测试可传小值加速。 */
const DEFAULT_POLL_MS = 1000;
/** 换行符字节。 */
const NL = 0x0a;

/** {@link buildLogTailStream} 的参数。 */
export interface LogTailStreamOptions {
  /** 日志目录（pino-roll 沉降目录）。 */
  dir: string;
  /** 初始 backlog 最大行数，默认 500，上限 5000。 */
  maxLines?: number;
  /** 轮询间隔毫秒数，默认 1000；测试可传 15。 */
  pollMs?: number;
  /** 客户端中断信号（GET 传 req.signal；abort 即停轮询并清理）。 */
  signal?: AbortSignal;
}

/**
 * 把一段原始字节切成完整行：只产出以 `\n` 结尾的部分，不完整尾行不产生输出，
 * 其字节将在下一轮从 offset 重读时自然拼全。`dropLeadingPartial` 用于
 * 从文件中段起读（backlog 尾窗 / 上一轮整体无换行）时丢弃头部半行。
 *
 * 返回 `offset` = 已消费到的文件字节位（恰在某个 `\n` 之后，或维持原位）；
 * `advanced` = 本轮是否推进过 `\n` 边界（用于维护「起点是否落在行中间」状态）。
 */
function cutCompleteLines(
  chunk: Buffer,
  chunkStartOffset: number,
  dropLeadingPartial: boolean,
): { offset: number; advanced: boolean; lines: string[] } {
  const lastNl = chunk.lastIndexOf(NL);
  if (lastNl === -1) {
    // 整段无换行：不产出任何行，offset 维持原位（下轮重读拼全）
    return { offset: chunkStartOffset, advanced: false, lines: [] };
  }
  let lineStart = 0;
  if (dropLeadingPartial) {
    const firstNl = chunk.indexOf(NL);
    if (firstNl === -1 || firstNl >= lastNl) {
      // 首个换行即末个换行：换行前整段是残行（起点未知），全部丢弃
      return { offset: chunkStartOffset + lastNl + 1, advanced: true, lines: [] };
    }
    lineStart = firstNl + 1;
  }
  // 从行边界到 `\n` 的字节段整体解码——UTF-8 多字节序列不会被 \n 截断
  const lines = chunk.toString("utf8", lineStart, lastNl + 1).split("\n");
  lines.pop(); // 末尾必然是切分产生的空串
  return { offset: chunkStartOffset + lastNl + 1, advanced: true, lines };
}

/** 从文件 [start, end) 字节区间读取内容（循环读满，短读即止）。 */
async function readRange(path: string, start: number, end: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const length = Math.max(0, end - start);
    const buffer = Buffer.allocUnsafe(length);
    let readTotal = 0;
    while (readTotal < length) {
      const { bytesRead } = await handle.read(buffer, readTotal, length - readTotal, start + readTotal);
      if (bytesRead <= 0) {
        break; // 文件被并发截断等异常情形：读到多少算多少
      }
      readTotal += bytesRead;
    }
    return buffer.subarray(0, readTotal);
  } finally {
    await handle.close();
  }
}

/**
 * 构建日志尾随 SSE 流（导出供测试直调；GET 薄封装——对齐 events 路由直测先例）。
 *
 * 流生命周期：start 内完成首轮（backlog 或「目录暂无文件」提示）并自续轮询；
 * abort / 发送失败即清理心跳与轮询定时器并关流。定时器均 unref，
 * 避免悬空流把进程（或测试进程）吊住。
 */
export function buildLogTailStream(opts: LogTailStreamOptions): ReadableStream<Uint8Array> {
  const dir = opts.dir;
  const maxLines =
    opts.maxLines !== undefined && Number.isFinite(opts.maxLines)
      ? Math.min(Math.max(Math.trunc(opts.maxLines), 1), MAX_LINES_CAP)
      : DEFAULT_MAX_LINES;
  const pollMs =
    opts.pollMs !== undefined && Number.isFinite(opts.pollMs) && opts.pollMs > 0
      ? opts.pollMs
      : DEFAULT_POLL_MS;
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let pollTimer: ReturnType<typeof setTimeout> | null = null;
      let polling = false;

      // 当前跟踪的日志文件、已消费字节位、起点是否落在行中间（中段起读残留）
      let currentFile: string | null = null;
      let offset = 0;
      let midLine = false;
      // 目录持续为空时只提示一次；首次解析（初始 backlog）不发「发现文件」提示
      let announcedEmpty = false;
      let firstResolve = true;

      const close = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        if (heartbeat !== null) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        if (pollTimer !== null) {
          clearTimeout(pollTimer);
          pollTimer = null;
        }
        try {
          controller.close();
        } catch {
          // 客户端已断开时 close 可能抛错——忽略
        }
      };

      const send = (line: string): void => {
        if (closed) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(`event: log\ndata: ${JSON.stringify({ line })}\n\n`));
        } catch {
          close();
        }
      };

      const schedule = (): void => {
        if (closed) {
          return;
        }
        pollTimer = setTimeout(() => {
          void pollOnce();
        }, pollMs);
        (pollTimer as unknown as { unref?: () => void }).unref?.();
      };

      /** 读初始 backlog（轮转到新文件时也走这里）：≤4MB 全读，>4MB 读尾 1MB；行数按 maxLines 取尾。 */
      const readBacklog = async (path: string): Promise<void> => {
        const handle = await open(path, "r");
        let size: number;
        try {
          size = (await handle.stat()).size;
        } finally {
          await handle.close();
        }
        offset = 0;
        midLine = false;
        if (size === 0) {
          return;
        }
        const whole = size <= FULL_READ_LIMIT_BYTES;
        const start = whole ? 0 : Math.max(0, size - TAIL_WINDOW_BYTES);
        const chunk = await readRange(path, start, size);
        const cut = cutCompleteLines(chunk, start, !whole);
        offset = cut.offset;
        midLine = !cut.advanced && start > 0;
        const lines = cut.lines.length > maxLines ? cut.lines.slice(-maxLines) : cut.lines;
        for (const line of lines) {
          send(line);
        }
      };

      /** 同文件增量：从 offset 读到当前文件尾，完整行逐条发送。 */
      const readIncrement = async (path: string): Promise<void> => {
        const handle = await open(path, "r");
        let size: number;
        try {
          size = (await handle.stat()).size;
        } finally {
          await handle.close();
        }
        if (size < offset) {
          // 文件被外部截断/重写：重置跟踪，下一轮从头读
          send("—— 日志文件被截断，将从头读取 ——");
          offset = 0;
          midLine = false;
          return;
        }
        if (size === offset) {
          return; // 无新字节；offset 之后的残行无需缓存，下轮重读自然拼全
        }
        const fresh = await readRange(path, offset, size);
        const cut = cutCompleteLines(fresh, offset, midLine);
        offset = cut.offset;
        if (cut.advanced) {
          midLine = false;
        }
        for (const line of cut.lines) {
          send(line);
        }
      };

      const pollOnce = async (): Promise<void> => {
        if (closed || polling) {
          return;
        }
        polling = true;
        try {
          const latest = resolveCurrentLogFile(dir);
          if (latest === null) {
            if (currentFile !== null) {
              send(`—— 日志文件 ${basename(currentFile)} 已消失，继续监听目录 ——`);
              currentFile = null;
            } else if (firstResolve || !announcedEmpty) {
              send("—— 日志目录尚无文件（configure 未落盘或暂无输出），将持续监听 …… ——");
            }
            announcedEmpty = true;
          } else {
            announcedEmpty = false;
            if (latest !== currentFile) {
              const rotated = currentFile !== null;
              currentFile = latest;
              if (rotated) {
                send(`—— 日志滚动到 ${basename(latest)} ——`);
              } else if (!firstResolve) {
                send(`—— 发现日志文件 ${basename(latest)} ——`);
              }
              await readBacklog(latest);
            } else {
              await readIncrement(latest);
            }
          }
        } catch (exc) {
          send(`—— 读取日志异常（将继续监听）：${exc instanceof Error ? exc.message : String(exc)} ——`);
        } finally {
          firstResolve = false;
          polling = false;
          schedule();
        }
      };

      if (opts.signal?.aborted) {
        close();
        return;
      }
      opts.signal?.addEventListener("abort", close, { once: true });

      heartbeat = setInterval(() => {
        if (closed) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          close();
        }
      }, HEARTBEAT_MS);
      (heartbeat as unknown as { unref?: () => void }).unref?.();

      void pollOnce();
    },
  });
}
