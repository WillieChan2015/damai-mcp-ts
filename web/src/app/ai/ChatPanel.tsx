"use client";

import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  getToolOrDynamicToolName,
  isToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from "ai";
import { useEffect, useRef, useState } from "react";

/**
 * AI 对话面板（设计 §8.5）：useChat + DefaultChatTransport 直连
 * POST /api/ai/chat；文本部分直接渲染，tool- 前缀部分渲染为折叠卡
 * （工具名 + 状态 + 输入/输出 JSON）。流式期间显示指示并提供「停止」。
 */

// transport 只依赖静态 api 路径，模块级单例避免每次渲染重建
const TRANSPORT = new DefaultChatTransport({ api: "/api/ai/chat" });

/** ToolUIPart.state → 中文标签 + 配色（折叠卡徽标）。 */
const TOOL_STATE_VIEW: Record<ToolUIPart["state"], { label: string; cls: string }> = {
  "input-streaming": {
    label: "输入流式传输中",
    cls: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  },
  "input-available": {
    label: "待执行",
    cls: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  },
  "approval-requested": {
    label: "等待批准",
    cls: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  },
  "approval-responded": {
    label: "已响应批准",
    cls: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  },
  "output-available": {
    label: "已完成",
    cls: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  },
  "output-error": {
    label: "执行出错",
    cls: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300",
  },
  "output-denied": {
    label: "已拒绝",
    cls: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300",
  },
};

/** 消息 part 里提取的只读工具卡视图数据。 */
interface ToolPartView {
  key: string;
  toolName: string;
  state: ToolUIPart["state"];
  input: unknown;
  output: unknown;
}

/** 从消息 parts 中挑出工具调用卡（tool- 前缀静态工具 / dynamic-tool）。 */
function toolPartViews(message: UIMessage): ToolPartView[] {
  const views: ToolPartView[] = [];
  for (const part of message.parts) {
    if (!isToolUIPart(part)) {
      continue;
    }
    const toolPart = part as ToolUIPart;
    views.push({
      key: toolPart.toolCallId,
      toolName: getToolOrDynamicToolName(toolPart),
      state: toolPart.state,
      input: toolPart.input,
      output: toolPart.output,
    });
  }
  return views;
}

/** 证据展示：非 text 的 part 不在本面板渲染（当前工具集不会产生）；只渲染文本与工具卡。 */
function isRenderablePart(part: UIMessage["parts"][number]): boolean {
  return part.type === "text" || isToolUIPart(part);
}

/** JSON 折叠卡内的代码块（空值显示占位）。 */
function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</p>
      <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-zinc-50 p-2 font-mono text-xs text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
        {value === undefined || value === null ? "—" : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

/** 单条工具调用折叠卡：工具名 + 状态徽标 + 输入/输出 JSON。 */
function ToolCard({ view }: { view: ToolPartView }) {
  const badge = TOOL_STATE_VIEW[view.state];
  return (
    <details className="rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
      <summary className="cursor-pointer list-none select-none">
        <span aria-hidden className="mr-1 text-zinc-400">
          ▸
        </span>
        <span className="font-mono text-xs font-medium text-zinc-800 dark:text-zinc-200">
          {view.toolName}
        </span>
        <span className={`ml-2 rounded px-2 py-0.5 text-xs font-medium ${badge.cls}`}>
          {badge.label}
        </span>
      </summary>
      <div className="mt-2 grid gap-3">
        <JsonBlock label="输入" value={view.input} />
        <JsonBlock label="输出" value={view.output} />
      </div>
    </details>
  );
}

/**
 * 对话面板。未配置 provider（configured=false）时顶部常驻引导条；
 * 聊天记录与输入框在两种状态下都可用——发送未配置时会收到引导流。
 */
export function ChatPanel({ configured }: { configured: boolean }) {
  const chat = useChat({ transport: TRANSPORT });
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const busy = chat.status === "submitted" || chat.status === "streaming";

  // 新消息 / 流式推进时滚到底部（仅容器内滚动，不劫持页面）
  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null) {
      el.scrollTop = el.scrollHeight;
    }
  }, [chat.messages, chat.status]);

  const submit = (): void => {
    const text = input.trim();
    if (text === "" || busy) {
      return;
    }
    void chat.sendMessage({ text });
    setInput("");
  };

  return (
    <section className="rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      {!configured ? (
        <p className="m-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          尚未配置 AI 提供商——发送消息会收到配置引导。请先在
          <a href="#ai-settings" className="mx-1 underline">
            下方设置区
          </a>
          填入 Base URL / API Key / 模型名，或通过环境变量 DAMAI_AI_* 配置。
        </p>
      ) : null}

      <div
        ref={scrollRef}
        className="max-h-[28rem] space-y-4 overflow-y-auto px-4 py-4"
        aria-live="polite"
      >
        {chat.messages.length === 0 ? (
          <p className="text-sm text-zinc-400 dark:text-zinc-500">
            （暂无对话。试试「现在连接了哪些设备？」）
          </p>
        ) : null}
        {chat.messages.map((message) => {
          const toolViews = toolPartViews(message);
          return (
            <div key={message.id} className="space-y-2">
              <p
                className={`text-xs font-medium ${
                  message.role === "user"
                    ? "text-zinc-500 dark:text-zinc-400"
                    : "text-emerald-600 dark:text-emerald-400"
                }`}
              >
                {message.role === "user" ? "你" : "AI 助手"}
              </p>
              {message.parts.filter(isRenderablePart).map((part, index) =>
                part.type === "text" ? (
                  <p
                    key={`${message.id}-text-${index}`}
                    className="whitespace-pre-wrap text-sm text-zinc-800 dark:text-zinc-200"
                  >
                    {part.text}
                  </p>
                ) : null,
              )}
              {toolViews.map((view) => (
                <ToolCard key={`${message.id}-${view.key}`} view={view} />
              ))}
            </div>
          );
        })}
        {busy ? (
          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            {chat.status === "submitted" ? "已提交，等待 AI 响应…" : "AI 正在回复…"}
          </p>
        ) : null}
        {chat.error !== undefined ? (
          <p className="text-sm text-red-600 dark:text-red-400">
            请求失败：{chat.error.message}（可重试；若提示未配置请先完成设置）
          </p>
        ) : null}
      </div>

      <div className="border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Enter 发送、Shift+Enter 换行（聊天输入惯例）
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          rows={2}
          placeholder="输入消息，Enter 发送 / Shift+Enter 换行"
          className="w-full resize-none rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
        />
        <div className="mt-2 flex items-center justify-between">
          <p className="text-xs text-zinc-400">
            工具仅只读探查；对话记录仅保存在当前浏览器会话内。
          </p>
          <div className="flex gap-2">
            {busy ? (
              <button
                type="button"
                onClick={() => chat.stop()}
                className="rounded-lg border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
              >
                停止
              </button>
            ) : null}
            <button
              type="button"
              onClick={submit}
              disabled={busy || input.trim() === ""}
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
            >
              发送
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
