/**
 * /api/ai/chat 路由测试（设计 §8.6③，mock 全链路、全程不出网）：
 * 模型用 ai/test 的 MockLanguageModelV4 + simulateReadableStream 注入；
 * 配置经 DAMAI_WEB_TASK_DB（临时目录，库不存在）+ DAMAI_WEB_DATA_DIR（隔离
 * 本机遗留 ai-settings.json）+ DAMAI_AI_* env 直灌，无库配置。
 * 真实 OpenAI 兼容商联调本机无 key，留待用户持有 key 时验证。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { tool, type UIMessage } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { z } from "zod";

import { buildAiChatResponse, POST } from "./route";

/** 本机真实 env 的原值（afterAll 复位）。 */
const ENV_KEYS = [
  "DAMAI_WEB_TASK_DB",
  "DAMAI_WEB_DATA_DIR",
  "DAMAI_AI_BASE_URL",
  "DAMAI_AI_API_KEY",
  "DAMAI_AI_MODEL",
] as const;
const savedEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

const ENV_BASE_URL = "https://mock-provider.example.com/v1";
const ENV_API_KEY = "sk-test-key-abcdef";
const ENV_MODEL = "mock-model";

/** 当前用例的空临时数据目录（隔离本机 web/data/tasks.db 与遗留 ai-settings.json）。 */
let dataDir: string;

function clearAiEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

/** 配置好 env 三要素（已配置分支）。 */
function setAiEnv(): void {
  process.env.DAMAI_AI_BASE_URL = ENV_BASE_URL;
  process.env.DAMAI_AI_API_KEY = ENV_API_KEY;
  process.env.DAMAI_AI_MODEL = ENV_MODEL;
}

/** 一条最小合法 user 消息（UIMessage 形状）。 */
function userMessage(text: string): UIMessage {
  return { id: `m-${text}`, role: "user", parts: [{ type: "text", text }] };
}

/**
 * provider v4 usage 全 0（嵌套结构对齐 @ai-sdk/provider LanguageModelV4Usage，
 * 不直接 import 该类型——web 不依赖 @ai-sdk/provider）。
 */
const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

beforeEach(() => {
  // 先清空再注入：clearAiEnv 会删掉 DAMAI_WEB_* 两个变量，顺序不能反
  clearAiEnv();
  dataDir = mkdtempSync(join(tmpdir(), "ai-chat-route-test-"));
  process.env.DAMAI_WEB_TASK_DB = join(dataDir, "tasks.db");
  // 遗留迁移路径钉到临时目录，防止 loadAiSettings 触发迁移时碰本机真实遗留文件
  process.env.DAMAI_WEB_DATA_DIR = dataDir;
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

afterAll(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

// ---- ① 已配置分支：文本流 -----------------------------------------------------

describe("buildAiChatResponse 已配置（MockLanguageModelV4 文本流）", () => {
  it("200 + text/event-stream + no-store，body 为 UI 消息流且含文本增量；不含 apiKey", async () => {
    setAiEnv();
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "你好，我是只读助手" },
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: ZERO_USAGE },
          ],
        }),
      }),
    });

    const res = await buildAiChatResponse({
      messages: [userMessage("你好")],
      model,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-store");

    const body = await res.text();
    // SSE 形态：data: 行包裹 JSON chunk；含文本增量与起止
    expect(body).toContain('"type":"text-start"');
    expect(body).toContain('"type":"text-delta"');
    expect(body).toContain("你好，我是只读助手");
    expect(body).toContain('"type":"text-end"');
    // 秘密卫生：响应不含 apiKey 原文
    expect(body).not.toContain(ENV_API_KEY);
  });

  it("system 提示注入了只读约束（不向模型泄漏 apiKey）", async () => {
    setAiEnv();
    let capturedOptions: unknown;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        capturedOptions = options;
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: ZERO_USAGE },
            ],
          }),
        };
      },
    });

    const res = await buildAiChatResponse({ messages: [userMessage("hi")], model });
    await res.text(); // streamText 惰性：消费完流才会真正调用模型

    const prompt = JSON.stringify(capturedOptions);
    expect(prompt).toContain("只读");
    expect(prompt).toContain("支付");
    expect(prompt).not.toContain(ENV_API_KEY);
  });
});

// ---- ② 多步工具循环（stepCountIs 生效）----------------------------------------

describe("buildAiChatResponse 多步工具循环", () => {
  it("第 1 步工具调用 → 第 2 步文本：doStream 被调 2 次，body 含工具输出与文本", async () => {
    setAiEnv();
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                {
                  type: "tool-call",
                  toolCallId: "call-1",
                  toolName: "list_devices",
                  input: "{}",
                },
                {
                  type: "finish",
                  finishReason: { unified: "tool-calls", raw: "tool-calls" },
                  usage: ZERO_USAGE,
                },
              ],
            }),
          };
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t2" },
              { type: "text-delta", id: "t2", delta: "当前连接了 0 台设备" },
              { type: "text-end", id: "t2" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: ZERO_USAGE },
            ],
          }),
        };
      },
    });
    const tools = {
      list_devices: tool({
        description: "测试用只读工具",
        inputSchema: z.object({}),
        execute: async () => ({ devices: [] }),
      }),
    };

    const res = await buildAiChatResponse({
      messages: [userMessage("现在有哪些设备？")],
      model,
      tools,
    });
    const body = await res.text();

    expect(calls).toBe(2); // 工具结果回灌后继续第 2 步（多步循环生效）
    expect(body).toContain('"toolName":"list_devices"');
    expect(body).toContain('"devices":[]');
    expect(body).toContain("当前连接了 0 台设备");
  });

  it("模型持续要求工具调用 → stepCountIs(10) 封顶：doStream 恰好被调 10 次", async () => {
    setAiEnv();
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              {
                type: "tool-call",
                toolCallId: `call-${calls}`,
                toolName: "list_devices",
                input: "{}",
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage: ZERO_USAGE,
              },
            ],
          }),
        };
      },
    });
    const tools = {
      list_devices: tool({
        description: "测试用只读工具",
        inputSchema: z.object({}),
        execute: async () => ({ devices: [] }),
      }),
    };

    const res = await buildAiChatResponse({
      messages: [userMessage("loop")],
      model,
      tools,
    });
    expect(res.status).toBe(200);
    await res.text(); // streamText 惰性：消费完流多步循环才完整执行
    expect(calls).toBe(10); // stopWhen=stepCountIs(10)：恰好 10 步封顶，不无限循环
  });
});

// ---- ③ 未配置分支：引导流 -----------------------------------------------------

describe("buildAiChatResponse 未配置", () => {
  it("返回含引导文案的 assistant 流（text-start/delta/end），不发起模型调用", async () => {
    const res = await buildAiChatResponse({ messages: [userMessage("你好")] });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain('"type":"text-start"');
    expect(body).toContain('"type":"text-delta"');
    expect(body).toContain("尚未配置 AI 提供商");
    expect(body).toContain("DAMAI_AI_BASE_URL");
    expect(body).toContain('"type":"text-end"');
  });
});

// ---- ④ POST 包装：请求体校验 --------------------------------------------------

function postRequest(body: string): Request {
  return new Request("http://localhost/api/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

describe("POST /api/ai/chat", () => {
  it("合法 messages + 未配置 → 200 引导流（集成经 POST）", async () => {
    const res = await POST(postRequest(JSON.stringify({ messages: [userMessage("你好")] })));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("尚未配置 AI 提供商");
  });

  it("请求体非 JSON → 400 中文", async () => {
    const res = await POST(postRequest("not-json"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("合法 JSON");
  });

  it("缺 messages 数组 → 400 中文", async () => {
    const res = await POST(postRequest(JSON.stringify({ prompt: "hi" })));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("messages");
  });

  it("messages 形状非法（缺 parts）→ 400 中文", async () => {
    setAiEnv(); // 形状校验与是否配置无关，但配置齐备可排除引导分支干扰
    const res = await POST(postRequest(JSON.stringify({ messages: [{ role: "user" }] })));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("对话消息格式非法");
  });
});
