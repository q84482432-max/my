"use client";

import Link from "next/link";
import { MENU_NAV, isNavActive } from "@/lib/navConfig";
import { cn } from "@/lib/utils";

/* ============================================================================
   NavMenuPanel · 顶栏二级菜单的**面板本体**（纯展示，不读路由上下文）
   ----------------------------------------------------------------------------
   为什么把它从 `SiteNav` 里拆出来：
     `SiteNav` 需要 `usePathname()` 拿当前路由，而 `usePathname` 依赖 Next App Router
     的**运行时上下文** —— 在没有该上下文的环境（SSR 断言 / 单测）里直接抛错。
     结果是「菜单里到底渲染了哪几项、当前项有没有高亮」这件最该被测的事，
     反而只能靠人点开看。
     拆出来后 `pathname` 由 props 传入，面板就变成可确定性渲染 + 可断言的纯组件
     （见 `scripts/testNavConfig.ts` 的 G 段）。
   ==========================================================================*/

export interface NavMenuPanelProps {
  /** 当前路由（由调用方从 `usePathname()` 取，便于测试注入） */
  pathname: string;
  /** 点击任一项后的回调（用于关闭菜单） */
  onNavigate?: () => void;
}

export function NavMenuPanel({ pathname, onNavigate }: NavMenuPanelProps) {
  return (
    <div
      id="site-nav-menu"
      role="menu"
      className="absolute left-0 top-[calc(100%+8px)] z-dropdown w-[236px] overflow-hidden rounded-lg border border-[rgba(255,255,255,.10)] bg-[#151a21] py-1 shadow-overlay"
    >
      {MENU_NAV.map((item) => {
        const active = isNavActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            role="menuitem"
            aria-current={active ? "page" : undefined}
            onClick={onNavigate}
            className={cn(
              "flex items-center justify-between px-3 py-2 text-[13.5px] transition-colors",
              active
                ? "bg-[rgba(78,123,255,.18)] font-medium text-white"
                : "text-[#c7d0dc] hover:bg-[rgba(255,255,255,.06)] hover:text-white",
            )}
          >
            <span>{item.label}</span>
            {active && <span className="text-[11px] text-[#5b93f5]">当前</span>}
          </Link>
        );
      })}
    </div>
  );
}
