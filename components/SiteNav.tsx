"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/* ============================================================================
   SiteNav · 顶栏导航（规范依据 DESIGN.md §4.1）
   ----------------------------------------------------------------------------
   为什么是客户端组件：当前页高亮依赖 usePathname()。

   与补丁时代的关键差别：线上曾用 nav-active.js 在浏览器里给 <a> 补
   aria-current 属性（因为构建产物里没有这个标记，且要额外做 /app 前缀
   归一化 —— 那是 workbench 反代的产物）。
   回到源码后不需要那套：
     · 当前页判定直接用应用内路径（usePathname），不涉及反代伪前缀
     · aria-current 由 React 声明式输出，无需 MutationObserver 监听
   ==========================================================================*/

const NAV_ITEMS = [
  { href: "/", label: "行情中心" },
  { href: "/stocks", label: "股票列表" },
  { href: "/account", label: "模拟账户" },
  { href: "/sim", label: "历史模拟" },
  { href: "/backtest", label: "策略回测" },
  { href: "/simtrade", label: "模拟炒股" },
] as const;

/** 当前页判定："/" 精确匹配；其余允许子路径（/stocks/000001 命中 /stocks） */
function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}

export function SiteNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="主导航"
      /* 窄屏收为横向可滚动（§8.1 <768px），滚动条隐藏以免破坏顶栏高度 */
      className="-mx-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {NAV_ITEMS.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "shrink-0 whitespace-nowrap rounded-[8px] px-2.5 py-1.5 text-[13.5px] transition-colors sm:px-3",
              /* 选中态用「半透明品牌底 + 内描边」而非纯色块，避免在深底上过重。
                 浅字 #A8B8D0 于 #0D1A2E 上 8.66:1（AAA）。 */
              active
                ? "bg-[rgba(78,123,255,.26)] font-semibold text-white shadow-[inset_0_0_0_1px_rgba(130,170,255,.4)]"
                : "text-[#a8b8d0] hover:bg-[rgba(255,255,255,.09)] hover:text-white",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
