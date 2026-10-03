import { describe, expect, it } from "vitest";

import {
  monitorAvailability,
  MonitorResult,
  type MonitorOptions,
  type MonitorReportSnapshot,
} from "@core/damai/monitor";

import { monitorTaskInputSchema } from "@/app/monitor/schema";

import { isMonitorResultDict, makeMonitorRunner, parseMonitorProgressLine } from "./monitorRunner";
import type { MonitorRunnerInput } from "./monitorRunner";
import type { TaskRunContext } from "./manager";
import { TaskManager } from "./manager";
import { SimpleStopEvent } from "./stopEvent";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** fake monitor 的一次调用记录（透传断言用）。 */
interface FakeCall {
  deviceId: string;
  itemId: string;
  options: MonitorOptions;
}

/**
 * 构造依脚本依次 onReport 的 fake monitor（注入 makeMonitorRunner 的 deps.monitor）。
 *
 * reportLines：每次 onReport 调用期间 runner 同步产出的进度行（onReport →
 * onProgress 是同步链，用调用前后的行数差精确截取，不受启动行等干扰）。
 */
function makeFakeMonitor(
  script: Array<Omit<MonitorReportSnapshot, "errors">>,
  result: MonitorResult,
  lines: string[],
): { calls: FakeCall[]; reportLines: string[]; fake: typeof monitorAvailability } {
  const calls: FakeCall[] = [];
  const reportLines: string[] = [];
  const fake: typeof monitorAvailability = async (deviceId, itemId, options = {}) => {
    calls.push({ deviceId, itemId, options });
    for (const snapshot of script) {
      const before = lines.length;
      await options.onReport?.({ ...snapshot, errors: 0 });
      reportLines.push(...lines.slice(before));
    }
    return result;
  };
  return { calls, reportLines, fake };
}

/** 构造 fake 的终局 MonitorResult（字段取自 MonitorResultInit，全字段显式）。 */
function fakeResult(
  overrides: Partial<ConstructorParameters<typeof MonitorResult>[0]> = {},
): MonitorResult {
  return new MonitorResult({
    found: true,
    finalStatus: "available",
    attempts: 3,
    consecutiveErrors: 0,
    stopReason: "available",
    detailUrl: "https://m.damai.cn/damai/detail/item.html?itemId=1001",
    lastReason: "立即购买",
    elapsedMs: 64000,
    error: null,
    ...overrides,
  });
}

/** 直接调用执行体的上下文：进度行收集进同一数组（供 makeFakeMonitor 截取）。 */
function makeCtx(lines: string[]): TaskRunContext {
  return {
    taskId: "task-test",
    stopEvent: new SimpleStopEvent(),
    onProgress: (line) => lines.push(line),
  };
}

describe("makeMonitorRunner（注入 fake monitor）", () => {
  it("① 3 次 onReport 的进度行全部可被 parseMonitorProgressLine 解析回 {attempt,status}", async () => {
    const lines: string[] = [];
    const { reportLines, fake } = makeFakeMonitor(
      [
        { attempt: 1, status: "not_on_sale", reason: "未开售", nextDelayMs: 5000 },
        { attempt: 2, status: "sold_out", reason: "售罄", nextDelayMs: 5000 },
        { attempt: 3, status: "available", reason: "立即购买", nextDelayMs: null },
      ],
      fakeResult(),
      lines,
    );
    const returned = await makeMonitorRunner(
      { deviceId: "emu-1", itemId: "1001", intervalMs: 5000, maxAttempts: 3 },
      { monitor: fake },
    )(makeCtx(lines));

    expect(reportLines).toHaveLength(3);
    expect(reportLines.map((line) => parseMonitorProgressLine(line))).toEqual([
      { attempt: 1, status: "not_on_sale" },
      { attempt: 2, status: "sold_out" },
      { attempt: 3, status: "available" },
    ]);
    // 文案与 MCP 工具 damai_monitor_availability 的上报行同构（server.ts:997-1003）
    expect(reportLines[0]).toBe("第 1 次采样: not_on_sale（未开售），5s 后继续");
    expect(reportLines[2]).toBe("第 3 次采样: available（立即购买）");
    expect(returned).toBeDefined();
  });

  it("② 透传：fake 收到的 options 与 input 一致，stopEvent 直传（同一实例）", async () => {
    const lines: string[] = [];
    const input: MonitorRunnerInput = {
      deviceId: "emu-t",
      itemId: "2002",
      intervalMs: 15000,
      maxAttempts: 42,
      maxConsecutiveErrors: 7,
      openPage: false,
      deadlineUnixMs: 4102444800000,
    };
    const { calls, fake } = makeFakeMonitor(
      [],
      fakeResult({ found: false, stopReason: "max_attempts", finalStatus: "sold_out" }),
      lines,
    );
    const ctx = makeCtx(lines);
    await makeMonitorRunner(input, { monitor: fake })(ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.deviceId).toBe("emu-t");
    expect(calls[0]?.itemId).toBe("2002");
    const options = calls[0]?.options;
    expect(options?.intervalMs).toBe(15000);
    expect(options?.maxAttempts).toBe(42);
    expect(options?.maxConsecutiveErrors).toBe(7);
    expect(options?.openPage).toBe(false);
    expect(options?.deadlineUnixMs).toBe(4102444800000);
    expect(options?.stopEvent).toBe(ctx.stopEvent);
    expect(typeof options?.onReport).toBe("function");
  });

  it("③ 返回值 = MonitorResult.toDict 形状（全 snake_case）", async () => {
    const lines: string[] = [];
    const result = fakeResult();
    const { fake } = makeFakeMonitor([], result, lines);
    const returned = await makeMonitorRunner(
      { deviceId: "emu-1", itemId: "1001", intervalMs: 5000, maxAttempts: 3 },
      { monitor: fake },
    )(makeCtx(lines));

    expect(returned).toEqual(result.toDict());
    expect(returned).toMatchObject({
      found: true,
      final_status: "available",
      attempts: 3,
      consecutive_errors: 0,
      stop_reason: "available",
      detail_url: "https://m.damai.cn/damai/detail/item.html?itemId=1001",
      last_reason: "立即购买",
      elapsed_ms: 64000,
      error: null,
    });
    expect(isMonitorResultDict(returned)).toBe(true);
  });

  it("④ startAt 候场中出现 cancel：不调 monitor，任务快速收敛 cancelled", async () => {
    const mgr = new TaskManager();
    let monitorCalls = 0;
    const fake: typeof monitorAvailability = async () => {
      monitorCalls += 1;
      return fakeResult();
    };
    const startedAt = Date.now();
    const snap = mgr.start({
      kind: "monitor",
      deviceId: "emu-wait",
      label: "候场监控",
      runner: makeMonitorRunner(
        {
          deviceId: "emu-wait",
          itemId: "3003",
          intervalMs: 5000,
          maxAttempts: 3,
          startAtUnixMs: startedAt + 500, // 候场 500ms，取消发生在 ~30ms
        },
        { monitor: fake },
      ),
    });

    await sleep(30);
    const running = mgr.get(snap.id);
    expect(running?.status).toBe("running");
    expect(running?.progress.some((line) => line.startsWith("候场至"))).toBe(true);

    mgr.cancel(snap.id);
    await mgr.whenSettled(snap.id);
    const done = mgr.get(snap.id);
    expect(done?.status).toBe("cancelled");
    expect(monitorCalls).toBe(0); // 候场内取消：绝不惊动设备
    expect(done?.result).toBeNull(); // 直接 return，不产出 toDict
    const endedAt = done?.endedAtUnixMs ?? 0;
    expect(endedAt - startedAt).toBeLessThan(500); // 未等满整个候场
  });

  it("④b startAt 到点后正常进入采样（候场→monitor 正向路径）", async () => {
    const lines: string[] = [];
    let monitorCalls = 0;
    const fake: typeof monitorAvailability = async () => {
      monitorCalls += 1;
      return fakeResult();
    };
    const mgr = new TaskManager();
    const snap = mgr.start({
      kind: "monitor",
      deviceId: "emu-due",
      runner: makeMonitorRunner(
        {
          deviceId: "emu-due",
          itemId: "4004",
          intervalMs: 5000,
          maxAttempts: 3,
          startAtUnixMs: Date.now() + 120,
        },
        { monitor: fake },
      ),
    });
    await mgr.whenSettled(snap.id);
    const done = mgr.get(snap.id);
    expect(monitorCalls).toBe(1);
    expect(done?.status).toBe("succeeded");
    expect(done?.progress.some((line) => line.startsWith("候场至"))).toBe(true);
    expect(done?.progress[done.progress.length - 1]).toBe(
      "监控结束 stop_reason=available attempts=3 final_status=available",
    );
  });
});

describe("parseMonitorProgressLine", () => {
  it("⑤ 非采样行（启动/候场/结束/阶段/杂音）返回 null", () => {
    expect(
      parseMonitorProgressLine("监控启动 device=emu-1 item=1001 interval=5000ms max_attempts=3"),
    ).toBeNull();
    expect(parseMonitorProgressLine("候场至 19:30，到点开始采样")).toBeNull();
    expect(
      parseMonitorProgressLine("监控结束 stop_reason=max_attempts attempts=3 final_status=sold_out"),
    ).toBeNull();
    expect(parseMonitorProgressLine("阶段 → dump")).toBeNull();
    expect(parseMonitorProgressLine("")).toBeNull();
    expect(parseMonitorProgressLine("第 x 次采样: available")).toBeNull();
    expect(parseMonitorProgressLine("第 1 次采样: availableish")).toBeNull();
    expect(parseMonitorProgressLine("第 1 次采样: ")).toBeNull();
  });

  it("采样行：四种状态 + reason/nextDelay 后缀变体", () => {
    expect(parseMonitorProgressLine("第 1 次采样: available")).toEqual({
      attempt: 1,
      status: "available",
    });
    expect(parseMonitorProgressLine("第 2 次采样: not_on_sale，5s 后继续")).toEqual({
      attempt: 2,
      status: "not_on_sale",
    });
    expect(parseMonitorProgressLine("第 3 次采样: sold_out（售罄）")).toEqual({
      attempt: 3,
      status: "sold_out",
    });
    expect(parseMonitorProgressLine("第 4 次采样: unknown")).toEqual({
      attempt: 4,
      status: "unknown",
    });
    expect(parseMonitorProgressLine("第 12 次采样: unknown（dump 失败），10s 后继续")).toEqual({
      attempt: 12,
      status: "unknown",
    });
  });
});

describe("monitorTaskInputSchema（web 接线层边界）", () => {
  const base = { deviceId: "emu-1", itemId: "1001" };

  it("intervalMs=4999 拒绝（下界 5000）；5000 / 3600000 通过、3600001 拒绝", () => {
    expect(monitorTaskInputSchema.safeParse({ ...base, intervalMs: 4999 }).success).toBe(false);
    expect(monitorTaskInputSchema.safeParse({ ...base, intervalMs: 5000 }).success).toBe(true);
    expect(monitorTaskInputSchema.safeParse({ ...base, intervalMs: 3600000 }).success).toBe(true);
    expect(monitorTaskInputSchema.safeParse({ ...base, intervalMs: 3600001 }).success).toBe(false);
  });

  it("maxAttempts=0 拒绝（web 不给无限，区别于 MCP 工具的 min(0)）；1 通过", () => {
    expect(monitorTaskInputSchema.safeParse({ ...base, maxAttempts: 0 }).success).toBe(false);
    expect(monitorTaskInputSchema.safeParse({ ...base, maxAttempts: 1 }).success).toBe(true);
    expect(monitorTaskInputSchema.safeParse({ ...base, maxAttempts: 100001 }).success).toBe(false);
  });

  it("非法 startAt 拒绝（非 datetime-local / 语义无效日期 / 空串），合法值通过", () => {
    expect(monitorTaskInputSchema.safeParse({ ...base, startAt: "not-a-date" }).success).toBe(false);
    expect(
      monitorTaskInputSchema.safeParse({ ...base, startAt: "2026-13-40T25:61" }).success,
    ).toBe(false);
    expect(monitorTaskInputSchema.safeParse({ ...base, startAt: "" }).success).toBe(false);
    expect(monitorTaskInputSchema.safeParse({ ...base, startAt: "2026-10-03T19:00" }).success).toBe(
      true,
    );
  });

  it("缺省字段取默认：intervalMs=30000、maxAttempts=720、openPage=true、无起止时刻", () => {
    const parsed = monitorTaskInputSchema.parse(base);
    expect(parsed.intervalMs).toBe(30000);
    expect(parsed.maxAttempts).toBe(720);
    expect(parsed.openPage).toBe(true);
    expect(parsed.startAt).toBeUndefined();
    expect(parsed.endAt).toBeUndefined();
  });
});
