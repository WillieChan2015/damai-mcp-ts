import { getAiSettingsStatus } from "@/lib/aiConfig";

import { ChatPanel } from "./ChatPanel";
import { SettingsForm } from "./SettingsForm";
import { PageHeader } from "@/components/console";

export const dynamic = "force-dynamic";

export const metadata = { title: "AI · Damai Console" };

/**
 * AI 对话页（设计 §8.5）：provider 设置 + 对话面板。
 *
 * RSC 读取掩码状态快照（getAiSettingsStatus，apiKey 只回掩码）传给两个
 * client 组件；未配置 provider 时对话面板顶部出现引导条，指向设置区。
 * 本页面只读探查：AI 工具集为只读（见 @/lib/aiTools），绝不暴露下单/支付。
 */
export default function AiPage() {
  const status = getAiSettingsStatus();

  return (
    <div className="space-y-6">
      <div>
        <PageHeader title="AI 助手" lede="OpenAI 兼容 provider 动态可插：对话中可调用只读探查工具（列设备 / 设备详情 / dump UI / 查找文本 / 监控任务）。AI 绝不执行点击/下单/支付等写操作。" />
      </div>

      <div id="ai-settings">
        <SettingsForm status={status} />
      </div>
      <ChatPanel configured={status.configured} />
    </div>
  );
}
