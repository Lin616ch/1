/* ============================================================================
 * app.js —— TP.App：引导装配 + 主循环 + 全局事件接线
 * 命名空间：TP.App
 * 依赖：TP.Util（必需）；TP.Theme / TP.City / TP.Sim / TP.Api / TP.Scene /
 *       TP.CityBuilder / TP.CameraRig / TP.Layers / TP.Charts / TP.UI
 *       —— 除 TP.Util 外全部可缺失或抛错，逐项降级，绝不一起停摆
 *
 * 三条纪律：
 *   1) boot() 逐步 try/catch：任何一步抛错只降级它自己，"加载页一定被关掉"
 *      （0 延迟或降级提示停留后关闭 + 12s 看门狗兜底），失败项写入
 *      TP.App.stats.failedSteps 并弹 toast、打印完整堆栈
 *   2) 主循环 RAF 自驱，dt clamp ≤100ms；播放推进 ≥80ms 节流；fps 走 EMA
 *   3) 只补 TP.UI 没绑的交互（3D 拾取 / 悬停 / 新事件推送 / 时变图层重刷），
 *      不重复绑定 DOM 事件（UI 层已绑 #btn-play、#btn-theme、键盘 1/2/3/4、
 *      时间轴 slider 等，见 docs/APP-NOTES.md）
 * ==========================================================================*/
(function (window, document) {
  'use strict';

  var TP = window.TP = window.TP || {};
  var U = TP.Util;

  var App = TP.App = {};

  /* ================================================================== *
   * 0. 常量与内部状态
   * ================================================================== */

  var MAX_DT = 100;               /* 单帧 dt 上限（ms）：后台切回来不跳大步 */
  var PLAY_STEP = 80;             /* 播放推进节流间隔（ms） */
  var FPS_ALPHA = 0.08;           /* fps EMA 系数（约 12 帧收敛到 63%） */
  var WATCHDOG_MS = 12000;        /* 加载页看门狗：超时强制关闭 */
  var ERR_HOLD_MS = 1400;         /* 有降级项时，错误摘要先停留这么久 */
  var INC_TOAST_MS = 4000;        /* 新事件 toast 的最小间隔 */
  var ERR_LOG_MAX = 2;            /* 同一每帧步骤最多打印 2 次堆栈，之后只计数 */

  var booted = false, booting = false, wired = false, looping = false;
  var rafId = null, lastTs = 0, fpsEma = 0;
  var playAcc = 0, playFlag = false;
  var chartsState = { ok: false, error: null };
  var okSteps = {};
  var failed = [];
  var stepErrs = {};
  var seenIncidents = {};
  var lastIncToast = -1e9;
  var hoverCache = { key: '', minute: -1, html: '' };
  var watchdogId = 0;
  var resizeHandler = null;

  var stats = App.stats = {
    fps: 0, minute: 0, playing: false, speed: 1,
    frames: 0, dt: 0, bootMs: 0,
    degraded: false, failedSteps: failed, stepErrors: stepErrs,
    core: {}, charts: 'pending', scene: false
  };
  App.ready = false;

  /* ================================================================== *
   * 1. 基础设施：日志 / toast / 加载页
   * ================================================================== */

  function nowMs() { return (U && U.now) ? U.now() : Date.now(); }

  function el(id) { return document.getElementById(id); }

  /** 打印完整堆栈（消息 + stack，并把 Error 对象本身一并交给控制台） */
  function errLog(label, e) {
    if (!window.console || !window.console.error) return;
    var msg = (e && e.message) ? e.message : String(e);
    var stack = (e && e.stack) ? e.stack : '(无堆栈)';
    window.console.error('[App] ' + label + ' 失败：' + msg + '\n' + stack, e);
  }

  function toast(msg, kind) {
    kind = kind || 'err';
    try {
      if (TP.UI && typeof TP.UI.toast === 'function') { TP.UI.toast(msg, kind); return; }
    } catch (e) { /* 落到下面的 DOM 兜底 */ }
    var host = el('toast-host');
    if (!host) return;
    var d = document.createElement('div');
    d.className = 'toast toast--' + kind;
    d.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    d.textContent = msg;
    host.appendChild(d);
    window.setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 9000);
  }

  function setLoading(pct, text, step) {
    try {
      if (TP.UI && typeof TP.UI.setLoading === 'function') { TP.UI.setLoading(pct, text, step); return; }
    } catch (e) { /* DOM 兜底 */ }
    var scr = el('loading-screen');
    if (!scr) return;
    scr.classList.add('has-progress');
    if (pct != null && U) scr.style.setProperty('--load', U.clamp(pct, 0, 100) + '%');
    var t = scr.querySelector('.loading-text');
    if (t && text != null) t.textContent = text;
  }

  /** 把"方法名 + 消息"写进 #loading-screen 的 .loading-text */
  function setLoadingError(summary) {
    var scr = el('loading-screen');
    var t = scr ? scr.querySelector('.loading-text') : null;
    if (!t) return;
    t.textContent = summary;
    t.title = summary;
  }

  /** 关闭加载页：优先 TP.UI.hideLoading()，UI 缺失时用等价 DOM 兜底 */
  function finishLoading(delayMs) {
    function run() {
      try {
        if (TP.UI && typeof TP.UI.hideLoading === 'function') { TP.UI.hideLoading(); return; }
      } catch (e) { /* DOM 兜底 */ }
      var scr = el('loading-screen');
      if (!scr || scr.getAttribute('data-done')) return;
      scr.setAttribute('data-done', '1');
      scr.classList.add('has-progress', 'is-done');
      scr.style.setProperty('--load', '100%');
      scr.style.pointerEvents = 'none';
      scr.setAttribute('aria-hidden', 'true');
      window.setTimeout(function () { scr.classList.add('is-hidden'); }, 700);
    }
    if (delayMs > 0) window.setTimeout(run, delayMs);
    else run();
  }

  /** 看门狗：无论 boot 里发生什么，加载页都不会永久转圈 */
  function armWatchdog() {
    window.clearTimeout(watchdogId);
    watchdogId = window.setTimeout(function () {
      var scr = el('loading-screen');
      if (!scr || scr.getAttribute('data-done')) return;
      var summary = '启动超时（' + Math.round(WATCHDOG_MS / 1000) + 's 未完成初始化），已强制进入降级界面';
      errLog('TP.App.boot()', new Error(summary));
      setLoadingError(summary);
      toast(summary, 'err');
      finishLoading(0);
    }, WATCHDOG_MS);
  }

  /** 每帧 / 事件处理器用的安全调用：吞异常 + 计数，最多打印 ERR_LOG_MAX 次 */
  function guard(key, fn) {
    try { return fn(); }
    catch (e) {
      var n = (stepErrs[key] = (stepErrs[key] || 0) + 1);
      if (n <= ERR_LOG_MAX) errLog(key + '()', e);
      return undefined;
    }
  }

  /* ================================================================== *
   * 2. 播放态 / 速度（权威来源是 TP.UI.state，UI 缺失时才用本地标志）
   * ================================================================== */

  function uiState() { return (TP.UI && TP.UI.state) ? TP.UI.state : null; }

  function playingNow() {
    var s = uiState();
    if (s && typeof s.playing === 'boolean') return s.playing;
    return playFlag;
  }

  function speedNow() {
    var s = uiState();
    var v = s ? +s.speed : 0;
    if (v !== 1 && v !== 2 && v !== 4 && v !== 8) v = 1;
    return v;
  }

  /** 播放/暂停：同步 #btn-play 与内部标志（UI 层不拥有循环，由 app 推进时间） */
  App.pause = function () {
    playFlag = false;
    guard('TP.UI.setPlaying(false)', function () {
      if (TP.UI && typeof TP.UI.setPlaying === 'function') TP.UI.setPlaying(false);
    });
    stats.playing = false;
    return App;
  };

  App.resume = function () {
    playFlag = true;
    guard('TP.UI.setPlaying(true)', function () {
      if (TP.UI && typeof TP.UI.setPlaying === 'function') TP.UI.setPlaying(true);
    });
    stats.playing = true;
    return App;
  };

  /* ================================================================== *
   * 3. 主循环
   * ================================================================== */

  /**
   * 单帧逻辑（顺序不可变）：
   *   1) 播放推进  2) Layers.update  3) CameraRig.update
   *   4) Scene.update（必须在 rig 之后：阴影跟随 + 标签投影依赖最新相机矩阵）
   *   5) Scene.render  6) Util.Tween.update
   */
  function frameImpl(dtMs) {
    var raw = (dtMs == null ? 16.7 : +dtMs);
    if (!isFinite(raw) || raw <= 0) raw = 16.7;

    /* fps 用**未裁剪**的真实间隔统计；后台切回来的一次大跳不污染 EMA */
    if (raw < 500) {
      var inst = 1000 / raw;
      fpsEma = fpsEma > 0 ? (fpsEma + (inst - fpsEma) * FPS_ALPHA) : inst;
    }
    var dt = U.clamp(raw, 0, MAX_DT);

    stats.frames++;
    stats.dt = Math.round(dt * 100) / 100;
    stats.fps = Math.round(fpsEma * 10) / 10;

    /* 1) 播放态推进：≥80ms 一次，累积后交给门面（1 档 = 60s 走完 24h，内部按真实时间累积） */
    if (playingNow()) {
      playAcc += dt;
      if (playAcc >= PLAY_STEP) {
        var chunk = playAcc;
        playAcc = 0;
        guard('TP.Api.setMinuteAuto', function () { TP.Api.setMinuteAuto(chunk, speedNow()); });
      }
    } else if (playAcc) {
      playAcc = 0;
    }

    /* 2) 时变图层动画（粒子 / 事件环 / OD 光点 / 高亮呼吸） */
    if (TP.Layers && TP.Layers.ready) {
      guard('TP.Layers.update', function () { TP.Layers.update(dt); });
    }

    /* 3) 视角系统（内部已处理 Tween/惯性/巡航/不穿楼约束） */
    if (TP.CameraRig && typeof TP.CameraRig.update === 'function') {
      guard('TP.CameraRig.update', function () { TP.CameraRig.update(dt); });
    }

    /* 4)+5) 场景更新与渲染 —— 必须在 rig 之后 */
    if (TP.Scene && TP.Scene.ready) {
      guard('TP.Scene.update', function () { TP.Scene.update(dt); });
      guard('TP.Scene.render', function () { TP.Scene.render(); });
    }

    /* 6) 补间（CameraRig 过渡也靠它；rig 有自驱兜底，但正常由这里驱动） */
    guard('TP.Util.Tween.update', function () { U.Tween.update(dt); });

    var st = TP.Api && TP.Api.state;
    if (st) {
      stats.minute = st.minute;
      stats.playing = playingNow();
      stats.speed = speedNow();
    }
  }

  App.frame = function (dtMs) {
    try { frameImpl(dtMs); }
    catch (e) {
      var n = (stepErrs.frame = (stepErrs.frame || 0) + 1);
      if (n <= ERR_LOG_MAX) errLog('TP.App.frame()', e);
    }
    return App;
  };

  function startLoop() {
    if (looping) return;
    looping = true;
    lastTs = 0;
    var raf = window.requestAnimationFrame || function (fn) {
      return window.setTimeout(function () { fn(nowMs()); }, 16);
    };
    function tick(ts) {
      if (!looping) return;
      rafId = raf(tick);
      var t = (typeof ts === 'number') ? ts : nowMs();
      var dt = lastTs ? (t - lastTs) : 16.7;
      lastTs = t;
      App.frame(dt < 0 ? 0 : dt);
    }
    rafId = raf(tick);
  }

  function stopLoop() {
    looping = false;
    if (rafId != null && window.cancelAnimationFrame) window.cancelAnimationFrame(rafId);
    rafId = null;
    lastTs = 0;
    playAcc = 0;
  }

  App.start = startLoop;
  App.stop = stopLoop;

  /* ================================================================== *
   * 4. 全局接线（只补 UI 层没做的）
   * ================================================================== */

  function onPick(e) {
    var hit = e && e.hit;
    if (!hit) return;
    /* 详情一律经 TP.Api.pickInfo()，app 不自己拼业务对象 */
    var d = null;
    try { d = TP.Api.pickInfo(hit); }
    catch (err) { errLog('TP.Api.pickInfo()', err); return; }
    if (!d) return;
    guard('TP.UI.showDetail', function () { TP.UI.showDetail(d, hit); });
    guard('TP.UI.hideTooltip', function () { TP.UI.hideTooltip(); });
  }

  function onHover(e) {
    var hit = e && e.hit;
    if (!hit) {
      hoverCache.key = '';
      guard('TP.UI.hideTooltip', function () { TP.UI.hideTooltip(); });
      return;
    }
    var st = TP.Api && TP.Api.state;
    var minute = st ? st.minute : -1;
    var key = hit.kind + '|' + (hit.id == null ? '' : hit.id) + '|' + (hit.roadId || '');
    /* 同一实体同一时刻复用上一次的 tooltip HTML（hover 每 60ms 一次，避免重复取数） */
    if (key === hoverCache.key && minute === hoverCache.minute) {
      if (hoverCache.html && e.px >= 0) {
        guard('TP.UI.tooltip', function () { TP.UI.tooltip(hoverCache.html, e.px, e.py); });
      }
      return;
    }
    var d = null;
    try { d = TP.Api.pickInfo(hit); } catch (err) { d = null; }
    if (!d) {
      hoverCache = { key: '', minute: -1, html: '' };
      guard('TP.UI.hideTooltip', function () { TP.UI.hideTooltip(); });
      return;
    }
    var html = '';
    guard('TP.UI.tooltipFromDetail', function () { html = TP.UI.tooltipFromDetail(d) || ''; });
    hoverCache = { key: key, minute: minute, html: html };
    if (!html) { guard('TP.UI.hideTooltip', function () { TP.UI.hideTooltip(); }); return; }
    if (e.px >= 0) guard('TP.UI.tooltip', function () { TP.UI.tooltip(html, e.px, e.py); });
  }

  function incidentToast(inc, extra) {
    if (!inc) return;
    var kind = inc.severity >= 3 ? 'err' : (inc.severity >= 2 ? 'warn' : 'info');
    var hhmm = inc.sinceHHMM || (U ? U.hhmm(TP.Api.state.minute) : '');
    var tail = (extra && extra > 1) ? '（另有 ' + (extra - 1) + ' 起）' : '';
    toast('新事件 ' + hhmm + ' · ' + (inc.title || inc.typeName || '交通事件') + tail, kind);
  }

  /** 时间推进时跨过事件起点 → 发现新事件（TP.Api 目前没有 emit('incident')，这里做等价检测） */
  function detectIncidents() {
    if (!TP.Api || typeof TP.Api.incidents !== 'function') return;
    var list;
    try { list = TP.Api.incidents() || []; } catch (e) { return; }
    var cur = {}, fresh = [], i;
    for (i = 0; i < list.length; i++) {
      var it = list[i];
      if (!it || it.status === 'cleared') continue;
      cur[it.id] = 1;
      if (!seenIncidents[it.id]) fresh.push(it);
    }
    seenIncidents = cur;
    if (!fresh.length || !playingNow()) return;      /* 拖时间轴回看历史不刷屏 */
    var t = nowMs();
    if (t - lastIncToast < INC_TOAST_MS) return;
    lastIncToast = t;
    incidentToast(fresh[0], fresh.length);
  }

  /** 时间变化：TP.Api.setMinute 内部已调 TP.Sim.setTime，这里只让时变图层跟上 */
  function onTime() {
    guard('TP.Layers.applyTime', function () { if (TP.Layers && TP.Layers.ready) TP.Layers.applyTime(); });
    detectIncidents();
  }

  function onVisibility() {
    if (document.hidden) return;
    lastTs = 0;      /* 从后台切回：不追补时间，也不一次跳一大步 */
    playAcc = 0;
  }

  function wire() {
    if (wired) return;
    wired = true;

    /* 3D 拾取 → 详情抽屉 */
    guard('TP.CameraRig.onPick', function () {
      if (TP.CameraRig && typeof TP.CameraRig.onPick === 'function') TP.CameraRig.onPick(onPick);
    });

    /* 悬停 → tooltip（px/py 即 #canvas-host 局部坐标；#canvas-host 是 #stage 的 inset:0 子元素） */
    guard('TP.CameraRig.onHover', function () {
      if (TP.CameraRig && typeof TP.CameraRig.onHover === 'function') TP.CameraRig.onHover(onHover);
    });

    /* 数据总线：时间推进 / 新事件 */
    guard('TP.Api.on', function () {
      if (!TP.Api || typeof TP.Api.on !== 'function') return;
      TP.Api.on('time', onTime);
      TP.Api.on('incident', function (inc) { if (inc) incidentToast(inc); });
      TP.Api.on('region', function () { hoverCache.key = ''; });
    });

    /* 时间轴拖动期间关掉图表动画：UI 层只在拖动时切 state.scrubbing（数据侧），
       并没有动 TP.Charts 的动画开关，所以这里补上；只调 setAnimation，
       与 UI 自己绑在同一个 slider 上的 pointerdown（管 scrubbing）语义不重叠，
       不会造成"一次拖动触发两次业务动作"。 */
    var slider = el('timeline-slider');
    if (slider && U && U.on) {
      var animOn = function () {
        guard('TP.Charts.setAnimation(true)', function () {
          if (TP.Charts && typeof TP.Charts.setAnimation === 'function') TP.Charts.setAnimation(true);
        });
      };
      U.on(slider, 'pointerdown', function () {
        guard('TP.Charts.setAnimation(false)', function () {
          if (TP.Charts && typeof TP.Charts.setAnimation === 'function') TP.Charts.setAnimation(false);
        });
      });
      U.on(slider, 'touchstart', function () {
        guard('TP.Charts.setAnimation(false)', function () {
          if (TP.Charts && typeof TP.Charts.setAnimation === 'function') TP.Charts.setAnimation(false);
        });
      }, { passive: true });
      U.on(window, 'pointerup', animOn);
      U.on(window, 'pointercancel', animOn);
      U.on(slider, 'change', animOn);
      U.on(slider, 'blur', animOn);
    }

    /* 尺寸兜底：TP.Scene 与 TP.Charts 各自已监听 window resize，
       这里只做一次防抖复核（幂等，且覆盖全屏切换 / 容器尺寸变化） */
    if (U && U.debounce) {
      resizeHandler = U.debounce(function () {
        guard('TP.Scene.resize', function () { if (TP.Scene && TP.Scene.ready) TP.Scene.resize(); });
        guard('TP.Charts.resize', function () { if (TP.Charts && TP.Charts.ready) TP.Charts.resize(); });
      }, 160);
      window.addEventListener('resize', resizeHandler, false);
      window.addEventListener('orientationchange', resizeHandler, false);
    }
    window.addEventListener('visibilitychange', onVisibility, false);

    /* #btn-theme / #btn-play / #speed-group / #timeline-slider / 键盘 1-4 等
       全部由 TP.UI.bind() 绑定，这里绝不重复绑，避免一次操作触发两次 */
  }

  /* ================================================================== *
   * 5. 引导装配（顺序不可变）
   * ================================================================== */

  function ctxFor() {
    return {
      city: TP.City, sim: TP.Sim, api: TP.Api,
      scene: okSteps.scene ? TP.Scene : null,
      builder: okSteps.builder ? TP.CityBuilder : null,
      rig: okSteps.rig ? TP.CameraRig : null,
      layers: okSteps.layers ? TP.Layers : null,
      charts: TP.Charts,
      chartsOk: chartsState.ok,
      chartsError: chartsState.error
    };
  }

  /** 图表层可用性探测：失败不抛给上层，只把自己标记为降级 */
  function initCharts() {
    chartsState.ok = false;
    chartsState.error = null;
    if (!TP.Charts) { chartsState.error = 'TP.Charts 未加载'; throw new Error(chartsState.error); }
    if (typeof window.echarts === 'undefined') {
      chartsState.error = 'echarts 未加载（vendor/echarts.min.js 缺失）';
      throw new Error(chartsState.error);
    }
    try {
      TP.Charts.init();
    } catch (e) {
      /* 记下原因再往上抛：TP.UI.init 需要 chartsError 才能给出准确提示 */
      chartsState.error = 'TP.Charts.init(): ' + ((e && e.message) || e);
      throw e;
    }
    if (TP.Charts.ready) { chartsState.ok = true; return; }
    chartsState.error = 'TP.Charts.init() 执行后 TP.Charts.ready 仍为 false';
    throw new Error(chartsState.error);
  }

  /** 把数据门面的图层开关一次性对齐给 3D（两处默认值一致，纯保险） */
  function syncLayers() {
    var ls = (TP.Api && TP.Api.state) ? TP.Api.state.layers : null;
    if (!ls || !TP.Layers || !TP.Layers.ready) return;
    for (var id in ls) {
      if (!Object.prototype.hasOwnProperty.call(ls, id)) continue;
      (function (layerId, on) {
        guard('TP.Layers.setVisible(' + layerId + ')', function () { TP.Layers.setVisible(layerId, on); });
      })(id, !!ls[id]);
    }
  }

  function recordFailure(key, label, e) {
    var msg = (e && e.message) ? e.message : String(e);
    failed.push({ step: key, name: label, message: msg });
    errLog(label, e);
    setLoadingError('启动降级：' + label + ' — ' + msg);
    toast('「' + label + '」失败：' + msg + '（其余模块继续可用）', 'err');
  }

  function runStep(step, i, total) {
    var stepIdx = Math.min(4, Math.floor(i / total * 5));
    setLoading(Math.round(i / total * 96) + 2, step.text, stepIdx);
    try {
      step.fn();
      okSteps[step.key] = true;
      return true;
    } catch (e) {
      okSteps[step.key] = false;
      if (step.key === 'charts') chartsState.ok = false;
      recordFailure(step.key, step.label, e);
      return false;
    }
  }

  App.boot = function () {
    if (booted || booting) return App;          /* 幂等：重复调用不重复初始化 */
    booting = true;
    var t0 = nowMs();
    okSteps = {};
    armWatchdog();
    setLoading(1, '正在读取设计令牌与基础数据…', 0);

    /* 设计令牌：CSS 变量落地后再读一次，保证 3D / 图表取色正确 */
    try { if (TP.Theme && typeof TP.Theme.refresh === 'function') TP.Theme.refresh(); }
    catch (e) { errLog('TP.Theme.refresh()', e); }

    var hostEl = el('canvas-host') || document.body;

    var steps = [
      { key: 'city', label: 'TP.City.build()', text: '正在构建城市路网与用地模型…',
        fn: function () { TP.City.build(); } },
      { key: 'sim', label: 'TP.Sim.init()', text: '正在初始化交通仿真引擎…',
        fn: function () { TP.Sim.init(TP.City.data); } },
      { key: 'api', label: 'TP.Api.init()', text: '正在挂载数据接口门面…',
        fn: function () { TP.Api.init({ mode: 'mock' }); } },
      { key: 'scene', label: 'TP.Scene.init()', text: '正在初始化三维渲染器…',
        fn: function () { TP.Scene.init(hostEl); } },
      { key: 'builder', label: 'TP.CityBuilder.build()', text: '正在构建城市静态几何…',
        fn: function () { TP.CityBuilder.build(TP.City.data); } },
      { key: 'layers', label: 'TP.Layers.init()', text: '正在生成动态数据图层…',
        fn: function () { TP.Layers.init(TP.City.data, TP.Sim); } },
      { key: 'rig', label: 'TP.CameraRig.init()', text: '正在初始化视角系统…',
        fn: function () { TP.CameraRig.init(TP.Scene.camera, hostEl); } },
      { key: 'charts', label: 'TP.Charts.init()', text: '正在初始化图表组件…',
        fn: initCharts },
      { key: 'ui', label: 'TP.UI.init()', text: '正在绑定界面交互…',
        fn: function () { TP.UI.init(ctxFor()); } },
      { key: 'view', label: 'TP.CameraRig.setMode("bird")', text: '正在切换到默认鸟瞰机位…',
        fn: function () { TP.CameraRig.setMode('bird'); } },
      { key: 'refresh', label: 'TP.Api.refresh() + TP.UI.renderAll()', text: '正在刷新面板与图表…',
        fn: function () { TP.Api.refresh(); TP.UI.renderAll(); } }
    ];

    var i;
    for (i = 0; i < steps.length; i++) runStep(steps[i], i, steps.length);

    /* 图层开关与 3D 对齐（可在 layers 降级时安全跳过） */
    guard('syncLayers', syncLayers);

    /* 全局接线：务必在 UI.init 之后（处理器要用 TP.UI），且只接一次 */
    guard('wire', wire);

    /* 12. TP.UI.hideLoading() + TP.Api.emit('ready') —— 先广播再关页面，避免图表闪空 */
    var summary = '';
    if (failed.length) {
      summary = '启动降级 ' + failed.length + ' 项：' + failed[0].name + ' — ' + failed[0].message;
      setLoadingError(summary);
    } else {
      setLoading(100, '城市交通网络大数据平台已就绪', 4);
    }
    guard('TP.Api.emit("ready")', function () { if (okSteps.api) TP.Api.emit('ready'); });
    finishLoading(failed.length ? ERR_HOLD_MS : 0);
    window.clearTimeout(watchdogId);

    /* 基线：把当前已存在的事件标记为"已见"，避免启动瞬间刷屏 */
    guard('detectIncidents(seed)', detectIncidents);

    /* 13. 启动 RAF 主循环（即使前面降级也必须跑，否则页面完全静止） */
    guard('startLoop', startLoop);

    /* 收尾统计 */
    stats.bootMs = Math.round(nowMs() - t0);
    stats.degraded = failed.length > 0;
    stats.charts = chartsState.ok ? 'ok' : (chartsState.error ? 'degraded' : 'pending');
    stats.scene = !!(okSteps.scene && okSteps.builder);
    stats.core = {
      city: !!okSteps.city, sim: !!okSteps.sim, api: !!okSteps.api,
      scene: !!okSteps.scene, builder: !!okSteps.builder, layers: !!okSteps.layers,
      rig: !!okSteps.rig, charts: chartsState.ok, ui: !!okSteps.ui
    };
    stats.playing = playingNow();
    stats.speed = speedNow();

    booting = false;
    booted = true;
    App.ready = true;
    if (window.console && console.log) {
      console.log('[App] boot ' + stats.bootMs + 'ms · 降级 ' + failed.length + ' 项 · ' +
        'draw', (TP.Scene && TP.Scene.stats) ? TP.Scene.stats.drawCalls : '-');
    }
    return App;
  };

  /* ================================================================== *
   * 6. 自动引导
   * ================================================================== */

  function autoBoot() {
    try { App.boot(); }
    catch (e) {
      errLog('TP.App.boot()', e);
      var msg = '启动失败：' + ((e && e.message) || e);
      setLoadingError(msg);
      toast(msg, 'err');
      finishLoading(0);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoBoot, false);
    window.addEventListener('load', autoBoot, false);         /* 双保险，boot 幂等 */
  } else {
    /* 解析已完成：延后一个任务，让主题令牌与布局先落地。
       非浏览器环境（Node 单测桩）里 setTimeout 不执行回调，
       因此 app.js 被 require 时不会触发真实引导。 */
    window.setTimeout(autoBoot, 0);
  }

})(window, document);
