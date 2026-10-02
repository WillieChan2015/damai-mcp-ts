/**
 * MCP server 冒烟测试——校验所有工具均已注册
 * （Python `tests/test_server.py` 的 TS 对应物）。
 *
 * 测法选择（与 Python 版一致）：Python 直接内省 FastMCP 内部注册表
 * `mcp._tool_manager._tools`；TS 侧同样选择**直接读取** SDK `McpServer` 的
 * 内部注册表 `mcp._registeredTools`，而不启动 InMemoryTransport 的
 * client-server 内存直连——后者对「注册了哪些工具」的冒烟校验并无增益，
 * 直接读注册表更简单（该取舍已记入迁移偏差说明）。
 *
 * ntp_sync 的输出键断言直接调用注册表里的原始 handler（`RegisteredTool.handler`
 * 即注册时的回调，zod 默认值在 SDK 的请求分发层才生效，故入参需全量显式给出）；
 * UDP 依赖与 test_ntp.test.ts 同款 `node:dgram` mock，冻结 Date 使 offset 恒 0。
 */
import type { SocketType } from "node:dgram";
import { describe, expect, it, vi } from "vitest";

import { z } from "zod";

import { VERSION } from "../src/index";
import { mcp } from "../src/server";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { NTP_UNIX_DELTA } from "../src/utils/ntp";
import { FakeUdpSocket, fakeNtpResponse } from "./helpers";

const dgramMocks = vi.hoisted(() => ({
  /** 当前用例注入的 createSocket 实现；null 时透传真实实现。 */
  createSocketImpl: null as null | ((type: SocketType) => unknown),
}));

vi.mock("node:dgram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dgram")>();
  return {
    ...actual,
    createSocket: (type: SocketType) =>
      dgramMocks.createSocketImpl === null
        ? actual.createSocket(type)
        : dgramMocks.createSocketImpl(type),
  };
});

/**
 * 读取模块级单例的工具注册表（对应 Python `mcp._tool_manager._tools`，
 * dict of name → Tool）。
 */
function registeredTools(): Record<string, RegisteredTool> {
  return (mcp as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
}

/** 对应 Python `mcp.name`：TS SDK 存在底层 Server 的私有 `_serverInfo` 里。 */
function serverName(): string {
  return (
    mcp.server as unknown as { _serverInfo: { name: string; version: string } }
  )._serverInfo.name;
}

/** 直接调用注册表里工具的原始 handler（绕过 transport；extra 不被这些工具使用）。 */
async function callToolHandler(
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const tool = registeredTools()[name];
  if (tool === undefined) {
    throw new Error(`tool not registered: ${name}`);
  }
  const handler = tool.handler as (
    args: Record<string, unknown>,
    extra: unknown,
  ) => Promise<CallToolResult>;
  return handler(args, {});
}

describe("mcp server 注册", () => {
  it("mcp 实例存在且名为 damai-mcp-ts", () => {
    expect(serverName()).toBe("damai-mcp-ts");
  });

  it("至少注册了 25 个工具", () => {
    // 期望 30+ 个工具；留些余量
    const tools = registeredTools();
    const count = Object.keys(tools).length;
    expect(
      count,
      `Expected ≥25 tools, got ${count}: ${Object.keys(tools).join(", ")}`,
    ).toBeGreaterThanOrEqual(25);
  });

  it("所有工具都有描述", () => {
    const tools = registeredTools();
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.description, `Tool ${name} has no description`).toBeTruthy();
      expect(
        (tool.description ?? "").length,
        `Tool ${name} description too short`,
      ).toBeGreaterThan(5);
    }
  });

  it("L1 工具齐全", () => {
    const tools = registeredTools();
    for (const required of [
      "list_devices",
      "connect_device",
      "disconnect_device",
      "device_info",
    ]) {
      expect(required in tools, `Missing L1 tool: ${required}`).toBe(true);
    }
  });

  it("L2 工具齐全", () => {
    const tools = registeredTools();
    for (const required of [
      "tap",
      "swipe",
      "scroll",
      "input_text",
      "press_key",
      "take_screenshot",
      "long_press",
      "double_tap",
    ]) {
      expect(required in tools, `Missing L2 tool: ${required}`).toBe(true);
    }
  });

  it("L3 工具齐全", () => {
    const tools = registeredTools();
    for (const required of [
      "dump_ui",
      "find_text",
      "find_resource_id",
      "find_xpath",
      "wait_for_element",
      "assert_text",
    ]) {
      expect(required in tools, `Missing L3 tool: ${required}`).toBe(true);
    }
  });

  it("L4 工具齐全", () => {
    const tools = registeredTools();
    for (const required of [
      "damai_check_login",
      "damai_open_concert",
      "damai_select_price",
      "damai_select_viewers",
      "damai_confirm_order",
      "damai_pay",
      "damai_grab",
      "damai_grab_multi",
    ]) {
      expect(required in tools, `Missing L4 tool: ${required}`).toBe(true);
    }
  });

  it("新工具 damai_monitor_availability 已注册（只读监控 + zod 边界校验）", () => {
    const tools = registeredTools();
    const tool = tools["damai_monitor_availability"];
    expect(tool, "Missing tool: damai_monitor_availability").toBeTruthy();
    // 只读硬约束（设计文档 §7.5）：description 首句必须声明绝不点击购买、绝不提交订单
    const desc = tool?.description ?? "";
    expect(desc.startsWith("只读监控大麦详情页余票状态：判定")).toBe(true);
    expect(desc).toContain("绝不点击购买、绝不提交订单");
    // zod 参数校验（§7.5）：默认值齐全，且 max_attempts 工具层默认为有限值
    const schema = tool?.inputSchema as unknown as z.ZodObject<z.ZodRawShape>;
    const parsed = schema.parse({ device_id: "emu", item_id: "123" });
    expect(parsed.interval_ms).toBe(30000);
    expect(parsed.max_attempts).toBe(720);
    expect(parsed.max_consecutive_errors).toBe(5);
    expect(parsed.open_page).toBe(true);
    expect(parsed.deadline_unix_ms).toBeNull();
    // 边界：轮询间隔必须 ≥5s；max_attempts 不得为负
    expect(() =>
      schema.parse({ device_id: "emu", item_id: "123", interval_ms: 4999 }),
    ).toThrow();
    expect(() =>
      schema.parse({ device_id: "emu", item_id: "123", max_attempts: -1 }),
    ).toThrow();
  });

  it("新工具 notify_send 已注册（只发消息 + 幂等语义说明）", () => {
    const tools = registeredTools();
    const tool = tools["notify_send"];
    expect(tool, "Missing tool: notify_send").toBeTruthy();
    // 幂等语义（设计文档 §7.6）：超时＝送达状态未知，不自动重发
    const desc = tool?.description ?? "";
    expect(desc).toContain("timeout_unknown");
    expect(desc).toContain("不会自动重发");
    // target/text 必填；origin 等凭证参数可选（缺省回落环境变量），timeout_ms 有默认
    const schema = tool?.inputSchema as unknown as z.ZodObject<z.ZodRawShape>;
    const parsed = schema.parse({ target: "user", text: "开票了" });
    expect(parsed.timeout_ms).toBe(10000);
    expect(parsed.origin).toBeUndefined();
    expect(parsed.client_id).toBeUndefined();
  });

  it("ntp_sync 输出保留旧键并新增采样字段（handler 冒烟，mock UDP + 冻结 Date）", async () => {
    // 冻结 Date：t1 = t4 = 服务器时间戳 → offset=0、rtt=0、uncertainty=rtt/2+1=1
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1_700_000_000_000);
      dgramMocks.createSocketImpl = () =>
        new FakeUdpSocket(fakeNtpResponse(1_700_000_000 + NTP_UNIX_DELTA));

      // 原始 handler 不经过 zod 默认值，入参全量显式给出
      const result = await callToolHandler("ntp_sync", {
        server: "pool.ntp.org",
        timeout_sec: 1.0,
        device_id: null,
      });
      const out = result.structuredContent as Record<string, unknown>;

      // 旧键（向后兼容，Python to_dict 表面）逐键断言
      expect(out["server"]).toBe("pool.ntp.org");
      expect(out["offset_ms"]).toBe(0);
      expect(out["delay_ms"]).toBe(0); // 旧键语义 = 最小 RTT（往返时延）
      expect(out["server_unix"]).toBe(1_700_000_000);
      expect(out["queried_at_unix"]).toBe(1_700_000_000);
      expect(out["synced"]).toBe(true);
      // 新增采样键（querySampled 语义）
      expect(out["round_trip_ms"]).toBe(0);
      expect(out["uncertainty_ms"]).toBe(1);
      expect(out["interval_low_ms"]).toBe(-1);
      expect(out["interval_high_ms"]).toBe(1);
      expect(out["samples"]).toBe(3);
      expect(out["sampled_at_unix"]).toBe(1_700_000_000);
      // device_id=null 分支不产生 device_* 键
      expect("device_unix" in out).toBe(false);
      expect("device_offset_ms" in out).toBe(false);
    } finally {
      dgramMocks.createSocketImpl = null;
      vi.useRealTimers();
    }
  });

  it("监控/抢票四工具声明设备占用互斥（§7.3 项 10 N2）", () => {
    const tools = registeredTools();
    for (const required of [
      "damai_grab",
      "damai_grab_multi",
      "damai_checklist_grab",
      "damai_monitor_availability",
    ]) {
      const desc = tools[required]?.description ?? "";
      expect(
        desc.includes("同一设备同时只允许一个监控/抢票任务"),
        `${required} description 缺少设备占用互斥说明`,
      ).toBe(true);
    }
  });

  it("导入干净（包版本号正确）", () => {
    // 对应 Python `import damai_mcp; assert damai_mcp.__version__ == "0.2.3"`
    expect(VERSION).toBe("0.2.3");
  });
});
