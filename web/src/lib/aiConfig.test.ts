/**
 * aiConfig 测试（设计 §8.6①）：DAMAI_WEB_TASK_DB 注入空临时目录隔离本机
 * 任务库，DAMAI_WEB_DATA_DIR 同步钉到临时目录（防止迁移路径触到本机遗留
 * ai-settings.json），DAMAI_AI_* env 直灌。覆盖：db>env 优先级、库缺失/
 * 损坏/行非法回落 env、遗留 JSON 一次性迁移、0600 权限收紧（POSIX）、掩码形态。
 */
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { getAiSettingsStatus, loadAiSettings, saveAiSettings } from "./aiConfig";

/** 本机真实 env 的原值（afterAll 复位，避免污染同进程其他测试）。 */
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

/** 测试三要素（apiKey 长度 ≥ 8，可断言 redactToken 掩码形态）。 */
const DB_BASE_URL = "https://db.example.com/v1";
const DB_API_KEY = "db-key-abcdef";
const DB_MODEL = "db-model";
const ENV_BASE_URL = "https://env.example.com/v1";
const ENV_API_KEY = "env-key-123456";
const ENV_MODEL = "env-model";

/** 当前用例的临时数据目录（beforeEach 新建、afterEach 清理）。 */
let dataDir: string;

/** 当前用例的任务库路径（DAMAI_WEB_TASK_DB 注入值）。 */
function dbPath(): string {
  return join(dataDir, "tasks.db");
}

/** 遗留 JSON 设置文件路径（DAMAI_WEB_DATA_DIR 注入目录下）。 */
function legacyFile(): string {
  return join(dataDir, "ai-settings.json");
}

/** 清空五个 env（未配置用例）。 */
function clearEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

/** 直灌三要素 env（env 来源用例）。 */
function setAiEnv(): void {
  process.env.DAMAI_AI_BASE_URL = ENV_BASE_URL;
  process.env.DAMAI_AI_API_KEY = ENV_API_KEY;
  process.env.DAMAI_AI_MODEL = ENV_MODEL;
}

/** 写一份三要素齐备的遗留 JSON 设置文件（迁移用例）。 */
function writeLegacyFile(): void {
  writeFileSync(
    legacyFile(),
    JSON.stringify({ baseUrl: DB_BASE_URL, apiKey: DB_API_KEY, model: DB_MODEL }),
    "utf-8",
  );
}

/** POSIX-only 用例（win32 的 chmod 只有只读位语义，跳过，对齐 credentials.ts 平台注记）。 */
const itPosix = process.platform === "win32" ? it.skip : it;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "ai-config-test-"));
  clearEnv();
  process.env.DAMAI_WEB_TASK_DB = dbPath();
  // 迁移路径按旧实现读 DAMAI_WEB_DATA_DIR，钉到临时目录隔离本机真实遗留文件
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

describe("loadAiSettings 优先级", () => {
  it("① 任务库 > env：两者都在时取库内三要素，status.source=db", () => {
    saveAiSettings({ baseUrl: DB_BASE_URL, apiKey: DB_API_KEY, model: DB_MODEL });
    setAiEnv();

    expect(loadAiSettings()).toEqual({
      baseUrl: DB_BASE_URL,
      apiKey: DB_API_KEY,
      model: DB_MODEL,
    });
    const status = getAiSettingsStatus();
    expect(status.configured).toBe(true);
    expect(status.source).toBe("db");
    expect(status.baseUrl).toBe(DB_BASE_URL);
  });

  it("② 无库 → 回落 env（不抛），且读路径不创建库文件", () => {
    setAiEnv();

    expect(loadAiSettings()).toEqual({
      baseUrl: ENV_BASE_URL,
      apiKey: ENV_API_KEY,
      model: ENV_MODEL,
    });
    expect(getAiSettingsStatus().source).toBe("env");
    expect(existsSync(dbPath())).toBe(false);
  });

  it("②b 库文件损坏（非 SQLite）→ 回落 env（不抛）", () => {
    writeFileSync(dbPath(), "not a sqlite database", "utf-8");
    setAiEnv();

    expect(loadAiSettings()).toEqual({
      baseUrl: ENV_BASE_URL,
      apiKey: ENV_API_KEY,
      model: ENV_MODEL,
    });
    expect(getAiSettingsStatus().source).toBe("env");
  });

  it("②c 库内行非法（空串三要素）→ 视为无库配置，回落 env", () => {
    saveAiSettings({ baseUrl: DB_BASE_URL, apiKey: DB_API_KEY, model: DB_MODEL });
    const db = new Database(dbPath());
    db.prepare("UPDATE ai_settings SET base_url = '', api_key = '', model = '' WHERE id = 1").run();
    db.close();
    setAiEnv();

    expect(loadAiSettings()).toEqual({
      baseUrl: ENV_BASE_URL,
      apiKey: ENV_API_KEY,
      model: ENV_MODEL,
    });
    expect(getAiSettingsStatus().source).toBe("env");
  });

  it("③ 无库无 env → loadAiSettings=null，status configured=false / source=none / 全 null", () => {
    expect(loadAiSettings()).toBeNull();
    expect(getAiSettingsStatus()).toEqual({
      configured: false,
      source: "none",
      baseUrl: null,
      model: null,
      maskedKey: null,
    });
  });

  it("③b env 缺一项（无 MODEL）→ 视为未配置（provider 三要素缺一不可）", () => {
    process.env.DAMAI_AI_BASE_URL = ENV_BASE_URL;
    process.env.DAMAI_AI_API_KEY = ENV_API_KEY;

    expect(loadAiSettings()).toBeNull();
    expect(getAiSettingsStatus().configured).toBe(false);
  });
});

describe("saveAiSettings", () => {
  itPosix("④ 落库后库文件权限收紧为 0600（mode & 0o777 === 0o600）", () => {
    saveAiSettings({ baseUrl: ENV_BASE_URL, apiKey: ENV_API_KEY, model: ENV_MODEL });

    const mode = statSync(dbPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("④b 保存后 load 读回三要素（db 来源），status 掩码正确", () => {
    saveAiSettings({ baseUrl: ENV_BASE_URL, apiKey: ENV_API_KEY, model: ENV_MODEL });

    expect(loadAiSettings()).toEqual({
      baseUrl: ENV_BASE_URL,
      apiKey: ENV_API_KEY,
      model: ENV_MODEL,
    });
    const status = getAiSettingsStatus();
    expect(status.source).toBe("db");
    expect(status.configured).toBe(true);
  });

  it("④c 保存覆盖旧值（单例行 UPSERT 语义）", () => {
    saveAiSettings({ baseUrl: DB_BASE_URL, apiKey: DB_API_KEY, model: DB_MODEL });
    saveAiSettings({ baseUrl: ENV_BASE_URL, apiKey: ENV_API_KEY, model: ENV_MODEL });

    expect(loadAiSettings()?.baseUrl).toBe(ENV_BASE_URL);
  });

  it("④d 库目录不存在时自动创建", () => {
    const nested = join(dataDir, "deep", "data");
    process.env.DAMAI_WEB_TASK_DB = join(nested, "tasks.db");

    saveAiSettings({ baseUrl: ENV_BASE_URL, apiKey: ENV_API_KEY, model: ENV_MODEL });
    expect(loadAiSettings()?.model).toBe(ENV_MODEL);
  });
});

describe("遗留 JSON 迁移", () => {
  it("⑤ 库中无配置且遗留文件齐备 → 迁移落库并删除遗留文件，source=db", () => {
    writeLegacyFile();

    expect(loadAiSettings()).toEqual({
      baseUrl: DB_BASE_URL,
      apiKey: DB_API_KEY,
      model: DB_MODEL,
    });
    const status = getAiSettingsStatus();
    expect(status.source).toBe("db");
    expect(existsSync(legacyFile())).toBe(false);
    expect(existsSync(dbPath())).toBe(true);
  });

  it("⑤b 遗留文件损坏 JSON → 视为无遗留配置（回落 env），文件保留", () => {
    writeFileSync(legacyFile(), "{not valid json", "utf-8");
    setAiEnv();

    expect(loadAiSettings()).toEqual({
      baseUrl: ENV_BASE_URL,
      apiKey: ENV_API_KEY,
      model: ENV_MODEL,
    });
    expect(existsSync(legacyFile())).toBe(true);
  });

  it("⑤c 落库失败（库目录不可创建）→ 遗留文件保留、load 仍返回其三要素（不抛）", () => {
    writeLegacyFile();
    // 用普通文件占位目标目录：mkdirSync(recursive) 必失败，模拟写库不可用
    const blocker = join(dataDir, "blocker");
    writeFileSync(blocker, "", "utf-8");
    process.env.DAMAI_WEB_TASK_DB = join(blocker, "tasks.db");

    expect(loadAiSettings()).toEqual({
      baseUrl: DB_BASE_URL,
      apiKey: DB_API_KEY,
      model: DB_MODEL,
    });
    expect(existsSync(legacyFile())).toBe(true);
  });

  it("⑤d 库中已有配置时不迁移：遗留文件原样保留，取库内值", () => {
    saveAiSettings({ baseUrl: ENV_BASE_URL, apiKey: ENV_API_KEY, model: ENV_MODEL });
    writeLegacyFile();

    expect(loadAiSettings()).toEqual({
      baseUrl: ENV_BASE_URL,
      apiKey: ENV_API_KEY,
      model: ENV_MODEL,
    });
    expect(existsSync(legacyFile())).toBe(true);
  });
});

describe("掩码与秘密卫生", () => {
  it("⑥ maskedKey 为 redactToken 形态（前 2 后 2）且不等于原文", () => {
    setAiEnv();

    const status = getAiSettingsStatus();
    expect(status.maskedKey).toBe("en****56"); // env-key-123456：前 2 后 2
    expect(status.maskedKey).not.toBe(ENV_API_KEY);
  });

  it("⑥b 状态快照 JSON 序列化不含 apiKey 原文（db 来源同样成立）", () => {
    saveAiSettings({ baseUrl: DB_BASE_URL, apiKey: DB_API_KEY, model: DB_MODEL });

    const serialized = JSON.stringify(getAiSettingsStatus()) ?? "";
    expect(serialized).not.toContain(DB_API_KEY);
    expect(serialized).toContain(DB_BASE_URL); // baseUrl 非敏感，明文展示
  });
});
