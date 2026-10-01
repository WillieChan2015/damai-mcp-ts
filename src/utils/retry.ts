/**
 * 带指数退避 + 可选抖动的重试高阶函数
 * （Python `utils/retry.py` 的 `retry` 装饰器改为 `withRetry`）。
 *
 * 用法：
 *   const flakyAdbCall = withRetry(
 *     async () => { ... },
 *     { maxAttempts: 3, baseDelay: 0.5, exceptions: [ADBError] },
 *   );
 */
import { setTimeout as sleep } from "node:timers/promises";

import { DamaiMCPError } from "./errors";
import { logger } from "./logging";

/** 可触发重试的异常构造器（用 instanceof 匹配，等价于 Python 的 `except (Cls, ...)`）。 */
export type RetryableErrorClass = abstract new (...args: unknown[]) => Error;

export interface RetryOptions {
  /** 最大尝试次数（含首次）。默认 3。 */
  maxAttempts?: number;
  /** 首次重试前的基准延迟（秒）。默认 0.3。 */
  baseDelay?: number;
  /** 延迟上限（秒）；截断发生在加抖动之前（与 Python 版一致）。默认 5.0。 */
  maxDelay?: number;
  /** 是否给延迟乘以 0.5~1.5 的随机系数。默认 true。 */
  jitter?: boolean;
  /** 触发重试的异常类列表；不在列表内的异常立即向调用方抛出。默认 `[DamaiMCPError]`。 */
  exceptions?: readonly RetryableErrorClass[];
}

/** 等价于 Python `str(exc)`：Error 取 message，其他值 String()。 */
function excToStr(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** 对应 f-string 的 `{value:.100}`：截断到最多 100 个字符。 */
function truncate100(s: string): string {
  return s.length > 100 ? s.slice(0, 100) : s;
}

/**
 * 异步重试包装：指数退避 + 可选抖动。
 *
 * 第 n 次失败后的等待为 `min(baseDelay * 2^(n-1), maxDelay)`，
 * 开启 jitter 时再乘以 `[0.5, 1.5)` 的随机系数（可能超过 maxDelay，与 Python 版一致）。
 */
export function withRetry<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => TResult | Promise<TResult>,
  options: RetryOptions = {},
): (...args: TArgs) => Promise<TResult> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelay = options.baseDelay ?? 0.3;
  const maxDelay = options.maxDelay ?? 5.0;
  const jitter = options.jitter ?? true;
  const exceptions = options.exceptions ?? [DamaiMCPError];
  const fnName = fn.name || "<anonymous>";

  const wrapped = async (...args: TArgs): Promise<TResult> => {
    let lastExc: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn(...args);
      } catch (exc) {
        if (!exceptions.some((cls) => exc instanceof cls)) {
          throw exc; // 不在重试名单内的异常立即抛出，不做退避
        }
        lastExc = exc;
        if (attempt === maxAttempts) {
          logger.error(`${fnName} 重试 ${maxAttempts} 次后仍失败: ${excToStr(exc)}`);
          throw exc;
        }
        let delay = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
        if (jitter) {
          delay = delay * (0.5 + Math.random());
        }
        logger.warning(
          `${fnName} 第 ${attempt}/${maxAttempts} 次失败: ${truncate100(excToStr(exc))}，` +
            `等待 ${delay.toFixed(2)}s 重试`,
        );
        await sleep(delay * 1000);
      }
    }
    throw lastExc; // 对应 Python 版循环后的 assert + raise（max_attempts ≥ 1 时不可达）
  };

  // 对应 functools.wraps：保留原函数名
  Object.defineProperty(wrapped, "name", { value: fnName, configurable: true });
  return wrapped;
}

/**
 * 柯里化形式，保持与 Python `@retry(...)` 相同的调用顺序：
 * `retry({ maxAttempts: 3 })(fn)` 等价于 `withRetry(fn, { maxAttempts: 3 })`。
 */
export function retry(
  options: RetryOptions = {},
): <TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => TResult | Promise<TResult>,
) => (...args: TArgs) => Promise<TResult> {
  return (fn) => withRetry(fn, options);
}
