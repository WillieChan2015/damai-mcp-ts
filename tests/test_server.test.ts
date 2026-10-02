/**
 * MCP server 冒烟测试——校验所有工具均已注册
 * （Python `tests/test_server.py` 的 TS 对应物）。
 *
 * 测法选择（与 Python 版一致）：Python 直接内省 FastMCP 内部注册表
 * `mcp._tool_manager._tools`；TS 侧同样选择**直接读取** SDK `McpServer` 的
 * 内部注册表 `mcp._registeredTools`，而不启动 InMemoryTransport 的
 * client-server 内存直连——后者对「注册了哪些工具」的冒烟校验并无增益，
 * 直接读注册表更简单（该取舍已记入迁移偏差说明）。
 */
import { describe, expect, it } from "vitest";

import { z } from "zod";

import { VERSION } from "../src/index";
import { mcp } from "../src/server";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";

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

  it("导入干净（包版本号正确）", () => {
    // 对应 Python `import damai_mcp; assert damai_mcp.__version__ == "0.2.3"`
    expect(VERSION).toBe("0.2.3");
  });
});
