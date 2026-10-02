#!/usr/bin/env bun
/**
 * Example: grab a ticket using multiple devices/accounts concurrently.
 *
 * Each emulator at a different ADB port runs its own 大麦 instance. Every
 * account runs the full `runChecklist` 编排（NTP 校正 + 详情页预热 + warm-dump +
 * 开票去抖门），而不是裸 `damaiGrab`——多账号并发经 `Promise.allSettled` 发射，
 * 结束后逐设备汇总 checklist 状态。
 *
 * 多设备注记：
 *   - N 台设备会各自做一次 NTP 采样（querySampled，3 个 UDP 样本 × N）——UDP
 *     查询之间无冲突，仅 stderr 日志会交错；
 *   - 各 checklist 只操作各自的 device_id，互不共享设备状态；MCP 工具层的
 *     设备占用锁（withDeviceLease）覆盖 server 路径，本示例直接并发调用库层，
 *     不再额外包一层锁（N 台设备互不相同，进程内亦无竞争）。
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
import { pathToFileURL } from "node:url";

import { Command, CommanderError, InvalidArgumentError } from "commander";

import { runChecklist } from "../src/damai/checklist";
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
  if (args.open) {
    console.log(
      `⏰ 开票时间 ${args.open}，预热 ${args.preheat}s（各 worker 经 runChecklist 自行 NTP 校正并候场）`,
    );
  }

  // 每账号跑完整 checklist：NTP 校正 → 连接检查 → 登录检查 → 详情页预热 →
  // 并行 warm dump → 开票去抖门 → fire。倒计时进度与阶段切换逐设备打印。
  const tasks = accounts.map((a, i) =>
    runChecklist(a.device_id, args.item, {
      openTime: args.open,
      priceIndex: args.price,
      viewerNames: a.viewer_names,
      ticketNum: 1,
      preheatSeconds: args.preheat,
      onPhase: (phase) => {
        console.log(`  [${i}] ▶ ${phase}`);
      },
      onProgress: (secondsLeft) => {
        console.log(`  [${i}] ⏱ 距开票约 ${Math.max(0, Math.ceil(secondsLeft))}s`);
      },
    }),
  );
  // 对应 asyncio.gather(*tasks, return_exceptions=True)
  const results = await Promise.allSettled(tasks);

  console.log(`\n=== 抢票结果（每设备 checklist 状态） ===`);
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r === undefined) {
      continue;
    }
    if (r.status === "rejected") {
      console.log(`  [${i}] ❌ 异常: ${excMessage(r.reason)}`);
      continue;
    }
    const c = r.value;
    const ntpText = c.ntpOffsetMs === null ? "无" : `${c.ntpOffsetMs.toFixed(2)}ms`;
    const triggerText = c.saleTrigger === null ? "-" : c.saleTrigger;
    const grab = c.grabResult;
    let grabText = "-";
    if (grab !== null) {
      const gStatus = typeof grab.status === "string" ? grab.status : "?";
      const gElapsed = typeof grab.elapsed_ms === "number" ? `${grab.elapsed_ms}ms` : "?";
      const gOrderUrl = typeof grab.order_url === "string" ? `  订单页: ${grab.order_url}` : "";
      grabText = `${gStatus} (${gElapsed})${gOrderUrl}`;
    }
    console.log(
      `  [${i}] ${c.status}  grab=${grabText}  ntp_offset=${ntpText}  ` +
        `trigger=${triggerText}  error=${c.error || "OK"}`,
    );
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
