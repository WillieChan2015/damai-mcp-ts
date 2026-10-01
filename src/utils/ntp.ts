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
 *     该估计偏向半个往返时延，对局域网 NTP 而言可忽略。
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
 * 查询 NTP 服务器并计算 offset。
 *
 * Python 原版是同步 socket 实现（`async_query` 用线程池包装它）；Node 的
 * dgram 天然异步，这里直接以异步实现承载同一协议语义，供测试与 CLI 快速
 * 模式使用。
 *
 * @throws 超时（`TimeoutError`）、socket 错误（`ConnectionError`）或响应过短
 *   （`Error`）——错误名与 Python 内建异常对应，`str(err)` 形态一致。
 */
export async function query(
  server: string = DEFAULT_NTP_SERVER,
  timeout: number = QUERY_TIMEOUT_SEC,
): Promise<NtpResult> {
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
