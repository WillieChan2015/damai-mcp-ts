/**
 * 选择器调试器的纯函数与共享类型（actions 与 client 组件共用）。
 *
 * core 的 `dumpUi` 返回扁平 DFS 列表、不暴露父索引（`src/inspector/dump.ts:85-89`），
 * 因此树结构由本模块按 bounds 包含关系在客户端重建。
 */
import type { UIElement } from "@core/inspector/models";

/** `UIElement.toDict()` 的返回形状（snake_case，`src/inspector/models.ts:95-123`）。 */
export type ElementDict = ReturnType<UIElement["toDict"]>;

/** probe 页流转的单个元素载荷：`toDict()` + dump 序号 + 原生 XML 属性。 */
export interface ProbeElement extends ElementDict {
  /** 扁平 DFS 列表中的序号（0 起）；findByText 命中的元素拿不到 dump 位置时为 null。 */
  index: number | null;
  /** 未提升为一等字段的原生 XML 属性（`models.ts:51`）；仅 core 侧非 null 时附带。 */
  attrs?: Record<string, string>;
}

/**
 * 证据标注：把页面结果映射回 core 源码出处（设计稿 §7.1 技术决策 6），
 * 供「证据」面板显示来源注脚。
 */
export interface ProbeMeta {
  /** dump 结果的来源 API。 */
  dumpedBy: string;
  /** find_text 结果的来源 API。 */
  foundBy: string;
}

/** 证据注脚常量（path:line 实读自 2026-10-03 源码）。 */
export const PROBE_META: ProbeMeta = {
  dumpedBy: "src/inspector/dump.ts:102 dumpUi",
  foundBy: "src/inspector/find.ts:23 findByText",
};

/** `dumpDeviceUi` 的返回载荷。 */
export interface ProbeDumpResult {
  /** 元素数超过 {@link PROBE_DUMP_CAP} 被截断时为 true。 */
  truncated: boolean;
  /** 扁平元素列表（已截断到 {@link PROBE_DUMP_CAP}）。 */
  elements: ProbeElement[];
  meta: ProbeMeta;
}

/** `findTextProbe` 的返回载荷；未命中（超时）是正常试查结果而非错误。 */
export type ProbeFindResult =
  | { found: true; element: ProbeElement; meta: ProbeMeta }
  | { found: false; error: string; meta: ProbeMeta };

/** bounds 重建树的单个节点。 */
export interface UiTreeNode {
  element: ProbeElement;
  /** bounds 被当前元素完全包含的子节点（同级按 index 升序）。 */
  children: UiTreeNode[];
}

/** Server Action 返回载荷的元素数上限（防 Next Server Action 默认 1MB body 限制）。 */
export const PROBE_DUMP_CAP = 3000;

/**
 * 把元素列表截断到 {@link PROBE_DUMP_CAP}：超出时取前 N 个并置 `truncated=true`。
 */
export function capProbeElements(elements: ReadonlyArray<ProbeElement>): {
  elements: ProbeElement[];
  truncated: boolean;
} {
  if (elements.length > PROBE_DUMP_CAP) {
    return { elements: elements.slice(0, PROBE_DUMP_CAP), truncated: true };
  }
  return { elements: [...elements], truncated: false };
}

/** 判断父 bounds 是否完全包含子 bounds（uiautomator 语义：父 bounds ⊇ 子 bounds）。 */
export function boundsContain(
  parent: readonly number[],
  child: readonly number[],
): boolean {
  return (
    parent[0] <= child[0] &&
    parent[1] <= child[1] &&
    parent[2] >= child[2] &&
    parent[3] >= child[3]
  );
}

/**
 * 按 bounds 包含关系把扁平 DFS 列表重建为树（uiautomator 语义：父 bounds ⊇ 子 bounds）。
 *
 * 算法：按列表序（即 DFS 前序）维护祖先栈——当前元素的父 = 栈顶仍包含它的最近祖先；
 * 栈顶不再包含时逐层弹出（对应 DFS 子树关闭）。
 * 非包含关系（异常 dump）→ 保守挂到根，绝不丢元素；同级按 index 稳定排序。
 */
export function buildUiTree(elements: ReadonlyArray<ProbeElement>): UiTreeNode[] {
  const roots: UiTreeNode[] = [];
  const stack: UiTreeNode[] = [];
  for (const element of elements) {
    while (
      stack.length > 0 &&
      !boundsContain(stack[stack.length - 1]!.element.bounds, element.bounds)
    ) {
      stack.pop();
    }
    const node: UiTreeNode = { element, children: [] };
    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      roots.push(node);
    } else {
      parent.children.push(node);
    }
    stack.push(node);
  }
  sortSiblingsByIndex(roots);
  return roots;
}

/** 同级按 index 升序稳定排序（Array.sort 为稳定排序；index 缺失时排最后）。 */
function sortSiblingsByIndex(nodes: UiTreeNode[]): void {
  for (const node of nodes) {
    node.children.sort(
      (a, b) =>
        (a.element.index ?? Number.MAX_SAFE_INTEGER) -
        (b.element.index ?? Number.MAX_SAFE_INTEGER),
    );
    sortSiblingsByIndex(node.children);
  }
}

/** 统计树节点总数（「绝不丢元素」自检与单测用）。 */
export function countTreeNodes(nodes: ReadonlyArray<UiTreeNode>): number {
  let count = 0;
  for (const node of nodes) {
    count += 1 + countTreeNodes(node.children);
  }
  return count;
}

/** bounds 数组 → `[x1,y1][x2,y2]` 字符串（与 core `boundsStr` 一致）。 */
export function formatBounds(bounds: readonly number[]): string {
  return `[${bounds[0]},${bounds[1]}][${bounds[2]},${bounds[3]}]`;
}

/** 复刻 `UIElement.toString()`（`models.ts:125-130`），供客户端从 dict 重建证据行。 */
export function probeElementToString(element: ProbeElement): string {
  const label =
    element.text || element.content_desc || element.resource_id || element.class_name;
  const [cx, cy] = element.center;
  return `<UIElement ${element.tag} '${label}' @ (${cx}, ${cy})>`;
}
