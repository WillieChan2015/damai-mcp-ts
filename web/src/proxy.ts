import { NextResponse, type NextRequest } from "next/server";

/**
 * 访问令牌校验（计划 D6）。Next 16 规范：`proxy.ts` 取代已废弃的 `middleware.ts`。
 *
 * token 来源：`DAMAI_WEB_TOKEN` 环境变量，由 `cli.ts web` 子命令注入
 * （显式 --token 或自动生成并打印到终端）。
 *
 * - 环境变量存在：请求须携带 `x-web-token` 头或 `damai_web_token` Cookie
 *   （浏览器经 `GET /api/token?token=…` 换取），否则 401。
 * - 环境变量不存在：说明是手动 `next dev` 的本地开发场景，放行并在响应头
 *   标注 `x-damai-web-auth: disabled`（cli 启动路径始终配置 token）。
 */
const TOKEN_COOKIE = "damai_web_token";

function extractToken(req: NextRequest): string | null {
  return req.headers.get("x-web-token") ?? req.cookies.get(TOKEN_COOKIE)?.value ?? null;
}

export default function proxy(req: NextRequest) {
  const expected = process.env.DAMAI_WEB_TOKEN;
  if (!expected) {
    const res = NextResponse.next();
    res.headers.set("x-damai-web-auth", "disabled");
    return res;
  }
  if (extractToken(req) === expected) {
    return NextResponse.next();
  }
  return NextResponse.json(
    { error: "未授权：缺少或错误的 token（x-web-token 头，或经 /api/token 换取 Cookie）" },
    { status: 401 },
  );
}

export const config = {
  // 放行静态资源与 /api/token（发 Cookie 的端点，自身校验 query token，无绕过风险）；
  // 其余全部过鉴权
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/token).*)"],
};
