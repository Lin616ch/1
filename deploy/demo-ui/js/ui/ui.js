/* ============================================================================
 * ui.js —— 全部 DOM 交互层
 * 命名空间：TP.UI
 * 依赖：TP.Util、TP.Theme、TP.Api（必需）；TP.Scene / TP.CityBuilder / TP.CameraRig /
 *       TP.Layers / TP.Charts（均为可选，缺失或抛错时自动降级，不影响页面可用）
 *
 * 约定：
 *   - 只按 index.html 实际存在的 id / class 绑定；占位容器一律 innerHTML 覆盖
 *   - 全部事件用 addEventListener / TP.Util.delegate 绑定，无内联事件
 *   - 不拥有主循环；播放推进由 js/app.js 读取 TP.UI.state.playing / speed 后驱动
 *   - 不硬编码色值：颜色一律来自 TP.Api 返回值或 TP.Theme / CSS 变量
 *   - 跨 3D 与 UI 的实体详情一律来自 TP.Api.pickInfo()，本文件不拼业务对象
 * ==========================================================================*/
(function (window, document) {
  'use strict';

  var TP = window.TP = window.TP || {};
  var U = TP.Util;

  var UI = TP.UI = {};
  UI.ready = false;

  /* UI 侧只读缓存：镜像 TP.Api.state，并附带纯 UI 状态 */
  var state = UI.state = {
    minute: 0, dayType: 'weekday', regionId: 'all', viewMode: 'bird', moduleId: 'traffic',
    layers: {}, selected: null,
    playing: false, speed: 1, scrubbing: false, drawerOpen: false,
    chartsOk: false, chartsError: null
  };

  var ctx = {};            // { city, sim, api, scene, builder, rig, layers, charts }
  var api = null;
  var dom = {};            // 缓存的节点
  var viewIcons = {};      // 从 index.html 占位里抄下来的视角图标
  var tlCells = [];        // 144 个 .tl-cell
  var tlActive = -1;
  var warned = {};         // 同类降级只告警一次
  var detailCtx = null;    // { detail, hit } 当前抽屉内容
  var hoverCache = { key: '', detail: null };

  var HEAVY_MS = 140;      // 时间变化时"重刷新"的节流间隔
  var DRAWER_MS = 450;

  /* ================================================================== *
   * 0. 小工具
   * ================================================================== */

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function hex(token) {
    return (TP.Theme && TP.Theme.hex) ? TP.Theme.hex(token) : 'currentColor';
  }

  function warnOnce(key, msg, err) {
    if (warned[key]) return;
    warned[key] = true;
    if (window.console && console.warn) console.warn('[UI] ' + msg, err || '');
  }

  /** 安全调用可选模块的方法：模块/方法不存在或抛错都只返回 undefined */
  function call(obj, method) {
    if (!obj || typeof obj[method] !== 'function') return undefined;
    try {
      return obj[method].apply(obj, Array.prototype.slice.call(arguments, 2));
    } catch (e) {
      warnOnce('call:' + method, method + '() 调用失败，已降级', e);
      return undefined;
    }
  }

  /** 图表层是否可用（缺失 / init 抛错 → false，全程走占位或 SVG 兜底） */
  function chartsUsable() {
    return !!(state.chartsOk && ctx.charts);
  }

  /** 调图表方法；成功返回 true。任何异常都被吞掉并记一次 warn */
  function chart(method) {
    if (!chartsUsable()) return false;
    var c = ctx.charts;
    if (typeof c[method] !== 'function') { warnOnce('chart:' + method, 'TP.Charts.' + method + ' 不存在'); return false; }
    try {
      c[method].apply(c, Array.prototype.slice.call(arguments, 1));
      return true;
    } catch (e) {
      warnOnce('chartErr:' + method, 'TP.Charts.' + method + '() 抛错，该图表位保持占位', e);
      return false;
    }
  }

  function levelClass(level) { return level === 'bad' ? ' is-alert' : ''; }

  function fmtKm(v) {
    v = +v || 0;
    return (v >= 100 ? U.int(v) : U.fixed(v, 1)) + ' km';
  }

  function fmtCount(v) {
    v = +v || 0;
    return v >= 100000 ? U.compact(v) : U.int(v);
  }

  /* ================================================================== *
   * 1. 轻量 SVG 折线图（抽屉内 24h 曲线 / 预测；图表层不可用时的右栏兜底）
   * ================================================================== */

  /**
   * opts: { w, h, x:[], y:[], color, unit, xFmt(v), now, ref, refLabel,
   *         band:[{x, lo, hi}], dashedFrom, ticks:[x...] }
   */
  function svgLine(opts) {
    var w = Math.max(160, Math.round(opts.w || 320));
    var h = Math.max(70, Math.round(opts.h || 130));
    var x = opts.x || [], y = opts.y || [];
    var n = Math.min(x.length, y.length);
    if (n < 2) return '';
    var padL = 30, padR = 8, padT = 10, padB = 18;
    var iw = w - padL - padR, ih = h - padT - padB;
    var i, lo = Infinity, hi = -Infinity;
    for (i = 0; i < n; i++) { if (y[i] < lo) lo = y[i]; if (y[i] > hi) hi = y[i]; }
    var band = opts.band || null;
    if (band) for (i = 0; i < band.length; i++) { if (band[i].lo < lo) lo = band[i].lo; if (band[i].hi > hi) hi = band[i].hi; }
    if (opts.ref != null) { if (opts.ref > hi) hi = opts.ref; if (opts.ref < lo) lo = opts.ref; }
    if (opts.zero !== false && lo > 0 && lo < (hi - lo) * 1.5) lo = 0;
    if (hi - lo < 1e-6) { hi = lo + 1; }
    var span = hi - lo;
    hi += span * 0.08;
    if (lo !== 0) lo -= span * 0.08;
    var x0 = x[0], x1 = x[n - 1];
    if (x1 === x0) x1 = x0 + 1;
    function sx(v) { return padL + (v - x0) / (x1 - x0) * iw; }
    function sy(v) { return padT + (1 - (v - lo) / (hi - lo)) * ih; }
    function f(v) { return Math.round(v * 10) / 10; }

    var color = opts.color || hex('--c-primary');
    var grid = hex('--c-border');
    var uid = U.uid('lg');
    var s = '<svg class="ui-chart" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h +
      '" role="img" style="display:block;font-size:10px;font-variant-numeric:tabular-nums">';
    s += '<defs><linearGradient id="' + uid + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="' + color + '" stop-opacity="0.2"/>' +
      '<stop offset="1" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>';

    /* 横向网格 + Y 轴标签 */
    for (i = 0; i <= 3; i++) {
      var gv = lo + (hi - lo) * i / 3, gy = f(sy(gv));
      s += '<line x1="' + padL + '" x2="' + (w - padR) + '" y1="' + gy + '" y2="' + gy +
        '" stroke="' + grid + '" stroke-width="1"' + (i ? ' stroke-dasharray="2 3"' : '') + '/>';
      s += '<text x="' + (padL - 5) + '" y="' + (gy + 3) + '" text-anchor="end" style="fill:var(--c-text-dim)">' +
        (Math.abs(gv) >= 100 ? Math.round(gv) : f(gv)) + '</text>';
    }
    /* X 轴刻度 */
    var ticks = opts.ticks || [x0, x0 + (x1 - x0) / 2, x1];
    for (i = 0; i < ticks.length; i++) {
      var tx = f(sx(ticks[i]));
      var anchor = i === 0 ? 'start' : (i === ticks.length - 1 ? 'end' : 'middle');
      s += '<text x="' + tx + '" y="' + (h - 4) + '" text-anchor="' + anchor + '" style="fill:var(--c-text-dim)">' +
        esc(opts.xFmt ? opts.xFmt(ticks[i]) : ticks[i]) + '</text>';
    }
    /* 参考线（如限速） */
    if (opts.ref != null) {
      var ry = f(sy(opts.ref));
      s += '<line x1="' + padL + '" x2="' + (w - padR) + '" y1="' + ry + '" y2="' + ry +
        '" stroke="' + hex('--c-text-dim') + '" stroke-width="1" stroke-dasharray="5 4"/>';
      if (opts.refLabel) {
        s += '<text x="' + (w - padR - 2) + '" y="' + (ry - 3) + '" text-anchor="end" style="fill:var(--c-text-dim)">' +
          esc(opts.refLabel) + '</text>';
      }
    }
    /* 置信带 */
    if (band && band.length > 1) {
      var bp = '';
      for (i = 0; i < band.length; i++) bp += (i ? 'L' : 'M') + f(sx(band[i].x)) + ' ' + f(sy(band[i].hi));
      for (i = band.length - 1; i >= 0; i--) bp += 'L' + f(sx(band[i].x)) + ' ' + f(sy(band[i].lo));
      s += '<path d="' + bp + 'Z" fill="' + color + '" fill-opacity="0.14" stroke="none"/>';
    }
    /* 面积 + 折线 */
    var lp = '';
    for (i = 0; i < n; i++) lp += (i ? 'L' : 'M') + f(sx(x[i])) + ' ' + f(sy(y[i]));
    if (!band) {
      s += '<path d="' + lp + 'L' + f(sx(x[n - 1])) + ' ' + f(sy(lo)) + 'L' + f(sx(x[0])) + ' ' + f(sy(lo)) +
        'Z" fill="url(#' + uid + ')" stroke="none"/>';
    }
    s += '<path d="' + lp + '" fill="none" stroke="' + color + '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"' +
      (opts.dashed ? ' stroke-dasharray="5 3"' : '') + '/>';
    /* 当前时刻标线 */
    if (opts.now != null && opts.now >= x0 && opts.now <= x1) {
      var nx = f(sx(opts.now));
      var k = Math.min(n - 1, Math.max(0, Math.round((opts.now - x0) / (x1 - x0) * (n - 1))));
      s += '<line x1="' + nx + '" x2="' + nx + '" y1="' + padT + '" y2="' + (padT + ih) +
        '" stroke="' + hex('--c-primary') + '" stroke-width="1" stroke-dasharray="3 3"/>';
      s += '<circle cx="' + nx + '" cy="' + f(sy(y[k])) + '" r="3" fill="' + hex('--c-panel') +
        '" stroke="' + color + '" stroke-width="1.6"/>';
    }
    return s + '</svg>';
  }

  /** 迷你走势图兜底：与 index.html 占位同构（viewBox 0 0 120 34 + polyline） */
  function sparkSvg(data, color) {
    if (!data || data.length < 2) return '';
    var lo = Infinity, hi = -Infinity, i;
    for (i = 0; i < data.length; i++) { if (data[i] < lo) lo = data[i]; if (data[i] > hi) hi = data[i]; }
    if (hi - lo < 1e-9) hi = lo + 1;
    var pts = [];
    for (i = 0; i < data.length; i++) {
      pts.push(U.round(i / (data.length - 1) * 120, 1) + ',' + U.round(30 - (data[i] - lo) / (hi - lo) * 26, 1));
    }
    return '<svg viewBox="0 0 120 34" preserveAspectRatio="none" aria-hidden="true">' +
      '<polyline points="' + pts.join(' ') + '"' + (color ? ' style="stroke:' + color + '"' : '') + '/></svg>';
  }

  /** 绿波带时距图兜底（图表层不可用时画进 #signal-diagram） */
  function greenWaveSvg(g, w, h) {
    if (!g || !g.stops || !g.stops.length) return '';
    w = Math.max(260, Math.round(w || 600)); h = Math.max(110, Math.round(h || 150));
    var padL = 40, padR = 12, padT = 16, padB = 22;
    var iw = w - padL - padR, ih = h - padT - padB;
    var stops = g.stops, i, maxD = 0, cyc = 0;
    for (i = 0; i < stops.length; i++) {
      if (stops[i].distanceFromStart > maxD) maxD = stops[i].distanceFromStart;
      if (stops[i].cycle > cyc) cyc = stops[i].cycle;
    }
    maxD = maxD || 1; cyc = cyc || 90;
    var T = cyc * 2;                                   // 纵轴：两个周期
    function sx(d) { return padL + d / maxD * iw; }
    function sy(t) { return padT + (1 - t / T) * ih; }
    var green = hex('--road-free'), red = hex('--road-block'), line = hex('--c-primary');
    var s = '<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h +
      '" role="img" style="font-size:10px;font-variant-numeric:tabular-nums">';
    s += '<text x="' + padL + '" y="11" style="fill:var(--c-text-sub);font-weight:700">' +
      esc((g.corridorName || '绿波带') + ' · 推荐车速 ' + g.recommendedSpeed + ' km/h · 带宽 ' + Math.round(g.bandwidth || 0) + ' 秒') + '</text>';
    s += '<line x1="' + padL + '" x2="' + (w - padR) + '" y1="' + (padT + ih) + '" y2="' + (padT + ih) + '" stroke="' + hex('--c-border') + '"/>';
    s += '<text x="' + (padL - 5) + '" y="' + (padT + ih + 3) + '" text-anchor="end" style="fill:var(--c-text-dim)">0s</text>';
    s += '<text x="' + (padL - 5) + '" y="' + (padT + 4) + '" text-anchor="end" style="fill:var(--c-text-dim)">' + T + 's</text>';
    for (i = 0; i < stops.length; i++) {
      var st = stops[i], cx = Math.round(sx(st.distanceFromStart) * 10) / 10;
      var c = st.cycle || cyc, gs = st.greenSec || c * (st.greenRatio || 0.5), off = st.offsetSec || 0;
      s += '<line x1="' + cx + '" x2="' + cx + '" y1="' + padT + '" y2="' + (padT + ih) + '" stroke="' + red + '" stroke-width="4" stroke-opacity="0.55"/>';
      for (var t0 = (off % c) - c; t0 < T; t0 += c) {
        var a = Math.max(0, t0), b = Math.min(T, t0 + gs);
        if (b <= a) continue;
        s += '<line x1="' + cx + '" x2="' + cx + '" y1="' + sy(a) + '" y2="' + sy(b) + '" stroke="' + green + '" stroke-width="4"/>';
      }
      if (stops.length <= 14 || i % 2 === 0) {
        s += '<text x="' + cx + '" y="' + (h - 6) + '" text-anchor="middle" style="fill:var(--c-text-dim)">' +
          U.fixed(st.distanceFromStart / 1000, 1) + '</text>';
      }
    }
    /* 推荐车速斜线：从首站绿灯起点出发 */
    var v = (g.recommendedSpeed || 40) / 3.6;
    var startT = ((stops[0].offsetSec || 0) % (stops[0].cycle || cyc));
    var endT = startT + maxD / v;
    s += '<line x1="' + sx(0) + '" y1="' + sy(startT) + '" x2="' + sx(maxD) + '" y2="' + sy(Math.min(T, endT)) +
      '" stroke="' + line + '" stroke-width="1.6" stroke-dasharray="6 4"/>';
    s += '<text x="' + (w - padR) + '" y="' + (h - 6) + '" text-anchor="end" style="fill:var(--c-text-dim)">km</text>';
    return s + '</svg>';
  }

  /* ================================================================== *
   * 2. 渲染：顶栏
   * ================================================================== */

  UI.renderTicker = function () {
    var host = dom.ticker;
    if (!host || !api) return;
    var items = api.ticker() || [];
    if (!items.length) return;
    var track = host.querySelector('.ticker-track');
    var box = track || host;
    var copies = track ? 2 : 1;

    /* 结构未变时只改数值文本，避免重排打断 marquee 动画 */
    var nodes = box.querySelectorAll('.ticker-item');
    if (nodes.length === items.length * copies && box.getAttribute('data-ui') === '1') {
      for (var i = 0; i < nodes.length; i++) {
        var it = items[i % items.length];
        var vEl = nodes[i].querySelector('.ticker-value');
        var html = esc(it.value) + (it.unit ? '<small>' + esc(it.unit) + '</small>' : '');
        if (vEl && vEl.getAttribute('data-v') !== html) { vEl.innerHTML = html; vEl.setAttribute('data-v', html); }
        U.setClass(nodes[i], 'is-alert', tickerAlert(it));
      }
      return;
    }
    var out = '';
    for (var c = 0; c < copies; c++) {
      for (var k = 0; k < items.length; k++) {
        var t = items[k];
        var vh = esc(t.value) + (t.unit ? '<small>' + esc(t.unit) + '</small>' : '');
        out += '<div class="ticker-item' + (tickerAlert(t) ? ' is-alert' : '') + '"' + (c ? ' aria-hidden="true"' : '') + '>' +
          '<span class="ticker-label">' + esc(t.label) + '</span>' +
          '<span class="ticker-value" data-v="' + esc(vh) + '">' + vh + '</span></div>';
      }
    }
    box.innerHTML = out;
    box.setAttribute('data-ui', '1');
  };

  function tickerAlert(it) { return !!(it && it.invert && it.trend < 0); }

  UI.setClock = function (date) {
    date = date || new Date();
    if (dom.clock) {
      var t = U.hms(date);
      if (dom.clock.textContent !== t) dom.clock.textContent = t;
    }
    if (dom.date) {
      var d = date.getFullYear() + '-' + U.pad2(date.getMonth() + 1) + '-' + U.pad2(date.getDate()) +
        '\u3000星期' + '日一二三四五六'.charAt(date.getDay());
      if (dom.date.textContent !== d) dom.date.textContent = d;
    }
    /* #weather-chip：数据门面未提供气象口径，保留 index.html 的静态文案，仅补 title */
    if (dom.weather && !dom.weather.getAttribute('data-ui')) {
      dom.weather.setAttribute('data-ui', '1');
      dom.weather.title = '气象（静态示例） · ' + (api ? (api.meta().cityName || '') : '');
    }
  };

  /* ================================================================== *
   * 3. 渲染：左栏
   * ================================================================== */

  UI.renderLayers = function () {
    var host = dom.layers;
    if (!host || !api) return;
    var list = api.layersMeta() || [];
    var out = '';
    for (var i = 0; i < list.length; i++) {
      var L = list[i];
      state.layers[L.id] = !!L.on;
      out += '<label class="layer-item' + (L.on ? ' is-active' : '') + '" data-layer="' + esc(L.id) + '"' +
        ' role="switch" tabindex="0" aria-checked="' + (L.on ? 'true' : 'false') + '" title="' + esc(L.name) + '">' +
        '<span class="layer-icon">' + (L.icon || '') + '</span>' +
        '<span class="layer-name">' + esc(L.name) + '</span>' +
        '<span class="layer-count" title="' + esc(fmtCount(L.count) + ' ' + (L.unit || '')) + '">' + esc(fmtCount(L.count)) + '</span>' +
        '<span class="switch' + (L.on ? ' is-active' : '') + '"><i></i></span></label>';
    }
    host.innerHTML = out;
    var tag = document.querySelector('[data-panel="layers"] .panel-tools .tag');
    if (tag) tag.textContent = list.length + ' 类图层';
  };

  /** 只更新图层数量与开关态（时间变化时用，不重建节点） */
  function patchLayers() {
    var host = dom.layers;
    if (!host || !api) return;
    var list = api.layersMeta() || [];
    var nodes = host.querySelectorAll('.layer-item');
    if (nodes.length !== list.length) { UI.renderLayers(); return; }
    for (var i = 0; i < list.length; i++) {
      var L = list[i], el = nodes[i];
      if (el.getAttribute('data-layer') !== L.id) { UI.renderLayers(); return; }
      var cnt = el.querySelector('.layer-count'), txt = fmtCount(L.count);
      if (cnt && cnt.textContent !== txt) { cnt.textContent = txt; cnt.title = txt + ' ' + (L.unit || ''); }
      setLayerNode(el, !!L.on);
      state.layers[L.id] = !!L.on;
    }
  }

  function setLayerNode(el, on) {
    U.setClass(el, 'is-active', on);
    U.setClass(el.querySelector('.switch'), 'is-active', on);
    el.setAttribute('aria-checked', on ? 'true' : 'false');
  }

  UI.renderRegions = function () {
    var host = dom.regions;
    if (!host || !api) return;
    var list = api.regionsMeta ? api.regionsMeta() : (api.snapshot().regions || []);
    var out = '';
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      out += '<button class="region-item' + (r.active ? ' is-active' : '') + '" data-region="' + esc(r.id) +
        '" type="button" aria-pressed="' + (r.active ? 'true' : 'false') + '">' +
        '<span class="region-name">' + esc(r.name) + '</span>' +
        '<span class="region-value">' + esc(fmtKm(r.value)) + '</span></button>';
    }
    host.innerHTML = out;
  };

  UI.renderViews = function () {
    var host = dom.views;
    if (!host || !api) return;
    var list = api.viewsMeta() || [];
    var out = '';
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      out += '<button class="view-btn' + (v.active ? ' is-active' : '') + '" data-view="' + esc(v.id) +
        '" type="button" aria-pressed="' + (v.active ? 'true' : 'false') + '" title="' + esc(v.name + '（快捷键 ' + v.key + '）') + '">' +
        '<span class="view-icon">' + (viewIcons[v.id] || '') + '</span>' +
        '<span class="view-text"><b>' + esc(v.name) + '</b><em>' + esc(v.desc) + '</em></span>' +
        '<kbd class="view-key">' + esc(v.key) + '</kbd></button>';
    }
    host.innerHTML = out;
  };

  /* ================================================================== *
   * 4. 渲染：右栏
   * ================================================================== */

  UI.renderKpiCards = function () {
    var host = dom.kpi;
    if (!host || !api) return;
    var cards = api.kpiCards() || [];
    var nodes = host.querySelectorAll('.kpi-card[data-kpi]');
    var same = nodes.length === cards.length && cards.length > 0;
    var i;
    for (i = 0; same && i < cards.length; i++) if (nodes[i].getAttribute('data-kpi') !== cards[i].id) same = false;

    if (!same) {
      var out = '';
      for (i = 0; i < cards.length; i++) {
        var c = cards[i];
        out += '<article class="kpi-card' + levelClass(c.level) + '" data-kpi="' + esc(c.id) + '">' +
          '<div class="kpi-head"><span class="kpi-label">' + esc(c.label) + '</span>' +
          '<span class="kpi-trend ' + trendClass(c.trend) + '">' + esc(c.trendText) + '</span></div>' +
          '<div class="kpi-value"><b>' + esc(c.value) + '</b><i>' + esc(c.unit) + '</i></div>' +
          '<div class="kpi-spark" data-spark="' + esc(c.id) + '"></div>' +
          '<div class="kpi-foot">' + esc(c.foot) + '</div></article>';
      }
      host.innerHTML = out;
      nodes = host.querySelectorAll('.kpi-card[data-kpi]');
    }
    for (i = 0; i < cards.length; i++) {
      var k = cards[i], el = nodes[i];
      if (!el) continue;
      if (same) {
        U.setClass(el, 'is-alert', k.level === 'bad');
        var b = el.querySelector('.kpi-value b');
        if (b && b.textContent !== String(k.value)) b.textContent = k.value;
        var tr = el.querySelector('.kpi-trend');
        if (tr) { tr.className = 'kpi-trend ' + trendClass(k.trend); if (tr.textContent !== k.trendText) tr.textContent = k.trendText; }
        var ft = el.querySelector('.kpi-foot');
        if (ft && ft.textContent !== k.foot) ft.textContent = k.foot;
      }
      fillSpark(el.querySelector('.kpi-spark'), k.spark, k.color);
    }
  };

  function trendClass(t) { return t > 0 ? 'is-up' : (t < 0 ? 'is-down' : 'is-flat'); }

  /** .kpi-spark：优先 TP.Charts.sparkline；不可用则画同构 SVG polyline */
  function fillSpark(el, data, color) {
    if (!el) return;
    if (el.getAttribute('data-spark-mode') !== 'svg' && chart('sparkline', el, data || [], color, { animation: false })) {
      el.setAttribute('data-spark-mode', 'chart');
      return;
    }
    if (el.getAttribute('data-spark-mode') === 'chart') return;   // 图表已接管但本次失败：保留上一帧
    el.setAttribute('data-spark-mode', 'svg');
    el.innerHTML = sparkSvg(data, color);
  }

  UI.renderRanking = function () {
    var host = dom.rank;
    if (!host || !api) return;
    var list = api.ranking('corridor', 'congestionIndex', 6) || [];
    var sel = state.selected;
    var out = '<ol class="rank-list">';
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      var cls = 'rank-item' + (r.isAlert ? ' is-alert' : '') +
        (sel && sel.kind === 'corridor' && sel.id === r.id ? ' is-selected' : '');
      out += '<li class="' + cls + '" data-id="' + esc(r.id) + '" tabindex="0" title="' + esc(r.name + ' · ' + (r.extra || '')) + '">' +
        '<span class="rank-no">' + U.pad2(i + 1) + '</span>' +
        '<span class="rank-name">' + esc(r.name) + '</span>' +
        '<span class="rank-bar"><i style="width:' + Math.round(U.clamp01(r.ratio) * 100) + '%"></i></span>' +
        '<span class="rank-value">' + esc(r.display) + '</span></li>';
    }
    out += '</ol>';
    if (!list.length) out = '<div class="is-empty">暂无走廊数据</div>';
    host.innerHTML = out;
    var meta = document.querySelector('[data-panel="rank"] .panel-meta');
    if (meta) meta.textContent = '拥堵指数 TOP ' + (list.length || 6);
  };

  /** 右栏两张图：图表层可用则交给 TP.Charts；否则画 SVG 兜底 */
  function renderSideCharts() {
    if (!api) return;
    if (chartsUsable()) {
      chart('trend', api.state.metric || 'congestionIndex');
      chart('forecast', api.state.metric || 'congestionIndex');
      return;
    }
    var metric = api.state.metric || 'congestionIndex';
    var se = api.series(metric);
    if (dom.chartTrend && se && se.y && se.y.length) {
      dom.chartTrend.innerHTML = svgLine({
        w: dom.chartTrend.clientWidth, h: dom.chartTrend.clientHeight || 120,
        x: se.x, y: se.y, now: state.minute, color: hex('--c-primary'),
        ticks: [0, 360, 720, 1080, se.x[se.x.length - 1]], xFmt: tickHHMM
      });
    }
    var fc = api.forecast(metric, 60);
    if (dom.chartForecast && fc && fc.points && fc.points.length) {
      dom.chartForecast.innerHTML = forecastSvg(fc, dom.chartForecast.clientWidth, dom.chartForecast.clientHeight || 120, hex('--c-accent'));
    }
  }

  function tickHHMM(m) { return m >= 1435 ? '24:00' : U.hhmm(m); }

  function forecastSvg(fc, w, h, color) {
    var pts = fc.points, xs = [], ys = [], band = [], lab = {};
    for (var i = 0; i < pts.length; i++) {
      xs.push(i); ys.push(pts[i].v);
      band.push({ x: i, lo: pts[i].lo, hi: pts[i].hi });
      lab[i] = pts[i].hhmm;
    }
    var mid = Math.floor((pts.length - 1) / 2);
    return svgLine({
      w: w, h: h, x: xs, y: ys, band: band, color: color, zero: false,
      ticks: [0, mid, pts.length - 1], xFmt: function (v) { return lab[v] || ''; }
    });
  }

  /* ================================================================== *
   * 5. 渲染：底栏模块
   * ================================================================== */

  UI.renderModules = function () {
    var host = dom.tabs;
    if (!host || !api) return;
    var list = api.modulesMeta() || [];
    var out = '';
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      out += '<button class="tab' + (m.active ? ' is-active' : '') + '" data-module="' + esc(m.id) +
        '" type="button" role="tab" aria-selected="' + (m.active ? 'true' : 'false') + '">' + esc(m.name) + '</button>';
    }
    host.innerHTML = out;
  };

  function renderMetrics(board) {
    var host = dom.metrics;
    if (!host) return;
    var list = (board && board.metrics) || [];
    var out = '';
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      out += '<div class="mini-card' + levelClass(m.level) + '" title="' + esc(m.label + '：' + m.value + ' ' + (m.unit || '')) + '">' +
        '<span class="mini-label">' + esc(m.label) + '</span>' +
        '<b class="mini-value">' + esc(m.value) + '</b>' +
        '<em class="mini-unit">' + esc(m.unit || '') + '</em></div>';
    }
    host.innerHTML = out;
  }

  /** #module-metrics + #bottom-chart + #signal-diagram。opts.metricsOnly：只刷指标小卡 */
  UI.renderModuleBody = function (opts) {
    if (!api) return;
    opts = opts || {};
    var id = api.state.moduleId;
    var board = null;
    try { board = api.moduleBoard(id); } catch (e) { warnOnce('board', 'moduleBoard 取数失败', e); }
    renderMetrics(board);
    if (opts.metricsOnly) return;

    var isSignal = id === 'signal';
    /* #signal-diagram 只在信号绿波模块显示；其余模块必须隐藏，否则会盖住 #bottom-chart */
    U.setClass(dom.signal, 'is-hidden', !isSignal);

    if (chartsUsable()) {
      if (dom.bottomChart && dom.bottomChart.getAttribute('data-empty-orig')) {
        dom.bottomChart.setAttribute('data-empty', dom.bottomChart.getAttribute('data-empty-orig'));
      }
      if (isSignal) {
        var ok = chart('signalDiagram', api.state.signalGroupId);
        if (!ok) drawSignalFallback();
      } else {
        chart('moduleChart', id);
      }
      /* 显隐切换后容器尺寸变了，让 ECharts 在下一帧重新量尺寸 */
      U.nextFrame(function () { chart('resize'); });
      return;
    }
    /* —— 图表层不可用：信号模块画 SVG 时距图，其余模块显示占位文案 —— */
    if (isSignal) { drawSignalFallback(); return; }
    if (dom.bottomChart) {
      if (!dom.bottomChart.getAttribute('data-empty-orig')) {
        dom.bottomChart.setAttribute('data-empty-orig', dom.bottomChart.getAttribute('data-empty') || '');
      }
      var title = (board && board.chart && board.chart.title) || '模块图表';
      dom.bottomChart.setAttribute('data-empty', title + ' · 图表组件未就绪，指标卡与三维场景不受影响');
      dom.bottomChart.innerHTML = '';
    }
  };

  function drawSignalFallback() {
    if (!dom.signal || !api) return;
    var g = null;
    try { g = api.signalBoard(api.state.signalGroupId); } catch (e) { g = null; }
    if (!g) { dom.signal.innerHTML = ''; dom.signal.setAttribute('data-empty', '暂无绿波带数据'); return; }
    dom.signal.innerHTML = greenWaveSvg(g, dom.signal.clientWidth, dom.signal.clientHeight);
  }

  UI.renderLegend = function () {
    var host = dom.legend;
    if (!host || !api) return;
    var id = api.state.moduleId;
    var list = [];
    try { list = api.legend(id) || []; } catch (e) { list = []; }
    var name = '图例', mods = api.modulesMeta();
    for (var i = 0; i < mods.length; i++) if (mods[i].id === id) name = mods[i].name + '图例';
    var out = '<div class="legend-title">' + esc(name) + '</div>';
    for (var k = 0; k < list.length; k++) {
      var it = list[k];
      out += '<div class="legend-item"><span class="legend-swatch" style="background:' + esc(it.color) + '"></span>' +
        '<span class="legend-text">' + esc(it.label) + '\u3000' + esc(it.value) + (it.unit ? ' ' + esc(it.unit) : '') + '</span></div>';
    }
    /* 线网图层开启时补充线型图例 */
    var L = api.state.layers || {};
    if (L.metro || L.bus) {
      out += '<div class="legend-sep"></div>';
      if (L.metro) out += '<div class="legend-item"><span class="legend-swatch legend-swatch--line legend-swatch--metro"></span><span class="legend-text">地铁线路</span></div>';
      if (L.bus) out += '<div class="legend-item"><span class="legend-swatch legend-swatch--line legend-swatch--bus"></span><span class="legend-text">公交线网</span></div>';
    }
    host.innerHTML = out;
  };

  function renderStageBadge() {
    var b = dom.badgeB, em = dom.badgeEm;
    if (!api || (!b && !em)) return;
    var snap = api.snapshot(), name = '全市路网', i;
    for (i = 0; i < snap.regions.length; i++) if (snap.regions[i].active && snap.regions[i].id !== 'all') name = snap.regions[i].name;
    var t1 = name + ' · ' + (snap.time.phaseName || '实时');
    var m = api.meta();
    var t2 = (m.cityName || '') + ' · ' + snap.time.hhmm + ' · 均速 ' + U.fixed(snap.kpi.avgSpeed, 1) + ' km/h';
    if (b && b.textContent !== t1) b.textContent = t1;
    if (em && em.textContent !== t2) em.textContent = t2;
  }

  /* ================================================================== *
   * 6. 时间轴
   * ================================================================== */

  UI.renderTimeline = function () {
    var host = dom.track;
    if (!host || !api) return;
    var bands = api.timelineBands() || [];
    var out = '';
    for (var i = 0; i < bands.length; i++) {
      var b = bands[i];
      out += '<div class="tl-cell" data-level="' + (b.level | 0) + '" data-minute="' + b.minute +
        '" title="' + esc(b.label || b.hhmm) + '" style="background:' + esc(b.color) + '"></div>';
    }
    host.innerHTML = out;
    tlCells = Array.prototype.slice.call(host.querySelectorAll('.tl-cell'));
    tlActive = -1;
    syncTimeline(state.minute, false);
  };

  /** 只动 slider / label / 热力条高亮 —— 每次时间变化都同步执行，必须足够轻 */
  function syncTimeline(m, fromSlider) {
    var s = dom.slider;
    if (s) {
      if (!fromSlider && +s.value !== m) s.value = m;
      s.style.setProperty('--_fill', (m / 1439 * 100) + '%');
      s.setAttribute('aria-valuetext', U.hhmm(m));
    }
    if (dom.tlLabel) {
      var t = U.hhmm(m);
      if (dom.tlLabel.textContent !== t) dom.tlLabel.textContent = t;
    }
    if (tlCells.length) {
      var idx = Math.min(tlCells.length - 1, Math.floor(m / (1440 / tlCells.length)));
      if (idx !== tlActive) {
        if (tlActive >= 0 && tlCells[tlActive]) tlCells[tlActive].classList.remove('is-active');
        tlCells[idx].classList.add('is-active');
        tlActive = idx;
      }
    }
  }

  /**
   * 同步时间轴 UI。若 m 与数据门面当前时刻不同（外部跳转），会先写回 TP.Api.setMinute。
   * opts: { fromPlayback, fromSlider, silent }
   */
  UI.setMinute = function (m, opts) {
    opts = opts || {};
    m = U.clamp(Math.round(+m || 0), 0, 1439);
    if (api && !opts.silent && api.state.minute !== m) {
      api.setMinute(m);                 // → 'time' 事件 → onTime() 再回到这里（silent）
      if (state.minute === m) return;
    }
    state.minute = m;
    syncTimeline(m, !!opts.fromSlider);
  };

  var ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 5.8v12.4L18.6 12z"/></svg>';
  var ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 5.5h3.4v13H7.5zM13.1 5.5h3.4v13h-3.4z"/></svg>';

  UI.setPlaying = function (on) {
    on = !!on;
    state.playing = on;
    var b = dom.play;
    if (!b) return;
    if (U.hasClass(b, 'is-playing') !== on || !b.getAttribute('data-ui')) {
      U.setClass(b, 'is-playing', on);
      b.innerHTML = on ? ICON_PAUSE : ICON_PLAY;
      b.setAttribute('aria-label', on ? '暂停' : '播放');
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.title = on ? '暂停回放（空格）' : '播放 24 小时回放（空格）';
      b.setAttribute('data-ui', '1');
    }
  };

  UI.setSpeed = function (v) {
    v = +v;
    if (v !== 1 && v !== 2 && v !== 4 && v !== 8) v = 1;
    state.speed = v;
    if (!dom.speed) return;
    var btns = dom.speed.querySelectorAll('button[data-speed]');
    for (var i = 0; i < btns.length; i++) {
      var on = +btns[i].getAttribute('data-speed') === v;
      U.setClass(btns[i], 'is-active', on);
      btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  };

  /* ================================================================== *
   * 7. 详情抽屉
   * ================================================================== */

  var LV_CLS = { bad: ' class="t-block"', warn: ' class="t-jam"' };

  function drawerHTML(d) {
    var i, out = '';
    /* 徽标行 */
    out += '<div class="drawer-meta">';
    var badges = d.badges || [];
    for (i = 0; i < badges.length; i++) {
      var bk = badges[i].kind || 'tag';
      var cls = bk.indexOf('badge--') === 0 ? 'badge ' + bk : 'tag';
      out += '<span class="' + cls + '">' + esc(badges[i].text) + '</span>';
    }
    if (d.districtName) out += '<span class="tag">' + esc(d.districtName) + '</span>';
    out += '<span class="drawer-meta-time">数据时刻 ' + U.hhmm(state.minute) + '</span></div>';
    if (d.subtitle) out += '<p>' + esc(d.subtitle) + '</p>';

    /* 指标网格 */
    var ms = d.metrics || [];
    if (ms.length) {
      out += '<div class="kv-grid">';
      for (i = 0; i < ms.length; i++) {
        out += '<div class="kv"><span>' + esc(ms[i].label) + '</span><b' + (LV_CLS[ms[i].level] || '') + '>' +
          esc(ms[i].value) + (ms[i].unit ? '<small>' + esc(ms[i].unit) + '</small>' : '') + '</b></div>';
      }
      out += '</div>';
    }
    /* 24h 曲线与预测：占位容器，插入 DOM 后按实际宽度绘制 */
    if (d.series && d.series.y && d.series.y.length) {
      out += '<h4 class="drawer-sec">' + esc((d.series.label || '指标') + ' · 24 小时曲线（' + (d.series.unit || '') + '）') + '</h4>' +
        '<div class="drawer-chart" data-chart="series"></div>';
    }
    if (d.forecast && d.forecast.points && d.forecast.points.length) {
      var trendCn = { up: '回升', down: '回落', flat: '平稳' }[d.forecast.trend] || '';
      out += '<h4 class="drawer-sec">未来 1 小时预测' + (trendCn ? ' · 趋势' + trendCn : '') + '</h4>' +
        '<div class="drawer-chart" data-chart="forecast"></div>';
    }
    /* 通行链条 */
    var fs = d.flowSteps || [];
    if (fs.length) {
      out += '<h4 class="drawer-sec">通行效率分解</h4><ol class="flow-steps">';
      for (i = 0; i < fs.length; i++) {
        out += '<li class="flow-step' + (i === fs.length - 1 ? ' is-active' : ' is-done') + '"><span class="flow-dot"></span>' +
          '<time>' + esc(fs[i].label) + '</time><p><b>' + esc(fs[i].value) + '</b> ' + esc(fs[i].unit || '') + '</p></li>';
      }
      out += '</ol>';
    }
    /* 信号 */
    var sg = d.signals || [];
    if (sg.length) {
      out += '<h4 class="drawer-sec">两端信号路口</h4><div class="table-wrap"><table class="data-table"><thead><tr>' +
        '<th>路口</th><th>周期 s</th><th>相位</th><th>剩余 s</th></tr></thead><tbody>';
      for (i = 0; i < sg.length; i++) {
        var pk = sg[i].phase === 'green' ? 'badge--ok' : (sg[i].phase === 'yellow' ? 'badge--warn' : 'badge--bad');
        out += '<tr><td>' + esc(sg[i].name) + '</td><td>' + esc(sg[i].cycle) + '</td><td><span class="badge ' + pk + '">' +
          esc(sg[i].phaseName || sg[i].phase) + '</span></td><td>' + esc(sg[i].remain) + '</td></tr>';
      }
      out += '</tbody></table></div>';
    }
    /* 信号路口的配时方案 */
    var sp = d.splits || [];
    if (sp.length) {
      out += '<h4 class="drawer-sec">配时方案</h4><ul class="plain-list">';
      for (i = 0; i < sp.length; i++) {
        out += '<li><span>进口道 ' + esc(sp[i].dir) + '</span><b>绿 ' + esc(Math.round(sp[i].green)) + ' s · 黄 ' + esc(sp[i].yellow) + ' s</b></li>';
      }
      out += '</ul>';
    }
    /* 事件 */
    var ev = d.events || [];
    if (ev.length) {
      out += '<h4 class="drawer-sec">关联交通事件</h4><ul class="plain-list">';
      for (i = 0; i < ev.length; i++) {
        var ek = ev[i].severity === 3 ? 'badge--bad' : (ev[i].severity === 2 ? 'badge--warn' : 'badge--ok');
        out += '<li><span>' + esc(ev[i].sinceHHMM) + '\u3000' + esc(ev[i].title) + '</span><span class="badge ' + ek + '">' +
          esc(ev[i].severityName || '') + '</span></li>';
      }
      out += '</ul>';
    }
    /* 周边公共交通 */
    var tr = d.transit || [];
    if (tr.length) {
      out += '<h4 class="drawer-sec">周边公共交通</h4><ul class="plain-list">';
      for (i = 0; i < tr.length; i++) {
        out += '<li><span>' + (tr[i].kind === 'metro' ? '地铁 · ' : '公交 · ') + esc(tr[i].name) + '</span><b>' +
          esc(U.int(tr[i].distanceM)) + ' m</b></li>';
      }
      out += '</ul>';
    }
    var nr = d.nearbyRoads || [];
    if (nr.length) {
      out += '<h4 class="drawer-sec">周边道路</h4><ul class="plain-list">';
      for (i = 0; i < nr.length; i++) {
        out += '<li><span>' + esc(nr[i].name) + '</span><b>' + esc(U.int(nr[i].distanceM)) + ' m</b></li>';
      }
      out += '</ul>';
    }
    return out;
  }

  function drawDrawerCharts(d) {
    var body = dom.drawerBody;
    if (!body) return;
    var w = Math.max(200, body.clientWidth - 28);
    var el = body.querySelector('[data-chart="series"]');
    if (el && d.series) {
      var x = d.series.x, last = x[x.length - 1];
      el.innerHTML = svgLine({
        w: w, h: 132, x: x, y: d.series.y, now: state.minute,
        color: d.color || hex('--c-primary'),
        ref: d.series.speedLimit, refLabel: d.series.speedLimit ? '自由流 ' + Math.round(d.series.speedLimit) : '',
        ticks: [0, 360, 720, 1080, last], xFmt: tickHHMM
      });
    }
    el = body.querySelector('[data-chart="forecast"]');
    if (el && d.forecast) el.innerHTML = forecastSvg(d.forecast, w, 112, hex('--c-accent'));
  }

  /** detail = TP.Api.pickInfo(hit) / roadInfo(...) 等的返回值；hit 可选（用于随时间自动刷新） */
  UI.showDetail = function (detail, hit) {
    if (!detail || !dom.drawer) return;
    var keep = detailCtx && detailCtx.detail && detailCtx.detail.kind === detail.kind && detailCtx.detail.id === detail.id;
    var scroll = keep && dom.drawerBody ? dom.drawerBody.scrollTop : 0;
    detailCtx = { detail: detail, hit: hit || hitFromDetail(detail) };
    if (dom.drawerTitle) { dom.drawerTitle.textContent = detail.title || '详情'; dom.drawerTitle.title = detail.title || ''; }
    if (dom.drawerBody) {
      dom.drawerBody.innerHTML = drawerHTML(detail);
      drawDrawerCharts(detail);
      dom.drawerBody.scrollTop = scroll;
    }
    U.addClass(dom.drawer, 'is-open');
    dom.drawer.style.visibility = '';            // 交回 CSS（.is-open → visible）
    dom.drawer.setAttribute('aria-hidden', 'false');
    state.drawerOpen = true;

    if (!keep) {
      var sel = { kind: detail.kind, id: detail.id };
      state.selected = sel;
      if (api) api.setSelected(sel);
      call(ctx.layers, 'highlight', detail.id, detail.kind);
      markRankSelected();
    }
  };

  /** 详情对象 → 可再次交给 pickInfo 的 hit（仅用于抽屉随时间刷新） */
  function hitFromDetail(d) {
    var ok = { road: 1, parking: 1, bike: 1, incident: 1, corridor: 1, district: 1, hub: 1 };
    return d && ok[d.kind] ? { kind: d.kind, id: d.id } : null;
  }

  UI.closeDrawer = function () {
    if (!dom.drawer) return;
    U.removeClass(dom.drawer, 'is-open');
    dom.drawer.setAttribute('aria-hidden', 'true');
    var was = state.drawerOpen;
    state.drawerOpen = false;
    detailCtx = null;
    if (was || state.selected) {
      state.selected = null;
      if (api) api.setSelected(null);
      call(ctx.layers, 'highlight', null);
      markRankSelected();
    }
  };

  function markRankSelected() {
    if (!dom.rank) return;
    var sel = state.selected, nodes = dom.rank.querySelectorAll('.rank-item');
    for (var i = 0; i < nodes.length; i++) {
      U.setClass(nodes[i], 'is-selected', !!(sel && sel.kind === 'corridor' && nodes[i].getAttribute('data-id') === sel.id));
    }
  }

  var refreshDrawer = null;   // 节流后的抽屉刷新，init 时创建
  function refreshDrawerNow() {
    if (!state.drawerOpen || !detailCtx || !detailCtx.hit || !api) return;
    var d = null;
    try { d = api.pickInfo(detailCtx.hit); } catch (e) { d = null; }
    if (d) UI.showDetail(d, detailCtx.hit);
  }

  /* ================================================================== *
   * 8. 反馈：tooltip / toast / loading
   * ================================================================== */

  /**
   * html：字符串，或 { title, rows:[{label, value, cls}] }
   * px / py：**#stage 局部坐标**（#tooltip 是 position:absolute 且相对 #stage）
   */
  UI.tooltip = function (html, px, py) {
    var el = dom.tooltip || (dom.tooltip = $('tooltip'));
    if (!el) return;
    if (html == null || html === '') { UI.hideTooltip(); return; }
    if (typeof html === 'object') html = tooltipHTML(html);
    if (el._html !== html) { el.innerHTML = html; el._html = html; }
    U.removeClass(el, 'is-hidden');
    /* 夹在舞台内：CSS 已做 translate(-50%, -100% - 14px)，这里只修正 left/top */
    var stage = dom.stage || el.parentNode;
    var sw = stage ? stage.clientWidth : 0;
    var tw = el.offsetWidth, th = el.offsetHeight;
    var x = px, y = py;
    if (sw) x = U.clamp(px, tw / 2 + 6, Math.max(tw / 2 + 6, sw - tw / 2 - 6));
    if (y - th - 14 < 4) y = th + 18;
    el.style.left = Math.round(x) + 'px';
    el.style.top = Math.round(y) + 'px';
  };

  function tooltipHTML(o) {
    var s = '<div id="tooltip-title">' + esc(o.title || '') + '</div><div id="tooltip-body">';
    var rows = o.rows || [];
    for (var i = 0; i < rows.length; i++) {
      s += '<div class="tt-row"><span>' + esc(rows[i].label) + '</span><b' + (rows[i].cls ? ' class="' + esc(rows[i].cls) + '"' : '') + '>' +
        esc(rows[i].value) + '</b></div>';
    }
    return s + '</div>';
  }

  UI.hideTooltip = function () {
    var el = dom.tooltip || $('tooltip');
    if (el && !U.hasClass(el, 'is-hidden')) U.addClass(el, 'is-hidden');
  };

  /** 把详情对象压成 tooltip 内容（详情仍然来自 TP.Api.pickInfo） */
  UI.tooltipFromDetail = function (d) {
    if (!d) return '';
    var rows = [], ms = d.metrics || [];
    for (var i = 0; i < ms.length && i < 3; i++) {
      rows.push({
        label: ms[i].label, value: ms[i].value + (ms[i].unit ? ' ' + ms[i].unit : ''),
        cls: ms[i].level === 'bad' ? 'is-bad' : ''
      });
    }
    if (d.badges && d.badges[0]) rows.unshift({ label: '状态', value: d.badges[0].text, cls: d.badges[0].kind === 'badge--bad' ? 'is-bad' : (d.badges[0].kind === 'badge--ok' ? 'is-good' : '') });
    return tooltipHTML({ title: d.title, rows: rows });
  };

  var TOAST_ICO = {
    ok: '<path d="M5 12.5l4.2 4.2L19 7"/>',
    warn: '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5M12 17.2h.01"/>',
    err: '<circle cx="12" cy="12" r="8.5"/><path d="M9 9l6 6M15 9l-6 6"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8h.01"/>'
  };

  /** kind: 'ok' | 'warn' | 'err' | 'info'。不依赖 init，可在启动阶段直接调用 */
  UI.toast = function (msg, kind, ms) {
    var host = $('toast-host');
    if (!host) return null;
    if (!TOAST_ICO[kind]) kind = 'info';
    while (host.children.length >= 4) host.removeChild(host.firstChild);
    var el = document.createElement('div');
    el.className = 'toast toast--' + kind;
    el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    el.innerHTML = '<span class="toast-ico"><svg class="i" viewBox="0 0 24 24" aria-hidden="true">' + TOAST_ICO[kind] + '</svg></span>' +
      '<span class="toast-msg">' + esc(msg) + '</span>' +
      '<button class="toast-close" type="button" aria-label="关闭"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>';
    host.appendChild(el);
    var gone = false;
    function close() { if (gone) return; gone = true; if (el.parentNode) el.parentNode.removeChild(el); }
    el.querySelector('.toast-close').addEventListener('click', close, false);
    setTimeout(close, ms || (kind === 'err' ? 9000 : (kind === 'warn' ? 6000 : 3800)));
    return el;
  };

  /** 启动进度：pct 0..100，text 文案，step 当前步骤序号（对应 .loading-steps 的 li） */
  UI.setLoading = function (pct, text, step) {
    var el = $('loading-screen');
    if (!el) return;
    el.classList.add('has-progress');
    if (pct != null) el.style.setProperty('--load', U.clamp(pct, 0, 100) + '%');
    var t = el.querySelector('.loading-text');
    if (t && text != null) t.textContent = text;
    if (step != null) {
      var lis = el.querySelectorAll('.loading-steps > li');
      for (var i = 0; i < lis.length; i++) {
        U.setClass(lis[i], 'is-done', i < step);
        U.setClass(lis[i], 'is-active', i === step);
      }
    }
  };

  UI.hideLoading = function () {
    var el = $('loading-screen');
    if (!el || el.getAttribute('data-done')) return;
    el.setAttribute('data-done', '1');
    el.classList.add('has-progress');
    el.style.setProperty('--load', '100%');
    var lis = el.querySelectorAll('.loading-steps > li');
    for (var i = 0; i < lis.length; i++) { lis[i].classList.add('is-done'); lis[i].classList.remove('is-active'); }
    el.classList.add('is-done');
    el.style.pointerEvents = 'none';
    el.setAttribute('aria-hidden', 'true');
    /* 淡出动画结束后彻底移出渲染树，避免任何情况下挡住交互 */
    setTimeout(function () { el.classList.add('is-hidden'); }, 700);
  };

  /* ================================================================== *
   * 9. 汇总渲染与增量刷新
   * ================================================================== */

  function mirror() {
    if (!api) return;
    var s = api.state;
    state.minute = s.minute; state.dayType = s.dayType; state.regionId = s.regionId;
    state.viewMode = s.viewMode; state.moduleId = s.moduleId; state.selected = s.selected;
    for (var k in s.layers) if (Object.prototype.hasOwnProperty.call(s.layers, k)) state.layers[k] = s.layers[k];
  }

  function safe(name, fn) {
    try { fn(); } catch (e) {
      if (window.console) console.error('[UI] ' + name + ' 渲染失败', e);
    }
  }

  UI.renderAll = function () {
    if (!api) return;
    mirror();
    safe('ticker', UI.renderTicker);
    safe('layers', UI.renderLayers);
    safe('regions', UI.renderRegions);
    safe('views', UI.renderViews);
    safe('kpi', UI.renderKpiCards);
    safe('ranking', UI.renderRanking);
    safe('modules', UI.renderModules);
    safe('moduleBody', UI.renderModuleBody);
    safe('legend', UI.renderLegend);
    safe('timeline', UI.renderTimeline);
    safe('sideCharts', renderSideCharts);
    safe('badge', renderStageBadge);
    UI.setPlaying(state.playing);
    UI.setSpeed(state.speed);
    UI.setClock(new Date());
  };

  /** 时间变化后的"重刷新"：数值类面板 + 图表。被节流，不在每个 minute 上都跑 */
  function heavyRefresh() {
    if (!api) return;
    safe('ticker', UI.renderTicker);
    safe('layers', patchLayers);
    safe('kpi', UI.renderKpiCards);
    safe('ranking', UI.renderRanking);
    safe('metrics', function () { UI.renderModuleBody({ metricsOnly: true }); });
    safe('legend', UI.renderLegend);
    safe('badge', renderStageBadge);
    /* 图表层若自己订阅了 TP.Api 事件（selfDriven），这里就不重复驱动 */
    if (chartsUsable()) {
      if (!ctx.charts.selfDriven) {
        chart('trend', api.state.metric || 'congestionIndex');
        chart('forecast', api.state.metric || 'congestionIndex');
        if (api.state.moduleId === 'signal') chart('signalDiagram', api.state.signalGroupId);
        else chart('moduleChart', api.state.moduleId);
      }
    } else {
      safe('sideCharts', renderSideCharts);
      if (api.state.moduleId === 'signal') safe('signal', drawSignalFallback);
    }
    if (refreshDrawer) refreshDrawer();
  }
  var heavyThrottled = heavyRefresh;

  /* ================================================================== *
   * 10. 行为：供事件处理器与外部调用
   * ================================================================== */

  UI.toggleLayer = function (id, on) {
    if (!api) return;
    if (on == null) on = !api.state.layers[id];
    on = !!on;
    api.setLayer(id, on);                       // → 'layer' 事件 → onLayer()
    if (ctx.layers && typeof ctx.layers.setVisible === 'function') call(ctx.layers, 'setVisible', id, on);
    else if (id === 'district') call(ctx.builder, 'setDistrictsVisible', on);   // 图层模块未到位时的最小兜底
  };

  UI.selectRegion = function (id) {
    if (!api) return;
    api.setRegion(id);
    id = api.state.regionId;
    call(ctx.layers, 'setRegionFilter', id === 'all' ? null : api.regionFilter());
    call(ctx.builder, 'setRegionHighlight', id);
    if (id !== 'all') {
      var b = call(ctx.builder, 'focusBounds', id);
      if (b && b.center) call(ctx.rig, 'focusOn', b.center.x, b.center.z, { radius: b.radius });
    } else {
      call(ctx.rig, 'reset');
    }
  };

  UI.selectView = function (mode) {
    if (!api) return;
    var ok = false, vs = api.viewsMeta();
    for (var i = 0; i < vs.length; i++) if (vs[i].id === mode) ok = true;
    if (!ok) return;
    api.setViewMode(mode);                      // → 'view' 事件 → onView()
    call(ctx.rig, 'setMode', mode);
  };

  UI.selectModule = function (id) { if (api) api.setModule(id); };

  UI.togglePlay = function () { UI.setPlaying(!state.playing); };

  UI.toggleFullscreen = function () {
    var d = document, el = d.documentElement;
    var cur = d.fullscreenElement || d.webkitFullscreenElement;
    try {
      if (cur) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
      else {
        var req = el.requestFullscreen || el.webkitRequestFullscreen;
        if (!req) { UI.toast('当前浏览器不支持全屏', 'warn'); return; }
        var p = req.call(el);
        if (p && p.catch) p.catch(function () { UI.toast('全屏请求被浏览器拒绝', 'warn'); });
      }
    } catch (e) { UI.toast('全屏切换失败', 'warn'); }
  };

  /** 重新读取设计令牌并让 3D / 图表 / UI 全部跟随 */
  UI.applyTheme = function () {
    if (!api) return;
    safe('legend', UI.renderLegend);
    safe('timeline', UI.renderTimeline);
    safe('kpi', UI.renderKpiCards);
    safe('sideCharts', function () { if (!chartsUsable()) renderSideCharts(); });
    safe('signal', function () { if (!chartsUsable() && api.state.moduleId === 'signal') drawSignalFallback(); });
    if (state.drawerOpen && detailCtx) drawDrawerCharts(detailCtx.detail);
  };

  function onThemeClick() {
    call(TP.Theme, 'refresh');
    if (api) api.refresh();                    // 门面里缓存了取色结果，需失效一次
    call(ctx.scene, 'applyTheme');
    call(ctx.builder, 'applyTheme');
    call(ctx.layers, 'applyTheme');
    chart('applyTheme');
    UI.applyTheme();
    UI.toast('已重新读取设计令牌并刷新三维场景与图表配色（当前仅提供浅色政务主题）', 'info');
  }

  /* ================================================================== *
   * 11. 事件绑定
   * ================================================================== */

  function isTyping(t) {
    if (!t || !t.tagName) return false;
    var tag = t.tagName.toLowerCase();
    if (tag === 'textarea' || tag === 'select' || t.isContentEditable) return true;
    return tag === 'input' && t.type !== 'range' && t.type !== 'button' && t.type !== 'checkbox';
  }

  function bind() {
    /* —— 图层 —— */
    U.delegate(dom.layers, 'click', '.layer-item', function (ev, el) {
      ev.preventDefault();
      if (U.hasClass(el, 'is-disabled')) return;
      UI.toggleLayer(el.getAttribute('data-layer'));
    });
    U.delegate(dom.layers, 'keydown', '.layer-item', function (ev, el) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); UI.toggleLayer(el.getAttribute('data-layer')); }
    });

    /* —— 行政区 —— */
    U.delegate(dom.regions, 'click', '.region-item', function (ev, el) {
      UI.selectRegion(el.getAttribute('data-region'));
    });

    /* —— 视角 —— */
    U.delegate(dom.views, 'click', '.view-btn', function (ev, el) {
      UI.selectView(el.getAttribute('data-view'));
      if (el.blur) el.blur();                  // 避免空格键再次触发按钮
    });

    /* —— 模块标签 —— */
    U.delegate(dom.tabs, 'click', '.tab', function (ev, el) {
      UI.selectModule(el.getAttribute('data-module'));
    });

    /* —— 走廊排行 → 走廊详情 —— */
    function openRank(el) {
      if (!api) return;
      var hit = { kind: 'corridor', id: el.getAttribute('data-id') };
      var d = api.pickInfo(hit);
      if (d) UI.showDetail(d, hit);
    }
    U.delegate(dom.rank, 'click', '.rank-item', function (ev, el) { openRank(el); });
    U.delegate(dom.rank, 'keydown', '.rank-item', function (ev, el) { if (ev.key === 'Enter') openRank(el); });

    /* —— 播放 / 倍速 —— */
    U.on(dom.play, 'click', function () { UI.togglePlay(); if (dom.play.blur) dom.play.blur(); });
    U.delegate(dom.speed, 'click', 'button[data-speed]', function (ev, el) {
      UI.setSpeed(el.getAttribute('data-speed'));
      if (el.blur) el.blur();
    });

    /* —— 时间轴滑块：input 事件里只做轻量同步 + 写门面，重刷新由节流器接管 —— */
    if (dom.slider) {
      U.on(dom.slider, 'input', function () {
        var v = +dom.slider.value;
        dom.slider.style.setProperty('--_fill', (v / 1439 * 100) + '%');
        state.minute = v;
        syncTimeline(v, true);
        if (api) api.setMinute(v);
      });
      var scrubOn = function () { state.scrubbing = true; };
      var scrubOff = function () { state.scrubbing = false; };
      U.on(dom.slider, 'pointerdown', scrubOn);
      U.on(dom.slider, 'touchstart', scrubOn, { passive: true });
      U.on(window, 'pointerup', scrubOff);
      U.on(window, 'pointercancel', scrubOff);
      U.on(window, 'touchend', scrubOff);
      U.on(window, 'blur', scrubOff);
      U.on(dom.slider, 'change', scrubOff);
    }

    /* —— 热力条：点击某格跳到该时刻（hover 提示走原生 title = band.label）—— */
    U.delegate(dom.track, 'click', '.tl-cell', function (ev, el) {
      var m = +el.getAttribute('data-minute');
      if (isFinite(m)) UI.setMinute(m);
    });

    /* —— 顶栏按钮 / 抽屉 —— */
    U.on(dom.fullscreen, 'click', UI.toggleFullscreen);
    U.on(dom.theme, 'click', onThemeClick);
    U.on(dom.drawerClose, 'click', UI.closeDrawer);

    function onFs() {
      var on = !!(document.fullscreenElement || document.webkitFullscreenElement);
      U.setClass(dom.fullscreen, 'is-active', on);
      if (dom.fullscreen) dom.fullscreen.title = on ? '退出全屏' : '全屏';
      U.nextFrame(function () { call(ctx.scene, 'resize'); chart('resize'); onResizeDebounced(); });
    }
    U.on(document, 'fullscreenchange', onFs);
    U.on(document, 'webkitfullscreenchange', onFs);

    /* —— 键盘：1/2/3/4 切视角、空格播放暂停、Esc 关抽屉 —— */
    U.on(document, 'keydown', function (ev) {
      if (ev.ctrlKey || ev.metaKey || ev.altKey || isTyping(ev.target)) return;
      var k = ev.key;
      if (k === '1' || k === '2' || k === '3' || k === '4') {
        var vs = api ? api.viewsMeta() : [];
        for (var i = 0; i < vs.length; i++) if (vs[i].key === k) { UI.selectView(vs[i].id); ev.preventDefault(); return; }
      } else if (k === ' ' || k === 'Spacebar') {
        var t = ev.target, tag = t && t.tagName ? t.tagName.toLowerCase() : '';
        if (tag === 'button' || tag === 'a') return;        // 交给按钮自身的原生激活
        ev.preventDefault();
        UI.togglePlay();
      } else if (k === 'Escape' || k === 'Esc') {
        if (state.drawerOpen) UI.closeDrawer();
      }
    });

    /* —— 窗口尺寸变化：SVG 兜底图与抽屉曲线按新宽度重画（ECharts 自己有监听）—— */
    U.on(window, 'resize', onResizeDebounced);
  }

  var onResizeDebounced = function () {};

  /* —— TP.Api 事件订阅（增量刷新，不轮询）—— */
  function subscribe() {
    api.on('time', function (p) {
      UI.setMinute(p.minute, { silent: true, fromSlider: state.scrubbing });
      heavyThrottled();
    });
    api.on('layer', function (p) {
      state.layers[p.id] = !!p.on;
      var el = dom.layers && dom.layers.querySelector('.layer-item[data-layer="' + p.id + '"]');
      if (el) setLayerNode(el, !!p.on);
      safe('legend', UI.renderLegend);
    });
    api.on('region', function (p) {
      state.regionId = p.regionId;
      safe('regions', UI.renderRegions);
      heavyRefresh();
      safe('moduleBody', UI.renderModuleBody);
    });
    api.on('view', function (p) {
      state.viewMode = p.viewMode;
      safe('views', UI.renderViews);
    });
    api.on('module', function (p) {
      state.moduleId = p.moduleId;
      safe('modules', UI.renderModules);
      safe('moduleBody', UI.renderModuleBody);
      safe('legend', UI.renderLegend);
    });
    api.on('signalgroup', function () { safe('moduleBody', UI.renderModuleBody); });
    api.on('daytype', function (p) {
      state.dayType = p.dayType;
      UI.renderAll();
    });
    api.on('select', function (sel) { state.selected = sel || null; markRankSelected(); });

    /* 视角被 3D 层自行切换（如双击复位、巡航结束）时回写门面，保持按钮同步 */
    call(ctx.rig, 'onModeChange', function (mode) {
      if (api.state.viewMode !== mode) api.setViewMode(mode);
    });
  }

  /* ================================================================== *
   * 12. 初始化
   * ================================================================== */

  /**
   * ctx = { city, sim, api, scene, builder, rig, layers, charts, chartsOk, chartsError }
   * 除 api 外全部可缺省；缺什么就降级什么。
   */
  UI.init = function (c) {
    c = c || {};
    ctx = {
      city: c.city || TP.City, sim: c.sim || TP.Sim, api: c.api || TP.Api,
      scene: c.scene || TP.Scene || null, builder: c.builder || TP.CityBuilder || null,
      rig: c.rig || TP.CameraRig || null, layers: c.layers || TP.Layers || null,
      charts: c.charts || TP.Charts || null
    };
    api = ctx.api;
    if (!api) throw new Error('TP.UI.init: 缺少数据接口门面 TP.Api');

    /* 图表层可用性：app.js 会把 init 的成败传进来；未传则按 ready 标志判断 */
    if (c.chartsOk != null) state.chartsOk = !!c.chartsOk;
    else state.chartsOk = !!(ctx.charts && (ctx.charts.ready === true || (typeof ctx.charts.ready === 'function' && ctx.charts.ready())));
    state.chartsError = c.chartsError || null;

    dom = {
      stage: $('stage'), ticker: $('kpi-ticker'), clock: $('sys-clock'), date: $('sys-date'), weather: $('weather-chip'),
      theme: $('btn-theme'), fullscreen: $('btn-fullscreen'),
      layers: $('layer-list'), regions: $('region-list'), views: $('view-modes'),
      kpi: $('kpi-cards'), chartTrend: $('chart-trend'), chartForecast: $('chart-forecast'), rank: $('corridor-rank'),
      tabs: $('module-tabs'), metrics: $('module-metrics'), bottomChart: $('bottom-chart'), signal: $('signal-diagram'),
      play: $('btn-play'), speed: $('speed-group'), tlLabel: $('timeline-label'), slider: $('timeline-slider'), track: $('timeline-track'),
      legend: $('map-legend'), tooltip: $('tooltip'),
      drawer: $('detail-drawer'), drawerTitle: $('drawer-title'), drawerBody: $('drawer-body'), drawerClose: $('drawer-close'),
      badgeB: document.querySelector('.stage-badge > b'), badgeEm: document.querySelector('.stage-badge > em')
    };

    /* 视角图标：数据门面不带图标，从 index.html 的占位按钮里抄一份再覆盖 */
    if (dom.views) {
      var vb = dom.views.querySelectorAll('.view-btn[data-view]');
      for (var i = 0; i < vb.length; i++) {
        var ic = vb[i].querySelector('.view-icon');
        if (ic && !viewIcons[vb[i].getAttribute('data-view')]) viewIcons[vb[i].getAttribute('data-view')] = ic.innerHTML;
      }
    }
    /* 图表层不可用时清掉"加载中…"占位，换成明确的降级说明 */
    if (!state.chartsOk) {
      var tip = '图表组件未就绪 · 已切换为简化曲线';
      if (dom.chartTrend) dom.chartTrend.setAttribute('data-empty', tip);
      if (dom.chartForecast) dom.chartForecast.setAttribute('data-empty', tip);
    }
    if (dom.drawer) dom.drawer.setAttribute('aria-hidden', 'true');

    mirror();
    if (!UI.ready) {
      heavyThrottled = U.throttle(heavyRefresh, HEAVY_MS);
      refreshDrawer = U.throttle(refreshDrawerNow, DRAWER_MS);
      onResizeDebounced = U.debounce(function () {
        if (!chartsUsable()) { safe('sideCharts', renderSideCharts); if (api.state.moduleId === 'signal') safe('signal', drawSignalFallback); }
        if (state.drawerOpen && detailCtx) drawDrawerCharts(detailCtx.detail);
      }, 180);
      bind();
      subscribe();
    }
    UI.setPlaying(false);
    UI.setSpeed(state.speed);
    UI.ready = true;
    return UI;
  };

  /** 供 app.js / 调试使用 */
  UI.refresh = function () { heavyRefresh(); };
  UI.chartsUsable = chartsUsable;
  UI._svgLine = svgLine;

})(window, document);
