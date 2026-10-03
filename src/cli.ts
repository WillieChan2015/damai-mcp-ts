#!/usr/bin/env bun
/**
 * FastMCP server entry — registers all tools from all layers.
 *
 * Run via:
 *     python -m damai_mcp                # stdio transport (default for Claude Code)
 *     damai-mcp-ts serve --transport http   # HTTP transport
 *
 * （Python `server.main()` 的 TS 对应物：commander 复刻 argparse 的
 *  serve / grab / list-devices / list-profiles / app-grab / ntp-sync / version
 *  全部子命令与参数。可直接 `bun src/cli.ts ...` 执行。）
 */

import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Command, InvalidArgumentError, Option } from "commander";

import { listProfiles, loadProfile, pyRepr } from "./app/profile";
import { runProfile } from "./app/runner";
import { damaiGrab } from "./damai/actions";
import { runChecklist } from "./damai/checklist";
import { whichAdb } from "./device/adb";
import { DeviceManager } from "./device/manager";
import { VERSION, createMcpServer, mcp } from "./server";
import { configure as configureLogging, logger } from "./utils/logging";
import { asyncQuery, fetchDeviceTime } from "./utils/ntp";

// ============================================================================
// CLI entry
// ============================================================================

/** argparse 顶层 --help 用的描述（对应 Python `description=__doc__`）。 */
const CLI_DESCRIPTION =
  "FastMCP server entry — registers all tools from all layers.\n" +
  "\n" +
  "Run via:\n" +
  "    python -m damai_mcp                # stdio transport (default for Claude Code)\n" +
  "    damai-mcp-ts serve --transport http   # HTTP transport";

/** 对应 argparse `type=int`（报错文案与 Python argparse 一致）。 */
function pyIntArg(value: string): number {
  if (!/^[+-]?\d+$/.test(value.trim())) {
    throw new InvalidArgumentError(`invalid int value: '${value}'`);
  }
  return parseInt(value.trim(), 10);
}

/** 对应 argparse `type=float`（报错文案与 Python argparse 一致）。 */
function pyFloatArg(value: string): number {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value.trim())) {
    throw new InvalidArgumentError(`invalid float value: '${value}'`);
  }
  return Number(value.trim());
}

/** 对应 argparse `action="append"`。 */
function appendArg(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * CLI entry point registered as `damai-mcp-ts`.
 *
 * 对应 Python `main()`；返回 Promise（asyncio.run 的等价物就是直接 await）。
 */
export async function main(): Promise<void> {
  const program = new Command();
  program.name("damai-mcp-ts").description(CLI_DESCRIPTION);
  program.option("--log-level <level>", "DEBUG/INFO/WARNING/ERROR", "INFO");
  program.option("--log-dir <dir>", "日志目录", "./logs");

  // 对应 Python `configure_logging(...)`：解析成功后、任何子命令执行前运行
  program.hook("preAction", async (thisCommand) => {
    const opts = thisCommand.opts<{ logLevel: string; logDir: string }>();
    await configureLogging(opts.logLevel, opts.logDir);
  });

  const serveP = program.command("serve").description("启动 MCP server");
  serveP.addOption(
    new Option("--transport <transport>", "stdio | streamable-http | sse")
      .choices(["stdio", "streamable-http", "sse"])
      .default("stdio"),
  );
  serveP.option("--host <host>", "", "127.0.0.1");
  serveP.option("--port <port>", "", pyIntArg, 8765);
  serveP.action(async (opts) => {
    await cmdServe(opts.transport, opts.host, opts.port);
  });

  program
    .command("list-devices")
    .description("列出连接的设备（一次性）")
    .action(async () => {
      await cmdListDevices();
    });

  program
    .command("version")
    .description("打印版本")
    .action(async () => {
      console.log(`damai-mcp-ts ${VERSION}`);
    });

  // CLI: web（可视化控制台，Next.js 16 全栈应用位于仓库根 web/，
  // 计划见 docs/plans/web-console-plan.md）
  const webP = program
    .command("web")
    .description("启动可视化控制台（默认仅绑定本机 127.0.0.1）");
  webP.addOption(
    new Option("--mode <mode>", "dev | start")
      .choices(["dev", "start"])
      .default("start"),
  );
  webP.option("--host <host>", "绑定地址（默认仅本机）", "127.0.0.1");
  webP.option("--port <port>", "端口", pyIntArg, 3000);
  webP.option(
    "--token <token>",
    "访问 token（--host 为非回环地址时必填；回环绑定缺省自动生成并打印）",
  );
  webP.action(async (opts) => {
    await cmdWeb(opts.mode, opts.host, opts.port, opts.token);
  });

  // CLI: ntp-sync
  const ntpP = program
    .command("ntp-sync")
    .description("NTP 时钟同步 (打印 offset_ms)");
  ntpP.option("--server <server>", "", "pool.ntp.org");
  ntpP.option("--timeout <timeout>", "", pyFloatArg, 5.0);
  ntpP.option("--device <device>", "同时校验设备时间");
  ntpP.action(async (opts) => {
    await cmdNtpSync(opts.server, opts.timeout, opts.device);
  });

  // CLI: list-profiles
  program
    .command("list-profiles")
    .description("列出所有支持的 app profile")
    .action(async () => {
      await cmdListProfiles();
    });

  // CLI: app-grab（argparse：help= 是父 help 里的摘要，description= 是子命令 help 正文）
  const appP = program
    .command("app-grab")
    .summary("通用多网站抢票执行器")
    .description(
      "用任意 profile 抢该网站的票。damai 走专用流程；其他走 step runner。",
    );
  appP.requiredOption("--device <device>");
  appP.requiredOption("--profile <profile>", "profile 名（先 list-profiles）");
  appP.requiredOption("--item-id <item-id>");
  appP.option(
    "--option <option>",
    "profile 选项 (k=v，可多次)，如 --option price_index=1 --option viewer_names=张三",
    appendArg,
    [],
  );
  appP.action(async (opts) => {
    await cmdAppGrab(opts.device, opts.profile, opts.itemId, opts.option);
  });

  // CLI: 抢票当天 checklist（argparse：help= 是父 help 里的摘要，description= 是子命令 help 正文）
  const grabP = program
    .command("grab")
    .summary("抢票当天一键 checklist（推荐）")
    .description(
      "一条命令跑完：设备检查 → 登录验证 → 详情页预热 → 倒计时 → 开票抢票。" +
        "适合开票前 5 分钟执行，自动候场等开票。",
    );
  grabP.requiredOption("--device <device>", "设备 ID，如 127.0.0.1:5555");
  grabP.requiredOption("--item-id <item-id>", "大麦 item id");
  grabP.option(
    "--open-time <open-time>",
    "开票时间 'YYYY-MM-DD HH:MM:SS'，空=立即抢",
    "",
  );
  grabP.option("--price <price>", "票档序号（1-based）", pyIntArg, 1);
  grabP.option("--viewer <viewer>", "观演人姓名（可多次 --viewer 张三）", appendArg, []);
  grabP.option("--num <num>", "张数", pyIntArg, 1);
  grabP.option("--preheat <preheat>", "开票前预热秒数（默认 30）", pyFloatArg, 30.0);
  grabP.action(async (opts) => {
    await cmdGrab(opts);
  });

  await program.parseAsync();
}

// ---- serve -------------------------------------------------------------------

/**
 * serve 子命令：stdio 直连；streamable-http / sse 起本地 HTTP 服务。
 *
 * TS SDK 的 Protocol 不允许单实例多 transport，因此 HTTP 模式下每个会话
 * 各建一个 server 实例（工具注册集合与 stdio 完全一致）。
 */
async function cmdServe(
  transport: "stdio" | "streamable-http" | "sse",
  host: string,
  port: number,
): Promise<void> {
  if (transport === "stdio") {
    await mcp.connect(new StdioServerTransport());
    return;
  }
  logger.info(`damai-mcp-ts serving on http://${host}:${port} (${transport})`);
  const httpServer = createServer();
  if (transport === "streamable-http") {
    // 有状态会话：initialize 建 session，后续请求按 mcp-session-id 头路由
    const sessions = new Map<string, StreamableHTTPServerTransport>();
    httpServer.on("request", (req, res) => {
      void handleStreamableHttp(req, res, sessions).catch((exc) => {
        logger.error(`streamable-http 请求处理失败: ${excToStr(exc)}`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
        }
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }),
        );
      });
    });
    await listen(httpServer, host, port);
    return;
  }

  // sse：GET /sse 建立事件流，POST /messages?session_id=... 投递消息
  const sseTransports = new Map<string, SSEServerTransport>();
  httpServer.on("request", (req, res) => {
    void handleSse(req, res, sseTransports).catch((exc) => {
      logger.error(`sse 请求处理失败: ${excToStr(exc)}`);
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    });
  });
  await listen(httpServer, host, port);
}

async function handleStreamableHttp(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: Map<string, StreamableHTTPServerTransport>,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== "/mcp") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(notFoundBody());
    return;
  }
  const sessionId = req.headers["mcp-session-id"];
  const existing =
    typeof sessionId === "string" ? sessions.get(sessionId) ?? null : null;
  if (existing) {
    await existing.handleRequest(req, res);
    return;
  }
  if (!sessionId && req.method === "POST") {
    // 新会话：initialize 请求
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // sessionId 在 handleRequest 处理 initialize 时才生成，
      // 必须经此回调注册（connect 时读 sessionId 为时过早）
      onsessioninitialized: (sid) => {
        sessions.set(sid, transport);
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        sessions.delete(sid);
      }
    };
    const server = createMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(notFoundBody());
}

async function handleSse(
  req: IncomingMessage,
  res: ServerResponse,
  sseTransports: Map<string, SSEServerTransport>,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (req.method === "GET" && url.pathname === "/sse") {
    const transport = new SSEServerTransport("/messages", res);
    sseTransports.set(transport.sessionId, transport);
    transport.onclose = () => {
      sseTransports.delete(transport.sessionId);
    };
    const server = createMcpServer();
    // Protocol.connect 内部会调用 transport.start()，此处不能重复调用
    await server.connect(transport);
    return;
  }
  if (req.method === "POST" && url.pathname === "/messages") {
    const sid = url.searchParams.get("sessionId");
    const transport = sid ? sseTransports.get(sid) ?? null : null;
    if (!transport) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(notFoundBody());
      return;
    }
    await transport.handlePostMessage(req, res);
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(notFoundBody());
}

function notFoundBody(): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Session not found" },
    id: null,
  });
}

function listen(httpServer: import("node:http").Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => resolve());
  });
}

// ---- list-devices -------------------------------------------------------------

async function cmdListDevices(): Promise<void> {
  // Python f-string 把 None 渲染为 "None"，此处保持一致
  console.log(`adb: ${whichAdb() ?? "None"}`);
  const devices = await DeviceManager.shared().listDevices(true);
  for (const d of devices) {
    const tag = d.isEmulator ? "EMU" : "DEVICE";
    console.log(`  ${d.deviceId}\t${d.state}\t${d.model}\t${d.screenSize}\t${tag}`);
  }
}

// ---- list-profiles ------------------------------------------------------------

async function cmdListProfiles(): Promise<void> {
  const names = listProfiles();
  console.log(`已注册 ${names.length} 个 profile:`);
  for (const n of names) {
    const p = await loadProfile(n);
    const steps = p.steps.length;
    const hints = p.hints.slice(0, 2);
    console.log(
      `  - ${n.padEnd(10)} (${p.packageName.padEnd(25)}) ${steps} 步 hints=${pyListStr(hints)}`,
    );
  }
}

// ---- ntp-sync -----------------------------------------------------------------

async function cmdNtpSync(
  server: string,
  timeout: number,
  device: string | undefined,
): Promise<void> {
  const result = await asyncQuery(server, timeout);
  console.log(JSON.stringify(result.toDict(), null, 2));
  if (device) {
    const deviceUnix = await fetchDeviceTime(device);
    if (deviceUnix !== null) {
      const deltaMs = (result.serverUnix - deviceUnix) * 1000;
      console.log(`设备 ${device} Unix=${deviceUnix} 偏差 ${signed2(deltaMs)}ms`);
    }
  }
}

// ---- grab ---------------------------------------------------------------------

async function cmdGrab(opts: {
  device: string;
  itemId: string;
  openTime: string;
  price: number;
  viewer: string[];
  num: number;
  preheat: number;
}): Promise<void> {
  const phaseCb = async (name: string): Promise<void> => {
    console.log(`  ▶ ${name}`);
  };

  const progressCb = async (secondsLeft: number, elapsedS: number): Promise<void> => {
    if (secondsLeft > 60) {
      console.log(`  ⏱  开票还有 ${Math.floor(secondsLeft / 60)} 分钟`);
    } else if (secondsLeft > 10) {
      console.log(`  ⏱  开票还有 ${Math.trunc(secondsLeft)}s`);
    } else {
      console.log(`  🚀 开票 ${secondsLeft.toFixed(1)}s！`);
    }
  };

  logger.info(
    `检查清单启动: device=${opts.device} item=${opts.itemId} ` +
      `开票=${opts.openTime || "now"} 票档=${opts.price}`,
  );
  const result = await runChecklist(opts.device, opts.itemId, {
    openTime: opts.openTime,
    priceIndex: opts.price,
    viewerNames: opts.viewer,
    ticketNum: opts.num,
    preheatSeconds: opts.preheat,
    onPhase: phaseCb,
    onProgress: progressCb,
  });
  console.log("\n" + "=".repeat(60));
  console.log(`📋 结果: ${result.status}`);
  if (result.error) {
    console.log(`❌ 错误: ${result.error}`);
  }
  console.log("=".repeat(60));
  console.log(JSON.stringify(result.toDict(), null, 2));
}

// ---- app-grab -----------------------------------------------------------------

async function cmdAppGrab(
  device: string,
  profileName: string,
  itemId: string,
  optionKvs: string[],
): Promise<void> {
  const options: Record<string, unknown> = {};
  for (const kv of optionKvs) {
    if (!kv.includes("=")) {
      console.log(`⚠️  跳过非法 option ${pyRepr(kv)} (需要 k=v)`);
      continue;
    }
    const sep = kv.indexOf("=");
    const k = kv.slice(0, sep);
    const v = kv.slice(sep + 1);
    // try int
    let v2: unknown;
    if (/^[+-]?\d+$/.test(v.trim())) {
      v2 = parseInt(v.trim(), 10);
    } else {
      v2 = v;
    }
    options[k] = v2;
  }
  logger.info(
    `app-grab: profile=${profileName} item=${itemId} options=${pyDictStr(options)}`,
  );
  // Reuse the MCP tool implementation directly (avoids double-async wrapping)
  const profile = await loadProfile(profileName);
  let result: Record<string, unknown>;
  if (profile.name === "damai") {
    const grab = await damaiGrab(
      device,
      itemId,
      pyIntCast(options["price_index"] ?? 1),
      "viewer_label" in options ? [String(options["viewer_label"])] : [],
      pyIntCast(options["ticket_num"] ?? 1),
      options["open_time"] === undefined ? "" : String(options["open_time"]),
      {
        preheatSeconds: pyFloatCast(options["preheat_seconds"] ?? 0.0),
        maxRuntimeSec: pyFloatCast(options["max_runtime_sec"] ?? 60.0),
      },
    );
    result = { profile: "damai", status: grab.status, grab_result: grab };
  } else {
    result = (await runProfile(profile, device, itemId, options)).toDict();
  }
  console.log(JSON.stringify(result, null, 2));
}

// ---- 内部辅助 -------------------------------------------------------------------

/** 对应 Python `int(...)` 截断语义（options 里的数字/数字字符串）。 */
function pyIntCast(value: unknown): number {
  if (typeof value === "number") {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) {
    return parseInt(value.trim(), 10);
  }
  const n = Number(value);
  if (Number.isNaN(n)) {
    throw new Error(`invalid literal for int() with base 10: '${String(value)}'`);
  }
  return n;
}

/** 对应 Python `float(...)`（options 里的数字/数字字符串）。 */
function pyFloatCast(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(n)) {
    throw new Error(`could not convert string to float: '${String(value)}'`);
  }
  return n;
}

/** 对应 Python f-string `{x:+.2f}`：恒带符号、保留两位小数。 */
function signed2(value: number): string {
  return `${value < 0 ? "-" : "+"}${Math.abs(value).toFixed(2)}`;
}

/** 等价于 Python 的 str(exc)：Error 取 message，其余 String()。 */
function excToStr(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** 复刻 Python `str(list)` 的形态（如 `['damai', 'maoyan']`），供 list-profiles 输出。 */
function pyListStr(items: readonly string[]): string {
  return `[${items.map(pyRepr).join(", ")}]`;
}

/**
 * 复刻 Python `str(dict)` 的形态（如 `{'k': 1}`），仅供 app-grab 的日志行使用；
 * CLI 解析出的值只会是 int / str。
 */
function pyDictStr(d: Record<string, unknown>): string {
  const inner = Object.entries(d)
    .map(([k, v]) => `${pyRepr(k)}: ${pyValueRepr(v)}`)
    .join(", ");
  return `{${inner}}`;
}

function pyValueRepr(v: unknown): string {
  if (typeof v === "string") return pyRepr(v);
  if (typeof v === "boolean") return v ? "True" : "False";
  if (v === null || v === undefined) return "None";
  if (Array.isArray(v)) return `[${v.map(pyValueRepr).join(", ")}]`;
  if (typeof v === "number") return String(v);
  return String(v);
}

// ---- web ---------------------------------------------------------------------

/**
 * web 绑定安全闸（D6）：校验 `--host` 与 `--token` 的组合是否允许启动。
 *
 * - 回环地址（`localhost` / `127.*` / `::1`）直接放行并返回 `true`；
 * - 非回环 + 未显式提供 token → 抛中文 Error 拒绝启动
 *   （自动生成 token + 内网暴露属高危组合）；
 * - 非回环 + 显式 token → 打印多行风险横幅并返回 `false`（暴露风险由调用方自担）。
 *
 * 除 `logger.warning` 外无副作用，供 `cmdWeb` 与测试直接调用。
 *
 * @param host `--host` 的值（原样比对，不做 DNS 解析）。
 * @param hasExplicitToken 调用方是否显式传入了 `--token`（`undefined` 即未提供）。
 * @returns 是否为回环绑定：`true` = 仅本机可见；`false` = 非回环、已确认暴露风险。
 * @throws 非回环地址且未显式提供 token 时，抛出含补救指引的中文 Error。
 */
export function assertWebBinding(host: string, hasExplicitToken: boolean): boolean {
  const loopback = host === "localhost" || host.startsWith("127.") || host === "::1";
  if (loopback) {
    return true;
  }
  if (!hasExplicitToken) {
    throw new Error(
      `拒绝启动：绑定非回环地址 ${host} 时必须显式提供 --token。` +
        "自动生成 token + 内网暴露属高危组合——局域网内任何拿到 token 的人都能操控你的手机/模拟器。" +
        "请改用默认 127.0.0.1，或 --token <自定义高熵token> 并阅读 docs/web-console-remote.md。",
    );
  }
  logger.warning(
    [
      "┌────────────────────── 远程访问风险提示 ──────────────────────┐",
      `│ ① 当前绑定 ${host} 为非回环地址：控制台对所在网段可见。`,
      "│ ② 持有 token 者可完全操控设备（UI dump、截图、抢票任务流程）。",
      "│ ③ 自动支付边界不因网络暴露而改变（控制台不触发支付），",
      "│    但设备仍可被远程操纵（点击、输入、安装等）。",
      "│ ④ 建议：反向代理终结 TLS + 防火墙仅放行可信源 IP。",
      "│ ⑤ 详见 docs/web-console-remote.md（反代/HTTPS/防火墙/最小暴露建议）。",
      "└──────────────────────────────────────────────────────────────┘",
    ].join("\n"),
  );
  return false;
}

/**
 * web 子命令：启动可视化控制台（Next.js 16 全栈应用，位于仓库根 `web/`）。
 *
 * 安全护栏（docs/plans/web-console-plan.md D6，经 {@link assertWebBinding} 落实）：
 * - 默认绑定 127.0.0.1；`--host` 指向非回环地址且未显式提供 `--token` 时拒绝启动；
 * - 非回环 + 显式 token 时打印多行风险横幅；
 * - 回环绑定下 token 未显式提供时自动生成并打印（自动生成仅限回环），
 *   经 `DAMAI_WEB_TOKEN` 注入 Next 进程，由 `web/src/proxy.ts` 校验
 *   （x-web-token 头或 /api/token 换取的 Cookie）。
 */
async function cmdWeb(
  mode: "dev" | "start",
  host: string,
  port: number,
  token?: string,
): Promise<void> {
  // 安全闸先于一切副作用：非回环 + 未显式 token 直接拒绝启动（D6）
  const loopback = assertWebBinding(host, token !== undefined);
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const webRoot = join(repoRoot, "web");
  const nextEntry = join(webRoot, "node_modules", "next", "dist", "bin", "next");
  if (!existsSync(nextEntry)) {
    throw new Error(`未找到 Next.js（${nextEntry}）。请先在仓库根执行 pnpm install。`);
  }
  if (mode === "start" && !existsSync(join(webRoot, ".next", "BUILD_ID"))) {
    throw new Error(
      "web 尚未构建（缺少 web/.next/BUILD_ID）。请先执行 pnpm -C web build，或改用 --mode dev。",
    );
  }

  // 走到这里 token===undefined 只可能出现在回环绑定（非回环已被安全闸拒绝）
  const effectiveToken = token ?? randomBytes(16).toString("hex");
  logger.info(
    `web 控制台: http://${host}:${port} (mode=${mode}${loopback ? "，仅本机可访问" : "，对所在网段可见"})`,
  );
  logger.info(
    `访问 token: ${effectiveToken}  （浏览器打开 /api/token?token=<token> 换取 Cookie，或请求携带 x-web-token 头）`,
  );

  // 用显式 node 而非 process.execPath：cli 可由 bun 运行，而 next 交给 node 更稳
  const child = spawn("node", [nextEntry, mode, "-H", host, "-p", String(port)], {
    cwd: webRoot,
    stdio: "inherit",
    env: { ...process.env, DAMAI_WEB_TOKEN: effectiveToken },
  });
  const forward = (signal: NodeJS.Signals) => {
    child.kill(signal);
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));
  await new Promise<void>((resolvePromise, rejectPromise) => {
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`next ${mode} 退出码 ${code ?? "signal"}`));
      }
    });
    child.once("error", rejectPromise);
  });
}

// 对应 Python `if __name__ == "__main__": main()`
// —— 仅当本文件作为入口直接执行时才自动运行（被 index.ts 导入时不触发）。
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((exc) => {
    console.error(exc instanceof Error ? exc.message : String(exc));
    process.exitCode = 1;
  });
}
