"use client";

import { useState } from "react";

import { probeElementToString, type ProbeElement, type UiTreeNode } from "./tree";

const BTN_CLS =
  "rounded px-1.5 py-0.5 text-left font-mono text-xs transition-colors hover:bg-surface-raised";

/** class 全名取最后一段（android.widget.Button → Button）。 */
function shortClassName(className: string): string {
  const idx = className.lastIndexOf(".");
  return idx === -1 ? className : className.slice(idx + 1);
}

/**
 * 递归 `<details>` 可折叠树（设计稿 §7.2）：默认展开 2 层（depth 0/1），
 * 点击元素标签 → 回调 onSelect 驱动右侧属性面板。
 */
export function CollapsibleJsonTree({
  nodes,
  selectedIndex,
  onSelect,
}: {
  nodes: UiTreeNode[];
  selectedIndex: number | null;
  onSelect: (element: ProbeElement) => void;
}) {
  if (nodes.length === 0) {
    return <p className="text-sm text-muted">（空树）</p>;
  }
  return (
    <ul className="space-y-0.5 text-sm">
      {nodes.map((node) => (
        <TreeNode
          key={node.element.index ?? probeElementToString(node.element)}
          node={node}
          depth={0}
          selectedIndex={selectedIndex}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

function TreeNode({
  node,
  depth,
  selectedIndex,
  onSelect,
}: {
  node: UiTreeNode;
  depth: number;
  selectedIndex: number | null;
  onSelect: (element: ProbeElement) => void;
}) {
  // 默认展开 2 层：depth 0/1 展开，更深层默认折叠
  const [open, setOpen] = useState(depth < 2);
  const el = node.element;
  const selected = el.index !== null && el.index === selectedIndex;

  const labelText = `${el.index === null ? "" : `#${el.index} `}${shortClassName(el.class_name)}${
    el.text ? ` “${el.text}”` : ""
  }${el.resource_id ? ` ${el.resource_id}` : ""}${el.clickable ? " · clickable" : ""}`;

  return (
    <li>
      <details open={open}>
        <summary
          aria-expanded={open}
          onClick={(e) => {
            e.preventDefault();
            setOpen((o) => !o);
          }}
          className="cursor-pointer select-none list-none py-0.5"
        >
          <span aria-hidden className="mr-1 inline-block w-3 font-mono text-xs text-muted">
            {node.children.length > 0 ? (open ? "▾" : "▸") : "·"}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelect(el);
            }}
            className={`${BTN_CLS} ${
              selected
                ? "bg-zinc-200 font-semibold text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50"
                : "text-ink"
            }`}
          >
            {labelText}
          </button>
        </summary>
        {node.children.length > 0 ? (
          <ul className="ml-3 border-l border-line pl-2.5">
            {node.children.map((child) => (
              <TreeNode
                key={child.element.index ?? probeElementToString(child.element)}
                node={child}
                depth={depth + 1}
                selectedIndex={selectedIndex}
                onSelect={onSelect}
              />
            ))}
          </ul>
        ) : null}
      </details>
    </li>
  );
}
