# A股模拟交易 · UI 设计规范（DESIGN.md）

**产品**：A股模拟交易（`a-share-sim-trading`，Next.js **15.5.25** App Router + React **19.3.0** + Tailwind **3.4.19** + shadcn/ui（Radix 原语），线上 `http://111.229.225.7:8080`）
**读者**：接手前端优化/换肤的实现者与后续 Agent
**核心任务**：让数据密集型交易界面在"白底卡片"基础上建立可读的表面层级与品牌识别，同时保持 A 股行情语义（涨红跌绿）
**范围**：全站 7 个主页面 —— 行情中心、股票列表、个股详情、模拟账户、历史模拟、策略回测、模拟炒股（猜股票）
**现状证据**：线上产物 CSS 全文色值普查、7 页 HTML 结构、线上接口真实数据（2026-09-17 抓取）
**关键假设**（未验证，实现前需确认）：
- 深色模式当前未被产品实际使用（仅存在 `.dark` 令牌块，无切换入口），故本规范只覆盖浅色
- 图表以 `echarts-for-react@^3.0.6` 渲染（个股详情 K 线已确认），本规范给出的是颜色与尺寸约束，非 ECharts 配置迁移
- Tailwind 配置中 `borderColor`/`backgroundColor` 均绑定到 CSS 变量（由 DOM 类名 `border-stock-up/30`、`bg-stock-up/10` 存在推得，说明 `stock-up` 已在 Tailwind theme 中注册）

**已核实的环境事实**（本次实测，非推断）：
- 线上 `/home/ubuntu/app/` **只有** 构建产物（`.next/`）、`server.js`（Next 自动生成的 standalone 入口）、`prisma/schema.prisma` 与 `dev.db` —— **没有任何 `app/`、`components/`、`lib/`、`scripts/` 源码目录**
- 全站样式只有 **一份** 构建产物 CSS：`/home/ubuntu/app/.next/static/css/1f03992f2f77f6cc.css`（23,424 bytes）
- 源码唯一副本仍在用户家里机器（`%USERPROFILE%\WorkBuddy\a-share-sim-trading`），**服务器未 git 化**

---

## 1. 视觉主题（Visual Theme）

### 1.1 现状诊断：为什么"全是白的"

这是本次优化的起点，结论来自实测而非观感。

线上样式表（`/_next/static/css/*.css`，约 23KB）的 `:root` 令牌中，**表面（surface）角色全部塌陷到同一个纯白值**：

| 令牌 | 线上值 | HEX |
|---|---|---|
| `--background` | `0 0% 100%` | `#FFFFFF` |
| `--card` | `0 0% 100%` | `#FFFFFF` |
| `--popover` | `0 0% 100%` | `#FFFFFF` |

全表色值普查结果同样印证：整份 CSS 中出现的颜色仅有 `#fff`、`#e5e7eb`（边框）、`#9ca3af`（辅助文字）三类，**没有任何一处中间层级的灰或彩**。

后果是三层结构缺失：

1. **页面与内容无层级** —— 卡片 `bg-card` 与页面 `bg-background` 同色，卡片只靠 `border` + `shadow-sm` 与背景区分。在 5558 只股票的长列表里，滚动时没有"页面底 / 内容面"的参照，视觉上无限白。
2. **状态无色阶** —— 除了价格文字的涨跌色，没有任何"选中 / 悬停 / 分区 / 表头"的色阶表达。分段控件、表头、输入框底都退回灰白。
3. **品牌无痕迹** —— `--primary` 存在但只在少量按钮上出现；占屏面积最大的顶栏、表头、卡片全部无品牌色，产品缺少识别点。

### 1.2 目标视觉性格

**冷静的仪表盘（calm instrument panel）** —— 面向需要盯盘、比对、复盘的模拟交易者，一屏内信息密度高，因此视觉性格应当是**克制、精确、有层次**，而不是装饰性。

三条定性规则（由此推导出后续所有量化决策）：

| 规则 | 理由 |
|---|---|
| **层级靠"面"不靠"线"** | 数据密集页面若用大量边框分隔会形成网格噪点；用极浅的冷灰画布 + 纯白卡片建立前后关系，边界自然。 |
| **品牌色只做"注意力锚点"** | 主色出现位置限定为：主按钮、链接悬停、选中态、进度条、数据高亮。禁止大面积铺品牌色，否则与涨红跌绿争夺注意力。 |
| **语义色永不参与装饰** | 红/绿在本产品里是**强语义**（涨/跌），任何"好看"用途的红色装饰都会误导用户。 |

### 1.3 与现有资产的关系

- **保留**：shadcn 的令牌命名与 `hsl(var(--x))` 用法（零迁移成本，只改值）；A 股涨红跌绿的映射方向（现有实现已正确，**不做西式反转**）。
- **新增**：一层"画布色"（canvas）与一档"深浅面"（sunken），补上缺失的中间层级。
- **新增**：深色顶栏 chrome，作为产品识别与页面上沿的视觉闭合。

> **参考观察 vs 拟定规则**：以上 1.1 的色值为**观测事实**；1.2 的性格描述与 1.3 的取舍为本规范**拟定**，非现有产品文档中的既有约定。

---

## 2. 色彩系统（Color Palette）

### 2.1 语义角色表

对比度均为本次**实测计算**（WCAG 2.1 相对亮度公式），标注实测值而非估值。

| 角色 | CSS 变量 | HEX | HSL（shadcn） | 用途 | 实测对比度 |
|---|---|---|---|---|---|
| 画布 | `--canvas` / `--background` | `#F3F6FA` | `214 41% 97%` | 页面底色 | — |
| 内容面 | `--surface` / `--card` | `#FFFFFF` | `0 0% 100%` | 全部卡片 | — |
| 次级面 | `--surface-subtle` / `--muted` | `#F7F9FC` | `216 45% 98%` | 表头、分区底 | — |
| 下沉面 | `--surface-sunken` | `#EDF1F7` | `216 38% 95%` | 分段控件槽、估算框 | — |
| 定界边框 | `--border` | `#E3E8F0` | `217 30% 92%` | 1px 常规分隔（非文本） | 1.23 : 1 |
| 强调边框 | `--border-strong` / `--input` | `#D3DBE7` | `216 29% 87%` | 输入框、可点击边界 | 1.43 : 1 |
| 主文字 | `--foreground` / `--t1` | `#0F172A` | `222 47% 11%` | 标题、数值、正文 | **17.85 : 1** (AAA) |
| 次文字 | `--t2` | `#475569` | `215 19% 35%` | 次级说明、表体 | **7.58 : 1** (AAA) |
| 辅助文字 | `--muted-foreground` / `--t3` | `#64748B` | `215 16% 47%` | 表头、单位、时间戳 | **4.76 : 1** (AA) |
| 品牌主色 | `--primary` / `--b600` | `#2154E8` | `225 81% 52%` | 主按钮、链接、选中 | 6.00 : 1 (AA) |
| 品牌深 | `--b700` | `#1A44C4` | `225 77% 44%` | 主按钮 hover、浅底上的链接 | 8.0 : 1 |
| 品牌浅底 | `--b50` / `--accent` | `#EEF3FF` | `222 100% 97%` | 选中行、浅底区块 | — |
| 聚焦环 | `--ring` | `#3B6BF5` | `225 90% 60%` | 键盘焦点 | 3.4 : 1 (非文本 ≥3) |
| **涨 文本级** | `--stock-up` / `--up` | `#C91D1D` | `0 75% 45%` | 涨幅文字、买入按钮 | **5.71 : 1** (AA) |
| **涨 图形级** | `--up-graphic` | `#D93A3A` | `0 68% 54%` | K 线、图例 | 4.55 : 1 |
| 涨 浅底 | `--up-bg` | `#FDEDED` | `0 80% 96%` | 涨幅 chip 底 | 文字于其上 5.03 : 1 |
| **跌 文本级** | `--stock-down` / `--dn` | `#157F3C` | `142 72% 29%` | 跌幅文字、卖出按钮 | **5.08 : 1** (AA) |
| **跌 图形级** | `--dn-graphic` | `#18A05C` | `150 74% 36%` | K 线、图例 | 3.38 : 1 |
| 跌 浅底 | `--dn-bg` | `#EAF7F0` | `148 45% 94%` | 跌幅 chip 底 | 文字于其上 4.61 : 1 |
| 平盘 | `--stock-flat` | `#64748B` | `215 16% 47%` | 0.00% 状态 | 4.76 : 1 |
| 警示 | `--amber` | `#B45309` | `26 90% 37%` | 待处理、身份未知 | 4.67 : 1 (于 `#FEF6E7`) |
| 导航底 | `--navy` | `#0D1A2E` | `216 56% 12%` | 顶栏 chrome | 白字于其上 17.44 : 1 |

### 2.2 必须修正的一处硬伤：跌绿对比度不足

这是本次审计**唯一一处必须改色的可用性缺陷**，因为它出现在产品最高频的文本上（涨跌幅、价格）。

```
线上原值：--stock-down: 142 71% 40%   →  #1EAE53  on #FFFFFF = 2.96 : 1
```

2.96 : 1 **低于 AA 正文要求（4.5）**，甚至低于大字要求（3.0）。而在 A 股产品中，绿色恰恰大量用于 12–13.5px 的跌幅数字，属于小字号文本，必须达到 4.5。

修正方式：**把"文本色"和"图形色"拆成两个变量**。

- 文本/按钮用 `--stock-down: #157F3C` → 白底 5.08，跌浅底 4.61（双场景达标）
- K 线/图例等图形元素保留较亮的 `--dn-graphic: #18A05C` → 3.38（满足图形元素 ≥3:1）

红色侧同法处理：原 `--stock-up: #EB1414` 白底 4.52 属"擦线通过"，但置于涨浅底上仅 3.86 不达标；调整为文本级 `#C91D1D`（5.71 / 5.03），图形级保留 `#D93A3A`。

> **注意**：这是一次**纯可用性**修正，不改变红涨绿跌的语义方向。

### 2.3 可直接落地的 CSS

**方式 A — 若源码为 shadcn（推荐）**，替换 `app/globals.css` 的 `:root` 中以下行：

```css
:root {
  --background: 214 41% 97%;
  --foreground: 222 47% 11%;
  --card: 0 0% 100%;
  --card-foreground: 222 47% 11%;
  --popover: 0 0% 100%;
  --popover-foreground: 222 47% 11%;
  --primary: 225 81% 52%;
  --primary-foreground: 0 0% 100%;
  --secondary: 216 45% 98%;
  --secondary-foreground: 222 47% 11%;
  --muted: 216 45% 98%;
  --muted-foreground: 215 16% 47%;
  --accent: 222 100% 97%;
  --accent-foreground: 225 77% 44%;
  --border: 217 30% 92%;
  --input: 216 29% 87%;
  --ring: 225 90% 60%;

  /* 行情语义 —— 文本级（AA 达标） */
  --stock-up: 0 75% 45%;
  --stock-down: 142 72% 29%;
  --stock-flat: 215 16% 47%;

  /* 行情语义 —— 图形级（K线/图例） */
  --up-graphic: #D93A3A;
  --dn-graphic: #18A05C;

  /* 新增表面层级 */
  --canvas: #F3F6FA;
  --surface-subtle: #F7F9FC;
  --surface-sunken: #EDF1F7;
  --border-strong: #D3DBE7;

  --radius: 0.75rem;   /* 由 0.5rem 提到 12px，与卡片尺度匹配 */
}
```

**方式 B — 零构建覆盖（可回滚）**：新建 `app/theme-override.css`，在 `app/layout.tsx` 的 `globals.css` 之后引入；或先以 `<style>` 注入线上产物验证效果。方式 B 的完整内容见随附 `theme-patch.css`。

### 2.4 三种落地路径（按当前服务器实况排序）

由于服务器上**没有源码**（见文首"已核实的环境事实"），方式的可行性不同，这里按推荐度给出：

**方式 ① — 改源码后重新构建（推荐，但需先抢救源码）**
在源码 `app/globals.css` 的 `:root` 中替换 §2.3 方式 A 的值，再 `npm run build`。
- 前提：先完成"从家里机器拷源码 + git 化"（P0 遗留项）
- 优点：一次到位、可持续维护、可上 `git diff` 审阅
- 注意：源码不在服务器上，**在服务器上直接 build 不可行**

**方式 ② — 零构建补丁：追加到构建产物 CSS（可立即生效，推荐用于"先看效果"）**

服务器全站只有一份 CSS，追加补丁即可全站生效，且**文件名不变则 HTML 引用仍有效**：

```bash
# 1) 备份（可回滚的关键）
cp /home/ubuntu/app/.next/static/css/1f03992f2f77f6cc.css \
   /home/ubuntu/workbuddy-export/ui-design/css-backup-1f03992f2f77f6cc.css

# 2) 追加补丁（CSS 级联后写覆盖前写，:root 重定义生效）
cat /home/ubuntu/workbuddy-export/ui-design/theme-patch.css \
    >> /home/ubuntu/app/.next/static/css/1f03992f2f77f6cc.css

# 3) 验证：返回体应含补丁首行注释
curl -s http://127.0.0.1:8080/_next/static/css/1f03992f2f77f6cc.css | tail -3
```

- 回滚：`cp` 回备份文件，或 `git checkout`（源码 git 化之后）
- **已知副作用（必须知情）**：该 CSS 由 Next 以 `expireTime: 31536000`（1 年）下发，且文件名未变，**浏览器可能命中旧缓存而看不到新样式**。故这适合"打开新样式看效果 / 内部演示"，若要当作正式上线，需在文件名或查询串上做版本化
- 建议：先只追加 `theme-patch.css` 的**第 1 段（核心令牌）**，确认无副作用后再追加其余段

**方式 ③ — 改源码 + 正式发布（最终形态）**
同方式 ①，并配合版本化静态资源，避免缓存问题。

### 2.5 结论

对比度**已实测**，数值见 2.1 表；**未做的**是真实浏览器中的屏幕实测与色觉障碍模拟，属待办（见 §8.3）。

> 另需说明：方式 ②③ 都只在"浅色"下生效。线上 `.dark` 令牌块仍为 shadcn 默认值，若将来启用深色模式，§2.3 的令牌需补齐 `--canvas` / `--surface-sunken` 的深色对应值。

---

## 3. 字体系统（Typography）

### 3.1 字体栈

沿用系统栈，**不引入 Web 字体**（中文 Web 字体体积大、首屏代价高，而系统栈在 Win/macOS 均有高质量中文）：

```css
font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
             "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
             "Noto Sans CJK SC", sans-serif;
```

- **语言覆盖**：简体中文 + 拉丁 + 数字，无繁体/日文专门优化需求
- **字体资产依赖**：无。**无授权费用**。若未来需品牌字体，属新决策
- **等宽数字**：所有价格、涨跌幅、金额、统计数值容器必须加 `.num`

```css
.num { font-variant-numeric: tabular-nums; font-feature-settings: "tnum"; }
```

> 这不是可选项。默认比例数字在不同数值间字宽不一致，会让行情表格的数字列左右跳动，在 5558 行列表中尤其明显。

### 3.2 字号阶梯

| 角色 | 字号 | 字重 | 行高 | 字距 | 用途 |
|---|---|---|---|---|---|
| 页面标题 | 24px | 650 | 1.3 | 0 | `<h1>`，每页一处 |
| 统计数字 | 26px | 650 | 1.1 | 0 | 概览卡主数值 |
| 个股大字价格 | 32px | 650 | 1 | 0 | 个股详情头部 |
| 区块标题 | 14.5px | 600 | 1.4 | 0 | 卡片 `<h3>` |
| 正文 / 表格 | 13.5px | 400 | 1.6 | 0 | 表格体、说明 |
| 次级数字 | 13px | 500 | 1.5 | 0 | 卡片内小数值 |
| 辅助 / 表头 / 单位 | 12px | 500–600 | 1.5 | 0 | 表头、时间戳、单位 |
| 微标签 | 11px | 500 | 1.4 | 0 | 板块 tag |

**字距一律为 0**。不使用负字距（中文负字距会挤压笔画导致粘连），不使用 `text-transform`。

### 3.3 换行与截断

| 场景 | 规则 |
|---|---|
| 长股票名（如"XX 科技股份有限公司"） | 表格内 `white-space: nowrap`；容器溢出用省略号，`title` 属性补全 |
| 板块 / 状态 tag | `white-space: nowrap`，禁止折行撑高行 |
| 表格单元格 | 统一 `white-space: nowrap`；宽表横向滚动而非折行 |
| 账户名、策略名 | 单行省略：`overflow:hidden; text-overflow:ellipsis` |
| 数字 | **永不截断**。数值列给足宽度，宁可横向滚动 |
| 空值 | 显示 `—`（U+2014），不显示 `-` 或留白 |

---

## 4. 组件规范（Component Styles）

以下仅覆盖本任务涉及的组件。CSS 与线上预览 `ui-preview.html` 中的实现一致。

### 4.1 顶部导航（深色 chrome）

新增。深色底是产品识别点，同时给页面上沿一个视觉"闭合"，让下方画布的白有参照。

```css
.topbar{background:linear-gradient(180deg,#152945 0%,#0D1A2E 100%);
        border-bottom:1px solid rgba(255,255,255,.07);
        position:sticky;top:0;z-index:50}
.tb-in{max-width:1320px;margin:0 auto;height:56px;display:flex;align-items:center;gap:26px;padding:0 20px}
.nv{color:#A8B8D0;font-size:13.5px;padding:6px 12px;border-radius:8px;transition:.15s}
.nv:hover{color:#fff;background:rgba(255,255,255,.09)}
.nv.on{color:#fff;font-weight:600;background:rgba(78,123,255,.26);
       box-shadow:inset 0 0 0 1px rgba(130,170,255,.4)}
```

- 高度 56px 固定；导航项 6 个（与线上一致）
- 选中态用「半透明品牌底 + 内描边」而非纯色块，避免在深底上过重
- 深底上的文字对比度：浅字 `#A8B8D0` 于 `#0D1A2E` = 8.66 : 1（AAA）

### 4.2 卡片

```css
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;
      box-shadow:0 1px 2px rgba(16,24,40,.04),0 1px 3px rgba(16,24,40,.06);overflow:hidden}
.card-hd{padding:14px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px}
.card-hd h3{margin:0;font-size:14.5px;font-weight:600}
.card-bd{padding:16px}
```

- 卡片**不设 hover 位移**（列表中卡片过多，位移会造成抖动）。可点击卡片改为边框变色：`hover{border-color:#BFC9D9}`
- 卡片内表格去掉左右 padding（`padding:0`），由单元格自带 12px 横向留白，让表头底色贯通卡片边缘

### 4.3 统计卡

线上"模拟账户"页已有 4 张统计卡，"回测结果"页 6 张。

```css
.card.stat .lb{font-size:12px;color:var(--t3);font-weight:500}
.card.stat .vl{font-size:26px;font-weight:650;line-height:1.1;margin:6px 0 4px}
.card.stat .dl{font-size:12px;color:var(--t3)}
```

数值颜色规则：**收益类为涨跌着色，风险/中性类用主文字色**。最大回撤用跌绿（它是负面指标），夏普/波动率/胜率用 `--t1`（它们无方向）。避免"一片红绿"造成的语义稀释。

### 4.4 表格

```css
.tbl{width:100%;border-collapse:collapse;font-size:13.5px}
.tbl th{background:var(--surface-subtle);color:var(--t3);font-size:12px;font-weight:600;
        text-align:left;padding:9px 12px;border-bottom:1px solid var(--border);white-space:nowrap}
.tbl td{padding:10px 12px;border-bottom:1px solid #EEF2F8;white-space:nowrap}
.tbl tbody tr:hover{background:#F6F9FD}
.tbl tbody tr:last-child td{border-bottom:0}
.code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--t2)}
```

- **表头底 `--surface-subtle`** 是补层级的关键一笔（线上原为纯白，表头与表体无法区分）
- 数字列右对齐（`.r`），代码列左对齐，末列（日期）右对齐
- 行悬停底色 `#F6F9FD`，不用 `--b50`（过重，长列表滚动时闪）

### 4.5 涨跌 chip

```css
.chip{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;
      font-size:12px;font-weight:600;line-height:1.5}
.chip.up{color:var(--stock-up);background:var(--up-bg);border:1px solid #F3C9C9}
.chip.dn{color:var(--stock-down);background:var(--dn-bg);border:1px solid #C4E7D5}
.chip.flat{color:var(--t3);background:var(--surface-subtle);border:1px solid var(--border)}
```

**涨跌必须带符号**：`+20.01%` / `-3.59%`。仅靠颜色区分涨跌对有红绿色觉障碍的用户不可用，符号 + 颜色是冗余编码。

### 4.6 按钮

```css
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;
     padding:0 14px;border-radius:8px;font-size:13.5px;font-weight:600;cursor:pointer;
     border:1px solid transparent;transition:.15s}
.btn:active{transform:translateY(1px)}
.btn-p{background:var(--primary);color:#fff}
.btn-p:hover{background:var(--b700)}
.btn-o{background:#fff;border-color:var(--border-strong);color:var(--t1)}
.btn-o:hover{background:var(--surface-subtle);border-color:#BFC9D9}
.btn-buy{background:var(--up);color:#fff}
.btn-sell{background:var(--dn);color:#fff}
.btn-sm{height:29px;padding:0 11px;font-size:12.5px;border-radius:7px}
.btn-lg{height:40px;font-size:14px;border-radius:9px}
```

**买入必须用红色、卖出必须用绿色**（A 股语义），且**必须带文字标签**（"买入" / "卖出"），不得只用色块或图标。这是与欧美产品相反的方向，实现时不要"顺手修正"。

### 4.7 输入框 / 分段控件

```css
.inp{height:36px;border:1px solid var(--border-strong);background:#fff;border-radius:8px;
     padding:0 12px;font-size:13.5px;transition:.15s}
.inp:focus{outline:none;border-color:#3B6BF5;box-shadow:0 0 0 3px rgba(59,107,245,.18)}
.seg{display:inline-flex;background:var(--surface-sunken);border:1px solid var(--border);
     border-radius:9px;padding:3px;gap:2px}
.seg button{border:0;background:transparent;color:var(--t2);font:inherit;font-size:13px;
            padding:5px 12px;border-radius:7px;cursor:pointer;transition:.15s;white-space:nowrap}
.seg button.on{background:#fff;color:var(--t1);font-weight:600;
               box-shadow:0 1px 2px rgba(16,24,40,.1)}
```

分段控件槽用下沉面 `--surface-sunken`，选中项浮起为白 —— 这是"下沉槽 + 浮起片"的标准做法，比线上原本的灰白块能明确表达"这是一组互斥选项"。

---

## 5. 布局（Layout）

### 5.1 宽度与栅格

```css
.wrap{max-width:1320px;margin:0 auto;padding:0 20px}
.grid{display:grid;gap:16px}
.g2{grid-template-columns:repeat(2,minmax(0,1fr))}
.g3{grid-template-columns:repeat(3,minmax(0,1fr))}
.g4{grid-template-columns:repeat(4,minmax(0,1fr))}
.g6{grid-template-columns:repeat(6,minmax(0,1fr))}
.g-detail{grid-template-columns:minmax(0,1fr) 344px}   /* 个股详情：主区 + 侧栏下单 */
.g-bt{grid-template-columns:minmax(0,1.3fr) minmax(0,1fr)} /* 回测：资金曲线 + 回撤曲线 */
```

线上内容区为 `max-w-[1400px]`，本规范收到 **1320px**：1400px 下单行表格过长，视线横向跨度超出舒适区，且数字列与名称列间距被拉得过大。

**所有栅格必须用 `minmax(0,1fr)`**，不能用 `1fr`。默认 `1fr` 的 `min-width:auto` 会被长股票名/大数字撑破，导致栅格溢出。

### 5.2 间距尺度

基础单位 **4px**，实际使用阶梯：`4 / 6 / 8 / 10 / 12 / 16 / 20 / 24`。

| 位置 | 值 |
|---|---|
| 卡片内边距 | 16px |
| 卡片间距 | 16px |
| 区块间距 | 16px |
| 页头上下 | 22px / 18px |
| 表格单元格 | 10px 12px |
| 表头单元格 | 9px 12px |

### 5.3 阅读顺序（全站主线）

```
顶部导航（全局定位）
  ↓
页面标题 + 页头元信息（"我在哪 / 数据多新"）
  ↓
概览统计（4–6 张卡，一眼看全局）
  ↓
[主操作区]  ← 不同页面不同：行情=榜单；详情=K线+下单；账户=持仓+委托
  ↓
[明细区]    ← 表格 / 时间线 / 交易记录
```

关键约束：**概览统计必须在主操作区之前**。用户打开页面第一诉求是"现在什么情况"，第二诉求才是"我要做什么"。

### 5.4 长内容 / 空 / 密集数据

| 情形 | 处理 |
|---|---|
| 5558 行长列表 | 必须分页或虚拟滚动（线上已有分页，保持）；表头 `position:sticky` |
| 表格横向溢出 | 外层 `overflow-x:auto`，**不折行**、不缩小字号 |
| 图表容器 | 给定固定高度（K线 400px / 曲线 250px），`preserveAspectRatio="none"` 撑满宽度，避免布局随数据抖动 |
| 空态 | 虚线框 + 图标 + 一句说明 + 一个主操作（见 5.5），**不显示空白卡片** |
| 数据不足（如账户仅 1 个交易日） | 明确标注"数据不足，暂不计算 XX"，不显示 0 或 `NaN` |

### 5.5 空态

```css
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;
       padding:34px 20px;border:1px dashed var(--border-strong);border-radius:12px;
       background:linear-gradient(180deg,#FBFDFF,#F4F8FD);color:var(--t2);font-size:13.5px}
```

三个要素缺一不可：**图标 + 说明文字 + 主操作按钮**。只写"暂无数据"而不告诉用户如何产生数据，是空态最常见的失败。

---

## 6. 层次与投影（Depth And Elevation）

### 6.1 表面分层

| 层 | 值 | 用途 |
|---|---|---|
| L0 画布 | `#F3F6FA` | 页面底 |
| L1 内容面 | `#FFFFFF` | 卡片、表格容器 |
| L2 分区面 | `#F7F9FC` | 表头、卡片内分区 |
| L3 下沉面 | `#EDF1F7` | 分段控件槽、估算框 |
| L4 浮层 | `#FFFFFF` + `--sh3` | 下拉、弹窗、Popover |

**层级首先由表面色差表达，投影只是辅助。** 这是本规范与线上现状最大的差别：线上 L0 = L1 = L2 = `#FFFFFF`，等于只有一层，投影再细腻也建立不出深度。

### 6.2 投影

`--radius` 已提到 12px，投影相应收敛（大圆角 + 重投影 = 廉价感的常见来源）。

```css
--sh1: 0 1px 2px rgba(16,24,40,.04), 0 1px 3px rgba(16,24,40,.06);  /* e1 卡片，静置 */
--sh2: 0 6px 18px rgba(16,24,40,.09);                                /* e2 悬停 / 浮起片 */
--sh3: 0 16px 40px rgba(16,24,40,.16);                               /* e3 弹窗 / 下拉 */
```

| 层 | 投影 | 说明 |
|---|---|---|
| 卡片（静置） | `--sh1` | 几乎不可见，只做边缘的轻微脱离感 |
| 可点击卡片悬停 | `--sh2` | 同时可配合边框变深；**不做 translateY 位移** |
| 分段控件选中片 | 内联 `0 1px 2px rgba(16,24,40,.1)` | 比 `--sh1` 更轻，因为它在小尺寸容器内 |
| 浮层（Dropdown / Dialog） | `--sh3` | 必须有明显投影，与内容面区分 |

### 6.3 遮罩与浮层层级

| 层 | z-index |
|---|---|
| 深色顶栏（sticky） | 50 |
| 下拉 / Popover | 60 |
| 弹窗 Dialog | 70 |
| 全局提示 Toast | 80 |

线上顶栏为 `z-index:50`，保持。**不要用 `z-index:9999` 之类的默认值**，会出现提示被弹窗盖住的偶发问题。

---

## 7. 注意事项与风险（Cautions）

### 7.1 已知缺陷：回测「最大回撤起始日」字段错误（必须修）

**这是一个真实的数据正确性 Bug，已用线上数据完整复现并定位。**

同一次回测（`id=cmu5jzime002owkke2e638qan`，平安银行 000001，MA5/MA20，2026-03-02 ~ 2026-09-17）的接口返回：

```
maxDrawdown: -6.92
maxDrawdownStart: "2026-07-31"      ← 错
maxDrawdownEnd:   "2026-06-25"      ← 对
```

**起始日晚于结束日**，字段自相矛盾。逐日核对 `drawdownCurve` 后的真实口径：

| 项 | 日期 | 权益 |
|---|---|---|
| 真实峰值（回撤起点） | **2026-06-12** | ¥103,094.22 |
| 真实谷底（回撤终点） | **2026-06-25** | ¥95,962.41 |
| 回撤幅度 | | **-6.92%** ✓ |

而 `2026-07-31` 是**全区间权益最高点**，权益 ¥105,942.70 —— **它出现在谷底之后**。也就是说：错误值取的是"全区间最大权益的日期"，而不是"最大回撤区间起点的日期"。

**根因推断**：计算循环里用同一个 `peak` 变量同时承担两件事——一是随权益创新高的运行最大值（用于算 `drawdown = asset/peak - 1`），二是记录回撤起点日期。循环结束后写 `maxDrawdownStart` 时，取到的是**循环结束时** `peak` 对应的日期（即全区间最高点），而不是**谷底时刻**的回溯峰值日期。

**修复方向**：在遍历中当 `drawdownPercent` 刷新最小值时，同步快照**当时的** `peakDate`：

```ts
let peakAsset = equity[0].totalAsset, peakDate = equity[0].date;
let maxDD = 0, ddStart = equity[0].date, ddEnd = equity[0].date;

for (const p of equity) {
  if (p.totalAsset > peakAsset) { peakAsset = p.totalAsset; peakDate = p.date; } // 运行峰值
  const dd = peakAsset > 0 ? (p.totalAsset / peakAsset - 1) * 100 : 0;
  if (dd < maxDD) {                     // ← 只在刷新最深回撤时才快照
    maxDD = dd;
    ddStart = peakDate;                 // ← 关键：取"此刻"的峰值日，不是循环结束后的
    ddEnd = p.date;
  }
}
```

**验收标准**（可直接断言）：`maxDrawdownStart <= maxDrawdownEnd`；对该回测，二者应为 `2026-06-12` 与 `2026-06-25`。

> 本预览页（`ui-preview.html` 第 ④ 屏）按**修正后**口径展示，并在页内标注了线上现状，便于对比。

### 7.2 其他数据口径风险

- **回测"盈亏比"与"平均持有"**：预览模板初稿中的 `4.41` / `15.5 天` 经真实 `roundTrips` 复核后，盈亏比 4.41 正确，但**平均持有实为 23.2 天**（`15.5` 错误）。累计费用实为 **¥632.82（0.63%）**，而非 `664.38（0.66%）`。凡展示派生指标，应一律从 `roundTrips` 现算，**不要在前后端任何一处硬编码**。
- **账户收益页数据不足**：线上账户绩效接口当前只返回 1 个交易日的曲线，`maxDrawdownStart/End` 为 `null`。UI 必须处理 `null`（显示"—"并提示"数据不足"），否则会渲染出 `Invalid Date`。

### 7.3 禁止模式

| 禁止 | 原因 / 可观测的检查方式 |
|---|---|
| 大面积铺品牌蓝 | 与涨红跌绿争夺注意力；检查：非交互元素上不应出现 `--primary` 大面积填充 |
| 反转红绿方向 | A 股语义为涨红跌绿；检查：`+` 号数值必须是红色 |
| 仅用颜色表达涨跌 | 色觉障碍不可用；检查：涨跌数值是否都带 `+` / `-` 符号 |
| 负字距 / 缩小字号以塞下内容 | 中文会粘连；检查：全站 `letter-spacing` 出现次数应为 0 |
| 用 `1fr` 而非 `minmax(0,1fr)` | 长股票名会撑破栅格；检查：搜索 `grid-template-columns` 中裸 `1fr` |
| 卡片 hover 位移 | 长列表滚动时抖动；检查：`.card:hover` 不应有 `transform` |
| `--stock-down` 用浅绿做正文 | 对比度不足（原 `#1EAE53` = 2.96 : 1）；检查：文本场景必须用 `#157F3C` |
| 图表用 ECharts 默认色板 | 默认色板含欧美语义色，且与品牌无关；检查：图表色应引用令牌 |

### 7.4 待决事项

1. 深色模式是否纳入范围？（当前 `.dark` 令牌块存在但无入口，若要做需补齐 canvas/sunken 的深色对应值）
2. 深色顶栏是本规范的**提议**，产品若已定品牌视觉，需先对齐
3. **源码现状是本次最大的流程风险**：服务器上没有任何 `app/`/`components/`/`lib/` 源码，`server.js` 是 Next 自动生成的 standalone 入口（非可编辑的自定义服务器），全站只有一份构建产物 CSS。这意味着**任何组件级改动（如深色顶栏）在没有源码时都无法落地**，只能靠 CSS 覆盖（见 §2.4 方式 ②）。建议把"从家里机器抢救源码 + git 化"提到最高优先级，否则本规范只能部分实现。

---

## 8. 响应式与状态（Responsive Behavior）

### 8.1 断点

| 断点 | 栅格变化 |
|---|---|
| `≥1280px` | 全量：`g6` 统计卡 / `g-detail` 主区+344px 侧栏 |
| `1024–1279px` | `g6` → 3 列；`g-detail` → 主区 + 300px 侧栏 |
| `768–1023px` | `g6` → 2 列；`g-detail` → 单列（下单面板移至 K 线下方）；`g-bt` → 单列 |
| `<768px` | 全单列；顶栏导航收为横向可滚动；表格外层横向滚动，不折行 |

**表格在任何断点都不改为卡片堆叠**。行情数据的可比性依赖列对齐，堆叠会破坏"同一字段纵向对比"这一核心用法。

### 8.2 触控与键盘

- 触控目标最小 **44×44px**（移动端按钮 `btn-lg` 实际为 40px 高 + 间距，需在移动端加到 44px）
- 全部可交互元素可 Tab 到达，`:focus-visible` 显示 `--ring` 3px 光环
- **不使用 hover 独有的信息**：悬停显示的价格明细等，移动端需有点按等价路径

### 8.3 动效

```css
@media (prefers-reduced-motion: reduce) {
  * { transition-duration: .01ms !important; animation-duration: .01ms !important; }
}
```

全站动效仅做 150ms 的颜色/背景过渡。**不做**入场动画、数字滚动、图表逐点生长 —— 盯盘场景下这类动效是干扰。

### 8.4 加载 / 错误 / 恢复状态

| 状态 | 表现 |
|---|---|
| 加载 | 骨架屏（保持与最终内容同尺寸），**不使用 spinner 居中**（会造成布局跳动） |
| 空 | 见 §5.5 |
| 错误 | 卡片内错误态 + "重试"按钮，保留页面其余部分可用；不做全屏错误页 |
| 部分失败 | 例如 K 线失败但基本信息成功：仅图表区显示错误，不整页失败 |

### 8.5 验收检查项

**已执行**：
- ☑ 对比度按 WCAG 2.1 公式计算（数值见 §2.1）
- ☑ 线上原令牌色值普查确认"全白"根因
- ☑ 线上真实数据核对回测派生指标与回撤区间

**待执行**（需在真实浏览器/真机中完成）：
- ☐ 各断点实机截图核对
- ☐ 色觉障碍（红绿）模拟下的涨跌可辨识性
- ☐ 键盘全流程可用性走查
- ☐ 5558 行长列表在目标浏览器中的滚动性能

---

## 9. 实现提示（Agent Prompt Guide）

以下提示可直接交给实现 Agent。

---

**任务**：为「A股模拟交易」（Next.js 14 App Router + shadcn/ui）按 `DESIGN.md` 落地 UI 优化。

**背景与现状**：线上样式表 `:root` 中 `--background`、`--card`、`--popover` 三者同为 `0 0% 100%`，导致页面与卡片无层级、整体一片白。需在不改变信息架构与 A 股涨红跌绿语义的前提下，补上表面层级与品牌识别。

**工作流**（按序执行）：
1. 定位样式来源：**服务器上没有源码**，全站样式只有 `/home/ubuntu/app/.next/static/css/1f03992f2f77f6cc.css` 一份。若要改源码，先执行"从家里机器抢救源码 + git 化"。
2. 按 §2.3 方式 A 替换源码 `app/globals.css` 的 `:root` 令牌值；若暂无法改源码，走 §2.4 方式 ②（备份后追加补丁到构建产物 CSS）。
3. 按 §4 落地组件：深色顶栏、卡片、表头底、chip、按钮、输入框、分段控件。
4. 按 §5 调整栅格：内容区 `max-w` 收到 1320px；所有 `1fr` 改为 `minmax(0,1fr)`；表头 `sticky`。
5. 修复 §7.1 的最大回撤起始日 Bug，按下述验收断言验证。
6. 用 §8.1 断点调整响应式。

**必须遵守的令牌**（不得新造色值）：
`--canvas:#F3F6FA`、`--card:#FFFFFF`、`--surface-subtle:#F7F9FC`、`--surface-sunken:#EDF1F7`、`--border:#E3E8F0`、`--border-strong:#D3DBE7`、`--primary:#2154E8`、`--stock-up:#C91D1D`、`--stock-down:#157F3C`、`--up-graphic:#D93A3A`、`--dn-graphic:#18A05C`、`--t1:#0F172A`、`--t2:#475569`、`--t3:#64748B`。

**组件硬约束**：
- 红涨绿跌，**不得反转**；涨跌数值必须带 `+` / `-` 符号
- 买入按钮红色、卖出按钮绿色，且必须带文字标签
- 所有数值容器加 `tabular-nums`
- 字距一律 0；卡片无 hover 位移；表格不折行、移动端不堆叠
- 浅绿不得用于正文（对比度不足）

**期望产物**：
1. 修改后的样式文件（令牌 + 组件类）
2. 回测最大回撤计算的修复 diff
3. 至少 4 张截图：行情中心、个股详情、模拟账户、回测结果（含 1280px 与 768px 两档）

**验收标准**：
- `maxDrawdownStart <= maxDrawdownEnd` 在所有回测中成立；对 `id=cmu5jzime002owkke2e638qan`，二者为 `2026-06-12` 与 `2026-06-25`
- 回测页派生指标（平均持有 23.2 天、累计费用 ¥632.82、盈亏比 4.41）与 `roundTrips` 现算结果一致
- 页面底色与卡片底色在截图中可肉眼区分
- 涨跌文字在 100% 缩放下无发虚，跌绿不再偏浅

**验证状态说明**：`DESIGN.md` 中标注为"已执行"的检查（对比度计算、线上色值普查、真实数据核对）确已完成；截图为待办，**不得在交付说明中声称已通过浏览器验证**。

---

**附**：设计预览见 `ui-preview.html`（含 5 屏：行情中心 / 个股详情 / 猜股票对局 / 回测结果 / 设计令牌），可直接零构建覆盖用的补丁见 `theme-patch.css`。
