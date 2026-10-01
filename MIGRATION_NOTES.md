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
   - `_wait_until` 保留末段忙等——最后 200ms 内自旋（spin-wait），不做 sleep；
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
