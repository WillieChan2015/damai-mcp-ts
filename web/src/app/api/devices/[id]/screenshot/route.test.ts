import { Buffer } from "node:buffer";

import { Jimp } from "jimp";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ADBError } from "@core/utils/errors";

// 纯函数直测（不起服务，对齐 events/route.test.ts 先例）：
// 只 mock core 的 screenshot 动作，ADBError 用真实类保证 instanceof 判定成立
vi.mock("@core/actions/actions", () => ({ screenshot: vi.fn() }));

import { screenshot } from "@core/actions/actions";
import { GET } from "./route";

const mockedScreenshot = vi.mocked(screenshot);

function makeRequest(id = "emulator-5554"): Request {
  return new Request(`http://localhost/api/devices/${id}/screenshot`);
}

let png: Buffer;

beforeAll(async () => {
  // 用 jimp 现做一张 8×8 PNG 当 core 返回值（与被测路由同包，保证可被其转码）
  const img = new Jimp({ width: 8, height: 8, color: 0x336699ff });
  png = await img.getBuffer("image/png");
});

beforeEach(() => {
  mockedScreenshot.mockReset();
});

describe("GET /api/devices/[id]/screenshot", () => {
  it("core 返回 PNG → 200 + image/jpeg + no-store，且按约定参数调用 core", async () => {
    mockedScreenshot.mockResolvedValue(png);

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: "emulator-5554" }) });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = Buffer.from(await res.arrayBuffer());
    // JPEG 魔数 FF D8
    expect(body.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

    expect(mockedScreenshot).toHaveBeenCalledTimes(1);
    expect(mockedScreenshot).toHaveBeenCalledWith("emulator-5554", undefined, {
      returnBase64: false,
      maxSize: [720, 1280],
    });
  });

  it("core 抛 ADBError（重试 2 次耗尽）→ 502 + 中文 error", async () => {
    mockedScreenshot.mockRejectedValue(new ADBError("设备未连接"));

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: "emulator-5554" }) });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("设备截图失败");
    expect(body.error).toContain("设备未连接");
  });

  it("core 抛其他异常 → 500 + 中文 error", async () => {
    mockedScreenshot.mockRejectedValue(new Error("boom"));

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: "emulator-5554" }) });

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("设备截图失败");
    expect(body.error).toContain("boom");
  });

  it("空 id / 纯空白 id → 400，且不触发 core 调用", async () => {
    for (const id of ["", "   "]) {
      const res = await GET(makeRequest(id), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("设备 id 不能为空");
    }
    expect(mockedScreenshot).not.toHaveBeenCalled();
  });
});
