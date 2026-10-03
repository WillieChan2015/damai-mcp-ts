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
 * Dump 工具卡：分屏 IDE 风格调试台。
 * 左侧：DOM 树或平铺列表。
 * 右侧：全属性核查面板与 XPath 映射。
 */
export function UiTreePanel({ deviceId }: { deviceId: string }) {
  const [dump, setDump] = useState<ProbeDumpResult | null>(null);
  const [compressed, setCompressed] = useState(true);
  const [view, setView] = useState<"tree" | "flat">("tree");
  const [selected, setSelected] = useState<ProbeElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterText, setFilterText] = useState("");

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

  const rawElements = dump?.elements ?? [];
  const filteredElements = filterText.trim()
    ? rawElements.filter(
        (el) =>
          el.text?.toLowerCase().includes(filterText.toLowerCase()) ||
          el.resource_id?.toLowerCase().includes(filterText.toLowerCase()) ||
          el.content_desc?.toLowerCase().includes(filterText.toLowerCase()) ||
          el.class_name.toLowerCase().includes(filterText.toLowerCase()),
      )
    : rawElements;

  const tree = dump !== null ? buildUiTree(filteredElements) : [];
  const nodeCount = dump !== null ? countTreeNodes(tree) : 0;

  return (
    <section className="panel overflow-hidden">
      {/* 顶部控制栏 */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-ink">UI 结构层级检视</h2>
          <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={compressed}
              onChange={(e) => setCompressed(e.target.checked)}
              className="rounded border-line"
            />
            <span>仅可见控件</span>
          </label>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleDump}
            disabled={loading}
            className="btn btn-primary px-3 py-1.5 text-xs"
          >
            {loading ? "正在抓取 UI（约需 5~15s）…" : "Dump 当前界面"}
          </button>
        </div>
      </div>

      <div className="p-5 space-y-4">
        {error ? (
          <div className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </div>
        ) : null}

        {dump !== null ? (
          <>
            {/* 状态统计与视图切换 */}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-muted">
                  共 {nodeCount} 个节点
                </span>
                <span className="text-muted">·</span>
                <span className="text-xs text-muted">
                  来源：<code className="font-mono text-[11px]">{dump.meta.dumpedBy}</code>
                </span>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  placeholder="过滤类名 / 文本 / ID…"
                  className="field py-1 text-xs max-w-xs"
                />

                <div className="flex rounded border border-line p-0.5">
                  <button
                    type="button"
                    onClick={() => setView("tree")}
                    className={`rounded px-2 py-0.5 text-xs transition-colors ${
                      view === "tree"
                        ? "bg-surface text-ink font-semibold shadow-xs"
                        : "text-muted hover:text-ink"
                    }`}
                  >
                    树形视图
                  </button>
                  <button
                    type="button"
                    onClick={() => setView("flat")}
                    className={`rounded px-2 py-0.5 text-xs transition-colors ${
                      view === "flat"
                        ? "bg-surface text-ink font-semibold shadow-xs"
                        : "text-muted hover:text-ink"
                    }`}
                  >
                    平铺表格
                  </button>
                </div>
              </div>
            </div>

            {dump.truncated ? (
              <div className="rounded border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
                元素数超过 {PROBE_DUMP_CAP} 上限已截断，树/表格可能不完整；建议勾选「仅可见控件」或使用下方文本试查。
              </div>
            ) : null}

            {/* 双栏 IDE 分屏 */}
            <div className="grid gap-6 lg:grid-cols-12">
              {/* 左侧 UI 结构 (7/12, ~58%) */}
              <div className="lg:col-span-7 h-[32rem] overflow-auto rounded-lg border border-line bg-surface p-3">
                {view === "flat" ? (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-line text-left text-muted">
                        <th className="py-1.5 pr-2 font-medium">#</th>
                        <th className="py-1.5 pr-2 font-medium">中心点</th>
                        <th className="py-1.5 pr-2 font-medium">文本</th>
                        <th className="py-1.5 pr-2 font-medium">Resource ID</th>
                        <th className="py-1.5 font-medium">可点</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredElements.map((el) => (
                        <tr
                          key={el.index}
                          onClick={() => setSelected(el)}
                          className={`cursor-pointer border-b border-line transition-colors hover:bg-surface-raised ${
                            selected !== null && selected.index === el.index
                              ? "bg-surface-raised font-semibold"
                              : ""
                          }`}
                        >
                          <td className="py-1.5 pr-2 font-mono text-muted">{el.index}</td>
                          <td className="py-1.5 pr-2 font-mono text-muted">
                            ({el.center[0]},{el.center[1]})
                          </td>
                          <td className="py-1.5 pr-2 text-ink max-w-[140px] truncate">{el.text || "—"}</td>
                          <td className="py-1.5 pr-2 font-mono text-muted max-w-[140px] truncate">{el.resource_id || "—"}</td>
                          <td className="py-1.5 text-ok">{el.clickable ? "✓" : ""}</td>
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

              {/* 右侧属性核查面板 (5/12, ~42%) */}
              <div className="lg:col-span-5 h-[32rem] overflow-auto rounded-lg border border-line bg-surface p-3">
                <ElementPropsPanel element={selected} footnote={dump.meta.dumpedBy} />
              </div>
            </div>
          </>
        ) : (
          <div className="flex h-56 flex-col items-center justify-center rounded-lg border border-dashed border-line p-6 text-center">
            <p className="text-sm font-medium text-ink">当前尚未抓取 UI 树</p>
            <p className="mt-1 text-xs text-muted">
              点击右上角「Dump 当前界面」抓取连接设备的实时 UI 层级。
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
