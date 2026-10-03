"use client";

import { useState } from "react";

import { dumpDeviceUi } from "./actions";
import { CollapsibleJsonTree } from "./CollapsibleJsonTree";
import { ElementPropsPanel } from "./ElementPropsPanel";
import {
  PROBE_DUMP_CAP,
  buildUiTree,
  countTreeNodes,
  type ProbeDumpResult,
  type ProbeElement,
} from "./tree";

/**
 * Dump 工具卡：调用 `dumpDeviceUi`（真机单次可达 15s，必须 loading 态），
 * 结果支持「平铺表格 / bounds 重建树」双视图，点击元素在右侧属性面板显示全字段证据。
 */
export function UiTreePanel({ deviceId }: { deviceId: string }) {
  const [dump, setDump] = useState<ProbeDumpResult | null>(null);
  const [compressed, setCompressed] = useState(true);
  const [view, setView] = useState<"flat" | "tree">("flat");
  const [selected, setSelected] = useState<ProbeElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDump() {
    setLoading(true);
    setError(null);
    try {
      const result = await dumpDeviceUi({ deviceId, compressed });
      if (result.serverError) {
        setError(result.serverError);
        return;
      }
      if (result.data) {
        setDump(result.data);
        setSelected(null);
      }
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setLoading(false);
    }
  }

  const tree = dump !== null ? buildUiTree(dump.elements) : [];
  const nodeCount = dump !== null ? countTreeNodes(tree) : 0;

  return (
    <section className="space-y-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Dump UI 层级</h2>
        <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
          <input
            type="checkbox"
            checked={compressed}
            onChange={(e) => setCompressed(e.target.checked)}
          />
          压缩（不含不可见控件）
        </label>
        <button
          type="button"
          onClick={handleDump}
          disabled={loading}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {loading ? "Dump 中…（真机最多约 15s）" : "Dump 当前界面"}
        </button>
      </div>

      {error ? <p className="text-xs text-red-600">{error}</p> : null}

      {dump !== null ? (
        <>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            共 {nodeCount} 个元素 ·{" "}
            {view === "tree" ? "按 bounds 重建的树（异常数据保守挂根）" : "扁平 DFS 列表"} · 证据来源：{dump.meta.dumpedBy}
          </p>
          {dump.truncated ? (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300">
              元素数超过 {PROBE_DUMP_CAP} 上限已截断（防 Server Action 1MB 限制），树/表格不完整；请用压缩 dump 或 find_text 缩小范围。
            </p>
          ) : null}
          <div className="flex gap-2">
            {(["flat", "tree"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setView(mode)}
                className={`rounded-lg border px-3 py-1.5 text-xs ${
                  view === mode
                    ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                    : "border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
                }`}
              >
                {mode === "flat" ? "平铺表格" : "树视图"}
              </button>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="max-h-[28rem] overflow-auto">
              {view === "flat" ? (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-800">
                      <th className="py-2 pr-4 font-medium">#</th>
                      <th className="py-2 pr-4 font-medium">center</th>
                      <th className="py-2 pr-4 font-medium">text</th>
                      <th className="py-2 pr-4 font-medium">resource-id</th>
                      <th className="py-2 font-medium">clickable</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dump.elements.map((el) => (
                      <tr
                        key={el.index}
                        onClick={() => setSelected(el)}
                        className={`cursor-pointer border-b border-zinc-100 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900 ${
                          selected !== null && selected.index === el.index
                            ? "bg-zinc-50 dark:bg-zinc-900"
                            : ""
                        }`}
                      >
                        <td className="py-2 pr-4 font-mono text-xs">{el.index}</td>
                        <td className="py-2 pr-4 font-mono text-xs">
                          ({el.center[0]}, {el.center[1]})
                        </td>
                        <td className="py-2 pr-4">{el.text || "—"}</td>
                        <td className="py-2 pr-4 font-mono text-xs">{el.resource_id || "—"}</td>
                        <td className="py-2">{el.clickable ? "✓" : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <CollapsibleJsonTree
                  nodes={tree}
                  selectedIndex={selected?.index ?? null}
                  onSelect={setSelected}
                />
              )}
            </div>
            <div className="max-h-[28rem] overflow-auto">
              <ElementPropsPanel element={selected} footnote={dump.meta.dumpedBy} />
            </div>
          </div>
        </>
      ) : (
        <p className="text-sm text-zinc-400 dark:text-zinc-500">
          点击「Dump 当前界面」抓取设备当前 UI 层级；抓取期间请勿操作设备。
        </p>
      )}
    </section>
  );
}
