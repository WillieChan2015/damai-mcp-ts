#!/usr/bin/env bun
/**
 * Example: drive the MCP server from a TS client (like Claude Code does).
 *
 * Spawns `bun run src/cli.ts serve` over stdio, then makes a few tool calls and
 * prints the results. Demonstrates how external AI agents would interact with
 * the server.
 *
 * Usage:
 *     pnpm install
 *     bun examples/mcp_client_demo.ts
 *
 * （Python `examples/mcp_client_demo.py` 的 TS 对应物。）
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** 等价于 Python 的 str(exc)：Error 取 message，其余 String()。 */
function excMessage(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** 内容块的最小形状（对应 Python 的 `hasattr(content, "text")` 鸭子类型）。 */
interface TextLikeContent {
  type: string;
  text?: string;
}

/**
 * 从 callTool 结果中取出内容块。
 *
 * SDK 1.31 的 `callTool` 返回类型是「CallToolResult | task 结果」联合，
 * 其 `.content` 被索引签名归并为 unknown，这里按鸭子类型窄化。
 */
function contentBlocks(result: unknown): TextLikeContent[] {
  const content = (result as { content?: TextLikeContent[] }).content;
  return Array.isArray(content) ? content : [];
}

async function main(): Promise<void> {
  // 对应 Python 的 StdioServerParameters(command="damai-mcp", args=["serve"], env=None)。
  // TS 侧没有安装后的 console-script，等价命令是从 checkout 内启动 CLI：
  // `bun src/cli.ts serve`（与 README 的启动方式一致）。env=None → 继承父进程环境。
  const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
  const serverParams: ConstructorParameters<typeof StdioClientTransport>[0] = {
    command: "bun",
    args: [cliPath, "serve"],
    env: { ...process.env } as Record<string, string>,
  };
  const transport = new StdioClientTransport(serverParams);

  const client = new Client({ name: "damai-mcp-demo-client", version: "0.2.3" });
  // connect 内部完成 initialize 握手（对应 Python 的 session.initialize()）
  await client.connect(transport);
  try {
    // List tools
    const tools = await client.listTools();
    console.log(`📋 工具总数: ${tools.tools.length}`);
    for (const t of tools.tools.slice(0, 8)) {
      console.log(`  - ${t.name}: ${(t.description ?? "").slice(0, 60)}...`);
    }
    console.log(`  ... (还有 ${tools.tools.length - 8} 个)`);

    // Call list_devices
    console.log(`\n🔌 调用 list_devices:`);
    const result = await client.callTool({ name: "list_devices", arguments: { refresh: true } });
    for (const content of contentBlocks(result)) {
      if (typeof content.text === "string") {
        console.log(`  ${content.text}`);
      }
    }

    // Call find_text (will fail without device, but shows the call)
    console.log(`\n🔍 调用 find_text:`);
    try {
      const result2 = await client.callTool({
        name: "find_text",
        arguments: { device_id: "127.0.0.1:5555", text: "立即购买", timeout: 2.0 },
      });
      for (const content of contentBlocks(result2)) {
        if (typeof content.text === "string") {
          console.log(`  ${content.text}`);
        }
      }
    } catch (exc) {
      console.log(`  (expected if no device): ${excMessage(exc)}`);
    }
  } finally {
    // 对应 Python async with 退出时关闭会话
    await client.close();
  }
}

// 对应 Python `if __name__ == "__main__": asyncio.run(main())`
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((exc) => {
    console.error(exc);
    process.exitCode = 1;
  });
}
