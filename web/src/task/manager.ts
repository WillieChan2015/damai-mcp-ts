import { setTimeout as sleep } from "node:timers/promises";

import { DeviceLockfile, resolveLockfilePath } from "./lockfile";
import { createSqliteTaskStore, resolveTaskDbPath, type TaskStore } from "./persistence";
import { SimpleStopEvent } from "./stopEvent";

/** 任务 id：Web Crypto（Edge 与 Node ≥19 通用），保持本模块运行时中立（D8）。 */
function generateTaskId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Web 控制台的任务管理器（计划文档 D3/D4）。
 *
 * 设计约束：
 * - **框架无关**（D8）：本模块不得 import Next.js 的任何 API，全部为纯 TS；
 *   React/Next 只出现在 `app/` 壳层。
 * - **长任务绝不进请求生命周期**：Server Action / Route Handler 只做
 *   `start`（立即返回 taskId）/ `cancel`（置位 stopEvent）/ `list`；
 *   小时级任务（等开票）由本管理器持有的 Promise 承载。
 * - **单例**：经 {@link getTaskManager} 挂在 globalThis 上，dev HMR 模块重载
 *   时保持同一实例，运行中任务不被打断。
 */

export type TaskKind = "grab" | "monitor" | "custom";

/**
 * 任务状态。`interrupted`（Phase 2 persistence，additive）为启动恢复时对上个
 * 进程遗留 running/cancelling 行的历史标注——任务本身已随进程消失，只能如实
 * 标注，运行中任务绝不产出该状态。
 */
export type TaskStatus =
  | "running"
  | "cancelling"
  | "cancelled"
  | "succeeded"
  | "failed"
  | "interrupted";

/** 传给任务执行体的上下文。 */
export interface TaskRunContext {
  taskId: string;
  /** 置位后任务应在下一个检查点尽快退出（结构兼容 core 的 StopEvent）。 */
  stopEvent: SimpleStopEvent;
  /** 推一条进度/日志行（Phase 1 接 SSE 流）。 */
  onProgress: (line: string) => void;
}

/** 任务执行体：由调用方注入（Phase 1 里包装 damaiGrab / monitorAvailability）。 */
export type TaskRunner = (ctx: TaskRunContext) => Promise<unknown>;

export interface TaskStartOptions {
  kind: TaskKind;
  /** 绑定任务的设备序列号；同一设备同时只允许一个任务（D4）。 */
  deviceId: string;
  runner: TaskRunner;
  label?: string;
  /**
   * 抢票到这个 Unix 毫秒才占设备锁。在此之前监控可以同机运行。
   * 缺省或已到期则立即占锁。
   */
  lockAtUnixMs?: number;
}

/** 同设备已有运行中任务时抛出。 */
export class TaskConflictError extends Error {
  readonly deviceId: string;
  readonly runningTaskId: string;

  constructor(deviceId: string, runningTaskId: string) {
    super(`设备 ${deviceId} 已有运行中的任务 ${runningTaskId}（同一设备同时只允许一个任务）`);
    this.name = "TaskConflictError";
    this.deviceId = deviceId;
    this.runningTaskId = runningTaskId;
  }
}

/** 对外暴露的任务快照（不含任何可变内部引用）。 */
export interface TaskSnapshot {
  id: string;
  kind: TaskKind;
  deviceId: string;
  label: string;
  status: TaskStatus;
  startedAtUnixMs: number;
  endedAtUnixMs: number | null;
  /** cancel(forceAfterMs) 超时后任务仍未退出时置 true（JS 无法强杀 Promise，只能如实标注）。 */
  unresponsive: boolean;
  error: string | null;
  /** 进度/日志行（环形缓冲，最新在尾部）。 */
  progress: readonly string[];
  /** 全局进度总行数（含已被环形缓冲丢弃的行）；SSE 断线续传用。 */
  progressTotal: number;
  /** 任务执行体的返回值（如 runChecklist 的 toDict()）；未结束为 null。 */
  result: unknown;
}

const PROGRESS_CAP = 500;

/** 进度订阅回调：line 为日志行，index 为其全局序号（0-based，单调递增）。 */
export type ProgressSubscriber = (line: string, index: number) => void;

interface TaskEntry {
  id: string;
  kind: TaskKind;
  deviceId: string;
  label: string;
  status: TaskStatus;
  startedAtUnixMs: number;
  endedAtUnixMs: number | null;
  stopEvent: SimpleStopEvent;
  unresponsive: boolean;
  error: string | null;
  progress: string[];
  progressTotal: number;
  subscribers: Set<ProgressSubscriber>;
  result: unknown;
  cancelTimer: ReturnType<typeof setTimeout> | null;
  settleWaiters: Array<() => void>;
}

export interface CancelOptions {
  /** 超过该毫秒数任务仍未退出，则把快照标记为 unresponsive（仅标注，不中断）。 */
  forceAfterMs?: number;
}

/** TaskManager 可选依赖注入（Phase 2 persistence）：缺省全部关闭，行为与纯内存版完全一致。 */
export interface TaskManagerDeps {
  /** 任务持久化存储；缺省/null = 不持久化。 */
  store?: TaskStore | null;
  /** 跨进程设备锁（D4）；缺省/null = 只做单进程内存互斥。 */
  lockfile?: DeviceLockfile | null;
}

/** 等价于 Python 的 str(exc)：Error 取 message，其余 String()。 */
function excToStr(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

export class TaskManager {
  private readonly tasks = new Map<string, TaskEntry>();
  /** deviceId → 运行中/取消中的 taskId。任务终结时释放。 */
  private readonly deviceLocks = new Map<string, string>();
  /** 尚未占锁的抢票（含候场）。挡住同设备第二场抢票，不挡住监控。 */
  private readonly grabHolds = new Map<string, string>();
  /** 任务持久化存储（null = 不持久化）。 */
  private readonly store: TaskStore | null;
  /** 跨进程设备锁（null = 不做跨进程互斥）。 */
  private readonly lockfile: DeviceLockfile | null;

  /**
   * @param deps 可选依赖；缺省构造（`new TaskManager()`）时 store/lockfile 均为
   * null，不产生任何文件 I/O。注入 store 时构造函数内执行启动恢复：把落盘的
   * 历史任务重建为只读内存 entry，遗留 running/cancelling 行改标 interrupted。
   */
  constructor(deps?: TaskManagerDeps) {
    this.store = deps?.store ?? null;
    this.lockfile = deps?.lockfile ?? null;
    if (this.store) {
      this.restoreFromStore();
    }
  }

  /**
   * 启动恢复（仅当注入 store 时执行）：loadAll 把落盘历史逐行重建为只读内存 entry。
   *
   * - 遗留 running/cancelling 行（上个进程崩溃/退出时未收敛）改标 "interrupted"，
   *   endedAtUnixMs 缺失时补当前时刻，保证 whenSettled 对其立即 resolve；
   * - 不登记 deviceLocks（历史任务不占用设备，同设备可直接 start 新任务）、
   *   不挂 stopEvent/订阅者；
   * - progress/progressTotal 从 progress_tail/progress_total 恢复
   *   （SSE backlog 可回看历史行的尾部进度）。
   */
  private restoreFromStore(): void {
    let snapshots: TaskSnapshot[];
    try {
      snapshots = this.store!.loadAll();
    } catch (exc) {
      // store 合同要求自吞错误；此处兜底：恢复失败按无历史处理，不阻断启动
      console.error(`任务启动恢复失败（按无历史任务处理）: ${excToStr(exc)}`);
      return;
    }
    for (const snap of snapshots) {
      const interrupted = snap.status === "running" || snap.status === "cancelling";
      this.tasks.set(snap.id, {
        id: snap.id,
        kind: snap.kind,
        deviceId: snap.deviceId,
        label: snap.label,
        status: interrupted ? "interrupted" : snap.status,
        startedAtUnixMs: snap.startedAtUnixMs,
        endedAtUnixMs: snap.endedAtUnixMs ?? Date.now(),
        stopEvent: new SimpleStopEvent(),
        unresponsive: snap.unresponsive,
        error: snap.error,
        progress: [...snap.progress],
        progressTotal: snap.progressTotal,
        subscribers: new Set(),
        result: snap.result,
        cancelTimer: null,
        settleWaiters: [],
      });
    }
  }

  /** 登记并启动一个任务，立即返回快照（不等待任务完成）。 */
  start(opts: TaskStartOptions): TaskSnapshot {
    const lockAt = opts.lockAtUnixMs;
    const deferLock =
      opts.kind === "grab" &&
      typeof lockAt === "number" &&
      Number.isFinite(lockAt) &&
      lockAt > Date.now();
    const runningTaskId = this.deviceLocks.get(opts.deviceId);
    if (runningTaskId !== undefined) {
      const holder = this.tasks.get(runningTaskId);
      const shareWithMonitor = deferLock && holder?.kind === "monitor";
      if (!shareWithMonitor) {
        throw new TaskConflictError(opts.deviceId, runningTaskId);
      }
    }
    if (opts.kind === "grab") {
      const heldGrabId = this.grabHolds.get(opts.deviceId);
      if (heldGrabId !== undefined) {
        throw new TaskConflictError(opts.deviceId, heldGrabId);
      }
    }

    const id = generateTaskId();
    // 跨进程互斥（D4）：候场阶段不占锁。到预热点再占用。
    if (!deferLock) {
      this.lockfile?.acquire(opts.deviceId, id);
    }
    const entry: TaskEntry = {
      id,
      kind: opts.kind,
      deviceId: opts.deviceId,
      label: opts.label ?? `${opts.kind} ${opts.deviceId}`,
      status: "running",
      startedAtUnixMs: Date.now(),
      endedAtUnixMs: null,
      stopEvent: new SimpleStopEvent(),
      unresponsive: false,
      error: null,
      progress: [],
      progressTotal: 0,
      subscribers: new Set(),
      result: null,
      cancelTimer: null,
      settleWaiters: [],
    };
    this.tasks.set(id, entry);
    if (opts.kind === "grab") {
      this.grabHolds.set(opts.deviceId, id);
    }
    if (!deferLock) {
      this.deviceLocks.set(opts.deviceId, id);
    }
    // running 状态落盘（须先于 run：runner 若同步完成，终态 upsert 要覆盖在本条之后）
    this.persist(entry);
    void this.run(entry, opts.runner, deferLock ? lockAt : null);
    return this.snapshot(entry);
  }

  /**
   * 请求取消：置位 stopEvent 并把状态置为 cancelling。
   * 任务在下一个检查点退出后状态收敛为 cancelled；若超过 `forceAfterMs`
   * 仍未退出，快照标记 unresponsive（仅标注，JS 无法强杀 Promise）。
   */
  cancel(taskId: string, opts?: CancelOptions): TaskSnapshot {
    const entry = this.tasks.get(taskId);
    if (!entry) {
      throw new Error(`任务不存在: ${taskId}`);
    }
    if (entry.status === "running") {
      entry.stopEvent.set();
      entry.status = "cancelling";
      const forceAfterMs = opts?.forceAfterMs ?? 0;
      if (forceAfterMs > 0 && entry.cancelTimer === null) {
        entry.cancelTimer = setTimeout(() => {
          entry.unresponsive = true;
          this.persist(entry);
        }, forceAfterMs);
      }
      this.persist(entry);
    }
    return this.snapshot(entry);
  }

  get(taskId: string): TaskSnapshot | null {
    const entry = this.tasks.get(taskId);
    return entry ? this.snapshot(entry) : null;
  }

  list(): TaskSnapshot[] {
    return [...this.tasks.values()].map((entry) => this.snapshot(entry));
  }

  /** 当前被运行中/取消中任务占用的设备序列号。 */
  lockedDeviceIds(): string[] {
    return [...this.deviceLocks.keys()];
  }

  /** 等待任务终结（供 SSE 关流与测试使用）。 */
  whenSettled(taskId: string): Promise<void> {
    const entry = this.tasks.get(taskId);
    if (!entry) {
      return Promise.reject(new Error(`任务不存在: ${taskId}`));
    }
    if (entry.endedAtUnixMs !== null) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      entry.settleWaiters.push(resolve);
    });
  }

  /**
   * 订阅任务进度（SSE 路由用）。
   *
   * 先同步回放缓冲区内 index ≥ fromIndexExclusive 的行（补发断线期间的
   * backlog），再转入实时推送；返回退订函数。任务不存在时抛错。
   */
  subscribe(taskId: string, fromIndexExclusive: number, onLine: ProgressSubscriber): () => void {
    const entry = this.tasks.get(taskId);
    if (!entry) {
      throw new Error(`任务不存在: ${taskId}`);
    }
    const from = Math.max(0, Math.trunc(fromIndexExclusive));
    const offset = entry.progressTotal - entry.progress.length;
    for (let i = from; i < entry.progressTotal; i++) {
      onLine(entry.progress[i - offset]!, i);
    }
    const subscriber: ProgressSubscriber = (line, index) => {
      if (index >= from) {
        onLine(line, index);
      }
    };
    entry.subscribers.add(subscriber);
    return () => {
      entry.subscribers.delete(subscriber);
    };
  }

  private async run(entry: TaskEntry, runner: TaskRunner, lockAtUnixMs: number | null): Promise<void> {
    try {
      if (lockAtUnixMs !== null) {
        const leftBeforeLock = await this.waitToLock(entry, lockAtUnixMs);
        if (leftBeforeLock) {
          entry.status = "cancelled";
          return;
        }
      }
      const value = await runner({
        taskId: entry.id,
        stopEvent: entry.stopEvent,
        onProgress: (line) => this.pushProgress(entry, line),
      });
      if (value !== undefined) {
        entry.result = value;
      }
      if (orderAlreadyCommitted(value)) {
        entry.status = "succeeded";
        if (entry.stopEvent.isSet()) {
          this.pushProgress(entry, "确认点击已发出，请到订单页核对");
        }
      } else if (entry.stopEvent.isSet()) {
        entry.status = "cancelled";
      } else if (outcomeIsFailed(value)) {
        // runner 正常返回但业务终态是失败（checklist/damaiGrab 的 failed、
        // needs_human_captcha）——如实标 failed，不再一律标 succeeded。
        entry.status = "failed";
        entry.error = outcomeErrorOf(value);
      } else {
        entry.status = "succeeded";
      }
    } catch (exc) {
      entry.error = exc instanceof Error ? exc.message : String(exc);
      // 取消引发的异常（如 stopEvent 置位后的主动中止）归类为 cancelled 而非 failed
      entry.status = entry.stopEvent.isSet() ? "cancelled" : "failed";
    } finally {
      entry.endedAtUnixMs = Date.now();
      if (entry.cancelTimer !== null) {
        clearTimeout(entry.cancelTimer);
        entry.cancelTimer = null;
      }
      if (this.grabHolds.get(entry.deviceId) === entry.id) {
        this.grabHolds.delete(entry.deviceId);
      }
      if (this.deviceLocks.get(entry.deviceId) === entry.id) {
        this.deviceLocks.delete(entry.deviceId);
      }
      // 终态落盘 + 跨进程锁释放（均须先于 settle waiters 唤醒）
      this.persist(entry);
      this.releaseDeviceLock(entry);
      const waiters = [...entry.settleWaiters];
      entry.settleWaiters = [];
      for (const fn of waiters) {
        fn();
      }
    }
  }

  /** 状态落盘（store 合同要求自吞错误；此处兜底，防注入实现抛错拖垮任务）。 */
  private persist(entry: TaskEntry): void {
    if (!this.store) {
      return;
    }
    try {
      this.store.upsert(this.snapshot(entry));
    } catch (exc) {
      console.error(`任务状态落盘失败（忽略，不影响任务运行）: ${excToStr(exc)}`);
    }
  }

  /** 释放跨进程设备锁（release 幂等且自吞写失败；兜底防异常中断终态收敛）。 */
  private releaseDeviceLock(entry: TaskEntry): void {
    if (!this.lockfile) {
      return;
    }
    try {
      this.lockfile.release(entry.deviceId, entry.id);
    } catch (exc) {
      console.error(`跨进程设备锁释放失败（忽略，等过期清理兜底）: ${excToStr(exc)}`);
    }
  }

  /** 候场到预热点。返回 true 表示取消了，调用方不得再占锁或执行任务。 */
  private async waitToLock(entry: TaskEntry, lockAtUnixMs: number): Promise<boolean> {
    this.pushProgress(entry, "候场，设备未占用");
    const delayMs = lockAtUnixMs - Date.now();
    if (delayMs > 0) {
      const abort = new AbortController();
      try {
        const cancelled = await Promise.race([
          entry.stopEvent.wait().then(() => true),
          sleep(delayMs, undefined, { signal: abort.signal }).then(() => false),
        ]);
        if (cancelled || entry.stopEvent.isSet()) {
          return true;
        }
      } finally {
        abort.abort();
      }
    }
    if (entry.stopEvent.isSet()) {
      return true;
    }
    await this.takeDeviceLock(entry);
    return entry.stopEvent.isSet();
  }

  /** 预热前取消同设备监控，等它退出后再占内存锁和跨进程锁。 */
  private async takeDeviceLock(entry: TaskEntry): Promise<void> {
    const holderId = this.deviceLocks.get(entry.deviceId);
    if (holderId !== undefined && holderId !== entry.id) {
      const holder = this.tasks.get(holderId);
      if (holder?.kind === "monitor" && holder.endedAtUnixMs === null) {
        this.cancel(holderId);
        await this.whenSettled(holderId);
      }
    }
    if (entry.stopEvent.isSet()) {
      return;
    }
    const stillHeld = this.deviceLocks.get(entry.deviceId);
    if (stillHeld !== undefined && stillHeld !== entry.id) {
      throw new TaskConflictError(entry.deviceId, stillHeld);
    }
    this.lockfile?.acquire(entry.deviceId, entry.id);
    this.deviceLocks.set(entry.deviceId, entry.id);
    this.pushProgress(entry, "已占用设备");
  }

  private pushProgress(entry: TaskEntry, line: string): void {
    entry.progress.push(line);
    entry.progressTotal += 1;
    if (entry.progress.length > PROGRESS_CAP) {
      entry.progress.splice(0, entry.progress.length - PROGRESS_CAP);
    }
    const index = entry.progressTotal - 1;
    for (const subscriber of [...entry.subscribers]) {
      try {
        subscriber(line, index);
      } catch {
        // 订阅者（SSE 流）出错不拖垮任务本身
      }
    }
  }

  private snapshot(entry: TaskEntry): TaskSnapshot {
    return {
      id: entry.id,
      kind: entry.kind,
      deviceId: entry.deviceId,
      label: entry.label,
      status: entry.status,
      startedAtUnixMs: entry.startedAtUnixMs,
      endedAtUnixMs: entry.endedAtUnixMs,
      unresponsive: entry.unresponsive,
      error: entry.error,
      progress: [...entry.progress],
      progressTotal: entry.progressTotal,
      result: entry.result,
    };
  }
}

function orderAlreadyCommitted(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as {
    status?: unknown;
    grab_result?: { status?: unknown } | null;
  };
  return [record.status, record.grab_result?.status].some(
    (status) => status === "needs_action" || status === "submitted",
  );
}

/** 抢票/checklist 形态返回值（ChecklistResultDict / GrabResult）的顶层业务终态；
 * monitor 与 custom 任务的返回值没有顶层 status 字段，返回 null。 */
function outcomeStatusOf(value: unknown): string | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const status = (value as { status?: unknown }).status;
  return typeof status === "string" ? status : null;
}

/** 业务终态映射为 failed 的状态集合：runner 正常返回但目标未达成（滑块拦截
 * 与显式 failed）。ready_for_human / submitted / needs_action 属正常达成或交接。 */
const FAILED_OUTCOME_STATUSES: ReadonlySet<string> = new Set([
  "failed",
  "needs_human_captcha",
]);

/** 业务终态是否为失败（见 {@link FAILED_OUTCOME_STATUSES}）。 */
function outcomeIsFailed(value: unknown): boolean {
  const status = outcomeStatusOf(value);
  return status !== null && FAILED_OUTCOME_STATUSES.has(status);
}

/** 失败终态的原因文案：优先 checklist 顶层 error，缺省回落 grab_result.error。 */
function outcomeErrorOf(value: unknown): string | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const record = value as { error?: unknown; grab_result?: unknown };
  if (typeof record.error === "string" && record.error !== "") {
    return record.error;
  }
  if (record.grab_result !== null && typeof record.grab_result === "object") {
    const grabError = (record.grab_result as { error?: unknown }).error;
    if (typeof grabError === "string" && grabError !== "") {
      return grabError;
    }
  }
  return null;
}

const SINGLETON_KEY = "__damaiWebTaskManager";

/** globalThis 单例（D3）：dev HMR 重载本模块时返回同一实例。 */
export function getTaskManager(): TaskManager {
  const g = globalThis as unknown as Record<string, TaskManager | undefined>;
  const existing = g[SINGLETON_KEY];
  if (existing) {
    return existing;
  }
  // 注入持久化与跨进程锁（Phase 2）：store 为 better-sqlite3 惰性打开
  // （首次 upsert/loadAll 才建文件）、lockfile 构造零副作用，
  // 因此仅比对单例身份的测试路径不产生任何文件 I/O。
  const created = new TaskManager({
    store: createSqliteTaskStore(resolveTaskDbPath()),
    lockfile: new DeviceLockfile(resolveLockfilePath()),
  });
  g[SINGLETON_KEY] = created;
  return created;
}
