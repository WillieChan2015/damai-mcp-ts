import { afterEach, describe, expect, it, vi } from "vitest";

import { ADBError } from "../src/utils/errors";
import { damaiUrl, extractDamaiItemId, resolveDamaiItemId } from "../src/damai/itemId";
import { interpretActivityTopDump, readCurrentDamaiItem } from "../src/damai/readItem";

const shellMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());

vi.mock("../src/device/adb", () => ({
  shell: shellMock,
}));

const ITEM = "1063631004645";

afterEach(() => {
  shellMock.mockReset();
});

describe("extractDamaiItemId", () => {
  it("从分享长链、scheme、detail 页和百分号编码里抽出编号", () => {
    expect(
      extractDamaiItemId(
        `我在大麦发现了一场演出 https://m.damai.cn/shows/item.html?itemId=${ITEM}&from=appShare`,
      ),
    ).toBe(ITEM);
    expect(extractDamaiItemId(`damai://item?id=${ITEM}`)).toBe(ITEM);
    expect(extractDamaiItemId(`damai://item?from=share&id=${ITEM}`)).toBe(ITEM);
    expect(extractDamaiItemId(`damai://item/${ITEM}`)).toBe(ITEM);
    expect(extractDamaiItemId(`https://detail.damai.cn/item.htm?id=${ITEM}`)).toBe(ITEM);
    expect(extractDamaiItemId(`https://m.damai.cn/shows/item.html?itemId%3D${ITEM}`)).toBe(ITEM);
  });

  it("整段就是编号时直接采用", () => {
    expect(extractDamaiItemId(`  ${ITEM}  `)).toBe(ITEM);
    expect(extractDamaiItemId(`${ITEM}\u200b`)).toBe(ITEM);
  });

  it("不把 pid、skuId、外站 id 或过短数字当成演出编号", () => {
    expect(extractDamaiItemId("pid=12345678901 userId=12345678")).toBeNull();
    expect(extractDamaiItemId("https://m.damai.cn/shows/item.html?skuId=123456789")).toBeNull();
    expect(extractDamaiItemId("https://example.com/item.html?id=1063631004645")).toBeNull();
    expect(extractDamaiItemId("999")).toBeNull();
  });

  it("同时出现 itemId 和别的 id 时采用 itemId", () => {
    expect(
      extractDamaiItemId(
        `https://detail.damai.cn/item.htm?id=599817890400 真正的场次 itemId=${ITEM}`,
      ),
    ).toBe(ITEM);
  });
});

describe("resolveDamaiItemId", () => {
  it("短链只在 damai.cn 内跟随，最终 URL 上的编号可用", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toBe("https://m.damai.cn/s/abc");
      return new Response(null, {
        status: 302,
        headers: { location: `https://m.damai.cn/shows/item.html?itemId=${ITEM}` },
      });
    });
    await expect(resolveDamaiItemId("https://m.damai.cn/s/abc", fetchImpl)).resolves.toBe(ITEM);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("落地页 HTML 里的 itemId 可用", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(`<a href="/shows/item.html?itemId=${ITEM}">开售</a>`, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });
    await expect(resolveDamaiItemId("看看 https://m.damai.cn/s/xyz 。", fetchImpl)).resolves.toBe(ITEM);
  });

  it("外站链接和不留在大麦域内的跳转都不请求目标", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(null, {
        status: 302,
        headers: { location: `http://127.0.0.1/secret?itemId=${ITEM}` },
      });
    });
    await expect(resolveDamaiItemId("https://example.com/s/abc", fetchImpl)).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();

    await expect(resolveDamaiItemId("https://m.damai.cn/s/leave", fetchImpl)).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(damaiUrl("https://user:pass@m.damai.cn/s/abc")).toBeNull();
    expect(damaiUrl("https://damai.cn.evil.com/item?itemId=12345678")).toBeNull();
  });
});

describe("interpretActivityTopDump", () => {
  it("取最上面的大麦详情 Intent，不取栈里更早的演出", () => {
    const dump = `
ACTIVITY MANAGER ACTIVITIES (dumpsys activity top)
  * Hist #0: ActivityRecord{111 u0 cn.damai/.ProjectDetailActivity t12}
    Intent { dat=damai://item?id=${ITEM} cmp=cn.damai/.ProjectDetailActivity }
  * Hist #1: ActivityRecord{222 u0 cn.damai/.MainActivity t12}
    Intent { dat=damai://item?id=599817890400 }
`;
    expect(interpretActivityTopDump(dump)).toEqual({ foreground: true, itemId: ITEM });
  });

  it("前台不是大麦时不采用后台里的编号", () => {
    const dump = `
  * Hist #0: ActivityRecord{9 u0 com.android.settings/.Settings t3}
  * Hist #1: ActivityRecord{8 u0 cn.damai/.ProjectDetailActivity t2}
    Intent { dat=damai://item?id=${ITEM} }
`;
    expect(interpretActivityTopDump(dump)).toEqual({ foreground: false, itemId: null });
  });

  it("大麦在前台但当前页没有编号", () => {
    const dump = `
  * Hist #0: ActivityRecord{111 u0 cn.damai/.homepage.MainActivity t12}
    Intent { act=android.intent.action.MAIN cmp=cn.damai/.homepage.MainActivity }
`;
    expect(interpretActivityTopDump(dump)).toEqual({ foreground: true, itemId: null });
  });

  it("adb 把设备错误写在首行时抛 ADBError", () => {
    expect(() => interpretActivityTopDump("error: device offline\n")).toThrow(ADBError);
  });
});

describe("readCurrentDamaiItem", () => {
  it("top 没有 Activity 段时改读 activities", async () => {
    shellMock
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(
        `* Hist #0: ActivityRecord{1 u0 cn.damai/.Detail t1}\nIntent { dat=damai://item?id=${ITEM} }`,
      );
    await expect(readCurrentDamaiItem("serial")).resolves.toEqual({
      foreground: true,
      itemId: ITEM,
    });
    expect(shellMock).toHaveBeenCalledTimes(2);
    expect(shellMock.mock.calls[0]?.slice(0, 3)).toEqual(["dumpsys", "activity", "top"]);
    expect(shellMock.mock.calls[1]?.slice(0, 3)).toEqual(["dumpsys", "activity", "activities"]);
  });
});
