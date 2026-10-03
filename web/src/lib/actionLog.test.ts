import { beforeEach, describe, expect, it, vi } from "vitest";

const debug = vi.hoisted(() => vi.fn());

vi.mock("@core/utils/logging", () => ({
  logger: { debug },
}));

import { logPageOperation } from "./actionLog";

describe("logPageOperation", () => {
  beforeEach(() => {
    debug.mockClear();
  });

  it("完成只写操作类型和耗时", () => {
    const startedAt = performance.now();
    logPageOperation("导出界面", startedAt, "ok");
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug.mock.calls[0]?.[0]).toMatch(/^页面操作 导出界面 完成，耗时 \d+ms$/);
  });

  it("失败附带压平后的短原因，不带入参", () => {
    logPageOperation("导出界面", performance.now(), "failed", "  dump 失败\n设备离线  ");
    expect(debug.mock.calls[0]?.[0]).toMatch(
      /^页面操作 导出界面 失败，耗时 \d+ms：dump 失败 设备离线$/,
    );
  });

  it("校验失败不写出字段内容", () => {
    logPageOperation("测试通知", performance.now(), "invalid", "token=secret");
    expect(debug.mock.calls[0]?.[0]).toMatch(/^页面操作 测试通知 校验未通过，耗时 \d+ms$/);
    expect(debug.mock.calls[0]?.[0]).not.toContain("secret");
  });

  it("流式操作记已受理", () => {
    logPageOperation("AI 对话", performance.now(), "accepted");
    expect(debug.mock.calls[0]?.[0]).toMatch(/^页面操作 AI 对话 已受理，耗时 \d+ms$/);
  });
});
