// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CollapsibleJsonTree } from "./CollapsibleJsonTree";
import type { ProbeElement, UiTreeNode } from "./tree";

function el(index: number, text: string, className: string): ProbeElement {
  return {
    tag: "node",
    text,
    resource_id: "",
    class_name: className,
    content_desc: "",
    bounds: [0, 0, 0, 0],
    center: [0, 0],
    clickable: false,
    enabled: true,
    selected: false,
    checked: false,
    package: "cn.damai",
    index,
  };
}

/** 三层嵌套：0(根) > 1(容器) > 2(按钮)。 */
const NODES: UiTreeNode[] = [
  {
    element: el(0, "", "android.view.Root"),
    children: [
      {
        element: el(1, "", "android.widget.LinearLayout"),
        children: [
          {
            element: { ...el(2, "立即购买", "android.widget.Button"), clickable: true },
            children: [],
          },
        ],
      },
    ],
  },
];

function summaryOf(label: string): Element {
  const button = screen.getByText(label);
  const summary = button.closest("summary");
  if (summary === null) {
    throw new Error(`未找到 ${label} 对应的 <summary>`);
  }
  return summary;
}

describe("CollapsibleJsonTree（组件冒烟，jsdom）", () => {
  afterEach(() => {
    cleanup();
  });

  it("默认展开 2 层：depth 0/1 的 summary 展开，depth 2 默认折叠", () => {
    render(<CollapsibleJsonTree nodes={NODES} selectedIndex={null} onSelect={() => undefined} />);
    // 三层节点都渲染
    expect(screen.getByText("#0 Root")).toBeTruthy();
    expect(screen.getByText("#1 LinearLayout")).toBeTruthy();
    expect(screen.getByText("#2 Button “立即购买” · clickable")).toBeTruthy();
    // 默认展开前两层、折叠第三层（aria-expanded 反映 details open 态）
    expect(summaryOf("#0 Root").getAttribute("aria-expanded")).toBe("true");
    expect(summaryOf("#1 LinearLayout").getAttribute("aria-expanded")).toBe("true");
    expect(summaryOf("#2 Button “立即购买” · clickable").getAttribute("aria-expanded")).toBe("false");
  });

  it("点击 summary 展开 / 再点击折叠", () => {
    const onSelect = vi.fn();
    render(<CollapsibleJsonTree nodes={NODES} selectedIndex={null} onSelect={onSelect} />);
    const summary = summaryOf("#2 Button “立即购买” · clickable");
    fireEvent.click(summary);
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(summary);
    expect(summary.getAttribute("aria-expanded")).toBe("false");
  });

  it("点击元素标签触发 onSelect 并带出该元素", () => {
    const onSelect = vi.fn();
    render(<CollapsibleJsonTree nodes={NODES} selectedIndex={1} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("#2 Button “立即购买” · clickable"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    const arg = onSelect.mock.calls[0]?.[0] as ProbeElement;
    expect(arg.index).toBe(2);
    expect(arg.text).toBe("立即购买");
    // 选中态样式渲染在 selectedIndex 命中的节点上
    const selectedButton = screen.getByText("#1 LinearLayout");
    expect(selectedButton.className).toContain("bg-zinc-200");
  });
});
