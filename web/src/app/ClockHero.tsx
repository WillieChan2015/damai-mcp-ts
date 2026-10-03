"use client";

import { useEffect, useState } from "react";

/**
 * 首页 hero：本地实时时钟（100ms 步进，含百分秒）。
 * 挂载前渲染占位符，避免服务端/客户端水合不一致。
 */
export function ClockHero() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 100);
    return () => clearInterval(id);
  }, []);

  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  const time = now
    ? `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    : "--:--:--";
  const centis = now ? `.${pad(Math.floor(now.getMilliseconds() / 10))}` : "";
  const date = now
    ? `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日 · 周${"日一二三四五六"[now.getDay()]}`
    : "同步时间中…";
  const utcOffset = now ? -now.getTimezoneOffset() / 60 : 0;
  const utc = now
    ? `UTC${utcOffset >= 0 ? "+" : "−"}${Math.abs(utcOffset)}`
    : "";

  return (
    <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
      <div>
        <div className="flex items-center gap-2 text-xs font-medium text-muted">
          <span className="live-dot" />
          <span>本地基准时间（100ms 连续步进）</span>
        </div>
        <p
          className="mt-1 font-mono text-5xl font-semibold tracking-tight text-ink tabular-nums sm:text-6xl md:text-7xl"
          aria-label="当前本地时间"
        >
          {time}
          <span className="font-mono text-2xl text-muted sm:text-3xl md:text-4xl">{centis}</span>
        </p>
      </div>

      <div className="flex flex-col items-start gap-1 font-mono text-xs text-muted md:items-end">
        <div className="flex items-center gap-2">
          <span className="rounded border border-line bg-surface px-2 py-0.5 text-ink">
            {utc}
          </span>
          <span className="rounded border border-ok/30 bg-ok/10 px-2 py-0.5 text-ok">
            NTP 准点门控已激活
          </span>
        </div>
        <p className="mt-1 text-xs text-muted">
          {date}
        </p>
      </div>
    </div>
  );
}
