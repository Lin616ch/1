# 总装契约 v1 —— 数据接口门面 + 图表 + UI 逻辑 + 应用装配

> **归属**：
> - `js/data/data-api.js`（`TP.Api`）→ 由「数据接口」负责，**已由主 Agent 实现**
> - `js/charts.js`、`js/ui/ui.js`、`js/app.js` → 由「总装代理」实现
> **上游**：`TP.City` / `TP.Sim`（数据契约）、`TP.Scene` / `TP.CityBuilder` / `TP.CameraRig` / `TP.Layers`（3D 契约）
> **下游**：无

---

## 0. 依赖与约束

| 项 | 值 |
|---|---|
| ECharts | **5.4.3**，UMD 全局 `echarts`，来自 `vendor/echarts.min.js`（已就绪） |
| Three.js | r128 UMD 全局 `THREE`，来自 `vendor/three.min.js`（已就绪） |
| 已存在可复用 | `TP.Util`（utils.js）、`TP.Theme`（theme-bridge.js）、`TP.Api`（data-api.js） |
| 语言 | ES5 语法 IIFE，挂到 `window.TP` |

### 0.1 硬性禁止
- ❌ 不得使用 ES Module（`import` / `export` / `type="module"`）
- ❌ 不得引用任何外部库 / CDN / 网络资源（必须 `file://` 双击可打开）
- ❌ 不得修改 `js/utils.js`、`js/theme-bridge.js`、`js/data/*`、`js/three/*`、`index.html`、`css/*`、`docs/*.md`
- ❌ 不得在 HTML 里写内联事件（HTML 归 UI 代理所有，你只能**用 JS 绑定事件**）
- ❌ 不得硬编码色值，图表配色一律从 `TP.Theme.chartColors()` / `TP.Theme.roadColor()` / `TP.Theme.hex()` 取

---

## 1. 交付物

| 文件 | 命名空间 | 职责 |
|---|---|---|
| `js/charts.js` | `TP.Charts` | 全部 ECharts 图表：趋势、预测、6 个模块看板、绿波带时距图、迷你走势图 |
| `js/ui/ui.js` | `TP.UI` | 全部 DOM 交互：顶栏、图层列表、行政区、视角按钮、KPI 卡、排行、模块标签、时间轴、详情抽屉、tooltip、toast、加载页 |
| `js/app.js` | `TP.App` | 引导装配 + 主循环 + 全局事件总线接线 |
| `docs/APP-NOTES.md` | — | 交互说明、模块看板设计、实测帧率、已知问题 |

---

## 2. `TP.Api` —— 数据接口门面（**已实现，你只管调用**）

前端**唯一**的取数入口。**不要**直接读 `TP.Sim.roadStates` 之类（数据层可以读，图表与 UI 层一律走 `TP.Api`）。

### 2.1 初始化与状态
```js
TP.Api.init({ mode:'mock', pollMs:2000 })   // mock = 读 TP.Sim；live = 预留 HTTP 适配器
TP.Api.ready()                              // → boolean（**是函数**）
TP.Api.isReady                              // → boolean（getter）
// ⚠️ 不要写 `if (TP.Api.ready)` —— 函数永远是真值，会绕过就绪检查。要短路判断请用 `TP.Api.isReady`。

TP.Api.state = {
  minute: 512,          // 0..1439
  dayType: 'weekday',   // 'weekday' | 'weekend'
  regionId: 'all',      // 'all' | districtId
  viewMode: 'bird',     // 'orbit' | 'top' | 'bird' | 'cruise'
  moduleId: 'traffic',  // 见 §2.4
  layers: { traffic:true, heat:true, ... },
  selected: null        // { kind, id }
};

TP.Api.setMinute(m)          // → 触发 'time' 事件
TP.Api.setDayType('weekday'|'weekend')   // → 'daytype'
TP.Api.setRegion(id)         // → 'region'
TP.Api.setViewMode(mode)     // → 'view'
TP.Api.setModule(id)         // → 'module'
TP.Api.setLayer(id, on)      // → 'layer'
TP.Api.setSelected(sel)      // → 'select'
```

### 2.2 事件总线（UI 与图表都用它刷新）
```js
TP.Api.on(evt, fn)  // → 返回取消订阅函数
TP.Api.off(evt, fn)
// 事件名（固定）：
// 'ready'     初始化完成
// 'time'      时间变化   fn({minute, hhmm})
// 'daytype'   工作日/周末 fn({dayType})
// 'region'    行政区变化  fn({regionId})
// 'view'      视角变化   fn({viewMode})
// 'module'    底部模块切换 fn({moduleId})
// 'layer'     图层开关   fn({id, on})
// 'select'    选中实体   fn({kind, id}) 或 fn(null)
// 'incident'  新事件产生 fn(incident)   （mock 模式按时间推进触发）
// 'live'      实时数据帧 fn({ts, minute})
```
> ⚠️ 图表与 UI **必须订阅事件**做增量刷新，不要写 `setInterval` 轮询。

### 2.3 快照与看板数据
```js
TP.Api.snapshot()
// → {
//   time:    { minute, hhmm, dayType, dayTypeName, phaseName },   // phaseName 如 '晚高峰'
//   kpi:     { avgSpeed, congestionIndex, inNetVehicles, totalFlow, incidentCount,
//              transitRidership, transitShare, parkingOccupancy, parkingAvailable,
//              bikeRides, carbonToday, carbonSaved, greenShare, onTimeRate,
//              avgDelay, avgQueue, signalCount, greenWaveCount, emergencyResp,
//              congestionDelta, speedDelta },        // *Delta = 与昨日同期相比 %
//   districts: [{ id, name, color, avgSpeed, congestionIndex, flow, inNetVehicles,
//                 saturation, incidents, roadKm, population }],
//   layers:  [{ id, name, icon, on, count, unit }],
//   regions: [{ id, name, value, unit, active }],      // 'all' + 6 区
//   views:   [{ id, name, desc, key, active }],        // key = '1'..'4' 快捷键
//   modules: [{ id, name, active }],
//   alerts:  [{ id, level:'info'|'warn'|'danger', title, time, hhmm, districtId }]
// }

TP.Api.ticker()        // → [{ label, value, unit, trend }]  顶栏滚动 KPI，6~8 条
TP.Api.kpiCards()      // → 4 张右侧 KPI 卡：
                       //   { id, label, value, unit, decimals, trend, trendText, foot,
                       //     spark:[...20 个数], level:'ok'|'warn'|'bad' }
TP.Api.ranking(kind, metric, n)
//   kind: 'corridor' | 'district' | 'road' | 'metroLine' | 'busLine' | 'parking'
//   → [{ id, name, value, unit, display, ratio, level, isAlert }]   ratio 0..1
TP.Api.incidents()     // → [{ id, type, typeName, title, x, z, roadId, roadName,
                       //      districtId, districtName, severity, severityName,
                       //      since, sinceHHMM, duration, elapsed, status, statusName,
                       //      impactKm, responders, vehiclesAffected }]
TP.Api.alertsFeed()    // → 同 snapshot().alerts
TP.Api.summary()       // → 一句话态势播报（政务口吻，用于顶栏/抽屉）
TP.Api.districts()     // → TP.City.data.districts
TP.Api.meta()          // → { cityName, roadKm, population, areaKm2, roadCount, ... }
TP.Api.viewsMeta() / layersMeta() / modulesMeta()
```

### 2.4 底部模块看板（**6 个模块，id 固定**）
```js
TP.Api.modulesMeta()
// → [
//   { id:'traffic', name:'路况态势' },
//   { id:'od',      name:'OD 出行' },
//   { id:'transit', name:'公交地铁' },
//   { id:'signal',  name:'信号绿波' },
//   { id:'park',    name:'停车慢行' },
//   { id:'carbon',  name:'绿色出行' }
// ]

TP.Api.moduleBoard(moduleId)
// → {
//   metrics: [{ label, value, unit, decimals, trend, level }],   // 4~6 个小卡
//   chart:   { type, ... },        // 见下方各模块的 chart 规格
//   legend:  [{ label, color, value }],
//   table:   [{ name, v1, v2, v3 }] 或 null
// }
```
各模块 `chart` 规格（总装代理按此渲染）：

| moduleId | chart.type | 说明 |
|---|---|---|
| `traffic` | `'dualAxis'` | 24h 拥堵指数（折线/面积）+ 平均速度（折线）双 Y 轴，带 24 个整点刻度；`series:{x:[], congestion:[], speed:[]}` |
| `od` | `'odMatrix'` | 6×6 OD 矩阵热力图 + 右侧 TOP 流向条形；`matrix:{districts:[], values:[[...]]}, top:[{from,to,volume}]` |
| `transit` | `'barRank'` | 线路客流 TOP10 横向条形，按地铁/公交分色；`items:[{name, value, kind}]` |
| `signal` | `'greenWave'` | 绿波带时距图（横轴距离、纵轴时间、每站一根绿/红相位条、叠加一条推荐车速斜线）；`greenWave: TP.Sim.greenWave(groupId)` 结构 |
| `park` | `'stackedBar'` | 各行政区停车占用率堆叠条 + 共享单车周转折线；`categories:[], parking:[], bike:[]` |
| `carbon` | `'pie'` | 碳排放构成环形图 + 中心显示减排量；`items:[{name, value, ratio, color}]` |

```js
TP.Api.legend(moduleId)      // → [{ label, color, value, unit }]，给 #map-legend
TP.Api.signalBoard(groupId)  // → { groupId, corridorId, corridorName, recommendedSpeed,
                             //      bandwidth, efficiency, stops:[{ signalId, name, x, z,
                             //      distanceFromStart, offsetSec, phase, remain, greenRatio }] }
TP.Api.greenWaveGroups()     // → [{ id, corridorId, name, recommendedSpeed, bandwidth }]
TP.Api.transitBoard()        // → { lines:[…], summary:{…} }
TP.Api.parkingBoard()        // → { top:[…], summary:{…} }
TP.Api.carbonBoard()         // → { total, saved, perMode:[…], greenModes:[…] }
TP.Api.greenBoard()          // → { greenShare, modes:[…], savedTotal }
```

### 2.5 序列、预测与时间轴
```js
TP.Api.series(metric)          // → { x:[分钟 0..1435], y:[…288], label, unit }
                               //   metric: 'congestionIndex'|'avgSpeed'|'flow'|'transitRidership'|'carbon'|'incidents'
TP.Api.forecast(metric, horizonMin)
// → { metric, label, unit, now, trend:'up'|'down'|'flat', peakMinute, peakValue,
//     points:[{ minute, hhmm, v, lo, hi }] }
TP.Api.timelineBands()         // → 144 格（每 10 分钟）：[{ minute, hhmm, level:0..3, congestion, label }]
                               //   用于 #timeline-track 的格子着色
```

### 2.6 详情（供 `#detail-drawer`）
```js
TP.Api.roadInfo(roadId)
// → { kind:'road', title, subtitle, districtName, badges:[{text,kind}],
//     metrics:[{label,value,unit,level}],
//     series:{ x:[], y:[], label, unit },          // 该路段 24h 车速
//     forecast:{ points:[…] },
//     signals:[{ name, cycle, phase, remain }],
//     transit:[{ name, kind, distanceM }],         // 周边线路
//     events:[{ title, severity, sinceHHMM }],
//     flowSteps:[{ label, value, unit }] }         // 用于 .flow-steps

TP.Api.stationInfo(kind, id)     // kind: 'metro'|'bus' → 站点详情（同构）
TP.Api.parkingInfo(id) / bikeInfo(id) / corridorInfo(id) / incidentInfo(id) / districtInfo(id)
TP.Api.pickInfo(hit)             // hit = TP.Layers.resolveHit() 的返回；→ 上面任一种详情对象
TP.Api.searchNear(x, z, radius)  // → { roads:[…], stations:[…], parking:[…], incidents:[…] }
```

### 2.7 适配器与工具
```js
TP.Api.adapter = {
  mode: 'mock',          // 'mock' | 'live'
  baseUrl: '',
  fetchSnapshot(),       // live 模式下 GET baseUrl + '/snapshot'
  pushSelect(sel)        // 预留：把选中事件回传后端
};
TP.Api.fmt = {
  num(v, d), int(v), compact(v), pct(v, d), hhmm(min),
  speed(v), km(v), minutes(v), tons(v), wan(v)
};
TP.Api.regionFilter()    // → fn(item) → bool，item 含 districtId；regionId 为 'all' 时恒 true
TP.Api.visibleRoadIds()  // → Set<roadId>，当前行政区下的路段
TP.Api.setRegionFilterOnLayers()   // 便捷方法：把 regionFilter 同步给 TP.Layers
TP.Api.refresh()         // 强制重算当前 minute 的所有派生数据并 emit 'live'
```

---

## 3. `TP.Charts` API

```js
TP.Charts.init()                  // 建立 4 个图表实例 + resize 监听
TP.Charts.ready                   // boolean
TP.Charts.applyTheme()            // 从 TP.Theme 重取配色并 setOption
TP.Charts.trend(metric)           // 渲染 #chart-trend（默认 metric='congestionIndex'）
TP.Charts.forecast(metric)        // 渲染 #chart-forecast（带置信带面积）
TP.Charts.moduleChart(moduleId)   // 渲染 #bottom-chart（按 §2.4 的 chart.type 分派）
TP.Charts.signalDiagram(groupId)  // 渲染 #signal-diagram（绿波带时距图；其它模块时容器加 is-hidden）
TP.Charts.sparkline(el, data, color, opts)   // 在 .kpi-spark 里画迷你走势图
TP.Charts.resize()                // 容器变化时调用（内部已监听 window resize + ResizeObserver）
TP.Charts.dispose()
```
### 3.1 图表视觉要求（浅色政务风）
- 统一 `grid` 留白紧凑（`left:8, right:12, top:24, bottom:6, containLabel:true`）
- **不要** ECharts 默认的粗网格与深色 tooltip。坐标轴线用 `--c-border`，轴标签用 `--c-text-dim`（11px）
- tooltip 用白底 + `--c-border` 描边 + 小圆角 + `--c-shadow` 阴影，`axisPointer` 用虚线
- 折线用 `smooth:true`，面gradient 用主色 `rgba(…,0.18) → rgba(…,0)` 渐隐
- 拥堵指数折线应**按数值分段着色**（畅通绿 / 缓行黄 / 拥堵橙 / 严重红），用 `visualMap` 或分段 series
- 柱状图圆角 `[3,3,0,0]`、条宽 ≤ 14px
- 动画时长 400ms、`animationEasing:'cubicOut'`，**时间轴拖动时应关闭动画**（`animation:false`）以免卡顿
- 每个图表必须 `setOption(option, true)`（notMerge）避免脏状态残留

---

## 4. `TP.UI` API

```js
TP.UI.init(ctx)          // ctx = { city, sim, api, scene, builder, rig, layers, charts }
TP.UI.ready
TP.UI.state              // 镜像 TP.Api.state，UI 侧只读缓存

// 渲染
TP.UI.renderTicker()     // #kpi-ticker
TP.UI.renderLayers()     // #layer-list
TP.UI.renderRegions()    // #region-list
TP.UI.renderViews()      // #view-modes
TP.UI.renderKpiCards()   // #kpi-cards
TP.UI.renderRanking()    // #corridor-rank
TP.UI.renderModules()    // #module-tabs
TP.UI.renderModuleBody() // #module-metrics + #bottom-chart + #signal-diagram
TP.UI.renderLegend()     // #map-legend
TP.UI.renderTimeline()   // #timeline-track（144 个 .tl-cell）
TP.UI.renderAll()

// 时间轴
TP.UI.setMinute(m, opts)     // 同步 slider / label / #timeline-track 高亮；opts={fromPlayback}
TP.UI.setPlaying(bool)       // 切换 #btn-play 的 .is-playing 与内部 SVG
TP.UI.setSpeed(v)            // 1|2|4|8

// 详情抽屉
TP.UI.showDetail(detail)     // detail = TP.Api.roadInfo(...) 等；打开 #detail-drawer 并填充
TP.UI.closeDrawer()

// 反馈
TP.UI.tooltip(html, px, py) / TP.UI.hideTooltip()
TP.UI.toast(msg, kind)       // kind: 'ok'|'warn'|'err'|'info'
TP.UI.hideLoading()
TP.UI.setClock(date)         // #sys-clock / #sys-date / #weather-chip

// 主题
TP.UI.applyTheme()
```

### 4.1 交互绑定要求（**全部用 `addEventListener`，禁止内联事件**）
| 元素 | 交互 |
|---|---|
| `#layer-list` | 用 `TP.Util.delegate` 委托点击 `.layer-item` → `TP.Api.setLayer(id, !on)` + `TP.Layers.setVisible(id, on)` |
| `#region-list` | 点击 `.region-item` → `TP.Api.setRegion(id)` + `TP.Layers.setRegionFilter(TP.Api.regionFilter())` + `TP.CityBuilder.setRegionHighlight(id)` + 若为具体区则 `TP.CameraRig.focusOn(bounds.center.x, bounds.center.z, {radius:bounds.radius})` |
| `#view-modes` | 点击 `.view-btn` → `TP.Api.setViewMode(m)` + `TP.CameraRig.setMode(m)`；同时监听键盘 `1/2/3/4` |
| `#module-tabs` | 点击 `.tab` → `TP.Api.setModule(id)` → 重渲染模块看板与图例 |
| `#btn-play` | 播放/暂停 24h 回放（内部 `requestAnimationFrame` 累积推进 minute，速度按 `speed` 档） |
| `#speed-group` | 切换倍速 |
| `#timeline-slider` | `input` 事件 → `TP.Api.setMinute(v)`（**实时拖动要流畅，注意性能**） |
| `#timeline-track` | 点击某格 → 跳到该时刻；hover 显示提示 |
| `#btn-fullscreen` | `requestFullscreen` / `exitFullscreen` |
| `#btn-theme` | 调用 `TP.Theme.refresh()` → `TP.CityBuilder.applyTheme()` + `TP.Layers.applyTheme()` + `TP.Charts.applyTheme()` + `TP.UI.applyTheme()`。若 `index.html` 未提供浅/深两套变量，则此按钮只做"刷新令牌"并 toast 提示 |
| `#drawer-close` | 关闭抽屉 |
| `.kpi-spark` | `TP.Charts.sparkline` 填充 |

### 4.2 主循环归属
主循环写在 **`js/app.js`**，`TP.UI` 只暴露方法不拥有循环：
```js
// app.js 的 frame(dt)
TP.Api.setMinuteAuto(dtLike)     // 播放态下由 app 推进 minute（见 §5）
TP.Layers.update(dt);
TP.CameraRig.update(dt);
TP.Scene.update(dt);
TP.Scene.render();
TP.Util.Tween.update(dt);
```

---

## 5. `TP.App` API 与主循环

```js
TP.App.boot()            // 页面加载后自动执行；也可手动调用
TP.App.ready             // boolean
TP.App.frame(dt)         // 主循环（内部已用 RAF 自驱，外部一般不用调）
TP.App.pause() / resume()
TP.App.stats             // { fps, minute, playing, speed }
```

`boot()` 必须按此顺序：
1. `TP.City.build()`
2. `TP.Sim.init(TP.City.data)`
3. `TP.Api.init({ mode:'mock' })`
4. `TP.Scene.init($('#canvas-host'))`
5. `TP.CityBuilder.build(TP.City.data)`
6. `TP.Layers.init(TP.City.data, TP.Sim)`
7. `TP.CameraRig.init(TP.Scene.camera, $('#canvas-host'))`
8. `TP.Charts.init()`
9. `TP.UI.init({...})`
10. `TP.CameraRig.setMode('bird')`（默认机位）
11. `TP.UI.renderAll()` + `TP.Api.refresh()`
12. `TP.UI.hideLoading()` + `TP.Api.emit('ready')`
13. 启动 RAF 主循环

**异常兜底**：若任一步骤抛错，`#loading-screen` 必须显示错误信息而不是永远转圈；把错误写入 `#toast-host` 并 `console.error`。

**播放逻辑**：`TP.UI` 播放时，`app.js` 每帧按 `dt * speed * (1440/60000)` 推进 minute（即 1 档 = 60 秒走完 24 小时），到 1439 回到 0。推进时调 `TP.Api.setMinute(m)`。为避免每帧重算，做**≥80ms 节流**（`TP.Util.throttle`）。

**新事件推送**：时间推进时若跨过某个事件的 `since`，`TP.Api` 会 `emit('incident')`；`app.js` 负责 `TP.UI.toast()` 提示 + `TP.Layers` 事件图层刷新。

---

## 6. 自测（必做，结果写进 `docs/APP-NOTES.md`）

起本地静态服务（`python -m http.server 8899`）后浏览器实测：
- [ ] 页面加载完成后 `#loading-screen` 消失，无控制台 error
- [ ] 顶栏 KPI 滚动条有内容且匀速滚动
- [ ] 左侧：12 个图层开关可点、6 个行政区可切换、4 个视角按钮可切换（含键盘 1/2/3/4）
- [ ] 右侧：4 张 KPI 卡有数字与迷你走势图；趋势图与预测图正常渲染
- [ ] 底部：6 个模块标签逐个切换，每个都能出图（含 OD 矩阵热力图、绿波带时距图）
- [ ] 时间轴：拖动 slider 时**路网颜色实时变化**、图表跟随、144 格热力条高亮同步；播放/暂停/倍速正常
- [ ] 点击路网某条路 → 抽屉打开并显示该路段详情（含 24h 车速曲线）
- [ ] hover 路网有高亮 + tooltip 跟随鼠标
- [ ] 切换行政区后，3D 高亮与列表同步
- [ ] 窗口 resize 后图表自适应，不出现 0 尺寸或错位
- [ ] 1920×1080 与 1280×720 两档分辨率都不错位
- [ ] 整页刷新 3 次，无偶发失败（竞态/时序问题）

---

## 7. 最终回复格式（600 字以内）
1. 写入文件列表及行数
2. 6 个模块看板各用了什么图表类型与关键设计
3. 时间轴回放与播放的实现方式、实测流畅度
4. 自测清单逐条结果
5. 已知不足与待联调项
