"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 任务实时进度查看器（SSE，计划 D2）。
 *
 * 浏览器需先持有 token Cookie（CLI 打印的 token 经 /api/token?token=… 换取），
 * EventSource 同源自动携带 Cookie。
 */
export function ProgressViewer({ taskId }: { taskId: string | null }) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [finalResult, setFinalResult] = useState<unknown>(null);
  const [connectionError, setConnectionError] = useState(false);
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
        // 忽略解析失败的心跳/杂音
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
        // 同上
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

  // 自动滚到底部
  useEffect(() => {
    const box = boxRef.current;
    if (box) {
      box.scrollTop = box.scrollHeight;
    }
  }, [lines.length]);

  if (!taskId) {
    return (
      <p className="text-sm text-zinc-400">点击上方任务行查看实时进度（SSE）。</p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-zinc-500">{taskId.slice(0, 8)}</span>
        {status ? (
          <span className="text-xs text-zinc-500">终态：{status}</span>
        ) : (
          <span className="text-xs text-blue-600">实时跟踪中…</span>
        )}
        {connectionError ? <span className="text-xs text-red-600">连接已断开</span> : null}
      </div>
      <div
        ref={boxRef}
        className="h-64 overflow-y-auto rounded-lg bg-zinc-950 p-3 font-mono text-xs leading-5 text-zinc-200"
      >
        {lines.length === 0 ? (
          <p className="text-zinc-500">等待进度…</p>
        ) : (
          lines.map((line, i) => <div key={`${i}-${line}`}>{line}</div>)
        )}
      </div>
      {finalResult != null ? (
        <details className="text-xs text-zinc-500">
          <summary className="cursor-pointer">查看结构化结果（toDict）</summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded bg-zinc-100 p-2 dark:bg-zinc-900">
            {JSON.stringify(finalResult, null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
