/**
 * NTP 时钟同步测试（Python `tests/test_ntp.py` 的对应物，用例一一对应）。
 *
 * Python 侧 monkeypatch `damai_mcp.utils.ntp.socket.socket` 注入假 UDP
 * socket；TS 侧等价地 mock `node:dgram` 的 `createSocket`，由 helpers.ts 的
 * {@link FakeUdpSocket} 承担 `_FakeUDPSocket` 的角色。
 */
import type { SocketType } from "node:dgram";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_NTP_SERVER,
  NTP_MAX_OFFSET_ABS_MS,
  NTP_MIN_SERVER_UNIX,
  NTP_RESOLUTION_MS,
  NTP_SAMPLES,
  NTP_UNIX_DELTA,
  NtpResult,
  NtpSampleResult,
  asyncQuery,
  buildRequest,
  ntpSecsToUnix,
  parseTransmitTs,
  query,
  querySampled,
} from "../src/utils/ntp";
import { FakeUdpSocket, captureRejection, fakeNtpResponse, type SentPacket } from "./helpers";

const dgramMocks = vi.hoisted(() => ({
  /** 当前用例注入的 createSocket 实现；null 时透传真实实现。 */
  createSocketImpl: null as null | ((type: SocketType) => unknown),
}));

vi.mock("node:dgram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dgram")>();
  return {
    ...actual,
    createSocket: (type: SocketType) =>
      dgramMocks.createSocketImpl === null
        ? actual.createSocket(type)
        : dgramMocks.createSocketImpl(type),
  };
});

// ---- 纯函数解析 -----------------------------------------------------------

describe("NTP 纯函数解析", () => {
  it("test_build_request_length_and_li", () => {
    const pkt = buildRequest();
    expect(pkt).toHaveLength(48);
    // 首字节：0x1B -> 00 011 011（LI=0, VN=3, Mode=3）
    expect(pkt[0]).toBe(0x1b);
  });

  it("test_parse_transmit_ts_returns_pair", () => {
    const pkt = Buffer.alloc(48);
    const [secs, frac] = parseTransmitTs(pkt);
    expect(secs).toBe(0);
    expect(frac).toBe(0);
  });

  it("test_ntp_secs_to_unix", () => {
    // 2000-01-01 00:00 UTC = 946684800 unix = 3155673600 ntp
    const val = ntpSecsToUnix(3_155_673_600, 0);
    expect(Math.abs(val - 946684800.0)).toBeLessThan(1e-6);
  });

  it("test_ntp_secs_to_unix_with_fraction", () => {
    const val = ntpSecsToUnix(3_155_673_600, 2 ** 31); // 0.5 秒
    expect(Math.abs(val - 946684800.5)).toBeLessThan(1e-6);
  });
});

// ---- NtpResult ------------------------------------------------------------

describe("NtpResult", () => {
  it("test_ntp_result_to_dict", () => {
    const r = new NtpResult({
      server: "pool.ntp.org",
      offsetMs: 12.5,
      delayMs: 80.1,
      serverUnix: 1_700_000_000.0,
      queriedAtUnix: 1_700_000_000.1,
    });
    const d = r.toDict();
    expect(d.server).toBe("pool.ntp.org");
    expect(d.offset_ms).toBe(12.5);
    expect(d.synced).toBe(true);
    expect(d.server_unix).toBe(1_700_000_000.0);
  });

  it.each([
    [10.0, true],
    [200.0, true],
    [499.0, true],
    [501.0, false],
    [-499.0, true],
    [-501.0, false],
  ] as const)("test_ntp_result_synced (offsetMs=%s)", (offsetMs, expectedSynced) => {
    const r = new NtpResult({
      server: "x",
      offsetMs,
      delayMs: 0,
      serverUnix: 0,
      queriedAtUnix: 0,
    });
    expect(r.synced).toBe(expectedSynced);
  });
});

// ---- query（mock socket，确定性）------------------------------------------

describe("query（mock socket，确定性）", () => {
  it("test_query_uses_sock", async () => {
    // 构造一个表示「当前时间」的 NTP 响应包
    const unixNow = Math.floor(Date.now() / 1000);
    const fake = new FakeUdpSocket(fakeNtpResponse(unixNow + NTP_UNIX_DELTA));
    dgramMocks.createSocketImpl = () => fake;

    const out = await query("192.0.2.123", 1.0);
    expect(out.server).toBe("192.0.2.123");
    // 服务器时间与宿主机时间只差一个往返内的量，offset 应为亚秒级
    expect(Math.abs(out.offsetMs)).toBeLessThan(5000);
    // 恰好发出 1 个 48 字节包，目标是 server:123
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0].data).toHaveLength(48);
    expect(fake.sent[0].address).toBe("192.0.2.123");
    expect(fake.sent[0].port).toBe(123);
  });

  it("test_query_timeout", async () => {
    // Python 在 recvfrom 里同步抛 TimeoutError 模拟超时；TS 的 query 由内部
    // 超时定时器触发同一条 TimeoutError 分支——让假 socket 永不回包即可。
    dgramMocks.createSocketImpl = () => new FakeUdpSocket(null);
    const err = await captureRejection(query("0.0.0.1", 0.1));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("TimeoutError");
    expect((err as Error).message).toMatch(/did not respond/);
  });

  it("test_query_short_response", async () => {
    dgramMocks.createSocketImpl = () => new FakeUdpSocket(Buffer.alloc(16)); // 仅 16 字节
    const err = await captureRejection(query("0.0.0.2", 0.1));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("Error"); // 对应 Python 的 RuntimeError
    expect((err as Error).message).toMatch(/too short/);
  });
});

// ---- async_query ----------------------------------------------------------

describe("async_query", () => {
  it("test_async_query_returns_ntp_result", async () => {
    // Python 直接 monkeypatch ntp.query 返回 stub（server="stub"、offset_ms=0.0，
    // 故 synced 恒 true）；ESM 的模块内直调无法 monkeypatch，改为在 dgram 层
    // 注入确定性响应（asyncQuery 即 query 的别名）。冻结 Date 使 offset 恒为
    // 0——等价复现 stub 的确定性，且不受真实时钟跨秒翻转影响。
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1_700_000_000_000);
      dgramMocks.createSocketImpl = () =>
        new FakeUdpSocket(fakeNtpResponse(1_700_000_000 + NTP_UNIX_DELTA));
      const out = await asyncQuery("pool.ntp.org", 1.0);
      expect(out).toBeInstanceOf(NtpResult);
      expect(out.server).toBe("pool.ntp.org");
      expect(out.offsetMs).toBe(0);
      expect(out.synced).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

it("test_default_ntp_server_present", () => {
  expect(DEFAULT_NTP_SERVER).toBe("pool.ntp.org");
});

// ---- querySampled（多次采样：最小 RTT + 显式误差区间）-----------------------

/** 单个采样 socket 的脚本：`delayMs = Infinity` 表示永不回包。 */
interface SampleScript {
  /** 回包延迟（假时钟毫秒）。 */
  delayMs: number;
  /** 服务器时钟相对本机时钟的真实偏差（秒），恒定。 */
  serverOffsetSec?: number;
}

/**
 * 可控制回包延迟的假 UDP socket（helpers 的 {@link FakeUdpSocket} 回包不可控
 * 延迟，故在本测试文件内定义）。
 *
 * 响应不在构造时给定，而是在**回包触发时刻**按 `Date.now()/1000 +
 * serverOffsetSec` 生成 Transmit Timestamp——服务器时钟随（假）时钟推进且
 * 带固定真实偏差，使「误差区间覆盖真实偏差」的不变量可被精确断言。
 */
class DelayedFakeUdpSocket extends EventEmitter {
  readonly sent: SentPacket[] = [];

  constructor(
    private readonly delayMs: number,
    private readonly serverOffsetSec: number,
  ) {
    super();
  }

  send(data: Buffer, port: number, address: string, cb?: (err: Error | null) => void): this {
    this.sent.push({ data, port, address });
    if (Number.isFinite(this.delayMs)) {
      setTimeout(() => {
        const serverUnix = Date.now() / 1000 + this.serverOffsetSec;
        const ntpSecs = serverUnix + NTP_UNIX_DELTA;
        const secs = Math.floor(ntpSecs);
        // 防御浮点上界：frac 必须落在 uint32 内
        const frac = Math.min(2 ** 32 - 1, Math.round((ntpSecs - secs) * 2 ** 32));
        this.emit("message", fakeNtpResponse(secs, frac));
      }, this.delayMs);
    }
    if (cb) {
      cb(null);
    }
    return this;
  }

  close(): this {
    return this;
  }
}

/**
 * 按次序为每次 createSocket 发放脚本化 socket（querySampled 每次采样建一个
 * 独立 socket）；`created` 旁路收集全部实例供断言。
 */
function scriptedSockets(
  script: readonly SampleScript[],
  created: DelayedFakeUdpSocket[] = [],
): (type: SocketType) => DelayedFakeUdpSocket {
  let index = 0;
  return (_type: SocketType) => {
    const spec = script[Math.min(index, script.length - 1)];
    index += 1;
    const sock = new DelayedFakeUdpSocket(spec.delayMs, spec.serverOffsetSec ?? 0);
    created.push(sock);
    return sock;
  };
}

describe("NTP 采样常量", () => {
  it("test_ntp_sampling_constants", () => {
    expect(NTP_SAMPLES).toBe(3);
    expect(NTP_RESOLUTION_MS).toBe(1);
    expect(NTP_MAX_OFFSET_ABS_MS).toBe(86_400_000);
    expect(NTP_MIN_SERVER_UNIX).toBe(1.6e9);
  });
});

describe("NtpSampleResult", () => {
  it("test_ntp_sample_result_to_dict_keys", () => {
    const r = new NtpSampleResult({
      server: "pool.ntp.org",
      offsetMs: 12.5,
      roundTripMs: 80.25,
      uncertaintyMs: 41.13,
      samples: 3,
      sampledAtUnix: 1_700_000_000,
    });
    const d = r.toDict();
    // 键名逐项断言：snake_case 对外表面
    expect(Object.keys(d)).toEqual([
      "server",
      "offset_ms",
      "round_trip_ms",
      "uncertainty_ms",
      "interval_low_ms",
      "interval_high_ms",
      "samples",
      "sampled_at_unix",
      "synced",
    ]);
    expect(d.server).toBe("pool.ntp.org");
    expect(d.offset_ms).toBe(12.5);
    expect(d.round_trip_ms).toBe(80.25);
    expect(d.uncertainty_ms).toBe(41.13);
    expect(d.interval_low_ms).toBeCloseTo(-28.63, 10);
    expect(d.interval_high_ms).toBeCloseTo(53.63, 10);
    expect(d.samples).toBe(3);
    expect(d.sampled_at_unix).toBe(1_700_000_000);
    expect(d.synced).toBe(true);

    // getter：区间由 offset ± uncertainty 推出
    expect(r.intervalLoMs).toBeCloseTo(-28.63, 10);
    expect(r.intervalHiMs).toBeCloseTo(53.63, 10);
    // serverUnix 为 additive 可选字段：直接构造不传时为 undefined（toDict 键面不变）
    expect(r.serverUnix).toBeUndefined();
  });

  it.each([
    [499.9, true],
    [500, false],
    [-501, false],
  ] as const)("test_ntp_sample_result_synced (offsetMs=%s)", (offsetMs, expectedSynced) => {
    const r = new NtpSampleResult({
      server: "x",
      offsetMs,
      roundTripMs: 0,
      uncertaintyMs: 1,
      samples: 1,
      sampledAtUnix: 0,
    });
    expect(r.synced).toBe(expectedSynced);
  });
});

describe("querySampled（假定时器，逐样本可推）", () => {
  it("test_query_sampled_picks_min_rtt_and_covers_true_offset", async () => {
    // 全量假定时器让 Date 随假时钟推进：3 次采样回包延迟 30/5/15ms，服务器
    // 时钟恒超前真实偏差 250ms。逐样本可推：rtt=30/5/15ms 的样本 offset 分别
    // 为 250+15 / 250+2.5 / 250+7.5 ms——最快样本（5ms）胜出，其
    // [offset − rtt/2 − 1, offset + rtt/2 + 1] 覆盖真实偏差 250ms。
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_700_000_000_000);
      const created: DelayedFakeUdpSocket[] = [];
      dgramMocks.createSocketImpl = scriptedSockets(
        [
          { delayMs: 30, serverOffsetSec: 0.25 },
          { delayMs: 5, serverOffsetSec: 0.25 },
          { delayMs: 15, serverOffsetSec: 0.25 },
        ],
        created,
      );

      const pending = querySampled("pool.ntp.org", 1.0);
      await vi.advanceTimersByTimeAsync(60);
      const out = await pending;

      expect(out).toBeInstanceOf(NtpSampleResult);
      expect(out.server).toBe("pool.ntp.org");
      expect(out.samples).toBe(3); // 默认采样次数 NTP_SAMPLES
      // 每次采样是独立 socket，各发 1 个 48 字节请求到 server:123
      expect(created).toHaveLength(3);
      for (const sock of created) {
        expect(sock.sent).toHaveLength(1);
        expect(sock.sent[0].data).toHaveLength(48);
        expect(sock.sent[0].port).toBe(123);
        expect(sock.sent[0].address).toBe("pool.ntp.org");
      }
      expect(out.roundTripMs).toBeCloseTo(5, 2); // 命中最快样本
      expect(out.offsetMs).toBeCloseTo(252.5, 2); // 来自最快样本（其余样本为 265 / 257.5）
      expect(out.uncertaintyMs).toBeCloseTo(3.5, 2); // rtt/2 + NTP_RESOLUTION_MS
      expect(out.intervalLoMs).toBeLessThanOrEqual(250);
      expect(out.intervalHiMs).toBeGreaterThanOrEqual(250);
      expect(out.synced).toBe(true);
      // 收到最优样本响应的时刻 = 假时钟 35ms
      expect(out.sampledAtUnix).toBeCloseTo(1_700_000_000.035, 5);
      // 最优样本的服务器时间戳 = 收包假时刻 + 真实偏差 250ms（querySampled 恒填）
      expect(out.serverUnix).toBeCloseTo(1_700_000_000.285, 5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("test_query_sampled_tolerates_first_timeout", async () => {
    // 第 1 次采样永不回包（0.2s 超时），后两次正常 → 仍成功且 samples=2
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_700_000_000_000);
      dgramMocks.createSocketImpl = scriptedSockets([
        { delayMs: Number.POSITIVE_INFINITY },
        { delayMs: 5 },
        { delayMs: 5 },
      ]);

      const pending = querySampled("pool.ntp.org", 0.2);
      await vi.advanceTimersByTimeAsync(400);
      const out = await pending;

      expect(out.samples).toBe(2);
      expect(out.roundTripMs).toBeCloseTo(5, 2);
      // 最快样本 rtt=5ms、服务器偏差 0：offset = 0 + 5/2 = 2.5ms
      expect(out.offsetMs).toBeCloseTo(2.5, 2);
      expect(out.synced).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("test_query_sampled_all_timeout_reraises_timeout_error", async () => {
    // 三次全部超时 → 重抛最后一个错误，保留既有 TimeoutError 形态
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_700_000_000_000);
      dgramMocks.createSocketImpl = scriptedSockets([
        { delayMs: Number.POSITIVE_INFINITY },
        { delayMs: Number.POSITIVE_INFINITY },
        { delayMs: Number.POSITIVE_INFINITY },
      ]);

      const pending = captureRejection(querySampled("pool.ntp.org", 0.1));
      await vi.advanceTimersByTimeAsync(400);
      const err = (await pending) as Error;

      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("TimeoutError");
      expect(err.message).toMatch(/'pool\.ntp\.org' did not respond/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("test_query_sampled_honors_samples_and_resolution_options", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_700_000_000_000);
      dgramMocks.createSocketImpl = scriptedSockets([{ delayMs: 5 }]);

      const pending = querySampled("pool.ntp.org", 1.0, { samples: 1, resolutionMs: 10 });
      await vi.advanceTimersByTimeAsync(20);
      const out = await pending;

      expect(out.samples).toBe(1);
      expect(out.roundTripMs).toBeCloseTo(5, 2);
      expect(out.uncertaintyMs).toBeCloseTo(12.5, 2); // 5/2 + 自定义分辨率 10
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("querySampled（样本有效性门槛）", () => {
  it("test_query_sampled_drops_stale_server_unix_samples", async () => {
    // 冻结 Date 在 2000 年：offset=0 落在合法域内，但
    // serverUnix=946684800 < NTP_MIN_SERVER_UNIX → 仅触发「时间过旧」门槛，
    // 三次全部无效 → reject 中文「NTP 样本无效」。
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(946_684_800_000);
      dgramMocks.createSocketImpl = scriptedSockets([
        { delayMs: 0 },
        { delayMs: 0 },
        { delayMs: 0 },
      ]);

      const err = (await captureRejection(querySampled("pool.ntp.org", 1.0))) as Error;

      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/NTP 样本无效/);
      expect(err.message).toContain("946684800.000");
    } finally {
      vi.useRealTimers();
    }
  });

  it("test_query_sampled_drops_offset_beyond_24h", async () => {
    // 冻结 Date 在 2023 年，服务器时钟超前 25h：serverUnix 合法但
    // |offset| = 90_000_000ms > NTP_MAX_OFFSET_ABS_MS → 三次全部丢弃。
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1_700_000_000_000);
      dgramMocks.createSocketImpl = scriptedSockets([
        { delayMs: 0, serverOffsetSec: 86_400 + 3_600 },
        { delayMs: 0, serverOffsetSec: 86_400 + 3_600 },
        { delayMs: 0, serverOffsetSec: 86_400 + 3_600 },
      ]);

      const err = (await captureRejection(querySampled("pool.ntp.org", 1.0))) as Error;

      expect(err.message).toMatch(/NTP 样本无效/);
      expect(err.message).toContain("90000000.00ms");
    } finally {
      vi.useRealTimers();
    }
  });

  it("test_query_sampled_keeps_valid_samples_after_invalid_one", async () => {
    // 第 1 个样本 serverUnix ≈ 7e8 被丢弃，后两个有效 → 成功且 samples=2。
    // 冻结 Date 下 t1==t4（rtt=0），有效样本 offset=0、uncertainty=0/2+1=1。
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1_700_000_000_000);
      dgramMocks.createSocketImpl = scriptedSockets([
        { delayMs: 0, serverOffsetSec: -1_000_000_000 },
        { delayMs: 0 },
        { delayMs: 0 },
      ]);

      const out = await querySampled("pool.ntp.org", 1.0);

      expect(out.samples).toBe(2);
      expect(out.roundTripMs).toBe(0);
      expect(out.offsetMs).toBe(0);
      expect(out.uncertaintyMs).toBe(1);
      expect(out.intervalLoMs).toBe(-1);
      expect(out.intervalHiMs).toBe(1);
      expect(out.synced).toBe(true);
      // 有效样本（服务器偏差 0、冻结时钟）的 serverUnix = 冻结时刻
      expect(out.serverUnix).toBeCloseTo(1_700_000_000, 5);
    } finally {
      vi.useRealTimers();
    }
  });
});
