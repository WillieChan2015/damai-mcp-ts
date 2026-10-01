#!/usr/bin/env bun
/**
 * Example: grab a ticket using multiple devices/accounts concurrently.
 *
 * Each emulator at a different ADB port runs its own 大麦 instance. We fire
 * `damaiGrab` in parallel via `Promise.allSettled` and print who wins.
 *
 * Usage:
 *     # 1. Start two emulators on different ports:
 *     #    ldconsole launch --index 0    # port 5555
 *     #    ldconsole launch --index 1    # port 5557 (auto)
 *     # 2. Log into 大麦 on each (scan QR once)
 *     # 3. Run:
 *     bun examples/multi_devices.ts --item 1063631004645 --price 2 \
 *         --open "2026-07-09 17:21:00"
 *
 * （Python `examples/multi_devices.py` 的 TS 对应物。）
 */
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { Command, CommanderError, InvalidArgumentError } from "commander";

import { damaiGrab, parseIso } from "../src/damai/actions";
import { formatPyFloat } from "../src/device/adb";
import { configure as configureLogging } from "../src/utils/logging";

/** 解析后的命令行参数（对应 Python 的 argparse.Namespace）。 */
interface Args {
  item: string;
  price: number;
  devices: string[];
  viewers: string[];
  open: string;
  preheat: number;
}

/** 与 Python 字面量一致的单账号配置。 */
interface Account {
  device_id: string;
  viewer_names: string[];
}

const DEFAULT_ACCOUNTS: readonly Account[] = [
  { device_id: "127.0.0.1:5555", viewer_names: ["杨安琪"] },
  // { device_id: "127.0.0.1:5557", viewer_names: ["张三"] },
  // { device_id: "127.0.0.1:5559", viewer_names: ["李四"] },
];

/** 对应 argparse `type=int`（报错文案与 Python argparse 一致）。 */
function pyIntArg(value: string): number {
  if (!/^[+-]?\d+$/.test(value.trim())) {
    throw new InvalidArgumentError(`invalid int value: '${value}'`);
  }
  return parseInt(value.trim(), 10);
}

/** 对应 argparse `type=float`（报错文案与 Python argparse 一致）。 */
function pyFloatArg(value: string): number {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value.trim())) {
    throw new InvalidArgumentError(`invalid float value: '${value}'`);
  }
  return Number(value.trim());
}

/** 等价于 Python 的 str(exc)：Error 取 message，其余 String()。 */
function excMessage(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

async function mainAsync(args: Args): Promise<number> {
  await configureLogging("INFO", "./logs");

  // 对应 Python 的 zip(args.devices, args.viewers)：按较短的截断
  const accounts: Account[] = [];
  const zipped = Math.min(args.devices.length, args.viewers.length);
  for (let i = 0; i < zipped; i++) {
    accounts.push({ device_id: args.devices[i], viewer_names: [args.viewers[i]] });
  }
  if (accounts.length === 0) {
    accounts.push(...DEFAULT_ACCOUNTS);
  }
  console.log(`🚀 启动 ${accounts.length} 个 worker 并发抢票`);

  // Pre-warm: parse target time once（按本地时区解析，与 strptime 语义一致）
  let targetTs: number | null = null;
  if (args.open) {
    targetTs = parseIso(args.open).getTime() / 1000;
    const now = Date.now() / 1000;
    const waitSec = targetTs - now - args.preheat;
    if (waitSec > 0) {
      console.log(
        `⏰ 距开票 ${(targetTs - now).toFixed(0)}s，等待 ${waitSec.toFixed(0)}s 后开抢（预热 ${formatPyFloat(args.preheat)}s）`,
      );
      await sleep(waitSec * 1000);
    }
  }

  const tasks = accounts.map((a) =>
    damaiGrab(
      a.device_id,
      args.item,
      args.price,
      a.viewer_names,
      1,
      args.open,
      { preheatSeconds: args.preheat },
    ),
  );
  // 对应 asyncio.gather(*tasks, return_exceptions=True)
  const results = await Promise.allSettled(tasks);

  console.log(`\n=== 抢票结果 ===`);
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r === undefined) {
      continue;
    }
    if (r.status === "rejected") {
      console.log(`  [${i}] ❌ 异常: ${excMessage(r.reason)}`);
    } else {
      const g = r.value;
      console.log(`  [${i}] ${g.status}  (${g.elapsed_ms}ms)  ${g.error || "OK"}`);
    }
  }
  return 0;
}

async function main(): Promise<void> {
  const p = new Command();
  p.name("multi_devices.ts");
  p.requiredOption("--item <item>");
  p.option("--price <price>", "", pyIntArg, 1);
  p.option("--devices <devices...>", '设备 ID 列表，如 "127.0.0.1:5555 127.0.0.1:5557"', []);
  p.option("--viewers <viewers...>", "每个设备对应的观演人姓名", []);
  p.option("--open <open>", '开票时间 "YYYY-MM-DD HH:MM:SS"', "");
  p.option("--preheat <preheat>", "", pyFloatArg, 30.0);

  let args: Args;
  try {
    p.exitOverride();
    args = p.parse().opts<Args>();
  } catch (exc) {
    if (exc instanceof CommanderError) {
      // argparse 对用法错误统一 exit 2；help/version 为 0
      process.exit(exc.exitCode === 0 ? 0 : 2);
    }
    throw exc;
  }
  process.exitCode = await mainAsync(args);
}

// 对应 Python `if __name__ == "__main__": main()`
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((exc) => {
    console.error(exc);
    process.exitCode = 1;
  });
}
