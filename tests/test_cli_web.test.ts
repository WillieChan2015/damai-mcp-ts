/**
 * cli web 子命令绑定安全闸测试（Phase 2+3 remote 项，设计稿 §2.4）。
 *
 * `assertWebBinding` 为纯校验函数：cli.ts 顶层仅注册命令，
 * `main()` 只在本文件被直接执行时才运行（invokedDirectly 守卫），
 * 因此 import 无副作用。回环判定规则：localhost / 127.* / ::1。
 *
 * 非回环 + 显式 token 的用例会经 logger.warning 打印风险横幅到 stderr，
 * 属预期输出（logging.ts 的 stderr sink 未 configure 时默认 DEBUG 起打印）。
 */
import { describe, expect, it } from "vitest";

import { assertWebBinding } from "../src/cli";

describe("assertWebBinding", () => {
  it("回环 127.0.0.1 未显式提供 token：放行并返回 true", () => {
    expect(assertWebBinding("127.0.0.1", false)).toBe(true);
  });

  it("回环 localhost 显式提供 token：放行并返回 true", () => {
    expect(assertWebBinding("localhost", true)).toBe(true);
  });

  it("回环 ::1：放行并返回 true", () => {
    expect(assertWebBinding("::1", false)).toBe(true);
  });

  it("非回环 0.0.0.0 未显式提供 token：拒绝启动，中文 Error 含 --token 与文档指引", () => {
    let message: string | null = null;
    try {
      assertWebBinding("0.0.0.0", false);
    } catch (exc) {
      expect(exc).toBeInstanceOf(Error);
      message = exc instanceof Error ? exc.message : String(exc);
    }
    expect(message).not.toBeNull();
    expect(message).toContain("--token");
    expect(message).toContain("127.0.0.1");
    expect(message).toContain("docs/web-console-remote.md");
  });

  it("非回环 192.168.1.5 显式提供 token：打印横幅、放行并返回 false", () => {
    expect(assertWebBinding("192.168.1.5", true)).toBe(false);
  });
});
