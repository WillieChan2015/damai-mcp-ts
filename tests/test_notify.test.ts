/**
 * notify —— 微信 ClawBot sendmessage 协议客户端测试（自包含，全程不出网）。
 *
 * beforeAll 起一个本地 node:http 服务器（listen(0) 随机端口）记录到达的请求；
 * 注入的 transport 把名义 origin（合法的 https://bot.ilinkai.weixin.qq.com）
 * 映射到 127.0.0.1——origin 校验与真实走向解耦，无需任何逃生开关。
 *
 * 「响应体上限」与「超时」两条用例必须走默认 fetch 传输（上限与 AbortSignal.timeout
 * 都实现在 createFetchTransport 里），同样经映射指向本地服务器，不触真实服务。
 */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CLAWBOT_APP_CLIENT_VERSION,
  CLAWBOT_DEFAULT_CHANNEL_VERSION,
  CLAWBOT_SENDMESSAGE_PATH,
  ClawBotClient,
  type ClawBotRequest,
  type ClawBotTransport,
  type SendStatus,
  createFetchTransport,
} from "../src/notify/wechat";

/** 名义 origin：host ∈ *.ilinkai.weixin.qq.com（合法），真实走向由 transport 决定。 */
const NOMINAL_ORIGIN = "https://bot.ilinkai.weixin.qq.com";
const TOKEN = "test-bot-token";
const CONTEXT_TOKEN = "ctx-token-for-tests";

/** 本地服务器记录到的请求。 */
interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  rawBody: string;
  receivedAt: number;
  respondedAt: number;
}

/** 每条请求的脚本化响应。 */
interface ScriptedResponse {
  status: number;
  body?: string;
  delayMs?: number;
  /** true 时挂住不响应（等客户端超时）。 */
  hang?: boolean;
}

let server: Server;
let port = 0;
let requests: RecordedRequest[] = [];
let script: () => ScriptedResponse = () => ({ status: 200, body: '{"ret":0}' });

/** transport 收到的协议请求（跨用例累积，用于「不出网」守护断言）。 */
const transportCalls: ClawBotRequest[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("error", () => {}); // 客户端超时中止时忽略
    req.on("end", () => {
      const scripted = script();
      const record: RecordedRequest = {
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        rawBody: Buffer.concat(chunks).toString("utf-8"),
        receivedAt: Date.now(),
        respondedAt: 0,
      };
      requests.push(record);
      if (scripted.hang) {
        return; // 挂住：不响应，等客户端超时
      }
      setTimeout(() => {
        record.respondedAt = Date.now();
        res.writeHead(scripted.status, { "Content-Type": "application/json" });
        res.end(scripted.body ?? "");
      }, scripted.delayMs ?? 0);
    });
    res.on("error", () => {}); // 客户端中止时忽略
  });
  // 防御：默认的 clientError 处理会回 400 响应，可能干扰挂住/超时用例
  server.on("clientError", (_err, socket) => {
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("本地测试服务器未取得端口");
  }
  port = addr.port;
});

afterAll(async () => {
  // 先掐掉所有连接（含挂住用例遗留的 socket），close 才能立即完成
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err === null || err === undefined ? resolve() : reject(err)));
  });
});

beforeEach(() => {
  requests = [];
  script = () => ({ status: 200, body: '{"ret":0}' });
});

/** 共享的默认 fetch 传输（createFetchTransport 一次）。 */
const baseFetchTransport = createFetchTransport();

/** 注入用 transport：记录协议请求，并把 origin 映射到 127.0.0.1 本地服务器。 */
const localTransport: ClawBotTransport = async (req) => {
  transportCalls.push(req);
  return baseFetchTransport({ ...req, origin: `http://127.0.0.1:${port}` });
};

function makeClient(timeoutMs = 5_000): ClawBotClient {
  return new ClawBotClient({ origin: NOMINAL_ORIGIN, token: TOKEN, timeoutMs }, localTransport);
}

// ---- ① 快乐路径 -----------------------------------------------------------

describe("sendText 快乐路径", () => {
  it("200+ret=0 → sent；六个协议头、client_id 格式与 payload 形状全部正确", async () => {
    const outcome = await makeClient().sendText("user-001", CONTEXT_TOKEN, "您关注的演出已开售");

    expect(outcome.status).toBe("sent");
    expect(outcome.error).toBeNull();
    expect(outcome.httpStatus).toBe(200);
    expect(outcome.clientId).toMatch(/^damai-mcp-ts-[0-9a-f-]{36}$/);
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(0);

    expect(requests).toHaveLength(1);
    const req = requests[0];
    expect(req.method).toBe("POST");
    expect(req.path).toBe(CLAWBOT_SENDMESSAGE_PATH);
    // 六个协议头（node:http 把到达的头名统一小写）
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers["ilink-app-id"]).toBe("bot");
    expect(req.headers["ilink-app-clientversion"]).toBe(CLAWBOT_APP_CLIENT_VERSION);
    expect(req.headers["authorizationtype"]).toBe("ilink_bot_token");
    expect(req.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    // X-WECHAT-UIN：base64(随机 u32 的十进制 ASCII 串)
    const uinText = Buffer.from(String(req.headers["x-wechat-uin"]), "base64").toString("ascii");
    expect(uinText).toMatch(/^\d+$/);
    const uin = Number(uinText);
    expect(uin).toBeGreaterThanOrEqual(0);
    expect(uin).toBeLessThanOrEqual(4_294_967_295);

    // payload 形状（材料 wechat_api.rs:239-275）
    const payload = JSON.parse(req.rawBody) as {
      msg: Record<string, unknown>;
      base_info: Record<string, unknown>;
    };
    expect(payload.msg.to_user_id).toBe("user-001");
    expect(payload.msg.client_id).toBe(outcome.clientId);
    expect(payload.msg.message_type).toBe(2);
    expect(payload.msg.message_state).toBe(2);
    expect(payload.msg.context_token).toBe(CONTEXT_TOKEN);
    expect(payload.msg.item_list).toEqual([{ type: 1, text_item: { text: "您关注的演出已开售" } }]);
    expect(payload.base_info).toEqual({
      channel_version: CLAWBOT_DEFAULT_CHANNEL_VERSION,
      bot_agent: "damai-mcp-ts/notify",
    });

    // 客户端只组协议：transport 收到的是名义 origin 与配置的超时
    const call = transportCalls[transportCalls.length - 1];
    expect(call.origin).toBe(NOMINAL_ORIGIN);
    expect(call.path).toBe(CLAWBOT_SENDMESSAGE_PATH);
    expect(call.timeoutMs).toBe(5_000);
  });

  it("显式 clientId 原样透传到 body 与结果（幂等键复用通道）", async () => {
    const outcome = await makeClient().sendText("user-002", CONTEXT_TOKEN, "重发用例", {
      clientId: "manual-retry-client-id-0001",
    });
    expect(outcome.status).toBe("sent");
    expect(outcome.clientId).toBe("manual-retry-client-id-0001");
    const payload = JSON.parse(requests[0].rawBody) as { msg: { client_id: string } };
    expect(payload.msg.client_id).toBe("manual-retry-client-id-0001");
  });
});

// ---- ③ 响应守卫矩阵 -------------------------------------------------------

describe("响应守卫（材料 wechat_api.rs:282-357 的中文映射）", () => {
  it.each([
    {
      label: "ret=-14 → expired",
      status: 200,
      body: '{"ret":-14}',
      expected: "expired" as SendStatus,
      fragment: "重新绑定通知机器人",
    },
    {
      label: "errcode=-14 → expired",
      status: 200,
      body: '{"errcode":-14}',
      expected: "expired" as SendStatus,
      fragment: "重新绑定通知机器人",
    },
    {
      label: "ret=7 → failed",
      status: 200,
      body: '{"ret":7}',
      expected: "failed" as SendStatus,
      fragment: "发送失败（ret=7）",
    },
    {
      label: "HTTP 401 → expired",
      status: 401,
      body: "",
      expected: "expired" as SendStatus,
      fragment: "重新绑定通知机器人",
    },
    {
      label: "HTTP 403 → 请求受限",
      status: 403,
      body: "",
      expected: "failed" as SendStatus,
      fragment: "请求受限",
    },
    {
      label: "HTTP 429 → 请求受限",
      status: 429,
      body: "",
      expected: "failed" as SendStatus,
      fragment: "请求受限",
    },
    {
      label: "HTTP 500 → 服务器返回 HTTP n",
      status: 500,
      body: "",
      expected: "failed" as SendStatus,
      fragment: "服务器返回 HTTP 500",
    },
  ])("$label", async ({ status, body, expected, fragment }) => {
    script = () => ({ status, body });
    const outcome = await makeClient().sendText("user-guard", CONTEXT_TOKEN, "守卫用例");
    expect(outcome.status).toBe(expected);
    expect(outcome.error).toContain(fragment);
    expect(outcome.httpStatus).toBe(status);
    expect(outcome.clientId).toMatch(/^damai-mcp-ts-/);
  });
});

// ---- ④ 非 JSON / 响应体上限 ----------------------------------------------

describe("响应体解析与上限", () => {
  it("200 但 body 非 JSON → failed「服务器返回了非 JSON 数据」", async () => {
    script = () => ({ status: 200, body: "<html>bad gateway</html>" });
    const outcome = await makeClient().sendText("user-json", CONTEXT_TOKEN, "非 JSON 用例");
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("非 JSON");
    expect(outcome.httpStatus).toBe(200);
  });

  it("200 但响应体超 1MiB → failed「响应体超过上限」（默认传输层强制）", async () => {
    // 默认 fetch 传输（映射到本地服务器）：1MiB 上限实现在 createFetchTransport 内
    script = () => ({ status: 200, body: "a".repeat(1_048_577) });
    const outcome = await makeClient().sendText("user-big", CONTEXT_TOKEN, "超限用例");
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("超过上限");
    expect(outcome.httpStatus).toBeNull(); // 传输层抛错，未产生完整响应
  });
});

// ---- ⑤ 超时＝送达未知、零重试 --------------------------------------------

it("服务器挂住 + timeoutMs=100 → timeout_unknown，error 含幂等语义，且恰好收到 1 次请求", async () => {
  // 默认 fetch 传输（映射到本地服务器）：超时语义实现在 AbortSignal.timeout
  script = () => ({ status: 200, hang: true });
  const client = new ClawBotClient({ origin: NOMINAL_ORIGIN, token: TOKEN, timeoutMs: 100 }, localTransport);
  const outcome = await client.sendText("user-timeout", CONTEXT_TOKEN, "超时用例");

  expect(outcome.status).toBe("timeout_unknown");
  expect(outcome.error).toContain("送达状态未知");
  expect(outcome.error).toContain("不会自动重发");
  expect(outcome.error).toContain("client_id");
  expect(outcome.httpStatus).toBeNull();
  expect(outcome.elapsedMs).toBeGreaterThanOrEqual(50);
  // 零重试断言：客户端内部不自动重发，服务器恰好收到 1 次请求
  expect(requests).toHaveLength(1);
}, 5_000);

// ---- ⑥ origin 校验矩阵 ----------------------------------------------------

describe("origin 强校验（构造即执行，不发任何请求）", () => {
  it("http/端口/路径/query/fragment/凭据/非法 URL 均抛中文错", () => {
    const badOrigins: ReadonlyArray<readonly [string, RegExp]> = [
      ["http://bot.ilinkai.weixin.qq.com", /https/],
      ["https://bot.ilinkai.weixin.qq.com:8443", /端口/],
      ["https://bot.ilinkai.weixin.qq.com/api", /路径/],
      ["https://bot.ilinkai.weixin.qq.com/?x=1", /query/],
      ["https://bot.ilinkai.weixin.qq.com/#frag", /fragment/],
      ["https://user:pass@bot.ilinkai.weixin.qq.com", /凭据|用户名/],
      ["not-a-valid-url", /URL/],
    ];
    for (const [origin, pattern] of badOrigins) {
      expect(() => new ClawBotClient({ origin, token: TOKEN }, localTransport), origin).toThrow(pattern);
    }
    expect(requests).toHaveLength(0);
  });

  it("非 *.ilinkai.weixin.qq.com 的 host（含连字符/前后缀拼接的近似域）被拒绝", () => {
    for (const origin of [
      "https://evil.example.com",
      "https://evil-ilinkai.weixin.qq.com",
      "https://notilinkai.weixin.qq.com",
      "https://ilinkai.weixin.qq.com.evil.com",
    ]) {
      expect(() => new ClawBotClient({ origin, token: TOKEN }, localTransport), origin).toThrow(
        /ilinkai\.weixin\.qq\.com/,
      );
    }
  });

  it("合法 origin（裸域/子域/多级子域）可正常构造", () => {
    expect(
      () => new ClawBotClient({ origin: "https://ilinkai.weixin.qq.com", token: TOKEN }, localTransport),
    ).not.toThrow();
    expect(
      () => new ClawBotClient({ origin: "https://bot.ilinkai.weixin.qq.com", token: TOKEN }, localTransport),
    ).not.toThrow();
    expect(
      () => new ClawBotClient({ origin: "https://a.b.ilinkai.weixin.qq.com", token: TOKEN }, localTransport),
    ).not.toThrow();
  });
});

// ---- ⑦ 参数前置校验 -------------------------------------------------------

describe("参数前置校验（transport 计数不变）", () => {
  it("空 target / 空 context_token / 超长 context_token / 空 text / 超长 text 均抛中文错且 0 请求", async () => {
    const client = makeClient();
    await expect(client.sendText("", CONTEXT_TOKEN, "hi")).rejects.toThrow(/target 不能为空/);
    await expect(client.sendText("u", "", "hi")).rejects.toThrow(/context_token 不能为空/);
    await expect(client.sendText("u", "c".repeat(16_385), "hi")).rejects.toThrow(
      /context_token 长度超过上限/,
    );
    await expect(client.sendText("u", CONTEXT_TOKEN, "")).rejects.toThrow(/text 不能为空/);
    await expect(client.sendText("u", CONTEXT_TOKEN, "x".repeat(4_097))).rejects.toThrow(
      /text 长度超过上限/,
    );
    // 校验失败绝不发请求
    expect(requests).toHaveLength(0);
  });

  it("恰好达限的 context_token(16384) 与 text(4096) 通过", async () => {
    const outcome = await makeClient().sendText("user-edge", "c".repeat(16_384), "x".repeat(4_096));
    expect(outcome.status).toBe("sent");
    expect(requests).toHaveLength(1);
    const payload = JSON.parse(requests[0].rawBody) as { msg: { context_token: string } };
    expect(payload.msg.context_token).toHaveLength(16_384);
  });
});

// ---- ⑧ 并发串行化 ---------------------------------------------------------

it("并发 sendText 被 promise 锁串行化：请求次序与调用次序一致，且第二条在第一条响应后到达", async () => {
  // 30ms 响应延迟：未加锁时第二条请求会在第一条挂起期内到达
  script = () => ({ status: 200, body: '{"ret":0}', delayMs: 30 });
  const client = makeClient();
  const p1 = client.sendText("user-1", CONTEXT_TOKEN, "msg-first");
  const p2 = client.sendText("user-2", CONTEXT_TOKEN, "msg-second");
  const [o1, o2] = await Promise.all([p1, p2]);

  expect(o1.status).toBe("sent");
  expect(o2.status).toBe("sent");
  expect(o1.clientId).not.toBe(o2.clientId); // 每次调用生成独立幂等键
  expect(requests).toHaveLength(2);

  const msgOf = (index: number): { to_user_id: string; client_id: string } => {
    const parsed = JSON.parse(requests[index].rawBody) as {
      msg: { to_user_id: string; client_id: string };
    };
    return parsed.msg;
  };
  // 次序：user-1 先、user-2 后
  expect(msgOf(0).to_user_id).toBe("user-1");
  expect(msgOf(1).to_user_id).toBe("user-2");
  expect(msgOf(0).client_id).toBe(o1.clientId);
  expect(msgOf(1).client_id).toBe(o2.clientId);
  // 严格串行：第二条请求在第 1 条响应完成之后才到达
  expect(requests[1].receivedAt).toBeGreaterThanOrEqual(requests[0].respondedAt);
});

// ---- ⑨ 不出网守护 ---------------------------------------------------------

it("不出网守护：transport 收到的 origin 恒为名义合法值，流量仅落本地服务器", async () => {
  await makeClient().sendText("user-final", CONTEXT_TOKEN, "不出网守护");
  expect(transportCalls.length).toBeGreaterThan(0);
  for (const call of transportCalls) {
    // 客户端只组协议：origin 始终是名义合法值，真实走向全部由 transport 映射到 127.0.0.1
    expect(call.origin).toBe(NOMINAL_ORIGIN);
    expect(call.path).toBe(CLAWBOT_SENDMESSAGE_PATH);
    expect(call.method).toBe("POST");
  }
  for (const req of requests) {
    expect(req.path).toBe(CLAWBOT_SENDMESSAGE_PATH);
  }
});
