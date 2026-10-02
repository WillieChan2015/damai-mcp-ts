/**
 * notify credentials —— 通知凭证持久化存储测试（临时目录隔离，全程不触真实
 * 用户目录：setNotifyCredentialsDirForTests(mkdtemp) → afterEach 复位 + rmSync）。
 *
 * 权限断言（0600 / 0700 / 过宽告警）依赖 POSIX chmod 语义——Windows 的 chmod
 * 只有只读位语义，相关用例以 `it.skipIf(process.platform === "win32")` 跳过
 * （见 src/notify/credentials.ts 模块头平台注记）。
 *
 * logger 用 vi.mock 整体替换为桩：真实 logger 是带 caller 捕获的 Proxy，对它
 * vi.spyOn(level) 会被 get 陷阱旁路，桩才是可靠的断言点。
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logger } from "../src/utils/logging";
import {
  NOTIFY_CREDENTIALS_DIR_DEFAULT,
  NOTIFY_CREDENTIALS_FILE_DEFAULT,
  clearNotifyCredentials,
  loadNotifyCredentials,
  redactToken,
  saveNotifyCredentials,
  setNotifyCredentialsDirForTests,
} from "../src/notify/credentials";

vi.mock("../src/utils/logging", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/logging")>();
  return {
    ...actual,
    logger: {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
    } as unknown as typeof actual.logger,
  };
});

/** 当前用例的临时凭证目录（beforeEach 创建，afterEach 删除）。 */
let tmpDir = "";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "damai-notify-creds-"));
  setNotifyCredentialsDirForTests(tmpDir);
  vi.mocked(logger.warning).mockClear();
});

afterEach(() => {
  setNotifyCredentialsDirForTests(null); // 恢复默认，防泄漏到其他测试文件
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("notify credentials 默认路径", () => {
  it("默认文件为默认目录下的 notify.json（XDG/家目录布局）", () => {
    expect(NOTIFY_CREDENTIALS_FILE_DEFAULT).toBe(join(NOTIFY_CREDENTIALS_DIR_DEFAULT, "notify.json"));
    expect(NOTIFY_CREDENTIALS_DIR_DEFAULT.endsWith("damai-mcp-ts")).toBe(true);
  });
});

describe("saveNotifyCredentials / loadNotifyCredentials 往返", () => {
  it("save → load 字段一致，savedAtUnix 为数字", async () => {
    await saveNotifyCredentials({
      origin: "https://bot.ilinkai.weixin.qq.com",
      token: "secret-token-abcdef",
      contextToken: "ctx-token-0123456789",
    });
    const loaded = await loadNotifyCredentials();
    expect(loaded).not.toBeNull();
    expect(loaded?.origin).toBe("https://bot.ilinkai.weixin.qq.com");
    expect(loaded?.token).toBe("secret-token-abcdef");
    expect(loaded?.contextToken).toBe("ctx-token-0123456789");
    expect(typeof loaded?.savedAtUnix).toBe("number");
  });

  it("覆盖保存：同名 token 被新值原子替换", async () => {
    await saveNotifyCredentials({ origin: "https://a.ilinkai.weixin.qq.com", token: "old-token-xx", contextToken: "c1" });
    await saveNotifyCredentials({ origin: "https://b.ilinkai.weixin.qq.com", token: "new-token-yy", contextToken: "c2" });
    const loaded = await loadNotifyCredentials();
    expect(loaded?.origin).toBe("https://b.ilinkai.weixin.qq.com");
    expect(loaded?.token).toBe("new-token-yy");
  });
});

describe("文件权限（POSIX only）", () => {
  it.skipIf(process.platform === "win32")("save 后文件 0600、目录 0700", async () => {
    await saveNotifyCredentials({ origin: "https://o.ilinkai.weixin.qq.com", token: "t-0123456789", contextToken: "c" });
    const fileMode = statSync(join(tmpDir, "notify.json")).mode & 0o777;
    const dirMode = statSync(tmpDir).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")("过宽权限触发 warning 且照常读取", async () => {
    await saveNotifyCredentials({ origin: "https://o.ilinkai.weixin.qq.com", token: "t-0123456789", contextToken: "c" });
    chmodSync(join(tmpDir, "notify.json"), 0o644); // 人为放宽
    vi.mocked(logger.warning).mockClear();
    const loaded = await loadNotifyCredentials();
    expect(loaded?.token).toBe("t-0123456789"); // 不因权限拒绝读取
    expect(vi.mocked(logger.warning)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warning).mock.calls[0]?.[0]).toContain("通知凭证文件权限过宽");
  });
});

describe("原子替换与残留", () => {
  it("save 后目录无 .tmp 残留，仅剩 notify.json", async () => {
    await saveNotifyCredentials({ origin: "https://o.ilinkai.weixin.qq.com", token: "t-0123456789", contextToken: "c" });
    expect(readdirSync(tmpDir)).toEqual(["notify.json"]);
  });

  it("save 失败（凭证路径被目录占用）不残留 tmp 文件且抛中文错误", async () => {
    // 凭证路径上是一个目录 → rename 目标非法（POSIX EISDIR / win32 EPERM）
    mkdirSync(join(tmpDir, "notify.json"));
    await expect(
      saveNotifyCredentials({ origin: "https://o.ilinkai.weixin.qq.com", token: "t-0123456789", contextToken: "c" }),
    ).rejects.toThrow("保存通知凭证失败");
    expect(readdirSync(tmpDir).filter((n) => n.includes(".tmp."))).toEqual([]);
  });
});

describe("load 容错", () => {
  it("文件缺失 → null 不抛", async () => {
    await expect(loadNotifyCredentials()).resolves.toBeNull();
  });

  it("损坏 JSON → null 不抛", async () => {
    writeFileSync(join(tmpDir, "notify.json"), "{not json at all", "utf-8");
    await expect(loadNotifyCredentials()).resolves.toBeNull();
  });

  it("非 JSON 对象（数组）→ null", async () => {
    writeFileSync(join(tmpDir, "notify.json"), '["origin","token"]', "utf-8");
    await expect(loadNotifyCredentials()).resolves.toBeNull();
  });

  it("缺 token 字段 → null；缺 savedAtUnix 兼容（记 0）", async () => {
    writeFileSync(
      join(tmpDir, "notify.json"),
      JSON.stringify({ origin: "https://o.ilinkai.weixin.qq.com", contextToken: "c" }),
      "utf-8",
    );
    await expect(loadNotifyCredentials()).resolves.toBeNull();

    writeFileSync(
      join(tmpDir, "notify.json"),
      JSON.stringify({ origin: "https://o.ilinkai.weixin.qq.com", token: "t-0123456789", contextToken: "c" }),
      "utf-8",
    );
    const loaded = await loadNotifyCredentials();
    expect(loaded?.savedAtUnix).toBe(0);
  });
});

describe("clearNotifyCredentials", () => {
  it("clear 后 load 为 null；重复 clear 不抛", async () => {
    await saveNotifyCredentials({ origin: "https://o.ilinkai.weixin.qq.com", token: "t-0123456789", contextToken: "c" });
    await clearNotifyCredentials();
    expect(existsSync(join(tmpDir, "notify.json"))).toBe(false);
    await expect(loadNotifyCredentials()).resolves.toBeNull();
    // 文件已不存在时再次清除应静默成功（rm force 语义）
    await expect(clearNotifyCredentials()).resolves.toBeUndefined();
  });
});

describe("redactToken", () => {
  it("长度 ≥ 8：只留前 2 后 2", () => {
    expect(redactToken("abcd1234efgh")).toBe("ab****gh");
    expect(redactToken("abcdwxyz")).toBe("ab****yz");
  });

  it("长度 < 8 与空串：全遮为 ***", () => {
    expect(redactToken("short")).toBe("***");
    expect(redactToken("")).toBe("***");
  });
});
