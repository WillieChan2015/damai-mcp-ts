import { describe, expect, it } from "vitest";

import { GET } from "./route";
import { getTaskManager } from "@/task/manager";

function makeRequest(url = "http://localhost/api/tasks/x/events"): Request {
  return new Request(url, { headers: { accept: "text/event-stream" } });
}

async function readAll(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

describe("GET /api/tasks/[id]/events（SSE 路由）", () => {
  it("任务不存在 → 404", async () => {
    const res = await GET(makeRequest(), { params: Promise.resolve({ id: "nope" }) });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("任务不存在");
  });

  it("已终结任务：补发 backlog + 终态事件后关流", async () => {
    const mgr = getTaskManager();
    const snap = mgr.start({
      kind: "custom",
      deviceId: "sse-test-ended",
      runner: async ({ onProgress }) => {
        onProgress("line-a");
        onProgress("line-b");
        return { status: "ok" };
      },
    });
    await mgr.whenSettled(snap.id);

    const res = await GET(makeRequest(), {
      params: Promise.resolve({ id: snap.id }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-store");

    const text = await readAll(res);
    expect(text).toContain("event: progress");
    expect(text).toContain("line-a");
    expect(text).toContain("line-b");
    expect(text).toContain('"status":"succeeded"');
    // 终态事件应包含 result
    expect(text).toContain("event: status");
    expect(text).toContain('"result"');
    // text() 能读完 = 流已正常关闭
  });

  it("运行中任务：订阅后实时收到 progress，取消后收到终态并关流", async () => {
    const mgr = getTaskManager();
    const snap = mgr.start({
      kind: "custom",
      deviceId: "sse-test-live",
      runner: async ({ stopEvent, onProgress }) => {
        let n = 0;
        while (!stopEvent.isSet()) {
          onProgress(`tick ${n++}`);
          await new Promise((r) => setTimeout(r, 20));
        }
        onProgress("stopped");
      },
    });

    const res = await GET(makeRequest(), {
      params: Promise.resolve({ id: snap.id }),
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 10000;
    let sawCancelled = false;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      text += decoder.decode(value, { stream: true });
      if (text.includes("tick 0") && !text.includes("cancelled")) {
        mgr.cancel(snap.id);
      }
      if (text.includes('"status":"cancelled"')) {
        sawCancelled = true;
        break;
      }
    }
    expect(sawCancelled).toBe(true);
    expect(text).toContain("event: progress");
    expect(text).toContain("event: status");
    // 流应已关闭（再读一次应立即 done）
    const final = await reader.read();
    expect(final.done).toBe(true);
  });

  it("心跳注释行存在（task 已终结时可能无心跳——用 backlog 流验证协议字段）", async () => {
    const mgr = getTaskManager();
    const snap = mgr.start({
      kind: "custom",
      deviceId: "sse-test-protocol",
      runner: async ({ onProgress }) => {
        onProgress("hello");
      },
    });
    await mgr.whenSettled(snap.id);
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ id: snap.id }),
    });
    const text = await readAll(res);
    // SSE 事件帧格式：event: + data: 成对出现
    expect(text).toMatch(/event: progress\ndata: /);
    expect(text).toMatch(/event: status\ndata: /);
  });
});
