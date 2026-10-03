import { Jimp } from "jimp";

import { screenshot } from "@core/actions/actions";
import { ADBError } from "@core/utils/errors";

export const dynamic = "force-dynamic";

/** 传输流量限制：等比缩小上限（宽, 高），与 MCP 端截图工具口径一致（设计 §5.2）。 */
const MAX_SIZE: readonly [number, number] = [720, 1280];

/**
 * 设备实时截图端点（JPEG，no-store，设计 §5.2）。
 *
 * core `screenshot()` 返回 PNG 字节（`screencap -p`，ADBError 时内部重试
 * maxAttempts=2 次后抛出）；技术决策 3 要求 JPEG 响应 ⇒ 此处经 jimp 转码
 * （默认质量），照片类图像 JPEG 体积显著小于 PNG，利于 2s 级轮询。
 *
 * - 成功：200 + `image/jpeg` + `Cache-Control: no-store`；
 * - ADBError（设备离线/adb 不可用）→ 502 + 中文 error，前端 `<img>` onError 降级；
 * - 其余异常 → 500；空 id → 400。不写 404（设备不存在由 ADB 错误自然表达）。
 *
 * 鉴权由 `src/proxy.ts` matcher 统一覆盖，本路由不自行实现；
 * 前端轮询方式：`<img src="/api/devices/${id}/screenshot?t=${Date.now()}">`（时间戳配合 no-store 防缓存）。
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  if (!id || id.trim() === "") {
    return Response.json({ error: "设备 id 不能为空" }, { status: 400 });
  }

  let pngBytes: Buffer | string;
  try {
    pngBytes = await screenshot(id, undefined, {
      returnBase64: false,
      maxSize: MAX_SIZE,
    });
  } catch (err) {
    if (err instanceof ADBError) {
      return Response.json(
        {
          error: `设备截图失败（设备可能不在线或 adb 不可用，已重试 2 次）: ${err.message}`,
        },
        { status: 502 },
      );
    }
    return Response.json(
      { error: `设备截图失败: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }

  // returnBase64: false ⇒ core 恒返回 Buffer；string 分支仅为类型收窄的防御
  if (typeof pngBytes === "string") {
    return Response.json({ error: "截图返回了意外的 base64 数据" }, { status: 500 });
  }

  let jpeg: Buffer;
  try {
    const img = await Jimp.read(pngBytes);
    jpeg = await img.getBuffer("image/jpeg");
  } catch (err) {
    return Response.json(
      { error: `截图编码失败: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }

  // new Uint8Array 拷贝一层：Buffer 的底层 ArrayBuffer 可能大于视图，且满足 BodyInit 类型
  return new Response(new Uint8Array(jpeg), {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "no-store",
    },
  });
}
