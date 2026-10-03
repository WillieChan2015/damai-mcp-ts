/**
 * 监控进度 / 结果的纯解析辅助（Phase 2/3 设计 §3.2）。
 *
 * 独立于 monitorRunner 存在的原因：MonitorTaskList 等客户端组件只需要行解析
 * 与结果收窄，不需要 core 的 monitorAvailability（其依赖链会拉入 pino/adb 等
 * Node 专属模块，Turbopack 打包浏览器端直接报 Module not found: fs）。
 * 本模块对 core 只允许 `import type`（编译期擦除，零运行时依赖）。
 */
import type { Availability, MonitorStopReason } from "@core/damai/monitor";

/** {@link parseMonitorProgressLine} 的返回类型：一次采样快照的解析结果。 */
export interface MonitorProgressSample {
  /** 采样序号（第 n 次）。 */
  attempt: number;
  /** 本次判定的四态状态。 */
  status: Availability;
}

/**
 * 采样进度行的固定行首格式：`第 <n> 次采样: <status>`（makeMonitorRunner 写出）。
 * 状态后只允许行尾 / reason 括号 / 「，Ns 后继续」后缀，防止 `unknown2` 之类误配。
 */
const PROGRESS_LINE_RE = /^第 (\d+) 次采样: (available|not_on_sale|sold_out|unknown)(?![a-z0-9_])/;

/**
 * 从监控进度行解析采样快照（运行中徽标渲染用）。
 *
 * 仅采样行可解析；候场行、结束行、启动行等非采样行一律返回 null。
 */
export function parseMonitorProgressLine(line: string): MonitorProgressSample | null {
  const match = PROGRESS_LINE_RE.exec(line);
  if (match === null) {
    return null;
  }
  return { attempt: Number(match[1]), status: match[2] as Availability };
}

/** {@link MonitorResult.toDict} 的形状（全 snake_case，monitor.ts:238-260）。 */
export interface MonitorResultDict {
  /** 是否判定有票后提前返回。 */
  found: boolean;
  /** 最后一次成功判定的状态。 */
  final_status: Availability;
  /** 已完成的尝试次数。 */
  attempts: number;
  /** 停止时刻的连续失败计数。 */
  consecutive_errors: number;
  /** 停止原因。 */
  stop_reason: MonitorStopReason;
  /** 详情页 URL（供 found=true 时渲染外链）。 */
  detail_url: string;
  /** 最后一次判定的命中证据；无则 null。 */
  last_reason: string | null;
  /** 总耗时毫秒。 */
  elapsed_ms: number;
  /** 停止相关的中文错误描述；其余为 null。 */
  error: string | null;
}

/** 运行时收窄 TaskSnapshot.result（unknown）为 {@link MonitorResultDict}。 */
export function isMonitorResultDict(value: unknown): value is MonitorResultDict {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.found === "boolean" &&
    (v.final_status === "available" ||
      v.final_status === "not_on_sale" ||
      v.final_status === "sold_out" ||
      v.final_status === "unknown") &&
    typeof v.attempts === "number" &&
    typeof v.consecutive_errors === "number" &&
    typeof v.stop_reason === "string" &&
    typeof v.detail_url === "string" &&
    (v.last_reason === null || typeof v.last_reason === "string") &&
    typeof v.elapsed_ms === "number" &&
    (v.error === null || typeof v.error === "string")
  );
}
