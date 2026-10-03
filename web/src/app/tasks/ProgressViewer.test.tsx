// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deriveActiveStage, ProgressViewer, TERMINAL_TASK_STATUSES } from "./ProgressViewer";

/**
 * 最小 EventSource 替身：记录实例与监听器，供测试用例手动 emit 事件。
 * jsdom 不内置 EventSource，组件在 mount 时会 new EventSource(...)。
 */
class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly url: string;
  closed = false;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }

  close(): void {
    this.closed = true;
  }

  /** 模拟服务端下发一条 SSE 事件（data 为 JSON 序列化后的载荷）。 */
  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) });
    }
  }
}

vi.stubGlobal("EventSource", MockEventSource);

afterEach(() => {
  cleanup();
  MockEventSource.instances = [];
});

describe("deriveActiveStage（阶段 → 流水线下标）", () => {
  it("空进度从第 0 格开始", () => {
    expect(deriveActiveStage([])).toBe(0);
  });

  it("任务参数行不参与匹配（旧版关键词猜测会把「观演人=2 人」误判成选人阶段）", () => {
    const line =
      "任务启动 device=df6a4ff7 item=1082041144079 场次=2026-10-18周日 18:30 " +
      "票档=看台588元 观演人=2 人 open_time=立即抢";
    expect(deriveActiveStage([line])).toBe(0);
  });

  it("阶段行按固定映射推进；未列出的阶段保持上一格", () => {
    const lines = [
      "任务启动 device=x item=y 观演人=2 人",
      "阶段 → ntp_sync",
      "阶段 → connectivity",
      "阶段 → login_check",
      "阶段 → grab_fire",
      "阶段 → some_future_phase",
    ];
    expect(deriveActiveStage(lines)).toBe(3);
  });

  it("预热/开票判定阶段分别落到 1 / 2", () => {
    expect(deriveActiveStage(["阶段 → preheat_open", "阶段 → freeze_check", "阶段 → preheat_warm_dump"])).toBe(1);
    expect(deriveActiveStage(["阶段 → countdown"])).toBe(2);
  });
});

describe("TERMINAL_TASK_STATUSES", () => {
  it("含四个终态，不含 running/cancelling", () => {
    for (const status of ["succeeded", "failed", "cancelled", "interrupted"]) {
      expect(TERMINAL_TASK_STATUSES.has(status)).toBe(true);
    }
    expect(TERMINAL_TASK_STATUSES.has("running")).toBe(false);
    expect(TERMINAL_TASK_STATUSES.has("cancelling")).toBe(false);
  });
});

describe("ProgressViewer SSE 生命周期", () => {
  it("running 状态事件不关流、不显示终态；进度行持续到达；终态事件才关流", () => {
    render(<ProgressViewer taskId="task-sse-1" />);
    const es = MockEventSource.instances.at(-1)!;
    expect(es.url).toBe("/api/tasks/task-sse-1/events");

    // 服务端建立连接时先发「当前状态」：running 不应关流
    act(() => {
      es.emit("status", { status: "running", error: null, result: null });
    });
    expect(es.closed).toBe(false);
    expect(screen.getByText("实时跟踪流 (SSE)")).toBeTruthy();

    // 进度行照常下发
    act(() => {
      es.emit("progress", { line: "阶段 → grab_fire", index: 1 });
    });
    expect(screen.getByText("阶段 → grab_fire")).toBeTruthy();

    // 终态事件：关流 + 显示终态
    act(() => {
      es.emit("status", { status: "failed", error: "详情页加载失败", result: { status: "failed" } });
    });
    expect(es.closed).toBe(true);
    expect(screen.getByText("failed")).toBeTruthy();
  });

  it("cancelling 属非终态：保持订阅，等真正的终态事件", () => {
    render(<ProgressViewer taskId="task-sse-2" />);
    const es = MockEventSource.instances.at(-1)!;
    act(() => {
      es.emit("status", { status: "cancelling", error: null, result: null });
    });
    expect(es.closed).toBe(false);
    act(() => {
      es.emit("status", { status: "cancelled", error: null, result: null });
    });
    expect(es.closed).toBe(true);
    expect(screen.getByText("cancelled")).toBeTruthy();
  });

  it("连接到已终结任务：初始 status 事件即终态，直接渲染终态并关流", () => {
    render(<ProgressViewer taskId="task-sse-3" />);
    const es = MockEventSource.instances.at(-1)!;
    act(() => {
      es.emit("progress", { line: "任务结束 status=failed", index: 0 });
      es.emit("status", { status: "succeeded", error: null, result: { status: "failed" } });
    });
    expect(es.closed).toBe(true);
    expect(screen.getByText("succeeded")).toBeTruthy();
  });
});
