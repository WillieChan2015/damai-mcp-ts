import { NextResponse, type NextRequest } from "next/server";

/**
 * 用一次性查询参数换取长效 Cookie（浏览器场景）：
 * `GET /api/token?token=<DAMAI_WEB_TOKEN>` → Set-Cookie 后跳回首页。
 * 非法 token 一律 401，且不在响应中回显期望值。
 */
const TOKEN_COOKIE = "damai_web_token";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export function GET(req: NextRequest) {
  const expected = process.env.DAMAI_WEB_TOKEN;
  const got = req.nextUrl.searchParams.get("token");
  if (!expected || got !== expected) {
    return NextResponse.json({ error: "token 不正确" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.search = "";
  url.pathname = "/";
  const res = NextResponse.redirect(url);
  res.cookies.set(TOKEN_COOKIE, expected, {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
  return res;
}
