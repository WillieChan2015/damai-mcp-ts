/**
 * retry 指数退避重试测试（Python `tests/test_retry.py` 的对应物，用例一一对应）。
 *
 * Python 的 `@retry(...)` 装饰器对应 TS 的柯里化 `retry({...})(fn)`
 * （内部即 `withRetry`），调用顺序保持一致。
 */
import { describe, expect, it } from "vitest";

import { ADBError, DamaiMCPError } from "../src/utils/errors";
import { retry, type RetryableErrorClass } from "../src/utils/retry";
import { captureRejection } from "./helpers";

describe("retry 指数退避（对应 @retry 装饰器）", () => {
  it("test_retry_succeeds_first_try", async () => {
    const calls: number[] = [];
    const fn = retry({ maxAttempts: 3 })(async () => {
      calls.push(1);
      return "ok";
    });

    await expect(fn()).resolves.toBe("ok");
    expect(calls).toHaveLength(1);
  });

  it("test_retry_succeeds_after_two_failures", async () => {
    const calls: number[] = [];
    const fn = retry({ maxAttempts: 3, baseDelay: 0.001 })(async () => {
      calls.push(1);
      if (calls.length < 3) {
        throw new ADBError("transient");
      }
      return "ok";
    });

    await expect(fn()).resolves.toBe("ok");
    expect(calls).toHaveLength(3);
  });

  it("test_retry_gives_up_after_max_attempts", async () => {
    const calls: number[] = [];
    const fn = retry({ maxAttempts: 3, baseDelay: 0.001 })(async () => {
      calls.push(1);
      throw new ADBError("persistent");
    });

    await expect(fn()).rejects.toThrowError(/persistent/);
    expect(calls).toHaveLength(3);
  });

  it("test_retry_does_not_catch_unexpected_exceptions", async () => {
    // Python 抛 ValueError（不在 exceptions 名单内）；TS 无对应内建，
    // 用普通 Error 承担同一语义——非 DamaiMCPError 系异常立即外抛。
    // exceptions 的双重断言沿用 src/actions/actions.ts 的既有约定
    // （RetryableErrorClass 的构造签名与具体错误类在类型层不兼容）。
    const fn = retry({
      maxAttempts: 3,
      exceptions: [DamaiMCPError] as unknown as readonly RetryableErrorClass[],
    })(async () => {
      throw new Error("not retried");
    });

    const err = await captureRejection(fn());
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DamaiMCPError);
    expect((err as Error).message).toBe("not retried");
  });

  it("test_retry_base_delay_grows", async () => {
    // 验证指数退避确实让第 2 次尝试更晚发生
    const timings: number[] = [];
    const fn = retry({ maxAttempts: 3, baseDelay: 0.05, maxDelay: 10.0, jitter: false })(
      async () => {
        timings.push(performance.now() / 1000);
        throw new ADBError("x");
      },
    );

    await expect(fn()).rejects.toThrowError(ADBError);
    expect(timings).toHaveLength(3);
    // 第 1 与第 2 次尝试之间的间隔应 ≥ 0.05s（留 10ms 时钟误差余量）
    const gap = timings[1] - timings[0];
    expect(gap, `Expected ≥0.05s backoff, got ${gap.toFixed(3)}s`).toBeGreaterThanOrEqual(0.04);
  });
});
