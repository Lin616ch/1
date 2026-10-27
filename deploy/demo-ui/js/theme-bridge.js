/* ============================================================================
 * theme-bridge.js —— 设计令牌桥
 * 命名空间：TP.Theme
 * 职责：把 UI 层（CSS）在 :root 定义的设计令牌读进 JS，
 *       供 Three.js 材质与 ECharts 图表取色。UI 改色 → 3D 与图表自动跟随。
 * 特性：每一档令牌都有内置兜底值，即使 CSS 漏定义也不会渲染成黑色。
 * 依赖：TP.Util（可选）。加载顺序：utils.js 之后，其余模块之前。
 * ==========================================================================*/
(function (window, document) {
  'use strict';

  var TP = window.TP = window.TP || {};
  var U = TP.Util;

  /* 全部令牌的兜底值（浅色政务风）——键名必须与 docs/UI-CONTRACT.md §2 完全一致 */
  var DEFAULTS = {
    /* --- 基础色 --- */
    '--c-bg':            '#eef2f7',
    '--c-bg-sub':        '#f5f8fb',
    '--c-panel':         '#ffffff',
    '--c-panel-head':    '#f7fafd',
    '--c-border':        '#dbe4ee',
    '--c-border-strong': '#c3d2e3',
    '--c-text':          '#1b2733',
    '--c-text-sub':      '#4a5b6d',
    '--c-text-dim':      '#8496a8',
    '--c-primary':       '#1a5fb4',
    '--c-primary-weak':  '#e8f1fb',
    '--c-primary-deep':  '#0f4685',
    '--c-accent':        '#0e9aa7',
    '--c-success':       '#2b8a3e',
    '--c-warn':          '#e8a33d',
    '--c-danger':        '#d64545',
    '--c-info':          '#3b82c4',
    '--c-shadow':        'rgba(23,43,77,0.10)',

    /* --- 交通语义色 --- */
    '--road-free':   '#2fb344',
    '--road-slow':   '#f2c037',
    '--road-jam':    '#f08a24',
    '--road-block':  '#e03131',
    '--road-nodata': '#b9c4d0',

    /* --- 3D 舞台 --- */
    '--stage-sky-top':    '#d8e8f8',
    '--stage-sky-bottom': '#f4f8fc',
    '--stage-fog':        '#f2f7fc',
    '--stage-ground':     '#f1f5f9',
    '--stage-grid':       '#e3eaf2',
    '--stage-grid-major': '#ccd9e6',
    '--bld-top':          '#ffffff',
    '--bld-side':         '#e7edf5',
    '--bld-side-dark':    '#d2dce9',
    '--bld-hi':           '#b9d3ee',
    '--road-casing':      '#cbd7e4',
    '--transit-metro':    '#1a5fb4',
    '--transit-bus':      '#2b8a3e',
    '--od-flow':          '#4c8fd6',
    '--heat-low':         '#7fc8f8',
    '--heat-mid':         '#ffd166',
    '--heat-high':        '#e03131',

    /* --- 图表色板 --- */
    '--chart-1': '#1a5fb4',
    '--chart-2': '#0e9aa7',
    '--chart-3': '#e8a33d',
    '--chart-4': '#d64545',
    '--chart-5': '#2b8a3e',
    '--chart-6': '#6f5bd6',
    '--chart-7': '#e06c9f',
    '--chart-8': '#5c7a99',

    /* --- 地铁线路色 --- */
    '--metro-1': '#c0392b',
    '--metro-2': '#1a5fb4',
    '--metro-3': '#2b8a3e',
    '--metro-4': '#e8a33d',
    '--metro-5': '#6f5bd6',

    /* --- 尺度与动效（供 JS 读取，用于动画时长对齐）--- */
    '--dur-fast': '160ms',
    '--dur-base': '220ms',
    '--dur-slow': '360ms'
  };

  /* 有序色板（ECharts 按序取用） */
  var ORDER_CHART = ['--chart-1', '--chart-2', '--chart-3', '--chart-4',
                     '--chart-5', '--chart-6', '--chart-7', '--chart-8'];
  var ORDER_METRO = ['--metro-1', '--metro-2', '--metro-3', '--metro-4', '--metro-5'];
  var ORDER_ROAD  = ['--road-free', '--road-slow', '--road-jam', '--road-block', '--road-nodata'];

  var cache = null;
  var listeners = [];

  var Theme = TP.Theme = {};

  Theme.DEFAULTS = DEFAULTS;
  Theme.ORDER_CHART = ORDER_CHART;
  Theme.ORDER_METRO = ORDER_METRO;
  Theme.ORDER_ROAD = ORDER_ROAD;
  Theme.LOADED = false;

  /** 从 :root 重新读取全部令牌。UI 换肤后调用一次即可全局生效。 */
  Theme.refresh = function () {
    cache = {};
    var cs = null;
    try {
      cs = window.getComputedStyle(document.documentElement);
    } catch (e) { cs = null; }

    for (var k in DEFAULTS) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS, k)) continue;
      var v = '';
      if (cs) {
        try { v = cs.getPropertyValue(k); } catch (e2) { v = ''; }
      }
      v = (v == null) ? '' : String(v).trim();
      cache[k] = v || DEFAULTS[k];
    }
    Theme.LOADED = true;

    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](cache); } catch (e3) { /* 单个监听器出错不影响其他 */ }
    }
    return cache;
  };

  Theme._ensure = function () { if (!cache) Theme.refresh(); return cache; };

  /** 原始 CSS 值，可能是 'rgb()' / '#hex' / '12px' */
  Theme.v = function (name, fallback) {
    Theme._ensure();
    var v = cache[name];
    if (v == null || v === '') {
      v = (DEFAULTS[name] != null) ? DEFAULTS[name] : fallback;
    }
    return v == null ? '' : v;
  };

  Theme.css = Theme.v;

  /** 数值型令牌（如 '220ms' → 220） */
  Theme.num = function (name, fallback) {
    var n = parseFloat(Theme.v(name));
    return isFinite(n) ? n : (fallback == null ? 0 : fallback);
  };

  /** 归一化为 '#rrggbb'（ECharts / THREE 都能吃） */
  Theme.hex = function (name, fallback) {
    var raw = Theme.v(name);
    if (!raw) return fallback || '#000000';
    if (raw.charAt(0) === '#') {
      if (raw.length === 4) {
        return '#' + raw[1] + raw[1] + raw[2] + raw[2] + raw[3] + raw[3];
      }
      if (raw.length === 7) return raw.toLowerCase();
      if (raw.length === 9) return raw.slice(0, 7).toLowerCase();
    }
    var c = U ? U.parseColor(raw) : null;
    if (!c) return fallback || '#000000';
    var h = function (n) {
      var s = Math.round(Math.max(0, Math.min(255, n))).toString(16);
      return s.length === 1 ? '0' + s : s;
    };
    return '#' + h(c.r) + h(c.g) + h(c.b);
  };

  /** → 'rgb(r,g,b)' */
  Theme.rgb = function (name, fallback) {
    var c = U ? U.parseColor(Theme.v(name)) : null;
    if (!c) return fallback || 'rgb(0,0,0)';
    return 'rgb(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ')';
  };

  /** → 'rgba(r,g,b,a)' */
  Theme.rgba = function (name, alpha) {
    var c = U ? U.parseColor(Theme.v(name)) : null;
    if (!c) return 'rgba(0,0,0,' + (alpha == null ? 1 : alpha) + ')';
    return 'rgba(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ',' +
      (alpha == null ? (c.a == null ? 1 : c.a) : alpha) + ')';
  };

  /** → 0xrrggbb 整数，给 THREE 用（THREE 未加载时也能安全调用） */
  Theme.hexInt = function (name, fallback) {
    var h = Theme.hex(name, fallback);
    var n = parseInt(h.slice(1), 16);
    return isFinite(n) ? n : 0x000000;
  };

  /** 创建一个 THREE.Color（THREE 缺失时返回 hex 字符串） */
  Theme.threeColor = function (name, fallback) {
    var h = Theme.hex(name, fallback);
    if (window.THREE && window.THREE.Color) return new window.THREE.Color(h);
    return h;
  };

  /** 图表色板数组 */
  Theme.chartColors = function () {
    return ORDER_CHART.map(function (k) { return Theme.hex(k); });
  };

  /** 地铁线路色板数组（按序号取，超出后循环） */
  Theme.metroColors = function () {
    return ORDER_METRO.map(function (k) { return Theme.hex(k); });
  };

  /** 路况等级色：level 0..3 */
  Theme.roadColor = function (level) {
    var keys = ['--road-free', '--road-slow', '--road-jam', '--road-block'];
    return Theme.hex(keys[level] || '--road-nodata');
  };

  /** 热力色带（低→高），返回 hex 数组，可直接给 U.ramp */
  Theme.heatRamp = function () {
    return [Theme.hex('--heat-low'), Theme.hex('--heat-mid'), Theme.hex('--heat-high')];
  };

  /** 订阅令牌刷新 */
  Theme.onChange = function (fn) {
    if (typeof fn === 'function') listeners.push(fn);
    return fn;
  };

  /* 页面加载完成后再读一次，确保外部样式表已生效 */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { Theme.refresh(); }, false);
  } else {
    Theme.refresh();
  }
  window.addEventListener('load', function () { Theme.refresh(); }, false);

})(window, document);
