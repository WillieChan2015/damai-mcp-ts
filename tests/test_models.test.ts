/**
 * UIElement 模型 + parse_bounds 的测试
 * （Python `tests/test_models.py` 的 TS 对应物；用例一一对应）。
 */
import { describe, expect, it } from "vitest";

import { UIElement, parseBounds } from "../src/inspector/models";

describe("UIElement model + parseBounds", () => {
  it("test_parse_bounds_valid", () => {
    expect(parseBounds("[100,200][300,400]")).toEqual([100, 200, 300, 400]);
  });

  it("test_parse_bounds_invalid", () => {
    expect(parseBounds("garbage")).toEqual([0, 0, 0, 0]);
    expect(parseBounds("")).toEqual([0, 0, 0, 0]);
  });

  it("test_ui_element_center", () => {
    const el = new UIElement({ tag: "node", bounds: [10, 20, 110, 220] });
    expect(el.center).toEqual([60, 120]);
    expect(el.width).toBe(100);
    expect(el.height).toBe(200);
  });

  it("test_ui_element_visible_default", () => {
    const el = new UIElement({ tag: "node", bounds: [0, 0, 100, 100], enabled: true });
    expect(el.visible).toBe(true);
    const el2 = new UIElement({ tag: "node", bounds: [0, 0, 0, 0], enabled: true });
    expect(el2.visible).toBe(false);
    const el3 = new UIElement({ tag: "node", bounds: [0, 0, 100, 100], enabled: false });
    expect(el3.visible).toBe(false);
  });

  it("test_ui_element_to_dict_keys", () => {
    const el = new UIElement({ tag: "node", text: "OK", bounds: [0, 0, 10, 10] });
    const d = el.toDict();
    expect("tag" in d).toBe(true);
    expect("text" in d).toBe(true);
    expect("center" in d).toBe(true);
    expect(d["center"]).toEqual([5, 5]);
  });

  it("test_ui_element_repr_includes_label", () => {
    const el = new UIElement({ tag: "node", text: "立即购买", bounds: [0, 0, 10, 10] });
    // Python 的 repr(el) 对应 TS 的 toString()（String(el) 触发）
    const r = String(el);
    expect(r).toContain("立即购买");
    expect(r).toContain("node");
  });
});
