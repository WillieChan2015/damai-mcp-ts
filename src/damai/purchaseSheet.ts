/**
 * 选票页上的场次卡片与票档卡片。
 * 购买弹层（场次 / 票档 / 确定）和预约页（预约想看场次 / 预约想看票档 / 已预约）
 * 用同一套规则。只看可见文本和 bounds，不依赖 resource-id。
 *
 * 真机上卡片正文经常不进无障碍树，只剩「预售」「可预约」。
 * 那种情况先框出可点卡片，再用截图识别结果补上文字。
 */

import { UIElement, type Bounds } from "../inspector/models";

/** 场次卡片正文，例如「2026-10-18 周日 18:30」。 */
export const SESSION_TEXT = /^\d{4}-\d{2}-\d{2}/;
/**
 * 票档卡片正文。价格后可以跟全角括号说明，例如
 * 「看台488元」「看台580元（大屏观演区，仅支持看大屏）」。
 * 同一节点末尾的「可预约」「缺货登记」也算这张卡片，不另算一项。
 */
export const PRICE_CARD_TEXT = /^(\D+?)(\d+(?:\.\d+)?)元(?:（[^）]*）)?(?:\s*(?:可预约|缺货登记))?$/;
/** 旧版弹层里整段就是「¥680」的票档。 */
const LEGACY_PRICE_TEXT = /^¥\d+(\.\d+)?$/;
/** 底部操作条。这些文字本身不是票档，它们的上沿是票档区下界。 */
const FOOTER_TEXTS = ["确定", "已预约", "取消预约"] as const;

export interface PurchaseSessionOption {
  label: string;
  /** 节点自身已是选中态。预约页上再点一次会取消。 */
  picked: boolean;
}

export interface PurchasePriceOption {
  label: string;
  /** 与卡片重叠的「缺货登记」角标。不改变顺序。 */
  soldOut: boolean;
  /** 节点自身已是选中态。预约页上再点一次会取消。 */
  picked: boolean;
}

export interface PurchaseSheetOptions {
  sessions: PurchaseSessionOption[];
  prices: PurchasePriceOption[];
}

function visibleText(element: UIElement): string {
  return element.text.trim();
}

function centerY(element: UIElement): number {
  return (element.bounds[1] + element.bounds[3]) / 2;
}

/** 上沿优先，同一行再比左沿。 */
function byVisualOrder(a: UIElement, b: UIElement): number {
  return a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0];
}

/** 「场次」或「预约想看场次」。旁边的「场次时间均为…」不是标题。 */
export function isSessionHeading(text: string): boolean {
  return text === "场次" || text === "预约想看场次" || text.startsWith("预约想看场次 ");
}

/** 「票档」或「预约想看票档」。 */
export function isPriceHeading(text: string): boolean {
  return text === "票档" || text === "预约想看票档" || text.startsWith("预约想看票档 ");
}

function topmost(elements: readonly UIElement[], match: (text: string) => boolean): UIElement | undefined {
  return elements
    .filter((element) => element.visible && match(visibleText(element)))
    .sort(byVisualOrder)[0];
}

/** 底部操作条里最靠上的那一个，用来挡住合计金额和「已预约」按钮。 */
function footerBar(elements: readonly UIElement[]): UIElement | undefined {
  return elements
    .filter((element) => element.visible && (FOOTER_TEXTS as readonly string[]).includes(visibleText(element)))
    .sort((a, b) => a.bounds[1] - b.bounds[1])[0];
}

function overlaps(a: UIElement, b: UIElement): boolean {
  const [ax1, ay1, ax2, ay2] = a.bounds;
  const [bx1, by1, bx2, by2] = b.bounds;
  return ax1 < bx2 && ax2 > bx1 && ay1 < by2 && ay2 > by1;
}

/**
 * 中心点是否落在票档区：票档标题之下、底部按钮之上。
 * 缺了哪一条边界，就不用那一条。
 */
function inPriceBand(
  element: UIElement,
  priceHeading: UIElement | undefined,
  footer: UIElement | undefined,
): boolean {
  const y = centerY(element);
  if (priceHeading !== undefined && y <= priceHeading.bounds[3]) {
    return false;
  }
  if (footer !== undefined && y >= footer.bounds[1]) {
    return false;
  }
  return true;
}

/** 日期卡片。同时有场次标题和票档标题时，只收两者之间的节点。 */
export function listSessionCards(elements: readonly UIElement[]): UIElement[] {
  const sessionHeading = topmost(elements, isSessionHeading);
  const priceHeading = topmost(elements, isPriceHeading);
  const constrain = sessionHeading !== undefined && priceHeading !== undefined;
  return elements
    .filter((element) => {
      if (!element.visible || !SESSION_TEXT.test(visibleText(element))) {
        return false;
      }
      if (!constrain || sessionHeading === undefined || priceHeading === undefined) {
        return true;
      }
      const y = centerY(element);
      return y > sessionHeading.bounds[3] && y < priceHeading.bounds[1];
    })
    .sort(byVisualOrder);
}

/**
 * 票档卡片。有「区域+价格+元」或票档标题时不再把 `¥数字` 算进去。
 * 两者都没有时，退回旧的整段 `¥数字`，并丢掉底部按钮那一行上的合计。
 */
export function listPriceCards(elements: readonly UIElement[]): UIElement[] {
  const priceHeading = topmost(elements, isPriceHeading);
  const confirm = footerBar(elements);
  const cards = elements.filter(
    (element) =>
      element.visible &&
      PRICE_CARD_TEXT.test(visibleText(element)) &&
      inPriceBand(element, priceHeading, confirm),
  );
  if (cards.length > 0 || priceHeading !== undefined) {
    return cards.sort(byVisualOrder);
  }
  return elements
    .filter(
      (element) =>
        element.visible &&
        LEGACY_PRICE_TEXT.test(visibleText(element)) &&
        inPriceBand(element, undefined, confirm),
    )
    .sort(byVisualOrder);
}

export function parsePurchaseSheet(elements: readonly UIElement[]): PurchaseSheetOptions {
  const badges = elements.filter((element) => element.visible && visibleText(element) === "缺货登记");
  return {
    sessions: listSessionCards(elements).map((element) => ({
      label: normalizeSheetLabel(visibleText(element)),
      picked: element.selected,
    })),
    prices: listPriceCards(elements).map((element) => {
      const raw = visibleText(element);
      return {
        label: normalizeSheetLabel(raw),
        // 缺货登记有两种节点形态：与卡片重叠的独立角标节点，或拼在正文行尾
        // （"看台588元缺货登记"）。两种都视为该档当前不可购。
        soldOut:
          badges.some((badge) => overlaps(badge, element)) || PRICE_SOLD_OUT_SUFFIX.test(raw),
        picked: element.selected,
      };
    }),
  };
}

export function priceListReady(elements: readonly UIElement[]): boolean {
  return listPriceCards(elements).length > 0;
}

export function sheetHasChoice(elements: readonly UIElement[]): boolean {
  return listSessionCards(elements).length > 0 || listPriceCards(elements).length > 0;
}

/**
 * 预热时核对冻结的文字选择。对得上返回 null。
 * 场次或票档列表为空时不检查那一项。
 */
export function missingFrozenSelection(
  sheet: PurchaseSheetOptions,
  sessionLabel: string,
  priceLabels: readonly string[],
): string | null {
  const session = sessionLabel.trim();
  if (session !== "" && !sheet.sessions.some((item) => item.label === session)) {
    const available = sheet.sessions.map((item) => item.label).join("、");
    return available === ""
      ? `预热校验未找到场次「${session}」`
      : `预热校验未找到场次「${session}」，当前有: ${available}`;
  }
  if (priceLabels.length > 0 && !priceLabels.some((label) => sheet.prices.some((item) => item.label === label))) {
    const available = sheet.prices.map((item) => item.label).join("、");
    return available === ""
      ? `预热校验未找到主档或备选：${priceLabels.join("、")}`
      : `预热校验未找到主档或备选（${priceLabels.join("、")}），当前有: ${available}`;
  }
  return null;
}

/** 场次标题和票档标题都在。卡片正文可以还不在。 */
export function sheetHeadingsReady(elements: readonly UIElement[]): boolean {
  return topmost(elements, isSessionHeading) !== undefined && topmost(elements, isPriceHeading) !== undefined;
}

const OCR_BADGES = ["预售", "可预约", "缺货登记"] as const;

/** 价签卡上表示「当前不可购」的行尾角标后缀。预售不算——预售场次仍是可选项。 */
const PRICE_SOLD_OUT_SUFFIX = /(?:\s*(?:可预约|缺货登记))+$/;

/**
 * 卡片显示名的归一形态：剥掉行尾重复的角标（预售 / 可预约 / 缺货登记）并收尾空白。
 * 真机上角标可能与卡片正文同节点（"看台588元缺货登记"），也可能独立成节点；
 * 归一化后两种形态与用户配置的纯文本档位名（"看台588元"）可以一致地比对。
 * OCR 路径的 {@link stripOcrBadges} 与本函数同规则。
 */
export function normalizeSheetLabel(text: string): string {
  return stripOcrBadges(text).trim();
}

export interface OcrBox {
  bounds: Bounds;
  text: string;
}

function normalizeOcrLine(text: string): string {
  return text
    .replace(/[•·]/g, " ")
    .replace(/\(/g, "（")
    .replace(/\)/g, "）")
    .replace(/\s+/g, " ")
    .trim();
}

function stripOcrBadges(text: string): string {
  return text.replace(/(?:\s*(?:预售|可预约|缺货登记))+$/u, "").trim();
}

/** 把一张卡片里识别出的几行收成场次或票档全文。对不上就返回 null。 */
export function labelFromOcrLines(lines: readonly string[]): string | null {
  const cleaned = lines
    .map(normalizeOcrLine)
    .filter(
      (line) =>
        line !== "" &&
        !(OCR_BADGES as readonly string[]).includes(line) &&
        /[\d\u4e00-\u9fff]/u.test(line),
    );
  if (cleaned.length === 0) {
    return null;
  }
  const candidates = [stripOcrBadges(cleaned.join(" ")), stripOcrBadges(cleaned.join("")), ...cleaned];
  for (const candidate of candidates) {
    const text = candidate.replace(/\s+/g, " ").trim();
    if (SESSION_TEXT.test(text) || PRICE_CARD_TEXT.test(text)) {
      return text;
    }
  }
  return null;
}

function contains(outer: UIElement, inner: UIElement): boolean {
  const [ax1, ay1, ax2, ay2] = outer.bounds;
  const [bx1, by1, bx2, by2] = inner.bounds;
  return bx1 >= ax1 && by1 >= ay1 && bx2 <= ax2 && by2 <= ay2;
}

function centerInside(bounds: Bounds, card: UIElement): boolean {
  const x = (bounds[0] + bounds[2]) / 2;
  const y = (bounds[1] + bounds[3]) / 2;
  const [x1, y1, x2, y2] = card.bounds;
  return x >= x1 && x <= x2 && y >= y1 && y <= y2;
}

/**
 * 标题之间、还没有正文的可点卡片。
 * 底部「取消预约 / 已预约」整条排除：它的中心紧贴底栏文字。
 */
export function unlabeledSheetCards(elements: readonly UIElement[]): UIElement[] {
  const sessionHeading = topmost(elements, isSessionHeading);
  const priceHeading = topmost(elements, isPriceHeading);
  if (sessionHeading === undefined || priceHeading === undefined) {
    return [];
  }
  const footer = footerBar(elements);
  const footerCut = footer !== undefined ? footer.bounds[1] - 48 : Number.POSITIVE_INFINITY;
  const clickable = elements.filter((element) => {
    if (!element.visible || !element.clickable) {
      return false;
    }
    if (element.height < 70 || element.height > 280 || element.width < 160) {
      return false;
    }
    const y = centerY(element);
    const inSession = y > sessionHeading.bounds[3] && y < priceHeading.bounds[1];
    const inPrice = y > priceHeading.bounds[3] && y < footerCut;
    return inSession || inPrice;
  });
  return clickable
    .filter((card) => !clickable.some((other) => other !== card && contains(other, card)))
    .sort(byVisualOrder);
}

const FOOTER_MARKERS = ["¥", "确定", "已预约", "取消预约"] as const;

/**
 * 只出现了场次、票档区还没画出来时的场次卡片。
 * 这种页不选场次就不会渲染票档。底栏（¥0 / 确定）不算场次。
 */
export function sessionCardsAwaitingPrices(elements: readonly UIElement[]): UIElement[] {
  const sessionHeading = topmost(elements, isSessionHeading);
  if (sessionHeading === undefined || topmost(elements, isPriceHeading) !== undefined) {
    return [];
  }
  const clickable = elements.filter((element) => {
    if (!element.visible || !element.clickable) {
      return false;
    }
    if (element.height < 70 || element.height > 280 || element.width < 160) {
      return false;
    }
    if (centerY(element) <= sessionHeading.bounds[3]) {
      return false;
    }
    const holdsFooter = elements.some(
      (marker) =>
        marker !== element &&
        marker.visible &&
        (FOOTER_MARKERS as readonly string[]).includes(marker.text.trim()) &&
        contains(element, marker),
    );
    return !holdsFooter;
  });
  return clickable
    .filter((card) => !clickable.some((other) => other !== card && contains(other, card)))
    .sort(byVisualOrder);
}

/** 实心心形是 ImageView。空心心是图标字体，不是 ImageView。 */
function filledHeart(card: UIElement, elements: readonly UIElement[]): boolean {
  return elements.some(
    (element) =>
      element.className.endsWith("ImageView") &&
      element.width >= 16 &&
      element.width <= 90 &&
      element.height >= 16 &&
      element.height <= 90 &&
      contains(card, element),
  );
}

/**
 * 给没有正文的卡片补上识别文字。已有同样全文的节点不重复加。
 * 返回新数组，原列表不动。
 */
export function applyOcrLabels(elements: readonly UIElement[], boxes: readonly OcrBox[]): UIElement[] {
  const extra: UIElement[] = [];
  for (const card of unlabeledSheetCards(elements)) {
    const lines = boxes.filter((box) => centerInside(box.bounds, card)).map((box) => box.text);
    const label = labelFromOcrLines(lines);
    if (label === null) {
      continue;
    }
    if (elements.some((element) => element.visible && visibleText(element) === label)) {
      continue;
    }
    extra.push(
      new UIElement({
        tag: "node",
        text: label,
        bounds: card.bounds,
        clickable: true,
        selected: filledHeart(card, elements),
        className: card.className,
      }),
    );
  }
  return extra.length > 0 ? [...elements, ...extra] : [...elements];
}
