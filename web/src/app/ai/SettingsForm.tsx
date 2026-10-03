"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { AiSettingsStatus } from "@/lib/aiConfig";

/**
 * AI provider 设置表单（设计 §8.5）：三字段 + 保存（POST /api/ai/settings）+
 * 保存后 router.refresh() 重取 RSC 状态。
 *
 * 安全：只展示 maskedKey（redactToken 掩码），apiKey 输入框不回填原文；
 * 保存会整体覆盖三要素（POST 校验要求 apiKey 必填）。
 */

const labelCls = "block text-xs font-medium text-zinc-600 dark:text-zinc-400";

/** 来源 → 中文标签。 */
const SOURCE_LABEL: Record<AiSettingsStatus["source"], string> = {
  file: "设置文件（web/data/ai-settings.json）",
  env: "环境变量（DAMAI_AI_*）",
  none: "未配置",
};

export function SettingsForm({ status }: { status: AiSettingsStatus }) {
  const router = useRouter();
  const [baseUrl, setBaseUrl] = useState(status.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(status.model ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const submit = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/ai/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: baseUrl.trim(), apiKey, model: model.trim() }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(body?.error ?? `保存失败（HTTP ${res.status}）`);
        return;
      }
      setSaved(true);
      setApiKey("");
      router.refresh(); // 重取 RSC 状态（掩码 / 来源 / configured）
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold text-ink">Provider 设置</h2>
        <span
          className={`rounded border px-2 py-0.5 text-xs font-medium ${
            status.configured
              ? "border-ok/30 bg-ok/10 text-ok"
              : "border-warn/30 bg-warn/10 text-warn"
          }`}
        >
          {status.configured ? "已配置" : "未配置"}
        </span>
        <span className="text-xs text-muted">
          来源：{SOURCE_LABEL[status.source]}
          {status.filePresent ? "；设置文件存在" : "；设置文件不存在"}
        </span>
      </div>
      <p className="mt-1 text-sm text-muted">
        任意 OpenAI 兼容 API（Base URL 形如 https://host/v1）。保存写入
        web/data/ai-settings.json（权限 0600，优先级高于环境变量）；API Key
        只存服务端，页面仅显示掩码{status.maskedKey !== null ? `（当前：${status.maskedKey}）` : ""}。
      </p>

      <form
        className="mt-4 grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div>
          <label className={labelCls} htmlFor="ai-base-url">
            Base URL（必填，合法 URL）
          </label>
          <Input
            id="ai-base-url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
            autoComplete="off"
            className="mt-1"
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="ai-api-key">
            API Key（必填；保存整体覆盖，不回填已存原文）
          </label>
          <Input
            id="ai-api-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={status.maskedKey ?? "sk-…"}
            autoComplete="off"
            className="mt-1"
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="ai-model">
            模型名（必填）
          </label>
          <Input
            id="ai-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-4o-mini / deepseek-chat / …"
            autoComplete="off"
            className="mt-1"
          />
        </div>

        {error !== null ? (
          <p className="whitespace-pre-line text-xs text-red-600 dark:text-red-400">{error}</p>
        ) : null}
        {saved ? (
          <p className="text-xs text-emerald-600 dark:text-emerald-400">
            已保存（文件 0600，写入即生效，无需重启）。
          </p>
        ) : null}

        <div>
          <Button type="submit" disabled={saving}>
            {saving ? "保存中…" : "保存设置"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
