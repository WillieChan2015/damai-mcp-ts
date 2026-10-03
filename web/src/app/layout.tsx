import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono, Noto_Serif_SC } from "next/font/google";
import "./globals.css";

import { NavLinks } from "./NavLinks";
import { Providers } from "./providers";
import { ThemeToggle } from "./ThemeToggle";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// 衬线中文展示字体：戏剧海报气质的页题与品牌（按需子集加载，不 preload）
const displaySerif = Noto_Serif_SC({
  weight: ["600", "900"],
  subsets: [],
  preload: false,
  variable: "--font-display-serif",
});

export const metadata: Metadata = {
  title: "抢票指挥台",
  description: "大麦抢票可视化指挥台：任务、监控、日志与调试",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="zh-CN"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${displaySerif.variable} h-full antialiased`}
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("damai_theme");if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t);}}catch(e){}})();`,
          }}
        />
      </head>
      <body className="flex min-h-full flex-col bg-paper text-ink transition-colors duration-150">
        <Providers>
          <header className="sticky top-0 z-20 border-b border-line bg-surface/90 backdrop-blur">
            <nav
              className="mx-auto flex w-full max-w-7xl items-center gap-4 sm:gap-6 px-4 py-2.5 sm:px-6"
              aria-label="品牌与导航"
            >
              <Link href="/" className="whitespace-nowrap">
                <span className="font-display text-lg font-black tracking-tight text-ink">
                  抢票指挥台
                </span>
              </Link>
              <NavLinks />
              <ThemeToggle />
            </nav>
          </header>
          <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
          <footer className="border-t border-line bg-surface/50">
            <div className="mx-auto flex w-full max-w-7xl flex-col items-start justify-between gap-2 px-4 py-3 text-xs text-muted sm:flex-row sm:items-center sm:px-6">
              <span>流程止步于人工确认，支付永远手动完成 · 仅供学习研究</span>
              <span className="font-mono text-[11px]">v0.2.3 · 宽屏指挥舱体系</span>
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
