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

  it("导入干净（包版本号正确）", () => {
    // 对应 Python `import damai_mcp; assert damai_mcp.__version__ == "0.2.3"`
    expect(VERSION).toBe("0.2.3");
  });
});
