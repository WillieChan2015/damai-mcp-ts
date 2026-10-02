/**
 * 把 UIAutomator XML dump 解析为 UIElement 扁平列表
 * （Python `inspector/dump.py` 的 TS 对应物）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { DOMParser, XMLSerializer, onErrorStopParsing } from "@xmldom/xmldom";

import { adb, persistentShellEnabledFor, runShellCommand, shell } from "../device/adb";
import { ADBError } from "../utils/errors";
import { logger } from "../utils/logging";
import { UIElement, parseBounds } from "./models";

/**
 * dump XML 读取路径的进程内 memo：记住首次命中的候选路径，后续 dump 优先
 * 直读（单次 dump 从最多 6 个子进程稳定到 2 个：1 次 dump 命令 + 1 次 cat）。
 * memo 路径读取失败（非 ok / 空输出 / 无 `<node`）时清空并回落候选顺序，
 * 任一路径成功后重写 memo。{@link clearDumpReadPathMemo} 供测试重置。
 */
let dumpReadPathMemo: string | null = null;

/** 清空 dump XML 读取路径的 memo，迫使下一次 dump 重新按候选顺序探测。 */
export function clearDumpReadPathMemo(): void {
  dumpReadPathMemo = null;
}

/** 在 UIElement 上提升为一等字段的原生 XML 属性（对应 Python `_NODE_FIELDS`）。 */
const NODE_FIELDS = [
  "text",
  "resource-id",
  "class",
  "content-desc",
  "clickable",
  "enabled",
  "selected",
  "checked",
  "password",
  "focused",
  "package",
] as const;

/** 对应 Python 的 `b"<node" in result.stdout_bytes`：字节序列haystack搜索。 */
const NODE_TAG_BYTES = new TextEncoder().encode("<node");

/** UTF-8 解码器（非 fatal：无效字节替换为 U+FFFD，对应 `errors="replace"`）。 */
const UTF8_DECODER = new TextDecoder("utf-8");

/** 等价于 Python 的 `str(exc)`：Error 取 message，其余 String()。 */
function excMessage(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** 在原始字节中搜索字节序列；未命中返回 -1（对应 Python 的 `in` 字节串包含判断）。 */
function bytesIndexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return i;
  }
  return -1;
}

/** 把原始字节按 UTF-8 解码（无效序列用替换字符，对应 `decode("utf-8", errors="replace")`）。 */
function decodeUtf8(bytes: Uint8Array): string {
  return UTF8_DECODER.decode(bytes);
}

/**
 * 严格解析 XML：`error` / `fatalError` 级别一律抛 `ParseError`，
 * 与 lxml `etree.fromstring` 的严格语义对齐（@xmldom 默认 onError 只会
 * console.error 后继续解析，会产生残缺的元素树，行为不同）。
 */
function parseXml(xmlText: string) {
  return new DOMParser({ onError: onErrorStopParsing }).parseFromString(
    xmlText,
    "application/xml",
  );
}

/**
 * Dump 当前 UI 层级为扁平的 UIElement 列表。
 *
 * 返回*扁平*列表（深度优先前序遍历）。如需树结构可使用 `parent` 索引
 * （为简单起见未暴露）。
 *
 * 实现步骤：
 *   1. `adb shell uiautomator dump /sdcard/window_dump.xml`
 *   2. `adb exec-out cat /sdcard/window_dump.xml` 读取 XML
 *   3. XML 解析 → 遍历所有节点
 *
 * @remarks
 * 步骤 1 的写命令段在 per-device 持久 shell 启用时走常驻会话
 * （{@link persistentShellEnabledFor}），任一通道失败回落一次性 spawn 重试
 * 一次；未启用时与旧行为逐字一致。步骤 2 的 XML 读取恒走 `adb exec-out cat`
 * 一次性进程（原始字节策略：交互式 shell 流无法承载二进制），但会经
 * {@link dumpReadPathMemo} 记住首次命中的候选路径优先直读。
 */
export async function dumpUi(
  deviceId: string,
  { compressed = true }: { compressed?: boolean } = {},
): Promise<UIElement[]> {
  // 1. 让 uiautomator 执行 dump
  const dumpCmd = compressed ? "uiautomator dump --compressed" : "uiautomator dump";
  let dumpOut: string;
  if (persistentShellEnabledFor(deviceId)) {
    try {
      // uiautomator dump 在真机/模拟器上可能远超普通 input 命令的耗时
      dumpOut = await runShellCommand(dumpCmd, { deviceId, receiptTimeoutMs: 15000 });
    } catch {
      // 持久通道失败（回执超时 / 会话关闭 / 远端报错）→ 回落一次性 spawn 重试一次
      dumpOut = await shell(dumpCmd, { deviceId, timeout: 15, check: false });
    }
  } else {
    dumpOut = await shell(dumpCmd, { deviceId, timeout: 15, check: false });
  }
  // uiautomator dump 会在 stdout 打印 "UI hierchary dumped to: /sdcard/...xml"
  // （持久 shell 的命令回显只含 "dump"，不含 "dumped"，无误命中）
  if (!dumpOut || !dumpOut.includes("dumped")) {
    throw new ADBError(`uiautomator dump 失败: ${JSON.stringify(dumpOut)}`);
  }

  // 2. 读取 XML —— 依次尝试若干已知路径
  // IMPORTANT: use `adb exec-out cat` instead of `adb shell cat` — the latter
  // routes through Windows console code page (GBK) for non-ASCII bytes,
  // which mangles Chinese in the UI dump. `exec-out` keeps raw bytes intact.
  const candidates = [
    "/sdcard/window_dump.xml",
    "/sdcard/dump.xml",
    "/data/local/tmp/ui_dump.xml",
    "/data/local/tmp/window_dump.xml",
  ];
  let xmlText: string | null = null;
  // 读取路径 memo：优先直读上次命中的路径；失效则清空并回落候选顺序
  const memoPath = dumpReadPathMemo;
  if (memoPath !== null) {
    const result = await adb("exec-out", "cat", memoPath, {
      deviceId,
      check: false,
      timeout: 5,
    });
    if (
      result.ok &&
      result.stdoutBytes.length > 0 &&
      bytesIndexOf(result.stdoutBytes, NODE_TAG_BYTES) !== -1
    ) {
      xmlText = decodeUtf8(result.stdoutBytes);
    } else {
      dumpReadPathMemo = null;
    }
  }
  if (xmlText === null) {
    for (const path of candidates) {
      // Use exec-out to bypass Windows code page mangling for non-ASCII
      const result = await adb("exec-out", "cat", path, {
        deviceId,
        check: false,
        timeout: 5,
      });
      if (
        result.ok &&
        result.stdoutBytes.length > 0 &&
        bytesIndexOf(result.stdoutBytes, NODE_TAG_BYTES) !== -1
      ) {
        xmlText = decodeUtf8(result.stdoutBytes);
        dumpReadPathMemo = path;
        break;
      }
    }
  }
  if (xmlText === null) {
    // 兜底：直接再按字节读一次默认路径
    const result = await adb("exec-out", "cat", "/sdcard/window_dump.xml", {
      deviceId,
      check: false,
      timeout: 5,
    });
    xmlText = result.stdoutBytes.length > 0 ? decodeUtf8(result.stdoutBytes) : null;
  }
  if (!xmlText || !xmlText.includes("<node")) {
    throw new ADBError("uiautomator dump 未返回有效 XML");
  }

  // 3. 解析
  let doc: ReturnType<typeof parseXml>;
  try {
    doc = parseXml(xmlText);
  } catch (exc) {
    logger.debug(`XML 解析失败: ${excMessage(exc)}; 前 200 字: ${xmlText.slice(0, 200)}`);
    throw new ADBError(`UI XML 解析失败: ${excMessage(exc)}`, { cause: exc });
  }

  const elements: UIElement[] = [];
  const nodes = doc.getElementsByTagName("node");
  for (const node of nodes) {
    const attrs: Record<string, string> = {};
    for (const f of NODE_FIELDS) {
      attrs[f] = node.getAttribute(f) ?? "";
    }
    try {
      elements.push(
        new UIElement({
          tag: node.tagName,
          text: attrs["text"],
          resourceId: attrs["resource-id"],
          className: attrs["class"],
          contentDesc: attrs["content-desc"],
          bounds: parseBounds(node.getAttribute("bounds") ?? ""),
          clickable: attrs["clickable"].toLowerCase() === "true",
          enabled: attrs["enabled"].toLowerCase() === "true",
          selected: attrs["selected"].toLowerCase() === "true",
          checked: attrs["checked"].toLowerCase() === "true",
          password: attrs["password"].toLowerCase() === "true",
          focused: attrs["focused"].toLowerCase() === "true",
          package: attrs["package"],
        }),
      );
    } catch (exc) {
      logger.warning(`跳过坏节点 ${node.getAttribute("bounds")}: ${excMessage(exc)}`);
      continue;
    }
  }
  return elements;
}

/**
 * Dump UI 并把原始 XML 保存到 `savePath`（用于调试）。
 *
 * 返回写入的文件路径。
 */
export async function dumpUiToFile(deviceId: string, savePath: string): Promise<string> {
  await mkdir(dirname(savePath), { recursive: true });
  const elements = await dumpUi(deviceId);
  // 重新序列化一个最小 XML 便于人工检查
  const doc = new DOMParser().parseFromString("<hierarchy/>", "application/xml");
  const root = doc.documentElement;
  if (root == null) {
    throw new Error("无法构建用于导出的 XML 根节点");
  }
  for (const el of elements) {
    const boundsStr = `[${el.bounds[0]},${el.bounds[1]}][${el.bounds[2]},${el.bounds[3]}]`;
    const node = doc.createElement("node");
    node.setAttribute("text", el.text);
    node.setAttribute("resource-id", el.resourceId);
    node.setAttribute("class", el.className);
    node.setAttribute("bounds", boundsStr);
    node.setAttribute("clickable", el.clickable ? "true" : "false");
    root.appendChild(node);
  }
  // 对应 Python ET.write(..., encoding="utf-8", xml_declaration=True)：
  // 声明行 + 文档本体（单引号声明、小写 utf-8 与 ElementTree 输出一致）
  const xml = `<?xml version='1.0' encoding='utf-8'?>\n${new XMLSerializer().serializeToString(doc)}`;
  await writeFile(savePath, xml, "utf-8");
  return savePath;
}
