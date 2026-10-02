# damai-mcp-ts 竞品借鉴改进设计（六项）

状态：设计定稿（本文档只做设计，不含实现）。
日期：2026-10-02。

## 证据与引用约定

本文档引用分两类，显式区分：

- **本地锚点**：形如 `src/device/adb.ts:372` —— 本会话实际读过的本仓库代码，
  行号以当前工作区为准。
- **材料引用**：形如（材料：`damai_checkout.py:200-207`）—— 来自本 ask 附带的
  三方分析材料（tickets 仓库 `monitor.rs`/`wechat_api.rs`/`clock.rs`/`dm.rs`/
  `tasks.rs`/`notifications.rs`/`http.rs`，damai 仓库 `damai_checkout.py`/
  `damai_mode0.py`/`tests/test_sale_wait_logic.py`/`profiles/li_ronghao_urumqi.json`）。
  竞品源文件本会话未直接打开，行号转引自分析材料。

行为保真基线：`MIGRATION_NOTES.md` §2（中文错误信息、子进程原始 Buffer、本地时区
时间解析、时序语义、`confirm_order=false` 永不自动支付）与 §3（文件所有权、具名
导出、snake_case 对外表面）。

## 并行实现隔离规则（六项通用）

1. 各项只允许修改/创建自己名下的文件（见 §0 表格），不得要求改动他人文件。
2. **不得 import 其他项"新增"的导出**（并行实现时对方的新导出尚不存在）；
   只允许 import 现有代码中已经存在的导出。
3. 需要共享的小工具一律放进该项自己的新文件或自属源文件内，禁止改
   `tests/helpers.ts`（不在任何一项名下）。
4. 接线（`src/server.ts` / `src/index.ts` / `README.md` / 新工具的 MCP 注册）
   由专门的接线工程师统一执行，见 §7。

## 0. 总览与文件所有权

| id | 目标（一句话） | 独占文件 | 硬约束 |
| --- | --- | --- | --- |
| adb-shell | 持久 ADB shell 进程复用 + marker 回执 | `src/device/adb.ts`、`tests/test_adb.test.ts` | 现有导出签名与行为逐字不变；exec-out 二进制通道原样 |
| countdown-gate | 开票判定去抖门（连续 N 次消失确认 + 刷新 re-arm + 定时器兜底最高优先级） | `src/damai/checklist.ts`、`tests/test_checklist.test.ts` | 不绕过 `damaiGrab` 内置开票闸门；现有 checklist 测试路径不破坏 |
| order-semantics | 提交订单网络异常 ≠ 失败，新增 needs_action + 官方订单页 | `src/damai/actions.ts`、`tests/test_damai.test.ts` | 错误信息中文；不改变 `confirm_order` 默认值 |
| ntp-sample | NTP 3 次采样取最小 RTT + RTT/2 补偿 + 误差区间 | `src/utils/ntp.ts`、`tests/test_ntp.test.ts` | 现有导出（含 `NtpResult.toDict` 键名）不变 |
| monitor | L4 只读余票监控（有票/未开售/售罄/未知 + 退避 + 连败停止） | `src/damai/monitor.ts`（新）、`tests/test_monitor.test.ts`（新） | 绝不点击购买/提交（只读是硬约束） |
| notify | 微信 ClawBot 通知协议客户端（纯 HTTP、传输可注入、发送幂等） | `src/notify/wechat.ts`（新）、`tests/test_notify.test.ts`（新） | 不接真实服务；超时不重发语义必须显式 |

---

## 1. adb-shell —— 持久 ADB shell 进程复用 + marker 回执

### 1.1 目标

把高频点击链从"每条命令冷启动一次 `adb` 客户端进程"升级为"每会话一条常驻
`adb [-s DEV] shell` 交互进程 + 单行拼接 + ASCII marker 回执"，借鉴 damai 的
`PersistentAdbShell` 与 `adb_taps` 协议（材料：`damai_checkout.py:200-207,289-323`；
`damai_mode0.py:114-130`）。**现有全部导出的签名与行为逐字不变**，新能力全部为
新增导出。

### 1.2 API 形状（全部为 `src/device/adb.ts` 新增导出）

```ts
/** 持久 shell 选项。 */
export interface PersistentShellOptions {
  deviceId?: string | null;   // 省略时与当前唯一设备通信（同 AdbOptions.deviceId 语义）
  receiptTimeoutMs?: number;  // 单条回执等待上限，默认 4000（对齐 damai tap 的 4s 上限）
}

/** 超时：回执未在时限内到达。 */
export class AdbShellTimeoutError extends ADBError { /* name = "AdbShellTimeoutError" */ }
/** 通道已死：进程退出 / EOF / 写入失败。 */
export class AdbShellClosedError extends ADBError { /* name = "AdbShellClosedError" */ }

export class PersistentAdbShell {
  /** 解析 adb 路径（复用 whichAdb()）并 spawn `adb [-s DEV] shell`；stdin/stdout 必须为管道。 */
  static open(options?: PersistentShellOptions): Promise<PersistentAdbShell>;

  get alive(): boolean;

  /** N 个 tap 拼一行；gapMs/initialDelayMs 转成设备端 `sleep`；等 marker 回执。 */
  taps(points: ReadonlyArray<readonly [number, number]>,
       opts?: { gapMs?: number; initialDelayMs?: number; receiptTimeoutMs?: number }): Promise<void>;

  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number,
        opts?: { receiptTimeoutMs?: number }): Promise<void>;

  /** 通用单命令：`<cmd>; echo <marker>`；resolve 为 marker 之前的输出行（utf-8 replace 解码）。 */
  run(cmd: string, opts?: { receiptTimeoutMs?: number }): Promise<string>;

  /** 即发即忘（mode0 语义）：写入即返回，不消费回执；下一条命令的 marker 仍可唯一定界。 */
  fire(cmd: string): void;

  /** terminate → 最多等 1s → SIGKILL（对齐 damai close()，材料：damai_checkout.py:348-354）。 */
  close(): Promise<void>;
}
```

marker 形态（实例内自增序号，保证唯一）：
`__DMCTS_CMD_<n>_DONE__` / `__DMCTS_TAP_<n>_DONE__` / `__DMCTS_SWIPE_<n>_DONE__`。

### 1.3 行为语义

- **单行拼接**（对齐 材料：`damai_checkout.py:295-315`）：
  `taps([{100},{200}], {gapMs: 50})` 写入的一行是
  `input tap 100 200; sleep 0.05; input tap 200 300; echo __DMCTS_TAP_1_DONE__\n`，
  一次 write + flush；间隙延时在设备端执行，宿主只等一个 marker。
- **回执匹配在原始字节上做**：内部累积 `Buffer`，用 `Buffer.indexOf(markerBytes)`
  做字节级搜索（marker 为 ASCII），不整段解码——遵守 MIGRATION_NOTES §2 的原始
  字节策略。命中后把 marker 之前的部分按 utf-8（替换坏字节）解码返回，并从累积
  缓冲中消费掉 marker 及其行尾（`\r\n` 或 `\n`，Windows adb.exe 输出 CRLF 需剥 `\r`）。
- **失败三分级**（错误信息中文，对齐 材料：`damai_checkout.py:308-323` 的分级）：
  1. 写入前活性检查 `child.exitCode !== null || child.signalCode !== null ||
     child.stdin.destroyed` → `AdbShellClosedError`「持久 shell 进程已退出」；
  2. stdout `end`/`close` 先于 marker → `AdbShellClosedError`「持久 shell
     在命令完成前结束」；
  3. 超时 → `AdbShellTimeoutError`「持久 shell 命令超时（>Nms）」。
- **超时后通道即废弃**（deviation，记录到 deviations）：Python 版超时后继续复用
  通道；TS 版超时意味着字节流可能已失步（迟到的 marker 无法与后续命令区分），
  因此超时路径自动 `close()`，后续调用得到 `AdbShellClosedError`，由调用方重开。
  marker 唯一序号本身已使"迟到回执误命中后续命令"不可能发生，close 是双保险。
- **stderr**：管道接住并持续 drain（防背压阻塞），内容仅 debug 日志——对齐
  Python 的 `stderr=DEVNULL` 但避免管道写满死锁。
- **fire()**：只做活性检查 + 写入，不注册任何回执等待（对齐 mode0 tap，
  材料：`damai_mode0.py:125-130`）；连点环里下一条写入天然串行，省一次 RTT。
- **串行化**：实例内部用 promise 链把 `run/taps/swipe/fire` 排队，保证"一次写入
  对应一个 marker"的协议不变量，并发调用不会交错写 stdin。

### 1.4 边界条件

- `whichAdb()` 为 null → `open()` 抛现有文案 `ADBError`「adb 未找到。…」
  （`src/device/adb.ts:280-282` 原文复用）。
- spawn 后 `child.stdin/stdout` 为 null（不应发生，stdio 全管道）→ 抛
  `AdbShellClosedError`「持久 shell 流不可用」。
- `taps` 入参：空数组 resolve（不写任何字节）；坐标必须为非负整数，否则抛
  `TypeError`（中文信息）；`gapMs/initialDelayMs` 转成最多 3 位小数的
  `sleep` 秒数（toybox 支持小数秒，Android ≥6；TSDoc 注明该要求）。
- `run(cmd)`：cmd 含 `\n` 或与 marker 同文 → 抛「命令不能包含换行符 / 与回执
  marker 冲突」，维持单写单回执不变量。
- `close()` 幂等：重复调用直接 resolve；进程已死也 resolve。

### 1.5 兼容策略

- **零改动区**：`adb()`（`src/device/adb.ts:274`）、`shell()`（:372）、
  `ADBResult`、`AdbOptions/ShellOptions`、`whichAdb/whichBinary`、
  `exitReturncode/splitLines/formatPyFloat/waitForExit` 全部保持原样；
  现有 `adb exec-out` 二进制通道及其注释（:12-14、:299-303）一字不动。
  持久 shell 不能替代 `shell()`：交互式 shell 无法回报远端退出码，
  `check:true` 语义会变——这正是"签名与行为不变"的边界，故只做新增 API。
- 新错误类继承 `ADBError`（`src/utils/errors.ts:27-32`），现有
  `catch (ADBError)` 分支天然兼容；`src/utils/errors.ts` 不改（不在名下）。
- 消费方接入是接线工程师的可选项（见 §7.2）；本期不强制 `actions/actions.ts`
  的 tap 链迁移（不在名下）。

### 1.6 测试计划（追加到 `tests/test_adb.test.ts`）

复用现有 `mocks.spawnImpl` 注入机制（`tests/test_adb.test.ts:29-58,78-84`）。
持久 shell 的假进程**需要在测试文件内自定义**（`makeFakeProc` 的 stdin 恒为
null，且 `tests/helpers.ts` 不在本项名下）：EventEmitter + PassThrough 三流，
记录 stdin 写入、按用例脚本回放 stdout 字节。用例：

1. `taps` 单行拼接正确（含 `; sleep 0.05;` 与 `echo __DMCTS_TAP_1_DONE__`），
   回放 `…DONE__\r\n` 也能命中（CRLF 剥离）。
2. marker 前有含 `0x80-0xFF` 字节的噪声行 → 字节搜索不受影响，`run` 返回噪声行。
3. EOF 先到 → `AdbShellClosedError`，信息含「在命令完成前结束」。
4. 写入前已 close → `AdbShellClosedError`，信息含「进程已退出」。
5. 回执超时（`receiptTimeoutMs: 20`）→ `AdbShellTimeoutError`，且通道已关闭，
   下一次 `run` reject `AdbShellClosedError`。
6. marker 唯一性：命令 1 超时后迟到的 marker 不会 resolve 命令 2。
7. `fire()` 不等回执即 resolve；随后 `run()` 的 marker 正常命中。
8. `close()`：SIGTERM 后 1s 内未退出则补 SIGKILL（用假进程记录 kill 信号）。
9. 回归：现有 `adb()`/`shell()` 用例原样通过（不改一行）。

### 1.7 证据

本地：`src/device/adb.ts:274-380`（现有 adb/shell 全文）、`:299-303`（spawn +
原始 Buffer 收集）、`:350-356`（中文 check 错误）。材料：`damai_checkout.py:200-207`
（Popen 常驻 shell）、`:289-323`（adb_taps marker 协议）、`:343-346`（swipe 无
超时的原版缺陷——本设计补 4s 上限，记 deviation）、`damai_mode0.py:114-130`
（fire-and-forget 形态）。

---

## 2. countdown-gate —— 开票判定去抖门

### 2.1 目标

在 checklist 的等待开票逻辑里落地三重判定：**连续 N 次确认倒计时节点消失才算
开票**（去抖门）、**下拉刷新造成的节点缺失必须 re-arm 后重新计数**、**定时器
兜底最高优先级**（到点必触发，IPC 回来后复查 deadline）。语义移植自 damai 的
`CountdownSignalGate` 与 `wait_for_sale_fast`（材料：`damai_checkout.py:73-99,
477-488,497-581`；状态机用例 `tests/test_sale_wait_logic.py:71-94`）。

### 2.2 API 形状（`src/damai/checklist.ts` 新增导出）

```ts
export const COUNTDOWN_NODE_RESOURCE_ID = "cn.damai:id/id_project_count_down_layout";
export const GATE_BASELINE_COUNT = 3;        // 基线：连续 3 次见到节点才 armed
export const GATE_BASELINE_WINDOW_MS = 3000; // 基线尝试窗口 min(3s, 距开票)
export const GATE_FALLBACK_AFTER_MS = 150;   // 定时器在 target+150ms 兜底
export const GATE_DEFAULT_POLL_MS = 500;

/** 纯状态机（无 I/O，可直接单测）。 */
export class CountdownSignalGate {
  constructor(options?: { confirmCount?: number }); // clamp 1..5，默认 2（材料：:480）
  get armed(): boolean;
  get falseStreak(): number;
  get rearmCount(): number;
  get missingStartedAtMs(): number | null;
  disarm(nowMs?: number): void;
  /** present=节点在场；signalAllowed=已到点。返回 true = 确认开票。 */
  observe(present: boolean, nowMs: number, signalAllowed: boolean): boolean;
}

export interface WaitForSaleStartOptions {
  observeFromUnix?: number;   // 默认 targetUnix - 10（最后 10s 进入观察窗）
  gatePollMs?: number;        // 默认 500
  confirmCount?: number;      // 默认 2
  fallbackAfterMs?: number;   // 默认 150
  refreshEnabled?: boolean;   // 默认 true
  refreshIntervalMs?: number; // 默认 10000（材料：profiles/li_ronghao_urumqi.json:17-24）
  refreshStopAtSec?: number;  // 默认 2
  refreshSettleMs?: number;   // 默认 250
  progressCb?: ProgressCallback | null;  // 复用现有类型（checklist.ts:316）
  stopEvent?: StopEvent | null;
}

export interface WaitSaleStartResult {
  trigger: "gate" | "timer";
  baselineEstablished: boolean;
  armedAtTrigger: boolean;
  rearmCount: number;
  missingMs: number | null;
  uiDisabled: boolean;      // dump 连续失败导致 UI 观察被禁用，仅靠定时器
  refreshes: number;
  elapsedMs: number;
}

export async function waitForSaleStart(
  deviceId: string,
  targetUnix: number,
  options?: WaitForSaleStartOptions,
): Promise<WaitSaleStartResult>;
```

`RunChecklistOptions`（`src/damai/checklist.ts:358-377`）**只增不改**：
`signalGateDisabled?: boolean`（默认 false）与
`signalGateOptions?: Omit<WaitForSaleStartOptions, "progressCb" | "stopEvent" | "observeFromUnix"> | null`。

### 2.3 行为语义

**门状态机**（逐条对齐 材料：`damai_checkout.py:87-99`）：

- `observe(true, …)`：未 armed → re-arm（`rearmCount += 1`），清零
  `falseStreak` / `missingStartedAtMs`，返回 false。
- `observe(false, …)` 且（未 armed 或 `!signalAllowed`）→ 忽略，返回 false。
- `observe(false, …)` 且 armed 且 signalAllowed → 首次缺失记
  `missingStartedAtMs`，`falseStreak += 1`；`falseStreak >= confirmCount`
  才返回 true。
- `disarm()`：清 armed / streak / missingStartedAtMs（**刷新后必调**——刷新会
  临时卸载倒计时节点，那段缺失永不计入，必须等节点重现才重新武装；
  材料：`damai_checkout.py:566-573` 注释）。

**waitForSaleStart 主循环**（每次迭代顺序固定）：

1. `stopEvent.isSet()` → 返回 `trigger:"timer", …`（外部取消语义与
   `countdownLoop` 一致，`src/damai/checklist.ts:339-341`）。
2. **定时器最高优先级**：`now >= targetUnix*1000 + fallbackAfterMs` →
   `trigger:"timer"` break（材料：`damai_checkout.py:537-541`「定时器有意为
   权威：到点立即点击，不等再一次选择器探测」）。
3. dump UI（复用现有 `dumpUi` import，`src/damai/checklist.ts:22`），
   找倒计时节点：`el.resourceId === RID || el.resourceId.endsWith(RID)` 且
   `el.visible`（RID 匹配语义同 `src/inspector/find.ts:208-216` 的后缀规则）。
   dump **抛异常 ≠ 节点缺失**：不喂门，`consecutiveDumpErrors += 1`；达 3 次
   → `uiDisabled = true`，退化为纯定时器等待（行为等价今天的 `countdownLoop`）。
4. dump 返回后**复查 deadline**：IPC 可能跨越定时器 deadline，定时器仍然获胜
   且不再做信号确认（材料：`damai_checkout.py:552-556`）。
5. `gate.observe(present, now, signalAllowed)`，其中
   `signalAllowed = nowMs >= targetUnix*1000`（到点/过点后的缺失才计数；
   `signalAcceptBefore` 默认 0，材料：`:487,543-545`）→ true 则
   `trigger:"gate"` break。
6. **下拉刷新**：`refreshEnabled` 且距上次刷新 ≥ `refreshIntervalMs` 且
   距开票 > `refreshStopAtSec` 且不在冷却期 → 执行刷新手势（见下），
   随即 `gate.disarm()`、`cooldownUntil = now + refreshSettleMs`、
   `refreshes += 1`。
7. 睡 `gatePollMs`；每轮调用 `progressCb(secondsLeft, elapsedS)`（异常吞掉，
   复用 `src/damai/checklist.ts:344-349` 的容错语义）。

**基线先建立**（材料：`damai_checkout.py:497-517`「没有这个转换，错误或半渲染
页面看起来就像已开售」）：进入观察窗后先以 `min(3s, 距开票)` 为窗口、
`gatePollMs` 为步长，要求节点**连续 3 次**在场才 armed；窗口内未建成基线 →
`baselineEstablished = false`，门不武装，纯定时器兜底。**deviation**：damai 此
处抛 RuntimeError「未检测到倒计时区域」；TS checklist 选择降级为定时器而非失败，
理由：checklist 是编排层，不能因 UI 变体（如页面无倒计时节点、或实际已开售）
让整场抢票中断——该偏离记入 deviations。

**刷新手势**：`swipe(deviceId, w/2, h*0.25, w/2, h*0.65, { durationMs: 300 })`
（`swipe` 已存在于 `src/actions/actions.ts:109-118`，只 import 不修改）；
屏幕尺寸取 `DeviceManager.shared().require(deviceId).screenSize`
（"WxH" 解析，`src/device/manager.ts:56`；空/解析失败回退 1080×1920 并
logger.warning）。

### 2.4 边界条件

- `targetUnix` 已过去：跳过候场与基线，`fallbackAfterMs` 也已过 → 立即
  `trigger:"timer"` 返回（等价今天的立即 fire）。
- 观察窗起点 `observeFromUnix` 早于现在 → 直接进基线段。
- `confirmCount` 越界 → clamp 到 1..5（不抛错，对齐材料 `:480`）。
- 候场段（`now < observeFromUnix`）复用现有 `countdownLoop`
  （`src/damai/checklist.ts:324-353`），长候场仍是 60s 粗粒度 tick。

### 2.5 兼容策略

- **Phase 3 改造点**：`runChecklist` 的 Phase 3（`src/damai/checklist.ts:486-492`）
  由 `await countdownLoop(fireAt, …)` 改为
  `await waitForSaleStart(deviceId, targetUnix, { observeFromUnix: fireAt, … })`，
  `observeFromUnix` 传入原 `fireAt`，候场部分行为逐字不变。Phase 4 仍把
  `openTime` 透传给 `damaiGrab`（`:503`）——**不绕过 damaiGrab 的内置闸门**
  （`src/damai/actions.ts:532-535`）：门提前确认时 `waitUntil` 立即返回；
  定时器兜底时同理，两层语义自动对齐。
- 无 `open_time` 的立即分支（`:516-539`）完全不动。
- `countdownLoop` 等现有导出全部保留（测试与 CLI 直接引用）。
- 现有测试（`tests/test_checklist.test.ts:148-178`）只走 `openTime: ""` 路径，
  不受影响；新增 UI 观察 mock 只出现在本项名下的测试文件里。

### 2.6 测试计划（追加到 `tests/test_checklist.test.ts`）

1. **门状态机两用例逐字复刻**（材料：`tests/test_sale_wait_logic.py:72-94`）：
   ① disarm 后 miss 不触发 → 重新见到节点 re-arm（`rearmCount=1`）→ 再连续
   2 次 miss 触发且 `missingStartedAtMs` = 首个 miss 时刻；② 节点从未出现则
   永不触发、`rearmCount=0`。
2. `confirmCount` clamp（0→1，9→5）。
3. 基线：present×2 + miss → 基线计数归零；present×3 → armed。
4. `waitForSaleStart`（新增 `vi.mock("../src/inspector/dump")` 序列桩 +
   `vi.mock("../src/actions/actions", { swipe })` + 小 `gatePollMs`）：
   a. 基线建成后连续 2 次 miss → `trigger:"gate"`；b. 节点恒在场、目标时刻
   已过 → `trigger:"timer"`；c. dumpUi 连续抛 3 次 → `trigger:"timer"` 且
   `uiDisabled=true`；d. 刷新被调用后 `rearmCount` 从 0 重新累积（disarm 生效）；
   e. `stopEvent` 置位 → 立即返回。
5. `runChecklist` 带 `openTime` + dumpUi 恒在场桩 → 全流程完成、
   Phase 名仍含 `countdown`/`grab_fire`、status 透传不变。
6. 全部用例不触网不触真机（沿用本文件既有 mock 约定，
   `tests/test_checklist.test.ts:26-49`）。

### 2.7 证据

本地：`src/damai/checklist.ts:22`（dumpUi 已可复用）、`:324-353`（countdownLoop）、
`:459-492`（Phase 2/3 现状）、`:497-515`（Phase 4 透传 openTime）、
`:503`（「damai_grab 自带开票时间闸门」注释）；`src/damai/actions.ts:521-535`
（动作层闸门）；`src/inspector/find.ts:208-216`（resource-id 后缀匹配语义）；
`src/actions/actions.ts:109-118`（swipe）。材料：`damai_checkout.py:73-99,
477-488,497-581`；`tests/test_sale_wait_logic.py:71-94`；
`profiles/li_ronghao_urumqi.json:17-24`。

---

## 3. order-semantics —— 防重复下单语义

### 3.1 目标

修正一类会导致**重复下单**的错误分类：确认订单的点击已发出（或点击结果无法
确认）时发生的异常，不得归类为 `failed`——用户看到 failed 会重跑流程、重复
下单。语义移植自 tickets：`order.create` 网络异常 →
`Outcome::action("订单请求结果未确认，请先检查官方订单页，避免重复下单",
ORDERS=https://orders.damai.cn/orderList)`（材料：`dm.rs:351-367,11`；
`tasks.rs:85-93`）。错误信息中文。

### 3.2 API 形状（`src/damai/actions.ts` 内改动）

```ts
/** 官方订单列表页（人工核对入口）。 */
export const DAMAI_ORDERS_URL = "https://orders.damai.cn/orderList";

/** needs_action 的固定中文提示（逐字固定，便于上层识别）。 */
export const NEEDS_ACTION_MESSAGE =
  "订单请求结果未确认，请先检查官方订单页，避免重复下单";

export type GrabResult = {
  status: "ready_for_human" | "submitted" | "needs_action" | "failed";
  // ……既有字段全部保留（elapsed_ms/item_id/price_index/viewer_names/
  //   requires_human_confirmation/payment_started/screenshots/error）
  /** 官方订单页 URL；submitted 与 needs_action 时携带，其余省略。 */
  order_url?: string;
};
```

`damaiGrab`、`DamaiGrabOptions`、`damaiConfirmOrder` 等既有函数签名不变。

### 3.3 行为语义（`damaiGrab` 的 confirmOrder=true 分支细化）

现状：`await damaiConfirmOrder(...)` → 截图 → `status:"submitted"`
（`src/damai/actions.ts:588-606`）；整个 try 的 catch 兜底成
`failed`（:607-625）。改造为三段：

1. **定位失败 ≠ 已发单**：`damaiConfirmOrder` 抛
   `UIElementNotFoundError`（确认按钮从未出现，订单请求必然未发出）→
   原样上抛，走既有 failed 路径。判定依据：`damaiConfirmOrder` 内部先
   `waitForElement` 再 `tap`（`src/damai/actions.ts:427-429`），异常类型可
   区分两个阶段。
2. **点击运输异常 = 结果未知 → needs_action**：`waitForElement` 成功后
   `tap`（adb shell 传输层）抛错——点击是否送达设备未知，订单请求可能已由
   app 发出 → 返回
   `{ status:"needs_action", order_url: DAMAI_ORDERS_URL,
      requires_human_confirmation: true, payment_started: false,
      error: `${NEEDS_ACTION_MESSAGE}（原因: ${excToStr(exc)}）`, … }`。
   与 tickets 的 `request Err → Outcome::action` 同构（材料：`dm.rs:351-367`）。
3. **点击成功后的非致命失败不得降级**：tap 已成功返回后，调试截图抛错
   （`screenshot` 失败）→ **仍返回 `submitted`**（logger.warning 记录，
   `screenshots` 数组允许缺该张）。这是对现状的 bug 修复：今天截图失败会被
   外层 catch 归为 failed（`src/damai/actions.ts:607-624`），订单已提交却报
   失败，正是重复下单的成因之一。记 deviation。
4. 成功路径增加 `order_url: DAMAI_ORDERS_URL` 字段（additive）。

### 3.4 边界条件

- `confirmOrder=false` 的 `ready_for_human` 早退路径
  （`src/damai/actions.ts:570-586`）与登录/打开详情页/选票档/选观演人阶段的
  失败路径**语义不变**（订单请求未发出，failed 无重复下单风险）。
- `needs_action` 的 `error` 恒以中文固定句式开头（§3.2 常量），原因子句允许
  携带底层异常文本（可能含英文的 adb/Node 错误消息，位于中文句子内，符合
  MIGRATION_NOTES §2.1 对既有文案"保持原文"的边界——新句式本身为中文）。
- tickets 的终止词表（VALIDATE/TOKEN/SESSION/登录/令牌/未支付/限购/实名，
  材料：`dm.rs:299-312`）**本期不移植**：其前提是 build/create 重试循环，
  `damaiGrab` 没有重试环，命中即停退化为"改个状态名"，反而稀释语义；
  在 TSDoc 中注明为未来工作。
- tickets 的取消语义（`tasks.rs:450-478`，材料引用）依赖任务管理器快照，
  本仓库无对应结构，明确不在本期范围。

### 3.5 兼容策略

- `GrabResult.status` 联合类型加宽是 additive 变更：下游两处消费均已核实安全——
  `src/damai/checklist.ts:510,533` 的 `grab.status ?? "submitted"` 是 `string`
  赋值；`src/server.ts` 的 `damai_grab`/`damai_grab_multi` 经
  `dictResult` + `DICT_OUTPUT`（passthrough，`src/server.ts:74,93-96`）透传，
  新键 `order_url` 原样过网。两文件均无需改动。
- `requires_human_confirmation: true` 于 needs_action：语义诚实（需人工核对）。
- `payment_started` 恒 false 的安全不变量保持（`src/damai/actions.ts:71-72`）。
- MCP 工具 `damai_grab` 的 zod `confirm_order` 默认 false 不动
  （`src/server.ts:708-709`）；工具 description 的更新属接线工程师（§7.3）。

### 3.6 测试计划（追加到 `tests/test_damai.test.ts`）

复用既有桩（`tests/test_damai.test.ts:28-77`：`waitForElementMock` /
`tapMock` / `screenshotMock` / `shellMock`）：

1. confirmOrder=true 快乐路径 → `submitted` 且 `order_url === DAMAI_ORDERS_URL`
   （新字段断言，旧行为回归）。
2. `tapMock` 在确认按钮已定位后 reject `ADBError` → `needs_action`：
   error 以「订单请求结果未确认，请先检查官方订单页，避免重复下单」开头、
   `order_url` 正确、`requires_human_confirmation === true`、
   `payment_started === false`。
3. `tapMock` reject `UIElementNotFoundError` → 仍为 `failed`（定位失败≠已发单）。
4. tap 成功后 `screenshotMock` reject → 仍为 `submitted`（不降级），error 为 null。
5. 选票档失败（前置阶段）→ `failed` 回归不变。
6. `ready_for_human` 路径回归不变。

### 3.7 证据

本地：`src/damai/actions.ts:61-77`（GrabResult）、`:419-430`（确认订单 =
waitForElement + tap 两阶段）、`:570-625`（三分支现状与外层 catch）、
`:71-72`（payment_started 恒 false 注释）；`src/damai/checklist.ts:510,533`
（status 透传点，已核实是 string 赋值）；`src/server.ts:709,713-739`
（zod 与透传）。材料：`dm.rs:351-367,11`、`tasks.rs:85-93`、
`dm.rs:299-312`（终止词表，本期不移植的理由）。

---

## 4. ntp-sample —— NTP 采样 3 次取最小 RTT + 误差区间

### 4.1 目标

把单臂 NTP 查询从"单样本"升级为"3 次采样、取最小 RTT 样本、输出
RTT/2 补偿后的误差区间"，移植 clock.rs 的采样语义（材料：`clock.rs:22-33,
42-96`；`tasks.rs:196-198`）。**现有全部导出与行为保持兼容**。

### 4.2 数学说明（为何公式不用改）

现有实现 `offsetMs = (serverUnix − (t1+t4)/2)·1000`
（`src/utils/ntp.ts:200-202`）。单臂下 t2≈t3=t_s，标准公式
((t2−t1)+(t3−t4))/2 退化为 t_s − (t1+t4)/2 ≡ t_s − t1 − rtt/2 —— 与 clock.rs
的 `offset = server − sent − rtt/2`（材料：`clock.rs:22-26`）**完全等价**，
即现有 offset 已含 RTT/2 补偿。改进点因此只有两个：① 多次采样选最小 RTT
（最小 RTT 样本的上/下行不对称差最小，offset 偏差随之最小）；② 补充
`uncertainty = minRtt/2 + resolution` 的显式误差区间（材料：`clock.rs:88`）。

### 4.3 API 形状（`src/utils/ntp.ts` 新增导出）

```ts
export const NTP_SAMPLES = 3;                    // 每源采样次数（材料：clock.rs:59）
export const NTP_RESOLUTION_MS = 1;              // 本地时钟分辨率（材料：clock.rs:88）
export const NTP_MAX_OFFSET_ABS_MS = 86_400_000; // 样本 offset 合法域 ±24h（材料：clock.rs:84）
export const NTP_MIN_SERVER_UNIX = 1.6e9;        // ≈2020-09；clock.rs 的 server>1.6e12ms 门槛换算到秒制

export interface NtpSampleResultInit { server: string; offsetMs: number; roundTripMs: number;
  uncertaintyMs: number; samples: number; sampledAtUnix: number; }

export class NtpSampleResult {
  readonly server: string;
  readonly offsetMs: number;      // 最小 RTT 样本的 offset（已含 rtt/2 补偿）
  readonly roundTripMs: number;   // 3 次采样中的最小 RTT
  readonly uncertaintyMs: number; // = roundTripMs / 2 + resolutionMs
  readonly samples: number;       // 有效样本数（1..3）
  readonly sampledAtUnix: number; // 收到最优样本响应的时刻（Unix 秒）
  get intervalLoMs(): number;     // offsetMs − uncertaintyMs
  get intervalHiMs(): number;     // offsetMs + uncertaintyMs
  get synced(): boolean;          // 与 NtpResult 同规则：|offsetMs| < 500（src/utils/ntp.ts:64-66）
  toDict(): { server: string; offset_ms: number; round_trip_ms: number;
    uncertainty_ms: number; interval_low_ms: number; interval_high_ms: number;
    samples: number; sampled_at_unix: number; synced: boolean };  // snake_case 对外表面
}

export async function querySampled(
  server?: string,          // 默认 DEFAULT_NTP_SERVER
  timeout?: number,         // 默认 QUERY_TIMEOUT_SEC；为**每次**采样的超时
  options?: { samples?: number; resolutionMs?: number },
): Promise<NtpSampleResult>;
```

### 4.4 行为语义

- 顺序执行 `samples`（默认 3）次单臂交换；实现上把 `query()` 的单次交换
  重构为**模块内私有** `queryOnce()`，`query()` 对外行为逐字不变（恰好 1 次
  尝试、同样的错误名 `TimeoutError`/`ConnectionError` 与文案、同样的日志）。
- **样本有效性门槛**（对齐 材料：`clock.rs:84`）：`serverUnix >
  NTP_MIN_SERVER_UNIX` 且 `|offsetMs| ≤ NTP_MAX_OFFSET_ABS_MS`；不满足的样本
  丢弃并计入失败次数（错误原因中文：`NTP 样本无效: server=… offset=…ms`）。
- 最优样本 = 有效样本中 RTT 最小者。
- **失败容忍**：部分尝试失败 → 只要 ≥1 个有效样本即成功返回
  （`samples` 字段如实记录有效数）。全部尝试失败（含全部无效）→ 重抛
  **最后一个**错误（保留现有 `TimeoutError`/`ConnectionError` 的 `name` 与
  文案形态，`src/utils/ntp.ts:117-121,164-181`）。
- 两次采样之间不强制间隔（clock.rs 的 3 次采样背靠背，材料：`clock.rs:59`）；
  每次采样都是独立 socket（`queryOnce` 现有创建/关闭语义）。
- `synced` 阈值与 `NtpResult` 一致（500ms），不引入第二套健康标准。

### 4.5 兼容策略

- 现有导出零变化：`NTP_UNIX_DELTA / DEFAULT_NTP_SERVER / QUERY_TIMEOUT_SEC /
  NtpResult / NtpResultInit / buildRequest / parseTransmitTs / ntpSecsToUnix /
  query / asyncQuery / syncDeviceClock / fetchDeviceTime` 的签名、行为、
  `NtpResult.toDict()` 的 snake_case 键名（`src/utils/ntp.ts:73-89`）全部原样。
- 现有调用点不改也不受影响：checklist Phase -1 调 `asyncQuery`
  （`src/damai/checklist.ts:418-428`），server 的 `ntp_sync` 调 `asyncQuery`
  （`src/server.ts:809-819`）——它们继续拿单样本语义。升级为 `querySampled`
  属接线工程师的可选项（§7.4），不在本项名下。
- 仅依赖 Node 标准库（node:dgram/node:crypto），不新增依赖（package.json 不动）。

### 4.6 测试计划（追加到 `tests/test_ntp.test.ts`）

复用 `dgramMocks.createSocketImpl` 注入（`tests/test_ntp.test.ts:23-37`）。
`tests/helpers.ts` 的 `FakeUdpSocket` 立即回包、RTT 不可控，因此在本测试文件内
定义 `DelayedFakeUdpSocket`（extends EventEmitter，按 send 次序以不同真实延迟
回包——延迟 ≤50ms，总用例时长远低于 15s 上限）：

1. 三次采样延迟 30/5/15ms → `roundTripMs` 命中最快样本，`samples === 3`，
   `offsetMs` 来自最快样本（冻结 `Date` 使 serverUnix 固定时逐样本可推），
   `intervalLoMs <= 真实偏差 <= intervalHiMs`。
2. 第 1 次超时（不回包 + 小 timeout）、后两次正常 → `samples === 2` 且成功。
3. 全部超时 → reject，`err.name === "TimeoutError"`、文案含 `did not respond`
   （既有错误形态回归）。
4. 无效样本门槛：响应的 serverUnix < 1.6e9 → 该样本丢弃；三次全部无效 →
   reject 且信息为中文「NTP 样本无效…」。
5. offset 超 ±24h 的样本被丢弃。
6. `toDict()` 键名逐项断言（snake_case + synced）。
7. 回归：现有 `query/asyncQuery` 用例不改一行且全部通过（单样本行为未变）。

### 4.7 证据

本地：`src/utils/ntp.ts:133-214`（query 全文）、`:200-202`（offset 公式）、
`:64-66`（synced 阈值）、`:73-89`（toDict 键名）、`:117-121`（错误名映射）、
`:249-261`（fetchDeviceTime，不动）；`tests/test_ntp.test.ts:23-37,107-142`
（dgram 注入与既有确定性用例）。材料：`clock.rs:22-33,42-96`（offset 公式、
3 采样、min-RTT、uncertainty、样本门槛）、`tasks.rs:196-198`（offset 合法域）。

---

## 5. monitor —— L4 只读余票监控

### 5.1 目标

新增 L4 工具底座：轮询大麦 App 详情页，判定 **有票（available）/ 未开售
（not_on_sale）/ 售罄（sold_out）/ 未知（unknown）**，间隔 + 指数退避 +
连续失败停止。移植 tickets monitor.rs 的三态骨架与词表（材料：
`monitor.rs:56-61,81-102,180-215,246-302`），数据源从 H5 JSON 换成
`uiautomator` UI dump（材料已注明 H5 字段路径不可平移）。
**只读不下单是硬约束：本模块不 import 任何 tap/swipe/input/confirm/pay，
绝不点击购买或提交。**

### 5.2 API 形状（新文件 `src/damai/monitor.ts`）

```ts
export type Availability = "available" | "not_on_sale" | "sold_out" | "unknown";

export const MONITOR_DETAIL_URL_TEMPLATE =
  "https://m.damai.cn/damai/detail/item.html?itemId=";   // 材料：monitor.rs:304-310,346-351
export const MONITOR_COUNTDOWN_RESOURCE_ID = "cn.damai:id/id_project_count_down_layout";
// 16 个阻塞词按四态折叠（源自 材料：monitor.rs:81-102 词表，分组为本设计的适配）：
export const MONITOR_SOLD_OUT_WORDS = ["售罄","售完","缺货","无票","无货","停售",
  "不可售","不可购","已结束","已取消","下架"] as const;             // 终局性不可购
export const MONITOR_NOT_ON_SALE_WORDS = ["未开售","未开始","即将开售","登记","候补"] as const;
export const MONITOR_POSITIVE_WORDS = ["立即购买","立即预订","选座购买","预售中","售票中"] as const;
export const MONITOR_MAX_CONSECUTIVE_ERRORS = 5;   // 材料：monitor.rs:276-287
export const MONITOR_MAX_BACKOFF_MS = 300_000;     // 材料：monitor.rs:292-299
export const MONITOR_MIN_INTERVAL_MS = 5_000;      // 边界常量，库不强制，MCP zod 强制（见 5.6）
export const MONITOR_MAX_INTERVAL_MS = 3_600_000;
export const MONITOR_MAX_ATTEMPTS_LIMIT = 100_000;

export interface MonitorJudge { status: Availability; reason: string | null; }

/** 纯函数：UIElement[] → 四态判定（可直接单测）。 */
export function classifyAvailability(
  elements: readonly UIElement[],
  options?: { soldOutWords?: readonly string[]; notOnSaleWords?: readonly string[];
    positiveWords?: readonly string[]; countdownResourceId?: string | null },
): MonitorJudge;

export interface MonitorOptions {
  intervalMs?: number;            // 默认 30_000
  maxAttempts?: number;           // 默认 0 = 无限（材料：monitor.rs:289-291）
  maxConsecutiveErrors?: number;  // 默认 5
  maxBackoffMs?: number;          // 默认 300_000
  deadlineUnixMs?: number | null; // 默认 null；到达即停（材料：monitor.rs:327-338）
  openPage?: boolean;             // 默认 true：开始时经深链打开详情页
  stopEvent?: { readonly isSet: () => boolean } | null;
  onReport?: ((snapshot: { attempt: number; status: Availability; reason: string | null;
    errors: number; nextDelayMs: number | null }) => void | Promise<void>) | null;
}

export type MonitorStopReason = "available" | "max_attempts" | "consecutive_errors"
  | "cancelled" | "timeout" | "not_foreground" | "page_not_loaded";

export class MonitorResult {
  readonly found: boolean;
  readonly finalStatus: Availability;
  readonly attempts: number;
  readonly consecutiveErrors: number;
  readonly stopReason: MonitorStopReason;
  readonly detailUrl: string;     // MONITOR_DETAIL_URL_TEMPLATE + itemId，found 供人工确认
  readonly lastReason: string | null;  // 命中的文案词
  readonly elapsedMs: number;
  toDict(): { found: boolean; final_status: Availability; attempts: number;
    consecutive_errors: number; stop_reason: MonitorStopReason; detail_url: string;
    last_reason: string | null; elapsed_ms: number };   // snake_case 对外表面
}

export async function monitorAvailability(
  deviceId: string, itemId: string, options?: MonitorOptions,
): Promise<MonitorResult>;
```

### 5.3 行为语义

**判定（`classifyAvailability`，优先级从高到低）**：

1. 扫描全部 `visible` 元素的 `text` 与 `contentDesc`（字段同
   `src/inspector/models.ts` 的 UIElement；匹配语义同
   `src/inspector/find.ts:197-206` 的子串包含）：
   命中 `MONITOR_SOLD_OUT_WORDS` → `sold_out`（reason=命中词）；
2. 命中 `MONITOR_NOT_ON_SALE_WORDS` → `not_on_sale`；
3. 倒计时节点在场（resource-id 等值/后缀匹配）→ `not_on_sale`
   （reason="countdown_node"，与 countdown-gate 观察的是同一节点，
   常量在本文件内独立定义——**不 import checklist 的新导出**，见隔离规则）；
4. 命中 `MONITOR_POSITIVE_WORDS` → `available`（正证据：可购 CTA 文案；
   无库存数字可读，正证据即 CTA，对齐 材料：`monitor.rs:210-211` 的
   "正证据才判 Available" 精神）；
5. 其余一律 `unknown`（**无正证据一律 Unknown 继续轮询**，材料：
   `monitor.rs:56-61`）。阻塞词优先于正证据（同材料 `:202-211` 的检查次序）。
   词表适配说明：16 个阻塞词折叠进 sold_out / not_on_sale 两组（11+5），
   reason 字段保留原始命中词，信息不丢失。

**轮询（`monitorAvailability`，对齐 材料：`monitor.rs:246-302`）**：

```
errors = 0; attempts = 0
openPage 时：am start 深链打开（damai://item?id=<id>，失败回退
  https://m.damai.cn/shows/item.html?itemId=<id>，均经 device/adb.shell，check:false），
  以「dump 中存在 package === cn.damai 的元素」为加载成功判据（不等待购买按钮——
  未开售时按钮文案本就不是“立即购买”）；两次尝试后仍未加载 → 停止
  stopReason:"page_not_loaded"，错误信息中文。
循环：
  stopEvent 置位 → "cancelled"；deadlineUnixMs 已到 → "timeout"
  attempts++
  dumpUi 抛异常 → errors++；errors >= maxConsecutiveErrors → 停止
    "consecutive_errors"（错误信息为中文且截断 200 字符，不含上游原始 body——
    材料：monitor.rs:276-287「错误文案不含上游 body」）；否则睡
    min(interval * 2^errors, maxBackoffMs) 后继续（指数退避，下限 interval）
  dump 成功 → errors = 0（成功响应清零计数，材料：monitor.rs:268）
  若无任何元素 package === "cn.damai"（DAMAI_PACKAGE，import 自
    ./actions，即 src/damai/actions.ts:24）→ 停止 "not_foreground"
    （大麦不在前台；只读监控不做自动重导航，避免干扰设备上的人工操作）
  classify：available → 立即返回 found=true（材料：monitor.rs:263-266）
    其余状态继续轮询（未开售/售罄都可能翻转；不提前停是 tickets 既有语义）
  睡 interval → 下一轮
  maxAttempts > 0 且 attempts 达上限 → 停止 "max_attempts"（false=未发现）
```

- **只读硬约束的实现层保证**：`monitor.ts` 的 import 白名单 =
  `node:timers/promises`、`../device/adb`（仅 `shell`）、
  `../inspector/dump`（仅 `dumpUi`）、`./actions`（仅 `DAMAI_PACKAGE`
  常量）、`../utils/logging`。不 import `tap/swipe/pressKey/inputText` 与
  `damaiGrab/damaiConfirmOrder/damaiPay`。
- 深链 `am start` 属"打开页面"而非"点击"，且只在 `openPage=true`（默认）时
  执行一次；轮询期间零写入指令。工具 description 必须写明
  「只读监控：不点击购买、不提交订单」（接线工程师落实，§7.5）。

### 5.4 边界条件

- 入参校验（库层只做正负号 sanity，抛中文 Error）：`intervalMs <= 0` →
  「监控间隔必须为正数」；`maxAttempts < 0` → 「max_attempts 不能为负」。
  **5000–3600000ms 与 ≤100000 的边界强制放在 MCP 工具的 zod schema**
  （`z.number().int().min(5000).max(3600000)`）——对应 tickets 在任务管理器层
  的校验（材料：`tasks.rs:184-194`），MCP 中由 zod 承担同一角色，库层保持
  可测性（测试用小间隔）。
- `maxAttempts = 0` 为无限轮询（tickets 语义忠实保留）；**接线时工具层默认
  必须给有限值**（建议 720，约 6h @30s），见 §7.5。
- dump 成功但元素为空 → `unknown`（材料：`monitor.rs:184-186`「缺失 →
  Unknown」），继续轮询，不计错误。
- 本场演出级词（已结束/已取消/下架）归入 sold_out 组：四态模型下它们都是
  "不再有票可购"的终局态，reason 保留区分度。

### 5.5 兼容策略

- 纯新增文件，零现有导出受影响。仅 import 既有导出（`shell`、`dumpUi`、
  `DAMAI_PACKAGE`、`logger`），全部为已存在的稳定符号，与其他五项无文件交集。
- `MonitorResult.toDict()` 全 snake_case，直接可作为 MCP 工具的
  structuredContent（经 `DICT_OUTPUT` passthrough）。

### 5.6 测试计划（新文件 `tests/test_monitor.test.ts`，自包含）

`vi.mock("../src/inspector/dump")`（dumpUi 序列桩）、
`vi.mock("../src/device/adb")`（shell 桩，深链不外发）、小 `intervalMs`：

1. `classifyAvailability` 纯函数矩阵：立即购买 → available；售罄 + 立即购买
   并存 → sold_out（阻塞词优先）；未开售/即将开售/登记/候补 → not_on_sale；
   已结束 → sold_out；空白页 → unknown；content-desc 证据同样命中；
   倒计时节点在场 → not_on_sale。
2. 首轮即 available → `found=true` 立即返回，`stopReason:"available"`，
   `detailUrl` 拼接正确。
3. dumpUi 连续 5 次抛 → `stopReason:"consecutive_errors"`、attempts=5、
   错误信息中文且 ≤200 字符。
4. 退避节奏：经 `onReport` 快照断言 `nextDelayMs` 序列
   `interval, 2·interval, 4·interval, …` 封顶 `maxBackoffMs`，成功后回到
   `interval`（用 `vi.useFakeTimers` + `advanceTimersByTimeAsync`）。
5. `maxAttempts=3` 未命中 → `"max_attempts"`、`found=false`。
6. dump 中 package 全非 cn.damai → `"not_foreground"`。
7. deadlineUnixMs 已过 → `"timeout"`；stopEvent 置位 → `"cancelled"`。
8. `openPage=true` 时 shell 桩收到 `am start -a android.intent.action.VIEW -d
   damai://item?id=…`；两次深链均失败 → `"page_not_loaded"`。
9. **只读守护测试**：`readFileSync` 读 `src/damai/monitor.ts` 源码，断言不出现
   `/\btap\(|\bswipe\(|pressKey|inputText|damaiGrab|damaiConfirmOrder|damaiPay/`
   ——把"绝不点击"固化为 CI 断言。

### 5.7 证据

本地：`src/inspector/dump.ts:82-173`（dumpUi + package 属性解析
`:165`）、`src/inspector/find.ts:197-216`（文本/rid 匹配语义）、
`src/damai/actions.ts:24,277-291`（包名常量与深链两步打开的既有形态）、
`src/utils/errors.ts:9-78`、`src/actions/actions.ts:109-118`（swipe——本模块
**不**引入）。材料：`monitor.rs:56-61`（三态原则）、`:81-102`（16 阻塞词）、
`:180-215`（大麦判定骨架与 limitQuantity 不影响库存）、`:246-302`（轮询/退避/
连败停止/错误文案）、`:304-310,346-351`（found 返回详情页 URL）、
`tasks.rs:184-194`（间隔/次数边界，落点改为 zod）。

---

## 6. notify —— 微信 ClawBot 通知协议客户端

### 6.1 目标

纯 HTTP 的 ClawBot `sendmessage` 协议客户端（材料：`wechat_api.rs:8-10,
134-159,239-275,282-357`）：全局 `fetch` 实现、传输层可注入（测试用本地
`node:http` mock，**不接任何真实服务**）、发送幂等（超时＝送达未知、不自动
重发的语义必须显式）。扫码绑定/接收长轮询**不在本期范围**（依赖任务管理器与
UI 会话，材料：`notifications.rs`；MCP 侧凭证由用户配置提供）。

### 6.2 API 形状（新文件 `src/notify/wechat.ts`）

```ts
/** 传输层抽象：客户端只负责组协议，URL 的真实走向由 transport 决定。 */
export interface ClawBotRequest {
  origin: string;               // 配置里的合法 origin（未与 path 拼接）
  path: string;                 // 形如 "/ilink/bot/sendmessage"
  method: "GET" | "POST";
  headers: Record<string, string>;
  body: string | null;          // JSON 文本；GET 为 null
  timeoutMs: number;
}
export interface ClawBotResponse { status: number; bodyText: string; }
export type ClawBotTransport = (req: ClawBotRequest) => Promise<ClawBotResponse>;

/** 默认传输：全局 fetch + AbortSignal.timeout + 1MiB body 上限。 */
export function createFetchTransport(options?: { maxBodyBytes?: number }): ClawBotTransport;

export interface ClawBotConfig {
  origin: string;      // https 且 host ∈ *.ilinkai.weixin.qq.com，无端口/路径/query/fragment
  token: string;       // Bearer
  timeoutMs?: number;  // 默认 10_000
  maxTextLength?: number; // 默认 4096（见 6.4 deviation）
}

export type SendStatus = "sent" | "failed" | "expired" | "timeout_unknown";

export interface SendOutcome {
  status: SendStatus;
  clientId: string;        // 协议幂等键，恒回显
  error: string | null;    // 中文；sent 时为 null
  httpStatus: number | null;
  elapsedMs: number;
}

export const CLAWBOT_DEFAULT_CHANNEL_VERSION = "2.4.8";   // 材料：wechat_api.rs:278-280
export const CLAWBOT_APP_CLIENT_VERSION = "132104";       // 材料：wechat_api.rs:9-10
export const CLAWBOT_USER_AGENT_BASE = "damai-mcp-ts";    // bot_agent 前缀

export class ClawBotClient {
  constructor(config: ClawBotConfig, transport?: ClawBotTransport); // 缺省 createFetchTransport()
  /** 发送一条文本通知；恰好一次 HTTP 请求，内部零重试。 */
  sendText(target: string, contextToken: string, text: string,
           options?: { clientId?: string }): Promise<SendOutcome>;
}
```

### 6.3 行为语义

**请求协议**（照抄 材料：`wechat_api.rs:134-159,239-275,265,278-280`）：

```
POST {origin}/ilink/bot/sendmessage
headers:
  Content-Type: application/json
  iLink-App-Id: bot
  iLink-App-ClientVersion: 132104
  AuthorizationType: ilink_bot_token
  X-WECHAT-UIN: base64(随机 u32 的十进制 ASCII 串)
  Authorization: Bearer <token>
body: {
  "msg": { "to_user_id": target, "client_id": "damai-mcp-ts-<uuid4>",
           "message_type": 2, "message_state": 2, "context_token": contextToken,
           "item_list": [{ "type": 1, "text_item": { "text": text } }] },
  "base_info": { "channel_version": "2.4.8", "bot_agent": "damai-mcp-ts/notify" }
}
```

`client_id` = `"damai-mcp-ts-" + crypto.randomUUID()`（node:crypto）；
`options.clientId` 显式传入时原样使用（幂等键复用通道）。

**响应守卫**（对齐 材料：`wechat_api.rs:282-357`；映射文案借 http.rs 风格，
材料：`http.rs:103-116`，全部中文）：

| 情形 | 结果 |
| --- | --- |
| HTTP 2xx 且 JSON `ret === 0` | `sent` |
| HTTP 2xx 且 `ret` 或 `errcode === -14` | `expired`「登录状态已过期，请重新绑定通知机器人」 |
| HTTP 2xx 且 `ret`/`errcode` 非 0 | `failed`「发送失败（ret=<n>）」 |
| HTTP 401 | `expired` |
| HTTP 403 / 429 | `failed`「请求受限，请稍后重试」 |
| 其他非 2xx | `failed`「服务器返回 HTTP <n>」 |
| 非 JSON body | `failed`「服务器返回了非 JSON 数据」 |
| body 超 1MiB（默认传输层抛出） | `failed`「响应体超过上限」 |
| 传输超时（AbortError/TimeoutError） | `timeout_unknown`（见下） |
| 其他传输异常 | `failed`「发送失败（网络错误）: <原因>」 |

错误文案一律不含服务端 body 原文（材料：`wechat_api.rs:295-327` 及其测试
语义）。

**发送幂等（本项的核心语义，必须逐字实现）**：

1. **恰好一次**：每次 `sendText` 调用至多发出一次 HTTP 请求，客户端内部
   **零自动重试**（对齐 材料：`notifications.rs:635-660`「发送超时＝送达状态
   未知…应用不会自动重发」与 `tasks.rs:383-384` 的每任务恰好一次）。
2. **超时 ≠ 失败**：`timeout_unknown` 明确表达"请求可能已送达"；outcome.error
   固定含「送达状态未知，为避免重复提醒不会自动重发；如确需重试，请携带返回
   的 client_id 由服务端幂等去重后再人工决策」。
3. **幂等键外置**：`client_id` 是协议级去重键（材料：`wechat_api.rs:265`），
   客户端把它放在 `SendOutcome.clientId` 回显，重发决策权在调用方——客户端
   自己永不重发。
4. **串行化**：实例内 promise 锁把并发的 `sendText` 排队（对齐
   材料：`notifications.rs:141` 的 send_lock），保证观察到的请求次序与调用
   次序一致。

**origin 强校验**（构造时执行，材料：`wechat_api.rs:63-85`）：必须能被
`new URL` 解析、协议 `https:`、无 username/password、无显式端口、
pathname 为 `/` 或空、无 search/hash；host 等于
`ilinkai.weixin.qq.com` 或以其为后缀。违规抛中文 `Error`。
**测试如何过这道校验**：测试传入名义 origin
`https://bot.ilinkai.weixin.qq.com`（合法），注入的 transport 把请求映射到
本地 `node:http` 服务器——origin 校验与真实走向解耦，无需任何逃生开关。

### 6.4 边界条件

- 参数校验（发请求前抛中文 Error，transport 计数不变）：`target`/`contextToken`
  非空；`contextToken.length <= 16384`（材料：`notifications.rs:308-353`）；
  `text` 非空且 `<= maxTextLength`。
- **deviation**：tickets 的 text 长度上限的具体数值未出现在分析材料中，本设计
  取保守默认 4096 并通过 `maxTextLength` 可配；接入真实服务前需实测校准。
- 超时计时在默认 transport 内用 `AbortSignal.timeout(timeoutMs)`；注入
  transport 时超时语义由 transport 自身负责（契约：超时 reject 的 Error 名为
  `TimeoutError` 或 `AbortError`，客户端据此归类 `timeout_unknown`）。
- 本模块不接真实服务：默认 transport 只在显式构造后才会出网；测试全部走注入
  transport + 本地 `node:http`。

### 6.5 兼容策略

- 纯新增文件（`src/notify/wechat.ts`），零交集、零现有导出受影响。
- 不 import 仓库内任何模块（自包含，node:crypto/node:global fetch），
  与其他五项及 server 无耦合；`bot_agent` 用本文件常量而非 `server.ts` 的
  VERSION，避免反向依赖 MCP SDK。
- 上层接入（MCP 工具/checklist 自动通知）属接线范围，见 §7.6 与 §8 的
  所有权限制说明。

### 6.6 测试计划（新文件 `tests/test_notify.test.ts`，自包含）

`beforeAll` 起本地 `node:http` 服务器（`listen(0)` 取随机端口）记录请求，
用例内把 `ClawBotRequest` 映射到 `http://127.0.0.1:<port>`：

1. 快乐路径：200 + `{"ret":0}` → `sent`；断言 path、六个协议头、
   `client_id` 匹配 `^damai-mcp-ts-[0-9a-f-]{36}$`、payload 形状
   （message_type/message_state/item_list/base_info）。
2. 显式 `clientId` 透传到 body。
3. `ret=-14` → `expired`；`ret=7` → `failed` 且文案含「发送失败」；
   HTTP 401 → `expired`；403/429 → 「请求受限」；500 → 「服务器返回 HTTP 500」。
4. 非 JSON body → 「非 JSON」；Content-Length > 1MiB → 「超过上限」。
5. 超时：本地服务器挂住 + 默认 transport + `timeoutMs: 100` →
   `timeout_unknown`，error 含「送达状态未知」与「不会自动重发」，
   且服务器**恰好收到 1 次请求**（零重试断言）。
6. origin 校验矩阵：http://、带端口、带路径、带 query、非 weixin host →
   构造即抛中文错误。
7. 参数校验：空 target / 空 context_token / text 超长 → 抛错且服务器请求数
   不变。
8. 并发串行化：两个并发 `sendText` → 服务器按调用次序各收到 1 次。
9. 全程不出网：所有用例走注入 transport（第 5 条用默认 transport 但指向
   本地服务器）。

### 6.7 证据

全部为材料引用：`wechat_api.rs:8-10,63-85,134-159,161-275,265,278-280,
282-357`（端点/头/载荷/守卫/幂等键/base_info）、`notifications.rs:141,308-353,
635-660`（send_lock、context_token 校验、超时不重发）、`tasks.rs:383-384`
（恰好一次）、`http.rs:103-116`（中文错误映射风格）。本地核实：仓库现无任何
通知模块（`src/` 目录清单与全仓检索，仅 `src/damai/checklist.ts:14` 有
「可选提醒」占位注释）。

---

## 7. 接线说明（接线工程师执行；涉及 server.ts / index.ts / README.md）

### 7.1 总原则

- 新工具注册在 `createMcpServer()`（`src/server.ts:83`）内，仿 L4 段模式
  （`src/server.ts:553-886`）：中文 description 带 Args 块、`inputSchema` 为
  带 `.shape` 的 zod 对象、`outputSchema: DICT_OUTPUT`（`src/server.ts:74`）、
  返回经 `dictResult`（`:93-96`）。
- `tests/test_server.test.ts` 的冒烟断言是「≥25 个工具」的下限
  （`tests/test_server.test.ts:38-46`），新增工具无需改该文件即可通过；
  若要补新工具的注册断言，接线工程师自行追加。
- `src/index.ts` barrel（`src/index.ts:9-10`）按需具名导出新模块的公共 API。

### 7.2 adb-shell（可选接入）

`PersistentAdbShell` 本期为纯新增能力（无强制消费方）。可选：在 L2 段
（`src/server.ts:194-399`）后新增 `device_tap_chain` 工具
（`{ device_id, points: [[x,y],…], gap_ms?, initial_delay_ms? }` →
`PersistentAdbShell.open({deviceId}).taps(...)` → 返回 `{sent: n, elapsed_ms}`），
用于演示与验证持久通道；或在 README 记录其定位为库级 API。

### 7.3 order-semantics

- `damai_grab` 工具 description 补一句：「提交结果可能出现
  status=needs_action：表示订单请求结果未确认，请先打开
  https://orders.damai.cn/orderList 人工核对，切勿直接重跑」。
- 无 schema 变更（`confirm_order` 默认 false 保持，`src/server.ts:709`）。

### 7.4 ntp-sample（二选一，推荐 A）

- **A（保守）**：`ntp_sync`（`src/server.ts:792-821`）保持 `asyncQuery` 不变，
  另注册 `ntp_sync_precise` 工具：`{ server?, timeout_sec?, samples? }` →
  `querySampled(...)` → 合并 `toDict()` 输出（新增
  uncertainty/interval/samples 键）。
- **B（就地升级）**：`ntp_sync` 改调 `querySampled`，响应在保留旧键
  `offset_ms/delay_ms/server_unix/queried_at_unix/synced` 的同时
  （`delay_ms` 填最小 RTT），追加 `round_trip_ms/uncertainty_ms/
  interval_low_ms/interval_high_ms/samples`。旧键语义不破坏。

### 7.5 monitor（必须接线）

- L4 段末尾（`src/server.ts:886` 之后、L5 之前）注册
  `damai_monitor_availability`：
  ```ts
  inputSchema: {
    device_id: z.string(),
    item_id: z.string(),
    interval_ms: z.number().int().min(5000).max(3600000).default(30000),
    max_attempts: z.number().int().min(0).max(100000).default(720), // 工具层必须有限
    max_consecutive_errors: z.number().int().min(1).max(50).default(5),
    open_page: z.boolean().default(true),
    deadline_unix_ms: z.number().nullable().default(null),
  }
  ```
  description 首句必须为：「只读监控大麦详情页余票状态：判定
  available/not_on_sale/sold_out/unknown；**绝不点击购买、绝不提交订单**。」
  返回 `MonitorResult.toDict()`。
- `max_attempts` 工具层默认给有限值（库层 0=无限语义保留）；zod 的
  min/max 承担 tickets 任务层校验的角色（材料：`tasks.rs:184-194`）。

### 7.6 notify（可选接线 + 所有权限制说明）

- 可选注册 `notify_send` 工具：
  `{ origin, token, context_token, target, text }` → `new ClawBotClient({origin,
  token}).sendText(...)` → 返回 `SendOutcome`（含 timeout_unknown 语义说明）。
  凭证建议从环境变量读取（如 `DAMAI_CLAWBOT_ORIGIN/TOKEN/CONTEXT_TOKEN`），
  工具参数缺省时回落环境变量——具体由接线工程师定。
- **范围限制（如实声明）**：`runChecklist` 结果自动触发通知需要改
  `src/damai/checklist.ts`（在 `src/damai/checklist.ts:541` 返回前注入回调），
  该文件所有权在 countdown-gate 项名下，本期不设计跨文件改动；自动通知留待
  下一轮所有权分配。README 先记录手动 `notify_send` 用法。

### 7.7 README.md

新增章节：① 六项改进的简介与出处（本文档链接）；②
`damai_monitor_availability` 的只读声明与参数表；③ ClawBot 配置（origin/token/
context_token 获取方式）与「超时不重发」语义说明；④ `needs_action` 结果的
处置指引（先查官方订单页再决定是否重跑）。

---

## 8. 跨项兼容与风险清单

1. **并行隔离**：六项零文件交集；monitor/notify 只 import 已存在的导出
   （`shell`/`dumpUi`/`DAMAI_PACKAGE`/`logger`），不依赖任何一项的新导出。
   `MONITOR_COUNTDOWN_RESOURCE_ID` 与 countdown-gate 的
   `COUNTDOWN_NODE_RESOURCE_ID` 是有意重复的字面常量（并行实现不能互相
   import 新导出），接线阶段可评估合并。
2. **GrabResult 类型加宽**（order-semantics）对 checklist（string 赋值，
   `src/damai/checklist.ts:510,533`）与 server（passthrough，
   `src/server.ts:74,93-96`）均已核实无编译/运行影响。
3. **checklist Phase 3 改造**（countdown-gate）只影响带 `openTime` 的路径；
   现有测试仅覆盖立即路径（`tests/test_checklist.test.ts:148-178`），回归
   风险低；新增 dumpUi mock 仅存在于其自属测试文件。
4. **持久 shell 不替换 `shell()`**：交互式 shell 无远端退出码，`check:true`
   语义不可平移——这是"行为不变"的硬边界（`src/device/adb.ts:350-356`）。
5. **已识别的 deviation（须记入各提交的 deviations）**：
   - adb-shell：超时后关闭通道（Python 版继续复用）；swipe 补 4s 上限。
   - countdown-gate：基线未建立时降级为定时器（damai 原版抛错）。
   - order-semantics：tap 成功后截图失败不再降级为 failed（重复下单 bug 修复）。
   - ntp-sample：clock.rs 的 `server>1.6e12`(ms) 门槛换算为秒制 1.6e9。
   - monitor：16 阻塞词折叠进四态；H5 JSON 字段路径不可用，改 UI dump。
   - notify：text 上限 4096 为保守取值，待实测校准；绑定/接收流程不移植。
6. **安全不变量全局复核**：monitor 无任何写入型 adb 指令（有 CI 守护测试）；
   order-semantics 与 checklist 均不触碰支付（`payment_started` 恒 false，
   `src/damai/actions.ts:71-72`）；notify 不接真实服务、不出网。
7. 本设计为只读设计：本次会话未运行 `pnpm typecheck` / `pnpm test`（ask 未
   要求执行检查），文中所有"已核实"均指静态阅读本会话打开的源文件。
