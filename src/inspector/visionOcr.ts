/**
 * 用 macOS Vision 识别截图里的文字，返回左上角坐标系的文字框。
 * 大麦把场次、票档正文藏在无障碍树外面时，用这个补文字。
 *
 * Swift 源码内嵌在这里。`new URL("./xx.swift", import.meta.url)` 会被 Next
 * 收成静态资源，服务端拿到的不是磁盘路径，swift 起不来。
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { OcrBox } from "../damai/purchaseSheet";

const execFileAsync = promisify(execFile);

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
  const scriptPath = join(dir, "vision-ocr.swift");
  try {
    await writeFile(pngPath, png);
    await writeFile(scriptPath, VISION_SWIFT);
    const { stdout } = await execFileAsync("/usr/bin/swift", [scriptPath, pngPath], {
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return parseOcrOutput(stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
