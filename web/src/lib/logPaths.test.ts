import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LOG_FILE_RE, resolveCurrentLogFile, resolveLogDir } from "./logPaths";

function makeTmpDir(prefix = "damai-logpaths-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("LOG_FILE_RE（pino-roll 落盘文件名规则）", () => {
  it("匹配带 .log 扩展名（sanitizeFile 默认扩展）与不带扩展名两种形态", () => {
    expect(LOG_FILE_RE.test("damai_mcp.20261003.1.log")).toBe(true);
    expect(LOG_FILE_RE.test("damai_mcp.20261003.1")).toBe(true);
  });

  it("不匹配无关形态：缺日期段 / 日期段超长 / 基名不同 / 缺序号", () => {
    expect(LOG_FILE_RE.test("damai_mcp.20261003.log")).toBe(false);
    expect(LOG_FILE_RE.test("damai_mcp.202610031.1.log")).toBe(false);
    expect(LOG_FILE_RE.test("damai_mcp.txt")).toBe(false);
    expect(LOG_FILE_RE.test("other_mcp.20261003.1.log")).toBe(false);
  });
});

describe("resolveCurrentLogFile", () => {
  const cleanups: string[] = [];
  afterEach(() => {
    for (const dir of cleanups.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("多文件按 (日期段, 序号) 数值最大取当前——序号 10 优于 2（非字典序）", () => {
    const dir = makeTmpDir();
    cleanups.push(dir);
    writeFileSync(join(dir, "damai_mcp.20261002.1.log"), "old\n");
    writeFileSync(join(dir, "damai_mcp.20261003.2.log"), "mid\n");
    writeFileSync(join(dir, "damai_mcp.20261003.10.log"), "newest\n");
    expect(resolveCurrentLogFile(dir)).toBe(join(dir, "damai_mcp.20261003.10.log"));
  });

  it("日期段优先于序号：昨天的 .99 不敌今天的 .1", () => {
    const dir = makeTmpDir();
    cleanups.push(dir);
    writeFileSync(join(dir, "damai_mcp.20261002.99.log"), "yesterday\n");
    writeFileSync(join(dir, "damai_mcp.20261003.1.log"), "today\n");
    expect(resolveCurrentLogFile(dir)).toBe(join(dir, "damai_mcp.20261003.1.log"));
  });

  it("无关文件全部忽略", () => {
    const dir = makeTmpDir();
    cleanups.push(dir);
    writeFileSync(join(dir, "damai_mcp.txt"), "x\n");
    writeFileSync(join(dir, "other_mcp.20261003.1.log"), "x\n");
    writeFileSync(join(dir, "README.md"), "x\n");
    writeFileSync(join(dir, "damai_mcp.20261003.7.log"), "real\n");
    expect(resolveCurrentLogFile(dir)).toBe(join(dir, "damai_mcp.20261003.7.log"));
  });

  it("空目录 → null", () => {
    const dir = makeTmpDir();
    cleanups.push(dir);
    expect(resolveCurrentLogFile(dir)).toBeNull();
  });

  it("目录不存在 → null（不抛错）", () => {
    expect(resolveCurrentLogFile(join(tmpdir(), "damai-logpaths-not-exist-42"))).toBeNull();
  });
});

describe("resolveLogDir", () => {
  it("env DAMAI_WEB_LOG_DIR 命中时优先", () => {
    expect(
      resolveLogDir({ cwd: "/repo/web", env: { DAMAI_WEB_LOG_DIR: "/custom/logs" } }),
    ).toBe("/custom/logs");
  });

  it("env 置空串视为未设置，回落 cwd 上一级 logs/", () => {
    expect(resolveLogDir({ cwd: "/repo/web", env: { DAMAI_WEB_LOG_DIR: "  " } })).toBe(
      resolve("/repo/web", "..", "logs"),
    );
  });

  it("默认解析 = resolve(cwd, '..', 'logs')", () => {
    expect(resolveLogDir({ cwd: "/repo/web" })).toBe("/repo/logs");
  });

  it("完全不传实参时用 process.cwd() 与 process.env", () => {
    expect(resolveLogDir()).toBe(resolve(process.cwd(), "..", "logs"));
  });
});
