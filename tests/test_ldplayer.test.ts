/**
 * 雷电模拟器辅助测试（Python `tests/test_ldplayer.py` 的对应物，用例一一对应）。
 * 纯函数用例，不需要 mock。
 */
import { describe, expect, it } from "vitest";

import { candidateDeviceIds } from "../src/device/ldplayer";

describe("candidateDeviceIds（对应 candidate_device_ids）", () => {
  it("test_ldplayer_index_one_prefers_stable_emulator_serial", () => {
    expect(candidateDeviceIds(1)).toEqual(["emulator-5556", "127.0.0.1:5557"]);
  });

  it("test_ldplayer_keeps_explicit_serial_as_fallback", () => {
    expect(candidateDeviceIds(1, "custom-device")).toEqual([
      "emulator-5556",
      "127.0.0.1:5557",
      "custom-device",
    ]);
  });
});
