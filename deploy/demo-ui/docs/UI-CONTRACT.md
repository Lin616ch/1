# UI 契约 v1 —— 城市交通网络大数据平台

> 本文件是 **UI 设计（Opus）** 与 **3D/逻辑实现（主 Agent）** 之间的强制接口。
> UI 侧只负责 `index.html` + `css/*.css`；JS 侧只负责 `js/*.js` 并严格按本契约绑定 DOM。
> **任何一方不得单方面修改本契约中的 id / class / data-* 名称。**

---

## 1. 交付物与硬性约束

### 1.1 UI 侧必须产出的文件
| 文件 | 职责 |
|---|---|
| `index.html` | 完整静态骨架，含全部挂载点与占位文案。**不得包含任何 JS 逻辑**，只允许在末尾按顺序引用脚本（见 §5） |
| `css/theme.css` | 设计令牌（`:root` CSS 变量）、reset、排版、字体栈 |
| `css/layout.css` | 应用外壳栅格布局、响应式断点 |
| `css/components.css` | 面板/卡片/按钮/标签页/时间轴/抽屉/图例/提示/加载页 等组件样式 |
| `docs/design-notes.md` | 设计说明：配色理由、栅格尺寸、组件状态清单、动效时长表 |

### 1.2 绝对禁止
- ❌ **禁止任何外部网络资源**：不得出现 Google Fonts、CDN、`@import url(http...)`、外链图片。
  本工程必须能在**完全离线 + 双击 `file://` 打开**的条件下正常显示。
- ❌ 不得使用 ES Module（`type="module"`）——`file://` 下会被 CORS 拦截。只用经典 `<script src>`。
- ❌ 不得在 HTML 里写业务 JS（`onclick` 内联事件一律禁止）。交互全部由 JS 侧用 `addEventListener` 绑定。
- ❌ 不得自行增删或改名契约中的 id。
- ❌ 图标一律用**内联 SVG** 或 CSS 绘制，不得用 icon font、不得引用图片文件。
- ❌ 不得引入任何 CSS 框架（Bootstrap/Tailwind 等）。

### 1.3 视觉方向
**浅色政务风**：专业、克制、可截图进汇报材料。
- 底色浅灰白，面板纯白 + 极轻边框 + 柔和阴影（不要浓重投影）
- 主色为政务蓝；语义色（畅通/缓行/拥堵/严重拥堵）必须区分度高且色盲友好
- 3D 舞台区域是**浅色**的（浅灰蓝天空 → 白地面），因此面板不能靠深色发光取胜，要靠**层次、留白、字重**取胜
- 数字使用 `font-variant-numeric: tabular-nums`，KPI 数值要突出
- 动效克制：过渡 160–260ms，缓动 `cubic-bezier(.4,0,.2,1)`；不使用花哨旋转/闪烁（数据刷新指示除外）

### 1.4 设计分辨率与断点
- 基准设计尺寸 **1920 × 1080**，必须在此尺寸下满屏无滚动条、无裁切
- 栅格：左栏 `320px`、右栏 `360px`、顶栏 `64px`、底栏 `≈210px`（含时间轴行）
- 断点：`≥1600px` 完整三栏；`1280–1599px` 左右栏收窄；`<1280px` 左右栏可折叠为图标条（用 `.is-collapsed` 类）
- 页面整体 `overflow: hidden`，只有面板内部允许滚动（滚动条需自定义美化）

---

## 2. 设计令牌（`:root` CSS 变量）—— **名称强制固定**

JS 侧会用 `getComputedStyle(document.documentElement).getPropertyValue('--xxx')` 读取这些变量来给
Three.js 场景、ECharts 图表上色。**少一个都会导致渲染出错。**

### 2.1 基础色
```
--c-bg               页面底色
--c-bg-sub           次级底（表头/斑马纹）
--c-panel            面板底色
--c-panel-head       面板标题栏底色
--c-border           常规描边
--c-border-strong    强调描边
--c-text             主文字
--c-text-sub         次要文字
--c-text-dim         弱化文字 / 单位 / 轴标签
--c-primary          主色（政务蓝）
--c-primary-weak     主色浅底（选中态背景）
--c-primary-deep     主色深（hover / 强调）
--c-accent           辅助强调色（青）
--c-success --c-warn --c-danger --c-info   语义色
--c-shadow           阴影颜色（含透明度）
```

### 2.2 交通语义色（**必须严格按语义**）
```
--road-free      畅通（建议绿）
--road-slow      缓行（建议黄）
--road-jam       拥堵（建议橙）
--road-block     严重拥堵（建议红）
--road-nodata    无数据（灰）
```

### 2.3 3D 舞台专用色（JS 直接用于 Three.js 材质）
```
--stage-sky-top      舞台天空渐变上端
--stage-sky-bottom   舞台天空渐变下端（接近地面）
--stage-fog          雾色（需与天空下端接近，用于地平线消隐）
--stage-ground       地面底板色
--stage-grid         地面网格线色
--stage-grid-major   地面网格主线色（每 5 格）
--bld-top            建筑顶面
--bld-side           建筑侧面（受光面）
--bld-side-dark      建筑侧面（背光面）
--bld-hi             重要建筑/地标高亮色
--road-casing        道路描边色（比路面深，用于勾边）
--transit-metro      地铁线默认色（各线路另有 --metro-1..--metro-5）
--transit-bus        公交线默认色
--od-flow            OD 飞线默认色
--heat-low --heat-mid --heat-high   热力图色阶（低→高）
```

### 2.4 图表色板（ECharts 按序取用）
```
--chart-1  --chart-2  --chart-3  --chart-4
--chart-5  --chart-6  --chart-7  --chart-8
--metro-1  --metro-2  --metro-3  --metro-4  --metro-5
```

### 2.5 尺度与动效
```
--radius-sm(4px) --radius-md(8px) --radius-lg(12px)
--space-1(4px) --space-2(8px) --space-3(12px) --space-4(16px) --space-5(24px)
--dur-fast(160ms) --dur-base(220ms) --dur-slow(360ms)
--ease(cubic-bezier(.4,0,.2,1))
--z-canvas(0) --z-overlay(10) --z-panel(20) --z-drawer(60) --z-toast(80) --z-loading(100)
--font-ui     中文字体栈（离线可用：系统字体）
--font-num    数字字体栈（用于 KPI，允许用 monospace 兜底）
```

---

## 3. DOM 结构契约

层级与 id 必须完全一致。`.panel` 内部结构统一为
`<section class="panel"><header class="panel-head"><h3 class="panel-title">…</h3><div class="panel-tools">…</div></header><div class="panel-body">…</div></section>`。

```
#app

├─ header#topbar
│   ├─ .brand
│   │   ├─ .brand-mark            （内联 SVG 徽标）
│   │   └─ .brand-text > h1.brand-title + p.brand-sub
│   ├─ #kpi-ticker                 （横向滚动 KPI 条，JS 填充：.ticker-item > .ticker-label + .ticker-value）
│   └─ .topbar-right
│       ├─ #weather-chip           （.chip：内联 SVG + 文案）
│       ├─ #sys-clock              （大号时间 HH:MM:SS）
│       ├─ #sys-date               （日期 + 星期）
│       ├─ button#btn-theme        （主题切换，可只做视觉占位）
│       └─ button#btn-fullscreen   （全屏）
│
├─ aside#sidebar-left.rail
│   ├─ section.panel[data-panel="layers"]
│   │   └─ .panel-body#layer-list          （JS 填充图层开关项）
│   ├─ section.panel[data-panel="region"]
│   │   └─ .panel-body#region-list         （JS 填充行政区筛选）
│   └─ section.panel[data-panel="view"]
│       └─ .panel-body#view-modes          （JS 填充视角模式按钮）
│
├─ main#stage
│   ├─ #canvas-host                （Three.js renderer 挂载点；UI 侧只需给尺寸，不要设 background）
│   ├─ #map-overlay
│   │   ├─ #map-legend             （图例，JS 填充）
│   │   ├─ #nav-compass            （指北针；JS 会设置其子元素 #compass-needle 的 transform 与 #compass-pitch 文本）
│   │   └─ #view-hint              （视角操作提示：左键旋转/滚轮缩放/右键平移）
│   └─ #tooltip                    （.is-hidden 默认隐藏；含 #tooltip-title / #tooltip-body）
│
├─ aside#sidebar-right.rail
│   ├─ section.panel[data-panel="kpi"]      > .panel-body#kpi-cards
│   ├─ section.panel[data-panel="trend"]    > .panel-body#chart-trend
│   ├─ section.panel[data-panel="forecast"] > .panel-body#chart-forecast
│   └─ section.panel[data-panel="rank"]     > .panel-body#corridor-rank
│
├─ footer#bottombar
│   ├─ nav#module-tabs             （JS 填充 tab 按钮，class .tab，选中态 .is-active）
│   ├─ #module-body
│   │   ├─ #module-metrics         （该模块的关键指标小卡，JS 填充）
│   │   ├─ #bottom-chart           （ECharts 挂载点；承载切换模块的图表）
│   │   └─ #signal-diagram         （信号配时绿波带示意图容器，默认加 .is-hidden；JS 会往里插 SVG）
│   └─ #timeline-row
│       ├─ button#btn-play         （播放/暂停；JS 会切换 .is-playing 类并替换内部 SVG）
│       ├─ #speed-group            （速度档，button[data-speed="1|2|4|8"]，选中 .is-active）
│       ├─ #timeline-label         （当前时刻文本 HH:MM）
│       ├─ input#timeline-slider   （type=range min=0 max=1439 step=1）
│       └─ #timeline-track         （24h 路况热力条容器，JS 插 canvas 或 div 条）
│
├─ aside#detail-drawer
│   ├─ header.drawer-head > #drawer-title + button#drawer-close
│   └─ .drawer-body#drawer-body     （JS 填充路段/站点详情）
│
├─ #toast-host                      （JS 插 .toast）
└─ #loading-screen                  （加载页；JS 完成后加 .is-done 淡出并设 pointer-events:none）
```

### 3.1 状态类名规范（JS 会直接增删，UI 必须为它们写好样式）
| 类名 | 作用对象 | 含义 |
|---|---|---|
| `.is-hidden` | 任意 | `display:none`（工具类，需 `!important` 优先级足够） |
| `.is-active` | `.tab` / `button` / 图层项 | 选中态 |
| `.is-collapsed` | `#sidebar-left` / `#sidebar-right` | 折叠为窄条 |
| `.is-playing` | `#btn-play` | 播放中 |
| `.is-done` | `#loading-screen` | 加载完成，淡出 |
| `.is-loading` | 任意面板 | 数据加载中（骨架/呼吸态） |
| `.is-disabled` | 任意 | 不可用 |
| `.is-alert` | 指标卡 / 列表项 | 告警态强调（红色左边框或角标） |
| `.is-selected` | 列表项 | 详情抽屉对应的高亮项 |

---

## 4. 组件清单（UI 必须为以下每一个写出完整样式）

1. **顶栏** `.brand` / `#kpi-ticker`（自动横向滚动，`@keyframes` marquee，鼠标 hover 暂停）/ 时钟双行 / `.chip` / 图标按钮
2. **面板** `.panel` + `.panel-head` + `.panel-title`（左侧竖色条）+ `.panel-tools` + `.panel-body`（内部滚动）
3. **图层开关项** —— JS 生成的结构固定为：
   ```html
   <label class="layer-item is-active" data-layer="traffic">
     <span class="layer-icon"><svg …/></span>
     <span class="layer-name">实时路况</span>
     <span class="layer-count">1,284</span>
     <span class="switch"><i></i></span>
   </label>
   ```
   需要为 `.layer-item` / `.layer-icon` / `.layer-name` / `.layer-count` / `.switch`（含 `.is-active` 时滑块右移+变色）写样式。
4. **行政区筛选** `.region-item`（同 `.layer-item` 简化版：名称 + 数值 + 选中态）：
   ```html
   <button class="region-item is-active" data-region="all"><span class="region-name">全市</span><span class="region-value">4,286 km</span></button>
   ```
5. **视角模式按钮**（JS 生成，含快捷键角标）：
   ```html
   <button class="view-btn is-active" data-view="orbit">
     <span class="view-icon"><svg …/></span>
     <span class="view-text"><b>自由环绕</b><em>拖拽旋转观察</em></span>
     <kbd class="view-key">1</kbd>
   </button>
   ```
   需要 `.view-btn` / `.view-icon` / `.view-text`(b/em) / `.view-key` 样式。
6. **KPI 卡**（JS 生成）：
   ```html
   <article class="kpi-card">
     <div class="kpi-head"><span class="kpi-label">路网平均速度</span><span class="kpi-trend is-up">+2.4%</span></div>
     <div class="kpi-value"><b>28.6</b><i>km/h</i></div>
     <div class="kpi-spark" data-spark="speed"></div>
     <div class="kpi-foot">较昨日同期</div>
   </article>
   ```
   需要 `.kpi-card` / `.kpi-head` / `.kpi-label` / `.kpi-trend`(`.is-up` 绿 `.is-down` 红) / `.kpi-value`(b 大号数字 + i 小号单位) / `.kpi-spark`(固定高度 34px 的迷你图容器) / `.kpi-foot`。
7. **图表容器** `#chart-trend` / `#chart-forecast` / `#bottom-chart` 需有确定高度（面板内 `flex:1` + `min-height`），ECharts 依赖它计算尺寸。
8. **走廊排行列表**（JS 生成）：
   ```html
   <li class="rank-item is-alert">
     <span class="rank-no">01</span>
     <span class="rank-name">中山路走廊</span>
     <span class="rank-bar"><i style="width:78%"></i></span>
     <span class="rank-value">2.8</span>
   </li>
   ```
   需要 `.rank-item`（前三名 `.rank-no` 特殊配色）/ `.rank-bar`(i 为填充条) / `.rank-value`。
9. **模块标签页** `.tab`（底部，选中态 `.is-active` 带下划线或顶色条）
10. **模块指标小卡** `#module-metrics` 内为 `.mini-card`：
    ```html
    <div class="mini-card"><span class="mini-label">运营线路</span><b class="mini-value">312</b><em class="mini-unit">条</em></div>
    ```
11. **时间轴**：`#btn-play` 圆形主按钮 / `#speed-group` 分段控件（`button[data-speed]`，选中 `.is-active`）/ `input#timeline-slider`（必须自定义 `::-webkit-slider-thumb` 与 `::-moz-range-thumb`，含已滑过部分的 `--_fill` 进度视觉）/ `#timeline-track`（高度约 22px，内部由 JS 填 144 个 `.tl-cell`，需要 `.tl-cell` 的默认样式与 hover 放大效果）
12. **详情抽屉** `#detail-drawer`：默认从右侧滑出（`transform: translateX(100%)`），`.is-open` 时归位；含遮罩可选
13. **流程条 / 步骤条** 用于抽屉内路段历史（`.flow-steps` + `.flow-step`）
14. **表格** `.data-table`（抽屉与底部模块可能使用，斑马纹 + 粘性表头）
15. **`.chip` / `.badge` / `.tag`** 语义小标（`.badge--ok/.badge--warn/.badge--bad`）
16. **`#toast-host` 内的 `.toast`**（`.toast--ok/.toast--warn/.toast--err`，从右上滑入）
17. **`#loading-screen`**：政务风加载页（徽标 + 进度条 + 文案 + 呼吸动画），`.is-done` 后整体淡出 400ms
18. **自定义滚动条**（`::-webkit-scrollbar`，细、浅灰、圆角）
19. **`#nav-compass`**：圆形指北针，内部 `svg#compass-needle`（JS 只设 `transform: rotate(Xdeg)`，需保证 `transform-origin` 正确）+ `#compass-pitch` 文本
20. **`#view-hint`**：底部居中的半透明操作提示条
21. **`#tooltip`**：跟随鼠标的信息浮层，默认 `.is-hidden`，需设 `pointer-events:none` 与 `transform: translate(-50%, calc(-100% - 14px))`
22. **`#map-legend`**：图例，JS 填充，结构为 `.legend-item > .legend-swatch + .legend-text`

---

## 5. 脚本引用顺序（`index.html` 末尾，**顺序不可变**）

```html
<script src="vendor/three.min.js"></script>
<script src="vendor/echarts.min.js"></script>
<script src="js/utils.js"></script>
<script src="js/theme-bridge.js"></script>
<script src="js/data/city-model.js"></script>
<script src="js/data/sim-engine.js"></script>
<script src="js/data/data-api.js"></script>
<script src="js/three/scene.js"></script>
<script src="js/three/city-builder.js"></script>
<script src="js/three/camera-rig.js"></script>
<script src="js/three/layers.js"></script>
<script src="js/charts.js"></script>
<script src="js/ui/ui.js"></script>
<script src="js/app.js"></script>
```

---

## 6. UI 侧需要提供的"空状态"文案位
以下位置请在 HTML 中写一段合理的占位内容（JS 会覆盖，但首屏不能空白）：
`#kpi-ticker`、`#layer-list`、`#region-list`、`#view-modes`、`#kpi-cards`、`#corridor-rank`、
`#module-tabs`、`#module-metrics`、`#map-legend`、`#drawer-body`、`#timeline-track`。

## 7. 验收自检清单（UI 侧交付前必须逐条确认）
- [ ] 1920×1080 下无页面级滚动条，四栏无重叠
- [ ] 全文无任何 `http://` / `https://` 外链资源
- [ ] 无 `type="module"`、无内联 `onclick`
- [ ] §2 全部 CSS 变量都已在 `:root` 定义（可用脚本 grep 核对名称一致）
- [ ] §3 全部 id 均存在且拼写一致
- [ ] §3.1 状态类、§4 全部组件均有样式
- [ ] `js/*.js` 由我（主 Agent）负责创建；UI 侧只需保证 script 标签存在即可，缺失文件不影响 CSS 预览
