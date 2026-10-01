#!/usr/bin/env bun
/**
 * 多设备 3-App 并发沙盒测试。
 *
 * 对于 3 个雷电实例：
 * - emulator-5556 → damai_bot (大麦)
 * - emulator-5558 → maoyan_bot (猫眼)
 * - emulator-5560 → fliggy_bot (飞猪)
 *
 * 每个实例：
 * 1. 验证连接
 * 2. 加载对应 profile
 * 3. 跑 NTP 同步
 * 4. 模拟 app-grab 流程（不真正抢票，只测框架）
 *
 * （Python `examples/three_apps_sandbox.py` 的 TS 对应物。）
 */
import { pathToFileURL } from "node:url";

import { adb, whichBinary } from "../src/device/adb";
import { DeviceManager } from "../src/device/manager";
import { batchTap } from "../src/actions/batch";
import { loadProfile } from "../src/app/profile";
import { asyncQuery, fetchDeviceTime } from "../src/utils/ntp";
import { logger } from "../src/utils/logging";
import { UICache } from "../src/utils/uiCache";

/** 与 Python 字面量一致的每设备配置。 */
interface DeviceConfig {
  device_id: string;
  expected_profile: string;
  package: string;
  installed: boolean;
  label: string;
}

/** 单项检查结果（Python 里就是随意形状的 dict）。 */
type CheckResult = Record<string, unknown>;

/** 单设备测试结果。 */
interface DeviceTestResult {
  device_id: string;
  label: string;
  package: string;
  checks: Record<string, CheckResult>;
  elapsed_ms?: number;
  status?: string;
}

// 每个设备的配置
const DEVICE_CONFIGS: readonly DeviceConfig[] = [
  {
    device_id: "emulator-5556",
    expected_profile: "damai",
    package: "cn.damai",
    installed: true,
    label: "大麦",
  },
  {
    device_id: "emulator-5558",
    expected_profile: "maoyan",
    package: "com.sankuai.movie",
    installed: false, // 还没装
    label: "猫眼",
  },
  {
    device_id: "emulator-5560",
    expected_profile: "fliggy",
    package: "com.taobao.trip",
    installed: false,
    label: "飞猪",
  },
];

/** 对应 Python round(x, 2) 的显示辅助。 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 对应 Python round(x, 1) 的显示辅助（整数值保留 ".0"，与 Python str 一致）。 */
function pyRound1(value: number): string {
  const v = Math.round(value * 10) / 10;
  return Number.isInteger(v) ? v.toFixed(1) : String(v);
}

/** 等价于 Python 的 str(exc)：Error 取 message，其余 String()。 */
function excMessage(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/**
 * 复刻 Python `str(obj)` 对 dict / bool / None / list 的渲染形态，
 * 仅用于把检查结果里的额外字段打印成 Python 版的样式。
 */
function pyValue(v: unknown): string {
  if (typeof v === "string") {
    return `'${v}'`;
  }
  if (v === true) {
    return "True";
  }
  if (v === false) {
    return "False";
  }
  if (v === null || v === undefined) {
    return "None";
  }
  if (Array.isArray(v)) {
    return `[${v.map(pyValue).join(", ")}]`;
  }
  if (typeof v === "object") {
    const inner = Object.entries(v)
      .map(([k, vv]) => `'${k}': ${pyValue(vv)}`)
      .join(", ");
    return `{${inner}}`;
  }
  return String(v);
}

/** 对单个设备跑全套沙盒测试。 */
async function testDevice(device: DeviceConfig): Promise<DeviceTestResult> {
  const result: DeviceTestResult = {
    device_id: device.device_id,
    label: device.label,
    package: device.package,
    checks: {},
  };
  const started = Date.now() / 1000;

  // 1. 设备可达
  try {
    const info = await DeviceManager.shared().require(device.device_id);
    result.checks["device_ok"] = {
      ok: true,
      model: info.model,
      screen: info.screenSize,
    };
  } catch (exc) {
    result.checks["device_ok"] = { ok: false, error: excMessage(exc).slice(0, 100) };
    result.status = "device_failed";
    return result;
  }

  // 2. profile 加载
  // （Python 版直接调 get_profile；TS 侧内置 profile 经异步动态 import 注册，
  //   loadProfile 会在注册表为空时先注册内置项，语义等价且无时序竞态。）
  try {
    const profile = await loadProfile(device.expected_profile);
    result.checks["profile_ok"] = {
      ok: true,
      name: profile.name,
      package: profile.packageName,
      steps: profile.steps.length,
    };
  } catch (exc) {
    result.checks["profile_ok"] = { ok: false, error: excMessage(exc).slice(0, 100) };
  }

  // 3. App 是否安装
  if (whichBinary(process.platform === "win32" ? "adb.exe" : "adb") === null) {
    logger.warning("adb not on PATH, skipping package check");
    result.checks["app_installed"] = { ok: false, error: "adb not on PATH" };
  } else {
    try {
      const r = await adb(
        "shell", "pm", "list", "packages", device.package,
        { deviceId: device.device_id, timeout: 5.0, check: false },
      );
      const out = r.stdoutBytes.toString("utf-8");
      const isInstalled = out.includes(device.package);
      result.checks["app_installed"] = {
        ok: true,
        installed: isInstalled,
        expected: device.installed,
      };
    } catch (exc) {
      result.checks["app_installed"] = { ok: false, error: excMessage(exc).slice(0, 100) };
    }
  }

  // 4. NTP 同步
  try {
    const ntp = await asyncQuery("pool.ntp.org", 3.0);
    result.checks["ntp_sync"] = {
      ok: true,
      offset_ms: round2(ntp.offsetMs),
      delay_ms: round2(ntp.delayMs),
    };
  } catch (exc) {
    result.checks["ntp_sync"] = { ok: false, error: excMessage(exc).slice(0, 100) };
  }

  // 5. 设备时钟
  try {
    const deviceT = await fetchDeviceTime(device.device_id);
    if (deviceT === null) {
      // Python 原版对 None 做减法会抛 TypeError 落入 except；此处抛等价错误
      throw new TypeError("unsupported operand type(s) for -: 'NoneType' and 'float'");
    }
    result.checks["device_time"] = {
      ok: true,
      unix: deviceT,
      delta_from_host_ms: round2((deviceT - Date.now() / 1000) * 1000),
    };
  } catch (exc) {
    result.checks["device_time"] = { ok: false, error: excMessage(exc).slice(0, 100) };
  }

  // 6. UI cache 初始化（如果 App 没装就跳过 dump）
  const cache = new UICache(2.0);
  const appInstalled = result.checks["app_installed"];
  if (appInstalled !== undefined && appInstalled["installed"] === true) {
    try {
      const elements = await cache.get(device.device_id);
      result.checks["ui_cache"] = {
        ok: true,
        elements_count: elements.length,
        cache_stats: cache.stats,
      };
    } catch (exc) {
      result.checks["ui_cache"] = { ok: false, error: excMessage(exc).slice(0, 100) };
    }
  } else {
    result.checks["ui_cache"] = { ok: false, skipped: "app not installed" };
  }

  // 7. batch input (不依赖 App 也能跑)
  try {
    await batchTap(device.device_id, [
      [540, 100],
      [540, 200],
      [540, 300],
    ] as const);
    result.checks["batch_input"] = { ok: true };
  } catch (exc) {
    result.checks["batch_input"] = { ok: false, error: excMessage(exc).slice(0, 100) };
  }

  result.elapsed_ms = Math.round(((Date.now() / 1000 - started) * 1000) * 10) / 10;
  result.status = "ok";
  return result;
}

async function main(): Promise<number> {
  console.log("=".repeat(60));
  console.log("DAMAI-MCP 3-APP SANDBOX TEST");
  console.log("=".repeat(60));
  console.log();
  const started = Date.now() / 1000;

  // 并发跑 3 个设备（对应 asyncio.gather(..., return_exceptions=True)）
  const results = await Promise.allSettled(DEVICE_CONFIGS.map((d) => testDevice(d)));

  // 渲染结果
  console.log();
  for (const r of results) {
    if (r.status === "rejected") {
      console.log(`  ERROR: ${excMessage(r.reason)}`);
      continue;
    }
    const d = r.value;
    console.log(`--- ${d.label} (${d.device_id}) ---`);
    console.log(`  package: ${d.package}`);
    // Python 版设备失败分支缺 elapsed_ms 键，渲染时 KeyError；此处退化为 "undefined"
    console.log(`  elapsed: ${d.elapsed_ms === undefined ? "undefined" : pyRound1(d.elapsed_ms)}ms`);
    for (const [k, v] of Object.entries(d.checks)) {
      const mark = v["ok"] ? "OK" : "FAIL";
      let note = "";
      if (v["error"]) {
        note = `  err=${v["error"]}`;
      } else if (v["skipped"]) {
        note = `  (${String(v["skipped"])})`;
      } else {
        const extra: Record<string, unknown> = {};
        for (const [kk, vv] of Object.entries(v)) {
          if (kk !== "ok") {
            extra[kk] = vv;
          }
        }
        if (Object.keys(extra).length > 0) {
          note = `  ${pyValue(extra)}`;
        }
      }
      console.log(`  [${mark}] ${k}${note}`);
    }
    console.log();
  }

  console.log(`Total: ${pyRound1((Date.now() / 1000 - started) * 1000)}ms`);
  return 0;
}

// 对应 Python `if __name__ == "__main__": sys.exit(asyncio.run(main()))`
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((exc) => {
      console.error(exc);
      process.exitCode = 1;
    });
}
