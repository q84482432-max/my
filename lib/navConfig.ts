/**
 * 站点导航配置 —— 纯数据 + 纯函数，**唯一来源**
 *
 * ## 为什么把导航配置从组件里抽出来
 *
 * 顶栏（`SiteNav` 二级菜单）与底栏（`BottomTabBar`）都依赖 `usePathname()`，
 * 而 `usePathname` 需要 Next App Router 的**运行时上下文**。这让导航「有哪些入口、
 * 指向哪个路由、当前是否高亮」这几件事**无法脱离 Next 运行时被验证** ——
 * 既不能做 SSR 断言，也不能做单元测试，只能靠人点着看。
 *
 * 抽出本模块后：
 *   · 入口清单与高亮规则成为纯数据/纯函数 → 可直接断言（见 `scripts/testNavConfig.ts`）
 *   · 顶栏与底栏共用同一份清单与同一套高亮逻辑 → 不会出现「顶栏叫这个名字、
 *     底栏叫那个名字」或「同一个路由在两边高亮行为不一致」的漂移
 */

/** 一个导航入口 */
export interface NavItem {
  /** 应用内路由（不含 workbench 反代的 `/app` 前缀） */
  href: string;
  /** 展示文案 */
  label: string;
}

/**
 * 顶栏**主场入口**：常驻可见的高频项（本产品的主场只有一个）。
 */
export const PRIMARY_NAV: NavItem = { href: "/simtrade", label: "模拟炒股" };

/**
 * 顶栏**二级菜单**收纳的工具入口（2026-09-23 从平铺改为下拉）。
 *
 * 排序：行情类 → 账户/复盘类。
 *
 * 注意 `行情中心` 指向 `/`，与底栏的「首页」是**同一个路由**，只是沿用需求原文的
 * 两处不同措辞。若要统一叫法，只改这里的 label 即可（顶栏与底栏都不会漏改）。
 */
export const MENU_NAV: NavItem[] = [
  { href: "/", label: "行情中心" },
  { href: "/stocks", label: "股票列表" },
  { href: "/indices", label: "指数" },
  { href: "/account", label: "模拟账户" },
  { href: "/sim", label: "历史模拟" },
  { href: "/backtest", label: "策略回测" },
];

/**
 * 移动端**底部 tab bar** 的 5 个主场入口。
 *
 * 与顶栏二级菜单是**分工**而非重复：
 *   · 顶栏管「不常用工具」（指数、历史模拟、策略回测等）
 *   · 底栏管「常用主场」——需要单手可达、常驻可见
 * 因此两边清单必然有交集（如 行情 / 交易 / 回测），这是有意为之。
 */
export const BOTTOM_TABS: NavItem[] = [
  { href: "/", label: "首页" },
  { href: "/stocks", label: "行情" },
  { href: "/simtrade", label: "交易" },
  { href: "/backtest", label: "回测" },
  { href: "/account", label: "我的" },
];

/**
 * 当前页判定：`/` 精确匹配；其余允许子路径。
 *
 * 为什么 `/` 必须精确匹配：任何路径都以 `/` 开头，若用 `startsWith("/")`
 * 则**所有页面都会把首页判为当前页**，底栏会出现两个高亮项。
 *
 * 子路径为什么允许：`/stocks/000001`（个股详情）应让 `/stocks` 保持高亮，
 * 否则用户从列表点进详情后导航就"失去位置感"。
 */
export function isNavActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}
