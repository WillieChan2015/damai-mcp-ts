import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  type UIMessage,
} from "ai";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import { logPageOperation } from "@/lib/actionLog";
import { loadAiSettings } from "@/lib/aiConfig";
import { buildReadOnlyAiTools } from "@/lib/aiTools";

export const dynamic = "force-dynamic";

/**
 * AI 对话流式路由（POST /api/ai/chat，设计 §8.3）。
 *
 * - 未配置 provider：返回一段含中文引导文案的 assistant UI 消息流
 *   （text-start/delta/end，chunk 形状见 ai@7 dist/index.d.ts:2514-2524）；
 * - 已配置：createOpenAICompatible 运行时构造 + streamText 多步工具循环，
 *   stopWhen=stepCountIs(10)，客户端断开（req.signal abort）即中止；
 * - 鉴权由 src/proxy.ts 的 matcher 统一覆盖，本路由不自行实现鉴权；
 * - SSE 响应头由 createUIMessageStreamResponse 提供基础头
 *   （text/event-stream、x-accel-buffering: no），此处显式补 no-store；
 * - 秘密卫生：任何日志 / 错误透出前经 {@link redactSecrets} 把 apiKey 原文
 *   替换为 ***；GET /api/ai/settings 只回掩码状态。
 */

/** 多步工具循环步数上限（设计 §8.3：stopWhen=stepCountIs(10)）。 */
const MAX_STEPS = 10;

/** 系统提示：中文只读助手（D5 硬约束——绝不代付/下单，引导用户自行操作）。 */
const AI_SYSTEM_PROMPT = [
  "你是「大麦抢票助手」本地控制台的只读设备助手。",
  "你只能使用提供的只读工具（列出设备、查询设备详情、dump UI、按文本查找元素、查看监控任务）帮助用户了解设备与界面状态。",
  "你没有也不应获得任何写操作能力：不能点击、滑动、输入文本，不能下单、抢票或支付；",
  "当用户要求你代为操作、下单或支付时，必须明确拒绝，并引导用户到控制台对应页面（设备/抢票任务）自行操作。",
  "回答使用简体中文，简洁准确；描述界面时尽量引用元素 text / resource-id / bounds 作为证据。",
].join("\n");

/** 未配置 provider 时的引导文案（中文、可操作，设计 §8.3 原文）。 */
const GUIDE_MESSAGE =
  "尚未配置 AI 提供商：① 打开本页「设置」填入 Base URL / API Key / 模型名" +
  "（保存到任务数据库 web/data/tasks.db）；或 ② 在启动 web 前设置环境变量" +
  " DAMAI_AI_BASE_URL / DAMAI_AI_API_KEY / DAMAI_AI_MODEL。";

/** 对外错误文案（不含任何请求细节与密钥）。 */
const PROVIDER_ERROR_TEXT = "AI 提供商返回错误（详见服务端日志，不含密钥）";

/** 等价于 Python 的 str(exc)：Error 取 message，其余 String()。 */
function excToStr(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** 秘密卫生：把 apiKey 原文替换为 ***（写日志前必须过此函数）。 */
function redactSecrets(text: string, apiKey: string): string {
  if (apiKey === "" || !text.includes(apiKey)) {
    return text;
  }
  return text.split(apiKey).join("***");
}

/**
 * 构造 AI 对话响应（测试直调工厂，设计 §8.3）。
 *
 * @param opts.messages 客户端 UI 消息（useChat 的 messages）。
 * @param opts.model 可注入模型（mock 联调）；缺省按 aiConfig 动态构造
 *   OpenAI 兼容 provider 并取 settings.model。
 * @param opts.tools 可注入工具集；缺省 = buildReadOnlyAiTools()。
 * @param opts.abortSignal 客户端断开信号（POST 传 req.signal）。
 */
export async function buildAiChatResponse(opts: {
  messages: UIMessage[];
  model?: LanguageModel;
  tools?: ToolSet;
  abortSignal?: AbortSignal;
}): Promise<Response> {
  const settings = loadAiSettings();
  if (settings === null) {
    // 未配置分支：直接写一段引导文案的 assistant 流（不发起任何网络请求）
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        writer.write({ type: "text-start", id: "guide" });
        writer.write({ type: "text-delta", id: "guide", delta: GUIDE_MESSAGE });
        writer.write({ type: "text-end", id: "guide" });
      },
    });
    return createUIMessageStreamResponse({
      stream,
      headers: { "Cache-Control": "no-store, no-transform" },
    });
  }

  // provider 构造（baseURL 非法等在此抛出）→ 500 JSON，文案不含密钥
  let model = opts.model;
  if (model === undefined) {
    try {
      const provider = createOpenAICompatible({
        baseURL: settings.baseUrl,
        name: "damai-web",
        apiKey: settings.apiKey,
      });
      model = provider(settings.model);
    } catch (exc) {
      console.error(`AI provider 构造失败: ${redactSecrets(excToStr(exc), settings.apiKey)}`);
      return Response.json(
        { error: `AI provider 构造失败（Base URL 或模型名非法）: ${redactSecrets(excToStr(exc), settings.apiKey)}` },
        { status: 500 },
      );
    }
  }

  // UI 消息 → 模型消息；形状非法（残缺 parts 等）→ 400 中文
  let modelMessages: ModelMessage[];
  try {
    modelMessages = await convertToModelMessages(opts.messages);
  } catch (exc) {
    return Response.json({ error: `对话消息格式非法: ${excToStr(exc)}` }, { status: 400 });
  }

  const result = streamText({
    model,
    system: AI_SYSTEM_PROMPT,
    messages: modelMessages,
    tools: opts.tools ?? buildReadOnlyAiTools(),
    // 允许多步工具循环（工具结果回灌后继续生成，至多 10 步）
    stopWhen: stepCountIs(MAX_STEPS),
    abortSignal: opts.abortSignal,
    onError: ({ error }) => {
      // 服务端日志：经 redactSecrets 去除 apiKey 原文
      console.error(`AI 对话流错误: ${redactSecrets(excToStr(error), settings.apiKey)}`);
    },
  });

  return result.toUIMessageStreamResponse({
    headers: { "Cache-Control": "no-store, no-transform" },
    // 流内错误经 UI 流透出（不中断连接）；固定中文文案，不含请求细节与密钥
    onError: () => PROVIDER_ERROR_TEXT,
  });
}

/**
 * POST /api/ai/chat：useChat（DefaultChatTransport）的标准入口。
 *
 * 请求体 `{ messages: UIMessage[] }`；缺 messages / 非数组 → 400 中文。
 */
export async function POST(req: Request): Promise<Response> {
  const startedAt = performance.now();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    logPageOperation("AI 对话", startedAt, "invalid");
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const messages = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) {
    logPageOperation("AI 对话", startedAt, "invalid");
    return Response.json({ error: "请求体缺少 messages 数组" }, { status: 400 });
  }
  try {
    const response = await buildAiChatResponse({
      messages: messages as UIMessage[],
      abortSignal: req.signal,
    });
    // 流在响应返回后才继续生成，这里只记受理耗时。
    logPageOperation("AI 对话", startedAt, response.ok ? "accepted" : "failed");
    return response;
  } catch (exc) {
    logPageOperation("AI 对话", startedAt, "failed");
    throw exc;
  }
}
