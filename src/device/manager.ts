/**
 * 设备管理器：发现并跟踪已连接的 Android 设备/模拟器
 * （Python `device/manager.py` 的 TS 对应物）。
 *
 * 维护以 device_id 为键的内存注册表，避免每次动作调用都 shell 出 `adb devices`。
 *
 * 并发模型：本模块可安全地跨异步任务共享——Python 版的 asyncio.Lock 只保护
 * 「替换缓存 + 更新时间戳」这两步写入，在 JS 单线程模型下赋值本身原子，
 * 语义等价（代价是并发刷新可能重复执行 adb 调用，与 Python 版一致）。
 * 子进程调用经由无状态的 {@link adb}，从不持有长驻 adb 进程。
 */

import { ADBError, DeviceNotFoundError } from "../utils/errors";
import { logger } from "../utils/logging";
import { adb, shell, splitLines } from "./adb";

/** 单台 Android 设备运行时状态的快照。 */
export interface DeviceInfoInit {
  /** adb 序列号（如 `emulator-5554` 或 `127.0.0.1:5555`）。 */
  deviceId: string;
  /** 设备状态："device" | "offline" | "unauthorized"。 */
  state: string;
  /** 型号代码（ro.product.model），如 `24129PN74C`。 */
  model?: string;
  /** 市场名（ro.product.marketname），如 `Xiaomi 15`。没有则为空。 */
  marketName?: string;
  /** 系统设置里的设备名（persist.sys.device_name），用户自己起的名字。 */
  deviceName?: string;
  /** Android 版本（ro.build.version.release）。 */
  androidVersion?: string;
  /** SDK 版本（ro.build.version.sdk）。 */
  sdk?: string;
  /** CPU ABI（ro.product.cpu.abi）。 */
  abi?: string;
  /** 屏幕分辨率，如 "1080x2400"。 */
  screenSize?: string;
  /** 总内存（MB）。 */
  totalMemMb?: number;
  /** 是否为模拟器。 */
  isEmulator?: boolean;
  /** 最后一次见到该设备的时间（Unix 秒）。 */
  lastSeen?: number;
}

/** 单台 Android 设备运行时状态的快照。 */
export class DeviceInfo {
  /** adb 序列号。 */
  readonly deviceId: string;
  /** 设备状态："device" | "offline" | "unauthorized"。 */
  readonly state: string;
  /** 型号代码（ro.product.model）。 */
  readonly model: string;
  /** 市场名。没有可读机型名时为空串。 */
  readonly marketName: string;
  /** 用户在系统设置里起的设备名。没有时为空串。 */
  readonly deviceName: string;
  /** Android 版本。 */
  readonly androidVersion: string;
  /** SDK 版本。 */
  readonly sdk: string;
  /** CPU ABI。 */
  readonly abi: string;
  /** 屏幕分辨率，如 "1080x2400"。 */
  readonly screenSize: string;
  /** 总内存（MB）。 */
  readonly totalMemMb: number;
  /** 是否为模拟器。 */
  readonly isEmulator: boolean;
  /** 最后一次见到该设备的时间（Unix 秒）。 */
  readonly lastSeen: number;

  constructor(init: DeviceInfoInit) {
    this.deviceId = init.deviceId;
    this.state = init.state;
    this.model = init.model ?? "";
    this.marketName = init.marketName ?? "";
    this.deviceName = init.deviceName ?? "";
    this.androidVersion = init.androidVersion ?? "";
    this.sdk = init.sdk ?? "";
    this.abi = init.abi ?? "";
    this.screenSize = init.screenSize ?? "";
    this.totalMemMb = init.totalMemMb ?? 0;
    this.isEmulator = init.isEmulator ?? false;
    this.lastSeen = init.lastSeen ?? Date.now() / 1000;
  }

  /**
   * 序列化为普通对象。
   *
   * 键名保持 Python 版 `to_dict()` 的 snake_case 原样
   * （这是 MCP 工具响应的对外表面，改动会破坏行为保真）。
   */
  toDict(): {
    device_id: string;
    state: string;
    model: string;
    android_version: string;
    sdk: string;
    abi: string;
    screen_size: string;
    total_mem_mb: number;
    is_emulator: boolean;
    last_seen: number;
  } {
    return {
      device_id: this.deviceId,
      state: this.state,
      model: this.model,
      android_version: this.androidVersion,
      sdk: this.sdk,
      abi: this.abi,
      screen_size: this.screenSize,
      total_mem_mb: this.totalMemMb,
      is_emulator: this.isEmulator,
      last_seen: this.lastSeen,
    };
  }
}

/** 按顺序取第一个非空字符串。 */
function firstFilled(...values: readonly string[]): string {
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed !== "") {
      return trimmed;
    }
  }
  return "";
}

/** 准单例管理器；经由 {@link DeviceManager.shared} 访问。 */
export class DeviceManager {
  private static instance: DeviceManager | null = null;

  /** device_id → 快照。 */
  private cache: Map<string, DeviceInfo> = new Map();
  /** 重新查询 `adb devices` 前的缓存有效期（秒）。 */
  private readonly refreshTtl = 5.0;
  /** 上次刷新时刻（performance.now() 秒，等价 Python 的 time.monotonic()）。 */
  private lastRefresh = 0.0;

  private constructor() {}

  /** 获取进程级单例（对应 Python 的 `DeviceManager.shared()`）。 */
  static shared(): DeviceManager {
    if (DeviceManager.instance === null) {
      DeviceManager.instance = new DeviceManager();
    }
    return DeviceManager.instance;
  }

  // ---- 发现 ----------------------------------------------------------------

  /**
   * 返回当前所有已连接的设备。
   *
   * 结果缓存 5 秒；传 `refresh = true` 可绕过缓存。
   */
  async listDevices(refresh = false): Promise<DeviceInfo[]> {
    const now = performance.now() / 1000;
    if (!refresh && now - this.lastRefresh < this.refreshTtl && this.cache.size > 0) {
      return [...this.cache.values()];
    }

    let result: Awaited<ReturnType<typeof adb>>;
    try {
      result = await adb("devices", "-l", { check: false, timeout: 10 });
    } catch (exc) {
      if (exc instanceof ADBError) {
        logger.warning(`adb devices 失败: ${exc.message}`);
        return [...this.cache.values()];
      }
      throw exc;
    }

    const newCache: Map<string, DeviceInfo> = new Map();
    for (const rawLine of splitLines(result.stdout).slice(1)) {
      const line = rawLine.trim();
      if (!line || line.includes("List of devices")) {
        continue;
      }
      const parts = line.split(/\s+/);
      if (parts.length < 2) {
        continue;
      }
      const serial = parts[0]!;
      const state = parts[1]!;
      if (state !== "device") {
        // 跳过 "offline" / "unauthorized"
        continue;
      }
      const info = await this.buildInfo(serial, state);
      newCache.set(serial, info);
    }

    this.cache = newCache;
    this.lastRefresh = now;
    return [...newCache.values()];
  }

  /**
   * 用 ro.* 属性填充 {@link DeviceInfo}；单项失败只损失该字段，不影响整体。
   */
  private async buildInfo(deviceId: string, state: string): Promise<DeviceInfo> {
    const safeGet = async (...args: string[]): Promise<string> => {
      try {
        const result = await shell(...args, { deviceId, timeout: 5, check: false });
        return result.trim();
      } catch {
        return "";
      }
    };

    const model = await safeGet("getprop", "ro.product.model");
    const marketName = firstFilled(
      await safeGet("getprop", "ro.product.marketname"),
      await safeGet("getprop", "ro.product.odm.marketname"),
      await safeGet("getprop", "ro.product.bootimage.marketname"),
    );
    const deviceName = await safeGet("getprop", "persist.sys.device_name");
    const androidVersion = await safeGet("getprop", "ro.build.version.release");
    const sdk = await safeGet("getprop", "ro.build.version.sdk");
    const abi = await safeGet("getprop", "ro.product.cpu.abi");
    const screenSize = await safeGet("wm", "size");
    const isEmulator =
      deviceId.toLowerCase().includes("emulator") ||
      (await safeGet("getprop", "ro.product.device")).toLowerCase().includes("sdk_gphone");

    // Python 版捕获 (IndexError, ValueError)：解析失败保持 total_mem_mb = 0
    let totalMemMb = 0;
    const meminfo = await safeGet("cat", "/proc/meminfo");
    const memTotalIdx = meminfo.indexOf("MemTotal:");
    if (memTotalIdx !== -1) {
      const firstToken = (meminfo.slice(memTotalIdx + "MemTotal:".length).trim().split(/\s+/)[0]) ?? "";
      if (/^[+-]?\d+$/.test(firstToken)) {
        totalMemMb = Math.floor(parseInt(firstToken, 10) / 1024);
      }
    }

    return new DeviceInfo({
      deviceId,
      state,
      model,
      marketName,
      deviceName,
      androidVersion,
      sdk,
      abi,
      screenSize,
      totalMemMb,
      isEmulator,
    });
  }

  // ---- 连接控制 --------------------------------------------------------------

  /**
   * 连接 TCP 附着的设备（如位于 127.0.0.1:5555 的模拟器）。
   *
   * 成功时返回对应的 {@link DeviceInfo}。
   */
  async connect(hostPort: string): Promise<DeviceInfo> {
    const result = await adb("connect", hostPort, { check: false, timeout: 10 });
    const lower = result.stdout.toLowerCase();
    if (!lower.includes("connected") && !lower.includes("already")) {
      throw new ADBError(`adb connect 失败: ${result.stdout.trim()} ${result.stderr.trim()}`);
    }
    logger.info(`已连接: ${hostPort}`);
    await this.listDevices(true);
    const info = this.cache.get(hostPort);
    if (!info) {
      throw new ADBError(`连接后未在 adb devices 看到: ${hostPort}`);
    }
    return info;
  }

  /** 断开 TCP 设备并从缓存移除。 */
  async disconnect(deviceId: string): Promise<void> {
    await adb("disconnect", deviceId, { check: false, timeout: 5 });
    this.cache.delete(deviceId);
    logger.info(`已断开: ${deviceId}`);
  }

  // ---- 访问器 -----------------------------------------------------------------

  /** 按 device_id 取设备快照；未连接时抛 {@link DeviceNotFoundError}。 */
  async get(deviceId: string, refresh = false): Promise<DeviceInfo> {
    const devices = await this.listDevices(refresh);
    for (const d of devices) {
      if (d.deviceId === deviceId) {
        return d;
      }
    }
    throw new DeviceNotFoundError(`设备未连接: ${deviceId}`);
  }

  /** 解析设备；若设备在调用之间消失则强制再刷新一次后重查。 */
  async require(deviceId: string): Promise<DeviceInfo> {
    try {
      return await this.get(deviceId);
    } catch (exc) {
      if (exc instanceof DeviceNotFoundError) {
        // 强制再刷新一次，以防设备刚刚连上
        return await this.get(deviceId, true);
      }
      throw exc;
    }
  }

  /** 同步的缓存查找；不触发 adb。 */
  cachedGet(deviceId: string): DeviceInfo | null {
    return this.cache.get(deviceId) ?? null;
  }
}
