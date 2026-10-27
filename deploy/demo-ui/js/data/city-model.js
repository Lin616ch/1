/* ============================================================================
 * city-model.js —— 城市静态模型（纯数据，零渲染，零 DOM）
 * 命名空间：TP.City
 * 依赖：TP.Util（js/utils.js）
 * 世界坐标：Y 轴朝上，城市在 XZ 平面，X,Z ∈ [-1000,1000]，1 世界单位 = 5 米
 *           x = 东(+)，z = 南(+)，故北方为 -z
 * 确定性：只用 TP.Util.Rng，全程不使用 Math.random()
 * ==========================================================================*/
(function (window) {
  'use strict';

  var TP = window.TP = window.TP || {};
  var U = TP.Util;

  var UNIT_M = 5;                 // 1 世界单位 = 5 米
  var TWO_PI = Math.PI * 2;
  var DEG = Math.PI / 180;
  var CORE_R = 240;               // 中心城区半径（世界单位）= 1.2 km
  var R_CLIP = 940;               // 路网采样跨度（实际裁剪按市域轮廓 boundaryHalfZ/X 走）
  var FINE_R = 640;               // 细网格范围
  var COARSE = 130;               // 粗网格间距（世界单位）= 650 米
  var FINE = 65;                  // 细网格间距 = 325 米
  var MIN_SEG_W = 1.0;            // 过短碎段丢弃阈值（世界单位）= 5 米
  var RING_R = [400, 620];        // 两条环路基准半径（会被谐波扰动成不规则闭合环）
  var SQ2 = Math.SQRT2;

  /* ------------------------------------------------------------------ *
   * 行政区定义（1 个中心圆盘 + 5 个 72° 环形扇区）
   * 角度为极角（度），从 +x 轴起，向 +z（南）为正
   * ------------------------------------------------------------------ */
  var DISTRICT_DEF = [
    { id: 'core', name: '中心城区', short: '中心', color: '#1a5fb4', a0: null, a1: null,
      pop: 62.4, jobs: 58.2, weight: 0.26, stock: 14.2,
      hBase: 46, hSpread: 0.62, landmark: 3, character: 'cbd' },

    { id: 'east', name: '城东片区', short: '城东', color: '#0e9aa7', a0: 324, a1: 396,
      pop: 48.6, jobs: 18.4, weight: 0.19, stock: 13.8,
      hBase: 30, hSpread: 0.50, landmark: 2, character: 'mixed' },

    { id: 'south', name: '城南片区', short: '城南', color: '#2b8a3e', a0: 36, a1: 108,
      pop: 42.8, jobs: 12.6, weight: 0.16, stock: 11.6,
      hBase: 26, hSpread: 0.46, landmark: 2, character: 'residential' },

    { id: 'riverside', name: '滨江新区', short: '滨江', color: '#3b82c4', a0: 108, a1: 180,
      pop: 30.2, jobs: 26.8, weight: 0.15, stock: 8.4,
      hBase: 38, hSpread: 0.55, landmark: 2, character: 'business' },

    { id: 'hitech', name: '高新园区', short: '高新', color: '#6f5bd6', a0: 180, a1: 252,
      pop: 22.6, jobs: 34.2, weight: 0.14, stock: 6.2,
      hBase: 34, hSpread: 0.52, landmark: 2, character: 'industrial' },

    { id: 'airport', name: '空港新城', short: '空港', color: '#e8a33d', a0: 252, a1: 324,
      pop: 13.4, jobs: 15.8, weight: 0.10, stock: 3.4,
      hBase: 20, hSpread: 0.40, landmark: 1, character: 'logistics' }
  ];

  /* ------------------------------------------------------------------ *
   * 街道 / 站点命名池
   * ------------------------------------------------------------------ */
  var NAME_RADIAL = ['中山大道', '澜江大道', '云锦大道', '望京大道',
                     '临港大道', '科创大道', '腾飞大道', '锦绣大道'];
  var NAME_BORDER = { 36: '城南大道', 108: '滨江大道', 180: '高新高架', 252: '空港大道', 324: '东城大道' };
  var NAME_RING = ['内环快速路', '外环高速'];
  var NAME_V = ['文华路', '锦程路', '育才路', '兴业路', '朝阳路', '玉兰路', '明德路', '广济路',
                '青云路', '长乐路', '同泰路', '光华路', '嘉禾路', '通惠路', '安平路', '新民路',
                '春熙路', '朝晖路', '白鹭路', '文澜路', '和风路', '鼎盛路', '聚源路', '望舒路'];
  var NAME_H = ['望山路', '清和路', '惠民路', '滨湖路', '经纬路', '康宁路', '瑞金路', '通元路',
                '山河路', '建业路', '丰泽路', '紫荆路', '澄江路', '万顺路', '东林路', '厚德路',
                '五云路', '甘棠路', '和顺路', '静安路', '远航路', '海纳路', '中天路', '集贤路'];

  var STATION_NAMES = ['市民中心', '云澜站', '会展中心', '体育中心', '云澜大学', '科技园',
                       '高新园', '空港枢纽', '城南客运站', '滨江公园', '文化宫', '人民医院',
                       '图书馆', '金融街', '软件园', '汽车东站', '火车站北', '百花广场',
                       '中心公园', '望山公园', '澜江码头', '创业大厦', '国际学校', '汽车城',
                       '物流园', '工业园', '政务中心', '艺术中心', '万顺商城', '西湖新村',
                       '东林家园', '碧水湾', '青云里', '和风里', '锦绣华庭', '康桥小镇',
                       '临港新城', '云锦台', '保税区', '航空港', '智造园', '生物医药园',
                       '数码城', '双创中心', '金融后台', '数据谷', '电商园', '临空产业园'];

  var BUILDING_NAMES = ['云澜国际中心', '环球金融大厦', '澜江双子塔', '市民服务中心', '城市规划馆',
                        '科技创新中心', '国际会展中心', '云澜大剧院', '体育中心体育馆', '空港航站楼'];

  /* ================================================================== *
   * 几何辅助
   * ================================================================== */

  function polar(r, deg) { return { x: r * Math.cos(deg * DEG), z: r * Math.sin(deg * DEG) }; }

  /** 外边界半径随角度起伏，范围约 805 ~ 995，恒 >= 800 */
  function outerRadius(deg) {
    var a = deg * DEG;
    var r = 900 + 60 * Math.sin(3 * a + 15 * DEG) + 35 * Math.sin(7 * a);
    return U.clamp(r, 806, 996);
  }

  /** 区界（径向分界线）随半径的角向偏移，纯函数，保证相邻两区得到同一条线 */
  function borderWobble(thetaDeg, t) {
    /* 角度必须先归一化：东区 a1=396 与南区 a0=36 是同一条分界线，
       若直接用 396 去 hash 会得到不同的扰动，产生两条几乎重合的平行道路 */
    thetaDeg = ((thetaDeg % 360) + 360) % 360;
    var s = U.hashStr('border:' + Math.round(thetaDeg));
    var p1 = (s % 1000) / 1000 * TWO_PI;
    var p2 = ((s >> 10) % 1000) / 1000 * TWO_PI;
    return (3.4 * Math.sin(t * 3.1 + p1) + 1.9 * Math.sin(t * 6.7 + p2)) * DEG;
  }

  var BORDER_SAMPLES = 16;
  /** 返回从内(索引0)到外(索引 N-1)的分界点列 */
  function borderPoints(thetaDeg) {
    var pts = [], i, t, r, a;
    var rOut = outerRadius(thetaDeg);
    for (i = 0; i < BORDER_SAMPLES; i++) {
      t = i / (BORDER_SAMPLES - 1);
      r = U.lerp(CORE_R, rOut, t);
      a = thetaDeg + borderWobble(thetaDeg, t) / DEG;
      pts.push(polar(r, a));
    }
    return pts;
  }

  /** 中心圆盘边界：完美圆，每 3° 一点（保证与各扇区内弧顶点严格重合） */
  function coreCirclePoints() {
    var pts = [], a;
    for (a = 0; a < 360; a += 3) pts.push(polar(CORE_R, a));
    return pts;
  }

  /** 生成某个环形扇区的闭合多边形 */
  function sectorPolygon(a0, a1) {
    var pts = [], a, rOut, steps, i, t, r;
    /* 内弧 a0 → a1（每 3° 一点，与中心圆共用顶点） */
    for (a = a0; a < a1; a += 3) pts.push(polar(CORE_R, a));
    /* 右分界 内 → 外 */
    var bp1 = borderPoints(a1);
    for (i = 1; i < bp1.length; i++) pts.push(bp1[i]);
    /* 外弧 a1 → a0 */
    steps = Math.max(6, Math.round((a1 - a0) / 4));
    for (i = 1; i <= steps; i++) {
      t = i / steps;
      a = U.lerp(a1, a0, t);
      rOut = outerRadius(a);
      pts.push(polar(rOut, a));
    }
    /* 左分界 外 → 内 */
    var bp0 = borderPoints(a0);
    for (i = bp0.length - 2; i >= 1; i--) pts.push(bp0[i]);
    return pts;
  }

  /* ================================================================== *
   * 线段索引（空间哈希，加速建筑-道路碰撞检测）
   * ================================================================== */
  function SegIndex(cell) {
    this.cell = cell || 60;
    this.map = {};
  }
  SegIndex.prototype._key = function (ix, iz) { return ix + '|' + iz; };
  SegIndex.prototype.add = function (seg) {
    var c = this.cell;
    var x0 = Math.min(seg.a.x, seg.b.x), x1 = Math.max(seg.a.x, seg.b.x);
    var z0 = Math.min(seg.a.z, seg.b.z), z1 = Math.max(seg.a.z, seg.b.z);
    var ix0 = Math.floor((x0 - c) / c), ix1 = Math.floor((x1 + c) / c);
    var iz0 = Math.floor((z0 - c) / c), iz1 = Math.floor((z1 + c) / c);
    for (var ix = ix0; ix <= ix1; ix++) {
      for (var iz = iz0; iz <= iz1; iz++) {
        var k = this._key(ix, iz);
        (this.map[k] || (this.map[k] = [])).push(seg);
      }
    }
  };
  SegIndex.prototype.near = function (x, z) {
    var k = this._key(Math.floor(x / this.cell), Math.floor(z / this.cell));
    return this.map[k] || null;
  };

  /** 点到线段最短距离 */
  function distSeg(x, z, a, b) {
    var dx = b.x - a.x, dz = b.z - a.z;
    var L2 = dx * dx + dz * dz;
    var t = L2 < 1e-9 ? 0 : U.clamp01(((x - a.x) * dx + (z - a.z) * dz) / L2);
    var px = a.x + dx * t, pz = a.z + dz * t;
    return Math.sqrt((x - px) * (x - px) + (z - pz) * (z - pz));
  }

  /* ================================================================== *
   * 最小堆 + Dijkstra
   * ================================================================== */
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

  function Pathfinder(graph) {
    this.g = graph;
    this._cache = {};
  }
  /** weightFn(edge) → 代价；不传则用 lengthM */
  Pathfinder.prototype.path = function (startId, endId, weightFn) {
    var g = this.g;
    if (!g.nodes[startId] || !g.nodes[endId]) return null;
    var dist = {}, prev = {}, prevEdge = {}, visited = {};
    var heap = new Heap();
    dist[startId] = 0;
    heap.push(0, startId);
    var guard = 0;
    while (heap.size()) {
      if (++guard > 60000) break;
      var top = heap.pop();
      var cur = top.v;
      if (visited[cur]) continue;
      visited[cur] = 1;
      if (cur === endId) break;
      var adj = g.adjacency[cur] || [];
      for (var i = 0; i < adj.length; i++) {
        var e = adj[i];
        var w = weightFn ? weightFn(e) : e.lengthM;
        var nd = dist[cur] + w;
        if (dist[e.to] === undefined || nd < dist[e.to]) {
          dist[e.to] = nd;
          prev[e.to] = cur;
          prevEdge[e.to] = e;
          heap.push(nd, e.to);
        }
      }
    }
    if (dist[endId] === undefined) return null;
    var nodes = [], edges = [], c = endId;
    while (c !== undefined) {
      nodes.unshift(c);
      if (prevEdge[c]) edges.unshift(prevEdge[c]);
      c = prev[c];
    }
    return { nodes: nodes, edges: edges, cost: dist[endId] };
  };

  /* ================================================================== *
   * 平面细分：把一堆可能相交的线段切成互不相交的边
   * ================================================================== */
  function subdivide(lines) {
    /* 1. 展开为线段 */
    var segs = [], i, j, k;
    for (i = 0; i < lines.length; i++) {
      var ln = lines[i];
      for (j = 0; j < ln.pts.length - 1; j++) {
        var a = ln.pts[j], b = ln.pts[j + 1];
        if (U.dist2(a.x, a.z, b.x, b.z) < 1e-6) continue;
        segs.push({ a: a, b: b, line: ln, segIdx: j, cuts: [0, 1] });
      }
      /* 闭合线的收尾段 */
      if (ln.closed && ln.pts.length > 2) {
        var pa = ln.pts[ln.pts.length - 1], pb = ln.pts[0];
        if (U.dist2(pa.x, pa.z, pb.x, pb.z) > 1e-6) {
          segs.push({ a: pa, b: pb, line: ln, segIdx: ln.pts.length - 1, cuts: [0, 1] });
        }
      }
    }
    var n = segs.length;

    /* 2. 空间哈希，收集潜在相交对 */
    var cell = 90, buckets = {}, key;
    for (i = 0; i < n; i++) {
      var s = segs[i];
      var x0 = Math.min(s.a.x, s.b.x), x1 = Math.max(s.a.x, s.b.x);
      var z0 = Math.min(s.a.z, s.b.z), z1 = Math.max(s.a.z, s.b.z);
      var ix0 = Math.floor(x0 / cell), ix1 = Math.floor(x1 / cell);
      var iz0 = Math.floor(z0 / cell), iz1 = Math.floor(z1 / cell);
      for (var ix = ix0; ix <= ix1; ix++) {
        for (var iz = iz0; iz <= iz1; iz++) {
          key = ix + '|' + iz;
          (buckets[key] || (buckets[key] = [])).push(i);
        }
      }
    }

    /* 3. 求交并记录切分参数 */
    var tested = {};
    for (key in buckets) {
      if (!Object.prototype.hasOwnProperty.call(buckets, key)) continue;
      var arr = buckets[key];
      for (i = 0; i < arr.length; i++) {
        for (j = i + 1; j < arr.length; j++) {
          var p = arr[i], q = arr[j];
          if (p === q) continue;
          var pk = p < q ? p + '_' + q : q + '_' + p;
          if (tested[pk]) continue;
          tested[pk] = 1;
          var A = segs[p], B = segs[q];
          var r1 = A.b.x - A.a.x, r2 = A.b.z - A.a.z;
          var s1 = B.b.x - B.a.x, s2 = B.b.z - B.a.z;
          var den = r1 * s2 - r2 * s1;
          if (Math.abs(den) < 1e-9) continue;      // 平行或共线：交给端点焊接处理
          var t = ((B.a.x - A.a.x) * s2 - (B.a.z - A.a.z) * s1) / den;
          var u = ((B.a.x - A.a.x) * r2 - (B.a.z - A.a.z) * r1) / den;
          if (t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6) {
            A.cuts.push(t);
            B.cuts.push(u);
          }
        }
      }
    }

    /* 4. 按切分参数切段 + 端点焊接 */
    var nodeMap = {}, nodes = [], edges = [], edgeSeen = {};
    function weld(x, z) {
      var kx = Math.round(x * 2) / 2, kz = Math.round(z * 2) / 2;
      var k = kx + ',' + kz;
      var id = nodeMap[k];
      if (id === undefined) {
        id = 'N' + (nodes.length + 1);
        nodeMap[k] = id;
        nodes.push({ id: id, x: kx, z: kz, roadIds: [], degree: 0 });
      }
      return nodeMap[k];
    }

    for (i = 0; i < n; i++) {
      var S = segs[i];
      S.cuts.sort(function (m, mm) { return m - mm; });
      for (k = 0; k < S.cuts.length - 1; k++) {
        var t0 = S.cuts[k], t1 = S.cuts[k + 1];
        if (t1 - t0 < 1e-5) continue;
        var ax = U.lerp(S.a.x, S.b.x, t0), az = U.lerp(S.a.z, S.b.z, t0);
        var bx = U.lerp(S.a.x, S.b.x, t1), bz = U.lerp(S.a.z, S.b.z, t1);
        var len = Math.sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az));
        if (len < MIN_SEG_W) continue;   // 丢弃零长碎段（阈值刻意很小，
                                         // 否则会把环路/走廊在中间打断成两截）
        var idA = weld(ax, az), idB = weld(bx, bz);
        if (idA === idB) continue;
        var ek = idA < idB ? idA + '_' + idB : idB + '_' + idA;
        if (edgeSeen[ek]) {
          var exist = edgeSeen[ek];
          exist.dupLines.push(S.line);
          continue;
        }
        var e = {
          id: 'R' + String(edges.length + 1).padStart(4, '0'),
          a: idA, b: idB,
          path: [{ x: ax, z: az }, { x: bx, z: bz }],
          lengthW: len,
          lengthM: Math.round(len * UNIT_M),
          line: S.line,
          dupLines: []
        };
        edgeSeen[ek] = e;
        edges.push(e);
      }
    }

    return { nodes: nodes, edges: edges };
  }

  /* ================================================================== *
   * 建筑
   * ================================================================== */

  function buildingCountFor(def, areaKm2) {
    /* 目标总量 ~2000（受路网退让后的可用格位约束，实际会略低于目标） */
    var density = 0;
    switch (def.character) {
      case 'cbd':         density = 130; break;   // 中心城区另有显式上限
      case 'business':    density = 44;  break;
      case 'mixed':       density = 40;  break;
      case 'residential': density = 38;  break;
      case 'industrial':  density = 20;  break;
      default:            density = 13;  break;   // logistics
    }
    return Math.round(areaKm2 * density);
  }

  function pickType(def, rng) {
    var roll = rng.next();
    switch (def.character) {
      case 'cbd':
        if (roll < 0.42) return 'office';
        if (roll < 0.62) return 'mall';
        if (roll < 0.88) return 'res';
        return 'office';
      case 'business':
        if (roll < 0.50) return 'office';
        if (roll < 0.68) return 'mall';
        return 'res';
      case 'mixed':
        if (roll < 0.30) return 'office';
        if (roll < 0.46) return 'mall';
        return 'res';
      case 'residential':
        if (roll < 0.78) return 'res';
        if (roll < 0.94) return 'mall';
        return 'office';
      case 'industrial':
        if (roll < 0.52) return 'industrial';
        if (roll < 0.80) return 'res';
        return 'office';
      default: /* logistics */
        if (roll < 0.56) return 'industrial';
        if (roll < 0.84) return 'res';
        return 'office';
    }
  }

  /* ================================================================== *
   * 主构建
   * ================================================================== */

  var built = null;
  var buildOptions = null;

  function build(options) {
    options = options || {};
    var opt = {
      seed: options.seed == null ? 20240815 : options.seed,
      name: options.name || '云澜市',
      extent: options.extent || 1000
    };
    if (built && buildOptions &&
        built.meta.seed === opt.seed && built.meta.name === opt.name) {
      return built;
    }
    var t0 = U.now();

    var rng = U.Rng(opt.seed);
    var noise = U.makeNoise2D(opt.seed ^ 0x9e37);

    /* ---------- 1. 行政区多边形 ---------- */
    var districts = [];
    var i, d;
    for (i = 0; i < DISTRICT_DEF.length; i++) {
      d = DISTRICT_DEF[i];
      var polyPts;
      if (d.id === 'core') polyPts = coreCirclePoints();
      else polyPts = sectorPolygon(d.a0, d.a1);
      /* 契约形态是 [[x,z], ...]；U.pointInPolygon / polygonArea / polygonCentroid
         都只认数组形态。_polyPts 保留 {x,z} 形态供内部几何计算复用。 */
      var polyArrD = polyPts.map(function (p) { return [U.round(p.x, 2), U.round(p.z, 2)]; });
      districts.push({
        id: d.id, name: d.name, short: d.short, color: d.color,
        center: null, polygon: polyArrD, _polyPts: polyPts,
        areaKm2: 0, population: d.pop, jobs: d.jobs, roadKm: 0,
        vehicleStock: d.stock, weight: d.weight,
        _def: d, _character: d.character
      });
    }

    /* ---------- 2. 构造"线"集合 ----------
       现实感的三条原则：
         a) 环路不是正圆 —— 真实环路有凸有凹，是"多频谐波扰动过的闭合环"
         b) 路网不是激光直线 —— 用二维缓变扭曲场让街道顺地形微弯，且间距不等（街区长宽不一）
         c) 路网必须分级 —— 高架快速路 / 地面主干 / 次干 / 支路，并有立交与桥梁 */

    var lines = [];

    /* 全局缓变扭曲场：把一个坐标"顺着地形"推一下。
       空间尺度 300 世界单位 = 1.5 km，振幅约 ±18 世界单位 = 90 米。
       用它作用于网格后，街道既保持大致平行（不会互相穿插），又不再是直线。 */
    function warp(x, z) {
      var wx = U.fbm(noise, x / 300, z / 300, 3) * 26;
      var wz = U.fbm(noise, x / 300 + 11.3, z / 300 + 7.7, 3) * 26;
      return { x: x + wx, z: z + wz };
    }

    /** 生成"不等距"坐标序列：真实城市的街区长度是参差的 */
    function steppedPositions(span, base, seed) {
      var out = [], acc = -span;
      var rp = U.Rng(seed);
      while (acc < span) {
        out.push(acc);
        acc += base * rp.range(0.74, 1.46);
      }
      return out;
    }

    /* 市域轮廓采样表：把路网裁剪到**真实市域形状**，而不是裁到一个固定半径的圆里。
       否则市域边缘会留下一圈"有楼无路"的怪带（建筑生成按行政区多边形，路网却按固定圆裁剪）。 */
    var BND_N = 720;
    var bnd = [];
    for (k = 0; k < BND_N; k++) {
      var ba = k * 360 / BND_N;
      var br = outerRadius(ba);
      bnd.push({ x: br * Math.cos(ba * DEG), z: br * Math.sin(ba * DEG) });
    }
    /** 给定 x，求市域内该竖线的最大 |z|（近似） */
    function boundaryHalfZ(x) {
      var best = 0;
      for (var q = 0; q < BND_N; q++) {
        var p = bnd[q];
        if (Math.abs(p.x - x) < 40 && Math.abs(p.z) > best) best = Math.abs(p.z);
      }
      return best;
    }
    /** 给定 z，求市域内该横线的最大 |x|（近似） */
    function boundaryHalfX(z) {
      var best = 0;
      for (var q = 0; q < BND_N; q++) {
        var p = bnd[q];
        if (Math.abs(p.z - z) < 40 && Math.abs(p.x) > best) best = Math.abs(p.x);
      }
      return best;
    }

    /* 2.1 高压环路：expressway + 高架（viaduct）。不再用正圆，改为多频谐波扰动 */
    for (i = 0; i < RING_R.length; i++) {
      var rpts = [];
      var rseg = 60, k;
      var rBase = RING_R[i];
      var p1 = i * 2.1, p2 = i * 4.7;
      for (k = 0; k < rseg; k++) {
        var aDeg = k * 360 / rseg;
        var aRad = aDeg * DEG;
        var rr = rBase * (1
          + 0.075 * Math.sin(2 * aRad + p1)
          + 0.045 * Math.sin(3 * aRad + p2)
          + 0.026 * Math.sin(5 * aRad + p1 * 2)
          + 0.015 * Math.sin(8 * aRad + p2 * 3));
        /* 角向也不等分，避免采样点均匀造成"多边形感" */
        rpts.push(polar(rr, aDeg + 1.3 * Math.sin(3 * aRad + p2)));
      }
      lines.push({
        kind: 'ring', cls: 'expressway', name: NAME_RING[i],
        pts: rpts, closed: true,
        structure: 'viaduct', elevW: 2.6, piers: true
      });
    }

    /* 2.2 绕城高速：沿**真实市域轮廓**走一圈（而不是一个正圆）。
       它同时承担一个工程职责 —— 让被裁剪的网格端点有地方落地
       （原先靠"行政区边界环路"承担，但那种沿每个行政区边界修一圈路的做法在真实城市里并不存在，
        是很明显的人造感来源）。 */
    (function () {
      var opts = [];
      var oseg = 72;
      for (k = 0; k < oseg; k++) {
        var oa = k * 360 / oseg;
        var oar = oa * DEG;
        var orr = outerRadius(oa) * 0.975;
        opts.push({ x: orr * Math.cos(oar), z: orr * Math.sin(oar) });
      }
      lines.push({
        kind: 'outerRing', cls: 'expressway', name: '绕城高速',
        pts: opts, closed: true, structure: 'surface', elevW: 0
      });
    })();

    /* 2.3 中央商务区环（arterial，地面）：给放射干道一个落脚点，
       避免 8 条干道全部汇聚到原点那种"蜘蛛"形状 */
    (function () {
      var cpts = [];
      var cseg = 40;
      for (k = 0; k < cseg; k++) {
        var ca = k * 360 / cseg;
        var car = ca * DEG;
        var crr = 150 * (1 + 0.09 * Math.sin(2 * car + 0.6) + 0.05 * Math.sin(5 * car + 2.2));
        cpts.push(polar(crr, ca));
      }
      lines.push({
        kind: 'cbdRing', cls: 'arterial', name: '内环辅路',
        pts: cpts, closed: true, structure: 'surface', elevW: 0
      });
    })();

    /* 2.4 放射干道：从 CBD 环出发到绕城高速。
       不等距布置（不再严格 45°），并用两层扰动让干道整体弯折 + 局部折点。 */
    for (i = 0; i < 6; i++) {
      var baseAng = i * 60 + [7, -9, 12, -6, 10, -11][i];
      var rEnd = 772;
      var lp = [];
      var nSeg = 22;
      for (k = 0; k <= nSeg; k++) {
        var t = k / nSeg;
        var rr2 = U.lerp(150, rEnd, Math.pow(t, 0.96));
        var aa = baseAng
               + 5.2 * Math.sin(t * 2.4 + i * 1.9)
               + 2.1 * Math.sin(t * 6.3 + i * 3.3);
        lp.push(polar(rr2, aa));
      }
      /* 第 0、3 条做成高架快速路放射线，让城市里既有"环"也有"射"的高架 */
      var isExp = (i === 0 || i === 3);
      lines.push({
        kind: 'radial', cls: isExp ? 'expressway' : 'arterial',
        name: NAME_RADIAL[i], pts: lp, closed: false,
        structure: isExp ? 'viaduct' : 'surface',
        elevW: isExp ? 2.4 : 0, piers: isExp
      });
    }

    /* 2.5 区界干道（arterial，地面）—— 与行政区多边形严格共用折线，
       但裁到市域轮廓之内（否则会伸到市域外面变成断头路） */
    for (i = 0; i < DISTRICT_DEF.length; i++) {
      d = DISTRICT_DEF[i];
      if (d.a0 === null) continue;
      var bp = [];
      var bpRaw = borderPoints(d.a1);
      for (k = 0; k < bpRaw.length; k++) {
        var bpr = Math.sqrt(bpRaw[k].x * bpRaw[k].x + bpRaw[k].z * bpRaw[k].z);
        var bpAng = Math.atan2(bpRaw[k].z, bpRaw[k].x) / DEG;
        if (bpr > outerRadius(bpAng) * 0.965) break;   // 采样半径递增，一旦超出即可停止
        bp.push(bpRaw[k]);
      }
      if (bp.length < 2) continue;
      lines.push({
        kind: 'border', cls: 'arterial',
        name: NAME_BORDER[Math.round(d.a1) % 360] || (d.name + '环路'),
        pts: bp, closed: false, structure: 'surface', elevW: 0
      });
    }

    /* 2.6 斜向干道：真实城市几乎都有几条"斜街"打破方格 */
    var DIAG = [
      { ang: 24, off: 150, name: '云锦路' },
      { ang: 68, off: -230, name: '望江大道' },
      { ang: 118, off: 260, name: '腾飞路' },
      { ang: 158, off: -170, name: '长虹路' },
      { ang: 205, off: 300, name: '金沙大道' }
    ];
    for (i = 0; i < DIAG.length; i++) {
      var dg = DIAG[i];
      var drad = dg.ang * DEG;
      var ux = Math.cos(drad), uz = Math.sin(drad);
      var lx = -uz * dg.off, lz = ux * dg.off;
      var L = Math.sqrt(Math.max(0, R_CLIP * R_CLIP - dg.off * dg.off)) + 90;
      var nd = 26;
      /* 采样后只保留"落在市域轮廓内"的那一段连续区间，
         否则对角线会捅到市域外面变成断头路 */
      var run = [], best = [];
      for (k = 0; k <= nd; k++) {
        var st2 = U.lerp(-L, L, k / nd);
        var wp = warp(lx + ux * st2, lz + uz * st2);
        var wr = Math.sqrt(wp.x * wp.x + wp.z * wp.z);
        var wang = Math.atan2(wp.z, wp.x) / DEG;
        if (wr <= outerRadius(wang) * 0.965) run.push(wp);
        else { if (run.length > best.length) best = run; run = []; }
      }
      if (run.length > best.length) best = run;
      if (best.length < 2) continue;
      var pd = best;
      lines.push({
        kind: 'diag', cls: 'arterial', name: dg.name,
        pts: pd, closed: false, structure: 'surface', elevW: 0
      });
    }

    /* 2.7 主干/次干路网：不等距 + 扭曲场 + 按市域轮廓裁剪 */
    var vxs = steppedPositions(R_CLIP, COARSE, 7001);
    var hzs = steppedPositions(R_CLIP, COARSE, 7002);
    var gi, gx, gz, q, tt, hz, hx, nPt;
    for (gi = 0; gi < vxs.length; gi++) {
      gx = vxs[gi];
      hz = boundaryHalfZ(gx) - 16;
      if (hz < 90) continue;                       // 落在市域外的线直接不要
      nPt = 16;
      var pv = [];
      for (q = 0; q <= nPt; q++) {
        tt = q / nPt;
        pv.push(warp(gx, U.lerp(-hz, hz, tt)));
      }
      var isArtV = (gi % 3 === 0);
      lines.push({
        kind: 'gridV', cls: isArtV ? 'arterial' : 'secondary',
        name: NAME_V[gi % NAME_V.length],
        pts: pv, closed: false, structure: 'surface', elevW: 0
      });
    }
    for (gi = 0; gi < hzs.length; gi++) {
      gz = hzs[gi];
      hx = boundaryHalfX(gz) - 16;
      if (hx < 90) continue;
      nPt = 16;
      var ph = [];
      for (q = 0; q <= nPt; q++) {
        tt = q / nPt;
        ph.push(warp(U.lerp(-hx, hx, tt), gz));
      }
      var isArtH = (gi % 3 === 1);
      lines.push({
        kind: 'gridH', cls: isArtH ? 'arterial' : 'secondary',
        name: NAME_H[gi % NAME_H.length],
        pts: ph, closed: false, structure: 'surface', elevW: 0
      });
    }

    /* 2.8 支路网：只在建成区加密（范围取"建成区半径"与"市域轮廓"的较小者） */
    var FINE_STEP = FINE;
    var fxs = steppedPositions(FINE_R, FINE_STEP, 7101);
    var fzs = steppedPositions(FINE_R, FINE_STEP, 7102);
    for (gi = 0; gi < fxs.length; gi++) {
      gx = fxs[gi];
      hz = Math.min(Math.sqrt(Math.max(0, FINE_R * FINE_R - gx * gx)), boundaryHalfZ(gx) - 20);
      if (hz < 70) continue;
      var pf = [];
      for (q = 0; q <= 12; q++) {
        tt = q / 12;
        pf.push(warp(gx, U.lerp(-hz, hz, tt)));
      }
      lines.push({
        kind: 'fineV', cls: 'branch', name: NAME_V[(gi + 7) % NAME_V.length] + '支路',
        pts: pf, closed: false, structure: 'surface', elevW: 0
      });
    }
    for (gi = 0; gi < fzs.length; gi++) {
      gz = fzs[gi];
      hx = Math.min(Math.sqrt(Math.max(0, FINE_R * FINE_R - gz * gz)), boundaryHalfX(gz) - 20);
      if (hx < 70) continue;
      var pf2 = [];
      for (q = 0; q <= 12; q++) {
        tt = q / 12;
        pf2.push(warp(U.lerp(-hx, hx, tt), gz));
      }
      lines.push({
        kind: 'fineH', cls: 'branch', name: NAME_H[(gi + 11) % NAME_H.length] + '支路',
        pts: pf2, closed: false, structure: 'surface', elevW: 0
      });
    }

    /* ---------- 3. 平面细分 ---------- */
    var sub = subdivide(lines);
    var rawNodes = sub.nodes;
    var rawEdges = sub.edges;

    /* ---------- 4. 剪除过短的悬挂支路（degree 1 且长度很短） ---------- */
    pruneDangling(rawNodes, rawEdges, 55);

    /* ---------- 4.1 溶解直通节点：把碎段并成真实量级的路段 ---------- */
    dissolvePassThrough(rawNodes, rawEdges);

    /* ---------- 5. 组装 roads / intersections / graph ---------- */
    var levelOf = {};   // cls → {lanes, speedLimit, capacity, width}
    var CLS_SPEC = {
      expressway: { lanes: 8, speedLimit: 100, capacity: 9000 },
      arterial:   { lanes: 6, speedLimit: 60,  capacity: 5400 },
      secondary:  { lanes: 4, speedLimit: 45,  capacity: 3200 },
      branch:     { lanes: 2, speedLimit: 30,  capacity: 1400 }
    };

    var roads = [];
    var roadsById = {};
    var nodeRoads = {};
    for (i = 0; i < rawEdges.length; i++) {
      var e = rawEdges[i];
      var spec = CLS_SPEC[e.line.cls] || CLS_SPEC.secondary;
      var cid = districtIdAtRaw(e.path[0].x, e.path[0].z, districts, noise);
      var road = {
        id: e.id,
        name: e.line.name,
        cls: e.line.cls,
        path: e.path,
        lengthM: e.lengthM,
        lanes: spec.lanes,
        speedLimit: spec.speedLimit,
        capacity: spec.capacity,
        districtId: cid,
        from: e.a,
        to: e.b,
        oneway: false,
        corridorId: null,
        /* 结构类型与桥面标高（世界单位）。0 = 地面。
           surface 地面 | viaduct 高架 | bridge 跨河桥 | tunnel 隧道 */
        structure: e.line.structure || 'surface',
        elevW: e.line.elevW || 0,
        piers: !!e.line.piers,
        _kind: e.line.kind,
        _line: e.line            /* 建走廊时要用它的原始折线做弧长排序 */
      };
      roads.push(road);
      roadsById[road.id] = road;
      (nodeRoads[e.a] || (nodeRoads[e.a] = [])).push(road.id);
      (nodeRoads[e.b] || (nodeRoads[e.b] = [])).push(road.id);
    }

    /* 过河路段稍后（水系生成之后）统一升级为桥梁，见第 7 步之后的 7.1 */

    var intersections = [];
    var nodesById = {};
    for (i = 0; i < rawNodes.length; i++) {
      var nd = rawNodes[i];
      var rids = nodeRoads[nd.id] || [];
      if (!rids.length) continue;
      var it = {
        id: nd.id, x: nd.x, z: nd.z,
        degree: rids.length, roadIds: rids,
        districtId: districtIdAtRaw(nd.x, nd.z, districts, noise),
        signalId: null, lat: null, lng: null
      };
      intersections.push(it);
      nodesById[it.id] = it;
    }

    /* ---------- 5.2 立交：把一个交叉点拆成"高架层 / 地面层"两个节点 ----------
       真实的高架快速路与地面道路相交时是跨过去，不是路口（无信号、不能转弯）。
       原先平面细分在每个交叉点只建一个节点，于是快速路上长满了路口，
       整张图既不读作快速路，也不读作城市。
       注意：**不能简单删掉地面路的邻接** —— 那会把地面路截断成两段死路。
       正确做法是同坐标建两个节点、各挂各的路，高度差交给 3D 层去画。
       ⚠️ 必须在建 graph 邻接**之前**做，否则改不动 road.from/to。 */
    var gradeSepCount = 0;
    var interchangeCount2 = 0;
    (function () {
      /* 先收集"同一点上既有快速路又有地面道路"的候选 */
      var cands = [];
      for (i = 0; i < intersections.length; i++) {
        var it3 = intersections[i];
        var expIds = [], surfIds = [];
        for (var q = 0; q < it3.roadIds.length; q++) {
          var rc = roadsById[it3.roadIds[q]];
          if (!rc) continue;
          if (rc.cls === 'expressway') expIds.push(rc.id); else surfIds.push(rc.id);
        }
        if (!expIds.length || !surfIds.length) continue;
        cands.push({ it: it3, exp: expIds, surf: surfIds });
      }

      /* 互通立交（有匝道、可上下快速路）必须保留连通：
         真实快速路每隔 1~2 km 才有出入口，不可能每个交叉都互通；
         但一个互通都没有也不行 —— 那样快速路在图上完全不可达，OD 寻路也用不上它。
         做法：按坐标排序后贪心挑选，彼此间隔 >= 190 世界单位（950 米）的设为互通。 */
      cands.sort(function (a, b) {
        return (a.it.x - b.it.x) || (a.it.z - b.it.z);
      });
      var chosen = [];
      for (var ci = 0; ci < cands.length; ci++) {
        var cd = cands[ci];
        var ok = true;
        for (var cj = 0; cj < chosen.length; cj++) {
          if (U.dist(cd.it.x, cd.it.z, chosen[cj].x, chosen[cj].z) < 190) { ok = false; break; }
        }
        if (ok) {
          chosen.push(cd.it);
          cd.it.gradeSeparated = true;
          cd.it.deck = 'interchange';     /* 互通：两层都连通 */
          cd.it.signalId = null;
          interchangeCount2++;
        } else {
          cd.it._split = true;            /* 纯跨线：要拆成两层 */
        }
      }

      /* 纯跨线的节点：拆成"高架层 / 地面层"两个同坐标节点 */
      var newNodes = [];
      var seq = 0;
      for (ci = 0; ci < cands.length; ci++) {
        var c2 = cands[ci];
        if (!c2.it._split) continue;
        delete c2.it._split;
        var it4 = c2.it;
        var exp2 = c2.exp, surf2 = c2.surf;
        var expNodeId = 'NX' + String(++seq).padStart(4, '0');
        it4.gradeSeparated = true;
        it4.deck = 'surface';
        it4.signalId = null;
        it4.roadIds = surf2;
        it4.degree = surf2.length;
        for (var w = 0; w < exp2.length; w++) {
          var rw = roadsById[exp2[w]];
          if (!rw) continue;
          if (rw.from === it4.id) rw.from = expNodeId;
          else if (rw.to === it4.id) rw.to = expNodeId;
        }
        newNodes.push({
          id: expNodeId, x: it4.x, z: it4.z,
          degree: exp2.length, roadIds: exp2,
          districtId: it4.districtId,
          signalId: null, lat: null, lng: null,
          gradeSeparated: true, deck: 'viaduct'
        });
      }
      for (var z2 = 0; z2 < newNodes.length; z2++) {
        intersections.push(newNodes[z2]);
        nodesById[newNodes[z2].id] = newNodes[z2];
      }
      gradeSepCount = newNodes.length;
    })();

    var graph = { nodes: {}, adjacency: {} };
    for (i = 0; i < roads.length; i++) {
      var r = roads[i];
      if (!graph.nodes[r.from]) graph.nodes[r.from] = { x: 0, z: 0, roads: [] };
      if (!graph.nodes[r.to]) graph.nodes[r.to] = { x: 0, z: 0, roads: [] };
      graph.nodes[r.from].roads.push(r.id);
      graph.nodes[r.to].roads.push(r.id);
    }
    for (i = 0; i < intersections.length; i++) {
      var n2 = intersections[i];
      if (graph.nodes[n2.id]) { graph.nodes[n2.id].x = n2.x; graph.nodes[n2.id].z = n2.z; }
    }
    for (i = 0; i < roads.length; i++) {
      var rr2 = roads[i];
      (graph.adjacency[rr2.from] || (graph.adjacency[rr2.from] = []))
        .push({ roadId: rr2.id, to: rr2.to, lengthM: rr2.lengthM, cls: rr2.cls });
      if (!rr2.oneway) {
        (graph.adjacency[rr2.to] || (graph.adjacency[rr2.to] = []))
          .push({ roadId: rr2.id, to: rr2.from, lengthM: rr2.lengthM, cls: rr2.cls });
      }
    }

    /* ---------- 6. 行政区面积 & 路网里程 ---------- */
    for (i = 0; i < districts.length; i++) {
      d = districts[i];
      d.areaKm2 = U.round(U.polygonArea(d.polygon) * UNIT_M * UNIT_M / 1e6, 2);
      d.center = U.polygonCentroid(d.polygon);
      d.center = { x: U.round(d.center.x, 1), z: U.round(d.center.z, 1) };
    }
    for (i = 0; i < roads.length; i++) {
      var dd2 = districtMapById(districts)[roads[i].districtId];
      if (dd2) dd2.roadKm += roads[i].lengthM / 1000;
    }
    for (i = 0; i < districts.length; i++) {
      districts[i].roadKm = U.round(districts[i].roadKm, 1);
    }

    /* ---------- 7. 水系 / 绿地 ---------- */
    var waterways = buildWaterways(rng);
    var greenlands = buildGreenlands(rng, districts);

    /* ---------- 7.1 过河路段升级为桥梁 ----------
       原先道路是直接"浮"在水面上的，读起来像画错了。真实城市跨河必然是桥：
       抬高桥面 + 两侧设桥墩，视觉上立刻说得通，也解释了为什么这里没有红绿灯。 */
    var bridgeCount = 0;
    for (i = 0; i < roads.length; i++) {
      var rdw = roads[i];
      if (rdw.structure !== 'surface') continue;
      var midW = rdw.path[0];
      if (!inWater(midW.x, midW.z, waterways)) continue;
      rdw.structure = 'bridge';
      rdw.elevW = rdw.cls === 'expressway' ? 1.9 : 1.4;
      rdw.piers = true;
      bridgeCount++;
    }

    /* ---------- 8. 建筑 ---------- */
    /* 注意：溶解直通节点之后，一条 road.path 是多点折线（不再是两点），
       必须把**每一小段**都加进索引 —— 只索引 path[0]→path[1] 会让建筑
       长在道路中段上（实测漏检 68 栋）。 */
    var segIndex = new SegIndex(70);
    for (i = 0; i < roads.length; i++) {
      var rp = roads[i].path;
      for (k = 0; k < rp.length - 1; k++) {
        segIndex.add({ a: rp[k], b: rp[k + 1] });
      }
    }
    var buildings = buildBuildings(rng, noise, districts, segIndex, waterways, greenlands);

    /* ---------- 9. 信号控制 ----------
       只给"真正该设信号"的交叉口配信号灯：
         · 含快速路的节点是立交（匝道分流），不设信号
         · 纯支路交叉口不设信号
         · 至少要有主干路或次干路参与，且 degree>=3 */
    var signals = [];
    var signalsById = {};
    var sigArt = [], sigSec = [];
    for (i = 0; i < intersections.length; i++) {
      var it2 = intersections[i];
      if (it2.degree < 3) continue;
      if (it2.deck === 'viaduct') continue;             /* 高架层不设信号灯 */
      var clss = it2.roadIds.map(function (id) { return roadsById[id] ? roadsById[id].cls : ''; });
      if (clss.indexOf('expressway') >= 0) continue;
      if (clss.indexOf('arterial') >= 0) sigArt.push(it2);
      else if (clss.indexOf('secondary') >= 0) sigSec.push(it2);
    }
    function byDegreeDesc(a2, b2) {
      if (b2.degree !== a2.degree) return b2.degree - a2.degree;
      return a2.id < b2.id ? -1 : 1;
    }
    sigArt.sort(byDegreeDesc);
    sigSec.sort(byDegreeDesc);
    /* 主干路优先占用信号配额。
       否则会出现"长干道走廊上一个信号灯都没有"的情况 —— 绿波带与信号配时看板会空掉。 */
    var sigCandidates = sigArt.concat(sigSec);
    /* 信号路口规模：本市 3674 条路段 / 7.7 km·km⁻²，真实城市信号路口是上千个量级。
       配额太小会让长干道走廊分不到信号灯，"信号配时 / 绿波带"看板会空。 */
    var maxSignals = Math.min(900, sigCandidates.length);
    for (i = 0; i < maxSignals; i++) {
      var node3 = sigCandidates[i];
      var nearRoads = node3.roadIds.map(function (id) { return roadsById[id]; }).filter(Boolean);
      var hasMajor = nearRoads.some(function (x) {
        return x.cls === 'expressway' || x.cls === 'arterial';
      });
      var cycle = hasMajor ? rng.int(120, 160) : rng.int(90, 130);
      var nApp = U.clamp(node3.degree, 2, 4);
      var apprs = [];
      var greenTotal = cycle - nApp * 3;
      var base = Math.floor(greenTotal / nApp);
      var rem = greenTotal - base * nApp;
      var dirs = ['N', 'S', 'E', 'W'];
      for (k = 0; k < nApp; k++) {
        var gg = base + (k < rem ? 1 : 0);
        apprs.push({
          dir: dirs[k], green: gg, yellow: 3, red: cycle - gg - 3,
          leftTurnRatio: U.round(rng.range(0.12, 0.34), 2)
        });
      }
      var sg = {
        id: 'S' + String(i + 1).padStart(4, '0'),
        intersectionId: node3.id,
        x: node3.x, z: node3.z,
        cycle: cycle,
        approaches: apprs,
        coordGroup: null
      };
      signals.push(sg);
      signalsById[sg.id] = sg;
      node3.signalId = sg.id;
    }

    /* ---------- 10. 关键走廊 ---------- */
    var pf = new Pathfinder(graph);
    var corridors = buildCorridors(roads, graph, pf, rng);
    var corridorMap = {};
    for (i = 0; i < corridors.length; i++) {
      corridorMap[corridors[i].id] = corridors[i];
      for (k = 0; k < corridors[i].roadIds.length; k++) {
        roadsById[corridors[i].roadIds[k]].corridorId = corridors[i].id;
      }
    }
    /* 补齐走廊沿线的信号机序列（绿波带要用）——同时记录弧长位置 */
    for (i = 0; i < corridors.length; i++) {
      var sigList = corridorSignals(corridors[i], signals, roadsById);
      corridors[i].signalIds = sigList.map(function (x) { return x.id; });
      corridors[i].signalArcs = sigList.map(function (x) { return U.round(x.arc, 2); });
    }

    /* ---------- 11. 信号协调分组（每个走廊一组，做绿波） ---------- */
    for (i = 0; i < corridors.length; i++) {
      var cg = 'CG' + String(i + 1).padStart(2, '0');
      var c = corridors[i];
      for (k = 0; k < c.signalIds.length; k++) {
        var s3 = signalsById[c.signalIds[k]];
        if (s3) s3.coordGroup = cg;
      }
    }
    /* 未进走廊的信号按行政区归组 */
    for (i = 0; i < signals.length; i++) {
      if (signals[i].coordGroup) continue;
      var dId = districtIdAtRaw(signals[i].x, signals[i].z, districts, noise);
      signals[i].coordGroup = 'CGX-' + dId;
    }

    /* ---------- 12. 公共交通 ---------- */
    var transit = buildTransit(rng, graph, pf, roads, roadsById, districts, signals);

    /* ---------- 13. 静态设施 ---------- */
    var facilities = buildFacilities(rng, roads, districts, greenlands, transit);

    /* ---------- 14. meta ---------- */
    var totalRoadM = 0, areaTotal = 0, popTotal = 0;
    for (i = 0; i < roads.length; i++) totalRoadM += roads[i].lengthM;
    for (i = 0; i < districts.length; i++) { areaTotal += districts[i].areaKm2; popTotal += districts[i].population; }

    var data = {
      meta: {
        name: opt.name,
        extent: opt.extent,
        unitMeters: UNIT_M,
        seed: opt.seed,
        districts: districts.length,
        roadCount: roads.length,
        nodeCount: intersections.length,
        buildingCount: buildings.length,
        signalCount: signals.length,
        corridorCount: corridors.length,
        bridgeCount: bridgeCount,
        gradeSepCount: gradeSepCount,
        interchangeCount: interchangeCount2,
        roadKm: U.round(totalRoadM / 1000, 1),
        areaKm2: U.round(areaTotal, 2),
        population: U.round(popTotal, 1),
        buildMs: 0
      },
      districts: districts,
      roads: roads,
      intersections: intersections,
      graph: graph,
      buildings: buildings,
      waterways: waterways,
      greenlands: greenlands,
      transit: transit,
      facilities: facilities,
      signals: signals,
      corridors: corridors
    };

    /* 清掉内部字段 */
    for (i = 0; i < districts.length; i++) delete districts[i]._def;
    for (i = 0; i < roads.length; i++) {
      delete roads[i]._kind;
      delete roads[i]._dupLines;
      delete roads[i]._rev;
      delete roads[i]._line;
      delete roads[i]._split;
    }

    data.meta.buildMs = Math.round(U.now() - t0);

    built = data;
    buildOptions = opt;
    _index(data);
    return data;
  }

  /* ------------------------------------------------------------------ *
   * 溶解"直通节点"
   *
   * 平面细分会在**每个**交叉点建节点，把一条街切成很多碎段 —— 实测段长
   * p05 = 2.8 世界单位（14 米）、25% 的段短于 50 米。后果很直观：
   * 交叉口圆盘的半径是路段半宽（最大 4.7），两端圆盘一盖，
   * 14% 的路段被完全遮住、另有 9% 几乎遮住，画面上就只剩"一个个小圆"。
   *
   * 真实路网里，"路段"是相邻两个**路口**之间的一段；度为 2、且两条边属于
   * 同一条命名线的节点只是几何折点，不是路口。把这类节点溶掉（两段并一段），
   * 段长立刻回到 100~400 米的真实量级。
   * ------------------------------------------------------------------ */
  function dissolvePassThrough(nodes, edges) {
    var deg = {}, inc = {}, i, k;
    for (i = 0; i < nodes.length; i++) { deg[nodes[i].id] = 0; inc[nodes[i].id] = []; }
    for (i = 0; i < edges.length; i++) {
      var e = edges[i];
      deg[e.a] = (deg[e.a] || 0) + 1; inc[e.a].push(e);
      deg[e.b] = (deg[e.b] || 0) + 1; inc[e.b].push(e);
    }
    function isPass(nodeId) {
      if ((deg[nodeId] || 0) !== 2) return false;
      var l = inc[nodeId];
      return l.length === 2 && l[0].line === l[1].line;
    }

    var consumed = {};
    var out = [];
    for (i = 0; i < edges.length; i++) {
      var head = edges[i];
      if (consumed[head.id]) continue;

      /* 先往回退到链的真正起点（否则从中间出发会把前半截漏掉） */
      var startNode = head.a, back = head, g2 = 0;
      while (isPass(startNode) && g2++ < 4000) {
        var cs = inc[startNode];
        var prev = (cs[0] === back) ? cs[1] : cs[0];
        if (!prev || consumed[prev.id]) break;
        back = prev;
        startNode = (prev.a === startNode) ? prev.b : prev.a;
      }

      var path = [], cur = back, curNode = startNode, lastNode = startNode;
      var guard = 0;
      while (cur && guard++ < 4000) {
        if (consumed[cur.id] && cur !== back) break;
        consumed[cur.id] = 1;
        var fwd = (cur.a === curNode);
        var pts = fwd ? cur.path : [cur.path[1], cur.path[0]];
        for (k = (path.length ? 1 : 0); k < pts.length; k++) path.push(pts[k]);
        var nextNode = fwd ? cur.b : cur.a;
        lastNode = nextNode;
        if (!isPass(nextNode)) break;
        var cands = inc[nextNode];
        var nxt = (cands[0] === cur) ? cands[1] : cands[0];
        if (!nxt || consumed[nxt.id]) break;
        cur = nxt;
        curNode = nextNode;
      }
      if (path.length < 2) continue;

      var lenW = 0;
      for (k = 0; k < path.length - 1; k++) {
        var dx = path[k + 1].x - path[k].x, dz = path[k + 1].z - path[k].z;
        lenW += Math.sqrt(dx * dx + dz * dz);
      }
      out.push({
        id: head.id,
        a: startNode, b: lastNode,
        path: path,
        lengthW: lenW,
        lengthM: Math.round(lenW * UNIT_M),
        line: back.line,
        dupLines: []
      });
    }

    edges.length = 0;
    for (i = 0; i < out.length; i++) edges.push(out[i]);

    /* 回收被溶掉的节点 */
    var used = {};
    for (i = 0; i < edges.length; i++) { used[edges[i].a] = 1; used[edges[i].b] = 1; }
    var kn = [];
    for (i = 0; i < nodes.length; i++) if (used[nodes[i].id]) kn.push(nodes[i]);
    nodes.length = 0;
    for (i = 0; i < kn.length; i++) nodes.push(kn[i]);
  }

  /* ------------------------------------------------------------------ *
   * 剪枝：反复删除"度=1 且相邻边极短"的悬挂末端
   * ------------------------------------------------------------------ */
  function pruneDangling(nodes, edges, minLen) {
    var pass, i;
    /* 注意：必须就地改写这两个数组（调用方持有的是同一引用），
       不能 `edges = edges.filter(...)` 否则调用方拿到的仍是未剪枝的数组 */
    for (pass = 0; pass < 6; pass++) {
      var deg = {};
      for (i = 0; i < edges.length; i++) {
        deg[edges[i].a] = (deg[edges[i].a] || 0) + 1;
        deg[edges[i].b] = (deg[edges[i].b] || 0) + 1;
      }
      var keep = [];
      var removed = 0;
      for (i = 0; i < edges.length; i++) {
        var e = edges[i];
        if (e.lengthW < minLen && ((deg[e.a] || 0) === 1 || (deg[e.b] || 0) === 1)) {
          removed++;
          continue;
        }
        keep.push(e);
      }
      if (!removed) break;
      edges.length = 0;
      for (i = 0; i < keep.length; i++) edges.push(keep[i]);
    }
    /* 回收孤立节点 */
    var used = {};
    for (i = 0; i < edges.length; i++) { used[edges[i].a] = 1; used[edges[i].b] = 1; }
    var kn = [];
    for (i = 0; i < nodes.length; i++) if (used[nodes[i].id]) kn.push(nodes[i]);
    nodes.length = 0;
    for (i = 0; i < kn.length; i++) nodes.push(kn[i]);
  }

  /* ------------------------------------------------------------------ *
   * 行政区归属（多边形判定 + 最近中心兜底）
   * ------------------------------------------------------------------ */
  function districtIdAtRaw(x, z, districts, noise) {
    for (var i = 0; i < districts.length; i++) {
      if (U.pointInPolygon(x, z, districts[i].polygon)) return districts[i].id;
    }
    /* 兜底：取中心最近者 */
    var best = districts[0].id, bd = Infinity;
    for (var j = 0; j < districts.length; j++) {
      var c = districts[j].center;
      if (!c) continue;
      var d = U.dist2(x, z, c.x, c.z);
      if (d < bd) { bd = d; best = districts[j].id; }
    }
    return best;
  }

  var _districtMap = null;
  function districtMapById(districts) {
    if (_districtMap && _districtMap._src === districts) return _districtMap;
    var m = { _src: districts };
    for (var i = 0; i < districts.length; i++) m[districts[i].id] = districts[i];
    _districtMap = m;
    return m;
  }

  /* ------------------------------------------------------------------ *
   * 水系
   * ------------------------------------------------------------------ */
  function buildWaterways(rng) {
    var riverPath = [];
    var ctrl = [
      { x: -1060, z: 820 }, { x: -880, z: 640 }, { x: -730, z: 470 },
      { x: -600, z: 320 }, { x: -520, z: 160 }, { x: -500, z: -20 },
      { x: -556, z: -220 }, { x: -660, z: -420 }, { x: -800, z: -640 },
      { x: -940, z: -860 }, { x: -1060, z: -1040 }
    ];
    var i, k;
    for (i = 0; i < ctrl.length - 1; i++) {
      for (k = 0; k < 6; k++) {
        var t = k / 6;
        riverPath.push({
          x: U.lerp(ctrl[i].x, ctrl[i + 1].x, t),
          z: U.lerp(ctrl[i].z, ctrl[i + 1].z, t)
        });
      }
    }
    riverPath.push(ctrl[ctrl.length - 1]);

    var lakePts = [];
    var lakeC = { x: 402, z: 392 };
    for (k = 0; k < 40; k++) {
      var a = k / 40 * TWO_PI;
      var rr = 1 + 0.18 * Math.sin(3 * a + 0.7) + 0.09 * Math.sin(5 * a);
      lakePts.push({ x: lakeC.x + 118 * rr * Math.cos(a), z: lakeC.z + 92 * rr * Math.sin(a) });
    }

    return [
      { name: '澜江', kind: 'river', path: riverPath, width: 46 },
      { name: '云澜湖', kind: 'lake', path: lakePts, width: 0 }
    ];
  }

  function inWater(x, z, waterways) {
    for (var i = 0; i < waterways.length; i++) {
      var w = waterways[i];
      if (w.kind === 'lake') {
        if (U.pointInPolygon(x, z, w.path.map(function (p) { return [p.x, p.z]; }))) return true;
      } else {
        if (U.distToPolyline(x, z, w.path) < w.width * 0.62) return true;
      }
    }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * 绿地
   * ------------------------------------------------------------------ */
  function buildGreenlands(rng, districts) {
    var out = [];
    var parks = [
      { name: '中央公园', x: 0, z: 0, r: 96 },
      { name: '云澜湖公园', x: 402, z: 392, r: 150 },
      { name: '望山森林公园', x: -300, z: -420, r: 132 },
      { name: '滨江生态廊道', x: -560, z: 180, r: 118 },
      { name: '城东体育公园', x: 520, z: 90, r: 104 },
      { name: '城南植物园', x: 150, z: 560, r: 112 },
      { name: '高新科创绿廊', x: -380, z: -110, r: 88 },
      { name: '空港迎宾绿地', x: 330, z: -520, r: 96 }
    ];
    for (var i = 0; i < parks.length; i++) {
      var p = parks[i];
      var poly = [];
      for (var k = 0; k < 28; k++) {
        var a = k / 28 * TWO_PI;
        var rr = p.r * (1 + 0.16 * Math.sin(3 * a + i) + 0.08 * Math.sin(5 * a + i * 2));
        poly.push([p.x + rr * Math.cos(a), p.z + rr * Math.sin(a)]);
      }
      out.push({ name: p.name, polygon: poly, districtId: districtIdAtRaw(p.x, p.z, districts, null) });
    }
    return out;
  }

  function inGreen(x, z, greenlands) {
    for (var i = 0; i < greenlands.length; i++) {
      if (U.pointInPolygon(x, z, greenlands[i].polygon)) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * 建筑生成
   * ------------------------------------------------------------------ */
  function buildBuildings(rng, noise, districts, segIndex, waterways, greenlands) {
    var out = [];
    var i, k;
    for (i = 0; i < districts.length; i++) {
      var d = districts[i];
      var area = d.areaKm2 || 40;
      var target = buildingCountFor(DISTRICT_DEF_BY_ID(d.id), area);
      if (d.id === 'core') target = 420;
      var polyArr = d.polygon;          // [[x,z], ...] 契约形态
      var poly = d._polyPts;            // { x, z } 形态，便于计算
      /* 该区包围盒 */
      var minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (k = 0; k < poly.length; k++) {
        if (poly[k].x < minX) minX = poly[k].x;
        if (poly[k].x > maxX) maxX = poly[k].x;
        if (poly[k].z < minZ) minZ = poly[k].z;
        if (poly[k].z > maxZ) maxZ = poly[k].z;
      }
      var isCore = d.id === 'core';
      /* 格位尺寸必须显著小于"路网退让后的可用缝隙"，
         否则实际落位数量会被格位数卡死（实测过 24 只能落到目标的一半） */
      var cell = isCore ? 12 : 18;
      var grng = rng.fork('bld:' + d.id);
      var maxH = 0;
      /* 系统化扫描整个包围盒（打散访问顺序，避免因上限截断而偏向某一角），
         比随机撒点更可靠地逼近目标数量 */
      var nx = Math.max(1, Math.floor((maxX - minX) / cell));
      var nz = Math.max(1, Math.floor((maxZ - minZ) / cell));
      var cells = [];
      for (var cxg = 0; cxg <= nx; cxg++) {
        for (var czg = 0; czg <= nz; czg++) cells.push(cxg * 4096 + czg);
      }
      cells = grng.shuffle(cells);
      var placed = 0;

      for (var ci = 0; ci < cells.length && placed < target; ci++) {
        var gx = Math.floor(cells[ci] / 4096);
        var gz = cells[ci] % 4096;
        var px = minX + gx * cell + grng.range(-cell * 0.30, cell * 0.30);
        var pz = minZ + gz * cell + grng.range(-cell * 0.30, cell * 0.30);
        if (px < minX || px > maxX || pz < minZ || pz > maxZ) continue;
        if (!U.pointInPolygon(px, pz, polyArr)) continue;
        if (inWater(px, pz, waterways)) continue;
        if (inGreen(px, pz, greenlands)) continue;

        var w = isCore ? grng.range(7, 15) : grng.range(12, 26);
        var dp = isCore ? grng.range(7, 15) : grng.range(12, 26);
        /* 中心城区建筑贴近街道（CBD 就该是这样），外围留出绿化/人行退让 */
        var clear = Math.max(w, dp) * 0.5 + (isCore ? 3.0 : 5.0);
        var near = segIndex.near(px, pz);
        var clash = false;
        if (near) {
          for (k = 0; k < near.length; k++) {
            if (distSeg(px, pz, near[k].a, near[k].b) < clear) { clash = true; break; }
          }
        }
        if (clash) continue;

        /* 高度：区基准 × 距中心衰减 × 噪声 */
        var distC = U.dist(px, pz, 0, 0);
        var falloff = U.clamp(1 - Math.pow(distC / 900, 1.35), 0.16, 1);
        var nz = U.fbm(noise, px / 210, pz / 210, 3, 2, 0.55);
        var hMul = 0.45 + 0.9 * (nz * 0.5 + 0.5);
        var def = DISTRICT_DEF_BY_ID(d.id);
        var h = def.hBase * (0.42 + def.hSpread) * falloff * hMul;
        h = U.clamp(h, 9, 210);

        var type = pickType(def, grng);
        if (type === 'res') h = Math.min(h, 62);
        if (type === 'industrial') { h = Math.min(h, 34); w = Math.max(w, 20); dp = Math.max(dp, 22); }
        if (type === 'mall') h = Math.min(h, 74);

        out.push({
          x: U.round(px, 1), z: U.round(pz, 1),
          w: U.round(w, 1), d: U.round(dp, 1), h: U.round(h, 1),
          rot: U.round(grng.range(-0.22, 0.22), 3),
          type: type, districtId: d.id, name: ''
        });
        placed++;
        if (h > maxH) maxH = h;
      }
    }

    /* 地标：每区最高的若干栋升级为 landmark 并命名 */
    var byDistrict = {};
    for (i = 0; i < out.length; i++) {
      (byDistrict[out[i].districtId] || (byDistrict[out[i].districtId] = [])).push(out[i]);
    }
    var nameIdx = 0;
    for (i = 0; i < districts.length; i++) {
      var list = byDistrict[districts[i].id] || [];
      list.sort(function (a, b) { return b.h - a.h; });
      var want = DISTRICT_DEF_BY_ID(districts[i].id).landmark;
      for (k = 0; k < Math.min(want, list.length); k++) {
        var b = list[k];
        b.type = 'landmark';
        b.h = U.round(b.h * 1.55, 1);
        b.w = U.round(b.w * 1.16, 1);
        b.d = U.round(b.d * 1.16, 1);
        b.name = BUILDING_NAMES[nameIdx % BUILDING_NAMES.length];
        nameIdx++;
      }
    }
    return out;
  }

  function DISTRICT_DEF_BY_ID(id) {
    for (var i = 0; i < DISTRICT_DEF.length; i++) {
      if (DISTRICT_DEF[i].id === id) return DISTRICT_DEF[i];
    }
    return DISTRICT_DEF[0];
  }

  /* ------------------------------------------------------------------ *
   * 关键走廊
   * ------------------------------------------------------------------ */

  /** 把点投影到折线上，返回 { t: 归一化弧长, arcW: 弧长(世界单位), dist: 垂距 } */
  function projectOnPath(x, z, path) {
    if (!path || path.length < 2) return null;
    var total = 0, i, segs = [];
    for (i = 0; i < path.length - 1; i++) {
      var a = path[i], b = path[i + 1];
      var dx = b.x - a.x, dz = b.z - a.z;
      var L = Math.sqrt(dx * dx + dz * dz);
      segs.push({ a: a, dx: dx, dz: dz, L: L, acc: total });
      total += L;
    }
    if (total < 1e-6) return { t: 0, arcW: 0, dist: U.dist(x, z, path[0].x, path[0].z) };
    var best = null;
    for (i = 0; i < segs.length; i++) {
      var s = segs[i];
      var k = s.L < 1e-9 ? 0 : U.clamp01(((x - s.a.x) * s.dx + (z - s.a.z) * s.dz) / (s.L * s.L));
      var px = s.a.x + s.dx * k, pz = s.a.z + s.dz * k;
      var d = U.dist(x, z, px, pz);
      if (!best || d < best.dist) {
        var arcW = s.acc + s.L * k;
        best = { t: arcW / total, arcW: arcW, dist: d };
      }
    }
    return best;
  }

  /** 沿走廊取信号机：只收编**属于走廊自身路段端点**的交叉口上的信号，
   *  再按投影弧长排序，保证顺序严格沿走廊单调（绿波相位差依赖这个顺序） */
  function corridorSignals(corridor, signals, roadsById) {
    var path = corridor.path || [];
    if (!path.length || !signals || !signals.length) return [];
    var nodeSet = {};
    for (var i = 0; i < corridor.roadIds.length; i++) {
      var r = roadsById[corridor.roadIds[i]];
      if (!r) continue;
      nodeSet[r.from] = 1;
      nodeSet[r.to] = 1;
    }
    var cand = [];
    for (var k = 0; k < signals.length; k++) {
      var sg = signals[k];
      if (!nodeSet[sg.intersectionId]) continue;
      var pr = projectOnPath(sg.x, sg.z, path);
      if (!pr) continue;
      cand.push({ id: sg.id, arc: pr.arcW, dist: pr.dist });
    }
    cand.sort(function (a, b) { return a.arc - b.arc; });
    var out = [], seen = {};
    for (var q = 0; q < cand.length; q++) {
      if (seen[cand[q].id]) continue;
      seen[cand[q].id] = 1;
      out.push(cand[q]);
    }
    return out;
  }

  function buildCorridors(roads, graph, pf, rng) {
    var groups = {};
    for (var i = 0; i < roads.length; i++) {
      var r = roads[i];
      if (r.cls !== 'arterial' && r.cls !== 'expressway') continue;
      var key = r._kind + '|' + r.name;
      (groups[key] || (groups[key] = [])).push(r);
    }
    var keys = Object.keys(groups);
    /* 按总里程排序，取最长的 8 条 */
    keys.sort(function (a, b) {
      var la = 0, lb = 0, j;
      for (j = 0; j < groups[a].length; j++) la += groups[a][j].lengthM;
      for (j = 0; j < groups[b].length; j++) lb += groups[b][j].lengthM;
      return lb - la;
    });
    var corridors = [];
    for (var k = 0; k < Math.min(8, keys.length); k++) {
      var list = groups[keys[k]];
      if (list.length < 3) continue;

      /* 排序方式：把每段中点投影回**原始折线**求弧长，按弧长排序。
         这比贪心游走可靠得多 —— 之前的贪心游走在岔口/自交处会停，
         导致走廊只拼出一半（实测外环高速 163 段只拼入 83 段，长度差一半）。
         环路（闭合折线）用同一套逻辑也对：弧长 0→1 绕一圈。 */
      var ln = list[0]._line;
      var ordered = [];
      for (var q = 0; q < list.length; q++) {
        var seg = list[q];
        var a0 = seg.path[0], b0 = seg.path[1];
        var pa = ln ? projectOnPath(a0.x, a0.z, ln.pts) : null;
        var pb = ln ? projectOnPath(b0.x, b0.z, ln.pts) : null;
        var t0 = pa ? pa.t : 0;
        var t1 = pb ? pb.t : 0;
        ordered.push({ seg: seg, tMid: (t0 + t1) / 2, rev: t1 < t0 });
      }
      ordered.sort(function (a, b) { return a.tMid - b.tMid; });

      var chain = [];
      var path = [];
      for (var m2 = 0; m2 < ordered.length; m2++) {
        var o2 = ordered[m2];
        chain.push(o2.seg);
        var dir = o2.rev ? [o2.seg.path[1], o2.seg.path[0]] : o2.seg.path;
        for (var q3 = 0; q3 < dir.length; q3++) path.push(dir[q3]);
      }
      if (chain.length < 3) continue;
      var km = 0, dset = {};
      for (m2 = 0; m2 < chain.length; m2++) { km += chain[m2].lengthM / 1000; dset[chain[m2].districtId] = 1; }
      var cid = 'C' + String(k + 1).padStart(2, '0');
      corridors.push({
        id: cid,
        name: chain[0].name + '走廊',
        roadIds: chain.map(function (x) { return x.id; }),
        path: path,
        lengthKm: U.round(km, 2),
        districtIds: Object.keys(dset),
        signalIds: [],
        recommendedSpeed: chain[0].cls === 'expressway' ? 60 : 45,
        cls: chain[0].cls
      });
    }
    return corridors;
  }

  /** 把一堆散乱同向边拼成链（简单贪心：从度最小端出发沿邻接走） */
  function chainEdges(edges, graph) {
    if (edges.length <= 1) return edges.slice();
    var byFrom = {}, byTo = {}, i;
    for (i = 0; i < edges.length; i++) {
      (byFrom[edges[i].from] || (byFrom[edges[i].from] = [])).push(edges[i]);
      (byTo[edges[i].to] || (byTo[edges[i].to] = [])).push(edges[i]);
    }
    /* 找起点：某个端点只出现一次 */
    var degCount = {};
    for (i = 0; i < edges.length; i++) {
      degCount[edges[i].from] = (degCount[edges[i].from] || 0) + 1;
      degCount[edges[i].to] = (degCount[edges[i].to] || 0) + 1;
    }
    var start = null;
    for (var key in degCount) {
      if (degCount[key] === 1) { start = key; break; }
    }
    if (start === null) start = edges[0].from;
    /* 贪心游走 */
    var used = {}, chain = [], cur = start;
    /* 贪心游走时优先选"最直的下一步"，而不是数组里的第一条 ——
       否则走到环路/交叉处会被拐进支线，走廊只拼出一半（实测外环高速只拼到 9.9km / 应为 19.5km）。 */
    var dirX = 0, dirZ = 0, hasDir = false;
    for (var guard = 0; guard < edges.length * 4; guard++) {
      var cands = [];
      if (byFrom[cur]) cands = cands.concat(byFrom[cur]);
      if (byTo[cur]) cands = cands.concat(byTo[cur]);
      var next = null, bestScore = -2;
      for (i = 0; i < cands.length; i++) {
        var c = cands[i];
        if (used[c.id]) continue;
        var revC = (c.to === cur);
        var q0 = revC ? c.path[1] : c.path[0];
        var q1 = revC ? c.path[0] : c.path[1];
        var vx = q1.x - q0.x, vz = q1.z - q0.z;
        var vl = Math.sqrt(vx * vx + vz * vz) || 1;
        var score = hasDir ? ((vx / vl) * dirX + (vz / vl) * dirZ) : 0;
        if (score > bestScore) { bestScore = score; next = c; }
      }
      if (!next) break;
      used[next.id] = 1;
      var rev = (next.to === cur);
      next._rev = rev;
      chain.push(next);
      var fromP = rev ? next.path[1] : next.path[0];
      var toP = rev ? next.path[0] : next.path[1];
      var dx2 = toP.x - fromP.x, dz2 = toP.z - fromP.z;
      var dl2 = Math.sqrt(dx2 * dx2 + dz2 * dz2) || 1;
      dirX = dx2 / dl2; dirZ = dz2 / dl2; hasDir = true;
      cur = rev ? next.from : next.to;
    }
    if (!chain.length) return edges.slice();
    return chain;
  }

  /* ------------------------------------------------------------------ *
   * 公共交通
   * ------------------------------------------------------------------ */
  function buildTransit(rng, graph, pf, roads, roadsById, districts, signals) {
    var nodeIds = Object.keys(graph.nodes);
    var metroColors = ['#c0392b', '#1a5fb4', '#2b8a3e', '#e8a33d', '#6f5bd6'];
    var metroLines = [];
    var usedNames = {};
    var nameCursor = 0;

    function nextStationName(fallback) {
      for (var t = 0; t < STATION_NAMES.length * 2; t++) {
        var nm = STATION_NAMES[(nameCursor++) % STATION_NAMES.length];
        if (!usedNames[nm]) { usedNames[nm] = 1; return nm; }
      }
      return fallback;
    }

    /* 找离指定方向最远的节点，用作线路端点 */
    function farNode(dx, dz) {
      var best = nodeIds[0], bs = -Infinity;
      for (var i = 0; i < nodeIds.length; i++) {
        var n = graph.nodes[nodeIds[i]];
        var s = n.x * dx + n.z * dz;
        if (s > bs) { bs = s; best = nodeIds[i]; }
      }
      return best;
    }

    var metroDefs = [
      { dx: -1, dz: 0, ex: 1, ez: 0, name: '地铁1号线' },
      { dx: 0, dz: -1, ex: 0, ez: 1, name: '地铁2号线' },
      { dx: -0.7, dz: -0.7, ex: 0.7, ez: 0.7, name: '地铁3号线' },
      { dx: 0.7, dz: -0.7, ex: -0.7, ez: 0.7, name: '地铁4号线' },
      { dx: -1, dz: 0.35, ex: 1, ez: -0.35, name: '地铁5号线' }
    ];

    /* 地铁偏好快速路/主干路 */
    function metroWeight(e) {
      var c = e.cls === 'expressway' ? 0.55 : (e.cls === 'arterial' ? 0.8 :
              (e.cls === 'secondary' ? 1.5 : 3.2));
      return e.lengthM * c;
    }

    for (var mi = 0; mi < metroDefs.length; mi++) {
      var def = metroDefs[mi];
      var sNode = farNode(def.dx, def.dz);
      var eNode = farNode(def.ex, def.ez);
      var res = pf.path(sNode, eNode, metroWeight);
      if (!res || res.nodes.length < 6) continue;

      /* 抽稀成线路走向 */
      var path = [];
      var step = Math.max(1, Math.floor(res.nodes.length / 46));
      for (var i = 0; i < res.nodes.length; i += step) {
        var n = graph.nodes[res.nodes[i]];
        path.push({ x: U.round(n.x, 1), z: U.round(n.z, 1) });
      }
      var lastN = graph.nodes[res.nodes[res.nodes.length - 1]];
      path.push({ x: U.round(lastN.x, 1), z: U.round(lastN.z, 1) });

      var totalW = U.polylineLength(path);
      var km = U.round(totalW * UNIT_M / 1000, 2);
      var stationCount = U.clamp(Math.round(km / 1.0), 8, 28);
      var stations = [];
      for (var k = 0; k < stationCount; k++) {
        var t = stationCount === 1 ? 0 : k / (stationCount - 1);
        var pt = U.pointAlongPolyline(path, t);
        var nm = nextStationName('站点' + (k + 1));
        stations.push({
          id: 'M' + (mi + 1) + 'S' + String(k + 1).padStart(2, '0'),
          name: nm,
          x: U.round(pt.x, 1), z: U.round(pt.z, 1),
          interchange: false,
          lineIds: ['M' + (mi + 1)]
        });
      }
      metroLines.push({
        id: 'M' + (mi + 1),
        name: def.name,
        color: metroColors[mi % metroColors.length],
        path: path,
        stations: stations,
        lengthKm: km,
        dailyRidership: U.round(rng.range(24, 52), 1)
      });
    }

    /* 换乘站：不同线路站点距离很近则标记互通 */
    for (var a = 0; a < metroLines.length; a++) {
      for (var b = a + 1; b < metroLines.length; b++) {
        var LA = metroLines[a], LB = metroLines[b];
        for (var sa = 0; sa < LA.stations.length; sa++) {
          for (var sb = 0; sb < LB.stations.length; sb++) {
            var s1 = LA.stations[sa], s2 = LB.stations[sb];
            if (U.dist(s1.x, s1.z, s2.x, s2.z) < 46) {
              s1.interchange = true; s2.interchange = true;
              if (s1.lineIds.indexOf(LB.id) < 0) s1.lineIds.push(LB.id);
              if (s2.lineIds.indexOf(LA.id) < 0) s2.lineIds.push(LA.id);
            }
          }
        }
      }
    }

    /* 公交：走次干路/支路的 Dijkstra，端点随机但确定 */
    var busLines = [];
    var brng = rng.fork('bus');
    var busColors = ['#2b8a3e', '#0e9aa7', '#3b82c4', '#e8a33d', '#6f5bd6', '#d64545'];
    function busWeight(e) {
      var c = e.cls === 'expressway' ? 2.4 : (e.cls === 'arterial' ? 1.1 :
              (e.cls === 'secondary' ? 1.0 : 0.9));
      return e.lengthM * c;
    }
    var busTries = 0;
    while (busLines.length < 12 && busTries < 120) {
      busTries++;
      var p1 = nodeIds[brng.int(0, nodeIds.length - 1)];
      var p2 = nodeIds[brng.int(0, nodeIds.length - 1)];
      var n1 = graph.nodes[p1], n2 = graph.nodes[p2];
      var sep = U.dist(n1.x, n1.z, n2.x, n2.z);
      if (sep < 620) continue;
      var r2 = pf.path(p1, p2, busWeight);
      if (!r2 || r2.nodes.length < 8) continue;

      var bpath = [];
      var bstep = Math.max(1, Math.floor(r2.nodes.length / 30));
      for (var q = 0; q < r2.nodes.length; q += bstep) {
        var nn = graph.nodes[r2.nodes[q]];
        bpath.push({ x: U.round(nn.x, 1), z: U.round(nn.z, 1) });
      }
      var ln = graph.nodes[r2.nodes[r2.nodes.length - 1]];
      bpath.push({ x: U.round(ln.x, 1), z: U.round(ln.z, 1) });

      var bkm = U.round(U.polylineLength(bpath) * UNIT_M / 1000, 2);
      var stopCount = U.clamp(Math.round(bkm / 0.6), 8, 34);
      var stops = [];
      for (var s = 0; s < stopCount; s++) {
        var tt = stopCount === 1 ? 0 : s / (stopCount - 1);
        var pp = U.pointAlongPolyline(bpath, tt);
        stops.push({
          id: 'B' + String(busLines.length + 1).padStart(2, '0') + 'S' + String(s + 1).padStart(2, '0'),
          name: nextStationName('公交站' + (s + 1)),
          x: U.round(pp.x, 1), z: U.round(pp.z, 1)
        });
      }
      busLines.push({
        id: 'B' + String(busLines.length + 1).padStart(2, '0'),
        name: '公交' + (busLines.length + 1) + '路',
        color: busColors[busLines.length % busColors.length],
        path: bpath,
        stops: stops,
        lengthKm: bkm,
        headway: brng.int(4, 12),
        dailyRidership: U.round(brng.range(0.8, 3.4), 1)
      });
    }

    /* 把走廊的 signalIds 补上（走廊内按顺序的信号机） */
    return { metroLines: metroLines, busLines: busLines };
  }

  /* ------------------------------------------------------------------ *
   * 静态设施
   * ------------------------------------------------------------------ */
  function buildFacilities(rng, roads, districts, greenlands, transit) {
    var parking = [], bike = [], hubs = [];
    var frng = rng.fork('fac');
    var i, k;

    /* 枢纽：地铁换乘站 / 机场 / 火车站 */
    var interchanges = [];
    for (i = 0; i < transit.metroLines.length; i++) {
      var sts = transit.metroLines[i].stations;
      for (k = 0; k < sts.length; k++) {
        if (sts[k].interchange) interchanges.push(sts[k]);
      }
    }
    var hubNames = ['云澜站', '汽车东站', '空港枢纽', '城南客运站', '滨江码头', '高新枢纽', '云澜北站', '临港枢纽'];
    var hubKinds = ['rail', 'bus', 'air', 'bus', 'port', 'rail', 'rail', 'port'];
    for (i = 0; i < Math.min(8, hubNames.length); i++) {
      var src = interchanges[i % Math.max(1, interchanges.length)];
      var hx = src ? src.x : frng.range(-400, 400);
      var hz = src ? src.z : frng.range(-400, 400);
      hubs.push({
        id: 'H' + String(i + 1).padStart(2, '0'),
        name: hubNames[i],
        x: U.round(hx, 1), z: U.round(hz, 1),
        kind: hubKinds[i],
        districtId: districtIdAtRaw(hx, hz, districts, null)
      });
    }

    /* 停车场：沿主干路布点 */
    var arterials = roads.filter(function (r) { return r.cls === 'arterial' || r.cls === 'expressway'; });
    var parkNames = ['地下停车场', '立体停车楼', '公共停车场', 'P+R 换乘停车场', '路侧停车带'];
    for (i = 0; i < 22 && arterials.length; i++) {
      var rd = arterials[frng.int(0, arterials.length - 1)];
      var pt = rd.path[0];
      var ox = pt.x + frng.range(-28, 28);
      var oz = pt.z + frng.range(-28, 28);
      var dId = districtIdAtRaw(ox, oz, districts, null);
      parking.push({
        id: 'P' + String(i + 1).padStart(2, '0'),
        name: (districtShort(districts, dId) || '中心') + parkNames[i % parkNames.length],
        x: U.round(ox, 1), z: U.round(oz, 1),
        capacity: frng.int(120, 1200),
        type: i % 3 === 0 ? 'surface' : (i % 5 === 0 ? 'curb' : 'underground'),
        districtId: dId
      });
    }

    /* 共享单车：地铁站口 + 绿地周边 */
    var bikeSpots = [];
    for (i = 0; i < transit.metroLines.length; i++) {
      var ss = transit.metroLines[i].stations;
      for (k = 0; k < ss.length; k++) bikeSpots.push({ x: ss[k].x, z: ss[k].z, nm: ss[k].name });
    }
    for (i = 0; i < greenlands.length; i++) {
      var c = U.polygonCentroid(greenlands[i].polygon);
      bikeSpots.push({ x: c.x, z: c.z, nm: greenlands[i].name });
    }
    var maxBike = Math.min(44, bikeSpots.length);
    for (i = 0; i < maxBike; i++) {
      var sp = bikeSpots[i];
      var bx = sp.x + frng.range(-16, 16);
      var bz = sp.z + frng.range(-16, 16);
      bike.push({
        id: 'K' + String(i + 1).padStart(2, '0'),
        name: sp.nm + '服务点',
        x: U.round(bx, 1), z: U.round(bz, 1),
        capacity: frng.int(24, 96),
        districtId: districtIdAtRaw(bx, bz, districts, null)
      });
    }
    return { parking: parking, bike: bike, hubs: hubs };
  }

  function districtShort(districts, id) {
    for (var i = 0; i < districts.length; i++) if (districts[i].id === id) return districts[i].short;
    return null;
  }

  /* ================================================================== *
   * 内部索引 & 公开辅助方法
   * ================================================================== */
  var _idx = null;

  function _index(data) {
    var i;
    _idx = {
      road: {}, district: {}, node: {}, signal: {}, corridor: {},
      metro: {}, bus: {}, parking: {}, bike: {}, hub: {},
      buildingByName: {}
    };
    for (i = 0; i < data.roads.length; i++) _idx.road[data.roads[i].id] = data.roads[i];
    for (i = 0; i < data.districts.length; i++) _idx.district[data.districts[i].id] = data.districts[i];
    for (i = 0; i < data.intersections.length; i++) _idx.node[data.intersections[i].id] = data.intersections[i];
    for (i = 0; i < data.signals.length; i++) _idx.signal[data.signals[i].id] = data.signals[i];
    for (i = 0; i < data.corridors.length; i++) _idx.corridor[data.corridors[i].id] = data.corridors[i];
    for (i = 0; i < data.transit.metroLines.length; i++) {
      var ml = data.transit.metroLines[i];
      _idx.metro[ml.id] = ml;
      for (var k = 0; k < ml.stations.length; k++) {
        _idx.metro[ml.stations[k].id] = ml.stations[k];
        ml.stations[k].lineId = ml.id;
        ml.stations[k].kind = 'metro';
      }
    }
    for (i = 0; i < data.transit.busLines.length; i++) {
      var bl = data.transit.busLines[i];
      _idx.bus[bl.id] = bl;
      for (var k2 = 0; k2 < bl.stops.length; k2++) {
        _idx.bus[bl.stops[k2].id] = bl.stops[k2];
        bl.stops[k2].lineId = bl.id;
        bl.stops[k2].kind = 'bus';
      }
    }
    for (i = 0; i < data.facilities.parking.length; i++) _idx.parking[data.facilities.parking[i].id] = data.facilities.parking[i];
    for (i = 0; i < data.facilities.bike.length; i++) _idx.bike[data.facilities.bike[i].id] = data.facilities.bike[i];
    for (i = 0; i < data.facilities.hubs.length; i++) _idx.hub[data.facilities.hubs[i].id] = data.facilities.hubs[i];

    /* 建筑空间网格（供最近地标查询 & 拾取） */
    var bg = { cell: 80, map: {} };
    for (i = 0; i < data.buildings.length; i++) {
      var b = data.buildings[i];
      var key = Math.floor(b.x / bg.cell) + '|' + Math.floor(b.z / bg.cell);
      (bg.map[key] || (bg.map[key] = [])).push(b);
    }
    _idx.buildingGrid = bg;

    /* 地标列表 */
    _idx.landmarks = data.buildings.filter(function (x) { return x.type === 'landmark' && x.name; });
  }

  function ensure() {
    if (!built) build();
    return built;
  }

  var City = TP.City = {};

  City.build = build;
  City.DISTRICT_DEF = DISTRICT_DEF;
  City.UNIT_M = UNIT_M;
  City.CORE_R = CORE_R;

  /* data 用 getter，保证 build 之后拿到最新对象 */
  Object.defineProperty(City, 'data', {
    get: function () { return built; },
    enumerable: true, configurable: true
  });

  City.ready = function () { return !!built; };

  City.districtOf = function (x, z) {
    var d = ensure();
    for (var i = 0; i < d.districts.length; i++) {
      if (U.pointInPolygon(x, z, d.districts[i].polygon)) return d.districts[i].id;
    }
    var best = null, bd = Infinity;
    for (var j = 0; j < d.districts.length; j++) {
      var c = d.districts[j].center;
      var dd = U.dist2(x, z, c.x, c.z);
      if (dd < bd) { bd = dd; best = d.districts[j].id; }
    }
    return best;
  };

  City.roadById = function (id) { ensure(); return (_idx && _idx.road[id]) || null; };
  City.districtById = function (id) { ensure(); return (_idx && _idx.district[id]) || null; };
  City.intersectionById = function (id) { ensure(); return (_idx && _idx.node[id]) || null; };
  City.signalById = function (id) { ensure(); return (_idx && _idx.signal[id]) || null; };
  City.corridorById = function (id) { ensure(); return (_idx && _idx.corridor[id]) || null; };
  City.metroLineById = function (id) { ensure(); return (_idx && _idx.metro[id]) || null; };
  City.busLineById = function (id) { ensure(); return (_idx && _idx.bus[id]) || null; };
  City.parkingById = function (id) { ensure(); return (_idx && _idx.parking[id]) || null; };
  City.bikeById = function (id) { ensure(); return (_idx && _idx.bike[id]) || null; };
  City.hubById = function (id) { ensure(); return (_idx && _idx.hub[id]) || null; };
  City.landmarks = function () { ensure(); return _idx.landmarks; };

  City.nearestRoad = function (x, z, maxDist) {
    var d = ensure();
    maxDist = maxDist == null ? Infinity : maxDist;
    var best = null, bd = maxDist;
    for (var i = 0; i < d.roads.length; i++) {
      var r = d.roads[i];
      var dist = U.distToPolyline(x, z, r.path);
      if (dist < bd) { bd = dist; best = r; }
    }
    if (!best) return null;
    return { road: best, dist: bd, point: { x: x, z: z } };
  };

  /** 最近地标建筑（供详情抽屉"周边"用） */
  City.nearestLandmark = function (x, z) {
    var d = ensure();
    var lm = _idx.landmarks;
    var best = null, bd = Infinity;
    for (var i = 0; i < lm.length; i++) {
      var dd = U.dist2(x, z, lm[i].x, lm[i].z);
      if (dd < bd) { bd = dd; best = lm[i]; }
    }
    return best ? { landmark: best, distM: Math.round(Math.sqrt(bd) * UNIT_M) } : null;
  };

  /** 半径内设施检索 */
  City.nearby = function (x, z, radiusW, limit) {
    var d = ensure();
    limit = limit || 6;
    var out = { roads: [], metro: [], bus: [], parking: [], bike: [], hubs: [], incidents: [] };
    var i;
    function push(arr, item, distW) {
      arr.push({ item: item, distM: Math.round(distW * UNIT_M) });
    }
    for (i = 0; i < d.roads.length; i++) {
      var dist = U.distToPolyline(x, z, d.roads[i].path);
      if (dist <= radiusW) push(out.roads, d.roads[i], dist);
    }
    var groups = [
      ['metro', d.transit.metroLines, 'stations'],
      ['bus', d.transit.busLines, 'stops']
    ];
    for (i = 0; i < groups.length; i++) {
      var gk = groups[i][0], garr = groups[i][1], sk = groups[i][2];
      for (var j = 0; j < garr.length; j++) {
        for (var k = 0; k < garr[j][sk].length; k++) {
          var st = garr[j][sk][k];
          var dw = U.dist(x, z, st.x, st.z);
          if (dw <= radiusW) push(out[gk], st, dw);
        }
      }
    }
    var fkeys = ['parking', 'bike', 'hubs'];
    var fmap = { parking: 'parking', bike: 'bike', hubs: 'hubs' };
    for (i = 0; i < fkeys.length; i++) {
      var arr2 = d.facilities[fmap[fkeys[i]]];
      for (var j2 = 0; j2 < arr2.length; j2++) {
        var dw2 = U.dist(x, z, arr2[j2].x, arr2[j2].z);
        if (dw2 <= radiusW) push(out[fkeys[i]], arr2[j2], dw2);
      }
    }
    for (var key in out) {
      if (!Object.prototype.hasOwnProperty.call(out, key)) continue;
      out[key].sort(function (a, b) { return a.distM - b.distM; });
      out[key] = out[key].slice(0, limit);
    }
    return out;
  };

  /** 生成一条走廊上按顺序排列的信号机 id */
  City.corridorSignalIds = function (corridorId) {
    ensure();
    var c = (_idx && _idx.corridor[corridorId]) || null;
    if (!c) return [];
    return (c.signalIds || []).slice();
  };

  return City;

})(window);
