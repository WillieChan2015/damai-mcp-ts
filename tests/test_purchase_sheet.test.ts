import { describe, expect, it } from "vitest";

import { UIElement } from "../src/inspector/models";
import { parseOcrOutput } from "../src/inspector/visionOcr";
import {
  applyOcrLabels,
  labelFromOcrLines,
  parsePurchaseSheet,
  type OcrBox,
} from "../src/damai/purchaseSheet";

function node(
  text: string,
  bounds: readonly [number, number, number, number],
  extra: { clickable?: boolean; className?: string } = {},
): UIElement {
  return new UIElement({
    tag: "node",
    text,
    bounds,
    clickable: extra.clickable ?? false,
    className: extra.className ?? "",
  });
}

function box(bounds: OcrBox["bounds"], text: string): OcrBox {
  return { bounds, text };
}

describe("labelFromOcrLines", () => {
  it("丢掉角标和符号，拼出日期", () => {
    expect(labelFromOcrLines(["2026-12-04", "• 周五 19:00", "预售", "C+"])).toBe(
      "2026-12-04 周五 19:00",
    );
  });

  it("半角括号收成票档全文", () => {
    expect(labelFromOcrLines(["看台580元(大屏观演区，仅支持看大屏)", "可预约", "C+"])).toBe(
      "看台580元（大屏观演区，仅支持看大屏）",
    );
  });
});

describe("parseOcrOutput", () => {
  it("只收带文字框的行", () => {
    expect(parseOcrOutput("84,680,484,719\t2026-12-04 周五 19:00\nbad\n")).toEqual([
      { bounds: [84, 680, 484, 719], text: "2026-12-04 周五 19:00" },
    ]);
  });
});

describe("applyOcrLabels", () => {
  it("无障碍树没有正文时，用识别框补上场次和票档，实心心形算已选", () => {
    const elements = [
      node("预约想看场次", [55, 545, 307, 601]),
      node("预约想看票档", [55, 1140, 307, 1196]),
      node("取消预约", [55, 2293, 183, 2335]),
      node("", [55, 635, 1025, 785], { clickable: true }),
      node("", [55, 785, 1025, 935], { clickable: true }),
      node("", [55, 935, 1025, 1085], { clickable: true }),
      node("", [589, 973, 639, 1023], { className: "android.widget.ImageView" }),
      node("", [55, 1217, 1005, 1367], { clickable: true }),
      node("", [55, 1367, 484, 1517], { clickable: true }),
      node("", [484, 1367, 956, 1517], { clickable: true }),
      node("", [55, 1517, 502, 1667], { clickable: true }),
      node("", [502, 1517, 974, 1667], { clickable: true }),
      node("", [892, 1555, 942, 1605], { className: "android.widget.ImageView" }),
      node("", [55, 1667, 509, 1817], { clickable: true }),
      node("", [509, 1667, 986, 1817], { clickable: true }),
      node("", [0, 2199, 1080, 2358], { clickable: true }),
    ];
    const boxes: OcrBox[] = [
      box([84, 680, 484, 719], "2026-12-04 周五 19:00"),
      box([516, 684, 568, 715], "预售"),
      box([84, 830, 474, 869], "2026-12-05 周六 19:00"),
      box([84, 980, 474, 1019], "2026-12-06 周日 19:00"),
      box([87, 1263, 763, 1308], "看台580元（大屏观演区，仅支持看大屏）"),
      box([812, 1266, 892, 1298], "可预约"),
      box([87, 1413, 261, 1451], "看台780元"),
      box([536, 1411, 732, 1453], "看台1080元"),
      box([87, 1557, 283, 1604], "看台1380元"),
      box([557, 1554, 756, 1603], "内场1880元"),
      box([87, 1708, 289, 1752], "内场2080元"),
      box([564, 1708, 767, 1752], "内场2380元"),
      box([561, 2236, 679, 2281], "已预约"),
    ];
    const sheet = parsePurchaseSheet(applyOcrLabels(elements, boxes));
    expect(sheet.sessions.map((session) => session.label)).toEqual([
      "2026-12-04 周五 19:00",
      "2026-12-05 周六 19:00",
      "2026-12-06 周日 19:00",
    ]);
    expect(sheet.sessions[2]?.picked).toBe(true);
    expect(sheet.sessions[0]?.picked).toBe(false);
    expect(sheet.prices.map((price) => price.label)).toEqual([
      "看台580元（大屏观演区，仅支持看大屏）",
      "看台780元",
      "看台1080元",
      "看台1380元",
      "内场1880元",
      "内场2080元",
      "内场2380元",
    ]);
    expect(sheet.prices[4]?.picked).toBe(true);
  });
});
