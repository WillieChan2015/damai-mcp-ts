/**
 * damai-mcp-ts: Android Emulator MCP for ticket-grabbing automation.
 *
 * 对应 Python `damai_mcp/__init__.py` 的公共面：
 *     __all__ = ["mcp", "main", "__version__"]
 * （`__version__` 在 TS 里以 {@link VERSION} 具名导出。）
 */

export { mcp, VERSION } from "./server";
export { main } from "./cli";
