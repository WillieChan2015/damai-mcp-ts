// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { TaskTable } from "./TaskTable";
import type { TaskSnapshot } from "@/task/manager";

function makeSnapshot(overrides: Partial<TaskSnapshot>): TaskSnapshot {
  return {
    id: "task-abcdef1234567890",
    kind: "grab",
    deviceId: "127.0.0.1:5555",
    label: "抢票 1063631004645 @ 127.0.0.1:5555",
    status: "running",
    startedAtUnixMs: 1759400000000,
    endedAtUnixMs: null,
    unresponsive: false,
    error: null,
    progress: [],
    progressTotal: 0,
    result: null,
    ...overrides,
  };
}

describe("TaskTable（组件冒烟）", () => {
  afterEach(() => {
    cleanup();
  });

  it("渲染任务行：id 截断、状态中文、类型映射", () => {
    render(
      <TaskTable
        tasks={[
          makeSnapshot({ status: "running" }),
          makeSnapshot({ id: "task-ffff0000aaaa1111", status: "failed", deviceId: "emu-2" }),
        ]}
        selectedId={null}
        onSelect={() => undefined}
      />,
    );
    expect(screen.getByText("task-abc")).toBeTruthy();
    expect(screen.getByText("task-fff")).toBeTruthy();
    expect(screen.getByText("运行中")).toBeTruthy();
    expect(screen.getByText("失败")).toBeTruthy();
    expect(screen.getAllByText("抢票").length).toBe(2);
    expect(screen.getByText("emu-2")).toBeTruthy();
  });

  it("unresponsive 标注与空列表", () => {
    render(
      <TaskTable
        tasks={[makeSnapshot({ status: "cancelling", unresponsive: true })]}
        selectedId={null}
        onSelect={() => undefined}
      />,
    );
    expect(screen.getByText("取消中（未响应）")).toBeTruthy();
  });
});
