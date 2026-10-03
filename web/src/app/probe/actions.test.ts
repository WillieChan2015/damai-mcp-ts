import { UIElement } from "@core/inspector/models";
import { UIElementNotFoundError } from "@core/utils/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { dumpDeviceUi, findTextProbe } from "./actions";
import { dumpUiSchema, findTextSchema } from "./schemas";

// 只 mock probe 页的两个 core 入口（dumpUi / findByText），不触 adb
const dumpUiMock = vi.hoisted(() => vi.fn<() => Promise<UIElement[]>>());
const findByTextMock = vi.hoisted(() => vi.fn<() => Promise<UIElement>>());
const debugMock = vi.hoisted(() => vi.fn());

vi.mock("@core/inspector/dump", () => ({ dumpUi: dumpUiMock }));
vi.mock("@core/inspector/find", () => ({ findByText: findByTextMock }));
vi.mock("@core/utils/logging", () => ({ logger: { debug: debugMock } }));

/** 构造命中元素（buy 按钮语义）。 */
function makeBuyElement(attrs?: Record<string, string>): UIElement {
  return new UIElement({
    tag: "node",
    text: "立即购买",
    resourceId: "cn.damai:id/buy",
    className: "android.widget.Button",
    contentDesc: "",
    bounds: [40, 100, 400, 200],
    clickable: true,
    enabled: true,
    package: "cn.damai",
    ...(attrs !== undefined ? { attrs } : {}),
  });
}

describe("probe schemas（边界）", () => {
  it("findTextSchema：timeoutSec 0 与 31 拒绝、1 与 30 通过", () => {
    expect(findTextSchema.safeParse({ deviceId: "d", text: "x", timeoutSec: 0 }).success).toBe(false);
    expect(findTextSchema.safeParse({ deviceId: "d", text: "x", timeoutSec: 31 }).success).toBe(false);
    expect(findTextSchema.safeParse({ deviceId: "d", text: "x", timeoutSec: 1 }).success).toBe(true);
    expect(findTextSchema.safeParse({ deviceId: "d", text: "x", timeoutSec: 30 }).success).toBe(true);
  });

  it("findTextSchema：text 空与 deviceId 空拒绝；缺省字段应用默认值", () => {
    expect(findTextSchema.safeParse({ deviceId: "d", text: "" }).success).toBe(false);
    expect(findTextSchema.safeParse({ deviceId: "", text: "x" }).success).toBe(false);
    expect(findTextSchema.parse({ deviceId: "d", text: "立即购买" })).toEqual({
      deviceId: "d",
      text: "立即购买",
      exact: true,
      clickableOnly: false,
      timeoutSec: 5,
    });
  });

  it("dumpUiSchema：compressed 默认 true、deviceId 空拒绝", () => {
    expect(dumpUiSchema.parse({ deviceId: "d" })).toEqual({ deviceId: "d", compressed: true });
    expect(dumpUiSchema.safeParse({ deviceId: "" }).success).toBe(false);
  });
});

describe("findTextProbe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("命中：返回 found:true + toDict 全字段 + meta 注脚；attrs 为 null 时不附带", async () => {
    findByTextMock.mockResolvedValueOnce(makeBuyElement());
    const result = await findTextProbe({ deviceId: "emu-1", text: "立即购买" });
    expect(findByTextMock).toHaveBeenCalledWith("emu-1", "立即购买", {
      exact: true,
      clickableOnly: false,
      timeout: 5,
    });
    expect(result.serverError).toBeUndefined();
    expect(result.data?.found).toBe(true);
    if (result.data?.found) {
      expect(result.data.element).toMatchObject({
        tag: "node",
        text: "立即购买",
        resource_id: "cn.damai:id/buy",
        class_name: "android.widget.Button",
        content_desc: "",
        bounds: [40, 100, 400, 200],
        center: [220, 150],
        clickable: true,
        enabled: true,
        package: "cn.damai",
      });
      expect(result.data.element.index).toBeNull();
      expect("attrs" in result.data.element).toBe(false);
      expect(result.data.meta.foundBy).toBe("src/inspector/find.ts:23 findByText");
    }
  });

  it("超时（UIElementNotFoundError）是正常试查结果：found:false + core 文案，而非 serverError", async () => {
    findByTextMock.mockRejectedValueOnce(
      new UIElementNotFoundError('等待 "立即购买" 超时（5.0s，dump 节点数 120）'),
    );
    const result = await findTextProbe({ deviceId: "emu-1", text: "立即购买", timeoutSec: 5 });
    expect(result.serverError).toBeUndefined();
    expect(result.data?.found).toBe(false);
    if (result.data !== undefined && !result.data.found) {
      expect(result.data.error).toContain("超时");
      expect(result.data.error).toContain("dump 节点数 120");
      expect(result.data.meta.foundBy).toBe("src/inspector/find.ts:23 findByText");
    }
  });

  it("其他异常（设备离线等）走 serverError 通道", async () => {
    findByTextMock.mockRejectedValueOnce(new Error("设备未连接: emu-x"));
    const result = await findTextProbe({ deviceId: "emu-x", text: "x" });
    expect(result.data).toBeUndefined();
    expect(result.serverError).toContain("设备未连接");
  });
});

describe("dumpDeviceUi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("元素 >3000：truncated=true 且长度恰为 3000，meta 注脚正确", async () => {
    dumpUiMock.mockResolvedValueOnce(
      Array.from(
        { length: 3001 },
        (_, i) => new UIElement({ tag: "node", bounds: [i, i, i + 5, i + 5] }),
      ),
    );
    const result = await dumpDeviceUi({ deviceId: "emu-1", compressed: true });
    expect(dumpUiMock).toHaveBeenCalledWith("emu-1", { compressed: true });
    expect(result.data?.truncated).toBe(true);
    expect(result.data?.elements.length).toBe(3000);
    expect(result.data?.elements[0]?.index).toBe(0);
    expect(result.data?.elements[2999]?.index).toBe(2999);
    expect(result.data?.meta.dumpedBy).toBe("src/inspector/dump.ts:102 dumpUi");
    expect(debugMock).toHaveBeenCalledWith(expect.stringMatching(/^页面操作 导出界面 完成，耗时 \d+ms$/));
  });

  it("少量元素：truncated=false，attrs 非 null 时附带", async () => {
    dumpUiMock.mockResolvedValueOnce([
      makeBuyElement({ selected: "true", "nested-node": "false" }),
      new UIElement({ tag: "node", text: "选座" }),
    ]);
    const result = await dumpDeviceUi({ deviceId: "emu-1" });
    expect(result.data?.truncated).toBe(false);
    expect(result.data?.elements.length).toBe(2);
    expect(result.data?.elements[0]?.index).toBe(0);
    expect(result.data?.elements[0]?.attrs).toEqual({ selected: "true", "nested-node": "false" });
    expect(result.data?.elements[1]?.attrs).toBeUndefined();
  });

  it("dump 失败（设备离线等）→ serverError 透出中文信息", async () => {
    dumpUiMock.mockRejectedValueOnce(new Error("uiautomator dump 失败: 未发现设备"));
    const result = await dumpDeviceUi({ deviceId: "emu-x" });
    expect(result.data).toBeUndefined();
    expect(result.serverError).toContain("uiautomator dump 失败");
    expect(debugMock).toHaveBeenCalledWith(
      expect.stringMatching(/^页面操作 导出界面 失败，耗时 \d+ms：uiautomator dump 失败: 未发现设备$/),
    );
  });
});
