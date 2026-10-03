import { describe, expect, it } from "vitest";

import {
  TaskConflictError,
  TaskManager,
  getTaskManager,
  type TaskRunner,
} from "./manager";
import { SimpleStopEvent } from "./stopEvent";

// —— Phase 2 persistence 追加用例所需（既有用例零改动）——
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach } from "vitest";

import type { TaskSnapshot } from "./manager";
import { DeviceLockfile } from "./lockfile";
import { createSqliteTaskStore } from "./persistence";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 一直跑到 stopEvent 置位才退出的执行体。 */
function stopAwareRunner(sleepMs = 5): TaskRunner {
  return async ({ stopEvent, onProgress }) => {
    let n = 0;
    while (!stopEvent.isSet()) {
      onProgress(`tick ${n++}`);
      await sleep(sleepMs);
    }
    onProgress("stopped");
  };
}

describe("SimpleStopEvent", () => {
  it("isSet/set/wait 语义", async () => {
    const ev = new SimpleStopEvent();
    expect(ev.isSet()).toBe(false);
    const waited = ev.wait();
    ev.set();
    await waited;
    expect(ev.isSet()).toBe(true);
    // 重复 set 幂等；wait 立即返回
    ev.set();
    await ev.wait();
  });
});

describe("TaskManager", () => {
  it("getTaskManager 返回 globalThis 单例", () => {
    expect(getTaskManager()).toBe(getTaskManager());
  });

  it("start 立即返回 running 快照，任务完成后收敛为 succeeded 并释放设备锁", async () => {
    const mgr = new TaskManager();
    let ran = false;
    const snap = mgr.start({
      kind: "custom",
      deviceId: "dev-1",
      label: "ok 任务",
      runner: async () => {
        ran = true;
      },
    });
    expect(snap.status).toBe("running");
    expect(snap.deviceId).toBe("dev-1");
    await mgr.whenSettled(snap.id);
    const after = mgr.get(snap.id);
    expect(after?.status).toBe("succeeded");
    expect(after?.endedAtUnixMs).not.toBeNull();
    expect(ran).toBe(true);
    expect(mgr.lockedDeviceIds()).not.toContain("dev-1");
  });

  it("同设备互斥：运行中再 start 同设备抛 TaskConflictError，不同设备不受影响", async () => {
    const mgr = new TaskManager();
    const first = mgr.start({ kind: "grab", deviceId: "emu-1", runner: stopAwareRunner() });
    expect(() => mgr.start({ kind: "grab", deviceId: "emu-1", runner: async () => undefined })).toThrow(
      TaskConflictError,
    );
    const other = mgr.start({ kind: "monitor", deviceId: "emu-2", runner: async () => undefined });
    expect(other.status).toBe("running");

    mgr.cancel(first.id);
    await mgr.whenSettled(first.id);
    await mgr.whenSettled(other.id);
    // 释放后可再次占用
    const again = mgr.start({ kind: "grab", deviceId: "emu-1", runner: async () => undefined });
    expect(again.status).toBe("running");
    await mgr.whenSettled(again.id);
  });

  it("cancel：置位 stopEvent、状态 cancelling → cancelled，进度被记录", async () => {
    const mgr = new TaskManager();
    const snap = mgr.start({ kind: "grab", deviceId: "dev-9", runner: stopAwareRunner(3) });
    await sleep(15); // 让 runner 产出若干进度行
    const cancelling = mgr.cancel(snap.id);
    expect(cancelling.status).toBe("cancelling");
    await mgr.whenSettled(snap.id);
    const done = mgr.get(snap.id);
    expect(done?.status).toBe("cancelled");
    expect(done?.progress.length).toBeGreaterThan(0);
    expect(done?.progress[done.progress.length - 1]).toBe("stopped");
  });

  it("cancel forceAfterMs 超时后标记 unresponsive（任务仍无法强杀）", async () => {
    const mgr = new TaskManager();
    // 无视 stopEvent 的执行体
    const snap = mgr.start({
      kind: "custom",
      deviceId: "dev-x",
      runner: async () => {
        await sleep(120);
      },
    });
    mgr.cancel(snap.id, { forceAfterMs: 20 });
    await sleep(40);
    expect(mgr.get(snap.id)?.unresponsive).toBe(true);
    expect(mgr.get(snap.id)?.status).toBe("cancelling");
    await mgr.whenSettled(snap.id);
    expect(mgr.get(snap.id)?.status).toBe("cancelled");
    expect(mgr.get(snap.id)?.unresponsive).toBe(true);
  });

  it("runner 抛错 → failed + error 信息，锁释放；stopEvent 已置位时归类 cancelled", async () => {
    const mgr = new TaskManager();
    const boom = mgr.start({
      kind: "custom",
      deviceId: "dev-f",
      runner: async () => {
        throw new Error("adb 未找到");
      },
    });
    await mgr.whenSettled(boom.id);
    expect(mgr.get(boom.id)?.status).toBe("failed");
    expect(mgr.get(boom.id)?.error).toBe("adb 未找到");
    expect(mgr.lockedDeviceIds()).not.toContain("dev-f");

    const stopped = mgr.start({
      kind: "custom",
      deviceId: "dev-f",
      runner: async ({ stopEvent }) => {
        stopEvent.set();
        throw new Error("被中止");
      },
    });
    await mgr.whenSettled(stopped.id);
    expect(mgr.get(stopped.id)?.status).toBe("cancelled");
  });

  it("已终结的任务 cancel 返回快照且不改变状态", async () => {
    const mgr = new TaskManager();
    const snap = mgr.start({ kind: "custom", deviceId: "dev-d", runner: async () => undefined });
    await mgr.whenSettled(snap.id);
    const again = mgr.cancel(snap.id);
    expect(again.status).toBe("succeeded");
  });

  it("进度环形缓冲：超过上限丢弃最旧行", async () => {
    const mgr = new TaskManager();
    const snap = mgr.start({
      kind: "custom",
      deviceId: "dev-p",
      runner: async ({ onProgress }) => {
        for (let i = 0; i < 600; i++) {
          onProgress(`line ${i}`);
        }
      },
    });
    await mgr.whenSettled(snap.id);
    const done = mgr.get(snap.id);
    expect(done?.progress.length).toBe(500);
    expect(done?.progress[0]).toBe("line 100");
    expect(done?.progress[done.progress.length - 1]).toBe("line 599");
  });

  it("cancel/get 对不存在的任务抛错", () => {
    const mgr = new TaskManager();
    expect(() => mgr.cancel("nope")).toThrow("任务不存在");
    expect(mgr.get("nope")).toBeNull();
  });

  it("subscribe：backlog 回放 + 实时推送 + 退订；result 存入快照", async () => {
    const mgr = new TaskManager();
    const snap = mgr.start({
      kind: "custom",
      deviceId: "dev-sub",
      runner: async ({ onProgress, stopEvent }) => {
        onProgress("early-1");
        onProgress("early-2");
        await new Promise((r) => setTimeout(r, 30));
        onProgress("late-1");
        while (!stopEvent.isSet()) {
          await new Promise((r) => setTimeout(r, 10));
        }
        return { summary: "done" };
      },
    });

    // 任务未结束时订阅：先回放 2 行 backlog
    const received: Array<{ line: string; index: number }> = [];
    const unsub = mgr.subscribe(snap.id, 0, (line, index) => received.push({ line, index }));
    expect(received.map((r) => r.line)).toEqual(["early-1", "early-2"]);

    // 退订后不再收到实时行；取消任务使其终结
    unsub();
    mgr.cancel(snap.id);

    await mgr.whenSettled(snap.id);
    const done = mgr.get(snap.id);
    expect(done?.status).toBe("cancelled");
    expect(done?.result).toEqual({ summary: "done" });
    expect(done?.progressTotal).toBeGreaterThanOrEqual(3);
    expect(done?.progress[done.progress.length - 1]).toBe("late-1");

    // 已终结任务订阅：只回放 backlog，不抛错
    const after: string[] = [];
    mgr.subscribe(snap.id, 0, (line) => after.push(line));
    expect(after).toContain("late-1");
  });

  it("subscribe 指定 fromIndexExclusive：只收其后的事件（断线续传语义）", async () => {
    const mgr = new TaskManager();
    const snap = mgr.start({
      kind: "custom",
      deviceId: "dev-sub2",
      runner: async ({ onProgress }) => {
        onProgress("l0");
        onProgress("l1");
        onProgress("l2");
      },
    });
    await mgr.whenSettled(snap.id);
    const seen: string[] = [];
    mgr.subscribe(snap.id, 2, (line) => seen.push(line));
    expect(seen).toEqual(["l2"]);
  });
});

// —— Phase 2 persistence 追加用例（store 注入 / 启动恢复 / 跨进程锁）——

/** 追加用例共用的临时目录。 */
let persistTmpDir: string;

afterEach(() => {
  if (persistTmpDir) {
    rmSync(persistTmpDir, { recursive: true, force: true });
  }
});

/** 构造用于注入 store 的种子快照（模拟上个进程遗留的落盘行）。 */
function seedSnapshot(overrides: Partial<TaskSnapshot>): TaskSnapshot {
  return {
    id: "seed-1",
    kind: "grab",
    deviceId: "dev-seed",
    label: "遗留任务",
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

describe("TaskManager 持久化与跨进程锁（Phase 2）", () => {
  it("注入 store：start/cancel/终态逐次落盘，终态后 loadAll 与内存快照一致（含 result 往返）", async () => {
    persistTmpDir = mkdtempSync(join(tmpdir(), "damai-web-mgr-"));
    const store = createSqliteTaskStore(join(persistTmpDir, "tasks.db"));
    const mgr = new TaskManager({ store });

    // 任务 A：取消收敛为 cancelled（产出进度行）
    const a = mgr.start({ kind: "grab", deviceId: "dev-a", label: "取消任务", runner: stopAwareRunner(3) });
    await sleep(15);
    mgr.cancel(a.id);
    await mgr.whenSettled(a.id);

    // 任务 B：正常完成，result 存入快照
    const b = mgr.start({
      kind: "custom",
      deviceId: "dev-b",
      runner: async ({ onProgress }) => {
        onProgress("b-1");
        return { summary: "done" };
      },
    });
    await mgr.whenSettled(b.id);

    expect(mgr.get(a.id)?.status).toBe("cancelled");
    expect(mgr.get(b.id)?.status).toBe("succeeded");

    const rows = store.loadAll();
    expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    const rowA = rows.find((r) => r.id === a.id)!;
    expect(rowA.status).toBe("cancelled");
    expect(rowA.endedAtUnixMs).not.toBeNull();
    expect(rowA.error).toBeNull();
    expect(rowA.progress.length).toBeGreaterThan(0);
    expect(rowA.progressTotal).toBe(mgr.get(a.id)?.progressTotal);
    expect(rowA.progress[rowA.progress.length - 1]).toBe("stopped");
    const rowB = rows.find((r) => r.id === b.id)!;
    expect(rowB.status).toBe("succeeded");
    expect(rowB.result).toEqual({ summary: "done" });

    // 换新实例重开同一 db：磁盘往返一致
    const reopened = createSqliteTaskStore(join(persistTmpDir, "tasks.db"));
    const reread = reopened.loadAll().find((r) => r.id === a.id);
    expect(reread?.status).toBe("cancelled");
    expect(reread?.progress).toEqual(rowA.progress);
    reopened.close();
    store.close();
  });

  it("注入含遗留 running/cancelling 行的 store：启动恢复为 interrupted、endedAt 非空、不占设备锁、whenSettled 立即 resolve", async () => {
    persistTmpDir = mkdtempSync(join(tmpdir(), "damai-web-mgr-"));
    const store = createSqliteTaskStore(join(persistTmpDir, "tasks.db"));
    store.upsert(
      seedSnapshot({
        id: "legacy-1",
        status: "running",
        deviceId: "dev-legacy",
        progress: ["a", "b"],
        progressTotal: 2,
      }),
    );
    store.upsert(seedSnapshot({ id: "legacy-2", status: "cancelling", deviceId: "dev-legacy-2", progressTotal: 0 }));
    // 已终结的历史行原样恢复
    store.upsert(seedSnapshot({ id: "done-1", status: "failed", error: "历史失败", endedAtUnixMs: 1720000001000 }));

    const mgr = new TaskManager({ store });
    const restored = mgr.list();
    expect(restored.map((t) => t.id).sort()).toEqual(["done-1", "legacy-1", "legacy-2"]);

    const l1 = mgr.get("legacy-1")!;
    expect(l1.status).toBe("interrupted");
    expect(l1.endedAtUnixMs).not.toBeNull();
    expect(l1.progress).toEqual(["a", "b"]);
    expect(l1.progressTotal).toBe(2);
    expect(mgr.get("legacy-2")?.status).toBe("interrupted");
    expect(mgr.get("done-1")?.status).toBe("failed");
    expect(mgr.get("done-1")?.endedAtUnixMs).toBe(1720000001000);

    // 历史任务不占用设备锁
    expect(mgr.lockedDeviceIds()).toEqual([]);
    // whenSettled 立即 resolve（endedAtUnixMs 已补齐）
    await mgr.whenSettled("legacy-1");
    // SSE backlog：可订阅历史行的尾部进度
    const backlog: string[] = [];
    mgr.subscribe("legacy-1", 0, (line) => backlog.push(line));
    expect(backlog).toEqual(["a", "b"]);

    // 同设备可直接 start 新任务（恢复的 entry 不登记 deviceLocks）
    const fresh = mgr.start({ kind: "grab", deviceId: "dev-legacy", runner: async () => undefined });
    expect(fresh.status).toBe("running");
    await mgr.whenSettled(fresh.id);
    store.close();
  });

  it("注入 lockfile：跨进程同设备冲突抛 TaskConflictError（含持有 taskId），终态释放后可再占用", async () => {
    persistTmpDir = mkdtempSync(join(tmpdir(), "damai-web-mgr-"));
    const lockPath = join(persistTmpDir, ".damai-web.lock");
    // isPidAlive 恒 true：模拟「其他存活 web 进程」持有
    const mgrA = new TaskManager({ lockfile: new DeviceLockfile(lockPath, { isPidAlive: () => true }) });
    const mgrB = new TaskManager({ lockfile: new DeviceLockfile(lockPath, { isPidAlive: () => true }) });

    const a = mgrA.start({ kind: "grab", deviceId: "dev-lock", runner: stopAwareRunner(3) });
    let conflict: TaskConflictError | null = null;
    try {
      mgrB.start({ kind: "grab", deviceId: "dev-lock", runner: async () => undefined });
    } catch (exc) {
      conflict = exc as TaskConflictError;
    }
    expect(conflict).toBeInstanceOf(TaskConflictError);
    expect(conflict?.runningTaskId).toBe(a.id);

    // 不同设备不受影响
    const other = mgrB.start({ kind: "grab", deviceId: "dev-lock-2", runner: async () => undefined });
    expect(other.status).toBe("running");
    await mgrB.whenSettled(other.id);

    // A 的任务终态（run finally 释放跨进程锁）后 B 可占用同设备
    mgrA.cancel(a.id);
    await mgrA.whenSettled(a.id);
    const retried = mgrB.start({ kind: "grab", deviceId: "dev-lock", runner: async () => undefined });
    expect(retried.status).toBe("running");
    await mgrB.whenSettled(retried.id);
  });
});
