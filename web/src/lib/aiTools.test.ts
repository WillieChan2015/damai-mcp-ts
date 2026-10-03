/**
 * aiTools 测试（设计 §8.6②）：vi.mock 注入 fake core（DeviceManager/dumpUi/
 * findByText）与 fake TaskManager；UIElementNotFoundError 用真实类保证
 * instanceof 判定成立。覆盖：五白名单工具名、各 execute 返回形状、
 * 抛错兜底 {error: 中文}、源码守护（去注释源码不含写入类符号）。
 */
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tool } from "ai";

// 只 mock core 接入点（factory 内不放真实实现）
vi.mock("@core/device/manager", () => ({ DeviceManager: { shared: vi.fn() } }));
vi.mock("@core/inspector/dump", () => ({ dumpUi: vi.fn() }));
vi.mock("@core/inspector/find", () => ({ findByText: vi.fn() }));
vi.mock("@/task/manager", () => ({ getTaskManager: vi.fn() }));

import { DeviceManager } from "@core/device/manager";
import { dumpUi } from "@core/inspector/dump";
import { findByText } from "@core/inspector/find";
import { UIElementNotFoundError } from "@core/utils/errors";
import { getTaskManager } from "@/task/manager";

import { buildReadOnlyAiTools, READ_ONLY_TOOL_NAMES } from "./aiTools";

const mockedShared = vi.mocked(DeviceManager.shared);
const mockedDumpUi = vi.mocked(dumpUi);
const mockedFindByText = vi.mocked(findByText);
const mockedGetTaskManager = vi.mocked(getTaskManager);

/** fake UIElement（只需 toDict；形状对齐 UIElement.toDict()，models.ts:95）。 */
function fakeElement(text: string): { toDict: () => Record<string, unknown> } {
  return {
    toDict: () => ({
      tag: "node",
      text,
      resource_id: "com.example:id/buy",
      class_name: "android.widget.Button",
      content_desc: "",
      bounds: [0, 0, 100, 40],
      center: [50, 20],
      clickable: true,
      enabled: true,
      selected: false,
      checked: false,
      package: "com.example",
    }),
  };
}

/** 调用工具 execute 的测试入口（options 形状对齐 ToolExecutionOptions）。 */
async function runTool(name: string, input: unknown = {}): Promise<unknown> {
  const tools = buildReadOnlyAiTools();
  const toolObj = tools[name] as Tool;
  if (toolObj.execute === undefined) {
    throw new Error(`工具 ${name} 缺少 execute`);
  }
  return toolObj.execute(
    input as never,
    { toolCallId: `test-${name}`, messages: [], context: undefined } as never,
  );
}

/** fake DeviceManager（listDevices/get 由用例注入）。 */
function fakeDeviceManager(overrides: {
  listDevices?: ReturnType<typeof vi.fn>;
  get?: ReturnType<typeof vi.fn>;
}): never {
  return {
    listDevices: overrides.listDevices ?? vi.fn(),
    get: overrides.get ?? vi.fn(),
  } as never;
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ---- ① 白名单 ----------------------------------------------------------------

describe("只读工具白名单", () => {
  it("工具名恰好等于设计 §8.2 的五个只读工具", () => {
    const names = Object.keys(buildReadOnlyAiTools());
    expect(names).toHaveLength(5);
    expect(new Set(names)).toEqual(
      new Set(["list_devices", "get_device", "dump_ui", "find_text", "list_monitor_tasks"]),
    );
    expect(READ_ONLY_TOOL_NAMES).toHaveLength(5);
  });

  it("每个工具都有非空中文 description", () => {
    for (const toolObj of Object.values(buildReadOnlyAiTools())) {
      const description = toolObj.description ?? "";
      expect(description.length).toBeGreaterThan(0);
    }
  });
});

// ---- ② list_devices ----------------------------------------------------------

describe("list_devices", () => {
  it("fake 返回 → 映射为五字段对象数组（不含多余字段）", async () => {
    mockedShared.mockReturnValue(
      fakeDeviceManager({
        listDevices: vi.fn().mockResolvedValue([
          {
            deviceId: "emulator-5554",
            model: "Pixel 6",
            androidVersion: "14",
            screenSize: "1080x2400",
            isEmulator: true,
            state: "device", // 多余字段应被丢弃
          },
        ]),
      }),
    );

    const result = (await runTool("list_devices")) as Array<Record<string, unknown>>;
    expect(result).toEqual([
      {
        deviceId: "emulator-5554",
        model: "Pixel 6",
        androidVersion: "14",
        screenSize: "1080x2400",
        isEmulator: true,
      },
    ]);
  });

  it("fake 抛错 → {error: 中文} 兜底（不向外抛）", async () => {
    mockedShared.mockReturnValue(
      fakeDeviceManager({
        listDevices: vi.fn().mockRejectedValue(new Error("adb 不可用")),
      }),
    );

    const result = (await runTool("list_devices")) as { error: string };
    expect(result.error).toContain("列出设备失败");
    expect(result.error).toContain("adb 不可用");
  });
});

// ---- ③ get_device ------------------------------------------------------------

describe("get_device", () => {
  it("fake 返回 → 透传 toDict() 全字段", async () => {
    const dict = { device_id: "emulator-5554", state: "device", model: "Pixel 6" };
    const get = vi.fn().mockResolvedValue({ toDict: () => dict });
    mockedShared.mockReturnValue(fakeDeviceManager({ get }));

    const result = await runTool("get_device", { deviceId: "emulator-5554" });
    expect(result).toEqual(dict);
    expect(get).toHaveBeenCalledWith("emulator-5554", true);
  });

  it("设备不存在（core 抛中文错）→ {error} 兜底", async () => {
    mockedShared.mockReturnValue(
      fakeDeviceManager({ get: vi.fn().mockRejectedValue(new Error("设备未连接: nope")) }),
    );

    const result = (await runTool("get_device", { deviceId: "nope" })) as { error: string };
    expect(result.error).toContain("查询设备 nope 失败");
  });
});

// ---- ④ dump_ui ---------------------------------------------------------------

describe("dump_ui", () => {
  it("元素 ≤ 80：count/truncated=false/全量返回；调用参数 compressed:true", async () => {
    const elements = [fakeElement("a"), fakeElement("b")];
    mockedDumpUi.mockResolvedValue(elements as never);

    const result = (await runTool("dump_ui", { deviceId: "emulator-5554" })) as {
      count: number;
      truncated: boolean;
      elements: unknown[];
    };
    expect(result.count).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.elements).toHaveLength(2);
    expect(result.elements[0]).toMatchObject({ text: "a" });
    expect(mockedDumpUi).toHaveBeenCalledWith("emulator-5554", { compressed: true });
  });

  it("元素 > 80：truncated=true 且只返回前 80 个（防 payload 爆炸）", async () => {
    mockedDumpUi.mockResolvedValue(
      Array.from({ length: 82 }, (_, i) => fakeElement(`e${i}`)) as never,
    );

    const result = (await runTool("dump_ui", { deviceId: "emulator-5554" })) as {
      count: number;
      truncated: boolean;
      elements: unknown[];
    };
    expect(result.count).toBe(82);
    expect(result.truncated).toBe(true);
    expect(result.elements).toHaveLength(80);
    expect(result.elements[79]).toMatchObject({ text: "e79" });
  });

  it("dump 失败 → {error: 中文} 兜底", async () => {
    mockedDumpUi.mockRejectedValue(new Error("uiautomator dump 失败"));

    const result = (await runTool("dump_ui", { deviceId: "emulator-5554" })) as { error: string };
    expect(result.error).toContain("dump 设备 emulator-5554 的 UI 失败");
  });
});

// ---- ⑤ find_text -------------------------------------------------------------

describe("find_text", () => {
  it("命中 → {found:true, element: toDict}；默认 exact:true / clickableOnly:false / timeout:5", async () => {
    const el = fakeElement("立即购买");
    mockedFindByText.mockResolvedValue(el as never);

    const result = (await runTool("find_text", {
      deviceId: "emulator-5554",
      text: "立即购买",
    })) as { found: boolean; element: Record<string, unknown> };
    expect(result.found).toBe(true);
    expect(result.element).toMatchObject({ text: "立即购买" });
    expect(mockedFindByText).toHaveBeenCalledWith("emulator-5554", "立即购买", {
      exact: true,
      clickableOnly: false,
      timeout: 5,
    });
  });

  it("UIElementNotFoundError → {found:false, error}（查询未命中不是异常）", async () => {
    mockedFindByText.mockRejectedValue(
      new UIElementNotFoundError("等待 text=\"不存在\" 超时（5.0s）"),
    );

    const result = (await runTool("find_text", {
      deviceId: "emulator-5554",
      text: "不存在",
    })) as { found: boolean; error: string };
    expect(result.found).toBe(false);
    expect(result.error).toContain("超时");
  });

  it("其他错误（如 adb 失败）→ {error: 中文} 兜底", async () => {
    mockedFindByText.mockRejectedValue(new Error("adb 连接失败"));

    const result = (await runTool("find_text", {
      deviceId: "emulator-5554",
      text: "x",
    })) as { error: string };
    expect(result.error).toContain("查找文本失败");
  });
});

// ---- ⑥ list_monitor_tasks ----------------------------------------------------

describe("list_monitor_tasks", () => {
  const monitorTask = {
    id: "m1",
    kind: "monitor",
    deviceId: "emulator-5554",
    label: "可用性监控",
    status: "running",
    startedAtUnixMs: 1000,
    endedAtUnixMs: null,
    unresponsive: false,
    error: null,
    progress: ["ok"],
    progressTotal: 1,
    result: { ok: true },
  };
  const grabTask = { ...monitorTask, id: "g1", kind: "grab", label: "抢票任务" };

  it("只返回 kind=monitor 的任务，且字段为八键投影（不含 progress 全量）", async () => {
    mockedGetTaskManager.mockReturnValue({ list: () => [grabTask, monitorTask] } as never);

    const result = (await runTool("list_monitor_tasks")) as Array<Record<string, unknown>>;
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: "m1",
      label: "可用性监控",
      status: "running",
      startedAtUnixMs: 1000,
      endedAtUnixMs: null,
      error: null,
      result: { ok: true },
    });
    expect(Object.keys(result[0])).toHaveLength(7);
    expect(JSON.stringify(result)).not.toContain("progress");
  });

  it("TaskManager 异常 → {error: 中文} 兜底", async () => {
    mockedGetTaskManager.mockImplementation(() => {
      throw new Error("任务管理器不可用");
    });

    const result = (await runTool("list_monitor_tasks")) as { error: string };
    expect(result.error).toContain("列出监控任务失败");
  });
});

// ---- ⑦ 源码守护（仿 core tests/test_monitor.test.ts 手法）---------------------

describe("源码守护：只读硬约束", () => {
  /** 读 aiTools.ts 源码并剥离注释（块注释 + 行注释），得到纯代码文本。 */
  function codeWithoutComments(): string {
    const source = readFileSync(new URL("./aiTools.ts", import.meta.url), "utf-8");
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  it("代码不引用 @core/actions（tap/swipe/input 等写入动作所在模块）", () => {
    expect(codeWithoutComments()).not.toMatch(/@core\/actions/);
  });

  it("代码不出现任何写入类符号（tap/swipe/inputText/pressKey/scroll/…/damai_grab）", () => {
    const code = codeWithoutComments();
    for (const symbol of [
      "tap",
      "doubleTap",
      "longPress",
      "swipe",
      "scroll",
      "inputText",
      "pressKey",
      "keyEvent",
      "damai_grab",
    ]) {
      expect(code).not.toMatch(new RegExp(`\\b${symbol}\\b`));
    }
  });

  it("core 导入白名单：仅 device/manager、inspector/dump、inspector/find、utils/errors 与 @/task/manager", () => {
    const code = codeWithoutComments();
    const coreImports = [...code.matchAll(/from\s+["'](@[^"']+)["']/g)].map((m) => m[1]);
    expect(new Set(coreImports)).toEqual(
      new Set([
        "@core/device/manager",
        "@core/inspector/dump",
        "@core/inspector/find",
        "@core/utils/errors",
        "@/task/manager",
      ]),
    );
  });
});
