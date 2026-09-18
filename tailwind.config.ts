import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      /* §5.1 内容宽度统一 1320px。
         原为 1400px：单行表格过长，视线横向跨度超出舒适区，
         且数字列与名称列间距被拉得过大。 */
      screens: { "2xl": "1320px" },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        /* 强调边框：输入框、可点击边界（§2.1） */
        "border-strong": "var(--border-strong)",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        /* L0 画布：页面底。与 background 同源，供语义化书写 */
        canvas: "var(--canvas)",
        foreground: "hsl(var(--foreground))",
        /* 文字三级：t1 主 / t2 次 / t3 辅助（§2.1） */
        t1: "var(--t1)",
        t2: "var(--t2)",
        t3: "var(--t3)",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        /* 表面层级（§6.1）：L2 分区面 / L3 下沉面 */
        surface: {
          subtle: "var(--surface-subtle)",
          sunken: "var(--surface-sunken)",
        },
        /* A股涨跌专用色：涨红跌绿（中国习惯，与欧美相反，禁止反转）
           —— 文本级用于文字/按钮，graphic 级用于 K线/图例（§2.2） */
        "stock-up": "hsl(var(--stock-up))",
        "stock-down": "hsl(var(--stock-down))",
        "stock-flat": "hsl(var(--stock-flat))",
        "up-graphic": "var(--up-graphic)",
        "dn-graphic": "var(--dn-graphic)",
        "up-bg": "var(--up-bg)",
        "dn-bg": "var(--dn-bg)",
      },
      /* §3.2 字号阶梯。采用"新增语义名"而非覆盖内置 text-sm/base，
         避免一次性改变全站既有排版造成回归；迁移按页推进。 */
      fontSize: {
        micro: ["11px", { lineHeight: "1.4" }], // 微标签 / 板块 tag
        label: ["12px", { lineHeight: "1.5" }], // 表头 / 单位 / 时间戳
        num: ["13px", { lineHeight: "1.5" }], // 卡片内次级数字
        body: ["13.5px", { lineHeight: "1.6" }], // 正文 / 表格
        h3: ["14.5px", { lineHeight: "1.4" }], // 卡片区块标题
        title: ["24px", { lineHeight: "1.3" }], // 页面标题（每页一处）
        stat: ["26px", { lineHeight: "1.1" }], // 概览卡主数值
        price: ["32px", { lineHeight: "1" }], // 个股详情大字价格
      },
      borderRadius: {
        lg: "var(--radius)", // 12px，与卡片尺度匹配
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      /* §6.2 投影：圆角提到 12px 后投影同步收敛 */
      boxShadow: {
        card: "var(--sh1)", // e1 卡片静置：几乎不可见，只做轻微脱离感
        raise: "var(--sh2)", // e2 悬停 / 浮起片
        overlay: "var(--sh3)", // e3 弹窗 / 下拉
      },
      /* §6.3 浮层层级：不用 9999 之类的默认值，避免提示被弹窗遮盖 */
      zIndex: {
        topbar: "50",
        dropdown: "60",
        dialog: "70",
        toast: "80",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
