# Web 控制台 Phase 2+3 设计：monitor / notify / screenshots / logs / probe / persistence / remote / ai-chat

状态：设计定稿（供八位实现者并行开发，文件所有权互斥）。
日期：2026-10-03。
上游：[`docs/plans/web-console-plan.md`](plans/web-console-plan.md)（Phase 0/1 已完成）。
本文所有 `path:line` 均为 2026-10-03 实读源码核对结果；`ai`/`better-sqlite3` 等版本号实测自 `node_modules/*/package.json`。

---

## 0. 共同约束（所有八项必须遵守）

1. **文件所有权互斥**（实现者不得越界；需要共享逻辑就写进该项自己的新文件）：

   | 项 | 独占文件 |
   |---|---|
   | monitor | `web/src/task/monitorRunner.ts`(+`.test.ts`)、`web/src/app/monitor/**` |
   | notify | `web/src/app/notify/**` |
   | screenshots | `web/src/app/api/devices/[id]/screenshot/route.ts`、`web/src/app/screenshots/**`、`web/src/lib/paths.ts`(+测试) |
   | logs | `web/src/instrumentation.ts`、`web/src/lib/logPaths.ts`、`web/src/app/api/logs/tail/route.ts`、`web/src/app/logs/**` |
   | probe | `web/src/app/probe/**`、`web/src/app/api/probe/**`（设计决定：不建 HTTP 端点，全部走 Server Action） |
   | persistence | `web/src/task/manager.ts`、`web/src/task/manager.test.ts`、`web/src/task/persistence.ts`(+测试)、`web/src/task/lockfile.ts`(+测试)、`web/data/.gitkeep` |
   | remote | `src/cli.ts`（唯一允许改动的 core 文件）、`docs/web-console-remote.md`、`tests/test_cli_web.test.ts`（新增） |
   | ai-chat | `web/src/app/ai/**`、`web/src/app/api/ai/**`、`web/src/lib/aiConfig.ts`、`web/src/lib/aiTools.ts` |

2. **依赖全部预装，禁止 `pnpm add/install`**：`better-sqlite3@13.0.3`、`ai@7.0.127`、`@ai-sdk/react@4.0.130`、`@ai-sdk/openai-compatible@3.0.62`、`@tanstack/react-virtual@3.14.13`、`@types/better-sqlite3@9.6.0`（`web/package.json:13-32` 实测）。
3. **core 源码一行不改**（remote 项的 `src/cli.ts` 除外）；不改 `server.ts` / MCP 工具；core 的 `pnpm-workspace` 拓扑不动。
4. **鉴权自动覆盖**：Next 16 规范 `web/src/proxy.ts:36-40` 的 matcher `["/((?!_next/static|_next/image|favicon.ico|api/token).*)"]` 已覆盖一切新增路由（SSE tail、截图、AI chat、settings），**各新路由不得自行实现鉴权**。token 取 `x-web-token` 头或 `damai_web_token` Cookie（`proxy.ts:16-18`）；Cookie 由 `GET /api/token?token=…` 下发（`web/src/app/api/token/route.ts:11-27`，httpOnly + sameSite=strict + path=/，30 天）。浏览器 `EventSource` 对同源请求默认携带 Cookie（含 httpOnly；`withCredentials` 仅跨域需要——此为 EventSource 规范行为，本机未跑浏览器实测，Phase 1 的任务 SSE 已按此工作）。
5. **SSE 路由骨架**（复用 `web/src/app/api/tasks/[id]/events/route.ts:29-105` 的既有模式）：`export const dynamic = "force-dynamic"`（:3）、`ReadableStream` + `closed` 标志（:30-33）、15s 心跳 `: heartbeat`（:80-86）、`req.signal.addEventListener("abort", close)` 清理（:103）、响应头 `Cache-Control: no-store, no-transform`（:110）。
6. **Server Action 模式**：`actionClient.schema(zod).action(...)`（`web/src/lib/safe-action.ts:10-12`），业务错误以中文 message 透出为 `result.serverError`；RSC 快照页 `export const dynamic = "force-dynamic"`（如 `web/src/app/devices/page.tsx:6`）。
7. **测试约定**（`web/vitest.config.ts:5-14`）：environment=node、`include=["src/**/*.test.{ts,tsx}"]`、testTimeout=15000、alias `@→src`、`@core→../src`；组件测试文件级 `// @vitest-environment jsdom` + `afterEach(cleanup)`（`TaskTable.test.tsx:1` 先例）；Route Handler 按 `(Request) → Response` 纯函数直测、不起服务。定点自测命令：`pnpm -C web exec vitest run <文件>`；全量门禁 = 根 typecheck + core test + web test + web build。
8. **风格**：TypeScript strict；错误信息与 TSDoc 中文；D5 硬约束（不自动支付、web 不传 `confirmOrder`）与 D3（长任务不进请求生命周期）继续有效。

---

## 1. persistence —— 任务持久化（better-sqlite3）+ D4 lockfile

### 1.1 目标
任务状态跨进程重启可追溯；进程启动时把遗留 `running/cancelling` 标记为 `interrupted`；多 web 进程并发操作同一设备时以仓库根 `.damai-web.lock` 提供跨进程互斥。**硬约束：`web/src/task/manager.ts` 对外 API 与既有签名完全兼容，`manager.test.ts` 既有用例零改动全过。**

### 1.2 `web/src/task/persistence.ts`（新）

```ts
/** 任务存储最小接口（manager 只依赖此接口，不感知 sqlite）。 */
export interface TaskStore {
  /** 任务状态/快照任何变化时整体覆盖写（按主键 id）。 */
  upsert(snapshot: TaskSnapshot): void;
  /** 启动恢复：读全部历史行（进度只回放尾部 ≤500 行，与内存环形缓冲同语义）。 */
  loadAll(): TaskSnapshot[];
  /** 进程退出钩子；实现方必须幂等。 */
  close(): void;
}

/**
 * better-sqlite3 落盘存储。惰性初始化：Database 在首次 upsert/loadAll 时才打开，
 * 构造与导入零副作用（保证 getTaskManager() 单例测试不产生文件）。
 * open 失败（文件损坏/权限）→ 降级为 no-op 存储 + console.error 中文告警，绝不阻断任务运行。
 */
export function createSqliteTaskStore(dbPath: string): TaskStore;
```

- 表结构（建表 `CREATE TABLE IF NOT EXISTS`，`db.pragma("journal_mode = WAL")`）：

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,      -- grab | monitor | custom
  device_id         TEXT NOT NULL,
  label             TEXT NOT NULL,
  status            TEXT NOT NULL,      -- running/cancelling/cancelled/succeeded/failed/interrupted
  started_at_unix_ms INTEGER NOT NULL,
  ended_at_unix_ms  INTEGER,
  unresponsive      INTEGER NOT NULL DEFAULT 0,
  error             TEXT,
  result            TEXT,               -- JSON（TaskSnapshot.result）
  progress_total    INTEGER NOT NULL DEFAULT 0,
  progress_tail     TEXT                -- JSON string[]，尾部 ≤500 行
);
```

- upsert 在写库异常时吞掉（`try { ... } catch (exc) { console.error(...) }`）——持久化失败绝不拖垮任务本身（对齐 TaskManager 订阅者容错语义，`manager.ts:261-267`）。
- `web/data/` 目前不存在（实测 `ls web/data` → No such file）——persistence 项新建 `web/data/.gitkeep`。db 路径解析（persistence 项自持，放在 `persistence.ts` 内导出）：

```ts
/** 默认 <cwd>/data/tasks.db（cli 拓扑下 cli.ts:585-586 以 web/ 为 cwd ⇒ web/data/tasks.db）。 */
export function resolveTaskDbPath(): string {
  return process.env.DAMAI_WEB_TASK_DB ?? join(process.cwd(), "data", "tasks.db");
}
```

### 1.3 `web/src/task/lockfile.ts`（新，D4）

```ts
export interface DeviceLockRecord {
  deviceId: string; taskId: string; pid: number; heldAtUnixMs: number;
}
export interface DeviceLockfileDeps {
  /** 默认 process.kill(pid, 0) 探活；测试注入。 */
  isPidAlive?: (pid: number) => boolean;
  now?: () => number;
  /** 持有时长超过该值视为过期，默认 10 分钟。 */
  staleAfterMs?: number;
}
export class DeviceLockfile {
  constructor(lockPath: string, deps?: DeviceLockfileDeps);
  /**
   * 先清理全部过期条目（pid 不存活 或 now-heldAt > staleAfterMs），
   * 再尝试占用 deviceId：被其他存活进程持有 → 抛 TaskConflictError(deviceId, holder.taskId)；
   * 成功 → 原子写入本条目。文件损坏（非法 JSON）→ 视为无锁并重写 + 告警。
   */
  acquire(deviceId: string, taskId: string): void;
  /** 幂等释放：仅当条目 taskId 匹配才移除。 */
  release(deviceId: string, taskId: string): void;
}
```

- 写入方式对齐 core 凭证存储的原子写先例（`src/notify/credentials.ts:102-122`）：`<file>.tmp.<pid>` 以 0o600 创建 → `rename` 原子替换 → `chmod 0o600`。
- 锁路径：`process.env.DAMAI_WEB_LOCK_FILE ?? resolve(process.cwd(), "..", ".damai-web.lock")`（cwd=web/ ⇒ 仓库根 `.damai-web.lock`），在 `lockfile.ts` 内导出 `resolveLockfilePath(): string`。
- **已知边界（如实标注）**：MCP 进程不写此锁（core 不改），该锁只防「多个 web 进程」之间同设备并发；web 与 MCP 的跨进程冲突仍按计划 D4 以 UI 常驻警示 + 文档缓解。

### 1.4 `web/src/task/manager.ts`（唯一既有改动点）

- `TaskStatus` 联合类型**追加** `"interrupted"`（additive；既有用例不产出该状态，零改动通过）。
- 构造函数加**可选**依赖注入，默认全关（既有 10 用例全部 `new TaskManager()` 直构 ⇒ 行为逐字不变）：

```ts
export interface TaskManagerDeps {
  store?: TaskStore | null;      // 缺省 = 不持久化
  lockfile?: DeviceLockfile | null; // 缺省 = 不跨进程锁
}
constructor(deps?: TaskManagerDeps)
```

- 接线点：
  - `start()`（`manager.ts:113-142`）：内存冲突检查后 `this.lockfile?.acquire(deviceId, id)`（跨进程冲突复用 `TaskConflictError`，UI 语义不变）；创建 entry 后 `this.store?.upsert(snapshot(entry))`。
  - `cancel()`（`manager.ts:154-163`）：置 `cancelling` 后 upsert。
  - `run()` finally（`manager.ts:237-251`）：终态 upsert + `lockfile?.release(deviceId, id)`（先于 settle waiters 唤醒）。
- **启动恢复**（构造函数内，仅当 `store` 存在）：`loadAll()` 逐行重建为只读历史 entry——原 `running/cancelling` 行改标 `"interrupted"`、`endedAtUnixMs ??= Date.now()`（保证 `whenSettled` 对其立即 resolve）；**不**登记 deviceLocks、不挂 stopEvent/订阅者；`progress/progressTotal` 从 `progress_tail/progress_total` 恢复（SSE backlog 可看历史行）。
- `getTaskManager()`（`manager.ts:291-300`）：改为 `new TaskManager({ store: createSqliteTaskStore(resolveTaskDbPath()), lockfile: new DeviceLockfile(resolveLockfilePath()) })`。两者均惰性打开 ⇒ 既有用例 `getTaskManager 返回 globalThis 单例`（`manager.test.ts:42-44`，仅比对身份）不触发任何文件创建。

### 1.5 测试计划（persistence 项）

- `persistence.test.ts`（tmp 目录）：upsert/loadAll 往返（含 result JSON 与 progress_tail 截断到 500）；损坏 JSON 存储文件 → 降级 no-op 不抛。
- `lockfile.test.ts`（tmp 目录 + 注入 `isPidAlive`/`now`）：①锁竞争——A 占用后 B 同设备 acquire 抛 `TaskConflictError`（error 含 A 的 taskId），不同设备互不影响；②过期清理——持锁 pid 存活但 heldAt 超 10 分钟 → 清理后可占用；pid 已死 → 同；③损坏文件容错——写入 `not-json` 后 acquire 成功且文件被重写；④release 幂等、他人条目不误删。
- `manager.test.ts` **追加**用例（既有 10 例零改动）：`new TaskManager({ store: createSqliteTaskStore(tmp/tasks.db) })` 跑完 start/cancel/终态后重新 loadAll 断言状态序列；构造时注入含 `running` 行的 store → `list()` 出 `interrupted`、`endedAtUnixMs` 非空、`lockedDeviceIds()` 为空。
- 门禁命令（实现者自测）：`pnpm -C web exec vitest run src/task/manager.test.ts src/task/persistence.test.ts src/task/lockfile.test.ts`。

---

## 2. remote —— cli web 子命令安全强化 + 远程访问文档

### 2.1 目标
`--host` 放开到非回环地址时，若 token 是自动生成（调用方未显式给 `--token`），**拒绝启动**；显式给 token 时打印多行风险横幅；新增反代/HTTPS/防火墙文档。

### 2.2 `src/cli.ts` 改动（`cmdWeb`，现 `cli.ts:554-605`）

- 签名不变：`cmdWeb(mode, host, port, token?)`——`token === undefined` 即「未显式提供」（调用点 `cli.ts:126` 原样透传 commander 的 `--token` 选项，`cli.ts:121`）。
- 新增导出纯函数（cli.ts 现无任何测试钩子；`invokedDirectly` 守卫 `cli.ts:609-617` 保证 import 安全）：

```ts
/**
 * web 绑定安全闸（D6）：回环地址直接放行并返回 true；
 * 非回环 + 未显式提供 token → 抛中文 Error 拒绝启动；
 * 非回环 + 显式 token → 打印风险横幅并返回 false。
 */
export function assertWebBinding(host: string, hasExplicitToken: boolean): boolean
```

- `cmdWeb` 开头调用 `const loopback = assertWebBinding(host, token !== undefined);`，替换现 `:572-578` 的「自动生成 + 仅 warning」逻辑。
- 拒绝文案（示例措辞，实现时可润色但要点必须齐）：`拒绝启动：绑定非回环地址 ${host} 时必须显式提供 --token。自动生成 token + 内网暴露属高危组合——局域网内任何拿到 token 的人都能操控你的手机/模拟器。请改用默认 127.0.0.1，或 --token <自定义高熵token> 并阅读 docs/web-console-remote.md。`
- 横幅（`logger.warning` 多行）：①当前绑定 `${host}:${port}` 对内网可见；②持有 token 者可完全操控设备（dump/截图/抢票流程）；③自动支付边界不因网络而改变但设备仍可被操纵；④建议：反向代理 + HTTPS + 防火墙白名单；⑤详见 `docs/web-console-remote.md`。

### 2.3 `docs/web-console-remote.md`（新）大纲

1. 威胁模型与默认姿态（127.0.0.1 + 强制 token，`cli.ts:585-588` 注入 `DAMAI_WEB_TOKEN`）。
2. 鉴权机制：`proxy.ts` matcher 覆盖面、`x-web-token` 头 / Cookie（`/api/token?token=` 换取，httpOnly+sameSite=strict）、无 `DAMAI_WEB_TOKEN` 时的 dev 放行行为及其风险。
3. 非回环绑定规则：显式 `--token` 强制 + 风险横幅语义。
4. 反向代理建议：TLS 终结（Caddy/Nginx 示例段）；**SSE 三个流式端点**（`/api/tasks/[id]/events`、`/api/logs/tail`、`/api/ai/chat`）必须 `proxy_buffering off` / `X-Accel-Buffering no`，15s 心跳已内置（`events/route.ts:80-86`）；不要在反代层缓存 `no-store` 响应。
5. 防火墙建议：首选「保持 127.0.0.1 + SSH 隧道」；确需内网/公网时仅放行可信源 IP，禁用 0.0.0.0 全网段。
6. 凭证卫生：`DAMAI_WEB_TOKEN` 不入库不外传；`web/data/ai-settings.json`（0600）与 `~/.config/damai-mcp-ts/notify.json`（0600）不要提交仓库。
7. 已知边界：MCP 进程（stdio）不受 web token 保护；web lockfile 不覆盖 MCP 并发（见 §1.3）。

### 2.4 测试计划（remote 项）

- `tests/test_cli_web.test.ts`（新，根 vitest `include=tests/**/*.test.ts` 实测适用）：import `{ assertWebBinding }` from `@/cli`（cli.ts 顶层仅注册函数，直接运行才 `main()`）——①`("127.0.0.1", false)` 与 `("localhost", true)` 不抛且返回 true；②`("0.0.0.0", false)` 抛中文 Error（信息含「--token」）；③`("192.168.1.5", true)` 不抛返回 false。
- 现有 core 测试 16 文件不受影响（cli.ts 无既有测试文件，实测 `ls tests/`）。

---

## 3. monitor —— 监控面板（monitorAvailability 任务化 + 四态徽标）

### 3.1 `web/src/task/monitorRunner.ts`（新）

```ts
export interface MonitorRunnerInput {
  deviceId: string;
  itemId: string;
  intervalMs: number;              // 表单 zod 已限 5000-3600000（同 server.ts:970）
  maxAttempts: number;             // 接线层必须给有限值（monitor.ts:153-155 TSDoc 明示）；web 默认 720
  maxConsecutiveErrors?: number;   // 默认 5（MONITOR_MAX_CONSECUTIVE_ERRORS）
  openPage?: boolean;              // 默认 true（深链打开详情页，属导航非点击）
  startAtUnixMs?: number | null;   // 起始时刻；null/过去 = 立即
  deadlineUnixMs?: number | null;  // 截止时刻（墙钟）
}
export function makeMonitorRunner(
  input: MonitorRunnerInput,
  deps?: { monitor?: typeof monitorAvailability }, // 测试注入点（@core/damai/monitor）
): TaskRunner;

/** 从进度行解析监控快照（徽标渲染用）；非采样行返回 null。 */
export function parseMonitorProgressLine(
  line: string,
): { attempt: number; status: "available" | "not_on_sale" | "sold_out" | "unknown" } | null;
```

- 执行体行为：
  1. `startAtUnixMs` 在未来 → 候场：`Promise.race([stopEvent.wait(), sleep(delay)])`，`onProgress("候场至 HH:mm，到点开始采样")`；被取消直接 return（status 收敛 cancelled）。
  2. 调 `monitorAvailability(deviceId, itemId, { intervalMs, maxAttempts, maxConsecutiveErrors, openPage, deadlineUnixMs, stopEvent, onReport })`——`SimpleStopEvent` 结构兼容 monitor 的 `{isSet(): boolean}`（`monitor.ts:165`，`stopEvent.ts:4-7` 注释已固化该承诺）。
  3. `onReport` → `onProgress(\`第 ${attempt} 次采样: ${status}${reason ? `（${reason}）` : ""}${nextDelayMs ? `，${Math.round(nextDelayMs/1000)}s 后继续` : ""}\`)`——与 MCP 工具 `server.ts:997-1003` 文案同构；行首格式固定（`第 <n> 次采样: <status>`），`parseMonitorProgressLine` 依赖该稳定性。
  4. 结束行 `监控结束 stop_reason=… attempts=… final_status=…`；返回 `result.toDict()`（全 snake_case，`monitor.ts:238-260`）存入 TaskSnapshot.result。

### 3.2 `web/src/app/monitor/`（新页面组）

- `actions.ts`：

```ts
export const monitorTaskInputSchema = z.object({
  deviceId: z.string().min(1),
  itemId: z.string().min(1),
  intervalMs: z.number().int().min(5000).max(3600000).default(30000),
  // web 接线层不给无限：min(1)（区别于 MCP 工具的 min(0)，server.ts:972）
  maxAttempts: z.number().int().min(1).max(100000).default(720),
  startAt: z.string().optional(),  // datetime-local 值；空 = 立即；action 内转 startAtUnixMs
  endAt: z.string().optional(),    // 空 = 不设截止；转 deadlineUnixMs
});
export const startMonitorTask = actionClient.schema(monitorTaskInputSchema)
  .action(async ({ parsedInput }) => {
    const snap = getTaskManager().start({
      kind: "monitor",                       // TaskKind 已含 monitor（manager.ts:21）⇒ deviceId 互斥 + SSE 免费获得
      deviceId: parsedInput.deviceId,
      label: `监控 ${parsedInput.itemId} @ ${parsedInput.deviceId}`,
      runner: makeMonitorRunner({ ...parsedInput, /* 时刻转换 */ }),
    });
    revalidatePath("/monitor");
    return { taskId: snap.id, status: snap.status };
  });
```

  取消复用 `@/app/tasks/actions` 的既有 `cancelTask`（`tasks/actions.ts:27-35`），不重复实现。
- `page.tsx`（RSC，`dynamic = "force-dynamic"`）：设备下拉数据 `DeviceManager.shared().listDevices(true)`（容错空数组，同 `devices/page.tsx:12-16`）+ `MonitorForm` + 历史任务列表（`getTaskManager().list().filter(t => t.kind === "monitor")` 初始快照）。
- `MonitorForm.tsx`（RHF + zodResolver，与任务页 `TaskForm.tsx` 同构）：interval（秒输入，提交×1000）、起止时间（`datetime-local`，可空）、场次 itemId、设备、openPage 开关。
- `StatusBadge.tsx`：四态徽标 available=绿 / not_on_sale=蓝 / sold_out=红 / unknown=灰；任务态 running 旋转、cancelling 黄、unresponsive 紫虚线、cancelled/succeeded/failed 常规终态色。
- `MonitorTaskList.tsx`（client，1.5s TanStack Query 轮询 `GET /api/tasks`（`web/src/app/api/tasks/route.ts:9-16`）过滤 monitor + 运行中任务订阅既有 SSE `/api/tasks/[id]/events`）：徽标数据来源 = **终局取 `result.final_status`**（`MonitorResult.toDict`），**运行中取 SSE 最后一条可被 `parseMonitorProgressLine` 解析的行**。`found=true` 时渲染 `result.detail_url` 外链（MONITOR_DETAIL_URL_TEMPLATE，`monitor.ts:32-33`）。

### 3.3 测试计划（monitor 项）

- `monitorRunner.test.ts`（注入 fake monitor）：
  1. fake 依脚本发 3 次 `onReport` → 收集 `onProgress` 行全部可被 `parseMonitorProgressLine` 解析回 {attempt,status}；
  2. 透传断言：fake 收到的 options 与 input 一致（intervalMs/maxAttempts/deadlineUnixMs/stopEvent 非 null）；
  3. 返回值等于 fake MonitorResult.toDict 形状（found/final_status/attempts/stop_reason/detail_url/…）；
  4. `startAt` 在未来时启动 → 候场行出现；cancel 后任务在候场内快速收敛 cancelled（不调 monitor）；
  5. `parseMonitorProgressLine` 对非采样行（阶段行/结束行）返回 null。
- schema 直测：intervalMs=4999 / maxAttempts=0 / 非法 startAt → parse 抛。
- 命令：`pnpm -C web exec vitest run src/task/monitorRunner.test.ts`。

---

## 4. notify —— 通知页（配置完整性检查 + 测试发送 + 绑定指引）

### 4.1 定位（技术决策 4）
core `ClawBotClient` 公开 API **只有** `constructor(config, transport?) + sendText(target, contextToken, text, options?) → SendOutcome`（`src/notify/wechat.ts:217,260`），无二维码绑定/状态查询协议（模块头 `wechat.ts:5-7` 明确排除）⇒ 页面定位为**配置完整性检查 + 测试发送 + 绑定指引**，不新增协议实现。

### 4.2 `web/src/app/notify/page.tsx`（RSC）

- 组装三字段状态（origin / token / context_token），来源回落顺序与 MCP 工具一致（`server.ts:1044-1046`）后扩展文件回落：**env（`DAMAI_CLAWBOT_ORIGIN/TOKEN/CONTEXT_TOKEN`）> `loadNotifyCredentials()`（`src/notify/credentials.ts:140`，缺失/损坏返回 null 不抛）> none**。
- origin 非敏感完整显示；token/context_token 用 `redactToken` 掩码（`credentials.ts:204`，`ab****yz` / `***`）。
- 每字段渲染 `已配置（来源：环境变量/本地凭证文件）` 或 `未配置`；三字段齐 → 绿色「可以发送」。
- **绑定指引**（`<details>` 静态文案）：ClawBot 后台获取三要素 → 设 env 或手动放置 `~/.config/damai-mcp-ts/notify.json`（0600）；明确写出「本页面不保存凭证、不实现绑定协议」。

### 4.3 `web/src/app/notify/actions.ts`

```ts
export const sendTestSchema = z.object({
  target: z.string().min(1),
  text: z.string().min(1).max(2000).optional(),   // 缺省 = 固定测试文案
  // 高级折叠区：未落盘凭证时手填；均可空 = 用已配置凭证
  origin: z.string().url().optional(),
  token: z.string().min(1).optional(),
  contextToken: z.string().min(1).optional(),
});
export const sendTestNotification = actionClient.schema(sendTestSchema).action(...)
```

- 行为：凭证 = 手填 ?? env ?? 文件；缺项 → `result.serverError` 中文缺项清单（如「缺少 token：请设置 DAMAI_CLAWBOT_TOKEN 或在下方填写」）。
- 发送：`new ClawBotClient({ origin, token, timeoutMs: 10_000 }, transport?).sendText(target, contextToken, text)`；**sendText 失败返回 SendOutcome 而非抛错**（`wechat.ts:203-215`），origin 非法/参数校验失败由 constructor/前置校验抛中文错（`wechat.ts:230-236,266-284`）走 serverError。
- 返回 `{ status, clientId, error, httpStatus, elapsedMs, hint }`，`hint` 由导出纯函数 `describeSendOutcome(o: SendOutcome): string` 生成（sent=已送达 / failed=发送失败 / expired=会话过期需重新绑定 / timeout_unknown=超时未知，如需重试请携带 clientId 重发——幂等去重语义 `wechat.ts:249-255`）。
- 安全：服务端永不回传完整 token；不调用 `saveNotifyCredentials`（web 不写凭证文件）；本模块不打含 token 的日志。

### 4.4 组件

- `NotifyStatusCard.tsx`（服务端数据 props 展示）、`SendTestForm.tsx`（useActionState；结果卡展示 SendOutcome 五字段 + hint）。

### 4.5 测试计划（notify 项）

- `notify/actions.test.ts`：
  1. schema：缺 target 拒绝；超长 text 拒绝。
  2. `sendTestNotification` 注入 fake transport（`ClawBotTransport = (req: ClawBotRequest) => Promise<ClawBotResponse>`，`wechat.ts:103` 导出；fake 返回成功响应）→ `outcome.status === "sent"` 且请求载荷参数正确。
  3. 缺凭证（清空相关 env + `setNotifyCredentialsDirForTests(tmp空目录)`，`credentials.ts:72`）→ serverError 同时点名三要素。
  4. 结果对象不含完整 token（JSON.stringify 断言无 token 原文，只有掩码）。
- `describeSendOutcome` 四分支纯函数用例。
- 真实 ClawBot 送达验证属 live 冒烟，留待用户持有凭证时执行（本机无凭证，如实标注不跑）。

---

## 5. screenshots —— 截图端点（JPEG/no-store）+ 截图墙

### 5.1 `web/src/lib/paths.ts`（新）

```ts
export interface ShotsDirResolution {
  dir: string;
  source: "env" | "repoRoot" | "webCwd";
}
/**
 * damai_shots 目录解析（顺序固定，技术决策 3）：
 * 1. env DAMAI_WEB_SHOTS_DIR；
 * 2. 仓库根/damai_shots（从仓库根跑 MCP/CLI 的落点，src/damai/actions.ts:232-235 相对 cwd）；
 * 3. web/damai_shots（cli 拓扑下 cli.ts:585-586 以 web/ 为 cwd 的实际落点——历史兼容）。
 * 返回第一个【存在】的候选；都不存在 → null（页面空态）。
 * 仓库根 = resolve(process.cwd(), "..")（cwd 恒为 web/：cli 拓扑与 pnpm -C web 均如此），
 * 测试经参数注入 cwd/env，不依赖真实环境。
 */
export function resolveShotsDir(
  base?: { cwd?: string; env?: Record<string, string | undefined> },
): ShotsDirResolution | null;
/** 列出三个候选及其存在性（空态提示与测试用）。 */
export function shotsDirCandidates(base?: ...): Array<{ dir: string; source: ...; exists: boolean }>;
```

### 5.2 `web/src/app/api/devices/[id]/screenshot/route.ts`（新）

```ts
export const dynamic = "force-dynamic";
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response>
```

- 取 `id` → `screenshot(id, undefined, { returnBase64: false, maxSize: [720, 1280] })`（`src/actions/actions.ts:347-384`；**core 返回 PNG 字节**（`screencap -p`，`:365`），技术决策 3 要求 JPEG 响应 ⇒ 用 jimp（core 已依赖 1.6.1，`next.config.ts:14` 已 serverExternal；core 用法先例 `actions.ts:319,335`）转码：`Jimp.read(pngBytes)` → `img.getBuffer("image/jpeg")`（默认质量）。
- 成功：`new Response(bytes, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" } })`。
- 失败映射：`ADBError` → 502 `{ error: 中文 }`（含 core retry 2 次耗尽语义，`actions.ts:347-354`）；其余异常 → 500；空 id → 400。路由不写 404（设备不在线由 ADB 错误自然表达）。
- 前端轮询 `<img src="/api/devices/${id}/screenshot?t=${Date.now()}" />`（时间戳防缓存，配合 no-store）。

### 5.3 `web/src/app/screenshots/`（新截图墙）

- `page.tsx`（RSC）：`resolveShotsDir()` → null 时空态文案（「未找到 damai_shots 目录；抢票失败截图（open_fail_*/no_buy_btn_*/ready_for_human_*/grab_fail_* 等，`src/damai/actions.ts:726-1092` 落点）出现后自动显示」）；有目录 → `readdir` 过滤 `/\.png$/i` 按 mtime 倒序、cap 200 张，渲染网格（文件名 + mtime + 尺寸留空）。
- `file/[name]/route.ts`（`app/screenshots/**` 所有权内的新 Route Handler）：`GET` 供给墙内 `<img>`——`name` 必须匹配 `/^[\w.-]+\.png$/i` 且 `basename(name) === name`（拒绝路径穿越）；`new Response(bytes, { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } })`；文件消失 → 404。

### 5.4 测试计划（screenshots 项）

- `paths.test.ts`（tmp 树）：①env 命中优先；②env 未命中回落 repoRoot；③仅 webCwd 存在时选 webCwd；④三者均不存在 → null；⑤候选清单存在性标注正确。
- `screenshot/route.test.ts`：`vi.mock("@core/actions/actions")` 替换 screenshot 返回固定 PNG Buffer → 断言 200 + `image/jpeg` + `no-store`；mock 抛 ADBError → 502 + 中文 error；空 id → 400（纯函数直测，不起服务，对齐 `events/route.test.ts` 先例）。
- `file/[name]/route.test.ts`：合法名 200 / `..%2F` 与子目录名 400 / 不存在 404。
- 真机截图联调留待模拟器（本机无 adb，如实标注）。

---

## 6. logs —— core 日志落盘接入 + tail SSE + 虚拟滚动

### 6.1 `web/src/lib/logPaths.ts`（新）

```ts
/** 日志目录解析：env DAMAI_WEB_LOG_DIR > 仓库根 logs/（resolve(cwd,"..","logs")）。 */
export function resolveLogDir(base?: { cwd?: string; env?: Record<string, string|undefined> }): string;
/** pino-roll 落盘文件名规则（src/utils/logging.ts:252-259 定基名+日期段；
 *  pino-roll@4.0.0 lib/utils.js:93-97 实读确认拼接：`${基名}.${yyyyMMdd}.${轮转序号}`，
 *  首个文件序号为 1（utils.js:137-158 detectLastNumber 无文件时返回 1）⇒
 *  形如 damai_mcp.20261003.1，20MB 轮转 +1，跨天换日期段。 */
export const LOG_FILE_RE = /^damai_mcp\.(\d{8})\.(\d+)$/;
/** 返回目录内按 (日期段, 序号) 最大的当前日志文件；目录/无匹配 → null。 */
export function resolveCurrentLogFile(dir?: string): string | null;
```

### 6.2 `web/src/instrumentation.ts` 改动（logs 项独占该文件）

`register()` 在 `NEXT_RUNTIME === "nodejs"` 守卫与 `__damaiWebBooted` 守卫之后（现 `:10-17`）、TaskManager 初始化之前：

```ts
try {
  const { configure } = await import("@core/utils/logging");
  const { resolveLogDir } = await import("./lib/logPaths");
  await configure("INFO", resolveLogDir()); // 幂等（logging.ts:227 TSDoc）；logDir 非 null 启用 pino-roll 文件沉降
} catch (exc) {
  console.warn("[web] 日志文件沉降启用失败（不影响运行）:", exc);
}
```

- 事实依据：`configure(level="INFO", logDir)`（`logging.ts:232-266`）幂等；logDir 非 null 时 `mkdir -p` + pino-roll 基名 `join(logDir,"damai_mcp")`、daily + `dateFormat yyyyMMdd`、20MB、保留 7 个（`:252-259`）。pino/pino-roll 已在 `next.config.ts:14` serverExternalPackages，require 不打包。全局 logger 未 configure 也工作（仅 stderr，`logging.ts:220-222`）。
- 动态 import 放入 try/catch：日志配置失败绝不阻断启动。

### 6.3 `web/src/app/api/logs/tail/route.ts`（新）

```ts
export const dynamic = "force-dynamic";
export async function GET(req: Request): Promise<Response>
/** 供测试直调（events/route.ts 直测先例）；GET 内部薄封装。 */
export function buildLogTailStream(opts: {
  dir: string; maxLines?: number /* 默认 500，cap 5000 */; pollMs?: number /* 默认 1000；测试可传 15 */;
}): ReadableStream<Uint8Array>
```

- SSE 协议（技术决策 2，复用 events 骨架 `events/route.ts:29-105`）：
  - `event: log` `data: {"line":"…"}`——一行一条（含历史 tail 与增量）；
  - 心跳 `: heartbeat` 每 15s；`req.signal` abort 清理 interval/reader；`Cache-Control: no-store, no-transform`。
- 行为：
  1. 初始 backlog：`resolveCurrentLogFile(dir)` → null（目录/文件未创建）则发一条系统行 `—— 日志目录尚无文件（configure 未落盘或暂无输出），将持续监听 … ——" ` 并进入轮询（**不关流**）；有文件则读尾部 maxLines 行（文件 ≤4MB 全读，>4MB 从 `size-1MB` 起读），逐行发送，记录 `offset = 读取到的字节位`。
  2. 每 pollMs：重新 `resolveCurrentLogFile`——文件变更（跨天/20MB 轮转）→ 发系统行 `—— 日志滚动到 <文件名> ——`，offset 归零；同文件且 `size > offset` → 从 offset 读到文件尾，按 `\n` 切行（**不完整尾行**留待下轮拼接），逐行发送，offset 前移。
  3. 读取异常 → 发系统行（中文）继续轮询，不关流。
- 页面 `/logs`：`page.tsx`（RSC 壳 + metadata）+ `LogsPanel.tsx`（client）：`new EventSource("/api/logs/tail?maxLines=500")`；行缓冲 cap 10000（丢最旧）；`@tanstack/react-virtual` 的 `useVirtualizer` 固定行高虚拟滚动（已装 3.14.13）；「跟随滚动」开关（用户上翻即暂停、拉到底自动恢复）；按 `| LEVEL |` 段着色（WARNING 黄 / ERROR+ 红 / 其余默认）；清屏按钮（仅清前端缓冲）。

### 6.4 测试计划（logs 项）

- `logPaths.test.ts`（tmp 树）：`damai_mcp.20261002.1` + `damai_mcp.20261003.2` + `damai_mcp.20261003.10` → 取 20261003.10（序号数值比较非字典序）；无关文件忽略；空目录 → null；env 覆盖目录。
- `tail/route.test.ts`（`buildLogTailStream` + tmp 目录 + pollMs=15）：
  1. 预置文件 3 行 → 首 3 条 `event: log` 按序到达；
  2. 追加 2 行 → 下一轮收到且 index 连续；
  3. 半行写入 → 不发，补全后续发；
  4. 改名换新文件（模拟跨天）→ 收到滚动系统行后新文件内容；
  5. `abort` controller → 流终止且 interval 清理（不泄漏）。
- `instrumentation.ts` 的 register 为 Next 生命周期钩子，不做单测（依赖 globalThis 守卫与 pino-roll 真实打开）；其正确性由 web build + logPaths 用例间接覆盖——如实标注「未直测」。

---

## 7. probe —— 选择器调试器（dumpUi 树查看 + find_text 试查）

### 7.1 `web/src/app/probe/`（新页面组；设计决定不建 `api/probe/**` HTTP 端点，全走 Server Action）

- `actions.ts`：

```ts
export const dumpUiSchema = z.object({
  deviceId: z.string().min(1),
  compressed: z.boolean().default(true),
});
export const findTextSchema = z.object({
  deviceId: z.string().min(1),
  text: z.string().min(1),
  exact: z.boolean().default(true),          // findByText 默认整串相等（find.ts:26）
  clickableOnly: z.boolean().default(false), // find.ts:27
  timeoutSec: z.number().min(1).max(30).default(5),
});
export const dumpDeviceUi  = actionClient.schema(dumpUiSchema).action(...)
export const findTextProbe = actionClient.schema(findTextSchema).action(...)
```

- `dumpDeviceUi`：`dumpUi(deviceId, { compressed })`（`src/inspector/dump.ts:102-105`）→ **扁平 DFS 列表，非树、父索引未暴露**（`dump.ts:85-89`）→ 返回 `{ truncated: boolean, elements: Array<UIElement["toDict"]() & { index: number; attrs?: Record<string,string> }> }`；`toDict()` 全 snake_case（`models.ts:95-123`）；attrs 仅非 null 时附带（`models.ts:51`）；cap 3000 个元素 + `truncated` 标注（Server Action 默认 1MB body 限制防护；单次 dump 本身可达 15s——`dump.ts:112` receiptTimeoutMs 15000，UI 必须有 loading 态，action 不另设超时）。
- `findTextProbe`：`findByText(deviceId, text, { exact, clickableOnly, timeout: timeoutSec })`（`find.ts:23-45`）→ 命中返回 `{ found: true, element: toDict()+attrs+index }`；`UIElementNotFoundError`（超时）→ 返回 `{ found: false, error: 中文（find.ts:317-321 文案已含 dump 节点数） }`（不抛，避免 result.serverError 丢失结构化语义——超时是正常试查结果）。
- **path:line 证据标注**（技术决策 6）：每个动作返回 `meta: { dumpedBy: "src/inspector/dump.ts:102 dumpUi", foundBy: "src/inspector/find.ts:23 findByText" }`，页面「证据」面板显示：来源 API 注脚 + 命中元素 `toString()`（`models.ts:125-130`，`<UIElement tag 'label' @ (x,y)>`）+ 全字段表（text/resource-id/class/content-desc/bounds/center/clickable/enabled/package）。用途：改版自救时把页面证据直接映射回 core 源码出处。

### 7.2 UI 组件

- `page.tsx`（RSC）：设备下拉（同 §3.2 数据源）+ 两个工具卡。
- `UiTreePanel.tsx`（client）：默认平铺表格（index/center/text/resource-id/clickable）；切换「树视图」用纯函数重建层级。
- `web/src/app/probe/tree.ts`（新，纯函数 + 单测）：

```ts
/** 按 bounds 包含关系把扁平 DFS 列表重建为树（uiautomator 语义：父 bounds ⊇ 子 bounds）。
 *  非包含关系（异常 dump）→ 保守挂到根，绝不丢元素；同级按 index 稳定排序。 */
export function buildUiTree(elements: ReadonlyArray<ProbeElement>): UiTreeNode[];
```

- `CollapsibleJsonTree.tsx`（client）：递归 `<details>` 折叠（默认展开 2 层）；点击元素 → 右侧属性面板（全字段 + attrs + center + toString）。
- `FindTextForm.tsx`（client）：五字段表单 + loading 态（dump/find 均 5-15s 量级）+ 结果证据卡。

### 7.3 测试计划（probe 项）

- `tree.test.ts`：①三层嵌套 dump（人工构造 bounds）→ 树形正确、根面积最大；②同级兄弟按 index 排序；③bounds 不相交的异常数据全部挂根不丢失；④空列表 → 空树；⑤truncated 标注透传。
- `probe/actions.test.ts`：schema 边界（timeoutSec 0 与 31 拒绝、text 空 拒绝）；`findTextProbe` 注入 fake `findByText`（actions 工厂参数或 vi.mock `@core/inspector/find`）→ found:true / found:false 两种返回形状 + meta 注脚正确；dump 元素 >3000 → truncated=true 且长度 3000。
- `CollapsibleJsonTree` 冒烟（jsdom，文件级 `// @vitest-environment jsdom`）：渲染 2 层 + 点击展开。

---

## 8. ai-chat —— AI 对话面板（provider 动态可配置，OpenAI 兼容协议）

### 8.0 已核实的 ai@7.0.127 API 事实（实读 node_modules，全部为实现依据）

- `ai` 主导出：`streamText`（`dist/index.d.ts:3690`，参数含 model/tools/messages/stopWhen/onError/onFinish/onAbort）、`tool`（re-export 自 provider-utils，`{ description, inputSchema, execute }`，provider-utils `dist/index.d.ts:2303-2309`）、`convertToModelMessages`（`index.d.ts:5716`）、`stepCountIs`（`isStepCount as stepCountIs`，`index.d.ts:10564`）、`createUIMessageStream`/`createUIMessageStreamResponse`（`:6460/:6502`）、`DefaultChatTransport`（`:6229`，init 选项 `api` 默认 `/api/chat`）、类型 `UIMessage/ToolUIPart/DynamicToolUIPart/InferUITools/UIMessageChunk`；`StreamTextResult.toUIMessageStreamResponse(options)`（`:3090`）。
- UI 消息流 chunk 形状（`index.d.ts:2514-2524`）：`{type:"text-start",id}` / `{type:"text-delta",id,delta}` / `{type:"text-end",id}`。
- `ai/test` 子路径导出（`dist/test/index.d.ts`）：`MockLanguageModelV4`（`:131-148`，doStream 可注入）与 `simulateReadableStream({chunks, initialDelayInMs, chunkDelayInMs})`（`:14-21`）；LM v4 流块（@ai-sdk/provider `dist/index.d.ts:3243+`）：`{type:"stream-start",warnings}` / `{type:"text-start",id}` / `{type:"text-delta",id,delta}` / `{type:"text-end",id}` / `{type:"finish",finishReason,…}`。
- `@ai-sdk/react@4.0.130`：`useChat`（`dist/index.d.ts:129`），`UseChatHelpers`（`:99-111`）= `{ id, setMessages, error } & Pick<AbstractChat,"sendMessage"|"regenerate"|"stop"|"resumeStream"|"addToolResult"|"addToolOutput"|"addToolApprovalResponse"|"status"|"messages"|"clearError">`；`UseChatOptions = ({chat} | ChatInit) & {throttle?, resume?}`（`:112-128`）——`transport` 经 `ChatInit` 传入。
- `@ai-sdk/openai-compatible@3.0.62`：`createOpenAICompatible(options: { baseURL: string; name: string; apiKey?: string; headers?… })`（`dist/index.d.ts:338-407`）→ provider，`provider(modelId)` / `provider.languageModel(modelId)` → `LanguageModelV4`（`:326-337`）。

### 8.1 `web/src/lib/aiConfig.ts`（新）

```ts
export interface AiSettings { baseUrl: string; apiKey: string; model: string }
export type AiSettingsSource = "file" | "env" | "none";
export interface AiSettingsStatus {
  configured: boolean;
  source: AiSettingsSource;
  baseUrl: string | null;     // 非敏感，明文展示
  model: string | null;       // 明文展示
  maskedKey: string | null;   // redactToken 掩码；永不回传原文
  filePresent: boolean;
}
/** 优先级（技术决策 7）：web/data/ai-settings.json（0600）> env
 *  DAMAI_AI_BASE_URL/DAMAI_AI_API_KEY/DAMAI_AI_MODEL > 未配置。
 *  文件缺失/损坏/字段缺失 → 视为无文件配置，回落 env（null 不抛，同 credentials.ts:140 语义）。 */
export function loadAiSettings(): AiSettings | null;
export async function saveAiSettings(s: AiSettings): Promise<void>;   // 原子写 + 0600（tmp+rename+chmod，先例 credentials.ts:102-122）
export function getAiSettingsStatus(): AiSettingsStatus;
export function aiSettingsFilePath(): string; // DAMAI_WEB_DATA_DIR ?? <cwd>/data ⇒ web/data/ai-settings.json（与 §1.2 data 目录约定一致）
```

- 掩码复用 core 的 `redactToken`（`src/notify/credentials.ts:204` 导出）。

### 8.2 `web/src/lib/aiTools.ts`（新，只读能力 → AI 工具；安全硬约束）

```ts
export function buildReadOnlyAiTools(): ToolSet;
```

暴露**恰好五个**只读工具（全部中文 description）：

| 工具名 | 实现（core 出处） | 返回 |
|---|---|---|
| `list_devices` | `DeviceManager.shared().listDevices(true)`（`src/device/manager.ts:138`） | `[{deviceId,model,androidVersion,screenSize,isEmulator}]` |
| `get_device` | `DeviceManager.shared().get(deviceId)`（`manager.ts:259-267`） | DeviceInfo 全字段（设备详情） |
| `dump_ui` | `dumpUi(deviceId,{compressed:true})`（`dump.ts:102`） | `{count, truncated, elements: 前 80 个 toDict}`（防 payload 爆炸） |
| `find_text` | `findByText(deviceId,text,{exact,clickableOnly,timeout:5})`（`find.ts:23`） | 命中 `{found:true, element:toDict}`；`UIElementNotFoundError` → `{found:false,error}`（工具内部 catch，不向模型抛异常） |
| `list_monitor_tasks` | `getTaskManager().list().filter(kind==="monitor")`（`manager.ts:172`） | `{id,label,status,startedAtUnixMs,endedAtUnixMs,error,result}[]`（不含 progress 全量） |

- **安全硬约束（写死在模块头 TSDoc + 测试守护）**：绝不 import/包装 `src/actions/actions.ts` 的 tap/swipe/input/click 等写入类符号，绝不暴露 `damai_grab`/提交类能力；每个 `execute` try/catch → `{error: 中文}` 结构化返回。
- 本机无真实模型 key —— 真实 provider 联调留给用户（技术决策 7 原话），测试全部用 mock。

### 8.3 `web/src/app/api/ai/chat/route.ts`（新，POST 流式）

```ts
export const dynamic = "force-dynamic";
export async function POST(req: Request): Promise<Response>
/** 测试直调工厂：model/tools 可注入（mock 联调用）。 */
export function buildAiChatResponse(opts: {
  messages: UIMessage[];
  model?: LanguageModel;          // 缺省 = 按 aiConfig 动态构造
  tools?: ToolSet;                // 缺省 = buildReadOnlyAiTools()
}): Promise<Response>
```

- **未配置分支**：返回 `createUIMessageStreamResponse({ stream: createUIMessageStream({ execute: async ({writer}) => { writer.write({type:"text-start",id:"guide"}); writer.write({type:"text-delta",id:"guide",delta:<引导文案>}); writer.write({type:"text-end",id:"guide"}); } }) })`，chunk 形状已核实（§8.0）。引导文案（中文、可操作）：「尚未配置 AI 提供商：① 打开本页『设置』填入 Base URL / API Key / 模型名（保存到 web/data/ai-settings.json，权限 0600）；或在启动 web 前设置环境变量 DAMAI_AI_BASE_URL / DAMAI_AI_API_KEY / DAMAI_AI_MODEL。」
- **已配置分支**：

```ts
const provider = createOpenAICompatible({ baseURL: s.baseUrl, name: "damai-web", apiKey: s.apiKey });
const result = streamText({
  model: provider(s.model),                      // provider(modelId) → LanguageModelV4（§8.0）
  system: AI_SYSTEM_PROMPT,                      // 中文：只读设备助手；工具为只读探查；绝不代付/下单（D5）
  messages: await convertToModelMessages(messages),
  tools: buildReadOnlyAiTools(),
  stopWhen: stepCountIs(10),                     // 允许多步工具循环（isStepCount as stepCountIs 已导出）
  abortSignal: req.signal,                       // 客户端断开即中止
  onError: ({ error }) => { logger…; },          // 记录不含 apiKey 的中文摘要
});
return result.toUIMessageStreamResponse({
  onError: () => "AI 提供商返回错误（详见服务端日志，不含密钥）", // 错误经 UI 流透出，不中断连接
});
```

- 秘密卫生：任何日志/错误透出前做 `redactSecrets(str)`（把 `s.apiKey` 原文替换 `***`）；`GET /api/ai/settings` 只回 `AiSettingsStatus`（掩码）。

### 8.4 `web/src/app/api/ai/settings/route.ts`（新）

- `GET`：`NextResponse.json(getAiSettingsStatus(), { headers: { "Cache-Control": "no-store" } })`（只掩码，技术决策 7）。
- `POST`：zod 解析 `{ baseUrl: z.string().url(), apiKey: z.string().min(1), model: z.string().min(1) }` → `saveAiSettings` → 返回最新 status。非法 → 400 中文。

### 8.5 `web/src/app/ai/`（新页面组）

- `page.tsx`（RSC，force-dynamic）：`getAiSettingsStatus()` 初始状态 + `SettingsForm` + `ChatPanel`。
- `ChatPanel.tsx`（client）：

```tsx
const chat = useChat({
  transport: new DefaultChatTransport({ api: "/api/ai/chat" }), // api 缺省即 /api/chat，此处显式指定本路由
});
```

  渲染 `chat.messages`：`text` 部分直接渲染；`tool-` 前缀部分（`ToolUIPart`，`state: input-streaming|input-available|output-available|output-error`，`index.d.ts:2299-2301+`）渲染为折叠卡（工具名 + 输入/输出 JSON + 状态）；`chat.status === "submitted"|"streaming"` 显示指示；`sendMessage({ text })` 发送、`stop()` 中止；`chat.error` 显示中文重试提示。未配置时顶部常驻引导条（链接设置区锚点）。
- `SettingsForm.tsx`（client）：三字段 + 保存（POST `/api/ai/settings`）+ 保存后 `router.refresh()` 重取状态；只显示掩码 key、不回填原文。

### 8.6 测试计划（ai-chat 项）

- `aiConfig.test.ts`（tmp 数据目录 env 注入）：①file > env 优先级；②损坏 JSON 回落 env；③无任何配置 → configured=false；④`saveAiSettings` 落盘后文件权限为 0600（POSIX 断言 `stat.mode & 0o777 === 0o600`，win32 跳过——对齐 `credentials.ts:19-22` 平台注记）；⑤status.maskedKey 为掩码形态且不等于原文。
- `aiTools.test.ts`：①五个工具名恰好为白名单集合；②每个 execute 注入 fake（DeviceManager/dumpUi/findByText 用 `vi.mock("@core/…")`）→ 返回形状与中文错误兜底（fake 抛错 → `{error}` 不向外抛）；③**源码守护**：读 `aiTools.ts` 源文本断言不含 `tap`/`swipe`/`input(`/`press` 等 core 写入动作符号的 import（模仿 core `tests/test_monitor.test.ts` 的源码正则守护手法）。
- `chat/route.test.ts`（`buildAiChatResponse` + `ai/test`）：`model = new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: [ {type:"stream-start",warnings:[]}, {type:"text-start",id:"t1"}, {type:"text-delta",id:"t1",delta:"你好"}, {type:"text-end",id:"t1"}, {type:"finish",finishReason:"stop", /* 必要字段按类型补齐 */} ] }) }) })` → 断言 200、body 为 UI 消息流 SSE、含文本增量；未配置分支 → 返回含引导文案的 assistant 流；工具调用链路用带 `tool-call`/`tool-result` 块的 mock 或直接以 fake tools 断言多步（stepCountIs 生效）。
- settings 路由直测：GET 掩码字段形状；POST 合法/非法 body。
- **不跑**：真实 OpenAI 兼容商联调（本机无 key）——如实标注，交付后由用户填 key 验证。

---

## 9. 测试与验收门禁（全部八项）

- 每项自测：`pnpm -C damai-mcp-ts/web exec vitest run <该项测试文件>`；remote 项为 `pnpm -C damai-mcp-ts exec vitest run tests/test_cli_web.test.ts`。
- 全量门禁（脚本统一跑）：根 `typecheck` + core `test`（16 文件基线）+ web `test` + `pnpm -C web build`（Turbopack 全路由编译）。
- 特别验收锚点（对应计划 §6）：
  - persistence：`manager.test.ts` 既有 10 用例**零改动**全过（本次设计已逐例核对：全部 `new TaskManager()` 直构或仅测单例身份，§1.4 的惰性注入不触发其任何断言路径）。
  - monitor/notify/screenshots/logs/probe 的真机交互（模拟器采样、真实送达、真机截图）本机无 adb/无凭证，均如实标注为留待用户 live 验证；各页面无设备/无文件时优雅降级（空态）。
  - ai-chat：mock 全链路可测；真实模型流式 + 工具循环留待用户。

## 10. 导航接线（交接给单独的接线工程师，互斥所有权：`web/src/app/layout.tsx`、`web/src/app/page.tsx`、`web/src/app/api/health/route.ts`）

- `layout.tsx` 导航（现 `:32-49` 仅 设备/抢票任务 两项）追加六项：监控 `/monitor`、通知 `/notify`、截图 `/screenshots`、日志 `/logs`、调试器 `/probe`、AI `/ai`（建议分组：分析类 vs 运维类；保持既有 text-sm 链接样式）。
- `page.tsx` 首页卡片网格（现 `:9-30` 两卡）追加六张卡（标题/一句话说明对应各项目标）。
- `api/health/route.ts` 可选补充 `logDir`（`resolveLogDir()`）与 `aiConfigured`（`getAiSettingsStatus().configured`）字段——均为只读快照；不改既有 `taskCount/lockedDeviceIds/tasks` 字段形状。
- 接线时机：八项路由全部落地后统一接，避免链接指向 404。
