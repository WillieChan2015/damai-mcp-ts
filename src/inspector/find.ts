/**
 * 按各类选择器定位 UIElement + 等待助手
 * （Python `inspector/find.py` 的 TS 对应物）。
 */
import { setTimeout as sleep } from "node:timers/promises";

import { DOMParser } from "@xmldom/xmldom";
import * as xpath from "xpath";

import { UIElementNotFoundError } from "../utils/errors";
import { getDeviceUiCache } from "../utils/uiCache";
import { type Bounds, UIElement, parseBounds } from "./models";
import { dumpUi } from "./dump";

// ---- 单次查找 ---------------------------------------------------------------

/**
 * 定位 text / content-desc 包含 `text` 的 UIElement。
 *
 * `exact=false` 为子串匹配；`exact=true`（默认）为整串相等。
 * 返回第一个匹配元素，超时抛 UIElementNotFoundError。
 */
export async function findByText(
  deviceId: string,
  text: string,
  {
    exact = true,
    clickableOnly = false,
    timeout = 5.0,
    pollInterval = 0.3,
  }: {
    exact?: boolean;
    clickableOnly?: boolean;
    timeout?: number;
    pollInterval?: number;
  } = {},
): Promise<UIElement> {
  return waitFor(deviceId, {
    predicate: { kind: "element", fn: (el) => matchesText(el, text, exact) },
    timeout,
    pollInterval,
    description: `text=${JSON.stringify(text)}`,
    extraFilter: (el) => !clickableOnly || el.clickable,
  });
}

/** 按 `resource-id` 查找（完整 id 或后缀）。 */
export async function findByResourceId(
  deviceId: string,
  resourceId: string,
  {
    exact = true,
    timeout = 5.0,
    pollInterval = 0.3,
  }: { exact?: boolean; timeout?: number; pollInterval?: number } = {},
): Promise<UIElement> {
  return waitFor(deviceId, {
    predicate: { kind: "element", fn: (el) => matchesRid(el, resourceId, exact) },
    timeout,
    pollInterval,
    description: `resource-id=${JSON.stringify(resourceId)}`,
  });
}

/**
 * 通过标准 XPath 1.0 在 UI 树上查找。
 *
 * 可用属性：`text`、`resource-id`、`class`、`content-desc`、`bounds`、
 * `clickable`、`enabled`。
 * 示例：`//node[@text='立即购买' and @clickable='true']`
 */
export async function findByXpath(
  deviceId: string,
  xpathExpr: string,
  { timeout = 5.0, pollInterval = 0.3 }: { timeout?: number; pollInterval?: number } = {},
): Promise<UIElement> {
  return waitFor(deviceId, {
    predicate: {
      kind: "list",
      fn: (elements) => {
        // 由扁平 UIElement 列表重建一棵用于 XPath 查询的最小 XML 树。
        // 注意：这里与 utils/findHelpers.ts 的 _pack 不同——find.py 自己的打包
        // 显式包含 @class（find_helpers 的 getattr hack 使其 @class 恒缺失），
        // 两处行为差异是 Python 原版既有的，需保持。
        const doc = packElements(elements);
        let selected: xpath.SelectReturnType;
        try {
          selected = xpath.select(xpathExpr, doc as unknown as Node);
        } catch (exc) {
          const msg = exc instanceof Error ? exc.message : String(exc);
          throw new UIElementNotFoundError(`XPath 错误: ${msg}`);
        }
        const hits: readonly unknown[] = Array.isArray(selected) ? selected : [selected];
        if (hits.length === 0) {
          return null;
        }
        const first = hits[0];
        // 非元素节点（属性/文本/标量）对应 Python 版 `.get` 抛 AttributeError 的路径：
        // 由 _wait_for 捕获后记录 last_error 并继续轮询。
        if (first === null || typeof first !== "object" || (first as Node).nodeType !== 1) {
          throw new TypeError(`无法把 XPath 结果解包为 UIElement：结果不是元素节点（${String(first)}）`);
        }
        // 用 bounds 把命中节点映射回 UIElement（廉价且基本唯一）
        const bounds = parseBounds((first as Element).getAttribute("bounds") ?? "");
        for (const el of elements) {
          if (boundsEqual(el.bounds, bounds)) {
            return el;
          }
        }
        return null;
      },
    },
    timeout,
    pollInterval,
    description: `xpath=${JSON.stringify(xpathExpr)}`,
  });
}

export async function waitForText(
  deviceId: string,
  text: string,
  { exact = true, timeout = 5.0, pollInterval = 0.3 }: { exact?: boolean; timeout?: number; pollInterval?: number } = {},
): Promise<UIElement> {
  return findByText(deviceId, text, { exact, timeout, pollInterval });
}

/**
 * 便捷入口：按前缀分发选择器。
 *
 * 支持的前缀：
 *     `text=...`        → findByText
 *     `resource-id=...` → findByResourceId
 *     `xpath=...`       → findByXpath
 *     裸值              → 按 text 处理
 */
export async function waitForElement(
  deviceId: string,
  selector: string,
  { timeout = 5.0, pollInterval = 0.3 }: { timeout?: number; pollInterval?: number } = {},
): Promise<UIElement> {
  if (selector.startsWith("text=")) {
    return findByText(deviceId, selector.slice(5), { timeout, pollInterval });
  }
  if (selector.startsWith("resource-id=")) {
    return findByResourceId(deviceId, selector.slice(12), { timeout, pollInterval });
  }
  if (selector.startsWith("xpath=")) {
    return findByXpath(deviceId, selector.slice(6), { timeout, pollInterval });
  }
  return findByText(deviceId, selector, { timeout, pollInterval });
}

/** 超时时间内 text 出现则返回 true，否则返回 false。 */
export async function assertText(
  deviceId: string,
  text: string,
  { exact = true, timeout = 3.0 }: { exact?: boolean; timeout?: number } = {},
): Promise<boolean> {
  try {
    await findByText(deviceId, text, { exact, timeout });
    return true;
  } catch (exc) {
    if (exc instanceof UIElementNotFoundError) {
      return false;
    }
    throw exc;
  }
}

// ---- 内部实现 ---------------------------------------------------------------

/** 元素级谓词：对单个 UIElement 判断是否匹配。 */
export type ElementPredicate = (el: UIElement) => boolean;

/** 列表级谓词：对整个扁平元素列表返回第一个命中元素（无命中返回 null）。 */
export type ListPredicate = (elements: readonly UIElement[]) => UIElement | null;

/**
 * {@link waitFor} 的谓词参数——显式的两种形态（按元素 / 按列表）。
 *
 * Python 版用 `inspect.signature` 反射参数注解来猜测谓词形态
 * （`_is_list_predicate`）；TS 无法可靠反射参数类型，故改为显式区分。
 */
export type FindPredicate =
  | { readonly kind: "element"; readonly fn: ElementPredicate }
  | { readonly kind: "list"; readonly fn: ListPredicate };

/** 等价于 Python 的 `str(exc)`：Error 取 message，其余 String()。 */
function excToStr(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** 对应 Python float 的 str()：整数值浮点保留 ".0"（如 5.0 → "5.0"）。 */
function pyFloat(v: number): string {
  return Number.isInteger(v) ? `${v}.0` : String(v);
}

function matchesText(el: UIElement, needle: string, exact: boolean): boolean {
  if (!needle) {
    return false;
  }
  const candidates = [el.text, el.contentDesc];
  if (exact) {
    return candidates.some((c) => c === needle);
  }
  return candidates.some((c) => c !== "" && c.includes(needle));
}

function matchesRid(el: UIElement, needle: string, exact: boolean): boolean {
  if (!el.resourceId) {
    return false;
  }
  if (exact) {
    return el.resourceId === needle;
  }
  return el.resourceId.endsWith(needle) || el.resourceId.includes(needle);
}

function boundsStr(b: Bounds): string {
  return `[${b[0]},${b[1]}][${b[2]},${b[3]}]`;
}

function boundsEqual(a: Bounds, b: Bounds): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/**
 * 把元素序列化成一棵用于 XPath 查询的小型 XML 树（对应 Python find.py 的内联打包）。
 *
 * 与 Python 原版一致：所有属性无条件写入（包括空串），且包含 `@class`。
 */
function packElements(elements: readonly UIElement[]) {
  const doc = new DOMParser().parseFromString("<hierarchy/>", "application/xml");
  const root = doc.documentElement;
  if (root == null) {
    throw new Error("无法构建用于 XPath 查询的 XML 根节点");
  }
  for (const el of elements) {
    const node = doc.createElement("node");
    node.setAttribute("text", el.text);
    node.setAttribute("resource-id", el.resourceId);
    node.setAttribute("class", el.className);
    node.setAttribute("content-desc", el.contentDesc);
    node.setAttribute("bounds", boundsStr(el.bounds));
    node.setAttribute("clickable", el.clickable ? "true" : "false");
    node.setAttribute("enabled", el.enabled ? "true" : "false");
    root.appendChild(node);
  }
  return doc;
}

/**
 * 通用等待器。
 *
 * `predicate` 既可以是作用于单个 UIElement 的元素谓词（元素形态），
 * 也可以是作用于整个元素列表的列表谓词（xpath 形态）——
 * 由 {@link FindPredicate} 的 `kind` 判别字段显式区分。
 */
async function waitFor(
  deviceId: string,
  {
    predicate,
    timeout,
    pollInterval,
    description,
    extraFilter = null,
  }: {
    predicate: FindPredicate;
    timeout: number;
    pollInterval: number;
    description: string;
    extraFilter?: ((el: UIElement) => boolean) | null;
  },
): Promise<UIElement> {
  const deadline = performance.now() + timeout * 1000;
  let lastDumpCount = -1;
  let lastError: unknown = null;

  while (performance.now() < deadline) {
    let elements: UIElement[];
    try {
      // per-device UICache 注册（enableDeviceUiCache）后经缓存读取：同一轮询
      // 窗口内共享一次 dump（指纹命中则整体跳过）；未注册时保持裸 dumpUi 的
      // 旧行为（逐字一致）。UICache 内部 dump 抛错同样原样上抛走本分支。
      const cache = getDeviceUiCache(deviceId);
      elements = cache !== null ? await cache.get(deviceId) : await dumpUi(deviceId);
    } catch (exc) {
      lastError = exc;
      await sleep(pollInterval * 1000);
      continue;
    }
    lastDumpCount = elements.length;

    if (extraFilter !== null) {
      elements = elements.filter(extraFilter);
    }

    let result: UIElement | null;
    try {
      if (predicate.kind === "list") {
        result = predicate.fn(elements);
      } else {
        result = elements.find((el) => predicate.fn(el)) ?? null;
      }
    } catch (exc) {
      lastError = exc;
      await sleep(pollInterval * 1000);
      continue;
    }

    if (result !== null && result.visible) {
      return result;
    }
    await sleep(pollInterval * 1000);
  }

  let msg = `等待 ${description} 超时（${pyFloat(timeout)}s，dump 节点数 ${lastDumpCount}）`;
  if (lastError !== null) {
    msg += `，最后错误: ${excToStr(lastError)}`;
  }
  throw new UIElementNotFoundError(msg);
}
