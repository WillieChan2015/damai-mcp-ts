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

export type TaskStatus = "running" | "cancelling" | "cancelled" | "succeeded" | "failed";

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

export class TaskManager {
  private readonly tasks = new Map<string, TaskEntry>();
  /** deviceId → 运行中/取消中的 taskId。任务终结时释放。 */
  private readonly deviceLocks = new Map<string, string>();

  /** 登记并启动一个任务，立即返回快照（不等待任务完成）。 */
  start(opts: TaskStartOptions): TaskSnapshot {
    const runningTaskId = this.deviceLocks.get(opts.deviceId);
    if (runningTaskId !== undefined) {
      throw new TaskConflictError(opts.deviceId, runningTaskId);
    }

    const id = generateTaskId();
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
    this.deviceLocks.set(opts.deviceId, id);
    void this.run(entry, opts.runner);
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
        }, forceAfterMs);
      }
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

  private async run(entry: TaskEntry, runner: TaskRunner): Promise<void> {
    try {
      const value = await runner({
        taskId: entry.id,
        stopEvent: entry.stopEvent,
        onProgress: (line) => this.pushProgress(entry, line),
      });
      if (value !== undefined) {
        entry.result = value;
      }
      entry.status = entry.stopEvent.isSet() ? "cancelled" : "succeeded";
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
      if (this.deviceLocks.get(entry.deviceId) === entry.id) {
        this.deviceLocks.delete(entry.deviceId);
      }
      const waiters = [...entry.settleWaiters];
      entry.settleWaiters = [];
      for (const fn of waiters) {
        fn();
      }
    }
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

const SINGLETON_KEY = "__damaiWebTaskManager";

/** globalThis 单例（D3）：dev HMR 重载本模块时返回同一实例。 */
export function getTaskManager(): TaskManager {
  const g = globalThis as unknown as Record<string, TaskManager | undefined>;
  const existing = g[SINGLETON_KEY];
  if (existing) {
    return existing;
  }
  const created = new TaskManager();
  g[SINGLETON_KEY] = created;
  return created;
}
