/**
 * 基于 {@link UIElement} 列表的纯函数搜索
 * （Python `utils/find_helpers.py` 的 TS 对应物）。
 *
 * 与 uiCache 同层放置，使缓存无需引入 inspector/find（重量级 IO 函数）即可执行搜索。
 * XPath 部分使用 @xmldom/xmldom + xpath 包（标准 XPath 1.0 语义）。
 */
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import * as xpath from "xpath";

import { UIElement, parseBounds } from "../inspector/models";

/** {@link searchElements} 的过滤条件；`text` / `resourceId` / `xpath` 至少给出一个。 */
export interface SearchElementOptions {
  /** 按 text 匹配（exact 时全等，否则子串）。 */
  text?: string | null;
  /** 按 resource-id 匹配（exact 时全等，否则后缀匹配）。 */
  resourceId?: string | null;
  /** 标准 XPath 1.0 表达式；给出时忽略 text / resourceId / exact。 */
  xpath?: string | null;
  /** 是否精确匹配。默认 true。 */
  exact?: boolean;
}

function matchesText(el: UIElement, text: string, exact: boolean): boolean {
  if (el.text == null) {
    // 对应 Python 版 `el.text is None` 分支（TS 模型中不可达，保留语义）
    return false;
  }
  return exact ? el.text === text : el.text.includes(text);
}

function matchesResourceId(el: UIElement, resourceId: string, exact: boolean): boolean {
  if (el.resourceId == null) {
    return false;
  }
  if (exact) {
    return el.resourceId === resourceId;
  }
  return el.resourceId.endsWith(resourceId);
}

/**
 * 返回第一个匹配的 {@link UIElement}；无匹配时返回 null。
 *
 * `text`、`resourceId`、`xpath` 至少提供一个；给出 `xpath` 时走真正的
 * XPath 1.0 查询（与 Python 版一致，此时忽略 text / resourceId / exact）。
 */
export function searchElements(
  elements: readonly UIElement[],
  options: SearchElementOptions,
): UIElement | null {
  const { text = null, resourceId = null, xpath: xpathExpr = null, exact = true } = options;

  if (!text && !resourceId && !xpathExpr) {
    throw new Error("must supply one of text/resource_id/xpath");
  }

  const matches: UIElement[] = [];
  if (xpathExpr !== null) {
    const doc = new DOMParser().parseFromString(packElements(elements), "application/xml");
    const hits = xpath.select(xpathExpr, doc as unknown as Node);
    const nodes = Array.isArray(hits) ? hits : [hits];
    for (const hit of nodes) {
      matches.push(unpackNode(toElementNode(hit)));
    }
  } else {
    for (const el of elements) {
      if (text !== null && !matchesText(el, text, exact)) {
        continue;
      }
      if (resourceId !== null && !matchesResourceId(el, resourceId, exact)) {
        continue;
      }
      matches.push(el);
    }
  }
  return matches.length > 0 ? matches[0]! : null;
}

// ---- element <-> xml pack/unpack（轻量） --------------------------------

const PACK_FIELDS = [
  "text",
  "resource-id",
  "class",
  "package",
  "content-desc",
  "bounds",
  "clickable",
  "enabled",
] as const;

/** 复刻 Python `str()` 的布尔序列化（"True"/"False"），其余与 String() 一致。 */
function pythonStr(v: unknown): string {
  if (typeof v === "boolean") {
    return v ? "True" : "False";
  }
  return String(v);
}

/**
 * 对应 Python 的 `getattr(el, attr_name, None)`。
 *
 * 注意：Python 版 attr_name 为 "class" 时取到的是不存在的属性（UIElement 字段叫
 * class_name），恒返回 None → "class" 属性从不被打包。此处按原样保留该行为，
 * 以免 XPath 查询 `@class` 的匹配结果与 Python 版出现差异。
 */
function packField(el: UIElement, attrName: string): unknown {
  switch (attrName) {
    case "text":
      return el.text;
    case "resource_id":
      return el.resourceId;
    case "class":
      return undefined; // 复刻 Python 版：getattr(el, "class") 不存在
    case "package":
      return el.package;
    case "content_desc":
      return el.contentDesc;
    case "bounds":
      return el.bounds;
    case "clickable":
      return el.clickable;
    case "enabled":
      return el.enabled;
    default:
      return undefined;
  }
}

/** 把元素序列化成一棵用于 XPath 查询的小型 XML 树（对应 Python `_pack`）。 */
function packElements(elements: readonly UIElement[]): string {
  const doc = new DOMParser().parseFromString("<hierarchy/>", "application/xml");
  const root = doc.documentElement;
  if (root == null) {
    throw new Error("无法构建用于 XPath 查询的 XML 根节点");
  }
  for (const el of elements) {
    const node = doc.createElement("node");
    for (const f of PACK_FIELDS) {
      const attrName = f.replaceAll("-", "_");
      const v = packField(el, attrName);
      if (v == null) {
        continue;
      }
      let value: string;
      if (attrName === "bounds") {
        const b = v as readonly number[];
        value = `[${b[0]},${b[1]}][${b[2]},${b[3]}]`;
      } else {
        value = pythonStr(v);
      }
      node.setAttribute(f, value);
    }
    root.appendChild(node);
  }
  return new XMLSerializer().serializeToString(doc);
}

/** 把 XPath 命中结果收窄为元素节点；非元素结果按 Python 版的崩溃语义抛错。 */
function toElementNode(hit: Node | string | number | boolean | null): Element {
  if (hit !== null && typeof hit === "object" && (hit as Node).nodeType === 1) {
    return hit as unknown as Element;
  }
  // Python 版对属性/文本/标量结果调用 _unpack 会因缺少 .get 抛 AttributeError；
  // 这里等价地显式抛错。
  throw new TypeError(`无法把 XPath 结果解包为 UIElement：结果不是元素节点（${String(hit)}）`);
}

/** 从打包 XML 的节点还原 {@link UIElement}（对应 Python `_unpack`）。 */
function unpackNode(node: Element): UIElement {
  const boundsAttr = node.getAttribute("bounds");
  const attr = (name: string): string => node.getAttribute(name) ?? "";
  return new UIElement({
    tag: "node",
    text: attr("text") || "",
    resourceId: attr("resource-id") || "",
    className: attr("class") || "",
    contentDesc: attr("content-desc") || "",
    bounds: boundsAttr ? parseBounds(boundsAttr) : [0, 0, 0, 0],
    clickable: attr("clickable").toLowerCase() === "true",
    enabled: attr("enabled").toLowerCase() === "true",
    package: attr("package") || "",
  });
}
