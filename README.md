# 🎫 damai-mcp-ts

[![TypeScript](https://img.shields.io/badge/typescript-5.9-blue)]()
[![Runtime](https://img.shields.io/badge/bun-%E2%89%A51.2%20%7C%20node%E2%89%A522-green)]()
[![License](https://img.shields.io/badge/license-MIT-yellow)]()
[![MCP](https://img.shields.io/badge/MCP-1.0%2B-purple)](https://modelcontextprotocol.io)

> Android 设备自动化 MCP — 让你的 AI 直接操控手机/模拟器抢大麦 / 猫眼 / 飞猪门票。

大热门场次（¥921 + 0.5 秒开抢）下，**手动抢等于送人头**。本项目用 [Model Context Protocol](https://modelcontextprotocol.io) 把 ADB 操作封装成 30+ 个工具，让 Claude Code / Cursor / 自定义 Agent 都能像人一样操作大麦 APP，关键路径比手快 200~500 ms。

这是 [`damai-mcp`](../damai-mcp/README.md)（Python / asyncio）的 TypeScript 移植版：TypeScript 5.9.3 strict + ESM，运行于 Bun ≥ 1.2（兼容 Node ≥ 22 标准库 API），包管理用 pnpm。

---

## ✨ 核心特性

| | |
|---|---|
| 🪜 **4 层架构** | L1 设备管理 / L2 原子操作 / L3 语义查询 / L4 业务编排 |
| 🚀 **零依赖额外二进制** | 复用本地 `adb`（雷电 / MuMu / SDK 都自带） |
| 🔌 **标准 MCP 协议** | 直接接入 Claude Code / Cursor / Cline / Continue |
| 🧠 **大麦专属** | `damaiGrab()` 一行调用完成"等开票 → 抢档 → 选人 → 提交" |
| 🎯 **NTP 对时生效** | 3 次采样取最小 RTT，offset 修正开票基准（免疫宿主机钟差）并给出 ±ms 误差区间 |
| 🔁 **有界重试泵** | 可重试失败按指数退避整体重抢（默认 1 次＝不重试）；失败自动分类（验证码/会话/售罄/限购/人数太多弹窗），`needs_action` 防重复下单绝不重试；`max_runtime_sec` 硬停止（MCP 默认 600s） |
| 🧾 **订单已见验证** | 提交后只读验证窗口确认订单/收银台证据（`order_seen`），永不降级、永不自动支付 |
| 🙋 **验证码人工接管** | 命中滑块返回 `needs_human_captcha`（区别于 failed），绝不自动过滑块 |
| 🔒 **设备占用互斥** | 同一设备的 grab / checklist / monitor 调用经进程内占用锁互斥，冲突立即报 `DeviceBusyError` |
| ⚙️ **性能开关（默认关）** | per-device UI dump 缓存（UICache）与持久 ADB shell 通道为库级显式启用；未启用零参与，命令逐字节与旧版一致 |
| 📸 **自动截图归档** | 失败时自动存 `damai_shots/` 便于复盘 |
| ⏱️ **毫秒级等待** | 内部用 `setTimeout` 分段 sleep，末段（<200ms）一次精确睡满，不浪费开票瞬间 |
| 🛰️ **只读余票监控** | `damai_monitor_availability` 轮询详情页判定 available / not_on_sale / sold_out / unknown，绝不点击购买、绝不提交订单 |
| 📣 **微信开票通知** | `notify_send` 经 ClawBot 机器人发送文本提醒；超时＝送达状态未知（timeout_unknown），绝不自动重发；token 可经库级 API 存入 0600 凭证文件（MCP 工具的文件回落接线规划中） |

---

## 🚀 30 秒上手

### 1. 安装

```bash
pnpm install
```

### 2. 准备设备（任选其一）

| 设备类型 | ADB 端口 | 优点 |
|---|---|---|
| 雷电模拟器 9 | 127.0.0.1:5555 | 稳定、可多开、免费 |
| MuMu 模拟器 | 127.0.0.1:7555 | 性能好 |
| 真机（USB） | 自动检测 | 最真实 |

启动后确保大麦 APP 已装好并扫码登录。

### 3. 验证连接

```bash
bun run src/cli.ts list-devices
# adb: /usr/local/bin/adb
#   127.0.0.1:5555  device  HUAWEI Pura 70 Pro  1080x2400  EMU
```

### 4. 启动 MCP server（给 Claude Code / Cursor 用）

```bash
bun run src/cli.ts serve
# 或者：pnpm serve
```

然后在 Claude Code 的 `~/.claude/settings.json` 加入：

```json
{
  "mcpServers": {
    "damai": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/damai-mcp-ts/src/cli.ts", "serve"]
    }
  }
}
```

重启 Claude Code，对话框就能看到 30+ 个 `damai__*` 工具。

### 5. 一句话让 AI 帮你抢

> "用 127.0.0.1:5555 这台设备帮我抢 item 1063631004645，第二档，杨安琪的票，17:21 开票"

AI 会自动串联：

```
list_devices  →  damai_check_login  →  damai_open_concert
   ↓ 等待开票
damai_grab    →  失败截图存到 damai_shots/grab_fail_xxx.png
```

---

## 📐 架构（4 层工具）

```
┌─────────────────────────────────────────────────────────┐
│  L4 业务编排  damai_grab, run_checklist, run_profile     │  ← AI 直接用
├─────────────────────────────────────────────────────────┤
│  L3 语义查询  find_text, find_resource_id, find_xpath,   │  ← 用语义操作
│              wait_for_element, dump_ui                   │     UI 而不是坐标
├─────────────────────────────────────────────────────────┤
│  L2 原子操作  tap, swipe, input_text, press_key,          │  ← 调试时用
│              screenshot, scroll, long_press              │
├─────────────────────────────────────────────────────────┤
│  L1 设备管理  list_devices, connect_device,              │  ← 一切的开端
│              device_info, disconnect_device              │
└─────────────────────────────────────────────────────────┘
```

**核心原则**：AI 应该用 L3 语义工具，而不是 L2 坐标工具。大麦改版时坐标会失效，但"立即购买"这 4 个字永远在那里。

各层对应的源码位置：

| 层 | 目录 | 说明 |
|---|---|---|
| L1 | `src/device/` | adb 封装、设备管理器、雷电 console |
| L2 | `src/actions/` | 原子 UI 动作、批量输入 |
| L3 | `src/inspector/` | UI dump、语义查找（XPath 1.0） |
| L4 | `src/damai/`、`src/app/` | 大麦业务编排、抢票 checklist、多 app profile |

---

## 🛠️ 直接调用（不用 MCP）

```ts
// run.ts — bun run run.ts
import { damaiGrab } from "./src/damai/actions";

const result = await damaiGrab(
  "127.0.0.1:5555",       // deviceId
  "1063631004645",        // itemId
  2,                      // priceIndex
  ["杨安琪"],              // viewerNames
  1,                      // ticketNum
  "2026-07-09 17:21:00",  // openTime（按本地时区解析）
  { preheatSeconds: 30 }, // 开票前预热秒数
);
console.log(result);
```

或者命令行：

```bash
bun examples/grab_one_ticket.ts \
    --device 127.0.0.1:5555 \
    --item 1063631004645 \
    --price 2 \
    --viewer "杨安琪" \
    --open "2026-07-09 17:21:00"
```

---

## 🧰 实战示例

### 抢一张票（单设备）

参见 [`examples/grab_one_ticket.ts`](examples/grab_one_ticket.ts)。

### 多账号并发（5 个模拟器）

```bash
bun examples/multi_devices.ts \
    --item 1063631004645 \
    --price 2 \
    --devices 127.0.0.1:5555 127.0.0.1:5557 127.0.0.1:5559 \
    --viewers 杨安琪 张三 李四 \
    --open "2026-07-09 17:21:00"
```

### 当大麦改版时更新选择器

```bash
bun examples/probe_selectors.ts --device 127.0.0.1:5555
# 输出所有可点击元素，更新 src/damai/selectors.ts
```

### 其他示例

| 示例 | 用途 |
|---|---|
| [`examples/mcp_client_demo.ts`](examples/mcp_client_demo.ts) | 从 TS 客户端驱动 MCP server（模拟 Claude Code 的调用方式） |
| [`examples/three_apps_sandbox.ts`](examples/three_apps_sandbox.ts) | 3 台设备 × 3 个 app（大麦/猫眼/飞猪）并发沙盒自检 |
| [`examples/final_e2e_demo.ts`](examples/final_e2e_demo.ts) | L1/L2/L3 全链路端到端演示（启动 app → 找"同意" → 点击 → 截图） |

---

## 🧪 开发

```bash
git clone <repo-url> damai-mcp-ts
cd damai-mcp-ts
pnpm install

# 测试（不需要真机/模拟器）
pnpm test

# 类型检查
pnpm typecheck

# 跑 example
bun examples/grab_one_ticket.ts --device 127.0.0.1:5555 --item TEST
```

📄 从 Python 迁移的完整报告（模块清单、87 条行为偏离记录、独立复核发现与验证结果）见 [docs/migration/migration-report.md](docs/migration/migration-report.md)。

---

## ⚠️ 合规与免责

本项目仅供**学习与研究自动化测试技术**。请遵守：

1. 大麦 / 猫眼 / 飞猪的用户协议
2. 中国《反不正当竞争法》《消费者权益保护法》等法规
3. 抢到的票请在订单生成后 15 分钟内手动完成支付

作者不对因使用本项目造成的任何账号封禁、法律纠纷或经济损失负责。

---

## 🤝 贡献

欢迎 PR！特别是：

- 猫眼 / 飞猪的 L4 业务封装（目前只实现了大麦）
- 滑块验证码自动识别（OpenCV / 打码平台）
- 录制-回放工作流（让你能"录一遍下次自动跑"）
- 新模拟器适配（夜神 / 逍遥 / BlueStacks）

---

## 📜 License

MIT — see [LICENSE](../damai-mcp/LICENSE).
