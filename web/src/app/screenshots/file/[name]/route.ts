import { readFile } from "node:fs/promises";
import path from "node:path";

import { resolveShotsDir } from "@/lib/paths";

export const dynamic = "force-dynamic";

/**
 * 文件名白名单：字母/数字/下划线/连字符/点，且必须以 .png 结尾。
 * 排除空名、目录分隔符与非法字符；配合 basename 检查双保险防路径穿越。
 */
const NAME_RE = /^[\w.-]+\.png$/i;

/**
 * 截图墙单张 PNG（设计 §5.3，供墙内 `<img>` 引用）。
 *
 * - `name` 强校验：白名单正则 + `basename(name) === name`（拒绝 `../` 等路径穿越）；
 * - 目录按 `resolveShotsDir()` 每次请求时现解析（目录可能在服务运行期间才被
 *   core 抢票流程创建）；
 * - 成功：200 + `image/png` + `Cache-Control: no-store`（失败截图墙要求始终最新）；
 * - 文件消失 / 目录未就绪 → 404；名字非法 → 400。
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await ctx.params;
  if (!name || !NAME_RE.test(name) || path.basename(name) !== name) {
    return Response.json({ error: `非法的文件名: ${name}` }, { status: 400 });
  }

  const resolution = resolveShotsDir();
  if (resolution === null) {
    return Response.json({ error: "未找到 damai_shots 截图目录" }, { status: 404 });
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(path.join(resolution.dir, name));
  } catch {
    return Response.json({ error: `截图不存在: ${name}` }, { status: 404 });
  }

  // new Uint8Array 拷贝一层：Buffer 的底层 ArrayBuffer 可能大于视图，且满足 BodyInit 类型
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
    },
  });
}
