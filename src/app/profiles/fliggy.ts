/**
 * 飞猪 (com.taobao.trip) profile（Python `app/profiles/fliggy.py` 的 TS 对应物）。
 *
 * 飞猪的演出抢票流程：
 *     场次列表 → 选场次 → 选票价 → 实名 → 提交订单
 */
import { AppProfile, Step } from "../profile";

/** 飞猪内置 profile（对应 Python 的 `FLIGGY_PROFILE` 常量）。 */
export const FLIGGY_PROFILE = new AppProfile({
  name: "fliggy",
  packageName: "com.taobao.trip",
  deepLinkTemplate: "fliggy://item/{item_id}",
  hints: [
    "Sold-out badge: '已售完'",
    "Show selection uses card list (CarouselView)",
  ],
  viewerPicker: "出行人",
  steps: [
    new Step({
      name: "open_detail",
      action: "open_detail",
      args: {},
      timeoutSec: 15.0,
    }),
    new Step({
      name: "wait_session",
      action: "wait_text",
      args: { text: "场次", exact: false },
      timeoutSec: 30.0,
    }),
    new Step({
      name: "tap_price",
      action: "tap_index",
      args: { text: "¥", index: 0 },
      timeoutSec: 5.0,
    }),
    new Step({
      name: "tick_traveler",
      action: "select_checkbox",
      args: { label: "" }, // 运行时从 options 取值
      timeoutSec: 5.0,
      continueOnFail: true,
    }),
    new Step({
      name: "confirm_order",
      action: "tap_text",
      args: { text: "提交订单", exact: false },
      timeoutSec: 8.0,
    }),
  ],
});
