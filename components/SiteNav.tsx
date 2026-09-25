"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NavMenuPanel } from "@/components/NavMenuPanel";
import { MENU_NAV, PRIMARY_NAV, isNavActive } from "@/lib/navConfig";
import { cn } from "@/lib/utils";

/* ============================================================================
   SiteNav · 顶栏「主场 + 二级菜单」（2026-09-23 改版）
   ----------------------------------------------------------------------------
   原实现把 7 个入口**平铺**在一条横向滚动条里（`overflow-x-auto`）。两个问题：
     1. 窄屏（手机）必须横向滑动才能看到后面的项，最右那项常年「藏」在屏幕外
        —— 用户根本不知道它存在。滚动条本身还被 `[scrollbar-width:none]`
        隐藏了，连「右侧还有内容」这个线索都没有。
     2. 7 个入口**完全平级**，而本产品的主场只有一个（模拟炒股）。
        平级罗列等于没有主次。

   现改为「**一个主场常驻 + 一个二级菜单收纳其余**」：
     · `模拟炒股` 常驻可见（主场，高频）
     · 其余 6 个工具入口收进下拉菜单

   **全尺寸统一收起**（用户明确要求）：不再按断点区分两套结构 ——
   一套结构在桌面与移动端完全一致，避免「同一个人换设备后菜单内容变了」的困惑。

   交互约定：点击遮罩 / 按 Esc / 路由变化 三者任一即关闭。缺一不可 ——
   只做「点按钮切换」会导致菜单在导航后仍然挂在屏幕上。
   ==========================================================================*/

/* 入口清单与高亮规则见 `lib/navConfig.ts`（唯一来源，可被单测断言）。
   此处只负责渲染与交互 —— 组件里不再自带一份清单，避免与底栏漂移。 */

export function SiteNav() {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  /* 路由变化即关闭：否则点完菜单项跳转后，下拉仍悬在页面上。
     依赖 pathname 而不是 open，是为了让「已关闭」的情况不做无谓 setState。 */
  React.useEffect(() => {
    setOpen(false);
  }, [pathname]);

  /* 点击组件外部关闭 + Esc 关闭 */
  React.useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const el = rootRef.current;
      if (el && !el.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const primaryActive = isNavActive(pathname, PRIMARY_NAV.href);
  const menuActive = MENU_NAV.some((it) => isNavActive(pathname, it.href));

  return (
    <div ref={rootRef} className="relative flex min-w-0 flex-1 items-center gap-1">
      <Link
        href={PRIMARY_NAV.href}
        aria-current={primaryActive ? "page" : undefined}
        className={cn(
          "shrink-0 whitespace-nowrap rounded-[8px] px-2.5 py-1.5 text-[13.5px] transition-colors sm:px-3",
          primaryActive
            ? "bg-[rgba(78,123,255,.26)] font-semibold text-white shadow-[inset_0_0_0_1px_rgba(130,170,255,.4)]"
            : "text-[#a8b8d0] hover:bg-[rgba(255,255,255,.09)] hover:text-white",
        )}
      >
        {PRIMARY_NAV.label}
      </Link>

      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="site-nav-menu"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[8px] px-2.5 py-1.5 text-[13.5px] transition-colors sm:px-3",
          open || menuActive
            ? "bg-[rgba(78,123,255,.26)] font-semibold text-white shadow-[inset_0_0_0_1px_rgba(130,170,255,.4)]"
            : "text-[#a8b8d0] hover:bg-[rgba(255,255,255,.09)] hover:text-white",
        )}
      >
        <span>更多</span>
        {/* 展开指示：仅用 CSS 三角，不引入图标库 */}
        <span
          aria-hidden="true"
          className={cn(
            "inline-block h-0 w-0 border-x-[4px] border-t-[5px] border-x-transparent transition-transform",
            open ? "rotate-180 border-t-white" : "border-t-current",
          )}
        />
      </button>

      {open && (
        <>
          {/* 遮罩：移动端点击空白处关闭更自然。
              桌面端视觉上不可见但仍可点击（不做纯装饰 div，避免只靠 Esc 关闭）。 */}
          <div
            className="fixed inset-0 z-dropdown bg-black/20 md:bg-transparent"
            aria-hidden="true"
          />
          {/* 面板本体见 `NavMenuPanel`（纯展示组件，便于脱离路由上下文做 SSR 断言） */}
          <NavMenuPanel pathname={pathname} onNavigate={() => setOpen(false)} />
        </>
      )}
    </div>
  );
}
