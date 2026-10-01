/**
 * 雷电模拟器生命周期辅助（Python `device/ldplayer.py` 的 TS 对应物）。
 *
 * MCP 动作操作的是已连接的 ADB serial，但原项目工作流还需要先启动指定的
 * 雷电多开实例。本模块把这一宿主机侧的步骤保持显式且无破坏性。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { ADBError } from "../utils/errors";
import { adb, exitReturncode, splitLines, waitForExit, whichAdb, whichBinary } from "./adb";

/** {@link LDPlayerInstance} 的构造参数。 */
export interface LDPlayerInstanceInit {
  /** 雷电多开索引。 */
  index: number;
  /** 实例名称（仅用于展示/报错）。 */
  name: string;
  /** 期望的 ADB serial；可为 "auto" 或空串表示自动发现。 */
  deviceId: string;
  /** 目标应用包名。默认 "cn.damai"。 */
  package?: string;
}

/** 雷电多开索引/名称与其 ADB serial 的映射。 */
export class LDPlayerInstance {
  /** 雷电多开索引。 */
  readonly index: number;
  /** 实例名称。 */
  readonly name: string;
  /** 期望的 ADB serial。 */
  readonly deviceId: string;
  /** 目标应用包名。 */
  readonly package: string;

  constructor(init: LDPlayerInstanceInit) {
    this.index = init.index;
    this.name = init.name;
    this.deviceId = init.deviceId;
    this.package = init.package ?? "cn.damai";
  }
}

/**
 * 返回某个雷电多开索引可能的 ADB serial 列表（按优先级排序、去重）。
 */
export function candidateDeviceIds(index: number, requestedDeviceId = ""): readonly string[] {
  const candidates = [
    `emulator-${5554 + index * 2}`,
    `127.0.0.1:${5555 + index * 2}`,
  ];
  if (requestedDeviceId && requestedDeviceId.toLowerCase() !== "auto") {
    candidates.push(requestedDeviceId);
  }
  return [...new Set(candidates)];
}

/** 当前处于 "device" 状态的 ADB serial 集合。 */
async function connectedDeviceIds(): Promise<Set<string>> {
  const result = await adb("devices", "-l", { check: false, timeout: 5.0 });
  const ids = new Set<string>();
  for (const rawLine of splitLines(result.stdout).slice(1)) {
    const parts = rawLine.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1] === "device") {
      ids.add(parts[0]!);
    }
  }
  return ids;
}

/**
 * 定位雷电的宿主机控制程序 ldconsole。
 *
 * 先探测 PATH，再尝试常见安装位置；找不到时返回 null。
 */
export function whichLdconsole(): string | null {
  const binary = process.platform === "win32" ? "ldconsole.exe" : "ldconsole";
  const found = whichBinary(binary);
  if (found) {
    return found;
  }
  for (const dir of [
    "D:/leidian/LDPlayer9",
    "C:/Program Files/LDPlayer",
    "C:/Program Files/LDPlayer9",
  ]) {
    const p = join(dir, binary);
    if (existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * 运行 ldconsole 子命令（丢弃输出，仅关心退出码——ldconsole 可能派生
 * 继承其输出句柄的子进程，因此 stdout/stderr 走 DEVNULL，与 Python 版一致）。
 */
async function runLdconsole(args: readonly string[], timeout = 30.0): Promise<string> {
  const path = whichLdconsole();
  if (path === null) {
    throw new ADBError("未找到 ldconsole.exe，请安装雷电 9 或配置 LDPlayer 路径");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  timer.unref();

  const child = spawn(path, [...args], {
    stdio: ["inherit", "ignore", "ignore"],
    signal: controller.signal,
  });

  let exit: { code: number | null; signal: NodeJS.Signals | null };
  try {
    exit = await waitForExit(child);
  } catch (exc) {
    // abort 只发 SIGTERM，这里补 SIGKILL（对应 Python 的 proc.kill()）
    child.kill("SIGKILL");
    if (controller.signal.aborted) {
      throw new ADBError(`ldconsole 命令超时: ${args.join(" ")}`);
    }
    throw exc; // 例如 ENOENT：对应 Python 版 FileNotFoundError 原样外抛
  } finally {
    clearTimeout(timer);
  }

  // stdout = stderr = b""（DEVNULL，恒为空；保留 Python 版的读取结构）
  const stdout = Buffer.alloc(0);
  const stderr = Buffer.alloc(0);
  const returncode = exitReturncode(exit.code, exit.signal);
  if (returncode !== 0) {
    const detail = (stderr.length > 0 ? stderr : stdout).toString("utf8").trim();
    throw new ADBError(`ldconsole 失败 (rc=${returncode}): ${detail.slice(0, 300)}`);
  }
  return (stdout.length > 0 ? stdout : Buffer.alloc(0)).toString("utf8").trim();
}

/** {@link launchInstance} 的选项（对应 Python 版的关键字参数）。 */
export interface LaunchInstanceOptions {
  /** 等待 ADB 连接的总超时（秒）。默认 60。 */
  adbTimeout?: number;
  /** 轮询间隔（秒）。默认 1.0。 */
  connectInterval?: number;
}

/**
 * {@link launchInstance} 的返回结构。
 *
 * 键名保持 Python 版返回 dict 的 snake_case 原样（对外表面）。
 */
export interface LaunchInstanceResult {
  index: number;
  name: string;
  device_id: string;
  package: string;
  adb_path: string | null;
  houdini: boolean;
}

/** 启动实例并发现其 ADB serial，但不改变实例本身的任何设置。 */
export async function launchInstance(
  instance: LDPlayerInstance,
  { adbTimeout = 60.0, connectInterval = 1.0 }: LaunchInstanceOptions = {},
): Promise<LaunchInstanceResult> {
  await runLdconsole(["launch", "--index", String(instance.index)], 20.0);
  const deadline = performance.now() / 1000 + adbTimeout;
  let lastError = "";
  const candidates = candidateDeviceIds(instance.index, instance.deviceId);
  let connectAttempted = false;
  while (performance.now() / 1000 < deadline) {
    try {
      const connected = await connectedDeviceIds();
      const deviceId = candidates.find((serial) => connected.has(serial)) ?? null;
      if (deviceId) {
        const nativeBridge = await nativeBridgeEnabled(deviceId);
        return {
          index: instance.index,
          name: instance.name,
          device_id: deviceId,
          package: instance.package,
          adb_path: whichAdb(),
          houdini: nativeBridge,
        };
      }
      if (!connectAttempted) {
        const result = await adb("connect", candidates[1]!, { check: false, timeout: 5.0 });
        lastError = `${result.stdout} ${result.stderr}`.trim();
        connectAttempted = true;
      } else {
        // 复刻 Python 的 f"{sorted(connected)}"：list 的 repr 形态 ['a', 'b']
        const sorted = [...connected].sort();
        lastError = `connected devices: [${sorted.map((s) => `'${s}'`).join(", ")}]`;
      }
    } catch (exc) {
      lastError = exc instanceof Error ? exc.message : String(exc);
    }
    await sleep(connectInterval * 1000);
  }
  throw new ADBError(
    `雷电实例 ${instance.name || instance.index} 启动后未连接 ADB: ${instance.deviceId}; ${lastError}`,
  );
}

/** 读取模拟器的 ARM 桥（houdini）状态，但不改动任何 ISA 属性。 */
async function nativeBridgeEnabled(deviceId: string): Promise<boolean> {
  const result = await adb("shell", "getprop", "persist.sys.nativebridge", {
    deviceId,
    check: false,
    timeout: 5,
  });
  return result.ok && !["", "0"].includes(result.stdout.trim());
}
