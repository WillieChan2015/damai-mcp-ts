/**
 * 在真实 Android 设备上执行 {@link AppProfile} 的步骤
 * （Python `app/runner.py` 的 TS 对应物）。
 *
 * runner 刻意保持精简：每个 {@link Step} 动作是一个映射到小型异步函数的
 * 字符串。超出内置动作之外的东西不在范围内（请用自定义 profile 插件）。
 *
 * runner 返回结构化的 {@link RunResult}，含每一步的结果，调用方
 * （MCP/CLI/agent）无需翻日志即可定位问题。
 */
import { setTimeout as sleep } from "node:timers/promises";

import { inputText, tap } from "../actions/actions";
import { adb } from "../device/adb";
import { dumpUi } from "../inspector/dump";
import { findByText, waitForElement } from "../inspector/find";
import { logger } from "../utils/logging";
import { AppProfile, pyRepr, RunContext, Step } from "./profile";

// ---- 结果模型 ---------------------------------------------------------------

/** 单步执行状态（对应 Python 注释 `# "ok" | "failed" | "skipped"`，初始为 "pending"）。 */
export type StepStatus = "pending" | "ok" | "failed" | "skipped";

/** 整次运行状态（对应 Python 注释 `# "submitted" | "needs_human" | "failed"`）。 */
export type RunStatus = "submitted" | "needs_human" | "failed";

/** {@link StepResult} 的构造参数。 */
export interface StepResultInit {
  /** 步骤名。 */
  stepName: string;
  /** 动作名。 */
  action: string;
  /** 开始时间（Unix 毫秒）。 */
  startedAtMs: number;
  /** 结束时间（Unix 毫秒）。默认 `null`（未结束）。 */
  finishedAtMs?: number | null;
  /** 执行状态。默认 `"pending"`。 */
  status?: StepStatus;
  /** 动作输出。默认 `null`。 */
  output?: Record<string, unknown> | null;
  /** 失败原因。默认 `null`。 */
  error?: string | null;
}

/** 单个步骤的执行结果（runner 会在执行过程中原位更新字段）。 */
export class StepResult {
  /** 步骤名。 */
  stepName: string;
  /** 动作名。 */
  action: string;
  /** 开始时间（Unix 毫秒）。 */
  startedAtMs: number;
  /** 结束时间（Unix 毫秒）；null 表示尚未结束。 */
  finishedAtMs: number | null;
  /** 执行状态。 */
  status: StepStatus;
  /** 动作输出。 */
  output: Record<string, unknown> | null;
  /** 失败原因。 */
  error: string | null;

  constructor(init: StepResultInit) {
    this.stepName = init.stepName;
    this.action = init.action;
    this.startedAtMs = init.startedAtMs;
    this.finishedAtMs = init.finishedAtMs ?? null;
    this.status = init.status ?? "pending";
    this.output = init.output ?? null;
    this.error = init.error ?? null;
  }

  /** 已耗时（毫秒）；未结束时为 0。 */
  get elapsedMs(): number {
    if (this.finishedAtMs === null) {
      return 0;
    }
    return this.finishedAtMs - this.startedAtMs;
  }

  /**
   * 序列化为普通对象。
   *
   * 键名保持 Python 版 `to_dict()` 的 snake_case 原样（MCP 工具响应的对外表面）。
   */
  toDict(): {
    step: string;
    action: string;
    status: StepStatus;
    elapsed_ms: number;
    output: Record<string, unknown> | null;
    error: string | null;
  } {
    return {
      step: this.stepName,
      action: this.action,
      status: this.status,
      elapsed_ms: this.elapsedMs,
      output: this.output,
      error: this.error,
    };
  }
}

/** {@link RunResult} 的构造参数。 */
export interface RunResultInit {
  /** profile 名。 */
  profile: string;
  /** Android 包名。 */
  package: string;
  /** 演出/商品 id。 */
  itemId: string;
  /** 运行状态。 */
  status: RunStatus;
  /** 各步骤结果。默认 `[]`。 */
  steps?: StepResult[];
  /** 首个失败步骤的错误摘要。默认 `null`。 */
  error?: string | null;
}

/** 整次 profile 运行的结构化结果。 */
export class RunResult {
  /** profile 名。 */
  profile: string;
  /** Android 包名。 */
  package: string;
  /** 演出/商品 id。 */
  itemId: string;
  /** 运行状态。 */
  status: RunStatus;
  /** 各步骤结果。 */
  steps: StepResult[];
  /** 首个失败步骤的错误摘要。 */
  error: string | null;

  constructor(init: RunResultInit) {
    this.profile = init.profile;
    this.package = init.package;
    this.itemId = init.itemId;
    this.status = init.status;
    this.steps = init.steps ?? [];
    this.error = init.error ?? null;
  }

  /**
   * 序列化为普通对象。
   *
   * 键名保持 Python 版 `to_dict()` 的 snake_case 原样（MCP 工具响应的对外表面）。
   */
  toDict(): {
    profile: string;
    package: string;
    item_id: string;
    status: RunStatus;
    steps: ReturnType<StepResult["toDict"]>[];
    error: string | null;
  } {
    return {
      profile: this.profile,
      package: this.package,
      item_id: this.itemId,
      status: this.status,
      steps: this.steps.map((s) => s.toDict()),
      error: this.error,
    };
  }
}

/** 对应 Python 的 `_now_ms()`：`int(time.time() * 1000)`。 */
function nowMs(): number {
  return Date.now();
}

// ---- 动作实现 ---------------------------------------------------------------

/** 单个动作处理器的统一签名（Python 里多余参数经 `*_a` 吞掉，TS 直接少声明）。 */
type StepActionHandler = (
  step: Step,
  ctx: RunContext,
  profile: AppProfile,
) => Promise<Record<string, unknown>>;

/**
 * 打开演出详情页。
 *
 * 当前经包启动器启动（跨 app 最可靠）。URL deep-link 可以后续补充；目前
 * 借助 profile 钩子复用既有 `damai_open_concert` 的形态。
 *
 * 注意：Python 原版此处 `from ..device.adb import run_adb` 引用了不存在的
 * `run_adb`（调用即 ImportError），按迁移约定修复为调用正确的 {@link adb}
 * 封装；`check` 保持默认 true，使 `am start` 失败抛出 ADBError、落入
 * monkey 兜底分支。
 */
async function actionOpenDetail(
  step: Step,
  ctx: RunContext,
  profile: AppProfile,
): Promise<Record<string, unknown>> {
  const pkg = profile.packageName;
  try {
    await adb("shell", "am", "start", "-n", `${pkg}/.homepage.MainActivity`, {
      deviceId: ctx.deviceId,
      timeout: 10.0,
    });
    return { opened_pkg: pkg };
  } catch {
    await adb(
      "shell",
      "monkey",
      "-p",
      pkg,
      "-c",
      "android.intent.category.LAUNCHER",
      "1",
      { deviceId: ctx.deviceId, timeout: 10.0 },
    );
    return { opened_pkg: pkg, via: "monkey" };
  }
}

/** 等待文本出现。 */
async function actionWaitText(
  step: Step,
  ctx: RunContext,
): Promise<Record<string, unknown>> {
  const text = requireTextArg(step.args, "text");
  const el = await waitForElement(ctx.deviceId, `text=${text}`, {
    timeout: step.timeoutSec,
  });
  return { found: text, center: [...el.center], text: el.text };
}

/** 查找文本并点按。 */
async function actionTapText(
  step: Step,
  ctx: RunContext,
): Promise<Record<string, unknown>> {
  const text = requireTextArg(step.args, "text");
  const exactRaw = step.args["exact"];
  const exact = exactRaw === undefined ? false : Boolean(exactRaw);
  const el = await findByText(ctx.deviceId, text, {
    exact,
    timeout: step.timeoutSec,
  });
  await tap(ctx.deviceId, el.center[0], el.center[1]);
  return { tapped_text: text, center: [...el.center] };
}

/**
 * 点按第 N 个匹配文本。
 *
 * 注意：Python 原版此处同样引用了不存在的 `run_adb`，修复为 {@link adb}。
 * 这里传 `check: false`，让非零退出码走下方 `returncode != 0` 分支
 * （与 ntp.ts 对同类问题的处理一致），而不是在检查之前就抛 ADBError。
 * 另外 Python 原版调用 `dump_ui(device_id, refresh=True)`，但 `dump_ui`
 * 并没有 refresh 参数（调用即 TypeError）——修复为标准的 {@link dumpUi}。
 */
async function actionTapIndex(
  step: Step,
  ctx: RunContext,
): Promise<Record<string, unknown>> {
  const text = requireTextArg(step.args, "text");
  const index = pyInt(step.args["index"] ?? 0);
  // 找出所有匹配（先按 Python 原版跑一次 dump 命令，随后经 dumpUi 重新 dump）
  const out = await adb("shell", "uiautomator", "dump", "/sdcard/ui.xml", {
    deviceId: ctx.deviceId,
    timeout: 10.0,
    check: false,
  });
  if (out.returncode !== 0) {
    throw new Error(`uiautomator dump failed: ${out.stderr}`);
  }
  // 经既有的 dump 解析
  const elements = await dumpUi(ctx.deviceId);
  const matches = elements.filter((e) => (e.text || "").includes(text));
  if (index >= matches.length) {
    throw new Error(
      `only ${matches.length} matches for ${pyRepr(text)}, wanted index ${index}`,
    );
  }
  const el = matches[index];
  await tap(ctx.deviceId, el.center[0], el.center[1]);
  return { tapped_index: index, text: el.text };
}

/**
 * 按相邻文本标签切换复选框。
 *
 * 向左找复选框的完整实现从简：直接点按标签文本——在大麦/猫眼上均可行。
 */
async function actionSelectCheckbox(
  step: Step,
  ctx: RunContext,
): Promise<Record<string, unknown>> {
  const label = requireTextArg(step.args, "label");
  const el = await findByText(ctx.deviceId, label, {
    exact: false,
    timeout: step.timeoutSec,
  });
  await tap(ctx.deviceId, el.center[0], el.center[1]);
  return { toggled_label: label };
}

/** 断言文本出现（不点按）。 */
async function actionCheckText(
  step: Step,
  ctx: RunContext,
): Promise<Record<string, unknown>> {
  const text = requireTextArg(step.args, "text");
  const exactRaw = step.args["exact"];
  const exact = exactRaw === undefined ? true : Boolean(exactRaw);
  const el = await findByText(ctx.deviceId, text, {
    exact,
    timeout: step.timeoutSec,
  });
  return { present: true, text: el.text };
}

/** 直接睡眠。 */
async function actionSleep(step: Step): Promise<Record<string, unknown>> {
  const secRaw = step.args["seconds"] ?? 1.0;
  const sec = pyFloatCast(secRaw);
  await sleep(sec * 1000);
  return { slept_sec: sec };
}

/** 输入文本。 */
async function actionInputText(
  step: Step,
  ctx: RunContext,
): Promise<Record<string, unknown>> {
  const text = requireTextArg(step.args, "text");
  const delayMs = pyFloatCast(step.args["delay_ms"] ?? 0);
  await inputText(ctx.deviceId, text, { delayMs });
  return { input_len: text.length };
}

/**
 * 动作分发表（对应 Python 的 `_ACTION_TABLE`）。
 *
 * 与 Python 版一致：表是 string 键的普通 dict——`"input_text"` 虽不在
 * `Action` 联合类型里，但在此注册、可执行；而 `"screenshot"` 虽在类型里，
 * 却没有注册处理器——执行 screenshot 步骤会走 `unknown action` 错误分支。
 */
const ACTION_TABLE: Record<string, StepActionHandler | undefined> = {
  open_detail: actionOpenDetail,
  wait_text: actionWaitText,
  tap_text: actionTapText,
  tap_index: actionTapIndex,
  select_checkbox: actionSelectCheckbox,
  check_text: actionCheckText,
  sleep: actionSleep,
  input_text: actionInputText,
};

// ---- 执行器 -----------------------------------------------------------------

/**
 * 在设备上执行 profile。
 *
 * @param profile 已注册（或手工构造）的 {@link AppProfile}。
 * @param deviceId 目标设备序列号。
 * @param itemId 演出/商品 id。
 * @param options profile 专属选项（写入 {@link RunContext.options}）。
 */
export async function runProfile(
  profile: AppProfile,
  deviceId: string,
  itemId: string,
  options: Record<string, unknown> | null = null,
): Promise<RunResult> {
  const ctx = new RunContext({ deviceId, itemId, options: options ?? {} });
  const out = new RunResult({
    profile: profile.name,
    package: profile.packageName,
    itemId,
    status: "needs_human",
  });

  logger.info(`[runner] start profile=${profile.name} device=${deviceId} item=${itemId}`);
  for (const step of profile.steps) {
    const sr = new StepResult({
      stepName: step.name,
      action: step.action,
      startedAtMs: nowMs(),
    });
    try {
      const handler = ACTION_TABLE[step.action];
      if (handler === undefined) {
        throw new Error(`unknown action ${pyRepr(step.action)}`);
      }
      const outStep = await handler(step, ctx, profile);
      sr.output = outStep;
      sr.status = "ok";
    } catch (exc) {
      sr.status = "failed";
      sr.error = excToStr(exc);
      out.error = `${step.name}: ${excToStr(exc)}`;
      out.steps.push(sr);
      if (!step.continueOnFail) {
        out.status = "failed";
        sr.finishedAtMs = nowMs();
        logger.error(`[runner] step ${pyRepr(step.name)} failed: ${excToStr(exc)}`);
        break;
      }
      // 注意：Python 原版在 continue_on_fail 失败路径上会把同一个 sr
      // append 两次（前置 append + 此处再 append），此处按行为保真保留。
      sr.finishedAtMs = nowMs();
      out.steps.push(sr);
      logger.warning(
        `[runner] step ${pyRepr(step.name)} failed: ${excToStr(exc)} (continuing)`,
      );
      continue;
    }
    sr.finishedAtMs = nowMs();
    out.steps.push(sr);
    logger.info(`[runner] step ${pyRepr(step.name)} ok in ${sr.elapsedMs}ms`);
    ctx.lastResult = sr.output;
  }

  if (out.status !== "failed") {
    out.status = "submitted";
  }

  logger.info(`[runner] finish status=${out.status}`);
  return out;
}

// ---- 内部辅助 ---------------------------------------------------------------

/**
 * 取必需的字符串参数；缺失时抛与 Python `step.args["text"]` 的
 * KeyError 一致的消息（`'text'`）。
 */
function requireTextArg(args: Step["args"], key: string): string {
  if (!(key in args)) {
    throw new Error(`'${key}'`);
  }
  const value = args[key];
  if (typeof value !== "string") {
    throw new TypeError(`step.args['${key}'] 必须是字符串`);
  }
  return value;
}

/**
 * 对应 Python 的 `int(...)` 截断语义：数字向下取整，数字字符串解析；
 * 无法转换时抛与 Python 一致的 ValueError 消息。
 */
function pyInt(value: unknown): number {
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
 * 对应 Python 的 `float(...)`：数字原样，数字字符串解析；
 * 无法转换时抛与 Python 一致的 ValueError 消息。
 */
function pyFloatCast(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(n)) {
    throw new Error(`could not convert string to float: '${String(value)}'`);
  }
  return n;
}

/** 等价于 Python 的 `str(exc)`：Error 取 message，其余 String()。 */
function excToStr(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}
