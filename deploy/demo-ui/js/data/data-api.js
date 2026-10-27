/* ============================================================================
 * data-api.js —— 数据接口门面（前端唯一取数入口）
 * 命名空间：TP.Api
 * 依赖：TP.Util、TP.City、TP.Sim
 *
 * 设计意图：
 *   3D 图层可以直读 TP.Sim（每帧要读上千条路段，走门面太浪费），
 *   但**图表层与 UI 层一律走这里** —— 这样"数据怎么算"与"界面怎么画"彻底解耦，
 *   将来把 mock 换成真实后端，只需要替换本文件的 adapter 分支。
 *
 * 全部派生数据都是**纯函数 + 缓存**，不持有业务状态（除 UI 交互状态 state）。
 * ==========================================================================*/
(function (window) {
  'use strict';

  var TP = window.TP = window.TP || {};
  var U = TP.Util;

  /* ================================================================== *
   * 0. 静态元数据
   * ================================================================== */

  function svg(inner) {
    return '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" ' +
      'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
  }

  var MODULES = [
    { id: 'traffic', name: '路况态势' },
    { id: 'od',      name: 'OD 出行' },
    { id: 'transit', name: '公交地铁' },
    { id: 'signal',  name: '信号绿波' },
    { id: 'park',    name: '停车慢行' },
    { id: 'carbon',  name: '绿色出行' }
  ];

  var VIEWS = [
    { id: 'orbit',  name: '自由环绕',   desc: '拖拽旋转观察',   key: '1' },
    { id: 'top',    name: '俯视平面',   desc: '路网平面读图',   key: '2' },
    { id: 'bird',   name: '斜45°鸟瞰',  desc: '汇报常用机位',   key: '3' },
    { id: 'cruise', name: '巡航飞行',   desc: '沿走廊自动漫游', key: '4' }
  ];

  /* 图层 id 必须与 docs/3D-CONTRACT.md §5.1 完全一致 */
  var LAYERS = [
    { id: 'traffic',  name: '实时路况',   defaultOn: true,  icon: svg('<path d="M4 14V2M12 14V2M8 5v2M8 10v2"/>'), unit: '条路段' },
    { id: 'vehicle',  name: '车流粒子',   defaultOn: false, icon: svg('<path d="M2.2 10.5h11.6l-1.1-4.2a1.5 1.5 0 00-1.45-1.1H4.75A1.5 1.5 0 003.3 6.3L2.2 10.5z"/><circle cx="5" cy="12.2" r="1.3"/><circle cx="11" cy="12.2" r="1.3"/>'), unit: '辆' },
    { id: 'heat',     name: '拥堵热力',   defaultOn: true,  icon: svg('<circle cx="8" cy="8" r="5.2"/><circle cx="8" cy="8" r="2.1"/>'), unit: '热点' },
    { id: 'incident', name: '事件告警',   defaultOn: true,  icon: svg('<path d="M8 2.2l6 11.3H2L8 2.2z"/><path d="M8 6.2v3M8 11.4h.01"/>'), unit: '起' },
    { id: 'metro',    name: '地铁线网',   defaultOn: false, icon: svg('<rect x="4" y="2" width="8" height="10" rx="2"/><path d="M4 8h8M6.2 14l1-2M9.8 14l-1-2"/>'), unit: '条' },
    { id: 'bus',      name: '公交线网',   defaultOn: false, icon: svg('<rect x="3" y="3" width="10" height="9" rx="2"/><path d="M3 8h10"/><circle cx="6" cy="13.2" r="1"/><circle cx="10" cy="13.2" r="1"/>'), unit: '条' },
    { id: 'od',       name: 'OD 飞线',    defaultOn: false, icon: svg('<path d="M3 12.5c3.2 0 3.2-8.5 10-8.5"/><path d="M10 2l3 2-3 2"/>'), unit: '条' },
    { id: 'signal',   name: '信号配时',   defaultOn: false, icon: svg('<rect x="5" y="2" width="6" height="11" rx="2"/><circle cx="8" cy="5.2" r="1"/><circle cx="8" cy="9.4" r="1"/>'), unit: '个' },
    { id: 'parking',  name: '停车场',     defaultOn: false, icon: svg('<rect x="3" y="2" width="10" height="12" rx="2"/><path d="M6.4 11.2V5h2.2a2 2 0 010 4H6.4"/>'), unit: '处' },
    { id: 'bike',     name: '共享单车',   defaultOn: false, icon: svg('<circle cx="4" cy="11" r="2.4"/><circle cx="12" cy="11" r="2.4"/><path d="M4 11l3-6h3l2 6"/>'), unit: '个' },
    { id: 'carbon',   name: '碳排热点',   defaultOn: false, icon: svg('<path d="M13.2 3C7 3 3 6.2 3 11c0 1.4.5 2 1.9 2 5 0 8.3-4 8.3-10z"/><path d="M5 13l3.6-3.8"/>'), unit: '处' },
    { id: 'district', name: '行政区边界', defaultOn: true,  icon: svg('<path d="M8 2l5 3v6l-5 3-5-3V5l5-3z" stroke-dasharray="2 2"/>'), unit: '个' }
  ];

  var LEVEL_NAMES = ['畅通', '缓行', '拥堵', '严重拥堵'];

  /* ================================================================== *
   * 1. 交互状态
   * ================================================================== */

  var state = {
    minute: 0,
    dayType: 'weekday',
    regionId: 'all',
    viewMode: 'bird',
    moduleId: 'traffic',
    signalGroupId: null,
    metric: 'congestionIndex',
    layers: {},
    selected: null
  };

  var listeners = {};
  var cache = {};
  var _initialized = false;

  var adapter = {
    mode: 'mock',
    baseUrl: '',
    pollMs: 2000,
    timer: null,
    fetchSnapshot: function () {
      if (adapter.mode !== 'live' || !adapter.baseUrl || typeof window.fetch !== 'function') {
        return Promise.resolve(null);
      }
      try {
        return window.fetch(adapter.baseUrl.replace(/\/$/, '') + '/snapshot')
          .then(function (r) { return r.ok ? r.json() : null; })
          .catch(function () { return null; });
      } catch (e) {
        return Promise.resolve(null);
      }
    },
    pushSelect: function (sel) {
      if (adapter.mode !== 'live' || !adapter.baseUrl || typeof window.fetch !== 'function') {
        return Promise.resolve(null);
      }
      try {
        return window.fetch(adapter.baseUrl.replace(/\/$/, '') + '/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sel || null)
        }).then(function (r) { return r.ok ? r.json() : null; })
          .catch(function () { return null; });
      } catch (e) {
        return Promise.resolve(null);
      }
    }
  };

  /* ================================================================== *
   * 2. 内部工具
   * ================================================================== */

  function city() { return TP.City && TP.City.data ? TP.City.data : null; }
  function sim() { return TP.Sim && TP.Sim.ready ? TP.Sim : null; }

  function invalidate() { cache = {}; }

  /** 缓存键：任何会影响派生结果的状态变化都会改这个键 */
  function sig(extra) {
    return [state.minute, state.dayType, state.regionId, state.moduleId,
      state.signalGroupId, extra || ''].join('|');
  }

  function memo(key, fn) {
    if (cache[key] !== undefined) return cache[key];
    cache[key] = fn();
    return cache[key];
  }

  function emit(evt, payload) {
    var arr = listeners[evt];
    if (!arr) return;
    for (var i = 0; i < arr.length; i++) {
      try { arr[i](payload); } catch (e) {
        if (window.console) window.console.error('[Api] listener error on "' + evt + '"', e);
      }
    }
  }

  function themeHex(name, fb) {
    if (TP.Theme && TP.Theme.hex) return TP.Theme.hex(name, fb);
    return fb || '#1a5fb4';
  }

  function levelColor(level) {
    var keys = ['--road-free', '--road-slow', '--road-jam', '--road-block'];
    return themeHex(keys[U.clamp(level, 0, 3)] || '--road-nodata', '#b9c4d0');
  }

  var CLS_CN = { expressway: '快速路', arterial: '主干路', secondary: '次干路', branch: '支路' };
  var HUB_CN = { rail: '铁路枢纽', air: '机场', bus: '公路客运', port: '港口码头' };

  /* ================================================================== *
   * 3. 初始化与状态变更
   * ================================================================== */

  function init(opts) {
    opts = opts || {};
    if (adapter.mode !== opts.mode && opts.mode) adapter.mode = opts.mode;
    adapter.baseUrl = opts.baseUrl || adapter.baseUrl;
    adapter.pollMs = opts.pollMs || adapter.pollMs;

    /* 默认时刻：跟随真实时间；若落在深夜（路网几乎为空）则给一个早高峰机位，
       否则评审一打开就是"空城"。可用 setMinute 随时改。 */
    if (!_initialized) {
      var now = new Date();
      var real = now.getHours() * 60 + now.getMinutes();
      state.minute = (real < 360 || real > 1380) ? 490 : real;
    }

    /* 图层默认开关 */
    for (var i = 0; i < LAYERS.length; i++) {
      if (state.layers[LAYERS[i].id] === undefined) {
        state.layers[LAYERS[i].id] = !!LAYERS[i].defaultOn;
      }
    }

    if (!state.signalGroupId) {
      var gw = sim() && TP.Sim.greenWaves ? Object.keys(TP.Sim.greenWaves) : [];
      state.signalGroupId = gw.length ? gw[0] : null;
    }

    if (sim()) TP.Sim.setTime(state.minute);
    if (sim() && TP.Sim.setDay) TP.Sim.setDay(state.dayType);

    _initialized = true;
    invalidate();
    emit('ready', { state: state });
    return API;
  }

  /* 注意：状态占位在模块加载时只做一次；真实数据要等 app.js 调 TP.Api.init()。
     自动初始化必须放在 API 对象定义**之后**（init 内部会 return API）。 */

  function setMinute(m) {
    state.minute = U.wrap(Math.round(m), 1440);
    if (sim()) TP.Sim.setTime(state.minute);
    invalidate();
    emit('time', { minute: state.minute, hhmm: U.hhmm(state.minute) });
    emit('live', liveFrame());
    return API;
  }

  /* 时间轴播放：由 app 每帧调用，内部按真实时间累积推进 */
  var _playAccum = 0;
  function setMinuteAuto(dtMs, speed) {
    speed = speed || 1;
    /* 1 档 = 60 秒走完 24 小时 */
    _playAccum += dtMs * speed * (1440 / 60000);
    if (_playAccum < 1) return state.minute;
    var step = Math.floor(_playAccum);
    _playAccum -= step;
    setMinute(state.minute + step);
    return state.minute;
  }

  function setDayType(t) {
    var v = (t === 'weekend') ? 'weekend' : 'weekday';
    if (state.dayType === v) return API;
    state.dayType = v;
    if (sim() && TP.Sim.setDay) TP.Sim.setDay(v);
    if (sim()) TP.Sim.setTime(state.minute);
    invalidate();
    emit('daytype', { dayType: v, dayTypeName: v === 'weekend' ? '周末' : '工作日' });
    return API;
  }

  function setRegion(id) {
    var d = city();
    var ok = (id === 'all');
    if (!ok && d) {
      for (var i = 0; i < d.districts.length; i++) if (d.districts[i].id === id) ok = true;
    }
    if (!ok) id = 'all';
    if (state.regionId === id) return API;
    state.regionId = id;
    invalidate();
    emit('region', { regionId: id });
    return API;
  }

  function setViewMode(m) {
    for (var i = 0; i < VIEWS.length; i++) {
      if (VIEWS[i].id === m) { state.viewMode = m; emit('view', { viewMode: m }); return API; }
    }
    return API;
  }

  function setModule(id) {
    for (var i = 0; i < MODULES.length; i++) {
      if (MODULES[i].id === id) {
        if (state.moduleId === id) return API;
        state.moduleId = id;
        invalidate();
        emit('module', { moduleId: id });
        return API;
      }
    }
    return API;
  }

  function setSignalGroup(gid) {
    var gw = sim() && TP.Sim.greenWaves;
    if (!gw) return API;
    if (!gw[gid]) {
      for (var k in gw) if (gw[k].corridorId === gid) { gid = k; break; }
    }
    if (!gw[gid]) return API;
    state.signalGroupId = gid;
    invalidate();
    emit('signalgroup', { signalGroupId: gid });
    return API;
  }

  function setMetric(m) {
    state.metric = m || 'congestionIndex';
    invalidate();
    emit('metric', { metric: state.metric });
    return API;
  }

  function setLayer(id, on) {
    var found = false;
    for (var i = 0; i < LAYERS.length; i++) if (LAYERS[i].id === id) found = true;
    if (!found) return API;
    state.layers[id] = !!on;
    emit('layer', { id: id, on: !!on });
    return API;
  }

  function setSelected(sel) {
    state.selected = sel || null;
    emit('select', state.selected);
    if (adapter.mode === 'live') adapter.pushSelect(state.selected);
    return API;
  }

  function refresh() {
    if (sim()) TP.Sim.setTime(state.minute, true);
    invalidate();
    emit('live', liveFrame());
    return API;
  }

  function liveFrame() {
    return { ts: Date.now(), minute: state.minute, hhmm: U.hhmm(state.minute), dayType: state.dayType };
  }

  /* ================================================================== *
   * 4. 区域筛选
   * ================================================================== */

  /** 返回一个判定函数：item 需含 districtId；regionId 为 all 时恒真 */
  function regionFilter() {
    if (state.regionId === 'all') return function () { return true; };
    var rid = state.regionId;
    return function (item) {
      if (!item) return true;
      var d = item.districtId || item.district || item.id;
      return d === rid;
    };
  }

  function visibleRoadIds() {
    var out = {};
    var d = city();
    if (!d) return out;
    if (state.regionId === 'all') {
      for (var i = 0; i < d.roads.length; i++) out[d.roads[i].id] = 1;
      return out;
    }
    for (var k = 0; k < d.roads.length; k++) {
      if (d.roads[k].districtId === state.regionId) out[d.roads[k].id] = 1;
    }
    return out;
  }

  function setRegionFilterOnLayers() {
    if (TP.Layers && TP.Layers.setRegionFilter) {
      TP.Layers.setRegionFilter(state.regionId === 'all' ? null : regionFilter());
    }
    return API;
  }

  function regionRoads() {
    var d = city();
    if (!d) return [];
    if (state.regionId === 'all') return d.roads;
    var out = [];
    for (var i = 0; i < d.roads.length; i++) {
      if (d.roads[i].districtId === state.regionId) out.push(d.roads[i]);
    }
    return out;
  }

  /* ================================================================== *
   * 5. 快照与顶栏
   * ================================================================== */

  function snapshot() {
    return memo('snap|' + sig(), function () {
      var d = city(), s = sim();
      var kpi = s ? s.kpi : {};
      var districts = [];
      var stats = s ? s.districtStats : {};
      if (d) {
        for (var i = 0; i < d.districts.length; i++) {
          var dd = d.districts[i];
          var st = stats[dd.id] || {};
          districts.push({
            id: dd.id, name: dd.name, short: dd.short, color: dd.color,
            center: dd.center, polygon: dd.polygon,
            areaKm2: dd.areaKm2, population: dd.population, jobs: dd.jobs,
            roadKm: dd.roadKm, vehicleStock: dd.vehicleStock, weight: dd.weight,
            avgSpeed: st.avgSpeed || 0,
            congestionIndex: st.congestionIndex || 0,
            flow: st.flow || 0,
            inNetVehicles: st.inNetVehicles || 0,
            saturation: st.saturation || 0,
            incidents: st.incidents || 0,
            transitRidership: st.transitRidership || 0,
            parkingOccupancy: st.parkingOccupancy || 0,
            carbon: st.carbon || 0
          });
        }
      }
      return {
        time: {
          minute: state.minute,
          hhmm: U.hhmm(state.minute),
          dayType: state.dayType,
          dayTypeName: state.dayType === 'weekend' ? '周末' : '工作日',
          phaseName: kpi.phaseName || ''
        },
        kpi: {
          avgSpeed: kpi.avgSpeed || 0,
          congestionIndex: kpi.congestionIndex || 0,
          inNetVehicles: kpi.inNetVehicles || 0,
          totalFlow: kpi.totalFlow || 0,
          flowRate: kpi.flowRate || 0,
          incidentCount: kpi.incidentCount || 0,
          transitRidership: kpi.transitRidership || 0,
          transitShare: kpi.transitShare || 0,
          parkingOccupancy: kpi.parkingOccupancy || 0,
          parkingAvailable: kpi.parkingAvailable || 0,
          bikeRides: kpi.bikeRides || 0,
          bikeTurnover: kpi.bikeTurnover || 0,
          carbonToday: kpi.carbonToday || 0,
          carbonSaved: kpi.carbonSaved || 0,
          greenShare: kpi.greenShare || 0,
          onTimeRate: kpi.onTimeRate || 0,
          avgDelay: kpi.avgDelay || 0,
          avgQueue: kpi.avgQueue || 0,
          signalCount: kpi.signalCount || 0,
          greenWaveCount: kpi.greenWaveCount || 0,
          emergencyResp: kpi.emergencyResp || 0,
          linkFlowSum: kpi.linkFlowSum || 0,
          congestionDelta: kpi.congestionDelta || 0,
          speedDelta: kpi.speedDelta || 0,
          flowDelta: kpi.flowDelta || 0
        },
        districts: districts,
        layers: layersMeta(),
        regions: regionsMeta(),
        views: viewsMeta(),
        modules: modulesMeta(),
        alerts: alertsFeed()
      };
    });
  }

  function regionsMeta() {
    var d = city();
    var out = [{ id: 'all', name: '全市', value: 0, unit: 'km', active: state.regionId === 'all' }];
    if (!d) return out;
    var totalKm = 0;
    for (var i = 0; i < d.districts.length; i++) totalKm += d.districts[i].roadKm;
    out[0].value = U.round(totalKm, 1);
    for (var k = 0; k < d.districts.length; k++) {
      var dd = d.districts[k];
      out.push({
        id: dd.id, name: dd.name, short: dd.short,
        value: dd.roadKm, unit: 'km',
        population: dd.population,
        active: state.regionId === dd.id
      });
    }
    return out;
  }

  function layersMeta() {
    var s = sim();
    var out = [];
    for (var i = 0; i < LAYERS.length; i++) {
      var L = LAYERS[i];
      out.push({
        id: L.id, name: L.name, icon: L.icon, unit: L.unit,
        on: !!state.layers[L.id],
        count: layerCount(L.id, s)
      });
    }
    return out;
  }

  function layerCount(id, s) {
    var d = city();
    if (!s || !d) return 0;
    switch (id) {
      case 'traffic':
      case 'vehicle': {
        var roads = regionRoads();
        if (id === 'traffic') return roads.length;
        var v = 0;
        for (var i = 0; i < roads.length; i++) {
          var rs = s.roadStates[roads[i].id];
          if (rs) v += rs.vehicles;
        }
        return v;
      }
      case 'heat': return s.activeIncidents.length + districtCongestedCount(s);
      case 'incident': return s.activeIncidents.length;
      case 'metro': return d.transit.metroLines.length;
      case 'bus': return d.transit.busLines.length;
      case 'od': return s.odFlows.length;
      case 'signal': return d.signals.length;
      case 'parking': return d.facilities.parking.length;
      case 'bike': return d.facilities.bike.length;
      case 'carbon': return d.districts.length;
      case 'district': return d.districts.length;
      default: return 0;
    }
  }

  function districtCongestedCount(s) {
    var n = 0;
    for (var k in s.districtStats) {
      if (Object.prototype.hasOwnProperty.call(s.districtStats, k) &&
          s.districtStats[k].congestionIndex >= 6) n++;
    }
    return n;
  }

  function modulesMeta() {
    var out = [];
    for (var i = 0; i < MODULES.length; i++) {
      out.push({
        id: MODULES[i].id, name: MODULES[i].name,
        active: state.moduleId === MODULES[i].id
      });
    }
    return out;
  }

  function viewsMeta() {
    var out = [];
    for (var i = 0; i < VIEWS.length; i++) {
      out.push({
        id: VIEWS[i].id, name: VIEWS[i].name, desc: VIEWS[i].desc, key: VIEWS[i].key,
        active: state.viewMode === VIEWS[i].id
      });
    }
    return out;
  }

  function meta() {
    var d = city();
    if (!d) return { cityName: '—' };
    return {
      cityName: d.meta.name,
      roadKm: d.meta.roadKm,
      roadCount: d.meta.roadCount,
      nodeCount: d.meta.nodeCount,
      buildingCount: d.meta.buildingCount,
      signalCount: d.meta.signalCount,
      corridorCount: d.meta.corridorCount,
      areaKm2: d.meta.areaKm2,
      population: d.meta.population,
      districts: d.meta.districts,
      unitMeters: d.meta.unitMeters
    };
  }

  function districts() {
    var d = city();
    return d ? d.districts : [];
  }

  function ticker() {
    return memo('ticker|' + sig(), function () {
      var s = sim();
      if (!s) return [];
      var k = s.kpi;
      var m = meta();
      return [
        { label: '路网总里程', value: U.int(m.roadKm), unit: 'km', trend: 0 },
        { label: '在网车辆', value: U.compact(k.inNetVehicles), unit: '辆', trend: k.flowDelta },
        { label: '路网平均速度', value: U.fixed(k.avgSpeed, 1), unit: 'km/h', trend: k.speedDelta },
        { label: '拥堵指数', value: U.fixed(k.congestionIndex, 2), unit: '', trend: -k.congestionDelta, invert: true },
        { label: '进行中事件', value: U.int(k.incidentCount), unit: '起', trend: 0, invert: true },
        { label: '公共交通客流', value: U.fixed(k.transitRidership, 1), unit: '万人次', trend: 0 },
        { label: '信号联网路口', value: U.int(k.signalCount), unit: '个', trend: 0 },
        { label: '绿色出行占比', value: U.fixed(k.greenShare, 1), unit: '%', trend: 0 }
      ];
    });
  }

  /** 取序列上以当前时刻为中心的一段做迷你走势图 */
  function sparkOf(metric, n) {
    var se = series(metric);
    n = n || 20;
    if (!se || !se.y || !se.y.length) return [];
    var idx = Math.floor(state.minute / 5);
    var half = Math.floor(n / 2);
    var out = [];
    for (var i = -half; i <= half; i++) {
      var j = U.wrap(idx + i, se.y.length);
      out.push(se.y[j]);
    }
    return out;
  }

  function kpiCards() {
    return memo('kpiCards|' + sig(), function () {
      var s = sim();
      if (!s) return [];
      var k = s.kpi;
      function lv(ci, warn, bad) { return ci >= bad ? 'bad' : (ci >= warn ? 'warn' : 'ok'); }
      return [
        {
          id: 'speed', label: '路网平均速度', value: U.fixed(k.avgSpeed, 1), unit: 'km/h',
          decimals: 1, trend: k.speedDelta, trendText: U.signed(k.speedDelta, 1) + '%',
          foot: '较昨日同期', spark: sparkOf('avgSpeed'), color: themeHex('--c-primary'),
          level: k.avgSpeed < 20 ? 'bad' : (k.avgSpeed < 28 ? 'warn' : 'ok')
        },
        {
          id: 'congestion', label: '拥堵指数', value: U.fixed(k.congestionIndex, 2), unit: '',
          decimals: 2, trend: -k.congestionDelta, trendText: U.signed(-k.congestionDelta, 2),
          foot: '0–10，>6 为拥堵', spark: sparkOf('congestionIndex'), color: levelColor(k.congestionIndex >= 6 ? 3 : (k.congestionIndex >= 4.5 ? 2 : 1)),
          level: lv(k.congestionIndex, 4.5, 6)
        },
        {
          id: 'vehicles', label: '在网车辆', value: U.compact(k.inNetVehicles), unit: '辆',
          decimals: 0, trend: 0, trendText: '实时',
          foot: '全网断面累计', spark: sparkOf('flow').map(function (v) { return v / 100; }),
          color: themeHex('--c-accent'), level: 'ok'
        },
        {
          id: 'incidents', label: '进行中交通事件', value: U.int(k.incidentCount), unit: '起',
          decimals: 0, trend: 0, trendText: '实时',
          foot: '平均响应 ' + U.fixed(k.emergencyResp, 1) + ' 分钟',
          spark: sparkOf('incidents'), color: k.incidentCount > 12 ? themeHex('--c-danger') : themeHex('--c-warn'),
          level: k.incidentCount > 16 ? 'bad' : (k.incidentCount > 9 ? 'warn' : 'ok')
        }
      ];
    });
  }

  /* ================================================================== *
   * 6. 排行
   * ================================================================== */

  function ranking(kind, metric, n) {
    n = n || 8;
    return memo('rank|' + sig(kind + '#' + metric + '#' + n), function () {
      var s = sim();
      if (!s) return [];
      var raw = [];
      var i, k;
      if (kind === 'district') {
        for (var kk in s.districtStats) {
          if (!Object.prototype.hasOwnProperty.call(s.districtStats, kk)) continue;
          var ds = s.districtStats[kk];
          raw.push({ id: kk, name: ds.name, v: ds.congestionIndex, unit: '', extra: U.fixed(ds.avgSpeed, 1) + ' km/h' });
        }
      } else if (kind === 'corridor') {
        var d = city();
        for (i = 0; i < d.corridors.length; i++) {
          var c = d.corridors[i];
          var sumLen = 0, acc = 0, spd = 0;
          for (k = 0; k < c.roadIds.length; k++) {
            var rs = s.roadStates[c.roadIds[k]];
            var rd = TP.City.roadById(c.roadIds[k]);
            if (!rs || !rd) continue;
            sumLen += rd.lengthM;
            acc += rs.congestionIndex * rd.lengthM;
            spd += rs.speed * rd.lengthM;
          }
          if (sumLen <= 0) continue;
          raw.push({
            id: c.id, name: c.name, v: U.round(acc / sumLen, 2), unit: '',
            extra: U.fixed(spd / sumLen, 1) + ' km/h'
          });
        }
      } else if (kind === 'road') {
        var roads = regionRoads();
        for (i = 0; i < roads.length; i++) {
          if (roads[i].lengthM < 120) continue;
          var r2 = s.roadStates[roads[i].id];
          if (!r2) continue;
          raw.push({ id: roads[i].id, name: roads[i].name, v: r2.congestionIndex, unit: '', extra: U.fixed(r2.speed, 1) + ' km/h' });
        }
      } else if (kind === 'metroLine' || kind === 'busLine') {
        var want = kind === 'metroLine' ? 'metro' : 'bus';
        for (var lid in s.transitState) {
          if (!Object.prototype.hasOwnProperty.call(s.transitState, lid)) continue;
          var L = s.transitState[lid];
          if (L.kind !== want) continue;
          raw.push({ id: lid, name: L.name, v: L.ridership, unit: '万人次/h', extra: '满载 ' + U.fixed(L.load * 100, 0) + '%' });
        }
      } else if (kind === 'parking') {
        var ps = s.parkingState;
        for (var pid in ps) {
          if (!Object.prototype.hasOwnProperty.call(ps, pid)) continue;
          raw.push({ id: pid, name: ps[pid].name, v: U.round(ps[pid].occupancy * 100, 1), unit: '%', extra: '余 ' + U.int(ps[pid].available) + ' 位' });
        }
      }
      raw.sort(function (a, b) { return b.v - a.v; });
      var top = raw.slice(0, n);
      var max = top.length ? top[0].v : 1;
      var out = [];
      for (i = 0; i < top.length; i++) {
        var t = top[i];
        var lvl = kind === 'parking'
          ? (t.v >= 95 ? 3 : (t.v >= 85 ? 2 : (t.v >= 60 ? 1 : 0)))
          : U.congestionLevel(1 - U.clamp01(t.v / 10));
        out.push({
          id: t.id, name: t.name, value: t.v,
          unit: t.unit, display: U.fixed(t.v, t.v >= 100 ? 0 : (t.v >= 10 ? 1 : 2)),
          extra: t.extra,
          ratio: max > 0 ? U.clamp01(t.v / max) : 0,
          level: lvl,
          color: kind === 'parking' ? levelColor(lvl) : levelColor(lvl),
          isAlert: kind === 'parking' ? t.v >= 90 : t.v >= 6
        });
      }
      return out;
    });
  }

  /* ================================================================== *
   * 7. 事件与播报
   * ================================================================== */

  function incidents() {
    var s = sim();
    if (!s) return [];
    var out = [];
    var arr = s.incidents;
    for (var i = 0; i < arr.length; i++) {
      var x = arr[i];
      out.push({
        id: x.id, type: x.type, typeName: x.typeName, title: x.title, desc: x.desc,
        x: x.x, z: x.z, roadId: x.roadId, roadName: x.roadName,
        districtId: x.districtId, districtName: x.districtName,
        severity: x.severity, severityName: x.severityName,
        since: x.since, sinceHHMM: x.sinceHHMM, duration: x.duration,
        elapsed: x.elapsed, remainMin: x.remainMin,
        status: x.status, statusName: x.statusName,
        impactKm: x.impactKm, responders: x.responders,
        vehiclesAffected: x.vehiclesAffected,
        color: x.severity === 3 ? themeHex('--c-danger')
             : (x.severity === 2 ? themeHex('--road-jam') : themeHex('--c-warn'))
      });
    }
    return out;
  }

  function alertsFeed() {
    return memo('alerts|' + sig(), function () {
      var s = sim();
      if (!s) return [];
      var out = [];
      var inc = s.activeIncidents;
      for (var i = 0; i < inc.length && i < 8; i++) {
        var x = inc[i];
        out.push({
          id: x.id,
          level: x.severity === 3 ? 'danger' : (x.severity === 2 ? 'warn' : 'info'),
          title: x.title,
          time: x.since, hhmm: U.hhmm(x.since),
          districtId: x.districtId, districtName: x.districtName,
          type: 'incident'
        });
      }
      /* 系统级告警 */
      var k = s.kpi;
      if (k.congestionIndex >= 6) {
        out.unshift({
          id: 'sys_congestion', level: 'danger', type: 'system',
          title: '全市拥堵指数 ' + U.fixed(k.congestionIndex, 2) + '，已进入拥堵状态',
          time: state.minute, hhmm: U.hhmm(state.minute)
        });
      }
      if (k.parkingOccupancy >= 88) {
        out.push({
          id: 'sys_parking', level: 'warn', type: 'system',
          title: '全市停车位占用率 ' + U.fixed(k.parkingOccupancy, 1) + '%，余位紧张',
          time: state.minute, hhmm: U.hhmm(state.minute)
        });
      }
      if (k.onTimeRate < 88) {
        out.push({
          id: 'sys_ontime', level: 'warn', type: 'system',
          title: '公交准点率降至 ' + U.fixed(k.onTimeRate, 1) + '%',
          time: state.minute, hhmm: U.hhmm(state.minute)
        });
      }
      return out;
    });
  }

  function summary() {
    return memo('summary|' + sig(), function () {
      var s = sim();
      if (!s) return '';
      var k = s.kpi;
      var worst = null;
      for (var id in s.districtStats) {
        if (!Object.prototype.hasOwnProperty.call(s.districtStats, id)) continue;
        var d = s.districtStats[id];
        if (!worst || d.congestionIndex > worst.congestionIndex) worst = d;
      }
      var sev = 0;
      var inc = s.activeIncidents;
      for (var i = 0; i < inc.length; i++) if (inc[i].severity === 3) sev++;
      var parts = [];
      parts.push(U.hhmm(state.minute) + ' ' + (k.phaseName || '平峰运行'));
      parts.push('全网平均速度 ' + U.fixed(k.avgSpeed, 1) + ' km/h，拥堵指数 ' + U.fixed(k.congestionIndex, 2));
      if (worst) {
        parts.push(worst.name + '最拥堵（' + U.fixed(worst.avgSpeed, 1) + ' km/h，指数 ' +
          U.fixed(worst.congestionIndex, 2) + '）');
      }
      parts.push('进行中事件 ' + k.incidentCount + ' 起' + (sev ? '，其中严重 ' + sev + ' 起' : ''));
      parts.push('公共交通客流 ' + U.fixed(k.transitRidership, 1) + ' 万人次，绿色出行占比 ' +
        U.fixed(k.greenShare, 1) + '%');
      return parts.join('；') + '。';
    });
  }

  /* ================================================================== *
   * 8. 模块看板
   * ================================================================== */

  function legend(moduleId) {
    moduleId = moduleId || state.moduleId;
    return memo('legend|' + sig(moduleId), function () {
      var s = sim();
      if (!s) return [];
      var out = [];
      var i;
      if (moduleId === 'traffic') {
        var cnt = [0, 0, 0, 0];
        var roads = regionRoads();
        for (i = 0; i < roads.length; i++) {
          var rs = s.roadStates[roads[i].id];
          if (rs) cnt[rs.level]++;
        }
        for (i = 0; i < 4; i++) {
          out.push({ label: LEVEL_NAMES[i], color: levelColor(i), value: U.int(cnt[i]), unit: '条' });
        }
      } else if (moduleId === 'od') {
        var od = s.odFlows.slice(0, 5);
        for (i = 0; i < od.length; i++) {
          out.push({
            label: od[i].fromName + ' → ' + od[i].toName,
            color: themeHex('--chart-' + ((i % 8) + 1)),
            value: U.compact(od[i].volume), unit: '辆/日'
          });
        }
      } else if (moduleId === 'transit') {
        out.push({ label: '轨道交通', color: themeHex('--transit-metro'), value: String(countMetro()), unit: '条' });
        out.push({ label: '常规公交', color: themeHex('--transit-bus'), value: String(countBus()), unit: '条' });
        out.push({ label: '高峰满载', color: themeHex('--c-warn'), value: U.fixed(maxLoad() * 100, 0), unit: '%' });
      } else if (moduleId === 'signal') {
        out.push({ label: '绿灯放行', color: themeHex('--road-free'), value: String(greenCount('green')), unit: '个' });
        out.push({ label: '黄灯过渡', color: themeHex('--road-slow'), value: String(greenCount('yellow')), unit: '个' });
        out.push({ label: '红灯等待', color: themeHex('--road-block'), value: String(greenCount('red')), unit: '个' });
      } else if (moduleId === 'park') {
        out.push({ label: '泊位紧张', color: themeHex('--road-jam'), value: String(parkingCount('busy')), unit: '处' });
        out.push({ label: '泊位已满', color: themeHex('--road-block'), value: String(parkingCount('full')), unit: '处' });
        out.push({ label: '单车充足', color: themeHex('--road-free'), value: String(bikeCount('idle')), unit: '点' });
      } else if (moduleId === 'carbon') {
        var c = s.carbon;
        for (i = 0; i < c.perMode.length; i++) {
          out.push({
            label: c.perMode[i].name,
            color: themeHex('--chart-' + ((i % 8) + 1)),
            value: U.fixed(c.perMode[i].ratio, 1), unit: '%'
          });
        }
      }
      return out;
    });
  }

  function countMetro() { var s = sim(); return s ? s.city.transit.metroLines.length : 0; }
  function countBus() { var s = sim(); return s ? s.city.transit.busLines.length : 0; }
  function maxLoad() {
    var s = sim();
    if (!s) return 0;
    var mx = 0;
    for (var k in s.transitState) {
      if (Object.prototype.hasOwnProperty.call(s.transitState, k)) {
        mx = Math.max(mx, s.transitState[k].load);
      }
    }
    return mx;
  }
  function greenCount(phase) {
    var s = sim();
    if (!s) return 0;
    var n = 0;
    for (var k in s.signalStates) {
      if (Object.prototype.hasOwnProperty.call(s.signalStates, k) &&
          s.signalStates[k].phase === phase) n++;
    }
    return n;
  }
  function parkingCount(status) {
    var s = sim();
    if (!s) return 0;
    var n = 0;
    for (var k in s.parkingState) {
      if (Object.prototype.hasOwnProperty.call(s.parkingState, k) &&
          s.parkingState[k].status === status) n++;
    }
    return n;
  }
  function bikeCount(status) {
    var s = sim();
    if (!s) return 0;
    var n = 0;
    for (var k in s.bikeState) {
      if (Object.prototype.hasOwnProperty.call(s.bikeState, k) &&
          s.bikeState[k].status === status) n++;
    }
    return n;
  }

  function moduleBoard(moduleId) {
    moduleId = moduleId || state.moduleId;
    return memo('board|' + sig(moduleId), function () {
      var s = sim();
      if (!s) return { metrics: [], chart: null, legend: [], table: null };
      switch (moduleId) {
        case 'od':      return boardOD(s);
        case 'transit': return boardTransit(s);
        case 'signal':  return boardSignal(s);
        case 'park':    return boardPark(s);
        case 'carbon':  return boardCarbon(s);
        default:        return boardTraffic(s);
      }
    });
  }

  function metric(label, value, unit, decimals, trend, level) {
    return { label: label, value: value, unit: unit, decimals: decimals == null ? 1 : decimals,
             trend: trend || 0, level: level || 'ok' };
  }

  function boardTraffic(s) {
    var k = s.kpi;
    var roads = regionRoads();
    var jamLen = 0, totalLen = 0;
    for (var i = 0; i < roads.length; i++) {
      var rs = s.roadStates[roads[i].id];
      if (!rs) continue;
      totalLen += roads[i].lengthM;
      if (rs.level >= 2) jamLen += roads[i].lengthM;
    }
    var jamRatio = totalLen > 0 ? jamLen / totalLen * 100 : 0;
    var se = series('congestionIndex');
    var sp = series('avgSpeed');
    return {
      metrics: [
        metric('平均速度', U.fixed(k.avgSpeed, 1), 'km/h', 1, k.speedDelta),
        metric('拥堵指数', U.fixed(k.congestionIndex, 2), '', 2, -k.congestionDelta,
          k.congestionIndex >= 6 ? 'bad' : (k.congestionIndex >= 4.5 ? 'warn' : 'ok')),
        metric('拥堵里程占比', U.fixed(jamRatio, 1), '%', 1, 0, jamRatio > 30 ? 'bad' : (jamRatio > 15 ? 'warn' : 'ok')),
        metric('车均延误', U.fixed(k.avgDelay, 1), '秒', 1, 0),
        metric('平均排队', U.fixed(k.avgQueue, 1), '辆', 1, 0),
        metric('进行中事件', U.int(k.incidentCount), '起', 0, 0, k.incidentCount > 12 ? 'warn' : 'ok')
      ],
      chart: {
        type: 'dualAxis',
        title: '24 小时拥堵指数与平均速度',
        series: {
          x: se.x,
          xLabel: se.x.map(function (m) { return U.hhmm(m); }),
          congestion: se.y,
          speed: sp.y
        },
        yLabelLeft: '拥堵指数',
        yLabelRight: 'km/h'
      },
      legend: legend('traffic'),
      table: null
    };
  }

  function boardOD(s) {
    var d = city();
    var od = s.odFlows;
    var total = 0, maxFlow = od[0] || null;
    for (var i = 0; i < od.length; i++) total += od[i].volume;
    /* 6×6 OD 矩阵 */
    var ids = [], names = [];
    for (var q = 0; q < d.districts.length; q++) {
      ids.push(d.districts[q].id);
      names.push(d.districts[q].short);
    }
    var matrix = [];
    for (var r = 0; r < ids.length; r++) {
      var row = [];
      for (var c = 0; c < ids.length; c++) {
        if (r === c) { row.push(0); continue; }
        var found = 0;
        for (var k = 0; k < od.length; k++) {
          if (od[k].fromId === ids[r] && od[k].toId === ids[c]) { found = od[k].volume; break; }
        }
        row.push(found);
      }
      matrix.push(row);
    }
    var avgDist = 0;
    for (var m = 0; m < od.length; m++) avgDist += od[m].distanceKm * od[m].volume;
    avgDist = total > 0 ? avgDist / total : 0;
    return {
      metrics: [
        metric('全日出行总量', U.compact(total), '辆/日', 0),
        metric('当前小时出行', U.compact(od.reduce(function (a, b) { return a + b.volumeNow; }, 0)), '辆/h', 0),
        metric('最大流向', maxFlow ? maxFlow.fromName + '→' + maxFlow.toName : '—', '', 0),
        metric('该流向规模', maxFlow ? U.compact(maxFlow.volume) : '0', '辆/日', 0),
        metric('平均出行距离', U.fixed(avgDist, 1), 'km', 1),
        metric('跨区出行占比', U.fixed(100, 0), '%', 0)
      ],
      chart: {
        type: 'odMatrix',
        title: '行政区 OD 出行矩阵',
        matrix: { ids: ids, names: names, values: matrix },
        top: od.slice(0, 8).map(function (x) {
          return { from: x.fromName, to: x.toName, volume: x.volume, distanceKm: x.distanceKm };
        })
      },
      legend: legend('od'),
      table: null
    };
  }

  function boardTransit(s) {
    var arr = [];
    for (var k in s.transitState) {
      if (!Object.prototype.hasOwnProperty.call(s.transitState, k)) continue;
      var L = s.transitState[k];
      arr.push({ name: L.name, value: L.ridership, kind: L.kind, load: L.load, onTime: L.onTimeRate });
    }
    arr.sort(function (a, b) { return b.value - a.value; });
    var metroLoad = 0, metroN = 0;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].kind === 'metro') { metroLoad += arr[i].load; metroN++; }
    }
    return {
      metrics: [
        metric('运营线路', countMetro() + countBus(), '条', 0),
        metric('轨道交通', U.fixed(kpiOf(s, 'transitRidership'), 1), '万人次', 1),
        metric('地铁平均满载率', U.fixed(metroN ? metroLoad / metroN * 100 : 0, 0), '%', 0,
          0, (metroN && metroLoad / metroN > 1) ? 'warn' : 'ok'),
        metric('公交准点率', U.fixed(kpiOf(s, 'onTimeRate'), 1), '%', 1, 0,
          kpiOf(s, 'onTimeRate') < 88 ? 'warn' : 'ok'),
        metric('公共交通分担率', U.fixed(kpiOf(s, 'transitShare'), 1), '%', 1),
        metric('换乘站点', interchangeCount(), '个', 0)
      ],
      chart: {
        type: 'barRank',
        title: '线路实时客流 TOP 10（万人次/h）',
        items: arr.slice(0, 10).map(function (x) {
          return { name: x.name, value: x.value, kind: x.kind, load: x.load };
        }),
        metroColor: themeHex('--transit-metro'),
        busColor: themeHex('--transit-bus')
      },
      legend: legend('transit'),
      table: null
    };
  }

  function interchangeCount() {
    var d = city();
    if (!d) return 0;
    var n = 0;
    for (var i = 0; i < d.transit.metroLines.length; i++) {
      var st = d.transit.metroLines[i].stations;
      for (var k = 0; k < st.length; k++) if (st[k].interchange) n++;
    }
    return n;
  }

  function boardSignal(s) {
    var gw = greenWaveGroups();
    var g = signalBoard(state.signalGroupId);
    var green = greenCount('green'), yellow = greenCount('yellow'), red = greenCount('red');
    var totalG = green + yellow + red || 1;
    var adapted = 0, cycleSum = 0, qSum = 0, n = 0;
    for (var k in s.signalStates) {
      if (!Object.prototype.hasOwnProperty.call(s.signalStates, k)) continue;
      var so = s.signalStates[k];
      if (so.adapted) adapted++;
      cycleSum += so.cycle;
      qSum += so.queueLen;
      n++;
    }
    return {
      metrics: [
        metric('联网信号路口', kpiOf(s, 'signalCount'), '个', 0),
        metric('绿波带数量', gw.length, '条', 0),
        metric('绿灯放行占比', U.fixed(green / totalG * 100, 1), '%', 1),
        metric('平均周期', U.fixed(n ? cycleSum / n : 0, 0), '秒', 0),
        metric('自适应路口', adapted, '个', 0),
        metric('平均排队', U.fixed(n ? qSum / n : 0, 1), '辆', 1)
      ],
      chart: g ? {
        type: 'greenWave',
        title: (g.corridorName || '绿波带') + ' 时距图（推荐车速 ' + g.recommendedSpeed + ' km/h）',
        greenWave: g,
        groups: gw
      } : { type: 'greenWave', title: '暂无绿波带数据', greenWave: null, groups: gw },
      legend: legend('signal'),
      table: null
    };
  }

  function boardPark(s) {
    var d = city();
    var parkCap = 0, parkFree = 0, busy = 0, full = 0;
    for (var k in s.parkingState) {
      if (!Object.prototype.hasOwnProperty.call(s.parkingState, k)) continue;
      var p = s.parkingState[k];
      parkCap += p.capacity;
      parkFree += p.available;
      if (p.status === 'busy') busy++;
      if (p.status === 'full') full++;
    }
    var bikeCap = 0, bikeAvail = 0;
    for (var k2 in s.bikeState) {
      if (!Object.prototype.hasOwnProperty.call(s.bikeState, k2)) continue;
      bikeCap += s.bikeState[k2].capacity;
      bikeAvail += s.bikeState[k2].available;
    }
    var cats = [], pk = [], bk = [];
    for (var i = 0; i < d.districts.length; i++) {
      var id = d.districts[i].id;
      cats.push(d.districts[i].short);
      var st = s.districtStats[id];
      pk.push(st ? st.parkingOccupancy : 0);
      /* 该区单车周转用可用率的补数近似 */
      var occ = 0, cnt = 0;
      for (var k3 in s.bikeState) {
        if (!Object.prototype.hasOwnProperty.call(s.bikeState, k3)) continue;
        if (s.bikeState[k3].districtId !== id) continue;
        occ += s.bikeState[k3].occupancy;
        cnt++;
      }
      bk.push(U.round(cnt ? occ / cnt * 100 : 0, 1));
    }
    return {
      metrics: [
        metric('泊位总数', U.compact(parkCap), '个', 0),
        metric('剩余泊位', U.compact(parkFree), '个', 0, 0, parkFree < parkCap * 0.12 ? 'bad' : (parkFree < parkCap * 0.25 ? 'warn' : 'ok')),
        metric('占用率', U.fixed(kpiOf(s, 'parkingOccupancy'), 1), '%', 1, 0,
          kpiOf(s, 'parkingOccupancy') > 90 ? 'bad' : 'ok'),
        metric('紧张/已满', busy + '/' + full, '处', 0, 0, full > 3 ? 'warn' : 'ok'),
        metric('单车投放', U.compact(s.totals.bikeFleet), '辆', 0),
        metric('单车周转率', U.fixed(kpiOf(s, 'bikeTurnover'), 2), '次/日', 2)
      ],
      chart: {
        type: 'stackedBar',
        title: '各行政区停车占用率与单车可用率',
        categories: cats, parking: pk, bike: bk,
        parkingColor: themeHex('--c-primary'),
        bikeColor: themeHex('--road-free')
      },
      legend: legend('park'),
      table: null
    };
  }

  function boardCarbon(s) {
    var c = s.carbon;
    var colors = [];
    for (var i = 0; i < c.perMode.length; i++) colors.push(themeHex('--chart-' + ((i % 8) + 1)));
    return {
      metrics: [
        metric('当日碳排放', U.fixed(c.total, 1), '吨', 1, 0, 'warn'),
        metric('绿色出行减排', U.fixed(c.saved, 1), '吨', 1, 0, 'ok'),
        metric('减排占比', U.fixed(c.total > 0 ? c.saved / c.total * 100 : 0, 1), '%', 1, 0, 'ok'),
        metric('绿色出行占比', U.fixed(kpiOf(s, 'greenShare'), 1), '%', 1, 0, 'ok'),
        metric('公共交通分担率', U.fixed(kpiOf(s, 'transitShare'), 1), '%', 1),
        metric('人均碳排', U.fixed(c.total / 220 * 1000, 0), 'kg/人', 0)
      ],
      chart: {
        type: 'pie',
        title: '交通碳排放构成',
        centerLabel: '绿色减排',
        centerValue: U.fixed(c.saved, 0),
        centerUnit: '吨',
        items: c.perMode.map(function (x, i) {
          return { name: x.name, value: x.value, ratio: x.ratio, color: colors[i] };
        })
      },
      legend: legend('carbon'),
      table: c.greenModes.map(function (g) {
        return { name: g.name, v1: U.fixed(g.trips, 1) + ' 万人次', v2: U.fixed(g.saved, 1) + ' 吨', v3: U.fixed(g.savedNow, 1) + ' 吨' };
      })
    };
  }

  function kpiOf(s, key) { return s && s.kpi ? (s.kpi[key] || 0) : 0; }

  /* ---- 各模块专用板 ---- */

  function greenWaveGroups() {
    var s = sim();
    if (!s || !s.greenWaves) return [];
    var out = [];
    for (var k in s.greenWaves) {
      if (!Object.prototype.hasOwnProperty.call(s.greenWaves, k)) continue;
      var g = s.greenWaves[k];
      out.push({
        id: k, corridorId: g.corridorId, name: g.corridorName,
        recommendedSpeed: g.recommendedSpeed, bandwidth: g.bandwidth,
        efficiency: g.efficiency, lengthKm: g.lengthKm,
        stopCount: g.stops.length,
        active: state.signalGroupId === k
      });
    }
    return out;
  }

  function signalBoard(groupId) {
    var s = sim();
    if (!s || !s.greenWave) return null;
    var g = s.greenWave(groupId || state.signalGroupId || undefined);
    if (!g) return null;
    return {
      groupId: g.groupId,
      corridorId: g.corridorId,
      corridorName: g.corridorName,
      recommendedSpeed: g.recommendedSpeed,
      bandwidth: g.bandwidth,
      efficiency: g.efficiency,
      lengthKm: g.lengthKm,
      avgGreenRatio: U.round(
        g.stops.reduce(function (a, b) { return a + b.greenRatio; }, 0) / Math.max(1, g.stops.length), 3),
      stops: g.stops.map(function (x) {
        return {
          signalId: x.signalId, name: x.name, x: x.x, z: x.z,
          distanceFromStart: x.distanceFromStart,
          distanceKm: U.round(x.distanceFromStart / 1000, 3),
          offsetSec: x.offsetSec, cycle: x.cycle,
          phase: x.phase, remain: x.remain, phaseName: x.phaseName,
          greenRatio: x.greenRatio, greenSec: x.greenSec,
          color: x.phase === 'green' ? themeHex('--road-free')
               : (x.phase === 'yellow' ? themeHex('--road-slow') : themeHex('--road-block'))
        };
      })
    };
  }

  function transitBoard() {
    var s = sim();
    if (!s) return { lines: [], summary: {} };
    var lines = [];
    for (var k in s.transitState) {
      if (!Object.prototype.hasOwnProperty.call(s.transitState, k)) continue;
      var L = s.transitState[k];
      lines.push({
        id: L.lineId, name: L.name, kind: L.kind, color: L.color,
        ridership: L.ridership, load: L.load, loadPct: U.round(L.load * 100, 0),
        crowding: L.crowding, crowdingName: L.crowdingName,
        headwayActual: L.headwayActual, vehiclesPerHour: L.vehiclesPerHour,
        onTimeRate: L.onTimeRate, speed: L.speed, delayMin: L.delayMin,
        stationCount: L.stationCount, lengthKm: L.lengthKm,
        capacityHour: L.capacityHour, dailyRidership: L.dailyRidership,
        level: L.load > 1 ? 'bad' : (L.load > 0.85 ? 'warn' : 'ok')
      });
    }
    lines.sort(function (a, b) { return b.ridership - a.ridership; });
    return {
      lines: lines,
      summary: {
        lineCount: lines.length,
        metroCount: countMetro(),
        busCount: countBus(),
        ridership: kpiOf(s, 'transitRidership'),
        share: kpiOf(s, 'transitShare'),
        onTimeRate: kpiOf(s, 'onTimeRate'),
        maxLoad: U.round(maxLoad() * 100, 0)
      }
    };
  }

  function parkingBoard() {
    var s = sim();
    if (!s) return { top: [], summary: {} };
    var top = ranking('parking', null, 10);
    var cap = 0, free = 0, full = 0, busy = 0;
    for (var k in s.parkingState) {
      if (!Object.prototype.hasOwnProperty.call(s.parkingState, k)) continue;
      var p = s.parkingState[k];
      cap += p.capacity; free += p.available;
      if (p.status === 'full') full++;
      if (p.status === 'busy') busy++;
    }
    var bk = [], bikeFree = 0, bikeCap = 0;
    for (var k2 in s.bikeState) {
      if (!Object.prototype.hasOwnProperty.call(s.bikeState, k2)) continue;
      var b = s.bikeState[k2];
      bikeCap += b.capacity; bikeFree += b.available;
      bk.push({ id: b.id, name: b.name, available: b.available, capacity: b.capacity, status: b.status, statusName: b.statusName });
    }
    bk.sort(function (a, b) { return a.available - b.available; });
    return {
      top: top,
      parkingList: Object.keys(s.parkingState).map(function (k3) {
        var p = s.parkingState[k3];
        return { id: p.id, name: p.name, capacity: p.capacity, available: p.available,
                 occupancy: U.round(p.occupancy * 100, 1), status: p.status, statusName: p.statusName,
                 type: p.type, x: p.x, z: p.z, districtId: p.districtId };
      }).sort(function (a, b) { return b.occupancy - a.occupancy; }),
      bikeList: bk,
      summary: {
        capacity: cap, available: free, occupancy: kpiOf(s, 'parkingOccupancy'),
        full: full, busy: busy,
        bikeCapacity: bikeCap, bikeAvailable: bikeFree,
        bikeRides: kpiOf(s, 'bikeRides'), bikeTurnover: kpiOf(s, 'bikeTurnover')
      }
    };
  }

  function carbonBoard() {
    var s = sim();
    if (!s) return { total: 0, saved: 0, perMode: [], greenModes: [] };
    var c = s.carbon;
    return {
      total: c.total, saved: c.saved,
      savedRatio: U.round(c.total > 0 ? c.saved / c.total * 100 : 0, 1),
      perMode: c.perMode.map(function (x, i) {
        return { name: x.name, value: x.value, ratio: x.ratio,
                 color: themeHex('--chart-' + ((i % 8) + 1)) };
      }),
      greenModes: c.greenModes.map(function (g) {
        return { mode: g.mode, name: g.name, trips: g.trips, tripsNow: g.tripsNow,
                 saved: g.saved, savedNow: g.savedNow,
                 carbonSavedPerTrip: g.carbonSavedPerTrip };
      }),
      greenShare: kpiOf(s, 'greenShare'),
      transitShare: kpiOf(s, 'transitShare')
    };
  }

  function greenBoard() {
    var s = sim();
    if (!s) return { greenShare: 0, modes: [], savedTotal: 0 };
    var c = s.carbon;
    return {
      greenShare: kpiOf(s, 'greenShare'),
      savedTotal: c.saved,
      modes: c.greenModes.map(function (g) {
        return { mode: g.mode, name: g.name, trips: g.trips, saved: g.saved, savedNow: g.savedNow };
      })
    };
  }

  /* ================================================================== *
   * 9. 序列、预测、时间轴
   * ================================================================== */

  function series(metric) {
    var s = sim();
    if (!s || !s.seriesAt) return { x: [], y: [], label: metric, unit: '' };
    return s.seriesAt(metric || state.metric);
  }

  function forecast(metric, horizonMin) {
    var s = sim();
    if (!s || !s.forecast) return null;
    return s.forecast(metric || state.metric, horizonMin || 60);
  }

  /** 144 格（每 10 分钟）时间轴热力条
   *  档位用**拥堵指数**而不是速度比：全网均速是平均值，再堵也跌不到自由流的 30%，
   *  用速度比分档会让热力条永远只有"畅通/缓行"两档，看不出早晚高峰。 */
  function timelineBands() {
    return memo('bands|' + sig(), function () {
      var s = sim();
      if (!s) return [];
      var seSpeed = s.seriesAt('avgSpeed');
      var seCi = s.seriesAt('congestionIndex');
      var seInc = s.seriesAt('incidents');
      var out = [];
      for (var i = 0; i < 144; i++) {
        var bi = Math.min(seCi.y.length - 1, i * 2);
        var minute = i * 10;
        var ci = seCi.y[bi];
        var lvl;                                   // 0..3
        if (ci < 2.5) lvl = 0;
        else if (ci < 5.0) lvl = 1;
        else if (ci < 7.2) lvl = 2;
        else lvl = 3;
        var inc = seInc.y[bi] || 0;
        var spd = seSpeed.y[bi];
        out.push({
          minute: minute,
          hhmm: U.hhmm(minute),
          /* data-level: 0 无数据 / 1 畅通 / 2 缓行 / 3 拥堵 / 4 严重 */
          level: lvl + 1,
          levelName: LEVEL_NAMES[lvl],
          congestionIndex: ci,
          congestion: U.round(U.clamp01(ci / 10), 3),
          speed: spd,
          incidents: inc,
          color: levelColor(lvl),
          label: U.hhmm(minute) + ' ' + LEVEL_NAMES[lvl] + ' · 指数 ' + U.fixed(ci, 2) +
                 ' · ' + U.fixed(spd, 1) + ' km/h' + (inc ? ' · ' + inc + ' 起事件' : '')
        });
      }
      return out;
    });
  }

  /* ================================================================== *
   * 10. 详情抽屉
   * ================================================================== */

  function badge(text, kind) { return { text: text, kind: kind || 'tag' }; }

  function roadInfo(roadId) {
    var s = sim();
    var rd = TP.City.roadById(roadId);
    if (!s || !rd) return null;
    var rs = s.roadStates[roadId];
    if (!rs) return null;
    var dName = '';
    var dd = TP.City.districtById(rd.districtId);
    if (dd) dName = dd.name;
    var tl = TP.Sim.roadTimeline(roadId);
    var fc = TP.Sim.roadForecast(roadId, 60);
    var near = TP.City.nearby(rd.path[0].x, rd.path[0].z, 90, 4);
    var sigs = [];
    for (var i = 0; i < Math.min(2, rd.path.length); i++) { /* noop */ }
    /* 该路段两端的信号机 */
    var ends = [rd.from, rd.to];
    for (var e = 0; e < ends.length; e++) {
      var node = TP.City.intersectionById(ends[e]);
      if (node && node.signalId) {
        var so = s.signalStates[node.signalId];
        if (so) {
          sigs.push({
            id: so.signalId, name: '路口 ' + node.id,
            cycle: so.cycle, phase: so.phase, phaseName: so.phaseName,
            remain: so.remain, saturation: so.saturation,
            color: so.phase === 'green' ? themeHex('--road-free')
                 : (so.phase === 'yellow' ? themeHex('--road-slow') : themeHex('--road-block'))
          });
        }
      }
    }
    var evs = [];
    var inc = s.incidents;
    for (var q = 0; q < inc.length; q++) {
      if (inc[q].roadId === roadId) {
        evs.push({ title: inc[q].title, severity: inc[q].severity, severityName: inc[q].severityName,
                   sinceHHMM: inc[q].sinceHHMM, status: inc[q].status, statusName: inc[q].statusName });
      }
    }
    var transit = [];
    for (var t = 0; t < near.metro.length; t++) {
      transit.push({ name: near.metro[t].item.name, kind: 'metro', distanceM: near.metro[t].distM });
    }
    for (var t2 = 0; t2 < near.bus.length; t2++) {
      transit.push({ name: near.bus[t2].item.name, kind: 'bus', distanceM: near.bus[t2].distM });
    }
    transit.sort(function (a, b) { return a.distanceM - b.distanceM; });

    return {
      kind: 'road',
      id: roadId,
      title: rd.name,
      subtitle: (CLS_CN[rd.cls] || rd.cls) + ' · ' + rd.lanes + ' 车道 · 限速 ' + rd.speedLimit + ' km/h',
      districtId: rd.districtId,
      districtName: dName,
      badges: [
        badge(LEVEL_NAMES[rs.level], rs.level >= 2 ? 'badge--bad' : (rs.level === 1 ? 'badge--warn' : 'badge--ok')),
        badge('饱和度 ' + U.fixed(rs.satRatio * 100, 0) + '%'),
        badge('长度 ' + U.fixed(rd.lengthM / 1000, 2) + ' km'),
        badge('通行能力 ' + U.int(rd.capacity) + ' 辆/h')
      ],
      color: levelColor(rs.level),
      metrics: [
        { label: '实时车速', value: U.fixed(rs.speed, 1), unit: 'km/h', level: rs.level >= 2 ? 'bad' : 'ok' },
        { label: '断面流量', value: U.int(rs.flow), unit: '辆/h', level: 'ok' },
        { label: '车道占有率', value: U.fixed(rs.occupancy * 100, 0), unit: '%', level: 'ok' },
        { label: '排队长度', value: U.fixed(rs.queueLen, 0), unit: '米', level: rs.queueLen > 60 ? 'warn' : 'ok' },
        { label: '车均延误', value: U.fixed(rs.delay, 1), unit: '秒', level: rs.delay > 30 ? 'warn' : 'ok' },
        { label: '通行时间', value: U.int(rs.travelTime), unit: '秒', level: 'ok' },
        { label: '在段车辆', value: U.int(rs.vehicles), unit: '辆', level: 'ok' },
        { label: '自由流耗时', value: U.int(rs.freeTravelTime), unit: '秒', level: 'ok' }
      ],
      series: tl ? {
        x: tl.x, xLabel: tl.x.map(function (m) { return U.hhmm(m); }),
        y: tl.speed, label: '路段车速', unit: 'km/h', speedLimit: tl.speedLimit
      } : null,
      forecast: fc,
      signals: sigs,
      transit: transit.slice(0, 6),
      events: evs,
      flowSteps: [
        { label: '自由流', value: U.int(rs.freeTravelTime), unit: '秒' },
        { label: '实时通行', value: U.int(rs.travelTime), unit: '秒' },
        { label: '延误', value: U.fixed(rs.delay, 1), unit: '秒' },
        { label: '饱和度', value: U.fixed(rs.satRatio * 100, 0), unit: '%' }
      ]
    };
  }

  function stationInfo(kind, id) {
    var s = sim();
    if (!s) return null;
    var d = city();
    var obj = null, line = null, isMetro = kind === 'metro';
    if (isMetro && d) {
      obj = TP.City.metroLineById(id);
      if (obj && obj.stations) { line = obj; obj = null; }
      if (!line && obj && obj.lineId) line = TP.City.metroLineById(obj.lineId);
    } else if (d) {
      obj = TP.City.busLineById(id);
      if (obj && obj.stops) { line = obj; obj = null; }
      if (!line && obj && obj.lineId) line = TP.City.busLineById(obj.lineId);
    }
    if (!line && !obj) return null;
    var L = line ? s.transitState[line.id] : null;
    var nm = obj ? obj.name : line.name;
    var x = obj ? obj.x : line.path[0].x;
    var z = obj ? obj.z : line.path[0].z;
    var dd = TP.City.districtOf(x, z);
    var dObj = dd ? TP.City.districtById(dd) : null;
    var near = TP.City.nearby(x, z, 80, 3);
    return {
      kind: isMetro ? 'metroStation' : 'busStop',
      id: id,
      title: nm,
      subtitle: line ? line.name : '',
      districtId: dd,
      districtName: dObj ? dObj.name : '',
      badges: [
        badge(isMetro ? '轨道交通' : '常规公交', 'tag'),
        badge(dObj ? dObj.name : '—'),
        obj && obj.interchange ? badge('换乘站', 'badge--ok') : badge('普通站')
      ],
      color: isMetro ? themeHex('--transit-metro') : themeHex('--transit-bus'),
      metrics: L ? [
        { label: '线路客流', value: U.fixed(L.ridership, 2), unit: '万人次/h', level: 'ok' },
        { label: '满载率', value: U.fixed(L.load * 100, 0), unit: '%', level: L.load > 1 ? 'bad' : (L.load > 0.85 ? 'warn' : 'ok') },
        { label: '实际间隔', value: U.fixed(L.headwayActual, 1), unit: '分钟', level: 'ok' },
        { label: '发车频率', value: U.int(L.vehiclesPerHour), unit: '班/h', level: 'ok' },
        { label: '准点率', value: U.fixed(L.onTimeRate, 1), unit: '%', level: L.onTimeRate < 88 ? 'warn' : 'ok' },
        { label: '旅行速度', value: U.fixed(L.speed, 1), unit: 'km/h', level: 'ok' },
        { label: '站点数', value: U.int(L.stationCount), unit: '个', level: 'ok' },
        { label: '线路长度', value: U.fixed(L.lengthKm, 1), unit: 'km', level: 'ok' }
      ] : [],
      crowding: L ? { key: L.crowding, name: L.crowdingName } : null,
      nearbyRoads: near.roads.slice(0, 3).map(function (r) {
        return { name: r.item.name, distanceM: r.distM };
      }),
      events: []
    };
  }

  function parkingInfo(id) {
    var s = sim();
    var p = s && s.parkingState[id];
    if (!p) return null;
    var dd = TP.City.districtById(p.districtId);
    var typeCn = { underground: '地下停车场', surface: '地面停车场', curb: '路侧停车带' }[p.type] || p.type;
    return {
      kind: 'parking', id: id, title: p.name, subtitle: typeCn,
      districtId: p.districtId, districtName: dd ? dd.name : '',
      badges: [
        badge(p.statusName, p.status === 'full' ? 'badge--bad' : (p.status === 'busy' ? 'badge--warn' : 'badge--ok')),
        badge('泊位 ' + U.int(p.capacity))
      ],
      color: p.occupancy >= 0.97 ? themeHex('--road-block') : (p.occupancy >= 0.85 ? themeHex('--road-jam') : themeHex('--road-free')),
      metrics: [
        { label: '占用率', value: U.fixed(p.occupancy * 100, 1), unit: '%', level: p.occupancy >= 0.95 ? 'bad' : 'ok' },
        { label: '剩余泊位', value: U.int(p.available), unit: '个', level: p.available < 30 ? 'warn' : 'ok' },
        { label: '泊位总数', value: U.int(p.capacity), unit: '个', level: 'ok' },
        { label: '日均周转', value: U.fixed(p.turnover, 2), unit: '次', level: 'ok' }
      ],
      series: null, forecast: null, signals: [], transit: [], events: [], flowSteps: []
    };
  }

  function bikeInfo(id) {
    var s = sim();
    var b = s && s.bikeState[id];
    if (!b) return null;
    var dd = TP.City.districtById(b.districtId);
    return {
      kind: 'bike', id: id, title: b.name, subtitle: '共享单车服务点',
      districtId: b.districtId, districtName: dd ? dd.name : '',
      badges: [
        badge(b.statusName, b.status === 'full' ? 'badge--bad' : (b.status === 'busy' ? 'badge--warn' : 'badge--ok')),
        badge('桩位 ' + U.int(b.capacity))
      ],
      color: b.available > b.capacity * 0.5 ? themeHex('--road-free') : themeHex('--road-jam'),
      metrics: [
        { label: '可用车辆', value: U.int(b.available), unit: '辆', level: b.available < 5 ? 'warn' : 'ok' },
        { label: '占用率', value: U.fixed(b.occupancy * 100, 1), unit: '%', level: 'ok' },
        { label: '桩位总数', value: U.int(b.capacity), unit: '个', level: 'ok' },
        { label: '潮汐特征', value: b.commuteBias > 0 ? '早出晚归' : '早归晚出', unit: '', level: 'ok' }
      ],
      series: null, forecast: null, signals: [], transit: [], events: [], flowSteps: []
    };
  }

  function corridorInfo(id) {
    var s = sim();
    var c = TP.City.corridorById(id);
    if (!s || !c) return null;
    var sumLen = 0, acc = 0, spd = 0, flow = 0, worst = 0;
    for (var i = 0; i < c.roadIds.length; i++) {
      var rs = s.roadStates[c.roadIds[i]];
      var rd = TP.City.roadById(c.roadIds[i]);
      if (!rs || !rd) continue;
      sumLen += rd.lengthM;
      acc += rs.congestionIndex * rd.lengthM;
      spd += rs.speed * rd.lengthM;
      flow += rs.flow;
      worst = Math.max(worst, rs.level);
    }
    var ci = sumLen > 0 ? acc / sumLen : 0;
    var gw = state.signalGroupId ? signalBoard() : null;
    return {
      kind: 'corridor', id: id, title: c.name,
      subtitle: (CLS_CN[c.cls] || c.cls) + ' · 全长 ' + U.fixed(c.lengthKm, 1) + ' km · ' + c.roadIds.length + ' 个路段',
      districtIds: c.districtIds,
      districtName: c.districtIds.map(function (x) {
        var d2 = TP.City.districtById(x);
        return d2 ? d2.short : x;
      }).join(' / '),
      badges: [
        badge(LEVEL_NAMES[worst], worst >= 2 ? 'badge--bad' : 'badge--ok'),
        badge('拥堵指数 ' + U.fixed(ci, 2)),
        badge('推荐车速 ' + c.recommendedSpeed + ' km/h')
      ],
      color: levelColor(worst),
      metrics: [
        { label: '走廊均速', value: U.fixed(sumLen > 0 ? spd / sumLen : 0, 1), unit: 'km/h', level: worst >= 2 ? 'bad' : 'ok' },
        { label: '拥堵指数', value: U.fixed(ci, 2), unit: '', level: ci >= 6 ? 'bad' : (ci >= 4.5 ? 'warn' : 'ok') },
        { label: '断面总流量', value: U.int(flow), unit: '辆/h', level: 'ok' },
        { label: '路段数', value: c.roadIds.length, unit: '个', level: 'ok' },
        { label: '沿线信号', value: (c.signalIds || []).length, unit: '个', level: 'ok' },
        { label: '绿波带宽', value: gw ? U.int(gw.bandwidth) : 0, unit: '秒', level: 'ok' }
      ],
      series: null, forecast: null, signals: [], transit: [],
      events: [], flowSteps: [],
      greenWave: gw
    };
  }

  function incidentInfo(id) {
    var list = incidents();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) {
        var x = list[i];
        return {
          kind: 'incident', id: x.id, title: x.title,
          subtitle: x.typeName + ' · ' + x.statusName,
          districtId: x.districtId, districtName: x.districtName,
          badges: [
            badge(x.severityName + '（' + x.severity + '级）', x.severity === 3 ? 'badge--bad' : (x.severity === 2 ? 'badge--warn' : 'badge--ok')),
            badge('发生于 ' + x.sinceHHMM),
            badge(x.status === 'active' ? '剩余约 ' + x.remainMin + ' 分钟' : '已解除')
          ],
          color: x.color,
          metrics: [
            { label: '影响半径', value: U.fixed(x.impactKm, 1), unit: 'km', level: 'warn' },
            { label: '已派警力', value: x.responders, unit: '人', level: 'ok' },
            { label: '受影响车辆', value: U.compact(x.vehiclesAffected), unit: '辆', level: 'warn' },
            { label: '持续时长', value: x.elapsed, unit: '分钟', level: 'ok' },
            { label: '预计总时长', value: x.duration, unit: '分钟', level: 'ok' },
            { label: '所在路段', value: x.roadName, unit: '', level: 'ok' }
          ],
          series: null, forecast: null, signals: [], transit: [],
          events: [], flowSteps: []
        };
      }
    }
    return null;
  }

  function districtInfo(id) {
    var s = sim();
    var d = TP.City.districtById(id);
    if (!s || !d) return null;
    var st = s.districtStats[id];
    if (!st) return null;
    var dl = TP.City.data.districts;
    var i;
    for (i = 0; i < dl.length; i++) { /* noop */ }
    var rank = 1;
    for (var k in s.districtStats) {
      if (Object.prototype.hasOwnProperty.call(s.districtStats, k) &&
          s.districtStats[k].congestionIndex > st.congestionIndex) rank++;
    }
    return {
      kind: 'district', id: id, title: d.name,
      subtitle: '面积 ' + U.fixed(d.areaKm2, 2) + ' km² · 人口 ' + U.fixed(d.population, 1) + ' 万',
      districtId: id, districtName: d.name,
      badges: [
        badge('拥堵排名 第 ' + rank + ' 位', rank <= 2 ? 'badge--bad' : (rank <= 4 ? 'badge--warn' : 'badge--ok')),
        badge(LEVEL_NAMES[U.congestionLevel(1 - U.clamp01(st.congestionIndex / 10))])
      ],
      color: d.color,
      metrics: [
        { label: '平均速度', value: U.fixed(st.avgSpeed, 1), unit: 'km/h', level: st.avgSpeed < 22 ? 'bad' : 'ok' },
        { label: '拥堵指数', value: U.fixed(st.congestionIndex, 2), unit: '', level: st.congestionIndex >= 6 ? 'bad' : (st.congestionIndex >= 4.5 ? 'warn' : 'ok') },
        { label: '路网流量', value: U.compact(st.flow), unit: '辆/h', level: 'ok' },
        { label: '在网车辆', value: U.compact(st.inNetVehicles), unit: '辆', level: 'ok' },
        { label: '平均饱和度', value: U.fixed(st.saturation * 100, 0), unit: '%', level: st.saturation > 0.8 ? 'warn' : 'ok' },
        { label: '进行中事件', value: st.incidents, unit: '起', level: st.incidents > 4 ? 'warn' : 'ok' },
        { label: '停车占用率', value: U.fixed(st.parkingOccupancy, 1), unit: '%', level: st.parkingOccupancy > 90 ? 'warn' : 'ok' },
        { label: '路网里程', value: U.fixed(d.roadKm, 1), unit: 'km', level: 'ok' }
      ],
      population: d.population, jobs: d.jobs, vehicleStock: d.vehicleStock,
      series: null, forecast: null, signals: [], transit: [], events: [], flowSteps: []
    };
  }

  /** 3D 命中 → 详情对象 */
  function pickInfo(hit) {
    if (!hit || !hit.kind) return null;
    switch (hit.kind) {
      case 'road':       return roadInfo(hit.roadId || hit.id);
      case 'intersection': {
        var node = TP.City.intersectionById(hit.id);
        if (node && node.signalId) return signalInfo(node.signalId);
        var nr = node ? TP.City.nearestRoad(node.x, node.z, 40) : null;
        return nr ? roadInfo(nr.road.id) : null;
      }
      case 'station':
        return stationInfo(hit.lineKind || (hit.lineId && hit.lineId.charAt(0) === 'M' ? 'metro' : 'bus'), hit.id);
      case 'parking':    return parkingInfo(hit.id);
      case 'bike':       return bikeInfo(hit.id);
      case 'incident':   return incidentInfo(hit.id);
      case 'corridor':   return corridorInfo(hit.id);
      case 'district':   return districtInfo(hit.id);
      case 'hub': {
        var h = TP.City.hubById(hit.id);
        if (!h) return null;
        var dd = TP.City.districtById(h.districtId);
        return {
          kind: 'hub', id: h.id, title: h.name, subtitle: HUB_CN[h.kind] || '交通枢纽',
          districtId: h.districtId, districtName: dd ? dd.name : '',
          badges: [badge(HUB_CN[h.kind] || '枢纽', 'tag'), badge(dd ? dd.name : '—')],
          color: themeHex('--c-primary'),
          metrics: [], series: null, forecast: null, signals: [], transit: [], events: [], flowSteps: []
        };
      }
      default: return null;
    }
  }

  function signalInfo(signalId) {
    var s = sim();
    var so = s && s.signalStates[signalId];
    var sg = TP.City.signalById(signalId);
    if (!so || !sg) return null;
    var node = TP.City.intersectionById(sg.intersectionId);
    var dId = node ? node.districtId : null;
    var dd = dId ? TP.City.districtById(dId) : null;
    var splits = [];
    for (var i = 0; i < sg.approaches.length; i++) {
      splits.push({
        dir: sg.approaches[i].dir,
        green: so.splits[i] || sg.approaches[i].green,
        yellow: sg.approaches[i].yellow
      });
    }
    return {
      kind: 'signal', id: signalId, title: '信号路口 ' + sg.intersectionId,
      subtitle: (dd ? dd.name : '') + ' · 相连 ' + (node ? node.degree : 0) + ' 条道路',
      districtId: dId, districtName: dd ? dd.name : '',
      badges: [
        badge(so.phase === 'green' ? '绿灯放行' : (so.phase === 'yellow' ? '黄灯过渡' : '红灯等待'),
          so.phase === 'green' ? 'badge--ok' : (so.phase === 'yellow' ? 'badge--warn' : 'badge--bad')),
        badge('周期 ' + so.cycle + ' 秒'),
        badge(so.adapted ? '自适应' : '固定配时', so.adapted ? 'badge--ok' : 'tag')
      ],
      color: so.phase === 'green' ? themeHex('--road-free')
           : (so.phase === 'yellow' ? themeHex('--road-slow') : themeHex('--road-block')),
      metrics: [
        { label: '当前相位', value: so.phaseName, unit: '', level: 'ok' },
        { label: '剩余时长', value: so.remain, unit: '秒', level: 'ok' },
        { label: '周期', value: so.cycle, unit: '秒', level: 'ok' },
        { label: '饱和度', value: U.fixed(so.saturation * 100, 0), unit: '%', level: so.saturation > 0.85 ? 'warn' : 'ok' },
        { label: '排队长度', value: U.fixed(so.queueLen, 1), unit: '辆', level: 'ok' },
        { label: '协调子区', value: so.coordGroup || '—', unit: '', level: 'ok' }
      ],
      splits: splits,
      series: null, forecast: null, signals: [], transit: [], events: [], flowSteps: []
    };
  }

  function searchNear(x, z, radiusW) {
    radiusW = radiusW || 100;
    var s = sim();
    var near = TP.City.nearby(x, z, radiusW, 6);
    var out = { roads: [], stations: [], parking: [], bike: [], hubs: [], incidents: [] };
    var i;
    for (i = 0; i < near.roads.length; i++) {
      var rd = near.roads[i].item;
      var rs = s ? s.roadStates[rd.id] : null;
      out.roads.push({ id: rd.id, name: rd.name, cls: rd.cls, distanceM: near.roads[i].distM,
                       level: rs ? rs.level : 0, speed: rs ? rs.speed : 0,
                       color: rs ? levelColor(rs.level) : '#b9c4d0' });
    }
    for (i = 0; i < near.metro.length; i++) {
      out.stations.push({ id: near.metro[i].item.id, name: near.metro[i].item.name,
                          kind: 'metro', distanceM: near.metro[i].distM });
    }
    for (i = 0; i < near.bus.length; i++) {
      out.stations.push({ id: near.bus[i].item.id, name: near.bus[i].item.name,
                          kind: 'bus', distanceM: near.bus[i].distM });
    }
    for (i = 0; i < near.parking.length; i++) {
      var p = s && s.parkingState[near.parking[i].item.id];
      out.parking.push({ id: near.parking[i].item.id, name: near.parking[i].item.name,
                         distanceM: near.parking[i].distM,
                         occupancy: p ? U.round(p.occupancy * 100, 1) : 0,
                         available: p ? p.available : 0 });
    }
    for (i = 0; i < near.bike.length; i++) {
      var b = s && s.bikeState[near.bike[i].item.id];
      out.bike.push({ id: near.bike[i].item.id, name: near.bike[i].item.name,
                      distanceM: near.bike[i].distM,
                      available: b ? b.available : 0 });
    }
    for (i = 0; i < near.hubs.length; i++) {
      out.hubs.push({ id: near.hubs[i].item.id, name: near.hubs[i].item.name,
                      kind: near.hubs[i].item.kind, distanceM: near.hubs[i].distM });
    }
    if (s) {
      var inc = s.activeIncidents;
      for (i = 0; i < inc.length; i++) {
        var dm = U.dist(x, z, inc[i].x, inc[i].z) * (TP.City.UNIT_M || 5);
        if (dm <= radiusW * (TP.City.UNIT_M || 5)) {
          out.incidents.push({ id: inc[i].id, title: inc[i].title, severity: inc[i].severity,
                               severityName: inc[i].severityName, distanceM: Math.round(dm) });
        }
      }
      out.incidents.sort(function (a, b) { return a.distanceM - b.distanceM; });
      out.incidents = out.incidents.slice(0, 6);
    }
    return out;
  }

  /* ================================================================== *
   * 11. 对外
   * ================================================================== */

  var fmt = {
    num: function (v, d) { return U.fixed(v, d == null ? 1 : d); },
    int: U.int,
    compact: U.compact,
    pct: function (v, d) { return U.fixed(v, d == null ? 1 : d) + '%'; },
    hhmm: U.hhmm,
    speed: function (v) { return U.fixed(v, 1) + ' km/h'; },
    km: function (v) { return U.fixed(v, 1) + ' km'; },
    minutes: function (v) { return U.fixed(v, 1) + ' 分钟'; },
    tons: function (v) { return U.fixed(v, 1) + ' 吨'; },
    wan: function (v) { return U.fixed(v, 1) + ' 万'; },
    levelName: function (l) { return LEVEL_NAMES[U.clamp(l, 0, 3)]; },
    levelColor: levelColor,
    clsName: function (c) { return CLS_CN[c] || c; }
  };

  var API = {
    /* 生命周期 */
    init: init,
    refresh: refresh,
    /* ready() 是**函数**（与 APP-CONTRACT 一致）。
       注意：不要写 `if (TP.Api.ready)` —— 函数永远是真值，会绕过就绪检查；
       需要短路判断时用下面的 isReady。 */
    ready: function () { return !!(city() && sim()); },
    get isReady() { return !!(city() && sim()); },

    /* 状态 */
    state: state,
    setMinute: setMinute,
    setMinuteAuto: setMinuteAuto,
    setDayType: setDayType,
    setRegion: setRegion,
    setViewMode: setViewMode,
    setModule: setModule,
    setSignalGroup: setSignalGroup,
    setMetric: setMetric,
    setLayer: setLayer,
    setSelected: setSelected,

    /* 事件总线 */
    on: function (evt, fn) {
      (listeners[evt] || (listeners[evt] = [])).push(fn);
      return function () { API.off(evt, fn); };
    },
    off: function (evt, fn) {
      var arr = listeners[evt];
      if (!arr) return;
      var i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    emit: emit,

    /* 快照 */
    snapshot: snapshot,
    ticker: ticker,
    kpiCards: kpiCards,
    ranking: ranking,
    incidents: incidents,
    alertsFeed: alertsFeed,
    summary: summary,

    /* 元数据 */
    meta: meta,
    districts: districts,
    layersMeta: layersMeta,
    modulesMeta: modulesMeta,
    viewsMeta: viewsMeta,
    regionsMeta: regionsMeta,
    MODULES: MODULES,
    VIEWS: VIEWS,
    LAYERS: LAYERS,

    /* 看板 */
    moduleBoard: moduleBoard,
    legend: legend,
    signalBoard: signalBoard,
    greenWaveGroups: greenWaveGroups,
    transitBoard: transitBoard,
    parkingBoard: parkingBoard,
    carbonBoard: carbonBoard,
    greenBoard: greenBoard,

    /* 序列与预测 */
    series: series,
    forecast: forecast,
    timelineBands: timelineBands,
    sparkOf: sparkOf,

    /* 详情 */
    roadInfo: roadInfo,
    stationInfo: stationInfo,
    parkingInfo: parkingInfo,
    bikeInfo: bikeInfo,
    corridorInfo: corridorInfo,
    incidentInfo: incidentInfo,
    districtInfo: districtInfo,
    signalInfo: signalInfo,
    pickInfo: pickInfo,
    searchNear: searchNear,

    /* 筛选 */
    regionFilter: regionFilter,
    visibleRoadIds: visibleRoadIds,
    regionRoads: regionRoads,
    setRegionFilterOnLayers: setRegionFilterOnLayers,

    /* 适配器与格式化 */
    adapter: adapter,
    fmt: fmt
  };

  TP.Api = API;

  /* 模块加载时先建好状态占位（此时数据层通常还没 init，值会是空的，
     等 app.js 调 TP.Api.init() 后一切就绪）。 */
  if (!_initialized) init();

  return API;

})(window);
