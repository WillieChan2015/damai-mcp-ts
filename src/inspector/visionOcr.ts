/**
 * 用 macOS Vision 识别截图里的文字，返回左上角坐标系的文字框。
 * 大麦把场次、票档正文藏在无障碍树外面时，用这个补文字。
 *
 * Swift 源码内嵌在这里。`new URL("./xx.swift", import.meta.url)` 会被 Next
 * 收成静态资源，服务端拿到的不是磁盘路径，swift 起不来。
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { OcrBox } from "../damai/purchaseSheet";

const execFileAsync = promisify(execFile);

let visionBinary: Promise<string> | null = null;

/** 编译一次再复用。每次 `swift` 解释脚本都要冷启动编译器。 */
function compiledVisionBinary(): Promise<string> {
  if (visionBinary === null) {
    visionBinary = compileVisionBinary().catch((exc: unknown) => {
      visionBinary = null;
      throw exc;
    });
  }
  return visionBinary;
}

async function compileVisionBinary(): Promise<string> {
  const dir = join(tmpdir(), "damai-vision-ocr");
  await mkdir(dir, { recursive: true });
  const hash = createHash("sha256").update(VISION_SWIFT).digest("hex").slice(0, 16);
  const binary = join(dir, `ocr-${hash}`);
  try {
    await access(binary);
    return binary;
  } catch {
    // 还没编译过，或上次的产物被清掉了。
  }
  const source = join(dir, "vision-ocr.swift");
  await writeFile(source, VISION_SWIFT);
  await execFileAsync("/usr/bin/swiftc", ["-o", binary, source], { timeout: 60_000 });
  return binary;
}

const VISION_SWIFT = `import Foundation
import Vision
import ImageIO

let path = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
let url = URL(fileURLWithPath: path) as CFURL
guard let src = CGImageSourceCreateWithURL(url, nil),
      let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
  fputs("无法读取截图\\n", stderr)
  exit(1)
}
let width = CGFloat(cg.width)
let height = CGFloat(cg.height)
let request = VNRecognizeTextRequest()
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.recognitionLevel = .accurate
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do {
  try handler.perform([request])
} catch {
  fputs("识别失败 \\(error)\\n", stderr)
  exit(2)
}
for observation in request.results ?? [] {
  guard let candidate = observation.topCandidates(1).first else { continue }
  let box = observation.boundingBox
  let x1 = box.origin.x * width
  let y1 = (1 - box.origin.y - box.size.height) * height
  let x2 = (box.origin.x + box.size.width) * width
  let y2 = (1 - box.origin.y) * height
  print(String(format: "%.0f,%.0f,%.0f,%.0f\\t%@", x1, y1, x2, y2, candidate.string as NSString))
}
`;

/** 解析 `x1,y1,x2,y2\t文字`。坏行跳过。 */
export function parseOcrOutput(stdout: string): OcrBox[] {
  const boxes: OcrBox[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    const tab = trimmed.indexOf("\t");
    if (tab < 0) {
      continue;
    }
    const parts = trimmed
      .slice(0, tab)
      .split(",")
      .map((part) => Number(part));
    const text = trimmed.slice(tab + 1).trim();
    if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part)) || text === "") {
      continue;
    }
    const [x1, y1, x2, y2] = parts;
    if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
      continue;
    }
    boxes.push({ bounds: [x1, y1, x2, y2], text });
  }
  return boxes;
}

/** 识别整张 PNG。只在 macOS 上可用。 */
export async function recognizeTextBoxes(png: Buffer): Promise<OcrBox[]> {
  if (process.platform !== "darwin") {
    throw new Error("截图识别只支持 macOS");
  }
  const dir = await mkdtemp(join(tmpdir(), "damai-ocr-"));
  const pngPath = join(dir, "screen.png");
  try {
    await writeFile(pngPath, png);
    const binary = await compiledVisionBinary();
    const { stdout } = await execFileAsync(binary, [pngPath], {
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return parseOcrOutput(stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
