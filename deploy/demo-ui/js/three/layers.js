/* ============================================================================
 * layers.js —— 动态数据图层
 * 命名空间：TP.Layers
 * 依赖：THREE(r128)、TP.Util、TP.Theme、TP.Scene、TP.CityBuilder；数据读 TP.City.data / TP.Sim
 * 原则：
 *   - 不造业务数据：所有数值来自 TP.Sim；Math.random 零使用（粒子相位用 TP.Util.Rng）。
 *   - 一切重复实体用 InstancedMesh / 合并几何；applyTime() 只改颜色/实例矩阵，增量写入。
 *   - 路段数量不做假设（数千条可承受）。
 * ==========================================================================*/
(function (window) {
  'use strict';

  var TP = window.TP = window.TP || {};
  var U = TP.Util;
  var THREE = window.THREE;

  var TIME_SCALE = 10;           /* 粒子速度相对真实车速的放大倍数（可视化） */
  var MAX_PARTICLES = 3000;
  var HEAT_N = 160, HEAT_EXT = 1100;

  var L = TP.Layers = { ready: false, group: null, pickables: [], LAYERS: [] };

  var city = null, sim = null;
  var vis = {};
  var regionFn = null;
  var subs = {};                 /* id → 子图层对象 */
  var RG = [];                   /* 路段几何缓存 */
  var rgIndex = {};              /* roadId → RG 下标 */
  var intById = {}, sigDistrict = {};
  var levelCol = [], neutralCol = {}, dimCache = {};
  var particleScale = 1;
  var hoverMesh = null, hoverRoadId = null, selMesh = null, selMarker = null, selKey = null, selT = 0;
  var segGrid = null, SG_CELL = 40, SG_N = 0;
  var tmpC = new THREE.Color(), tmpC2 = new THREE.Color();

  function Y() { return TP.Scene.Y; }
  function col(t) { return TP.Scene.color(t); }
  function colCss(css, out) { return TP.Scene.colorOf(css, out); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function px(p) { return p.x !== undefined ? p.x : p[0]; }
  function pz(p) { return p.z !== undefined ? p.z : p[1]; }
  function passes(item) { if (!regionFn) return true; try { return !!regionFn(item); } catch (e) { return true; } }
  function districtOf(x, z) {
    if (TP.City && TP.City.districtOf) { try { return TP.City.districtOf(x, z); } catch (e) { /* fallthrough */ } }
    var ds = (city && city.districts) || [];
    for (var i = 0; i < ds.length; i++) if (U.pointInPolygon(x, z, ds[i].polygon)) return ds[i].id;
    return null;
  }
  function simGet(k) { try { return sim ? sim[k] : null; } catch (e) { return null; } }

  var M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), PV = new THREE.Vector3(), SV = new THREE.Vector3();
  function setInst(mesh, i, x, y, z, sx, sy, sz) {
    PV.set(x, y, z); SV.set(sx, sy, sz); Q.set(0, 0, 0, 1);
    M4.compose(PV, Q, SV); mesh.setMatrixAt(i, M4);
  }
  function flatGeo(g) { g.rotateX(-Math.PI / 2); return g; }

  /* ===================================================== 图层元数据 ===== */
  function icon(d) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
  }
  L.LAYERS = [
    { id: 'traffic', name: '实时路况', unit: '条路段', defaultOn: true, icon: icon('<path d="M4 19 10 5M20 19 14 5M12 7v2M12 12v2M12 17v2"/>'), count: function () { return RG.length; } },
    { id: 'vehicle', name: '车流粒子', unit: '辆', defaultOn: false, icon: icon('<rect x="3" y="9" width="18" height="7" rx="2"/><circle cx="7.5" cy="17" r="1.5"/><circle cx="16.5" cy="17" r="1.5"/>'), count: function () { return subs.vehicle ? subs.vehicle.active : 0; } },
    { id: 'heat', name: '拥堵热力', unit: '处拥堵', defaultOn: true, icon: icon('<path d="M12 3c3 4 6 6.5 6 10a6 6 0 0 1-12 0c0-2 1-3.5 2.5-5 .5 2 1.5 3 3 3-1-3 0-5.5.5-8z"/>'), count: function () { return subs.heat ? subs.heat.jams : 0; } },
    { id: 'incident', name: '事件告警', unit: '起', defaultOn: true, icon: icon('<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17v.5"/>'), count: function () { return subs.incident ? subs.incident.activeN : 0; } },
    { id: 'metro', name: '地铁线网', unit: '座车站', defaultOn: false, icon: icon('<rect x="6" y="3" width="12" height="14" rx="3"/><path d="M6 11h12M9 21l1.5-4M15 21l-1.5-4"/>'), count: function () { return subs.metro ? subs.metro.n : 0; } },
    { id: 'bus', name: '公交线网', unit: '条线路', defaultOn: false, icon: icon('<rect x="4" y="4" width="16" height="13" rx="2"/><path d="M4 11h16M8 20v-3M16 20v-3"/>'), count: function () { return subs.bus ? subs.bus.lines : 0; } },
    { id: 'od', name: 'OD 飞线', unit: '条', defaultOn: false, icon: icon('<circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/><path d="M5 16C7 6 17 6 19 16"/>'), count: function () { return subs.od ? subs.od.n : 0; } },
    { id: 'signal', name: '信号配时', unit: '个路口', defaultOn: false, icon: icon('<rect x="8" y="2" width="8" height="18" rx="3"/><circle cx="12" cy="7" r="1.4"/><circle cx="12" cy="11" r="1.4"/><circle cx="12" cy="15" r="1.4"/>'), count: function () { return subs.signal ? subs.signal.n : 0; } },
    { id: 'parking', name: '停车场', unit: '个', defaultOn: false, icon: icon('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M10 17V7h3a3 3 0 0 1 0 6h-3"/>'), count: function () { return subs.parking ? subs.parking.n : 0; } },
    { id: 'bike', name: '共享单车', unit: '个站点', defaultOn: false, icon: icon('<circle cx="6" cy="16" r="3.5"/><circle cx="18" cy="16" r="3.5"/><path d="M6 16l4-7h5l3 7M10 9 8 6H6"/>'), count: function () { return subs.bike ? subs.bike.n : 0; } },
    { id: 'carbon', name: '碳排热点', unit: '处', defaultOn: false, icon: icon('<path d="M5 19c0-8 6-14 14-14 0 8-6 14-14 14zM5 19l7-7"/>'), count: function () { return subs.carbon ? subs.carbon.n : 0; } },
    { id: 'district', name: '行政区边界', unit: '个区', defaultOn: true, icon: icon('<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/>'), count: function () { return (city && city.districts) ? city.districts.length : 0; } }
  ];

  /* ===================================================== 路段缓存 ======= */
  function buildRoadCache() {
    var roads = city.roads || [];
    RG = []; rgIndex = {};
    for (var i = 0; i < roads.length; i++) {
      var r = roads[i];
      if (!r || !r.path || r.path.length < 2) continue;
      var n = r.path.length, pts = new Float32Array(n * 2), cum = new Float32Array(n), acc = 0;
      for (var k = 0; k < n; k++) {
        pts[k * 2] = px(r.path[k]); pts[k * 2 + 1] = pz(r.path[k]);
        if (k) acc += Math.sqrt(Math.pow(pts[k * 2] - pts[k * 2 - 2], 2) + Math.pow(pts[k * 2 + 1] - pts[k * 2 - 1], 2));
        cum[k] = acc;
      }
      rgIndex[r.id] = RG.length;
      RG.push({ id: r.id, road: r, cls: r.cls, pts: pts, cum: cum, len: Math.max(acc, 0.01), n: n, lastKey: -99 });
    }
    /* 路段空间网格：拾取容差查询 */
    SG_N = Math.ceil(2 * HEAT_EXT / SG_CELL);
    segGrid = new Array(SG_N * SG_N);
    for (var j = 0; j < RG.length; j++) {
      var g = RG[j], seen = {};
      var steps = Math.max(1, Math.ceil(g.len / (SG_CELL * 0.5)));
      for (var s = 0; s <= steps; s++) {
        var p = along(g, g.len * s / steps);
        var cx = Math.floor((p.x + HEAT_EXT) / SG_CELL), cz = Math.floor((p.z + HEAT_EXT) / SG_CELL);
        if (cx < 0 || cz < 0 || cx >= SG_N || cz >= SG_N) continue;
        var key = cz * SG_N + cx;
        if (seen[key]) continue; seen[key] = 1;
        (segGrid[key] || (segGrid[key] = [])).push(j);
      }
    }
  }
  var tmpP = { x: 0, z: 0 };
  function along(g, s) {
    var cum = g.cum, n = g.n, k = 0;
    while (k < n - 2 && cum[k + 1] < s) k++;
    var seg = cum[k + 1] - cum[k], t = seg > 1e-6 ? (s - cum[k]) / seg : 0;
    tmpP.x = U.lerp(g.pts[k * 2], g.pts[k * 2 + 2], t); tmpP.z = U.lerp(g.pts[k * 2 + 1], g.pts[k * 2 + 3], t);
    return tmpP;
  }
  function nearestRoad(x, z, tol) {
    if (!segGrid) return null;
    var c0 = Math.floor((x - tol + HEAT_EXT) / SG_CELL), c1 = Math.floor((x + tol + HEAT_EXT) / SG_CELL);
    var r0 = Math.floor((z - tol + HEAT_EXT) / SG_CELL), r1 = Math.floor((z + tol + HEAT_EXT) / SG_CELL);
    var best = null, bd = tol, done = {};
    for (var cz = Math.max(0, r0); cz <= Math.min(SG_N - 1, r1); cz++)
      for (var cx = Math.max(0, c0); cx <= Math.min(SG_N - 1, c1); cx++) {
        var list = segGrid[cz * SG_N + cx];
        if (!list) continue;
        for (var i = 0; i < list.length; i++) {
          var j = list[i]; if (done[j]) continue; done[j] = 1;
          var d = U.distToPolyline(x, z, RG[j].road.path) - (TP.CityBuilder.WIDTH[RG[j].cls] || 3) / 2;
          if (d < bd) { bd = d; best = RG[j].road; }
        }
      }
    return best;
  }

  /* ===================================================== 颜色缓存 ======= */
  function buildColors() {
    levelCol = [];
    for (var i = 0; i < 4; i++) levelCol.push(colCss(TP.Theme.roadColor(i)));
    levelCol.nodata = col('--road-nodata');
    neutralCol = {};
    var cls = TP.CityBuilder.CLASSES;
    for (var k = 0; k < cls.length; k++) neutralCol[cls[k]] = TP.CityBuilder.neutralRoadColor(cls[k]);
    dimCache = {};
  }
  /** 路段显示色：路况色；区域筛选外的路段向中性色淡出 */
  function roadColor(g, st, dim, out) {
    var neu = neutralCol[g.cls] || neutralCol.branch;
    if (!vis.traffic) return out.copy(neu);
    var c = st && st.level != null ? (levelCol[st.level] || levelCol.nodata) : levelCol.nodata;
    out.copy(c);
    if (dim) out.lerp(neu, 0.78);
    return out;
  }

  /* ===================================================== traffic ======== */
  var traffic = {
    lastRoadKey: null,
    apply: function (force) {
      var rs = simGet('roadStates') || {};
      var B = TP.CityBuilder, changed = false;
      var keyBase = vis.traffic ? 0 : 100;
      for (var i = 0; i < RG.length; i++) {
        var g = RG[i], st = rs[g.id];
        var dim = regionFn ? !passes(g.road) : false;
        var key = keyBase + (st && st.level != null ? st.level : 9) + (dim ? 20 : 0);
        g.dim = dim;
        if (!force && key === g.lastKey) continue;
        g.lastKey = key;
        roadColor(g, st, dim, tmpC);
        B.setRoadColor(g.id, tmpC.r, tmpC.g, tmpC.b);
        changed = true;
      }
      if (changed) B.flushRoadColors();
      /* 交叉口圆盘 = 主导道路颜色 */
      var D = B.discs;
      if (D && (changed || force)) {
        for (var d = 0; d < D.roadIds.length; d++) {
          var j = rgIndex[D.roadIds[d]];
          if (j == null) continue;
          roadColor(RG[j], rs[RG[j].id], RG[j].dim, tmpC);
          D.mesh.setColorAt(d, tmpC);
        }
        B.flushDiscColors();
      }
    },
    setVisible: function () { this.apply(true); }
  };

  /* ===================================================== vehicle ======== */
  var vehicle = {
    mesh: null, n: 0, active: 0,
    build: function () {
      var budget = MAX_PARTICLES;
      var W = 0, i, w = [];
      var lf = { expressway: 3, arterial: 2, secondary: 1.2, branch: 0.6 };
      for (i = 0; i < RG.length; i++) { var wi = RG[i].len * (lf[RG[i].cls] || 0.6); w.push(wi); W += wi; }
      var counts = [], acc = 0, assigned = 0;
      for (i = 0; i < RG.length; i++) { acc += budget * w[i] / (W || 1); var c = Math.floor(acc) - assigned; counts.push(c); assigned += c; }
      var n = this.n = assigned;
      this.road = new Int32Array(n); this.s = new Float32Array(n); this.dir = new Int8Array(n);
      this.lane = new Float32Array(n); this.seg = new Int16Array(n); this.rank = new Float32Array(n);
      this.act = new Int32Array(n);
      var rng = U.Rng('vehicle-phase'), p = 0;
      for (i = 0; i < RG.length; i++) {
        var g = RG[i], oneway = !!g.road.oneway, hw = (TP.CityBuilder.WIDTH[g.cls] || 3) / 2;
        for (var k = 0; k < counts[i]; k++, p++) {
          this.road[p] = i;
          this.s[p] = rng.next() * g.len;
          this.dir[p] = oneway ? 1 : (k % 2 ? -1 : 1);
          this.lane[p] = oneway ? (rng.next() - 0.5) * hw : hw * (0.3 + rng.next() * 0.4);
          this.rank[p] = (k + rng.next() * 0.5) / Math.max(1, counts[i]);
        }
      }
      this.speed = new Float32Array(RG.length);
      this.alive = new Uint8Array(RG.length);
      var geo = new THREE.BoxGeometry(1, 1, 1); geo.translate(0, 0.5, 0);
      this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: 0xffffff }), Math.max(1, n));
      this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.mesh.count = 0;
      this.mesh.frustumCulled = false;
      this.mesh.name = 'layer-vehicle';
      this.mesh.setColorAt(0, tmpC.setRGB(1, 1, 1));
      L.group.add(this.mesh);
      this.y = Y().overlay - 0.1;
    },
    apply: function () {
      var rs = simGet('roadStates') || {}, i;
      var sc = particleScale;
      for (i = 0; i < RG.length; i++) {
        var st = rs[RG[i].id];
        var sp = st && st.speed != null ? st.speed : 30;
        this.speed[i] = Math.max(0.6, sp / 3.6 / 5 * TIME_SCALE);
        var frac = st ? U.clamp(st.satRatio != null ? st.satRatio : (st.flow && RG[i].road.capacity ? st.flow / RG[i].road.capacity : 0.4), 0.04, 1) : 0.15;
        this.alive[i] = Math.round(frac * 100 * sc);
        RG[i].vLevel = st ? st.level : -1;
      }
      var a = 0, mesh = this.mesh;
      for (i = 0; i < this.n; i++) {
        var r = this.road[i];
        if (this.rank[i] * 100 >= this.alive[r] || RG[r].dim) continue;
        this.act[a] = i;
        var lv = RG[r].vLevel;
        tmpC.copy(lv >= 0 ? levelCol[lv] : levelCol.nodata).multiplyScalar(0.62);   /* 比路面更深，压在同色路面上仍可辨 */
        mesh.setColorAt(a, tmpC);
        a++;
      }
      this.active = a;
      mesh.count = a;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    },
    update: function (dts) {
      var arr = this.mesh.instanceMatrix.array, y = this.y;
      var SX = 3.4, SY = 1.5, SZ = 1.7;
      for (var a = 0; a < this.active; a++) {
        var i = this.act[a], g = RG[this.road[i]], d = this.dir[i];
        var s = this.s[i] + d * this.speed[this.road[i]] * dts, Lr = g.len;
        if (s > Lr) s -= Lr; else if (s < 0) s += Lr;
        this.s[i] = s;
        var cum = g.cum, k = this.seg[i];
        if (k > g.n - 2) k = 0;
        while (k < g.n - 2 && cum[k + 1] < s) k++;
        while (k > 0 && cum[k] > s) k--;
        this.seg[i] = k;
        var ax = g.pts[k * 2], az = g.pts[k * 2 + 1], bx = g.pts[k * 2 + 2], bz = g.pts[k * 2 + 3];
        var sl = cum[k + 1] - cum[k], t = sl > 1e-6 ? (s - cum[k]) / sl : 0;
        var fx = (bx - ax) / (sl || 1) * d, fz = (bz - az) / (sl || 1) * d;
        var rx = -fz, rz = fx, lo = this.lane[i];
        var x = ax + (bx - ax) * t + rx * lo, z = az + (bz - az) * t + rz * lo;
        var o = a * 16;
        arr[o] = fx * SX; arr[o + 1] = 0; arr[o + 2] = fz * SX; arr[o + 3] = 0;
        arr[o + 4] = 0; arr[o + 5] = SY; arr[o + 6] = 0; arr[o + 7] = 0;
        arr[o + 8] = rx * SZ; arr[o + 9] = 0; arr[o + 10] = rz * SZ; arr[o + 11] = 0;
        arr[o + 12] = x; arr[o + 13] = y; arr[o + 14] = z; arr[o + 15] = 1;
      }
      this.mesh.instanceMatrix.needsUpdate = true;
    },
    setVisible: function (on) { this.mesh.visible = on; if (on) this.apply(); }
  };

  /* ===================================================== heat =========== */
  var heat = {
    build: function () {
      var c = this.canvas = document.createElement('canvas');
      c.width = c.height = HEAT_N;
      this.ctx = c.getContext('2d');
      this.img = this.ctx.createImageData(HEAT_N, HEAT_N);
      this.grid = new Float32Array(HEAT_N * HEAT_N);
      this.tmp = new Float32Array(HEAT_N * HEAT_N);
      this.tex = new THREE.CanvasTexture(c);
      this.tex.encoding = THREE.sRGBEncoding;
      this.tex.minFilter = THREE.LinearFilter; this.tex.generateMipmaps = false;
      var g = flatGeo(new THREE.PlaneGeometry(HEAT_EXT * 2, HEAT_EXT * 2));
      this.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false, opacity: 0.9 }));
      this.mesh.position.y = Y().heat; this.mesh.renderOrder = 0; this.mesh.name = 'layer-heat';
      L.group.add(this.mesh);
      /* 预计算每条路段的采样格子 */
      this.cells = [];
      for (var i = 0; i < RG.length; i++) {
        var G = RG[i], list = [], steps = Math.max(1, Math.round(G.len / 24));
        for (var s = 0; s <= steps; s++) {
          var p = along(G, G.len * s / steps);
          var cx = Math.floor((p.x + HEAT_EXT) / (2 * HEAT_EXT) * HEAT_N), cz = Math.floor((p.z + HEAT_EXT) / (2 * HEAT_EXT) * HEAT_N);
          if (cx >= 0 && cz >= 0 && cx < HEAT_N && cz < HEAT_N) list.push(cz * HEAT_N + cx);
        }
        this.cells.push(list);
      }
      this.buildLut();
      this.jams = 0;
    },
    buildLut: function () {
      var ramp = TP.Theme.heatRamp();
      this.lut = new Uint8Array(256 * 3);
      for (var i = 0; i < 256; i++) {
        var c = U.parseColor(U.ramp(ramp, i / 255));
        this.lut[i * 3] = c.r; this.lut[i * 3 + 1] = c.g; this.lut[i * 3 + 2] = c.b;
      }
    },
    apply: function () {
      var grid = this.grid, i, k;
      grid.fill(0);
      var rs = simGet('roadStates') || {}, W = [0, 0.18, 0.62, 1.0], cw = { expressway: 1.3, arterial: 1.1, secondary: 0.9, branch: 0.7 };
      var jams = 0;
      for (i = 0; i < RG.length; i++) {
        var st = rs[RG[i].id];
        if (!st || !st.level || RG[i].dim) continue;
        if (st.level >= 2) jams++;
        var w = W[st.level] * (cw[RG[i].cls] || 1), cl = this.cells[i];
        for (k = 0; k < cl.length; k++) grid[cl[k]] += w;
      }
      var inc = simGet('incidents') || [];
      for (i = 0; i < inc.length; i++) {
        var e = inc[i];
        if (e.status === 'cleared' || !passes(e)) continue;
        var cx = Math.floor((e.x + HEAT_EXT) / (2 * HEAT_EXT) * HEAT_N), cz = Math.floor((e.z + HEAT_EXT) / (2 * HEAT_EXT) * HEAT_N);
        if (cx >= 0 && cz >= 0 && cx < HEAT_N && cz < HEAT_N) grid[cz * HEAT_N + cx] += 2.5 * (e.severity || 1);
      }
      this.jams = jams;
      blur(grid, this.tmp, HEAT_N, 2); blur(grid, this.tmp, HEAT_N, 2);
      var d = this.img.data, lut = this.lut;
      for (i = 0; i < grid.length; i++) {
        var v = 1 - Math.exp(-grid[i] * 0.9);
        var li = (v * 255) | 0, o = i * 4;
        d[o] = lut[li * 3]; d[o + 1] = lut[li * 3 + 1]; d[o + 2] = lut[li * 3 + 2];
        var a = v < 0.06 ? 0 : U.smoothstep((v - 0.06) / 0.6);
        d[o + 3] = (a * 200) | 0;
      }
      this.ctx.putImageData(this.img, 0, 0);
      this.tex.needsUpdate = true;
    },
    setVisible: function (on) { this.mesh.visible = on; if (on) this.apply(); }
  };
  /** 可分离盒式模糊（两次 ≈ 高斯） */
  function blur(a, t, n, r) {
    var x, y, s, i, w = 2 * r + 1;
    for (y = 0; y < n; y++) {
      s = 0; var row = y * n;
      for (x = -r; x <= r; x++) s += a[row + U.clamp(x, 0, n - 1)];
      for (x = 0; x < n; x++) {
        t[row + x] = s / w;
        s += a[row + Math.min(n - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    for (x = 0; x < n; x++) {
      s = 0;
      for (y = -r; y <= r; y++) s += t[U.clamp(y, 0, n - 1) * n + x];
      for (y = 0; y < n; y++) {
        a[y * n + x] = s / w;
        s += t[Math.min(n - 1, y + r + 1) * n + x] - t[Math.max(0, y - r) * n + x];
      }
    }
    for (i = 0; i < 0; i++) { /* noop */ }
  }

  /* ===================================================== incident ======= */
  var INC_CAP = 64;
  var INC_ICON = { accident: '⚠', congestion: '◉', construction: '⛏', weather: '☂', control: '⛔', violation: 'Ⓟ' };
  var incident = {
    sig: '', list: [], activeN: 0, labels: [],
    build: function () {
      var c = document.createElement('canvas'); c.width = 4; c.height = 64;
      var g = c.getContext('2d'), grd = g.createLinearGradient(0, 64, 0, 0);
      grd.addColorStop(0, '#fff'); grd.addColorStop(0.7, '#555'); grd.addColorStop(1, '#000');
      g.fillStyle = grd; g.fillRect(0, 0, 4, 64);
      this.alpha = new THREE.CanvasTexture(c);
      var pg = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true); pg.translate(0, 0.5, 0);
      this.pillar = new THREE.InstancedMesh(pg, new THREE.MeshBasicMaterial({ color: 0xffffff, alphaMap: this.alpha, transparent: true, depthWrite: false, side: THREE.DoubleSide }), INC_CAP);
      this.pillar.name = 'layer-incident'; this.pillar.renderOrder = 12; this.pillar.count = 0;
      var hg = new THREE.OctahedronGeometry(1, 0);
      this.head = new THREE.InstancedMesh(hg, new THREE.MeshLambertMaterial({ color: 0xffffff }), INC_CAP);
      this.head.count = 0; this.head.name = 'layer-incident-head';
      var rg = flatGeo(new THREE.RingGeometry(0.82, 1, 48));
      this.ring = new THREE.InstancedMesh(rg, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false }), INC_CAP * 2);
      this.ring.count = 0; this.ring.renderOrder = 11; this.ring.frustumCulled = false;
      this.pillar.userData = { kind: 'incident', items: this.list };
      this.head.userData = this.pillar.userData;
      this.group = new THREE.Group(); this.group.add(this.ring); this.group.add(this.pillar); this.group.add(this.head);
      L.group.add(this.group);
      L.pickables.push(this.pillar, this.head);
      this.cols = this.makeCols();
    },
    makeCols: function () { return { 1: col('--c-warn'), 2: col('--road-jam'), 3: col('--c-danger'), cleared: col('--c-text-dim'), ground: col('--stage-ground') }; },
    apply: function (force) {
      var inc = simGet('incidents') || [], list = [], i, sig = '';
      for (i = 0; i < inc.length && list.length < INC_CAP; i++) if (passes(inc[i])) { list.push(inc[i]); sig += inc[i].id + inc[i].status + inc[i].severity + '|'; }
      this.activeN = 0;
      for (i = 0; i < list.length; i++) if (list[i].status !== 'cleared') this.activeN++;
      if (sig === this.sig && !force) return;
      this.sig = sig;
      this.list.length = 0; Array.prototype.push.apply(this.list, list);
      var y = Y().overlay;
      for (i = 0; i < list.length; i++) {
        var e = list[i], cl = e.status === 'cleared', h = cl ? 18 : 40 + (e.severity || 1) * 22;
        var c = cl ? this.cols.cleared : this.cols[e.severity] || this.cols[1];
        setInst(this.pillar, i, e.x, y, e.z, 2.4, h, 2.4); this.pillar.setColorAt(i, c);
        setInst(this.head, i, e.x, y + h + 4, e.z, 4, 5.5, 4); this.head.setColorAt(i, c);
      }
      this.pillar.count = this.head.count = list.length;
      this.ring.count = list.length * 2;
      this.pillar.instanceMatrix.needsUpdate = this.head.instanceMatrix.needsUpdate = true;
      if (this.pillar.instanceColor) this.pillar.instanceColor.needsUpdate = this.head.instanceColor.needsUpdate = true;
      this.rebuildLabels();
    },
    rebuildLabels: function () {
      for (var i = 0; i < this.labels.length; i++) this.labels[i].remove();
      this.labels = [];
      if (!vis.incident) return;
      for (var k = 0; k < this.list.length; k++) {
        var e = this.list[k];
        if (e.status === 'cleared') continue;
        var h = 40 + (e.severity || 1) * 22;
        this.labels.push(TP.Scene.addLabel('<span class="bld-label__icon">' + (INC_ICON[e.type] || '!') + '</span> ' + esc(e.title || e.type),
          { x: e.x, y: Y().overlay + h + 12, z: e.z },
          { className: 'bld-label bld-label--incident sev-' + (e.severity || 1), maxDistance: 2600, fadeStart: 1800 }));
      }
    },
    update: function (t) {
      var n = this.list.length; if (!n) return;
      var y = Y().overlay + 0.1, g = this.cols.ground;
      for (var i = 0; i < n; i++) {
        var e = this.list[i], c = e.status === 'cleared' ? this.cols.cleared : (this.cols[e.severity] || this.cols[1]);
        for (var k = 0; k < 2; k++) {
          var ph = ((t * 0.45 + k * 0.5 + i * 0.137) % 1);
          var r = 6 + ph * (28 + (e.severity || 1) * 14) * (e.status === 'cleared' ? 0.4 : 1);
          setInst(this.ring, i * 2 + k, e.x, y, e.z, r, 1, r);
          tmpC2.copy(c).lerp(g, ph * 0.95);
          this.ring.setColorAt(i * 2 + k, tmpC2);
        }
        var bob = Math.sin(t * 2.2 + i) * 2;
        var h = e.status === 'cleared' ? 18 : 40 + (e.severity || 1) * 22;
        PV.set(e.x, Y().overlay + h + 6 + bob, e.z); Q.setFromAxisAngle(THREE.Object3D.DefaultUp, t * 1.4 + i); SV.set(4, 5.5, 4);
        M4.compose(PV, Q, SV); this.head.setMatrixAt(i, M4);
      }
      this.ring.instanceMatrix.needsUpdate = true; this.head.instanceMatrix.needsUpdate = true;
      if (this.ring.instanceColor) this.ring.instanceColor.needsUpdate = true;
    },
    setVisible: function (on) { this.group.visible = on; this.rebuildLabels(); }
  };

  /* ===================================================== metro ========== */
  var metro = {
    n: 0,
    build: function () {
      var lines = (city.transit && city.transit.metroLines) || [], cols = TP.Theme.metroColors();
      var acc = TP.CityBuilder.newAcc(true), y = Y().metro, i, k;
      this.group = new THREE.Group(); this.group.name = 'layer-metro';
      var items = [], uniq = {};
      for (i = 0; i < lines.length; i++) {
        var ln = lines[i], c = colCss(cols[i % cols.length]);
        if (ln.path && ln.path.length > 1) {
          var v = [];
          for (k = 0; k < ln.path.length; k++) v.push(new THREE.Vector3(px(ln.path[k]), y, pz(ln.path[k])));
          var curve = v.length > 2 ? new THREE.CatmullRomCurve3(v, false, 'centripetal') : new THREE.LineCurve3(v[0], v[1]);
          var len = U.polylineLength(ln.path);
          var tg = new THREE.TubeGeometry(curve, Math.max(8, Math.min(400, Math.round(len / 10))), 2.2, 6, false);
          TP.CityBuilder.appendGeometry(acc, tg, c); tg.dispose();
        }
        var sts = ln.stations || [];
        for (k = 0; k < sts.length; k++) {
          var s = sts[k], key = Math.round(s.x / 4) + ',' + Math.round(s.z / 4);
          if (uniq[key]) { uniq[key].interchange = true; continue; }
          var it = { kind: 'station', mode: 'metro', id: s.id, name: s.name, x: s.x, z: s.z, lineId: ln.id, lineIds: s.lineIds || [ln.id], interchange: !!s.interchange, color: c, districtId: districtOf(s.x, s.z) };
          uniq[key] = it; items.push(it);
        }
      }
      if (acc.pos.length) {
        this.tube = new THREE.Mesh(TP.CityBuilder.accToGeometry(acc), new THREE.MeshLambertMaterial({ vertexColors: true }));
        this.tube.renderOrder = 6; this.group.add(this.tube);
      }
      var hubs = (city.facilities && city.facilities.hubs) || [];
      for (i = 0; i < hubs.length; i++) items.push({ kind: 'hub', id: hubs[i].id, name: hubs[i].name, x: hubs[i].x, z: hubs[i].z, hubKind: hubs[i].kind, districtId: hubs[i].districtId, hub: true });
      this.all = items;
      var sg = new THREE.CylinderGeometry(1, 1, 1, 18); sg.translate(0, 0.5, 0);
      this.st = new THREE.InstancedMesh(sg, new THREE.MeshLambertMaterial({ color: 0xffffff }), Math.max(1, items.length));
      this.st.name = 'layer-metro-station'; this.st.userData = { kind: 'station', items: [] };
      this.group.add(this.st);
      L.pickables.push(this.st);
      L.group.add(this.group);
      this.layout();
    },
    layout: function () {
      var items = this.st.userData.items; items.length = 0;
      var white = col('--c-panel'), hubC = col('--c-primary-deep'), y = Y().metro - 3;
      for (var i = 0; i < this.all.length; i++) {
        var it = this.all[i];
        if (!passes(it)) continue;
        var j = items.length;
        if (it.hub) { setInst(this.st, j, it.x, 0, it.z, 11, 14, 11); this.st.setColorAt(j, hubC); }
        else if (it.interchange) { setInst(this.st, j, it.x, y, it.z, 7, 7.5, 7); this.st.setColorAt(j, white); }
        else { setInst(this.st, j, it.x, y, it.z, 4.2, 6, 4.2); this.st.setColorAt(j, it.color); }
        items.push(it);
      }
      this.st.count = items.length; this.n = items.length;
      this.st.instanceMatrix.needsUpdate = true;
      if (this.st.instanceColor) this.st.instanceColor.needsUpdate = true;
    },
    setVisible: function (on) { this.group.visible = on; }
  };

  /* ===================================================== bus ============ */
  var bus = {
    lines: 0, n: 0,
    build: function () {
      var lines = (city.transit && city.transit.busLines) || [], acc = TP.CityBuilder.newAcc(true), y = Y().bus, i, k;
      this.group = new THREE.Group(); this.group.name = 'layer-bus';
      var all = [];
      for (i = 0; i < lines.length; i++) {
        var ln = lines[i], c = colCss(U.mix(TP.Theme.hex('--transit-bus'), TP.Theme.hex('--c-accent'), lines.length > 1 ? (i / (lines.length - 1)) * 0.6 : 0));
        if (ln.path && ln.path.length > 1) TP.CityBuilder.ribbonInto(acc, ln.path, 0.8, y + i * 0.02, false, c);
        var sp = ln.stops || [];
        for (k = 0; k < sp.length; k++) all.push({ kind: 'station', mode: 'bus', id: sp[k].id, name: sp[k].name, x: sp[k].x, z: sp[k].z, lineId: ln.id, districtId: districtOf(sp[k].x, sp[k].z) });
      }
      this.lines = lines.length;
      if (acc.pos.length) {
        this.line = new THREE.Mesh(TP.CityBuilder.accToGeometry(acc), new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
        this.line.renderOrder = 5; this.group.add(this.line);
      }
      this.all = all;
      var g = new THREE.CylinderGeometry(1, 1, 1, 10); g.translate(0, 0.5, 0);
      this.st = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ color: 0xffffff }), Math.max(1, all.length));
      this.st.userData = { kind: 'station', items: [] }; this.st.name = 'layer-bus-stop';
      this.group.add(this.st); L.pickables.push(this.st); L.group.add(this.group);
      this.layout();
    },
    layout: function () {
      var items = this.st.userData.items; items.length = 0;
      var c = col('--transit-bus'), y = Y().bus - 0.6;
      for (var i = 0; i < this.all.length; i++) {
        var it = this.all[i]; if (!passes(it)) continue;
        var j = items.length; setInst(this.st, j, it.x, y, it.z, 2.2, 1.6, 2.2); this.st.setColorAt(j, c); items.push(it);
      }
      this.st.count = this.n = items.length;
      this.st.instanceMatrix.needsUpdate = true; if (this.st.instanceColor) this.st.instanceColor.needsUpdate = true;
    },
    setVisible: function (on) { this.group.visible = on; }
  };

  /* ===================================================== od ============= */
  var OD_SEG = 48, OD_DOTS = 8;
  var od = {
    n: 0, arcs: [],
    build: function () {
      this.group = new THREE.Group(); this.group.name = 'layer-od';
      var dg = new THREE.SphereGeometry(1, 10, 8);
      this.dots = new THREE.InstancedMesh(dg, new THREE.MeshBasicMaterial({ color: 0xffffff }), 60 * OD_DOTS);
      this.dots.count = 0; this.dots.frustumCulled = false; this.dots.renderOrder = 14;
      this.group.add(this.dots);
      L.group.add(this.group);
      this.key = '';
    },
    /** 飞线几何只在 OD 对集合变化时重建（按日量定粗细）；时变量（volumeNow）只改颜色与光点 */
    rebuild: function (flows) {
      if (this.tube) { this.group.remove(this.tube); this.tube.geometry.dispose(); this.tube.material.dispose(); this.tube = null; }
      var maxV = 1, i, k;
      for (i = 0; i < flows.length; i++) if (flows[i].volume > maxV) maxV = flows[i].volume;
      var acc = TP.CityBuilder.newAcc(true), white = new THREE.Color(1, 1, 1);
      this.arcs = [];
      for (i = 0; i < flows.length; i++) {
        var f = flows[i]; if (!f.from || !f.to) continue;
        var a = new THREE.Vector3(f.from.x, 2, f.from.z), b = new THREE.Vector3(f.to.x, 2, f.to.z);
        var d = a.distanceTo(b), m = a.clone().add(b).multiplyScalar(0.5); m.y = 50 + d * 0.32;
        var curve = new THREE.QuadraticBezierCurve3(a, m, b);
        var rad = 0.7 + 2.3 * Math.sqrt(f.volume / maxV);
        var tg = new THREE.TubeGeometry(curve, OD_SEG, rad, 5, false);
        var start = acc.pos.length / 3;
        TP.CityBuilder.appendGeometry(acc, tg, white);
        var cnt = acc.pos.length / 3 - start; tg.dispose();
        var pts = curve.getPoints(64), arr = new Float32Array(65 * 3);
        for (k = 0; k <= 64; k++) { arr[k * 3] = pts[k].x; arr[k * 3 + 1] = pts[k].y; arr[k * 3 + 2] = pts[k].z; }
        this.arcs.push({ flow: f, key: f.fromId + '>' + f.toId, start: start, count: cnt, pts: arr, rad: rad, dots: 0, speed: 0.12, inten: 0.5, phase: (U.hashStr(f.fromId + f.toId) % 1000) / 1000 });
      }
      if (acc.pos.length) {
        this.tube = new THREE.Mesh(TP.CityBuilder.accToGeometry(acc), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.72, depthWrite: false }));
        this.tube.renderOrder = 13; this.group.add(this.tube);
      }
      this.n = this.arcs.length;
    },
    apply: function () {
      var flows = simGet('odFlows') || [], key = '', i;
      for (i = 0; i < flows.length; i++) key += flows[i].fromId + '>' + flows[i].toId + ';';
      if (key !== this.key) { this.key = key; this.rebuild(flows); }
      var byKey = {}, maxN = 1;
      for (i = 0; i < flows.length; i++) { byKey[flows[i].fromId + '>' + flows[i].toId] = flows[i]; if ((flows[i].volumeNow || 0) > maxN) maxN = flows[i].volumeNow; }
      var oc = col('--od-flow'), g = col('--stage-ground'), ca = this.tube ? this.tube.geometry.attributes.color : null;
      for (i = 0; i < this.arcs.length; i++) {
        var A = this.arcs[i], f = byKey[A.key] || A.flow;
        var show = passes({ districtId: f.fromId }) || passes({ districtId: f.toId });
        var t = show ? U.clamp((f.volumeNow || 0) / maxN, 0, 1) : 0;
        A.inten = t; A.show = show;
        A.dots = show ? 1 + Math.round(t * (OD_DOTS - 1)) : 0;
        A.speed = 0.08 + 0.14 * t;
        tmpC.copy(oc).lerp(g, show ? 0.7 - 0.6 * t : 0.93);
        if (ca) for (var v = A.start; v < A.start + A.count; v++) { ca.array[v * 3] = tmpC.r; ca.array[v * 3 + 1] = tmpC.g; ca.array[v * 3 + 2] = tmpC.b; }
      }
      if (ca) ca.needsUpdate = true;
      this.dotCol = col('--c-primary');
    },
    update: function (t) {
      var n = 0, mesh = this.dots;
      for (var i = 0; i < this.arcs.length; i++) {
        var A = this.arcs[i];
        for (var k = 0; k < A.dots; k++) {
          var u = (t * A.speed + A.phase + k / A.dots) % 1, fi = u * 64, j = Math.floor(fi), fr = fi - j, p = A.pts;
          if (j >= 64) { j = 63; fr = 1; }
          var x = U.lerp(p[j * 3], p[j * 3 + 3], fr), y = U.lerp(p[j * 3 + 1], p[j * 3 + 4], fr), z = U.lerp(p[j * 3 + 2], p[j * 3 + 5], fr);
          var s = A.rad * 1.5 + 1;
          setInst(mesh, n, x, y, z, s, s, s);
          if (this.dotCol) mesh.setColorAt(n, this.dotCol);
          n++;
          if (n >= 60 * OD_DOTS) break;
        }
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    },
    setVisible: function (on) { this.group.visible = on; if (on) this.apply(); }
  };

  /* ===================================================== signal ========= */
  var signal = {
    n: 0,
    build: function () {
      var sigs = city.signals || [];
      var g = flatGeo(new THREE.RingGeometry(0.62, 1, 24));
      this.mesh = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false }), Math.max(1, sigs.length));
      this.mesh.name = 'layer-signal'; this.mesh.renderOrder = 10;
      this.mesh.userData = { kind: 'intersection', items: [] };
      L.group.add(this.mesh); L.pickables.push(this.mesh);
      this.sigs = sigs;
      this.layout();
    },
    layout: function () {
      var items = this.mesh.userData.items; items.length = 0;
      var y = Y().overlay + 0.2;
      for (var i = 0; i < this.sigs.length; i++) {
        var s = this.sigs[i], n = intById[s.intersectionId];
        var x = s.x != null ? s.x : (n ? n.x : 0), z = s.z != null ? s.z : (n ? n.z : 0);
        var it = { kind: 'intersection', id: s.intersectionId, signalId: s.id, x: x, z: z, districtId: n ? n.districtId : districtOf(x, z), name: '' };
        if (!passes(it)) continue;
        setInst(this.mesh, items.length, x, y, z, 7.5, 1, 7.5); items.push(it);
      }
      this.mesh.count = this.n = items.length;
      this.mesh.instanceMatrix.needsUpdate = true;
      this.apply();
    },
    apply: function () {
      var st = simGet('signalStates') || {}, items = this.mesh.userData.items;
      var C = { green: col('--c-success'), yellow: col('--c-warn'), red: col('--c-danger') }, nd = col('--road-nodata');
      for (var i = 0; i < items.length; i++) {
        var s = st[items[i].signalId];
        this.mesh.setColorAt(i, s && C[s.phase] ? C[s.phase] : nd);
      }
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    },
    setVisible: function (on) { this.mesh.visible = on; if (on) this.apply(); }
  };

  /* ===================================================== parking ======== */
  var parking = {
    n: 0,
    build: function () {
      this.all = (city.facilities && city.facilities.parking) || [];
      var g = new THREE.BoxGeometry(1, 1, 1); g.translate(0, 0.5, 0);
      this.mesh = new THREE.InstancedMesh(g, new THREE.MeshLambertMaterial({ color: 0xffffff }), Math.max(1, this.all.length));
      this.mesh.name = 'layer-parking'; this.mesh.castShadow = false;
      this.mesh.userData = { kind: 'parking', items: [] };
      L.group.add(this.mesh); L.pickables.push(this.mesh);
      this.apply();
    },
    apply: function () {
      var st = simGet('parkingState') || {}, items = this.mesh.userData.items; items.length = 0;
      var C = { idle: col('--c-success'), normal: col('--c-info'), busy: col('--c-warn'), full: col('--c-danger') };
      for (var i = 0; i < this.all.length; i++) {
        var p = this.all[i]; if (!passes(p)) continue;
        var s = st[p.id], occ = s ? U.clamp01(s.occupancy) : 0;
        var j = items.length;
        setInst(this.mesh, j, p.x, 0, p.z, 10, 6 + occ * 46, 10);
        this.mesh.setColorAt(j, (s && C[s.status]) || C.normal);
        items.push({ kind: 'parking', id: p.id, name: p.name, districtId: p.districtId, x: p.x, z: p.z });
      }
      this.mesh.count = this.n = items.length;
      this.mesh.instanceMatrix.needsUpdate = true; if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    },
    setVisible: function (on) { this.mesh.visible = on; if (on) this.apply(); }
  };

  /* ===================================================== bike =========== */
  var bike = {
    n: 0,
    build: function () {
      this.all = (city.facilities && city.facilities.bike) || [];
      var g = new THREE.CylinderGeometry(1, 1, 1, 16); g.translate(0, 0.5, 0);
      this.mesh = new THREE.InstancedMesh(g, new THREE.MeshLambertMaterial({ color: 0xffffff }), Math.max(1, this.all.length));
      this.mesh.name = 'layer-bike'; this.mesh.userData = { kind: 'bike', items: [] };
      L.group.add(this.mesh); L.pickables.push(this.mesh);
      this.apply();
    },
    apply: function () {
      var st = simGet('bikeState') || {}, items = this.mesh.userData.items; items.length = 0;
      var ramp = [TP.Theme.hex('--c-danger'), TP.Theme.hex('--c-warn'), TP.Theme.hex('--c-success')];
      for (var i = 0; i < this.all.length; i++) {
        var b = this.all[i]; if (!passes(b)) continue;
        var s = st[b.id], cap = b.capacity || 40, av = s ? s.available : 0, r = U.clamp01(av / cap);
        var j = items.length, rad = 3 + 5 * Math.sqrt(r);
        setInst(this.mesh, j, b.x, Y().overlay, b.z, rad, 2.2, rad);
        this.mesh.setColorAt(j, colCss(U.ramp(ramp, r), tmpC));
        items.push({ kind: 'bike', id: b.id, name: b.name, districtId: b.districtId, x: b.x, z: b.z });
      }
      this.mesh.count = this.n = items.length;
      this.mesh.instanceMatrix.needsUpdate = true; if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    },
    setVisible: function (on) { this.mesh.visible = on; if (on) this.apply(); }
  };

  /* ===================================================== carbon ========= */
  var CARBON_ROADS = 28;
  var carbon = {
    n: 0,
    build: function () {
      var c = document.createElement('canvas'); c.width = c.height = 128;
      var g = c.getContext('2d'), grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      grd.addColorStop(0, '#fff'); grd.addColorStop(0.45, '#999'); grd.addColorStop(1, '#000');
      g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
      this.alpha = new THREE.CanvasTexture(c);
      var geo = flatGeo(new THREE.PlaneGeometry(2, 2));
      this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff, alphaMap: this.alpha, transparent: true, opacity: 0.8, depthWrite: false }), 6 + 12 + CARBON_ROADS);
      this.mesh.name = 'layer-carbon'; this.mesh.renderOrder = 0;
      this.mesh.position.y = Y().carbon;
      L.group.add(this.mesh);
    },
    /** 区级碳排（districtStats.carbon）+ 车流×里程 最大的路段（排放强度代理） */
    apply: function () {
      var ds = (city.districts) || [], st = simGet('districtStats') || {}, rs = simGet('roadStates') || {};
      var ramp = TP.Theme.heatRamp(), j = 0, i, maxC = 1;
      for (i = 0; i < ds.length; i++) { var s = st[ds[i].id]; if (s && s.carbon > maxC) maxC = s.carbon; }
      for (i = 0; i < ds.length; i++) {
        var d = ds[i], sc = st[d.id]; if (!passes(d) || !sc) continue;
        var v = U.clamp01(sc.carbon / maxC), c = d.center || U.polygonCentroid(d.polygon || []);
        var rad = 120 + 160 * Math.sqrt(v);
        setInst(this.mesh, j, c.x, 0, c.z, rad, 1, rad);
        this.mesh.setColorAt(j, colCss(U.ramp(ramp, v), tmpC)); j++;
      }
      var top = [];
      for (i = 0; i < RG.length; i++) {
        var r = rs[RG[i].id]; if (!r || RG[i].dim) continue;
        var e = (r.flow || 0) * RG[i].len * (1 + (r.level || 0) * 0.35);
        if (top.length < CARBON_ROADS || e > top[top.length - 1].e) {
          top.push({ i: i, e: e }); top.sort(function (a, b) { return b.e - a.e; }); if (top.length > CARBON_ROADS) top.pop();
        }
      }
      var maxE = top.length ? top[0].e : 1;
      for (i = 0; i < top.length; i++) {
        var G = RG[top[i].i], p = along(G, G.len / 2), vv = U.clamp01(top[i].e / maxE);
        var rr = 30 + 40 * vv;
        setInst(this.mesh, j, p.x, 0.01 * i, p.z, rr, 1, rr);
        this.mesh.setColorAt(j, colCss(U.ramp(ramp, 0.35 + 0.65 * vv), tmpC)); j++;
      }
      this.mesh.count = this.n = j;
      this.mesh.instanceMatrix.needsUpdate = true; if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    },
    setVisible: function (on) { this.mesh.visible = on; if (on) this.apply(); }
  };

  /* ===================================================== district ======= */
  var district = {
    setVisible: function (on) { if (TP.CityBuilder.setDistrictsVisible) TP.CityBuilder.setDistrictsVisible(on); }
  };

  subs = { traffic: traffic, vehicle: vehicle, heat: heat, incident: incident, metro: metro, bus: bus, od: od, signal: signal, parking: parking, bike: bike, carbon: carbon, district: district };
  var TIME_LAYERS = ['vehicle', 'heat', 'incident', 'od', 'signal', 'parking', 'bike', 'carbon'];

  /* ===================================================== API ============ */
  L.init = function (cityData, simRef) {
    if (L.ready) L.dispose();
    city = cityData || (TP.City && TP.City.data);
    sim = simRef || TP.Sim;
    if (!city) throw new Error('TP.Layers.init: 缺少城市数据');
    var t0 = U.now();
    L.group = new THREE.Group(); L.group.name = 'layers';
    L.pickables = [];
    TP.Scene.dataGroup.add(L.group);
    intById = {};
    var ints = city.intersections || [];
    for (var i = 0; i < ints.length; i++) intById[ints[i].id] = ints[i];
    buildRoadCache();
    buildColors();
    vehicle.build(); heat.build(); incident.build(); metro.build(); bus.build();
    od.build(); signal.build(); parking.build(); bike.build(); carbon.build();
    buildOverlays();
    for (var k = 0; k < L.LAYERS.length; k++) vis[L.LAYERS[k].id] = !!L.LAYERS[k].defaultOn;
    L.ready = true;
    for (k = 0; k < L.LAYERS.length; k++) applyVisible(L.LAYERS[k].id);
    L.applyTime();
    L.initMs = Math.round(U.now() - t0);
    TP.Scene.log('Layers.init ' + L.initMs + 'ms, particles=' + vehicle.n);
    return L;
  };

  function applyVisible(id) {
    var s = subs[id], on = !!vis[id];
    if (!s) return;
    if (id === 'traffic') { traffic.apply(true); return; }
    if (s.setVisible) s.setVisible(on);
  }

  L.setVisible = function (id, on) {
    if (!subs[id]) return false;
    vis[id] = !!on;
    if (L.ready) {
      applyVisible(id);
      if (id === 'traffic' && on === false && vis.vehicle) vehicle.apply();
    }
    return true;
  };
  L.isVisible = function (id) { return !!vis[id]; };
  L.toggle = function (id) { return L.setVisible(id, !vis[id]); };

  /** TP.Sim.setTime() 后调用：只重刷可见的时变图层，不可见的在打开时再刷 */
  L.applyTime = function () {
    if (!L.ready) return;
    var t0 = U.now();
    traffic.apply(false);
    for (var i = 0; i < TIME_LAYERS.length; i++) {
      var id = TIME_LAYERS[i];
      if (vis[id] || id === 'incident') subs[id].apply();
    }
    L.lastApplyMs = U.now() - t0;
    return L.lastApplyMs;
  };

  var tAcc = 0;
  L.update = function (dt) {
    if (!L.ready) return;
    var dts = U.clamp((dt == null ? 16.7 : dt) / 1000, 0, 0.1);
    tAcc += dts;
    if (vis.vehicle) vehicle.update(dts);
    if (vis.incident) incident.update(tAcc);
    if (vis.od) od.update(tAcc);
    if (selMarker && selMarker.visible) {
      selT += dts;
      var s = selMarker.userData.base * (1 + 0.18 * Math.sin(selT * 4));
      selMarker.scale.set(s, 1, s);
    }
  };

  L.applyTheme = function () {
    if (!L.ready) return;
    buildColors();
    heat.buildLut();
    incident.cols = incident.makeCols();
    for (var i = 0; i < RG.length; i++) RG[i].lastKey = -99;
    traffic.apply(true);
    metro.group.parent.remove(metro.group); L.pickables.splice(L.pickables.indexOf(metro.st), 1); metro.build(); metro.setVisible(vis.metro);
    bus.group.parent.remove(bus.group); L.pickables.splice(L.pickables.indexOf(bus.st), 1); bus.build(); bus.setVisible(vis.bus);
    incident.sig = '';
    for (var k = 0; k < TIME_LAYERS.length; k++) subs[TIME_LAYERS[k]].apply(true);
    if (hoverMesh) hoverMesh.material.color.copy(col('--c-panel'));
    if (selMesh) selMesh.material.color.copy(col('--c-primary'));
    if (selMarker) selMarker.material.color.copy(col('--c-primary'));
  };

  L.setRegionFilter = function (fn) {
    regionFn = typeof fn === 'function' ? fn : null;
    if (!L.ready) return;
    traffic.apply(true);
    metro.layout(); bus.layout(); signal.layout();
    incident.sig = '';
    for (var i = 0; i < TIME_LAYERS.length; i++) subs[TIME_LAYERS[i]].apply(true);
  };

  L.setParticleScale = function (f) {
    f = U.clamp(+f || 1, 0.1, 1);
    if (f === particleScale) return;
    particleScale = f;
    if (L.ready && vis.vehicle) vehicle.apply();
  };

  /* ===================================================== 高亮 / 拾取 ==== */
  function buildOverlays() {
    hoverMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: col('--c-panel'), transparent: true, opacity: 0.55, depthWrite: false }));
    hoverMesh.visible = false; hoverMesh.renderOrder = 20; hoverMesh.name = 'hover-road';
    selMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: col('--c-primary'), transparent: true, opacity: 0.9, depthWrite: false }));
    selMesh.visible = false; selMesh.renderOrder = 19; selMesh.name = 'select-road';
    selMarker = new THREE.Mesh(flatGeo(new THREE.RingGeometry(0.75, 1, 48)), new THREE.MeshBasicMaterial({ color: col('--c-primary'), transparent: true, opacity: 0.9, depthWrite: false }));
    selMarker.visible = false; selMarker.renderOrder = 21; selMarker.userData.base = 14;
    L.group.add(selMesh); L.group.add(hoverMesh); L.group.add(selMarker);
  }

  /** CameraRig 内部 hover 钩子：命中道路即叠加提亮描边带 */
  L._rigHover = function (hit) {
    var id = hit && hit.kind === 'road' ? hit.roadId || hit.id : null;
    if (id === hoverRoadId) return;
    hoverRoadId = id;
    if (!id) { hoverMesh.visible = false; return; }
    var g = TP.CityBuilder.roadOverlayGeometry(id, 1.6, Y().overlay + 0.1);
    if (!g) { hoverMesh.visible = false; return; }
    hoverMesh.geometry.dispose(); hoverMesh.geometry = g; hoverMesh.visible = true;
  };

  function findItem(kind, id) {
    var meshes = L.pickables;
    for (var i = 0; i < meshes.length; i++) {
      var ud = meshes[i].userData;
      if (!ud || !ud.items) continue;
      for (var k = 0; k < ud.items.length; k++) if (ud.items[k].id === id && (!kind || ud.items[k].kind === kind)) return ud.items[k];
    }
    if (kind === 'incident' || !kind) { var inc = simGet('incidents') || []; for (var j = 0; j < inc.length; j++) if (inc[j].id === id) return inc[j]; }
    return null;
  }

  /** highlight(id, kind)：kind = 'road'（默认）| 'incident' | 'station' | 'parking' | 'bike' | 'intersection' | 'hub'；id=null 取消 */
  L.highlight = function (id, kind) {
    selMesh.visible = false; selMarker.visible = false; selKey = null;
    if (id == null) return;
    kind = kind || (rgIndex[id] != null ? 'road' : null);
    selKey = kind + ':' + id;
    if (kind === 'road') {
      var g = TP.CityBuilder.roadOverlayGeometry(id, 2.4, Y().overlay + 0.05);
      if (g) { selMesh.geometry.dispose(); selMesh.geometry = g; selMesh.visible = true; }
      return;
    }
    var it = findItem(kind, id);
    if (!it && intById[id]) it = intById[id];
    if (it) { selMarker.position.set(it.x, Y().overlay + 0.4, it.z); selMarker.userData.base = kind === 'incident' ? 26 : 16; selMarker.visible = true; selT = 0; }
  };
  L.highlighted = function () { return selKey; };

  function roadHit(r) { return r ? { kind: 'road', id: r.id, roadId: r.id, districtId: r.districtId, name: r.name } : null; }

  /**
   * resolveHit(object, instanceId, point, raw) → { kind, id, roadId?, districtId?, name } | null
   * object 为空（点在空地）时按"随视距放大的容差"吸附最近路段，远景也容易点中细路。
   */
  L.resolveHit = function (object, instanceId, point, raw) {
    var ud = object && object.userData;
    var dist = (TP.CameraRig && TP.CameraRig.distance) || 1200;
    var tol = U.clamp(dist * 0.012, 5, 30);
    if (ud && ud.kind === 'road') {
      var rid = TP.CityBuilder.roadIdFromHit(object, raw && raw.face);
      if (rid) return roadHit(TP.CityBuilder.roadById(rid));
    }
    if (ud && ud.items && instanceId != null && ud.items[instanceId]) {
      var it = ud.items[instanceId];
      var out = { kind: it.kind || ud.kind, id: it.id, districtId: it.districtId || null, name: it.name || it.title || '' };
      if (it.roadId) out.roadId = it.roadId;
      if (it.signalId) out.signalId = it.signalId;
      if (it.mode) out.mode = it.mode;
      if (it.lineId) out.lineId = it.lineId;
      if (out.kind === 'incident') { out.name = it.title || ''; out.roadId = it.roadId; }
      return out;
    }
    if (!point) return null;
    if (ud && ud.kind === 'building') {
      var b = city.buildings[ud.indices[instanceId]];
      var nr = b ? nearestRoad(b.x, b.z, Math.max(b.w, b.d) / 2 + 30) : null;
      return roadHit(nr);
    }
    return roadHit(nearestRoad(point.x, point.z, tol));
  };
  L.nearestRoad = function (x, z, tol) { return nearestRoad(x, z, tol || 20); };

  L.stats = function () {
    return { particles: vehicle.active, particleCap: vehicle.n, incidents: incident.list.length, applyMs: L.lastApplyMs, roads: RG.length };
  };

  L.dispose = function () {
    if (!L.group) return;
    for (var i = 0; i < incident.labels.length; i++) incident.labels[i].remove();
    incident.labels = []; incident.sig = ''; od.key = '';
    L.group.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { if (o.material.map) o.material.map.dispose(); if (o.material.alphaMap) o.material.alphaMap.dispose(); o.material.dispose(); }
    });
    if (L.group.parent) L.group.parent.remove(L.group);
    L.group = null; L.pickables = []; L.ready = false;
  };

})(window);
