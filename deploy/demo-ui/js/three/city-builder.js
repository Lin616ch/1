/* ============================================================================
 * city-builder.js —— 静态城市几何
 * 命名空间：TP.CityBuilder
 * 依赖：THREE(r128)、TP.Util、TP.Theme、TP.Scene
 * 要点：
 *   - 建筑：按 type 分 5 组 InstancedMesh；共享 BoxGeometry 写逐面顶点色（顶亮/侧中/背暗 + 底部 AO），
 *     setColorAt 给每个实例色相 → 无光照也有清晰白模体块感。
 *   - 路网：按 cls 4 组合并 BufferGeometry（逐顶点色 = 路况色）+ 1 层合并描边带 + 2 组交叉口圆盘 InstancedMesh。
 *     roadVertexRange[roadId] = { cls, start, count } 支撑局部改色（updateRange 精确上传）。
 *   - 路段数量不做任何假设（可承受数千条）。
 * ==========================================================================*/
(function (window) {
  'use strict';

  var TP = window.TP = window.TP || {};
  var U = TP.Util;
  var THREE = window.THREE;

  var CLASSES = ['branch', 'secondary', 'arterial', 'expressway'];      /* 绘制顺序：低等级在下 */
  var WIDTH = { expressway: 9, arterial: 6.5, secondary: 4.5, branch: 3 };
  var CASING = { expressway: 3.2, arterial: 2.6, secondary: 2.0, branch: 1.6 };
  var CLS_RANK = { branch: 0, secondary: 1, arterial: 2, expressway: 3 };
  var BTYPES = ['res', 'office', 'mall', 'industrial', 'landmark'];

  var B = TP.CityBuilder = {
    ready: false,
    group: null,
    pickables: [],
    buildingMeshes: [],
    roadVertexRange: {},
    roadMeshes: {},          /* cls → Mesh */
    discs: null,             /* { mesh, casing, roadIds:[], ids:[] } */
    style: 'type',
    WIDTH: WIDTH, CLASSES: CLASSES
  };

  var city = null;
  var bGroup = null, roadGroup = null, waterGroup = null, districtGroup = null;
  var bInfo = {};             /* type → { mesh, idx:[buildingIndex], base:Float32Array(rgb) } */
  var boxGeo = null;
  var casingMesh = null, waterMesh = null, bankMesh = null, greenMesh = null;
  var districtLines = null, districtHover = {}, districtSel = null, districtFill = null;
  var labelHandles = [];
  var regionId = 'all', hoverDistrictId = null;
  var dirty = {};             /* cls → {min,max} 顶点区间 */
  var hGrid = null, HG_CELL = 25, HG_N = 0, HG_ORIGIN = -1100;
  var planTween = null, planK = 0;
  var roadById = {};

  function Y() { return TP.Scene.Y; }
  function col(token) { return TP.Scene.color(token); }
  function colCss(css, out) { return TP.Scene.colorOf(css, out); }
  function mixTok(a, b, t) { return colCss(U.mix(TP.Theme.hex(a), TP.Theme.hex(b), t)); }

  /* ======================================================= 几何小工具 ===== */
  function px(p) { return p.x !== undefined ? p.x : p[0]; }
  function pz(p) { return p.z !== undefined ? p.z : p[1]; }

  /** 折线扩成三角带（斜接 + 斜接长度钳制）。写入 acc，返回本段顶点数 */
  function ribbon(acc, pts, hw, y, closed, color) {
    var n = pts.length;
    if (n < 2) return 0;
    var base = acc.pos.length / 3;
    var i, ax, az, bx, bz, d0x, d0z, d1x, d1z, l;
    for (i = 0; i < n; i++) {
      var cx = px(pts[i]), cz = pz(pts[i]);
      var ip = i - 1, inx = i + 1;
      if (closed) { if (ip < 0) ip = n - 1; if (inx >= n) inx = 0; }
      if (ip >= 0) { ax = px(pts[ip]); az = pz(pts[ip]); d0x = cx - ax; d0z = cz - az; l = Math.sqrt(d0x * d0x + d0z * d0z) || 1; d0x /= l; d0z /= l; }
      if (inx < n) { bx = px(pts[inx]); bz = pz(pts[inx]); d1x = bx - cx; d1z = bz - cz; l = Math.sqrt(d1x * d1x + d1z * d1z) || 1; d1x /= l; d1z /= l; }
      if (ip < 0) { d0x = d1x; d0z = d1z; }
      if (inx >= n) { d1x = d0x; d1z = d0z; }
      var tx = d0x + d1x, tz = d0z + d1z;
      l = Math.sqrt(tx * tx + tz * tz);
      if (l < 1e-6) { tx = d1x; tz = d1z; l = 1; }
      tx /= l; tz /= l;
      var nx = -tz, nz = tx;                       /* 法向（左） */
      var dot = nx * (-d1z) + nz * d1x;            /* 与段法向夹角余弦 */
      var m = hw / Math.max(0.5, dot);
      acc.pos.push(cx + nx * m, y, cz + nz * m, cx - nx * m, y, cz - nz * m);
      if (acc.col && color) acc.col.push(color.r, color.g, color.b, color.r, color.g, color.b);
    }
    var segs = closed ? n : n - 1;
    for (i = 0; i < segs; i++) {
      var a = base + i * 2, b2 = base + ((i + 1) % n) * 2;
      /* ⚠️ 缠绕方向必须是"从上看逆时针"，否则法线朝下，
         默认 FrontSide 会把整条路带背面剔除 —— 画面上就只剩交叉口圆盘，
         看起来像"一个个小圆没连成路"。
         推导：v0=P+n·hw, v1=P-n·hw，三角面 (v0, v0_next, v1) 的
         cross Y = +2·hw·L > 0（朝上）。反过来写就是 -2·hw·L（朝下，被剔除）。 */
      acc.idx.push(a, b2, a + 1, a + 1, b2, b2 + 1);
    }
    return n * 2;
  }

  function newAcc(withColor) { return { pos: [], idx: [], col: withColor ? [] : null }; }

  /* ------------------------------------------------------------------ *
   * 高架 / 桥梁：梁体侧裙 + 桥墩
   *
   * 只有一块悬空的路面会显得很假 —— 真实高架一定有梁体侧面和下方立柱。
   * 侧裙用 DoubleSide：竖直面从两侧都可能被看到，靠缠绕方向做单面剔除只会
   * 换来"转到某个角度就消失一片"的怪现象。
   * ------------------------------------------------------------------ */
  var BEAM_DEPTH = 0.7;        /* 梁体厚度（世界单位）= 3.5 米 */
  var PIER_STEP = 10;          /* 立柱间距（世界单位）= 50 米 */
  var PIER_MAX = 6000;         /* 立柱上限，保证单个 InstancedMesh 扛得住 */

  /** 沿折线左右各竖一片梁体侧面：从 yBot 到 yTop */
  function skirt(acc, pts, hw, yBot, yTop) {
    var n = pts.length;
    if (n < 2) return;
    var base = acc.pos.length / 3;
    var i;
    for (i = 0; i < n; i++) {
      var cx = px(pts[i]), cz = pz(pts[i]);
      var ip = i - 1, inx = i + 1;
      if (ip < 0) ip = 0;
      if (inx >= n) inx = n - 1;
      var ax = px(pts[ip]), az = pz(pts[ip]);
      var bx = px(pts[inx]), bz = pz(pts[inx]);
      var d0x = cx - ax, d0z = cz - az;
      var d1x = bx - cx, d1z = bz - cz;
      var l0 = Math.sqrt(d0x * d0x + d0z * d0z) || 1;
      var l1 = Math.sqrt(d1x * d1x + d1z * d1z) || 1;
      d0x /= l0; d0z /= l0; d1x /= l1; d1z /= l1;
      if (i === 0) { d0x = d1x; d0z = d1z; }
      if (i === n - 1) { d1x = d0x; d1z = d0z; }
      var tx = d0x + d1x, tz = d0z + d1z;
      var tl = Math.sqrt(tx * tx + tz * tz);
      if (tl < 1e-6) { tx = d1x; tz = d1z; tl = 1; }
      tx /= tl; tz /= tl;
      var nx = -tz, nz = tx;
      var dot = nx * (-d1z) + nz * d1x;
      var m = Math.min(hw / Math.max(0.4, dot), hw * 1.25);
      /* 每点 4 个顶点：左墙下/上，右墙下/上 */
      acc.pos.push(cx + nx * m, yBot, cz + nz * m, cx + nx * m, yTop, cz + nz * m);
      acc.pos.push(cx - nx * m, yBot, cz - nz * m, cx - nx * m, yTop, cz - nz * m);
    }
    for (i = 0; i < n - 1; i++) {
      var a = base + i * 4, b2 = base + (i + 1) * 4;
      acc.idx.push(a, a + 1, b2, a + 1, b2 + 1, b2);
      acc.idx.push(a + 2, b2 + 2, a + 3, a + 3, b2 + 2, b2 + 3);
    }
  }

  /** 桥墩：沿高架路段每隔 ~50 米一根立柱，全部塞进一个 InstancedMesh */
  function buildPiers(list) {
    if (!list.length) return;
    var yy = Y();
    var spots = [], i, k;
    for (i = 0; i < list.length && spots.length < PIER_MAX; i++) {
      var it = list[i];
      var total = TP.Util.polylineLength(it.path);
      if (total < 1) continue;
      var count = Math.max(1, Math.round(total / PIER_STEP));
      for (k = 0; k <= count && spots.length < PIER_MAX; k++) {
        var p = TP.Util.pointAlongPolyline(it.path, k / count);
        spots.push({ x: p.x, z: p.z, yTop: it.yTop, w: it.pierW });
      }
    }
    if (!spots.length) return;
    var geo = new THREE.BoxGeometry(1, 1, 1);
    var mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: col('--bld-side') }), spots.length);
    var m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pV = new THREE.Vector3(), sV = new THREE.Vector3();
    for (i = 0; i < spots.length; i++) {
      var s = spots[i];
      var h = Math.max(0.25, s.yTop - yy.ground);
      pV.set(s.x, yy.ground + h / 2, s.z);
      sV.set(s.w, h, s.w);
      m4.compose(pV, q, sV);
      mesh.setMatrixAt(i, m4);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.name = 'road-piers';
    mesh.renderOrder = 1.6;
    roadGroup.add(mesh);
    B.pierCount = spots.length;
  }

  function accToGeometry(acc) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(acc.pos), 3));
    if (acc.col) {
      var ca = new THREE.BufferAttribute(new Float32Array(acc.col), 3);
      ca.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('color', ca);
    }
    var nv = acc.pos.length / 3;
    g.setIndex(new THREE.BufferAttribute(nv > 65535 ? new Uint32Array(acc.idx) : new Uint16Array(acc.idx), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }

  /** 把一个（可能有 index 的）THREE 几何追加进 acc */
  function appendGeometry(acc, geo, color) {
    var p = geo.attributes.position.array, base = acc.pos.length / 3, i;
    for (i = 0; i < p.length; i++) acc.pos.push(p[i]);
    if (acc.col) for (i = 0; i < p.length / 3; i++) acc.col.push(color.r, color.g, color.b);
    if (geo.index) { var ix = geo.index.array; for (i = 0; i < ix.length; i++) acc.idx.push(ix[i] + base); }
    else for (i = 0; i < p.length / 3; i++) acc.idx.push(base + i);
  }

  function shapeFromPolygon(poly) {
    var s = new THREE.Shape();
    for (var i = 0; i < poly.length; i++) {
      var x = px(poly[i]), z = pz(poly[i]);
      if (i === 0) s.moveTo(x, -z); else s.lineTo(x, -z);
    }
    return s;
  }
  function flatShapeGeo(poly, y) {
    var g = new THREE.ShapeGeometry(shapeFromPolygon(poly));
    g.rotateX(-Math.PI / 2);            /* (x,-z) → XZ 平面 */
    g.translate(0, y, 0);
    return g;
  }

  /* ======================================================= 建筑 ========== */
  function makeBoxGeometry() {
    var g = new THREE.BoxGeometry(1, 1, 1);
    g.translate(0, 0.5, 0);
    g.deleteAttribute('uv');
    writeBoxColors(g);
    return g;
  }

  /** 逐面顶点色：BoxGeometry 面序 +x,-x,+y,-y,+z,-z。主光来自 -X/+Z 侧 */
  function writeBoxColors(g) {
    var top = col('--bld-top'), side = col('--bld-side'), dark = col('--bld-side-dark');
    var faceCol = [dark, side, top, dark, side, dark];
    var pos = g.attributes.position.array;
    var n = pos.length / 3;
    var arr = g.attributes.color ? g.attributes.color.array : new Float32Array(n * 3);
    for (var v = 0; v < n; v++) {
      var face = Math.floor(v / 4);
      var c = faceCol[face];
      var ao = 1;
      if (face !== 2 && face !== 3) ao = pos[v * 3 + 1] < 0.5 ? 0.86 : 1.0;   /* 侧面底部压暗：接地感 */
      arr[v * 3] = c.r * ao; arr[v * 3 + 1] = c.g * ao; arr[v * 3 + 2] = c.b * ao;
    }
    if (!g.attributes.color) g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    else g.attributes.color.needsUpdate = true;
  }

  function typeTint(type, out) {
    var T = TP.Theme, w = T.hex('--bld-top');
    var css;
    switch (type) {
      case 'office':     css = U.mix(w, T.hex('--bld-hi'), 0.42); break;
      case 'mall':       css = U.mix(w, T.hex('--c-warn'), 0.16); break;
      case 'industrial': css = U.mix(w, T.hex('--c-text-dim'), 0.26); break;
      case 'landmark':   css = U.mix(w, T.hex('--bld-hi'), 0.85); break;
      default:           css = U.mix(w, T.hex('--c-primary-weak'), 0.55);
    }
    return colCss(css, out);
  }

  var maxH = 1;
  function tintFor(b, i, out) {
    var st = B.style;
    var jitter = 0.955 + 0.045 * ((U.hashStr('b' + i) % 1000) / 1000);
    if (st === 'height') {
      var t = Math.pow(U.clamp01(b.h / maxH), 0.7);
      colCss(U.ramp([TP.Theme.hex('--bld-top'), TP.Theme.hex('--bld-hi'), TP.Theme.hex('--c-primary')], t * 0.75), out);
    } else if (st === 'plain') {
      out.setRGB(1, 1, 1);
      if (b.type === 'landmark') typeTint('landmark', out);
    } else {
      typeTint(b.type, out);
    }
    out.multiplyScalar(jitter);
    return out;
  }

  function buildBuildings() {
    var list = city.buildings || [];
    boxGeo = makeBoxGeometry();
    bGroup = new THREE.Group(); bGroup.name = 'buildings';
    B.group.add(bGroup);
    var byType = {}, i, t;
    for (t = 0; t < BTYPES.length; t++) byType[BTYPES[t]] = [];
    maxH = 1;
    for (i = 0; i < list.length; i++) {
      var ty = byType[list[i].type] ? list[i].type : 'res';
      byType[ty].push(i);
      if (list[i].h > maxH) maxH = list[i].h;
    }
    var m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pV = new THREE.Vector3(), sV = new THREE.Vector3();
    var yAxis = new THREE.Vector3(0, 1, 0), c = new THREE.Color();
    var gy = Y().ground;
    B.buildingMeshes = [];
    for (t = 0; t < BTYPES.length; t++) {
      var type = BTYPES[t], idx = byType[type];
      if (!idx.length) continue;
      var mat = new THREE.MeshLambertMaterial({ vertexColors: true });
      var mesh = new THREE.InstancedMesh(boxGeo, mat, idx.length);
      mesh.name = 'bld-' + type;
      mesh.castShadow = true; mesh.receiveShadow = true;
      var base = new Float32Array(idx.length * 3);
      for (var k = 0; k < idx.length; k++) {
        var b = list[idx[k]];
        q.setFromAxisAngle(yAxis, b.rot || 0);
        pV.set(b.x, gy, b.z);
        sV.set(Math.max(1, b.w), Math.max(1, b.h - gy), Math.max(1, b.d));
        m4.compose(pV, q, sV);
        mesh.setMatrixAt(k, m4);
        tintFor(b, idx[k], c);
        base[k * 3] = c.r; base[k * 3 + 1] = c.g; base[k * 3 + 2] = c.b;
        mesh.setColorAt(k, c);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.userData = { kind: 'building', type: type, indices: idx };
      bInfo[type] = { mesh: mesh, idx: idx, base: base };
      bGroup.add(mesh);
      B.buildingMeshes.push(mesh);
    }
    buildHeightGrid(list);
  }

  /** 建筑高度栅格：给相机做"不穿楼"约束 */
  function buildHeightGrid(list) {
    HG_N = Math.ceil(2200 / HG_CELL);
    hGrid = new Float32Array(HG_N * HG_N);
    for (var i = 0; i < list.length; i++) {
      var b = list[i], r = Math.sqrt(b.w * b.w + b.d * b.d) * 0.5 + 6;
      var x0 = Math.floor((b.x - r - HG_ORIGIN) / HG_CELL), x1 = Math.floor((b.x + r - HG_ORIGIN) / HG_CELL);
      var z0 = Math.floor((b.z - r - HG_ORIGIN) / HG_CELL), z1 = Math.floor((b.z + r - HG_ORIGIN) / HG_CELL);
      for (var gx = Math.max(0, x0); gx <= Math.min(HG_N - 1, x1); gx++)
        for (var gz = Math.max(0, z0); gz <= Math.min(HG_N - 1, z1); gz++) {
          var k = gz * HG_N + gx;
          if (b.h > hGrid[k]) hGrid[k] = b.h;
        }
    }
  }
  /** 某点附近建筑最大高度（已考虑 plan 视图压扁） */
  B.heightAt = function (x, z) {
    if (!hGrid) return 0;
    var gx = Math.floor((x - HG_ORIGIN) / HG_CELL), gz = Math.floor((z - HG_ORIGIN) / HG_CELL);
    if (gx < 0 || gz < 0 || gx >= HG_N || gz >= HG_N) return 0;
    var s = bGroup ? bGroup.scale.y : 1;
    return (bGroup && !bGroup.visible) ? 0 : hGrid[gz * HG_N + gx] * s;
  };

  B.applyBuildingColors = function () {
    var c = new THREE.Color(), g = col('--stage-ground');
    for (var type in bInfo) {
      if (!Object.prototype.hasOwnProperty.call(bInfo, type)) continue;
      var info = bInfo[type], mesh = info.mesh;
      for (var k = 0; k < info.idx.length; k++) {
        var b = city.buildings[info.idx[k]];
        c.setRGB(info.base[k * 3], info.base[k * 3 + 1], info.base[k * 3 + 2]);
        if (regionId !== 'all' && b.districtId !== regionId) c.lerp(g, 0.62);
        mesh.setColorAt(k, c);
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  };

  B.setBuildingStyle = function (style) {
    if (style !== 'plain' && style !== 'height' && style !== 'type') return;
    B.style = style;
    var c = new THREE.Color();
    for (var type in bInfo) {
      if (!Object.prototype.hasOwnProperty.call(bInfo, type)) continue;
      var info = bInfo[type];
      for (var k = 0; k < info.idx.length; k++) {
        tintFor(city.buildings[info.idx[k]], info.idx[k], c);
        info.base[k * 3] = c.r; info.base[k * 3 + 1] = c.g; info.base[k * 3 + 2] = c.b;
      }
    }
    B.applyBuildingColors();
  };

  B.setBuildingsVisible = function (on) { if (bGroup) bGroup.visible = !!on; };

  /** 俯视平面模式：建筑压扁成占地面色块（像路网平面图），带补间 */
  B.setPlanView = function (on, dur) {
    if (!bGroup) return;
    var to = on ? 1 : 0;
    if (planTween) planTween.cancel();
    var from = planK;
    planTween = U.tween({
      from: from, to: to, dur: dur == null ? 1000 : dur, ease: 'inOutCubic',
      onUpdate: function (v) { setPlanK(v); },
      onDone: function () { planTween = null; }
    });
  };
  function setPlanK(v) {
    planK = v;
    bGroup.scale.y = U.lerp(1, 0.03, v);
    for (var i = 0; i < labelHandles.length; i++) if (labelHandles[i].kind === 'landmark') labelHandles[i].h.setVisible(v < 0.5);
  }
  B.planAmount = function () { return planK; };

  /* ======================================================= 路网 ========== */
  function neutralRoadColor(cls) {
    var k = { expressway: 0.62, arterial: 0.48, secondary: 0.34, branch: 0.22 }[cls] || 0.3;
    return mixTok('--c-panel', '--road-nodata', k);
  }
  B.neutralRoadColor = neutralRoadColor;

  function buildRoads() {
    var roads = city.roads || [];
    roadGroup = new THREE.Group(); roadGroup.name = 'roads';
    B.group.add(roadGroup);
    var accs = {}, ranges = {}, c, i;
    for (i = 0; i < CLASSES.length; i++) { accs[CLASSES[i]] = newAcc(true); ranges[CLASSES[i]] = { starts: [], ids: [] }; }
    var cas = newAcc(false), y = Y();
    var skirtAcc = newAcc(false);
    var pierList = [];
    B.roadVertexRange = {};
    roadById = {};
    for (i = 0; i < roads.length; i++) {
      var r = roads[i];
      if (!r || !r.path || r.path.length < 2) continue;
      var cls = WIDTH[r.cls] ? r.cls : 'branch';
      roadById[r.id] = r;
      var acc = accs[cls];
      c = neutralRoadColor(cls);
      /* 路面高度 = 地面层高度 + 该路段自身的抬高量（高架 2.6 / 桥 1.4 / 地面 0）。
         合并几何里每个顶点各自带 Y，所以**不需要按结构拆分网格**，
         roadVertexRange 的逐段改色完全不受影响。 */
      var elev = r.elevW || 0;
      var deckY = y.road[cls] + elev;
      var start = acc.pos.length / 3;
      var cnt = ribbon(acc, r.path, WIDTH[cls] / 2, deckY, false, c);
      B.roadVertexRange[r.id] = { cls: cls, start: start, count: cnt };
      ranges[cls].starts.push(start); ranges[cls].ids.push(r.id);
      ribbon(cas, r.path, WIDTH[cls] / 2 + CASING[cls], deckY - 0.06, false, null);
      if (elev > 0) {
        var beamBottom = deckY - BEAM_DEPTH;
        skirt(skirtAcc, r.path, WIDTH[cls] / 2, beamBottom, deckY);
        if (r.piers) {
          pierList.push({
            path: r.path,
            yTop: beamBottom,
            pierW: Math.max(0.5, WIDTH[cls] / 2 * 0.30)
          });
        }
      }
    }
    for (i = 0; i < CLASSES.length; i++) {
      var k = CLASSES[i];
      if (!accs[k].pos.length) continue;
      var mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: false });
      var mesh = new THREE.Mesh(accToGeometry(accs[k]), mat);
      mesh.name = 'road-' + k;
      mesh.renderOrder = 2 + i;
      mesh.userData = { kind: 'road', cls: k, starts: ranges[k].starts, ids: ranges[k].ids };
      B.roadMeshes[k] = mesh;
      roadGroup.add(mesh);
      B.pickables.push(mesh);
    }
    if (cas.pos.length) {
      casingMesh = new THREE.Mesh(accToGeometry(cas), new THREE.MeshBasicMaterial({ color: col('--road-casing') }));
      casingMesh.name = 'road-casing';
      casingMesh.renderOrder = 1;
      roadGroup.add(casingMesh);
    }

    /* 高架/桥梁的梁体侧面（DoubleSide：竖直面从两侧都可能看到） */
    if (skirtAcc.pos.length) {
      var skirtMesh = new THREE.Mesh(accToGeometry(skirtAcc),
        new THREE.MeshBasicMaterial({ color: col('--bld-side-dark'), side: THREE.DoubleSide }));
      skirtMesh.name = 'road-viaduct-skirt';
      skirtMesh.renderOrder = 1.5;
      roadGroup.add(skirtMesh);
      B.skirtMesh = skirtMesh;
    }
    buildPiers(pierList);

    buildDiscs();
  }

  /** 交叉口圆盘：消除带状路口缺口。上层圆盘色 = 该路口最高等级道路的路况色 */
  function buildDiscs() {
    var ints = city.intersections || [];
    if (!ints.length) return;
    var geo = new THREE.CircleGeometry(1, 18);
    geo.rotateX(-Math.PI / 2);
    var top = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff }), ints.length);
    var casing = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: col('--road-casing') }), ints.length);
    var m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pV = new THREE.Vector3(), sV = new THREE.Vector3();
    var y = Y(), roadIds = [], ids = [], c = new THREE.Color();
    for (var i = 0; i < ints.length; i++) {
      var n = ints[i], best = null, bestRank = -1, w = 3;
      var rids = n.roadIds || [];
      var maxElev = 0;
      for (var j = 0; j < rids.length; j++) {
        var r = roadById[rids[j]];
        if (!r) continue;
        var rk = CLS_RANK[r.cls] || 0;
        if (rk > bestRank) { bestRank = rk; best = r; }
        if (WIDTH[r.cls] > w) w = WIDTH[r.cls];
        if ((r.elevW || 0) > maxElev) maxElev = r.elevW || 0;
      }
      roadIds.push(best ? best.id : null); ids.push(n.id);
      var rad = w / 2 * 1.04;
      /* 高架层的路口圆盘要跟着抬上去，否则会画在地面上。
         立交拆层之后，地面节点只挂地面路、高架节点只挂快速路，
         所以这里除了 deck==='viaduct' 一律贴地（interchange 留在地面层表示匝道区）。 */
      var lift = (n.deck === 'viaduct') ? maxElev : 0;
      pV.set(n.x, y.disc + lift, n.z); sV.set(rad, 1, rad);
      m4.compose(pV, q, sV); top.setMatrixAt(i, m4);
      var casR = rad + (best ? CASING[best.cls] : 1.6);
      pV.y = y.casing + lift; sV.set(casR, 1, casR);
      m4.compose(pV, q, sV); casing.setMatrixAt(i, m4);
      c.copy(best ? neutralRoadColor(best.cls) : neutralRoadColor('branch'));
      top.setColorAt(i, c);
    }
    top.instanceMatrix.needsUpdate = true; casing.instanceMatrix.needsUpdate = true;
    if (top.instanceColor) top.instanceColor.needsUpdate = true;
    top.name = 'road-discs'; casing.name = 'road-discs-casing';
    top.renderOrder = 1.5; casing.renderOrder = 1;
    top.userData = { kind: 'intersection', ids: ids };
    roadGroup.add(casing); roadGroup.add(top);
    B.discs = { mesh: top, casing: casing, roadIds: roadIds, ids: ids };
  }

  /** 写某路段颜色（线性 rgb 0..1）。调用 flushRoadColors() 统一上传 */
  B.setRoadColor = function (roadId, r, g, b) {
    var rg = B.roadVertexRange[roadId];
    if (!rg) return false;
    var mesh = B.roadMeshes[rg.cls];
    if (!mesh) return false;
    var arr = mesh.geometry.attributes.color.array;
    var s = rg.start * 3, e = (rg.start + rg.count) * 3;
    for (var i = s; i < e; i += 3) { arr[i] = r; arr[i + 1] = g; arr[i + 2] = b; }
    var d = dirty[rg.cls];
    if (!d) dirty[rg.cls] = { min: rg.start, max: rg.start + rg.count };
    else { if (rg.start < d.min) d.min = rg.start; if (rg.start + rg.count > d.max) d.max = rg.start + rg.count; }
    return true;
  };
  B.flushRoadColors = function () {
    for (var cls in dirty) {
      if (!Object.prototype.hasOwnProperty.call(dirty, cls)) continue;
      var d = dirty[cls], mesh = B.roadMeshes[cls];
      if (!d || !mesh) continue;
      var at = mesh.geometry.attributes.color;
      at.updateRange.offset = d.min * 3;
      at.updateRange.count = (d.max - d.min) * 3;
      at.needsUpdate = true;
    }
    dirty = {};
  };
  B.setDiscColor = function (i, color) {
    if (!B.discs) return;
    B.discs.mesh.setColorAt(i, color);
  };
  B.flushDiscColors = function () {
    if (B.discs && B.discs.mesh.instanceColor) B.discs.mesh.instanceColor.needsUpdate = true;
  };

  B.roadMeshById = function (roadId) {
    var rg = B.roadVertexRange[roadId];
    return rg ? (B.roadMeshes[rg.cls] || null) : null;
  };
  B.roadById = function (id) { return roadById[id] || null; };

  /** 由 raycast 的 faceIndex 反查路段 id（二分查找顶点起点） */
  B.roadIdFromHit = function (mesh, face) {
    if (!mesh || !mesh.userData || mesh.userData.kind !== 'road' || !face) return null;
    var v = face.a, st = mesh.userData.starts, lo = 0, hi = st.length - 1;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (st[mid] <= v) lo = mid; else hi = mid - 1; }
    return mesh.userData.ids[lo] || null;
  };

  /** 构造单条路段的覆盖带几何（hover / 选中高亮用） */
  B.roadOverlayGeometry = function (roadId, extra, y) {
    var r = roadById[roadId];
    if (!r) return null;
    var acc = newAcc(false);
    ribbon(acc, r.path, (WIDTH[r.cls] || 3) / 2 + (extra || 0), y == null ? Y().overlay : y, false, null);
    return accToGeometry(acc);
  };
  /** 同名道路全部路段的覆盖带（用于"整条道路"高亮） */
  B.roadNameOverlayGeometry = function (name, extra, y) {
    var acc = newAcc(false), roads = city.roads || [];
    for (var i = 0; i < roads.length; i++) {
      var r = roads[i];
      if (r.name === name && r.path && r.path.length > 1) ribbon(acc, r.path, (WIDTH[r.cls] || 3) / 2 + (extra || 0), y == null ? Y().overlay : y, false, null);
    }
    return acc.pos.length ? accToGeometry(acc) : null;
  };
  B.ribbonGeometry = function (pts, hw, y, closed) {
    var acc = newAcc(false); ribbon(acc, pts, hw, y, !!closed, null); return accToGeometry(acc);
  };
  B.ribbonInto = ribbon;
  B.newAcc = newAcc;
  B.accToGeometry = accToGeometry;
  B.appendGeometry = appendGeometry;

  /* ======================================================= 水系 / 绿地 ==== */
  function waterColor() { return mixTok('--c-primary', '--stage-ground', 0.84); }
  function bankColor() { return mixTok('--c-primary', '--stage-ground', 0.72); }
  function greenColor() { return mixTok('--c-success', '--stage-ground', 0.82); }

  function buildWaterGreen() {
    waterGroup = new THREE.Group(); waterGroup.name = 'water-green';
    B.group.add(waterGroup);
    var y = Y();
    var water = newAcc(false), bank = newAcc(false), i;
    var ws = city.waterways || [];
    for (i = 0; i < ws.length; i++) {
      var w = ws[i];
      var poly = w.polygon || ((w.kind === 'lake' && w.path) ? w.path : null);
      if (poly && poly.length > 2) {
        var g = flatShapeGeo(poly, y.water); appendGeometry(water, g); g.dispose();
        ribbon(bank, poly, 2.5, y.water - 0.05, true, null);
      } else if (w.path && w.path.length > 1) {
        var hw = (w.width || 30) / 2;
        ribbon(water, w.path, hw, y.water, false, null);
        ribbon(bank, w.path, hw + 3, y.water - 0.05, false, null);
      }
    }
    if (water.pos.length) {
      waterMesh = new THREE.Mesh(accToGeometry(water), new THREE.MeshBasicMaterial({ color: waterColor(), side: THREE.DoubleSide }));
      waterMesh.name = 'water'; waterMesh.renderOrder = -3;
      bankMesh = new THREE.Mesh(accToGeometry(bank), new THREE.MeshBasicMaterial({ color: bankColor(), side: THREE.DoubleSide }));
      bankMesh.name = 'water-bank'; bankMesh.renderOrder = -4;
      waterGroup.add(bankMesh); waterGroup.add(waterMesh);
    }
    var green = newAcc(false), gl = city.greenlands || [];
    for (i = 0; i < gl.length; i++) {
      if (!gl[i].polygon || gl[i].polygon.length < 3) continue;
      var gg = flatShapeGeo(gl[i].polygon, y.green); appendGeometry(green, gg); gg.dispose();
    }
    if (green.pos.length) {
      greenMesh = new THREE.Mesh(accToGeometry(green), new THREE.MeshBasicMaterial({ color: greenColor(), side: THREE.DoubleSide }));
      greenMesh.name = 'green'; greenMesh.renderOrder = -2;
      waterGroup.add(greenMesh);
    }
  }

  /* ======================================================= 行政区 ======== */
  function buildDistricts() {
    districtGroup = new THREE.Group(); districtGroup.name = 'districts';
    B.group.add(districtGroup);
    var ds = city.districts || [], y = Y(), pos = [], i, j;
    for (i = 0; i < ds.length; i++) {
      var poly = ds[i].polygon || [];
      for (j = 0; j < poly.length; j++) {
        var a = poly[j], b = poly[(j + 1) % poly.length];
        pos.push(px(a), y.district, pz(a), px(b), y.district, pz(b));
      }
      /* hover 加粗带（预建，默认隐藏） */
      if (poly.length > 2) {
        var hm = new THREE.Mesh(B.ribbonGeometry(poly, 1.8, y.district + 0.05, true),
          new THREE.MeshBasicMaterial({ color: col('--c-primary'), transparent: true, opacity: 0.55, depthWrite: false }));
        hm.visible = false; hm.renderOrder = 8; hm.name = 'district-hover-' + ds[i].id;
        districtHover[ds[i].id] = hm;
        districtGroup.add(hm);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    districtLines = new THREE.LineSegments(g, new THREE.LineDashedMaterial({
      color: col('--c-border-strong'), dashSize: 12, gapSize: 8, transparent: true, opacity: 0.95, depthWrite: false
    }));
    districtLines.computeLineDistances();
    districtLines.renderOrder = 7;
    districtLines.name = 'district-lines';
    districtGroup.add(districtLines);

    /* 标签 */
    for (i = 0; i < ds.length; i++) {
      (function (d) {
        var c = d.center || U.polygonCentroid(d.polygon || []);
        var h = TP.Scene.addLabel(d.name, { x: c.x, y: 6, z: c.z }, { className: 'bld-label bld-label--district', maxDistance: 5200, fadeStart: 4200 });
        labelHandles.push({ kind: 'district', id: d.id, h: h });
      })(ds[i]);
    }
    var bl = city.buildings || [];
    for (i = 0; i < bl.length; i++) {
      if (bl[i].type === 'landmark' && bl[i].name) {
        (function (b) {
          var h = TP.Scene.addLabel(b.name, function () { return { x: b.x, y: b.h * (bGroup ? bGroup.scale.y : 1) + 4, z: b.z }; },
            { className: 'bld-label bld-label--landmark', maxDistance: 1900, fadeStart: 1400, occlude: true });
          labelHandles.push({ kind: 'landmark', id: b.name, h: h });
        })(bl[i]);
      }
    }
  }

  B.setDistrictsVisible = function (on) {
    if (districtGroup) districtGroup.visible = !!on;
    for (var i = 0; i < labelHandles.length; i++) if (labelHandles[i].kind === 'district') labelHandles[i].h.setVisible(!!on);
  };
  B.districtsVisible = function () { return !!(districtGroup && districtGroup.visible); };

  B.hoverDistrict = function (id) {
    if (id === hoverDistrictId) return;
    if (hoverDistrictId && districtHover[hoverDistrictId]) districtHover[hoverDistrictId].visible = false;
    hoverDistrictId = id || null;
    if (hoverDistrictId && districtHover[hoverDistrictId] && hoverDistrictId !== regionId) districtHover[hoverDistrictId].visible = true;
  };

  B.setRegionHighlight = function (id) {
    regionId = id && id !== 'all' ? id : 'all';
    if (districtSel) { districtGroup.remove(districtSel); districtSel.geometry.dispose(); districtSel.material.dispose(); districtSel = null; }
    if (districtFill) { districtGroup.remove(districtFill); districtFill.geometry.dispose(); districtFill.material.dispose(); districtFill = null; }
    var d = regionId === 'all' ? null : findDistrict(regionId);
    if (d && d.polygon && d.polygon.length > 2) {
      var y = Y();
      districtSel = new THREE.Mesh(B.ribbonGeometry(d.polygon, 2.6, y.district + 0.1, true),
        new THREE.MeshBasicMaterial({ color: col('--c-primary'), transparent: true, opacity: 0.9, depthWrite: false }));
      districtSel.renderOrder = 9;
      districtFill = new THREE.Mesh(flatShapeGeo(d.polygon, y.heat - 0.08),
        new THREE.MeshBasicMaterial({ color: col('--c-primary'), transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide }));
      districtFill.renderOrder = -1;
      districtGroup.add(districtFill); districtGroup.add(districtSel);
    }
    if (hoverDistrictId && districtHover[hoverDistrictId]) districtHover[hoverDistrictId].visible = hoverDistrictId !== regionId;
    for (var i = 0; i < labelHandles.length; i++) {
      var L = labelHandles[i];
      if (L.kind === 'district') U.setClass(L.h.el, 'is-active', L.id === regionId);
    }
    B.applyBuildingColors();
  };
  B.regionId = function () { return regionId; };

  function findDistrict(id) {
    var ds = city.districts || [];
    for (var i = 0; i < ds.length; i++) if (ds[i].id === id) return ds[i];
    return null;
  }

  B.focusBounds = function (districtId) {
    var d = districtId && districtId !== 'all' ? findDistrict(districtId) : null;
    if (!d || !d.polygon || !d.polygon.length) {
      var e = (city && city.meta && city.meta.extent) || 1000;
      return { center: { x: 0, z: 0 }, radius: e };
    }
    var minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    for (var i = 0; i < d.polygon.length; i++) {
      var x = px(d.polygon[i]), z = pz(d.polygon[i]);
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    var cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    return { center: { x: cx, z: cz }, radius: Math.max(maxX - minX, maxZ - minZ) / 2 };
  };

  /* ======================================================= 生命周期 ====== */
  B.build = function (cityData) {
    if (B.ready) B.dispose();
    city = cityData || (TP.City && TP.City.data);
    if (!city) throw new Error('TP.CityBuilder.build: 缺少城市数据');
    var t0 = U.now();
    B.group = new THREE.Group(); B.group.name = 'city';
    B.pickables = [];
    TP.Scene.world.add(B.group);
    buildWaterGreen();
    buildRoads();
    buildBuildings();
    for (var i = 0; i < B.buildingMeshes.length; i++) B.pickables.push(B.buildingMeshes[i]);
    buildDistricts();
    B.buildMs = Math.round(U.now() - t0);
    B.ready = true;
    TP.Scene.log('CityBuilder.build ' + B.buildMs + 'ms, roads=' + (city.roads || []).length + ', buildings=' + (city.buildings || []).length);
    return B;
  };

  B.applyTheme = function () {
    if (!B.ready) return;
    if (boxGeo) writeBoxColors(boxGeo);
    B.setBuildingStyle(B.style);
    if (casingMesh) casingMesh.material.color.copy(col('--road-casing'));
    if (B.discs) B.discs.casing.material.color.copy(col('--road-casing'));
    /* 路网回到中性色；路况色由 TP.Layers.applyTheme() 重新刷上 */
    for (var id in B.roadVertexRange) {
      if (!Object.prototype.hasOwnProperty.call(B.roadVertexRange, id)) continue;
      var c = neutralRoadColor(B.roadVertexRange[id].cls);
      B.setRoadColor(id, c.r, c.g, c.b);
    }
    B.flushRoadColors();
    if (waterMesh) { waterMesh.material.color.copy(waterColor()); bankMesh.material.color.copy(bankColor()); }
    if (greenMesh) greenMesh.material.color.copy(greenColor());
    if (districtLines) districtLines.material.color.copy(col('--c-border-strong'));
    for (var k in districtHover) if (Object.prototype.hasOwnProperty.call(districtHover, k)) districtHover[k].material.color.copy(col('--c-primary'));
    B.setRegionHighlight(regionId);
  };

  B.dispose = function () {
    if (!B.group) return;
    for (var i = 0; i < labelHandles.length; i++) labelHandles[i].h.remove();
    labelHandles = [];
    B.group.traverse(function (o) {
      if (o.geometry && o.geometry !== boxGeo) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    if (boxGeo) boxGeo.dispose();
    if (B.group.parent) B.group.parent.remove(B.group);
    B.group = null; bInfo = {}; B.buildingMeshes = []; B.pickables = []; B.roadMeshes = {};
    B.roadVertexRange = {}; B.discs = null; districtHover = {}; districtSel = districtFill = null;
    hGrid = null; planK = 0; regionId = 'all';
    B.ready = false;
  };

})(window);
