/**
 * core 只读能力 → AI SDK 工具集（ai-chat 项，设计 §8.2）。
 *
 * 安全硬约束（D5/D6，模块头与测试双重守护）：
 * - **本模块只读**：只包装设备发现（device/manager）、UI 探查（inspector/dump、
 *   inspector/find）、监控任务查看（task/manager list）三类只读能力；
 * - **绝不 import** `@core/actions/*` 的 tap / swipe / inputText / pressKey /
 *   scroll 等任何写入类符号，绝不暴露 damai_grab / 下单 / 支付类能力——
 *   aiTools.test.ts 读本文件源文本做白名单守护，新增 import 必须同步过审；
 * - 每个 execute 内部 try/catch：失败 → `{error: 中文}` 结构化返回，
 *   绝不向模型抛异常（模型对话不因单次工具失败中断）；
 * - dump_ui 输出截断为前 {@link DUMP_UI_ELEMENT_CAP} 个元素（防 payload 爆炸）；
 * - apiKey / provider 配置不经过本模块（配置见 @/lib/aiConfig）。
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";

import { DeviceManager } from "@core/device/manager";
import { dumpUi } from "@core/inspector/dump";
import { findByText } from "@core/inspector/find";
import { UIElementNotFoundError } from "@core/utils/errors";

import { getTaskManager } from "@/task/manager";

/** dump_ui 返回的元素数上限（防 payload 爆炸，设计 §8.2）。 */
const DUMP_UI_ELEMENT_CAP = 80;

/** find_text 单次查找超时（秒，设计 §8.2：timeout:5）。 */
const FIND_TEXT_TIMEOUT_SEC = 5;

/** 工具白名单（恰好五个；aiTools.test.ts 断言工具名集合严格等于它）。 */
export const READ_ONLY_TOOL_NAMES = [
  "list_devices",
  "get_device",
  "dump_ui",
  "find_text",
  "list_monitor_tasks",
] as const;

/** 等价于 Python 的 str(exc)：Error 取 message，其余 String()。 */
function excToStr(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/**
 * 构建只读工具集（供 /api/ai/chat 的 streamText 使用）。
 *
 * 恰好五个工具（见 {@link READ_ONLY_TOOL_NAMES}），全部中文 description：
 *
 * | 工具名 | core 出处 | 返回 |
 * |---|---|---|
 * | `list_devices` | DeviceManager.shared().listDevices(true) | `[{deviceId,model,androidVersion,screenSize,isEmulator}]` |
 * | `get_device` | DeviceManager.shared().get(deviceId, true) | DeviceInfo.toDict() 全字段 |
 * | `dump_ui` | dumpUi(deviceId,{compressed:true}) | `{count,truncated,elements:前 80 个 toDict}` |
 * | `find_text` | findByText(deviceId,text,{timeout:5}) | `{found:true,element}` / `{found:false,error}` |
 * | `list_monitor_tasks` | getTaskManager().list() 过滤 kind==="monitor" | `[{id,label,status,startedAtUnixMs,endedAtUnixMs,error,result}]` |
 */
export function buildReadOnlyAiTools(): ToolSet {
  return {
    list_devices: tool({
      description:
        "列出当前已连接的 Android 设备/模拟器（只读，不触发任何设备操作）。返回设备 id、型号、系统版本、分辨率与是否模拟器。",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const devices = await DeviceManager.shared().listDevices(true);
          return devices.map((device) => ({
            deviceId: device.deviceId,
            model: device.model,
            androidVersion: device.androidVersion,
            screenSize: device.screenSize,
            isEmulator: device.isEmulator,
          }));
        } catch (exc) {
          return { error: `列出设备失败: ${excToStr(exc)}` };
        }
      },
    }),

    get_device: tool({
      description:
        "查询单台设备的运行时快照（只读）：状态、型号、Android 版本、SDK、CPU ABI、分辨率、总内存、是否模拟器、最后在线时间。",
      inputSchema: z.object({
        deviceId: z.string().min(1, "设备 id 不能为空"),
      }),
      execute: async ({ deviceId }) => {
        try {
          const device = await DeviceManager.shared().get(deviceId, true);
          return device.toDict();
        } catch (exc) {
          return { error: `查询设备 ${deviceId} 失败: ${excToStr(exc)}` };
        }
      },
    }),

    dump_ui: tool({
      description:
        "dump 当前 UI 层级为扁平元素列表（只读，uiautomator dump，可达 15 秒）。返回元素总数与前 80 个元素（text/resource-id/bounds/center/clickable 等）。",
      inputSchema: z.object({
        deviceId: z.string().min(1, "设备 id 不能为空"),
      }),
      execute: async ({ deviceId }) => {
        try {
          const elements = await dumpUi(deviceId, { compressed: true });
          return {
            count: elements.length,
            truncated: elements.length > DUMP_UI_ELEMENT_CAP,
            elements: elements.slice(0, DUMP_UI_ELEMENT_CAP).map((el) => el.toDict()),
          };
        } catch (exc) {
          return { error: `dump 设备 ${deviceId} 的 UI 失败: ${excToStr(exc)}` };
        }
      },
    }),

    find_text: tool({
      description:
        "在当前界面上按 text / content-desc 查找元素（只读，轮询等待最多 5 秒）。未命中返回 found:false 而非报错。",
      inputSchema: z.object({
        deviceId: z.string().min(1, "设备 id 不能为空"),
        text: z.string().min(1, "查找文本不能为空"),
        exact: z.boolean().describe("true=整串相等（默认）；false=子串包含").optional(),
        clickableOnly: z.boolean().describe("只匹配可点击元素（默认 false）").optional(),
      }),
      execute: async ({ deviceId, text, exact, clickableOnly }) => {
        try {
          const element = await findByText(deviceId, text, {
            exact: exact ?? true,
            clickableOnly: clickableOnly ?? false,
            timeout: FIND_TEXT_TIMEOUT_SEC,
          });
          return { found: true, element: element.toDict() };
        } catch (exc) {
          // 未命中是正常查询结果（不向模型抛异常）；UIElementNotFoundError → found:false
          if (exc instanceof UIElementNotFoundError) {
            return { found: false, error: exc.message };
          }
          return { error: `在设备 ${deviceId} 上查找文本失败: ${excToStr(exc)}` };
        }
      },
    }),

    list_monitor_tasks: tool({
      description:
        "列出本控制台的可用性监控任务（只读）：id、名称、状态、起止时间、错误与结果。不含抢票任务与进度日志。",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          return getTaskManager()
            .list()
            .filter((task) => task.kind === "monitor")
            .map((task) => ({
              id: task.id,
              label: task.label,
              status: task.status,
              startedAtUnixMs: task.startedAtUnixMs,
              endedAtUnixMs: task.endedAtUnixMs,
              error: task.error,
              result: task.result,
            }));
        } catch (exc) {
          return { error: `列出监控任务失败: ${excToStr(exc)}` };
        }
      },
    }),
  };
}
