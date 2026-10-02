/**
 * 设备占用互斥锁测试（src/device/lock.ts，§7.3 项 10 的 N2）。
 *
 * 锁是纯进程内状态机（无 I/O），直接用真实时钟的小等待窗口做确定性断言；
 * 全部用例使用独立 device_id，避免用例间经由模块级锁表互相污染。
 */
import { describe, expect, it } from "vitest";

import {
  DeviceBusyError,
  acquireDevice,
  isDeviceBusy,
  withDeviceLease,
} from "../src/device/lock";

describe("acquireDevice / DeviceBusyError", () => {
  it("① 并发 acquire 同一设备 → 第二个立即拒绝 DeviceBusyError，错误含用途与秒数", async () => {
    const first = await acquireDevice("lock-dev-1", "monitor");

    expect(isDeviceBusy("lock-dev-1")).toBe(true);
    const err = (await acquireDevice("lock-dev-1", "grab").catch((e) => e)) as DeviceBusyError;
    expect(err).toBeInstanceOf(DeviceBusyError);
    // 中文文案含持有方用途与已持有时长，给出明确指引
    expect(err.message).toContain("lock-dev-1");
    expect(err.message).toContain("monitor");
    expect(err.message).toMatch(/已持有 \d+\.\ds/);
    expect(err.message).toContain("请等待其完成或换设备");
    // 结构化字段：持有方与持有时长（>=0，几毫秒内完成断言）
    expect(err.heldBy).toBe("monitor");
    expect(err.heldForMs).toBeGreaterThanOrEqual(0);
    // 冲突不影响在持的租约
    expect(isDeviceBusy("lock-dev-1")).toBe(true);
    first.release();
    expect(isDeviceBusy("lock-dev-1")).toBe(false);
  });

  it("② release 后可再次 acquire（锁状态彻底清理）", async () => {
    const first = await acquireDevice("lock-dev-2", "monitor");
    first.release();
    expect(isDeviceBusy("lock-dev-2")).toBe(false);

    const second = await acquireDevice("lock-dev-2", "grab");
    expect(second.purpose).toBe("grab");
    expect(isDeviceBusy("lock-dev-2")).toBe(true);
    second.release();
    expect(isDeviceBusy("lock-dev-2")).toBe(false);
  });

  it("⑤ 不同设备互不阻塞", async () => {
    const a = await acquireDevice("lock-dev-5a", "monitor");
    // 另一台设备即便同用途也不受影响
    const b = await acquireDevice("lock-dev-5b", "monitor");
    expect(isDeviceBusy("lock-dev-5a")).toBe(true);
    expect(isDeviceBusy("lock-dev-5b")).toBe(true);
    a.release();
    b.release();
  });

  it("waitMs > 0 且持有方在窗口内释放 → FIFO 等待后获得", async () => {
    const first = await acquireDevice("lock-dev-wait", "monitor");
    setTimeout(() => first.release(), 20);
    const second = await acquireDevice("lock-dev-wait", "grab", { waitMs: 2000 });
    expect(second.purpose).toBe("grab");
    second.release();
  });

  it("waitMs > 0 但持有方不释放 → 超时抛 DeviceBusyError（锁保持原持有方）", async () => {
    const first = await acquireDevice("lock-dev-timeout", "monitor");
    const startedAt = Date.now();
    const err = (await acquireDevice("lock-dev-timeout", "grab", { waitMs: 60 }).catch(
      (e) => e,
    )) as DeviceBusyError;
    expect(err).toBeInstanceOf(DeviceBusyError);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
    // 超时方出队，不影响原持有方；原持有方释放后锁可再获得
    expect(err.heldBy).toBe("monitor");
    first.release();
    const third = await acquireDevice("lock-dev-timeout", "grab");
    third.release();
  });

  it("waitMs 排队按 FIFO 顺序交接（先等者先得）", async () => {
    const first = await acquireDevice("lock-dev-fifo", "monitor");
    const order: string[] = [];
    const p1 = acquireDevice("lock-dev-fifo", "grab-1", { waitMs: 2000 }).then((l) => {
      order.push("grab-1");
      return l;
    });
    const p2 = acquireDevice("lock-dev-fifo", "grab-2", { waitMs: 2000 }).then((l) => {
      order.push("grab-2");
      return l;
    });
    await new Promise((r) => setTimeout(r, 10)); // 确保两个等待者都已入队
    first.release();
    const l1 = await p1;
    l1.release();
    const l2 = await p2;
    l2.release();
    expect(order).toEqual(["grab-1", "grab-2"]);
  });
});

describe("withDeviceLease", () => {
  it("③ fn 抛错时自动释放（finally 语义），后续可重新 acquire", async () => {
    await expect(
      withDeviceLease("lock-dev-3", "monitor", async () => {
        expect(isDeviceBusy("lock-dev-3")).toBe(true);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // 异常路径不残留锁
    expect(isDeviceBusy("lock-dev-3")).toBe(false);
    const lease = await acquireDevice("lock-dev-3", "grab");
    lease.release();
  });

  it("fn 正常返回值透传，结束后释放", async () => {
    const out = await withDeviceLease("lock-dev-4", "grab", async (lease) => {
      expect(lease.deviceId).toBe("lock-dev-4");
      expect(lease.purpose).toBe("grab");
      return 42;
    });
    expect(out).toBe(42);
    expect(isDeviceBusy("lock-dev-4")).toBe(false);
  });
});

describe("DeviceLease.release 幂等", () => {
  it("⑥ 重复 release 为 no-op，不吞掉后续获得者的锁", async () => {
    const lease = await acquireDevice("lock-dev-6", "monitor");
    lease.release();
    lease.release(); // 幂等：第二次是 no-op

    // 后续获得者持有期间，早先的重复 release 不得破坏其占用
    const next = await acquireDevice("lock-dev-6", "grab");
    expect(isDeviceBusy("lock-dev-6")).toBe(true);
    lease.release(); // 早先租约再释放仍应无效
    expect(isDeviceBusy("lock-dev-6")).toBe(true);
    next.release();
    expect(isDeviceBusy("lock-dev-6")).toBe(false);
  });
});
