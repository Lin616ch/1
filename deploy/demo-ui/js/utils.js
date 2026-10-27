/* ============================================================================
 * utils.js —— 通用工具库
 * 命名空间：TP.Util
 * 依赖：无。加载顺序：紧跟 vendor 之后、theme-bridge 之前。
 * 约定：全部为纯函数或轻量状态容器，不触碰 DOM 结构（除 §DOM 一小节）。
 * ==========================================================================*/
(function (window) {
  'use strict';

  var TP = window.TP = window.TP || {};
  var U = TP.Util = {};

  /* ========================= 1. 数学 ========================= */

  U.clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
  U.clamp01 = function (v) { return v < 0 ? 0 : (v > 1 ? 1 : v); };
  U.lerp = function (a, b, t) { return a + (b - a) * t; };
  U.invLerp = function (a, b, v) { return a === b ? 0 : (v - a) / (b - a); };
  U.remap = function (v, a, b, c, d) { return U.lerp(c, d, U.clamp01(U.invLerp(a, b, v))); };
  U.smoothstep = function (t) { t = U.clamp01(t); return t * t * (3 - 2 * t); };
  U.dist = function (ax, az, bx, bz) { var dx = ax - bx, dz = az - bz; return Math.sqrt(dx * dx + dz * dz); };
  U.dist2 = function (ax, az, bx, bz) { var dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; };
  U.wrap = function (v, m) { return ((v % m) + m) % m; };
  U.round = function (v, d) { var p = Math.pow(10, d || 0); return Math.round(v * p) / p; };
  U.DEG = Math.PI / 180;
  U.RAD = 180 / Math.PI;

  /* ========================= 2. 缓动 ========================= */

  U.ease = {
    linear:     function (t) { return t; },
    inQuad:     function (t) { return t * t; },
    outQuad:    function (t) { return t * (2 - t); },
    inOutQuad:  function (t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; },
    inCubic:    function (t) { return t * t * t; },
    outCubic:   function (t) { var k = t - 1; return k * k * k + 1; },
    inOutCubic: function (t) { return t < 0.5 ? 4 * t * t * t : 1 + 4 * (t - 1) * (t - 1) * (t - 1); },
    outQuart:   function (t) { var k = t - 1; return 1 - k * k * k * k; },
    inOutQuart: function (t) { return t < 0.5 ? 8 * t * t * t * t : 1 - 8 * (t - 1) * (t - 1) * (t - 1) * (t - 1); },
    outQuint:   function (t) { var k = t - 1; return 1 + k * k * k * k * k; },
    inOutSine:  function (t) { return -(Math.cos(Math.PI * t) - 1) / 2; },
    outExpo:    function (t) { return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t); },
    inOutCirc:  function (t) { return t < 0.5
      ? (1 - Math.sqrt(1 - 4 * t * t)) / 2
      : (1 + Math.sqrt(1 - Math.pow(-2 * t + 2, 2))) / 2; },
    outBack:    function (t) { var c1 = 1.70158, c3 = c1 + 1, k = t - 1;
      return 1 + c3 * k * k * k + c1 * k * k; },
    outElastic: function (t) {
      if (t === 0 || t === 1) return t;
      var c4 = (2 * Math.PI) / 3;
      return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
    }
  };

  /* ========================= 3. 伪随机与噪声 =========================
   * 数据引擎要求「可复现」：同一 seed 必须得到同一序列，
   * 这样拖动时间轴来回擦洗时结果稳定。                            */

  U.mulberry32 = function (seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  U.hashStr = function (s) {
    var h = 2166136261 >>> 0;
    s = String(s);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };

  /** 建一个带便捷方法的随机源 */
  U.Rng = function (seed) {
    if (typeof seed === 'string') seed = U.hashStr(seed);
    if (seed == null) seed = 1;
    seed = seed >>> 0;
    var r = U.mulberry32(seed);
    var o = {};
    o.seed = seed;
    o.next = r;
    o.range = function (a, b) { return a + r() * (b - a); };
    o.int = function (a, b) { return Math.floor(a + r() * (b - a + 1)); };
    o.pick = function (arr) { return arr[Math.min(arr.length - 1, Math.floor(r() * arr.length))]; };
    o.chance = function (p) { return r() < p; };
    o.sign = function () { return r() < 0.5 ? -1 : 1; };
    o.gauss = function (mean, sd) {
      var u = 1 - r(), v = r();
      return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    o.shuffle = function (arr) {
      var a = arr.slice(), i, j, t;
      for (i = a.length - 1; i > 0; i--) { j = Math.floor(r() * (i + 1)); t = a[i]; a[i] = a[j]; a[j] = t; }
      return a;
    };
    /** 派生一个独立子序列，用于「每个实体各自的随机性」互不干扰 */
    o.fork = function (salt) { return U.Rng((seed ^ U.hashStr(String(salt))) >>> 0); };
    return o;
  };

  /** 2D 梯度噪声，返回约 [-1,1] */
  U.makeNoise2D = function (seed) {
    var r = U.mulberry32(seed == null ? 7 : seed >>> 0);
    var p = new Uint8Array(256), i, j, t;
    for (i = 0; i < 256; i++) p[i] = i;
    for (i = 255; i > 0; i--) { j = Math.floor(r() * (i + 1)); t = p[i]; p[i] = p[j]; p[j] = t; }
    var perm = new Uint8Array(512);
    for (i = 0; i < 512; i++) perm[i] = p[i & 255];

    function grad(h, x, y) {
      switch (h & 7) {
        case 0: return  x + y;
        case 1: return  x - y;
        case 2: return -x + y;
        case 3: return -x - y;
        case 4: return  x;
        case 5: return -x;
        case 6: return  y;
        default: return -y;
      }
    }
    function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

    return function (x, y) {
      var X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
      x -= Math.floor(x); y -= Math.floor(y);
      var u = fade(x), v = fade(y);
      var A = perm[X] + Y, B = perm[X + 1] + Y;
      var n00 = grad(perm[A], x, y);
      var n10 = grad(perm[B], x - 1, y);
      var n01 = grad(perm[A + 1], x, y - 1);
      var n11 = grad(perm[B + 1], x - 1, y - 1);
      return U.lerp(U.lerp(n00, n10, u), U.lerp(n01, n11, u), v);
    };
  };

  /** 分形叠加噪声 */
  U.fbm = function (noise, x, y, octaves, lacunarity, gain) {
    octaves = octaves || 4; lacunarity = lacunarity || 2; gain = gain == null ? 0.5 : gain;
    var amp = 1, freq = 1, sum = 0, norm = 0;
    for (var i = 0; i < octaves; i++) {
      sum += amp * noise(x * freq, y * freq);
      norm += amp;
      amp *= gain; freq *= lacunarity;
    }
    return norm ? sum / norm : 0;
  };

  /* ========================= 4. 补间（由主循环驱动） =========================
   * 用法：
   *   var h = U.tween({ from:0, to:1, dur:600, ease:'inOutCubic',
   *                     onUpdate:function(v,k){...}, onDone:function(){} });
   *   h.cancel();
   * 主循环每帧调用 U.Tween.update(dtMs)。                        */

  var tweens = [], tweenSeq = 0;

  U.tween = function (opt) {
    opt = opt || {};
    var t = {
      id: ++tweenSeq,
      from: opt.from == null ? 0 : opt.from,
      to: opt.to == null ? 1 : opt.to,
      dur: Math.max(1e-4, opt.dur == null ? 400 : opt.dur),
      delay: opt.delay || 0,
      ease: typeof opt.ease === 'function' ? opt.ease : (U.ease[opt.ease] || U.ease.inOutCubic),
      onUpdate: opt.onUpdate, onDone: opt.onDone, onStart: opt.onStart,
      elapsed: 0, started: false, dead: false
    };
    tweens.push(t);
    return {
      id: t.id,
      cancel: function () { t.dead = true; },
      get done() { return t.dead; }
    };
  };

  U.Tween = {
    update: function (dt) {
      if (!tweens.length) return;
      for (var i = 0; i < tweens.length; i++) {
        var t = tweens[i];
        if (t.dead) continue;
        if (t.delay > 0) { t.delay -= dt; if (t.delay > 0) continue; }
        if (!t.started) { t.started = true; if (t.onStart) t.onStart(); }
        t.elapsed += dt;
        var k = U.clamp01(t.elapsed / t.dur);
        var v = t.from + (t.to - t.from) * t.ease(k);
        if (t.onUpdate) t.onUpdate(v, k);
        if (k >= 1) { t.dead = true; if (t.onDone) t.onDone(); }
      }
      for (var j = tweens.length - 1; j >= 0; j--) if (tweens[j].dead) tweens.splice(j, 1);
    },
    clear: function () { tweens.length = 0; },
    count: function () { return tweens.length; }
  };

  /* ========================= 5. 节流 / 防抖 ========================= */

  U.throttle = function (fn, wait) {
    var last = -1e9, timer = null, lastArgs = null, ctx = null;
    return function () {
      var now = U.now();
      ctx = this; lastArgs = arguments;
      if (now - last >= wait) {
        last = now;
        fn.apply(ctx, lastArgs);
      } else if (!timer) {
        timer = setTimeout(function () {
          timer = null; last = U.now();
          fn.apply(ctx, lastArgs);
        }, wait - (now - last));
      }
    };
  };

  U.debounce = function (fn, wait) {
    var timer = null;
    return function () {
      var ctx = this, args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(ctx, args); }, wait);
    };
  };

  U.now = function () {
    return (window.performance && window.performance.now)
      ? window.performance.now() : Date.now();
  };

  U.uid = (function () { var n = 0; return function (p) { return (p || 'id') + '_' + (++n); }; })();

  /** file:// 下 localStorage 可能抛异常，一律包裹 */
  U.store = {
    get: function (k, fb) {
      try { var v = window.localStorage.getItem(k); return v == null ? fb : JSON.parse(v); }
      catch (e) { return fb; }
    },
    set: function (k, v) {
      try { window.localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ }
    }
  };

  /* ========================= 6. DOM ========================= */

  U.$ = function (sel, root) { return (root || document).querySelector(sel); };
  U.$$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  /** U.el('div', {class:'a', dataset:{x:1}, style:{top:'2px'}, onclick:fn, html:'<b/>'}) */
  U.el = function (tag, attrs, inner) {
    var e = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class' || k === 'className') e.className = v;
        else if (k === 'html') e.innerHTML = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'style' && typeof v === 'object') {
          for (var s in v) if (Object.prototype.hasOwnProperty.call(v, s)) e.style[s] = v[s];
        } else if (k === 'dataset' && typeof v === 'object') {
          for (var d in v) if (Object.prototype.hasOwnProperty.call(v, d)) e.dataset[d] = v[d];
        } else if (k.indexOf('on') === 0 && typeof v === 'function') {
          e.addEventListener(k.slice(2).toLowerCase(), v);
        } else {
          e.setAttribute(k, v);
        }
      }
    }
    if (inner != null) {
      if (inner.nodeType) e.appendChild(inner);
      else e.innerHTML = inner;
    }
    return e;
  };

  U.clear = function (e) { while (e && e.firstChild) e.removeChild(e.firstChild); return e; };
  U.on = function (el, type, fn, opt) { if (el) el.addEventListener(type, fn, opt || false); return fn; };
  U.off = function (el, type, fn, opt) { if (el) el.removeEventListener(type, fn, opt || false); };

  U.delegate = function (root, type, sel, fn) {
    return U.on(root, type, function (ev) {
      var t = ev.target;
      while (t && t !== root) {
        if (t.matches && t.matches(sel)) { fn.call(t, ev, t); return; }
        t = t.parentNode;
      }
    });
  };

  U.addClass    = function (e, c) { if (e) e.classList.add(c); };
  U.removeClass = function (e, c) { if (e) e.classList.remove(c); };
  U.setClass    = function (e, c, on) { if (e) { if (on) e.classList.add(c); else e.classList.remove(c); } };
  U.hasClass    = function (e, c) { return !!(e && e.classList && e.classList.contains(c)); };
  U.show = function (e) { U.removeClass(e, 'is-hidden'); };
  U.hide = function (e) { U.addClass(e, 'is-hidden'); };

  U.setHTML = function (e, html) { if (e) e.innerHTML = html; return e; };
  U.setText = function (e, txt) { if (e) e.textContent = txt; return e; };
  U.setStyle = function (e, prop, val) { if (e) e.style[prop] = val; return e; };

  /** 等待布局稳定后执行（ECharts 需要容器有尺寸） */
  U.nextFrame = function (fn) {
    if (window.requestAnimationFrame) window.requestAnimationFrame(function () { fn(); });
    else setTimeout(fn, 16);
  };

  /* ========================= 7. 格式化 ========================= */

  U.int = function (v) {
    var n = Math.round(v);
    var s = String(Math.abs(n));
    var out = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (n < 0 ? '-' : '') + out;
  };

  U.fixed = function (v, d) {
    d = d || 0;
    if (!isFinite(v)) v = 0;
    return v.toFixed(d);
  };

  U.pct = function (v, d) { return U.fixed(v, d == null ? 1 : d) + '%'; };

  U.pad2 = function (n) { n = Math.floor(n); return (n < 10 ? '0' : '') + n; };

  /** 分钟数(0..1439) → 'HH:MM' */
  U.hhmm = function (min) {
    min = U.wrap(Math.round(min), 1440);
    return U.pad2(min / 60) + ':' + U.pad2(min % 60);
  };

  U.hms = function (d) {
    return U.pad2(d.getHours()) + ':' + U.pad2(d.getMinutes()) + ':' + U.pad2(d.getSeconds());
  };

  U.dateCN = function (d) {
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 星期' +
      '日一二三四五六'.charAt(d.getDay());
  };

  /** 大数压缩：12345 → '1.2万' */
  U.compact = function (v) {
    var a = Math.abs(v);
    if (a >= 1e8) return U.fixed(v / 1e8, 2) + '亿';
    if (a >= 1e4) return U.fixed(v / 1e4, 1) + '万';
    return U.int(v);
  };

  U.signed = function (v, d) { return (v > 0 ? '+' : '') + U.fixed(v, d == null ? 1 : d); };

  /* ========================= 8. 颜色 ========================= */

  /** 支持 '#rgb' '#rrggbb' '#rrggbbaa' 'rgb()' 'rgba()'；返回 {r,g,b,a} */
  U.parseColor = function (c) {
    if (c == null) return { r: 0, g: 0, b: 0, a: 1 };
    if (typeof c === 'object' && 'r' in c) return { r: c.r, g: c.g, b: c.b, a: c.a == null ? 1 : c.a };
    c = String(c).trim();
    var m;
    if (c.charAt(0) === '#') {
      var h = c.slice(1);
      if (h.length === 3) {
        return {
          r: parseInt(h[0] + h[0], 16),
          g: parseInt(h[1] + h[1], 16),
          b: parseInt(h[2] + h[2], 16),
          a: 1
        };
      }
      if (h.length === 6 || h.length === 8) {
        return {
          r: parseInt(h.slice(0, 2), 16),
          g: parseInt(h.slice(2, 4), 16),
          b: parseInt(h.slice(4, 6), 16),
          a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
        };
      }
    }
    m = c.match(/rgba?\(([^)]+)\)/i);
    if (m) {
      var p = m[1].split(',');
      return {
        r: parseFloat(p[0]) || 0,
        g: parseFloat(p[1]) || 0,
        b: parseFloat(p[2]) || 0,
        a: p.length > 3 ? (parseFloat(p[3]) || 0) : 1
      };
    }
    return { r: 0, g: 0, b: 0, a: 1 };
  };

  U.rgba = function (r, g, b, a) {
    return 'rgba(' + Math.round(r) + ',' + Math.round(g) + ',' + Math.round(b) + ',' +
      (a == null ? 1 : a) + ')';
  };

  U.toRgba = function (c, a) {
    var o = U.parseColor(c);
    return U.rgba(o.r, o.g, o.b, a == null ? o.a : a);
  };

  /** 两色线性插值，返回 'rgb(...)' */
  U.mix = function (c1, c2, t) {
    var a = U.parseColor(c1), b = U.parseColor(c2);
    t = U.clamp01(t);
    return U.rgba(
      U.lerp(a.r, b.r, t),
      U.lerp(a.g, b.g, t),
      U.lerp(a.b, b.b, t),
      U.lerp(a.a, b.a, t)
    );
  };

  /** 多段色带取色。stops 可为 hex 数组或 [{c:hex,p:0..1}] 数组 */
  U.ramp = function (stops, t) {
    if (!stops || !stops.length) return '#000';
    t = U.clamp01(t);
    var pts = stops;
    if (typeof stops[0] === 'string') {
      pts = stops.map(function (c, i) {
        return { c: c, p: stops.length === 1 ? 0 : i / (stops.length - 1) };
      });
    }
    if (t <= pts[0].p) return pts[0].c;
    if (t >= pts[pts.length - 1].p) return pts[pts.length - 1].c;
    for (var i = 0; i < pts.length - 1; i++) {
      var a = pts[i], b = pts[i + 1];
      if (t >= a.p && t <= b.p) return U.mix(a.c, b.c, U.invLerp(a.p, b.p, t));
    }
    return pts[pts.length - 1].c;
  };

  /** 提亮(amt>0)/压暗(amt<0)，amt 为 -1..1 */
  U.shade = function (c, amt) {
    var o = U.parseColor(c);
    var f = amt < 0 ? 0 : 255;
    var t = Math.abs(amt);
    return U.rgba(U.lerp(o.r, f, t), U.lerp(o.g, f, t), U.lerp(o.b, f, t), o.a);
  };

  /** '#rrggbb' → 0xrrggbb（给 Three.js 用） */
  U.hexInt = function (c) {
    var o = U.parseColor(c);
    return (Math.round(o.r) << 16) | (Math.round(o.g) << 8) | Math.round(o.b);
  };

  /* ========================= 9. 几何 ========================= */

  /** 射线法判断点是否在多边形内。poly 为 [[x,z],...] */
  U.pointInPolygon = function (x, z, poly) {
    if (!poly || poly.length < 3) return false;
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i][0], zi = poly[i][1];
      var xj = poly[j][0], zj = poly[j][1];
      var hit = ((zi > z) !== (zj > z)) &&
                (x < (xj - xi) * (z - zi) / ((zj - zi) || 1e-9) + xi);
      if (hit) inside = !inside;
    }
    return inside;
  };

  /** 多边形面积（绝对值），单位与输入一致 */
  U.polygonArea = function (poly) {
    if (!poly || poly.length < 3) return 0;
    var s = 0;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      s += (poly[j][0] * poly[i][1]) - (poly[i][0] * poly[j][1]);
    }
    return Math.abs(s) / 2;
  };

  /** 多边形形心 */
  U.polygonCentroid = function (poly) {
    if (!poly || !poly.length) return { x: 0, z: 0 };
    var cx = 0, cz = 0, a = 0;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var f = (poly[j][0] * poly[i][1]) - (poly[i][0] * poly[j][1]);
      a += f;
      cx += (poly[j][0] + poly[i][0]) * f;
      cz += (poly[j][1] + poly[i][1]) * f;
    }
    if (Math.abs(a) < 1e-9) {
      var sx = 0, sz = 0;
      for (var k = 0; k < poly.length; k++) { sx += poly[k][0]; sz += poly[k][1]; }
      return { x: sx / poly.length, z: sz / poly.length };
    }
    a *= 0.5;
    return { x: cx / (6 * a), z: cz / (6 * a) };
  };

  /** 折线总长度；pts 为 [{x,z}] 或 [[x,z]] */
  U.polylineLength = function (pts) {
    if (!pts || pts.length < 2) return 0;
    var L = 0, ax, az, bx, bz;
    for (var i = 0; i < pts.length - 1; i++) {
      var a = pts[i], b = pts[i + 1];
      ax = (a.x !== undefined ? a.x : a[0]); az = (a.z !== undefined ? a.z : a[1]);
      bx = (b.x !== undefined ? b.x : b[0]); bz = (b.z !== undefined ? b.z : b[1]);
      L += Math.sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az));
    }
    return L;
  };

  /** 沿折线按累计弧长归一化取点，返回 {x,z,angle}。t 为 0..1，超出会环绕 */
  U.pointAlongPolyline = function (pts, t) {
    var n = pts.length;
    if (n === 0) return { x: 0, z: 0, angle: 0 };
    if (n === 1) return { x: pts[0].x !== undefined ? pts[0].x : pts[0][0],
                          z: pts[0].z !== undefined ? pts[0].z : pts[0][1], angle: 0 };
    var segs = [], total = 0, i;
    for (i = 0; i < n - 1; i++) {
      var a = pts[i], b = pts[i + 1];
      var ax = a.x !== undefined ? a.x : a[0], az = a.z !== undefined ? a.z : a[1];
      var bx = b.x !== undefined ? b.x : b[0], bz = b.z !== undefined ? b.z : b[1];
      var L = Math.sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az));
      segs.push({ ax: ax, az: az, bx: bx, bz: bz, len: L });
      total += L;
    }
    if (total < 1e-6) {
      var p0 = pts[0];
      return { x: p0.x !== undefined ? p0.x : p0[0], z: p0.z !== undefined ? p0.z : p0[1], angle: 0 };
    }
    t = U.clamp01(t);
    var d = t * total;
    for (i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (d <= s.len || i === segs.length - 1) {
        var k = s.len < 1e-9 ? 0 : d / s.len;
        return {
          x: U.lerp(s.ax, s.bx, k),
          z: U.lerp(s.az, s.bz, k),
          angle: Math.atan2(s.bz - s.az, s.bx - s.ax)
        };
      }
      d -= s.len;
    }
    var last = segs[segs.length - 1];
    return { x: last.bx, z: last.bz, angle: Math.atan2(last.bz - last.az, last.bx - last.ax) };
  };

  /** 点到折线的最短距离 */
  U.distToPolyline = function (x, z, pts) {
    if (!pts || pts.length === 0) return Infinity;
    if (pts.length === 1) {
      var p = pts[0];
      return U.dist(x, z, p.x !== undefined ? p.x : p[0], p.z !== undefined ? p.z : p[1]);
    }
    var best = Infinity;
    for (var i = 0; i < pts.length - 1; i++) {
      var a = pts[i], b = pts[i + 1];
      var ax = a.x !== undefined ? a.x : a[0], az = a.z !== undefined ? a.z : a[1];
      var bx = b.x !== undefined ? b.x : b[0], bz = b.z !== undefined ? b.z : b[1];
      var dx = bx - ax, dz = bz - az;
      var L2 = dx * dx + dz * dz;
      var k = L2 < 1e-9 ? 0 : U.clamp01(((x - ax) * dx + (z - az) * dz) / L2);
      var d = U.dist(x, z, ax + dx * k, az + dz * k);
      if (d < best) best = d;
    }
    return best;
  };

  /* ========================= 10. 交通专用小工具 ========================= */

  /** 拥堵等级：0 畅通 / 1 缓行 / 2 拥堵 / 3 严重拥堵 */
  U.congestionLevel = function (speedRatio) {
    if (speedRatio >= 0.75) return 0;
    if (speedRatio >= 0.5) return 1;
    if (speedRatio >= 0.3) return 2;
    return 3;
  };

  U.LEVEL_KEY   = ['free', 'slow', 'jam', 'block'];
  U.LEVEL_CN    = ['畅通', '缓行', '拥堵', '严重拥堵'];
  U.LEVEL_SHORT = ['畅通', '缓行', '拥堵', '严重'];

  /** 指数移动平滑，用于实时数值不跳变 */
  U.Smoother = function (halfLifeMs) {
    this.halfLife = halfLifeMs == null ? 500 : halfLifeMs;
    this.value = null;
  };
  U.Smoother.prototype.push = function (target, dt) {
    if (this.value == null) { this.value = target; return this.value; }
    var k = 1 - Math.pow(0.5, dt / this.halfLife);
    this.value += (target - this.value) * k;
    return this.value;
  };
  U.Smoother.prototype.reset = function (v) { this.value = v == null ? null : v; };

  /** 环形缓冲，用于滚动窗口统计 */
  U.Ring = function (n) { this.n = n; this.arr = []; };
  U.Ring.prototype.push = function (v) {
    this.arr.push(v);
    if (this.arr.length > this.n) this.arr.shift();
    return this;
  };
  U.Ring.prototype.get = function (i) { return this.arr[i]; };
  U.Ring.prototype.last = function () { return this.arr[this.arr.length - 1]; };
  U.Ring.prototype.mean = function () {
    if (!this.arr.length) return 0;
    var s = 0;
    for (var i = 0; i < this.arr.length; i++) s += this.arr[i];
    return s / this.arr.length;
  };
  U.Ring.prototype.max = function () { return this.arr.length ? Math.max.apply(null, this.arr) : 0; };
  U.Ring.prototype.clear = function () { this.arr.length = 0; return this; };

})(window);
