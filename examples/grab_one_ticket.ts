#!/usr/bin/env bun
/**
 * Example: grab a single ticket using damai-mcp-ts directly (without MCP server).
 *
 * Usage:
 *     bun examples/grab_one_ticket.ts --device 127.0.0.1:5555 --item 1063631004645 \
 *         --price 2 --viewer "杨安琪" --open "2026-07-09 17:21:00"
 *
 * （Python `examples/grab_one_ticket.py` 的 TS 对应物。ESM 相对导入天然按文件
 * 位置解析，不再需要 Python 版的 `sys.path.insert` 导入黑客。）
 */
import { pathToFileURL } from "node:url";

import { Command, CommanderError, InvalidArgumentError } from "commander";

import { damaiGrab } from "../src/damai/actions";
import { DeviceManager } from "../src/device/manager";
import { configure as configureLogging } from "../src/utils/logging";

/** argparse `description=__doc__` 用的模块 docstring（usage 行改为 bun 调用）。 */
const DOC = `Example: grab a single ticket using damai-mcp-ts directly (without MCP server).

Usage:
    bun examples/grab_one_ticket.ts --device 127.0.0.1:5555 --item 1063631004645 \
        --price 2 --viewer "杨安琪" --open "2026-07-09 17:21:00"
`;

/** 解析后的命令行参数（对应 Python 的 argparse.Namespace）。 */
interface Args {
  device: string;
  item: string;
  price: number;
  viewer: string;
  num: number;
  open: string;
  preheat: number;
}

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

/** Python repr() 的字符串形态（str(list) 对元素用 repr）。 */
function pyStrRepr(s: string): string {
  return s.includes("'") && !s.includes('"') ? `"${s}"` : `'${s}'`;
}

/**
 * 复刻 Python `str(v)` 对结果 dict 各值类型的渲染形态
 * （None/True/False/list → Python 字面量；list 元素用 repr），仅用于结果打印。
 */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) {
    return "None";
  }
  if (v === true) {
    return "True";
  }
  if (v === false) {
    return "False";
  }
  if (Array.isArray(v)) {
    return `[${v.map((x) => (typeof x === "string" ? pyStrRepr(x) : pyStr(x))).join(", ")}]`;
  }
  return String(v);
}

async function mainAsync(args: Args): Promise<number> {
  await configureLogging("INFO", "./logs");
  const mgr = DeviceManager.shared();

  // Verify device first
  let info;
  try {
    info = await mgr.require(args.device);
  } catch (exc) {
    console.error(`❌ 设备不可用: ${excMessage(exc)}`);
    return 2;
  }
  console.log(`✅ 设备: ${info.deviceId}  ${info.model}  ${info.screenSize}`);

  // Run grab
  const result = await damaiGrab(
    args.device,
    args.item,
    args.price,
    args.viewer ? [args.viewer] : [],
    args.num,
    args.open,
    { preheatSeconds: args.preheat },
  );

  console.log(`\n=== 抢票结果 ===`);
  for (const [k, v] of Object.entries(result)) {
    if (k === "screenshots" && Array.isArray(v)) {
      console.log(`  ${k}: ${v.length} 张`);
      for (const p of v) {
        console.log(`    - ${p}`);
      }
    } else {
      console.log(`  ${k}: ${pyStr(v)}`);
    }
  }
  return result.status === "submitted" ? 0 : 1;
}

async function main(): Promise<void> {
  const p = new Command();
  p.name("grab_one_ticket.ts").description(DOC);
  p.requiredOption("--device <device>", '设备 ID，如 "127.0.0.1:5555"');
  p.requiredOption("--item <item>", "大麦 item id");
  p.option("--price <price>", "票档序号 (1-based)", pyIntArg, 1);
  p.option("--viewer <viewer>", "观演人姓名", "");
  p.option("--num <num>", "张数", pyIntArg, 1);
  p.option("--open <open>", '开票时间 "YYYY-MM-DD HH:MM:SS"（空=立即抢）', "");
  p.option("--preheat <preheat>", "开票前预热秒数", pyFloatArg, 30.0);

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
