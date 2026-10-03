/**
 * 极简 NTP 客户端，用于时钟同步（Python `utils/ntp.py` 的 TS 对应物）。
 *
 * 抢票流水线需要所有设备对「开售时间」有一致的认知。我们一次性计算
 * `offset_ms = ntp_unix - local_unix` 并在整个抢票运行期间复用——
 * 低于 ~100 ms 的偏差对抢票而言足够好（服务器通常因排队 + APM 带来 ~50 ms 拖延）。
 *
 * 设计取舍：
 *   - 仅用 Node 标准库（node:dgram），不引入 ntplib 之类的依赖
 *   - UDP、5 秒超时——NTP 服务器在 1 个往返内即返回
 *   - 单臂（single-arm）查询——没有 Originate Timestamp 可回传，因此用
 *     `server_unix - midpoint(local_send, local_recv)` 近似 offset。
 *     该估计偏向半个往返时延，对局域网 NTP 而言可忽略。单臂下该公式退化为
 *     `server - sent - rtt/2`（与 clock.rs 的写法等价），即已含 RTT/2 补偿。
 *   - {@link querySampled} 在此之上做每源多次采样（默认 3 次）取最小 RTT
 *     （最小 RTT 样本的上下行不对称差最小），并给出 uncertainty = rtt/2 +
 *     分辨率的显式误差区间；{@link query} 保持单次交换行为不变。
 *   - MCP 侧 fire-and-forget——调用方可以不 await 地预热同步。
 */

import { createSocket, type Socket } from "node:dgram";

import { adb, formatPyFloat } from "../device/adb";
import { logger } from "./logging";

// NTP 纪元：1900-01-01 00:00 UTC；Unix 纪元：1970-01-01 00:00 UTC
export const NTP_UNIX_DELTA = 2_208_988_800;

export const DEFAULT_NTP_SERVER = "pool.ntp.org";
export const QUERY_TIMEOUT_SEC = 5.0;

/** {@link NtpResult} 的构造参数。 */
export interface NtpResultInit {
  /** 查询的 NTP 服务器。 */
  server: string;
  /** 本机时钟相对服务器的偏移（毫秒）。 */
  offsetMs: number;
  /** 往返时延（毫秒）。 */
  delayMs: number;
  /** 查询完成时的 NTP 时间（Unix 秒）。 */
  serverUnix: number;
  /** 本机发出查询后收到响应的时刻（Unix 秒）。 */
  queriedAtUnix: number;
}

/** 单次 NTP 查询的结果。 */
export class NtpResult {
  /** 查询的 NTP 服务器。 */
  readonly server: string;
  /** 本机时钟相对服务器的偏移（毫秒）。 */
  readonly offsetMs: number;
  /** 往返时延（毫秒）。 */
  readonly delayMs: number;
  /** 查询完成时的 NTP 时间（Unix 秒）。 */
  readonly serverUnix: number;
  /** 本机收到响应的时刻（Unix 秒）。 */
  readonly queriedAtUnix: number;

  constructor(init: NtpResultInit) {
    this.server = init.server;
    this.offsetMs = init.offsetMs;
    this.delayMs = init.delayMs;
    this.serverUnix = init.serverUnix;
    this.queriedAtUnix = init.queriedAtUnix;
  }

  /** offset 在健康带内（< 500 ms）时为 true。 */
  get synced(): boolean {
    return Math.abs(this.offsetMs) < 500.0;
  }

  /**
   * 序列化为普通对象。
   *
   * 键名保持 Python 版 `to_dict()` 的 snake_case 原样（对外表面）。
   */
  toDict(): {
    server: string;
    offset_ms: number;
    delay_ms: number;
    server_unix: number;
    queried_at_unix: number;
    synced: boolean;
  } {
    return {
      server: this.server,
      offset_ms: round2(this.offsetMs),
      delay_ms: round2(this.delayMs),
      server_unix: this.serverUnix,
      queried_at_unix: this.queriedAtUnix,
      synced: this.synced,
    };
  }
}

/** 等价 Python `round(x, 2)`（半值取整方向与 Python 银行家舍入略有差异，仅影响展示）。 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 构造 48 字节 NTP 客户端请求包：LI=0, VN=3 (IPv4), Mode=3 (client)。 */
export function buildRequest(): Buffer {
  const pkt = Buffer.alloc(48);
  pkt[0] = 0x1b; // 00 011 011 = LI 0, VN 3, Mode 3
  return pkt;
}

/** 读取服务器的 Transmit Timestamp（字节 40-47，大端）并解码为 (秒, 小数部分)。 */
export function parseTransmitTs(data: Buffer): readonly [number, number] {
  const seconds = data.readUInt32BE(40);
  const fraction = data.readUInt32BE(44);
  return [seconds, fraction];
}

/** NTP 秒数（1900 纪元）+ 小数部分 → Unix 秒（浮点）。 */
export function ntpSecsToUnix(ntpSeconds: number, ntpFraction: number): number {
  return ntpSeconds - NTP_UNIX_DELTA + ntpFraction / 2 ** 32;
}

/** 以 Python 内建异常的 `str()` 形态抛错：`<Name>: <message>`。 */
function namedError(name: "TimeoutError" | "ConnectionError", message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

/**
 * 单次 NTP 交换（模块内私有）：{@link query} 与 {@link querySampled} 共用的
 * 最小单元——恰好一次 UDP 往返，socket 创建/关闭语义独立完整。
 *
 * @throws 超时（`TimeoutError`）、socket 错误（`ConnectionError`）或响应过短
 *   （`Error`）——错误名与 Python 内建异常对应，`str(err)` 形态一致。
 */
async function queryOnce(server: string, timeout: number): Promise<NtpResult> {
  const sock: Socket = createSocket("udp4");
  // 持久的 error 监听：settle 之后到达的 socket 错误不能变成未捕获异常
  sock.on("error", () => {});

  let data: Buffer;
  // NaN 仅为满足定值赋值分析：executor 同步执行，发送前必被覆盖；
  // 未覆盖的路径（发送前失败）必然 reject，不会走到 midpoint 计算。
  let t1Unix = Number.NaN;
  let t4Unix: number;
  try {
    const received = await new Promise<{ data: Buffer; t4Unix: number }>((resolve, reject) => {
      let settled = false;
      const succeed = (buf: Buffer, recvUnix: number): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ data: buf, t4Unix: recvUnix });
        }
      };
      const fail = (err: Error): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      };

      const timer = setTimeout(() => {
        fail(namedError("TimeoutError", `NTP server '${server}' did not respond in ${formatPyFloat(timeout)}s`));
      }, timeout * 1000);

      sock.once("message", (msg: Buffer) => {
        succeed(msg, Date.now() / 1000);
      });
      sock.once("error", (err: Error) => {
        fail(namedError("ConnectionError", `NTP socket error: ${err.message}`));
      });

      // t1 取在发送前（对应 Python 的 time.time() → sendto 顺序）
      t1Unix = Date.now() / 1000;
      sock.send(buildRequest(), 123, server, (err) => {
        if (err) {
          fail(namedError("ConnectionError", `NTP socket error: ${err.message}`));
        }
      });
    });
    data = received.data;
    t4Unix = received.t4Unix;
  } finally {
    try {
      sock.close();
    } catch {
      // 未绑定/未运行的 socket 关闭可能抛错，尽力而为（Python close 不会抛）
    }
  }

  if (data.length < 48) {
    throw new Error(`NTP response too short: ${data.length} bytes`);
  }

  const [ntpSeconds, ntpFraction] = parseTransmitTs(data);
  const serverUnix = ntpSecsToUnix(ntpSeconds, ntpFraction);

  const midpoint = (t1Unix + t4Unix) / 2;
  const offsetMs = (serverUnix - midpoint) * 1000;
  const delayMs = (t4Unix - t1Unix) * 1000;

  // 对应 Python 的 f"{offset_ms:+.2f}"（恒带符号）与 f"{delay_ms:.2f}"
  const offsetText = `${offsetMs < 0 ? "-" : "+"}${Math.abs(offsetMs).toFixed(2)}`;
  logger.info(`[ntp] server=${server} offset=${offsetText}ms delay=${delayMs.toFixed(2)}ms`);
  return new NtpResult({
    server,
    offsetMs,
    delayMs,
    serverUnix,
    queriedAtUnix: t4Unix,
  });
}

/**
 * 查询 NTP 服务器并计算 offset。
 *
 * Python 原版是同步 socket 实现（`async_query` 用线程池包装它）；Node 的
 * dgram 天然异步，这里直接以异步实现承载同一协议语义，供测试与 CLI 快速
 * 模式使用。单次交换的实现挪入 {@link queryOnce}；本函数对外行为不变
 * （恰好 1 次尝试、同样的错误名与文案、同样的日志）。
 *
 * @throws 超时（`TimeoutError`）、socket 错误（`ConnectionError`）或响应过短
 *   （`Error`）——错误名与 Python 内建异常对应，`str(err)` 形态一致。
 */
export async function query(
  server: string = DEFAULT_NTP_SERVER,
  timeout: number = QUERY_TIMEOUT_SEC,
): Promise<NtpResult> {
  return queryOnce(server, timeout);
}

/**
 * {@link query} 的异步入口，保留与 Python 版相同的名字以维持 API 对等。
 *
 * Python 版用 `run_in_executor` 把阻塞查询挪出事件循环；Node 的 dgram 本身
 * 非阻塞，因此这里只是 `query` 的别名（整个交换约 50-1500ms，不阻塞事件循环）。
 */
export async function asyncQuery(
  server: string = DEFAULT_NTP_SERVER,
  timeout: number = QUERY_TIMEOUT_SEC,
): Promise<NtpResult> {
  return query(server, timeout);
}

// ------ 多次采样（借鉴 clock.rs：每源 3 次采样取最小 RTT + 显式误差区间）------

/**
 * 每个源的采样次数：3 次背靠背采样取最小 RTT（最小 RTT 样本的上下行
 * 不对称差最小，offset 偏差随之最小）。
 */
export const NTP_SAMPLES = 3;

/** 本地时钟分辨率（毫秒）：计入误差半宽，避免零 RTT 时区间塌缩为单点。 */
export const NTP_RESOLUTION_MS = 1;

/** 样本 offset 的合法域：|offset| ≤ 24h（借鉴 clock.rs 的同款门槛），超出视为无效样本。 */
export const NTP_MAX_OFFSET_ABS_MS = 86_400_000;

/**
 * 服务器时间戳的最低可信值（Unix 秒，≈2020-09）：低于此值视为无效样本。
 *
 * 对应 clock.rs 的 `server > 1.6e12`（毫秒制）门槛换算到本模块的秒制时间轴。
 */
export const NTP_MIN_SERVER_UNIX = 1.6e9;

/** {@link NtpSampleResult} 的构造参数。 */
export interface NtpSampleResultInit {
  /** 查询的 NTP 服务器。 */
  server: string;
  /** 最小 RTT 样本的偏移（毫秒）。单臂公式已含 RTT/2 补偿（见模块头注释）。 */
  offsetMs: number;
  /** 有效样本中的最小往返时延（毫秒）。 */
  roundTripMs: number;
  /** 误差半宽（毫秒）= roundTripMs / 2 + 分辨率。 */
  uncertaintyMs: number;
  /** 有效样本数（≥1；超时/socket 错误/无效样本不计入）。 */
  samples: number;
  /** 收到最优样本响应的时刻（Unix 秒）。 */
  sampledAtUnix: number;
  /**
   * 最优样本的服务器 Transmit Timestamp（Unix 秒）。
   *
   * 可选（additive）：既有直接构造 {@link NtpSampleResult} 的调用方不受影响；
   * {@link querySampled} 返回时恒填该字段。
   */
  serverUnix?: number;
}

/**
 * 多次采样后的 NTP 查询结果（借鉴 clock.rs 的采样语义）。
 *
 * 数学说明：单臂下标准 offset 公式退化为 `server − t1 − rtt/2`，与 clock.rs
 * 的 `offset = server − sent − rtt/2` 等价，即已含 RTT/2 补偿；取最小 RTT
 * 样本可最小化上下行不对称引入的偏差，且 `[offset − uncertainty,
 * offset + uncertainty]`（uncertainty = rtt/2 + 分辨率）必覆盖真实偏差。
 */
export class NtpSampleResult {
  /** 查询的 NTP 服务器。 */
  readonly server: string;
  /** 最小 RTT 样本的偏移（毫秒，已含 RTT/2 补偿）。 */
  readonly offsetMs: number;
  /** 有效样本中的最小往返时延（毫秒）。 */
  readonly roundTripMs: number;
  /** 误差半宽（毫秒）。 */
  readonly uncertaintyMs: number;
  /** 有效样本数（≥1）。 */
  readonly samples: number;
  /** 收到最优样本响应的时刻（Unix 秒）。 */
  readonly sampledAtUnix: number;
  /**
   * 最优样本的服务器 Transmit Timestamp（Unix 秒）。
   *
   * 与 {@link NtpResult.serverUnix} 同语义；`querySampled` 恒填，直接构造时
   * 可缺省（undefined）。注意与 {@link sampledAtUnix}（= t4 本地收包时刻）
   * 语义不同——需要「服务器认为现在是几点」时用本字段。
   */
  readonly serverUnix: number | undefined;

  constructor(init: NtpSampleResultInit) {
    this.server = init.server;
    this.offsetMs = init.offsetMs;
    this.roundTripMs = init.roundTripMs;
    this.uncertaintyMs = init.uncertaintyMs;
    this.samples = init.samples;
    this.sampledAtUnix = init.sampledAtUnix;
    this.serverUnix = init.serverUnix;
  }

  /** 误差区间下界（毫秒）：offsetMs − uncertaintyMs。 */
  get intervalLoMs(): number {
    return this.offsetMs - this.uncertaintyMs;
  }

  /** 误差区间上界（毫秒）：offsetMs + uncertaintyMs。 */
  get intervalHiMs(): number {
    return this.offsetMs + this.uncertaintyMs;
  }

  /** offset 在健康带内（< 500 ms）时为 true——与 {@link NtpResult.synced} 同一规则。 */
  get synced(): boolean {
    return Math.abs(this.offsetMs) < 500.0;
  }

  /**
   * 序列化为普通对象。
   *
   * 键名为 snake_case（对外表面，与 {@link NtpResult.toDict} 同风格）。
   */
  toDict(): {
    server: string;
    offset_ms: number;
    round_trip_ms: number;
    uncertainty_ms: number;
    interval_low_ms: number;
    interval_high_ms: number;
    samples: number;
    sampled_at_unix: number;
    synced: boolean;
  } {
    return {
      server: this.server,
      offset_ms: round2(this.offsetMs),
      round_trip_ms: round2(this.roundTripMs),
      uncertainty_ms: round2(this.uncertaintyMs),
      interval_low_ms: round2(this.intervalLoMs),
      interval_high_ms: round2(this.intervalHiMs),
      samples: this.samples,
      sampled_at_unix: this.sampledAtUnix,
      synced: this.synced,
    };
  }
}

/** {@link querySampled} 的可选项。 */
export interface NtpSampledOptions {
  /** 采样次数，必须为正整数；默认 {@link NTP_SAMPLES}。 */
  samples?: number;
  /** 本地时钟分辨率（毫秒），计入误差半宽；默认 {@link NTP_RESOLUTION_MS}。 */
  resolutionMs?: number;
}

/**
 * 查询 NTP 服务器：顺序采样多次（默认 {@link NTP_SAMPLES} 次，背靠背、不强制
 * 间隔，每次采样都是 {@link queryOnce} 的独立 socket），取最小 RTT 的有效
 * 样本并给出显式误差区间。
 *
 * - 样本有效性门槛：`serverUnix > NTP_MIN_SERVER_UNIX` 且
 *   `|offsetMs| ≤ NTP_MAX_OFFSET_ABS_MS`；无效样本丢弃并计入失败
 *   （错误文案「NTP 样本无效: …」）；
 * - 部分尝试失败时只要 ≥1 个有效样本即成功（{@link NtpSampleResult.samples}
 *   如实记录有效数）；全部失败（含全部无效）则重抛**最后一个**错误，
 *   保留 {@link query} 的既有错误形态（`TimeoutError`/`ConnectionError`
 *   的 name 与文案）。
 *
 * @param timeout 单次采样的超时（秒）。
 * @throws 超时（`TimeoutError`）、socket 错误（`ConnectionError`）、响应过短
 *   （`Error`）或样本全部无效（`Error`，中文「NTP 样本无效」）；采样次数
 *   非正整数时抛中文 `Error`。
 */
export async function querySampled(
  server: string = DEFAULT_NTP_SERVER,
  timeout: number = QUERY_TIMEOUT_SEC,
  options: NtpSampledOptions = {},
): Promise<NtpSampleResult> {
  const requested = options.samples ?? NTP_SAMPLES;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error(`NTP 采样次数必须为正整数: ${requested}`);
  }
  const resolutionMs = Math.max(0, options.resolutionMs ?? NTP_RESOLUTION_MS);

  let best: NtpResult | null = null;
  let validSamples = 0;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < requested; attempt++) {
    let sample: NtpResult;
    try {
      sample = await queryOnce(server, timeout);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      continue;
    }
    if (
      sample.serverUnix <= NTP_MIN_SERVER_UNIX ||
      Math.abs(sample.offsetMs) > NTP_MAX_OFFSET_ABS_MS
    ) {
      lastError = new Error(
        `NTP 样本无效: server=${server} ` +
          `server_unix=${sample.serverUnix.toFixed(3)} ` +
          `offset=${sample.offsetMs.toFixed(2)}ms`,
      );
      logger.debug(lastError.message);
      continue;
    }
    validSamples += 1;
    if (best === null || sample.delayMs < best.delayMs) {
      best = sample;
    }
  }

  if (best === null) {
    // 全部尝试失败：重抛最后一个错误（保留既有 TimeoutError/ConnectionError 形态）
    throw lastError ?? new Error(`NTP 采样全部失败: server=${server}`);
  }

  const uncertaintyMs = best.delayMs / 2 + resolutionMs;
  // 对应 Python 的 f"{offset_ms:+.2f}"（恒带符号）
  const offsetText = `${best.offsetMs < 0 ? "-" : "+"}${Math.abs(best.offsetMs).toFixed(2)}`;
  logger.info(
    `[ntp] sampled server=${server} offset=${offsetText}ms rtt=${best.delayMs.toFixed(2)}ms ` +
      `uncertainty=${uncertaintyMs.toFixed(2)}ms samples=${validSamples}/${requested}`,
  );
  return new NtpSampleResult({
    server,
    offsetMs: best.offsetMs,
    roundTripMs: best.delayMs,
    uncertaintyMs,
    samples: validSamples,
    sampledAtUnix: best.queriedAtUnix,
    serverUnix: best.serverUnix,
  });
}

/** 校时来源。manual 由调用方填入，不经过本函数。 */
export type ClockSource = "ntp" | "taobao" | "bilibili" | "manual";

/** 一次可用的时钟修正。 */
export interface ClockFix {
  offsetMs: number;
  /** 手动修正时为 null。 */
  uncertaintyMs: number | null;
  /** HTTP 来源没有多次采样时为 null。 */
  samples: number | null;
  source: ClockSource;
}

const TAOBAO_TIME_URL = "https://api.m.taobao.com/rest/api3.do?api=mtop.common.getTimestamp";
const BILIBILI_TIME_URL = "https://api.bilibili.com/x/report/click/now";

/** 单臂 offset：server − sent − rtt/2。 */
export function clockOffsetFromExchange(serverMs: number, sentMs: number, roundTripMs: number): number {
  return serverMs - sentMs - roundTripMs / 2;
}

function validClockSample(serverMs: number, offsetMs: number): boolean {
  return serverMs > 1_600_000_000_000 && Math.abs(offsetMs) <= NTP_MAX_OFFSET_ABS_MS;
}

async function readPublicClock(
  fetchImpl: typeof fetch,
  url: string,
  source: "taobao" | "bilibili",
  resolutionMs: number,
  readServerMs: (body: unknown) => number | null,
): Promise<ClockFix | null> {
  const sentMs = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { "Cache-Control": "no-cache, no-store" },
      signal: AbortSignal.timeout(4000),
    });
  } catch (err) {
    logger.warning(
      `公共时间 ${source} 请求失败: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  const roundTripMs = Date.now() - sentMs;
  if (!response.ok) {
    return null;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  const serverMs = readServerMs(body);
  if (serverMs === null) {
    return null;
  }
  const offsetMs = clockOffsetFromExchange(serverMs, sentMs, roundTripMs);
  if (!validClockSample(serverMs, offsetMs)) {
    return null;
  }
  return {
    offsetMs,
    uncertaintyMs: roundTripMs / 2 + resolutionMs,
    samples: null,
    source,
  };
}

function numberField(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

/**
 * 先做 NTP 多次采样；失败后再请求淘宝毫秒时间和 Bilibili 秒级时间。
 * 请求不带账号 Cookie。全部失败时抛中文错误。
 */
export async function resolveClockOffset(options?: {
  server?: string;
  timeoutSec?: number;
  fetchImpl?: typeof fetch;
  ntp?: () => Promise<NtpSampleResult>;
}): Promise<ClockFix> {
  const ntp =
    options?.ntp ??
    (() => querySampled(options?.server ?? DEFAULT_NTP_SERVER, options?.timeoutSec));
  try {
    const sample = await ntp();
    return {
      offsetMs: sample.offsetMs,
      uncertaintyMs: sample.uncertaintyMs,
      samples: sample.samples,
      source: "ntp",
    };
  } catch (err) {
    logger.warning(`NTP 校时失败，改试公共时间接口: ${err instanceof Error ? err.message : String(err)}`);
  }
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  const taobao = await readPublicClock(fetchImpl, TAOBAO_TIME_URL, "taobao", 1, (body) => {
    if (body === null || typeof body !== "object") {
      return null;
    }
    const data = (body as { data?: { t?: unknown } }).data;
    return numberField(data?.t);
  });
  if (taobao !== null) {
    return taobao;
  }
  const bilibili = await readPublicClock(fetchImpl, BILIBILI_TIME_URL, "bilibili", 1000, (body) => {
    if (body === null || typeof body !== "object") {
      return null;
    }
    const now = numberField((body as { data?: { now?: unknown } }).data?.now);
    return now === null ? null : now * 1000;
  });
  if (bilibili !== null) {
    return bilibili;
  }
  throw new Error("未能校正时钟：NTP 与公共时间接口都不可用");
}

// ------ 设备时钟辅助 -------------------------------------------------------

/**
 * 查询服务器并返回 offset。设备侧时间经 adb 读取仅作交叉核对；真正对齐的是
 * *宿主机*时钟（设备跑的是 ADB 时间戳，我们无法设置）。
 */
export async function syncDeviceClock(server: string = DEFAULT_NTP_SERVER): Promise<NtpResult> {
  return asyncQuery(server);
}

/**
 * 经由 `adb shell date` 返回设备的 Unix 时钟估计。
 *
 * 用于交叉核对设备时钟是否与宿主机相差悬殊。注意：Python 原版此处
 * `from ..device.adb import run_adb` 引用了不存在的 `run_adb`（调用即
 * ImportError），按迁移约定修复为调用正确的 adb 封装；`check: false` 使
 * 非零退出码走既有的 `returncode != 0 → null` 分支而非抛异常。
 *
 * @returns 设备的 Unix 秒；无法获取或解析失败时返回 null。
 */
export async function fetchDeviceTime(deviceId: string, timeout = 5.0): Promise<number | null> {
  const out = await adb("shell", "date", "+%s", { deviceId, timeout, check: false });
  if (out.returncode !== 0) {
    return null;
  }
  const trimmed = out.stdout.trim();
  const parsed = Number(trimmed);
  // 对应 Python 的 float(...) + except (ValueError, AttributeError) → None
  if (trimmed === "" || Number.isNaN(parsed)) {
    return null;
  }
  return parsed;
}
