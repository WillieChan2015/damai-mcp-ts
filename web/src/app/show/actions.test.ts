import { beforeEach, describe, expect, it, vi } from "vitest";

import { ADBError } from "@core/utils/errors";

import { readCurrentShow, resolveShareShow } from "./actions";

const readMock = vi.hoisted(() => vi.fn());
const resolveMock = vi.hoisted(() => vi.fn());

vi.mock("@core/damai/readItem", () => ({
  readCurrentDamaiItem: readMock,
}));

vi.mock("@core/damai/itemId", () => ({
  resolveDamaiItemId: resolveMock,
}));

beforeEach(() => {
  readMock.mockReset();
  resolveMock.mockReset();
});

describe("readCurrentShow", () => {
  it("前台详情返回编号", async () => {
    readMock.mockResolvedValueOnce({ foreground: true, itemId: "1063631004645" });
    const result = await readCurrentShow({ deviceId: "phone" });
    expect(result.serverError).toBeUndefined();
    expect(result.data).toEqual({
      itemId: "1063631004645",
      message: "已从手机当前页面识别演出。",
    });
  });

  it("大麦不在前台时说明先打开详情", async () => {
    readMock.mockResolvedValueOnce({ foreground: false, itemId: null });
    const result = await readCurrentShow({ deviceId: "phone" });
    expect(result.data?.itemId).toBeNull();
    expect(result.data?.message).toContain("打开大麦");
  });

  it("adb 失败时提示检查连接，不把异常抛成未处理错误", async () => {
    readMock.mockRejectedValueOnce(new ADBError("error: device offline"));
    const result = await readCurrentShow({ deviceId: "phone" });
    expect(result.serverError).toBeUndefined();
    expect(result.data?.itemId).toBeNull();
    expect(result.data?.message).toContain("USB 调试");
  });
});

describe("resolveShareShow", () => {
  it("短链解析成功时带回编号", async () => {
    resolveMock.mockResolvedValueOnce("1063631004645");
    const result = await resolveShareShow({ text: "https://m.damai.cn/s/abc" });
    expect(result.data?.itemId).toBe("1063631004645");
  });

  it("识别不到时给出粘贴提示", async () => {
    resolveMock.mockResolvedValueOnce(null);
    const result = await resolveShareShow({ text: "没有链接" });
    expect(result.data?.itemId).toBeNull();
    expect(result.data?.message).toContain("分享");
  });
});
