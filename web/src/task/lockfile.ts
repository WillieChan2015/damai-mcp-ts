/**
 * 跨进程设备锁（Phase 2 D4）：以仓库根 `.damai-web.lock`（JSON 文件）在
 * 多个 web 进程之间对同一设备提供互斥——内存锁（TaskManager.deviceLocks）
 * 只覆盖单进程，dev 多实例/多终端同时操作同一台设备时需要跨进程仲裁。
 *
 * 语义：
 * - 文件内容为 `Record<deviceId, DeviceLockRecord>`；写入对齐 core 凭证存储的
 *   原子写先例（src/notify/credentials.ts:102-122）：`<file>.tmp.<pid>` 以 0o600
 *   创建 → rename 原子替换 → chmod 0o600 双保险，写一半崩溃不会留下半截锁文件。
 * - acquire 先清理全部过期条目（pid 不存活 或 持有时长超 staleAfterMs，默认
 *   10 分钟）再占用；被其他存活进程持有 → 抛 TaskConflictError（与内存锁同一
 *   错误类型，UI 语义不变）。文件损坏（非法 JSON）→ 视为无锁并重写 + 告警。
 * - release 幂等：仅当条目 taskId 匹配才移除，绝不误删他人条目。
 *
 * 已知边界（如实标注）：
 * - MCP 进程（stdio）不写此锁（core 不改），该锁只防「多个 web 进程」之间的
 *   同设备并发；web 与 MCP 的并发仍按 D4 以 UI 常驻警示 + 文档缓解。
 * - 「读文件→判断→写回」非原子的 check-then-act 窗口内，两进程可能同时判定
 *   无锁并先后写入（后写者胜出）；配合 10 分钟过期清理与 TaskConflictError
 *   的 UI 提示，按 best-effort 互斥定位，不追求强一致。
 */

import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { TaskConflictError } from "./manager";

/** 锁文件中的一条设备占用记录。 */
export interface DeviceLockRecord {
  deviceId: string;
  taskId: string;
  /** 持锁进程 pid（探活与过期判断用）。 */
  pid: number;
  /** 取锁时刻（Unix 毫秒）。 */
  heldAtUnixMs: number;
}

/** 锁文件内容：deviceId → 占用记录。 */
type DeviceLockTable = Record<string, DeviceLockRecord>;

export interface DeviceLockfileDeps {
  /** 默认 process.kill(pid, 0) 探活；测试注入。 */
  isPidAlive?: (pid: number) => boolean;
  now?: () => number;
  /** 持有时长超过该值视为过期，默认 10 分钟。 */
  staleAfterMs?: number;
}

/** 默认过期阈值：10 分钟（远大于任何正常任务检查点间隔，防 pid 复用误判）。 */
const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000;

/** 锁路径：仓库根 `.damai-web.lock`（cli 拓扑下 cwd=web/ ⇒ resolve(cwd, "..") 即仓库根）。 */
export function resolveLockfilePath(): string {
  return process.env.DAMAI_WEB_LOCK_FILE ?? resolve(process.cwd(), "..", ".damai-web.lock");
}

/** 等价于 Python 的 str(exc)：Error 取 message，其余 String()。 */
function excToStr(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** 默认探活：kill(pid, 0) 不抛 = 存活；EPERM（无权限发信号）也算存活，ESRCH 才算死。 */
function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (exc) {
    return exc instanceof Error && (exc as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 校验一条记录形状是否完整（损坏条目按无锁处理）。 */
function isValidRecord(value: unknown, deviceId: string): value is DeviceLockRecord {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.taskId === "string" &&
    record.taskId !== "" &&
    typeof record.pid === "number" &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.heldAtUnixMs === "number" &&
    Number.isFinite(record.heldAtUnixMs) &&
    (record.deviceId === undefined || record.deviceId === deviceId)
  );
}

/**
 * 跨进程设备锁（JSON 文件 + 原子替换写）。构造零副作用（不读不写任何文件），
 * 文件 I/O 全部发生在 acquire/release 调用内，便于测试注入。
 */
export class DeviceLockfile {
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly now: () => number;
  private readonly staleAfterMs: number;

  constructor(private readonly lockPath: string, deps?: DeviceLockfileDeps) {
    this.isPidAlive = deps?.isPidAlive ?? defaultIsPidAlive;
    this.now = deps?.now ?? (() => Date.now());
    this.staleAfterMs = deps?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  }

  /**
   * 先清理全部过期条目（pid 不存活 或 now-heldAt > staleAfterMs），再尝试占用
   * deviceId：被其他存活进程持有 → 抛 TaskConflictError(deviceId, holder.taskId)；
   * 成功 → 原子写入本条目。文件损坏（非法 JSON）→ 视为无锁并重写 + 告警。
   *
   * @throws TaskConflictError 同设备被其他存活进程持有；中文 Error 锁文件写入失败。
   */
  acquire(deviceId: string, taskId: string): void {
    const table = this.readTable();
    const nowMs = this.now();
    // 先清理过期条目（含本设备）：pid 已死或持锁超时的记录不构成冲突
    const live: DeviceLockTable = {};
    for (const [key, record] of Object.entries(table)) {
      const expired = !this.isPidAlive(record.pid) || nowMs - record.heldAtUnixMs > this.staleAfterMs;
      if (!expired) {
        live[key] = record;
      }
    }
    const holder = live[deviceId];
    if (holder) {
      throw new TaskConflictError(deviceId, holder.taskId);
    }
    live[deviceId] = { deviceId, taskId, pid: process.pid, heldAtUnixMs: nowMs };
    this.writeTable(live);
  }

  /** 幂等释放：仅当条目 taskId 匹配才移除（绝不误删他人条目）；写失败只告警不抛。 */
  release(deviceId: string, taskId: string): void {
    const table = this.readTable();
    const record = table[deviceId];
    if (!record || record.taskId !== taskId) {
      return; // 已被过期清理/他人占用/本就无锁：幂等 no-op
    }
    delete table[deviceId];
    try {
      this.writeTable(table);
    } catch (exc) {
      // 释放失败不抛：锁条目会在 ≤staleAfterMs 内被过期清理，终态收敛优先
      console.error(`释放跨进程设备锁失败（${this.lockPath}，等过期清理兜底）: ${excToStr(exc)}`);
    }
  }

  /**
   * 读锁文件：缺失/损坏/含非法条目一律降级（损坏 → 视为无锁 + 告警），
   * 不让坏文件永久锁死设备。
   */
  private readTable(): DeviceLockTable {
    let text: string;
    try {
      text = readFileSync(this.lockPath, "utf-8");
    } catch (exc) {
      if (exc instanceof Error && (exc as NodeJS.ErrnoException).code === "ENOENT") {
        return {}; // 缺失 = 无锁
      }
      console.error(`读取跨进程设备锁失败（${this.lockPath}，按无锁处理）: ${excToStr(exc)}`);
      return {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      console.error(`跨进程设备锁文件损坏（${this.lockPath}），视为无锁并将在下次占用时重写`);
      return {};
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error(`跨进程设备锁文件内容非法（${this.lockPath}），视为无锁并将在下次占用时重写`);
      return {};
    }
    const table: DeviceLockTable = {};
    let dropped = false;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isValidRecord(value, key)) {
        table[key] = { deviceId: key, taskId: value.taskId, pid: value.pid, heldAtUnixMs: value.heldAtUnixMs };
      } else {
        dropped = true;
      }
    }
    if (dropped) {
      console.error(`跨进程设备锁文件含非法条目（${this.lockPath}），已忽略并在下次占用时重写`);
    }
    return table;
  }

  /**
   * 原子写整表：`<file>.tmp.<pid>` 以 0o600 创建 → rename 原子替换 → chmod 0o600
   * 双保险（对齐 src/notify/credentials.ts:102-122 先例）。
   *
   * @throws 中文 Error：任一文件系统步骤失败（临时文件会被尽力清理）。
   */
  private writeTable(table: DeviceLockTable): void {
    const tmp = `${this.lockPath}.tmp.${process.pid}`;
    try {
      mkdirSync(dirname(this.lockPath), { recursive: true });
      // open(..., "w", 0o600)：0o600 不含 group/other 位，umask 去位后仍 ≤ 0o600
      const handle = openSync(tmp, "w", 0o600);
      try {
        writeSync(handle, JSON.stringify(table, null, 2), 0, "utf-8");
      } finally {
        closeSync(handle);
      }
      // 同目录 rename：原子替换，写一半崩溃时旧锁文件保持可用
      renameSync(tmp, this.lockPath);
      // 双保险：上一次崩溃可能残留宽权限 tmp，"w" 复用时不改已有权限
      chmodSync(this.lockPath, 0o600);
    } catch (exc) {
      try {
        unlinkSync(tmp);
      } catch {
        // 清理失败不影响原始错误
      }
      throw new Error(`写入跨进程设备锁文件失败（${this.lockPath}）: ${excToStr(exc)}`);
    }
  }
}
