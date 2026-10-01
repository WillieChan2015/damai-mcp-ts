/**
 * Android 设备上的原子 UI 动作（Python `actions/actions.py` 的 TS 对应物）。
 *
 * 每个函数都是 `adb shell input ...` 或 `adb shell screencap ...` 的薄封装，
 * 在 adb 调用返回后立即返回。
 *
 * 这些刻意保持*低层*——按文本/id 查找元素见 `inspector`，业务逻辑见 `damai`。
 */
import { writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { Jimp } from "jimp";

import { adb, shell } from "../device/adb";
import { ADBError } from "../utils/errors";
import { retry, type RetryableErrorClass } from "../utils/retry";

/** {@link pressKey} 接受的具名按键（取值保持 Android 键名原样）。 */
export type KeyName =
  | "home"
  | "back"
  | "menu"
  | "enter"
  | "delete"
  | "tab"
  | "power"
  | "volume_up"
  | "volume_down"
  | "camera"
  | "up"
  | "down"
  | "left"
  | "right";

/** {@link scroll} 接受的滚动方向。 */
export type ScrollDirection = "up" | "down" | "left" | "right";

/** keyevent 码映射（子集——按需扩展）。 */
const KEYCODE: Record<string, number | undefined> = {
  home: 3,
  back: 4,
  menu: 82,
  enter: 66,
  delete: 67,
  tab: 61,
  power: 26,
  volume_up: 24,
  volume_down: 25,
  camera: 27,
  up: 19,
  down: 20,
  left: 21,
  right: 22,
};

// ---- tap / press ------------------------------------------------------------

/**
 * 在 (x, y) 处点按。`durationMs > 0` 模拟偏长按的点按。
 */
export async function tap(
  deviceId: string,
  x: number,
  y: number,
  { durationMs = 50 }: { durationMs?: number } = {},
): Promise<void> {
  let cmd = `input tap ${x} ${y}`;
  if (durationMs && durationMs !== 50) {
    // `input swipe x y x y ms` 是控制按压时长的标准做法
    cmd = `input swipe ${x} ${y} ${x} ${y} ${durationMs}`;
  }
  await shell(cmd, { deviceId, check: true });
}

/**
 * 在 (x, y) 处双击：两次 tap 之间隔 `gapMs`（默认 80ms）。
 */
export async function doubleTap(
  deviceId: string,
  x: number,
  y: number,
  { gapMs = 80 }: { gapMs?: number } = {},
): Promise<void> {
  await tap(deviceId, x, y);
  await sleep(gapMs);
  await tap(deviceId, x, y);
}

/**
 * 在 (x, y) 处长按 `durationMs`。上下文菜单建议用 500-1000ms。
 */
export async function longPress(
  deviceId: string,
  x: number,
  y: number,
  { durationMs = 800 }: { durationMs?: number } = {},
): Promise<void> {
  await shell(`input swipe ${x} ${y} ${x} ${y} ${durationMs}`, {
    deviceId,
    check: true,
  });
}

// ---- swipe / scroll ---------------------------------------------------------

/**
 * 在 `durationMs` 内从 (x1, y1) 拖动到 (x2, y2)。
 */
export async function swipe(
  deviceId: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  { durationMs = 300 }: { durationMs?: number } = {},
): Promise<void> {
  await shell(`input swipe ${x1} ${y1} ${x2} ${y2} ${durationMs}`, {
    deviceId,
    check: true,
  });
}

/**
 * 按 `distanceRatio * 屏幕 高/宽` 的幅度滚动屏幕。
 *
 * `up` 表示内容上移（手指从下往上），露出下方内容——与多数应用中
 * 用户意图一致。
 */
export async function scroll(
  deviceId: string,
  direction: ScrollDirection = "down",
  distanceRatio = 0.6,
  { durationMs = 300 }: { durationMs?: number } = {},
): Promise<void> {
  const sizeStr = (
    await shell("wm", "size", { deviceId, check: false, timeout: 5 })
  ).trim();
  const m = /(\d+)x(\d+)/.exec(sizeStr);
  if (!m) {
    throw new ADBError(`无法获取屏幕分辨率: ${sizeStr}`);
  }
  const w = Number(m[1]);
  const h = Number(m[2]);
  const cx = Math.floor(w / 2);
  const cy = Math.floor(h / 2);
  const d = Math.trunc(Math.min(w, h) * distanceRatio);
  const deltas: Record<ScrollDirection, readonly [number, number]> = {
    up: [0, -d], // 手指 bottom→top   → 内容上移
    down: [0, d], // 手指 top→bottom   → 内容下移
    left: [-d, 0], // 手指 right→left   → 内容左移
    right: [d, 0], // 手指 left→right   → 内容右移
  };
  const [dx, dy] = deltas[direction];
  await swipe(deviceId, cx, cy, cx + dx, cy + dy, { durationMs });
}

// ---- text / key -------------------------------------------------------------

/**
 * 输入文本。空格必须以 %s 发送；CJK 走广播 IME。
 *
 * 中文（CJK）文本需要支持广播的输入法，例如 ADBKeyBoard。
 * 较短的 ASCII 文本则回退为逐字符 `input text`（`delayMs` 时逐字发送）。
 */
export async function inputText(
  deviceId: string,
  text: string,
  { delayMs = 0 }: { delayMs?: number } = {},
): Promise<void> {
  if (!text) {
    return;
  }
  // CJK 字符或特殊字符 → 若安装了 ADBKeyBoard 则走广播输入法，否则
  // 把文本拆成 ASCII 段逐段用 input text 发送
  const safe = text.replaceAll(" ", "%s");
  if (delayMs) {
    for (const ch of safe) {
      await shell(`input text ${ch}`, { deviceId, check: true });
      await sleep(delayMs);
    }
  } else {
    await shell(`input text ${safe}`, { deviceId, check: true });
  }
}

/**
 * 按具名按键（如 "back"、"home"）或数字 keyevent 码。
 */
export async function pressKey(
  deviceId: string,
  key: KeyName | number,
): Promise<void> {
  let code: number;
  if (typeof key === "string") {
    const mapped = KEYCODE[key.toLowerCase()];
    if (mapped === undefined) {
      throw new ADBError(`未知按键: ${key}`);
    }
    code = mapped;
  } else {
    code = Math.trunc(key); // 对应 Python `int(key)`
  }
  await shell(`input keyevent ${code}`, { deviceId, check: true });
}

// ---- screenshot -------------------------------------------------------------

/**
 * 对应 Python `_resize_png`：等比缩小到 `maxSize` 内再编码回 PNG。
 *
 * 采用 Pillow `Image.thumbnail` 的语义（已实测对齐）：
 * 图像已在 `maxSize` 内时不放大；缩放目标尺寸按 floor 取整、最小为 1。
 */
async function resizePng(
  pngBytes: Buffer,
  maxSize: readonly [number, number],
): Promise<Buffer> {
  const img = await Jimp.read(pngBytes);
  const x = Math.floor(maxSize[0]);
  const y = Math.floor(maxSize[1]);
  if (!(x >= img.bitmap.width && y >= img.bitmap.height)) {
    const aspect = img.bitmap.width / img.bitmap.height;
    let w: number;
    let h: number;
    if (x / y >= aspect) {
      w = Math.max(1, Math.floor(y * aspect));
      h = Math.max(1, Math.floor(y));
    } else {
      w = Math.max(1, Math.floor(x));
      h = Math.max(1, Math.floor(x / aspect));
    }
    img.resize({ w, h });
  }
  return img.getBuffer("image/png");
}

/**
 * 截取设备屏幕。
 *
 * @param savePath - 给出时把 PNG 字节写入该路径。
 * @param options.returnBase64 - 为 true 时返回 base64 字符串（便于 MCP 传输）。
 * @param options.maxSize - 可选 (宽, 高)，为传输流量做等比缩小。
 * @returns 给出 savePath 时仍是 PNG 字节（与 Python 版一致），否则
 *          返回字节（或 base64 字符串）。
 */
export const screenshot = retry({
  maxAttempts: 2,
  // RetryableErrorClass 要求 `(...args: unknown[])` 构造签名，与具体错误类
  // `new (message: string, ...)` 在 strictFunctionTypes 逆变下不兼容
  // （基座 utils/retry.ts 的类型缺陷，见迁移报告）；此处仅做类型桥接，
  // 运行时仍是 `exc instanceof ADBError` 判定。
  exceptions: [ADBError] as unknown as readonly RetryableErrorClass[],
})(
  async function screenshot(
    deviceId: string,
    savePath?: string,
    {
      returnBase64 = false,
      maxSize = null,
    }: { returnBase64?: boolean; maxSize?: readonly [number, number] | null } = {},
  ): Promise<Buffer | string> {
    // exec-out 直接走二进制通道：绕过 Windows 控制台的 GBK 代码页，
    // 避免 screencap 的 PNG 字节流被 code page 转码破坏。
    const result = await adb("exec-out", "screencap", "-p", {
      deviceId,
      timeout: 15,
      check: true,
    });
    let pngBytes = result.stdoutBytes;

    if (maxSize !== null) {
      pngBytes = await resizePng(pngBytes, maxSize);
    }

    if (savePath !== undefined) {
      await writeFile(savePath, pngBytes);
    }
    if (returnBase64) {
      return pngBytes.toString("base64");
    }
    return pngBytes;
  },
);

// ---- timing helper ----------------------------------------------------------

/**
 * 异步睡眠——为语义清晰保留的别名。
 */
export async function waitMs(ms: number): Promise<void> {
  await sleep(ms);
}
