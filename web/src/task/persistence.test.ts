import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { TaskSnapshot } from "./manager";
import { createSqliteTaskStore, resolveTaskDbPath, type TaskStore } from "./persistence";

/** 每用例独立的临时目录。 */
let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

/** 构造一份完整快照（测试只需覆盖关注字段）。 */
function snapshot(overrides: Partial<TaskSnapshot>): TaskSnapshot {
  return {
    id: "task-1",
    kind: "grab",
    deviceId: "emu-1",
    label: "抢票测试",
    status: "running",
    startedAtUnixMs: 1720000000000,
    endedAtUnixMs: null,
    unresponsive: false,
    error: null,
    progress: [],
    progressTotal: 0,
    result: null,
    ...overrides,
  };
}

describe("createSqliteTaskStore", () => {
  it("构造零副作用：不建文件，首次 upsert 才落盘", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "damai-web-persist-"));
    const dbPath = join(tmpDir, "nested", "tasks.db");
    const store = createSqliteTaskStore(dbPath);
    // 仅构造：db 文件不产生（目录由 ensureOpen 惰性 mkdir）
    expect(existsSync(dbPath)).toBe(false);
    store.upsert(snapshot({ id: "lazy-1" }));
    expect(existsSync(dbPath)).toBe(true);
    expect(store.loadAll().map((s) => s.id)).toEqual(["lazy-1"]);
    store.close();
  });

  it("upsert/loadAll 往返：字段全量还原，result JSON 与 progress_tail 截断到 500", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "damai-web-persist-"));
    const store = createSqliteTaskStore(join(tmpDir, "tasks.db"));
    const lines = Array.from({ length: 600 }, (_, i) => `line ${i}`);
    const snap = snapshot({
      id: "grab-1",
      status: "succeeded",
      endedAtUnixMs: 1720000001000,
      unresponsive: true,
      error: "模拟错误",
      progress: lines,
      progressTotal: 600,
      result: { summary: "完成", ok: true },
    });
    store.upsert(snap);

    const loaded = store.loadAll();
    expect(loaded).toHaveLength(1);
    const row = loaded[0]!;
    expect(row.id).toBe("grab-1");
    expect(row.kind).toBe("grab");
    expect(row.deviceId).toBe("emu-1");
    expect(row.label).toBe("抢票测试");
    expect(row.status).toBe("succeeded");
    expect(row.startedAtUnixMs).toBe(1720000000000);
    expect(row.endedAtUnixMs).toBe(1720000001000);
    expect(row.unresponsive).toBe(true);
    expect(row.error).toBe("模拟错误");
    expect(row.result).toEqual({ summary: "完成", ok: true });
    // 环形缓冲同语义：只保留尾部 500 行，总数不变
    expect(row.progressTotal).toBe(600);
    expect(row.progress).toHaveLength(500);
    expect(row.progress[0]).toBe("line 100");
    expect(row.progress[row.progress.length - 1]).toBe("line 599");
    store.close();
  });

  it("同 id 重复 upsert 整体覆盖：最新状态胜出，不产生重复行", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "damai-web-persist-"));
    const store = createSqliteTaskStore(join(tmpDir, "tasks.db"));
    store.upsert(snapshot({ id: "grab-2", status: "running" }));
    store.upsert(snapshot({ id: "grab-2", status: "failed", error: "adb 掉线", endedAtUnixMs: 1 }));

    const loaded = store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.status).toBe("failed");
    expect(loaded[0]?.error).toBe("adb 掉线");
    store.close();
  });

  it("多任务多行：loadAll 按 startedAt 升序返回全部历史", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "damai-web-persist-"));
    const store = createSqliteTaskStore(join(tmpDir, "tasks.db"));
    store.upsert(snapshot({ id: "b", startedAtUnixMs: 200 }));
    store.upsert(snapshot({ id: "a", startedAtUnixMs: 100, deviceId: "emu-2", kind: "monitor" }));
    store.upsert(snapshot({ id: "c", startedAtUnixMs: 300, status: "cancelled", endedAtUnixMs: 400 }));

    const loaded = store.loadAll();
    expect(loaded.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(loaded[0]?.kind).toBe("monitor");
    expect(loaded[2]?.status).toBe("cancelled");
    store.close();
  });

  it("损坏文件（非 SQLite）→ 降级 no-op：upsert/loadAll/close 均不抛", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "damai-web-persist-"));
    const dbPath = join(tmpDir, "tasks.db");
    writeFileSync(dbPath, "this is definitely not a sqlite database", "utf-8");
    const store = createSqliteTaskStore(dbPath);
    expect(() => store.upsert(snapshot({}))).not.toThrow();
    expect(store.loadAll()).toEqual([]);
    // close 幂等
    expect(() => {
      store.close();
      store.close();
    }).not.toThrow();
  });

  it("close 后实例停用（upsert/loadAll no-op），数据仍在盘上可被新实例读回", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "damai-web-persist-"));
    const dbPath = join(tmpDir, "tasks.db");
    const store = createSqliteTaskStore(dbPath);
    store.upsert(snapshot({ id: "keep-1", status: "succeeded", endedAtUnixMs: 5 }));
    store.close();

    expect(() => store.upsert(snapshot({ id: "keep-2" }))).not.toThrow();
    expect(store.loadAll()).toEqual([]);

    const reopened = createSqliteTaskStore(dbPath);
    const loaded = reopened.loadAll();
    expect(loaded.map((s) => s.id)).toEqual(["keep-1"]);
    reopened.close();
  });

  it("resolveTaskDbPath：env 优先，缺省 <cwd>/data/tasks.db", () => {
    const saved = process.env.DAMAI_WEB_TASK_DB;
    try {
      process.env.DAMAI_WEB_TASK_DB = "/tmp/custom/tasks.db";
      expect(resolveTaskDbPath()).toBe("/tmp/custom/tasks.db");
      delete process.env.DAMAI_WEB_TASK_DB;
      expect(resolveTaskDbPath()).toBe(join(process.cwd(), "data", "tasks.db"));
    } finally {
      if (saved === undefined) {
        delete process.env.DAMAI_WEB_TASK_DB;
      } else {
        process.env.DAMAI_WEB_TASK_DB = saved;
      }
    }
  });

  it("TaskStore 接口形状：createSqliteTaskStore 返回值可赋给 TaskStore", () => {
    const store: TaskStore = createSqliteTaskStore(join(tmpdir(), "unused.db"));
    store.close();
  });
});
