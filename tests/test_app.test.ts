/**
 * 多应用 profile 框架的测试
 * （Python `tests/test_app.py` 的 TS 对应物；用例一一对应）。
 *
 * 与 Python 版的两处结构性差异（断言语义不变）：
 * 1. Python 用 `monkeypatch.setitem(_ACTION_TABLE, ...)` 替换动作处理器；
 *    TS 侧 `runner.ts` 未导出动作表，改为在子进程/查询层 mock 动作处理器的
 *    依赖（`inspector/find`、`device/adb`），由真实处理器驱动 runner 循环。
 * 2. Python 用 `hasattr(server, "list_app_profiles")` 做注册健全性检查；
 *    TS 侧 server.ts 把工具注册进 `createMcpServer()`，改为 spy
 *    `McpServer.prototype.registerTool` 断言工具名被注册。
 *
 * 另：Python `load_profile` 是同步函数；TS 版因 ESM 惰性注册内置项而返回
 * Promise，相应用例全部 await 化。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AppProfile,
  Step,
  listProfiles,
  loadProfile,
  loadProfileFile,
  registerProfile,
} from "../src/app/profile";
import { runProfile } from "../src/app/runner";
import { shell } from "../src/device/adb";
import { findByText, waitForElement } from "../src/inspector/find";
import { createMcpServer } from "../src/server";
import { el } from "./helpers";

vi.mock("../src/device/adb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/device/adb")>();
  return { ...actual, adb: vi.fn(), shell: vi.fn() };
});

vi.mock("../src/inspector/find", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/inspector/find")>();
  return { ...actual, findByText: vi.fn(), waitForElement: vi.fn() };
});

describe("built-in registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("test_builtin_profiles_registered", async () => {
    // Trigger lazy registration
    for (const n of ["damai", "maoyan", "fliggy"]) {
      await loadProfile(n);
    }
    const names = listProfiles();
    for (const n of ["damai", "maoyan", "fliggy"]) {
      expect(names).toContain(n);
    }
  });

  it("test_maoyan_profile_shape", async () => {
    const p = await loadProfile("maoyan");
    expect(p.packageName).toBe("com.sankuai.movie");
    expect(p.steps.length).toBeGreaterThanOrEqual(4);
    const actions = p.steps.map((s) => s.action);
    expect(actions).toContain("open_detail");
    expect(actions).toContain("tap_text");
  });

  it("test_fliggy_profile_shape", async () => {
    const p = await loadProfile("fliggy");
    expect(p.packageName).toBe("com.taobao.trip");
    expect(p.steps.some((s) => s.action === "tap_index")).toBe(true);
  });

  it("test_damai_profile_special", async () => {
    const p = await loadProfile("damai");
    expect(p.packageName).toBe("cn.damai");
  });
});

describe("custom registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("test_register_custom_profile", async () => {
    const custom = new AppProfile({
      name: "pytest_demo",
      packageName: "com.example.demo",
      steps: [new Step({ name: "wait_hi", action: "wait_text", args: { text: "Hi" } })],
      hints: ["unit-test"],
    });
    registerProfile(custom, { override: true });
    const loaded = await loadProfile("pytest_demo");
    expect(loaded.packageName).toBe("com.example.demo");
    expect(loaded.steps[0]!.action).toBe("wait_text");
  });

  it("test_register_duplicate_raises", () => {
    registerProfile(new AppProfile({ name: "dup", packageName: "x.dup" }));
    expect(() =>
      registerProfile(new AppProfile({ name: "dup", packageName: "x.dup" })),
    ).toThrow(/already registered/);
  });
});

describe("JSON round trip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("test_load_profile_file", async () => {
    const custom = {
      name: "json_test",
      package_name: "com.example.json",
      steps: [
        { name: "go", action: "wait_text", args: { text: "buy" } },
        { name: "tap", action: "tap_text", args: { text: "buy" }, timeout_sec: 3.0 },
      ],
      hints: ["loaded from disk"],
    };
    // 对应 Python 的 tempfile.NamedTemporaryFile(delete=False)
    const dir = await mkdtemp(join(tmpdir(), "damai-profile-test-"));
    const filePath = join(dir, "custom_profile.json");
    try {
      await writeFile(filePath, JSON.stringify(custom), "utf-8");
      const p = await loadProfileFile(filePath);
      expect(p.name).toBe("json_test");
      expect(p.packageName).toBe("com.example.json");
      expect(p.steps).toHaveLength(2);
      expect(p.steps[1]!.timeoutSec).toBe(3.0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("test_load_profile_invalid_path", async () => {
    // Python 断言 FileNotFoundError；Node 的等价物是带 code="ENOENT" 的拒绝
    await expect(loadProfileFile("/no/such/path.json")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("runner with mocked handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // runner 的 tap_text 动作最终落到 adb shell——子进程层放行
    vi.mocked(shell).mockResolvedValue("");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("test_runner_returns_submitted_when_all_ok", async () => {
    const profile = new AppProfile({
      name: "runner_ok",
      packageName: "x.ok",
      steps: [
        new Step({ name: "s1", action: "wait_text", args: { text: "buy" } }),
        new Step({ name: "s2", action: "tap_text", args: { text: "buy" } }),
      ],
    });
    // 对应 monkeypatch.setitem(_ACTION_TABLE, "wait_text", AsyncMock(...))
    vi.mocked(waitForElement).mockResolvedValue(el({ text: "buy" }));
    vi.mocked(findByText).mockResolvedValue(el({ text: "buy" }));

    const out = await runProfile(profile, "127.0.0.1:5555", "ITEM1", { price_index: 1 });
    expect(out.status).toBe("submitted");
    expect(out.steps).toHaveLength(2);
    expect(out.steps.every((s) => s.status === "ok")).toBe(true);
  });

  it("test_runner_stops_on_failure_unless_continue", async () => {
    const profile = new AppProfile({
      name: "runner_fail",
      packageName: "x.fail",
      steps: [
        new Step({ name: "s1", action: "wait_text", args: { text: "buy" } }), // will fail
        new Step({
          name: "s2",
          action: "tap_text",
          args: { text: "buy" },
          continueOnFail: true, // still runs
        }),
        new Step({ name: "s3", action: "sleep", args: { seconds: 0.0 } }),
      ],
    });

    vi.mocked(waitForElement).mockRejectedValue(new Error("widget missing"));
    vi.mocked(findByText).mockResolvedValue(el({ text: "buy" }));

    const out = await runProfile(profile, "127.0.0.1:5555", "ITEM1");
    expect(out.status).toBe("failed");
    // Step 1 failed without continue_on_fail — runner stops
    expect(out.steps).toHaveLength(1);
    expect(out.error ?? "").toContain("widget missing");
  });

  it("test_runner_continues_when_flag_set", async () => {
    const profile = new AppProfile({
      name: "runner_continue",
      packageName: "x.cont",
      steps: [
        new Step({
          name: "s1",
          action: "sleep",
          args: { seconds: 0.01 },
          continueOnFail: true,
        }),
        new Step({ name: "s2", action: "wait_text", args: { text: "x" } }),
      ],
    });

    // sleep 步骤走真实处理器（10ms 眠）；wait_text 步骤失败
    vi.mocked(waitForElement).mockRejectedValue(new Error("transient"));

    const out = await runProfile(profile, "127.0.0.1:5555", "ITEM1");
    // sleep ok, wait_text failed (no continue) so runner stops
    expect(out.status).toBe("failed");
    // 2 step entries made it
    expect(out.steps).toHaveLength(2);
    expect(out.steps.some((s) => s.status === "failed")).toBe(true);
  });

  it("test_app_grab_mcp_tool_registered", () => {
    // Sanity-check the MCP server registers the new tools.
    // Python 用 hasattr 检查模块级符号；TS 的工具注册进 createMcpServer()
    // 构造的 McpServer，这里 spy 注册入口断言工具名。
    const spy = vi.spyOn(McpServer.prototype, "registerTool");
    createMcpServer();
    const registeredNames = spy.mock.calls.map((call) => call[0]);
    expect(registeredNames).toContain("list_app_profiles");
    expect(registeredNames).toContain("app_grab");
  });
});
