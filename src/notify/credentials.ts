/**
 * 通知凭证（微信 ClawBot 的 origin / token / context_token）本地持久化存储。
 *
 * 方案对齐竞品 tickets 的 `notifications.rs:693-723`：凭证落盘为用户目录下的
 * 单个 JSON 文件——目录 0o700、文件 0o600、临时文件 + `rename` 原子替换
 * （写一半崩溃也不会留下半截凭证文件，旧凭证保持可用）。
 *
 * 安全语义：
 *   - save：`mkdir -p` → 目录 chmod 0o700 → `<file>.tmp.<pid>` 以 0o600 创建
 *     （`open(..., "w", 0o600)`；0o600 本身不含 group/other 位，umask 只会去位
 *     不会加位）→ 写入最小 JSON（仅四个字段）→ `rename` 原子替换 → 文件
 *     chmod 0o600 双保险（防上一次崩溃残留的宽权限 tmp 被复用）。
 *   - load：缺失 / 损坏 JSON / 字段缺失一律返回 null（不抛，避免锁死用户）；
 *     POSIX 上 stat 发现文件权限过宽（mode & 0o077 ≠ 0）时打 warning 并照常
 *     返回——权限问题是提醒项，不是拒绝服务的理由。
 *   - 日志脱敏：本模块任何日志只含文件路径，绝不输出 token；对外提供
 *     {@link redactToken}（只留前 2 后 2）供上层（server 接线）拼接错误文案用。
 *
 * 平台注记（win32）：POSIX 上 0o600/0o700 完整生效；Windows 的 `chmod` 只有
 * 只读位语义，权限实际依赖目录 ACL——按用户主目录默认 ACL 已私有（仅本人与
 * SYSTEM/Administrators 可见）的假设提供同级保护。load 的权限体检因此在
 * win32 上跳过（Node 在 Windows 上伪造的 mode 恒为 0o666/0o444，检查无意义）。
 */

import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { logger } from "../utils/logging";

/** 凭证目录名（XDG 规范的应用级子目录）。 */
const CREDENTIALS_APP_DIR = "damai-mcp-ts";

/** 凭证文件名。 */
const CREDENTIALS_FILE_NAME = "notify.json";

/** 默认凭证目录：$XDG_CONFIG_HOME/damai-mcp-ts，未设置时为 ~/.config/damai-mcp-ts。 */
export const NOTIFY_CREDENTIALS_DIR_DEFAULT: string = join(
  process.env.XDG_CONFIG_HOME !== undefined && process.env.XDG_CONFIG_HOME.trim() !== ""
    ? process.env.XDG_CONFIG_HOME
    : join(homedir(), ".config"),
  CREDENTIALS_APP_DIR,
);

/** 默认凭证文件路径：{@link NOTIFY_CREDENTIALS_DIR_DEFAULT} 下的 notify.json。 */
export const NOTIFY_CREDENTIALS_FILE_DEFAULT: string = join(
  NOTIFY_CREDENTIALS_DIR_DEFAULT,
  CREDENTIALS_FILE_NAME,
);

/** 落盘的凭证结构（notify.json 的最小面，不含任何其他字段）。 */
export interface NotifyCredentials {
  /** ClawBot 服务 origin（https，host ∈ *.ilinkai.weixin.qq.com）。 */
  origin: string;
  /** Bearer 令牌（Authorization: Bearer <token>）。 */
  token: string;
  /** 会话上下文 token。 */
  contextToken: string;
  /** 保存时刻（Unix 秒）。 */
  savedAtUnix: number;
}

/** 测试隔离用目录覆盖；null 恢复默认（{@link NOTIFY_CREDENTIALS_DIR_DEFAULT}）。 */
let credentialsDirOverride: string | null = null;

/**
 * 覆盖凭证存储目录（仅供测试注入临时目录；null 恢复默认）。
 *
 * 与仓库内其他 `*ForTests` 开关（如 `setJitterRngForTests`）同一模式：
 * 测试在 beforeEach 里指向 mkdtemp 目录、afterEach 传 null 复位。
 */
export function setNotifyCredentialsDirForTests(dir: string | null): void {
  credentialsDirOverride = dir;
}

/** 当前生效的凭证目录。 */
function credentialsDir(): string {
  return credentialsDirOverride ?? NOTIFY_CREDENTIALS_DIR_DEFAULT;
}

/** 当前生效的凭证文件路径。 */
function credentialsFile(): string {
  return join(credentialsDir(), CREDENTIALS_FILE_NAME);
}

/** 等价于 Python 的 str(exc)：Error 取 message，其余 String()。 */
function excToStr(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/**
 * 保存凭证到本地（目录 0o700 + 文件 0o600 + 临时文件 rename 原子替换）。
 *
 * @param creds 凭证三要素；`savedAtUnix` 由本函数以保存时刻补齐。
 * @throws 中文 Error：任一文件系统步骤失败（临时文件会被尽力清理）。
 */
export async function saveNotifyCredentials(
  creds: Omit<NotifyCredentials, "savedAtUnix">,
): Promise<void> {
  const dir = credentialsDir();
  const file = credentialsFile();
  const tmp = `${file}.tmp.${process.pid}`;
  const payload: NotifyCredentials = {
    origin: creds.origin,
    token: creds.token,
    contextToken: creds.contextToken,
    savedAtUnix: Math.floor(Date.now() / 1000),
  };
  try {
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o700);
    // open(..., "w", 0o600)：0o600 不含 group/other 位，umask 去位后仍 ≤ 0o600
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(payload), "utf-8");
    } finally {
      await handle.close();
    }
    // 同目录 rename：原子替换，写一半崩溃时旧凭证保持可用
    await rename(tmp, file);
    // 双保险：上一次崩溃可能残留宽权限 tmp，"w" 复用时不改已有权限
    await chmod(file, 0o600);
  } catch (exc) {
    try {
      await rm(tmp, { force: true });
    } catch {
      // 清理失败不影响原始错误
    }
    throw new Error(`保存通知凭证失败: ${excToStr(exc)}`);
  }
}

/**
 * 读取本地凭证；缺失 / 损坏 / 字段缺失一律返回 null（不抛）。
 *
 * POSIX 上文件权限过宽（mode & 0o077 ≠ 0）时打 warning 并照常返回——不因
 * 权限拒绝读取，避免用户被自己的旧文件锁死。win32 上跳过该体检（见模块头
 * 平台注记）。
 */
export async function loadNotifyCredentials(): Promise<NotifyCredentials | null> {
  const file = credentialsFile();
  let text: string;
  try {
    text = await readFile(file, "utf-8");
  } catch {
    return null; // 缺失（ENOENT）或不可读：视为无凭证
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null; // 损坏 JSON：视为无凭证
  }
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const { origin, token, contextToken } = obj;
  if (typeof origin !== "string" || origin === "") {
    return null;
  }
  if (typeof token !== "string" || token === "") {
    return null;
  }
  if (typeof contextToken !== "string" || contextToken === "") {
    return null;
  }
  // savedAtUnix 不参与形状强校验（兼容手改文件缺该字段），非法时记 0
  const savedAtUnix =
    typeof obj.savedAtUnix === "number" && Number.isFinite(obj.savedAtUnix)
      ? obj.savedAtUnix
      : 0;
  if (process.platform !== "win32") {
    try {
      const st = await stat(file);
      if ((st.mode & 0o077) !== 0) {
        // 文案不含 token；路径本身非敏感
        logger.warning(`通知凭证文件权限过宽（应为 0600）: ${file}`);
      }
    } catch {
      // 文件在读取与 stat 之间消失：跳过体检
    }
  }
  return { origin, token, contextToken, savedAtUnix };
}

/**
 * 清除本地凭证（文件不存在视为已清除，不抛 ENOENT）。
 *
 * @throws 中文 Error：除「文件不存在」外的删除失败。
 */
export async function clearNotifyCredentials(): Promise<void> {
  try {
    await rm(credentialsFile(), { force: true });
  } catch (exc) {
    throw new Error(`清除通知凭证失败: ${excToStr(exc)}`);
  }
}

/**
 * token 脱敏展示：长度 ≥ 8 时只留前 2 后 2（`ab****yz` 形态），否则全遮为
 * `***`。供上层日志 / 错误文案使用——任何输出路径都不得携带完整 token。
 */
export function redactToken(token: string): string {
  if (typeof token !== "string" || token.length < 8) {
    return "***";
  }
  return `${token.slice(0, 2)}****${token.slice(-2)}`;
}
