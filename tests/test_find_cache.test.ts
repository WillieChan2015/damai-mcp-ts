/**
 * UICache 接入 find*（item-1）与 dump 读取路径 memo（item-9）的测试。
 *
 * mock 层次：
 *   * `vi.mock("../src/device/adb")` —— adb（screencap 指纹 / exec-out cat）
 *     与 shell（uiautomator dump 写命令）打桩；
 *   * `vi.mock("../src/inspector/dump")` —— 把 dumpUi 换成 vi.fn 以便按调用
 *     次数断言「缓存命中跳过 dump」；find.ts 与 UICache 导入的是同一 mock。
 *
 * dumpUi 本体（含读取路径 memo）的行为用 `vi.importActual` 拿真实模块验证——
 * 其内部的 adb / shell 依赖同样命中上方的 mock。
 */
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { adb, shell } from "../src/device/adb";
import { tap } from "../src/actions/actions";
import { findByText } from "../src/inspector/find";
import { dumpUi } from "../src/inspector/dump";
import type * as dumpModule from "../src/inspector/dump";
import {
  disableDeviceUiCache,
  enableDeviceUiCache,
  getDeviceUiCache,
  invalidateDeviceUiCache,
} from "../src/utils/uiCache";
import { el, fakeAdbResult } from "./helpers";

vi.mock("../src/device/adb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/device/adb")>();
  return { ...actual, adb: vi.fn(), shell: vi.fn() };
});

vi.mock("../src/inspector/dump", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/inspector/dump")>();
  return { ...actual, dumpUi: vi.fn() };
});

/** 真实 dump 模块（绕过 vi.mock）：dumpUi 本体与读取路径 memo 的被测对象。 */
const realDump = await vi.importActual<typeof dumpModule>("../src/inspector/dump");

const DEV = "127.0.0.1:5555";

/** 供 dumpUi 解析的最小有效 UI XML（含 "<node" 字节判据）。 */
const DUMP_XML =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<hierarchy><node text="立即购买" resource-id="" class="android.widget.Button" bounds="[0,0][100,50]"/></hierarchy>`;

/** adb mock 收到的全部 `exec-out cat <path>` 调用路径（按序）。 */
function catPaths(): string[] {
  return vi
    .mocked(adb)
    .mock.calls.filter((c) => c[0] === "exec-out" && c[1] === "cat")
    .map((c) => c[2] as string);
}

describe("UICache 注册表 API（item-1）", () => {
  afterEach(() => {
    disableDeviceUiCache(DEV);
  });

  it("enable / get / disable / invalidate 的注册表语义", () => {
    expect(getDeviceUiCache(DEV)).toBeNull();
    const cache = enableDeviceUiCache(DEV, 0.5);
    expect(getDeviceUiCache(DEV)).toBe(cache);
    expect(enableDeviceUiCache(DEV, 9)).toBe(cache); // 重复启用返回既有实例（TTL 不变）
    invalidateDeviceUiCache("未注册设备"); // no-op，不抛
    disableDeviceUiCache(DEV);
    expect(getDeviceUiCache(DEV)).toBeNull();
    disableDeviceUiCache(DEV); // 幂等
  });
});

describe("UICache 接入 find*（item-1）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    disableDeviceUiCache(DEV);
  });

  it("未注册时行为与现状一致：走裸 dumpUi，不发 screencap 指纹探测（回归）", async () => {
    vi.mocked(dumpUi).mockResolvedValue([el({ text: "立即购买", bounds: [0, 0, 100, 50] })]);
    const found = await findByText(DEV, "立即购买");
    expect(found?.text).toBe("立即购买");
    expect(vi.mocked(dumpUi)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(adb)).not.toHaveBeenCalled(); // 无指纹探测
    expect(getDeviceUiCache(DEV)).toBeNull();
  });

  it("注册后同屏二次 findByText → dumpUi 仅 1 次，第二次 screencap 指纹命中", async () => {
    enableDeviceUiCache(DEV, 5.0);
    vi.mocked(dumpUi).mockResolvedValue([el({ text: "立即购买", bounds: [0, 0, 100, 50] })]);
    // 稳定截屏指纹：fingerprint 对这段固定字节求 md5，逐次恒一致
    vi.mocked(adb).mockResolvedValue(
      fakeAdbResult({ stdoutBytes: Buffer.from("stable-screencap-frame") }),
    );

    await findByText(DEV, "立即购买");
    await findByText(DEV, "立即购买");

    expect(vi.mocked(dumpUi)).toHaveBeenCalledTimes(1); // 第二次整体跳过 dump
    expect(vi.mocked(adb)).toHaveBeenCalled(); // 指纹探测发生（每轮一次 screencap）
  });

  it("tap 写入后失效 → 下一次 findByText 重新 dump", async () => {
    enableDeviceUiCache(DEV, 5.0);
    vi.mocked(dumpUi).mockResolvedValue([el({ text: "立即购买", bounds: [0, 0, 100, 50] })]);
    vi.mocked(adb).mockResolvedValue(
      fakeAdbResult({ stdoutBytes: Buffer.from("stable-screencap-frame") }),
    );
    vi.mocked(shell).mockResolvedValue("");

    await findByText(DEV, "立即购买");
    await tap(DEV, 10, 20); // 写路径成功后 invalidateDeviceUiCache
    await findByText(DEV, "立即购买");

    expect(vi.mocked(dumpUi)).toHaveBeenCalledTimes(2);
  });

  it("TTL 过期 → 重新 dump", async () => {
    enableDeviceUiCache(DEV, 0.05);
    vi.mocked(dumpUi).mockResolvedValue([el({ text: "立即购买", bounds: [0, 0, 100, 50] })]);
    vi.mocked(adb).mockResolvedValue(
      fakeAdbResult({ stdoutBytes: Buffer.from("stable-screencap-frame") }),
    );

    await findByText(DEV, "立即购买");
    await sleep(100);
    await findByText(DEV, "立即购买");

    expect(vi.mocked(dumpUi)).toHaveBeenCalledTimes(2);
  });

  it("指纹变化（截屏头部不同）→ 重新 dump", async () => {
    enableDeviceUiCache(DEV, 5.0);
    vi.mocked(dumpUi).mockResolvedValue([el({ text: "立即购买", bounds: [0, 0, 100, 50] })]);
    vi.mocked(adb)
      .mockResolvedValueOnce(fakeAdbResult({ stdoutBytes: Buffer.from("frame-1") }))
      .mockResolvedValueOnce(fakeAdbResult({ stdoutBytes: Buffer.from("frame-2") }))
      .mockResolvedValue(fakeAdbResult({ stdoutBytes: Buffer.from("frame-2") }));

    await findByText(DEV, "立即购买");
    await findByText(DEV, "立即购买"); // 指纹 frame-2 ≠ frame-1 → 缓存判变

    expect(vi.mocked(dumpUi)).toHaveBeenCalledTimes(2);
  });

  it("invalidateDeviceUiCache 未注册时为 no-op，注册后强制下次重新 dump", async () => {
    invalidateDeviceUiCache(DEV); // 未注册：no-op
    enableDeviceUiCache(DEV, 5.0);
    vi.mocked(dumpUi).mockResolvedValue([el({ text: "立即购买", bounds: [0, 0, 100, 50] })]);
    vi.mocked(adb).mockResolvedValue(
      fakeAdbResult({ stdoutBytes: Buffer.from("stable-screencap-frame") }),
    );

    await findByText(DEV, "立即购买");
    invalidateDeviceUiCache(DEV);
    await findByText(DEV, "立即购买");

    expect(vi.mocked(dumpUi)).toHaveBeenCalledTimes(2);
  });
});

describe("dump 读取路径 memo（item-9）", () => {
  const FIRST_CANDIDATE = "/sdcard/window_dump.xml";
  const SECOND_CANDIDATE = "/sdcard/dump.xml";

  beforeEach(() => {
    vi.clearAllMocks();
    realDump.clearDumpReadPathMemo();
    // uiautomator dump 写命令段：命中 "dumped" 判据
    vi.mocked(shell).mockResolvedValue("UI hierchary dumped to: /sdcard/window_dump.xml");
  });

  afterEach(() => {
    realDump.clearDumpReadPathMemo();
  });

  it("首次按候选顺序探测命中候选 2 并写 memo；第二次只直读候选 2（1 次 cat）", async () => {
    vi.mocked(adb).mockImplementation(async (...args) =>
      args[2] === SECOND_CANDIDATE
        ? fakeAdbResult({ stdoutBytes: Buffer.from(DUMP_XML) })
        : fakeAdbResult(), // 其余候选返回空
    );

    await realDump.dumpUi(DEV);
    expect(catPaths()).toEqual([FIRST_CANDIDATE, SECOND_CANDIDATE]);

    vi.mocked(adb).mockClear();
    await realDump.dumpUi(DEV);
    expect(catPaths()).toEqual([SECOND_CANDIDATE]); // memo 直读，免去无效探测
  });

  it("memo 路径失效（返回空）→ 清 memo 回落候选顺序并重记 memo", async () => {
    vi.mocked(adb).mockImplementation(async (...args) =>
      args[2] === SECOND_CANDIDATE ? fakeAdbResult({ stdoutBytes: Buffer.from(DUMP_XML) }) : fakeAdbResult(),
    );
    await realDump.dumpUi(DEV); // memo = /sdcard/dump.xml
    vi.mocked(adb).mockClear();

    // memo 路径变空、候选 1 变有效
    vi.mocked(adb).mockImplementation(async (...args) =>
      args[2] === FIRST_CANDIDATE ? fakeAdbResult({ stdoutBytes: Buffer.from(DUMP_XML) }) : fakeAdbResult(),
    );
    await realDump.dumpUi(DEV);
    expect(catPaths()).toEqual([SECOND_CANDIDATE, FIRST_CANDIDATE]); // 先试 memo，失效后回落

    vi.mocked(adb).mockClear();
    await realDump.dumpUi(DEV);
    expect(catPaths()).toEqual([FIRST_CANDIDATE]); // memo 已更新为候选 1
  });

  it("clearDumpReadPathMemo 后重新按候选顺序探测", async () => {
    vi.mocked(adb).mockImplementation(async (...args) =>
      args[2] === SECOND_CANDIDATE ? fakeAdbResult({ stdoutBytes: Buffer.from(DUMP_XML) }) : fakeAdbResult(),
    );
    await realDump.dumpUi(DEV);
    vi.mocked(adb).mockClear();

    realDump.clearDumpReadPathMemo();
    await realDump.dumpUi(DEV);
    expect(catPaths()).toEqual([FIRST_CANDIDATE, SECOND_CANDIDATE]); // 重扫（候选 1 仍空）
  });

  it("memo 命中路径的读取结果仍过 <node 判据与解析（元素数一致）", async () => {
    vi.mocked(adb).mockResolvedValue(fakeAdbResult({ stdoutBytes: Buffer.from(DUMP_XML) }));
    const first = await realDump.dumpUi(DEV);
    const second = await realDump.dumpUi(DEV);
    expect(second).toHaveLength(first.length);
    expect(second[0]?.text).toBe("立即购买");
  });
});
