/**
 * /api/ai/settings 路由测试（设计 §8.6④）：GET 掩码状态形状 / POST 合法保存
 * （落任务库）/ POST 非法 body 400 中文。配置经 DAMAI_WEB_TASK_DB（临时目录）
 * + DAMAI_WEB_DATA_DIR（同目录，隔离本机遗留 ai-settings.json）+ DAMAI_AI_*
 * env 直灌，隔离本机 web/data/tasks.db。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET, POST } from "./route";

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

const ENV_BASE_URL = "https://env.example.com/v1";
const ENV_API_KEY = "env-key-123456";
const ENV_MODEL = "env-model";
const POST_BASE_URL = "https://post.example.com/v1";
const POST_API_KEY = "post-key-abcdef";
const POST_MODEL = "post-model";

let dataDir: string;

/** 直读任务库中的 AI 设置单例行（验证真实落库内容）。 */
function readDbRow(): Record<string, unknown> {
  const db = new Database(join(dataDir, "tasks.db"), { readonly: true });
  try {
    return db.prepare("SELECT base_url, api_key, model FROM ai_settings WHERE id = 1").get() as Record<
      string,
      unknown
    >;
  } finally {
    db.close();
  }
}

function clearAiEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

function setAiEnv(): void {
  process.env.DAMAI_AI_BASE_URL = ENV_BASE_URL;
  process.env.DAMAI_AI_API_KEY = ENV_API_KEY;
  process.env.DAMAI_AI_MODEL = ENV_MODEL;
}

function postRequest(body: string): Request {
  return new Request("http://localhost/api/ai/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

beforeEach(() => {
  // 先清空再注入：clearAiEnv 会删掉 DAMAI_WEB_* 两个变量，顺序不能反
  clearAiEnv();
  dataDir = mkdtempSync(join(tmpdir(), "ai-settings-route-test-"));
  process.env.DAMAI_WEB_TASK_DB = join(dataDir, "tasks.db");
  // 遗留迁移路径钉到临时目录，防止 GET/POST 触发迁移时碰本机真实遗留文件
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

// ---- GET ---------------------------------------------------------------------

describe("GET /api/ai/settings", () => {
  it("未配置 → configured=false / source=none / 全 null，no-store", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      configured: false,
      source: "none",
      baseUrl: null,
      model: null,
      maskedKey: null,
    });
  });

  it("env 配置 → source=env，maskedKey 为掩码且不含原文", async () => {
    setAiEnv();

    const res = await GET();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.configured).toBe(true);
    expect(body.source).toBe("env");
    expect(body.baseUrl).toBe(ENV_BASE_URL);
    expect(body.model).toBe(ENV_MODEL);
    expect(body.maskedKey).toBe("en****56");
    const serialized = JSON.stringify(body) ?? "";
    expect(serialized).not.toContain(ENV_API_KEY);
  });
});

// ---- POST --------------------------------------------------------------------

describe("POST /api/ai/settings", () => {
  it("合法三要素 → 200 + 最新状态（source=db），真实落库且内容与请求一致", async () => {
    const res = await POST(
      postRequest(
        JSON.stringify({ baseUrl: POST_BASE_URL, apiKey: POST_API_KEY, model: POST_MODEL }),
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.configured).toBe(true);
    expect(body.source).toBe("db");
    expect(body.baseUrl).toBe(POST_BASE_URL);
    expect(body.maskedKey).not.toBe(POST_API_KEY);

    // 库中真实落库：单例行内容与请求一致
    expect(readDbRow()).toEqual({
      base_url: POST_BASE_URL,
      api_key: POST_API_KEY,
      model: POST_MODEL,
    });
    // 状态回包不含 apiKey 原文
    expect(JSON.stringify(body)).not.toContain(POST_API_KEY);
  });

  it("baseUrl 非法 URL → 400 中文且不落库", async () => {
    const res = await POST(
      postRequest(JSON.stringify({ baseUrl: "not-a-url", apiKey: POST_API_KEY, model: POST_MODEL })),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("AI 设置校验失败");
    expect(body.error).toContain("Base URL");
    expect(() => readDbRow()).toThrow();
  });

  it("缺 model → 400 逐字段中文点名", async () => {
    const res = await POST(
      postRequest(JSON.stringify({ baseUrl: POST_BASE_URL, apiKey: POST_API_KEY })),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("model");
    expect(body.error).toContain("模型名");
  });

  it("空 apiKey → 400", async () => {
    const res = await POST(
      postRequest(JSON.stringify({ baseUrl: POST_BASE_URL, apiKey: "", model: POST_MODEL })),
    );
    expect(res.status).toBe(400);
  });

  it("请求体非 JSON → 400 中文", async () => {
    const res = await POST(postRequest("not-json"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("合法 JSON");
  });
});
