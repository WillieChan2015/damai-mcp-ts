/**
 * CTA 状态分类（修复 4b）的纯函数矩阵。
 *
 * classifyCtaState 无 I/O：直接以合成 UIElement 驱动，覆盖六步优先级、
 * 全等匹配语义（标题含敏感字样不误触发）与词表注入。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_BUYABLE_TEXTS,
  NOT_ON_SALE_CTA_WORDS,
  SHOW_ENDED_CTA_WORDS,
  classifyCtaState,
} from "../src/damai/cta";
import { UIElement, type UIElementInit } from "../src/inspector/models";

function el(text: string, extra: Partial<UIElementInit> = {}): UIElement {
  return new UIElement({ tag: "node", text, bounds: [0, 0, 200, 60], ...extra });
}

/** 购买弹层最小形态：场次 + 票档标题、两张卡片、底栏。 */
function openSheet(): UIElement[] {
  return [
    el("场次", { bounds: [16, 180, 80, 210] }),
    el("2026-10-18 周日 18:30", { bounds: [16, 240, 360, 300] }),
    el("票档", { bounds: [16, 400, 80, 430] }),
    el("看台588元", { bounds: [16, 450, 200, 510] }),
    el("看台688元", { bounds: [16, 530, 180, 590] }),
    el("¥0", { bounds: [16, 750, 80, 790] }),
    el("确定", { bounds: [250, 740, 380, 790] }),
  ];
}

describe("classifyCtaState", () => {
  it("购买弹层已打开 → sheet_open（优先于其下一切信号）", () => {
    // 弹层开着、角落还残留「缺货登记」角标：状态必须是 sheet_open，
    // 档位级缺货交由 per-tier soldOut 处理
    const result = classifyCtaState([...openSheet(), el("缺货登记", { bounds: [120, 460, 175, 490] })]);
    expect(result).toEqual({ state: "sheet_open", evidence: "购买弹层已打开" });
  });

  it("预约页 → not_on_sale（先于弹层判定，卡片点击是登记意愿而非购票）", () => {
    const reservePage = [
      el("预约想看场次", { bounds: [16, 180, 160, 210] }),
      el("2026-12-04 周五 19:00", { bounds: [16, 230, 360, 290] }),
      el("预约想看票档", { bounds: [16, 470, 160, 500] }),
      el("看台580元", { bounds: [16, 520, 360, 590] }),
      el("已预约", { bounds: [140, 900, 370, 960] }),
    ];
    expect(classifyCtaState(reservePage).state).toBe("not_on_sale");
  });

  it("CTA 可购文案 → buyable", () => {
    for (const text of DEFAULT_BUYABLE_TEXTS) {
      expect(classifyCtaState([el(text)])).toEqual({ state: "buyable", evidence: text });
    }
    // content-desc 全等同样命中
    expect(classifyCtaState([el("", { contentDesc: "立即购买" })]).state).toBe("buyable");
  });

  it("场次级终局词 → show_ended；可见但非全等的字样不触发", () => {
    for (const word of SHOW_ENDED_CTA_WORDS) {
      expect(classifyCtaState([el(word)]).state).toBe("show_ended");
    }
    // 演出标题里含「已结束」字样：全等匹配不误触发（抢票侧误判是终局）
    expect(classifyCtaState([el("直到世界结束演唱会")]).state).toBe("unknown");
    // 倒计时在场 + CTA 文案缺省：unknown（countdown 由调用方注入，见下例）
    expect(classifyCtaState(openSheet()).state).toBe("sheet_open");
  });

  it("未开售 / 预约 / 候补 CTA → not_on_sale（可重试，绝不终局）", () => {
    for (const word of ["未开售", "即将开售", "预约", "去预约", "候补", "缺货登记"]) {
      expect(NOT_ON_SALE_CTA_WORDS).toContain(word);
      expect(classifyCtaState([el(word)])).toEqual({ state: "not_on_sale", evidence: word });
    }
  });

  it("倒计时节点在场（调用方注入）→ not_on_sale，evidence=countdown_node", () => {
    expect(
      classifyCtaState([el("演出详情")], { countdownNodePresent: true }),
    ).toEqual({ state: "not_on_sale", evidence: "countdown_node" });
    // 未探测（缺省 null）不参与判定
    expect(classifyCtaState([el("演出详情")]).state).toBe("unknown");
  });

  it("优先级：buyable 压过同屏的终局/未开售字样；不可见元素不参与", () => {
    const mixed = [
      el("已结束"),
      el("未开售"),
      el("立即购买"),
      el("缺货登记", { bounds: [0, 0, 0, 0] }),
    ];
    // bounds 为空的元素不可见（models 语义），不参与全等候选
    expect(classifyCtaState(mixed).state).toBe("buyable");
  });

  it("空页面 / 无信号 → unknown；词表可注入", () => {
    expect(classifyCtaState([])).toEqual({ state: "unknown", evidence: null });
    expect(classifyCtaState([el("演出详情")])).toEqual({ state: "unknown", evidence: null });
    // 注入自定义可购文案
    expect(
      classifyCtaState([el("立即抢购")], { buyableTexts: ["立即抢购"] }).state,
    ).toBe("buyable");
  });
});

describe("classifyCtaState bottomBarTopY 区域限定", () => {
  it("页面中部的角标字样不再误触发状态（本机实测：巡演城市「预约」角标）", () => {
    // y≈1072 的角标 + 底部条上沿 2040：词匹配只看带内元素 → unknown
    const detailPage = [
      el("广州站", { bounds: [504, 1061, 729, 1113] }),
      el("预约", { bounds: [143, 1053, 201, 1091] }),
      el("演出详情", { bounds: [64, 1600, 1016, 1642] }),
    ];
    expect(classifyCtaState(detailPage, { bottomBarTopY: 2040 })).toEqual({
      state: "unknown",
      evidence: null,
    });
    // 同一页面、无区域限定（旧行为）→ 会误报 not_on_sale
    expect(classifyCtaState(detailPage).state).toBe("not_on_sale");
  });

  it("带内的 CTA 词正常命中；弹层判定不受区域限定影响", () => {
    const withCta = [
      el("预约", { bounds: [143, 1053, 201, 1091] }),
      el("立即预订", { bounds: [228, 2193, 1048, 2358] }),
    ];
    expect(classifyCtaState(withCta, { bottomBarTopY: 2040 })).toEqual({
      state: "buyable",
      evidence: "立即预订",
    });
    // 弹层结构判定是全屏的：卡片区域照常识别
    expect(classifyCtaState(openSheet(), { bottomBarTopY: 2040 }).state).toBe("sheet_open");
  });
});
