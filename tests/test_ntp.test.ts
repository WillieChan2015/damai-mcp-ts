/**
 * NTP 时钟同步测试（Python `tests/test_ntp.py` 的对应物，用例一一对应）。
 *
 * Python 侧 monkeypatch `damai_mcp.utils.ntp.socket.socket` 注入假 UDP
 * socket；TS 侧等价地 mock `node:dgram` 的 `createSocket`，由 helpers.ts 的
 * {@link FakeUdpSocket} 承担 `_FakeUDPSocket` 的角色。
 */
import type { SocketType } from "node:dgram";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_NTP_SERVER,
  NTP_UNIX_DELTA,
  NtpResult,
  asyncQuery,
  buildRequest,
  ntpSecsToUnix,
  parseTransmitTs,
  query,
} from "../src/utils/ntp";
import { FakeUdpSocket, captureRejection, fakeNtpResponse } from "./helpers";

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
