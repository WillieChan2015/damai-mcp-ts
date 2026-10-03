import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { Providers } from "./providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Damai Web Console",
  description: "damai-mcp-ts 可视化控制台",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-zinc-50 dark:bg-black">
        <Providers>
          <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
            {/* flex-wrap：7 个导航项在窄屏下换行而非溢出（桌面端视觉不变） */}
            <nav className="mx-auto flex w-full max-w-4xl flex-wrap items-center gap-x-4 gap-y-2 px-6 py-3 sm:gap-x-6">
              <Link href="/" className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                🎫 Damai Console
              </Link>
              <Link
                href="/devices"
                className="text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                设备
              </Link>
              <Link
                href="/tasks"
                className="text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                抢票任务
              </Link>
              <Link
                href="/monitor"
                className="text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                监控
              </Link>
              <Link
                href="/notify"
                className="text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                通知
              </Link>
              <Link
                href="/logs"
                className="text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                日志
              </Link>
              <Link
                href="/probe"
                className="text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                调试器
              </Link>
              <Link
                href="/ai"
                className="text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                AI 助手
              </Link>
              <span className="ml-auto text-xs text-zinc-400">永不自动支付 · 仅供学习研究</span>
            </nav>
          </header>
          <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-8">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
