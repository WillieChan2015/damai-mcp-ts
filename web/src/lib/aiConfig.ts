/**
 * AI provider 设置（OpenAI 兼容协议）动态配置读写（设计 §8.1，技术决策 7）。
 *
 * 来源优先级：任务库 `ai_settings` 表（{@link resolveTaskDbPath}，默认
 * `web/data/tasks.db`，与任务/观演人快捷项共用同一 SQLite 库）> 环境变量
 * `DAMAI_AI_BASE_URL` / `DAMAI_AI_API_KEY` / `DAMAI_AI_MODEL` > 未配置。
 * 库文件缺失 / 打开或读库失败 / 行非法 → 视为无库配置，回落 env（null 不抛，
 * 同 core `src/notify/credentials.ts:140` 语义）。
 *
 * 存储语义（对齐 lib/viewerPresets.ts 与 task/persistence.ts 先例）：
 *   - better-sqlite3 同步访问；单例行表 `ai_settings`（id=1）。读路径在库
 *     文件不存在时直接返回 null 不建库（保证纯只读调用零文件创建）；写路径
 *     mkdir + WAL + 建表，失败抛中文 Error（settings 路由转 500）；
 *   - 每次 load/save 短连接开关（viewerPresets.ts 同款），无长驻句柄，
 *     不与任务持久化争用连接生命周期；
 *   - 密钥卫生：保存落库后对 db / -wal / -shm 尽力 chmod 0600（共享库可能
 *     早于本功能以 0644 存在，收紧失败仅告警不阻断保存；win32 跳过——Node
 *     在 Windows 上伪造的 mode 无 POSIX 权限语义，检查无意义）；
 *   - 对外展示：apiKey 一律经 {@link redactToken} 掩码（core
 *     `src/notify/credentials.ts:204`），原文永不回传前端、不进日志。
 *
 * 遗留迁移：旧版本把设置存在 `<DAMAI_WEB_DATA_DIR ?? <cwd>/data>/ai-settings.json`
 * （0600 JSON 文件）。load/status 时若库中无配置且遗留文件三要素齐备 →
 * 先写入库，成功后删除遗留文件（密钥只留在库里）；写库失败则保留文件并
 * 本次直接沿用遗留配置（保持可用），下次 load 重试迁移。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";

import { redactToken } from "@core/notify/credentials";

import { resolveTaskDbPath } from "@/task/persistence";

/** AI provider 三要素（OpenAI 兼容协议的最小面）。 */
export interface AiSettings {
  /** OpenAI 兼容 API 的 Base URL（如 https://api.example.com/v1）。 */
  baseUrl: string;
  /** API Key（Bearer 令牌）；只落库与请求头使用，永不外传原文。 */
  apiKey: string;
  /** 模型名（provider 调用时的 modelId）。 */
  model: string;
}

/** 当前生效配置的来源。 */
export type AiSettingsSource = "db" | "env" | "none";

/** AI 设置状态快照（settings 路由 GET / 页面 RSC 的展示面，全部可安全回传）。 */
export interface AiSettingsStatus {
  /** 三要素齐备（db 或 env 任一来源）。 */
  configured: boolean;
  /** 命中来源。 */
  source: AiSettingsSource;
  /** Base URL（非敏感，明文展示）；未配置为 null。 */
  baseUrl: string | null;
  /** 模型名（非敏感，明文展示）；未配置为 null。 */
  model: string | null;
  /** apiKey 掩码（redactToken 形态）；原文永不出现。未配置为 null。 */
  maskedKey: string | null;
}

/** 任务库中的 AI 设置表（单例行，id 恒为 1）。 */
const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ai_settings (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  base_url TEXT NOT NULL,
  api_key  TEXT NOT NULL,
  model    TEXT NOT NULL
)`.trim();

/** 遗留 JSON 设置文件名（迁移专用）。 */
const LEGACY_FILE_NAME = "ai-settings.json";

/** 等价于 Python 的 str(exc)：Error 取 message，其余 String()。 */
function excToStr(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** 读取环境变量；未设置或空串一律视为未配置（对齐 notifyConfig.ts:44-47）。 */
function envOrUndefined(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

/** 打开任务库并确保 AI 设置表存在。调用方负责 close。 */
function openDb(): Database.Database {
  const dbPath = resolveTaskDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(CREATE_TABLE_SQL);
  return db;
}

/** 三要素对象是否齐备（非空字符串 ×3）；归一校验入口（兼容任意来源的松散对象）。 */
function isCompleteSettings(value: unknown): value is AiSettings {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const { baseUrl, apiKey, model } = value as Record<string, unknown>;
  return (
    typeof baseUrl === "string" &&
    baseUrl !== "" &&
    typeof apiKey === "string" &&
    apiKey !== "" &&
    typeof model === "string" &&
    model !== ""
  );
}

/**
 * 从任务库读三要素；库文件缺失 / 打开或读库失败 / 行非法 → null（不抛）。
 * 库文件不存在时不建库（读路径零文件创建，同 persistence.ts loadAll 语义）。
 */
function aiSettingsFromDb(): AiSettings | null {
  const dbPath = resolveTaskDbPath();
  if (!existsSync(dbPath)) {
    return null;
  }
  let db: Database.Database | null = null;
  try {
    db = openDb();
    const row = db
      .prepare("SELECT base_url, api_key, model FROM ai_settings WHERE id = 1")
      .get() as { base_url: unknown; api_key: unknown; model: unknown } | undefined;
    if (row === undefined) {
      return null;
    }
    // 列名 snake_case → 三要素 camelCase，再走统一校验
    const candidate = { baseUrl: row.base_url, apiKey: row.api_key, model: row.model };
    return isCompleteSettings(candidate) ? candidate : null;
  } catch (exc) {
    console.error(`读取 AI 设置（任务库 ${dbPath}）失败（按未配置处理）: ${excToStr(exc)}`);
    return null;
  } finally {
    db?.close();
  }
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

/** 遗留 JSON 设置文件路径（旧实现：DAMAI_WEB_DATA_DIR ?? <cwd>/data 目录下）。 */
function legacySettingsFilePath(): string {
  const dataDir = envOrUndefined("DAMAI_WEB_DATA_DIR") ?? join(process.cwd(), "data");
  return join(dataDir, LEGACY_FILE_NAME);
}

/** 解析遗留 JSON 文件；缺失 / 损坏 JSON / 字段缺失 → null（不抛、不动文件）。 */
function aiSettingsFromLegacyFile(): AiSettings | null {
  let text: string;
  try {
    text = readFileSync(legacySettingsFilePath(), "utf-8");
  } catch {
    return null; // 缺失（ENOENT）或不可读：视为无遗留配置
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null; // 损坏 JSON：视为无遗留配置
  }
  return isCompleteSettings(parsed) ? parsed : null;
}

/**
 * 遗留 JSON → 任务库一次性迁移：写库成功才删除遗留文件（密钥只留在库里）；
 * 写库失败保留文件并本次直接返回遗留三要素（AI 功能保持可用，下次 load
 * 重试迁移）；删除失败不致命（库已是权威来源，遗留文件由 .gitignore 兜底）。
 * 迁移未触发（文件缺失/损坏）返回 null。
 */
function migrateLegacyFileSettings(): AiSettings | null {
  const legacy = aiSettingsFromLegacyFile();
  if (legacy === null) {
    return null;
  }
  try {
    saveAiSettings(legacy);
  } catch (exc) {
    console.error(`AI 设置迁移落库失败（本次沿用 ${LEGACY_FILE_NAME}，下次重试）: ${excToStr(exc)}`);
    return legacy;
  }
  try {
    rmSync(legacySettingsFilePath(), { force: true });
  } catch (exc) {
    console.error(`删除遗留 AI 设置文件失败（不影响已落库配置）: ${excToStr(exc)}`);
  }
  return legacy;
}

/** 密钥已入库：把库文件（含 WAL 伴生文件）收紧到 0600；尽力而为不阻断保存。 */
function tightenDbPermissions(dbPath: string): void {
  if (process.platform === "win32") {
    return;
  }
  for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      if (existsSync(candidate)) {
        chmodSync(candidate, 0o600);
      }
    } catch (exc) {
      console.error(`AI 设置落库后收紧文件权限失败（${candidate}）: ${excToStr(exc)}`);
    }
  }
}

/**
 * 读取当前生效的 AI 设置：任务库 > 遗留迁移 > env > null（未配置）。
 *
 * 库缺失 / 损坏 / 行非法自动回落；env 不齐备 → null。
 * 本函数不抛异常——任何异常路径都归一为「该来源无配置」。
 */
export function loadAiSettings(): AiSettings | null {
  return aiSettingsFromDb() ?? migrateLegacyFileSettings() ?? aiSettingsFromEnv();
}

/**
 * 保存 AI 设置到任务库（WAL + 建表 + 单例行 UPSERT，落库后收紧文件权限 0600）。
 *
 * @param settings 三要素；调用方（settings 路由）负责先做 zod 校验。
 * @throws 中文 Error：打开/建表/写库任一步失败（上层路由转 500）。
 */
export function saveAiSettings(settings: AiSettings): void {
  const dbPath = resolveTaskDbPath();
  let db: Database.Database | null = null;
  try {
    db = openDb();
    db.prepare(
      `INSERT INTO ai_settings (id, base_url, api_key, model)
       VALUES (1, @baseUrl, @apiKey, @model)
       ON CONFLICT(id) DO UPDATE SET
         base_url = excluded.base_url,
         api_key  = excluded.api_key,
         model    = excluded.model`,
    ).run({ baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model });
  } catch (exc) {
    throw new Error(`保存 AI 设置失败: ${excToStr(exc)}`);
  } finally {
    db?.close();
  }
  tightenDbPermissions(dbPath);
}

/**
 * AI 设置状态快照（只含可安全回传前端的字段）。
 *
 * configured=false 时 baseUrl/model/maskedKey 均为 null；
 * 与 loadAiSettings 同一取值链（含遗留迁移触发）。
 */
export function getAiSettingsStatus(): AiSettingsStatus {
  // 先库（含迁移）后 env，与 loadAiSettings 同序：读两次轻量同步 I/O，
  // 换取 source 判定零重复逻辑
  const fromDb = aiSettingsFromDb() ?? migrateLegacyFileSettings();
  const fromEnv = aiSettingsFromEnv();
  const settings = fromDb ?? fromEnv;
  return {
    configured: settings !== null,
    source: fromDb !== null ? "db" : fromEnv !== null ? "env" : "none",
    baseUrl: settings?.baseUrl ?? null,
    model: settings?.model ?? null,
    maskedKey: settings === null ? null : redactToken(settings.apiKey),
  };
}
