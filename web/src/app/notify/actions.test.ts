/**
 * notify 页测试发送 actions 测试（自包含，全程不出网）。
 *
 * fake transport（ClawBotTransport，wechat.ts:103 导出）经 setNotifyTransportForTests
 * 注入后，sendTestNotification 的请求全部落在内存记录里；凭证用 env 直灌 +
 * setNotifyCredentialsDirForTests(空临时目录) 隔离本机真实凭证（credentials.ts:72）。
 *
 * 真实 ClawBot 送达验证属 live 冒烟——本机无凭证，留待用户持有凭证时执行。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { saveNotifyCredentials, setNotifyCredentialsDirForTests } from "@core/notify/credentials";
import {
  CLAWBOT_SENDMESSAGE_PATH,
  type ClawBotRequest,
  type ClawBotResponse,
  type ClawBotTransport,
  type SendOutcome,
} from "@core/notify/wechat";

import { sendTestNotification } from "./actions";
import { loadNotifyStatusSnapshot } from "./notifyConfig";
import {
  DEFAULT_TEST_TEXT,
  describeSendOutcome,
  sendTestSchema,
  setNotifyTransportForTests,
} from "./testSend";

/** 本机真实 env 的原值（afterAll 复位，避免污染同进程其他测试）。 */
const ENV_KEYS = [
  "DAMAI_CLAWBOT_ORIGIN",
  "DAMAI_CLAWBOT_TOKEN",
  "DAMAI_CLAWBOT_CONTEXT_TOKEN",
] as const;
const savedEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

/** 测试用三要素（host 属 *.ilinkai.weixin.qq.com 合法；token 长度 ≥ 8 可断言掩码）。 */
const ORIGIN = "https://bot.ilinkai.weixin.qq.com";
const TOKEN = "test-token-abcdef";
const CONTEXT_TOKEN = "ctx-token-987654";

/** fake transport 收到的协议请求（每用例重置）。 */
let requests: ClawBotRequest[] = [];

/** fake transport 的脚本化响应队列；空队列时默认 200+ret=0。 */
let responses: ClawBotResponse[] = [];
const fakeTransport: ClawBotTransport = async (req) => {
  requests.push(req);
  const scripted = responses.shift();
  return scripted ?? { status: 200, bodyText: '{"ret":0}' };
};

/** 清空三要素 env（缺凭证用例）。 */
function clearEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

/** 直灌三要素 env（已配置用例）。 */
function setEnv(): void {
  process.env.DAMAI_CLAWBOT_ORIGIN = ORIGIN;
  process.env.DAMAI_CLAWBOT_TOKEN = TOKEN;
  process.env.DAMAI_CLAWBOT_CONTEXT_TOKEN = CONTEXT_TOKEN;
}

/** 空凭证目录（隔离本机 ~/.config/damai-mcp-ts/notify.json）。 */
function makeEmptyCredentialsDir(): string {
  return mkdtempSync(join(tmpdir(), "notify-web-test-"));
}

/**
 * 直调 action 的测试入口：Server Action 在线上接收的是未校验的线路输入，
 * 残缺载荷（如缺 target）是合法的对抗用例——但 TS 层 action 入参类型是
 * 校验后的输出，残缺载荷须经 unknown 显式放开。
 */
async function callAction(input: unknown): Promise<Awaited<ReturnType<typeof sendTestNotification>>> {
  return sendTestNotification(input as Parameters<typeof sendTestNotification>[0]);
}

afterEach(() => {
  setNotifyTransportForTests(null);
  setNotifyCredentialsDirForTests(null);
  requests = [];
  responses = [];
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

// ---- ① schema 校验 ---------------------------------------------------------

describe("sendTestSchema / sendTestNotification 校验拒绝", () => {
  it("schema 直测：缺 target 拒绝；超长 text（>2000）拒绝；合法最小输入通过", () => {
    expect(sendTestSchema.safeParse({ text: "hi" }).success).toBe(false);
    expect(sendTestSchema.safeParse({ target: "u", text: "x".repeat(2001) }).success).toBe(false);
    expect(sendTestSchema.safeParse({ target: "u" }).success).toBe(true);
  });

  it("action 级：缺 target → validationErrors（不发请求）", async () => {
    setEnv();
    setNotifyCredentialsDirForTests(makeEmptyCredentialsDir());
    setNotifyTransportForTests(fakeTransport);
    const result = await callAction({ text: "hi" });
    expect(result.data).toBeUndefined();
    expect(result.validationErrors).toBeDefined();
    expect(JSON.stringify(result.validationErrors)).toContain("target");
    expect(requests).toHaveLength(0);
  });

  it("action 级：超长 text → validationErrors 且错误文案含 2000", async () => {
    setEnv();
    setNotifyCredentialsDirForTests(makeEmptyCredentialsDir());
    setNotifyTransportForTests(fakeTransport);
    const result = await sendTestNotification({ target: "user-001", text: "x".repeat(2001) });
    expect(result.data).toBeUndefined();
    expect(result.validationErrors).toBeDefined();
    expect(JSON.stringify(result.validationErrors)).toContain("2000");
    expect(requests).toHaveLength(0);
  });
});

// ---- ② 快乐路径（注入 fake transport）--------------------------------------

describe("sendTestNotification（注入 fake transport）", () => {
  it("env 凭证 + fake transport → status=sent，端点/载荷/协议头正确", async () => {
    setEnv();
    setNotifyTransportForTests(fakeTransport);
    const result = await sendTestNotification({ target: "user-001" });

    expect(result.serverError).toBeUndefined();
    expect(result.validationErrors).toBeUndefined();
    const data = result.data;
    if (data === undefined) {
      throw new Error("已配置凭证时应返回 data");
    }
    expect(data.status).toBe("sent");
    expect(data.error).toBeNull();
    expect(data.httpStatus).toBe(200);
    expect(data.clientId).toMatch(/^damai-mcp-ts-[0-9a-f-]{36}$/);
    expect(data.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(data.hint).toContain("已送达");

    // 协议载荷：端点、Bearer 头、to_user_id / context_token / client_id / 文案
    expect(requests).toHaveLength(1);
    const req = requests[0];
    if (req === undefined) {
      throw new Error("fake transport 应收到恰好一次请求");
    }
    expect(req.origin).toBe(ORIGIN);
    expect(req.path).toBe(CLAWBOT_SENDMESSAGE_PATH);
    expect(req.method).toBe("POST");
    expect(req.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(req.body ?? "{}") as {
      msg: {
        to_user_id: string;
        client_id: string;
        context_token: string;
        item_list: Array<{ text_item: { text: string } }>;
      };
    };
    expect(body.msg.to_user_id).toBe("user-001");
    expect(body.msg.context_token).toBe(CONTEXT_TOKEN);
    expect(body.msg.client_id).toBe(data.clientId);
    expect(body.msg.item_list[0]?.text_item.text).toBe(DEFAULT_TEST_TEXT);
  });

  it("手填凭证优先于 env（高级折叠区语义）；text 手填时不套默认文案", async () => {
    setEnv();
    setNotifyTransportForTests(fakeTransport);
    const result = await sendTestNotification({
      target: "user-002",
      text: "手动文案",
      origin: "https://alt.ilinkai.weixin.qq.com",
      token: "manual-token-0001",
      contextToken: "manual-ctx-token-1",
    });

    expect(result.data?.status).toBe("sent");
    expect(requests).toHaveLength(1);
    const req = requests[0];
    if (req === undefined) {
      throw new Error("fake transport 应收到恰好一次请求");
    }
    expect(req.origin).toBe("https://alt.ilinkai.weixin.qq.com");
    expect(req.headers.Authorization).toBe("Bearer manual-token-0001");
    const body = JSON.parse(req.body ?? "{}") as {
      msg: { context_token: string; item_list: Array<{ text_item: { text: string } }> };
    };
    expect(body.msg.context_token).toBe("manual-ctx-token-1");
    expect(body.msg.item_list[0]?.text_item.text).toBe("手动文案");
  });
});

// ---- ③ 缺凭证 → serverError 点名三要素 -------------------------------------

describe("sendTestNotification 缺凭证", () => {
  it("清 env + 空凭证目录 → serverError 同时点名 origin/token/context_token 与 env 变量名，且不发请求", async () => {
    clearEnv();
    const dir = makeEmptyCredentialsDir();
    setNotifyCredentialsDirForTests(dir);
    try {
      setNotifyTransportForTests(fakeTransport);
      const result = await sendTestNotification({ target: "user-003" });

      expect(result.data).toBeUndefined();
      const message = result.serverError ?? "";
      expect(message).toContain("origin");
      expect(message).toContain("DAMAI_CLAWBOT_ORIGIN");
      expect(message).toContain("token");
      expect(message).toContain("DAMAI_CLAWBOT_TOKEN");
      expect(message).toContain("context_token");
      expect(message).toContain("DAMAI_CLAWBOT_CONTEXT_TOKEN");
      expect(requests).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- ④ 安全：结果不回传完整凭证 --------------------------------------------

describe("安全断言：结果不含完整 token 原文", () => {
  it("成功结果 JSON.stringify 不含 token / context_token 原文", async () => {
    setEnv();
    setNotifyTransportForTests(fakeTransport);
    const result = await sendTestNotification({ target: "user-004" });
    const serialized = JSON.stringify(result) ?? "";
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(CONTEXT_TOKEN);
  });

  it("失败结果（HTTP 500）同样不含 token 原文", async () => {
    setEnv();
    responses = [{ status: 500, bodyText: "oops" }];
    setNotifyTransportForTests(fakeTransport);
    const result = await sendTestNotification({ target: "user-005" });
    expect(result.data?.status).toBe("failed");
    const serialized = JSON.stringify(result) ?? "";
    expect(serialized).not.toContain(TOKEN);
  });
});

// ---- ⑤ 页面完整性检查数据（notifyConfig）-----------------------------------

describe("loadNotifyStatusSnapshot（页面完整性检查数据）", () => {
  it("env 来源：origin 明文、token/context_token 掩码、ready=true", async () => {
    setEnv();
    setNotifyCredentialsDirForTests(makeEmptyCredentialsDir());
    const snapshot = await loadNotifyStatusSnapshot();

    expect(snapshot.ready).toBe(true);
    expect(snapshot.origin).toEqual({ configured: true, source: "env", display: ORIGIN });
    expect(snapshot.token.source).toBe("env");
    expect(snapshot.token.display).not.toBe(TOKEN);
    expect(snapshot.token.display).toBe("te****ef"); // redactToken：前 2 后 2
    expect(snapshot.contextToken.display).not.toBe(CONTEXT_TOKEN);
    const serialized = JSON.stringify(snapshot) ?? "";
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(CONTEXT_TOKEN);
  });

  it("无 env 无文件 → 三字段未配置、ready=false", async () => {
    clearEnv();
    const dir = makeEmptyCredentialsDir();
    setNotifyCredentialsDirForTests(dir);
    try {
      const snapshot = await loadNotifyStatusSnapshot();
      expect(snapshot.ready).toBe(false);
      expect(snapshot.origin).toEqual({ configured: false, source: "none", display: null });
      expect(snapshot.token.configured).toBe(false);
      expect(snapshot.contextToken.display).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("回落顺序：env 优先于文件；缺 env 的字段回落到凭证文件", async () => {
    clearEnv();
    const dir = makeEmptyCredentialsDir();
    setNotifyCredentialsDirForTests(dir);
    try {
      await saveNotifyCredentials({
        origin: "https://file.ilinkai.weixin.qq.com",
        token: "file-token-123456",
        contextToken: "file-ctx-token-1",
      });
      process.env.DAMAI_CLAWBOT_ORIGIN = "https://env.ilinkai.weixin.qq.com";

      const snapshot = await loadNotifyStatusSnapshot();
      expect(snapshot.ready).toBe(true);
      expect(snapshot.origin.source).toBe("env");
      expect(snapshot.origin.display).toBe("https://env.ilinkai.weixin.qq.com");
      expect(snapshot.token.source).toBe("file");
      expect(snapshot.token.display).toBe("fi****56");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- ⑥ describeSendOutcome 四分支 -------------------------------------------

describe("describeSendOutcome（四分支纯函数）", () => {
  function makeOutcome(partial: Partial<SendOutcome>): SendOutcome {
    return {
      status: "sent",
      clientId: "damai-mcp-ts-00000000-0000-4000-8000-000000000000",
      error: null,
      httpStatus: 200,
      elapsedMs: 42,
      ...partial,
    };
  }

  it("sent → 已送达", () => {
    expect(describeSendOutcome(makeOutcome({ status: "sent" }))).toContain("已送达");
  });

  it("failed → 发送失败 + 中文错误说明", () => {
    const hint = describeSendOutcome(
      makeOutcome({ status: "failed", error: "服务器返回 HTTP 500", httpStatus: 500 }),
    );
    expect(hint).toContain("发送失败");
    expect(hint).toContain("服务器返回 HTTP 500");
  });

  it("expired → 会话过期 + 重新绑定提示", () => {
    const hint = describeSendOutcome(
      makeOutcome({ status: "expired", error: "登录状态已过期，请重新绑定通知机器人" }),
    );
    expect(hint).toContain("会话过期");
    expect(hint).toContain("重新绑定");
  });

  it("timeout_unknown → 超时未知 + 携带 clientId 幂等重发提示", () => {
    const hint = describeSendOutcome(
      makeOutcome({ status: "timeout_unknown", error: "发送超时", httpStatus: null }),
    );
    expect(hint).toContain("超时未知");
    expect(hint).toContain("不会自动重发");
    expect(hint).toContain("damai-mcp-ts-00000000"); // 提示携带 client_id 重发
    expect(hint).toContain("幂等");
  });
});
