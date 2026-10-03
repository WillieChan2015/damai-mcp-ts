import { describe, expect, it } from "vitest";

import { prepareViewerPresets, VIEWER_PRESET_LIST_MAX, VIEWER_PRESET_NAME_MAX } from "./viewerPresetRules";

describe("prepareViewerPresets", () => {
  it("去掉空串和首尾空格，并按顺序去重", () => {
    expect(prepareViewerPresets([" 杨安琪 ", "", "张三", "杨安琪", "  张三"])).toEqual({
      ok: true,
      names: ["杨安琪", "张三"],
    });
  });

  it("空名单合法", () => {
    expect(prepareViewerPresets([])).toEqual({ ok: true, names: [] });
    expect(prepareViewerPresets(["  ", ""])).toEqual({ ok: true, names: [] });
  });

  it("拒绝逗号", () => {
    expect(prepareViewerPresets(["杨安琪,张三"]).ok).toBe(false);
    expect(prepareViewerPresets(["杨安琪，张三"]).ok).toBe(false);
  });

  it("拒绝超长姓名和超限条数", () => {
    expect(prepareViewerPresets(["名".repeat(VIEWER_PRESET_NAME_MAX + 1)]).ok).toBe(false);
    const tooMany = Array.from({ length: VIEWER_PRESET_LIST_MAX + 1 }, (_, i) => `人${i}`);
    expect(prepareViewerPresets(tooMany).ok).toBe(false);
  });
});
