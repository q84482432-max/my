/**
 * testNavConfig —— 导航契约测试（顶栏二级菜单 + 底部 tab bar）
 *
 * 为什么单独测这个：
 *   导航入口与高亮规则是**用户唯一能感知的站点结构**。它此前散落在组件内部、
 *   依赖 `usePathname`（需要 Next 运行时上下文），因此无法脱离浏览器被断言 ——
 *   改错了只能靠人肉点。抽到 `lib/navConfig.ts` 后成为纯数据/纯函数，可确定性验证。
 *
 * 覆盖：
 *   1. 二级菜单**恰好**收纳需求指定的 6 项，且文案/路由一一对应
 *   2. 底栏**恰好**是需求指定的 5 项
 *   3. 主场入口 = 模拟炒股（常驻可见）
 *   4. 所有 href 都指向真实存在的页面路由（防止写出死链）
 *   5. 同一清单内无重复 href
 *   6. 高亮规则：`/` 只精确匹配；子路径继承高亮；前缀相似但不相同的路径**不得**误高亮
 *
 * 运行：DATABASE_URL="file:./test.db" "$NODE" -e "require('./runner.mjs').run('scripts/testNavConfig.ts')"
 */
import fs from "node:fs";
import path from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BOTTOM_TABS, MENU_NAV, PRIMARY_NAV, isNavActive } from "@/lib/navConfig";
import { NavMenuPanel } from "@/components/NavMenuPanel";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, extra = ""): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name} ${extra}`);
    console.log(`  ✗ ${name} ${extra}`);
  }
}

/** 读取 app 下真实存在的页面路由（用于死链检查） */
function realRoutes(): string[] {
  const root = process.cwd();
  const routes: string[] = [];
  /* 根路由是 `app/page.tsx`，它不在任何子目录里 —— 遍历只扫目录会漏掉它，
     导致「/ 找不到对应页面」的假失败。必须先显式收一个 `"/"`。 */
  if (fs.existsSync(path.join(root, "app", "page.tsx"))) routes.push("/");
  const walk = (dir: string, prefix: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const child = path.join(dir, e.name);
      const seg = e.name;
      const nextPrefix = `${prefix}/${seg}`.replace(/\/+/g, "/");
      if (fs.existsSync(path.join(child, "page.tsx"))) routes.push(nextPrefix);
      walk(child, nextPrefix);
    }
  };
  walk(path.join(root, "app"), "");
  return routes;
}

function main(): void {
  console.log("\n=== A. 顶栏主场入口 ===");
  check("主场 = 模拟炒股", PRIMARY_NAV.label === "模拟炒股", PRIMARY_NAV.label);
  check("主场路由 = /simtrade", PRIMARY_NAV.href === "/simtrade", PRIMARY_NAV.href);

  console.log("\n=== B. 二级菜单：恰好收纳指定的 6 项 ===");
  const expectMenu: Array<[string, string]> = [
    ["/", "行情中心"],
    ["/stocks", "股票列表"],
    ["/indices", "指数"],
    ["/account", "模拟账户"],
    ["/sim", "历史模拟"],
    ["/backtest", "策略回测"],
  ];
  check(`菜单项数 == 6`, MENU_NAV.length === 6, `实际=${MENU_NAV.length}`);
  for (const [href, label] of expectMenu) {
    const hit = MENU_NAV.find((i) => i.href === href);
    check(`菜单含「${label}」→ ${href}`, !!hit && hit.label === label, `实际=${JSON.stringify(hit)}`);
  }
  check(
    "菜单不含客场「模拟炒股」（它应常驻在顶栏，不在下拉里）",
    !MENU_NAV.some((i) => i.href === "/simtrade"),
    JSON.stringify(MENU_NAV.map((i) => i.label)),
  );
  check(
    "菜单顺序与需求原文一致",
    MENU_NAV.map((i) => i.label).join(",") === expectMenu.map(([, l]) => l).join(","),
    MENU_NAV.map((i) => i.label).join(","),
  );

  console.log("\n=== C. 底部 tab bar：恰好 5 项 ===");
  const expectTabs: Array<[string, string]> = [
    ["/", "首页"],
    ["/stocks", "行情"],
    ["/simtrade", "交易"],
    ["/backtest", "回测"],
    ["/account", "我的"],
  ];
  check("底栏项数 == 5", BOTTOM_TABS.length === 5, `实际=${BOTTOM_TABS.length}`);
  check(
    "底栏文案与顺序与需求一致",
    BOTTOM_TABS.map((i) => i.label).join(",") === expectTabs.map(([, l]) => l).join(","),
    BOTTOM_TABS.map((i) => i.label).join(","),
  );
  for (const [href] of expectTabs) {
    check(`底栏含 ${href}`, BOTTOM_TABS.some((i) => i.href === href));
  }
  check(
    "底栏含「交易」指向 /simtrade（产品主场）",
    BOTTOM_TABS.some((i) => i.href === "/simtrade" && i.label === "交易"),
  );

  console.log("\n=== D. 死链检查：所有 href 都指向真实页面 ===");
  const routes = realRoutes();
  console.log(`    app 下真实路由：${routes.join(" ")}`);
  const allHrefs = [PRIMARY_NAV.href, ...MENU_NAV.map((i) => i.href), ...BOTTOM_TABS.map((i) => i.href)];
  for (const href of Array.from(new Set(allHrefs))) {
    check(`${href} 存在对应页面`, routes.includes(href), `未找到 app${href}/page.tsx`);
  }

  console.log("\n=== E. 同一清单内无重复 href ===");
  const dupMenu = MENU_NAV.length !== new Set(MENU_NAV.map((i) => i.href)).size;
  const dupTabs = BOTTOM_TABS.length !== new Set(BOTTOM_TABS.map((i) => i.href)).size;
  check("二级菜单无重复路由", !dupMenu);
  check("底栏无重复路由", !dupTabs);

  console.log("\n=== F. 高亮规则 ===");
  check("`/` 精确匹配 `/`", isNavActive("/", "/") === true);
  check("`/stocks` 不把 `/` 判为当前页（否则会出现双高亮）", isNavActive("/stocks", "/") === false);
  check("`/simtrade` 不把 `/` 判为当前页", isNavActive("/simtrade", "/") === false);
  check("`/` 自身不被其他路由高亮", isNavActive("/", "/stocks") === false);
  check("`/stocks` 精确命中", isNavActive("/stocks", "/stocks") === true);
  check("`/stocks/000001` 继承 `/stocks` 高亮", isNavActive("/stocks/000001", "/stocks") === true);
  check("`/simtrade` 精确命中", isNavActive("/simtrade", "/simtrade") === true);
  check(
    "前缀相似但不同段不得误高亮（/stocks2 不应命中 /stocks）",
    isNavActive("/stocks2", "/stocks") === false,
    "这依赖实现里的 `href + '/'` 而不是裸 startsWith(href)",
  );
  check("`/backtest` 命中 /backtest", isNavActive("/backtest", "/backtest") === true);
  check("`/indices` 命中 /indices", isNavActive("/indices", "/indices") === true);
  check("`/sim` 不误命中 /simtrade", isNavActive("/simtrade", "/sim") === false, "/sim 与 /simtrade 前缀不同段");
  check("`/simtrade` 确实命中 /simtrade", isNavActive("/simtrade", "/simtrade") === true);

  console.log("\n=== G. 二级菜单面板的真实渲染（SSR）===");
  {
    /* 为什么能在这里断言：`NavMenuPanel` 把 pathname 作为 props 传入、
       不读 `usePathname()`，因此可脱离 Next 路由上下文确定性渲染。
       这一层验证的是「**渲染出来的 DOM**」——比只断言数据多挡一类问题：
       比如清单改了但 JSX 里漏映射某一项、或高亮标记没写进 DOM。 */
    const html = renderToStaticMarkup(
      React.createElement(NavMenuPanel, { pathname: "/indices" }),
    );

    check("面板含 role=menu", html.includes('role="menu"'), "");
    const itemCount = (html.match(/role="menuitem"/g) ?? []).length;
    check("渲染出恰好 6 个菜单项", itemCount === 6, `实际=${itemCount}`);

    for (const [href, label] of expectMenu) {
      check(`DOM 含「${label}」`, html.includes(label), "");
      check(`DOM 含链接 ${href}`, html.includes(`href="${href}"`), "");
    }
    check("DOM 不含「模拟炒股」（主场不重复进菜单）", !html.includes("模拟炒股"), "");

    // 高亮：/indices 命中时只有「指数」这一项带 aria-current，且显示「当前」
    const currentCount = (html.match(/aria-current="page"/g) ?? []).length;
    check("恰好 1 项被标记为当前页", currentCount === 1, `实际=${currentCount}`);
    check("当前项标记在「指数」上", /aria-current="page"[^>]*>[\s\S]*?指数/.test(html) || html.indexOf("指数") < html.indexOf("当前"), "");
    check("当前项显示「当前」角标", html.includes("当前"), "");

    // 换一个路由：高亮应随之移动（验证不是写死的）
    const html2 = renderToStaticMarkup(
      React.createElement(NavMenuPanel, { pathname: "/backtest" }),
    );
    check("路由变化后高亮项数仍为 1", (html2.match(/aria-current="page"/g) ?? []).length === 1, "");
    check("`/backtest` 时高亮移到「策略回测」", html2.indexOf("策略回测") < html2.indexOf("当前"), "");
  }

  console.log("\n" + "=".repeat(64));
  console.log(`通过 ${passed} / 失败 ${failed}`);
  if (failures.length > 0) {
    console.log("\n失败项：");
    for (const f of failures) console.log(`  ✗ ${f}`);
  }
  console.log("=".repeat(64));
}

main();
