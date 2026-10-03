import Link from "next/link";
import type { ReactNode } from "react";

import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type GlyphName =
  | "devices"
  | "tasks"
  | "monitor"
  | "notify"
  | "logs"
  | "probe"
  | "ai"
  | "shots"
  | "clock"
  | "refresh"
  | "terminal"
  | "check"
  | "alert"
  | "copy"
  | "sun"
  | "moon";

const PATHS: Record<GlyphName, ReactNode> = {
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </>
  ),
  moon: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />,
  devices: (
    <>
      <rect width="14" height="20" x="5" y="2" rx="2" />
      <line x1="12" x2="12.01" y1="18" y2="18" />
    </>
  ),
  tasks: (
    <>
      <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
      <path d="M13 5v2" />
      <path d="M13 17v2" />
      <path d="M13 11v2" />
    </>
  ),
  monitor: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
  notify: (
    <>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </>
  ),
  logs: (
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M10 9H8" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
    </>
  ),
  probe: (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="22" x2="18" y1="12" y2="12" />
      <line x1="6" x2="2" y1="12" y2="12" />
      <line x1="12" x2="12" y1="6" y2="2" />
      <line x1="12" x2="12" y1="22" y2="18" />
    </>
  ),
  ai: (
    <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
  ),
  shots: (
    <>
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2-2z" />
      <circle cx="12" cy="13" r="3" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </>
  ),
  refresh: (
    <>
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </>
  ),
  terminal: (
    <>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </>
  ),
  check: <polyline points="20 6 9 17 4 12" />,
  alert: (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" x2="12" y1="8" y2="12" />
      <line x1="12" x2="12.01" y1="16" y2="16" />
    </>
  ),
  copy: (
    <>
      <rect width="13" height="13" x="9" y="9" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
};

/** 线性图标（1.75 描边，继承 currentColor），替代 emoji。 */
export function Glyph({ name, className }: { name: GlyphName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {PATHS[name]}
    </svg>
  );
}

/** 页头：衬线页题 + 一句人话说明，支持右侧操作插槽。 */
export function PageHeader({
  title,
  lede,
  actions,
}: {
  title: string;
  lede: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 border-b border-line pb-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="font-display text-2xl font-semibold leading-tight text-ink">{title}</h1>
        <p className="mt-1 text-sm leading-relaxed text-muted">{lede}</p>
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** 战备状态指标卡。传入 href 时整张卡跳转到对应页面。 */
export function MetricCard({
  title,
  value,
  subtext,
  glyph,
  active = false,
  href,
}: {
  title: string;
  value: ReactNode;
  subtext: string;
  glyph: GlyphName;
  active?: boolean;
  href?: string;
}) {
  const className = `block p-4 transition-colors ${
    href ? "hover:border-ink/30 hover:bg-surface-raised" : ""
  } ${active ? "border-ink/40" : ""}`;
  const content = (
    <>
      <div className="flex items-center justify-between text-muted">
        <span className="text-xs font-medium">{title}</span>
        <Glyph name={glyph} className={`h-4 w-4 ${active ? "text-accent" : "text-muted"}`} />
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-ink font-mono">{value}</div>
      <div className="mt-1 text-xs text-muted">{subtext}</div>
    </>
  );
  if (href) {
    return (
      <Card className={className}>
        <Link href={href} className="block">
          {content}
        </Link>
      </Card>
    );
  }
  return <Card className={className}>{content}</Card>;
}

/** 面板：shadcn Card，标题与内容用细线分隔。 */
export function Panel({
  title,
  actions,
  children,
  className,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      {title ? (
        <CardHeader className="flex-row items-center justify-between border-b border-line">
          <CardTitle className="text-sm font-semibold text-ink">{title}</CardTitle>
          {actions ? <CardAction>{actions}</CardAction> : null}
        </CardHeader>
      ) : null}
      <CardContent className={title ? undefined : "p-5"}>{children}</CardContent>
    </Card>
  );
}
