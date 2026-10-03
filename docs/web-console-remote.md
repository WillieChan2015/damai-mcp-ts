# Web 控制台远程访问安全指南

> 面向需要把 `damai-mcp-ts web` 控制台暴露到非回环地址（局域网 / 远程）的使用者。
> 默认姿态下控制台只监听 `127.0.0.1`，本文解释：默认为什么安全、放开绑定时的风险在哪、
> 以及如何用「SSH 隧道 / 反向代理 + HTTPS + 防火墙」把风险降到最低。

## 1. 威胁模型与默认姿态

web 控制台能**完全操控你的手机/模拟器**：查看与 dump UI、截图、发起抢票任务（含点击、
输入、候场等设备操作）、尾随日志、AI 助手（只读工具）。因此本项目的安全模型很简单：

> **谁持有 token，谁就能操控设备。**

默认姿态（不做任何配置时的安全底线）：

- **只绑定回环地址**：`web` 子命令默认 `--host 127.0.0.1`，进程外任何机器都连不上；
- **强制 token**：cli 启动路径恒注入 `DAMAI_WEB_TOKEN` 环境变量（`src/cli.ts` 的
  `cmdWeb`，回环绑定下未显式 `--token` 时自动生成高熵随机值并打印到终端），
  由 `web/src/proxy.ts` 对每个请求校验。

结论：**保持默认（127.0.0.1 + token）即可安全使用**。以下所有章节只在你要把它暴露到
非回环地址时才需要读。

## 2. 鉴权机制（proxy.ts）

Next 16 规范用 `web/src/proxy.ts` 取代已废弃的 `middleware.ts`，所有请求先过它：

- **覆盖面**：matcher 为
  `["/((?!_next/static|_next/image|favicon.ico|api/token).*)"]`——除 Next 静态资源与
  `/api/token` 外的一切路由（页面、REST、SSE 流式端点）**全部强制鉴权**，新增路由无需
  各自实现校验；
- **token 载体**（二者任一）：
  - 请求头 `x-web-token: <token>`（脚本 / curl 场景）；
  - Cookie `damai_web_token`（浏览器场景）：浏览器先访问
    `GET /api/token?token=<token>` 换取——校验通过后 `Set-Cookie`
    （`httpOnly` + `sameSite=strict` + `path=/`，有效期 30 天）并 302 跳回首页。
    非法 token 一律 401 且不回显期望值；
- **SSE 也走同一套**：浏览器 `EventSource` 对同源请求默认携带 Cookie（含 `httpOnly`，
  `withCredentials` 仅跨域才需要），因此任务进度 `/api/tasks/[id]/events`、日志尾随
  `/api/logs/tail`、AI 对话 `/api/ai/chat` 等流式端点复用 matcher 即可，无需额外改造
  （此为 EventSource 规范行为，本仓库未做浏览器实测，如需确认请自行抓包验证）；
- **无 `DAMAI_WEB_TOKEN` 时放行**：proxy 检测到环境变量缺失会直接放行，并在响应头标注
  `x-damai-web-auth: disabled`。这只应出现在**手动 `next dev` 的本地开发场景**——
  cli 启动路径恒注入 token。风险：若你在非回环地址上手动起 dev 且未设置该变量，
  控制台对所在网段完全裸奔。**永远不要在非回环绑定下依赖这一放行行为。**

一个已知的小口径：`/api/token?token=…` 的 token 位于 URL 查询串，可能落入反向代理的
access log 或浏览器历史（跳转后的最终 URL 不含 token，`route.ts` 会清空 search）。
脚本场景请优先用 `x-web-token` 头，浏览器场景换取 Cookie 一次即可。

## 3. 非回环绑定规则（--host 安全闸）

`src/cli.ts` 导出的 `assertWebBinding(host, hasExplicitToken)` 是唯一裁决点：

| `--host` | 显式 `--token` | 行为 |
| --- | --- | --- |
| `localhost` / `127.*` / `::1` | 任意 | 放行（返回 `true`） |
| 非回环 | 未提供 | **抛中文 Error 拒绝启动**（自动生成 token + 内网暴露属高危组合） |
| 非回环 | 显式提供 | 打印多行风险横幅后继续启动（返回 `false`） |

- 自动生成 token **仅限回环绑定**——杜绝「忘了改默认 token + 内网可访问」的组合；
- 确需非回环绑定时，请**自定义高熵 token**（如 `openssl rand -hex 24` 的输出），
  不要用弱口令；
- 横幅要点：绑定地址内网可见、持 token 者可完全操控设备、自动支付边界不变但设备仍可
  被操纵、建议反代 + HTTPS + 防火墙白名单（详见下文）。

## 4. 反向代理建议（TLS 终结 + SSE 透传）

推荐拓扑：**Next 仍绑 127.0.0.1，由反向代理对外提供 HTTPS**——TLS 在代理层终结，
明文流量不出本机。

### 4.1 三个 SSE 流式端点必须关闭代理缓冲

以下端点是长连接事件流（`text/event-stream`），缓冲会把事件攒到连接结束才发出，
表现为「页面永远等不到进度」：

- `/api/tasks/[id]/events` —— 任务进度流（15s 心跳注释行已内置，见
  `web/src/app/api/tasks/[id]/events/route.ts:80-86`）；
- `/api/logs/tail` —— core 日志尾随（同样 15s 心跳）；
- `/api/ai/chat` —— AI 对话流。

Nginx 必须 `proxy_buffering off;`（或上游响应携带 `X-Accel-Buffering: no`）；
Caddy 默认流式转发，用 `flush_interval -1` 显式强制。同时**不要在反代层缓存这些
响应**——它们都带 `Cache-Control: no-store, no-transform`，任何缓存行为都属配置错误。

### 4.2 Caddy 示例（自动 HTTPS）

```caddyfile
console.example.com {
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1   # SSE：立即冲刷，不做缓冲
    }
}
```

### 4.3 Nginx 示例

```nginx
server {
    listen 443 ssl;
    server_name console.example.com;
    # ssl_certificate     /etc/letsencrypt/live/console.example.com/fullchain.pem;
    # ssl_certificate_key /etc/letsencrypt/live/console.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        # SSE：关闭缓冲与缓存，放宽读超时（15s 心跳已足够保活，超时是兜底）
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
}
```

### 4.4 可选：在代理层再加一道源 IP 白名单

```nginx
location / {
    allow 192.168.1.0/24;   # 仅可信网段
    deny  all;
    # ... 其余同上
}
```

## 5. 防火墙建议

**首选方案：保持 127.0.0.1 + SSH 隧道**（零新增暴露面，无需 HTTPS 证书）：

```bash
# 在你自己的机器上执行；之后本地浏览器打开 http://127.0.0.1:3000
ssh -N -L 3000:127.0.0.1:3000 user@server
```

确需内网/公网直连时，**仅放行可信源 IP，禁用全网段放行**：

```bash
# ufw：仅允许内网网段访问 3000
ufw allow from 192.168.1.0/24 to any port 3000 proto tcp

# iptables 等价（同时显式拒绝其余来源）
iptables -A INPUT -p tcp --dport 3000 -s 192.168.1.0/24 -j ACCEPT
iptables -A INPUT -p tcp --dport 3000 -j DROP
```

云主机场景优先用安全组做同样的事。**不要** `--host 0.0.0.0` + 防火墙全放行——那等于
把设备控制权交给所在网络的每一个人（token 只是最后防线，不是唯一防线）。

## 6. 凭证卫生

- **`DAMAI_WEB_TOKEN`**：只经环境变量注入 Next 进程，不落任何文件。不要写进 shell
  rc、`.env` 等会入库的文件；泄露后立即换新并重启；
- **`web/data/ai-settings.json`**（权限 0600）：AI 提供商配置，**含 API Key**，绝不能
  提交仓库——提交前确认 `.gitignore` 确实覆盖该目录（当前 `web/.gitignore` 尚未包含
  `data/`，需自行补规则）；
- **`~/.config/damai-mcp-ts/notify.json`**（权限 0600）：ClawBot 通知凭证，位于仓库外
  的用户配置目录，天然不入库——移动/备份仓库时不要把它拷进去；
- 浏览器侧 token 换取一次即可（Cookie 30 天有效）；终端里打印的 token 视同设备密码，
  不要贴进 issue、聊天记录或截图。

## 7. 已知边界

- **MCP 进程不受 web token 保护**：经 stdio 接入 Claude Code 的 MCP server 与 web
  控制台是两个独立进程，`proxy.ts` 只守护 web 流量。MCP 的 HTTP transport
  （`serve --transport http/sse`）请同样保持默认 `127.0.0.1` 绑定；
- **web lockfile 不覆盖 MCP 并发**：web 侧的设备锁文件只协调多个 web 任务进程之间
  的设备互斥；通过 MCP 工具直接发起的抢票/监控任务不在锁的覆盖范围内——两边同时
  操作同一设备仍可能相互干扰，请自行错开；
- **自动支付边界**：控制台与 MCP 工具都不会自动支付（下单流程在提交订单前停止），
  网络暴露不改变这一边界；但暴露后设备可被持 token 者远程操纵，请按 §4/§5 收紧访问面。
