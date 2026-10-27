/* ============================================================================
 * charts.js —— 全部 ECharts 图表（浅色政务风）
 * 命名空间：TP.Charts
 * 依赖：echarts 5.4.3（UMD 全局）、TP.Util、TP.Theme、TP.Api
 *       —— 只依赖 TP.Api 与 TP.Theme，绝不读 TP.Sim、绝不调 TP.UI。
 *
 * 结构：
 *   1. 取色 / 样式工具（全部颜色来自 TP.Theme，无硬编码色值）
 *   2. option 构造器 buildXxxOption(data, ctx) —— 纯函数，不碰 DOM / echarts，
 *      可在 Node 里直接测试（挂在 TP.Charts._builders 上，仅供测试与调试）
 *   3. 实例管理：延迟 init（容器 0 尺寸时挂起）、ResizeObserver + window resize
 *   4. 公开 API：init / applyTheme / trend / forecast / moduleChart /
 *      signalDiagram / sparkline / setAnimation / resize / dispose
 *   5. 事件驱动增量刷新：订阅 TP.Api 事件，同一帧内合并（rAF），不轮询
 *
 * 性能要点：时间轴拖动/播放时 'time' 事件高频到达（间隔 < 300ms），
 *   此时自动关闭动画并使用 lazyUpdate；停止 300ms 后恢复 400ms cubicOut 动画。
 * ==========================================================================*/
(function (window) {
  'use strict';

  var TP = window.TP = window.TP || {};
  var U = TP.Util;

  /* ================================================================== *
   * 1. 取色与样式工具
   * ================================================================== */

  function TH() { return TP.Theme; }
  function hex(name) { return TH().hex(name); }
  function rgba(name, a) { return TH().rgba(name, a); }
  function roadColor(level) { return TH().roadColor(level); }

  var ANIM_MS = 400;
  var EASING = 'cubicOut';
  var FS = 11;                       // 坐标轴字号
  var BAR_W = 12;                    // 条宽（≤14px）
  var RADIUS_V = [3, 3, 0, 0];       // 竖向柱：顶端圆角
  var RADIUS_H = [0, 3, 3, 0];       // 横向条：右端圆角（与竖柱"顶端圆角"同义）

  /* 拥堵指数分段阈值（与 TP.Api.timelineBands 一致） */
  var CI_STOPS = [2.5, 5.0, 7.2];

  function grid(extra) {
    var g = { left: 8, right: 12, top: 24, bottom: 6, containLabel: true };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) g[k] = extra[k];
    return g;
  }

  function areaGradient(name, top) {
    return {
      type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
      colorStops: [
        { offset: 0, color: rgba(name, top == null ? 0.18 : top) },
        { offset: 1, color: rgba(name, 0) }
      ]
    };
  }

  function tooltip(extra) {
    var t = {
      trigger: 'axis',
      confine: true,
      backgroundColor: hex('--c-panel'),
      borderColor: hex('--c-border'),
      borderWidth: 1,
      padding: [6, 10],
      textStyle: { color: hex('--c-text'), fontSize: 12 },
      extraCssText: 'border-radius:4px;box-shadow:0 4px 14px ' + TH().v('--c-shadow') + ';',
      axisPointer: {
        type: 'line',
        lineStyle: { color: hex('--c-border-strong'), width: 1, type: 'dashed' },
        crossStyle: { color: hex('--c-border-strong'), width: 1, type: 'dashed' },
        label: { backgroundColor: hex('--c-text-sub'), color: hex('--c-panel'), fontSize: 10 }
      }
    };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) t[k] = extra[k];
    return t;
  }

  function axisBase(extra) {
    var a = {
      axisLine: { show: true, lineStyle: { color: hex('--c-border'), width: 1 } },
      axisTick: { show: true, lineStyle: { color: hex('--c-border') }, length: 3 },
      axisLabel: { color: hex('--c-text-dim'), fontSize: FS, margin: 6 },
      splitLine: { show: false },
      nameTextStyle: { color: hex('--c-text-dim'), fontSize: FS, padding: [0, 0, 0, 0] }
    };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) a[k] = extra[k];
    return a;
  }

  /** 数值轴：不画轴线，极轻虚线网格 */
  function valueAxis(extra) {
    var a = axisBase({
      type: 'value',
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { show: true, lineStyle: { color: hex('--c-border'), width: 1, type: 'dashed' } },
      splitNumber: 3
    });
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) a[k] = extra[k];
    return a;
  }

  function legendStyle(extra) {
    var l = {
      top: 0, right: 12, itemWidth: 10, itemHeight: 6, itemGap: 12,
      icon: 'roundRect',
      textStyle: { color: hex('--c-text-sub'), fontSize: FS },
      inactiveColor: hex('--c-border-strong')
    };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) l[k] = extra[k];
    return l;
  }

  function subTitle(text, left, extra) {
    var t = {
      text: text, left: left == null ? 8 : left, top: 2,
      textStyle: { color: hex('--c-text-sub'), fontSize: 12, fontWeight: 500 }
    };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) t[k] = extra[k];
    return t;
  }

  /** 每个 option 的公共骨架：动画参数 + 色板 + 全局字体色 */
  function base(ctx) {
    var anim = !ctx || ctx.anim !== false;
    return {
      animation: anim,
      animationDuration: anim ? ANIM_MS : 0,
      animationEasing: EASING,
      animationDurationUpdate: anim ? ANIM_MS : 0,
      animationEasingUpdate: EASING,
      color: TH().chartColors(),
      backgroundColor: rgba('--c-panel', 0),
      textStyle: { color: hex('--c-text-sub'), fontSize: FS }
    };
  }

  function nowMarkLine(label, ctx) {
    return {
      silent: true,
      symbol: ['none', 'none'],
      animation: false,
      lineStyle: { color: hex('--c-primary'), width: 1, type: 'dashed', opacity: 0.8 },
      label: {
        show: true, position: 'insideEndTop', formatter: (ctx && ctx.nowText) || label,
        color: hex('--c-primary'), fontSize: 10, padding: [0, 0, 2, 0]
      },
      data: [{ xAxis: label }]
    };
  }

  function ciPieces() {
    return [
      { lt: CI_STOPS[0], color: roadColor(0), label: '畅通' },
      { gte: CI_STOPS[0], lt: CI_STOPS[1], color: roadColor(1), label: '缓行' },
      { gte: CI_STOPS[1], lt: CI_STOPS[2], color: roadColor(2), label: '拥堵' },
      { gte: CI_STOPS[2], color: roadColor(3), label: '严重拥堵' }
    ];
  }

  function hhmm(m) { return U.hhmm(((Math.round(m) % 1440) + 1440) % 1440); }
  function nearestIdx(xs, minute) {
    if (!xs || !xs.length) return 0;
    var step = xs.length > 1 ? (xs[1] - xs[0]) : 5;
    return U.clamp(Math.floor((minute - xs[0]) / step), 0, xs.length - 1);
  }
  function round(v, d) { var p = Math.pow(10, d || 0); return Math.round(v * p) / p; }
  function emptyOption(text, ctx) {
    var o = base(ctx);
    o.title = { text: text || '暂无数据', left: 'center', top: 'middle',
      textStyle: { color: hex('--c-text-dim'), fontSize: 12, fontWeight: 400 } };
    o.series = [];
    return o;
  }

  /* ================================================================== *
   * 2. option 构造器（纯函数）
   * ================================================================== */

  /**
   * #chart-trend：24h 全日序列，**288 点（5 分钟粒度）**，与 TP.Api.series 原生粒度一致，
   * 不做降采样；横轴每 4 小时一个标签、每小时一个刻度；当前时刻虚线标记。
   * 拥堵指数按 2.5/5/7.2 分段着色（visualMap piecewise）。
   * @param se  TP.Api.series(metric) → { x[288], y[288], label, unit }
   * @param ctx { minute, anim, metric }
   */
  function buildTrendOption(se, ctx) {
    ctx = ctx || {};
    if (!se || !se.y || !se.y.length) return emptyOption('暂无趋势数据', ctx);
    var metric = ctx.metric || se.metric || 'congestionIndex';
    var isCI = metric === 'congestionIndex';
    var labels = se.x.map(hhmm);
    var nowLabel = labels[nearestIdx(se.x, ctx.minute || 0)];
    var o = base(ctx);
    o.grid = grid();
    o.tooltip = tooltip({ valueFormatter: function (v) { return (v == null ? '-' : v) + (se.unit ? ' ' + se.unit : ''); } });
    o.xAxis = axisBase({
      type: 'category', boundaryGap: false, data: labels,
      axisTick: { show: true, interval: 11, lineStyle: { color: hex('--c-border') }, length: 3 },
      axisLabel: { color: hex('--c-text-dim'), fontSize: FS, interval: 47, margin: 6 }
    });
    o.yAxis = valueAxis(isCI ? { min: 0, max: 10, interval: 2.5 } : { scale: false });
    var s = {
      type: 'line', name: se.label || metric, data: se.y.slice(),
      smooth: true, showSymbol: false, symbol: 'circle', symbolSize: 5,
      lineStyle: { width: 2 },
      itemStyle: { color: hex('--c-primary') },
      areaStyle: { color: areaGradient('--c-primary') },
      markLine: nowMarkLine(nowLabel, ctx)
    };
    if (!isCI) s.lineStyle.color = hex('--c-primary');
    o.series = [s];
    if (isCI) {
      o.visualMap = { show: false, type: 'piecewise', seriesIndex: 0, dimension: 1, pieces: ciPieces() };
    }
    return o;
  }

  /**
   * #chart-forecast：近 60 分钟实测（实线）+ 未来 60 分钟预测（虚线）+ 置信带（堆叠面积）。
   * 横轴 25 点：now-60 … now-5（12 个历史）+ now … now+60（13 个预测）。
   * @param fc   TP.Api.forecast(metric, 60)
   * @param se   TP.Api.series(metric)（取历史）
   */
  function buildForecastOption(fc, se, ctx) {
    ctx = ctx || {};
    if (!fc || !fc.points || !fc.points.length) return emptyOption('暂无预测数据', ctx);
    var pts = fc.points;
    var now = pts[0].minute;
    var HIST = 12;
    var labels = [], hist = [], fv = [], lo = [], band = [];
    var i;
    for (i = HIST; i >= 1; i--) {
      var m = now - i * 5;
      labels.push(hhmm(m));
      var v = '-';
      if (se && se.y && se.y.length) {
        var idx = ((Math.floor(((m % 1440) + 1440) % 1440 / 5)) % se.y.length);
        v = se.y[idx];
      }
      hist.push(v); fv.push('-'); lo.push('-'); band.push('-');
    }
    for (i = 0; i < pts.length; i++) {
      labels.push(pts[i].hhmm || hhmm(pts[i].minute));
      hist.push(i === 0 ? pts[0].v : '-');
      fv.push(pts[i].v);
      lo.push(pts[i].lo);
      band.push(round(pts[i].hi - pts[i].lo, 3));
    }
    var unit = fc.unit ? ' ' + fc.unit : '';
    var o = base(ctx);
    o.grid = grid();
    o.legend = legendStyle({ data: ['实测', '预测', '置信区间'] });
    o.tooltip = tooltip({
      formatter: function (ps) {
        if (!ps || !ps.length) return '';
        var k = ps[0].dataIndex;
        var out = ps[0].axisValue;
        if (hist[k] !== '-') out += '<br/>实测：' + hist[k] + unit;
        if (fv[k] !== '-') {
          out += '<br/>预测：' + fv[k] + unit;
          out += '<br/>区间：' + lo[k] + ' ~ ' + round(lo[k] + band[k], 2) + unit;
        }
        return out;
      }
    });
    o.xAxis = axisBase({
      type: 'category', boundaryGap: false, data: labels,
      axisTick: { show: true, interval: 5, lineStyle: { color: hex('--c-border') }, length: 3 },
      axisLabel: { color: hex('--c-text-dim'), fontSize: FS, interval: 5, margin: 6 }
    });
    o.yAxis = valueAxis({ scale: true });
    o.series = [
      { type: 'line', name: '置信下界', data: lo, stack: 'ci', smooth: true, symbol: 'none',
        lineStyle: { width: 0, opacity: 0 }, itemStyle: { color: hex('--c-accent') },
        tooltip: { show: false }, silent: true, legendHoverLink: false },
      { type: 'line', name: '置信区间', data: band, stack: 'ci', smooth: true, symbol: 'none',
        lineStyle: { width: 0, opacity: 0 }, itemStyle: { color: rgba('--c-accent', 0.25) },
        areaStyle: { color: rgba('--c-accent', 0.16) }, silent: true },
      { type: 'line', name: '实测', data: hist, smooth: true, showSymbol: false, symbol: 'circle',
        lineStyle: { width: 2, color: hex('--c-primary') }, itemStyle: { color: hex('--c-primary') },
        areaStyle: { color: areaGradient('--c-primary') },
        markLine: nowMarkLine(labels[HIST], { nowText: '现在' }) },
      { type: 'line', name: '预测', data: fv, smooth: true, showSymbol: false, symbol: 'circle',
        lineStyle: { width: 2, type: 'dashed', color: hex('--c-accent') }, itemStyle: { color: hex('--c-accent') } }
    ];
    return o;
  }

  /** traffic：24h 拥堵指数（分段着色 + 面积）+ 平均速度（右轴折线），288 点、24 个整点刻度 */
  function buildDualAxisOption(chart, ctx) {
    ctx = ctx || {};
    var s = chart && chart.series;
    if (!s || !s.congestion || !s.congestion.length) return emptyOption('暂无路况数据', ctx);
    var labels = s.xLabel && s.xLabel.length === s.x.length ? s.xLabel.slice() : s.x.map(hhmm);
    var nowLabel = labels[nearestIdx(s.x, ctx.minute || 0)];
    var o = base(ctx);
    o.grid = grid();
    o.legend = legendStyle({ data: ['拥堵指数', '平均速度'] });
    o.tooltip = tooltip({
      formatter: function (ps) {
        if (!ps || !ps.length) return '';
        var out = ps[0].axisValue;
        for (var i = 0; i < ps.length; i++) {
          out += '<br/>' + ps[i].marker + ps[i].seriesName + '：' + ps[i].value +
            (ps[i].seriesName === '平均速度' ? ' km/h' : '');
        }
        return out;
      }
    });
    o.xAxis = axisBase({
      type: 'category', boundaryGap: false, data: labels,
      axisTick: { show: true, interval: 11, lineStyle: { color: hex('--c-border') }, length: 3 },
      axisLabel: { color: hex('--c-text-dim'), fontSize: FS, interval: 23, margin: 6 }
    });
    o.yAxis = [
      valueAxis({ name: chart.yLabelLeft || '拥堵指数', min: 0, max: 10, interval: 2.5,
        nameGap: 8, nameTextStyle: { color: hex('--c-text-dim'), fontSize: FS, align: 'left' } }),
      valueAxis({ name: chart.yLabelRight || 'km/h', min: 0, position: 'right', splitLine: { show: false },
        nameGap: 8, nameTextStyle: { color: hex('--c-text-dim'), fontSize: FS, align: 'right' } })
    ];
    o.visualMap = { show: false, type: 'piecewise', seriesIndex: 0, dimension: 1, pieces: ciPieces() };
    o.series = [
      { type: 'line', name: '拥堵指数', yAxisIndex: 0, data: s.congestion.slice(),
        smooth: true, showSymbol: false, symbol: 'circle', lineStyle: { width: 2 },
        itemStyle: { color: roadColor(2) },
        areaStyle: { color: areaGradient('--c-primary') },
        markLine: nowMarkLine(nowLabel, ctx) },
      { type: 'line', name: '平均速度', yAxisIndex: 1, data: s.speed.slice(),
        smooth: true, showSymbol: false, symbol: 'circle',
        lineStyle: { width: 1.6, color: hex('--chart-2') }, itemStyle: { color: hex('--chart-2') } }
    ];
    return o;
  }

  function shortName(n) { return String(n || '').replace(/(片区|城区|新区|园区|新城)$/, '').slice(0, 3); }

  /**
   * od：双图（ECharts 多 grid）。左 grid[0] = 6×6 热力矩阵（行=起点、列=终点），
   * 右 grid[1] = TOP 流向横向条形。两个子标题用 title 数组。
   */
  function buildOdOption(chart, ctx) {
    ctx = ctx || {};
    var mx = chart && chart.matrix;
    if (!mx || !mx.values || !mx.values.length) return emptyOption('暂无 OD 数据', ctx);
    var names = mx.names || mx.ids;
    var cells = [], max = 0;
    for (var r = 0; r < mx.values.length; r++) {
      for (var c = 0; c < mx.values[r].length; c++) {
        var v = mx.values[r][c];
        if (r === c || !v) { cells.push([c, r, '-']); continue; }
        var w = round(v / 10000, 1);
        if (w > max) max = w;
        cells.push([c, r, w]);
      }
    }
    var top = (chart.top || []).slice(0, 8);
    var topNames = top.map(function (t) { return shortName(t.from) + '→' + shortName(t.to); });
    var topVals = top.map(function (t) { return round(t.volume / 10000, 1); });

    var o = base(ctx);
    o.title = [subTitle('OD 矩阵（万辆/日）', 8), subTitle('主要流向 TOP' + top.length, '58%')];
    o.grid = [
      grid({ left: 8, right: '46%', top: 26 }),
      grid({ left: '58%', right: 40, top: 26 })
    ];
    o.tooltip = tooltip({ trigger: 'item' });
    o.xAxis = [
      axisBase({ type: 'category', gridIndex: 0, data: names, position: 'top',
        axisLine: { show: false }, axisTick: { show: false }, splitArea: { show: false } }),
      valueAxis({ gridIndex: 1, show: false })
    ];
    o.yAxis = [
      axisBase({ type: 'category', gridIndex: 0, data: names, inverse: true,
        axisLine: { show: false }, axisTick: { show: false } }),
      axisBase({ type: 'category', gridIndex: 1, data: topNames, inverse: true,
        axisLine: { show: false }, axisTick: { show: false } })
    ];
    o.visualMap = {
      show: false, type: 'continuous', seriesIndex: 0, dimension: 2,
      min: 0, max: max || 1, inRange: { color: TH().heatRamp() }
    };
    o.series = [
      { type: 'heatmap', name: 'OD 矩阵', xAxisIndex: 0, yAxisIndex: 0, data: cells,
        label: { show: true, fontSize: 10, color: hex('--c-text') },
        itemStyle: { borderColor: hex('--c-panel'), borderWidth: 2, borderRadius: 2 },
        emphasis: { itemStyle: { borderColor: hex('--c-primary'), borderWidth: 1 } },
        tooltip: { formatter: function (p) {
          var d = p.data || p.value;
          return names[d[1]] + ' → ' + names[d[0]] + '<br/>' + p.marker + d[2] + ' 万辆/日';
        } } },
      { type: 'bar', name: '流向规模', xAxisIndex: 1, yAxisIndex: 1, data: topVals,
        barWidth: 10, barMaxWidth: 14,
        itemStyle: { color: hex('--od-flow'), borderRadius: RADIUS_H },
        label: { show: true, position: 'right', fontSize: 10, color: hex('--c-text-sub'),
          formatter: '{c}万' },
        tooltip: { formatter: function (p) { return p.name + '<br/>' + p.marker + p.value + ' 万辆/日'; } } }
    ];
    return o;
  }

  /** transit：TOP10 横向条形，地铁/公交两个系列同 stack 实现"按 kind 分色 + 图例" */
  function buildBarRankOption(chart, ctx) {
    ctx = ctx || {};
    var items = (chart && chart.items) || [];
    if (!items.length) return emptyOption('暂无线路客流', ctx);
    var names = [], metro = [], bus = [];
    for (var i = 0; i < items.length; i++) {
      names.push(items[i].name);
      var isMetro = items[i].kind === 'metro';
      metro.push(isMetro ? items[i].value : '-');
      bus.push(isMetro ? '-' : items[i].value);
    }
    var lbl = { show: true, position: 'right', fontSize: 10, color: hex('--c-text-sub') };
    var o = base(ctx);
    o.grid = grid({ right: 36 });
    o.legend = legendStyle({ data: ['地铁', '公交'] });
    o.tooltip = tooltip({ trigger: 'item', formatter: function (p) {
      return p.name + '<br/>' + p.marker + p.seriesName + '客流：' + p.value + ' 万人次/h';
    } });
    o.xAxis = valueAxis({ splitNumber: 3 });
    o.yAxis = axisBase({ type: 'category', data: names, inverse: true, axisTick: { show: false } });
    o.series = [
      { type: 'bar', name: '地铁', stack: 'rank', data: metro, barWidth: BAR_W, barMaxWidth: 14,
        itemStyle: { color: hex('--transit-metro'), borderRadius: RADIUS_H }, label: lbl },
      { type: 'bar', name: '公交', stack: 'rank', data: bus, barWidth: BAR_W, barMaxWidth: 14,
        itemStyle: { color: hex('--transit-bus'), borderRadius: RADIUS_H }, label: lbl }
    ];
    return o;
  }

  var PHASE_KEYS = ['--road-free', '--road-slow', '--road-block'];   // 绿 / 黄 / 红
  var PHASE_CN = ['绿灯', '黄灯', '红灯'];
  var AMBER_SEC = 3;

  /**
   * 绿波带时距图几何（纯数据）。横轴 km、纵轴 s。
   * 每个路口：以 offsetSec 为绿灯起点、cycle 为周期，绿 greenSec → 黄 3s → 红其余。
   * 推荐车速线从首路口绿灯起点出发，斜率 = 3.6 / v（s/m）；带宽 = gw.bandwidth 秒。
   */
  function greenWaveGeometry(gw) {
    var stops = (gw.stops || []).slice().sort(function (a, b) {
      return a.distanceFromStart - b.distanceFromStart;
    });
    var v = Math.max(5, gw.recommendedSpeed || 40);
    var km = function (s) { return s.distanceKm != null ? s.distanceKm : s.distanceFromStart / 1000; };
    var d0 = km(stops[0]), dN = km(stops[stops.length - 1]);
    var c0 = Math.max(30, stops[0].cycle || 120);
    var t0 = ((stops[0].offsetSec || 0) % c0 + c0) % c0;
    var travel = (dN - d0) * 1000 / (v / 3.6);
    var bw = Math.max(0, gw.bandwidth || 0);
    var maxCycle = 0;
    stops.forEach(function (s) { maxCycle = Math.max(maxCycle, s.cycle || 0); });
    var T = Math.ceil((t0 + travel + bw + 20) / 60) * 60;
    var bars = [];
    stops.forEach(function (s) {
      var C = Math.max(30, s.cycle || 120);
      var g = U.clamp(s.greenSec || C * (s.greenRatio || 0.3), 1, C - AMBER_SEC);
      var off = ((s.offsetSec || 0) % C + C) % C;
      var x = km(s);
      for (var k = -1; off + k * C < T; k++) {
        var gs = off + k * C;
        var segs = [[gs, gs + g, 0], [gs + g, gs + g + AMBER_SEC, 1], [gs + g + AMBER_SEC, gs + C, 2]];
        for (var j = 0; j < 3; j++) {
          var a = Math.max(0, segs[j][0]), b = Math.min(T, segs[j][1]);
          if (b > a) bars.push({ value: [x, round(a, 1), round(b, 1), segs[j][2]], name: s.name });
        }
      }
    });
    return {
      stops: stops, d0: d0, dN: dN, t0: t0, tN: t0 + travel, T: T, bw: bw, v: v,
      bars: bars, cycleMax: maxCycle
    };
  }

  /** signal：绿波带时距图（custom 相位条 + custom 带宽多边形 + 推荐车速 line） */
  function buildGreenWaveOption(gw, ctx) {
    ctx = ctx || {};
    if (!gw || !gw.stops || gw.stops.length < 2) return emptyOption('暂无绿波带数据', ctx);
    var G = greenWaveGeometry(gw);
    var phaseColors = PHASE_KEYS.map(hex);
    var bandFill = rgba('--road-free', 0.16);
    var bandStroke = rgba('--road-free', 0.55);
    var xmin = Math.floor((G.d0 - 0.15) * 10) / 10, xmax = Math.ceil((G.dN + 0.15) * 10) / 10;
    var eff = gw.efficiency != null ? (gw.efficiency <= 1 ? gw.efficiency * 100 : gw.efficiency) : null;
    var o = base(ctx);
    o.grid = grid({ top: 28 });
    o.title = subTitle(gw.corridorName || '绿波带', 8);
    o.graphic = [{
      type: 'text', right: 12, top: 4, silent: true,
      style: {
        text: '带宽 ' + round(G.bw, 0) + 's · 效率 ' + (eff == null ? '-' : round(eff, 1) + '%') +
              ' · 推荐 ' + G.v + ' km/h',
        fill: hex('--c-primary'), fontSize: 11, fontWeight: 600
      }
    }];
    o.tooltip = tooltip({ trigger: 'item' });
    o.xAxis = axisBase({ type: 'value', min: xmin, max: xmax, splitNumber: 6,
      name: 'km', nameGap: 4, axisLabel: { color: hex('--c-text-dim'), fontSize: FS, margin: 6 } });
    o.yAxis = valueAxis({ min: 0, max: G.T, interval: G.T > 600 ? 120 : 60, name: '时间(s)', nameGap: 6,
      nameTextStyle: { color: hex('--c-text-dim'), fontSize: FS, align: 'left' } });
    o.series = [
      /* 绿波带（推荐车速下可连续通过的时间窗） */
      { type: 'custom', name: '绿波带', silent: true, z: 1,
        data: [[G.d0, G.t0, G.dN, G.tN]],
        renderItem: function (params, api) {
          var p1 = api.coord([api.value(0), api.value(1)]);
          var p2 = api.coord([api.value(2), api.value(3)]);
          var p3 = api.coord([api.value(2), api.value(3) + G.bw]);
          var p4 = api.coord([api.value(0), api.value(1) + G.bw]);
          return { type: 'polygon', shape: { points: [p1, p2, p3, p4] },
            style: { fill: bandFill, stroke: bandStroke, lineWidth: 1 } };
        },
        encode: { x: [0, 2], y: [1, 3] } },
      /* 各路口相位条 */
      { type: 'custom', name: '相位', z: 3,
        data: G.bars,
        renderItem: function (params, api) {
          var x = api.value(0);
          var s = api.coord([x, api.value(1)]);
          var e = api.coord([x, api.value(2)]);
          var w = 6;
          return { type: 'rect',
            shape: { x: s[0] - w / 2, y: e[1], width: w, height: Math.max(1, s[1] - e[1]) },
            style: { fill: phaseColors[api.value(3)] || phaseColors[2] } };
        },
        encode: { x: 0, y: [1, 2] },
        tooltip: { formatter: function (p) {
          var d = p.value;
          return p.name + '<br/>' + p.marker + PHASE_CN[d[3]] + '：' + d[1] + 's ~ ' + d[2] + 's' +
                 '<br/>距起点 ' + d[0] + ' km';
        } } },
      /* 推荐车速斜线 */
      { type: 'line', name: '推荐车速', z: 4, data: [[G.d0, round(G.t0, 1)], [G.dN, round(G.tN, 1)]],
        symbol: 'circle', symbolSize: 5, smooth: true,
        lineStyle: { width: 2, color: hex('--c-primary') }, itemStyle: { color: hex('--c-primary') },
        label: { show: false },
        endLabel: { show: true, formatter: G.v + ' km/h', color: hex('--c-primary'), fontSize: 10 },
        tooltip: { formatter: function () {
          return '推荐车速 ' + G.v + ' km/h<br/>全程 ' + round(G.dN - G.d0, 2) + ' km · ' +
                 round(G.tN - G.t0, 0) + ' s';
        } } }
    ];
    return o;
  }

  /** park：各区停车占用率（占用 + 空余 堆叠到 100%）+ 单车可用率折线 */
  function buildStackedBarOption(chart, ctx) {
    ctx = ctx || {};
    var cats = (chart && chart.categories) || [];
    if (!cats.length) return emptyOption('暂无停车数据', ctx);
    var occ = chart.parking.map(function (v) { return round(U.clamp(v || 0, 0, 100), 1); });
    var used = occ.map(function (v) {
      return v >= 100 ? { value: v, itemStyle: { borderRadius: RADIUS_V } } : v;
    });
    var free = occ.map(function (v) { return round(100 - v, 1); });
    var o = base(ctx);
    o.grid = grid();
    o.legend = legendStyle({ data: ['停车占用率', '空余泊位', '单车可用率'] });
    o.tooltip = tooltip({ valueFormatter: function (v) { return (v == null ? '-' : v) + ' %'; } });
    o.xAxis = axisBase({ type: 'category', data: cats, axisTick: { show: false } });
    o.yAxis = valueAxis({ min: 0, max: 100, interval: 25,
      axisLabel: { color: hex('--c-text-dim'), fontSize: FS, formatter: '{value}%' } });
    o.series = [
      { type: 'bar', name: '停车占用率', stack: 'park', data: used, barWidth: BAR_W, barMaxWidth: 14,
        itemStyle: { color: hex('--c-primary') } },
      { type: 'bar', name: '空余泊位', stack: 'park', data: free, barWidth: BAR_W, barMaxWidth: 14,
        itemStyle: { color: hex('--c-primary-weak'), borderRadius: RADIUS_V } },
      { type: 'line', name: '单车可用率', data: (chart.bike || []).slice(), smooth: true,
        symbol: 'circle', symbolSize: 5,
        lineStyle: { width: 2, color: hex('--road-free') }, itemStyle: { color: hex('--road-free') },
        areaStyle: { color: areaGradient('--road-free') } }
    ];
    return o;
  }

  /** carbon：左侧环形图 + 中心减排量（title 居中叠放），右侧竖排图例（名称 / 占比 / 吨） */
  function buildPieOption(chart, ctx) {
    ctx = ctx || {};
    var items = (chart && chart.items) || [];
    if (!items.length) return emptyOption('暂无碳排放数据', ctx);
    var palette = TH().chartColors();
    var info = {};
    var data = items.map(function (it, i) {
      info[it.name] = it;
      return { name: it.name, value: round(it.value, 1),
        itemStyle: { color: palette[i % palette.length] } };
    });
    var CX = '24%';
    var o = base(ctx);
    o.title = {
      text: String(chart.centerValue != null ? chart.centerValue : ''),
      subtext: (chart.centerLabel || '绿色减排') + (chart.centerUnit ? '（' + chart.centerUnit + '）' : ''),
      left: CX, top: '34%', textAlign: 'center', itemGap: 2,
      textStyle: { color: hex('--c-success'), fontSize: 20, fontWeight: 700 },
      subtextStyle: { color: hex('--c-text-dim'), fontSize: 11 }
    };
    o.tooltip = tooltip({ trigger: 'item', formatter: function (p) {
      var it = info[p.name] || {};
      return p.marker + p.name + '<br/>' + p.value + ' 吨 · ' + (it.ratio != null ? it.ratio : p.percent) + '%';
    } });
    o.legend = legendStyle({
      orient: 'vertical', top: 'middle', right: null, left: '50%', itemGap: 6, icon: 'circle',
      itemWidth: 8, itemHeight: 8,
      formatter: function (name) {
        var it = info[name] || {};
        return '{n|' + name + '}{r|' + (it.ratio != null ? it.ratio : '-') + '%}{v|' +
               (it.value != null ? round(it.value, 0) : '-') + ' 吨}';
      },
      textStyle: {
        color: hex('--c-text-sub'), fontSize: FS,
        rich: {
          n: { width: 72, color: hex('--c-text-sub'), fontSize: FS },
          r: { width: 44, align: 'right', color: hex('--c-text'), fontSize: FS, fontWeight: 600 },
          v: { width: 64, align: 'right', color: hex('--c-text-dim'), fontSize: FS }
        }
      }
    });
    o.series = [{
      type: 'pie', name: '碳排放构成', radius: ['54%', '78%'], center: [CX, '54%'],
      avoidLabelOverlap: true, startAngle: 90,
      label: { show: false }, labelLine: { show: false },
      itemStyle: { borderColor: hex('--c-panel'), borderWidth: 2, borderRadius: 3 },
      emphasis: { scale: true, scaleSize: 4, label: { show: false } },
      data: data
    }];
    return o;
  }

  /** 迷你走势图几何（纯函数）：返回 polyline points、闭合面积 path、末点坐标 */
  function buildSparkGeometry(data, w, h, opts) {
    opts = opts || {};
    var arr = (data || []).filter(function (v) { return v != null && isFinite(v); }).map(Number);
    if (arr.length < 2) return null;
    var pad = opts.pad == null ? 3 : opts.pad;
    var min = opts.min != null ? opts.min : Math.min.apply(null, arr);
    var max = opts.max != null ? opts.max : Math.max.apply(null, arr);
    if (max - min < 1e-9) { max = min + 1; min = min - 1; }
    var pts = [];
    for (var i = 0; i < arr.length; i++) {
      var x = i / (arr.length - 1) * w;
      var y = pad + (1 - (arr[i] - min) / (max - min)) * (h - pad * 2);
      pts.push([round(x, 2), round(y, 2)]);
    }
    var line = pts.map(function (p) { return p[0] + ',' + p[1]; }).join(' ');
    var area = 'M0,' + h + ' L' + pts.map(function (p) { return p[0] + ',' + p[1]; }).join(' L') +
               ' L' + w + ',' + h + ' Z';
    return { points: line, area: area, last: pts[pts.length - 1], count: pts.length, min: min, max: max };
  }

  var BUILDERS = {
    traffic: buildDualAxisOption,
    dualAxis: buildDualAxisOption,
    odMatrix: buildOdOption,
    barRank: buildBarRankOption,
    greenWave: function (chart, ctx) { return buildGreenWaveOption(chart && chart.greenWave, ctx); },
    stackedBar: buildStackedBarOption,
    pie: buildPieOption
  };

  /** 按 chart.type 分派 */
  function buildModuleOption(chart, ctx) {
    if (!chart || !BUILDERS[chart.type]) return emptyOption('暂无图表数据', ctx);
    return BUILDERS[chart.type](chart, ctx);
  }

  /* ================================================================== *
   * 3. 实例管理
   * ================================================================== */

  var SLOTS = { trend: '#chart-trend', forecast: '#chart-forecast', module: '#bottom-chart', signal: '#signal-diagram' };
  var inst = {};         // key → echarts instance
  var pending = {};      // key → 容器 0 尺寸时挂起的 option
  var lastSig = {};      // key → 上次渲染的状态签名（事件去重）
  var ro = null;
  var unsubs = [];
  var animEnabled = true;     // setAnimation 显式开关
  var lastTimeEvt = 0;        // 上一次 'time' 事件时间戳
  var fastUntil = 0;          // 在此时间点前视为"拖动/播放中"
  var FAST_GAP = 300;

  var view = { metric: 'congestionIndex', fcMetric: 'congestionIndex', moduleId: null, groupId: null };

  function now() { return (window.performance && window.performance.now) ? window.performance.now() : Date.now(); }
  function isFast() { return now() < fastUntil; }
  function ctxNow(extra) {
    var c = { anim: animEnabled && !isFast(), minute: apiOk() ? TP.Api.state.minute : 0 };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) c[k] = extra[k];
    return c;
  }
  function apiOk() { return !!(TP.Api && TP.Api.isReady); }
  function hasEcharts() { return typeof window.echarts !== 'undefined' && window.echarts && window.echarts.init; }
  function elOf(key) { return U.$(SLOTS[key]); }
  function sized(el) { return !!el && el.clientWidth > 0 && el.clientHeight > 0; }

  function stateSig(extra) {
    var s = TP.Api.state;
    return [s.minute, s.dayType, s.regionId, s.metric, s.signalGroupId, TP.Theme && TP.Theme.LOADED, extra || ''].join('|');
  }

  /** 设置 option；容器无尺寸时挂起，待 ResizeObserver 回调再 init */
  function paint(key, option) {
    var el = elOf(key);
    if (!el || !option || !hasEcharts()) return false;
    var c = inst[key];
    if (c && c.isDisposed && c.isDisposed()) { c = inst[key] = null; }
    if (!c) {
      if (!sized(el)) { pending[key] = option; return false; }
      c = inst[key] = window.echarts.init(el, null, { renderer: 'canvas' });
    }
    pending[key] = null;
    try {
      c.setOption(option, { notMerge: true, lazyUpdate: isFast() });
    } catch (e) {
      if (window.console) window.console.error('[Charts] setOption failed on ' + key, e);
      return false;
    }
    return true;
  }

  function flushPending() {
    for (var k in SLOTS) {
      if (!Object.prototype.hasOwnProperty.call(SLOTS, k)) continue;
      var el = elOf(k);
      if (pending[k] && sized(el)) paint(k, pending[k]);
    }
  }

  var resizeQueued = false;
  function resize() {
    if (resizeQueued) return;
    resizeQueued = true;
    U.nextFrame(function () {
      resizeQueued = false;
      flushPending();
      for (var k in inst) {
        if (!Object.prototype.hasOwnProperty.call(inst, k) || !inst[k]) continue;
        var el = elOf(k);
        if (!sized(el)) continue;                       // display:none / 0 尺寸跳过
        try { inst[k].resize({ animation: { duration: 0 } }); } catch (e) { /* noop */ }
      }
    });
  }

  /* ================================================================== *
   * 4. 公开渲染方法
   * ================================================================== */

  function trend(metric, _fromEvent) {
    if (metric) view.metric = metric;
    if (!apiOk()) return null;
    var sig = stateSig(view.metric);
    if (_fromEvent && lastSig.trend === sig) return null;
    var se = TP.Api.series(view.metric);
    var opt = buildTrendOption(se, ctxNow({ metric: view.metric }));
    lastSig.trend = sig;
    paint('trend', opt);
    return opt;
  }

  function forecast(metric, _fromEvent) {
    if (metric) view.fcMetric = metric;
    if (!apiOk()) return null;
    var sig = stateSig(view.fcMetric);
    if (_fromEvent && lastSig.forecast === sig) return null;
    var fc = TP.Api.forecast(view.fcMetric, 60);
    var se = TP.Api.series(view.fcMetric);
    var opt = buildForecastOption(fc, se, ctxNow({ metric: view.fcMetric }));
    lastSig.forecast = sig;
    paint('forecast', opt);
    return opt;
  }

  function moduleChart(moduleId, _fromEvent) {
    if (!apiOk()) { if (moduleId) view.moduleId = moduleId; return null; }
    var id = moduleId || view.moduleId || TP.Api.state.moduleId || 'traffic';
    view.moduleId = id;
    var sd = elOf('signal');
    if (id !== 'signal' && sd) U.addClass(sd, 'is-hidden');
    var sig = stateSig(id);
    if (_fromEvent && lastSig.module === sig) return null;
    var board = TP.Api.moduleBoard(id);
    var opt = buildModuleOption(board && board.chart, ctxNow());
    lastSig.module = sig;
    paint('module', opt);
    return opt;
  }

  function signalDiagram(groupId, _fromEvent) {
    if (groupId) view.groupId = groupId;
    if (!apiOk()) return null;
    var el = elOf('signal');
    if (el && !_fromEvent) {
      U.removeClass(el, 'is-hidden');
      U.nextFrame(resize);                      // 刚从 display:none 显示，下一帧补尺寸
    }
    var sig = stateSig('sd|' + (view.groupId || ''));
    if (_fromEvent && lastSig.signal === sig) return null;
    var gw = TP.Api.signalBoard(view.groupId || TP.Api.state.signalGroupId);
    var opt = buildGreenWaveOption(gw, ctxNow());
    lastSig.signal = sig;
    paint('signal', opt);
    return opt;
  }

  var SVGNS = 'http://www.w3.org/2000/svg';
  var sparkSeq = 0;

  /**
   * 迷你走势图：SVG（不用 ECharts 实例——4 张卡 × 时间轴高频刷新，SVG 零实例开销）。
   * @param el    .kpi-spark 元素或选择器
   * @param data  数值数组
   * @param color 颜色：'--token' 令牌名 / TP.Theme 取出的色值；缺省主色
   * @param opts  { area:true, dot:true, min, max, level:'ok'|'warn'|'bad' }
   */
  function sparkline(el, data, color, opts) {
    opts = opts || {};
    if (typeof el === 'string') el = U.$(el);
    if (!el || !window.document) return null;
    var W = 120, H = 34;
    var g = buildSparkGeometry(data, W, H, opts);
    var c;
    if (opts.level === 'bad') c = hex('--c-danger');
    else if (color && String(color).indexOf('--') === 0) c = hex(color);
    else c = color || hex('--c-primary');
    var cAlpha = function (a) {
      var p = U.parseColor(c);
      return p ? 'rgba(' + Math.round(p.r) + ',' + Math.round(p.g) + ',' + Math.round(p.b) + ',' + a + ')' : c;
    };
    while (el.firstChild) el.removeChild(el.firstChild);
    if (!g) return null;
    var id = 'tp-spark-g' + (++sparkSeq);
    var svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    if (opts.area !== false) {
      var defs = document.createElementNS(SVGNS, 'defs');
      var lg = document.createElementNS(SVGNS, 'linearGradient');
      lg.setAttribute('id', id); lg.setAttribute('x1', '0'); lg.setAttribute('y1', '0');
      lg.setAttribute('x2', '0'); lg.setAttribute('y2', '1');
      [[0, 0.18], [1, 0]].forEach(function (st) {
        var s = document.createElementNS(SVGNS, 'stop');
        s.setAttribute('offset', String(st[0]));
        s.setAttribute('stop-color', cAlpha(1));
        s.setAttribute('stop-opacity', String(st[1]));
        lg.appendChild(s);
      });
      defs.appendChild(lg); svg.appendChild(defs);
      var path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('d', g.area);
      path.setAttribute('fill', 'url(#' + id + ')');
      path.setAttribute('stroke', 'none');
      svg.appendChild(path);
    }
    var pl = document.createElementNS(SVGNS, 'polyline');
    pl.setAttribute('points', g.points);
    pl.style.stroke = c;
    svg.appendChild(pl);
    el.appendChild(svg);
    return g;
  }

  /** 显式开关动画（例如 UI 在 slider pointerdown 时 setAnimation(false)，pointerup 时 true） */
  function setAnimation(on) {
    animEnabled = !!on;
    for (var k in inst) {
      if (!Object.prototype.hasOwnProperty.call(inst, k) || !inst[k]) continue;
      try { inst[k].setOption({ animation: animEnabled }, { lazyUpdate: true }); } catch (e) { /* noop */ }
    }
    return animEnabled;
  }

  function renderAll() {
    if (!apiOk()) return;
    trend();
    forecast();
    moduleChart(view.moduleId || TP.Api.state.moduleId);
    var sd = elOf('signal');
    if (sd && !U.hasClass(sd, 'is-hidden')) signalDiagram(null, true);
  }

  function applyTheme() {
    lastSig = {};
    if (!apiOk()) return;
    var keepFast = fastUntil; fastUntil = 0;
    renderAll();
    fastUntil = keepFast;
  }

  /* ================================================================== *
   * 5. 事件驱动增量刷新（同一帧合并）
   * ================================================================== */

  var dirty = {};
  var flushQueued = false;
  function mark(keys) {
    for (var i = 0; i < keys.length; i++) dirty[keys[i]] = true;
    if (flushQueued) return;
    flushQueued = true;
    U.nextFrame(flush);
  }
  function flush() {
    flushQueued = false;
    var d = dirty; dirty = {};
    if (!Charts.ready || !apiOk()) return;
    if (d.all) { lastSig = {}; }
    if (d.trend || d.all) trend(null, true);
    if (d.forecast || d.all) forecast(null, true);
    if (d.module || d.all) moduleChart(TP.Api.state.moduleId, true);
    var sd = elOf('signal');
    if ((d.signal || d.module || d.all) && sd && !U.hasClass(sd, 'is-hidden')) signalDiagram(null, true);
  }

  function onTime() {
    var t = now();
    if (t - lastTimeEvt < FAST_GAP) fastUntil = t + FAST_GAP;   // 高频 → 拖动/播放中，关动画
    lastTimeEvt = t;
    mark(['trend', 'forecast', 'module', 'signal']);
  }

  function subscribe() {
    var A = TP.Api;
    if (!A || !A.on) return;
    unsubs.push(A.on('time', onTime));
    unsubs.push(A.on('live', function () { mark(['module', 'signal']); }));
    unsubs.push(A.on('daytype', function () { mark(['all']); }));
    unsubs.push(A.on('region', function () { mark(['all']); }));
    unsubs.push(A.on('module', function (p) {
      view.moduleId = (p && p.moduleId) || A.state.moduleId;
      lastSig.module = null;
      mark(['module']);
    }));
    unsubs.push(A.on('metric', function (p) {
      var m = (p && p.metric) || A.state.metric;
      view.metric = m; view.fcMetric = m;
      mark(['trend', 'forecast']);
    }));
    unsubs.push(A.on('signalgroup', function (p) {
      if (p && p.signalGroupId) view.groupId = p.signalGroupId;
      lastSig.module = null; lastSig.signal = null;
      mark(['module', 'signal']);
    }));
    unsubs.push(A.on('ready', function () { mark(['all']); }));
  }

  /* ================================================================== *
   * 6. 生命周期
   * ================================================================== */

  var onWinResize = function () { resize(); };
  var themeHooked = false;

  function init() {
    if (Charts.ready) return Charts;
    if (!hasEcharts()) {
      if (window.console) window.console.warn('[Charts] echarts 未加载，图表不可用');
      return Charts;
    }
    Charts.ready = true;
    window.addEventListener('resize', onWinResize, false);
    if (typeof window.ResizeObserver === 'function') {
      ro = new window.ResizeObserver(function () { resize(); });
      for (var k in SLOTS) {
        if (!Object.prototype.hasOwnProperty.call(SLOTS, k)) continue;
        var el = elOf(k);
        if (el) ro.observe(el);
      }
    }
    subscribe();
    if (!themeHooked && TP.Theme && TP.Theme.onChange) {
      themeHooked = true;
      TP.Theme.onChange(function () { if (Charts.ready) mark(['all']); });
    }
    if (TP.Api && TP.Api.state) view.metric = view.fcMetric = TP.Api.state.metric || 'congestionIndex';
    /* 延后一帧：等 grid 布局稳定、容器拿到尺寸后再首绘 */
    U.nextFrame(function () { if (Charts.ready) { renderAll(); resize(); } });
    return Charts;
  }

  function dispose() {
    Charts.ready = false;
    for (var i = 0; i < unsubs.length; i++) { try { unsubs[i](); } catch (e) { /* noop */ } }
    unsubs = [];
    window.removeEventListener('resize', onWinResize, false);
    if (ro) { try { ro.disconnect(); } catch (e2) { /* noop */ } ro = null; }
    for (var k in inst) {
      if (!Object.prototype.hasOwnProperty.call(inst, k) || !inst[k]) continue;
      try { inst[k].dispose(); } catch (e3) { /* noop */ }
    }
    inst = {}; pending = {}; lastSig = {}; dirty = {};
  }

  var Charts = TP.Charts = {
    ready: false,
    init: init,
    applyTheme: applyTheme,
    trend: function (metric) { return trend(metric || 'congestionIndex'); },
    forecast: function (metric) { return forecast(metric || 'congestionIndex'); },
    moduleChart: function (moduleId) { return moduleChart(moduleId); },
    signalDiagram: function (groupId) { return signalDiagram(groupId); },
    sparkline: sparkline,
    setAnimation: setAnimation,
    renderAll: renderAll,
    resize: resize,
    dispose: dispose,
    instances: function () { return inst; },
    /* 仅供测试与调试：纯 option 构造器（不依赖 DOM / echarts，Node 可直接调用） */
    _builders: {
      trend: buildTrendOption,
      forecast: buildForecastOption,
      dualAxis: buildDualAxisOption,
      odMatrix: buildOdOption,
      barRank: buildBarRankOption,
      greenWave: buildGreenWaveOption,
      greenWaveGeometry: greenWaveGeometry,
      stackedBar: buildStackedBarOption,
      pie: buildPieOption,
      module: buildModuleOption,
      sparkGeometry: buildSparkGeometry
    }
  };

})(window);
