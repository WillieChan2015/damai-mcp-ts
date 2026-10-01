/**
 * 多应用 profile 框架（Python `app/profile.py` 的 TS 对应物）。
 *
 * 一个 profile 描述如何驱动某个特定 app 完成抢票。每个 profile 是一串
 * {@link Step}，由 runner（`app/runner.ts`）解释执行。购票者（或 AI agent）
 * 只提供 `device_id`、`item_id` 与若干 profile 专属选项——从不接触原始选择器。
 *
 * 内置 profile 位于 `app/profiles/`，可通过 {@link loadProfile}(name) 按名加载。
 *
 * ESM 迁移说明：Python 版在 `load_profile` 与 `_load_builtins_once` 里做
 * *函数级* import（`from .profiles import _register_builtins`），既避免
 * profile↔profiles 的循环导入，又实现内置项的按需注册。ESM 的静态 import
 * 会形成 `profile → profiles/index → profiles/damai → profile` 的循环，
 * 且内置 profile 在模块顶层 `new AppProfile(...)` 会在该循环下触发 TDZ，
 * 因此这里用异步的 `import()` 动态导入表达同一语义（见 {@link loadProfile}
 * 与模块底部的一次性预热）——这也是 `loadProfile` 带上 Promise 的唯一原因。
 */
import { readFile } from "node:fs/promises";

import { logger } from "../utils/logging";

// ---- 类型 -------------------------------------------------------------------

/**
 * runner 可执行的动作类型（对应 Python `Action` 的 Literal 联合）。
 */
export type Action =
  | "open_detail" // 启动应用并进入演出详情页
  | "wait_text" // 等待文本出现
  | "tap_text" // 查找文本并点按
  | "tap_index" // 点按第 N 个匹配文本
  | "select_checkbox" // 按相邻文本标签切换复选框
  | "check_text" // 断言文本出现（不点按）
  | "sleep" // 直接睡眠，单位秒
  | "screenshot"; // 截屏到文件 / return_base64

/** 步骤的参数表（对应 Python `StepArg = dict[str, Any]`）。 */
export type StepArg = Record<string, unknown>;

/** {@link Step} 的构造参数；除 `name`/`action` 外均带与 Python dataclass 一致的默认值。 */
export interface StepInit {
  /** 步骤名（日志与结果里的标识）。 */
  name: string;
  /** 要执行的动作。 */
  action: Action;
  /** 动作参数。默认 `{}`。 */
  args?: StepArg;
  /** 超时秒数。默认 `5.0`。 */
  timeoutSec?: number;
  /** 失败时是否继续执行后续步骤。默认 `false`。 */
  continueOnFail?: boolean;
}

/** 抢票流水线中的一步 UI 操作。 */
export class Step {
  /** 步骤名（日志与结果里的标识）。 */
  readonly name: string;
  /** 要执行的动作。 */
  readonly action: Action;
  /** 动作参数。 */
  readonly args: StepArg;
  /** 超时秒数。 */
  readonly timeoutSec: number;
  /** 失败时是否继续执行后续步骤。 */
  readonly continueOnFail: boolean;

  constructor(init: StepInit) {
    this.name = init.name;
    this.action = init.action;
    this.args = init.args ?? {};
    this.timeoutSec = init.timeoutSec ?? 5.0;
    this.continueOnFail = init.continueOnFail ?? false;
  }

  /**
   * 序列化为普通对象。
   *
   * 键名保持 Python 版 `to_dict()` 的 snake_case 原样（这是
   * `load_profile_file` 往返读写的对外表面，改动会破坏行为保真）。
   */
  toDict(): {
    name: string;
    action: Action;
    args: StepArg;
    timeout_sec: number;
    continue_on_fail: boolean;
  } {
    return {
      name: this.name,
      action: this.action,
      args: this.args,
      timeout_sec: this.timeoutSec,
      continue_on_fail: this.continueOnFail,
    };
  }
}

/** {@link AppProfile} 的构造参数；除 `name`/`packageName` 外均带默认值。 */
export interface AppProfileInit {
  /** 短标识，如 `damai`、`maoyan`。 */
  name: string;
  /** Android 包名，如 `cn.damai`。 */
  packageName: string;
  /** 可选的 URL 模板，`{item_id}` 会被替换。默认 `null`。 */
  deepLinkTemplate?: string | null;
  /** open_detail 之后顺序执行的动作，每步接收运行上下文。默认 `[]`。 */
  steps?: Step[];
  /**
   * 若 app 支持多观演人（实名制），观演人列表的文本别名——
   * 之后由 `select_viewers` 填充。默认 `null`。
   */
  viewerPicker?: string | null;
  /** agent 可用的自由格式提示串（如 `"amap_disabled"`）。默认 `[]`。 */
  hints?: string[];
}

/** 如何在特定 app 上抢票。 */
export class AppProfile {
  /** 短标识，如 `damai`、`maoyan`。 */
  readonly name: string;
  /** Android 包名，如 `cn.damai`。 */
  readonly packageName: string;
  /** 可选的 URL 模板，`{item_id}` 会被替换。 */
  readonly deepLinkTemplate: string | null;
  /** open_detail 之后顺序执行的动作，每步接收运行上下文。 */
  readonly steps: Step[];
  /** 若 app 支持多观演人（实名制），观演人列表的文本别名。 */
  readonly viewerPicker: string | null;
  /** agent 可用的自由格式提示串。 */
  readonly hints: string[];

  constructor(init: AppProfileInit) {
    this.name = init.name;
    this.packageName = init.packageName;
    this.deepLinkTemplate = init.deepLinkTemplate ?? null;
    this.steps = init.steps ?? [];
    this.viewerPicker = init.viewerPicker ?? null;
    this.hints = init.hints ?? [];
  }

  /**
   * 序列化为普通对象。
   *
   * 键名保持 Python 版 `to_dict()` 的 snake_case 原样（这是
   * `load_profile_file` 往返读写的对外表面，改动会破坏行为保真）。
   */
  toDict(): {
    name: string;
    package_name: string;
    deep_link_template: string | null;
    steps: ReturnType<Step["toDict"]>[];
    viewer_picker: string | null;
    hints: string[];
  } {
    return {
      name: this.name,
      package_name: this.packageName,
      deep_link_template: this.deepLinkTemplate,
      steps: this.steps.map((s) => s.toDict()),
      viewer_picker: this.viewerPicker,
      hints: this.hints,
    };
  }
}

// ---- 自定义步骤回调 ---------------------------------------------------------

/**
 * 自定义步骤的异步回调（对应 Python `CustomStepHandler`）。
 * 接收 `(step, ctx)`，返回输出 dict（或 null）。
 */
export type CustomStepHandler = (
  step: Step,
  ctx: RunContext,
) => Promise<Record<string, unknown> | null>;

/** {@link RunContext} 的构造参数。 */
export interface RunContextInit {
  /** 目标设备序列号。 */
  deviceId: string;
  /** 演出/商品 id。 */
  itemId: string;
  /** profile 专属选项。默认 `{}`。 */
  options?: Record<string, unknown>;
  /** 上一个成功步骤的输出。默认 `null`。 */
  lastResult?: Record<string, unknown> | null;
}

/** 一次运行期间传递给每个步骤的共享状态（runner 会原位更新 `lastResult`）。 */
export class RunContext {
  /** 目标设备序列号。 */
  deviceId: string;
  /** 演出/商品 id。 */
  itemId: string;
  /** profile 专属选项。 */
  options: Record<string, unknown>;
  /** 上一个成功步骤的输出。 */
  lastResult: Record<string, unknown> | null;

  constructor(init: RunContextInit) {
    this.deviceId = init.deviceId;
    this.itemId = init.itemId;
    this.options = init.options ?? {};
    this.lastResult = init.lastResult ?? null;
  }
}

// ---- 注册表 -----------------------------------------------------------------

/** 内存注册表（对应 Python 的 `_PROFILES`）。 */
const _PROFILES = new Map<string, AppProfile>();

/**
 * 把 profile 注册进内存注册表。
 *
 * 传 `override: true` 允许替换同名内置 profile（测试场景与从磁盘加载
 * 用户 profile 时有用）。
 */
export function registerProfile(
  profile: AppProfile,
  { override = false }: { override?: boolean } = {},
): void {
  if (_PROFILES.has(profile.name) && !override) {
    throw new Error(
      `profile ${pyRepr(profile.name)} already registered; pass override=True`,
    );
  }
  _PROFILES.set(profile.name, profile);
  logger.debug(`registered profile ${pyRepr(profile.name)} (${profile.packageName})`);
}

/** 按名取出已注册的 profile；不存在时抛错并列出可用项。 */
export function getProfile(name: string): AppProfile {
  const profile = _PROFILES.get(name);
  if (profile === undefined) {
    throw new Error(
      `profile ${pyRepr(name)} not found; available: ${pyListStr([..._PROFILES.keys()].sort())}`,
    );
  }
  return profile;
}

/** 列出已注册 profile 的名字（升序）。 */
export function listProfiles(): string[] {
  return [..._PROFILES.keys()].sort();
}

/**
 * 按名返回 profile；注册表为空时先惰性注册内置项。
 *
 * Python 版此处是同步函数 + 函数级 import；ESM 的惰性加载原语是异步的
 * `import()`（自带模块缓存，重复调用无额外开销），故签名相应为 Promise。
 */
export async function loadProfile(name: string): Promise<AppProfile> {
  if (_PROFILES.size === 0) {
    const profiles = await import("./profiles/index");
    profiles.registerBuiltins(_PROFILES);
  }
  return getProfile(name);
}

/**
 * 一次性预热：把内置 profile 导入注册表（幂等）。
 *
 * 对应 Python 版模块底部的 `_load_builtins_once()`——模块被导入时即注册
 * 内置项，保证 `list_profiles()` 总能返回规范集合。ESM 动态导入是异步的，
 * 注册在本模块求值完成后的微任务里生效；失败时注册表保持为空
 * （仍可通过 {@link loadProfileFile} 填充）。
 */
async function loadBuiltinsOnce(): Promise<void> {
  if (_PROFILES.size > 0) {
    return;
  }
  try {
    const profiles = await import("./profiles/index");
    profiles.registerBuiltins(_PROFILES);
  } catch (exc) {
    // 内置 profile 是可选的；导入失败时让注册表保持为空
    logger.error(`failed to register built-in profiles: ${excMessage(exc)}`);
  }
}

// 模块导入即预热（对应 Python 版的无副作用顶层调用 `_load_builtins_once()`）
void loadBuiltinsOnce();

// ---- 从磁盘加载 profile -----------------------------------------------------

/**
 * 从磁盘上的 JSON 文件加载 profile 并注册。
 *
 * 文件形态与 {@link AppProfile.toDict} 一致（snake_case 键）。加载后以
 * `override: true` 注册，允许覆盖同名内置 profile。
 */
export async function loadProfileFile(path: string): Promise<AppProfile> {
  const text = await readFile(path, "utf-8");
  const data = JSON.parse(text) as Record<string, unknown>;

  // 对应 Python 的 data.pop("steps", [])
  let rawSteps: unknown[] = [];
  if (data["steps"] !== undefined) {
    if (!Array.isArray(data["steps"])) {
      throw new TypeError("profile 字段 'steps' 必须是数组");
    }
    rawSteps = data["steps"];
  }
  delete data["steps"];

  const steps = rawSteps.map((raw) => stepFromRaw(raw));
  const profile = appProfileFromRaw(data, steps);
  registerProfile(profile, { override: true });
  return profile;
}

/**
 * 转换 JSON 里的一份 step 对象（对应 Python 的 `Step(**s)` 构造）。
 *
 * 与 Python 一致：只对缺失键抛 KeyError（`'name'` / `'action'`），
 * 不做值类型校验（非法动作字符串在运行时才报错）。
 */
function stepFromRaw(raw: unknown): Step {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("steps 元素必须是对象");
  }
  const s = raw as Record<string, unknown>;
  if (!("name" in s)) {
    throw new Error("'name'");
  }
  if (!("action" in s)) {
    throw new Error("'action'");
  }
  return new Step({
    name: s["name"] as string,
    // Python 侧同样不做运行时校验（仅 type: ignore[arg-type]）
    action: s["action"] as Action,
    args: s["args"] === undefined ? {} : (s["args"] as StepArg),
    timeoutSec: s["timeout_sec"] === undefined ? 5.0 : (s["timeout_sec"] as number),
    continueOnFail:
      s["continue_on_fail"] === undefined ? false : (s["continue_on_fail"] as boolean),
  });
}

/**
 * 转换 JSON 的其余字段为 AppProfile（对应 Python 的 `AppProfile(steps=steps, **data)`）。
 *
 * 与 Python 一致：未知键抛 TypeError；必填的 name / package_name 缺失时抛
 * TypeError；其余字段不做值类型校验。
 */
function appProfileFromRaw(data: Record<string, unknown>, steps: Step[]): AppProfile {
  const KNOWN_KEYS = ["name", "package_name", "deep_link_template", "viewer_picker", "hints"];
  for (const key of Object.keys(data)) {
    if (!KNOWN_KEYS.includes(key)) {
      // 对应 Python `**data` 遇到未知关键字参数的 TypeError
      throw new TypeError(`AppProfile 收到意外的关键字参数 '${key}'`);
    }
  }
  if (!("name" in data)) {
    throw new TypeError("profile 缺少必需字段 'name'");
  }
  if (!("package_name" in data)) {
    throw new TypeError("profile 缺少必需字段 'package_name'");
  }
  return new AppProfile({
    name: data["name"] as string,
    packageName: data["package_name"] as string,
    deepLinkTemplate:
      data["deep_link_template"] === undefined ? null : (data["deep_link_template"] as string | null),
    steps,
    viewerPicker:
      data["viewer_picker"] === undefined ? null : (data["viewer_picker"] as string | null),
    hints: data["hints"] === undefined ? [] : (data["hints"] as string[]),
  });
}

// ---- 内部辅助 ---------------------------------------------------------------

/** 等价于 Python 的 `str(exc)`：Error 取 message，其余 String()。 */
function excMessage(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/**
 * 复刻 Python `repr()` 对字符串的形态（错误信息保真用，例如
 * `f"profile {name!r} not found"`）：默认单引号；字符串含 `'` 且不含 `"`
 * 时改用双引号；转义反斜杠、所选引号与常见控制字符。
 */
export function pyRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    if (ch === "\\") {
      out += "\\\\";
    } else if (ch === quote) {
      out += `\\${ch}`;
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\r") {
      out += "\\r";
    } else if (ch === "\t") {
      out += "\\t";
    } else {
      out += ch;
    }
  }
  return `${out}${quote}`;
}

/** 复刻 Python `str(list)` 的形态（如 `['damai', 'maoyan']`）。 */
function pyListStr(items: readonly string[]): string {
  return `[${items.map(pyRepr).join(", ")}]`;
}
