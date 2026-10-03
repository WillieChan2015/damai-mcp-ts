/**
 * AI provider 设置（OpenAI 兼容协议）动态配置读写（设计 §8.1，技术决策 7）。
 *
 * 来源优先级：`web/data/ai-settings.json`（0600）> 环境变量
 * `DAMAI_AI_BASE_URL` / `DAMAI_AI_API_KEY` / `DAMAI_AI_MODEL` > 未配置。
 * 文件缺失 / 损坏 JSON / 字段缺失 → 视为无文件配置，回落 env（null 不抛，
 * 同 core `src/notify/credentials.ts:140` 语义）。
 *
 * 安全语义（对齐 core 凭证存储先例 credentials.ts:102-122）：
 *   - save：`mkdir -p`（新建目录按 0o700；已存在的共享 data 目录不改权限，
 *     避免影响 tasks.db 等同目录文件）→ `<file>.tmp.<pid>` 以 0o600 创建
 *     → 写入最小 JSON → `rename` 原子替换 → `chmod 0o600` 双保险；
 *   - load：任何异常路径都返回 null / 回落，绝不把半截配置交给上层；
 *     POSIX 上文件权限过宽（mode & 0o077 ≠ 0）时打告警并照常返回——
 *     权限问题是提醒项，不是拒绝服务的理由；win32 跳过该体检
 *     （Node 在 Windows 上伪造的 mode 恒为 0o666/0o444，检查无意义）；
 *   - 对外展示：apiKey 一律经 {@link redactToken} 掩码（core
 *     `src/notify/credentials.ts:204`），原文永不回传前端、不进日志。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { redactToken } from "@core/notify/credentials";

/** AI provider 三要素（OpenAI 兼容协议的最小面）。 */
export interface AiSettings {
  /** OpenAI 兼容 API 的 Base URL（如 https://api.example.com/v1）。 */
  baseUrl: string;
  /** API Key（Bearer 令牌）；只落盘与请求头使用，永不外传原文。 */
  apiKey: string;
  /** 模型名（provider 调用时的 modelId）。 */
  model: string;
}

/** 当前生效配置的来源。 */
export type AiSettingsSource = "file" | "env" | "none";

/** AI 设置状态快照（settings 路由 GET / 页面 RSC 的展示面，全部可安全回传）。 */
export interface AiSettingsStatus {
  /** 三要素齐备（file 或 env 任一来源）。 */
  configured: boolean;
  /** 命中来源。 */
  source: AiSettingsSource;
  /** Base URL（非敏感，明文展示）；未配置为 null。 */
  baseUrl: string | null;
  /** 模型名（非敏感，明文展示）；未配置为 null。 */
  model: string | null;
  /** apiKey 掩码（redactToken 形态）；原文永不出现。未配置为 null。 */
  maskedKey: string | null;
  /** 设置文件是否存在（与有效性无关——损坏文件也计 present，供引导提示）。 */
  filePresent: boolean;
}

/** 设置文件名（数据目录下）。 */
const AI_SETTINGS_FILE_NAME = "ai-settings.json";

/** 等价于 Python 的 str(exc)：Error 取 message，其余 String()。 */
function excToStr(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** 读取环境变量；未设置或空串一律视为未配置（对齐 notifyConfig.ts:44-47）。 */
function envOrUndefined(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * AI 设置文件路径：`DAMAI_WEB_DATA_DIR ?? <cwd>/data` 下的 ai-settings.json
 * （与 tasks.db 的 data 目录约定一致；cli 拓扑下 cwd=web/ ⇒ web/data/ai-settings.json）。
 */
export function aiSettingsFilePath(): string {
  const dataDir = envOrUndefined("DAMAI_WEB_DATA_DIR") ?? join(process.cwd(), "data");
  return join(dataDir, AI_SETTINGS_FILE_NAME);
}

/** 三要素 env 是否全部齐备；齐备时返回三要素，否则 null。 */
function aiSettingsFromEnv(): AiSettings | null {
  const baseUrl = envOrUndefined("DAMAI_AI_BASE_URL");
  const apiKey = envOrUndefined("DAMAI_AI_API_KEY");
  const model = envOrUndefined("DAMAI_AI_MODEL");
  if (baseUrl === undefined || apiKey === undefined || model === undefined) {
    return null;
  }
  return { baseUrl, apiKey, model };
}

/**
 * 从设置文件读三要素；文件缺失 / 损坏 JSON / 字段缺失（含空串）→ null（不抛）。
 * POSIX 上权限过宽打告警但不拒绝读取（同 credentials.ts:173-183 语义）。
 */
function aiSettingsFromFile(): AiSettings | null {
  const file = aiSettingsFilePath();
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return null; // 缺失（ENOENT）或不可读：视为无文件配置
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null; // 损坏 JSON：视为无文件配置
  }
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const { baseUrl, apiKey, model } = obj;
  if (
    typeof baseUrl !== "string" ||
    baseUrl === "" ||
    typeof apiKey !== "string" ||
    apiKey === "" ||
    typeof model !== "string" ||
    model === ""
  ) {
    return null;
  }
  checkFilePermissions(file);
  return { baseUrl, apiKey, model };
}

/** POSIX 下文件权限体检：过宽（mode & 0o077 ≠ 0）打告警但不拒绝读取；win32 跳过。 */
function checkFilePermissions(file: string): void {
  if (process.platform === "win32") {
    return;
  }
  try {
    if ((statSync(file).mode & 0o077) !== 0) {
      // 文案不含 apiKey；路径本身非敏感
      console.error(`AI 设置文件权限过宽（应为 0600）: ${file}`);
    }
  } catch {
    // 文件在读取与 stat 之间消失：跳过体检
  }
}

/**
 * 读取当前生效的 AI 设置：文件 > env > null（未配置）。
 *
 * 文件缺失 / 损坏 / 字段缺失自动回落 env；env 不齐备 → null。
 * 本函数不抛异常——任何异常路径都归一为「该来源无配置」。
 */
export function loadAiSettings(): AiSettings | null {
  return aiSettingsFromFile() ?? aiSettingsFromEnv();
}

/**
 * 保存 AI 设置到本地文件（目录新建按 0700 + 文件 0600 + 临时文件 rename 原子替换）。
 *
 * @param settings 三要素；调用方（settings 路由）负责先做 zod 校验。
 * @throws 中文 Error：任一文件系统步骤失败（临时文件会被尽力清理）。
 */
export async function saveAiSettings(settings: AiSettings): Promise<void> {
  const file = aiSettingsFilePath();
  const dir = dirname(file);
  const tmp = `${file}.tmp.${process.pid}`;
  const payload = {
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
  };
  try {
    // 新建目录按 0700（已存在的共享 data 目录不受影响——mkdir 不重设已有目录权限）
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // open(..., "w", 0o600)：0o600 不含 group/other 位，umask 去位后仍 ≤ 0o600
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(payload), "utf-8");
    } finally {
      await handle.close();
    }
    // 同目录 rename：原子替换，写一半崩溃时旧配置保持可用
    await rename(tmp, file);
    // 双保险：上一次崩溃可能残留宽权限 tmp，"w" 复用时不改已有权限
    await chmod(file, 0o600);
  } catch (exc) {
    try {
      await rm(tmp, { force: true });
    } catch {
      // 清理失败不影响原始错误
    }
    throw new Error(`保存 AI 设置失败: ${excToStr(exc)}`);
  }
}

/**
 * AI 设置状态快照（只含可安全回传前端的字段）。
 *
 * configured=false 时 baseUrl/model/maskedKey 均为 null；
 * filePresent 与配置有效性无关（损坏文件也计 present，供页面引导提示）。
 */
export function getAiSettingsStatus(): AiSettingsStatus {
  const file = aiSettingsFilePath();
  // 先文件后 env，与 loadAiSettings 同序：读两次轻量同步 I/O，换取 source 判定零重复逻辑
  const fromFile = aiSettingsFromFile();
  const fromEnv = aiSettingsFromEnv();
  const settings = fromFile ?? fromEnv;
  return {
    configured: settings !== null,
    source: fromFile !== null ? "file" : fromEnv !== null ? "env" : "none",
    baseUrl: settings?.baseUrl ?? null,
    model: settings?.model ?? null,
    maskedKey: settings === null ? null : redactToken(settings.apiKey),
    filePresent: existsSync(file),
  };
}
