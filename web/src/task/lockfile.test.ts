import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TaskConflictError } from "./manager";
import { DeviceLockfile, resolveLockfilePath, type DeviceLockRecord } from "./lockfile";

/** 每用例独立的临时目录。 */
let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

/** 固定时钟，便于构造过期/未过期记录。 */
const NOW = 1_700_000_000_000;

/** 默认测试依赖：pid 恒存活、时钟固定、过期阈值 10 分钟。 */
function testDeps(overrides: Partial<{ isPidAlive: (pid: number) => boolean; now: () => number; staleAfterMs: number }> = {}) {
  return {
    isPidAlive: () => true,
    now: () => NOW,
    ...overrides,
  };
}

/** 直接向锁文件写入一条记录（绕过 acquire，便于构造任意历史状态）。 */
function seedRecord(lockPath: string, deviceId: string, rec: DeviceLockRecord): void {
  writeFileSync(lockPath, JSON.stringify({ [deviceId]: { ...rec, deviceId } }), "utf-8");
}

function record(taskId: string, pid: number, heldAtUnixMs: number): DeviceLockRecord {
  return { deviceId: "", taskId, pid, heldAtUnixMs };
}

describe("DeviceLockfile", () => {
  it("构造零副作用：不读不写锁文件", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "damai-web-lock-"));
    const lockPath = join(tmpDir, ".damai-web.lock");
    const lock = new DeviceLockfile(lockPath, testDeps());
    expect(existsSync(lockPath)).toBe(false);
    expect(typeof lock.acquire).toBe("function");
  });

  it("锁竞争：B 同设备 acquire 抛 TaskConflictError 且 error 含持有 taskId；不同设备互不影响", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "damai-web-lock-"));
    const lockPath = join(tmpDir, ".damai-web.lock");
    const alice = new DeviceLockfile(lockPath, testDeps());
    const bob = new DeviceLockfile(lockPath, testDeps());

    alice.acquire("emu-1", "task-a");
    let conflict: TaskConflictError | null = null;
    try {
      bob.acquire("emu-1", "task-b");
    } catch (exc) {
      conflict = exc as TaskConflictError;
    }
    expect(conflict).toBeInstanceOf(TaskConflictError);
    expect(conflict?.deviceId).toBe("emu-1");
    expect(conflict?.runningTaskId).toBe("task-a");
    expect(conflict?.message).toContain("task-a");

    // 不同设备不受影响
    expect(() => bob.acquire("emu-2", "task-b2")).not.toThrow();

    // alice 释放后 bob 可占用同设备
    alice.release("emu-1", "task-a");
    expect(() => bob.acquire("emu-1", "task-b3")).not.toThrow();
  });

  it("过期清理（持有时长超 staleAfterMs）：超时条目被清理后可占用，文件被重写", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "damai-web-lock-"));
    const lockPath = join(tmpDir, ".damai-web.lock");
    // stale 边界：now - heldAt > staleAfterMs 才过期
    seedRecord(lockPath, "emu-1", record("stale-task", 12345, NOW - 600_000 - 1));
    seedRecordExtra(lockPath, "emu-2", record("fresh-task", 12345, NOW - 600_000));

    const lock = new DeviceLockfile(lockPath, testDeps());
    // emu-1 恰好超时 → 可占用；emu-2 恰好未超时 → 冲突
    expect(() => lock.acquire("emu-1", "task-new")).not.toThrow();
    expect(() => lock.acquire("emu-2", "task-new")).toThrow(TaskConflictError);
    // 清理重写后，过期条目消失
    const table = JSON.parse(readFileSync(lockPath, "utf-8")) as Record<string, DeviceLockRecord>;
    expect(table["emu-1"]?.taskId).toBe("task-new");
    expect(table["emu-2"]?.taskId).toBe("fresh-task");
  });

  it("过期清理（pid 已死）：不存活进程的条目被清理后可占用", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "damai-web-lock-"));
    const lockPath = join(tmpDir, ".damai-web.lock");
    seedRecord(lockPath, "emu-9", record("dead-task", 99999, NOW));

    const lock = new DeviceLockfile(lockPath, testDeps({ isPidAlive: (pid) => pid !== 99999 }));
    expect(() => lock.acquire("emu-9", "task-live")).not.toThrow();
  });

  it("损坏文件容错：非法 JSON 视为无锁，acquire 成功且文件被重写", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "damai-web-lock-"));
    const lockPath = join(tmpDir, ".damai-web.lock");
    writeFileSync(lockPath, "not-json{{{", "utf-8");

    const lock = new DeviceLockfile(lockPath, testDeps());
    expect(() => lock.acquire("emu-1", "task-rw")).not.toThrow();
    const table = JSON.parse(readFileSync(lockPath, "utf-8")) as Record<string, DeviceLockRecord>;
    expect(table["emu-1"]?.taskId).toBe("task-rw");
    expect(table["emu-1"]?.pid).toBe(process.pid);
    expect(table["emu-1"]?.heldAtUnixMs).toBe(NOW);
  });

  it("release：仅 taskId 匹配才移除；幂等；不误删他人条目", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "damai-web-lock-"));
    const lockPath = join(tmpDir, ".damai-web.lock");
    const lock = new DeviceLockfile(lockPath, testDeps());
    lock.acquire("emu-1", "task-a");
    lock.acquire("emu-2", "task-c");

    // taskId 不匹配：不删除
    lock.release("emu-1", "wrong-task");
    let table = JSON.parse(readFileSync(lockPath, "utf-8")) as Record<string, DeviceLockRecord>;
    expect(table["emu-1"]?.taskId).toBe("task-a");
    expect(table["emu-2"]?.taskId).toBe("task-c");

    // 匹配释放：只移除自己条目，他人条目完好
    lock.release("emu-1", "task-a");
    table = JSON.parse(readFileSync(lockPath, "utf-8")) as Record<string, DeviceLockRecord>;
    expect(table["emu-1"]).toBeUndefined();
    expect(table["emu-2"]?.taskId).toBe("task-c");

    // 幂等：重复释放不再变化、不抛
    expect(() => lock.release("emu-1", "task-a")).not.toThrow();
    expect(() => lock.release("emu-1", "task-a")).not.toThrow();
  });

  it("默认依赖：process.kill 探活（本进程 pid 恒存活 → 冲突）", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "damai-web-lock-"));
    const lockPath = join(tmpDir, ".damai-web.lock");
    const alice = new DeviceLockfile(lockPath); // 无 deps：默认探活/时钟
    const bob = new DeviceLockfile(lockPath);

    alice.acquire("emu-1", "task-a");
    expect(() => bob.acquire("emu-1", "task-b")).toThrow(TaskConflictError);
    bob.release("emu-1", "task-b"); // 非持有者 release：幂等 no-op
    const table = JSON.parse(readFileSync(lockPath, "utf-8")) as Record<string, DeviceLockRecord>;
    expect(table["emu-1"]?.taskId).toBe("task-a");
  });

  it("resolveLockfilePath：env 优先，缺省 resolve(cwd, '..', '.damai-web.lock')", () => {
    const saved = process.env.DAMAI_WEB_LOCK_FILE;
    try {
      process.env.DAMAI_WEB_LOCK_FILE = "/tmp/custom.lock";
      expect(resolveLockfilePath()).toBe("/tmp/custom.lock");
      delete process.env.DAMAI_WEB_LOCK_FILE;
      expect(resolveLockfilePath()).toBe(resolve(process.cwd(), "..", ".damai-web.lock"));
    } finally {
      if (saved === undefined) {
        delete process.env.DAMAI_WEB_LOCK_FILE;
      } else {
        process.env.DAMAI_WEB_LOCK_FILE = saved;
      }
    }
  });
});

/** 向既有锁文件追加一条记录（保留其他条目）。 */
function seedRecordExtra(lockPath: string, deviceId: string, rec: DeviceLockRecord): void {
  const table = JSON.parse(readFileSync(lockPath, "utf-8")) as Record<string, DeviceLockRecord>;
  table[deviceId] = { ...rec, deviceId };
  writeFileSync(lockPath, JSON.stringify(table), "utf-8");
}
