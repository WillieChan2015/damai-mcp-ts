/**
 * 速度优化（UI 缓存 + 批量 adb + 预热）的测试
 * （Python `tests/test_optimizations.py` 的 TS 对应物；用例一一对应）。
 *
 * mock 层次说明：Python 用 monkeypatch 替换 `actions.batch.adb`、
 * `utils.ui_cache.dump_ui` 与 `UICache._fingerprint`。TS 侧统一在**子进程层**
 * mock（`vi.mock("../src/device/adb")`）+ mock dump 模块：UICache 的
 * `fingerprint` 是对截屏头部字节的 md5——mock adb 返回固定字节后指纹自然
 * 恒定，无需触碰（Python 版可直接 patch 的）私有方法。
 */
import { setTimeout as sleep } from "node:timers/promises";

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { adb } from "../src/device/adb";
import { batchSend, batchSwipe, batchTap } from "../src/actions/batch";
import { dumpUi } from "../src/inspector/dump";
import { searchElements } from "../src/utils/findHelpers";
import { UICache } from "../src/utils/uiCache";
import { el, fakeAdbResult } from "./helpers";

vi.mock("../src/device/adb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/device/adb")>();
  return { ...actual, adb: vi.fn(), shell: vi.fn() };
});

vi.mock("../src/inspector/dump", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/inspector/dump")>();
  return { ...actual, dumpUi: vi.fn() };
});

describe("pure-function search helpers", () => {
  it("test_search_by_text_exact", () => {
    const elements = [el({ text: "立即购买" }), el({ text: "加入购物车" })];
    const found = searchElements(elements, { text: "立即购买" });
    expect(found).not.toBeNull();
    expect(found?.text).toBe("立即购买");
  });

  it("test_search_by_text_substring", () => {
    const elements = [el({ text: "立即购买 ¥380" })];
    const found = searchElements(elements, { text: "立即购买", exact: false });
    expect(found).not.toBeNull();
  });

  it("test_search_by_text_miss", () => {
    const elements = [el({ text: "Buy Now" })];
    const found = searchElements(elements, { text: "立即购买" });
    expect(found).toBeNull();
  });

  it("test_search_by_resource_id_exact", () => {
    const elements = [el({ resourceId: "cn.damai:id/buy_button" })];
    const found = searchElements(elements, { resourceId: "cn.damai:id/buy_button" });
    expect(found).not.toBeNull();
  });

  it("test_search_by_resource_id_suffix", () => {
    const elements = [el({ resourceId: "cn.damai:id/buy_button" })];
    const found = searchElements(elements, { resourceId: "buy_button", exact: false });
    expect(found).not.toBeNull();
  });

  it("test_search_no_criteria_raises", () => {
    expect(() => searchElements([], {})).toThrow(/must supply/);
  });
});

describe("batch input formatting", () => {
  /** 收集 mock adb 收到的全部实参（对应 Python 的 `captured`）。 */
  const captured: unknown[][] = [];

  beforeEach(() => {
    captured.length = 0;
    vi.clearAllMocks();
    vi.mocked(adb).mockImplementation(async (...args) => {
      captured.push(args);
      return fakeAdbResult();
    });
  });

  it("test_batch_tap_joins_into_one_shell", async () => {
    await batchTap("127.0.0.1:5555", [
      [100, 200],
      [300, 400],
      [500, 600],
    ]);
    // Should be ONE adb call, not three
    expect(captured).toHaveLength(1);
    const script = captured[0]![1] as string;
    expect(script).toContain("input tap 100 200");
    expect(script).toContain("input tap 300 400");
    expect(script).toContain("input tap 500 600");
    // All three joined by ;
    expect(script.split("input tap")).toHaveLength(4); // count == 3
  });

  it("test_batch_tap_with_delay", async () => {
    await batchTap(
      "127.0.0.1:5555",
      [
        [100, 200],
        [300, 400],
      ],
      { delayMs: 50 },
    );
    const script = captured[0]![1] as string;
    expect(script).toContain("input tap 100 200");
    expect(script).toContain("sleep 0.050");
    expect(script).toContain("input tap 300 400");
  });

  it("test_batch_tap_empty", async () => {
    await batchTap("127.0.0.1:5555", []);
    expect(captured).toHaveLength(0); // no adb invocation
  });

  it("test_batch_swipe_format", async () => {
    await batchSwipe("127.0.0.1:5555", [
      [10, 20, 30, 40, 100],
      [50, 60, 70, 80, 200],
    ]);
    expect(captured[0]![1] as string).toContain("input swipe 10 20 30 40 100");
    expect(captured[0]![1] as string).toContain("input swipe 50 60 70 80 200");
  });

  it("test_batch_send_passthrough", async () => {
    await batchSend("127.0.0.1:5555", "input tap 1 2; input tap 3 4");
    expect(captured[0]![1]).toBe("input tap 1 2; input tap 3 4");
  });
});

describe("UI cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 稳定的截屏指纹：fingerprint 对这段固定字节求 md5，逐次调用恒一致
    // （对应 Python 里 patch UICache._fingerprint 返回固定 hash 的效果）
    vi.mocked(adb).mockResolvedValue(
      fakeAdbResult({ stdoutBytes: Buffer.from("stable-screencap-frame") }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("test_ui_cache_miss_then_hit", async () => {
    const cache = new UICache(5.0);
    vi.mocked(dumpUi).mockResolvedValue([el({ text: "buy" })]);

    const elems1 = await cache.get("127.0.0.1:5555");
    const elems2 = await cache.get("127.0.0.1:5555");
    expect(elems1).toBe(elems2); // cached
    const stats = cache.stats;
    expect(stats["misses"]).toBeGreaterThanOrEqual(1);
    expect(stats["hits"]).toBeGreaterThanOrEqual(1);
  });

  it("test_ui_cache_invalidate", async () => {
    const cache = new UICache(5.0);
    vi.mocked(dumpUi).mockResolvedValue([el({ text: "buy" })]);

    await cache.get("127.0.0.1:5555");
    cache.invalidate();
    await cache.get("127.0.0.1:5555");
    const stats = cache.stats;
    expect(stats["misses"]).toBe(2);
  });

  it("test_ui_cache_ttl_expiry", async () => {
    const cache = new UICache(0.05); // very short TTL
    vi.mocked(dumpUi).mockResolvedValue([el({ text: "buy" })]);

    await cache.get("127.0.0.1:5555");
    await sleep(100);
    await cache.get("127.0.0.1:5555");
    // After TTL expiry, cache should miss
    expect(cache.stats["misses"]).toBe(2);
  });

  it("test_ui_cache_concurrent_calls_share_one_dump", async () => {
    const cache = new UICache(5.0);
    let dumpCalls = 0;

    vi.mocked(dumpUi).mockImplementation(async (_deviceId: string) => {
      dumpCalls += 1;
      return [el({ text: "x" })];
    });

    // Fire 5 concurrent gets
    await Promise.all(
      Array.from({ length: 5 }, () => cache.get("127.0.0.1:5555")),
    );
    // Lock serializes them, so dumps happen at most twice (miss + hit)
    expect(dumpCalls).toBeLessThanOrEqual(2);
  });
});
