import { describe, expect, it, vi } from "vitest";

import { appendNotification, type TaskNotifyConfig } from "./taskNotify";

const config: TaskNotifyConfig = {
  origin: "https://example.ilinkai.weixin.qq.com",
  token: "token",
  contextToken: "context",
  target: "user",
};

describe("appendNotification", () => {
  it("失败只追加通知状态，调用方结果保持原样", async () => {
    const lines: string[] = [];
    const notice = await appendNotification({
      config,
      shouldSend: true,
      text: "待人工确认",
      onProgress: (line) => lines.push(line),
      send: async () => {
        throw new Error("超时");
      },
    });
    const result = { status: "ready_for_human", ...notice };
    expect(result.status).toBe("ready_for_human");
    expect(result.notification_status).toBe("failed");
    expect(result.notification_error).toBe("超时");
    expect(lines[0]).toContain("微信通知失败");
  });

  it("未配置时不发送", async () => {
    const send = vi.fn();
    const notice = await appendNotification({
      config: null,
      shouldSend: true,
      text: "发现余票",
      onProgress: () => undefined,
      send,
    });
    expect(send).not.toHaveBeenCalled();
    expect(notice.notification_status).toBe("unconfigured");
  });

  it("失败、取消、售罄不发", async () => {
    const send = vi.fn();
    const notice = await appendNotification({
      config,
      shouldSend: false,
      text: "售罄",
      onProgress: () => undefined,
      send,
    });
    expect(send).not.toHaveBeenCalled();
    expect(notice).toEqual({});
  });
});
