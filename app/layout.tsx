import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";
import { cn } from "@/lib/utils";
import { SiteNav } from "@/components/SiteNav";

export const metadata: Metadata = {
  title: "A股模拟交易系统",
  description: "A股个股模拟交易 + 行情 + 收益分析 + 历史回测",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className={cn("min-h-screen bg-background antialiased")}>
        {/*
          §4.1 深色顶栏
          这是本次规范中唯一"改变产品观感"的部分：深色 chrome 既是产品识别点，
          又给页面上沿一个视觉"闭合"，让下方浅色画布（#F3F6FA）有参照物。
          高度固定 56px；边框用半透明白而非 --border（浅色边框在深底上会显脏）。
        */}
        <header className="sticky top-0 z-topbar border-b border-[rgba(255,255,255,.08)] bg-[linear-gradient(180deg,#152945_0%,#0d1a2e_100%)]">
          <div className="mx-auto flex h-14 max-w-[1320px] items-center gap-3 px-4 sm:gap-6 sm:px-5">
            <Link href="/" className="flex shrink-0 items-center gap-2">
              <span className="text-base font-semibold tracking-tight text-white">
                A股模拟交易
              </span>
              {/* DEMO 徽标：原 bg-muted + text-muted-foreground 在深底上不可读，
                  改用半透明白底 + 次级浅蓝（于 #0D1A2E 上 6.9:1） */}
              <span className="hidden rounded bg-[rgba(255,255,255,.08)] px-1.5 py-0.5 text-[10px] text-[#9db0cc] sm:inline">
                DEMO
              </span>
            </Link>

            <SiteNav />

            {/* 装饰性说明文字：<1024px 隐藏。
                顶栏链接加了 nowrap 后，这段文字会在平板宽度被挤成竖排细条。 */}
            <div className="hidden shrink-0 text-xs text-[#a8b8d0] lg:block">
              数据：真实历史日K
            </div>
          </div>
        </header>

        {/* 内容区宽度统一 1320px（原 1400px：单行表格过长，视线横向跨度过大） */}
        <main className="mx-auto max-w-[1320px] px-4 py-5 sm:px-5">
          {children}
        </main>

        <footer className="mx-auto max-w-[1320px] px-4 pb-8 pt-4 text-center text-xs text-muted-foreground sm:px-5">
          本系统为学习用模拟交易工具，行情为历史真实数据，不构成投资建议。
        </footer>
      </body>
    </html>
  );
}
