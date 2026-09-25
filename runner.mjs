/**
 * runner.mjs —— 内联调用用的 TS 测试运行器
 *
 * 之所以做成「被 node -e 内联 require 的模块」而不是独立脚本：
 * 本机环境下 `node <脚本文件>` 会被静默拦截（exit 0、零输出、无副作用），
 * 而 `node -e "<内联代码>"` 完全正常。因此所有 TS 脚本统一走
 * node -e "require('./runner.mjs').run('scripts/xxx.ts')" 执行。
 *
 * 原理：esbuild 把目标 TS 打包成内存 ESM，写入临时文件后用动态 import 执行。
 *  - 支持 tsconfig `@/*` 别名
 *  - node_modules 外部化（packages: 'external'）
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

const ROOT = process.cwd();

/** 解析 `@/xxx` 别名到真实文件 */
function resolveAlias(spec) {
  if (!spec.startsWith("@/")) return null;
  const base = path.join(ROOT, spec.slice(2));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    `${base}.js`,
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* 继续尝试 */
    }
  }
  return base;
}

/** alias 解析插件 */
const aliasPlugin = {
  name: "tsconfig-paths",
  setup(b) {
    b.onResolve({ filter: /^@\// }, (args) => {
      return { path: resolveAlias(args.path) };
    });

    /**
     * Next 的子路径导入（next/link、next/navigation …）补 `.js` 扩展名。
     *
     * 为什么需要：`packages: "external"` 让这些 import 原样留给 Node 解析，
     * 而 Next 只在自己的 package.json `exports` 里声明了无扩展名映射 ——
     * 那是打包器（webpack/turbopack）的特性，Node 的 ESM 解析器不认，
     * 会报 ERR_MODULE_NOT_FOUND 并提示 "Did you mean next/link.js?"。
     * 组件里一旦 import 了 next/link，SSR 渲染测试就会撞上这个问题。
     */
    b.onResolve({ filter: /^next\// }, (args) => {
      if (/\.[cm]?js$/.test(args.path)) return null; // 已带扩展名，走默认解析
      return { path: `${args.path}.js`, external: true };
    });

    /**
     * 图表替身：把 `echarts-for-react` 换成一个无副作用占位组件。
     *
     * 两个原因，缺一不可：
     *  1. SSR 下 echarts 渲染不出任何实质内容（它需要 DOM/canvas），
     *     测试断言不了图表内部，渲染它只有成本没有收益；
     *  2. `echarts-for-react` 是 CJS 包，在 Node 的 ESM 加载下 default 导出
     *     可能变成 `{ __esModule, default }` 对象，被 React 当成非法元素类型
     *     并抛 "Element type is invalid ... but got: object"，让整个树渲染失败。
     *
     * 替身仍会渲染一个带标记的空 div，因此「图表容器确实被挂载」这一点
     * 依然可断言（见 scripts/testIndexUI.ts 的 data-testid 检查）。
     */
    b.onResolve({ filter: /^echarts-for-react$/ }, () => ({
      path: "echarts-for-react-stub",
      namespace: "test-stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "test-stub" }, () => ({
      contents:
        'export default function ChartStub() { return <div data-testid="kline-chart-stub" />; }',
      loader: "jsx",
      // 必须给 resolveDir，否则 esbuild 无法从虚拟模块里解析 react/jsx-runtime
      resolveDir: ROOT,
    }));
  },
};

/**
 * 执行一个 TS 脚本。
 * @param {string} target 相对项目根目录的 TS 文件路径
 * @param {string[]} args 透传给脚本的参数
 */
export async function run(target, args = []) {
  const esbuild = require("esbuild");
  const absTarget = path.resolve(ROOT, target);
  if (!fs.existsSync(absTarget)) {
    console.error(`[runner] 文件不存在: ${absTarget}`);
    process.exit(1);
  }

  const result = await esbuild.build({
    entryPoints: [absTarget],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm", // 输出 ESM，配合动态 import 执行
    // 与 Next.js 一致的自动 JSX runtime：组件文件按 Next 习惯**不 import React**，
    // 若用 esbuild 默认的经典转换会编译成 React.createElement 并报 "React is not defined"。
    jsx: "automatic",
    write: false,
    packages: "external",
    plugins: [aliasPlugin],
    logLevel: "warning",
    banner: {
      js: [
        'import { createRequire as __cr } from "node:module";',
        "const require = __cr(import.meta.url);",
      ].join("\n"),
    },
  });

  const code = result.outputFiles[0].text;
  const tmpDir = path.join(ROOT, ".tmp-run");
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(
    tmpDir,
    `${path.basename(absTarget, ".ts")}-${process.pid}-${Date.now()}.mjs`,
  );
  fs.writeFileSync(tmpFile, code, "utf8");

  const oldArgv = process.argv;
  process.argv = [process.argv[0], tmpFile, ...args];
  try {
    const mod = await import(pathToFileURL(tmpFile).href);
    void mod;
  } finally {
    process.argv = oldArgv;
  }
}

/** 清理历史临时产物 */
export function cleanup() {
  const tmpDir = path.join(ROOT, ".tmp-run");
  try {
    for (const f of fs.readdirSync(tmpDir)) {
      try {
        fs.unlinkSync(path.join(tmpDir, f));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

module.exports = { run, cleanup };
