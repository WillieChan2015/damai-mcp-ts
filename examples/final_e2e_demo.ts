#!/usr/bin/env bun
/**
 * damai-mcp-ts 最终端到端演示
 *
 * 完整流程：
 * 1. L1: 列出 3 台雷电设备
 * 2. 验证 houdini 已启用
 * 3. L2: 启动大麦/猫眼/飞猪
 * 4. L3: dump UI + 找关键元素
 * 5. L2: tap 点击
 * 6. 验证最终状态
 *
 * 注意：本示例使用雷电模拟器(LDPlayer)。请根据你的实际情况修改设备路径。
 * 默认通过 PATH 查找 adb，或设置环境变量 ANDROID_ADB_PATH 指定 adb 位置。
 *
 * （Python `examples/final_e2e_demo.py` 的 TS 对应物：本地 adb() 助手改为
 * node:child_process 的 spawn 异步实现，收集原始 Buffer——并发因此真正生效，
 * Python 版的 subprocess.run 会阻塞事件循环。）
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { screenshot, tap } from "../src/actions/actions";
import { dumpUi } from "../src/inspector/dump";
import { findByText } from "../src/inspector/find";
import type { UIElement } from "../src/inspector/models";
import { DeviceManager } from "../src/device/manager";
import { splitLines, whichBinary } from "../src/device/adb";

// 自动检测 adb：先看 ANDROID_ADB_PATH 环境变量，再看 PATH
const ADB =
  process.env.ANDROID_ADB_PATH ||
  whichBinary(process.platform === "win32" ? "adb.exe" : "adb");
if (!ADB) {
  throw new Error(
    "未找到 adb。请将 adb 加入 PATH，" +
      "或设置环境变量 ANDROID_ADB_PATH 指向 adb 可执行文件。",
  );
}

/** 对应 Python 本地 adb() 助手的返回（subprocess.run capture_output + text）。 */
interface AdbRunResult {
  stdout: string;
  stderr: string;
  returncode: number | null;
}

/**
 * 本地 adb 助手：`spawn(ADB, args)` 同步等待退出并收集原始 Buffer。
 *
 * 对应 Python 的 `subprocess.run([...], capture_output=True, text=True,
 * timeout=timeout)`——超时抛错（TimeoutExpired），非零退出码不抛错。
 */
function adbRun(args: readonly string[], timeoutSec = 15): Promise<AdbRunResult> {
  return new Promise<AdbRunResult>((resolve, reject) => {
    const child = spawn(ADB as string, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutSec * 1000);
    timer.unref();

    const stdout = child.stdout;
    if (stdout) {
      stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    }
    const stderr = child.stderr;
    if (stderr) {
      stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    }

    child.once("error", (exc) => {
      clearTimeout(timer);
      reject(exc);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        // 复刻 subprocess.run 超时抛 TimeoutExpired 的语义
        reject(new Error(`Command '${[ADB, ...args].join(" ")}' timed out after ${timeoutSec} seconds`));
        return;
      }
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        returncode: code,
      });
    });
  });
}

function banner(text: string): void {
  console.log();
  console.log("=".repeat(70));
  console.log(`  ${text}`);
  console.log("=".repeat(70));
}

/** 对应 Python `time.strftime('%Y-%m-%d %H:%M:%S')` 的本地时间格式。 */
function strftimeNow(): string {
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** 等价于 Python 的 str(exc)：Error 取 message，其余 String()。 */
function excMessage(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** 完整流程：启动 APP → 等 splash → 找同意 → 点 → 验证首页。 */
async function demoOne(deviceId: string, pkg: string, label: string): Promise<void> {
  banner(`📱 ${label} on ${deviceId}`);

  // 1) 启用 houdini（每台都开）
  console.log(`[Houdini] 启用 native bridge...`);
  for (const cmd of [
    ["shell", "setprop", "persist.sys.nativebridge", "1"],
    ["shell", "setprop", "ro.dalvik.vm.isa.arm", "arm"],
    ["shell", "setprop", "ro.dalvik.vm.isa.arm64", "arm64"],
  ]) {
    await adbRun(["-s", deviceId, ...cmd]);
  }

  // 2) force-stop + 启动
  console.log(`[启动] ${pkg}...`);
  await adbRun(["-s", deviceId, "shell", "am", "force-stop", pkg]);
  await sleep(1000); // Python 原版此处为阻塞的 time.sleep(1)
  await adbRun([
    "-s", deviceId, "shell", "monkey", "-p", pkg,
    "-c", "android.intent.category.LAUNCHER", "1",
  ]);
  console.log(`  等待 15 秒启动 + splash...`);
  await sleep(15000);

  // 3) 看 focus
  const r = await adbRun(["-s", deviceId, "shell", "dumpsys", "window"]);
  const focusLine = splitLines(r.stdout).find((l) => l.includes("mCurrentFocus")) ?? "n/a";
  const pkgInFocus = focusLine.includes(pkg) || focusLine.includes(label);
  console.log(`  focus: ${focusLine.trim().slice(0, 120)}`);
  console.log(`  ${label} 在前台: ${pkgInFocus ? "✓" : "✗"}`);

  // 4) 找"同意"按钮（L3）
  console.log(`[L3 语义查询] 找'同意'按钮...`);
  let btn: UIElement | null = null;
  try {
    btn = await findByText(deviceId, "同意", { exact: true, timeout: 3.0 });
    console.log(`  ✓ 找到 @ (${btn.center[0]}, ${btn.center[1]})`);
  } catch (exc) {
    console.log(`  ! ${excMessage(exc)} — 可能没隐私协议 dialog`);
  }

  // 5) 点击（L2）
  if (btn !== null) {
    console.log(`[L2 原子操作] tap(${btn.center[0]}, ${btn.center[1]})`);
    await tap(deviceId, btn.center[0], btn.center[1]);
    await sleep(8000);
  }

  // 6) 最终状态 + 截图
  const r2 = await adbRun(["-s", deviceId, "shell", "dumpsys", "window"]);
  const finalFocus = splitLines(r2.stdout).find((l) => l.includes("mCurrentFocus")) ?? "n/a";
  console.log(`[最终] ${finalFocus.trim().slice(0, 120)}`);

  // 截屏
  const shot = `./damai_shots/final_${label}.png`;
  await screenshot(deviceId, shot);
  console.log(`[截图] ${shot}`);

  // 7) dump 首页节点
  try {
    const elements = await dumpUi(deviceId);
    console.log(`[L3 dump] 首页 ${elements.length} 个节点`);
    for (const e of elements.slice(0, 8)) {
      if (e.text) {
        console.log(
          `  [${String(e.center[0]).padStart(4)},${String(e.center[1]).padStart(4)}] ${e.text.slice(0, 50)}`,
        );
      }
    }
  } catch (exc) {
    console.log(`  dump err: ${excMessage(exc)}`);
  }
}

async function main(): Promise<void> {
  banner("🎫 damai-mcp 最终端到端演示");
  console.log(`开始时间: ${strftimeNow()}`);
  console.log(`adb 路径: ${ADB}`);

  // L1: 列设备
  banner("L1 设备管理 — 列出 3 台雷电实例");
  const mgr = DeviceManager.shared();
  const devices = await mgr.listDevices(true);
  console.log(`  ✓ 找到 ${devices.length} 台设备`);
  for (const d of devices) {
    console.log(
      `    ${d.deviceId.padEnd(18)}  ${d.model.padEnd(25)}  ${d.screenSize}  (${d.isEmulator ? "EMU" : "PHONE"})`,
    );
  }

  // 验证 3 台都有 houdini 启用
  banner("前置: 验证 3 台设备 houdini 都启用");
  for (const d of devices) {
    await adbRun(["-s", d.deviceId, "shell", "setprop", "persist.sys.nativebridge", "1"]);
    const r = await adbRun(["-s", d.deviceId, "shell", "getprop", "persist.sys.nativebridge"]);
    const val = r.stdout.trim();
    console.log(`  ${d.deviceId.padEnd(18)}  persist.sys.nativebridge = ${val}`);
  }

  // 3 台设备并发演示
  const targets: readonly (readonly [string, string, string])[] = [
    ["127.0.0.1:5555", "cn.damai", "大麦"],
    ["emulator-5554", "com.sankuai.movie", "猫眼"],
    ["emulator-5560", "com.taobao.trip", "飞猪"],
  ];

  banner("3 台设备并发端到端（Promise.all）");
  const t0 = Date.now() / 1000;
  await Promise.all(targets.map(([dev, pkg, label]) => demoOne(dev, pkg, label)));
  const total = Date.now() / 1000 - t0;
  console.log();
  console.log(`⏱️  总耗时: ${total.toFixed(1)}s`);
  console.log(`📊  3 台设备并发启动 + MCP L1/L2/L3 全跑通`);

  banner("🎉 演示完成");
  console.log("下一步:");
  console.log("  - 抢票时把 damaiGrab() 包到 Promise.all 即可并发");
  console.log("  - pnpm install && bun run src/cli.ts serve");
}

// 对应 Python `if __name__ == "__main__": asyncio.run(main())`
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((exc) => {
    console.error(exc);
    process.exitCode = 1;
  });
}
