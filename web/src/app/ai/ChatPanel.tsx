"use client";

import { MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

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
 * POST /api/ai/chat；助手文本经 MessageResponse（streamdown）渲染 markdown，
 * 用户文本保持纯文本；tool- 前缀部分渲染为折叠卡（工具名 + 状态 + 输入/输出 JSON）。
 * 流式期间显示指示并提供「停止」。
 */

// transport 只依赖静态 api 路径，模块级单例避免每次渲染重建
const TRANSPORT = new DefaultChatTransport({ api: "/api/ai/chat" });

/** ToolUIPart.state → 中文标签 + 配色（折叠卡徽标）。 */
const TOOL_STATE_VIEW: Record<ToolUIPart["state"], { label: string; cls: string }> = {
  "input-streaming": {
    label: "输入流式传输中",
    cls: "border-line bg-surface-raised text-muted",
  },
  "input-available": {
    label: "待执行",
    cls: "border-info/30 bg-info/10 text-info",
  },
  "approval-requested": {
    label: "等待批准",
    cls: "border-warn/30 bg-warn/10 text-warn",
  },
  "approval-responded": {
    label: "已响应批准",
    cls: "border-line bg-surface-raised text-muted",
  },
  "output-available": {
    label: "已完成",
    cls: "border-ok/30 bg-ok/10 text-ok",
  },
  "output-error": {
    label: "执行出错",
    cls: "border-danger/30 bg-danger/10 text-danger",
  },
  "output-denied": {
    label: "已拒绝",
    cls: "border-danger/30 bg-danger/10 text-danger",
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
      <p className="text-xs font-medium text-muted">{label}</p>
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
    <details className="rounded-lg border border-line bg-surface px-3 py-2">
      <summary className="cursor-pointer list-none select-none">
        <span aria-hidden className="mr-1 text-muted">
          ▸
        </span>
        <span className="font-mono text-xs font-medium text-ink">
          {view.toolName}
        </span>
        <span className={`ml-2 rounded border px-2 py-0.5 text-xs font-medium ${badge.cls}`}>
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
    <Card className="overflow-hidden">
      {!configured ? (
        <div className="m-4 rounded-lg border border-warn/30 bg-warn/10 p-3 text-xs text-warn">
          尚未配置 AI 提供商。可直接在下方「Provider 设置」填入 Base URL、API Key 与 Model，或通过环境变量 DAMAI_AI_* 注入。
        </div>
      ) : null}

      <div
        ref={scrollRef}
        className="max-h-[30rem] min-h-[16rem] space-y-4 overflow-y-auto p-5"
        aria-live="polite"
      >
        {chat.messages.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center text-center text-muted">
            <p className="text-sm font-medium text-ink">AI 对话助手已就绪</p>
            <p className="mt-1 text-xs">
              支持自然语言查询已挂载的 Android 设备、检查大麦界面 UI 元素及当前监控任务。
            </p>
          </div>
        ) : null}
        {chat.messages.map((message) => {
          const toolViews = toolPartViews(message);
          return (
            <div key={message.id} className="space-y-2">
              <p className="text-xs font-semibold text-muted">
                {message.role === "user" ? "你" : "AI 助手"}
              </p>
              {message.parts.filter(isRenderablePart).map((part, index) =>
                part.type === "text" ? (
                  <div
                    key={`${message.id}-text-${index}`}
                    className={`rounded-lg px-3.5 py-2 text-xs leading-relaxed ${
                      message.role === "user"
                        ? "bg-surface-raised text-ink border border-line"
                        : "bg-surface text-ink border border-line"
                    }`}
                  >
                    {message.role === "user" ? (
                      <p className="whitespace-pre-wrap">{part.text}</p>
                    ) : (
                      <MessageResponse>{part.text}</MessageResponse>
                    )}
                  </div>
                ) : null,
              )}
              {toolViews.map((view) => (
                <ToolCard key={`${message.id}-${view.key}`} view={view} />
              ))}
            </div>
          );
        })}
        {busy ? (
          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="live-dot" />
            <span>{chat.status === "submitted" ? "已提交，等待 AI 响应…" : "AI 正在思考并组织回复…"}</span>
          </div>
        ) : null}
        {chat.error !== undefined ? (
          <div className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            请求失败：{chat.error.message}（请先检查 Provider 配置或网络连通）
          </div>
        ) : null}
      </div>

      <div className="border-t border-line bg-surface p-4">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          rows={2}
          placeholder="向助手提问（Enter 发送，Shift+Enter 换行）…"
          className="resize-none text-xs"
        />
        <div className="mt-2.5 flex items-center justify-between">
          <p className="text-[11px] text-muted">
            探查工具仅执行只读动作（无下单/扣款接口）；会话不持久化到磁盘。
          </p>
          <div className="flex gap-2">
            {busy ? (
              <Button
                type="button"
                onClick={() => chat.stop()}
                variant="outline" size="sm"
              >
                停止
              </Button>
            ) : null}
            <Button
              type="button"
              onClick={submit}
              disabled={busy || input.trim() === ""}
              size="sm"
            >
              发送
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
