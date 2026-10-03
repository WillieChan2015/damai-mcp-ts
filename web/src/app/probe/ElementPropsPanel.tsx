"use client";

import { formatBounds, probeElementToString, type ProbeElement } from "./tree";

const TH_CLS = "py-1 pr-4 align-top font-medium text-zinc-500 dark:text-zinc-400";
const TD_CLS = "py-1 pr-4 font-mono text-xs break-all text-zinc-800 dark:text-zinc-200";

/**
 * 元素属性面板（设计稿 §7.1「证据」面板）：`UIElement.toString()` 证据行 +
 * toDict 全字段表 + 原生 attrs + core 来源注脚。
 */
export function ElementPropsPanel({
  element,
  footnote,
}: {
  element: ProbeElement | null;
  /** core 来源注脚（path:line），如 `src/inspector/dump.ts:102 dumpUi`。 */
  footnote?: string;
}) {
  if (element === null) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-400 dark:border-zinc-700">
        点击左侧任一元素查看属性与证据。
      </div>
    );
  }

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
    <div className="space-y-3">
      <code className="block rounded-lg bg-zinc-100 px-3 py-2 font-mono text-xs text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
        {probeElementToString(element)}
      </code>
      <table className="w-full text-xs">
        <tbody>
          {rows.map(([key, value]) => (
            <tr key={key} className="border-b border-zinc-100 dark:border-zinc-900">
              <th className={TH_CLS}>{key}</th>
              <td className={TD_CLS}>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {element.attrs !== undefined ? (
        <div>
          <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">原生 attrs</p>
          <table className="mt-1 w-full text-xs">
            <tbody>
              {Object.entries(element.attrs).map(([key, value]) => (
                <tr key={key} className="border-b border-zinc-100 dark:border-zinc-900">
                  <th className={TH_CLS}>{key}</th>
                  <td className={TD_CLS}>{value === "" ? "（空）" : value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {footnote ? (
        <p className="text-xs text-zinc-400 dark:text-zinc-500">证据来源：{footnote}</p>
      ) : null}
    </div>
  );
}
