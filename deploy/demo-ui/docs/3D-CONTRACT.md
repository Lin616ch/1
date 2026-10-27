# 3D 契约 v1 —— Three.js 城市渲染层

> **归属**：由「3D 代理」实现 `js/three/*`。
> **边界**：本层只负责**把数据画出来 + 视角控制**。不得生成业务数据、不得写 UI 面板逻辑、不得改 HTML/CSS。
> **上游**：`TP.City`（静态城市）、`TP.Sim`（仿真状态）、`TP.Api`（数据接口门面）。
> **下游**：`js/app.js`（由「总装代理」实现）会按本契约调用。

---

## 0. 环境与技术约束

| 项 | 值 |
|---|---|
| Three.js | **r128**，UMD 全局 `THREE`，来自 `vendor/three.min.js`（已就绪） |
| 已存在可复用 | `js/utils.js`（`TP.Util`）、`js/theme-bridge.js`（`TP.Theme`） |
| 坐标系 | Y 轴朝上，城市在 XZ 平面，`X,Z ∈ [-1000,1000]`，**1 世界单位 = 5 米** |
| 语言 | ES5 语法 IIFE，挂到 `window.TP` |
| 必须支持 | `file://` 双击直接打开 |

### 0.1 硬性禁止
- ❌ **不得使用 ES Module**（`import`/`export`/`type="module"`）
- ❌ 不得引用任何外部库或 CDN。**没有 OrbitControls**（examples/js 未下载），轨道控制必须自己写
- ❌ 不得引入后处理（EffectComposer / UnrealBloom 未下载）。**浅色政务风本来就不该用辉光**，用色块层次与柔和阴影表达
- ❌ 不得操作 `#sidebar-*`、`#topbar`、`#bottombar`、`#detail-drawer`、`#tooltip` 等 UI 容器（除下方明确约定的 `#nav-compass` 子元素）
- ❌ 不得创建 `js/charts.js`、`js/ui/ui.js`、`js/app.js`、`index.html`、`css/*`、`js/data/*`
- ❌ 不得修改 `js/utils.js`、`js/theme-bridge.js`、`docs/*.md`

### 0.2 必须使用 `TP.Theme` 取色
所有颜色**一律**通过 `TP.Theme` 读取，禁止硬编码色值（虚线灰度除外）：
```js
TP.Theme.hex('--stage-ground')     // → '#f1f5f9'
TP.Theme.hexInt('--bld-top')       // → 0xffffff（给 THREE 用）
TP.Theme.threeColor('--road-free') // → THREE.Color
TP.Theme.roadColor(level)          // level 0..3 → 畅通/缓行/拥堵/严重拥堵 的 hex
TP.Theme.heatRamp()                // → [低,中,高] hex 数组，配 TP.Util.ramp 用
TP.Theme.chartColors() / metroColors()
TP.Theme.rgba('--c-primary', 0.3)  // → 'rgba(...)'
```
`TP.Theme.refresh()` 后需能换肤重绘（提供 `TP.CityBuilder.applyTheme()` / `TP.Layers.applyTheme()`）。

---

## 1. 交付物

| 文件 | 命名空间 | 职责 |
|---|---|---|
| `js/three/scene.js` | `TP.Scene` | 渲染器、相机、光照、天空、雾、地面、网格、标签投影、自适应画质 |
| `js/three/city-builder.js` | `TP.CityBuilder` | 静态城市几何：建筑、路网、水系、绿地、行政区边界、地标 |
| `js/three/camera-rig.js` | `TP.CameraRig` | **视角系统（本项目核心）**：4 种模式 + 平滑转换 + 轨道控制 + 巡航 |
| `js/three/layers.js` | `TP.Layers` | 动态数据图层：路况、热力、公交地铁、OD 飞线、车流粒子、事件、停车、单车、碳排、信号 |
| `docs/3D-NOTES.md` | — | 视觉与性能说明、性能实测、已知问题 |

---

## 2. `TP.Scene` API

```js
TP.Scene.init(hostEl)                 // hostEl = document.getElementById('canvas-host')
TP.Scene.ready                        // boolean
TP.Scene.scene / camera / renderer    // 暴露给其他模块（CameraRig 需要 camera）
TP.Scene.world                        // THREE.Group —— 静态城市（TP.CityBuilder 往这里加）
TP.Scene.dataGroup                    // THREE.Group —— 动态图层（TP.Layers 往这里加）
TP.Scene.update(dt)                   // 每帧调用（ms）。内部：阴影跟随、标签投影、画质自适应
TP.Scene.render()                     // 渲染一帧
TP.Scene.resize()                     // 重新读取 host 尺寸（内部已监听，外部也可手动调）
TP.Scene.screenPos(x, y, z)           // 世界坐标 → 容器像素 { x, y, visible, depth }
TP.Scene.raycast(px, py, objects)     // 容器像素 → { object, point:{x,y,z}, instanceId, distance } | null
TP.Scene.groundPoint(px, py)          // 容器像素 → 地面 y=0 交点 { x, z } | null
TP.Scene.addLabel(html, posFn, opts)  // → { el, remove() }  HTML 标签，自动跟随投影
TP.Scene.clearLabels()                // 清空所有标签
TP.Scene.setQuality(q)                // 0.5 ~ 1.0，立即生效
TP.Scene.quality                      // 当前画质系数
TP.Scene.stats                        // { fps, drawCalls, triangles, quality }
TP.Scene.setOption(key, value)        // 'shadows' | 'grid' | 'fog' | 'buildings'
TP.Scene.onResize(fn)                 // 容器尺寸变化回调
```
`opts` of `addLabel`：`{ className, offsetY, minDistance, maxDistance, fadeStart, occlude }`。
标签容器由 `TP.Scene` 自行创建并挂到 `hostEl` 内（若 `hostEl` 不是 `position:relative` 则自己补上），
**不得**依赖 UI 层提供容器。

### 2.1 场景视觉要求（浅色政务风）
- `renderer`：`antialias:true`、`alpha:false`、`outputEncoding = THREE.sRGBEncoding`、`setPixelRatio(min(devicePixelRatio,2) * quality)`
- **天空**：垂直渐变 CanvasTexture 作 `scene.background`（`--stage-sky-top` → `--stage-sky-bottom`，地平线附近带宽缓过渡）
- **雾**：`THREE.Fog(hex('--stage-fog'), ~900, ~3000)`，使远处建筑融进雾里，产生大气透视
- **光照**：`HemisphereLight(天空色, 地面色, ~0.75)` + 主 `DirectionalLight(~0.6)` + 反向补光 `DirectionalLight(~0.25)`。
  主光**投射柔和阴影**（`PCFSoftShadowMap`，mapSize 2048），阴影相机为正交、范围 ±650，
  **每帧让主光与其 target 一起跟随 `TP.CameraRig.target`**，这样近处阴影始终清晰（关键技巧）
- **地面**：`PlaneGeometry` 大平面用 `--stage-ground`；网格用两个 `GridHelper`：
  细网格 2000/125（`--stage-grid`，opacity ≈0.55）、主网格 2000/25（`--stage-grid-major`，opacity ≈0.85）
- **相机**：`PerspectiveCamera(42, aspect, 1, 7000)`，初始位置约 `(0, 900, 1250)` 看向原点
- **画质自适应**：维护帧率 EMA；连续低于 40fps 时依次降级 → `setPixelRatio` 降档 → 关阴影 → 减粒子数量。
  恢复条件同理（滞回，避免抖动）。降级动作要打日志到 `TP.Scene._log` 供排查

---

## 3. `TP.CityBuilder` API

```js
TP.CityBuilder.build(cityData)            // cityData = TP.City.data；构建全部静态几何
TP.CityBuilder.group                      // THREE.Group
TP.CityBuilder.ready                      // boolean
TP.CityBuilder.pickables                  // 供 raycast 的对象数组（建筑/道路/地标）
TP.CityBuilder.roadMeshById(roadId)       // → 该道路所属的合并 Mesh（便于高亮）
TP.CityBuilder.setRegionHighlight(id)     // districtId 或 'all'：区域高亮 + 其他区域淡出
TP.CityBuilder.focusBounds(districtId)    // → { center:{x,z}, radius }，供 CameraRig.focusOn 用
TP.CityBuilder.setBuildingStyle(style)    // 'plain' | 'height' | 'type'
TP.CityBuilder.setBuildingsVisible(bool)
TP.CityBuilder.applyTheme()               // 换肤后重刷材质色
TP.CityBuilder.dispose()
```

### 3.1 建筑（重点，视觉主体）
- **必须用 `THREE.InstancedMesh`**（1500~2600 个建筑，绝不能一个建筑一个 Mesh）
- 按 `type` 分 4~5 组 InstancedMesh（res / office / mall / industrial / landmark），每组一个材质
- **明暗面处理**：给 `BoxGeometry` 写入**逐面顶点色** —— 顶面最亮、两个侧面中等、背光面最暗。
  再配合 `InstancedMesh.setColorAt()` 给每个实例一个色相。
  这样即使无光照也有清晰体块感，符合浅色政务风（白模建筑）的观感
- 颜色基调：`--bld-top`（近白）/ `--bld-side` / `--bld-side-dark`；`--bld-hi` 用于地标
- 建筑 `castShadow = true`、`receiveShadow = true`
- `setRegionHighlight` 时：非目标区域建筑的实例色向 `--stage-ground` 混合并降低不透明度感（改 instanceColor 即可）

### 3.2 路网（重点，数据承载面）
- 每条 `road.path` 生成**带状几何**（把折线按左右偏移扩成三角带），宽度按等级：
  `expressway 9` / `arterial 6.5` / `secondary 4.5` / `branch 3`（世界单位）
- **性能关键**：不要 260 个 Mesh。**按等级分 4 组合并成 4 个 `BufferGeometry`**，
  逐段顶点色即路况色 → **4 个 draw call 搞定整个路网**
- 必须维护 `roadVertexRange[roadId] = { start, count }`，使得更新某条路的路况色时能精确定位顶点区间（`geometry.attributes.color` 局部更新 + `needsUpdate`）
- 材质：`MeshBasicMaterial({ vertexColors: true, transparent: false })`（浅色风不需要光照计算，颜色即语义）
- 道路下方再画一层稍宽的 `--road-casing` 描边带（同样合并），让路网在浅色地面上"立"起来
- 交叉口：`InstancedMesh` 小圆盘铺在节点处，消除带状路口的缺口

### 3.3 水系 / 绿地 / 行政区
- 水系：河流用带状 Mesh（`--c-primary` 极浅的蓝），湖泊用 `ShapeGeometry`；轻微下沉 y=-0.4
- 绿地：`ShapeGeometry`，浅绿，y=0.2
- 行政区边界：`LineLoop` + 虚线材质，`--c-border-strong`；hover 时该区边界高亮加粗
- 地名标签：为 6 个行政区中心各加一个 HTML 标签（`TP.Scene.addLabel`），class `bld-label bld-label--district`

---

## 4. `TP.CameraRig` API —— 本项目核心

```js
TP.CameraRig.init(camera, domElement)     // domElement = #canvas-host
TP.CameraRig.update(dt)                   // 每帧
TP.CameraRig.mode                         // 'orbit' | 'top' | 'bird' | 'cruise'
TP.CameraRig.setMode(mode, opts)          // 平滑切换；动画期间锁交互；完成后触发 onModeChange
TP.CameraRig.onModeChange(fn)             // fn(mode, prevMode)
TP.CameraRig.target                       // THREE.Vector3，观察点（TP.Scene 用它做阴影跟随）
TP.CameraRig.focusOn(x, z, opts)          // 平滑聚焦到某点 + 可选缩放半径；opts={radius, dur, pitch}
TP.CameraRig.reset()                      // 复位到该模式默认机位
TP.CameraRig.heading                      // 弧度，给指北针
TP.CameraRig.pitch                        // 弧度（0=水平, π/2=垂直向下）
TP.CameraRig.distance                     // 相机到 target 距离
TP.CameraRig.setBounds(minX,maxX,minZ,maxZ)  // 限制 target 平移范围
TP.CameraRig.setCruisePath(points)        // [{x,z}]，巡航路线
TP.CameraRig.setCruiseSpeed(v)            // 世界单位/秒
TP.CameraRig.pause() / resume()
TP.CameraRig.enabled                      // 只读；过渡动画期间为 false
TP.CameraRig.onPick(fn)                   // fn({ x, z, hit }) —— 只有"点击"而非拖拽才触发
TP.CameraRig.onHover(fn)                  // fn({ x, z, hit, px, py })
TP.CameraRig.dispose()
```

### 4.1 四种模式（必须都实现，且**转换要有电影感的平滑过渡**）

| mode | 名称 | 行为 |
|---|---|---|
| `orbit` | 自由环绕 | 左键拖拽绕 target 旋转（球坐标）、滚轮缩放、右键/中键平移。俯仰限 `8° ~ 88°`。带阻尼惯性 |
| `top` | 俯视平面 | 相机在 target 正上方垂直向下（pitch ≈ 90°）。可滚轮缩放、拖拽平移。**此模式下建筑应自动降为低不透明度或平面色**（通过 `TP.CityBuilder` 提供的方法），读图更像路网平面图 |
| `bird` | 斜 45°鸟瞰 | pitch 锁定 45°（允许 ±5° 微调），可绕 Y 轴旋转与缩放。政务汇报最常用机位 |
| `cruise` | 巡航飞行 | 沿 `cruisePath` 自动飞行，机位在该点斜后方上方，带轻微上下浮动与视线前瞻。可切换路线（关键走廊）、可暂停 |

**转换实现要求**：
- 一律在**球坐标空间插值**（radius / theta / phi / target 分别缓动），不要直接 lerp 笛卡尔坐标 —— 否则会穿过地面或剧烈抖动
- 时长 `900~1300ms`，缓动 `inOutCubic`（`TP.Util.ease.inOutCubic`），用 `TP.Util.tween` 驱动
- 过渡期间 `enabled = false`，屏蔽用户输入；过渡结束恢复
- `mode='top'` 时 phi 逼近 90° 会有万向锁，需把 phi 限制在 `89.2°` 以内

### 4.2 交互细节
- 区分**点击**与**拖拽**：mousedown→mouseup 位移 < 5px 且时长 < 350ms 才算点击 → 触发 `onPick`
- hover 节流（≥60ms）后触发 `onHover`，用于 tooltip
- 滚轮缩放范围 `120 ~ 2600`（世界单位），并对数感缩放（每格 ×0.9 / ÷0.9）
- 触摸：单指旋转、双指缩放（能支持就支持）
- **指北针同步**：每帧把 `heading` 写成角度写入 `#nav-compass > svg#compass-needle` 的 `style.transform = 'rotate(Xdeg)'`，
  把 `pitch` 的角度写入 `#compass-pitch` 的 `textContent`（形如 `45°`）。这是唯一允许 3D 层触碰的 UI 元素

---

## 5. `TP.Layers` API

```js
TP.Layers.init(cityData, sim)        // sim = TP.Sim
TP.Layers.group                      // THREE.Group
TP.Layers.LAYERS                     // 静态元数据数组，见下
TP.Layers.setVisible(id, on)
TP.Layers.isVisible(id)
TP.Layers.update(dt)                 // 每帧：粒子推进、动画
TP.Layers.applyTime()                // TP.Sim.setTime() 之后必须调用一次，立即重刷所有按时变的图层
TP.Layers.applyTheme()
TP.Layers.pickables                  // raycast 用（事件光柱、站点、停车场、单车点等）
TP.Layers.setRegionFilter(fn|null)   // fn(item) → bool，省份/行政区筛选；null = 不过滤
TP.Layers.highlight(id, kind)        // 高亮某个实体（如选中路段 / 事件），null 取消
```

### 5.1 图层清单（**id 与名称不可改**）
| id | 名称 | 说明 |
|---|---|---|
| `traffic` | 实时路况 | 按 `roadStates[].level` 给路网顶点着色（默认开） |
| `vehicle` | 车流粒子 | InstancedMesh 小方块沿道路移动，数量 ∝ `flow`，速度 ∝ `speed`，颜色取路况色 |
| `heat` | 拥堵热力 | 地面热力贴图/斑块，密度 ∝ 拥堵度与事件（默认开） |
| `incident` | 事件告警 | 光柱 + 地面扩散波纹 + 图标标签（默认开） |
| `metro` | 地铁线网 | TubeGeometry，抬高 y≈4，站点小圆柱，换乘站更大 |
| `bus` | 公交线网 | 细线 y≈2.5 + 站点小点 |
| `od` | OD 飞线 | 拱形曲线 + 沿线流动的光点，粗细/透明度 ∝ 流量 |
| `signal` | 信号配时 | 有信号路口的小环，颜色随 `signalStates[].phase` 变化 |
| `parking` | 停车场 | 小方柱，高度 ∝ occupancy，颜色按 status |
| `bike` | 共享单车 | 小圆点 InstancedMesh，颜色/大小 ∝ 可用量 |
| `carbon` | 碳排热点 | 地面圆形渐变斑块，`--heat-*` 色带映射 |
| `district` | 行政区边界 | 由 CityBuilder 提供，Layers 负责开关 |

**默认开启**：`traffic`、`heat`、`incident`、`district`；其余默认关。

`TP.Layers.LAYERS` 元素格式（供 UI 生成开关列表）：
```js
{ id:'traffic', name:'实时路况', icon:'<svg…>', defaultOn:true, count:function(){ return 1284; } }
```
`count()` 返回该项的实时数量（如"1,284 条路段"），**不要返回 undefined**。

### 5.2 性能预算（硬指标）
| 指标 | 上限 |
|---|---|
| 总 draw call | < 200 |
| 三角面 | < 150 万 |
| 车流粒子 | ≤ 3000（实例化，1 个 draw call） |
| 1920×1080 帧率 | **≥ 50 fps** |
| `applyTime()` 单次耗时 | < 12ms |

必须用 `InstancedMesh` / 合并几何实现粒子与线网，禁止循环 `new THREE.Mesh()`。

### 5.3 交互
- `onHover` → 高亮命中道路（顶点色提亮或叠加一层描边）+ 通过回调让 app 显示 tooltip
- `onPick` → 命中道路 / 站点 / 停车场 / 事件 时，通过 `TP.Layers` 暴露的 `resolveHit(object, instanceId, point)` 返回结构化信息：
  ```js
  { kind:'road'|'intersection'|'station'|'parking'|'bike'|'incident'|'hub', id:'R0001', roadId?, districtId?, name:'中山大道' }
  ```
  这个对象会被交给 `TP.Api.pickInfo()` 换取抽屉数据（见 DATA 契约）

---

## 6. 数据读取约定

- ❌ 3D 层**不得**自己造业务数据，不得用 `Math.random()` 生成数值（粒子初始相位除外，且必须用 `TP.Util.Rng` 保证确定性）
- ✅ 一律读 `TP.Sim`：`roadStates`（键 = `road.id`）、`districtStats`、`incidents`、`transitState`、`odFlows`、`signalStates`、`parkingState`、`bikeState`、`carbon`、`kpi`
- ✅ 静态几何读 `TP.City.data`
- ✅ 推荐调用顺序：
  ```js
  TP.City.build(); TP.Sim.init(TP.City.data);
  TP.Scene.init(document.getElementById('canvas-host'));
  TP.CityBuilder.build(TP.City.data);
  TP.CameraRig.init(TP.Scene.camera, document.getElementById('canvas-host'));
  TP.Layers.init(TP.City.data, TP.Sim);
  TP.CameraRig.setMode('bird');
  // 主循环
  function frame(t){ var dt = ...; TP.Sim.setTime(minute); TP.Layers.applyTime(); TP.Layers.update(dt); TP.CameraRig.update(dt); TP.Scene.update(dt); TP.Scene.render(); }
  ```
- ⚠️ `TP.Scene.update()` 必须在 `TP.CameraRig.update()` **之后**调用（阴影跟随 + 标签投影依赖最新相机矩阵）
- ⚠️ `TP.Layers.applyTime()` 只在 `TP.Sim.setTime()` 之后调用，不要每帧都调（`setTime` 内部有缓存判断）

---

## 7. 自测（必做，结果写进 `docs/3D-NOTES.md`）

用 PowerShell 起一个本地静态服务（`python -m http.server 8899` 或 Node 等价物）后打开页面实测：
- [ ] 四种视角模式均可用，切换过渡平滑无穿地/无抖动
- [ ] `orbit` 拖拽旋转滚轮缩放右键平移都正常，有阻尼
- [ ] `top` 模式俯视观感像平面路网图，建筑弱化
- [ ] `cruise` 沿走廊飞行流畅，可暂停/恢复/换线
- [ ] 指北针与俯仰角随视角实时更新
- [ ] 路网颜色随 `TP.Sim.setTime()` 变化（拖时间轴能明显看到早晚高峰变红）
- [ ] 12 个图层逐个开关正常，无残留、无报错
- [ ] hover 有高亮，click 能通过 `onPick` 回调吐出正确的路段 id
- [ ] `fps` 实测 ≥ 50（把实测数字写进 3D-NOTES，含 draw call 与三角面数）
- [ ] 控制台**零 error**（warning 需说明原因）
- [ ] 窗口从 1920×1080 缩到 1280×720 再放大，画面不变形不糊

---

## 8. 最终回复格式（600 字以内）
1. 写入文件列表及行数
2. 四种视角模式的实现要点（尤其是过渡怎么做的）
3. 性能实测：fps / draw call / 三角面 / `applyTime()` 耗时
4. 自测清单逐条结果
5. 已知不足
