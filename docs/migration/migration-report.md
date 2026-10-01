# damai-mcp → damai-mcp-ts 迁移报告

> 生成于 2026-10-01，由迁移工作流（run `dwfrun-991cc48e-e8b2-4bf3-8d43-cbd92db676cc`，10 阶段 / 69 步）产出并整理入库。
> 文中原 `damai-ts/` 路径已随项目更名为 `damai-mcp-ts/` 同步更新；包名 / MCP server 名 / CLI 名均为 `damai-mcp-ts`。
> 工具链与保真约定见根目录 [MIGRATION_NOTES.md](../../MIGRATION_NOTES.md)。

## 结论

迁移完成：Python 源码（25 个模块）与 12 个测试文件全部移植到 `damai-mcp-ts/`，`tsc --noEmit` 与 vitest 全绿，Bun 冒烟通过。

## 工具链

- 包管理：pnpm 10.34.5；运行时：Bun 1.2.4（Node 22 API 兼容）；TypeScript 5.9.3（精确锁定）
- MCP：@modelcontextprotocol/sdk + zod；XML/XPath：@xmldom/xmldom + xpath；图像：jimp；日志：pino + pino-roll；CLI：commander；测试：vitest

## 模块清单

| Python | TypeScript |
|---|---|
| utils/errors.py | src/utils/errors.ts |
| utils/logging.py | src/utils/logging.ts |
| utils/retry.py | src/utils/retry.ts |
| utils/ntp.py | src/utils/ntp.ts（设备层阶段移植） |
| utils/ui_cache.py | src/utils/uiCache.ts（检查器阶段移植） |
| utils/find_helpers.py | src/utils/findHelpers.ts |
| inspector/models.py | src/inspector/models.ts |
| inspector/dump.py | src/inspector/dump.ts |
| inspector/find.py | src/inspector/find.ts |
| device/adb.py | src/device/adb.ts |
| device/manager.py | src/device/manager.ts |
| device/ldplayer.py | src/device/ldplayer.ts |
| actions/actions.py | src/actions/actions.ts |
| actions/batch.py | src/actions/batch.ts |
| damai/selectors.py | src/damai/selectors.ts |
| damai/actions.py | src/damai/actions.ts |
| damai/checklist.py | src/damai/checklist.ts |
| app/profile.py | src/app/profile.ts |
| app/runner.py | src/app/runner.ts |
| app/profiles/damai.py | src/app/profiles/damai.ts |
| app/profiles/maoyan.py | src/app/profiles/maoyan.ts |
| app/profiles/fliggy.py | src/app/profiles/fliggy.ts |
| server.py | src/server.ts + src/cli.ts |
| \_\_init\_\_.py / \_\_main\_\_.py | src/index.ts（barrel 导出） |
| tests/*.py | tests/*.test.ts |
| examples/*.py | examples/*.ts |

## 行为偏离记录（87 条，均为有意决定）

- ntp.query 由 Python 的同步 socket 改为 node:dgram 异步实现（Node 无同步 UDP API，网络收发天然事件驱动），async_query 保留为同实现的别名入口；Python 侧 query 仅被测试与 CLI 快速模式使用，server.py 只依赖 async_query/fetch_device_time，不受影响
- fetch_device_time 按迁移约定第 6 条修复 Python 原版 import 不存在 run_adb 的 bug，改为调用 adb("shell","date","+%s",…,{check:false})——check:false 使非零退出码走原有的 returncode!=0→null 分支而非抛异常
- Python 内建 TimeoutError/ConnectionError 在 TS 无对应类型，改为 Error 并设 name="TimeoutError"/"ConnectionError"，str(err) 与 Python 的 `<Name>: <msg>` 形态逐字一致（已实测 Node 22 无全局 TimeoutError 类）
- adb 命令超时按迁移指示用 AbortSignal + spawn signal 实现，abort（SIGTERM）后在异常路径补 child.kill("SIGKILL") 确保子进程死亡——Python 版 asyncio.wait_for 取消后并不杀进程（已知泄漏），此为按指示的改进
- 子进程被信号杀死时 returncode 映射为 -(信号编号)（对应 Python 子进程的负 returncode 语义；Node close 事件只提供 (null, signal)）
- 无 input_data 时子进程 stdin 沿用父进程 fd（对应 Python stdin=None 继承语义）；Bun 1.2 下该模式会打印 fd0 ReadStream 的 MaxListeners 警告，实测 Node 22 下 stdin 监听器 0→0 不累积，判定为 Bun 运行时噪音
- DeviceManager 的 asyncio.Lock 未移植：它只保护的两步缓存写入在 JS 单线程模型下本身原子，语义等价；并发 list_devices 可能重复执行 adb 调用，与 Python 版一致
- DeviceManager 构造函数改为 private（Python 版可直接构造）：全仓调用点只有 DeviceManager.shared()，据此收紧单例语义
- to_dict 等对外 dict 保持 snake_case 键名，其中 round(x,2) 以 Math.round 近似 Python 银行家舍入（半值场景可能差 0.01，仅影响展示）
- Python 版 check 失败且输出为纯空白时 strip().splitlines()[-1] 会 IndexError 崩溃，TS 版此时 snippet 为空串（仅极端边沿）
- adb/shell 的 Python *args+kwargs 签名移植为「可变 string 参数 + 可选末尾选项对象」（如 adb("devices","-l",{check:false})），调用形态与 Python 调用点一一对应
- NTP 私有纯函数按 TS 命名约定去下划线导出（buildRequest/parseTransmitTs/ntpSecsToUnix），供测试移植与上层复用
- launchInstance 返回 dict、DeviceInfo/NtpResult.toDict 的键名保持 snake_case 原样（MCP 对外表面的行为保真）
- 真实 NTP UDP 查询因本环境网络隔离未能验证（冒烟测试 SKIP，错误路径的 3s 超时行为与错误消息格式已实测），协议按 48 字节包格式移植且纯函数已验证
- find.py 的 \_is_list_predicate（inspect.signature 反射注解的 hack）改为显式判别联合 FindPredicate（kind:"element" 按元素 / kind:"list" 按列表）——任务指定的允许偏离
- find.py 的 parse_bounds_str 与 models.parse_bounds 完全同义（同正则、同 [0,0,0,0] 回退），TS 版直接复用 models.ts 已有的 parseBounds，不再重复导出
- XML 解析用 @xmldom/xmldom + onErrorStopParsing（error/fatalError 抛 ParseError）近似 lxml fromstring 的严格语义；@xmldom 默认 onError 只 console.error 后继续、会产出残缺树，与 lxml 不同，故显式收紧
- dump 失败消息里的 {dump_out!r} 用 JSON.stringify 近似 Python repr（引号风格单双引号差异，内容一致）
- dump_ui_to_file 的重序列化用 @xmldom 构建 + 手写 ElementTree 风格声明行 <?xml version='1.0' encoding='utf-8'?>，属性顺序与 Python ET 输出一致，中文以字面 UTF-8 写出（已冒烟验证）
- ui_cache 的 asyncio.Lock 改为手写 Promise 链互斥 AsyncMutex（任务指定方案；串行化、异常透传、不阻塞后续排队者的语义与 asyncio.Lock 一致，已冒烟验证）
- XPath 命中结果为属性/文本/标量时抛中文 TypeError 并被 waitFor 捕获记入 last_error 继续轮询，对应 Python 版 .get 抛 AttributeError 的同一控制流（异常类型名不同，轮询语义一致）
- Python find_by_text 的 docstring 声称匹配 resource-id 但实现 \_matches_text 只匹配 text/content_desc，TSDoc 按实现忠实描述（不含 resource-id），调用行为与 Python 逐字一致
- \_resize_png 的 Pillow 缩放管线（bicubic 重采样 + reducing_gap 两步 reduce）改用 jimp 默认插值实现，PNG 输出与 Pillow 不逐字节一致；缩放后尺寸算法已按本机 Pillow 11.3.0 实测对齐（等比、floor 取整、最小 1px、图像已在 max_size 内时绝不放大，5 组用例全部吻合）。
- screenshot 的 save_path 参数类型由 str \| Path 收窄为 string（Node 无 Path 对象），文件写入由 Python 同步 write_bytes 改为 fs/promises.writeFile 异步写（函数本为 async，完成时序等价）。
- scroll 解析失败时错误信息中 Python 的 {size_str!r}（repr 带单引号）改为直接内插原始字符串，中文报错原文「无法获取屏幕分辨率: 」保持不变。
- max_size 高度为 0 时 Python 会抛 ZeroDivisionError，TS 版不抛、退化为按最小 1px 缩放（x/y 为 NaN/Infinity 的自然结果）。
- 基座 utils/retry.ts 的 RetryableErrorClass（abstract new (...args: unknown[]) => Error）与具体错误类构造器在 strictFunctionTypes 逆变下不可赋值（连其自身 docstring 示例 exceptions: [ADBError] 都无法通过类型检查），actions.ts 以局部 as unknown as 做类型桥接，运行时 instanceof 重试判定、次数与退避语义与 Python 完全一致；建议基座把构造签名参数放宽为 any[]。
- 对并行设备层 adb.ts 的调用按其已落盘的真实签名对齐（变参 + 末尾 AdbOptions/ShellOptions 选项对象，ADBResult.stdoutBytes/returncode 字段），已用真实文件通过 strict 编译，无接口偏离。
- checklist.py:242 的 dump_ui(device_id, refresh=True) 中 refresh 参数在 Python 全源码中不存在（调用即 TypeError、被 except 吞掉导致预热实际空转），按该阶段注释的意图迁移为并行 dumpUi×2 + screenshot×1，用 Promise.allSettled 对应 gather(return_exceptions=True) 的吞错语义。
- damai_grab 里 loguru 专属的 logger.success 在 TS 日志封装（pino，无 success 级别）中不存在，改为 logger.info，消息原文不变。
- logger.exception（loguru 带堆栈）在 countdownLoop 与 \_safe_cb 两处改为 logger.error 并把异常信息附在消息尾部（与 utils/retry.ts 既有风格一致）。
- Python 的函数内惰性 import（dump_ui / screenshot / DeviceManager / async_query）统一改为模块顶层 import（ESM 无等价的运行时惰性语义，测试改用模块 mock 替代 monkeypatch）。
- \_wait_until 的「末段忙等」按 Python 原版的实际实现迁移：remaining < 0.2s 时一次睡满剩余时间即返回、更长等待按 pollMs 分段且始终预留最后 100ms——原版并非自旋循环，未引入真正的忙等。
- strptime / fromisoformat 用手写正则 + Date 六参（setFullYear/setHours）复刻：范围非法的错误文案复刻 Python ValueError 形态；ISO 分支按 Python 3.10 fromisoformat 严格性（分量固定 2 位、小数恰 3/6 位、偏移 +HH:MM 且严格小于 24h），偏移一律丢弃、按字面墙钟分量取本地时间（约定第 3 条）；亚毫秒精度截断到毫秒（Python 保留微秒）。
- Python 返回的 dict（LoginCheckResult / OpenConcertResult / GrabResult）用 snake_case 键的 type alias 表达以保持 MCP 对外表面，而 PhaseEvent / ChecklistResult 的字段 camelCase 化、toDict() 输出保持 snake_case——与库内 DeviceInfo / NtpResult 既有模式一致。
- checklist 倒计时阶段 Python 的 except asyncio.CancelledError 分支省略（JS 侧 sleep 未接 AbortSignal、正常路径不会中途抛出），代码内已注释说明。
- 观演人列表在「⏰ 开票」日志里按 Python f-string 的 list repr 形态渲染（pyListRepr 辅助函数），而非 JS 默认的数组 String() 输出。
- 修复 Python runner.py 引用不存在的 run_adb（device/adb.py 只有 adb/shell，全项目亦无定义，已用 git log -S 确认）：两处改为调用正确的 adb 封装，与 ntp.ts 对同类问题的处理一致。
- \_action_open_detail 的 adb 调用保持 check=true（默认），使 am start 失败抛 ADBError 后落入 Python 原版写明的 monkey 兜底分支。
- \_action_tap_index 的 adb 调用传 check=false，让非零退出码走原版写明的 returncode != 0 → RuntimeError("uiautomator dump failed: …") 分支而非提前抛异常。
- 修复 dump_ui(device_id, refresh=True)：Python 的 dump_ui 签名并无 refresh 参数（调用即 TypeError），改为标准 dumpUi(deviceId)。
- load_profile 由同步函数改为 async（返回 Promise）：ESM 惰性加载原语是 import()，以此表达 Python 函数级 import 的『内置项按需注册 + 避免循环依赖 TDZ』语义。
- \_load_builtins_once 的『模块导入即预热注册』改为模块底部的 fire-and-forget 动态导入，注册在本模块求值完成后的微任务生效；导入后立刻同步调用 listProfiles() 理论上可能短暂看到空注册表（异步 loadProfile 分支会兜底补注册，registerBuiltins 幂等）。
- 额外创建 profiles/index.ts（Python app/profiles/\_\_init\_\_.py 的对应物，含 registerBuiltins）：它是 profile.ts 惰性注册的硬依赖，非占位 stub。
- 未创建 app/index.ts（Python app/\_\_init\_\_.py 的 barrel）：不在分配的 5 个文件内，避免越界，下游可直接从 ./profile、./runner、./profiles/index 具名导入。
- load_profile_file 由同步 Path.read_text 改为 async fs/promises readFile，与代码库整体异步风格一致。
- load_profile_file 对畸形输入（缺 name/package_name、未知字段、steps 非数组）的报错文案改为中文直述；Python 原版是 dataclass \_\_init\_\_ 的 TypeError/KeyError 英文文案。
- 缺失键的行为保持 KeyError 语义：step 缺 name/action 抛 Error("'name'")，str 后与 Python KeyError 的 str 形态逐字一致。
- step.args 的 text/label 必需参数：Python 鸭子类型（非字符串要等到具体操作才报错），TS 前置 typeof 校验抛 TypeError（同样失败但更早，报错文案为新增）。
- exact/index/seconds/delay_ms 参数桥接了 Python 真值与 int()/float() 截断语义（Boolean()/Math.trunc/正则整数串），无法转换时复刻 Python 的 ValueError 文案。
- 保留 Python 原版 continue_on_fail 失败路径重复 append 同一 StepResult 的行为（runner.py:229 与 236），失败的 continue_on_fail 步骤在 RunResult.steps 中出现两次（冒烟测试已验证）。
- 保留 Action 联合类型仅 8 个成员（Python Literal 不含 input_text），而分发表为 string 键 dict、input_text 可执行——复刻 Python 的类型/运行时不一致；screenshot 同样未注册处理器，执行走 unknown action 分支。
- StepResult.output 经 JSON 序列化时整数浮点无法表达 ".0"（如 slept_sec: 1.0 输出为 1），系 JS number 序列化的固有限制。
- pyRepr 复刻 Python repr 的引号选择与常见转义（\n \r \t 反斜杠 引号），未实现冷僻控制字符的 \x.. 转义。
- 运行时验证：限定范围 tsc 检查（bun ./node_modules/.bin/tsc -p /tmp/damai-app-check.json，仅含本 6 文件及其已就绪依赖，exit 0）与 Bun 1.2.4 冒烟测试通过（注册表惰性+预热注册、override 语义、错误文案、JSON 加载往返、runner 分发/continue_on_fail/状态机均符合 Python 原版行为）。
- TS SDK 的 Protocol.connect 拒绝单实例多 transport，server.ts 额外导出 createMcpServer() 工厂，streamable-http/sse 每会话各建一实例（Python FastMCP 为单实例多会话），模块级 mcp 单例保持与 Python 对等。
- outputSchema 用 z.object({}).passthrough() 表达 Python 注解 dict[str, Any] 对应的 {"type":"object"}：SDK 的 normalizeObjectSchema 不接受 ZodRecord（实测返回 undefined 导致 isZ4Schema(undefined) 崩溃），passthrough 保证校验不丢字段。
- 无参工具 list_app_profiles 不声明 inputSchema（SDK 对空 shape 的规范化同样返回 undefined 会崩，Python 为无参签名）。
- 工具结果的 JSON 文本 content 用 JSON.stringify（紧凑格式），Python FastMCP 对 dict 的 json.dumps 间距未能本机对照（环境未安装 Python mcp 包）；structuredContent 与 text 两侧均有，返回 dict 的 snake_case 键逐字段保持。
- streamable-http/sse 的 HTTP 承载用手写 node:http（Python 为 uvicorn/FastMCP.run）；streamable-http 已完成 initialize→tools/list→tools/call 全链路实测，sse 按同构模式实现，但本机 Bun 1.2.4 的 node:http SSE 流冲刷有运行时缺陷（10 行最小复现即失败、Node 22 相同代码正常），无法在本机完成 sse 线上验证，已如实上报。
- argparse 子命令的 help=（父 help 摘要）与 description=（子命令 help 正文）两段文案映射为 commander 的 summary()/description()，app-grab/grab 的描述文案保持中文原文。
- ESM 无 \_\_main\_\_ 等价物，cli.ts 底部用 import.meta.url 与 pathToFileURL(argv[1]) 比对实现「仅直接执行时运行 main」，被 index.ts 导入时不触发。
- 版本常量 VERSION 定义在 server.ts 并由 index.ts 再导出（Python 定义在 \_\_init\_\_.py），避免 cli↔index 循环导入。
- app_grab 的 options 为无类型 dict，open_time 经 String() 宽松转换后传入（Python 直接透传、失败推迟到 strptime）；price_index/ticket_num/preheat_seconds 等按 Python int()/float()/list() 语义实现 pyIntCast/pyFloatCast/pyListCast，select_checkbox 的 viewer_names 回退分支复刻 Python obj[0] 下标语义。
- ntp_sync 的 device_offset_ms 舍入用 Math.round(x*100)/100，与 Python round(x,2) 的银行家舍入在半值边界有差异（仅影响显示，与既有 ntp.ts 的决定一致）。
- press_key/scroll 的 MCP 入参为宽泛 string，对 KeyName/ScrollDirection 做类型桥接 cast，未知键名/非法方向的运行时报错路径与 Python 一致。
- input_text 的 input_len 用 JS .length（UTF-16 计数；BMP 内含常用 CJK 与 Python 码点计数一致，未做码点换算）。
- list-devices 在找不到 adb 时输出 "adb: None"（复刻 Python f-string 对 None 的渲染）。
- damai_grab_multi 的并发收集用 Promise.allSettled 等价 asyncio.gather(return_exceptions=True)（保序），accounts 缺 device_id 时在派发前抛 Error("'device_id'") 复刻 Python 推导式求值期的 KeyError；该工具与 app-grab CLI 的 damai 分支均不传 confirm_order，默认 false，永不自动点击支付。
- serve 的 --transport 用 commander Option.choices([stdio, streamable-http, sse])，默认 stdio；--port/--price/--num 用 argparse 同文案的 int 校验、--timeout/--preheat 用 float 校验。
- package.json 在 ask 要求的字段之外追加了 description 字段（沿用 pyproject.toml 的项目描述，便于 npm 侧识别）
- @modelcontextprotocol/sdk 依赖写为 ^1.30.0（通过 pnpm view 实查 npm registry 得到的最新 1.x 版本，符合 ask 的"最新 1.x"要求）
- tsconfig.json 仅含 ask 列出的 7 个 compilerOptions，未加 include/files 字段——骨架阶段 src 下暂无 .ts，此时跑 pnpm typecheck 会报 TS18003，待业务模块落地后消失
- src 下未创建任何业务 .ts（含未建 src/index.ts 占位），barrel 与 server/cli 留给对应阶段代理
- retry 装饰器改为主接口 withRetry(fn, options)，另提供柯里化 retry(options)(fn) 以保留 Python @retry(...) 的调用顺序
- logging 用单个 pino 实例 + 自定义调度流实现 loguru 多 sink：logger 身份恒定，configure() 原地更新 sink 状态（Python 是 logger.remove() 后重加）
- loguru 彩色行格式改为自实现格式化器（pino 默认 JSON 行不适合人类阅读），格式复刻 \_DEFAULT_FMT 且沿用 colorize=True 语义（重定向时也输出 ANSI）
- 格式中 caller(name:function:line) 段通过包装 logger 级别方法并解析 Error.stack 捕获（pino 无内建调用方捕获），{name} 用源文件名去扩展名近似 loguru 的完整模块名
- retention="7 days" 用 pino-roll 的 limit:{count:7, removeOtherLogFiles:true} 近似（pino-roll 不支持按时间保留），文件名由 damai_mcp_{YYYYMMDD}.log 变为 pino-roll 固有的 damai_mcp.<yyyyMMdd>.<序号>.log，并额外增加按天 frequency 轮转（Python 仅按 20MB 大小轮转）
- logging.configure 改为 async（pino-roll 建流是异步的），非法级别抛中文 Error("无效的日志级别: ...")（Python 侧是 loguru 自身的英文 ValueError）
- logger 增加 warning 别名方法（pino 叫 warn），方便下游按 loguru 命名机械翻译；文件流就绪前的日志行先缓冲（上限 1 万行），对应 loguru enqueue=True 的队列语义
- UIElement dataclass 改为 readonly class，构造器收单个 options 对象；toDict() 输出键保持 Python 的 snake_case 原样（它是 MCP 工具响应的对外表面）
- Python \_\_repr\_\_ 映射为 toString()，label 用单引号包裹近似 !r；错误基类构造器接受可选 ErrorOptions.cause 承载 raise ... from exc 语义
- search_elements 的 lxml ElementTree 换成 @xmldom/xmldom + xpath（标准 XPath 1.0）；两者 DOM 类型不兼容处用 as unknown as Node 适配
- Python \_pack 因 getattr(el, "class") 取不到属性导致 class 属性从不打包、str(bool) 产出 True/False，两处 quirk 均按原样复刻并注释（避免 @class XPath 查询结果与 Python 版出现差异）
- \_unpack 遇到非元素 XPath 结果（属性/文本/标量）时 Python 会因缺少 .get 抛 AttributeError，TS 改为显式抛 TypeError（中文消息）；search_elements 无筛选条件仍抛普通 Error，消息原文 "must supply one of text/resource_id/xpath" 保留未译
- parse_bounds 返回 readonly 四元组（对应 Python tuple），正则仅锚定开头以复刻 re.match 语义；f-string 布尔/数字序列化行为在打包时用 pythonStr 复刻

## 独立复核发现

- [medium] damai-mcp/src/damai_mcp/damai/checklist.py:241-247 ↔ damai-mcp-ts/src/damai/checklist.ts:470-484：checklist 的 preheat_warm_dump 阶段：Python 版因调用不存在的 `dump_ui(refresh=True)` 触发 TypeError，整个 gather 被吞掉、实际不执行任何 dump/截屏；TS 版真实执行 2 次 dumpUi + 1 次 screenshot。（处置：复核确认无需改动，见文末「未修」①）
- [medium] damai-mcp/src/damai_mcp/utils/ntp.py:145-156 ↔ damai-mcp-ts/src/utils/ntp.ts:249-261：ntp_sync 工具带 device_id / CLI `ntp-sync --device`：Python 版 fetch_device_time 引用不存在的 run_adb，调用必抛 ImportError（工具报错）；TS 版正常工作并返回 device_unix / device_offset_ms。（处置：复核确认无需改动，见文末「未修」②）
- [medium] damai-mcp/src/damai_mcp/app/runner.py:98,135-145 ↔ damai-mcp-ts/src/app/runner.ts:194-219,258-284：app/runner 的 open_detail 与 tap_index 动作：Python 版因引用不存在的 run_adb（及 dump_ui(refresh=True) 的 TypeError）这两个 step 必然失败；TS 版可正常执行。（处置：复核确认无需改动，见文末「未修」③）
- [low] damai-mcp/src/damai_mcp/device/adb.py:112-118 ↔ damai-mcp-ts/src/device/adb.ts:295-340：adb 命令超时后的子进程处置：Python 版 asyncio.wait_for 取消 communicate 但不杀进程（子进程泄漏、继续运行）；TS 版 abort 时发 SIGTERM 并补 SIGKILL 确保子进程死亡。（处置：记录在案，未改动）
- [low] damai-mcp-ts/src/inspector/find.ts:41,60,114 ↔ damai-mcp/src/damai_mcp/inspector/find.py:35,54,102；damai-mcp-ts/src/inspector/dump.ts:91 ↔ dump.py:37：查找超时/失败错误消息中的描述串引号风格：Python 用 repr（单引号，如 text='立即购买'），TS 用 JSON.stringify（双引号，含内嵌引号时转义为 \"），错误文案不逐字一致。（处置：记录在案，未改动）
- [low] damai-mcp/src/damai_mcp/damai/actions.py:213,230-232 ↔ damai-mcp-ts/src/damai/actions.ts:377,409-411：damai_select_viewers 的未点满超时路径：Python 版 clicked 在 while 循环内定义，若 timeout<=0 循环体从未执行，raise 语句引用未绑定变量直接 NameError；TS 版在循环外初始化 clicked=[]，正常抛出 DamaiGrabFailedError。（处置：记录在案，未改动）
- [low] damai-mcp/src/damai_mcp/damai/actions.py:339 ↔ damai-mcp-ts/src/damai/actions.ts:534：开票瞬间的日志级别：Python 用 loguru 专属的 logger.success（显示为 SUCCESS 级别）；TS 无对应级别，降为 logger.info（显示为 INFO）。（处置：记录在案，未改动）
- [low] damai-mcp/src/damai_mcp/utils/ntp.py:87-99 ↔ damai-mcp-ts/src/utils/ntp.ts:117-121,193-194：NTP 错误的异常类型：Python 抛内建 TimeoutError / ConnectionError / RuntimeError；TS 抛设置 err.name 的普通 Error（无对应内建类型可 instanceof）。（处置：记录在案，未改动）

### 未修说明（修复工程师逐条处置结论）

1. checklist preheat_warm_dump 差异不修（TS 真执行 2×dumpUi+1×screenshot）：这是 MIGRATION_NOTES.md §2.4「保留 preheat_warm_dump 并行预热语义」与 Python 阶段注释声明的意图（checklist.py:231-234）所要求的，且偏离已在 checklist.ts:472-474 注释显式记录；复刻 Python 侧 TypeError 被吞后的零设备活动反而违反保真约定（dump.py:21 确无 refresh 参数已核实）。
2. ntp fetch_device_time 差异不修：MIGRATION_NOTES.md §2.6 明文要求 TS 版改为调用正确的 adb 封装（run_adb 不存在属已记录的 Python 侧 bug，adb.py:153 \_\_all\_\_ 已核实无 run_adb），ntp.ts:242-246 TSDoc 已声明该修复且 check:false 精确对应 Python 的 returncode!=0→null 分支，无需改动。
3. runner open_detail/tap_index 差异不修：与 §2.6 同类的 Python 已知 bug（runner.py:98/135 引用不存在的 run_adb 且 import 位于 try 之前、runner.py:145 的 dump_ui(refresh=True) 系 TypeError），runner.ts:189-192 与 :249-257 TSDoc 已逐条声明修复，实现保持 Python 的 try am start→except→monkey 兜底结构与原错误文案——证据已核实，无需改动。

## 测试迁移中的跳过项

- 无用例被跳过：Python test_damai.py 9 条、test_checklist.py 12 条、test_server.py 8 条共 29 条全部迁移，与 TS 侧 9+12+8=29 条一一对应（含 round-trip 参数化 2 条拆为 it.each 两条）。
- 按批次要求记录 test_server 的测法取舍：未用 SDK InMemoryTransport 内存直连，而是直接读取 McpServer 内部注册表 mcp.\_registeredTools（与 Python 直接内省 mcp.\_tool_manager.\_tools 同构，更简单）；mcp.name 对应读取底层 Server 私有 \_serverInfo.name。
- tests/helpers.ts 已由并发的 conftest 批次创建并归属该批次，本批次未改动；本批次三个 Python 测试文件不依赖 conftest.py 的任何 fixture（它只做 sys.path 注入，TS 侧相对导入无需等价物），故共享辅助内联在各测试文件。

## 验证

- pnpm -C damai-mcp-ts install：退出码 0（骨架阶段）
- pnpm -C damai-mcp-ts typecheck（tsc 5.9.3 --noEmit）：退出码 0
- pnpm -C damai-mcp-ts test（vitest）：退出码 0，共迁移 105 个用例（A 批 32 + B 批 44 + C 批 29）
- bun -e import src/server.ts：模块加载成功，顶层无副作用
- 复核处置后重跑 typecheck + test：退出码 0

## 未覆盖

- 真机/模拟器端到端流程未运行（本机无 ADB 设备），业务层正确性由单元测试与代码比对保证
- 未跑完整的 MCP stdio 会话（Bun 冒烟仅验证模块可加载、无顶层副作用）
- jimp 与 Pillow 的缩放像素级差异未逐像素比对（仅验证功能等价）
