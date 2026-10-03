import { describe, expect, it } from "vitest";

import { deviceChoiceLabel, deviceModelLabel } from "./deviceLabel";

describe("deviceChoiceLabel", () => {
  it("小米机型代码换成市场名，括号里放用户自设的设备名", () => {
    expect(
      deviceChoiceLabel({
        deviceId: "beb5a721",
        model: "24129PN74C",
        marketName: "Xiaomi 15",
        deviceName: "Willie的Xiaomi 15",
      }),
    ).toBe("Xiaomi 15（Willie的Xiaomi 15）");
  });

  it("没有自设名称时括号里保留序列号", () => {
    expect(
      deviceChoiceLabel({
        deviceId: "beb5a721",
        model: "24129PN74C",
        marketName: "Xiaomi 15",
        deviceName: "Xiaomi 15",
      }),
    ).toBe("Xiaomi 15（beb5a721）");
  });

  it("没有市场名时仍显示序列号和型号代码", () => {
    expect(deviceChoiceLabel({ deviceId: "emulator-5554", model: "sdk_gphone64_arm64" })).toBe(
      "emulator-5554（sdk_gphone64_arm64）",
    );
  });

  it("只有序列号时不补空括号", () => {
    expect(deviceChoiceLabel({ deviceId: "abc" })).toBe("abc");
  });
});

describe("deviceModelLabel", () => {
  it("优先市场名", () => {
    expect(deviceModelLabel({ deviceId: "beb5a721", model: "24129PN74C", marketName: "Xiaomi 15" })).toBe(
      "Xiaomi 15",
    );
  });

  it("市场名缺失时用型号代码", () => {
    expect(deviceModelLabel({ deviceId: "abc", model: "M2102K1AC" })).toBe("M2102K1AC");
  });
});
