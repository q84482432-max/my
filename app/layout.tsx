import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";
import { cn } from "@/lib/utils";

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

const NAV_ITEMS = [
  { href: "/", label: "行情中心" },
  { href: "/stocks", label: "股票列表" },
  { href: "/account", label: "模拟账户" },
  { href: "/sim", label: "历史模拟" },
  { href: "/backtest", label: "策略回测" },
  { href: "/simtrade", label: "模拟炒股" },
];

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className={cn("min-h-screen bg-background antialiased")}>
        <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-3 px-3 sm:gap-6 sm:px-4">
            <Link href="/" className="flex shrink-0 items-center gap-2">
              <span className="text-base font-semibold tracking-tight">
                A股模拟交易
              </span>
              <span className="hidden rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline">
                DEMO
              </span>
            </Link>
            <nav className="-mx-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {NAV_ITEMS.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="shrink-0 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:px-3"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="hidden shrink-0 text-xs text-muted-foreground lg:block">
              数据：真实历史日K
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-[1400px] px-3 py-4 sm:px-4 sm:py-6">
          {children}
        </main>
        <footer className="mx-auto max-w-[1400px] px-4 pb-8 pt-4 text-center text-xs text-muted-foreground">
          本系统为学习用模拟交易工具，行情为历史真实数据，不构成投资建议。
        </footer>
      </body>
    </html>
  );
}
