# APP-NOTES —— `js/app.js`（TP.App）装配说明与实测记录

> 交付物：`js/app.js`（633 行，560 非空）+ 本文件。
> 除本文件与 `js/app.js` 外**未改动任何文件**。

---

## 1. boot() 顺序（不可变，逐步 try/catch）

| # | 步骤 | 失败影响 |
|---|---|---|
| 0 | `TP.Theme.refresh()`（令牌落地后再读一次） | 仅告警，不阻断 |
| 1 | `TP.City.build()` | 数据层，失败则后面全降级 |
| 2 | `TP.Sim.init(TP.City.data)` | 同上 |
| 3 | `TP.Api.init({ mode:'mock' })` | 门面缺失 ⇒ UI/图表无数据 |
| 4 | `TP.Scene.init(#canvas-host)` | 3D 停摆，UI/图表照常 |
| 5 | `TP.CityBuilder.build(TP.City.data)` | 静态几何缺失 |
| 6 | `TP.Layers.init(TP.City.data, TP.Sim)` | 动态图层缺失 |
| 7 | `TP.CameraRig.init(TP.Scene.camera, #canvas-host)` | 视角系统缺失（拾取/悬停随之失效） |
| 8 | `TP.Charts.init()` | **仅图表降级**（UI 自动切 SVG 兜底曲线） |
| 9 | `TP.UI.init({ city, sim, api, scene, builder, rig, layers, charts, chartsOk, chartsError })` | 交互层缺失 |
| 10 | `TP.CameraRig.setMode('bird')` | 默认机位不生效 |
| 11 | `TP.Api.refresh()` + `TP.UI.renderAll()` | 首屏数值空白 |
| — | 图层开关对齐（`syncLayers()`，把 `TP.Api.state.layers` 灌给 `TP.Layers`）+ `wire()` 全局接线 | 安全跳过 |
| 12 | `TP.Api.emit('ready')` 广播（先广播、后关页面，避免图表闪空）→ `TP.UI.hideLoading()`（有降级则先停留 1.4s 显示错误摘要） | — |
| 13 | 启动 RAF 主循环 | — |

* `boot()` 幂等：`booted/booting` 双闸，重复调用直接返回；实测 `City.build` 只被调用 1 次。
* `TP.App.ready` 表示"引导流程已跑完"（≠ 全部模块健康）；健康度看
  `TP.App.stats.degraded` / `stats.core` / `stats.failedSteps`。

## 2. 主循环每帧做什么（顺序不可变）

```js
App.frame(dt)                       // RAF 自驱（内部 loop 计算 dt），外部也可手动调
  1) 播放态推进：playAcc += dt；≥80ms 才 TP.Api.setMinuteAuto(playAcc, speed)，然后清零
  2) TP.Layers.update(dt)           // 粒子/事件环/OD 光点/高亮呼吸
  3) TP.CameraRig.update(dt)        // 惯性、巡航、flyTo 过渡
  4) TP.Scene.update(dt)            // 必须在 rig 之后：阴影跟随 + 标签投影吃最新相机矩阵
  5) TP.Scene.render()
  6) TP.Util.Tween.update(dt)      // 补间（CameraRig 过渡靠它，rig 内部另有自驱兜底）
```
* `dt` clamp ≤ 100ms；fps 用**未裁剪**的真实帧间隔做 EMA（α=0.08，后台切回的一次大跳不计入）。
* 每一步独立 `guard()`（try/catch + 计数），任一步抛错只跳过该步并把计数写进 `stats.stepErrors`。
* `TP.Scene/Layers` 未 ready 时直接跳过 3D 步骤，避免每帧刷控制台。
* `visibilitychange` → 重置 `lastTs/playAcc`，从后台切回来不跳秒。
* `stats = { fps, minute, playing, speed, frames, dt, bootMs, degraded, charts, scene, core, failedSteps, stepErrors }`

## 3. 播放实现

* 播放态**权威来源是 `TP.UI.state.playing` / `TP.UI.state.speed`**（UI 层不拥有循环）；UI 缺失时退回本地 `playFlag`。
* `TP.App.pause()/resume()` 直接调 `TP.UI.setPlaying(false/true)` 同步 `#btn-play` 与内部态；`pause()` 只停时间推进，**不停渲染循环**（相机/图层动画要继续）。
* 速率交给 `TP.Api.setMinuteAuto(ms, speed)`（内部按真实时间累积、满 1 分钟才 `setMinute`），app 侧只做 ≥80ms 节流合并。
* 实测：400 帧 × 16.7ms = 6.68s 虚拟时间 → `minute 490 → 650`（+160 分钟），即 **1 档 ≈ 60s 走完 24h**，与契约一致；浏览器里 `1x → 4x` 推进速率同比放大，暂停后 `playing=false`。
* 时间变化 → `TP.Api` 发 `'time'` → app 调 `TP.Layers.applyTime()`（否则路网颜色不会跟着变）。
* 新事件：`TP.Api` 目前**没有** `emit('incident')`，所以 app 除了订阅 `'incident'`，还在 `'time'` 里做等价检测（对比活动事件集合），**只在播放推进时**提示（≥4s 一次），拖时间轴回看历史不刷屏。

## 4. 容错降级策略（本次重点）

1. 每一步单独 try/catch；失败 → `console.error('[App] <方法名> 失败：<msg>\n<完整堆栈>', e)` + `TP.UI.toast(msg,'err')` + 把「方法名 — 消息」写进 `#loading-screen .loading-text` + 记入 `stats.failedSteps`。
2. **加载页绝不永久转圈**：正常路径 0ms 关闭；有降级时先停留 1.4s 展示摘要再关；另有 **12s 看门狗**（超时写摘要 + toast + 强制关闭）；UI 层缺失时用等价 DOM 兜底（`data-done` / `is-done` / `is-hidden`）。
3. **已成功的部分继续可用**：charts 挂了 → `UI.init` 收到 `chartsOk:false` / `chartsError`，自动改用 SVG 兜底曲线，3D/UI 不受影响；`Layers`/`CityBuilder` 挂了 → `UI.init(ctx)` 里对应字段传 `null`，UI 用 `call()` 静默跳过；3D 挂了 → 图表与面板照常。
4. 依赖缺失时 `ctx` 传 `null` 而不是"假装可用"，避免 UI 反复抛错。
5. 实测（两次真实浏览器 + 一次 Node 微测）：
   * 注入 `TP.Charts.init()` 抛错：`console.error` 恰好 1 条（我们自己的，带堆栈）、exception 0；`stats.degraded=true`、`stats.charts='degraded'`、`failedSteps=[charts]`；加载页正常消失且 `.loading-text` = 「启动降级 1 项：TP.Charts.init() — E2E…」；`#chart-trend/#chart-forecast` 转为 SVG、sparkline 4 张 SVG；3D draw 27 / 三角面 8.2 万，KPI/图层/时间轴/抽屉/四视角/6 模块看板全部照常。
   * 数据层文件被并发改坏（`City.build` 抛 `lines is not defined`）时：4 个步骤连续失败，页面仍未卡在加载页，每条错误都有方法名 + 堆栈，其余步骤继续。

## 5. 全局接线：**UI 已绑的不重复绑**

`js/ui/ui.js` 的 `bind()`/`subscribe()` 已绑：`#layer-list`、`#region-list`、`#view-modes`、`#module-tabs`、`#corridor-rank`、`#btn-play`、`#speed-group`、`#timeline-slider`（input/pointerdown…）、`#timeline-track`（格子点击）、`#btn-fullscreen`、**`#btn-theme`**、`#drawer-close`、`fullscreenchange`、键盘 `1/2/3/4`、空格、Esc、`window resize`，以及 `TP.Api` 的 time/layer/region/view/module/signalgroup/daytype/select 事件。

**app.js 只补 UI 没做的 5 处**：
1. `TP.CameraRig.onPick(e => TP.Api.pickInfo(e.hit) → TP.UI.showDetail(d, hit))`（详情一律经门面，app 不拼业务对象）。
2. `TP.CameraRig.onHover(...)` → `TP.UI.tooltip(html, px, py)`；HTML 由 `TP.UI.tooltipFromDetail()` 生成，并按「实体 + 当前 minute」缓存，避免 60ms 一次的 hover 重复取数。
3. `TP.Api.on('time')` → `TP.Layers.applyTime()` + 新事件检测；`TP.Api.on('incident')` → toast（防御性订阅）。
4. `#timeline-slider` 的 `pointerdown/up` → `TP.Charts.setAnimation(false/true)`（UI 只切自己的 `scrubbing` 标志，没动图表动画）。
5. `window resize/orientationchange` 的**防抖复核**（Scene/Charts 各自已监听，这里是幂等补刷，覆盖全屏切换）；`visibilitychange` 重置帧计时。

> `#btn-theme` 由 UI 的 `onThemeClick()` 全权处理（`Theme.refresh` → Scene/CityBuilder/Layers/Charts/UI 各自 applyTheme），app **没有**再绑，避免一次点击触发两次。

## 6. 实测数字

**静态检查**（`node --check` + Node 读回中文，非 PowerShell 判断编码）：语法 OK、UTF-8 干净、无 U+FFFD。

**`_selftest/integration-audit.js`**：14/14 脚本加载成功，已注册 12 个命名空间（含 `App`），共扫描 **308 处 `TP.*` 引用** → 「✅ 全部 TP.* 引用均可解析」+「❌ 发现 0 个问题」。
（唯一 note：`js/three/scene.js` 含 65 个 U+FFFD，属既有文件、审计只列为提示项，不是 error。）

**`_selftest/boot-test.js`**：除 1 项外全部 PASS —— draw call **31**、三角面 **22.6 万**、`Layers.applyTime()` 中位 **1ms**、`Layers.update` 中位 0ms、`resolveHit → pickInfo` **7/7**、四种视角全部可切换。唯一 FAIL 是 `车流粒子使用 InstancedMesh 且数量 ≤ 3000 → 实例总数 8887`：该断言统计的是**全部 InstancedMesh 实例和**，数据层路网刚从 1792 条扩到 3720 条（车流粒子本身 426 ≤ 3000、仍为 InstancedMesh），阈值项属数据/几何规模问题，与 app.js 无关。

**浏览器真实渲染**（Edge 155 + CDP 实测，本地静态服务 127.0.0.1:8899；窗口 1680×1000，舞台 692×477）：

| 验收项 | 结果 |
|---|---|
| `#loading-screen` 消失、控制台零 error | ✅ `data-done=1` / `is-hidden`；**console.error 0、exception 0**（仅 `favicon.ico` 404，浏览器自动请求，index.html 无 favicon，非 app 代码） |
| 3D 城市渲染 | ✅ 路网/建筑/地面网格/行政区标签/事件光柱可见；WebGL 实测 draw **25~28**、可见三角面 **14.2~17.3 万**、画质系数 1 |
| 顶栏 KPI / 左栏三组 / 右栏 KPI 卡与图表 / 底部模块标签 | ✅ ticker 16 节点、图层 12、行政区 7、视角 4、KPI 卡 4（含 4 张迷你走势图）、走廊排行 6、模块标签 6、模块指标 6、图例、`#chart-trend` + `#chart-forecast` 各 1 个 ECharts 实例（共 4 个） |
| 拖时间轴路网变色 | ✅ 03:00（畅通 1792/0/0/0）↔ 08:00（1012/520/192/68）切换后截图采样 **8963/9013 处像素不同**，图表/图例/KPI 同步 |
| 点击路网开抽屉 | ✅ 真实输入点击 → `#detail-drawer.is-open`、标题「兴业路」、8 个指标、2 张 SVG（24h 车速 + 预测）、`TP.Layers.highlighted()='road:R1319'`；Esc 可关闭并清空选中 |
| hover 高亮 + tooltip | ✅ tooltip 文本「紫荆路 状态缓行 实时车速30.3 km/h 断面流量2,605 辆/h 车道占有率60 %」，`hover-road` 高亮网格 visible=true |
| 四视角（按钮 + 键盘 1/2/3/4） | ✅ 4/4：`orbit/top/bird/cruise` 的 rig.mode、api.viewMode、按钮 `is-active` 三者一致；按钮点击同效 |
| 6 模块看板逐个切换 | ✅ 全部出图（含 OD 6×6 热力矩阵 + TOP 流向、信号绿波带时距图：带宽 33s / 效率 93.6% / 推荐 45 km/h）；`#signal-diagram` 仅在信号模块显示 |
| 播放/暂停/倍速 | ✅ 播放后 minute 推进、`playing=true`；4 档加速后推进明显加快；再点暂停 `playing=false` |
| fps | ✅ **59.9 ~ 60.1**（EMA，2046 帧 / 4s 复核 frames 持续增长，dt 16.6~16.7ms） |
| 1280×720 档 | ✅ 画布 654×448、图表 0 尺寸/错位、144 格时间轴与面板完整，draw 28 / 三角面 17.3 万 |
| 整页刷新 3 次 | ✅ 3/3 无偶发失败：ready=true、加载页已隐藏、降级 0、console.error 0、exception 0、network 失败 0，boot 331~660ms |

**容错专项**：见 §4.5（注入 `TP.Charts.init()` 抛错 + Node 侧装配微测 15 项全 PASS）。

## 7. 已知不足

1. **点击命中"无详情"的实体时无反馈**：`TP.Api.pickInfo()` 对个别命中（如无信号机的交叉口、找不到线路的站点）返回 `null`，按契约 app 不在本地拼详情，此时静默忽略（用户点附近路段即可）。若需要反馈，应在数据门面补默认详情。
2. 新事件 toast 目前是**等价检测**（`TP.Api.incident` 事件尚未实现），只在播放推进时提示；且 4s 内只提示一批中的第一条（其余以"另有 N 起"带过）。
3. `TP.App.pause()` 只暂停**时间推进**，不停止渲染循环（这是有意为之：相机/图层动画需要继续跑）。
4. 播放推进依赖 `TP.UI.state.playing`，若 UI 层缺失则以本地 `playFlag` 兜底——此时没有播放按钮，只能靠 `TP.App.resume()` 手动开。
5. 未做"时段预设/一键跳到早晚高峰"之类的入口（契约未要求）。
6. `_selftest/boot-test.js` 的 `实例总数 ≤ 6000` 断言随数据层路网扩容而失效（见 §6），需要数据/几何侧确认是否放宽阈值。
