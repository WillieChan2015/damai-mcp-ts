import { NextResponse, type NextRequest } from "next/server";

/**
 * 访问令牌校验（计划 D6）。Next 16 规范：`proxy.ts` 取代已废弃的 `middleware.ts`。
 *
 * token 来源：`DAMAI_WEB_TOKEN` 环境变量，由 `cli.ts web` 子命令注入
 * （显式 --token 或自动生成并打印到终端）。
 *
 * - 环境变量存在：请求须携带 `x-web-token` 头或 `damai_web_token` Cookie
 *   （浏览器经 cli 日志打印的一键链接 `{host}/?token=…` 打开即自动换取，
 *   或手动经 `GET /api/token?token=…`），否则 401。
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
  // ① 已持有有效凭证（x-web-token 头 / Cookie）→ 放行；过期的一键链接不打扰已登录会话
  if (extractToken(req) === expected) {
    return NextResponse.next();
  }
  // ② 一次性鉴权链接（cli 启动日志打印的 {host}/?token=xxx）：校验通过 → 种
  //    httpOnly Cookie 并去掉 token 参数重定向到原路径；错误 → 401
  const urlToken = req.nextUrl.searchParams.get("token");
  if (urlToken !== null) {
    if (urlToken === expected) {
      const target = req.nextUrl.clone();
      target.searchParams.delete("token");
      const res = NextResponse.redirect(target);
      res.cookies.set(TOKEN_COOKIE, expected, {
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        maxAge: 60 * 60 * 24 * 30, // 与 /api/token 路由一致
      });
      return res;
    }
    return NextResponse.json(
      { error: "未授权：链接中的 token 不正确（请从 cli 启动日志复制最新的一键登录链接）" },
      { status: 401 },
    );
  }
  // ③ 无任何凭证
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
