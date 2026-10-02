import { getTaskManager } from "@/task/manager";

export const dynamic = "force-dynamic";

/**
 * 任务进度 SSE 流（计划 D2）。
 *
 * 事件协议：
 * - `event: progress` data: { line, index } —— 补发 backlog 后转入实时；
 * - `event: status`   data: { status, error, result } —— 任务终结时发送并关流；
 * - 心跳注释行 `: heartbeat`（15s）防代理超时断连。
 * 客户端断开（req.signal abort）即退订并清理心跳。
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const manager = getTaskManager();
  const snapshot = manager.get(id);
  if (!snapshot) {
    return Response.json({ error: `任务不存在: ${id}` }, { status: 404 });
  }

  // backlog 起点：快照中缓冲区最早一行的全局序号（与订阅语义对齐，避免漏行）
  const fromIndex = snapshot.progressTotal - snapshot.progress.length;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let unsubscribe: (() => void) | null = null;

      const send = (event: string, data: unknown): void => {
        if (closed) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          close();
        }
      };
      const close = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        if (heartbeat !== null) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        if (unsubscribe !== null) {
          unsubscribe();
          unsubscribe = null;
        }
        try {
          controller.close();
        } catch {
          // 客户端已断开时 close 可能抛错——忽略
        }
      };

      // 补发 backlog，再转实时推送（subscribe 内部保证 index ≥ fromIndex）
      try {
        unsubscribe = manager.subscribe(id, fromIndex, (line, index) => {
          send("progress", { line, index });
        });
      } catch {
        close();
        return;
      }
      send("status", {
        status: snapshot.status,
        error: snapshot.error,
        result: snapshot.result,
      });

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          close();
        }
      }, 15000);

      // 已终结：发完终态即关；未终结：等 whenSettled 发终态后关
      if (snapshot.endedAtUnixMs !== null) {
        close();
        return;
      }
      void manager.whenSettled(id).then(() => {
        const final = manager.get(id);
        send("status", {
          status: final?.status ?? "failed",
          error: final?.error ?? null,
          result: final?.result ?? null,
        });
        close();
      });

      req.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
    },
  });
}
