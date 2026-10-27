/* ============================================================================
 * sim-engine.js —— 交通模拟引擎（纯数据，零渲染，零 DOM）
 * 命名空间：TP.Sim
 * 依赖：TP.Util、TP.City
 *
 * 设计要点：
 *   1. 路况是「闭式函数」f(路段固有属性, 时刻, 方向)，不是逐帧累加的状态机。
 *      因此同一 minute 反复 setTime 结果完全一致，时间轴可任意来回擦洗。
 *   2. roadStates / districtStats / signalStates 等对象在 init 时一次性创建，
 *      setTime 只改字段值，不再 new 对象（避免 GC 抖动）。
 *   3. 确定性：只用 TP.Util.Rng，绝不使用 Math.random()。
 * ==========================================================================*/
(function (window) {
  'use strict';

  var TP = window.TP = window.TP || {};
  var U = TP.Util;

  var MIN_PER_DAY = 1440;
  var BUCKET_MIN = 5;
  var NBUCKET = MIN_PER_DAY / BUCKET_MIN;      // 288
  var UNIT_M = 5;

  /* --- 城市级规模常量（口径在 DATA-NOTES 里说明） --- */
  var TOTAL_PERSON_TRIPS = 5280000;                       // 全市日出行总量（人次/日）
  var DAILY_VEHICLE_TRIPS = { weekday: 1650000, weekend: 1180000 };
  var PEAK_HOURLY_FLOW    = { weekday: 148000,  weekend: 96000 };
  var DAILY_CARBON        = { weekday: 8420.6,  weekend: 6280.4 };
  var DAILY_BIKE_RIDES    = { weekday: 320000,  weekend: 264000 };
  var BIKE_FLEET          = 100000;
  var WALK_TRIP_SHARE     = 0.18;                         // 步行占全方式出行比例
  var INCIDENT_POOL_SIZE  = 78;

  var CARBON_SAVED_PER_TRIP_KG = { metro: 0.42, bus: 0.28, bike: 0.12 };

  /* 公共交通运能口径：
     高峰小时客流约占全日客流的 9.5%，运营方按此配能，使高峰满载率落在 0.8~1.1，
     再用 capFactor 给各线路一点差异（有的线路就是更挤）。 */
  var PEAK_HOUR_SHARE = 0.095;
  var DESIGN_PEAK_LOAD = 0.92;
  var VEH_CAPACITY = { metro: 1440, bus: 70 };   // 单列 / 单车的定员（人）
  var MIN_VPH = { metro: 6, bus: 3 };            // 最小发车频率（班/h），避免平峰间隔离谱

  var INCIDENT_TYPES = {
    accident:     { name: '交通事故', desc: ['两车追尾', '车辆侧翻', '多车剐蹭', '货车抛锚', '电动车相撞'] },
    congestion:   { name: '交通拥堵', desc: ['车流积压', '路口溢出', '排队超限'] },
    construction: { name: '道路施工', desc: ['道路施工', '管线抢修', '路面养护'] },
    weather:      { name: '恶劣天气', desc: ['局部积水', '能见度低', '路面结冰'] },
    control:      { name: '交通管制', desc: ['临时管制', '大型活动保障', '警卫任务'] },
    violation:    { name: '违法停车', desc: ['违停占道', '占用公交专用道'] }
  };
  var INCIDENT_TYPE_KEYS = ['accident', 'accident', 'accident', 'congestion', 'congestion',
                            'construction', 'weather', 'control', 'violation'];
  var SEVERITY_NAME = ['', '一般', '较重', '严重'];

  /* ================================================================== *
   * 需求曲线（闭式）
   * ================================================================== */

  function gauss(m, c, s) { var x = (m - c) / s; return Math.exp(-0.5 * x * x); }

  function demandRaw(m, dayType) {
    if (dayType === 'weekend') {
      /* 周末为单峰，峰值刻意压在工作日双峰之下（需求总量也更低）。
         注意主峰与晚间肩峰在 17:00~18:00 会叠加，单看主峰中心会误判峰值偏低。 */
      return 0.180
        + 0.320 * gauss(m, 660, 90)      // 11:00 上午肩峰
        + 0.800 * gauss(m, 900, 165)     // 15:00 单主峰
        + 0.400 * gauss(m, 1170, 95);    // 19:30 晚间
    }
    return 0.095
      + 0.950 * gauss(m, 495, 55)        // 08:15 早高峰
      + 1.000 * gauss(m, 1080, 78)       // 18:00 晚高峰（更高更宽）
      + 0.620 * gauss(m, 735, 62)        // 12:15 午间小峰
      + 0.220 * gauss(m, 1260, 90);      // 21:00 夜间活动
  }

  /** 归一化需求强度，约 0.06 ~ 1.15 */
  function demand(m, dayType) {
    return U.clamp(demandRaw(m, dayType), 0.06, 1.16);
  }

  /** 潮汐系数：+1 = 早高峰（进城方向），-1 = 晚高峰（出城方向） */
  function tidal(m, dayType) {
    if (dayType === 'weekend') return 0;
    var am = 0.950 * gauss(m, 495, 62);
    var pm = 1.000 * gauss(m, 1080, 86);
    var s = am + pm;
    if (s < 1e-9) return 0;
    return (am - pm) / s;
  }

  /** 高峰/平峰/低谷的中文名 */
  function phaseName(m, dayType) {
    var d = demand(m, dayType);
    if (dayType === 'weekend') {
      if (d > 0.85) return '假日高峰';
      if (d > 0.55) return '假日平峰';
      if (d > 0.30) return '假日平峰';
      return '夜间低谷';
    }
    if (m >= 435 && m <= 570 && d > 0.85) return '早高峰';
    if (m >= 1020 && m <= 1170 && d > 0.85) return '晚高峰';
    if (m >= 690 && m <= 800) return '午间平峰';
    if (d < 0.25) return '夜间低谷';
    return '平峰运行';
  }

  /** 速度比 ← 饱和度（BPR 型阻抗函数） */
  function speedRatioFromSat(sat) {
    return 1 / (1 + 1.15 * Math.pow(sat, 4.2));
  }

  /** 拥堵指数 0~10（政务口径，>6 视为拥堵） */
  function congestionIndexFromRatio(ratio) {
    return U.clamp(12 * Math.pow(1 - U.clamp01(ratio), 1.1), 0.4, 10);
  }

  function crowdingOf(load) {
    if (load < 0.35) return 'empty';
    if (load < 0.72) return 'normal';
    if (load < 1.00) return 'busy';
    return 'crowded';
  }
  var CROWDING_CN = { empty: '舒适', normal: '正常', busy: '较挤', crowded: '拥挤' };

  /* ================================================================== *
   * 模块内部状态
   * ================================================================== */

  var S = {
    ready: false,
    city: null,
    seed: 970531,
    dayType: 'weekday',
    minute: 0,
    lastMinute: -1,

    roads: null,
    nRoads: 0,
    roadIndex: null,          // roadId → i
    /* 每路段的静态参数（init 时一次算好） */
    st: null,

    roadStates: null,
    districtStats: null,
    incidents: [],
    incidentPool: null,
    transitState: null,
    odFlows: [],
    signalStates: null,
    parkingState: null,
    bikeState: null,
    carbon: null,
    kpi: null,
    series: null,
    greenWaves: null,

    /* 累计量前缀和 */
    cum: null,
    freeSpeedAvg: 45,
    transitDaily: 0,
    bikeDaily: 0,
    rngSeed: 0
  };

  /* ================================================================== *
   * 初始化
   * ================================================================== */

  function init(city, options) {
    options = options || {};
    S.city = city || TP.City.data || TP.City.build();
    S.seed = options.seed == null ? 970531 : options.seed;
    var rng = U.Rng(S.seed);

    var cl = TP.City;
    var roads = S.city.roads;
    S.roads = roads;
    S.nRoads = roads.length;

    /* ---- 1. 路段索引 & 静态参数 ---- */
    S.roadIndex = {};
    var st = S.st = {
      /* 需求权重：决定该路段在给定需求下的饱和度 */
      w: new Float32Array(S.nRoads),
      /* 距市中心归一化距离 0(中心) ~ 1(边缘) */
      u: new Float32Array(S.nRoads),
      /* 相位（给微小时变扰动用） */
      ph: new Float32Array(S.nRoads),
      /* 自由流速度 */
      vf: new Float32Array(S.nRoads),
      len: new Float32Array(S.nRoads),
      cap: new Float32Array(S.nRoads),
      /* 潮汐方向性：+1 表示"走向市中心" */
      inbound: new Float32Array(S.nRoads),
      /* 去偏后的潮汐项（见 init 里的说明） */
      tidalRaw: new Float32Array(S.nRoads),
      tidalDev: new Float32Array(S.nRoads),
      districtIdx: new Int16Array(S.nRoads)
    };

    var dIdx = {};
    for (var di = 0; di < S.city.districts.length; di++) dIdx[S.city.districts[di].id] = di;

    var totalLen = 0, totalLenVf = 0;
    var classBonus = { expressway: 0.06, arterial: 0.22, secondary: 0.06, branch: -0.16 };
    var classBase = { expressway: 0.70, arterial: 0.74, secondary: 0.62, branch: 0.40 };

    for (var i = 0; i < S.nRoads; i++) {
      var r = roads[i];
      S.roadIndex[r.id] = i;
      var ax = r.path[0].x, az = r.path[0].z;
      var bx = r.path[r.path.length - 1].x, bz = r.path[r.path.length - 1].z;
      var mx = (ax + bx) * 0.5, mz = (az + bz) * 0.5;

      var du = U.dist(mx, mz, 0, 0) / 900;
      st.u[i] = U.clamp01(du);
      st.ph[i] = rng.range(0, Math.PI * 2);
      st.vf[i] = r.speedLimit;
      st.len[i] = r.lengthM;
      st.cap[i] = r.capacity;
      st.districtIdx[i] = dIdx[r.districtId] == null ? 0 : dIdx[r.districtId];

      var w = (classBase[r.cls] || 0.6) + (classBonus[r.cls] || 0) * 0
            + rng.range(-0.20, 0.20)
            + 0.26 * (1 - st.u[i]);
      st.w[i] = U.clamp(w, 0.18, 1.18);

      /* 潮汐方向：行进方向与"指向市中心"的夹角余弦 */
      var dx = bx - ax, dz = bz - az;
      var dl = Math.sqrt(dx * dx + dz * dz) || 1;
      var tox = -mx, toz = -mz;
      var tl = Math.sqrt(tox * tox + toz * toz) || 1;
      st.inbound[i] = (dx / dl) * (tox / tl) + (dz / dl) * (toz / tl);

      totalLen += r.lengthM;
      totalLenVf += r.lengthM * r.speedLimit;
    }
    S.freeSpeedAvg = totalLen > 0 ? totalLenVf / totalLen : 45;

    /* ---- 1.5 潮汐项去偏（重要） ----
       路段的几何朝向本身有系统性偏向：放射干道与区界道路都是"由内向外"生成的，
       网格道路各半，环路近似切向。直接拿 `inbound × 潮汐强度` 当潮汐项，
       会让早高峰（T=+1）多数路段饱和度被压低、晚高峰（T=-1）被抬高，
       产生"早高峰整体比晚高峰通畅得多"的伪现象（实测 08:10 全网指数 2.98 vs 18:00 4.78）。
       这里按里程加权把潮汐项的均值扣掉：每条路的进出城对比保留，
       但全网聚合不再被这个几何偏向污染。 */
    var meanTidalW = 0, sumLenW = 0;
    for (i = 0; i < S.nRoads; i++) {
      st.tidalRaw[i] = st.inbound[i] * (0.26 + 0.34 * (1 - st.u[i]));
      meanTidalW += st.tidalRaw[i] * st.len[i];
      sumLenW += st.len[i];
    }
    meanTidalW = sumLenW > 0 ? meanTidalW / sumLenW : 0;
    for (i = 0; i < S.nRoads; i++) st.tidalDev[i] = st.tidalRaw[i] - meanTidalW;
    S.tidalMeanBias = meanTidalW;

    /* ---- 2. roadStates 对象池 ---- */
    var rs = S.roadStates = {};
    for (i = 0; i < S.nRoads; i++) {
      rs[roads[i].id] = {
        roadId: roads[i].id,
        speed: 0, speedRatio: 1, level: 0, levelKey: 'free',
        flow: 0, satRatio: 0, occupancy: 0, queueLen: 0,
        delay: 0, travelTime: 0, freeTravelTime: 0, vehicles: 0,
        incidentIds: null
      };
    }

    /* ---- 3. districtStats 对象池 ---- */
    var ds = S.districtStats = {};
    for (i = 0; i < S.city.districts.length; i++) {
      var dd = S.city.districts[i];
      ds[dd.id] = {
        districtId: dd.id, name: dd.name,
        avgSpeed: 0, congestionIndex: 0, flow: 0, inNetVehicles: 0,
        saturation: 0, incidents: 0, transitRidership: 0,
        parkingOccupancy: 0, carbon: 0
      };
    }

    /* ---- 4. 信号状态对象池 + 绿波相位差 ---- */
    buildSignals(rng);

    /* ---- 5. 事件池 ---- */
    buildIncidents(rng);

    /* ---- 6. 时间序列 + 累计前缀和 ---- */
    buildSeries();

    /* ---- 7. 公共交通基线 ---- */
    buildTransitBaseline(rng);

    /* ---- 8. OD ---- */
    buildOD(rng);

    /* ---- 9. 停车 / 单车基线 ---- */
    buildFacilityBaseline(rng);

    /* ---- 10. 碳排放 ---- */
    S.carbon = {
      total: 0, saved: 0,
      perMode: [
        { mode: 'private', name: '小汽车', ratio: 0, value: 0 },
        { mode: 'bus', name: '常规公交', ratio: 0, value: 0 },
        { mode: 'metro', name: '轨道交通', ratio: 0, value: 0 },
        { mode: 'taxi', name: '出租车/网约', ratio: 0, value: 0 },
        { mode: 'truck', name: '货运车辆', ratio: 0, value: 0 },
        { mode: 'bike', name: '慢行交通', ratio: 0, value: 0 }
      ],
      greenModes: []
    };

    S.kpi = {
      avgSpeed: 0, congestionIndex: 0, inNetVehicles: 0, totalFlow: 0, flowRate: 0,
      incidentCount: 0, transitRidership: 0, transitShare: 0,
      parkingOccupancy: 0, parkingAvailable: 0, bikeRides: 0, bikeTurnover: 0,
      carbonToday: 0, carbonSaved: 0, greenShare: 0, onTimeRate: 0,
      signalCount: S.city.signals.length, greenWaveCount: 0,
      avgDelay: 0, avgQueue: 0, emergencyResp: 0,
      /* 与"昨日同期"相比的变化率 % */
      congestionDelta: 0, speedDelta: 0, flowDelta: 0,
      linkFlowSum: 0,
      phaseName: phaseName(0, 'weekday'),
      dayType: 'weekday',
      dayTypeName: '工作日'
    };

    tpExpose();
    S.ready = true;
    setTime(S.minute, true);
    return S;
  }

  /* ------------------------------------------------------------------ *
   * 信号 & 绿波
   * ------------------------------------------------------------------ */
  function buildSignals(rng) {
    var signals = S.city.signals;
    var ss = S.signalStates = {};
    var sigById = {};
    var i, k;

    /* 每个信号一个稳定的相位偏移（保证同一 minute 下重复一致） */
    for (i = 0; i < signals.length; i++) {
      var sg = signals[i];
      sigById[sg.id] = sg;
      ss[sg.id] = {
        signalId: sg.id, cycle: sg.cycle, elapsed: 0, phaseIndex: 0,
        phaseName: '', remain: 0, phase: 'red', splits: [], queueLen: 0,
        saturation: 0, coordGroup: sg.coordGroup, adapted: false,
        totalGreen: 0
      };
    }

    /* 绿波：同走廊的信号按「行程时间 = 相位差」做协调 */
    var gw = S.greenWaves = {};
    var corridors = S.city.corridors || [];
    for (i = 0; i < corridors.length; i++) {
      var c = corridors[i];
      /* 快速路是立交（匝道分流），不设信号也就不做绿波 */
      if (c.cls === 'expressway') continue;
      var sids = c.signalIds || [];
      if (sids.length < 2) continue;
      var vMs = (c.recommendedSpeed || 45) * 1000 / 3600;    // m/s
      var acc = 0, prev = null, stops = [];
      var offsetBySignal = {};
      /* 优先用 city-model 记录的走廊弧长位置，比相邻站点直线距离更准
         （弯道走廊用直线距离会系统性低估行程时间，绿波相位差会偏） */
      var arcs = c.signalArcs || null;
      for (k = 0; k < sids.length; k++) {
        var s2 = sigById[sids[k]];
        if (!s2) continue;
        if (arcs && arcs[k] != null) {
          acc = arcs[k] * UNIT_M;
        } else if (prev) {
          acc += U.dist(prev.x, prev.z, s2.x, s2.z) * UNIT_M;
        }
        prev = s2;
        var travelSec = vMs > 0 ? acc / vMs : 0;
        var cyc = s2.cycle || 120;
        var offset = ((travelSec % cyc) + cyc) % cyc;
        offsetBySignal[s2.id] = offset;
        stops.push({
          signalId: s2.id, name: s2.name || ('路口 ' + s2.id),
          x: s2.x, z: s2.z,
          distanceFromStart: Math.round(acc),
          offsetSec: Math.round(offset),
          cycle: cyc,
          approaches: s2.approaches
        });
      }
      /* 主方向绿灯：取东西/南北中较长的一组 */
      var greens = [];
      for (k = 0; k < stops.length; k++) {
        var ap = stops[k].approaches || [];
        var g = 0;
        for (var q = 0; q < ap.length; q++) g = Math.max(g, ap[q].green);
        greens.push(g);
      }
      var minG = greens.length ? Math.min.apply(null, greens) : 30;
      var avgG = greens.length ? greens.reduce(function (a, b) { return a + b; }, 0) / greens.length : 30;
      var bandwidth = Math.max(8, Math.round(minG - (avgG - minG) * 0.6));
      var gid = 'CG' + String(i + 1).padStart(2, '0');
      gw[gid] = {
        groupId: gid,
        corridorId: c.id,
        corridorName: c.name,
        recommendedSpeed: c.recommendedSpeed || 45,
        bandwidth: bandwidth,
        efficiency: U.round(U.clamp01(bandwidth / Math.max(1, avgG)), 3),
        lengthKm: c.lengthKm,
        stops: stops,
        offsets: offsetBySignal
      };
    }

    /* 给所有信号机记录其绿波相位差；不在绿波内的按均匀相位差铺开 */
    S.sigOffset = {};
    for (i = 0; i < signals.length; i++) {
      var sid = signals[i].id;
      var found = null;
      for (var gk in gw) {
        if (gw[gk].offsets[sid] != null) { found = gw[gk].offsets[sid]; break; }
      }
      S.sigOffset[sid] = found == null ? rng.range(0, signals[i].cycle) : found;
    }
  }

  /* ------------------------------------------------------------------ *
   * 事件池
   * ------------------------------------------------------------------ */
  function buildIncidents(rng) {
    var roads = S.roads;
    /* 按需求曲线构造 CDF，使事件在高峰时段更密集 */
    var cdf = new Float64Array(MIN_PER_DAY + 1);
    var acc = 0, m;
    for (m = 0; m < MIN_PER_DAY; m++) {
      acc += demand(m, 'weekday');
      cdf[m + 1] = acc;
    }
    for (m = 0; m <= MIN_PER_DAY; m++) cdf[m] /= acc;

    function sampleMinute(r) {
      var x = r.next();
      var lo = 0, hi = MIN_PER_DAY;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (cdf[mid] < x) lo = mid + 1; else hi = mid;
      }
      return lo;
    }

    /* 路段空间索引：事件只影响附近的道路。
       用**中点**而不是首点作代表 —— 溶解直通节点后一条路段可能很长（150~400 米），
       用首点会让事件的影响范围整体偏到路段一端。 */
    var cell = 120, grid = {};
    for (var i = 0; i < roads.length; i++) {
      var pp = roads[i].path;
      var p = pp[Math.floor(pp.length / 2)];
      var k = Math.floor(p.x / cell) + '|' + Math.floor(p.z / cell);
      (grid[k] || (grid[k] = [])).push(i);
    }
    function nearRoads(x, z, radiusW) {
      var out = [];
      var ix0 = Math.floor((x - radiusW) / cell), ix1 = Math.floor((x + radiusW) / cell);
      var iz0 = Math.floor((z - radiusW) / cell), iz1 = Math.floor((z + radiusW) / cell);
      for (var ix = ix0; ix <= ix1; ix++) {
        for (var iz = iz0; iz <= iz1; iz++) {
          var arr = grid[ix + '|' + iz];
          if (!arr) continue;
          for (var j = 0; j < arr.length; j++) {
            var ri = arr[j];
            var pts = roads[ri].path;
            var mid = pts[Math.floor(pts.length / 2)];
            /* 用整条折线的最短距离，比"到单点距离"准得多 */
            var d = U.distToPolyline(x, z, pts);
            if (d <= radiusW) out.push({ i: ri, d: d });
          }
        }
      }
      return out;
    }

    var irng = rng.fork('incidents');
    var pool = S.incidentPool = [];
    /* 偏重大路：按等级加权的候选池 */
    var weighted = [];
    for (i = 0; i < roads.length; i++) {
      var cl = roads[i].cls;
      var times = cl === 'expressway' ? 5 : (cl === 'arterial' ? 4 : (cl === 'secondary' ? 2 : 1));
      for (var t = 0; t < times; t++) weighted.push(i);
    }

    for (i = 0; i < INCIDENT_POOL_SIZE; i++) {
      var ri2 = weighted[irng.int(0, weighted.length - 1)];
      var road = roads[ri2];
      var tkey = INCIDENT_TYPE_KEYS[irng.int(0, INCIDENT_TYPE_KEYS.length - 1)];
      var tdef = INCIDENT_TYPES[tkey];
      var sev = tkey === 'accident' ? irng.int(1, 3)
              : (tkey === 'control' ? irng.int(2, 3) : irng.int(1, 3));
      var since = sampleMinute(irng);
      var dur = tkey === 'construction' ? irng.int(180, 420)
              : (tkey === 'weather' ? irng.int(60, 180) : irng.int(18, 95));
      var impactKm = U.round(0.6 + sev * 0.55 + irng.range(0, 0.8), 1);
      var radiusW = impactKm * 200;
      var near = nearRoads(road.path[0].x, road.path[0].z, Math.max(180, radiusW * 0.55));
      var aff = [];
      for (var q = 0; q < near.length; q++) {
        /* 越近影响越强 */
        var wgt = near[q].d < 60 ? 1.0 : U.clamp(1 - (near[q].d - 60) / 240, 0.18, 1.0);
        aff.push({ i: near[q].i, w: U.round(wgt, 3) });
      }
      var dId = road.districtId;
      var dName = '';
      var dObj = TP.City.districtById(dId);
      if (dObj) dName = dObj.name;
      pool.push({
        id: 'E' + String(i + 1).padStart(4, '0'),
        type: tkey,
        typeName: tdef.name,
        title: road.name + tdef.desc[irng.int(0, tdef.desc.length - 1)],
        desc: tdef.desc[irng.int(0, tdef.desc.length - 1)],
        x: U.round(road.path[0].x, 1), z: U.round(road.path[0].z, 1),
        roadId: road.id, roadName: road.name,
        districtId: dId, districtName: dName,
        severity: sev, severityName: SEVERITY_NAME[sev],
        since: since, duration: dur,
        impactKm: impactKm,
        responders: sev === 3 ? irng.int(3, 6) : (sev === 2 ? irng.int(2, 4) : 1),
        vehiclesAffected: Math.round(near.length * irng.range(4, 14) * sev),
        status: 'cleared', elapsed: 0,
        affected: aff
      });
    }
    pool.sort(function (a, b) { return a.since - b.since; });
  }

  /* ------------------------------------------------------------------ *
   * 时间序列 + 累计量
   * ------------------------------------------------------------------ */
  function buildSeries() {
    var series = S.series = {
      minutes: new Array(NBUCKET),
      congestionIndex: new Array(NBUCKET),
      avgSpeed: new Array(NBUCKET),
      flow: new Array(NBUCKET),
      transitRidership: new Array(NBUCKET),
      carbon: new Array(NBUCKET),
      incidents: new Array(NBUCKET)
    };
    S._seriesBoth = { weekday: null, weekend: null };

    var cum = S.cum = {
      weekday: null, weekend: null
    };

    ['weekday', 'weekend'].forEach(function (dt) {
      var se = {
        minutes: new Array(NBUCKET),
        congestionIndex: new Array(NBUCKET),
        avgSpeed: new Array(NBUCKET),
        flow: new Array(NBUCKET),
        transitRidership: new Array(NBUCKET),
        carbon: new Array(NBUCKET),
        incidents: new Array(NBUCKET)
      };
      var sumD = 0, b;
      var dArr = new Float64Array(NBUCKET);
      for (b = 0; b < NBUCKET; b++) {
        var m = b * BUCKET_MIN;
        var dv = demand(m, dt);
        dArr[b] = dv;
        sumD += dv;
      }
      var transitDaily = transitDailyRidership();
      var vehDaily = DAILY_VEHICLE_TRIPS[dt];
      var carDaily = DAILY_CARBON[dt];
      var bikeDaily = DAILY_BIKE_RIDES[dt];
      var incCount = new Array(NBUCKET);
      for (b = 0; b < NBUCKET; b++) incCount[b] = 0;
      /* 用事件池统计每个桶内的事件数（工作日口径；周末按比例缩放） */
      var pool = S.incidentPool || [];
      for (var p = 0; p < pool.length; p++) {
        var b2 = Math.min(NBUCKET - 1, Math.floor(pool[p].since / BUCKET_MIN));
        incCount[b2]++;
      }

      var cumTrips = new Float64Array(NBUCKET + 1);
      var cumTransit = new Float64Array(NBUCKET + 1);
      var cumCarbon = new Float64Array(NBUCKET + 1);
      var cumBike = new Float64Array(NBUCKET + 1);
      var cumInc = new Float64Array(NBUCKET + 1);

      for (b = 0; b < NBUCKET; b++) {
        var m2 = b * BUCKET_MIN;
        var dv2 = dArr[b];
        var agg = networkAggregateAt(dv2, tidal(m2, dt));
        se.minutes[b] = m2;
        se.avgSpeed[b] = U.round(agg.avgSpeed, 2);
        se.congestionIndex[b] = U.round(congestionIndexFromRatio(agg.ratio), 2);
        se.flow[b] = Math.round(PEAK_HOURLY_FLOW[dt] * dv2);
        se.transitRidership[b] = U.round(transitDaily * (dv2 / sumD) * (60 / 24), 2);
        se.carbon[b] = U.round(carDaily * (dv2 / sumD) * (60 / 24), 2);   // 吨/h
        se.incidents[b] = dt === 'weekend' ? Math.round(incCount[b] * 0.72) : incCount[b];

        cumTrips[b + 1] = cumTrips[b] + se.flow[b] * (BUCKET_MIN / 60);
        cumTransit[b + 1] = cumTransit[b] + se.transitRidership[b] * (BUCKET_MIN / 60);
        cumCarbon[b + 1] = cumCarbon[b] + se.carbon[b];
        cumBike[b + 1] = cumBike[b] + bikeDaily * (dv2 / sumD);
        cumInc[b + 1] = cumInc[b] + se.incidents[b];
      }
      /* 归一到目标日总量 */
      function norm(arr, target) {
        var tot = arr[NBUCKET];
        if (tot <= 0) return;
        var k = target / tot;
        for (var q = 1; q <= NBUCKET; q++) arr[q] *= k;
      }
      norm(cumTrips, vehDaily);
      norm(cumTransit, transitDaily);
      norm(cumCarbon, carDaily);
      norm(cumBike, bikeDaily);
      /* 回写 bucket 级数值，保持 bucket 与累计自洽（统一为"每小时"口径） */
      for (b = 0; b < NBUCKET; b++) {
        se.flow[b] = Math.round((cumTrips[b + 1] - cumTrips[b]) / (BUCKET_MIN / 60));
        se.transitRidership[b] = U.round((cumTransit[b + 1] - cumTransit[b]) * (60 / BUCKET_MIN), 2);
        se.carbon[b] = U.round((cumCarbon[b + 1] - cumCarbon[b]) * (60 / BUCKET_MIN), 2);
      }

      S._seriesBoth[dt] = se;
      cum[dt] = { trips: cumTrips, transit: cumTransit, carbon: cumCarbon, bike: cumBike, incidents: cumInc };
    });

    /* 对外暴露当前 dayType 的序列（引用会随 setDay 更换） */
    S.series = S._seriesBoth.weekday;
  }

  function transitDailyRidership() {
    var t = 0, i, k;
    var ml = S.city.transit.metroLines;
    for (i = 0; i < ml.length; i++) t += ml[i].dailyRidership;
    var bl = S.city.transit.busLines;
    for (k = 0; k < bl.length; k++) t += bl[k].dailyRidership;
    return t;
  }

  /* ------------------------------------------------------------------ *
   * 公交 / 地铁实时基线
   * ------------------------------------------------------------------ */
  function buildTransitBaseline(rng) {
    var ts = S.transitState = {};
    var trng = rng.fork('transit');
    var i, k;
    var ml = S.city.transit.metroLines;
    for (i = 0; i < ml.length; i++) {
      var L = ml[i];
      var capFactorM = trng.range(0.86, 1.14);
      ts[L.id] = {
        lineId: L.id, name: L.name, kind: 'metro', color: L.color,
        dailyRidership: L.dailyRidership, ridership: 0, load: 0,
        crowding: 'normal', crowdingName: '正常',
        headwayActual: 3, headwayBase: U.round(trng.range(2.0, 4.0), 1),
        onTimeRate: 96, speed: 35, delayMin: 0, vehiclesPerHour: 0,
        capFactor: U.round(capFactorM, 3),
        /* 运能由"高峰小时客流 ÷ 设计满载率"反推，保证高峰满载率落在 0.8~1.1 */
        capacityHour: Math.round(L.dailyRidership * PEAK_HOUR_SHARE * 10000 / (DESIGN_PEAK_LOAD * capFactorM)),
        vehicleCapacity: VEH_CAPACITY.metro, minVph: MIN_VPH.metro,
        stationCount: L.stations.length,
        lengthKm: L.lengthKm
      };
    }
    var bl = S.city.transit.busLines;
    for (k = 0; k < bl.length; k++) {
      var B = bl[k];
      var capFactorB = trng.range(0.86, 1.14);
      ts[B.id] = {
        lineId: B.id, name: B.name, kind: 'bus', color: B.color,
        dailyRidership: B.dailyRidership, ridership: 0, load: 0,
        crowding: 'normal', crowdingName: '正常',
        headwayActual: B.headway, headwayBase: B.headway,
        onTimeRate: 90, speed: 20, delayMin: 0, vehiclesPerHour: 0,
        capFactor: U.round(capFactorB, 3),
        capacityHour: Math.round(B.dailyRidership * PEAK_HOUR_SHARE * 10000 / (DESIGN_PEAK_LOAD * capFactorB)),
        vehicleCapacity: VEH_CAPACITY.bus, minVph: MIN_VPH.bus,
        stationCount: B.stops.length,
        lengthKm: B.lengthKm
      };
    }
    return ts;
  }

  /* ------------------------------------------------------------------ *
   * OD 出行（走真实路网求路径）
   * ------------------------------------------------------------------ */
  function buildOD(rng) {
    var city = S.city;
    var graph = city.graph;
    var pf = makePathfinder(graph);
    var districts = city.districts;
    /* 行政区中心 → 最近节点 */
    var anchor = {};
    var nodeIds = Object.keys(graph.nodes);
    for (var i = 0; i < districts.length; i++) {
      var c = districts[i].center;
      var best = nodeIds[0], bd = Infinity;
      for (var j = 0; j < nodeIds.length; j++) {
        var n = graph.nodes[nodeIds[j]];
        var d = U.dist2(c.x, c.z, n.x, n.z);
        if (d < bd) { bd = d; best = nodeIds[j]; }
      }
      anchor[districts[i].id] = best;
    }
    /* 重力模型：T_ij ∝ w_i * w_j * f(距离) */
    var out = [];
    var orng = rng.fork('od');
    var totalDailyVeh = DAILY_VEHICLE_TRIPS.weekday;
    var raw = [];
    var sumRaw = 0;
    for (i = 0; i < districts.length; i++) {
      for (var k = 0; k < districts.length; k++) {
        if (i === k) continue;
        var A = districts[i], B = districts[k];
        var distW = U.dist(A.center.x, A.center.z, B.center.x, B.center.z) * UNIT_M / 1000;
        var f = Math.exp(-distW / 9.5);
        var v = A.weight * B.weight * f * (1 + orng.range(-0.22, 0.22));
        raw.push({ i: i, k: k, v: v, distKm: distW });
        sumRaw += v;
      }
    }
    for (var q = 0; q < raw.length; q++) {
      var it = raw[q];
      var A2 = districts[it.i], B2 = districts[it.k];
      var res = pf.path(anchor[A2.id], anchor[B2.id]);
      var path = [];
      if (res && res.nodes.length > 1) {
        var step = Math.max(1, Math.floor(res.nodes.length / 18));
        for (var s = 0; s < res.nodes.length; s += step) {
          var nn = graph.nodes[res.nodes[s]];
          path.push({ x: U.round(nn.x, 1), z: U.round(nn.z, 1) });
        }
        var ln = graph.nodes[res.nodes[res.nodes.length - 1]];
        path.push({ x: U.round(ln.x, 1), z: U.round(ln.z, 1) });
      } else {
        path = [{ x: A2.center.x, z: A2.center.z }, { x: B2.center.x, z: B2.center.z }];
      }
      var volume = Math.round(totalDailyVeh * (it.v / sumRaw));
      out.push({
        fromId: A2.id, toId: B2.id,
        fromName: A2.name, toName: B2.name,
        from: { x: A2.center.x, z: A2.center.z },
        to: { x: B2.center.x, z: B2.center.z },
        volume: volume,
        volumeNow: 0,
        path: path,
        distanceKm: U.round(it.distKm, 2),
        avgTime: 0,
        _i: it.i, _k: it.k
      });
    }
    out.sort(function (a, b) { return b.volume - a.volume; });
    S.odFlows = out;
  }

  /* ------------------------------------------------------------------ *
   * 停车 / 单车基线
   * ------------------------------------------------------------------ */
  function buildFacilityBaseline(rng) {
    var frng = rng.fork('facility');
    var i;
    var ps = S.parkingState = {};
    var pk = S.city.facilities.parking;
    for (i = 0; i < pk.length; i++) {
      var P = pk[i];
      /* 通勤型(地下/立体)早晚高，商业型(地面)午间与晚间高 */
      var peakBias = P.type === 'surface' ? 0.5 : -0.35;
      ps[P.id] = {
        id: P.id, name: P.name, x: P.x, z: P.z,
        capacity: P.capacity, type: P.type, districtId: P.districtId,
        occupancy: 0, available: P.capacity, status: 'normal',
        turnover: U.round(frng.range(1.4, 4.2), 2), peakBias: peakBias
      };
    }
    var bs = S.bikeState = {};
    var bk = S.city.facilities.bike;
    for (i = 0; i < bk.length; i++) {
      var K = bk[i];
      bs[K.id] = {
        id: K.id, name: K.name, x: K.x, z: K.z,
        capacity: K.capacity, districtId: K.districtId,
        available: K.capacity, occupancy: 0, status: 'normal',
        /* 地铁口早高峰被骑走（空），晚高峰被骑回（满） */
        commuteBias: frng.range(0.35, 1.0) * (frng.chance(0.5) ? 1 : -1)
      };
    }
  }

  /* ================================================================== *
   * 轻量寻路（与 city-model 内部同算法，这里独立一份避免耦合）
   * ================================================================== */
  function makePathfinder(graph) {
    function Heap() { this.a = []; }
    Heap.prototype.push = function (k, v) {
      var a = this.a; a.push({ k: k, v: v });
      var i = a.length - 1;
      while (i > 0) {
        var p = (i - 1) >> 1;
        if (a[p].k <= a[i].k) break;
        var t = a[p]; a[p] = a[i]; a[i] = t; i = p;
      }
    };
    Heap.prototype.pop = function () {
      var a = this.a;
      if (!a.length) return null;
      var top = a[0], last = a.pop();
      if (a.length) {
        a[0] = last;
        var i = 0, n = a.length;
        for (;;) {
          var l = 2 * i + 1, r = l + 1, s = i;
          if (l < n && a[l].k < a[s].k) s = l;
          if (r < n && a[r].k < a[s].k) s = r;
          if (s === i) break;
          var t = a[s]; a[s] = a[i]; a[i] = t; i = s;
        }
      }
      return top;
    };
    Heap.prototype.size = function () { return this.a.length; };
    var cache = {};
    return {
      path: function (startId, endId) {
        var key = startId + '>' + endId;
        if (cache[key]) return cache[key];
        var dist = {}, prev = {}, visited = {};
        var heap = new Heap();
        dist[startId] = 0;
        heap.push(0, startId);
        var guard = 0;
        while (heap.size()) {
          if (++guard > 60000) break;
          var cur = heap.pop().v;
          if (visited[cur]) continue;
          visited[cur] = 1;
          if (cur === endId) break;
          var adj = graph.adjacency[cur] || [];
          for (var i = 0; i < adj.length; i++) {
            var e = adj[i];
            var nd = dist[cur] + e.lengthM;
            if (dist[e.to] === undefined || nd < dist[e.to]) {
              dist[e.to] = nd; prev[e.to] = cur; heap.push(nd, e.to);
            }
          }
        }
        if (dist[endId] === undefined) { cache[key] = null; return null; }
        var nodes = [], c = endId;
        while (c !== undefined) { nodes.unshift(c); c = prev[c]; }
        var res = { nodes: nodes, cost: dist[endId] };
        cache[key] = res;
        return res;
      }
    };
  }

  /* ================================================================== *
   * 核心：按时刻求值
   * ================================================================== */

  function setTime(minute, force) {
    if (!S.ready) return S;
    minute = U.wrap(Math.round(minute), MIN_PER_DAY);
    if (!force && minute === S.lastMinute) return S;
    S.minute = minute;
    S.lastMinute = minute;

    var dt = S.dayType;
    var D = demand(minute, dt);
    var T = tidal(minute, dt);
    var roads = S.roads, rs = S.roadStates, st = S.st;
    var n = S.nRoads;
    var i, k;

    /* ---------- 1. 事件：确定当前活跃/已解除 ---------- */
    var pool = S.incidentPool;
    var active = [];
    var incArr = S.incidents;
    incArr.length = 0;
    for (i = 0; i < pool.length; i++) {
      var inc = pool[i];
      var el = minute - inc.since;
      var isActive;
      if (el < 0) {
        /* 跨午夜：把前一天的事件计入 */
        el = minute + MIN_PER_DAY - inc.since;
        isActive = el < inc.duration;
      } else {
        isActive = el < inc.duration;
      }
      if (!isActive) {
        /* 只保留近 3 小时内刚解除的，供列表滚动 */
        var sinceClear = (minute - (inc.since + inc.duration) + MIN_PER_DAY) % MIN_PER_DAY;
        if (sinceClear > 180) continue;
      }
      inc.status = isActive ? 'active' : 'cleared';
      inc.elapsed = Math.max(0, el);
      inc.statusName = isActive ? '处置中' : '已解除';
      inc.sinceHHMM = U.hhmm(inc.since);
      inc.remainMin = Math.max(0, Math.round(inc.duration - el));
      incArr.push(inc);
      if (isActive) active.push(inc);
    }
    incArr.sort(function (a, b) {
      if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
      return b.severity - a.severity || a.since - b.since;
    });

    /* 事件对路段的惩罚系数（只影响被波及的路段） */
    var pen = S._pen || (S._pen = new Float32Array(n));
    pen.fill(1);
    var incOfRoad = S._incOfRoad || (S._incOfRoad = {});
    for (k in incOfRoad) if (Object.prototype.hasOwnProperty.call(incOfRoad, k)) incOfRoad[k] = null;
    for (i = 0; i < active.length; i++) {
      var a = active[i];
      var sevK = a.severity === 3 ? 0.30 : (a.severity === 2 ? 0.19 : 0.10);
      for (var q = 0; q < a.affected.length; q++) {
        var af = a.affected[q];
        var f = 1 - sevK * af.w;
        if (f < pen[af.i]) pen[af.i] = f;
        var rid = roads[af.i].id;
        (incOfRoad[rid] || (incOfRoad[rid] = [])).length = 0;
        (incOfRoad[rid] || (incOfRoad[rid] = [])).push(a.id);
      }
    }

    /* ---------- 2. 逐路段求值 ---------- */
    var sumLen = 0, sumLenSpeed = 0, sumLenVf = 0;
    var sumFlow = 0, sumVeh = 0, sumDelayFlow = 0, sumQueueLen = 0;
    var levelCount = [0, 0, 0, 0];

    for (i = 0; i < n; i++) {
      var w = st.w[i], u = st.u[i];
      var tidalEffect = T * st.tidalDev[i];
      var jitter = Math.sin(st.ph[i] + minute * 0.031) * 0.042;
      var sat = w * D * (1 + tidalEffect) + jitter;
      sat = U.clamp(sat, 0.02, 1.28);

      var ratio = speedRatioFromSat(sat) * pen[i];
      if (ratio > 1) ratio = 1;
      var speed = st.vf[i] * ratio;
      if (speed < 4) speed = 4;

      var len = st.len[i];
      var freeTT = len / (st.vf[i] * 1000 / 3600);
      var tt = len / (speed * 1000 / 3600);
      var flow = st.cap[i] * Math.min(sat, 1.0);
      var veh = flow * tt / 3600;
      var level = U.congestionLevel(ratio);

      var o = rs[roads[i].id];
      o.speed = U.round(speed, 1);
      o.speedRatio = U.round(ratio, 4);
      o.level = level;
      o.levelKey = U.LEVEL_KEY[level];
      /* 单条路段的拥堵指数（0~10），走廊/路段排行与详情都要用；
         注意它和 KPI 里那个"全市拥堵指数"口径一致但作用对象不同 */
      o.congestionIndex = U.round(congestionIndexFromRatio(ratio), 2);
      o.flow = Math.round(flow);
      /* 事件路段的实际饱和度要抬高 */
      o.satRatio = U.round(pen[i] < 1 ? Math.min(1.28, sat / Math.max(0.35, pen[i])) : sat, 4);
      o.occupancy = U.round(U.clamp01(o.satRatio * 0.74), 4);
      var ql = Math.max(0, o.satRatio - 0.52) * 230 * (st.vf[i] / 60);
      o.queueLen = U.round(Math.min(ql, len * 0.4), 1);
      o.delay = U.round(Math.max(0, tt - freeTT), 1);
      o.travelTime = Math.round(tt);
      o.freeTravelTime = Math.round(freeTT);
      o.vehicles = Math.round(veh);
      o.incidentIds = incOfRoad[roads[i].id] || null;

      levelCount[level]++;
      sumLen += len;
      sumLenSpeed += speed * len;
      sumLenVf += st.vf[i] * len;
      sumFlow += flow;
      sumVeh += veh;
      sumDelayFlow += o.delay * flow;
      sumQueueLen += o.queueLen * len;
    }

    var avgSpeed = sumLen > 0 ? sumLenSpeed / sumLen : 0;
    var avgRatio = sumLenVf > 0 ? sumLenSpeed / sumLenVf : 1;
    var avgDelay = sumFlow > 0 ? sumDelayFlow / sumFlow : 0;
    var avgQueue = sumLen > 0 ? sumQueueLen / sumLen : 0;

    /* ---------- 3. 信号状态 ---------- */
    var sigs = S.city.signals, ss = S.signalStates;
    for (i = 0; i < sigs.length; i++) {
      var sg = sigs[i];
      var so = ss[sg.id];
      var off = S.sigOffset[sg.id] || 0;
      /* 高峰启用自适应（周期微调） */
      var adapted = D > 0.62;
      var cycle = sg.cycle + (adapted ? Math.round((D - 0.62) * 16) : 0);
      var elapsed = U.wrap(minute * 60 + off, cycle);
      var cum = 0, pi = 0, ph = 'red', remain = 0;
      var apprs = sg.approaches;
      var scale = cycle / sg.cycle;
      for (k = 0; k < apprs.length; k++) {
        var g = apprs[k].green * scale, y = apprs[k].yellow;
        if (elapsed < cum + g) { pi = k; ph = 'green'; remain = cum + g - elapsed; break; }
        cum += g;
        if (elapsed < cum + y) { pi = k; ph = 'yellow'; remain = cum + y - elapsed; break; }
        cum += y;
        if (k === apprs.length - 1) { pi = k; ph = 'red'; remain = cycle - elapsed; }
      }
      var dir = apprs[pi] ? apprs[pi].dir : 'N';
      so.cycle = cycle;
      so.elapsed = Math.round(elapsed);
      so.phaseIndex = pi;
      so.phase = ph;
      so.remain = Math.max(0, Math.round(remain));
      so.phaseName = (dir === 'N' || dir === 'S') ? '南北直行' : '东西直行';
      so.splits = apprs.map(function (x) { return Math.round(x.green * scale); });
      var node = TP.City.intersectionById(sg.intersectionId);
      var satNear = 0.6 * D;
      if (node && node.roadIds.length) {
        var acc2 = 0;
        for (k = 0; k < node.roadIds.length; k++) {
          var ro = rs[node.roadIds[k]];
          if (ro) acc2 += ro.satRatio;
        }
        satNear = acc2 / node.roadIds.length;
      }
      so.saturation = U.round(U.clamp01(satNear), 3);
      so.queueLen = U.round(Math.max(0, satNear - 0.5) * 26, 1);
      so.adapted = adapted;
      so.totalGreen = (so.splits.length ? Math.max.apply(null, so.splits) : 0);
    }

    /* ---------- 4. 公共交通 ----------
       注意单位：L.dailyRidership 与 L.ridership 是「万人次」，
       capacityHour / vehicleCapacity 是「人次」。混用会让满载率恒等于下限。 */
    var ts = S.transitState;
    var dPeak = demandPeakOfDay(dt);
    var rel = U.clamp01(D / Math.max(1e-6, dPeak));
    for (var lid in ts) {
      if (!Object.prototype.hasOwnProperty.call(ts, lid)) continue;
      var L = ts[lid];
      var isMetro = L.kind === 'metro';
      var hourlyWan = L.dailyRidership * PEAK_HOUR_SHARE * rel;   // 万人次/h
      var hourlyPerson = hourlyWan * 10000;                       // 人次/h
      L.ridership = U.round(hourlyWan, 2);
      L.load = U.round(U.clamp(hourlyPerson / Math.max(1, L.capacityHour), 0.02, 1.45), 3);
      L.crowding = crowdingOf(L.load);
      L.crowdingName = CROWDING_CN[L.crowding];
      var vph = Math.max(L.minVph, hourlyPerson / L.vehicleCapacity);
      L.vehiclesPerHour = Math.round(vph);
      L.headwayActual = U.round(60 / vph, 1);
      var baseOnTime = isMetro ? 97.5 : 93.5;
      L.onTimeRate = U.round(U.clamp(baseOnTime - (isMetro ? 4.5 : 15) * Math.max(0, rel - 0.4), 62, 99.5), 1);
      L.speed = U.round(isMetro ? 34 + 6 * (1 - rel) : 22 * (0.58 + 0.42 * (1 - rel)), 1);
      L.delayMin = U.round(Math.max(0, (1.02 - L.onTimeRate / 100) * (isMetro ? 12 : 42)), 1);
      L.totalDaily = L.dailyRidership;
      L.rel = U.round(rel, 3);
    }

    /* ---------- 5. OD 当前流量 ---------- */
    var odScale = D / 1.0;
    for (i = 0; i < S.odFlows.length; i++) {
      var od = S.odFlows[i];
      od.volumeNow = Math.round(od.volume / 24 * 1.9 * odScale);
      var freeSpeed = 42;
      od.avgTime = U.round(od.distanceKm / (freeSpeed * avgRatio / 42) * 60, 1);
    }

    /* ---------- 6. 停车 & 单车 ---------- */
    var ps = S.parkingState, pkIds = Object.keys(ps);
    var parkCapSum = 0, parkOccSum = 0;
    for (i = 0; i < pkIds.length; i++) {
      var P = ps[pkIds[i]];
      /* 通勤型(peakBias<0)：早晚高、午间低；商业型：午间与晚间高 */
      var shape = P.peakBias < 0
        ? 0.55 + 0.45 * Math.min(1, D / 1.05)
        : 0.50 + 0.42 * demand(U.wrap(minute + 60, 1440), dt) + 0.18 * Math.sin(minute / 1440 * Math.PI * 2 - 0.6);
      var occ = U.clamp(shape + (P.peakBias < 0 ? 0.10 : 0.06), 0.05, 1.0);
      P.occupancy = U.round(occ, 4);
      P.available = Math.max(0, Math.round(P.capacity * (1 - occ)));
      P.status = occ >= 0.97 ? 'full' : (occ >= 0.85 ? 'busy' : (occ >= 0.45 ? 'normal' : 'idle'));
      P.statusName = { full: '已满', busy: '紧张', normal: '正常', idle: '空闲' }[P.status];
      parkCapSum += P.capacity;
      parkOccSum += P.capacity * occ;
    }
    var parkingOccupancy = parkCapSum > 0 ? parkOccSum / parkCapSum : 0;

    var bs2 = S.bikeState, bkIds = Object.keys(bs2);
    var bikeAvailSum = 0, bikeCapSum = 0;
    for (i = 0; i < bkIds.length; i++) {
      var K = bs2[bkIds[i]];
      /* 早高峰通勤点被骑空、晚高峰骑回；用潮汐系数驱动 */
      var bias = K.commuteBias * T * 0.42;
      var occ2 = U.clamp(0.52 - bias + 0.10 * (demand(U.wrap(minute + 90, 1440), dt) - 0.5), 0.03, 0.99);
      K.occupancy = U.round(occ2, 4);
      K.available = Math.round(K.capacity * (1 - occ2));
      K.status = occ2 >= 0.9 ? 'full' : (occ2 >= 0.7 ? 'busy' : (occ2 >= 0.35 ? 'normal' : 'idle'));
      K.statusName = { full: '无车', busy: '紧张', normal: '正常', idle: '充足' }[K.status];
      bikeAvailSum += K.available;
      bikeCapSum += K.capacity;
    }

    /* ---------- 6.5 当日累计量（区域聚合与全局 KPI 共用） ---------- */
    var cumSet = S.cum[dt];
    var tripsNow = interpCum(cumSet.trips, minute);
    var transitWan = interpCum(cumSet.transit, minute);        // 万人次（累计）
    var bikeNow = interpCum(cumSet.bike, minute);              // 骑行次数（累计）
    var carbonNow = interpCum(cumSet.carbon, minute);          // 吨 CO2（累计）
    var dayFrac = U.clamp01(tripsNow / Math.max(1, DAILY_VEHICLE_TRIPS[dt]));
    var allTripsNow = TOTAL_PERSON_TRIPS * dayFrac;            // 人次（累计）
    S._transitNow = transitWan;
    S._carbonNow = carbonNow;
    S._transitShareNow = U.round(
      U.clamp01(transitWan * 10000 / Math.max(1, allTripsNow)) * 100, 1);

    /* ---------- 7. 行政区聚合 ---------- */
    var ds = S.districtStats;
    var dKeys = Object.keys(ds);
    var dAcc = S._dAcc || (S._dAcc = {});
    for (i = 0; i < dKeys.length; i++) {
      dAcc[dKeys[i]] = { len: 0, lenSpeed: 0, lenVf: 0, flow: 0, veh: 0, sat: 0, cnt: 0, inc: 0 };
    }
    for (i = 0; i < n; i++) {
      var dId = S.city.districts[st.districtIdx[i]].id;
      var ac = dAcc[dId];
      if (!ac) continue;
      var o2 = rs[roads[i].id];
      ac.len += st.len[i];
      ac.lenSpeed += o2.speed * st.len[i];
      ac.lenVf += st.vf[i] * st.len[i];
      ac.flow += o2.flow;
      ac.veh += o2.vehicles;
      ac.sat += o2.satRatio;
      ac.cnt++;
    }
    for (i = 0; i < active.length; i++) {
      var ad = dAcc[active[i].districtId];
      if (ad) ad.inc++;
    }
    var transitShareSum = 0;
    for (i = 0; i < dKeys.length; i++) {
      var key = dKeys[i];
      var ac2 = dAcc[key];
      var dObj = ds[key];
      var aSpd = ac2.len > 0 ? ac2.lenSpeed / ac2.len : 0;
      var aRatio = ac2.lenVf > 0 ? ac2.lenSpeed / ac2.lenVf : 1;
      dObj.avgSpeed = U.round(aSpd, 1);
      dObj.congestionIndex = U.round(congestionIndexFromRatio(aRatio), 2);
      dObj.flow = Math.round(ac2.flow);
      dObj.inNetVehicles = Math.round(ac2.veh);
      dObj.saturation = U.round(ac2.cnt ? ac2.sat / ac2.cnt : 0, 3);
      dObj.incidents = ac2.inc;
      var wt = districtWeight(key);
      dObj.transitRidership = U.round(S._transitNow * wt, 2);
      var pOcc = districtParkingOcc(key);
      dObj.parkingOccupancy = U.round(pOcc * 100, 1);
      dObj.carbon = U.round(S._carbonNow * wt, 1);
    }

    /* ---------- 8. 全局 KPI ---------- */
    var kpi = S.kpi;
    kpi.avgSpeed = U.round(avgSpeed, 1);
    kpi.congestionIndex = U.round(congestionIndexFromRatio(avgRatio), 2);
    kpi.inNetVehicles = Math.round(sumVeh);
    kpi.totalFlow = Math.round(tripsNow);
    kpi.flowRate = Math.round(PEAK_HOURLY_FLOW[dt] * D);
    kpi.incidentCount = active.length;
    kpi.transitRidership = U.round(transitWan, 1);
    kpi.transitShare = S._transitShareNow;
    kpi.parkingOccupancy = U.round(parkingOccupancy * 100, 1);
    kpi.parkingAvailable = Math.max(0, Math.round(parkCapSum - parkOccSum));
    kpi.bikeRides = Math.round(bikeNow);
    kpi.bikeTurnover = U.round(bikeNow / BIKE_FLEET, 2);
    kpi.carbonToday = U.round(S._carbonNow, 1);
    kpi.carbonSaved = U.round(greenSavedSoFar(minute, dt), 1);
    var greenTrips = transitWan * 10000 + bikeNow + allTripsNow * WALK_TRIP_SHARE;
    kpi.greenShare = U.round(U.clamp01(greenTrips / Math.max(1, allTripsNow)) * 100, 1);
    kpi.onTimeRate = U.round(weightedOnTime(), 1);
    kpi.signalCount = S.city.signals.length;
    kpi.greenWaveCount = Object.keys(S.greenWaves).length;
    kpi.avgDelay = U.round(avgDelay, 1);
    kpi.avgQueue = U.round(avgQueue, 1);
    kpi.emergencyResp = U.round(U.clamp(3.2 + 3.4 * D + 0.4 * active.length / 6, 2, 14), 1);
    kpi.linkFlowSum = Math.round(sumFlow);
    kpi.phaseName = phaseName(minute, dt);
    kpi.dayType = dt;
    kpi.dayTypeName = dt === 'weekend' ? '周末' : '工作日';

    /* 与昨日同期对比 */
    var Dy = demand(minute, dt) * 1.028;
    var ratioY = speedRatioFromSat(0.85 * Dy);
    var avgSpeedY = S.freeSpeedAvg * ratioY;
    kpi.speedDelta = U.round((avgSpeed - avgSpeedY) / Math.max(1, avgSpeedY) * 100, 1);
    kpi.congestionDelta = U.round(congestionIndexFromRatio(avgRatio) - congestionIndexFromRatio(ratioY), 2);
    kpi.flowDelta = U.round(-2.8 * (1 - 1 / 1.028) * 100, 1);

    /* ---------- 9. 碳排放 ---------- */
    updateCarbon(minute, dt, D);

    /* ---------- 10. 对外序列引用 ---------- */
    S.series = S._seriesBoth[dt];

    S._levelCount = levelCount;
    S._avgRatio = avgRatio;
    S._D = D;
    S._T = T;
    if (S.onUpdate) S.onUpdate(S);
    return S;
  }

  /* ---- 小工具 ---- */
  var _demandAvgCache = {};
  function demandAvg(dt) {
    if (_demandAvgCache[dt] != null) return _demandAvgCache[dt];
    var s = 0;
    for (var b = 0; b < NBUCKET; b++) s += demand(b * BUCKET_MIN, dt);
    _demandAvgCache[dt] = s / NBUCKET;
    return _demandAvgCache[dt];
  }

  /** 当日需求峰值（用于把"高峰小时"锚定到真实峰值上） */
  var _demandPeakCache = {};
  function demandPeakOfDay(dt) {
    if (_demandPeakCache[dt] != null) return _demandPeakCache[dt];
    var mx = 0;
    for (var m = 0; m < MIN_PER_DAY; m += 5) {
      var v = demand(m, dt);
      if (v > mx) mx = v;
    }
    _demandPeakCache[dt] = mx;
    return mx;
  }

  /** 全网聚合：与 setTime 的路段模型**同一套公式**。
   *  时间序列与短时预测都走这里，保证图表曲线与 KPI 卡数值出自同一模型、不会互相打架。
   *  （早期版本序列用 `0.85 × D` 的经验式，与路网聚合实测能差到 170%，页面上一眼看出矛盾。） */
  function networkAggregateAt(D, T) {
    var st = S.st, n = S.nRoads;
    var sumLen = 0, sumLenSpeed = 0, sumLenVf = 0;
    for (var i = 0; i < n; i++) {
      var sat = U.clamp(st.w[i] * D * (1 + T * st.tidalDev[i]), 0.02, 1.28);
      var ratio = speedRatioFromSat(sat);
      var len = st.len[i];
      sumLen += len;
      sumLenSpeed += st.vf[i] * ratio * len;
      sumLenVf += st.vf[i] * len;
    }
    return {
      avgSpeed: sumLen > 0 ? sumLenSpeed / sumLen : 0,
      ratio: sumLenVf > 0 ? sumLenSpeed / sumLenVf : 1,
      freeSpeed: sumLen > 0 ? sumLenVf / sumLen : S.freeSpeedAvg
    };
  }

  /** 在前缀和数组上按 minute 线性插值 */
  function interpCum(arr, minute) {
    var x = minute / BUCKET_MIN;
    var i0 = Math.floor(x);
    if (i0 >= NBUCKET) return arr[NBUCKET];
    var t = x - i0;
    return U.lerp(arr[i0], arr[i0 + 1], t);
  }

  function districtWeight(id) {
    var ds = S.city.districts;
    for (var i = 0; i < ds.length; i++) if (ds[i].id === id) return ds[i].weight;
    return 1 / ds.length;
  }
  function districtParkingOcc(id) {
    var ps = S.parkingState, cap = 0, occ = 0;
    for (var k in ps) {
      if (!Object.prototype.hasOwnProperty.call(ps, k)) continue;
      if (ps[k].districtId !== id) continue;
      cap += ps[k].capacity;
      occ += ps[k].capacity * ps[k].occupancy;
    }
    return cap > 0 ? occ / cap : 0;
  }
  function weightedOnTime() {
    var ts = S.transitState, w = 0, v = 0;
    for (var k in ts) {
      if (!Object.prototype.hasOwnProperty.call(ts, k)) continue;
      var L = ts[k];
      var ww = L.dailyRidership;
      w += ww; v += ww * L.onTimeRate;
    }
    return w > 0 ? v / w : 0;
  }
  function greenSavedSoFar(minute, dt) {
    var ml = S.city.transit.metroLines, bl = S.city.transit.busLines, i;
    var frac = interpCum(S.cum[dt].transit, minute) / Math.max(1, S.cum[dt].transit[NBUCKET]);
    var bikeFrac = interpCum(S.cum[dt].bike, minute) / Math.max(1, S.cum[dt].bike[NBUCKET]);
    var saved = 0;
    for (i = 0; i < ml.length; i++) {
      saved += ml[i].dailyRidership * CARBON_SAVED_PER_TRIP_KG.metro * 10 * frac;
    }
    for (i = 0; i < bl.length; i++) {
      saved += bl[i].dailyRidership * CARBON_SAVED_PER_TRIP_KG.bus * 10 * frac;
    }
    saved += (DAILY_BIKE_RIDES[dt] / 10000) * CARBON_SAVED_PER_TRIP_KG.bike * 10 * (bikeFrac || 0);
    return saved;
  }

  function updateCarbon(minute, dt, D) {
    var c = S.carbon;
    var total = interpCum(S.cum[dt].carbon, minute);
    var saved = greenSavedSoFar(minute, dt);
    c.total = U.round(total, 1);
    c.saved = U.round(saved, 1);
    var shares = [0.584, 0.092, 0.046, 0.148, 0.114, 0.016];
    for (var i = 0; i < c.perMode.length; i++) {
      c.perMode[i].value = U.round(total * shares[i], 1);
      c.perMode[i].ratio = U.round(shares[i] * 100, 1);
      c.perMode[i].color = null;
    }
    var trng = S._crng || (S._crng = U.Rng(S.seed ^ 0x51ed));
    if (!c.greenModes.length) {
      var ml = S.city.transit.metroLines, bl = S.city.transit.busLines;
      var metroDaily = 0, busDaily = 0, k;
      for (k = 0; k < ml.length; k++) metroDaily += ml[k].dailyRidership;
      for (k = 0; k < bl.length; k++) busDaily += bl[k].dailyRidership;
      var bikeDaily = DAILY_BIKE_RIDES[dt] / 10000;
      c.greenModes = [
        { mode: 'metro', name: '轨道交通', trips: U.round(metroDaily, 1), carbonSavedPerTrip: CARBON_SAVED_PER_TRIP_KG.metro, saved: U.round(metroDaily * CARBON_SAVED_PER_TRIP_KG.metro * 10, 1) },
        { mode: 'bus', name: '常规公交', trips: U.round(busDaily, 1), carbonSavedPerTrip: CARBON_SAVED_PER_TRIP_KG.bus, saved: U.round(busDaily * CARBON_SAVED_PER_TRIP_KG.bus * 10, 1) },
        { mode: 'bike', name: '共享单车', trips: U.round(bikeDaily, 1), carbonSavedPerTrip: CARBON_SAVED_PER_TRIP_KG.bike, saved: U.round(bikeDaily * CARBON_SAVED_PER_TRIP_KG.bike * 10, 1) }
      ];
    }
    /* 进度按当日已过时段缩放 */
    var frac = interpCum(S.cum[dt].carbon, minute) / Math.max(1, S.cum[dt].carbon[NBUCKET]);
    for (var m = 0; m < c.greenModes.length; m++) {
      var gm = c.greenModes[m];
      gm.tripsNow = U.round(gm.trips * frac, 1);
      gm.savedNow = U.round(gm.saved * frac, 1);
    }
  }

  /* ================================================================== *
   * 对外：序列 / 预测 / 绿波
   * ================================================================== */

  var METRIC_META = {
    congestionIndex:   { label: '拥堵指数', unit: '',      band: 0.30 },
    avgSpeed:          { label: '平均速度', unit: 'km/h',  band: 1.10 },
    flow:              { label: '路网流量', unit: '辆/h',  band: 2600 },
    transitRidership:  { label: '公共交通客流', unit: '万人次/h', band: 0.55 },
    carbon:            { label: '碳排放', unit: '吨/h', band: 60.0 },
    incidents:         { label: '交通事件', unit: '起',    band: 1.2 }
  };

  function seriesAt(metric) {
    var se = S._seriesBoth[S.dayType] || S.series;
    var arr = se[metric];
    if (!arr) return { minutes: [], values: [], label: metric, unit: '' };
    var meta = METRIC_META[metric] || { label: metric, unit: '' };
    return {
      metric: metric,
      minutes: se.minutes.slice(),
      x: se.minutes.slice(),
      y: arr.slice(),
      values: arr.slice(),
      label: meta.label,
      unit: meta.unit
    };
  }

  /** 闭式求某时刻的聚合指标值（用于预测与对比） */
  function metricAt(metric, minute, dayType) {
    var dt = dayType || S.dayType;
    var D = demand(minute, dt);
    var T = tidal(minute, dt);
    var agg = networkAggregateAt(D, T);
    switch (metric) {
      case 'avgSpeed': return U.round(agg.avgSpeed, 2);
      case 'congestionIndex': return U.round(congestionIndexFromRatio(agg.ratio), 2);
      case 'flow': return Math.round(PEAK_HOURLY_FLOW[dt] * D);
      case 'transitRidership': {
        var td = transitDailyRidership();
        return U.round(td * (D / demandAvg(dt)) / 24, 2);
      }
      case 'carbon': {
        var se = S._seriesBoth[dt];
        var b = Math.min(NBUCKET - 1, Math.floor(minute / BUCKET_MIN));
        return se.carbon[b];
      }
      case 'incidents': {
        var c = 0;
        for (var i = 0; i < S.incidentPool.length; i++) {
          var inc = S.incidentPool[i];
          var el = minute - inc.since;
          if (el < 0) el += MIN_PER_DAY;
          if (el < inc.duration) c++;
        }
        return c;
      }
      default: return 0;
    }
  }

  function forecast(metric, horizonMin) {
    horizonMin = horizonMin || 60;
    var meta = METRIC_META[metric] || { label: metric, unit: '', band: 1 };
    var step = 5;
    var pts = [];
    var start = S.minute;
    var now = metricAt(metric, start, S.dayType);
    var peak = { minute: start, v: now };
    for (var t = 0; t <= horizonMin; t += step) {
      var m = U.wrap(start + t, MIN_PER_DAY);
      var v = metricAt(metric, m, S.dayType);
      var h = horizonMin > 0 ? t / horizonMin : 0;
      var band = meta.band * (0.35 + 1.75 * h);
      pts.push({
        minute: m, hhmm: U.hhmm(m),
        v: U.round(v, 2),
        lo: U.round(v - band, 2),
        hi: U.round(v + band, 2)
      });
      if (metric === 'avgSpeed' ? v < peak.v : v > peak.v) peak = { minute: m, v: v };
    }
    var last = pts[pts.length - 1];
    var diff = last.v - now;
    var trend = Math.abs(diff) < Math.max(0.02 * Math.abs(now), 1e-6) ? 'flat'
              : (diff > 0 ? 'up' : 'down');
    return {
      metric: metric, label: meta.label, unit: meta.unit,
      now: U.round(now, 2),
      trend: trend,
      peakMinute: peak.minute,
      peakHHMM: U.hhmm(peak.minute),
      peakValue: U.round(peak.v, 2),
      points: pts
    };
  }

  /* ================================================================== *
   * 单条路段的 24h 曲线与短时预测（详情抽屉用，按需计算 + LRU 缓存）
   * ================================================================== */

  var ROAD_SERIES_CACHE_MAX = 40;

  /** 某条路段在当日 288 个时间桶上的速度/拥堵指数/流量曲线 */
  function roadTimeline(roadId) {
    var i = S.roadIndex[roadId];
    if (i === undefined) return null;
    var cache = S._roadSeries || (S._roadSeries = {});
    var hit = cache[roadId];
    if (hit && hit.dayType === S.dayType) return hit;

    var st = S.st;
    var x = new Array(NBUCKET), speed = new Array(NBUCKET);
    var cong = new Array(NBUCKET), flow = new Array(NBUCKET);
    var td = st.tidalDev[i];
    for (var b = 0; b < NBUCKET; b++) {
      var m = b * BUCKET_MIN;
      var D = demand(m, S.dayType);
      var T = tidal(m, S.dayType);
      var sat = U.clamp(st.w[i] * D * (1 + T * td), 0.02, 1.28);
      var ratio = speedRatioFromSat(sat);
      x[b] = m;
      speed[b] = U.round(st.vf[i] * ratio, 1);
      cong[b] = U.round(congestionIndexFromRatio(ratio), 2);
      flow[b] = Math.round(st.cap[i] * Math.min(sat, 1));
    }
    var res = {
      dayType: S.dayType, roadId: roadId,
      x: x, minutes: x, speed: speed, congestion: cong, flow: flow,
      speedLimit: st.vf[i], capacity: st.cap[i], lanes: S.roads[i].lanes
    };
    /* 简单容量控制，避免用户连点上百条路段后内存无界增长 */
    var keys = Object.keys(cache);
    if (keys.length >= ROAD_SERIES_CACHE_MAX) delete cache[keys[0]];
    cache[roadId] = res;
    return res;
  }

  /** 某条路段的未来短时速度预测（含置信带） */
  function roadForecast(roadId, horizonMin) {
    var i = S.roadIndex[roadId];
    if (i === undefined) return null;
    horizonMin = horizonMin || 60;
    var st = S.st;
    var td = st.tidalDev[i];
    var pts = [], now = null;
    for (var t = 0; t <= horizonMin; t += 5) {
      var m = U.wrap(S.minute + t, MIN_PER_DAY);
      var D = demand(m, S.dayType);
      var T = tidal(m, S.dayType);
      var sat = U.clamp(st.w[i] * D * (1 + T * td), 0.02, 1.28);
      var ratio = speedRatioFromSat(sat);
      var v = U.round(st.vf[i] * ratio, 1);
      var band = 4.5 * (0.35 + 1.6 * (t / Math.max(1, horizonMin)));
      if (t === 0) now = v;
      pts.push({
        minute: m, hhmm: U.hhmm(m), v: v,
        lo: U.round(Math.max(0, v - band), 1),
        hi: U.round(v + band, 1)
      });
    }
    var last = pts[pts.length - 1];
    var diff = last.v - now;
    return {
      metric: 'avgSpeed', label: '路段车速', unit: 'km/h', now: now,
      trend: Math.abs(diff) < 0.6 ? 'flat' : (diff > 0 ? 'up' : 'down'),
      points: pts
    };
  }

  function invalidateRoadSeries() { S._roadSeries = {}; }

  function greenWave(groupId) {
    var gw = S.greenWaves;
    if (!gw) return null;
    var g = gw[groupId];
    if (!g) {
      /* 允许传 corridorId */
      for (var k in gw) {
        if (gw[k].corridorId === groupId) { g = gw[k]; groupId = k; break; }
      }
    }
    if (!g) {
      var keys = Object.keys(gw);
      if (!keys.length) return null;
      g = gw[keys[0]];
      groupId = keys[0];
    }
    var ss = S.signalStates;
    var stops = [];
    for (var i = 0; i < g.stops.length; i++) {
      var s = g.stops[i];
      var so = ss[s.signalId];
      var ap = s.approaches || [];
      var gmax = 0;
      for (var q = 0; q < ap.length; q++) gmax = Math.max(gmax, ap[q].green);
      stops.push({
        signalId: s.signalId,
        name: s.name,
        x: s.x, z: s.z,
        distanceFromStart: s.distanceFromStart,
        offsetSec: s.offsetSec,
        cycle: so ? so.cycle : s.cycle,
        phase: so ? so.phase : 'red',
        remain: so ? so.remain : 0,
        phaseName: so ? so.phaseName : '',
        greenRatio: so && so.cycle ? U.round((so.totalGreen || gmax) / so.cycle, 3) : U.round(gmax / s.cycle, 3),
        greenSec: gmax
      });
    }
    return {
      groupId: groupId,
      corridorId: g.corridorId,
      corridorName: g.corridorName,
      recommendedSpeed: g.recommendedSpeed,
      bandwidth: g.bandwidth,
      efficiency: g.efficiency,
      lengthKm: g.lengthKm,
      stops: stops
    };
  }

  /* ================================================================== *
   * setDay
   * ================================================================== */
  function setDay(type) {
    type = (type === 'weekend') ? 'weekend' : 'weekday';
    if (S.dayType === type && S.ready) return S;
    S.dayType = type;
    S.series = S._seriesBoth[type];
    S.kpi.dayType = type;
    S.kpi.dayTypeName = type === 'weekend' ? '周末' : '工作日';
    if (S.ready) setTime(S.minute, true);
    return S;
  }

  /* ================================================================== *
   * 暴露
   * ================================================================== */
  function tpExpose() {
    var Sim = TP.Sim = TP.Sim || {};
    Sim.init = init;
    Sim.setTime = setTime;
    Sim.setDay = setDay;
    Sim.seriesAt = seriesAt;
    Sim.metricAt = metricAt;
    Sim.forecast = forecast;
    Sim.greenWave = greenWave;
    Sim.roadTimeline = roadTimeline;
    Sim.roadForecast = roadForecast;
    Sim.invalidateRoadSeries = invalidateRoadSeries;
    Sim.demand = demand;
    Sim.demandAvg = demandAvg;
    Sim.tidal = tidal;
    Sim.phaseName = phaseName;
    Sim.speedRatioFromSat = speedRatioFromSat;
    Sim.METRIC_META = METRIC_META;
    Sim.DAY_TYPES = ['weekday', 'weekend'];
    Sim.crowdingName = function (k) { return CROWDING_CN[k] || k; };
    /* 注意：不要在这里写 Sim.ready = xxx —— ready 由下面的 getter 提供，
       给只有 getter 的属性赋值会抛 TypeError。S.ready 才是真实状态。 */

    Object.defineProperty(Sim, 'city', { get: function () { return S.city; }, configurable: true, enumerable: true });
    Object.defineProperty(Sim, 'minute', { get: function () { return S.minute; }, configurable: true, enumerable: true });
    Object.defineProperty(Sim, 'dayType', { get: function () { return S.dayType; }, configurable: true, enumerable: true });
    Object.defineProperty(Sim, 'kpi', { get: function () { return S.kpi; }, configurable: true, enumerable: true });
    Object.defineProperty(Sim, 'roadStates', { get: function () { return S.roadStates; }, configurable: true, enumerable: true });
    Object.defineProperty(Sim, 'districtStats', { get: function () { return S.districtStats; }, configurable: true, enumerable: true });
    Object.defineProperty(Sim, 'incidents', { get: function () { return S.incidents; }, configurable: true, enumerable: true });
    Object.defineProperty(Sim, 'activeIncidents', {
      get: function () {
        var out = [];
        for (var i = 0; i < S.incidents.length; i++) {
          if (S.incidents[i].status === 'active') out.push(S.incidents[i]);
        }
        return out;
      }, configurable: true, enumerable: true
    });
    Object.defineProperty(Sim, 'transitState', { get: function () { return S.transitState; }, configurable: true, enumerable: true });
    Object.defineProperty(Sim, 'odFlows', { get: function () { return S.odFlows; }, configurable: true, enumerable: true });
    Object.defineProperty(Sim, 'signalStates', { get: function () { return S.signalStates; }, configurable: true, enumerable: true });
    Object.defineProperty(Sim, 'parkingState', { get: function () { return S.parkingState; }, configurable: true, enumerable: true });
    Object.defineProperty(Sim, 'bikeState', { get: function () { return S.bikeState; }, configurable: true, enumerable: true });
    Object.defineProperty(Sim, 'carbon', { get: function () { return S.carbon; }, configurable: true, enumerable: true });
    Object.defineProperty(Sim, 'series', { get: function () { return S.series; }, configurable: true, enumerable: true });
    Object.defineProperty(Sim, 'greenWaves', { get: function () { return S.greenWaves; }, configurable: true, enumerable: true });
    Object.defineProperty(Sim, 'freeSpeedAvg', { get: function () { return S.freeSpeedAvg; }, configurable: true, enumerable: true });
    Object.defineProperty(Sim, 'ready', {
      get: function () { return S.ready; }, configurable: true, enumerable: true
    });
    Object.defineProperty(Sim, 'transitDailyTotal', {
      get: function () { return transitDailyRidership(); }, configurable: true, enumerable: true
    });
    Object.defineProperty(Sim, 'levelCount', { get: function () { return S._levelCount; }, configurable: true, enumerable: true });
    Object.defineProperty(Sim, 'peakHourlyFlow', {
      get: function () { return PEAK_HOURLY_FLOW[S.dayType]; }, configurable: true, enumerable: true
    });
    Object.defineProperty(Sim, 'totals', {
      get: function () {
        return {
          personTrips: TOTAL_PERSON_TRIPS,
          vehicleTrips: DAILY_VEHICLE_TRIPS[S.dayType],
          carbon: DAILY_CARBON[S.dayType],
          bikeRides: DAILY_BIKE_RIDES[S.dayType],
          bikeFleet: BIKE_FLEET,
          walkShare: WALK_TRIP_SHARE,
          transitDaily: transitDailyRidership()
        };
      }, configurable: true, enumerable: true
    });
  }

  tpExpose();

})(window);
