#!/usr/bin/env bun
/**
 * Debug helper: dump current UI to inspect selectors used by 大麦.
 *
 * When 大麦 updates and our hardcoded selectors drift, run this on the concert
 * page and update `src/damai/selectors.ts` accordingly.
 *
 * Usage:
 *     bun examples/probe_selectors.ts --device 127.0.0.1:5555
 *
 * （Python `examples/probe_selectors.py` 的 TS 对应物。）
 */
import { pathToFileURL } from "node:url";

import { Command, CommanderError } from "commander";

import { dumpUi, dumpUiToFile } from "../src/inspector/dump";
import { configure as configureLogging } from "../src/utils/logging";
import { pyRepr } from "../src/app/profile";

/** argparse `description=__doc__` 用的模块 docstring（usage 行改为 bun 调用）。 */
const DOC = `Debug helper: dump current UI to inspect selectors used by 大麦.

When 大麦 updates and our hardcoded selectors drift, run this on the concert
page and update \`src/damai/selectors.ts\` accordingly.

Usage:
    bun examples/probe_selectors.ts --device 127.0.0.1:5555
`;

/** 解析后的命令行参数（对应 Python 的 argparse.Namespace）。 */
interface Args {
  device: string;
  out: string;
  full: boolean;
}

/** 等价于 Python 的 str(exc)：Error 取 message，其余 String()。 */
function excMessage(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/**
 * 复刻 `str(Path("./x"))` 的形态：把开头的 "./" 规范化掉
 * （Python 打印的是 `Path(args.out)` 的 str，如 "./probe_ui.xml" → "probe_ui.xml"）。
 */
function pathStr(p: string): string {
  return p.startsWith("./") ? p.slice(2) : p;
}

async function mainAsync(args: Args): Promise<void> {
  await configureLogging("INFO", "./logs");

  console.log(`📱 正在 dump 设备 ${args.device} 的 UI...`);
  const elements = await dumpUi(args.device, { compressed: !args.full });

  // Print all clickable elements with text or resource-id
  console.log(`\n=== 可点击元素（共 ${elements.length} 个节点） ===`);
  for (const el of elements) {
    if (el.clickable && (el.text || el.resourceId || el.contentDesc)) {
      const [cx, cy] = el.center;
      console.log(
        `  [${String(cx).padStart(4)}, ${String(cy).padStart(4)}]  ` +
          `text=${pyRepr(el.text).padEnd(20)}  rid=${pyRepr(el.resourceId).padEnd(30)}  ` +
          `class=${el.className.split(".").pop() ?? ""}`,
      );
    }
  }

  // Save XML
  const out = pathStr(args.out);
  await dumpUiToFile(args.device, args.out);
  console.log(`\n💾 XML 已保存: ${out}`);
}

async function main(): Promise<void> {
  const p = new Command();
  p.name("probe_selectors.ts").description(DOC);
  p.requiredOption("--device <device>");
  p.option("--out <out>", "", "./probe_ui.xml");
  p.option("--full", "不要 compressed 模式（更全但更慢）");

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
  await mainAsync(args);
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
