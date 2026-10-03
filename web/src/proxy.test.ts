import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";

import proxy, { config } from "./proxy";

const TOKEN = "test-token-1234";
const ORIGINAL = process.env.DAMAI_WEB_TOKEN;

afterEach(() => {
  // 还原环境变量，避免污染其他测试文件
  if (ORIGINAL === undefined) {
    delete process.env.DAMAI_WEB_TOKEN;
  } else {
    process.env.DAMAI_WEB_TOKEN = ORIGINAL;
  }
});

function req(url: string, headers?: Record<string, string>): NextRequest {
  return new NextRequest(new Request(url, { headers }));
}

describe("proxy（访问令牌校验）", () => {
  it("未配置 token：放行并标注 disabled（手动 next dev 场景）", () => {
    delete process.env.DAMAI_WEB_TOKEN;
    const res = proxy(req("http://localhost/tasks"));
    expect(res.headers.get("x-damai-web-auth")).toBe("disabled");
  });

  it("x-web-token 头正确 → 放行", () => {
    process.env.DAMAI_WEB_TOKEN = TOKEN;
    const res = proxy(req("http://localhost/api/tasks", { "x-web-token": TOKEN }));
    expect(res.status).toBe(200);
  });

  it("?token= 正确 → 307 重定向去掉 token 参数并种 httpOnly Cookie", () => {
    process.env.DAMAI_WEB_TOKEN = TOKEN;
    const res = proxy(req(`http://localhost/?token=${TOKEN}`));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`damai_web_token=${TOKEN}`);
    expect(setCookie.toLowerCase()).toContain("httponly");
  });

  it("?token= 正确且带其他查询参数：仅剔除 token、其余保留", () => {
    process.env.DAMAI_WEB_TOKEN = TOKEN;
    const res = proxy(req(`http://localhost/tasks?foo=1&token=${TOKEN}`));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/tasks?foo=1");
  });

  it("?token= 错误 → 401 且提示从启动日志复制最新链接", () => {
    process.env.DAMAI_WEB_TOKEN = TOKEN;
    const res = proxy(req("http://localhost/?token=wrong-token"));
    expect(res.status).toBe(401);
    const body = res.headers.get("content-type");
    expect(body).toContain("json");
  });

  it("已持有合法 Cookie + 过期的一键链接 → 优先放行（不因 stale 链接 401）", () => {
    process.env.DAMAI_WEB_TOKEN = TOKEN;
    const res = proxy(req(`http://localhost/?token=stale-token`, { cookie: `damai_web_token=${TOKEN}` }));
    expect(res.status).toBe(200);
  });

  it("无任何凭证 → 401", () => {
    process.env.DAMAI_WEB_TOKEN = TOKEN;
    const res = proxy(req("http://localhost/api/health"));
    expect(res.status).toBe(401);
  });

  it("matcher 覆盖面：api 与页面均匹配、_next 静态放行", () => {
    const matcher = config.matcher[0] ?? "";
    expect(matcher).toContain("_next/static");
    expect(matcher).toContain("api/token");
  });
});
