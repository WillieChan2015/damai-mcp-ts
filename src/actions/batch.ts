/**
 * 批量 ADB 输入——在单次 adb shell 调用里发送多条命令
 * （Python `actions/batch.py` 的 TS 对应物）。
 *
 * 每次 `adb shell` 往返依 USB / TCP 传输不同耗时 30-80ms。抢票流水线需要
 * 连续点击多个点时，把它们拼进一条 adb shell 命令可省约 70% 的开销。
 *
 * 两种形式：
 *
 * - {@link batchTap} —— 依次点按 N 个点。
 * - {@link batchSend} —— `input ...` 命令组成的原始脚本。
 *
 * 刻意绕过 `actions.tap` 封装——那个封装面向单次点击；batch 是快路径。
 */
import { adb } from "../device/adb";

/**
 * 在一次 adb shell 调用里按顺序点按每个 (x, y)。
 *
 * @param points - (x, y) 坐标列表。
 * @param options.delayMs - 每次点击之间可选的睡眠（毫秒）。
 * @param options.timeout - 单次 shell 调用的总超时（秒）。
 *
 * 每次点击派发为 `input tap x y` 并用 `;` 串联。5 次点击且不带 delay 时，
 * 把 5×~50ms = 250ms 降到 ~70ms。
 */
export async function batchTap(
  deviceId: string,
  points: readonly (readonly [number, number])[],
  { delayMs = 0, timeout = 10.0 }: { delayMs?: number; timeout?: number } = {},
): Promise<void> {
  if (points.length === 0) {
    return;
  }

  const scriptParts: string[] = [];
  for (const [x, y] of points) {
    scriptParts.push(`input tap ${Math.trunc(x)} ${Math.trunc(y)};`);
  }
  let script: string;
  if (delayMs > 0) {
    // 重排：只在真实点击之间插入 sleep
    const spaced: string[] = [];
    for (let i = 0; i < scriptParts.length; i++) {
      spaced.push(scriptParts[i]);
      if (i < scriptParts.length - 1) {
        spaced.push(`sleep ${(delayMs / 1000).toFixed(3)};`);
      }
    }
    script = spaced.join(" ");
  } else {
    script = scriptParts.join(" ");
  }

  await adb("shell", script, { deviceId, timeout, check: true });
}

/**
 * 批量滑动：每项为 (x1, y1, x2, y2, durationMs)。
 *
 * 所有滑动在一次 adb shell 里发出。适合"上滑 × 5 滚到底部"之类的宏。
 */
export async function batchSwipe(
  deviceId: string,
  swipes: readonly (readonly [number, number, number, number, number])[],
  { timeout = 10.0 }: { timeout?: number } = {},
): Promise<void> {
  if (swipes.length === 0) {
    return;
  }
  const script = swipes
    .map(
      ([x1, y1, x2, y2, d]) =>
        `input swipe ${Math.trunc(x1)} ${Math.trunc(y1)} ${Math.trunc(x2)} ${Math.trunc(y2)} ${Math.trunc(d)};`,
    )
    .join(" ");
  await adb("shell", script, { deviceId, timeout, check: true });
}

/**
 * 发送一段原始 adb shell 脚本。格式化由调用方负责。
 *
 * 示例::
 *
 *     await batchSend(deviceId, "input tap 100 200; input tap 300 400;")
 */
export async function batchSend(
  deviceId: string,
  script: string,
  { timeout = 10.0 }: { timeout?: number } = {},
): Promise<void> {
  await adb("shell", script, { deviceId, timeout, check: true });
}
