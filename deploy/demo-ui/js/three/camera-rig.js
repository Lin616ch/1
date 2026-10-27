/* ============================================================================
 * camera-rig.js —— 视角系统（本项目核心）
 * 命名空间：TP.CameraRig
 * 依赖：THREE(r128)、TP.Util、TP.Scene、（可选）TP.CityBuilder / TP.Layers / TP.City
 *
 * 设计：
 *   1) 统一位姿 = 球坐标 { x, y, z (观察点 target), r (距离), th (方位角), p (俯仰角 pitch) }
 *      相机位置 = target + r·(cos p·sin th, sin p, cos p·cos th)；th=0 时相机在南侧(+Z)朝北看。
 *   2) 两层状态：goal（输入写这里）→ cur（指数阻尼追随 goal）→ 相机。阻尼 + 释放后速度衰减 = 惯性。
 *   3) 模式切换 / 聚焦 = flyTo：在球坐标空间逐分量缓动（r 走对数插值、th 走最短弧、p/target 线性），
 *      远距离平移时 r 额外叠加 sin(πk) 的"抬升弧"（电影感 fly-to），全程 inOutCubic，900~1300ms；
 *      过渡期间 enabled=false 屏蔽输入。
 *   4) 任何时刻都做"不穿地 / 不穿楼"约束：依据 TP.CityBuilder.heightAt() 抬高俯仰。
 *   5) 动态 near 平面：near ∝ 距离，远景深度精度足够，平面图层不 z-fighting。
 * ==========================================================================*/
(function (window, document) {
  'use strict';

  var TP = window.TP = window.TP || {};
  var U = TP.Util;
  var THREE = window.THREE;

  var DEG = Math.PI / 180;
  var TWO_PI = Math.PI * 2;
  var MODES = ['orbit', 'top', 'bird', 'cruise'];
  var R_MIN = 120, R_MAX = 2600;
  var P_ORBIT = [8 * DEG, 88 * DEG];
  var P_TOP = 89.2 * DEG;                 /* 避免 phi→0 的万向锁 */
  var P_BIRD = 45 * DEG, P_BIRD_TOL = 5 * DEG;
  var DEFAULT_TH = 24 * DEG;
  var CLICK_PX = 5, CLICK_MS = 350, HOVER_MS = 60;

  var R = TP.CameraRig = {
    mode: 'orbit',
    target: null,
    heading: 0, pitch: 0, distance: 0,
    transitioning: false,
    MODES: MODES
  };

  var cam = null, dom = null;
  var cur = { x: 0, y: 0, z: 0, r: 1500, th: 0, p: 35 * DEG };
  var goal = { x: 0, y: 0, z: 0, r: 1500, th: 0, p: 35 * DEG };
  var vel = { th: 0, p: 0, x: 0, z: 0 };
  var bounds = { minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000 };
  var trans = null;
  var inputOn = true;
  var avoidP = 0;
  var timeS = 0;
  var lsn = { mode: [], pick: [], hover: [] };
  var hoverFn = null, hoverTimer = null;
  var compass = { needle: null, pitch: null, retry: 0, lastRot: null, lastPitch: null };
  var lastNear = 1;
  var handlers = {};
  var pickCache = { list: [], sig: '' };

  /* ---- 巡航状态 ---- */
  var cruise = {
    pts: [], cum: [], len: 0, loop: false,
    s: 0, dir: 1, speed: 45, paused: false,
    distMul: 1, yawOff: 0, pitchOff: 0, smoothTh: null,
    routeId: null, routes: []
  };

  /* ---- 指针状态 ---- */
  var ptr = {
    map: {}, count: 0, action: null, button: 0,
    downX: 0, downY: 0, downT: 0, moved: false, lastX: 0, lastY: 0, lastT: 0,
    pinchD: 0, pinchA: 0, pinchMx: 0, pinchMy: 0, multi: false
  };

  Object.defineProperty(R, 'enabled', { get: function () { return inputOn && !trans; }, enumerable: true });

  /* ===================================================== 小工具 ========== */
  function wrapPi(a) { a = (a + Math.PI) % TWO_PI; if (a < 0) a += TWO_PI; return a - Math.PI; }
  function nearestAngle(from, to) { return from + wrapPi(to - from); }
  function copyPose(a, b) { b = b || {}; b.x = a.x; b.y = a.y; b.z = a.z; b.r = a.r; b.th = a.th; b.p = a.p; return b; }
  function damp(k, dts, tau) { return 1 - Math.exp(-dts / tau); }
  function toRad(v) { return v > 1.6 ? v * DEG : v; }        /* 兼容角度/弧度两种写法 */
  function hostSize() { return { w: dom ? (dom.clientWidth || 1) : 1, h: dom ? (dom.clientHeight || 1) : 1 }; }
  function emit(list, a, b) { for (var i = 0; i < list.length; i++) { try { list[i](a, b); } catch (e) { if (window.console) console.error(e); } } }

  function clampTarget(p) {
    p.x = U.clamp(p.x, bounds.minX, bounds.maxX);
    p.z = U.clamp(p.z, bounds.minZ, bounds.maxZ);
  }
  function pitchRange(mode) {
    if (mode === 'top') return [P_TOP, P_TOP];
    if (mode === 'bird') return [P_BIRD - P_BIRD_TOL, P_BIRD + P_BIRD_TOL];
    if (mode === 'cruise') return [8 * DEG, 60 * DEG];
    return P_ORBIT;
  }
  function constrain(g) {
    g.r = U.clamp(g.r, R_MIN, R_MAX);
    var pr = pitchRange(R.mode);
    g.p = U.clamp(g.p, pr[0], pr[1]);
    clampTarget(g);
  }

  /* ===================================================== 初始化 ========== */
  R.init = function (camera, domElement) {
    if (dom) R.dispose();
    cam = camera || (TP.Scene && TP.Scene.camera);
    dom = domElement || (TP.Scene && TP.Scene.renderer && TP.Scene.renderer.domElement.parentNode) || document.body;
    R.target = R.target || new THREE.Vector3();
    /* 从相机当前位置反推球坐标（Scene 初始机位 (0,900,1250) 看原点） */
    var dx = cam.position.x, dy = cam.position.y, dz = cam.position.z;
    cur.x = cur.z = cur.y = 0;
    cur.r = U.clamp(Math.sqrt(dx * dx + dy * dy + dz * dz), R_MIN, R_MAX);
    cur.p = Math.asin(U.clamp(dy / cur.r, -1, 1));
    cur.th = Math.atan2(dx, dz);
    copyPose(cur, goal);
    R.mode = 'orbit';
    if (TP.City && TP.City.data && TP.City.data.meta && TP.City.data.meta.extent) {
      var e = TP.City.data.meta.extent; R.setBounds(-e, e, -e, e);
    }
    initCruiseRoutes();
    bindEvents();
    applyCamera(0);
    return R;
  };

  /* ===================================================== 事件 ============ */
  function bindEvents() {
    handlers.down = onDown; handlers.move = onMove; handlers.up = onUp; handlers.cancel = onUp;
    handlers.wheel = onWheel; handlers.ctx = function (e) { e.preventDefault(); };
    handlers.leave = function () { if (!ptr.count) fireHover(null); };
    handlers.dbl = onDbl;
    dom.addEventListener('pointerdown', handlers.down, false);
    dom.addEventListener('pointermove', handlers.move, false);
    dom.addEventListener('pointerup', handlers.up, false);
    dom.addEventListener('pointercancel', handlers.cancel, false);
    dom.addEventListener('pointerleave', handlers.leave, false);
    dom.addEventListener('wheel', handlers.wheel, { passive: false });
    dom.addEventListener('contextmenu', handlers.ctx, false);
    dom.addEventListener('dblclick', handlers.dbl, false);
    if (dom.style) dom.style.touchAction = 'none';
    hoverFn = U.throttle(function (px, py) { doHover(px, py); }, HOVER_MS);
  }

  function localXY(e) {
    var rc = dom.getBoundingClientRect();
    return { x: e.clientX - rc.left, y: e.clientY - rc.top };
  }

  function actionFor(button, e) {
    var m = R.mode;
    var right = button === 2 || button === 1 || (e && (e.shiftKey || e.ctrlKey));
    if (m === 'cruise') return 'look';
    if (m === 'top') return right ? 'rotate' : 'pan';
    return right ? 'pan' : 'rotate';
  }

  function onDown(e) {
    var p = localXY(e);
    ptr.map[e.pointerId] = { x: p.x, y: p.y };
    ptr.count = Object.keys(ptr.map).length;
    try { dom.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
    vel.th = vel.p = vel.x = vel.z = 0;        /* 按下即"抓停"惯性 */
    if (ptr.count === 1) {
      ptr.button = e.pointerType === 'touch' ? 0 : e.button;
      ptr.action = actionFor(ptr.button, e);
      ptr.downX = ptr.lastX = p.x; ptr.downY = ptr.lastY = p.y;
      ptr.downT = ptr.lastT = U.now(); ptr.moved = false; ptr.multi = false;
    } else if (ptr.count === 2) {
      ptr.multi = true; ptr.moved = true;
      pinchInit();
    }
  }

  function pinchInit() {
    var ks = Object.keys(ptr.map), a = ptr.map[ks[0]], b = ptr.map[ks[1]];
    ptr.pinchD = Math.max(1, U.dist(a.x, a.y, b.x, b.y));
    ptr.pinchA = Math.atan2(b.y - a.y, b.x - a.x);
    ptr.pinchMx = (a.x + b.x) / 2; ptr.pinchMy = (a.y + b.y) / 2;
  }

  function onMove(e) {
    var p = localXY(e);
    if (!ptr.count || !ptr.map[e.pointerId]) {
      if (hoverFn && e.pointerType !== 'touch') hoverFn(p.x, p.y);
      return;
    }
    ptr.map[e.pointerId].x = p.x; ptr.map[e.pointerId].y = p.y;
    var now = U.now();
    if (ptr.count >= 2) { if (R.enabled) pinchMove(); else pinchInit(); return; }
    var dx = p.x - ptr.lastX, dy = p.y - ptr.lastY;
    var dts = Math.max(0.004, (now - ptr.lastT) / 1000);
    ptr.lastX = p.x; ptr.lastY = p.y; ptr.lastT = now;
    if (!ptr.moved && U.dist(p.x, p.y, ptr.downX, ptr.downY) >= CLICK_PX) ptr.moved = true;
    if (!ptr.moved || !R.enabled) return;
    var sz = hostSize();
    if (ptr.action === 'rotate') {
      var dth = -TWO_PI * dx / sz.h * 0.55;
      var dp = (R.mode === 'top') ? 0 : Math.PI * dy / sz.h * 0.6;
      goal.th += dth; goal.p += dp;
      vel.th = U.lerp(vel.th, dth / dts, 0.45); vel.p = U.lerp(vel.p, dp / dts, 0.45);
    } else if (ptr.action === 'pan') {
      var mv = panDelta(dx, dy, sz.h);
      goal.x += mv.x; goal.z += mv.z;
      vel.x = U.lerp(vel.x, mv.x / dts, 0.45); vel.z = U.lerp(vel.z, mv.z / dts, 0.45);
    } else if (ptr.action === 'look') {
      cruise.yawOff += -TWO_PI * dx / sz.h * 0.35;
      cruise.pitchOff = U.clamp(cruise.pitchOff + Math.PI * dy / sz.h * 0.4, -14 * DEG, 30 * DEG);
    }
  }

  /** 屏幕像素位移 → 地面世界位移（倾斜视角下纵向按 1/sin(p) 放大，贴合手感） */
  function panDelta(dx, dy, h) {
    var wpp = 2 * cur.r * Math.tan(cam.fov * DEG / 2) / h;
    var c = Math.cos(cur.th), s = Math.sin(cur.th);
    var k = wpp / Math.max(0.42, Math.sin(cur.p));
    return {
      x: -c * dx * wpp + (-s) * dy * k,
      z: s * dx * wpp + (-c) * dy * k
    };
  }

  function pinchMove() {
    var ks = Object.keys(ptr.map), a = ptr.map[ks[0]], b = ptr.map[ks[1]];
    var d = Math.max(1, U.dist(a.x, a.y, b.x, b.y));
    var ang = Math.atan2(b.y - a.y, b.x - a.x);
    var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    var f = ptr.pinchD / d;
    if (R.mode === 'cruise') cruise.distMul = U.clamp(cruise.distMul * f, 0.45, 2.6);
    else {
      goal.r = U.clamp(goal.r * f, R_MIN, R_MAX);
      goal.th -= wrapPi(ang - ptr.pinchA);
      var mv = panDelta(mx - ptr.pinchMx, my - ptr.pinchMy, hostSize().h);
      goal.x += mv.x; goal.z += mv.z;
    }
    ptr.pinchD = d; ptr.pinchA = ang; ptr.pinchMx = mx; ptr.pinchMy = my;
  }

  function onUp(e) {
    if (!ptr.map[e.pointerId]) return;
    var p = localXY(e);
    delete ptr.map[e.pointerId];
    ptr.count = Object.keys(ptr.map).length;
    try { dom.releasePointerCapture(e.pointerId); } catch (err) { /* noop */ }
    if (ptr.count === 1) { /* 双指 → 单指：重置基准，避免跳变 */
      var k = Object.keys(ptr.map)[0];
      ptr.lastX = ptr.map[k].x; ptr.lastY = ptr.map[k].y; ptr.lastT = U.now();
      return;
    }
    if (ptr.count > 0) return;
    var dt = U.now() - ptr.downT;
    var isClick = !ptr.multi && !ptr.moved && dt < CLICK_MS && U.dist(p.x, p.y, ptr.downX, ptr.downY) < CLICK_PX;
    if (U.now() - ptr.lastT > 70) { vel.th = vel.p = vel.x = vel.z = 0; }   /* 停住后松手：无惯性 */
    ptr.action = null;
    if (e.type === 'pointercancel') return;
    if (isClick && ptr.button === 0 && !trans) doPick(p.x, p.y);
  }

  function onWheel(e) {
    e.preventDefault();
    if (!R.enabled) return;
    var dy = e.deltaY * (e.deltaMode === 1 ? 33 : (e.deltaMode === 2 ? 400 : 1));
    var steps = U.clamp(dy / 100, -3, 3);
    var f = Math.pow(0.9, -steps);                     /* 每格 ×0.9 / ÷0.9：对数感缩放 */
    if (R.mode === 'cruise') { cruise.distMul = U.clamp(cruise.distMul * f, 0.45, 2.6); return; }
    var nr = U.clamp(goal.r * f, R_MIN, R_MAX);
    var fe = nr / goal.r;
    goal.r = nr;
    /* 以光标处地面点为锚缩放（地图式 zoom-to-cursor） */
    var p = localXY(e);
    var gp = TP.Scene && TP.Scene.groundPoint ? TP.Scene.groundPoint(p.x, p.y) : null;
    if (gp && U.dist(gp.x, gp.z, goal.x, goal.z) < goal.r * 3) {
      goal.x = gp.x + (goal.x - gp.x) * fe;
      goal.z = gp.z + (goal.z - gp.z) * fe;
    }
  }

  function onDbl(e) {
    if (!R.enabled || R.mode === 'cruise') return;
    var p = localXY(e);
    var gp = TP.Scene.groundPoint(p.x, p.y);
    if (gp) R.focusOn(gp.x, gp.z, { distance: Math.max(R_MIN * 1.5, goal.r * 0.55), dur: 900 });
  }

  /* ===================================================== 拾取 / 悬停 ===== */
  function pickables() {
    var a = (TP.Layers && TP.Layers.pickables) || [], b = (TP.CityBuilder && TP.CityBuilder.pickables) || [];
    var sig = a.length + ':' + b.length;
    if (sig !== pickCache.sig) { pickCache.list = a.concat(b); pickCache.sig = sig; }
    return pickCache.list;
  }

  function resolveAt(px, py) {
    var h = TP.Scene.raycast(px, py, pickables());
    var gp = TP.Scene.groundPoint(px, py);
    var pt = h ? h.point : (gp ? { x: gp.x, y: 0, z: gp.z } : null);
    if (!pt) return { x: 0, z: 0, hit: null, raw: null };
    var hit = null;
    if (TP.Layers && TP.Layers.resolveHit) {
      try { hit = TP.Layers.resolveHit(h ? h.object : null, h ? h.instanceId : null, pt, h); }
      catch (e) { if (window.console) console.error(e); }
    } else if (h) hit = { kind: (h.object.userData && h.object.userData.kind) || 'object', id: h.object.name };
    return { x: pt.x, z: pt.z, hit: hit || null, raw: h };
  }

  function doPick(px, py) {
    var r = resolveAt(px, py);
    emit(lsn.pick, { x: r.x, z: r.z, hit: r.hit, px: px, py: py });
  }

  var lastHoverKey = null;
  function doHover(px, py) {
    if (trans || ptr.count) return;
    var r = resolveAt(px, py);
    if (TP.CityBuilder && TP.CityBuilder.hoverDistrict && TP.CityBuilder.districtsVisible && TP.CityBuilder.districtsVisible() && TP.City && TP.City.districtOf) {
      TP.CityBuilder.hoverDistrict(TP.City.districtOf(r.x, r.z));
    }
    if (TP.Layers && TP.Layers._rigHover) TP.Layers._rigHover(r.hit);
    emit(lsn.hover, { x: r.x, z: r.z, hit: r.hit, px: px, py: py });
    lastHoverKey = r.hit ? r.hit.kind + r.hit.id : null;
  }
  function fireHover(nothing) {
    if (TP.Layers && TP.Layers._rigHover) TP.Layers._rigHover(null);
    if (TP.CityBuilder && TP.CityBuilder.hoverDistrict) TP.CityBuilder.hoverDistrict(null);
    if (lastHoverKey !== null || nothing === null) emit(lsn.hover, { x: 0, z: 0, hit: null, px: -1, py: -1 });
    lastHoverKey = null;
  }

  R.onPick = function (fn) { if (typeof fn === 'function') lsn.pick.push(fn); return fn; };
  R.onHover = function (fn) { if (typeof fn === 'function') lsn.hover.push(fn); return fn; };
  R.onModeChange = function (fn) { if (typeof fn === 'function') lsn.mode.push(fn); return fn; };
  R.pickAt = function (px, py) { return resolveAt(px, py); };

  /* ===================================================== 过渡（球坐标插值）*/
  /**
   * flyTo(to, o)：从 cur 平滑飞到 to。
   *   r：对数空间插值 × (1 + hop·sin πk)   ← 远距离平移时先拉高再落下
   *   th：最短弧；p：线性（两端都在 [8°, 89.2°] 内，插值结果不可能穿地）；target：线性
   */
  function flyTo(to, o) {
    o = o || {};
    if (trans) { trans.tw.cancel(); trans = null; }
    var from = copyPose(cur, {});
    var dest = copyPose(to, {});
    dest.th = nearestAngle(from.th, dest.th);
    var travel = U.dist(from.x, from.z, dest.x, dest.z);
    var hop = U.clamp(travel / (from.r + dest.r) * 0.9, 0, 0.55);
    var lr0 = Math.log(from.r), lr1 = Math.log(dest.r);
    var amount = Math.max(Math.abs(dest.th - from.th) / Math.PI, Math.abs(dest.p - from.p) / (Math.PI / 2),
      Math.abs(lr1 - lr0) / 1.4, travel / 1400);
    var dur = o.dur != null ? o.dur : Math.round(900 + 400 * U.clamp01(amount));
    dur = U.clamp(dur, 300, 2000);
    var T = { tw: null, tick: 0, seen: -1, stall: 0, from: from, to: dest, dur: dur, onDone: o.onDone };
    T.tw = U.tween({
      from: 0, to: 1, dur: dur, ease: 'inOutCubic',
      onUpdate: function (k) {
        T.tick++;
        var arc = Math.sin(Math.PI * k);
        cur.r = Math.exp(U.lerp(lr0, lr1, k)) * (1 + hop * arc);
        cur.th = U.lerp(from.th, dest.th, k);
        cur.p = U.lerp(from.p, dest.p, k);
        if (hop > 0.05 && dest.p < 80 * DEG) cur.p += (Math.min(70 * DEG, 89 * DEG) - cur.p) * hop * 0.35 * arc;
        cur.x = U.lerp(from.x, dest.x, k);
        cur.y = U.lerp(from.y, dest.y, k);
        cur.z = U.lerp(from.z, dest.z, k);
      },
      onDone: function () {
        if (trans !== T) return;
        copyPose(dest, cur);
        copyPose(cur, goal);
        vel.th = vel.p = vel.x = vel.z = 0;
        trans = null; R.transitioning = false;
        if (T.onDone) T.onDone();
      }
    });
    trans = T; R.transitioning = true;
    return T;
  }
  R.flyTo = function (pose, o) {
    var to = {
      x: pose.x != null ? pose.x : cur.x, y: 0, z: pose.z != null ? pose.z : cur.z,
      r: U.clamp(pose.r || pose.distance || cur.r, R_MIN, R_MAX),
      th: pose.th != null ? pose.th : (pose.heading != null ? -pose.heading : cur.th),
      p: pose.p != null ? toRad(pose.p) : (pose.pitch != null ? toRad(pose.pitch) : cur.p)
    };
    var pr = pitchRange(R.mode); to.p = U.clamp(to.p, pr[0], pr[1]);
    clampTarget(to);
    return flyTo(to, o);
  };

  /* ===================================================== 模式 ============ */
  function poseFor(mode, o, prev, isReset) {
    o = o || {};
    var t = o.target || (isReset ? { x: 0, z: 0 } : { x: cur.x, z: cur.z });
    var p = { x: t.x, y: 0, z: t.z, r: cur.r, th: cur.th, p: cur.p };
    if (mode === 'orbit') {
      p.r = isReset ? 1500 : U.clamp(cur.r, 600, 1800);
      p.p = 34 * DEG;
      if (isReset || prev === 'top') p.th = nearestAngle(cur.th, DEFAULT_TH);
    } else if (mode === 'top') {
      p.r = isReset ? 1950 : U.clamp(Math.max(cur.r, 1500), 1500, 2400);
      p.p = P_TOP;
      p.th = nearestAngle(cur.th, 0);                 /* 平面图：上北下南 */
    } else if (mode === 'bird') {
      p.r = isReset || prev === 'top' || prev === 'cruise' ? 1550 : U.clamp(cur.r, 700, 2100);
      p.p = P_BIRD;
      if (isReset || prev === 'top' || prev === 'cruise') p.th = nearestAngle(cur.th, DEFAULT_TH);
    } else if (mode === 'cruise') {
      return cruisePose(0, false, true);
    }
    if (o.radius != null) p.r = o.radius;
    if (o.distance != null) p.r = o.distance;
    if (o.pitch != null && mode !== 'top') p.p = toRad(o.pitch);
    if (o.heading != null) p.th = nearestAngle(cur.th, -o.heading);
    p.r = U.clamp(p.r, R_MIN, R_MAX);
    var pr = pitchRange(mode); p.p = U.clamp(p.p, pr[0], pr[1]);
    clampTarget(p);
    return p;
  }

  R.setMode = function (mode, o) {
    if (MODES.indexOf(mode) < 0) return R;
    o = o || {};
    var prev = R.mode;
    if (mode === 'cruise') {
      if (o.corridorId) R.setCruiseRoute(o.corridorId, { silent: true });
      else if (o.path) R.setCruisePath(o.path, { silent: true });
      if (!cruise.len) initCruiseRoutes();
      if (prev !== 'cruise') { cruise.yawOff = 0; cruise.pitchOff = 0; cruise.smoothTh = null; }
    }
    var to = poseFor(mode, o, prev, !!o.reset);
    R.mode = mode;
    if (TP.CityBuilder && TP.CityBuilder.setPlanView) {
      if (mode === 'top' && prev !== 'top') TP.CityBuilder.setPlanView(true, 1000);
      else if (mode !== 'top' && (prev === 'top' || (TP.CityBuilder.planAmount && TP.CityBuilder.planAmount() > 0))) TP.CityBuilder.setPlanView(false, 1000);
    }
    if (o.immediate) {
      if (trans) { trans.tw.cancel(); trans = null; R.transitioning = false; }
      copyPose(to, cur); copyPose(to, goal);
      applyCamera(0);
      if (prev !== mode) emit(lsn.mode, mode, prev);
      return R;
    }
    flyTo(to, {
      dur: o.dur,
      onDone: function () {
        if (mode === 'cruise') cruise.smoothTh = cur.th;
        if (prev !== mode) emit(lsn.mode, mode, prev);
        if (o.onDone) o.onDone();
      }
    });
    return R;
  };

  R.reset = function () {
    if (R.mode === 'cruise') { cruise.s = 0; cruise.dir = 1; cruise.yawOff = cruise.pitchOff = 0; cruise.distMul = 1; cruise.smoothTh = null; }
    var to = poseFor(R.mode, {}, R.mode, true);
    flyTo(to, { onDone: function () { if (R.mode === 'cruise') cruise.smoothTh = cur.th; } });
    return R;
  };

  /** 平滑聚焦。opts.radius = 要框住的区域半径（世界单位）；opts.distance = 直接指定相机距离 */
  R.focusOn = function (x, z, o) {
    o = o || {};
    if (R.mode === 'cruise') {
      return R.setMode('bird', { target: { x: x, z: z }, radius: o.distance || (o.radius ? o.radius * 2.4 : 900), dur: o.dur });
    }
    var to = { x: x, y: 0, z: z, r: goal.r, th: cur.th, p: cur.p };
    if (o.distance != null) to.r = o.distance;
    else if (o.radius != null) to.r = o.radius * (R.mode === 'top' ? 2.75 : 2.4);
    if (o.pitch != null) to.p = toRad(o.pitch);
    if (o.heading != null) to.th = -o.heading;
    to.r = U.clamp(to.r, R_MIN, R_MAX);
    var pr = pitchRange(R.mode); to.p = U.clamp(to.p, pr[0], pr[1]);
    clampTarget(to);
    flyTo(to, { dur: o.dur != null ? o.dur : 1100, onDone: o.onDone });
    return R;
  };

  R.setBounds = function (minX, maxX, minZ, maxZ) {
    bounds.minX = Math.min(minX, maxX); bounds.maxX = Math.max(minX, maxX);
    bounds.minZ = Math.min(minZ, maxZ); bounds.maxZ = Math.max(minZ, maxZ);
    clampTarget(goal);
    return R;
  };

  /* 便捷控制（供 UI 的 +/-/复北 按钮） */
  R.zoomBy = function (f) { if (R.mode === 'cruise') cruise.distMul = U.clamp(cruise.distMul * f, 0.45, 2.6); else goal.r = U.clamp(goal.r * f, R_MIN, R_MAX); return R; };
  R.zoomIn = function () { return R.zoomBy(0.8); };
  R.zoomOut = function () { return R.zoomBy(1.25); };
  R.rotateBy = function (rad) { goal.th += rad; return R; };
  R.resetNorth = function () {
    if (R.mode === 'cruise') return R;
    var to = copyPose(goal, {}); to.th = nearestAngle(cur.th, 0); flyTo(to, { dur: 900 }); return R;
  };
  R.getState = function () {
    return { mode: R.mode, x: cur.x, z: cur.z, distance: cur.r, heading: R.heading, pitch: R.pitch, transitioning: !!trans,
      cruise: { routeId: cruise.routeId, s: cruise.s, length: cruise.len, paused: cruise.paused, speed: cruise.speed } };
  };
  R.setInputEnabled = function (on) { inputOn = !!on; };

  /* ===================================================== 巡航 ============ */
  function initCruiseRoutes() {
    var cd = TP.City && TP.City.data;
    cruise.routes = [];
    if (cd && cd.corridors && cd.corridors.length) {
      for (var i = 0; i < cd.corridors.length; i++) {
        var c = cd.corridors[i];
        if (c.path && c.path.length > 1) cruise.routes.push({ id: c.id, name: c.name, path: c.path });
      }
    }
    if (!cruise.len) {
      if (cruise.routes.length) R.setCruiseRoute(cruise.routes[0].id, { silent: true });
      else {
        /* 无走廊数据时的几何兜底：绕城一圈（非业务数据） */
        var pts = [];
        for (var k = 0; k <= 48; k++) { var a = k / 48 * TWO_PI; pts.push({ x: Math.cos(a) * 480, z: Math.sin(a) * 480 }); }
        R.setCruisePath(pts, { silent: true });
      }
    }
  }

  R.cruiseRoutes = function () {
    if (!cruise.routes.length) initCruiseRoutes();
    return cruise.routes.map(function (r) { return { id: r.id, name: r.name }; });
  };
  R.cruiseRouteId = function () { return cruise.routeId; };

  R.setCruiseRoute = function (id, o) {
    for (var i = 0; i < cruise.routes.length; i++) {
      if (cruise.routes[i].id === id) {
        R.setCruisePath(cruise.routes[i].path, o);
        cruise.routeId = id;
        return true;
      }
    }
    return false;
  };
  R.nextCruiseRoute = function () {
    if (!cruise.routes.length) return null;
    var i = 0;
    for (var k = 0; k < cruise.routes.length; k++) if (cruise.routes[k].id === cruise.routeId) i = k + 1;
    var r = cruise.routes[i % cruise.routes.length];
    R.setCruiseRoute(r.id);
    return r.id;
  };

  /** 设置巡航路线：Catmull-Rom 平滑后按 ~6 单位等距重采样，预计算累计弧长 */
  R.setCruisePath = function (points, o) {
    o = o || {};
    if (!points || points.length < 2) return R;
    var v3 = [], i;
    for (i = 0; i < points.length; i++) {
      var p = points[i], x = p.x !== undefined ? p.x : p[0], z = p.z !== undefined ? p.z : p[1];
      if (v3.length && U.dist(x, z, v3[v3.length - 1].x, v3[v3.length - 1].z) < 0.5) continue;
      v3.push(new THREE.Vector3(x, 0, z));
    }
    if (v3.length < 2) return R;
    var loop = v3.length > 3 && v3[0].distanceTo(v3[v3.length - 1]) < 25;
    if (loop) v3.pop();
    var samples;
    if (v3.length >= 3) {
      var curve = new THREE.CatmullRomCurve3(v3, loop, 'centripetal');
      var approx = 0;
      for (i = 1; i < v3.length; i++) approx += v3[i].distanceTo(v3[i - 1]);
      samples = curve.getSpacedPoints(Math.max(16, Math.min(2400, Math.round(approx / 6))));
    } else samples = v3;
    cruise.pts = []; cruise.cum = [];
    var acc = 0;
    for (i = 0; i < samples.length; i++) {
      if (i) acc += U.dist(samples[i].x, samples[i].z, samples[i - 1].x, samples[i - 1].z);
      cruise.pts.push(samples[i].x, samples[i].z);
      cruise.cum.push(acc);
    }
    cruise.len = acc; cruise.loop = loop;
    cruise.s = 0; cruise.dir = 1; cruise.smoothTh = null;
    cruise.routeId = o.routeId || null;
    if (R.mode === 'cruise' && !o.silent && cam) {
      cruise.yawOff = cruise.pitchOff = 0;
      flyTo(cruisePose(0, false, true), { dur: 1200, onDone: function () { cruise.smoothTh = cur.th; } });
    }
    return R;
  };

  R.setCruiseSpeed = function (v) { cruise.speed = U.clamp(+v || 45, 2, 400); return R; };
  R.pause = function () { cruise.paused = true; return R; };
  R.resume = function () { cruise.paused = false; return R; };
  R.togglePause = function () { cruise.paused = !cruise.paused; return cruise.paused; };
  Object.defineProperty(R, 'paused', { get: function () { return cruise.paused; }, enumerable: true });

  function cruiseAt(s, out) {
    var L = cruise.len, cum = cruise.cum, pts = cruise.pts, n = cum.length;
    if (cruise.loop) s = U.wrap(s, L); else s = U.clamp(s, 0, L);
    var lo = 0, hi = n - 1;
    while (lo < hi - 1) { var mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
    var seg = cum[hi] - cum[lo], k = seg > 1e-6 ? (s - cum[lo]) / seg : 0;
    out.x = U.lerp(pts[lo * 2], pts[hi * 2], k);
    out.z = U.lerp(pts[lo * 2 + 1], pts[hi * 2 + 1], k);
    return out;
  }

  var cA = { x: 0, z: 0 }, cB = { x: 0, z: 0 }, cT = { x: 0, z: 0 };
  /**
   * 巡航位姿：机位在当前点斜后上方，视线前瞻 ahead；航向角做 0.9s 时间常数的平滑，
   * 转弯/掉头时相机"摆尾"而不是硬切；叠加轻微上下浮动（bob）与俯仰呼吸。
   */
  function cruisePose(dts, advance, fresh) {
    if (!cruise.len) initCruiseRoutes();
    if (advance && !cruise.paused) {
      cruise.s += cruise.dir * cruise.speed * dts;
      if (cruise.loop) cruise.s = U.wrap(cruise.s, cruise.len);
      else if (cruise.s > cruise.len) { cruise.s = 2 * cruise.len - cruise.s; cruise.dir = -1; }
      else if (cruise.s < 0) { cruise.s = -cruise.s; cruise.dir = 1; }
    }
    var dir = cruise.dir, ahead = 60 + cruise.speed * 0.5;
    cruiseAt(cruise.s + dir * ahead, cT);
    cruiseAt(cruise.s + dir * (ahead + 50), cA);
    cruiseAt(cruise.s - dir * 15, cB);
    var fx = cA.x - cB.x, fz = cA.z - cB.z;
    var want = Math.atan2(-fx, -fz);                    /* 相机在行进方向的反方向 */
    if (fresh || cruise.smoothTh == null) cruise.smoothTh = nearestAngle(cur.th, want);
    else cruise.smoothTh += wrapPi(want - cruise.smoothTh) * damp(0, dts, 0.9);
    if (!ptr.count) {
      cruise.yawOff *= Math.exp(-dts * 0.7);
      cruise.pitchOff *= Math.exp(-dts * 0.7);
    }
    var bob = fresh ? 0 : Math.sin(timeS * 0.8);
    return {
      x: cT.x, y: 4 + 2.5 * bob, z: cT.z,
      r: U.clamp(320 * cruise.distMul, R_MIN, R_MAX),
      th: cruise.smoothTh + cruise.yawOff,
      p: U.clamp(26 * DEG + (fresh ? 0 : 2.2 * DEG * Math.sin(timeS * 0.45)) + cruise.pitchOff, 8 * DEG, 60 * DEG)
    };
  }

  /* ===================================================== 每帧 ============ */
  R.update = function (dt) {
    if (!cam) return;
    dt = U.clamp(dt == null ? 16.7 : dt, 0, 100);
    var dts = dt / 1000;
    timeS += dts;

    if (trans) {
      /* 若主循环没有驱动 TP.Util.Tween（契约里由 app 调用），则自驱，保证过渡必然完成 */
      if (trans.tick === trans.seen) trans.stall++; else { trans.stall = 0; trans.seen = trans.tick; }
      if (trans.stall >= 2) {
        if (!R._selfDriveLogged) { R._selfDriveLogged = true; if (TP.Scene.log) TP.Scene.log('CameraRig: Tween 未被驱动，改为自驱'); }
        U.Tween.update(dt); trans && (trans.seen = trans.tick);
      }
    } else if (R.mode === 'cruise') {
      var cp = cruisePose(dts, true, false);
      var kc = damp(0, dts, 0.12);
      cur.x += (cp.x - cur.x) * kc; cur.z += (cp.z - cur.z) * kc; cur.y += (cp.y - cur.y) * kc;
      cur.th += wrapPi(cp.th - cur.th) * kc; cur.p += (cp.p - cur.p) * kc;
      cur.r = Math.exp(U.lerp(Math.log(cur.r), Math.log(cp.r), damp(0, dts, 0.25)));
      copyPose(cur, goal);
    } else {
      if (!ptr.count) {
        var dec = Math.exp(-dts * 3.6);
        if (Math.abs(vel.th) + Math.abs(vel.p) > 1e-4 || Math.abs(vel.x) + Math.abs(vel.z) > 1e-2) {
          goal.th += vel.th * dts; goal.p += vel.p * dts; goal.x += vel.x * dts; goal.z += vel.z * dts;
          vel.th *= dec; vel.p *= dec; vel.x *= dec; vel.z *= dec;
        } else { vel.th = vel.p = vel.x = vel.z = 0; }
      }
      constrain(goal);
      var kr = damp(0, dts, 0.085), kp = damp(0, dts, 0.075), kz = damp(0, dts, 0.11);
      cur.th += (goal.th - cur.th) * kr;
      cur.p += (goal.p - cur.p) * kr;
      cur.x += (goal.x - cur.x) * kp;
      cur.z += (goal.z - cur.z) * kp;
      cur.y += (0 - cur.y) * kp;
      cur.r = Math.exp(U.lerp(Math.log(cur.r), Math.log(goal.r), kz));
      /* 防止 th 无限累积导致精度损失 */
      if (Math.abs(cur.th) > 40 * Math.PI) { var w = cur.th - wrapPi(cur.th); cur.th -= w; goal.th -= w; }
    }
    applyCamera(dts);
  };

  var tmpPos = null;
  function applyCamera(dts) {
    if (!tmpPos) tmpPos = new THREE.Vector3();
    var p = cur.p;
    /* 不穿楼：相机落点处建筑高度 + 余量 → 需要的最小俯仰 */
    var cpos = Math.cos(p), sx = cur.x + cur.r * cpos * Math.sin(cur.th), sz = cur.z + cur.r * cpos * Math.cos(cur.th);
    var hb = (TP.CityBuilder && TP.CityBuilder.heightAt) ? TP.CityBuilder.heightAt(sx, sz) : 0;
    var need = hb > 0 ? Math.asin(U.clamp((hb + 22 - cur.y) / cur.r, -1, 1)) : 0;
    avoidP += (need - avoidP) * (dts > 0 ? damp(0, dts, 0.25) : 1);
    if (avoidP > p) p = Math.min(P_TOP, avoidP);
    var cp = Math.cos(p), sp = Math.sin(p);
    cam.position.set(cur.x + cur.r * cp * Math.sin(cur.th), cur.y + cur.r * sp, cur.z + cur.r * cp * Math.cos(cur.th));
    cam.up.set(0, 1, 0);
    tmpPos.set(cur.x, cur.y, cur.z);
    cam.lookAt(tmpPos);
    var near = U.clamp(cur.r * 0.035, 1, 70);
    if (Math.abs(near - lastNear) / lastNear > 0.04) { cam.near = near; cam.far = 7000 + cur.r; cam.updateProjectionMatrix(); lastNear = near; }
    cam.updateMatrixWorld();
    R.target.set(cur.x, cur.y, cur.z);
    R.heading = U.wrap(-cur.th, TWO_PI);
    R.pitch = p;
    R.distance = cur.r;
    syncCompass();
  }

  /* 指北针：针旋转 = -heading（让 N 永远指向屏幕上的真北）；俯仰角写文本 */
  function syncCompass() {
    if (!compass.needle || !compass.pitch) {
      if (--compass.retry > 0) return;
      compass.retry = 60;
      compass.needle = document.getElementById('compass-needle');
      compass.pitch = document.getElementById('compass-pitch');
      compass.lastRot = compass.lastPitch = null;
    }
    var rot = Math.round(-R.heading * 180 / Math.PI * 10) / 10;
    if (compass.needle && rot !== compass.lastRot) { compass.needle.style.transform = 'rotate(' + rot + 'deg)'; compass.lastRot = rot; }
    var pd = Math.round(R.pitch * 180 / Math.PI) + '°';
    if (compass.pitch && pd !== compass.lastPitch) { compass.pitch.textContent = pd; compass.lastPitch = pd; }
  }

  R.dispose = function () {
    if (!dom) return;
    dom.removeEventListener('pointerdown', handlers.down, false);
    dom.removeEventListener('pointermove', handlers.move, false);
    dom.removeEventListener('pointerup', handlers.up, false);
    dom.removeEventListener('pointercancel', handlers.cancel, false);
    dom.removeEventListener('pointerleave', handlers.leave, false);
    dom.removeEventListener('wheel', handlers.wheel, { passive: false });
    dom.removeEventListener('contextmenu', handlers.ctx, false);
    dom.removeEventListener('dblclick', handlers.dbl, false);
    if (trans) { trans.tw.cancel(); trans = null; }
    R.transitioning = false;
    lsn = { mode: [], pick: [], hover: [] };
    ptr.map = {}; ptr.count = 0;
    dom = null; cam = null;
  };

})(window, document);
