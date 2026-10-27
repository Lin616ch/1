# 数据契约 v1 —— 城市静态模型 + 交通模拟引擎

> **归属**：本文件描述两个纯数据模块，由「数据代理」实现。
> **调用方**：3D 渲染 / 图表 / UI 由主 Agent 实现，严格按本契约调用。
> **原则**：这两个模块**纯数据、零渲染、零 DOM**。不得 import/使用 THREE、不得 `document.querySelector`。
> 共享工具：`js/utils.js` 已存在，通过 `TP.Util` 使用（`TP.Util.Rng` / `clamp` / `lerp` / `ease` / `polylineLength` / `pointAlongPolyline` / `dist` / `pointInPolygon` / `polygonCentroid` / `congestionLevel` …）。
> 语言：全部用 ES5 语法的 IIFE 挂到 `window.TP`，**不得使用 ES Module**（必须支持 `file://` 双击打开）。

---

## 0. 文件与命名空间

| 文件 | 命名空间 |
|---|---|
| `js/data/city-model.js` | `TP.City` |
| `js/data/sim-engine.js` | `TP.Sim` |

两者都是 IIFE：`(function(window){ 'use strict'; var TP = window.TP = window.TP || {}; ... })(window);`

---

## 1. 世界坐标系（两个模块必须一致）

- Three.js 右手系，**Y 轴朝上**，城市铺在 **XZ 平面**上。
- 城市范围：`X ∈ [-1000, 1000]`，`Z ∈ [-1000, 1000]`（世界单位）。
- 换算：**1 世界单位 = 5 米**。故城市直径 2000 单位 = 10 km。
- 长度字段（`lengthM` 等）统一用**米**；坐标字段用**世界单位**。
- `(x=0, z=0)` 为市中心。Z 负方向为北。

---

## 2. `TP.City` 静态城市模型

### 2.1 入口
```js
TP.City.build(options)   // 幂等：重复调用返回同一结果
TP.City.data             // 生成后的完整模型对象（build 之后）
```
`options`（全部可选，需有默认值）：
```js
{ seed: 20240815, name: '云澜市', extent: 1000 }
```

### 2.2 返回结构（字段名不可改）
```js
{
  meta: {
    name: '云澜市',
    extent: 1000,          // 半边长（世界单位）
    unitMeters: 5,         // 1 世界单位 = 5 米
    seed: 20240815,
    districts: 6,
    roadCount: <int>, buildingCount: <int>,
    roadKm: <number>,      // 路网总里程（公里，1 位小数）
    population: <number>,  // 常住人口（万人，1 位小数）
    areaKm2: <number>      // 市域面积
  },

  // ---- 行政区（6 个）----
  districts: [{
    id: 'core',            // 稳定英文 id
    name: '中心城区',
    color: '#1a5fb4',      // 用于区域高亮，需彼此可区分
    center: { x: 0, z: 0 },
    polygon: [[x,z], ...], // 闭合凸/凹多边形，覆盖该区，6 个区并集需大致覆盖全城
    areaKm2: 128.5,
    population: 86.2,      // 万人
    jobs: 52.4,            // 万岗位
    roadKm: 486.2,
    vehicleStock: 12.4,    // 万辆车
    weight: 0.31           // 该区在全城交通量中的权重，6 个区之和 = 1
  }, ...],

  // ---- 路网：边 ----
  roads: [{
    id: 'R0001',
    name: '中山大道',       // 需是人话，主干道要有名字
    cls: 'expressway',     // 'expressway' 快速路 | 'arterial' 主干路 | 'secondary' 次干路 | 'branch' 支路
    path: [{x,z}, ...],    // 折线，≥2 点，相邻点间距 8~40 单位
    lengthM: 1240,         // 实际长度（米）
    lanes: 6,              // 车道数
    speedLimit: 80,        // 限速 km/h
    capacity: 5400,        // 通行能力 辆/h（双向）
    districtId: 'core',
    from: 'N012', to: 'N088',   // 起终点节点 id
    oneway: false,
    corridorId: 'C01',      // 所属关键走廊；支路可为 null

    /* ---- 结构类型与桥面标高（世界单位）—— 现实感的关键 ---- */
    structure: 'viaduct',   // 'surface' 地面 | 'viaduct' 高架 | 'bridge' 跨河桥 | 'tunnel' 隧道
    elevW: 2.6,             // 路面相对地面的抬高量（世界单位）；surface 为 0
                            // 换算：2.6 世界单位 = 13 米（典型城市高架桥面高度）
    piers: true             // 是否需要画桥墩/立柱（高架与桥梁为 true）
  }, ...],

  // ---- 路网：节点（路口）----
  intersections: [{
    id: 'N012', x: 120.5, z: -340.2,
    degree: 4,                 // 相连道路数
    roadIds: ['R0001','R0007', ...],
    districtId: 'core',
    signalId: 'S0031',         // 无信号路口为 null（立交与高架层一律为 null）
    gradeSeparated: false,     // 是否为立交（快速路与地面道路在此相交/跨线）
    deck: 'surface',           // 'surface' 地面层 | 'viaduct' 高架层 | 'interchange' 互通立交（两层连通）
    lat: null, lng: null       // 可选，无则 null
  }, ...],
  // ⚠️ 立交处会生成**同坐标的两个节点**：
  //    地面层节点（deck='surface'）挂地面道路；高架层节点（deck='viaduct'）挂快速路。
  //    3D 层渲染高架节点上的路口圆盘时，要抬到 viaduct 高度。
  //    互通立交（deck='interchange'）不拆分，两层连通，可以画成匝道。

  // ---- 邻接图（供流量传播/寻路使用）----
  graph: {
    nodes: { 'N012': { x: 120.5, z: -340.2, roads: ['R0001', ...] }, ... },
    // 无向邻接（oneway 道路只保留 from→to 方向）
    adjacency: { 'N012': [{ roadId: 'R0001', to: 'N088', lengthM: 1240 }, ...], ... }
  },

  // ---- 建筑体块 ----
  buildings: [{
    x: 12.5, z: -30.0,
    w: 18, d: 24, h: 36,       // 世界单位；h 为高度
    rot: 0.12,                 // 绕 Y 轴弧度
    type: 'office',            // 'res' 住宅 | 'office' 办公 | 'mall' 商业 | 'industrial' 工业 | 'landmark' 地标
    districtId: 'core',
    name: ''                   // 仅 landmark 有，如 '云澜国际中心'
  }, ...],                     // 数量 1500 ~ 2600

  // ---- 水系 / 绿地（可选但强烈建议，浅色主题下很出效果）----
  waterways: [{ name: '澜江', kind: 'river', path: [{x,z},...], width: 46 }, ...],
  greenlands: [{ name: '中央公园', polygon: [[x,z],...] }, ...],

  // ---- 公共交通 ----
  transit: {
    metroLines: [{
      id: 'M1', name: '地铁1号线', color: '#c0392b',
      path: [{x,z}, ...],                    // 线路走向
      stations: [{ id:'M1S01', name:'市民中心', x:0, z:0, interchange: true, lineIds:['M1','M2'] }, ...],
      lengthKm: 28.4, dailyRidership: 42.6   // 万人次/日
    }, ...],                                  // 5 条
    busLines: [{
      id: 'B01', name: '公交1路', color: '#2b8a3e',
      path: [{x,z}, ...],
      stops: [{ id:'B01S01', name:'…', x:0, z:0 }, ...],
      lengthKm: 18.2, headway: 6,             // 发车间隔（分钟）
      dailyRidership: 1.8                     // 万人次/日
    }, ...]                                   // 10 ~ 14 条
  },

  // ---- 静态设施 ----
  facilities: {
    parking:   [{ id:'P01', name:'市民中心地下停车场', x:0, z:0, capacity:820, type:'underground', districtId:'core' }, ...],  // 18~26 个
    bike:      [{ id:'K01', name:'地铁1号线市民中心站B口', x:0, z:0, capacity:60, districtId:'core' }, ...],                    // 36~50 个
    hubs:      [{ id:'H01', name:'云澜站', x:0, z:0, kind:'rail', districtId:'core' }, ...]                                      // 6~9 个
  },

  // ---- 信号控制（只给有信号的路口）----
  signals: [{
    id: 'S0031', intersectionId: 'N012', x: 0, z: 0,
    cycle: 140,                     // 周期秒
    offsetsByPhase: null,
    approaches: [                   // 2~4 个进口道
      { dir: 'N', green: 38, yellow: 3, red: 99, leftTurnRatio: 0.22 },
      ...
    ],
    coordGroup: 'CG03'              // 协调控制子区，同组可做绿波
  }, ...],

  // ---- 关键走廊（用于排行榜 / 绿波带演示）----
  corridors: [{
    id: 'C01', name: '中山大道走廊',
    roadIds: ['R0001','R0002', ...],   // 首尾相接，顺序正确
    path: [{x,z}, ...],                // 整条走廊折线
    lengthKm: 12.4,
    districtIds: ['core','east'],
    signalIds: ['S0031', ...],         // 沿走廊顺序排列的信号
    recommendedSpeed: 45               // 绿波推荐车速 km/h
  }, ...]                              // 6~10 条
}
```

### 2.3 生成质量要求
1. **路网要像真实城市**：至少包含 —— 一个内环 + 一个外环、`南—北`与`东—西`各 2~3 条贯穿主干路、若干放射状干道、每个行政区内部的方格网。道路不能穿河、不能互相交叉成 X 型而不设节点。
2. **每个 `intersections` 节点必须有 ≥2 条道路相连**；道路端点必须是节点 id。
3. **建筑不能压在道路上**：需用 `Util.distToPolyline` 做碰撞剔除（离任一路面中心线距离 < 8 + 自身半宽 则丢弃）。
4. **建筑高度呈中心高、外围低的分布**，中心城区与高新园区高，空港/城南低；`landmark` 每个区至多 1~2 个。
5. **`roads` 数量 2500 ~ 3500**（`roads[]` 是**路段**，即相邻交叉口之间的一段，不是"整条命名道路"；
   同一条命名道路会拆成多条 `roads` 条目并共享同一个 `name`）。`intersections` 约 1800 个，
   `signals` 约 380 个，`buildings` 1800 ~ 2800。为性能，`buildings` 会被 3D 层用 InstancedMesh 渲染。
   `meta.roadKm` 约 400 ~ 600 km（对应 5 ~ 7 km/km² 的真实路网密度）。
   消费方**不得**对路段数量做硬编码假设。
6. **确定性**：同 seed 必然同结果。整个过程只用 `TP.Util.Rng`，不得使用 `Math.random()`。
7. **性能**：`build()` 全流程耗时须 < 400ms（1920 尺寸机器）。若超，减少建筑数而不是降低路网质量。
8. 名字要有中文真实感，不要把「道路1、道路2」这种编号直接当名字。

### 2.4 辅助方法（必须提供）
```js
TP.City.districtOf(x, z)            // → districtId | null，用 pointInPolygon 判定
TP.City.nearestRoad(x, z, maxDist)  // → { road, t, point:{x,z}, dist } | null
TP.City.roadById(id)                // → road | null（内部建 Map 加速）
TP.City.districtById(id)            // → district | null
TP.City.intersectionById(id)        // → intersection | null
TP.City.signalById(id)              // → signal | null
TP.City.corridorById(id)            // → corridor | null
```

---

## 3. `TP.Sim` 交通模拟引擎

### 3.1 设计原则（关键）
- **纯数据、纯函数式取值**：`setTime(minute)` 之后，所有 `*State` 都应是**只读派生结果**，在**同一 minute 下重复调用结果完全一致**（时间轴来回擦洗必须稳定，不能有累积状态）。
- 因此**禁止**用「每帧累加」的方式产生路况。路况必须是 `f(路段固有属性, 时刻, 噪声种子)` 的**闭式函数**。
- 实时刷新感由调用方对**预测/事件/浮动车**做插值实现，不由引擎内部累积。
- 内部需有缓存（同 minute 重复 setTime 直接返回缓存）。

### 3.2 入口
```js
TP.Sim.init(city, options)   // city = TP.City.data；options 可选
TP.Sim.city                  // 保存的引用
TP.Sim.setTime(minute)       // 0..1439，返回 this；越界自动 wrap
TP.Sim.minute                // 当前分钟
```
`options`：`{ seed: 970531 }`

### 3.3 数据字段（**全部为 getter 属性，setTime 后即时可读**）

```js
// ---- 全局 KPI ----
TP.Sim.kpi = {
  avgSpeed: 28.6,            // km/h 全市路网平均速度
  congestionIndex: 4.8,      // 0~10 拥堵指数（政务口径，>6 为拥堵）
  inNetVehicles: 184320,     // 在网车辆（辆）
  totalFlow: 428600,         // 当日累计车流（辆）
  flowRate: 12840,           // 当前小时流量（辆/h）
  incidentCount: 12,         // 进行中事件数
  transitRidership: 386.2,   // 公共交通实时客流（万人次/日累计）
  transitShare: 46.8,        // 公共交通分担率 %
  parkingOccupancy: 78.4,    // 停车位占用率 %
  parkingAvailable: 24580,   // 剩余泊位
  bikeRides: 12840,          // 共享单车当日骑行次数
  bikeTurnover: 3.2,         // 单车周转率
  carbonToday: 8420.6,       // 当日交通碳排放（吨 CO2）
  carbonSaved: 1268.4,       // 绿色出行减排（吨）
  greenShare: 62.4,          // 绿色出行占比 %
  onTimeRate: 92.6,          // 公交准点率 %
  signalCount: 386,          // 联网信号路口数
  greenWaveCount: 7,         // 在运行的绿波带数量
  avgDelay: 32.4,            // 平均延误（秒/车）
  avgQueue: 6.8,             // 平均排队长度（辆）
  emergencyResp: 4.6         // 平均应急响应（分钟）
};

// ---- 路段状态（键 = road.id）----
TP.Sim.roadStates = {
  'R0001': {
    roadId: 'R0001',
    speed: 42.3,             // km/h 实际车速
    speedRatio: 0.61,        // 实际/限速，0..1
    level: 1,                // 0 畅通 1 缓行 2 拥堵 3 严重拥堵
    levelKey: 'slow',
    congestionIndex: 2.35,   // 单条路段的拥堵指数 0~10（走廊/路段排行与详情用）
    flow: 3820,              // 辆/h
    satRatio: 0.71,          // 流量/通行能力，0..1.2
    occupancy: 0.42,         // 车道占有率 0..1
    queueLen: 12.4,          // 排队长度（米）
    delay: 28.4,             // 车均延误（秒）
    travelTime: 116,         // 通过该路段耗时（秒）
    freeTravelTime: 56,      // 自由流耗时（秒）
    vehicles: 46             // 该路段当前车辆数（供粒子层配额）
  }, ...
};

// ---- 行政区统计（键 = district.id）----
TP.Sim.districtStats = {
  core: { districtId:'core', avgSpeed:22.4, congestionIndex:6.8, flow:126800,
          inNetVehicles:58200, saturation:0.82, incidents:4, transitRidership:186.4,
          parkingOccupancy:88.2, carbon:2840.5 },
  ...
};

// ---- 实时事件 ----
TP.Sim.incidents = [{
  id: 'E0001', type: 'accident',   // 'accident' 事故 | 'congestion' 拥堵 | 'construction' 施工
                                    // | 'weather' 恶劣天气 | 'control' 管制 | 'violation' 违停
  title: '中山大道两车追尾',
  x: 120.4, z: -340.2, roadId: 'R0001', districtId: 'core',
  severity: 2,                      // 1 一般 2 较重 3 严重
  since: 512,                       // 发生的分钟(0..1439)
  duration: 45,                     // 预计持续分钟
  status: 'active',                 // 'active' 处置中 | 'cleared' 已解除
  impactKm: 1.8,                    // 影响范围半径（公里）
  responders: 3,                    // 已派警力
  vehiclesAffected: 420
}, ...]                             // 同一时刻 6 ~ 20 条，其中 status='cleared' 的可有若干条

// ---- 公共交通线路实时 ----
TP.Sim.transitState = {
  'M1': { lineId:'M1', kind:'metro', ridership: 42.6, load: 0.82, crowding: 'busy',
          headwayActual: 2.8, onTimeRate: 96.2, speed: 34.5, delayMin: 0.6 },
  'B01': { lineId:'B01', kind:'bus', ridership: 1.8, load: 0.64, crowding: 'normal',
           headwayActual: 6.4, onTimeRate: 88.5, speed: 18.2, delayMin: 2.1 },
  ...
};
// crowding: 'empty' | 'normal' | 'busy' | 'crowded'

// ---- OD 出行（区→区）----
TP.Sim.odFlows = [{
  fromId:'core', toId:'hitech', from:{x:0,z:0}, to:{x:400,z:-200},
  volume: 12840,                   // 辆/日
  volumeNow: 420,                  // 当前小时
  path: [{x,z}, ...],              // 一条**沿真实路网**的合理路径（可简化为若干节点连线）
  distanceKm: 14.2, avgTime: 28.4
}, ...]                            // 6×5=30 条（不含自身），只输出 volume>0 的

// ---- 信号实时状态 ----
TP.Sim.signalStates = {
  'S0031': { signalId:'S0031', cycle:140, elapsed: 62, phaseIndex: 0,
             phaseName:'南北直行', remain: 18, phase: 'green',   // 'green'|'yellow'|'red'
             splits:[38,3,99], queueLen: 8.2, saturation: 0.78,
             coordGroup:'CG03', adapted: true }
};

// ---- 停车 & 单车 ----
TP.Sim.parkingState = { 'P01': { id:'P01', occupancy: 0.86, available: 115, status:'busy' } };
// status: 'idle' | 'normal' | 'busy' | 'full'
TP.Sim.bikeState = { 'K01': { id:'K01', available: 12, occupancy: 0.80, status:'busy' } };

// ---- 碳排放 ----
TP.Sim.carbon = {
  total: 8420.6,                        // 当日累计（吨）
  saved: 1268.4,
  perMode: [                            // 各方式碳排放占比（%）
    { mode:'private', name:'小汽车', ratio: 58.4, value: 4918.2 },
    { mode:'bus',     name:'常规公交', ratio: 9.2,  value: 774.7 },
    { mode:'metro',   name:'轨道交通', ratio: 4.6,  value: 387.3 },
    { mode:'taxi',    name:'出租车/网约', ratio: 14.8, value: 1246.2 },
    { mode:'truck',   name:'货运车辆', ratio: 11.4, value: 959.9 },
    { mode:'bike',    name:'慢行交通', ratio: 1.6,  value: 134.3 }
  ],
  greenModes: [                         // 绿色出行看板
    { mode:'metro', name:'轨道交通', trips: 386.2, carbonSavedPerTrip: 0.42, saved: 162.2 },
    { mode:'bus',   name:'常规公交', trips: 268.4, carbonSavedPerTrip: 0.28, saved: 75.2 },
    { mode:'bike',  name:'共享单车', trips: 128.4, carbonSavedPerTrip: 0.12, saved: 15.4 }
  ]
};

// ---- 时间序列（固定 288 个 5 分钟桶；供 24h 曲线与时间轴热力条）----
TP.Sim.series = {
  minutes: [0, 5, 10, ..., 1435],              // 长度 288
  congestionIndex: [ ...288 个 number ],
  avgSpeed:        [ ...288 ],
  flow:            [ ...288 ],   // 辆/h
  transitRidership:[ ...288 ],   // 万人次/h
  carbon:          [ ...288 ],   // 吨/h
  incidents:       [ ...288 ]    // 事件数
};
TP.Sim.seriesAt(metric)          // → { minutes:[], values:[] }，metric 为上面除 minutes 外的键

// ---- 短时预测（未来 60 分钟，5 分钟粒度）----
TP.Sim.forecast(metric, horizonMin)
// → { metric, now: <值>, points: [{ minute, v, lo, hi }], trend: 'up'|'down'|'flat', peakMinute, peakValue }
//   lo/hi 为置信区间下/上界（用于面积图的置信带）
```

### 3.4 必须体现的交通规律（评审会看这个）
1. **早晚高峰双峰**：早高峰 07:30–09:00 峰值、晚高峰 17:00–19:00 峰值（晚高峰略高、更宽），午间 11:30–13:00 一个小凸起，凌晨 01:00–05:00 为谷底。
2. **潮汐性**：早高峰进城方向（外围 → 中心）拥堵、出城畅通；晚高峰反向。`roadStates` 需体现，可由方向与中心距离决定。
3. **周末不同**：周六日无早晚高峰，改为 10:00–20:00 单峰。可由 `setTime(dayOfWeek, minute)` 或 `options.dayType` 控制（提供一个 `TP.Sim.setDay(type)`，type: `'weekday'|'weekend'`）。
4. **快速路比支路更快**、主干路流量更大；流量与限速、车道数正相关。
5. **事件会局部降速**：事件所在路段及其邻接路段 `speedRatio` 明显下降、`queueLen` 上升。
6. **地铁客流早高峰最大**，公交准点率在高峰下降。
7. **绿波带**：同一 `coordGroup` 内信号的 `elapsed` 需按**相位差**错开，使车队以 `recommendedSpeed` 行驶能连续遇绿。`TP.Sim.greenWave(groupId)` 返回：
   ```js
   { groupId, corridorId, recommendedSpeed: 45, bandwidth: 22, efficiency: 0.78,
     stops: [{ signalId, x, z, offsetSec, phase, remain, greenRatio }] }
   ```

### 3.5 性能要求
- `setTime()` 单次耗时 **< 8ms**（260 条路段 + 30 条 OD + 信号）。
- 内部对 `roadStates` 用**对象复用**（不要每次 setTime 都 new 260 个对象），降低 GC 压力。
- 相邻 minute 复用：若 `|minute - lastMinute| <= 3` 且只做小幅刷新，可增量更新而非全量重算。

### 3.6 自测要求（交付前必须做）
写一个临时自测（可用 node 跑，或做一个 `docs/selftest.html` 临时页面，**验收后删除**），确认：
- [ ] `TP.City.build()` 在 400ms 内完成，`roads.length` 与 `buildings.length` 在约定区间
- [ ] 每条 `road.path` 的点都在 `[-1000,1000]` 内；`from/to` 都能在 `graph.nodes` 里找到
- [ ] 没有建筑与道路冲突（抽样 200 个建筑校验）
- [ ] `setTime(480)` 与 `setTime(0)` 的 `avgSpeed` 有显著差异（高峰更慢），且 `setTime(480)` 连续调用两次结果完全相同
- [ ] `series.congestionIndex` 呈双峰形态
- [ ] `odFlows.length` 合理（>20），每条的 `from/to` 都是有效行政区
- [ ] `forecast` 返回 13 个点且 `lo <= v <= hi`
- [ ] 全文件 `grep -c "Math.random"` 结果为 0

---

## 4. 交付物
| 文件 | 说明 |
|---|---|
| `js/data/city-model.js` | `TP.City`，纯数据 |
| `js/data/sim-engine.js` | `TP.Sim`，纯数据 |
| `docs/DATA-NOTES.md` | 简要说明：生成算法、主要调参项、已知简化、性能实测数字 |

## 5. 禁止事项
- ❌ 不得使用 ES Module / `import` / `export`
- ❌ 不得引用任何外部库、CDN、网络资源（`file://` 必须能跑）
- ❌ 不得使用 `Math.random()`（必须确定性）
- ❌ 不得操作 DOM（除自测页），不得依赖 THREE
- ❌ 不得修改 `js/utils.js`、`docs/UI-CONTRACT.md`、`docs/DATA-CONTRACT.md`
- ❌ 不得创建 `index.html`、`css/*`、`js/` 下除上述两个文件以外的任何文件
