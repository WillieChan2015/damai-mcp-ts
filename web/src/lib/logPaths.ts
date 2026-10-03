/**
 * 日志目录 / 当前日志文件解析（Phase 2+3 logs 项）。
 *
 * core 的文件沉降由 `configure(level, logDir)` 开启（src/utils/logging.ts:232-266）：
 * pino-roll 基名 `join(logDir, "damai_mcp")`、frequency=daily + dateFormat=yyyyMMdd、
 * size=20MB、保留 7 个。pino-roll@4.0.0 源码实读确认（node_modules/pino-roll/）：
 * - `sanitizeFile` 在基名无扩展名且未显式传 `extension` 时追加默认扩展名 `log`
 *   （lib/utils.js:305-332，FALLBACK_EXTENSION='log'）；
 * - `buildFileName` 拼接为 `${基名}.${日期段}.${轮转序号}${.扩展名}`（lib/utils.js:93-97）；
 * - 目录无历史文件时轮转序号从 1 起（lib/utils.js:137-158 detectLastNumber）。
 * ⇒ 实际落盘形如 `damai_mcp.20261003.1.log`（20MB 轮转序号 +1，跨天换日期段）。
 */

import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/** 显式指定日志目录的环境变量名（优先于默认解析）。 */
export const LOG_DIR_ENV = "DAMAI_WEB_LOG_DIR";

/**
 * pino-roll 落盘文件名规则。
 *
 * 捕获组 1 = 日期段（yyyyMMdd，纯数字）、2 = 轮转序号；结尾的 `.log` 是
 * pino-roll 对无扩展名基名的默认扩展名（lib/utils.js:305-332），允许省略以兼容
 * 未来 core 显式传 `extension` 的情形。其余基名（如 `damai_mcp.txt`、`other.1.log`）不匹配。
 */
export const LOG_FILE_RE = /^damai_mcp\.(\d{8})\.(\d+)(?:\.log)?$/;

/** {@link resolveLogDir} 的解析参数（缺省取 process.cwd() 与 process.env；测试注入用）。 */
export interface ResolveLogDirBase {
  /** web 进程工作目录（cli 拓扑下 cli.ts:585-586 以 web/ 为 cwd）。 */
  cwd?: string;
  /** 环境变量表。 */
  env?: Record<string, string | undefined>;
}

/**
 * 日志目录解析：env {@link LOG_DIR_ENV} > 仓库根 logs/（resolve(cwd, "..", "logs")）。
 *
 * 两种运行拓扑下 cwd 均为 web/——`pnpm -C web dev` 与 cli 生成的 next 子进程
 * （src/cli.ts:585-586 以 webRoot 为 cwd 并继承 env），因此 `".."` 即仓库根，
 * 与 cli 自身 `--log-dir ./logs`（cli.ts:78）从仓库根运行时落点一致。
 * env 置空串 / 纯空白视为未设置，继续走默认解析。
 */
export function resolveLogDir(base?: ResolveLogDirBase): string {
  const env = base?.env ?? process.env;
  const fromEnv = env[LOG_DIR_ENV]?.trim();
  if (fromEnv) {
    return resolve(fromEnv);
  }
  const cwd = base?.cwd ?? process.cwd();
  return resolve(cwd, "..", "logs");
}

/**
 * 返回目录内按 (日期段, 序号) 数值最大的当前日志文件（即 pino-roll 正在写的那个）。
 *
 * 必须数值比较而非字典序：字典序会把 `.10` 排在 `.2` 之前。目录不存在 / 不可读 /
 * 无匹配文件 → null（调用方按「暂无文件」处理并继续监听）。
 */
export function resolveCurrentLogFile(dir?: string): string | null {
  const target = dir ?? resolveLogDir();
  let names: string[];
  try {
    names = readdirSync(target);
  } catch {
    return null; // 目录不存在或不可读
  }
  let best: { name: string; date: number; seq: number } | null = null;
  for (const name of names) {
    const m = LOG_FILE_RE.exec(name);
    if (!m) {
      continue;
    }
    const date = Number(m[1]);
    const seq = Number(m[2]);
    if (best === null || date > best.date || (date === best.date && seq > best.seq)) {
      best = { name, date, seq };
    }
  }
  return best === null ? null : join(target, best.name);
}
