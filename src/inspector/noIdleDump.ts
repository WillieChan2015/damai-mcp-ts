/**
 * 在持续刷新的界面上 dump UI：详情页那次 `waitForIdle` 改成固定 sleep，断开连接的仍 NOP。
 *
 * 准备失败（拉不到 jar、dex 格式不对、设备没有该调用）时返回 null，调用方回落
 * 原生命令。同一进程、同一设备只安装一次。
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { adb } from "../device/adb";
import { logger } from "../utils/logging";
import { patchUiautomatorJar } from "./uiautomatorPatch";

const SYSTEM_JAR = "/system/framework/uiautomator.jar";
const REMOTE_JAR = "/data/local/tmp/damai-uiautomator-noidle.jar";

/** 已成功推送的设备 → 系统 jar 的 sha256。 */
const ready = new Map<string, string>();
/** 这台设备的 jar 无法改写，后续 dump 不再重试安装。 */
const unsupported = new Set<string>();
/** 同一设备并发 dump 共用一次安装。 */
const pending = new Map<string, Promise<boolean>>();
/** 已经打过「跳过 idle」日志的设备，避免每轮轮询刷一行。 */
const announced = new Set<string>();

export interface NoIdleDumpOutput {
  stdout: string;
  stderr: string;
}

/** 清空安装缓存。测试用来隔离设备状态。 */
export function clearNoIdleDumpCache(): void {
  ready.clear();
  unsupported.clear();
  pending.clear();
  announced.clear();
}

/**
 * 跑不等 idle 的 dump。jar 不可用时返回 null。
 * 命令本身已执行（无论成败）时返回 stdout/stderr。
 */
export async function tryNoIdleDump(
  deviceId: string,
  compressed: boolean,
): Promise<NoIdleDumpOutput | null> {
  const installed = await ensureNoIdleJar(deviceId);
  if (!installed) {
    return null;
  }
  const sub = compressed ? "dump --compressed" : "dump";
  const cmd =
    `ANDROID_DATA=/data/local/tmp CLASSPATH=${REMOTE_JAR} ` +
    `app_process /system/bin com.android.commands.uiautomator.Launcher ${sub}`;
  try {
    const result = await adb("shell", cmd, { deviceId, timeout: 15, check: false });
    const stdout = stripTrailingNewlines(result.stdout);
    const stderr = stripTrailingNewlines(result.stderr);
    if (isLauncherUnsupported(stdout, stderr)) {
      unsupported.add(deviceId);
      ready.delete(deviceId);
      logger.debug(`不等 idle 的 uiautomator 无法在设备 ${deviceId} 上启动，回落系统命令`);
      return null;
    }
    if (
      (stdout.includes("dumped") || stderr.includes("dumped")) &&
      !announced.has(deviceId)
    ) {
      announced.add(deviceId);
      logger.info(`设备 ${deviceId} 的 uiautomator dump 已跳过 idle 等待`);
    }
    return { stdout, stderr };
  } catch (exc) {
    // 超过等待还没返回，多半是改写没生效、设备仍在等 idle。停用这条路径，避免每次轮询都白等。
    unsupported.add(deviceId);
    ready.delete(deviceId);
    logger.debug(
      `不等 idle 的 uiautomator 失败（${exc instanceof Error ? exc.message : String(exc)}），回落系统命令`,
    );
    return null;
  }
}

async function ensureNoIdleJar(deviceId: string): Promise<boolean> {
  if (unsupported.has(deviceId)) {
    return false;
  }
  if (ready.has(deviceId)) {
    return true;
  }
  const existing = pending.get(deviceId);
  if (existing) {
    return existing;
  }
  const job = installNoIdleJar(deviceId).finally(() => {
    pending.delete(deviceId);
  });
  pending.set(deviceId, job);
  return job;
}

async function installNoIdleJar(deviceId: string): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), "damai-uiautomator-"));
  const pulled = join(dir, "uiautomator.jar");
  const patchedPath = join(dir, "noidle.jar");
  try {
    const result = await adb("pull", SYSTEM_JAR, pulled, {
      deviceId,
      timeout: 20,
      check: false,
    });
    if (!result.ok) {
      logger.debug(
        `拉取 ${SYSTEM_JAR} 失败（rc=${result.returncode}），回落系统 uiautomator dump`,
      );
      return false;
    }
    const raw = await readFile(pulled);
    const hash = createHash("sha256").update(raw).digest("hex");
    const patched = patchUiautomatorJar(raw);
    await writeFile(patchedPath, patched);
    const pushed = await adb("push", patchedPath, REMOTE_JAR, {
      deviceId,
      timeout: 20,
      check: false,
    });
    if (!pushed.ok) {
      logger.debug(`推送不等 idle 的 uiautomator 失败（rc=${pushed.returncode}）`);
      return false;
    }
    await adb("shell", "rm -rf /data/local/tmp/dalvik-cache && mkdir -p /data/local/tmp/dalvik-cache", {
      deviceId,
      timeout: 5,
      check: false,
    });
    ready.set(deviceId, hash);
    return true;
  } catch (exc) {
    unsupported.add(deviceId);
    logger.debug(
      `无法改写 uiautomator.jar（${exc instanceof Error ? exc.message : String(exc)}），回落系统命令`,
    );
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function isLauncherUnsupported(stdout: string, stderr: string): boolean {
  const text = `${stdout}\n${stderr}`;
  if (/could not get idle state|null root node/.test(text)) {
    return false;
  }
  return /ClassNotFoundException|NoClassDefFoundError|app_process: not found/.test(text);
}

function stripTrailingNewlines(text: string): string {
  return text.replace(/[\r\n]+$/, "");
}
