/**
 * /api/ai/settings 路由测试（设计 §8.6④）：GET 掩码状态形状 / POST 合法保存
 * （落盘 0600）/ POST 非法 body 400 中文。配置经 DAMAI_WEB_DATA_DIR（空临时
 * 目录）+ DAMAI_AI_* env 直灌，隔离本机 web/data/ai-settings.json。
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET, POST } from "./route";

/** 本机真实 env 的原值（afterAll 复位）。 */
const ENV_KEYS = [
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

function settingsFile(): string {
  return join(dataDir, "ai-settings.json");
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
  // 先清空再注入：clearAiEnv 会删掉 DAMAI_WEB_DATA_DIR，顺序不能反
  clearAiEnv();
  dataDir = mkdtempSync(join(tmpdir(), "ai-settings-route-test-"));
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
      filePresent: false,
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
  it("合法三要素 → 200 + 最新状态（source=file），文件落盘 0600 且内容正确", async () => {
    const res = await POST(
      postRequest(
        JSON.stringify({ baseUrl: POST_BASE_URL, apiKey: POST_API_KEY, model: POST_MODEL }),
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.configured).toBe(true);
    expect(body.source).toBe("file");
    expect(body.baseUrl).toBe(POST_BASE_URL);
    expect(body.maskedKey).not.toBe(POST_API_KEY);

    // 文件真实落盘：权限 0600（POSIX）+ JSON 内容与请求一致
    const text = readFileSync(settingsFile(), "utf-8");
    expect(JSON.parse(text)).toEqual({
      baseUrl: POST_BASE_URL,
      apiKey: POST_API_KEY,
      model: POST_MODEL,
    });
    if (process.platform !== "win32") {
      expect(statSync(settingsFile()).mode & 0o777).toBe(0o600);
    }
    // 状态回包不含 apiKey 原文
    expect(JSON.stringify(body)).not.toContain(POST_API_KEY);
  });

  it("baseUrl 非法 URL → 400 中文且不落盘", async () => {
    const res = await POST(
      postRequest(JSON.stringify({ baseUrl: "not-a-url", apiKey: POST_API_KEY, model: POST_MODEL })),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("AI 设置校验失败");
    expect(body.error).toContain("Base URL");
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
