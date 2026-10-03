/**
 * 开发态请求日志里要丢掉的路径（`next.config.ts` 的 `logging.incomingRequests.ignore`）。
 *
 * `/api/health` 被导航栏每 3 秒轮询，既不代表用户操作，也不写入应用日志。
 * 匹配路径本身以及带 query / hash 的形式，不误伤 `/api/healthcare` 这类前缀。
 */
export const SILENT_INCOMING_REQUESTS: readonly RegExp[] = [/\/api\/health(?:[/?#]|$)/];
