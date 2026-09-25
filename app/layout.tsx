import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";
import { cn } from "@/lib/utils";
import { SiteNav } from "@/components/SiteNav";
import { BottomTabBar } from "@/components/BottomTabBar";

export const metadata: Metadata = {
  title: "A股模拟交易系统",
  description: "A股个股模拟交易 + 行情 + 收益分析 + 历史回测",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  /* 移动端浏览器地址栏/状态栏配色跟随深色页面，避免顶部出现一条亮白色条
     （`viewportFit: cover` 已让页面铺到安全区，若不声明 themeColor 会出现色差带） */
  themeColor: "#0f141a",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    /*
      全站深色（2026-09-23）：`globals.css` 的 `.dark` 令牌块早已存在但一直没有
      挂载点（原注释写明「深色模式当前无切换入口」）。这里在 <html> 上挂 `dark`，
      全站的 `bg-background / text-foreground / border-border / --canvas /
      --card / --stock-up…` 一次性翻转到深色，无需逐组件改。
    */
    <html lang="zh-CN" className="dark" suppressHydrationWarning>
      <body className={cn("min-h-screen bg-background antialiased")}>
        {/*
          顶栏：原先是一段海军蓝渐变（#152945 → #0d1a2e），那是「浅色画布 + 深色 chrome」
          时代的设计。全站转深色后若保留蓝渐变，会与近黑的页面底形成两条割裂的深色带。
          现统一到 --surface-sunken (#0f141a)，与底部 tab bar 同色 ——
          上下形成一对「书夹」，中间的内容区自然成为视觉主体。
        */}
        <header className="sticky top-0 z-topbar border-b border-[rgba(255,255,255,.08)] bg-[#0f141a]/95 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-[1320px] items-center gap-3 px-4 sm:gap-6 sm:px-5">
            <Link href="/" className="flex shrink-0 items-center gap-2 whitespace-nowrap">
              <span className="text-base font-semibold tracking-tight text-white">
                A股模拟交易
              </span>
              <span className="hidden rounded bg-[rgba(255,255,255,.08)] px-1.5 py-0.5 text-[10px] text-[#9db0cc] sm:inline">
                DEMO
              </span>
            </Link>

            <SiteNav />

            <div className="hidden shrink-0 text-xs text-[#a8b8d0] lg:block">
              数据：真实历史日K
            </div>
          </div>
        </header>

        {/*
          内容区宽度统一 1320px。
          底部避让：`--tabbar-h` 只在 <768px 生效（底栏 `md:hidden`），
          因此桌面端用 `md:pb-5` 还原原始内边距，不留下多余空白。
        */}
        <main className="mx-auto max-w-[1320px] px-4 py-5 pb-[calc(var(--tabbar-h)+env(safe-area-inset-bottom)+1.25rem)] sm:px-5 md:pb-5">
          {children}
        </main>

        <footer className="mx-auto max-w-[1320px] px-4 pt-4 pb-[calc(var(--tabbar-h)+env(safe-area-inset-bottom)+2rem)] text-center text-xs text-muted-foreground sm:px-5 md:pb-8">
          本系统为学习用模拟交易工具，行情为历史真实数据，不构成投资建议。
        </footer>

        {/* 移动端底部导航（<768px 显示；桌面靠顶栏二级菜单） */}
        <BottomTabBar />
      </body>
    </html>
  );
}
