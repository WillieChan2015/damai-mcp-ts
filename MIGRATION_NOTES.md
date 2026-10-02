# MIGRATION NOTES — damai-mcp (Python) → damai-mcp-ts (TypeScript)

本文档记录 Python 项目 `damai-mcp`（0.2.3，Python 3.10+，asyncio）向 TypeScript 项目
`damai-mcp-ts`（项目与代码目录同名 `damai-mcp-ts/`；TypeScript 5.9.3，strict，ESM）
迁移时的工具链决定与**行为保真**规则。
各模块负责人在移植前必读；与 Python 原版的一切偏离须记录在对应提交的 deviations 里。
迁移已完成，结果报告（含 87 条行为偏离记录与 8 条独立复核发现）见
[docs/migration/migration-report.md](docs/migration/migration-report.md)。

## 1. 工具链决定（已定，不得更换）

| 领域 | Python 原版 | TS 版选择 |
| --- | --- | --- |
| 运行时 / 语言 | Python 3.10+，asyncio | Bun ≥ 1.2（兼容）与 Node ≥ 22（标准 API），TypeScript 5.9.3 strict，ESM |
| 包管理 | pip / setuptools | pnpm（`packageManager: pnpm@10.34.5`） |
| 测试 | pytest + pytest-asyncio | vitest ^3（`tests/**/*.test.ts`，超时 15s） |
| MCP 协议 | `mcp>=1.0`（Python SDK） | `@modelcontextprotocol/sdk` ^1.30.0（最新 1.x）+ zod ^3 做参数校验 |
| XML / XPath | lxml（XPath 1.0） | `@xmldom/xmldom` ^0.9 + `xpath` ^0.0.34（**必须保持标准 XPath 1.0 语义**，不得自造选择器方言） |
| 图像缩放 | Pillow | jimp ^1 |
| 日志 | loguru | pino ^9 + pino-roll ^6（滚动文件） |
| CLI | `damai-mcp` console_script（server:main） | commander ^14（`src/cli.ts`，`pnpm serve` 即 `bun run src/cli.ts serve`） |
| 子进程 | asyncio subprocess | `node:child_process` 的 `spawn`（一律异步收集输出） |

## 2. 行为保真规则（移植时逐条对照）

1. **错误信息保持中文原文**；Python docstring 译成 TSDoc，语义不得增删。
2. **子进程原始字节策略**：所有子进程调用一律收集原始 `Buffer`（对应 Python 版的 raw
   bytes 策略），**不经过文本编解码管道**。保留 `adb exec-out` 用法及其注释——
   `exec-out` 直接走二进制通道，绕过 Windows 控制台的 GBK 代码页，避免截屏字节流
   被 code page 转码破坏。
3. **时间解析**：`"YYYY-MM-DD HH:MM:SS"` 一律按**本地时区**解析。用
   `new Date(y, m - 1, d, h, min, s)` 六参构造或手工计算 epoch 毫秒；**禁止**
   `new Date("字符串")` 直接解析非严格 ISO 格式（在部分运行时上会被当作 UTC）。
   checklist 的 `fromisoformat` 分支同样按本地时间处理。
4. **时序语义**：
   - `_wait_until` 保留末段精确睡眠语义——最后 200ms 内不做分段轮询，一次
     `sleep(remaining)` 精确睡满（**不是自旋忙等**。早期文档此处误写为
     "末段忙等 / spin-wait"，与实现不符，2026-10-02 已修正，见 §5）；
   - retry 保留指数退避 + jitter；
   - UICache 保留"截屏头 4KB 做 md5 指纹"的缓存键策略；
   - checklist 保留 `preheat_warm_dump` 并行预热语义。
5. **安全语义**：`damai_grab` 默认 `confirm_order=false`，**永不自动点击支付**。
6. **已知 Python 侧 bug**：`utils/ntp.py` 的 `fetch_device_time` 在函数体内
   `from ..device.adb import run_adb`（ntp.py:145），而 `device/adb.py` 只导出
   `adb` / `shell` / `which_adb` / `ADBResult`，**没有 `run_adb`**——调用即 ImportError。
   TS 版移植为调用正确的 adb 封装（`src/device/adb.ts` 的对应导出），并在 deviations 中记录。

## 3. 工程约定

- 只创建/修改分配给自己的文件；不为范围外模块建占位 stub。
- 相对导入不带扩展名；全部具名导出（barrel 见 `src/index.ts`）。
- Python `@dataclass` 用 `interface` + 工厂或 readonly class 均可，字段名语义一致（camelCase 化）。
- 不在本仓库根跑 `pnpm install` / 全局 typecheck / test 之外的全局命令；统一由工作流执行。

## 4. 文件映射表

| Python 源文件 | TS 目标文件 |
| --- | --- |
| `utils/errors.py` | `src/utils/errors.ts` |
| `utils/logging.py` | `src/utils/logging.ts` |
| `utils/retry.py` | `src/utils/retry.ts` |
| `utils/ntp.py` | `src/utils/ntp.ts`（设备层阶段移植） |
| `utils/ui_cache.py` | `src/utils/uiCache.ts`（检查器阶段移植） |
| `utils/find_helpers.py` | `src/utils/findHelpers.ts` |
| `inspector/models.py` | `src/inspector/models.ts` |
| `inspector/dump.py` | `src/inspector/dump.ts` |
| `inspector/find.py` | `src/inspector/find.ts` |
| `device/adb.py` | `src/device/adb.ts` |
| `device/manager.py` | `src/device/manager.ts` |
| `device/ldplayer.py` | `src/device/ldplayer.ts` |
| `actions/actions.py` | `src/actions/actions.ts` |
| `actions/batch.py` | `src/actions/batch.ts` |
| `damai/selectors.py` | `src/damai/selectors.ts` |
| `damai/actions.py` | `src/damai/actions.ts` |
| `damai/checklist.py` | `src/damai/checklist.ts` |
| `app/profile.py` | `src/app/profile.ts` |
| `app/runner.py` | `src/app/runner.ts` |
| `app/profiles/damai.py` | `src/app/profiles/damai.ts` |
| `app/profiles/maoyan.py` | `src/app/profiles/maoyan.ts` |
| `app/profiles/fliggy.py` | `src/app/profiles/fliggy.ts` |
| `server.py` | `src/server.ts` + `src/cli.ts` |
| `__init__.py` / `__main__.py` | `src/index.ts`（barrel 导出） |
| `tests/*.py` | `tests/*.test.ts` |
| `examples/*.py` | `examples/*.ts` |

## 5. 竞品借鉴第二轮（13 项清单）偏离记录（2026-10-02）

13 项清单与逐项实施状态见
[deep-compare-vs-tickets.md §7.3](../deep-compare-vs-tickets.md)。以下按实施工作组
汇总偏离记录；各项行为细节以源码 TSDoc 与测试为准。逐项状态：item-3/4/5/6/8/9/10/11
已实现，item-1/2/7/12 部分（机制落地、默认关闭或未接线），item-13 为本节与 README 的
文档修正。

### 工作组 A（item-1 UICache / item-2 持久 shell / item-7 行为随机化 / item-9 路径 memo）

- item-1/2：原任务 item-1 说「默认开启」；按实施规格的总体架构决定改为
  **注册表默认空 = 行为与现状逐字节一致，显式 enable 才参与**——
  `enableDeviceUiCache` / `enablePersistentShellForDevice` 均为懒启用 API，
  本轮未在任何生产路径调用（启用点原规划给 checklist / damaiGrab，未落地）。
- item-2：规格测试期望 tap 持久路径 marker 为 `__DMCTS_TAP_n_DONE__`，但 tap 走
  `runShellCommand` 通用单命令，实际产生 CMD 类 marker——按实际协议断言单行一次 write。
- item-2：actions 侧 `runShellCommand` 不显式传 `receiptTimeoutMs=4000`，改由
  `enablePersistentShellForDevice` 的配置默认 4000 控制（dump 写命令段仍显式传 15000）。
- item-2：持久 shell 通道无远端退出码，命令级失败检测为文本启发（回执输出
  `Error`/`Exception` 开头行 → `ADBError`「持久 shell 命令执行失败」）；启发报错不摘
  会话条目，通道级失败（超时/EOF/关闭）才摘除，并由调用方回落一次性 shell 重试一次。
- item-7：对 Python 原版的行为偏离（原版无任何坐标/等待/按压时长随机化）：新增
  `jitterInt`/`jitteredDelayMs`（可注入 rng）与 tap `jitterPx` 抖动、约 20% 按压时长
  roll，**默认全部关闭**（`jitterPx=0` 时命令逐字节不变）；本轮未在抢票热路径启用。
- item-9：dump memo 测试未追加到 `tests/test_optimizations.test.ts`（其文件级
  `vi.mock("../src/inspector/dump")` 会把被测模块换成 vi.fn），新建
  `tests/test_find_cache.test.ts` 用 `vi.importActual` 取真实 `dumpUi`；
  `tests/test_adb.test.ts` 基础设施增加 `clearAdbPathMemo()` 按用例重置模块级 memo。

### 工作组 B（item-3 NTP 双修 / item-10 N1+N2）

- item-3：对 Python 原版的行为偏离（任务明确要求）：checklist 现在把 NTP offset
  **应用**到 `targetUnix`（原版测而不用）；`ntp_sync` 输出保留旧键
  （server/offset_ms/delay_ms/server_unix/queried_at_unix/synced）并新增
  round_trip_ms/uncertainty_ms/interval_low_ms/interval_high_ms/samples/sampled_at_unix；
  `ChecklistResult` 只增不改地新增 ntp_uncertainty_ms/ntp_samples/sale_trigger 三键。
- item-3：**修正清单原文的公式笔误**：`targetUnix += offsetMs/1000` 实施为**减法**
  ——`src/utils/ntp.ts` 约定 `offsetMs = server − local`（正=服务器超前），服务器时刻
  到达 W 时本机钟读到 `W − offsetMs/1000`，与 clock.rs 的 `target − offset − local` 一致。
- item-3：`NtpSampleResult` 增可选 `readonly serverUnix`（additive，`toDict` 键面不变）；
  `querySampled` 最坏时延 3×`ntpTimeoutSec`（默认 15s，原 `asyncQuery` 单次最坏 5s）。
- item-10：去抖门启用（`signalGateDisabled=false`）时 Phase 4 对 **gate 与 timer 两种
  触发一律**传 `openTime: ""`（立即模式），而非原任务字面的仅 gate 触发时——项 3 落地后
  checklist 是唯一时间权威，timer 触发后再按未修正墙钟重睡同样会吞掉 offset 修正；
  `signalGateDisabled=true` 逃生路径保持透传 `openTime`（旧行为逐字保留；该模式下
  offset 修正会被 damaiGrab 内部重睡抵消，已知限制已写入 TSDoc）。
- item-10：门启用时 `damaiGrab` 不再对开票时刻做二次校验（checklist 为唯一时间权威），
  这是 N1 修复的内在语义变化，checklist.ts Phase 3 注释与 TSDoc 已注明。
- 测试适配（约束允许并在此说明）：`tests/test_checklist.test.ts` 原用例的
  `grabMock` 第 6 参断言由具体 openTime 改为 `.toBe("")`（用例同步更名）；
  ntp 桩从 asyncQueryMock 换为 querySampledMock（与真实签名同形）。

### 工作组 C（item-4 重试泵 / item-5 订单已见 / item-6 终止词表 / item-8 验证码）

- item-4：`maxRuntimeSec` 从 Python 原版/上轮的「参数保留未实现」变为**硬停止**
  （deviation 预期内）；库层解构默认 0（不启用），MCP `damai_grab` 默认 600 生效。
  预热/等开票等待可被 deadline 截断：`open_time` 距今超过 `max_runtime_sec` 时到点报
  「已达最大运行时长」走 failed，不再睡到 T0。
- item-4：重试泵保守默认——`maxGrabAttempts=1`（默认不重试、行为与历史一致）、
  `retryIntervalMs=500`、`retryBackoffCapMs=10000`，确定性指数退避 2^(n-1) 封顶，
  **未加 jitter**（简报中的「默认 5 次/300ms/2000ms/带 jitter」被实施规格覆盖，
  也不照搬 tickets 的 100 次上限）。
- item-4：重试每轮从购买按钮重新开始（接受价格弹层重置，未做「¥ 已在场则跳过重开」）；
  「每轮失败摘要」落 logger.warning 与终态 error，未新增 attempt_summaries 字段。
- item-4：关闭"人数太多"弹窗实现为在失败现场已 dump 的元素列表里找
  crowdPopupConfirmButtons 文案并 tap（少一轮设备往返），替换规格「waitForElement
  找按钮」的措辞，语义相同。
- item-5：`order_seen` 仅在 `verifyOrder=true` 时出现于 submitted 结果（false 时键缺席），
  避免与「验证过但未见证据」（false）混淆。
- item-5：post-submit 验证窗口内命中滑块文案不改 status（保持 submitted +
  requires_human_confirmation=true + warning），与提交前 `needs_human_captcha` 语义区分，
  TSDoc 已写明。
- GrabResult 按规格只增 attempts/errorCategory/order_seen 三键。

### 工作组 D（item-11 multi_devices / item-12 凭证持久化）

- item-12：任务文本要求 `notify_send` 新增可选 `token_file` 参数，实施规格明确
  「不得改 server.ts」并把它列为下轮接线项——以规格为准，server.ts 未动、token_file
  参数未加；凭证文件目前仅可经库级 API（saveNotifyCredentials/loadNotifyCredentials）
  使用，三级回落（工具参数 > 环境变量 > 凭证文件）未接线。
- item-12：`redactToken` 取前 2 后 2（规格明确 "ab****yz"），与任务文本「只留前 4 后 4」
  冲突，以规格为准。
- item-12：credentials.ts 规格依赖清单漏列 `../utils/logging`，但规格同时要求 load 用
  logger.warning——故引入该依赖（pino 为现有依赖，无新增 npm 依赖）；load 的权限过宽
  体检在 win32 上整体跳过（Node 在 Windows 伪造 mode 恒 0o666/0o444，检查必误报），
  模块头 TSDoc 注明语义差异；权限体检用异步 `stat` 而非规格文字的 `statSync`（语义
  等价，保持模块全异步）；save/clear 失败抛中文包装错误（满足 §2.1 错误文案中文红线）。
- item-12：更新了 `src/index.ts` barrel（新增 credentials 导出）——规格文件边界未列
  该文件，但硬性约束要求新增导出更新 barrel。
- item-11：examples/multi_devices.ts 删除手工 parseIso/sleep 预热段，按规格的二选一
  分支用 `runChecklist` 的 onPhase/onProgress 回调保留逐设备倒计时展示；结果打印格式
  为自定（examples 无测试基线）；未做真机验证（规格预期：验证 = typecheck + 人工审读）。

### 门禁复核（2026-10-02 文档收尾时实测）

`pnpm typecheck` 退出码 0；`pnpm exec vitest run` 16 个测试文件 274 用例全部通过。
