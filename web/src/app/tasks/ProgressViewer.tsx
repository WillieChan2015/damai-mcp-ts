"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/console";

const STAGES = [
  { id: "waiting", label: "NTP 候场" },
  { id: "preheating", label: "详情预热" },
  { id: "debouncing", label: "开票判定" },
  { id: "sku", label: "锁定票档" },
  { id: "viewers", label: "选观演人" },
  { id: "human", label: "待人工确认" },
];

function clockSummary(result: unknown): string | null {
  if (result === null || typeof result !== "object") {
    return null;
  }
  const record = result as {
    ntp_source?: unknown;
    ntp_offset_ms?: unknown;
    ntp_uncertainty_ms?: unknown;
  };
  if (record.ntp_source == null && record.ntp_offset_ms == null) {
    return null;
  }
  const uncertainty = record.ntp_uncertainty_ms == null ? "n/a" : String(record.ntp_uncertainty_ms);
  return `校时 source=${String(record.ntp_source ?? "未校正")} offset=${String(record.ntp_offset_ms ?? "—")}ms uncertainty=${uncertainty}ms`;
}

/**
 * 任务实时进度查看器（SSE）。
 * 顶部渲染 6 步流水线指示器，下方为终端式日志窗口。
 */
export function ProgressViewer({ taskId }: { taskId: string | null }) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [finalResult, setFinalResult] = useState<unknown>(null);
  const [connectionError, setConnectionError] = useState(false);
  const [copied, setCopied] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setLines([]);
    setStatus(null);
    setFinalResult(null);
    setConnectionError(false);
    if (!taskId) {
      return;
    }

    const es = new EventSource(`/api/tasks/${taskId}/events`);
    es.addEventListener("progress", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as { line: string };
        setLines((prev) => [...prev, data.line]);
      } catch {
        // 忽略杂音
      }
    });

    es.addEventListener("status", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as {
          status: string;
          result: unknown;
        };
        setStatus(data.status);
        setFinalResult(data.result);
        es.close();
      } catch {
        // 忽略
      }
    });

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        setConnectionError(true);
      }
    };

    return () => {
      es.close();
    };
  }, [taskId]);

  useEffect(() => {
    const box = boxRef.current;
    if (box) {
      box.scrollTop = box.scrollHeight;
    }
  }, [lines.length]);

  // 从日志流反推当前执行步骤（0 到 5）
  const activeStageIndex = useMemo(() => {
    if (status === "succeeded") return 5;
    if (status === "failed" || status === "cancelled") return -1;
    if (lines.length === 0) return 0;

    const fullLog = lines.slice(-10).join(" ");
    if (fullLog.includes("ready_for_human") || fullLog.includes("人工确认") || fullLog.includes("已到达确认页")) {
      return 5;
    }
    if (fullLog.includes("观演人") || fullLog.includes("选人") || fullLog.includes("实名")) {
      return 4;
    }
    if (fullLog.includes("票档") || fullLog.includes("立即购买") || fullLog.includes("确定")) {
      return 3;
    }
    if (fullLog.includes("开票判定") || fullLog.includes("去抖门") || fullLog.includes("开抢")) {
      return 2;
    }
    if (fullLog.includes("预热") || fullLog.includes("拉起详情")) {
      return 1;
    }
    return 0;
  }, [lines, status]);

  const copyLogs = () => {
    if (lines.length === 0) return;
    navigator.clipboard.writeText(lines.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!taskId) {
    return (
      <div className="flex h-72 flex-col items-center justify-center rounded-lg border border-dashed border-line p-6 text-center">
        <Glyph name="terminal" className="h-8 w-8 text-muted" />
        <p className="mt-3 text-sm text-ink font-medium">作战室未绑定任务</p>
        <p className="mt-1 text-xs text-muted">请从左侧启动新任务，或在下方历史列表中选定一个任务进行实时跟踪与日志回放。</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 阶段流水线阶梯指示 */}
      <div className="rounded-lg border border-line bg-surface-raised p-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
          {STAGES.map((stage, idx) => {
            const isCompleted = activeStageIndex > idx || status === "succeeded";
            const isCurrent = activeStageIndex === idx && status !== "failed" && status !== "cancelled";

            return (
              <div
                key={stage.id}
                className={`flex items-center gap-2 rounded px-2 py-1.5 text-xs font-medium transition-colors ${
                  isCurrent
                    ? "border border-ink bg-surface text-ink font-semibold"
                    : isCompleted
                      ? "border border-ok/20 bg-ok/10 text-ok"
                      : "border border-transparent text-muted"
                }`}
              >
                {isCurrent ? (
                  <span className="live-dot shrink-0" />
                ) : isCompleted ? (
                  <span className="shrink-0 text-ok">✓</span>
                ) : (
                  <span className="shrink-0 text-[10px] text-muted">{idx + 1}</span>
                )}
                <span className="truncate">{stage.label}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* 终端日志窗口头部控制 */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2 font-mono text-xs">
          <span className="rounded border border-line bg-surface px-1.5 py-0.5 text-muted">
            ID: {taskId.slice(0, 8)}
          </span>
          {status ? (
            <span className="text-muted">
              终态：<strong className="text-ink">{status}</strong>
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-accent font-medium">
              <span className="live-dot" />
              <span>实时跟踪流 (SSE)</span>
            </span>
          )}
          {connectionError ? (
            <span className="text-danger">（连接已断开）</span>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={copyLogs}
            disabled={lines.length === 0}
            className="font-mono"
          >
            {copied ? "已复制日志" : "复制日志"}
          </Button>
        </div>
      </div>

      {/* 日志终端机窗口 */}
      <div
        ref={boxRef}
        className="h-80 overflow-y-auto rounded-lg border border-line bg-[#0d1017] p-3 font-mono text-xs leading-5 text-[#dbe2ee] select-text"
      >
        {lines.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted">
            <span>等待事件流下发中…</span>
          </div>
        ) : (
          lines.map((line, i) => (
            <div key={`${i}-${line}`} className="hover:bg-white/5 py-0.5">
              <span className="text-muted select-none mr-2 text-[10px]">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span>{line}</span>
            </div>
          ))
        )}
      </div>

      {/* 结构化返回值展开 */}
      {clockSummary(finalResult) ? (
        <p className="rounded border border-line bg-surface px-3 py-2 font-mono text-[11px] text-ink">
          {clockSummary(finalResult)}
        </p>
      ) : null}

      {finalResult != null ? (
        <details className="rounded border border-line bg-surface p-3 text-xs text-muted">
          <summary className="cursor-pointer font-medium text-ink hover:text-accent">
            查看结构化响应数据 (toDict)
          </summary>
          <pre className="mt-2 max-h-56 overflow-auto rounded bg-surface-raised p-3 font-mono text-[11px] text-ink">
            {JSON.stringify(finalResult, null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
