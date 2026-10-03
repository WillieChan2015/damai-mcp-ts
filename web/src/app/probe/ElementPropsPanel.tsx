"use client";

import { Button } from "@/components/ui/button";
import { useState } from "react";
import { formatBounds, probeElementToString, type ProbeElement } from "./tree";

const TH_CLS = "py-1.5 pr-4 align-top font-medium text-muted whitespace-nowrap";
const TD_CLS = "py-1.5 pr-4 font-mono text-xs break-all text-ink";

/**
 * 元素属性核查面板：
 * - 顶部证据行 + 一键复制 XPath / ID
 * - 全属性键值核查表
 * - 原生 attrs 与 core 源码证据链
 */
export function ElementPropsPanel({
  element,
  footnote,
}: {
  element: ProbeElement | null;
  footnote?: string;
}) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  if (element === null) {
    return (
      <div className="flex h-64 flex-col items-center justify-center rounded-lg border border-dashed border-line p-6 text-center">
        <p className="text-sm font-medium text-ink">未选定控件节点</p>
        <p className="mt-1 text-xs text-muted">点击左侧 UI 树或结果表中的任意节点，在此检查其属性与选择器证据。</p>
      </div>
    );
  }

  const copyText = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  const buildXPathSuggestion = (el: ProbeElement): string => {
    if (el.resource_id) {
      return `//*[@resource-id="${el.resource_id}"]`;
    }
    if (el.text) {
      return `//*[@text="${el.text}"]`;
    }
    if (el.content_desc) {
      return `//*[@content-desc="${el.content_desc}"]`;
    }
    return `//${el.class_name}`;
  };

  const xpathSuggestion = buildXPathSuggestion(element);

  const rows: Array<[string, string]> = [
    ["index", element.index === null ? "—（findByText 不含 dump 位置）" : String(element.index)],
    ["tag", element.tag],
    ["text", element.text || "（空）"],
    ["resource_id", element.resource_id || "（空）"],
    ["class_name", element.class_name || "（空）"],
    ["content_desc", element.content_desc || "（空）"],
    ["bounds", `${formatBounds(element.bounds)} ${JSON.stringify(element.bounds)}`],
    ["center", `(${element.center[0]}, ${element.center[1]})`],
    ["clickable", element.clickable ? "true" : "false"],
    ["enabled", element.enabled ? "true" : "false"],
    ["selected", element.selected ? "true" : "false"],
    ["checked", element.checked ? "true" : "false"],
    ["package", element.package || "（空）"],
  ];

  return (
    <div className="space-y-4">
      {/* 快捷选择器建议 */}
      <div className="rounded-lg border border-line bg-surface-raised p-3">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-muted">XPath 引用建议</span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => copyText(xpathSuggestion, "xpath")}
            className="font-mono"
          >
            {copiedKey === "xpath" ? "已复制" : "复制 XPath"}
          </Button>
        </div>
        <div className="mt-1.5 font-mono text-xs text-accent break-all select-all">
          {xpathSuggestion}
        </div>
      </div>

      {/* 证据签名行 */}
      <div className="relative group">
        <code className="block rounded-lg border border-line bg-paper px-3 py-2 font-mono text-xs text-ink break-all">
          {probeElementToString(element)}
        </code>
      </div>

      {/* 全字段属性总表 */}
      <div>
        <h3 className="text-xs font-semibold text-ink mb-2">控件属性详情</h3>
        <table className="w-full text-xs">
          <tbody>
            {rows.map(([key, value]) => (
              <tr key={key} className="border-b border-line">
                <th className={TH_CLS}>{key}</th>
                <td className={TD_CLS}>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 原生 attributes */}
      {element.attrs !== undefined ? (
        <div>
          <h3 className="text-xs font-semibold text-ink mb-2">原生 attrs</h3>
          <table className="w-full text-xs">
            <tbody>
              {Object.entries(element.attrs).map(([key, value]) => (
                <tr key={key} className="border-b border-line">
                  <th className={TH_CLS}>{key}</th>
                  <td className={TD_CLS}>{value === "" ? "（空）" : value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {footnote ? (
        <p className="text-[11px] text-muted">证据来源：{footnote}</p>
      ) : null}
    </div>
  );
}
