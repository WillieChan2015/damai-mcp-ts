import { existsSync } from "node:fs";
import path from "node:path";

/**
 * damai_shots 候选来源（优先级从高到低：env > repoRoot > webCwd）。
 *
 * - `env`：环境变量 `DAMAI_WEB_SHOTS_DIR` 显式指定；
 * - `repoRoot`：仓库根/damai_shots——从仓库根跑 MCP/CLI 的落点
 *   （core `src/damai/actions.ts:224` 的 `SHOTS_DIR = "damai_shots"` 相对 cwd）；
 * - `webCwd`：cwd/damai_shots——cli 拓扑下 `cli.ts:585-586` 以 web/ 为 cwd
 *   启动 next 的实际落点（历史兼容）。
 */
export type ShotsDirSource = "env" | "repoRoot" | "webCwd";

/** 单个候选目录及其存在性（空态提示与测试用）。 */
export interface ShotsDirCandidate {
  /** 候选目录绝对路径。 */
  dir: string;
  /** 候选来源（决定优先级）。 */
  source: ShotsDirSource;
  /** 该目录当前是否存在。 */
  exists: boolean;
}

/** 已命中的 damai_shots 目录。 */
export interface ShotsDirResolution {
  /** 命中的目录绝对路径。 */
  dir: string;
  /** 命中来源。 */
  source: ShotsDirSource;
}

/** 解析参数；缺省取真实 `process.cwd()` / `process.env`（测试注入 tmp 树与假 env）。 */
export interface ShotsDirBase {
  /** 工作目录（Next 服务端恒为 web/）。 */
  cwd?: string;
  /** 环境变量表。 */
  env?: Record<string, string | undefined>;
}

const SHOTS_DIR_NAME = "damai_shots";

/**
 * damai_shots 目录解析（顺序固定，设计 §5.1 / 技术决策 3）：
 *
 * 1. env `DAMAI_WEB_SHOTS_DIR`（未设置或空串视为未设置；相对路径按 cwd 解析）；
 * 2. 仓库根/damai_shots（`resolve(cwd, "..")`——cwd 恒为 web/，cli 拓扑与
 *    `pnpm -C web` 均如此）；
 * 3. cwd/damai_shots（web/damai_shots，历史兼容落点）。
 *
 * 返回第一个【存在】的候选；都不存在 → null（截图墙据此渲染空态——
 * 失败截图目录由 core 抢票流程首次落图时自动创建，此前无需预建）。
 */
export function resolveShotsDir(base?: ShotsDirBase): ShotsDirResolution | null {
  for (const candidate of shotsDirCandidates(base)) {
    if (candidate.exists) {
      return { dir: candidate.dir, source: candidate.source };
    }
  }
  return null;
}

/**
 * 按优先级列出候选目录及存在性。
 *
 * env 未设置（或空串）时跳过 env 候选——它没有可检查的具体路径；
 * 空态提示据此展示「已检查过哪些目录」。
 */
export function shotsDirCandidates(base?: ShotsDirBase): ShotsDirCandidate[] {
  const cwd = base?.cwd ?? process.cwd();
  const env = base?.env ?? process.env;
  const repoRoot = path.resolve(cwd, "..");
  const ordered: Array<{ dir: string; source: ShotsDirSource }> = [];

  const fromEnv = env.DAMAI_WEB_SHOTS_DIR;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    // path.resolve 兼容绝对/相对两种写法：相对值按 cwd（web/）解析
    ordered.push({ dir: path.resolve(cwd, fromEnv), source: "env" });
  }
  ordered.push({ dir: path.join(repoRoot, SHOTS_DIR_NAME), source: "repoRoot" });
  ordered.push({ dir: path.join(cwd, SHOTS_DIR_NAME), source: "webCwd" });

  return ordered.map(({ dir, source }) => ({ dir, source, exists: existsSync(dir) }));
}
