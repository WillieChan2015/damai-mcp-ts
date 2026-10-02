/**
 * 轻量设备占用互斥锁（docs/improvements-from-competitors.md §7.3 项 10 的 N2）。
 *
 * 背景：`damai_monitor_availability`（openPage=true 会深链导航）与抢票工具
 * 并发跑在同一设备上时会互相干扰 uiautomator dump——monitor 的轮询会把
 * 抢票流程的页面状态打乱，抢票的深链导航也会让 monitor 采样到错误页面。
 * 本模块提供按 device_id 的占用互斥：同一设备同一时刻只允许一个监控/抢票任务。
 *
 * 设计取舍：
 *   - **仅进程内有效**（in-memory Map）：`damai_grab_multi` 与独立 MCP 客户端
 *     分属不同进程时不互斥——与改造前的现状同等，边界为单个 server 实例；
 *   - 默认**立即失败**而非排队：给 30 分钟的监控排队让抢票等待没有意义，
 *     调用方应等待其完成或换设备（错误文案给出明确指引）；
 *   - 自包含，仅依赖 node 标准库；不并入 DeviceManager（manager.ts 不在本
 *     模块的变更范围内）。
 */

import { logger } from "../utils/logging";

/** 占用冲突错误：`heldBy` 为持有方用途（purpose），`heldForMs` 为已持有时长。 */
export class DeviceBusyError extends Error {
  /** 被争用的设备 ID。 */
  readonly deviceId: string;
  /** 当前持有方的用途标识（如 "monitor" / "grab"）。 */
  readonly heldBy: string;
  /** 持有方已持有时长（毫秒）。 */
  readonly heldForMs: number;

  constructor(deviceId: string, heldBy: string, heldForMs: number) {
    super(
      `设备 ${deviceId} 正被「${heldBy}」占用（已持有 ${(heldForMs / 1000).toFixed(1)}s）：` +
        "监控与抢票不能同时在同一设备上运行，请等待其完成或换设备",
    );
    this.name = "DeviceBusyError";
    this.deviceId = deviceId;
    this.heldBy = heldBy;
    this.heldForMs = heldForMs;
  }
}

/** 一次成功的设备占用：持有方必须在使用结束后调用 {@link DeviceLease.release}。 */
export interface DeviceLease {
  /** 占用的设备 ID。 */
  readonly deviceId: string;
  /** 占用用途标识（与 acquireDevice 的 purpose 一致）。 */
  readonly purpose: string;
  /** 释放占用（幂等：重复调用为 no-op）。 */
  release(): void;
}

/** {@link acquireDevice} 的可选项。 */
export interface AcquireDeviceOptions {
  /**
   * 占用冲突时的等待时长（毫秒）；默认 null = 立即失败（抛
   * {@link DeviceBusyError}，不排队）。>0 时进入 FIFO 等待队列，
   * 超时仍未获得则抛同一错误。
   */
  waitMs?: number | null;
}

/** FIFO 等待队列的条目：交接时把用途写回锁状态并唤醒等待方。 */
interface LockWaiter {
  purpose: string;
  grant: () => void;
}

/** 单个设备的锁状态（仅存在于被占用期间；空闲即从 Map 删除）。 */
interface LockState {
  purpose: string;
  acquiredAt: number;
  waiters: LockWaiter[];
}

/** 进程内锁表：device_id → 锁状态。模块级单例（与 DeviceManager.shared 同风格）。 */
const locks = new Map<string, LockState>();

/** 设备当前是否被占用（进程内视角）。 */
export function isDeviceBusy(deviceId: string): boolean {
  return locks.has(deviceId);
}

/** 构造占用冲突错误（快照当时的目的与已持有时长）。 */
function busyError(deviceId: string, state: LockState): DeviceBusyError {
  return new DeviceBusyError(deviceId, state.purpose, Date.now() - state.acquiredAt);
}

/**
 * 释放占用并交接给等待队列队首（FIFO）；队列空则彻底删除锁状态。
 * 只能由仍持有租约的一方触发（lease 的 released 标志保证一次性）。
 */
function releaseHolder(deviceId: string): void {
  const state = locks.get(deviceId);
  if (state === undefined) {
    return;
  }
  const next = state.waiters.shift();
  if (next === undefined) {
    locks.delete(deviceId);
    return;
  }
  state.purpose = next.purpose;
  state.acquiredAt = Date.now();
  logger.debug(`[device-lock] 设备 ${deviceId} 交接给「${next.purpose}」（FIFO 队列）`);
  next.grant();
}

/** 构造租约：released 标志保证 release 幂等且一次性。 */
function makeLease(deviceId: string, purpose: string): DeviceLease {
  let released = false;
  return {
    deviceId,
    purpose,
    release(): void {
      if (released) {
        return; // 幂等：重复释放是 no-op
      }
      released = true;
      releaseHolder(deviceId);
    },
  };
}

/**
 * 尝试占用设备：成功返回租约，失败（被占用且不等待/等待超时）抛中文
 * {@link DeviceBusyError}。
 *
 * @param deviceId 设备 ID（如 adb 序列号 / IP:端口）。
 * @param purpose 用途标识（如 "monitor" / "grab" / "checklist_grab"），出现在
 *                错误文案与日志里，用于向调用方解释谁在占用。
 * @param opts {@link AcquireDeviceOptions}；默认立即失败。
 */
export async function acquireDevice(
  deviceId: string,
  purpose: string,
  { waitMs = null }: AcquireDeviceOptions = {},
): Promise<DeviceLease> {
  const state = locks.get(deviceId);
  if (state === undefined) {
    locks.set(deviceId, { purpose, acquiredAt: Date.now(), waiters: [] });
    logger.debug(`[device-lock] 设备 ${deviceId} 被「${purpose}」占用`);
    return makeLease(deviceId, purpose);
  }

  if (waitMs === null || waitMs <= 0) {
    throw busyError(deviceId, state);
  }

  // FIFO 排队等待：持有方 release 时按入队顺序交接；超时出队并抛占用错误
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waiter: LockWaiter = {
      purpose,
      grant: () => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        resolve();
      },
    };
    timer = setTimeout(() => {
      const idx = state.waiters.indexOf(waiter);
      if (idx >= 0) {
        state.waiters.splice(idx, 1);
      }
      reject(busyError(deviceId, state));
    }, waitMs);
    state.waiters.push(waiter);
  });
  return makeLease(deviceId, purpose);
}

/**
 * 占用 → 执行 → 释放的组合器：`fn` 正常返回或抛错都经 finally 释放租约
 * （对应 Python `with` 语义）。
 *
 * @throws {@link DeviceBusyError} 设备被占用且未在 waitMs 内等到。
 */
export async function withDeviceLease<T>(
  deviceId: string,
  purpose: string,
  fn: (lease: DeviceLease) => Promise<T>,
  opts: AcquireDeviceOptions = {},
): Promise<T> {
  const lease = await acquireDevice(deviceId, purpose, opts);
  try {
    return await fn(lease);
  } finally {
    lease.release();
  }
}
