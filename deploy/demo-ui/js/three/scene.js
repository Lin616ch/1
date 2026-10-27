/* ============================================================================
 * scene.js —�?渲染�?/ 相机 / 光照 / 天空 / �?/ 地面 / 网格 / 标签投影 / 自适应画质
 * 命名空间：TP.Scene
 * 依赖：THREE(r128)、TP.Util、TP.Theme
 * 约定�? *   - 所有颜色走 TP.Theme；输出为 sRGB，因此一�?THREE 颜色都先转线性（TP.Scene.color）�? *   - update(dt) 必须�?TP.CameraRig.update(dt) 之后调用：阴影跟�?+ 标签投影依赖最新相机�? * ==========================================================================*/
(function (window, document) {
  'use strict';

  var TP = window.TP = window.TP || {};
  var U = TP.Util;
  var THREE = window.THREE;

  var S = TP.Scene = {
    ready: false,
    scene: null, camera: null, renderer: null,
    world: null, dataGroup: null,
    quality: 1,
    stats: { fps: 0, drawCalls: 0, triangles: 0, quality: 1, level: 0, frameMs: 0 },
    _log: [],
    /* ͳһ�Ĳ�߱�����絥λ����ƽ��ͼ��֮�������� + ��̬ near ƽ�棬�ž� z-fighting */
    Y: { ground: -0.8, grid: -0.7, water: -0.4, green: 0.2, heat: 0.3, carbon: 0.32, casing: 0.45, disc: 0.6,
         road: { branch: 0.75, secondary: 0.85, arterial: 0.95, expressway: 1.05 }, overlay: 1.2, district: 1.4, bus: 2.5, metro: 4 }
  };

  var host = null, labelLayer = null;
  var hemi = null, sun = null, fill = null;
  var ground = null, shadowCatcher = null, gridMinor = null, gridMajor = null;
  var skyTex = null;
  var labels = [];
  var resizeFns = [];
  var raycaster = null, ndc = null, groundPlane = null, tmpV = null, tmpV2 = null;
  var opts = { shadows: true, grid: true, fog: true, buildings: true };
  var hostW = 1, hostH = 1;
  var ro = null;

  /* 主光相对 target 的偏移（西南偏上，与建筑逐面明暗约定一致：-X/+Z 面受光） */
  var SUN_OFFSET = null;
  var SHADOW_EXTENT = 650;

  /* ----------------------------------------------------------------- 颜色 */
  /** 令牌 �?线性空�?THREE.Color（因�?renderer.outputEncoding = sRGB�?*/
  S.color = function (token) {
    return new THREE.Color(TP.Theme.hex(token)).convertSRGBToLinear();
  };
  /** 任意 css 颜色字符串（hex / rgb()）→ 线�?THREE.Color */
  S.colorOf = function (css, out) {
    var c = U.parseColor(css);
    out = out || new THREE.Color();
    out.setRGB(c.r / 255, c.g / 255, c.b / 255);
    return out.convertSRGBToLinear();
  };

  function log(msg) {
    var line = U.hhmm(new Date().getHours() * 60 + new Date().getMinutes()) + ' ' + msg;
    S._log.push(line);
    if (S._log.length > 80) S._log.shift();
  }
  S.log = log;

  /* ----------------------------------------------------------------- 天空 */
  function makeSkyTexture() {
    var c = document.createElement('canvas');
    c.width = 4; c.height = 512;
    var g = c.getContext('2d');
    var top = TP.Theme.hex('--stage-sky-top'), bot = TP.Theme.hex('--stage-sky-bottom');
    var fog = TP.Theme.hex('--stage-fog');
    var grd = g.createLinearGradient(0, 0, 0, 512);
    grd.addColorStop(0.00, top);
    grd.addColorStop(0.30, U.mix(top, bot, 0.35));
    grd.addColorStop(0.58, U.mix(top, bot, 0.80));   /* 地平线附近宽缓过�?*/
    grd.addColorStop(0.78, bot);
    grd.addColorStop(1.00, fog);
    g.fillStyle = grd;
    g.fillRect(0, 0, 4, 512);
    var t = new THREE.CanvasTexture(c);
    t.encoding = THREE.sRGBEncoding;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    return t;
  }

  /* ----------------------------------------------------------------- 初始�?*/
  S.init = function (hostEl) {
    if (S.ready) return S;
    if (!THREE) throw new Error('TP.Scene: THREE 未加载');
    host = hostEl || document.getElementById('canvas-host') || document.body;
    var cs = window.getComputedStyle(host);
    if (cs.position === 'static') host.style.position = 'relative';

    raycaster = new THREE.Raycaster();
    ndc = new THREE.Vector2();
    groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    tmpV = new THREE.Vector3(); tmpV2 = new THREE.Vector3();
    SUN_OFFSET = new THREE.Vector3(-0.46, 0.80, 0.38).normalize().multiplyScalar(1400);

    var r = S.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    r.outputEncoding = THREE.sRGBEncoding;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) * S.quality);
    r.domElement.style.display = 'block';
    r.domElement.style.width = '100%';
    r.domElement.style.height = '100%';
    r.domElement.style.touchAction = 'none';
    r.domElement.className = 'tp-canvas';
    host.appendChild(r.domElement);

    var sc = S.scene = new THREE.Scene();
    skyTex = makeSkyTexture();
    sc.background = skyTex;
    sc.fog = new THREE.Fog(S.color('--stage-fog'), 900, 3000);

    var cam = S.camera = new THREE.PerspectiveCamera(42, 1, 1, 7000);
    cam.position.set(0, 900, 1250);
    cam.lookAt(0, 0, 0);

    /* 光照：半�?+ 主光(投影) + 反向补光 */
    hemi = new THREE.HemisphereLight(S.color('--stage-sky-top'), S.color('--stage-ground'), 0.75);
    sc.add(hemi);

    sun = new THREE.DirectionalLight(0xffffff, 0.6);
    sun.position.copy(SUN_OFFSET);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    var scam = sun.shadow.camera;
    scam.left = -SHADOW_EXTENT; scam.right = SHADOW_EXTENT;
    scam.top = SHADOW_EXTENT; scam.bottom = -SHADOW_EXTENT;
    scam.near = 50; scam.far = 3200;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.4;
    sc.add(sun);
    sc.add(sun.target);

    fill = new THREE.DirectionalLight(0xffffff, 0.25);
    fill.position.set(0.55, 0.55, -0.62).multiplyScalar(1000);
    sc.add(fill);

    /* 地面：MeshBasic 保证与令牌色一致；另叠一�?ShadowMaterial 接收柔和阴影 */
    var gGeo = new THREE.PlaneGeometry(14000, 14000);
    gGeo.rotateX(-Math.PI / 2);
    ground = new THREE.Mesh(gGeo, new THREE.MeshBasicMaterial({ color: S.color('--stage-ground') }));
    ground.name = 'ground';
    ground.renderOrder = -10;
    ground.position.y = S.Y.ground;
    sc.add(ground);

    shadowCatcher = new THREE.Mesh(gGeo, new THREE.ShadowMaterial({ opacity: 0.16, color: S.color('--c-text') }));
    shadowCatcher.position.y = S.Y.ground + 0.05;
    shadowCatcher.receiveShadow = true;
    shadowCatcher.renderOrder = -8;
    sc.add(shadowCatcher);

    buildGrids();

    S.world = new THREE.Group(); S.world.name = 'world';
    S.dataGroup = new THREE.Group(); S.dataGroup.name = 'data';
    sc.add(S.world); sc.add(S.dataGroup);

    /* 标签�?*/
    labelLayer = document.createElement('div');
    labelLayer.className = 'tp-label-layer';
    var ls = labelLayer.style;
    ls.position = 'absolute'; ls.left = '0'; ls.top = '0'; ls.right = '0'; ls.bottom = '0';
    ls.pointerEvents = 'none'; ls.overflow = 'hidden'; ls.zIndex = '2';
    host.appendChild(labelLayer);
    injectLabelStyle();

    S.resize();
    if (window.ResizeObserver) {
      ro = new window.ResizeObserver(function () { S.resize(); });
      ro.observe(host);
    }
    window.addEventListener('resize', S.resize, false);

    S.ready = true;
    log('init ok, dpr=' + (window.devicePixelRatio || 1));
    return S;
  };

  function buildGrids() {
    if (gridMinor) { S.scene.remove(gridMinor); gridMinor.geometry.dispose(); gridMinor.material.dispose(); }
    if (gridMajor) { S.scene.remove(gridMajor); gridMajor.geometry.dispose(); gridMajor.material.dispose(); }
    var cMinor = S.color('--stage-grid'), cMajor = S.color('--stage-grid-major');
    gridMinor = new THREE.GridHelper(2000, 125, cMinor, cMinor);
    gridMinor.material.transparent = true; gridMinor.material.opacity = 0.55; gridMinor.material.depthWrite = false;
    gridMinor.position.y = S.Y.grid; gridMinor.renderOrder = -6;
    gridMajor = new THREE.GridHelper(2000, 25, cMajor, cMajor);
    gridMajor.material.transparent = true; gridMajor.material.opacity = 0.85; gridMajor.material.depthWrite = false;
    gridMajor.position.y = S.Y.grid + 0.02; gridMajor.renderOrder = -5;
    gridMinor.visible = gridMajor.visible = opts.grid;
    S.scene.add(gridMinor); S.scene.add(gridMajor);
  }

  /* 标签的默认外观：�?:where() 零优先级，UI �?css 只要写了 .bld-label 就会覆盖�?*/
  function injectLabelStyle() {
    var id = 'tp-scene-label-style';
    var el = document.getElementById(id);
    if (!el) { el = document.createElement('style'); el.id = id; document.head.appendChild(el); }
    var T = TP.Theme;
    el.textContent =
      ':where(.tp-label-layer) > :where(.bld-label){position:absolute;left:0;top:0;white-space:nowrap;' +
      'font:12px/1.4 "Microsoft YaHei","PingFang SC",sans-serif;color:' + T.hex('--c-text') + ';' +
      'background:' + T.rgba('--c-panel', 0.92) + ';border:1px solid ' + T.hex('--c-border') + ';' +
      'border-radius:4px;padding:2px 8px;box-shadow:0 2px 8px ' + T.v('--c-shadow') + ';}' +
      ':where(.tp-label-layer) > :where(.bld-label--district){font-weight:600;font-size:13px;color:' + T.hex('--c-primary-deep') + ';' +
      'background:' + T.rgba('--c-panel', 0.78) + ';letter-spacing:2px;}' +
      ':where(.tp-label-layer) > :where(.bld-label--landmark){font-size:11px;color:' + T.hex('--c-text-sub') + ';}' +
      ':where(.tp-label-layer) > :where(.bld-label--incident){font-size:11px;color:' + T.hex('--c-danger') + ';' +
      'border-color:' + T.rgba('--c-danger', 0.45) + ';}';
  }

  /* ----------------------------------------------------------------- 尺寸 */
  S.resize = function () {
    if (!S.renderer || !host) return;
    var w = host.clientWidth || window.innerWidth || 1;
    var h = host.clientHeight || window.innerHeight || 1;
    var changed = (w !== hostW || h !== hostH);
    hostW = w; hostH = h;
    S.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) * S.quality);
    S.renderer.setSize(w, h, false);
    S.camera.aspect = w / h;
    S.camera.updateProjectionMatrix();
    if (changed) for (var i = 0; i < resizeFns.length; i++) { try { resizeFns[i](w, h); } catch (e) { /* noop */ } }
  };
  S.onResize = function (fn) { if (typeof fn === 'function') resizeFns.push(fn); return fn; };
  S.size = function () { return { w: hostW, h: hostH }; };

  /* ----------------------------------------------------------------- 画质 */
  S.setQuality = function (q) {
    q = U.clamp(+q || 1, 0.5, 1);
    S.quality = q; S.stats.quality = q;
    if (S.renderer) {
      S.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) * q);
      S.renderer.setSize(hostW, hostH, false);
    }
  };

  /* 自适应降级：level 0 满配 �?1 pixelRatio .8 �?2 pixelRatio .6 �?3 关阴�?�?4 粒子减半 */
  var adapt = { ema: 60, low: 0, high: 0, cool: 0, acc: 0, level: 0, enabled: true, userShadows: true };
  function applyLevel(lv) {
    adapt.level = lv; S.stats.level = lv;
    S.setQuality(lv >= 2 ? 0.6 : (lv >= 1 ? 0.8 : 1));
    setShadows(adapt.userShadows && lv < 3);
    if (TP.Layers && TP.Layers.setParticleScale) TP.Layers.setParticleScale(lv >= 4 ? 0.5 : 1);
  }
  S.setAdaptive = function (on) { adapt.enabled = !!on; if (!on) applyLevel(0); };

  function adaptTick(dt) {
    if (dt <= 0 || dt > 250) return;                 /* 切后�?/ 卡顿尖刺不计 */
    var fps = 1000 / dt;
    adapt.ema += (fps - adapt.ema) * Math.min(1, dt / 500);
    adapt.acc += dt;
    if (adapt.cool > 0) adapt.cool -= dt;
    if (adapt.acc < 1000) return;                    /* 每秒评估一�?*/
    adapt.acc = 0;
    if (!adapt.enabled) return;
    if (adapt.ema < 40) { adapt.low++; adapt.high = 0; }
    else if (adapt.ema > 56) { adapt.high++; adapt.low = 0; }
    else { adapt.low = 0; adapt.high = 0; }
    if (adapt.cool > 0) return;
    if (adapt.low >= 2 && adapt.level < 4) {
      applyLevel(adapt.level + 1); adapt.low = 0; adapt.cool = 3000;
      log('降级 → L' + adapt.level + ' (fps≈' + adapt.ema.toFixed(1) + ')');
    } else if (adapt.high >= 6 && adapt.level > 0) {
      applyLevel(adapt.level - 1); adapt.high = 0; adapt.cool = 5000;
      log('恢复 → L' + adapt.level + ' (fps≈' + adapt.ema.toFixed(1) + ')');
    }
  }

  function setShadows(on) {
    if (!S.renderer) return;
    if (sun.castShadow === on) return;
    sun.castShadow = on;
    shadowCatcher.visible = on;
    /* 切换阴影需要材质重编译 */
    S.scene.traverse(function (o) { if (o.material) { var m = o.material; if (m.length) { for (var i = 0; i < m.length; i++) m[i].needsUpdate = true; } else m.needsUpdate = true; } });
  }

  S.setOption = function (key, value) {
    value = !!value;
    opts[key] = value;
    if (key === 'shadows') { adapt.userShadows = value; setShadows(value && adapt.level < 3); }
    else if (key === 'grid') { if (gridMinor) gridMinor.visible = gridMajor.visible = value; }
    else if (key === 'fog') { S.scene.fog = value ? new THREE.Fog(S.color('--stage-fog'), 900, 3000) : null; markAll(); }
    else if (key === 'buildings') { if (TP.CityBuilder && TP.CityBuilder.setBuildingsVisible) TP.CityBuilder.setBuildingsVisible(value); }
    else if (key === 'adaptive') { S.setAdaptive(value); }
  };
  S.getOption = function (key) { return opts[key]; };
  function markAll() { S.scene.traverse(function (o) { if (o.material && !o.material.length) o.material.needsUpdate = true; }); }

  /* ----------------------------------------------------------------- 换肤 */
  S.applyTheme = function () {
    if (!S.ready) return;
    if (skyTex) skyTex.dispose();
    skyTex = makeSkyTexture();
    S.scene.background = skyTex;
    if (S.scene.fog) S.scene.fog.color.copy(S.color('--stage-fog'));
    hemi.color.copy(S.color('--stage-sky-top'));
    hemi.groundColor.copy(S.color('--stage-ground'));
    ground.material.color.copy(S.color('--stage-ground'));
    shadowCatcher.material.color.copy(S.color('--c-text'));
    buildGrids();
    injectLabelStyle();
  };
  if (TP.Theme && TP.Theme.onChange) TP.Theme.onChange(function () { if (S.ready) S.applyTheme(); });

  /* ----------------------------------------------------------------- 每帧 */
  var lastFrameT = 0, fpsAcc = 0, fpsN = 0, snapV = null;
  S.update = function (dt) {
    if (!S.ready) return;
    dt = dt || 16.7;
    var cam = S.camera;
    cam.updateMatrixWorld();

    /* 1) 阴影跟随：主光与�?target 一起跟�?CameraRig.target，并按阴影贴�?texel 对齐防闪�?*/
    var t = (TP.CameraRig && TP.CameraRig.target) ? TP.CameraRig.target : null;
    var dist = (TP.CameraRig && TP.CameraRig.distance) ? TP.CameraRig.distance : 1500;
    if (t) {
      var ext = SHADOW_EXTENT * U.clamp(dist / 1500, 1, 1.5);   /* 远景时略放大，避免阴影断边；近景保持 ±650 最清晰 */
      var sc = sun.shadow.camera;
      if (Math.abs(sc.right - ext) > 1) {
        sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.updateProjectionMatrix();
      }
      var texel = (2 * ext) / sun.shadow.mapSize.x;
      if (!snapV) snapV = new THREE.Vector3();
      /* 在光源视空间对齐：取光的 right/up �?*/
      var fwd = tmpV.copy(SUN_OFFSET).normalize().negate();
      var right = tmpV2.set(0, 1, 0).cross(fwd).normalize();
      var up = snapV.copy(fwd).cross(right).normalize();
      var pr = t.x * right.x + t.y * right.y + t.z * right.z;
      var pu = t.x * up.x + t.y * up.y + t.z * up.z;
      var pf = t.x * fwd.x + t.y * fwd.y + t.z * fwd.z;
      pr = Math.round(pr / texel) * texel; pu = Math.round(pu / texel) * texel;
      var tx = right.x * pr + up.x * pu + fwd.x * pf;
      var ty = right.y * pr + up.y * pu + fwd.y * pf;
      var tz = right.z * pr + up.z * pu + fwd.z * pf;
      sun.target.position.set(tx, ty, tz);
      sun.position.set(tx + SUN_OFFSET.x, ty + SUN_OFFSET.y, tz + SUN_OFFSET.z);
      sun.target.updateMatrixWorld();
    }

    /* 2) 雾随视距自适应：俯视拉远时不至于整城被雾吞�?*/
    if (S.scene.fog) {
      var extra = Math.max(0, dist - 900);
      S.scene.fog.near = 900 + extra * 0.85;
      S.scene.fog.far = 3000 + extra * 1.3;
    }
    /* 地面网格在超远距离淡出，降低摩尔�?*/
    if (gridMinor && opts.grid) {
      gridMinor.material.opacity = 0.55 * U.clamp(1.6 - dist / 1800, 0.25, 1);
    }

    /* 3) 标签投影 */
    updateLabels();

    /* 4) 统计与自适应 */
    fpsAcc += dt; fpsN++;
    if (fpsAcc >= 500) { S.stats.fps = Math.round(1000 * fpsN / fpsAcc * 10) / 10; fpsAcc = 0; fpsN = 0; }
    S.stats.frameMs = dt;
    adaptTick(dt);
  };

  S.render = function () {
    if (!S.ready) return;
    S.renderer.render(S.scene, S.camera);
    var info = S.renderer.info.render;
    S.stats.drawCalls = info.calls;
    S.stats.triangles = info.triangles;
    S.stats.quality = S.quality;
  };

  /* ----------------------------------------------------------------- 投影 / 拾取 */
  S.screenPos = function (x, y, z) {
    var v = tmpV.set(x, y, z);
    var cam = S.camera;
    var depth = v.distanceTo(cam.position);
    v.project(cam);
    var vis = v.z > -1 && v.z < 1 && v.x > -1.15 && v.x < 1.15 && v.y > -1.15 && v.y < 1.15;
    return { x: (v.x * 0.5 + 0.5) * hostW, y: (-v.y * 0.5 + 0.5) * hostH, visible: vis, depth: depth };
  };

  function setRay(px, py) {
    ndc.set((px / hostW) * 2 - 1, -(py / hostH) * 2 + 1);
    raycaster.setFromCamera(ndc, S.camera);
  }

  S.raycast = function (px, py, objects) {
    if (!S.ready || !objects || !objects.length) return null;
    setRay(px, py);
    var list = [];
    for (var i = 0; i < objects.length; i++) if (objects[i] && isVisible(objects[i])) list.push(objects[i]);
    if (!list.length) return null;
    var hits = raycaster.intersectObjects(list, false);
    if (!hits.length) return null;
    var h = hits[0];
    return {
      object: h.object, point: { x: h.point.x, y: h.point.y, z: h.point.z },
      instanceId: h.instanceId == null ? null : h.instanceId,
      faceIndex: h.faceIndex == null ? null : h.faceIndex,
      face: h.face || null, distance: h.distance
    };
  };
  function isVisible(o) { while (o) { if (!o.visible) return false; o = o.parent; } return true; }

  S.groundPoint = function (px, py) {
    if (!S.ready) return null;
    setRay(px, py);
    var p = raycaster.ray.intersectPlane(groundPlane, tmpV2);
    if (!p) return null;
    return { x: p.x, z: p.z };
  };

  /* ----------------------------------------------------------------- 标签 */
  /**
   * addLabel(html, posFn, opts)
   *   posFn: function �?{x,y,z} | THREE.Vector3；也可直接传对象
   *   opts: { className, offsetY, minDistance, maxDistance, fadeStart, occlude }
   */
  S.addLabel = function (html, posFn, o) {
    o = o || {};
    var el = document.createElement('div');
    el.className = o.className || 'bld-label';
    el.innerHTML = html;
    el.style.position = 'absolute';
    el.style.left = '0'; el.style.top = '0';
    el.style.willChange = 'transform,opacity';
    el.style.opacity = '0';
    if (labelLayer) labelLayer.appendChild(el);
    var L = {
      el: el, posFn: posFn, offsetY: o.offsetY || 0,
      minD: o.minDistance || 0, maxD: o.maxDistance || 1e9,
      fadeStart: o.fadeStart || (o.maxDistance ? o.maxDistance * 0.8 : 1e9),
      occlude: !!o.occlude, occluded: false, occTick: (labels.length * 7) % 12,
      lastX: -1, lastY: -1, lastA: -1, lastVis: null, hidden: false,
      remove: function () { var i = labels.indexOf(L); if (i >= 0) labels.splice(i, 1); if (el.parentNode) el.parentNode.removeChild(el); },
      setVisible: function (v) { L.hidden = !v; },
      setHTML: function (h) { el.innerHTML = h; }
    };
    labels.push(L);
    return L;
  };
  S.clearLabels = function () { while (labels.length) labels[0].remove(); };
  S.labelCount = function () { return labels.length; };

  var occObjects = null;
  function updateLabels() {
    if (!labels.length) return;
    var cam = S.camera;
    for (var i = 0; i < labels.length; i++) {
      var L = labels[i];
      var p = typeof L.posFn === 'function' ? L.posFn() : L.posFn;
      var vis = !L.hidden && !!p;
      var sx = 0, sy = 0, a = 0;
      if (vis) {
        var py = (p.y || 0);
        var s = S.screenPos(p.x, py, p.z);
        vis = s.visible && s.depth >= L.minD && s.depth <= L.maxD;
        if (vis) {
          sx = Math.round(s.x); sy = Math.round(s.y - L.offsetY);
          a = s.depth > L.fadeStart ? U.clamp01(1 - (s.depth - L.fadeStart) / Math.max(1, L.maxD - L.fadeStart)) : 1;
          if (L.occlude) {
            if (--L.occTick <= 0) {
              L.occTick = 12;
              occObjects = TP.CityBuilder && TP.CityBuilder.buildingMeshes ? TP.CityBuilder.buildingMeshes : null;
              L.occluded = false;
              if (occObjects && occObjects.length) {
                tmpV.set(p.x, py, p.z);
                var dir = tmpV.clone().sub(cam.position);
                var len = dir.length();
                raycaster.set(cam.position, dir.normalize());
                raycaster.far = len - 4;
                var hit = raycaster.intersectObjects(occObjects, false);
                raycaster.far = Infinity;
                L.occluded = hit.length > 0;
              }
            }
            if (L.occluded) a *= 0.25;
          }
        }
      }
      if (!vis) a = 0;
      if (vis !== L.lastVis) { L.el.style.display = vis ? '' : 'none'; L.lastVis = vis; }
      if (!vis) continue;
      if (sx !== L.lastX || sy !== L.lastY) {
        L.el.style.transform = 'translate3d(' + sx + 'px,' + sy + 'px,0) translate(-50%,-100%)';
        L.lastX = sx; L.lastY = sy;
      }
      var qa = Math.round(a * 20) / 20;
      if (qa !== L.lastA) { L.el.style.opacity = String(qa); L.lastA = qa; }
    }
  }

  S.dispose = function () {
    if (!S.ready) return;
    S.clearLabels();
    if (ro) ro.disconnect();
    window.removeEventListener('resize', S.resize, false);
    S.renderer.dispose();
    if (S.renderer.domElement.parentNode) S.renderer.domElement.parentNode.removeChild(S.renderer.domElement);
    if (labelLayer && labelLayer.parentNode) labelLayer.parentNode.removeChild(labelLayer);
    S.ready = false;
  };

})(window, document);

