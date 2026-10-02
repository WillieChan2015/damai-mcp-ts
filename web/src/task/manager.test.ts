import { describe, expect, it } from "vitest";

import {
  TaskConflictError,
  TaskManager,
  getTaskManager,
  type TaskRunner,
} from "./manager";
import { SimpleStopEvent } from "./stopEvent";

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
});
