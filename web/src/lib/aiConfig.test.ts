/**
 * aiConfig 测试（设计 §8.6①）：DAMAI_WEB_DATA_DIR 注入空临时目录隔离本机，
 * DAMAI_AI_* env 直灌。覆盖：file>env 优先级、损坏 JSON 回落、未配置、
 * 0600 权限落盘（POSIX）、掩码形态。
 */
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { aiSettingsFilePath, getAiSettingsStatus, loadAiSettings, saveAiSettings } from "./aiConfig";

/** 本机真实 env 的原值（afterAll 复位，避免污染同进程其他测试）。 */
const ENV_KEYS = [
  "DAMAI_WEB_DATA_DIR",
  "DAMAI_AI_BASE_URL",
  "DAMAI_AI_API_KEY",
  "DAMAI_AI_MODEL",
] as const;
const savedEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

/** 测试三要素（apiKey 长度 ≥ 8，可断言 redactToken 掩码形态）。 */
const FILE_BASE_URL = "https://file.example.com/v1";
const FILE_API_KEY = "file-key-abcdef";
const FILE_MODEL = "file-model";
const ENV_BASE_URL = "https://env.example.com/v1";
const ENV_API_KEY = "env-key-123456";
const ENV_MODEL = "env-model";

/** 当前用例的临时数据目录（beforeEach 新建、afterEach 清理）。 */
let dataDir: string;

function settingsFile(): string {
  return join(dataDir, "ai-settings.json");
}

/** 清空四个 env（未配置用例）。 */
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

/** 写一份三要素齐备的设置文件（file 来源用例；0600 模拟真实保存后的权限）。 */
function writeFileSettings(): void {
  writeFileSync(
    settingsFile(),
    JSON.stringify({ baseUrl: FILE_BASE_URL, apiKey: FILE_API_KEY, model: FILE_MODEL }),
    "utf-8",
  );
  chmodSync(settingsFile(), 0o600);
}

/** POSIX-only 用例（win32 的 chmod 只有只读位语义，跳过，对齐 credentials.ts 平台注记）。 */
const itPosix = process.platform === "win32" ? it.skip : it;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "ai-config-test-"));
  clearEnv();
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
  it("① 文件 > env：两者都在时取文件三要素，status.source=file", () => {
    writeFileSettings();
    setAiEnv();

    expect(loadAiSettings()).toEqual({
      baseUrl: FILE_BASE_URL,
      apiKey: FILE_API_KEY,
      model: FILE_MODEL,
    });
    const status = getAiSettingsStatus();
    expect(status.configured).toBe(true);
    expect(status.source).toBe("file");
    expect(status.baseUrl).toBe(FILE_BASE_URL);
  });

  it("② 损坏 JSON → 回落 env（不抛），filePresent 仍为 true", () => {
    writeFileSync(settingsFile(), "{not valid json", "utf-8");
    setAiEnv();

    expect(loadAiSettings()).toEqual({
      baseUrl: ENV_BASE_URL,
      apiKey: ENV_API_KEY,
      model: ENV_MODEL,
    });
    const status = getAiSettingsStatus();
    expect(status.source).toBe("env");
    expect(status.filePresent).toBe(true);
  });

  it("②b 文件字段缺失（只有 baseUrl）→ 视为无文件配置，回落 env", () => {
    writeFileSync(settingsFile(), JSON.stringify({ baseUrl: FILE_BASE_URL }), "utf-8");
    setAiEnv();

    expect(loadAiSettings()).toEqual({
      baseUrl: ENV_BASE_URL,
      apiKey: ENV_API_KEY,
      model: ENV_MODEL,
    });
    expect(getAiSettingsStatus().source).toBe("env");
  });

  it("③ 无文件无 env → loadAiSettings=null，status configured=false / source=none / 全 null", () => {
    expect(loadAiSettings()).toBeNull();
    const status = getAiSettingsStatus();
    expect(status).toEqual({
      configured: false,
      source: "none",
      baseUrl: null,
      model: null,
      maskedKey: null,
      filePresent: false,
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
  itPosix("④ 落盘文件权限为 0600（mode & 0o777 === 0o600）", async () => {
    await saveAiSettings({
      baseUrl: ENV_BASE_URL,
      apiKey: ENV_API_KEY,
      model: ENV_MODEL,
    });

    const mode = statSync(settingsFile()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("④b 保存后 load 读回三要素（file 来源），status 掩码正确", async () => {
    await saveAiSettings({
      baseUrl: ENV_BASE_URL,
      apiKey: ENV_API_KEY,
      model: ENV_MODEL,
    });

    expect(loadAiSettings()).toEqual({
      baseUrl: ENV_BASE_URL,
      apiKey: ENV_API_KEY,
      model: ENV_MODEL,
    });
    const status = getAiSettingsStatus();
    expect(status.source).toBe("file");
    expect(status.configured).toBe(true);
  });

  it("④c 保存覆盖旧文件（rename 原子替换语义）", async () => {
    writeFileSettings();
    await saveAiSettings({
      baseUrl: ENV_BASE_URL,
      apiKey: ENV_API_KEY,
      model: ENV_MODEL,
    });

    expect(loadAiSettings()?.baseUrl).toBe(ENV_BASE_URL);
  });

  it("④d 数据目录不存在时自动创建", async () => {
    const nested = join(dataDir, "deep", "data");
    process.env.DAMAI_WEB_DATA_DIR = nested;

    await saveAiSettings({ baseUrl: ENV_BASE_URL, apiKey: ENV_API_KEY, model: ENV_MODEL });
    expect(loadAiSettings()?.model).toBe(ENV_MODEL);
  });
});

describe("掩码与秘密卫生", () => {
  it("⑤ maskedKey 为 redactToken 形态（前 2 后 2）且不等于原文", async () => {
    setAiEnv();

    const status = getAiSettingsStatus();
    expect(status.maskedKey).toBe("en****56"); // env-key-123456：前 2 后 2
    expect(status.maskedKey).not.toBe(ENV_API_KEY);
  });

  it("⑤b 状态快照 JSON 序列化不含 apiKey 原文（file 来源同样成立）", async () => {
    writeFileSettings();

    const serialized = JSON.stringify(getAiSettingsStatus()) ?? "";
    expect(serialized).not.toContain(FILE_API_KEY);
    expect(serialized).toContain(FILE_BASE_URL); // baseUrl 非敏感，明文展示
  });
});

describe("aiSettingsFilePath", () => {
  it("DAMAI_WEB_DATA_DIR 设置时为 <dir>/ai-settings.json", () => {
    expect(aiSettingsFilePath()).toBe(join(dataDir, "ai-settings.json"));
  });

  it("未设置时回落 <cwd>/data/ai-settings.json（与 tasks.db 的 data 目录约定一致）", () => {
    delete process.env.DAMAI_WEB_DATA_DIR;
    expect(aiSettingsFilePath()).toBe(join(process.cwd(), "data", "ai-settings.json"));
  });
});
