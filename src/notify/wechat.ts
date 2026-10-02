/**
 * 微信 ClawBot `sendmessage` 协议客户端（纯 HTTP、传输可注入、发送幂等）。
 *
 * 范围（docs/improvements-from-competitors.md §6）：
 *   - 只实现「发送文本通知」一个端点；扫码绑定与接收长轮询明确不在范围内
 *     （依赖任务管理器与 UI 会话）。
 *   - 客户端只负责组装协议（路径/头部/载荷/响应守卫）；URL 的真实走向由注入的
 *     transport 决定——origin 校验与测试走向解耦，测试可把请求映射到本地
 *     node:http 服务器，不接任何真实服务。
 *   - 发送幂等（核心语义）：每次 sendText 至多发出一次 HTTP 请求，内部零自动
 *     重试；超时＝「送达状态未知」，客户端不重发，重发决策权在调用方——协议
 *     幂等键 client_id 随 {@link SendOutcome.clientId} 回显。
 *
 * 设计取舍：
 *   - 自包含：仅依赖 node:crypto 与全局 fetch，不 import 仓库内任何模块，
 *     避免反向依赖 MCP SDK。
 *   - 默认传输 {@link createFetchTransport} 用 AbortSignal.timeout 承载超时，
 *     并对响应体强制 1 MiB 上限（声明 Content-Length 与实际流式字节都拦）。
 *   - 错误文案一律中文，且不含服务端响应 body 原文。
 */

import { randomBytes, randomUUID } from "node:crypto";

// ------ 常量 ---------------------------------------------------------------

/** 默认传输的响应体上限：1 MiB。 */
export const CLAWBOT_MAX_BODY_BYTES = 1_048_576;

/** 缺省请求超时（毫秒）。 */
export const CLAWBOT_DEFAULT_TIMEOUT_MS = 10_000;

/**
 * 文本长度缺省上限。
 *
 * deviation：上游的精确上限未见于分析材料，这里取保守值 4096 并允许通过
 * {@link ClawBotConfig.maxTextLength} 配置；接入真实服务前需实测校准。
 */
export const CLAWBOT_DEFAULT_MAX_TEXT_LENGTH = 4_096;

/** context_token 长度上限（材料 notifications.rs:308-353）。 */
export const CLAWBOT_CONTEXT_TOKEN_MAX_LENGTH = 16_384;

/** sendmessage 端点路径（材料 wechat_api.rs:8-10）。 */
export const CLAWBOT_SENDMESSAGE_PATH = "/ilink/bot/sendmessage";

/** base_info.channel_version（材料 wechat_api.rs:278-280）。 */
export const CLAWBOT_DEFAULT_CHANNEL_VERSION = "2.4.8";

/** iLink-App-ClientVersion 请求头（材料 wechat_api.rs:9-10）。 */
export const CLAWBOT_APP_CLIENT_VERSION = "132104";

/** bot_agent 前缀；实际取 `${CLAWBOT_USER_AGENT_BASE}/notify`。 */
export const CLAWBOT_USER_AGENT_BASE = "damai-mcp-ts";

/** 允许的 ClawBot host（精确值或以其为后缀的子域；材料 wechat_api.rs:63-85）。 */
const CLAWBOT_ALLOWED_HOST = "ilinkai.weixin.qq.com";

/** 协议幂等键 client_id 的前缀（材料 wechat_api.rs:265）。 */
const CLIENT_ID_PREFIX = `${CLAWBOT_USER_AGENT_BASE}-`;

/** 登录过期的固定文案（ret/errcode === -14 与 HTTP 401 共用）。 */
const EXPIRED_MESSAGE = "登录状态已过期，请重新绑定通知机器人";

/**
 * 超时的固定文案——本模块的核心幂等语义，逐字保持稳定便于上层识别：
 * 请求可能已被服务端受理，客户端不自动重发；重发决策权在调用方。
 */
const TIMEOUT_UNKNOWN_MESSAGE =
  "发送超时，送达状态未知，为避免重复提醒不会自动重发；" +
  "如确需重试，请携带返回的 client_id 由服务端幂等去重后再人工决策";

// ------ 传输层 -------------------------------------------------------------

/** 传输层请求：客户端只组协议，URL 的真实走向由 transport 决定。 */
export interface ClawBotRequest {
  /** 配置里的合法 origin（未与 path 拼接；仅协议语义，不保证真实可达）。 */
  origin: string;
  /** 端点路径，形如 "/ilink/bot/sendmessage"。 */
  path: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  /** JSON 文本；GET 为 null。 */
  body: string | null;
  timeoutMs: number;
}

/** 传输层响应（body 已读为文本；超限/超时由 transport 直接抛错）。 */
export interface ClawBotResponse {
  status: number;
  bodyText: string;
}

/**
 * 传输层抽象：把协议请求送到某处并带回响应。
 *
 * 注入 transport 时的契约：
 *   - 超时由 transport 自身负责；超时 reject 的 Error 名应为 `TimeoutError` 或
 *     `AbortError`（客户端据此归类 timeout_unknown）。
 *   - 响应体超限应抛 {@link ClawBotBodyTooLargeError}（客户端映射「响应体超过
 *     上限」）。
 *   - 其他异常一律归类「发送失败（网络错误）」。
 */
export type ClawBotTransport = (req: ClawBotRequest) => Promise<ClawBotResponse>;

/** 默认传输在响应体超过上限时抛出的错误。 */
export class ClawBotBodyTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClawBotBodyTooLargeError";
    // 兼容经过转译/继承链重建 prototype 的运行环境
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * 默认传输：全局 fetch + AbortSignal.timeout + 响应体上限。
 *
 * @param options.maxBodyBytes 响应体上限（字节），默认 {@link CLAWBOT_MAX_BODY_BYTES}。
 *   声明的 Content-Length 超限立即中断；实际流式字节超限在读取中途抛
 *   {@link ClawBotBodyTooLargeError}——两种谎报都被拦住。
 */
export function createFetchTransport(options?: { maxBodyBytes?: number }): ClawBotTransport {
  const maxBodyBytes = options?.maxBodyBytes ?? CLAWBOT_MAX_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new Error("maxBodyBytes 必须为正整数");
  }
  return async (req) => {
    const response = await fetch(joinUrl(req.origin, req.path), {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(req.timeoutMs),
    });
    const declared = response.headers.get("content-length");
    if (declared !== null && Number.isInteger(Number(declared)) && Number(declared) > maxBodyBytes) {
      try {
        await response.body?.cancel();
      } catch {
        // 释放连接失败不影响错误分类
      }
      throw new ClawBotBodyTooLargeError(
        `响应体超过上限（声明 Content-Length=${declared} > ${maxBodyBytes} 字节）`,
      );
    }
    const bodyText = await readBodyCapped(response, maxBodyBytes);
    return { status: response.status, bodyText };
  };
}

/** 拼接 origin 与 path（容忍 origin 尾部多余的 "/"）。 */
function joinUrl(origin: string, path: string): string {
  const base = origin.endsWith("/") ? origin.slice(0, -1) : origin;
  return `${base}${path}`;
}

/** 流式读取响应体并强制字节上限；超限抛 {@link ClawBotBodyTooLargeError}。 */
async function readBodyCapped(response: Response, maxBodyBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || value === undefined) {
        break;
      }
      total += value.byteLength;
      if (total > maxBodyBytes) {
        throw new ClawBotBodyTooLargeError(`响应体超过上限（> ${maxBodyBytes} 字节）`);
      }
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 读取已结束或流已关闭，忽略
    }
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// ------ 客户端 -------------------------------------------------------------

/** {@link ClawBotClient} 的配置。 */
export interface ClawBotConfig {
  /**
   * 服务 origin：https 且 host ∈ *.ilinkai.weixin.qq.com，
   * 无端口/路径/query/fragment/凭据（构造时强校验，违规抛中文错）。
   */
  origin: string;
  /** Bearer 令牌（Authorization: Bearer <token>）。 */
  token: string;
  /** 单次请求超时（毫秒），默认 {@link CLAWBOT_DEFAULT_TIMEOUT_MS}。 */
  timeoutMs?: number;
  /** 文本长度上限，默认 {@link CLAWBOT_DEFAULT_MAX_TEXT_LENGTH}。 */
  maxTextLength?: number;
}

export type SendStatus = "sent" | "failed" | "expired" | "timeout_unknown";

/** 单次发送的结果。 */
export interface SendOutcome {
  status: SendStatus;
  /** 协议幂等键（服务端按它去重），恒回显。 */
  clientId: string;
  /** 中文错误说明；sent 时为 null，一律不含服务端响应 body 原文。 */
  error: string | null;
  /** HTTP 状态码；传输层未产生完整响应（超时/网络错误/超限）时为 null。 */
  httpStatus: number | null;
  elapsedMs: number;
}

export class ClawBotClient {
  private readonly origin: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxTextLength: number;
  private readonly transport: ClawBotTransport;

  /** 实例内 promise 锁：串行化并发 sendText，保证请求次序与调用次序一致（材料 notifications.rs:141）。 */
  private sendLock: Promise<void> = Promise.resolve();

  /**
   * @param config 客户端配置；origin 在构造时强校验。
   * @param transport 传输层；缺省 {@link createFetchTransport}（显式构造后才会出网）。
   * @throws 中文 Error：origin 不合法、token 为空或超时/长度参数非法。
   */
  constructor(config: ClawBotConfig, transport: ClawBotTransport = createFetchTransport()) {
    this.origin = validateOrigin(config.origin);
    if (typeof config.token !== "string" || config.token.length === 0) {
      throw new Error("ClawBot token 不能为空");
    }
    this.token = config.token;
    this.timeoutMs = config.timeoutMs ?? CLAWBOT_DEFAULT_TIMEOUT_MS;
    this.maxTextLength = config.maxTextLength ?? CLAWBOT_DEFAULT_MAX_TEXT_LENGTH;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("ClawBot timeoutMs 必须为正数");
    }
    if (!Number.isInteger(this.maxTextLength) || this.maxTextLength <= 0) {
      throw new Error("ClawBot maxTextLength 必须为正整数");
    }
    this.transport = transport;
  }

  /**
   * 发送一条文本通知。
   *
   * 幂等语义（核心）：本次调用至多发出一次 HTTP 请求，内部零自动重试；
   * 超时返回 timeout_unknown（请求可能已送达），绝不自动重发——如需人工重试，
   * 携带返回的 client_id 再次调用（服务端按 client_id 幂等去重）。
   *
   * @param options.clientId 显式指定幂等键（重发复用通道时传入）；缺省生成
   *   `damai-mcp-ts-<uuid4>`。
   * @throws 中文 Error：参数校验失败（此时不发任何请求，transport 计数不变）。
   */
  async sendText(
    target: string,
    contextToken: string,
    text: string,
    options?: { clientId?: string },
  ): Promise<SendOutcome> {
    // 参数前置校验：失败时绝不发起请求
    if (typeof target !== "string" || target.length === 0) {
      throw new Error("target 不能为空");
    }
    if (typeof contextToken !== "string" || contextToken.length === 0) {
      throw new Error("context_token 不能为空");
    }
    if (contextToken.length > CLAWBOT_CONTEXT_TOKEN_MAX_LENGTH) {
      throw new Error(
        `context_token 长度超过上限（${contextToken.length} > ${CLAWBOT_CONTEXT_TOKEN_MAX_LENGTH}）`,
      );
    }
    if (typeof text !== "string" || text.length === 0) {
      throw new Error("text 不能为空");
    }
    if (text.length > this.maxTextLength) {
      throw new Error(`text 长度超过上限（${text.length} > ${this.maxTextLength}）`);
    }
    if (options?.clientId !== undefined && options.clientId.length === 0) {
      throw new Error("clientId 不能为空");
    }
    const clientId = options?.clientId ?? newClientId();

    // promise 锁串行化并发发送：先排队占位，等前一次发送结束后才执行
    const previous = this.sendLock;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.sendLock = current;
    await previous;
    try {
      return await this.sendOnce(target, contextToken, text, clientId);
    } finally {
      release();
    }
  }

  /** 单次发送：恰好一次 HTTP 请求 + 响应守卫。 */
  private async sendOnce(
    target: string,
    contextToken: string,
    text: string,
    clientId: string,
  ): Promise<SendOutcome> {
    const startedAt = Date.now();
    // 六个协议头照抄（材料 wechat_api.rs:134-159）
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "iLink-App-Id": "bot",
      "iLink-App-ClientVersion": CLAWBOT_APP_CLIENT_VERSION,
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": buildUinHeader(),
      Authorization: `Bearer ${this.token}`,
    };
    // 载荷照抄（材料 wechat_api.rs:239-275）
    const body = JSON.stringify({
      msg: {
        to_user_id: target,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      },
      base_info: {
        channel_version: CLAWBOT_DEFAULT_CHANNEL_VERSION,
        bot_agent: `${CLAWBOT_USER_AGENT_BASE}/notify`,
      },
    });

    let response: ClawBotResponse;
    try {
      response = await this.transport({
        origin: this.origin,
        path: CLAWBOT_SENDMESSAGE_PATH,
        method: "POST",
        headers,
        body,
        timeoutMs: this.timeoutMs,
      });
    } catch (exc) {
      return classifyTransportFailure(exc, clientId, startedAt);
    }
    return classifyResponse(response, clientId, startedAt);
  }
}

// ------ 内部辅助 -----------------------------------------------------------

/** 新的协议幂等键：`damai-mcp-ts-<uuid4>`（材料 wechat_api.rs:265）。 */
function newClientId(): string {
  return `${CLIENT_ID_PREFIX}${randomUUID()}`;
}

/** X-WECHAT-UIN：随机 u32 的十进制 ASCII 串再做 base64（材料 wechat_api.rs:134-159）。 */
function buildUinHeader(): string {
  const uin = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uin), "ascii").toString("base64");
}

/**
 * origin 强校验（材料 wechat_api.rs:63-85）：能被 `new URL` 解析、协议 https、
 * 无 username/password、无显式端口、pathname 为 "/" 或空、无 search/hash、
 * host 属于 *.ilinkai.weixin.qq.com。合法时原样返回。
 */
function validateOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`ClawBot origin 不是合法的 URL: ${origin}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`ClawBot origin 必须使用 https 协议，收到: ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("ClawBot origin 不能包含用户名或密码（凭据）");
  }
  if (url.port !== "") {
    throw new Error(`ClawBot origin 不能包含显式端口: ${url.port}`);
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error(`ClawBot origin 不能包含路径: ${url.pathname}`);
  }
  if (url.search !== "") {
    throw new Error(`ClawBot origin 不能包含 query: ${url.search}`);
  }
  if (url.hash !== "") {
    throw new Error(`ClawBot origin 不能包含 fragment: ${url.hash}`);
  }
  const host = url.hostname;
  if (host !== CLAWBOT_ALLOWED_HOST && !host.endsWith(`.${CLAWBOT_ALLOWED_HOST}`)) {
    throw new Error(`ClawBot origin 的 host 必须属于 *.${CLAWBOT_ALLOWED_HOST}，收到: ${host}`);
  }
  return origin;
}

/** 取 2xx JSON 响应中的业务码：优先 ret，其次 errcode；两者皆缺时返回 undefined。 */
function extractResultCode(parsed: unknown): unknown {
  if (parsed === null || typeof parsed !== "object") {
    return undefined;
  }
  const obj = parsed as Record<string, unknown>;
  if ("ret" in obj) {
    return obj.ret;
  }
  if ("errcode" in obj) {
    return obj.errcode;
  }
  return undefined;
}

function makeOutcome(
  clientId: string,
  startedAt: number,
  status: SendStatus,
  error: string | null,
  httpStatus: number | null,
): SendOutcome {
  return { status, clientId, error, httpStatus, elapsedMs: Date.now() - startedAt };
}

/**
 * 响应守卫（材料 wechat_api.rs:282-357）：2xx+ret==0 → sent；ret/errcode==-14
 * 或 HTTP 401 → expired；403/429 → 请求受限；其余非 2xx → 服务器返回 HTTP n；
 * 非 JSON → 非 JSON 数据。文案全中文且不含服务端 body 原文。
 */
function classifyResponse(
  response: ClawBotResponse,
  clientId: string,
  startedAt: number,
): SendOutcome {
  const httpStatus = response.status;
  if (typeof httpStatus !== "number" || !Number.isInteger(httpStatus)) {
    // 传输层契约被破坏：按传输异常归类
    return makeOutcome(clientId, startedAt, "failed", "发送失败（网络错误）: 传输层返回了无效响应", null);
  }
  if (httpStatus >= 200 && httpStatus < 300) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.bodyText);
    } catch {
      return makeOutcome(clientId, startedAt, "failed", "服务器返回了非 JSON 数据", httpStatus);
    }
    const raw = extractResultCode(parsed);
    if (raw === undefined) {
      return makeOutcome(clientId, startedAt, "failed", "发送失败（响应缺少 ret/errcode 字段）", httpStatus);
    }
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return makeOutcome(clientId, startedAt, "failed", "发送失败（ret 字段类型异常）", httpStatus);
    }
    if (raw === 0) {
      return makeOutcome(clientId, startedAt, "sent", null, httpStatus);
    }
    if (raw === -14) {
      return makeOutcome(clientId, startedAt, "expired", EXPIRED_MESSAGE, httpStatus);
    }
    return makeOutcome(clientId, startedAt, "failed", `发送失败（ret=${raw}）`, httpStatus);
  }
  if (httpStatus === 401) {
    return makeOutcome(clientId, startedAt, "expired", EXPIRED_MESSAGE, httpStatus);
  }
  if (httpStatus === 403 || httpStatus === 429) {
    return makeOutcome(clientId, startedAt, "failed", "请求受限，请稍后重试", httpStatus);
  }
  return makeOutcome(clientId, startedAt, "failed", `服务器返回 HTTP ${httpStatus}`, httpStatus);
}

/**
 * 传输层异常分类：超时（TimeoutError/AbortError）→ timeout_unknown（送达状态
 * 未知，不自动重发）；响应体超限 → 「响应体超过上限」；其余 → 「发送失败
 * （网络错误）」。
 */
function classifyTransportFailure(exc: unknown, clientId: string, startedAt: number): SendOutcome {
  const name = typeof exc === "object" && exc !== null ? (exc as { name?: unknown }).name : undefined;
  if (name === "TimeoutError" || name === "AbortError") {
    return makeOutcome(clientId, startedAt, "timeout_unknown", TIMEOUT_UNKNOWN_MESSAGE, null);
  }
  if (exc instanceof ClawBotBodyTooLargeError || name === "ClawBotBodyTooLargeError") {
    return makeOutcome(clientId, startedAt, "failed", "响应体超过上限", null);
  }
  const reason = exc instanceof Error ? exc.message : String(exc);
  return makeOutcome(clientId, startedAt, "failed", `发送失败（网络错误）: ${reason}`, null);
}
