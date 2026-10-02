/**
 * FastMCP server entry — registers all tools from all layers.
 *
 * Run via:
 *     bun run src/cli.ts serve          # stdio transport (default for Claude Code)
 *     bun run src/cli.ts serve --transport streamable-http   # HTTP transport
 *
 * （Python `server.py` 的 TS 对应物。模块导入只有「注册工具」这一种副作用，
 *  绝不连接 transport——连接动作由 `cli.ts` 的 serve 子命令完成。）
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  doubleTap,
  inputText,
  longPress,
  pressKey,
  screenshot,
  scroll,
  swipe,
  tap,
  type KeyName,
  type ScrollDirection,
} from "./actions/actions";
import { listProfiles, loadProfile } from "./app/profile";
import { runProfile } from "./app/runner";
import {
  damaiConfirmOrder,
  damaiGrab,
  damaiLoginCheck,
  damaiOpenConcert,
  damaiPay,
  damaiSelectPrice,
  damaiSelectViewers,
} from "./damai/actions";
import { runChecklist } from "./damai/checklist";
import { monitorAvailability } from "./damai/monitor";
import { whichAdb } from "./device/adb";
import { withDeviceLease } from "./device/lock";
import { LDPlayerInstance, launchInstance, whichLdconsole } from "./device/ldplayer";
import { DeviceManager } from "./device/manager";
import { dumpUi, dumpUiToFile } from "./inspector/dump";
import {
  assertText,
  findByResourceId,
  findByText,
  findByXpath,
  waitForElement,
} from "./inspector/find";
import { CLAWBOT_DEFAULT_TIMEOUT_MS, ClawBotClient } from "./notify/wechat";
import { configure as configureLogging, logger } from "./utils/logging";
import { DEFAULT_NTP_SERVER, fetchDeviceTime, querySampled } from "./utils/ntp";

// Python `server.py` 底部以 noqa: F401 再导出的公共面，此处保持一致。
export { DamaiSelectors, GrabConfig } from "./damai/selectors";
export { UIElement } from "./inspector/models";
export { DamaiMCPError } from "./utils/errors";

/** 包版本（对应 Python `__init__.py` 的 `__version__`；index.ts 再导出）。 */
export const VERSION = "0.2.3";

/** server instructions 文本（与 Python FastMCP instructions 一致；项目更名后首句产品名为 damai-mcp-ts）。 */
export const SERVER_INSTRUCTIONS =
  "damai-mcp-ts 控制 Android 设备/模拟器，自动化抢大麦/猫眼/飞猪门票。" +
  "工具分 4 层：L1 设备管理、L2 原子操作、L3 语义查询、L4 业务编排。" +
  "先用 list_devices 看设备，再用对应层工具。";

/**
 * Python 工具返回值 `-> dict[str, Any]` 对应的输出 schema：
 * 任意对象，等价 FastMCP 按注解生成的 `{"type": "object"}`。
 * 必须是带 `.shape` 的对象 schema（SDK 的 normalizeObjectSchema 不认
 * ZodRecord），passthrough 保证校验时不丢弃任何字段。
 */
const DICT_OUTPUT = z.object({}).passthrough();

/**
 * 构造一个新的 McpServer 实例并注册全部工具（不连接 transport）。
 *
 * 之所以需要工厂：TS SDK 的 `Protocol.connect` 不允许同一实例挂多个
 * transport（Python FastMCP 可以），streamable-http / sse 的每个会话要
 * 各建一个实例。
 */
export function createMcpServer(): McpServer {
  const mcp = new McpServer(
    { name: "damai-mcp-ts", version: VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  /**
   * 工具返回值包装：FastMCP 对 dict 返回值同时给出
   * structuredContent 与 JSON 文本 content，此处保持两份都有。
   */
  const dictResult = (result: Record<string, unknown>): CallToolResult => ({
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  });

  // ==========================================================================
  // L1 — Device management
  // ==========================================================================

  mcp.registerTool(
    "list_devices",
    {
      description:
        "列出所有连接的 Android 设备/模拟器。\n\n" +
        "Args:\n" +
        "    refresh: 跳过缓存，强制重新查询 `adb devices`。",
      inputSchema: { refresh: z.boolean().default(false) },
      outputSchema: DICT_OUTPUT,
    },
    async ({ refresh }) => {
      const devices = await DeviceManager.shared().listDevices(refresh);
      return dictResult({
        count: devices.length,
        devices: devices.map((d) => d.toDict()),
        adb_path: whichAdb(),
      });
    },
  );

  mcp.registerTool(
    "connect_device",
    {
      description:
        "通过 TCP 连接远程设备/模拟器。\n\n" +
        'Args:\n    host_port: 形如 "127.0.0.1:5555"（雷电模拟器默认）。',
      inputSchema: { host_port: z.string() },
      outputSchema: DICT_OUTPUT,
    },
    async ({ host_port }) => {
      const info = await DeviceManager.shared().connect(host_port);
      return dictResult(info.toDict());
    },
  );

  mcp.registerTool(
    "disconnect_device",
    {
      description: "断开指定设备。\n\nArgs:\n    device_id: 设备序列号或 IP:端口。",
      inputSchema: { device_id: z.string() },
      outputSchema: DICT_OUTPUT,
    },
    async ({ device_id }) => {
      await DeviceManager.shared().disconnect(device_id);
      return dictResult({ disconnected: device_id });
    },
  );

  mcp.registerTool(
    "device_info",
    {
      description:
        "获取设备的详细信息（型号、安卓版本、屏幕分辨率等）。\n\n" +
        "Args:\n    device_id: 设备 ID。",
      inputSchema: { device_id: z.string() },
      outputSchema: DICT_OUTPUT,
    },
    async ({ device_id }) => {
      const info = await DeviceManager.shared().require(device_id);
      return dictResult(info.toDict());
    },
  );

  mcp.registerTool(
    "launch_ldplayer",
    {
      description:
        "启动雷电实例、连接 ADB，并启用大麦所需的 ARM/Houdini bridge。\n\n" +
        "This only launches and connects an existing instance; it does not install\n" +
        "APKs, clear app data, or perform destructive operations.",
      inputSchema: {
        index: z.number().int().default(1),
        name: z.string().default("damai_bot"),
        device_id: z.string().default("auto"),
        package: z.string().default("cn.damai"),
        timeout_sec: z.number().default(60.0),
      },
      outputSchema: DICT_OUTPUT,
    },
    async ({ index, name, device_id, package: pkg, timeout_sec }) => {
      const result = await launchInstance(
        new LDPlayerInstance({ index, name, deviceId: device_id, package: pkg }),
        { adbTimeout: timeout_sec },
      );
      return dictResult({ ...result, ldconsole_path: whichLdconsole() });
    },
  );

  // ==========================================================================
  // L2 — Atomic actions
  // ==========================================================================

  mcp.registerTool(
    "tap",
    {
      description:
        "点击屏幕坐标。\n\n" +
        "Args:\n" +
        "    device_id: 设备 ID。\n" +
        "    x: 像素 X 坐标。\n" +
        "    y: 像素 Y 坐标。\n" +
        "    duration_ms: 按住时长（>0 模拟长按）。",
      inputSchema: {
        device_id: z.string(),
        x: z.number().int(),
        y: z.number().int(),
        duration_ms: z.number().int().default(50),
      },
      outputSchema: DICT_OUTPUT,
    },
    async ({ device_id, x, y, duration_ms }) => {
      await tap(device_id, x, y, { durationMs: duration_ms });
      return dictResult({ tapped: [x, y], duration_ms });
    },
  );

  mcp.registerTool(
    "double_tap",
    {
      description:
        "双击。\n\n" +
        "Args:\n" +
        "    device_id: 设备 ID。\n" +
        "    x, y: 坐标。\n" +
        "    gap_ms: 两次点击间隔毫秒。",
      inputSchema: {
        device_id: z.string(),
        x: z.number().int(),
        y: z.number().int(),
        gap_ms: z.number().int().default(80),
      },
      outputSchema: DICT_OUTPUT,
    },
    async ({ device_id, x, y, gap_ms }) => {
      await doubleTap(device_id, x, y, { gapMs: gap_ms });
      return dictResult({ double_tapped: [x, y] });
    },
  );

  mcp.registerTool(
    "long_press",
    {
      description:
        "长按坐标。\n\n" +
        "Args:\n" +
        "    device_id: 设备 ID。\n" +
        "    x, y: 坐标。\n" +
        "    duration_ms: 按住时长（500-1000ms 可触发长按菜单）。",
      inputSchema: {
        device_id: z.string(),
        x: z.number().int(),
        y: z.number().int(),
        duration_ms: z.number().int().default(800),
      },
      outputSchema: DICT_OUTPUT,
    },
    async ({ device_id, x, y, duration_ms }) => {
      await longPress(device_id, x, y, { durationMs: duration_ms });
      return dictResult({ long_pressed: [x, y], duration_ms });
    },
  );

  mcp.registerTool(
    "swipe",
    {
      description:
        "从 (x1,y1) 拖动到 (x2,y2)。\n\n" +
        "Args:\n" +
        "    device_id: 设备 ID。\n" +
        "    x1, y1, x2, y2: 起止坐标。\n" +
        "    duration_ms: 拖动时长。",
      inputSchema: {
        device_id: z.string(),
        x1: z.number().int(),
        y1: z.number().int(),
        x2: z.number().int(),
        y2: z.number().int(),
        duration_ms: z.number().int().default(300),
      },
      outputSchema: DICT_OUTPUT,
    },
    async ({ device_id, x1, y1, x2, y2, duration_ms }) => {
      await swipe(device_id, x1, y1, x2, y2, { durationMs: duration_ms });
      return dictResult({ swiped: [[x1, y1], [x2, y2]], duration_ms });
    },
  );

  mcp.registerTool(
    "scroll",
    {
      description:
        "整屏滚动。\n\n" +
        "Args:\n" +
        "    device_id: 设备 ID。\n" +
        '    direction: "up" | "down" | "left" | "right"。\n' +
        "    distance_ratio: 滚动距离占屏幕短边的比例（0-1）。\n" +
        "    duration_ms: 滚动时长。",
      inputSchema: {
        device_id: z.string(),
        direction: z.string().default("down"),
        distance_ratio: z.number().default(0.6),
        duration_ms: z.number().int().default(300),
      },
      outputSchema: DICT_OUTPUT,
    },
    async ({ device_id, direction, distance_ratio, duration_ms }) => {
      // direction 由 MCP 入参保证为字符串；非法值由 actions.scroll 的
      // delta 表查找阶段失败（与 Python KeyError 等价的失败路径）
      await scroll(device_id, direction as ScrollDirection, distance_ratio, {
        durationMs: duration_ms,
      });
      return dictResult({ scrolled: direction, distance_ratio });
    },
  );

  mcp.registerTool(
    "input_text",
    {
      description:
        "向当前焦点输入框输入文本（中文需要 ADBKeyBoard）。\n\n" +
        "Args:\n" +
        "    device_id: 设备 ID。\n" +
        "    text: 要输入的文本。\n" +
        "    delay_ms: 字符间隔（用于绕过风控）。",
      inputSchema: {
        device_id: z.string(),
        text: z.string(),
        delay_ms: z.number().int().default(0),
      },
      outputSchema: DICT_OUTPUT,
    },
    async ({ device_id, text, delay_ms }) => {
      await inputText(device_id, text, { delayMs: delay_ms });
      // Python len(str) 按码点计数，JS .length 按 UTF-16 单元；BMP 内（含
      // 常用 CJK）两者一致，此处不再做码点换算
      return dictResult({ input_len: text.length, text_preview: text.slice(0, 30) });
    },
  );

  mcp.registerTool(
    "press_key",
    {
      description:
        "按键。\n\n" +
        "Args:\n" +
        "    device_id: 设备 ID。\n" +
        "    key: 常用键名（home/back/menu/enter/delete/tab/up/down/left/right/\n" +
        "         volume_up/volume_down/power）。",
      inputSchema: {
        device_id: z.string(),
        key: z.string(),
      },
      outputSchema: DICT_OUTPUT,
    },
    async ({ device_id, key }) => {
      // Python 版入参是任意 str；未知键名由 pressKey 内部抛「未知按键」
      // （与 Python 同一错误路径），因此这里只做类型桥接
      await pressKey(device_id, key as KeyName);
      return dictResult({ pressed: key });
    },
  );

  mcp.registerTool(
    "take_screenshot",
    {
      description:
        "截图。\n\n" +
        "Args:\n" +
        "    device_id: 设备 ID。\n" +
        "    save_path: 保存路径（None 则不保存文件）。\n" +
        "    return_base64: True 则返回 base64 字符串（用于 AI 看图）。\n" +
        "    max_width: 缩放宽度（保持比例），None 不缩放。",
      inputSchema: {
        device_id: z.string(),
        save_path: z.string().nullable().default(null),
        return_base64: z.boolean().default(false),
        max_width: z.number().int().nullable().default(null),
      },
      outputSchema: DICT_OUTPUT,
    },
    async ({ device_id, save_path, return_base64, max_width }) => {
      // Python `max_size = (max_width, 99999) if max_width else None`：
      // 0 与 None 同样视为不缩放
      const maxSize: readonly [number, number] | null = max_width
        ? [max_width, 99999]
        : null;
      const res = await screenshot(device_id, save_path ?? undefined, {
        returnBase64: return_base64,
        maxSize,
      });
      if (return_base64) {
        const preview =
          typeof res === "string" && res.length > 200 ? `${res.slice(0, 200)}...` : res;
        return dictResult({ saved_to: save_path, base64: preview, len: res.length });
      }
      return dictResult({ saved_to: save_path, bytes: res.length });
    },
  );

  // ==========================================================================
  // L3 — Semantic UI
  // ==========================================================================

  mcp.registerTool(
    "dump_ui",
    {
      description:
        "获取当前界面的 UI 层级。\n\n" +
        "Args:\n" +
        "    device_id: 设备 ID。\n" +
        "    save_to: 保存 XML 快照到该路径，便于事后分析。",
      inputSchema: {
        device_id: z.string(),
        save_to: z.string().nullable().default(null),
      },
      outputSchema: DICT_OUTPUT,
    },
    async ({ device_id, save_to }) => {
      const elements = await dumpUi(device_id);
      if (save_to) {
        await dumpUiToFile(device_id, save_to);
      }
      return dictResult({
        count: elements.length,
        elements: elements.slice(0, 200).map((e) => e.toDict()),
      });
    },
  );

  mcp.registerTool(
    "find_text",
    {
      description:
        "按文字查找 UI 元素。\n\n" +
        "Args:\n" +
        "    device_id: 设备 ID。\n" +
        "    text: 要查找的文字（默认精确匹配）。\n" +
        "    exact: True=全等，False=子串匹配。\n" +
        "    clickable_only: 只返回可点击元素。\n" +
        "    timeout: 等待秒数。",
      inputSchema: {
        device_id: z.string(),
        text: z.string(),
        exact: z.boolean().default(true),
        clickable_only: z.boolean().default(false),
        timeout: z.number().default(5.0),
      },
      outputSchema: DICT_OUTPUT,
    },
    async ({ device_id, text, exact, clickable_only, timeout }) => {
      const el = await findByText(device_id, text, {
        exact,
        clickableOnly: clickable_only,
        timeout,
      });
      return dictResult(el.toDict());
    },
  );

  mcp.registerTool(
    "find_resource_id",
    {
      description:
        "按 resource-id 查找 UI 元素。\n\n" +
        "Args:\n" +
        "    device_id: 设备 ID。\n" +
        "    resource_id: resource-id（默认精确匹配）。\n" +
        "    exact: True=全等，False=后缀匹配。\n" +
        "    timeout: 等待秒数。",
      inputSchema: {
        device_id: z.string(),
        resource_id: z.string(),
        exact: z.boolean().default(true),
        timeout: z.number().default(5.0),
      },
      outputSchema: DICT_OUTPUT,
    },
    async ({ device_id, resource_id, exact, timeout }) => {
      const el = await findByResourceId(device_id, resource_id, { exact, timeout });
      return dictResult(el.toDict());
    },
  );

  mcp.registerTool(
    "find_xpath",
    {
      description:
        "按 XPath 查找 UI 元素。\n\n" +
        "Args:\n" +
        "    device_id: 设备 ID。\n" +
        "    xpath: lxml 风格 XPath，例如 \"//node[@text='立即购买']\"。\n" +
        "    timeout: 等待秒数。",
      inputSchema: {
        device_id: z.string(),
        xpath: z.string(),
        timeout: z.number().default(5.0),
      },
      outputSchema: DICT_OUTPUT,
    },
    async ({ device_id, xpath, timeout }) => {
      const el = await findByXpath(device_id, xpath, { timeout });
      return dictResult(el.toDict());
    },
  );

  mcp.registerTool(
    "wait_for_element",
    {
      description:
        "等待元素出现，支持前缀：text= / resource-id= / xpath=。\n\n" +
        "Args:\n" +
        "    device_id: 设备 ID。\n" +
        "    selector: 选择器（带前缀）或裸文字。\n" +
        "    timeout: 等待秒数。",
      inputSchema: {
        device_id: z.string(),
        selector: z.string(),
        timeout: z.number().default(5.0),
      },
      outputSchema: DICT_OUTPUT,
    },
    async ({ device_id, selector, timeout }) => {
      const el = await waitForElement(device_id, selector, { timeout });
      return dictResult(el.toDict());
    },
  );

  mcp.registerTool(
    "assert_text",
    {
      description:
        "断言文字在指定时间内出现（不抛异常）。\n\n" +
        "Args:\n" +
        "    device_id: 设备 ID。\n" +
        "    text: 要检测的文字。\n" +
        "    exact: True=全等。\n" +
        "    timeout: 等待秒数。",
      inputSchema: {
        device_id: z.string(),
        text: z.string(),
        exact: z.boolean().default(true),
        timeout: z.number().default(3.0),
      },
      outputSchema: DICT_OUTPUT,
    },
    async ({ device_id, text, exact, timeout }) => {
      const found = await assertText(device_id, text, { exact, timeout });
      return dictResult({ found, text });
    },
  );

  // ==========================================================================
  // L4 — 大麦 business
  // ==========================================================================

  mcp.registerTool(
    "damai_check_login",
    {
      description:
        "检查大麦是否在前台且已登录。\n\n" +
        "Args:\n" +
        "    device_id: 设备 ID。\n" +
        "    timeout: 等待秒数。",
      inputSchema: {
        device_id: z.string(),
        timeout: z.number().default(3.0),
      },
      outputSchema: DICT_OUTPUT,
    },
    async ({ device_id, timeout }) => {
      const result = await damaiLoginCheck(device_id, { timeout });
      return dictResult(result);
    },
  );

  mcp.registerTool(
    "damai_open_concert",
    {
      description:
        "打开大麦演出详情页。\n\n" +
        "Args:\n" +
        "    device_id: 设备 ID。\n" +
        "    item_id: 大麦 item id（数字字符串）。",
      inputSchema: {
        device_id: z.string(),
        item_id: z.string(),
      },
      outputSchema: DICT_OUTPUT,
    },
    async ({ device_id, item_id }) => {
      const result = await damaiOpenConcert(device_id, item_id);
      return dictResult(result);
    },
  );

  mcp.registerTool(
    "damai_select_price",
    {
      description:
        "选择第 N 档票（从详情页的票价表）。\n\n" +
        "Args:\n" +
        "    device_id: 设备 ID。\n" +
        "    price_index: 1-based 票档序号。\n" +
        "    timeout: 等待秒数。",
      inputSchema: {
        device_id: z.string(),
        price_index: z.number().int().default(1),
        timeout: z.number().default(4.0),
      },
      outputSchema: DICT_OUTPUT,
    },
    async ({ device_id, price_index, timeout }) => {
      const el = await damaiSelectPrice(device_id, price_index, { timeout });
      return dictResult({ selected_price_text: el.text, center: [...el.center] });
    },
  );

  mcp.registerTool(
    "damai_select_viewers",
    {
      description:
        "勾选观演人。\n\n" +
        "Args:\n" +
        "    device_id: 设备 ID。\n" +
        '    viewer_names: 观演人姓名列表，如 ["杨安琪"]。\n' +
        "    timeout: 等待秒数。",
      inputSchema: {
        device_id: z.string(),
        viewer_names: z.array(z.string()),
        timeout: z.number().default(4.0),
      },
      outputSchema: DICT_OUTPUT,
    },
    async ({ device_id, viewer_names, timeout }) => {
      const clicked = await damaiSelectViewers(device_id, viewer_names, { timeout });
      return dictResult({
        requested: viewer_names,
        clicked: clicked.length,
        elements: clicked.map((e) => e.toDict()),
      });
    },
  );

  mcp.registerTool(
    "damai_confirm_order",
    {
      description:
        "点击「确认订单」按钮。\n\n" +
        "Args:\n" +
        "    device_id: 设备 ID。\n" +
        "    timeout: 等待秒数。",
      inputSchema: {
        device_id: z.string(),
        timeout: z.number().default(5.0),
      },
      outputSchema: DICT_OUTPUT,
    },
    async ({ device_id, timeout }) => {
      const el = await damaiConfirmOrder(device_id, { timeout });
      return dictResult(el.toDict());
    },
  );

  mcp.registerTool(
    "damai_pay",
    {
      description:
        "点击「立即支付」按钮（后续需手动在大麦 APP 完成支付）。\n\n" +
        "Args:\n" +
        "    device_id: 设备 ID。\n" +
        "    timeout: 等待秒数。",
      inputSchema: {
        device_id: z.string(),
        timeout: z.number().default(5.0),
      },
      outputSchema: DICT_OUTPUT,
    },
    async ({ device_id, timeout }) => {
      const el = await damaiPay(device_id, { timeout });
      return dictResult(el.toDict());
    },
  );

  mcp.registerTool(
    "damai_grab",
    {
      description:
        "一站式抢票：等开票 → 抢档位 → 选观演人 → 提交订单。\n\n" +
        "Args:\n" +
        "    device_id: 设备 ID。\n" +
        "    item_id: 大麦 item id。\n" +
        "    price_index: 票档序号（1-based）。\n" +
        "    viewer_names: 观演人姓名列表。\n" +
        "    ticket_num: 张数。\n" +
        '    open_time: 开票时间 "YYYY-MM-DD HH:MM:SS"（空=立即抢）。\n' +
        "    preheat_seconds: 开票前多少秒开始预热（默认 30）。\n" +
        "    max_runtime_sec: 整个流程最大耗时（默认 600 秒；现为硬停止——\n" +
        "        预热/开票等待与重试循环超限即中止并报「已达最大运行时长」）。\n" +
        "    max_grab_attempts: 可重试失败（购买按钮未出现/价格表未弹出/选观演人\n" +
        "        超时）的最大尝试轮数，含首轮（默认 1=不重试；指数退避重试需显式开启）。\n" +
        "    retry_interval_ms: 重试退避基数毫秒（默认 500，按 2^n 指数递增封顶 10s）。\n\n" +
        "同一设备同时只允许一个监控/抢票任务（设备被占用时立即报错）。\n\n" +
        "注意：提交结果可能出现 status=needs_action：表示订单请求结果未确认，\n" +
        "请先打开 https://orders.damai.cn/orderList 人工核对，切勿直接重跑。\n" +
        "还可能出现 status=needs_human_captcha：区别于 failed——页面被滑块验证\n" +
        "风控拦截但订单未提交，请人工完成验证后再重跑；本流程绝不自动过滑块。\n" +
        "submitted 结果含 order_seen 字段：true=已见订单/收银页证据；false=提交\n" +
        "点击已送达但未捕获到页面证据，请以官方订单页为准" +
        "（https://orders.damai.cn/orderList）。",
      inputSchema: {
        device_id: z.string(),
        item_id: z.string(),
        price_index: z.number().int().default(1),
        viewer_names: z.array(z.string()).nullable().default(null),
        ticket_num: z.number().int().default(1),
        open_time: z.string().default(""),
        preheat_seconds: z.number().default(30.0),
        max_runtime_sec: z.number().default(600.0),
        // 重试泵默认关闭（保守）：默认行为与历史版本一致，重试由调用方显式开启
        max_grab_attempts: z.number().int().min(1).max(20).default(1),
        retry_interval_ms: z.number().int().min(100).max(60000).default(500),
        // 与 Python 签名一致：confirm_order 默认 false，永不自动点击支付
        confirm_order: z.boolean().default(false),
      },
      outputSchema: DICT_OUTPUT,
    },
    async ({
      device_id,
      item_id,
      price_index,
      viewer_names,
      ticket_num,
      open_time,
      preheat_seconds,
      max_runtime_sec,
      max_grab_attempts,
      retry_interval_ms,
      confirm_order,
    }) => {
      // 设备占用互斥：与监控/其他抢票任务在同一设备上互斥（进程内）
      const grab = await withDeviceLease(device_id, "grab", () =>
        damaiGrab(
          device_id,
          item_id,
          price_index,
          viewer_names ?? [],
          ticket_num,
          open_time,
          {
            preheatSeconds: preheat_seconds,
            maxRuntimeSec: max_runtime_sec,
            maxGrabAttempts: max_grab_attempts,
            retryIntervalMs: retry_interval_ms,
            confirmOrder: confirm_order,
          },
        ),
      );
      return dictResult(grab);
    },
  );

  mcp.registerTool(
    "damai_grab_multi",
    {
      description:
        "多账号/多设备并发抢票（asyncio.gather）。\n\n" +
        "Args:\n" +
        '    accounts: [{"device_id": "127.0.0.1:5555", "viewer_names": ["A"],\n' +
        '        "max_grab_attempts": 3}, ...]（account 内可选键 max_grab_attempts\n' +
        "        = 该账号的可重试失败最大尝试轮数，默认 1=不重试）。\n" +
        "    item_id: 大麦 item id。\n" +
        "    price_index: 票档序号。\n" +
        "    open_time: 开票时间。\n" +
        "    preheat_seconds: 预热秒数。\n\n" +
        "同一设备同时只允许一个监控/抢票任务：accounts 中重复的 device_id\n" +
        "会得到明确的占用错误而非互相踩踏。",
      inputSchema: {
        accounts: z.array(z.record(z.unknown())),
        item_id: z.string(),
        price_index: z.number().int().default(1),
        open_time: z.string().default(""),
        preheat_seconds: z.number().default(30.0),
      },
      outputSchema: DICT_OUTPUT,
    },
    async ({ accounts, item_id, price_index, open_time, preheat_seconds }) => {
      // Python 推导式在 gather 之前就求值每个 _damai_grab(...) 调用的实参，
      // 缺 device_id 的 KeyError 会先于 gather 抛出——此处保持同一语义
      const tasks = accounts.map((a) => {
        if (!("device_id" in a)) {
          throw new Error("'device_id'");
        }
        // 按每账号 device_id 各自占用：重复 device_id 的第二个账号得到明确的
        // DeviceBusyError（进 allSettled 的 error 结果），而非互相踩踏
        // max_grab_attempts 为可选键：非法值（非正整数）一律回退 1（不重试）
        const rawAttempts: unknown = a["max_grab_attempts"];
        const maxGrabAttempts =
          typeof rawAttempts === "number" && Number.isInteger(rawAttempts) && rawAttempts >= 1
            ? rawAttempts
            : 1;
        return withDeviceLease(
          a["device_id"] as string,
          "grab_multi",
          () =>
            damaiGrab(
              a["device_id"] as string,
              item_id,
              price_index,
              (a["viewer_names"] ?? []) as string[],
              (a["ticket_num"] ?? 1) as number,
              open_time,
              { preheatSeconds: preheat_seconds, maxGrabAttempts },
            ),
        );
      });
      // gather(return_exceptions=True) 的结构等价物：allSettled 保序收集
      const results = await Promise.allSettled(tasks);
      const out: Record<string, unknown>[] = [];
      for (const [i, r] of results.entries()) {
        if (r.status === "rejected") {
          out.push({ account_idx: i, status: "error", error: excToStr(r.reason) });
        } else {
          out.push({ ...r.value, account_idx: i });
        }
      }
      return dictResult({ accounts: accounts.length, results: out });
    },
  );

  mcp.registerTool(
    "ntp_sync",
    {
      description:
        "NTP 时间同步 (推荐 ⭐⭐⭐⭐⭐)。\n\n" +
        "多设备并行抢票时，确保所有设备时钟一致（精度 <100ms）。\n\n" +
        "Args:\n" +
        "    server: NTP 服务器域名（默认 pool.ntp.org；国内推荐 cn.pool.ntp.org / ntp.aliyun.com）。\n" +
        "    timeout_sec: 超时秒数。\n" +
        "    device_id: 可选；同时拿设备的 Unix 时间戳做对比。",
      inputSchema: {
        server: z.string().default(DEFAULT_NTP_SERVER),
        timeout_sec: z.number().default(5.0),
        device_id: z.string().nullable().default(null),
      },
      outputSchema: DICT_OUTPUT,
    },
    async ({ server, timeout_sec, device_id }) => {
      // 多次采样（默认 3 次取最小 RTT）：旧键全部保留（向后兼容），
      // 另增 round_trip_ms / uncertainty_ms / interval_* / samples / sampled_at_unix。
      const result = await querySampled(server, timeout_sec);
      // 旧键语义：delay_ms = 最小 RTT（仍为「往返时延」）；server_unix 在缺失时
      // 以本机钟 + offset 兜底（有效样本下即服务器 Transmit Timestamp）
      const serverUnix = result.serverUnix ?? Date.now() / 1000 + result.offsetMs / 1000;
      const payload: Record<string, unknown> = {
        ...result.toDict(),
        // 旧键保留（向后兼容，值与采样语义一致；置于 spread 之后保证旧键名不丢）
        server: result.server,
        offset_ms: round2(result.offsetMs),
        delay_ms: round2(result.roundTripMs),
        server_unix: serverUnix,
        queried_at_unix: result.sampledAtUnix,
        synced: result.synced,
      };
      if (device_id !== null) {
        const deviceUnix = await fetchDeviceTime(device_id);
        payload["device_unix"] = deviceUnix;
        if (deviceUnix !== null) {
          payload["device_offset_ms"] = round2((serverUnix - deviceUnix) * 1000);
        }
      }
      return dictResult(payload);
    },
  );

  mcp.registerTool(
    "damai_checklist_grab",
    {
      description:
        "抢票当天一键 checklist（推荐 ⭐⭐⭐⭐⭐）。\n\n" +
        "一条命令跑完：NTP 时钟同步 → 设备检查 → 登录验证 → 详情页预热 → 倒计时 → 开票抢票。\n" +
        "适合抢票当天 5 分钟前执行，会自动候场等开票。\n\n" +
        "Args:\n" +
        "    device_id: 设备 ID。\n" +
        "    item_id: 大麦 item id。\n" +
        "    open_time: 开票时间 'YYYY-MM-DD HH:MM:SS'（空=立即抢）。\n" +
        "    price_index: 票档序号（1-based）。\n" +
        "    viewer_names: 观演人姓名列表。\n" +
        "    ticket_num: 张数。\n" +
        "    preheat_seconds: 开票前多少秒开始预热（默认 30）。\n" +
        "    ntp_server: NTP 服务器（默认 pool.ntp.org；国内用 cn.pool.ntp.org）。\n\n" +
        "同一设备同时只允许一个监控/抢票任务（设备被占用时立即报错）。",
      inputSchema: {
        device_id: z.string(),
        item_id: z.string(),
        open_time: z.string().default(""),
        price_index: z.number().int().default(1),
        viewer_names: z.array(z.string()).nullable().default(null),
        ticket_num: z.number().int().default(1),
        preheat_seconds: z.number().default(30.0),
        ntp_server: z.string().default("pool.ntp.org"),
      },
      outputSchema: DICT_OUTPUT,
    },
    async ({
      device_id,
      item_id,
      open_time,
      price_index,
      viewer_names,
      ticket_num,
      preheat_seconds,
      ntp_server,
    }) => {
      const phaseCb = async (name: string): Promise<void> => {
        logger.info(`[checklist] ▶ ${name}`);
      };

      const progressCb = async (secondsLeft: number, elapsedS: number): Promise<void> => {
        if (secondsLeft > 10) {
          const mins = Math.floor(secondsLeft / 60); // 对应 Python `int(seconds_left // 60)`
          logger.info(`[countdown] 开票 ${mins} 分钟后，已候场 ${elapsedS}s`);
        } else {
          logger.info(`[countdown] 开票 ${secondsLeft.toFixed(1)}s`);
        }
      };

      const res = await withDeviceLease(device_id, "checklist_grab", () =>
        runChecklist(device_id, item_id, {
          openTime: open_time,
          priceIndex: price_index,
          viewerNames: viewer_names ?? [],
          ticketNum: ticket_num,
          preheatSeconds: preheat_seconds,
          ntpServer: ntp_server,
          onPhase: phaseCb,
          onProgress: progressCb,
        }),
      );
      return dictResult(res.toDict());
    },
  );

  // ---- 只读余票监控（docs/improvements-from-competitors.md §7.5） -------------
  // 只读硬约束：轮询期间零写入指令，绝不点击购买、绝不提交订单。

  mcp.registerTool(
    "damai_monitor_availability",
    {
      description:
        "只读监控大麦详情页余票状态：判定 available/not_on_sale/sold_out/unknown；" +
        "**绝不点击购买、绝不提交订单**。\n\n" +
        "轮询 uiautomator dump 并把页面证据折叠为四态；发现可购 CTA（如「立即购买」）" +
        "立即返回 found=true；dump 连续失败自动指数退避并停止。\n\n" +
        "Args:\n" +
        "    device_id: 设备 ID。\n" +
        "    item_id: 大麦 item id（数字字符串）。\n" +
        "    interval_ms: 轮询间隔毫秒（5000-3600000，默认 30000）。\n" +
        "    max_attempts: 最大尝试次数（0=无限；工具层默认 720，避免调用方忘记终止）。\n" +
        "    max_consecutive_errors: dump 连续失败多少次后停止（默认 5）。\n" +
        "    open_page: 开始时是否深链打开详情页（默认 true；属导航非点击，只执行一次）。\n" +
        "    deadline_unix_ms: 墙钟截止（Unix 毫秒），到达即停 timeout；null=不设截止。\n\n" +
        "同一设备同时只允许一个监控/抢票任务（设备被占用时立即报错）。",
      inputSchema: {
        device_id: z.string(),
        item_id: z.string(),
        interval_ms: z.number().int().min(5000).max(3600000).default(30000),
        // 库层 0=无限语义保留；工具层默认给有限值（§7.5），zod min/max 承担边界校验
        max_attempts: z.number().int().min(0).max(100000).default(720),
        max_consecutive_errors: z.number().int().min(1).max(50).default(5),
        open_page: z.boolean().default(true),
        deadline_unix_ms: z.number().nullable().default(null),
      },
      outputSchema: DICT_OUTPUT,
    },
    async ({
      device_id,
      item_id,
      interval_ms,
      max_attempts,
      max_consecutive_errors,
      open_page,
      deadline_unix_ms,
    }) => {
      // 设备占用互斥：openPage=true 的深链导航会干扰抢票流程的页面状态，
      // 与抢票工具在同一设备上互斥（进程内）；只读约束不变（零写入指令）
      const result = await withDeviceLease(device_id, "monitor", () =>
        monitorAvailability(device_id, item_id, {
          intervalMs: interval_ms,
          maxAttempts: max_attempts,
          maxConsecutiveErrors: max_consecutive_errors,
          openPage: open_page,
          deadlineUnixMs: deadline_unix_ms,
          onReport: (snapshot) => {
            const reasonText = snapshot.reason === null ? "" : `（${snapshot.reason}）`;
            const nextText =
              snapshot.nextDelayMs === null ? "" : `，${Math.round(snapshot.nextDelayMs / 1000)}s 后继续`;
            logger.info(
              `[monitor] 第 ${snapshot.attempt} 次采样: ${snapshot.status}${reasonText}${nextText}`,
            );
          },
        }),
      );
      return dictResult(result.toDict());
    },
  );

  // ---- 通知（docs/improvements-from-competitors.md §7.6） --------------------
  // 只发消息，绝不自动支付。凭证缺省回落环境变量（§7.6：具体由接线工程师定）。

  mcp.registerTool(
    "notify_send",
    {
      description:
        "通过微信 ClawBot 机器人发送一条文本通知（只发消息，绝不自动支付）。\n\n" +
        "发送幂等语义：每次调用至多发出一次 HTTP 请求，内部零自动重试；\n" +
        "超时返回 timeout_unknown（送达状态未知），不会自动重发；如确需重试，\n" +
        "携带返回的 client_id 再次调用，由服务端幂等去重。\n\n" +
        "Args:\n" +
        "    target: 接收人 user id。\n" +
        "    text: 要发送的文本（默认上限 4096 字符）。\n" +
        "    origin: ClawBot 服务 origin（https，host ∈ *.ilinkai.weixin.qq.com）；\n" +
        "            缺省回落环境变量 DAMAI_CLAWBOT_ORIGIN。\n" +
        "    token: Bearer 令牌；缺省回落环境变量 DAMAI_CLAWBOT_TOKEN。\n" +
        "    context_token: 会话上下文 token；缺省回落环境变量 DAMAI_CLAWBOT_CONTEXT_TOKEN。\n" +
        "    client_id: 可选幂等键；人工重试时传入上次的 client_id 以便服务端去重。\n" +
        "    timeout_ms: 单次请求超时毫秒（默认 10000）。",
      inputSchema: {
        target: z.string(),
        text: z.string(),
        origin: z.string().optional(),
        token: z.string().optional(),
        context_token: z.string().optional(),
        client_id: z.string().optional(),
        timeout_ms: z.number().default(CLAWBOT_DEFAULT_TIMEOUT_MS),
      },
      outputSchema: DICT_OUTPUT,
    },
    async ({ target, text, origin, token, context_token, client_id, timeout_ms }) => {
      // 凭证缺省回落环境变量（§7.6）；缺省 transport 为 fetch，显式调用才会真正出网
      const finalOrigin = origin ?? process.env.DAMAI_CLAWBOT_ORIGIN;
      const finalToken = token ?? process.env.DAMAI_CLAWBOT_TOKEN;
      const finalContextToken = context_token ?? process.env.DAMAI_CLAWBOT_CONTEXT_TOKEN;
      if (finalOrigin === undefined || finalOrigin === "") {
        throw new Error("notify_send 缺少 origin：请传参或设置环境变量 DAMAI_CLAWBOT_ORIGIN");
      }
      if (finalToken === undefined || finalToken === "") {
        throw new Error("notify_send 缺少 token：请传参或设置环境变量 DAMAI_CLAWBOT_TOKEN");
      }
      if (finalContextToken === undefined || finalContextToken === "") {
        throw new Error(
          "notify_send 缺少 context_token：请传参或设置环境变量 DAMAI_CLAWBOT_CONTEXT_TOKEN",
        );
      }
      // origin 强校验 / 六协议头 / 载荷组装 / 响应守卫都在 ClawBotClient 内部完成；
      // 空 target / text 等参数校验失败时它会在发出任何请求前抛中文错误
      const client = new ClawBotClient({
        origin: finalOrigin,
        token: finalToken,
        timeoutMs: timeout_ms,
      });
      const outcome = await client.sendText(
        target,
        finalContextToken,
        text,
        client_id === undefined ? undefined : { clientId: client_id },
      );
      return dictResult({
        status: outcome.status,
        client_id: outcome.clientId,
        error: outcome.error,
        http_status: outcome.httpStatus,
        elapsed_ms: outcome.elapsedMs,
      });
    },
  );

  // ==========================================================================
  // L5 — Multi-app profile framework (大麦 / 猫眼 / 飞猪 / 自定义)
  // ==========================================================================

  mcp.registerTool(
    "list_app_profiles",
    {
      description:
        "列出所有已注册的 app profile（多网站抢票支持）。\n\n" +
        'Returns:\n    {"profiles": [{name, package_name, hints, step_count}]}',
      // 无入参工具：不声明 inputSchema（对应 Python 无参签名）
      outputSchema: DICT_OUTPUT,
    },
    async () => {
      const names = listProfiles();
      const items: Record<string, unknown>[] = [];
      for (const n of names) {
        try {
          const p = await loadProfile(n);
          items.push({
            name: p.name,
            package_name: p.packageName,
            hints: p.hints,
            step_count: p.steps.length,
            viewer_picker: p.viewerPicker,
          });
        } catch {
          continue;
        }
      }
      return dictResult({ profiles: items, count: items.length });
    },
  );

  mcp.registerTool(
    "app_grab",
    {
      description:
        "通用 app 抢票执行器（多网站支持 ⭐⭐⭐⭐⭐）。\n\n" +
        "内置 profile：\n" +
        "    - damai (cn.damai)        大麦\n" +
        "    - maoyan (com.sankuai.movie) 猫眼\n" +
        "    - fliggy (com.taobao.trip)  飞猪\n\n" +
        "Args:\n" +
        "    device_id: 设备 ID。\n" +
        "    profile_name: profile 名称（list_app_profiles 可查）。\n" +
        "    item_id: 商品 / 演出 id。\n" +
        '    options: 透传给 profile 的参数。例如\n' +
        '             {"price_index": 1, "viewer_names": ["张三"], "ticket_num": 1}。\n\n' +
        "Returns:\n" +
        "    RunResult dict with per-step timing + status.",
      inputSchema: {
        device_id: z.string(),
        profile_name: z.string(),
        item_id: z.string(),
        options: z.record(z.unknown()).nullable().default(null),
      },
      outputSchema: DICT_OUTPUT,
    },
    async ({ device_id, profile_name, item_id, options }) => {
      const profile = await loadProfile(profile_name);
      const opts: Record<string, unknown> = options ?? {};

      // Special dispatch: 大麦 handled via dedicated action
      if (profile.name === "damai") {
        const grab = await damaiGrab(
          device_id,
          item_id,
          pyIntCast(opts["price_index"] ?? 1),
          pyListCast(opts["viewer_names"] ?? []) as string[],
          pyIntCast(opts["ticket_num"] ?? 1),
          opts["open_time"] === undefined ? "" : String(opts["open_time"]),
          {
            preheatSeconds: pyFloatCast(opts["preheat_seconds"] ?? 0.0),
            maxRuntimeSec: pyFloatCast(opts["max_runtime_sec"] ?? 60.0),
          },
        );
        return dictResult({
          profile: profile.name,
          package: profile.packageName,
          item_id,
          status: grab.status ?? "submitted",
          grab_result: grab,
          dispatch: "damai_grab_special",
        });
      }

      // Generic step runner for maoyan/fliggy/custom profiles
      // Hydrate runtime args from options
      for (const step of profile.steps) {
        if (step.action === "select_checkbox") {
          // Python: options.get("viewer_label") or (options.get("viewer_names", [""])[0]
          // if options.get("viewer_names") else "")
          const label = opts["viewer_label"] || firstSubscript(opts["viewer_names"]);
          if (label) {
            step.args["label"] = label;
          }
        }
        if (step.action === "tap_index") {
          if (!("index" in step.args) && "price_index" in opts) {
            step.args["index"] = pyIntCast(opts["price_index"]) - 1;
          }
        }
      }

      return dictResult((await runProfile(profile, device_id, item_id, opts)).toDict());
    },
  );

  return mcp;
}

/** 模块级单例（对应 Python 的模块级 `mcp = FastMCP(...)`，导入即注册完工具）。 */
export const mcp: McpServer = createMcpServer();

// ---- 内部辅助 ---------------------------------------------------------------

/** 等价于 Python 的 str(exc)：Error 取 message，其余 String()。 */
function excToStr(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/**
 * 等价 Python `round(x, 2)`（半值取整方向与 Python 银行家舍入略有差异，仅影响展示）。
 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 对应 Python `int(...)` 截断语义：数字向下取整，数字字符串解析；
 * 无法转换时抛与 Python 一致的 ValueError 消息。
 */
function pyIntCast(value: unknown): number {
  let n: number;
  if (typeof value === "number") {
    n = Math.trunc(value);
  } else if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) {
    n = Number(value.trim());
  } else {
    n = Number(value);
  }
  if (Number.isNaN(n)) {
    throw new Error(`invalid literal for int() with base 10: '${String(value)}'`);
  }
  return n;
}

/**
 * 对应 Python `float(...)`：数字原样，数字字符串解析；
 * 无法转换时抛与 Python 一致的 ValueError 消息。
 */
function pyFloatCast(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(n)) {
    throw new Error(`could not convert string to float: '${String(value)}'`);
  }
  return n;
}

/**
 * 对应 Python `list(obj)` 的迭代语义（app_grab 里 `list(options.get(...))`）：
 * 数组浅拷贝；字符串按码点拆分（Python str 迭代）；其余不可迭代。
 */
function pyListCast(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return [...value];
  }
  if (typeof value === "string") {
    return [...value];
  }
  throw new TypeError(`'${pyTypeName(value)}' object is not iterable`);
}

/**
 * 对应 Python `obj[0]` 的下标语义（app_grab 里 viewer_names 的回退分支）：
 * 数组/字符串取首元素，其余抛 TypeError。
 */
function firstSubscript(value: unknown): unknown {
  if (value === null || value === undefined) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? value[0] : "";
  }
  if (typeof value === "string") {
    return value.length > 0 ? value[0] : "";
  }
  throw new TypeError(`'${pyTypeName(value)}' object is not subscriptable`);
}

/** Python 风格的类型名（用于复刻 TypeError 文案）。 */
function pyTypeName(value: unknown): string {
  if (value === null) return "NoneType";
  if (value === undefined) return "NoneType";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "string") return "str";
  if (Array.isArray(value)) return "list";
  return "dict";
}
