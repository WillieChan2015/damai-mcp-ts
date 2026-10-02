# Web 可视化控制台（Web Console）计划文档

状态：计划定稿——技术路线已选型 **Next.js 16 全栈（App Router，"用法 A"）**，待启动实施。
日期：2026-10-02（Next.js 方案重排版）。
上游分析：本会话《Web 可视化封装可行性分析》《技术栈推荐（联网核实）》《Next.js 用法收益与代价分析》《用法 A 选型展开》；
关联设计：[`docs/improvements-from-competitors.md`](../improvements-from-competitors.md)（六项借鉴改进，其中 §7.5/§7.6 的
`damai_monitor_availability` 与 `notify_send` 已在 `src/server.ts` 接线，是本计划监控/通知面板的直接后端）。
行为保真基线：`MIGRATION_NOTES.md` §2/§3 对 web 包同样适用（见 §5 护栏）。

---

## 1. 背景与目标

给 damai-mcp-ts 增加**可视化操作管理**能力：设备管理、抢票任务、余票监控、通知配置、
日志复盘均可在浏览器中操作；同时**完整保留现有三种使用方式**（MCP+Agent、SDK 直调、CLI）。

非目标：不做 Electron/Tauri 桌面壳；不做多租户 SaaS；不自动支付。

## 2. 路线决策与代价确认

**选型：Next.js 16 全栈（App Router）**，用 Route Handlers / Server Actions 直接承载后端逻辑，
不再单设 Hono 服务；前端同属一个 Next 应用（RSC + Client Components），样式 Tailwind CSS 4。

已核实版本事实（2026-10）：Next 16 中 **Turbopack 为 dev + build 默认构建器（稳定）**；
**`instrumentation.ts` 为稳定 API**（`register()` 保证先于应用代码执行一次）；**React 19 为 peer 依赖**；
Tailwind 4 官方三依赖接入。

选择此路线换取的价值与明确接受的代价：

| 得 | 失（已接受） |
|---|---|
| RSC / Server Actions 端到端类型安全，前后端一份 zod schema | web 包运行时锁死 Node（core 保持 Bun ≥1.2 / Node ≥22 双运行时承诺不变，Node-only 被**隔离在 web 包内**） |
| `instrumentation.ts` + Turbopack 默认化，长任务宿主与 DX 有官方地基 | 交付体积显著大于轻量 SPA（Next 全家桶），web 设为可选安装 |
| 演进空间：远程控制中心 / 页面内 AI 对话面板（Vercel AI SDK）是 Next 生态最顺路径 | TaskManager / SSE / 设备互斥等核心工作量与轻量路线完全相同，框架并不代劳 |

逃生通道（D8）：TaskManager 与全部业务逻辑写成**框架无关的纯 TS 模块**，Server Actions / Route Handlers 只做壳；
若未来要回退轻量路线（附录 C 的 Hono + rsbuild）或升级形态，可平移的面收窄到壳层。

## 3. 架构总览

```
damai-mcp-ts/                                  ← 仓库根 = core 包（原样保留）
├── src/device|actions|inspector|damai|notify/ ← core SDK：一行不动
│   └── src/schemas/                           ← ★core 唯一新增：纯新增共享 zod schema 目录
├── cli.ts                                     ← 仅新增 `web` 子命令
├── pnpm-workspace.yaml                        ← packages: [".", "web"]
└── web/                                       ← Next 16 全栈应用（独立 package.json，engines: node>=22）
    ├── instrumentation.ts                     ← register(): 启动 TaskManager（稳定 API，先于应用代码执行一次）
    ├── src/task/manager.ts                    ← TaskManager：globalThis 单例（防 dev HMR 重建）
    ├── src/task/lock.ts                       ← deviceId 互斥锁（单进程 Map + v2 跨进程 lockfile）
    ├── app/                                   ← 五个面板（RSC 快照 + Client Components 实时）
    │   ├── devices/  tasks/  monitor/  notify/  logs/  probe/
    └── app/api/
        ├── tasks/[id]/events/route.ts         ← SSE 进度/日志/监控状态流（ReadableStream）
        └── devices/[id]/screenshot/route.ts   ← 截图轮询端点（no-store）
```

- core 引用方式：`web/tsconfig.json` 用 `paths` 别名（如 `@core/* → ../src/*`）直接吃 core 的
  TS 源码，**core 的 package.json 一行不改**；Next/SWC 负责编译（`next build` Turbopack 下同样生效）。
- 进程拓扑：MCP server（stdio）独立进程不变；Next 生产形态是一个 **Node 常驻进程**
  （`cli.ts web` → 子进程 `next start -H 127.0.0.1 -p <port>`，可选 `output: "standalone"`）。

核心复用映射（全部为已存在的导出，无需改 core）：

| Web 功能 | 对接的现成能力 |
|---|---|
| 设备管理页 | `list_devices` / `connect_device` / `device_info`（`src/device/manager.ts`） |
| 实时屏幕预览 | `screenshot`（screencap JPEG 轮询 + `Cache-Control: no-store`） |
| 抢票任务 | `damaiGrab` / `runChecklist` + `stopEvent`（取消）+ `progressCb`（进度） |
| 余票监控面板 | `monitorAvailability`（`interval`/退避/`onReport`/`stopEvent`/`deadline`） |
| 选择器调试器 | `dump_ui` / `find_text`（`examples/probe_selectors.ts` 可视化，改版自救入口） |
| 通知配置 | `ClawBotClient` / `notify_send`（env 回落 `DAMAI_CLAWBOT_*`）+ 测试发送 |
| 日志复盘 | pino（含 pino-roll 文件日志 tail）+ `damai_shots/` 失败截图墙 |

## 4. 技术栈清单

| 层 | 选型 | 说明 |
|---|---|---|
| 框架 | **Next 16（App Router，Turbopack 默认 dev+build）+ React 19** | 版本锁 16.x |
| 样式 | **Tailwind CSS 4**（官方 Next 指南接入） | CSS-first 配置（`@theme`） |
| UI 组件 | **shadcn/ui** | 官方完全适配 React 19 + TW4（forwardRef 移除、`data-slot`）；不选 antd（CSS-in-JS 与 TW4 双样式层冲突 + React 19 需补丁） |
| 长任务宿主 | **`instrumentation.ts` `register()` 启动 TaskManager + `globalThis` 单例** | 官方"应用代码加载前执行一次"钩子；HMR 期间防重建 |
| 突变（启动/取消/保存） | **Server Actions + `next-safe-action` + zod** | 与 `src/schemas/` 共享校验；`useActionState` 承接简单表单 |
| 查询（初始快照） | **RSC 直读** TaskManager / DeviceManager + `export const dynamic = "force-dynamic"` | 控制台全页面禁缓存 |
| 实时推送 | **SSE Route Handler**（`ReadableStream` + `text/event-stream`） | 任务进度（progressCb）、监控状态（onReport）、pino 日志 tail；EventSource 自带重连 |
| WebSocket | **不选**（v1） | Route Handler 原生不支持 WS，需自定义 server；本场景 SSE + 截图轮询足够 |
| 客户端数据 | TanStack Query v5 | SSE 数据流与设备列表轮询的缓存/失效重取 |
| 表格 / 日志流 | TanStack Table v8 / `@tanstack/react-virtual` | 任务列表 / 抢票日志虚拟滚动 |
| 复杂表单 | react-hook-form + `@hookform/resolvers`（吃 `src/schemas/`） | 抢票配置字段多且有联动；简单开关用 `useActionState` |
| 鉴权 | **Next middleware + 固定 token** | `next start` 默认绑 `0.0.0.0`，子命令强制 `-H 127.0.0.1`（D6） |
| 持久化（v2） | `better-sqlite3` 或 `node:sqlite` | 任务表跨重启；启动时标记 interrupted |
| 测试 | vitest（core 不动）+ Route Handler 纯函数测试 + `@testing-library/react` | Handler 就是 `(Request) → Response`，不起服务直测；E2E 可选 Playwright |

## 5. 关键决策记录（ADR 摘要）

- **D1 库优先，框架不倒灌**：core 不感知 web 的存在，web 是 core 的第四个消费者（MCP/CLI/SDK 之后）。
  core 侧**唯一允许的新增**是 `src/schemas/`（纯新增共享 zod schema 目录，不改任何既有文件）；
  其余全部改动落在 `web/` 与 `cli.ts` 的一个子命令。
- **D2 实时通道 = SSE**：进度/日志/监控状态均为单向推送；Next Route Handler 原生不支持 WebSocket，
  为之引入自定义 server 得不偿失——v1 一律 SSE + EventSource 重连，截图预览用轮询。
- **D3 长任务 = TaskManager 常驻，绝不进请求生命周期**：任何 Route Handler / Server Action 都不允许
  `await` 小时级任务（等开票）。TaskManager 持有 `Map<taskId, {promise, stopEvent, progressCb}>`，
  启动/取消是立即返回的短操作，进度经 SSE 订阅；`after()` 只用于响应后短后置（如写日志）。
- **D4 设备互斥做在 TaskManager（按 deviceId）**：单进程内强互斥；MCP 是独立进程无法共享内存锁，
  跨进程冲突先以 UI 常驻警示 + 文档缓解，v2 落地 lockfile（`.damai-web.lock`，按 deviceId 记录持有者与时间戳）。
- **D5 支付边界不可绕过**：表单与 Server Action 强制 `confirm_order=false` 默认，后端不存在自动支付端点；
  页面"确认提交"复用 core 的 `needs_action` → 官方订单页语义（`src/damai/actions.ts` `GrabResult.status`）。
- **D6 安全护栏**：默认 `next start -H 127.0.0.1`；middleware token 必填（未配置 token 时拒绝非回环绑定）；
  CSP 用 Next 默认严格策略。反面教材：damaihelper（`0.0.0.0` + 无鉴权 + CORS `*`）、source-tickets（`csp: null`）。
- **D7 运行时与依赖隔离**：`web/package.json` engines 锁 `node >= 22`；core 的 engines（Bun/Node 双运行时）
  与零新增运行时依赖承诺不变；全部 web 依赖（含 Next 本体）隔离在 `web/`。
- **D8 框架无关逃生通道**：TaskManager、锁、schema 全部为纯 TS 模块，React/Next 只出现在 `app/` 壳层；
  回退轻量路线（附录 C）时平移面收敛于壳层。

## 6. 分阶段实施计划

### Phase 0 — 工程准备 ✅（2026-10-02 完成）

- [x] `pnpm-workspace.yaml`（`packages: [".", "web"]`）+ `web/` 脚手架（create-next-app：Next 16.3.8、TS、App Router、Tailwind 4、src 目录）
- [x] `web/tsconfig.json` paths 别名（`@core/* → ../src/*`）接通 core 源码；`next dev` 与 `next build`（Turbopack，`turbopack.root` 指向仓库根）均验证通过
- [x] `instrumentation.ts`（`NEXT_RUNTIME === "nodejs"` 守卫）+ TaskManager 骨架（`globalThis` 单例、start/cancel/whenSettled/list、deviceId 互斥、进度环形缓冲 500 行、cancel forceAfterMs → unresponsive 标注）+ 10 个 vitest 单测
- [x] `cli.ts` 新增 `web` 子命令：`--mode dev|start`（start 校验 `web/.next/BUILD_ID`）、默认 `-H 127.0.0.1`、token 自动生成打印并经 `DAMAI_WEB_TOKEN` 注入、非回环绑定警告
- [x] vitest 接入 `web/`（独立 `web/vitest.config.ts`，`src/**/*.test.ts`，与根配置互不干扰）
- **验收结果**：`next dev` 首页 200；鉴权链路全通（无 token 401 / x-web-token 200 / `/api/token` 换 Cookie 307 + Cookie 200）；instrumentation 日志恰好一次；鉴权文件采用 Next 16 新规范 `src/proxy.ts`（middleware.ts 已废弃）；`pnpm -C web build`（Turbopack）成功；根 typecheck 干净；core 测试 16 文件 274 用例全绿零影响。
- 实施备注：用户全局 npm 镜像（`~/.npmrc` → `npmregistry.getapk.cn`）超时，`web/.npmrc` 按仓库既有惯例指向官方 registry；create-next-app 生成的嵌套 `web/pnpm-workspace.yaml` 已并入根工作区配置。

### Phase 1 — MVP 骨架（设备 + 任务 + 进度）

- [ ] `src/schemas/`：任务参数共享 schema（设备/场次/档位/观演人/开票时间），与 MCP 参数语义对齐
- [ ] 设备页：RSC 快照 `DeviceManager.listDevices()` + Server Action `connect/disconnect`
- [ ] 任务页：Server Action `startTask/cancelTask` → TaskManager（启动 `damaiGrab`，登记 stopEvent/progressCb）；
  RHF 表单 + zod resolver；任务列表 TanStack Table
- [ ] `app/api/tasks/[id]/events/route.ts`：SSE（progressCb → 事件流，心跳注释行）
- [ ] 测试：TaskManager 互斥/取消单测；handlers 纯函数测试；关键组件 `@testing-library/react` 冒烟
- **验收**：`bun run src/cli.ts web` 后浏览器完成"选设备 → 填抢票参数 → 启动 → 看到真实进度 → 取消"；
  `pnpm test` 全绿；core diff 仅 `src/schemas/` 纯新增与 `cli.ts` 子命令。

### Phase 2 — 监控、通知与复盘

- [ ] 监控面板：`monitorAvailability` 任务化（interval/退避/起止时间），四态（available/not_on_sale/sold_out/unknown）可视化
- [ ] 通知页：ClawBot 绑定状态 + 测试发送（复用 `src/notify/wechat.ts`）
- [ ] 截图预览：`app/api/devices/[id]/screenshot/route.ts`（JPEG 轮询，no-store）+ 任务失败截图墙（`damai_shots/`）
- [ ] 日志页：pino 文件日志 tail → SSE；`@tanstack/react-virtual` 虚拟滚动
- [ ] 选择器调试器页：dump_ui 树查看 + find_text 试查（改版自救）
- **验收**：模拟器上监控状态变化实时上屏；通知测试发送送达；改版演练中通过调试器页定位新选择器文本。

### Phase 3 — 体验与演进（按需）

- [ ] 任务持久化（better-sqlite3 / node:sqlite，重启标记 interrupted，D4 lockfile 跨进程互斥一并落地）
- [ ] 远程访问强化：若显式 `--host` 放开绑定，强制 token + 文档化内网风险与反代建议
- [ ] AI 对话面板（R2 的天然收益项）：Vercel AI SDK 流式对接 MCP 工具，驱动 30+ 个 `damai__*` 工具
- **验收**：进程重启后任务状态可追溯；AI 面板可流式完成一次"查设备 → 查详情"链路。

## 7. 风险清单与缓解

| 风险 | 缓解 |
|---|---|
| `next start` 默认绑定 `0.0.0.0` | `cli.ts web` 强制 `-H 127.0.0.1`；无 token 拒绝非回环绑定（D6） |
| dev HMR 打断 DeviceManager 单例 / 运行中任务 | `globalThis` 单例（D3）；文档标注"改 core 代码需重启 web"；生产无此问题 |
| Turbopack 编译 core TS 源（仓库外路径 alias）在 build 下的边界情况 | Phase 0 即验证 `next build`；不通过则回退 `transpilePackages` + core `exports` 指向源码（core package.json 加一个 exports 字段） |
| Next 大版本迁移频繁（App Router 历史破坏性变更多） | 锁 16.x；CI 跑 Playwright 冒烟后再升级 |
| MCP 与 web 跨进程并发操作同一设备 | UI 常驻警示 + 文档；v2 lockfile（D4） |
| 内存任务重启即丢 | Phase 3 持久化；此前在 UI 明示"重启即丢" |
| 体积与 Node-only | web 为可选工作区安装；core 承诺不变（D7） |
| 支付边界被 UI 绕过 | D5：无自动支付端点；"确认提交"走 needs_action 语义 |

## 8. 附录 A：本方案被否决/搁置的子选项备忘

- **WebSocket**：Route Handler 原生不支持，自定义 server 成本 > 收益；截图轮询 + SSE 覆盖 v1/v2 全部需求。
- **Next 静态导出（`output: 'export'`）**：丢失 Server Actions/Route Handlers 的服务端能力，退化为更重的 SPA 构建器，不取。
- **Vercel/Serverless 部署**：`child_process` + adb + 本地设备决定只能自托管（`next start` / standalone），任何 Serverless 形态不可行。

## 9. 附录 B：外部参考（2026-10 联网核实）

- Next.js 16 发布博客（Turbopack 默认化）：https://nextjs.org/blog/next-16
- Turbopack API Reference：https://nextjs.org/docs/app/api-reference/turbopack
- instrumentation.ts 稳定化：https://jsmanifest.com/nextjs-16-instrumentation-stable
- Next.js Self-Hosting 指南：https://nextjs.org/docs/app/guides/self-hosting
- Tailwind CSS 官方 Next.js 指南：https://tailwindcss.com/docs/guides/nextjs
- shadcn/ui 对 Tailwind v4 + React 19 的官方适配：https://ui.shadcn.com/docs/tailwind-v4
- 备选路线参考（Hono 生态）：https://github.com/honojs/node-server 、https://hono.dev/docs/helpers/websocket

## 10. 附录 C：搁置的轻量备选路线（Hono + rsbuild SPA）存档摘要

若未来触发"只要本机单用户面板且在意体积/双运行时"的条件，可切换至：

- 后端：Hono + `@hono/node-server`（`app.request()` 可在 vitest 纯函数级测路由）+ `@hono/zod-validator` + `streamSSE` + `serveStatic`；
- 前端：rsbuild + `@rsbuild/plugin-react` + `@rsbuild/plugin-tailwindcss`（Rsbuild 2.1+，TW4 官方首选）+ React 19 + shadcn/ui + TanStack Query/Table/virtual + RHF + react-router v7；
- 优势：Bun/Node 双运行时、交付体积小；劣势：无 RSC/Server Actions 类型安全、AI 面板生态弱。
- 迁移面（按 D8）：TaskManager / `src/schemas/` / 锁逻辑原样平移，仅重写 `app/` 壳层与 Server Actions → REST 端点。
