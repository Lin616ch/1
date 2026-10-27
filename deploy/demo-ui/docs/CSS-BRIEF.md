# CSS 分工简报（components.css 拆块生产）

> 本文件是 4 个并行子任务的**共同说明**。每个子任务只负责产出**自己的那一个 CSS 文件**，
> 最后由主 Agent 按顺序拼装成 `css/components.css`。
> **不要**修改除自己文件以外的任何文件；**不要**直接创建 `css/components.css`。

---

## 1. 项目背景

「城市交通网络大数据平台」——基于 Three.js 自建 3D 城市的交通数据驾驶舱，**浅色政务风**：
白底面板 + 极轻边框 + 柔和阴影，靠层次、留白、字重取胜；专业、克制、可直接截图进政府汇报材料。

`index.html`、`css/theme.css`（设计令牌 + reset）、`css/layout.css`（外壳栅格）**已经写好且不可修改**。
`index.html` 已经 `<link rel="stylesheet" href="css/components.css">`，但该文件尚未生成 —— 你们四块拼起来就是它。

---

## 2. 每个子任务动手前必读（用 read 工具）

| 文件 | 为什么读 |
|---|---|
| `C:\Users\34119\Downloads\HomeWork\index.html` | **最重要**。为它里面**实际出现的 class** 写样式；静态占位就是 JS 运行时生成结构的样板 |
| `C:\Users\34119\Downloads\HomeWork\css\theme.css` | 设计令牌与 reset。**必须复用这些 `:root` 变量** |
| `C:\Users\34119\Downloads\HomeWork\css\layout.css` | 外壳栅格与尺寸假设。**不要重复写布局** |
| `C:\Users\34119\Downloads\HomeWork\docs\UI-CONTRACT.md` | 接口契约。重点 §2 令牌、§3.1 状态类、§4 组件清单 |

---

## 3. 共同硬性约束

- ❌ 不得修改 `index.html`、`css/theme.css`、`css/layout.css`、任何 `js/**`、任何 `docs/*.md`
- ❌ 不得创建 `css/components.css`（由主 Agent 拼装）
- ❌ 不得引用任何外部资源：无 CDN、无 `@import`、无外链字体/图片、无 icon font、无 CSS 框架
- ❌ **不要重新定义 `:root` 里的设计令牌**（`theme.css` 已有）。只允许定义**局部**自定义属性（如 `--_fill`）或带兜底的 `var(--x, 默认值)`
- ✅ 每个文件开头写一行注释标明归属，例如 `/* ==== components.css · Part 2/4 · 列表型组件 ==== */`
- ✅ 所有颜色走 `var(--令牌名)`；交通语义色作**文字**时用 `var(--road-free-text, #1f7a2e)` 这类带兜底的写法
- ✅ 数字统一 `font-variant-numeric: tabular-nums`
- ✅ 动效克制：160–260ms，`cubic-bezier(.4,0,.2,1)`（可用 `var(--dur-base)` / `var(--ease)`）
- ⚠️ **3D 舞台是浅色的**：不要把 `#stage` / `#canvas-host` 设成深色背景，不要依赖深色底才能看清的发光描边

### 3.1 必须覆盖的全局状态类（每个文件都要保证自己范围内的元素支持这些）
`.is-hidden`（`display:none !important`）、`.is-active`、`.is-playing`、`.is-done`、
`.is-loading`、`.is-disabled`、`.is-alert`、`.is-selected`、`.is-collapsed`
> `.is-hidden` 建议只在 Part 1 里定义一次（用 `!important`），其余文件不要重复定义。

---

## 4. 四块分工

| # | 产出文件 | 覆盖内容 |
|---|---|---|
| 1 | `_css/01-base.css` | `.is-hidden` 全局工具类、自定义滚动条、`#loading-screen` 加载页、顶栏（`.brand*` / `#kpi-ticker` / `.ticker-track` / `.ticker-item` / `.chip` / 顶栏图标按钮）、`.panel` 面板套件 |
| 2 | `_css/02-lists.css` | `.layer-item`+`.switch`、`.region-item`、`.view-btn`、`.rank-item`、`.tab`、`.mini-card`、`.legend-item`、`.badge`/`.tag` |
| 3 | `_css/03-data.css` | `.kpi-card` 套件、`.kpi-spark`、`#chart-trend`/`#chart-forecast`/`#bottom-chart`/`#signal-diagram` 容器、`.data-table`、`.flow-steps`、`#detail-drawer` 套件 |
| 4 | `_css/04-overlay.css` | `#timeline-row` 全组（`#btn-play` / `#speed-group` / `#timeline-slider` / `#timeline-track` / `.tl-cell`）、`#tooltip`、`.toast`、`#nav-compass`、`#view-hint` |

> 若发现自己需要的 class 不在自己范围内（例如 Part 2 想用 Part 3 的 `.kpi-card`），
> **不要**越界写，也不要复制粘贴 —— 那是另一块的责任。只写自己范围。
> 若发现 `index.html` 里某个 class 不在上面任何一块范围内，**请在自己文件里补上**并在最终回复中说明。

---

## 5. 交付前自检（每块都要做）

- [ ] 已按范围覆盖 `index.html` 中属于自己那块的全部 class（建议 grep 出 class 名逐一核对）
- [ ] 契约 §3.1 / §4 中属于自己那块的组件与状态均有默认态 / hover / active / disabled 样式
- [ ] 全文无 `http://` `https://` `@import`
- [ ] 未重新定义 `:root` 令牌块、未修改非授权文件、未创建 `css/components.css`
- [ ] 用 `pwsh` 检查语法：至少确认括号配对、无中文全角标点混入 CSS 语法位置（如 `，` `；` `：`）

## 6. 最终回复格式（200 字以内）
1. 你的文件名 + 行数
2. 你覆盖了哪些 class（列全）
3. 你在自己文件里补的"越界但缺失"的 class（如有）
4. 自检勾选结果
