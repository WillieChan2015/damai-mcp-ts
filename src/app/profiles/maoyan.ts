/**
 * 猫眼 (com.sankuai.movie) profile（Python `app/profiles/maoyan.py` 的 TS 对应物）。
 *
 * 猫眼走的是相当标准的商户下单流程：
 *     详情页 → "立即购买" → 选场次/票价 → 实名观演人 → 确认
 */
import { AppProfile, Step } from "../profile";

/** 猫眼内置 profile（对应 Python 的 `MAOYAN_PROFILE` 常量）。 */
export const MAOYAN_PROFILE = new AppProfile({
  name: "maoyan",
  packageName: "com.sankuai.movie",
  deepLinkTemplate: "maoyan://movie/{item_id}",
  hints: [
    "Standard sold-out guard: button shows '已售罄'",
    "Price tier is a horizontal scroll; pick the 1st 'available' badge",
    "Viewer picker uses '实名观演人' title",
  ],
  viewerPicker: "实名观演人",
  steps: [
    new Step({
      name: "open_detail",
      action: "open_detail",
      args: {},
      timeoutSec: 15.0,
    }),
    new Step({
      name: "wait_buy_visible",
      action: "wait_text",
      args: { text: "立即购买", exact: false },
      timeoutSec: 30.0,
    }),
    new Step({
      name: "tap_buy",
      action: "tap_text",
      args: { text: "立即购买", exact: false },
      timeoutSec: 5.0,
    }),
    new Step({
      name: "select_price",
      action: "tap_index",
      args: { text: "¥", index: 0 },
      timeoutSec: 5.0,
    }),
    new Step({
      name: "tick_viewer",
      action: "select_checkbox",
      args: { label: "" }, // 运行时从 options 取值
      timeoutSec: 5.0,
      continueOnFail: true, // 可选步骤
    }),
    new Step({
      name: "confirm_order",
      action: "tap_text",
      args: { text: "确认订单", exact: false },
      timeoutSec: 8.0,
    }),
  ],
});
