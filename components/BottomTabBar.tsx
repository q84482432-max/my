"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BOTTOM_TABS, isNavActive } from "@/lib/navConfig";
import { cn } from "@/lib/utils";

/* ============================================================================
   BottomTabBar · 移动端底部导航（深色）
   ----------------------------------------------------------------------------
   为什么加它：移动端顶部二级菜单是「工具入口」，而高频操作（看行情 / 去交易 /
   查回测 / 看账户）需要**单手可达**的常驻入口 —— 这是移动端交易类应用的标准分工，
   两者不是重复而是分层：顶栏管「不常用工具」，底栏管「常用主场」。

   ⚠️ 与模拟交易页的底部交易栏堆叠（关键，改高度时两处都要改）：
   `/simtrade` 页自己有一个固定在底部的交易操作栏（买入/卖出/观望）。
   本组件**占据最底部**，交易栏靠 `--tabbar-h` 上移一层。
   因此高度统一由 `globals.css` 的 `--tabbar-h` 提供，**不要在这里写死数字**。

   仅在 <768px 显示：桌面宽度下顶栏二级菜单已足够，再挂一条底栏是冗余。
   ==========================================================================*/

/** 预设路由 → 图标（20×20 描边式，不依赖图标库，避免新增依赖） */
function IconHome({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" aria-hidden="true">
      <path
        d="M3 8.6 10 3l7 5.6V16a1 1 0 0 1-1 1h-3.5v-4.5h-5V17H4a1 1 0 0 1-1-1V8.6Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconMarket({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" aria-hidden="true">
      <path d="M3 16V9M7.5 16V4.5M12 16v-6M16.5 16V7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function IconTrade({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" aria-hidden="true">
      <path d="M3.5 13.5 7 10l3 3 6.5-6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13 6.5h3.5V10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconBacktest({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" aria-hidden="true">
      <path d="M10 5v5l3.2 2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16.5 10a6.5 6.5 0 1 1-1.9-4.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M16.5 3v3.2h-3.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconUser({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" aria-hidden="true">
      <circle cx="10" cy="7" r="3.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3.8 17c.9-3.1 3.3-4.6 6.2-4.6s5.3 1.5 6.2 4.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/**
 * 入口清单与高亮规则见 `lib/navConfig.ts`（唯一来源）。此处只把「路由 → 图标」绑定起来：
 * 图标属于展示细节，路由与文案属于导航契约，两者分开才不会出现
 * 「改了路由漏改图标」或「两边文案不一致」。
 */
const TAB_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  "/": IconHome,
  "/stocks": IconMarket,
  "/simtrade": IconTrade,
  "/backtest": IconBacktest,
  "/account": IconUser,
};

export function BottomTabBar() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="底部导航"
      /* 固定在最底：用 `fixed` 而非 sticky —— 交易类应用的底栏必须始终可见，
         不随页面滚走。内容侧避让由 layout.tsx 给 <main>/<footer> 加
         `padding-bottom: --tabbar-h` 完成（不在这里塞占位元素）。
         安全区内边距用 padding 撑开而不是加高容器，保证 `--tabbar-h`
         始终等于「内容区高度」，模拟交易页交易栏的偏移量才算得准。 */
      className="fixed inset-x-0 bottom-0 z-topbar border-t border-[rgba(255,255,255,.08)] bg-[#0f141a]/95 backdrop-blur md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="flex h-[var(--tabbar-h)] items-stretch">
        {BOTTOM_TABS.map(({ href, label }) => {
          const active = isNavActive(pathname, href);
          const Icon = TAB_ICONS[href] ?? IconHome;
          return (
            <li key={href} className="flex-1">
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-full flex-col items-center justify-center gap-1 text-[11px] transition-colors",
                  active ? "text-[#5b93f5]" : "text-[#8b94a3] hover:text-[#c7d0dc]",
                )}
              >
                <Icon className="h-5 w-5" />
                <span className={cn(active && "font-medium")}>{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
