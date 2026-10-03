/**
 * 任务状态落盘（Phase 2 persistence）：better-sqlite3 存储，默认
 * `<cwd>/data/tasks.db`（cli 拓扑下 cli.ts:585-586 以 web/ 为 cwd ⇒
 * `web/data/tasks.db`），WAL 模式。
 *
 * 设计约束：
 * - **惰性初始化**：Database 在首次 upsert/loadAll 时才打开，构造与导入
 *   零副作用——保证 `getTaskManager()` 单例身份测试不产生任何文件。
 * - **失败降级**：open 失败（文件损坏/权限/原生模块问题）或写库异常一律
 *   吞掉并 console.error 中文告警，降级为 no-op 存储，绝不阻断任务运行
 *   （对齐 TaskManager 订阅者容错语义）。
 * - **运行时中立**：不 import Next.js 的任何 API；better-sqlite3 在
 *   next.config.ts 的 serverExternalPackages 中（原生模块交给 Node 运行时
 *   require，不参与打包）。
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";

import type { TaskKind, TaskSnapshot, TaskStatus } from "./manager";

/** 任务存储最小接口（manager 只依赖此接口，不感知 sqlite）。 */
export interface TaskStore {
  /** 任务状态/快照任何变化时整体覆盖写（按主键 id）。实现方应自吞错误不抛。 */
  upsert(snapshot: TaskSnapshot): void;
  /** 启动恢复：读全部历史行（进度只回放尾部 ≤{@link PROGRESS_TAIL_CAP} 行，与内存环形缓冲同语义）。 */
  loadAll(): TaskSnapshot[];
  /** 进程退出钩子；实现方必须幂等（close 后再调用 upsert/loadAll 视为 no-op）。 */
  close(): void;
}

/** 进度尾部截断上限（与 manager 的 PROGRESS_CAP 同值：只存环形缓冲内还能看到的行）。 */
export const PROGRESS_TAIL_CAP = 500;

/** 默认 <cwd>/data/tasks.db（cli 拓扑下 cli.ts:585-586 以 web/ 为 cwd ⇒ web/data/tasks.db）。 */
export function resolveTaskDbPath(): string {
  return process.env.DAMAI_WEB_TASK_DB ?? join(process.cwd(), "data", "tasks.db");
}

/** 等价于 Python 的 str(exc)：Error 取 message，其余 String()。 */
function excToStr(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** 落库合法的 status 集合（含跨进程恢复标注的 interrupted）。 */
const KNOWN_STATUSES: readonly TaskStatus[] = [
  "running",
  "cancelling",
  "cancelled",
  "succeeded",
  "failed",
  "interrupted",
];

/** 落库合法的 kind 集合（与 manager 的 TaskKind 同步）。 */
const KNOWN_KINDS: readonly TaskKind[] = ["grab", "monitor", "custom"];

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id                 TEXT PRIMARY KEY,
  kind               TEXT NOT NULL,
  device_id          TEXT NOT NULL,
  label              TEXT NOT NULL,
  status             TEXT NOT NULL,
  started_at_unix_ms INTEGER NOT NULL,
  ended_at_unix_ms   INTEGER,
  unresponsive       INTEGER NOT NULL DEFAULT 0,
  error              TEXT,
  result             TEXT,
  progress_total     INTEGER NOT NULL DEFAULT 0,
  progress_tail      TEXT
)`.trim();

const UPSERT_SQL = `
INSERT INTO tasks (
  id, kind, device_id, label, status, started_at_unix_ms, ended_at_unix_ms,
  unresponsive, error, result, progress_total, progress_tail
) VALUES (
  @id, @kind, @device_id, @label, @status, @started_at_unix_ms, @ended_at_unix_ms,
  @unresponsive, @error, @result, @progress_total, @progress_tail
)
ON CONFLICT(id) DO UPDATE SET
  kind               = excluded.kind,
  device_id          = excluded.device_id,
  label              = excluded.label,
  status             = excluded.status,
  started_at_unix_ms = excluded.started_at_unix_ms,
  ended_at_unix_ms   = excluded.ended_at_unix_ms,
  unresponsive       = excluded.unresponsive,
  error              = excluded.error,
  result             = excluded.result,
  progress_total     = excluded.progress_total,
  progress_tail      = excluded.progress_tail`.trim();

const LOAD_ALL_SQL = `
SELECT id, kind, device_id, label, status, started_at_unix_ms, ended_at_unix_ms,
       unresponsive, error, result, progress_total, progress_tail
FROM tasks
ORDER BY started_at_unix_ms ASC, id ASC`.trim();

/** 具名参数语句类型（绑定对象传参）。 */
type NamedStatement = Database.Statement<Record<string, unknown>>;

/** JSON.stringify 容错：循环引用等不可序列化值降级为 null（result 仅展示用，不值得抛错）。 */
function stringifyOrNull(value: unknown, context: string): string | null {
  if (value === undefined) {
    return null;
  }
  try {
    return JSON.stringify(value) ?? null;
  } catch (exc) {
    console.error(`任务持久化序列化 ${context} 失败（降级存 null）: ${excToStr(exc)}`);
    return null;
  }
}

/** JSON.parse 容错：损坏 JSON 降级为 null。 */
function parseOrNull(text: string | null, context: string): unknown {
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (exc) {
    console.error(`任务持久化解析 ${context} 失败（降级为 null）: ${excToStr(exc)}`);
    return null;
  }
}

/**
 * 把一行数据库记录还原为 TaskSnapshot；字段缺失/类型非法时返回 null
 * （调用方跳过该行并告警，绝不让单个坏行阻断启动恢复）。
 */
function rowToSnapshot(row: Record<string, unknown>): TaskSnapshot | null {
  const id = row.id;
  const kind = row.kind;
  const deviceId = row.device_id;
  const label = row.label;
  const status = row.status;
  const startedAt = row.started_at_unix_ms;
  if (
    typeof id !== "string" ||
    typeof kind !== "string" ||
    typeof deviceId !== "string" ||
    typeof label !== "string" ||
    typeof status !== "string" ||
    typeof startedAt !== "number" ||
    !Number.isFinite(startedAt)
  ) {
    return null;
  }
  if (!KNOWN_KINDS.includes(kind as TaskKind) || !KNOWN_STATUSES.includes(status as TaskStatus)) {
    return null;
  }
  const endedRaw = row.ended_at_unix_ms;
  const totalRaw = row.progress_total;
  const progressTotal =
    typeof totalRaw === "number" && Number.isFinite(totalRaw) && totalRaw >= 0
      ? Math.trunc(totalRaw)
      : 0;
  let progress: string[] = [];
  const tailRaw = row.progress_tail;
  if (typeof tailRaw === "string") {
    const parsed = parseOrNull(tailRaw, "progress_tail");
    if (Array.isArray(parsed)) {
      progress = parsed.filter((line): line is string => typeof line === "string");
    }
  }
  return {
    id,
    kind: kind as TaskKind,
    deviceId,
    label,
    status: status as TaskStatus,
    startedAtUnixMs: startedAt,
    endedAtUnixMs:
      typeof endedRaw === "number" && Number.isFinite(endedRaw) ? endedRaw : null,
    unresponsive: row.unresponsive === 1 || row.unresponsive === "1",
    error: typeof row.error === "string" ? row.error : null,
    progress,
    progressTotal,
    result: parseOrNull(typeof row.result === "string" ? row.result : null, "result"),
  };
}

/**
 * better-sqlite3 落盘存储。惰性初始化：Database 在首次 upsert/loadAll 时才打开，
 * 构造与导入零副作用（保证 getTaskManager() 单例测试不产生文件）。
 * open 失败（文件损坏/权限）→ 降级为 no-op 存储 + console.error 中文告警，
 * 绝不阻断任务运行；close 后本实例永久停用（幂等）。
 */
class SqliteTaskStore implements TaskStore {
  private db: Database.Database | null = null;
  private upsertStmt: NamedStatement | null = null;
  private loadAllStmt: Database.Statement<[], Record<string, unknown>> | null = null;
  /** open 已失败：本实例永久降级为 no-op，避免每次调用重复告警。 */
  private openFailed = false;
  /** close 已调用：本实例永久停用（幂等语义）。 */
  private closed = false;

  constructor(private readonly dbPath: string) {}

  upsert(snapshot: TaskSnapshot): void {
    const stmt = this.ensureOpen()?.upsertStmt;
    if (!stmt) {
      return;
    }
    try {
      stmt.run({
        id: snapshot.id,
        kind: snapshot.kind,
        device_id: snapshot.deviceId,
        label: snapshot.label,
        status: snapshot.status,
        started_at_unix_ms: snapshot.startedAtUnixMs,
        ended_at_unix_ms: snapshot.endedAtUnixMs,
        unresponsive: snapshot.unresponsive ? 1 : 0,
        error: snapshot.error,
        result: stringifyOrNull(snapshot.result, "result"),
        progress_total: snapshot.progressTotal,
        progress_tail: JSON.stringify(
          snapshot.progress.slice(-PROGRESS_TAIL_CAP),
        ),
      });
    } catch (exc) {
      // 写库失败吞掉降级 no-op：持久化失败绝不拖垮任务本身
      console.error(`任务状态写库失败（${this.dbPath}，降级不重试）: ${excToStr(exc)}`);
    }
  }

  loadAll(): TaskSnapshot[] {
    // db 文件不存在时按空历史处理且不打开：读路径零文件创建——保证
    // getTaskManager() 单例身份测试等只读路径不产生任何文件（§1.4 惰性语义）。
    // 真实恢复场景里 start 的首次 upsert 会建库建表，此后 loadAll 正常打开。
    if (!existsSync(this.dbPath)) {
      return [];
    }
    const stmt = this.ensureOpen()?.loadAllStmt;
    if (!stmt) {
      return [];
    }
    try {
      const rows = stmt.all();
      const snapshots: TaskSnapshot[] = [];
      for (const row of rows) {
        const snapshot = rowToSnapshot(row);
        if (snapshot) {
          snapshots.push(snapshot);
        } else {
          console.error(`任务持久化读到非法行（已跳过）: ${JSON.stringify(row.id ?? row)}`);
        }
      }
      return snapshots;
    } catch (exc) {
      console.error(`任务持久化读库失败（按空历史处理）: ${excToStr(exc)}`);
      return [];
    }
  }

  close(): void {
    // 先置空再关闭：保证 close 幂等（二次调用直接 no-op）
    const db = this.db;
    this.db = null;
    this.upsertStmt = null;
    this.loadAllStmt = null;
    this.closed = true;
    if (!db) {
      return;
    }
    try {
      db.close();
    } catch (exc) {
      console.error(`任务持久化关闭数据库失败: ${excToStr(exc)}`);
    }
  }

  /** 惰性打开：首次调用才创建 Database/建表/预编译语句；失败永久降级。 */
  private ensureOpen(): this | null {
    if (this.closed) {
      return null;
    }
    if (this.db) {
      return this;
    }
    if (this.openFailed) {
      return null;
    }
    let db: Database.Database | null = null;
    try {
      mkdirSync(dirname(this.dbPath), { recursive: true });
      db = new Database(this.dbPath);
      db.pragma("journal_mode = WAL");
      db.exec(CREATE_TABLE_SQL);
      this.upsertStmt = db.prepare<Record<string, unknown>>(UPSERT_SQL);
      this.loadAllStmt = db.prepare<[], Record<string, unknown>>(LOAD_ALL_SQL);
      this.db = db;
      return this;
    } catch (exc) {
      // 打开/建表失败（文件损坏、权限、原生模块异常）：永久降级为 no-op
      try {
        db?.close();
      } catch {
        // 清理失败不影响降级结论
      }
      this.openFailed = true;
      console.error(`任务持久化初始化失败（${this.dbPath}），已降级为不持久化: ${excToStr(exc)}`);
      return null;
    }
  }
}

/**
 * 创建 better-sqlite3 落盘任务存储（构造零副作用，Database 首次 upsert/loadAll 才打开）。
 *
 * @param dbPath 数据库文件路径（通常传 {@link resolveTaskDbPath} 的结果）。
 */
export function createSqliteTaskStore(dbPath: string): TaskStore {
  return new SqliteTaskStore(dbPath);
}
