/**
 * 从分享文案、链接或 dumpsys Intent 里抽出大麦 item id。
 *
 * 纯函数，不访问设备、不发网络请求。短链跟随见 {@link resolveDamaiItemId}。
 */

/** 上下文里的编号：至少 6 位，避免把年份、端口当成 item id。 */
const ID_BODY = "(\\d{6,20})";

/** 按优先级排列。先命中的模式赢，同一模式取文本中第一次出现。 */
const CONTEXT_PATTERNS: readonly RegExp[] = [
  new RegExp(`(?:itemId|item_id|projectId|project_id)\\s*[=:]\\s*["']?${ID_BODY}`, "i"),
  new RegExp(`damai://item/${ID_BODY}`, "i"),
  new RegExp(`damai://item\\?(?:[^\\s#]*&)?id=${ID_BODY}`, "i"),
  new RegExp(
    `https?://(?:[a-z0-9-]+\\.)*damai\\.cn[^\\s"'<>]*?[?&#]id=${ID_BODY}`,
    "i",
  ),
];

const HTTP_URL = /https?:\/\/[^\s"'<>]+/gi;

const MAX_HOPS = 5;
const MAX_BODY_BYTES = 65_536;
const FETCH_TIMEOUT_MS = 5_000;

/** 可注入的 fetch，便于测试时不发出真实请求。 */
export type ItemFetch = typeof fetch;

/** 去掉分享文案里的零宽字符，并把百分号编码的 ASCII 还原（`%3D` → `=`）。 */
function normalizeShareText(text: string): string {
  const stripped = text.replace(/[\u200b\u200c\u200d\ufeff]/g, "");
  return stripped.replace(/%[0-9a-fA-F]{2}/g, (seq) => {
    try {
      return decodeURIComponent(seq);
    } catch {
      return seq;
    }
  });
}

function firstGroup(text: string, pattern: RegExp): string | null {
  const matched = pattern.exec(text);
  return matched?.[1] ?? null;
}

/**
 * 从一段文本抽出大麦 item id。
 *
 * 整段去掉空白后若恰好是 8–20 位数字，视为用户直接粘贴的编号。
 * 否则只认 `itemId` / `projectId` / `damai://item` / `*.damai.cn` 上的 `id`。
 * dumpsys 里的 pid、skuId 不会命中。
 */
export function extractDamaiItemId(text: string): string | null {
  const cleaned = text.replace(/[\u200b\u200c\u200d\ufeff]/g, "").trim();
  if (/^\d{8,20}$/.test(cleaned)) {
    return cleaned;
  }
  const decoded = normalizeShareText(cleaned);
  const sources = decoded === cleaned ? [cleaned] : [decoded, cleaned];
  for (const source of sources) {
    for (const pattern of CONTEXT_PATTERNS) {
      const id = firstGroup(source, pattern);
      if (id !== null) {
        return id;
      }
    }
  }
  return null;
}

/**
 * 只接受 `http(s)://*.damai.cn`。拒绝用户信息、其它主机和跳到内网的 Location。
 */
export function damaiUrl(raw: string, base?: string): URL | null {
  let url: URL;
  try {
    url = base === undefined ? new URL(raw) : new URL(raw, base);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "") {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host !== "damai.cn" && !host.endsWith(".damai.cn")) {
    return null;
  }
  return url;
}

function extractHttpUrls(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(HTTP_URL)) {
    const raw = match[0].replace(/[),，。；;]+$/, "");
    if (!found.includes(raw)) {
      found.push(raw);
    }
  }
  return found;
}

function isTextual(contentType: string): boolean {
  const value = contentType.toLowerCase();
  if (value === "") {
    return true;
  }
  return (
    value.includes("text/") ||
    value.includes("html") ||
    value.includes("json") ||
    value.includes("xml")
  );
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || value === undefined) {
      break;
    }
    const room = maxBytes - total;
    if (room <= 0) {
      await reader.cancel();
      break;
    }
    const slice = value.byteLength > room ? value.slice(0, room) : value;
    chunks.push(slice);
    total += slice.byteLength;
    if (value.byteLength > room) {
      await reader.cancel();
      break;
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

interface FollowedPage {
  finalUrl: string;
  body: string;
}

/** 在 damai.cn 内跟随重定向。离开该域即停止，不读取跳转目标。 */
async function followDamai(start: URL, fetchImpl: ItemFetch): Promise<FollowedPage | null> {
  let current = start;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    let response: Response;
    try {
      response = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: "text/html,application/xhtml+xml" },
      });
    } catch {
      return null;
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null) {
        return { finalUrl: current.href, body: "" };
      }
      const next = damaiUrl(location, current.href);
      if (next === null) {
        return { finalUrl: current.href, body: "" };
      }
      // 跳转地址里已经有编号就停，避免再打一跳。
      if (extractDamaiItemId(next.href) !== null) {
        return { finalUrl: next.href, body: "" };
      }
      current = next;
      continue;
    }
    const contentType = response.headers.get("content-type") ?? "";
    const body =
      response.status === 200 && isTextual(contentType)
        ? await readLimited(response, MAX_BODY_BYTES)
        : "";
    return { finalUrl: current.href, body };
  }
  return { finalUrl: current.href, body: "" };
}

/**
 * 先在文本里抽编号；抽不到再跟随文本中的 `*.damai.cn` 短链。
 * 非大麦域名不请求。
 */
export async function resolveDamaiItemId(
  text: string,
  fetchImpl: ItemFetch = fetch,
): Promise<string | null> {
  const direct = extractDamaiItemId(text);
  if (direct !== null) {
    return direct;
  }
  for (const raw of extractHttpUrls(text)) {
    const start = damaiUrl(raw);
    if (start === null) {
      continue;
    }
    const page = await followDamai(start, fetchImpl);
    if (page === null) {
      continue;
    }
    const fromUrl = extractDamaiItemId(page.finalUrl);
    if (fromUrl !== null) {
      return fromUrl;
    }
    const fromBody = extractDamaiItemId(page.body);
    if (fromBody !== null) {
      return fromBody;
    }
  }
  return null;
}
