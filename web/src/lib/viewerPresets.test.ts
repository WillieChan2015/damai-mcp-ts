import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadViewerPresets, saveViewerPresetsStore } from "./viewerPresets";

const savedDbPath = process.env.DAMAI_WEB_TASK_DB;
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "viewer-presets-db-"));
  process.env.DAMAI_WEB_TASK_DB = join(dataDir, "tasks.db");
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  if (savedDbPath === undefined) {
    delete process.env.DAMAI_WEB_TASK_DB;
  } else {
    process.env.DAMAI_WEB_TASK_DB = savedDbPath;
  }
});

function rows(): Array<{ position: number; name: string }> {
  const db = new Database(process.env.DAMAI_WEB_TASK_DB);
  try {
    return db.prepare("SELECT position, name FROM viewer_presets ORDER BY position ASC").all() as Array<{
      position: number;
      name: string;
    }>;
  } finally {
    db.close();
  }
}

describe("viewer presets sqlite", () => {
  it("库不存在时为空名单，且不建库", () => {
    expect(loadViewerPresets()).toEqual([]);
    expect(existsSync(process.env.DAMAI_WEB_TASK_DB ?? "")).toBe(false);
  });

  it("保存后按 position 读回，并去掉重复项", () => {
    expect(saveViewerPresetsStore([" 李四 ", "李四", "王五"])).toEqual(["李四", "王五"]);
    expect(loadViewerPresets()).toEqual(["李四", "王五"]);
    expect(rows()).toEqual([
      { position: 0, name: "李四" },
      { position: 1, name: "王五" },
    ]);
  });

  it("可以保存空名单", () => {
    saveViewerPresetsStore(["李四"]);
    saveViewerPresetsStore([]);
    expect(loadViewerPresets()).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it("含逗号的姓名拒绝写入", () => {
    expect(() => saveViewerPresetsStore(["杨安琪,张三"])).toThrow("姓名不能包含逗号");
  });

  it("表中的非法姓名按空名单处理", () => {
    saveViewerPresetsStore(["李四"]);
    const db = new Database(process.env.DAMAI_WEB_TASK_DB);
    try {
      db.prepare("INSERT INTO viewer_presets (position, name) VALUES (?, ?)").run(1, "杨安琪,张三");
    } finally {
      db.close();
    }
    expect(loadViewerPresets()).toEqual([]);
  });
});
