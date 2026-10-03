/**
 * 详情页 CTA 状态分类（修复 4b，纯函数，无 I/O，可直接单测）。
 *
 * 背景：{@link damaiOpenConcert} 原本只以「8 秒内找到购买按钮文本」做二元
 * 判定，导致四种完全不同的页面状态共用一个「详情页加载失败」：
 * 购买弹层已打开 / 未开售（预售·预约·候补）/ 场次级终局 / 页面加载慢。
 * 本模块把可见元素折叠为有名状态，供抢票链路（修复 4c 接线）分支处置：
 *
 * - `sheet_open`  购买弹层已打开（场次/票档区已渲染）→ 直接选档，跳过点购买；
 * - `buyable`     CTA 是购票动作（立即购买 / 立即预订 / 选座购买）→ 正常抢票；
 * - `show_ended`  场次级终局（已结束 / 已取消 / 下架 / 停售）→ 终局，不再重试；
 * - `not_on_sale` 未开售 / 预约 / 候补（含预约页、倒计时节点在场）→ 可重试——
 *   T-0 场景下开票就在下一秒，绝不可据此终局；
 * - `unknown`     无信号——绝不臆断，交由上层按可重试处理。
 *
 * 匹配语义：全部词组按**元素文本全等**匹配（text / content-desc 与词条完全
 * 一致），不使用子串包含——演出标题里的「已结束」等字样不得误触发状态。
 * monitor 的 classifyAvailability 用整页包含扫描是因为误判只是继续轮询；
 * 抢票侧误判是终局，标准必须更严。角标与档位级缺货不在此判定（那属于
 * parsePurchaseSheet 的 per-tier soldOut 语义），弹层内的「缺货登记」角标
 * 因 sheet_open 优先而不会落进 not_on_sale。
 *
 * 词表均可注入，便于真机探针（examples/probe_selectors.ts）校准后调整默认值。
 */

import type { UIElement } from "../inspector/models";
import {
  priceListReady,
  sessionCardsAwaitingPrices,
  sheetHeadingsReady,
} from "./purchaseSheet";

/** CTA 处于可购票状态的文案（与 DamaiSelectors 的购买按钮三变体一致）。 */
export const DEFAULT_BUYABLE_TEXTS = ["立即购买", "立即预订", "选座购买"] as const;

/** 场次级终局词：命中即本场已不可购（演出结束 / 取消 / 下架 / 停售）。 */
export const SHOW_ENDED_CTA_WORDS = ["已结束", "已取消", "下架", "停售"] as const;

/**
 * 未开售 / 预约 / 候补 CTA 词：命中表示「现在买不了，但场次还在」。
 * 含预约页按钮（去预约 / 提前预约 / 预约抢票，与 actions 的
 * RESERVE_ENTRY_TEXTS 同源）与整档缺货登记时的底部 CTA——后者交由弹层
 * 内的 per-tier soldOut 细分，不应据此终局。
 */
export const NOT_ON_SALE_CTA_WORDS = [
  "未开售",
  "未开始",
  "即将开售",
  "即将开抢",
  "预约",
  "去预约",
  "提前预约",
  "预约抢票",
  "候补",
  "缺货登记",
] as const;

/** {@link classifyCtaState} 的返回状态。 */
export type CtaState = "buyable" | "sheet_open" | "show_ended" | "not_on_sale" | "unknown";

/** 状态 + 命中证据（evidence 为命中的词条或固定说明，无命中为 null）。 */
export interface CtaStateResult {
  state: CtaState;
  evidence: string | null;
}

/** {@link classifyCtaState} 的可选项（词表均可注入，便于探针校准与站点适配）。 */
export interface ClassifyCtaStateOptions {
  /** CTA 可购文案；默认 {@link DEFAULT_BUYABLE_TEXTS}。 */
  buyableTexts?: readonly string[];
  /** 场次级终局词；默认 {@link SHOW_ENDED_CTA_WORDS}。 */
  showEndedWords?: readonly string[];
  /** 未开售/预约/候补词；默认 {@link NOT_ON_SALE_CTA_WORDS}。 */
  notOnSaleWords?: readonly string[];
  /**
   * 倒计时节点是否在场（checklist/monitor 已有探测原语；此处只收结论）。
   * true 时未开售判定追加 `countdown_node` 证据；缺省 null = 未探测。
   */
  countdownNodePresent?: boolean | null;
  /**
   * 底部条上沿（绝对像素，调用方按屏幕高度换算，如 0.88×h）。设置后
   * buyable / show_ended / not_on_sale 三类词匹配只考虑中心点不低于该值的
   * 元素——页面中部的角标（本机实测：巡演城市「预约」角标）不再误触发状态；
   * 预约页与弹层判定是结构性检查，不受影响。缺省 null = 全屏匹配（旧行为）。
   */
  bottomBarTopY?: number | null;
}

/** 预约页标题前缀（isSessionHeading 同时接受「场次」，须先于弹层判定排除）。 */
const RESERVE_HEADING_PREFIX = "预约想看";

/**
 * 把 UI dump 的可见元素折叠为 CTA 状态（纯函数，可直接单测）。
 *
 * 判定优先级（高 → 低）：
 * ① 预约页（「预约想看…」标题）→ not_on_sale——卡片点击是登记意愿而非购票，
 *    绝不能按购买弹层处理；② 购买弹层已打开（场次/票档区已渲染）→ sheet_open
 * ——弹层盖住详情页，其下信号不可信，直接进入选档；③ CTA 可购文案 → buyable；
 * ④ 场次级终局词 → show_ended；⑤ 未开售/预约/候补词 → not_on_sale；
 * ⑥ 倒计时节点在场（options 注入）→ not_on_sale（evidence=countdown_node）；
 * ⑦ 其余 unknown。
 */
export function classifyCtaState(
  elements: readonly UIElement[],
  options: ClassifyCtaStateOptions = {},
): CtaStateResult {
  const buyableTexts = options.buyableTexts ?? DEFAULT_BUYABLE_TEXTS;
  const showEndedWords = options.showEndedWords ?? SHOW_ENDED_CTA_WORDS;
  const notOnSaleWords = options.notOnSaleWords ?? NOT_ON_SALE_CTA_WORDS;
  const bandTopY = options.bottomBarTopY ?? null;

  // 全等匹配的候选集：可见元素的 text 与 content-desc（去空白）
  const visibleTexts = new Set<string>();
  for (const element of elements) {
    if (!element.visible) {
      continue;
    }
    const text = element.text.trim();
    if (text !== "") {
      visibleTexts.add(text);
    }
    const desc = element.contentDesc.trim();
    if (desc !== "") {
      visibleTexts.add(desc);
    }
  }
  // CTA 词的限定候选集：只取底部带内的元素（bandTopY 设置时）
  let ctaTexts = visibleTexts;
  if (bandTopY !== null) {
    ctaTexts = new Set<string>();
    for (const element of elements) {
      if (!element.visible || (element.bounds[1] + element.bounds[3]) / 2 < bandTopY) {
        continue;
      }
      const text = element.text.trim();
      if (text !== "") {
        ctaTexts.add(text);
      }
      const desc = element.contentDesc.trim();
      if (desc !== "") {
        ctaTexts.add(desc);
      }
    }
  }

  // ① 预约页（优先于弹层判定：isSessionHeading 同时接受「预约想看场次」）
  for (const text of visibleTexts) {
    if (text.startsWith(RESERVE_HEADING_PREFIX)) {
      return { state: "not_on_sale", evidence: text };
    }
  }
  // ② 购买弹层已打开：场次/票档区任一已渲染
  if (
    sheetHeadingsReady(elements) ||
    priceListReady(elements) ||
    sessionCardsAwaitingPrices(elements).length > 0
  ) {
    return { state: "sheet_open", evidence: "购买弹层已打开" };
  }
  // ③ CTA 是购票动作
  const buyable = buyableTexts.find((text) => ctaTexts.has(text));
  if (buyable !== undefined) {
    return { state: "buyable", evidence: buyable };
  }
  // ④ 场次级终局
  const ended = showEndedWords.find((word) => ctaTexts.has(word));
  if (ended !== undefined) {
    return { state: "show_ended", evidence: ended };
  }
  // ⑤ 未开售 / 预约 / 候补（CTA 文案全等）
  const notOnSale = notOnSaleWords.find((word) => ctaTexts.has(word));
  if (notOnSale !== undefined) {
    return { state: "not_on_sale", evidence: notOnSale };
  }
  // ⑥ 倒计时节点在场 = 官方还在倒计时，必然未开售
  if (options.countdownNodePresent === true) {
    return { state: "not_on_sale", evidence: "countdown_node" };
  }
  return { state: "unknown", evidence: null };
}
