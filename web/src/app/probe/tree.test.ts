import { describe, expect, it } from "vitest";

import {
  PROBE_DUMP_CAP,
  boundsContain,
  buildUiTree,
  capProbeElements,
  countTreeNodes,
  formatBounds,
  probeElementToString,
  type ProbeElement,
} from "./tree";

/** 构造一个最小合法的 ProbeElement（toDict 全字段 + index）。 */
function el(overrides: Partial<ProbeElement> & { index: number }): ProbeElement {
  return {
    tag: "node",
    text: "",
    resource_id: "",
    class_name: "android.widget.FrameLayout",
    content_desc: "",
    bounds: [0, 0, 0, 0],
    center: [0, 0],
    clickable: false,
    enabled: true,
    selected: false,
    checked: false,
    package: "cn.damai",
    ...overrides,
  };
}

/** 树节点映射为「index → 子 index 列表」便于断言。 */
function toIndexShape(nodes: ReturnType<typeof buildUiTree>): Record<number, number[]> {
  const shape: Record<number, number[]> = {};
  const walk = (list: ReturnType<typeof buildUiTree>): void => {
    for (const node of list) {
      if (node.element.index !== null) {
        shape[node.element.index] = node.children.map((c) => c.element.index ?? -1);
      }
      walk(node.children);
    }
  };
  walk(nodes);
  return shape;
}

function area(b: readonly number[]): number {
  return (b[2] - b[0]) * (b[3] - b[1]);
}

describe("buildUiTree（bounds 重建树）", () => {
  it("① 三层嵌套 dump：树形正确、根面积最大", () => {
    const dump = [
      el({ index: 0, class_name: "android.view.Root", bounds: [0, 0, 1080, 2400], center: [540, 1200] }),
      el({ index: 1, class_name: "android.widget.LinearLayout", bounds: [0, 0, 1080, 1200], center: [540, 600] }),
      el({
        index: 2,
        class_name: "android.widget.Button",
        text: "立即购买",
        bounds: [40, 100, 400, 200],
        center: [220, 150],
        clickable: true,
      }),
    ];
    const tree = buildUiTree(dump);
    expect(toIndexShape(tree)).toEqual({ 0: [1], 1: [2], 2: [] });
    // 根面积 >= 树里其他所有节点（外层容器最大）
    const root = tree[0]!.element;
    for (const node of tree[0]!.children[0]!.children) {
      expect(area(root.bounds)).toBeGreaterThanOrEqual(area(node.element.bounds));
    }
  });

  it("② 同级兄弟按 index 升序稳定排列", () => {
    const dump = [
      el({ index: 0, bounds: [0, 0, 1000, 1000] }),
      el({ index: 1, bounds: [0, 0, 400, 400] }),
      el({ index: 2, bounds: [500, 0, 900, 400] }),
      el({ index: 3, bounds: [0, 500, 400, 900] }),
    ];
    const tree = buildUiTree(dump);
    expect(tree.length).toBe(1);
    expect(tree[0]!.children.map((c) => c.element.index)).toEqual([1, 2, 3]);
  });

  it("③ bounds 不相交的异常数据全部挂根、绝不丢元素", () => {
    const dump = [
      el({ index: 0, bounds: [0, 0, 10, 10] }),
      el({ index: 1, bounds: [20, 20, 30, 30] }),
      el({ index: 2, bounds: [40, 40, 50, 50] }),
    ];
    const tree = buildUiTree(dump);
    expect(tree.map((n) => n.element.index)).toEqual([0, 1, 2]);
    expect(countTreeNodes(tree)).toBe(3);
  });

  it("③b 嵌套子树与不相交元素混合：各自归位且总数不丢", () => {
    const dump = [
      el({ index: 0, bounds: [0, 0, 100, 100] }),
      el({ index: 1, bounds: [0, 0, 50, 50] }),
      el({ index: 2, bounds: [200, 200, 300, 300] }),
      el({ index: 3, bounds: [210, 210, 260, 260] }),
    ];
    const tree = buildUiTree(dump);
    expect(tree.map((n) => n.element.index)).toEqual([0, 2]);
    expect(toIndexShape(tree)).toEqual({ 0: [1], 1: [], 2: [3], 3: [] });
    expect(countTreeNodes(tree)).toBe(4);
  });

  it("④ 空列表 → 空树", () => {
    expect(buildUiTree([])).toEqual([]);
  });

  it("⑤ capProbeElements：超 3000 截断且 truncated 透传，截断后重建不丢元素", () => {
    // 互不相交 → 全部挂根，节点总数即元素数
    const many = Array.from({ length: PROBE_DUMP_CAP + 1 }, (_, i) =>
      el({ index: i, bounds: [i * 20, 0, i * 20 + 10, 10] }),
    );
    const capped = capProbeElements(many);
    expect(capped.truncated).toBe(true);
    expect(capped.elements.length).toBe(3000);
    const tree = buildUiTree(capped.elements);
    expect(countTreeNodes(tree)).toBe(3000);

    const notCapped = capProbeElements(many.slice(0, PROBE_DUMP_CAP));
    expect(notCapped.truncated).toBe(false);
    expect(notCapped.elements.length).toBe(PROBE_DUMP_CAP);
  });

  it("boundsContain：完全包含为真、部分重叠为真伪各半", () => {
    expect(boundsContain([0, 0, 100, 100], [10, 10, 90, 90])).toBe(true);
    expect(boundsContain([0, 0, 100, 100], [0, 0, 100, 100])).toBe(true); // 相等 ⊇
    expect(boundsContain([0, 0, 100, 100], [50, 50, 150, 150])).toBe(false);
  });

  it("formatBounds / probeElementToString 与 core 字符串一致", () => {
    const e = el({
      index: 2,
      text: "立即购买",
      class_name: "android.widget.Button",
      bounds: [40, 100, 400, 200],
      center: [220, 150],
    });
    expect(formatBounds(e.bounds)).toBe("[40,100][400,200]");
    // models.ts:125-130 的 __repr__ 形状
    expect(probeElementToString(e)).toBe("<UIElement node '立即购买' @ (220, 150)>");
  });
});
