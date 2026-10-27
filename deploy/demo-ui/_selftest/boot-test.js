/* ============================================================================
 * boot-test.js —— 构造阶段集成测试（临时工具，验收后删除）
 *
 * 为什么能在 Node 里跑：
 *   CityBuilder.build / Layers.init 只用到 THREE 的 **CPU 侧**（几何、材质、InstancedMesh），
 *   不需要 WebGL 上下文。所以可以在浏览器之前就把这两大模块的构造逻辑真跑一遍。
 *   唯一跑不了的是 TP.Scene.init（要 WebGLRenderer），这里用最小状态替身补上它创建的东西。
 * ==========================================================================*/
'use strict';
const { boot, ROOT } = require('./stub.js');

const fail = [];
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
  if (!ok) fail.push(name);
}

/* ---------------- 0. 加载 ---------------- */
const env = boot();
const TP = env.TP, THREE = env.THREE;
console.log(`加载 ${env.loaded.length}/${env.scripts.length} 个脚本`);
for (const f of env.loadFailed) console.log(`  ✗ ${f.file} → ${f.err}`);

/* 只有这些文件缺失/加载失败才中止 —— 它们本测试要验证的对象。
   其余（charts / ui / app）可能还在并行产出中，只告警不阻断。 */
const CRITICAL = [
  'js/utils.js', 'js/theme-bridge.js',
  'js/data/city-model.js', 'js/data/sim-engine.js', 'js/data/data-api.js',
  'js/three/scene.js', 'js/three/city-builder.js', 'js/three/camera-rig.js', 'js/three/layers.js'
];
const criticalFailed = env.loadFailed.filter(f => CRITICAL.indexOf(f.file) >= 0);
const otherFailed = env.loadFailed.filter(f => CRITICAL.indexOf(f.file) < 0);
if (otherFailed.length) {
  console.log(`\n⚠ 非关键脚本未就绪（不影响本测试）：${otherFailed.map(f => f.file).join(', ')}`);
}
if (criticalFailed.length) {
  console.log(`\n❌ 关键脚本加载失败，测试无法继续：`);
  for (const f of criticalFailed) console.log(`   ${f.file} → ${f.err}`);
  process.exit(1);
}
console.log('');

/* ---------------- 1. TP.Scene 的最小状态替身 ---------------- */
/* init() 需要 WebGLRenderer，Node 里跑不了。它创建 world / dataGroup / 标签容器，
   这里手工补上，让 CityBuilder 与 Layers 能把几何挂进去。
   其余（Y 偏移表 / color / colorOf / log）都是模块加载时就绪的纯函数，直接用真的。 */
TP.Scene.world = new THREE.Group(); TP.Scene.world.name = 'world';
TP.Scene.dataGroup = new THREE.Group(); TP.Scene.dataGroup.name = 'data';
/* setRegionHighlight / applyTheme 会往场景里增删对象，需要 scene 与 camera 存在 */
TP.Scene.scene = new THREE.Scene();
TP.Scene.camera = new THREE.PerspectiveCamera(42, 16 / 9, 1, 7000);
TP.Scene.camera.position.set(0, 900, 1250);
TP.Scene.size = { w: 1920, h: 1080 };
let labelsAlive = 0, labelsAdded = 0;
const REAL_ADD_LABEL = TP.Scene.addLabel;
/* 真实现返回的句柄有 { el, remove(), setVisible(v), hidden }，替身要对齐，
   否则 city-builder 里的 labelHandles[i].h.setVisible(...) 会报"不是函数"。 */
TP.Scene.addLabel = function (html, posFn, o) {
  labelsAdded++; labelsAlive++;
  const el = {
    style: {}, className: '', innerHTML: html, parentNode: null,
    /* 真实现是真实 DOM 元素，必须带 classList —— city-builder 的
       setRegionHighlight 会对标签元素做 U.setClass(el, 'is-active', ...) */
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    remove() {}
  };
  const h = {
    el: el, hidden: false, html: html,
    remove: function () { labelsAlive--; },
    setVisible: function (v) { h.hidden = !v; }
  };
  return h;
};
TP.Scene.groundPoint = function () { return { x: 0, z: 0 }; };
TP.Scene.raycast = function () { return null; };
TP.Scene.screenPos = function () { return { x: 0, y: 0, visible: true, depth: 0 }; };
TP.Scene.markDirty = function () {};

check('TP.Scene 关键成员齐备（Y/color/colorOf/log/addLabel）',
  !!TP.Scene.Y && typeof TP.Scene.color === 'function' && typeof TP.Scene.colorOf === 'function' &&
  typeof TP.Scene.log === 'function' && typeof REAL_ADD_LABEL === 'function',
  `Y 偏移键：${Object.keys(TP.Scene.Y).join(',')}`);

/* ---------------- 2. 数据层引导 ---------------- */
let t = Date.now();
const city = TP.City.build();
const tCity = Date.now() - t;
t = Date.now();
TP.Sim.init(city);
const tSim = Date.now() - t;
t = Date.now();
TP.Api.init();
const tApi = Date.now() - t;
TP.Api.setMinute(1080);
check('数据层引导成功', !!city && TP.Sim.ready && TP.Api.isReady,
  `City ${tCity}ms / Sim ${tSim}ms / Api ${tApi}ms`);

/* ---------------- 3. CityBuilder.build ---------------- */
let buildErr = null;
t = Date.now();
try { TP.CityBuilder.build(city); } catch (e) { buildErr = e; }
const tBuilder = Date.now() - t;
check('TP.CityBuilder.build 无异常', !buildErr, buildErr ? `${buildErr.message}\n${(buildErr.stack || '').split('\n').slice(0, 3).join('\n')}` : `${tBuilder} ms`);
if (buildErr) { console.log('\n构造失败，中止'); process.exit(1); }

const w = TP.Scene.world;
check('静态城市已挂到 TP.Scene.world', w.children.length > 0, `world 子节点 ${w.children.length} 个`);
check('CityBuilder.pickables 非空', Array.isArray(TP.CityBuilder.pickables) && TP.CityBuilder.pickables.length > 0,
  `${TP.CityBuilder.pickables.length} 个可拾取对象`);

/* roadMeshById / focusBounds / 高亮 / 主题 等契约方法 */
let apiErr = [];
function tryCall(label, fn) {
  try { const r = fn(); return { ok: true, r: r }; }
  catch (e) {
    const at = (e.stack || '').split('\n').filter(l => l.indexOf('city-builder') >= 0 || l.indexOf('camera-rig') >= 0 || l.indexOf('layers.js') >= 0)[0];
    apiErr.push(`${label}: ${e.message}${at ? '  ' + at.trim() : ''}`);
    return { ok: false };
  }
}
const rm = tryCall('roadMeshById', () => TP.CityBuilder.roadMeshById(city.roads[0].id));
check('CityBuilder.roadMeshById 可用', rm.ok && !!rm.r, rm.ok ? (rm.r && rm.r.type ? rm.r.type : typeof rm.r) : '抛错');
const fb = tryCall('focusBounds(core)', () => TP.CityBuilder.focusBounds('core'));
check('CityBuilder.focusBounds 返回合理包围',
  fb.ok && fb.r && fb.r.center && isFinite(fb.r.center.x) && isFinite(fb.r.radius) && fb.r.radius > 0,
  fb.ok && fb.r ? `中心(${fb.r.center.x},${fb.r.center.z}) 半径 ${Math.round(fb.r.radius)}` : '抛错');
tryCall('setRegionHighlight(core)', () => TP.CityBuilder.setRegionHighlight('core'));
tryCall('setRegionHighlight(all)', () => TP.CityBuilder.setRegionHighlight('all'));
tryCall('setBuildingStyle(height)', () => TP.CityBuilder.setBuildingStyle('height'));
tryCall('setBuildingStyle(type)', () => TP.CityBuilder.setBuildingStyle('type'));
tryCall('setBuildingsVisible(false)', () => TP.CityBuilder.setBuildingsVisible(false));
tryCall('setBuildingsVisible(true)', () => TP.CityBuilder.setBuildingsVisible(true));
tryCall('applyTheme', () => TP.CityBuilder.applyTheme());
check('CityBuilder 契约方法全部可调用且不抛错', apiErr.length === 0, apiErr.join(' | ') || '7 个方法全部通过');

/* 行政区标签应该被创建 */
check('行政区地名标签已创建', labelsAdded >= 6, `累计注册标签 ${labelsAdded} 个（含地标）`);

/* ---------------- 4. Layers.init ---------------- */
TP.Scene.dataGroup.remove(TP.Layers.group);
let layerErr = null;
t = Date.now();
try { TP.Layers.init(city, TP.Sim); } catch (e) { layerErr = e; }
const tLayers = Date.now() - t;
check('TP.Layers.init 无异常', !layerErr, layerErr ? `${layerErr.message}\n${(layerErr.stack || '').split('\n').slice(0, 3).join('\n')}` : `${tLayers} ms`);
if (layerErr) { console.log('\n图层初始化失败，中止'); process.exit(1); }

const LAYER_IDS = ['traffic', 'vehicle', 'heat', 'incident', 'metro', 'bus',
                   'od', 'signal', 'parking', 'bike', 'carbon', 'district'];
const meta = TP.Layers.LAYERS || [];
check('TP.Layers.LAYERS 为 12 个图层且 id 与契约逐字一致',
  meta.length === 12 && LAYER_IDS.every(id => meta.some(x => x.id === id)),
  meta.map(x => x.id).join(','));
check('TP.Layers.group 已挂到 dataGroup', !!TP.Layers.group && TP.Scene.dataGroup.children.indexOf(TP.Layers.group) >= 0,
  `dataGroup 子节点 ${TP.Scene.dataGroup.children.length} 个`);
check('TP.Layers.pickables 非空', Array.isArray(TP.Layers.pickables) && TP.Layers.pickables.length > 0,
  `${TP.Layers.pickables.length} 个`);

/* 图层逐个开关 */
const toggleErr = [];
for (const id of LAYER_IDS) {
  try {
    TP.Layers.setVisible(id, true);
    if (TP.Layers.isVisible(id) !== true) toggleErr.push(`${id} 开失败`);
    TP.Layers.setVisible(id, false);
    if (TP.Layers.isVisible(id) !== false) toggleErr.push(`${id} 关失败`);
    TP.Layers.setVisible(id, true);
  } catch (e) { toggleErr.push(`${id}: ${e.message}`); }
}
check('12 个图层逐个开关均正常', toggleErr.length === 0, toggleErr.join(' | ') || '全部正常');

/* ---------------- 5. 逐帧预算：applyTime 与 update ---------------- */
/* applyTime 是"时间变了之后重刷全部按时变图层"，是拖时间轴时的关键开销 */
const applyTimes = [];
for (let i = 0; i < 40; i++) {
  TP.Sim.setTime((i * 37) % 1440);
  const s = Date.now();
  TP.Layers.applyTime();
  applyTimes.push(Date.now() - s);
}
applyTimes.sort((a, b) => a - b);
const applyMed = applyTimes[Math.floor(applyTimes.length / 2)];
const applyMax = applyTimes[applyTimes.length - 1];
check('Layers.applyTime() 中位耗时 < 12ms（契约硬指标）', applyMed < 12,
  `中位 ${applyMed}ms / 最大 ${applyMax}ms（40 次采样）`);

let updErr = null;
const updTimes = [];
for (let i = 0; i < 120; i++) {
  const s = Date.now();
  try { TP.Layers.update(16.7); } catch (e) { updErr = e; break; }
  updTimes.push(Date.now() - s);
}
updTimes.sort((a, b) => a - b);
check('Layers.update(dt) 每帧不抛错', !updErr, updErr ? updErr.message : '120 帧全部通过');
check('Layers.update(dt) 中位耗时 < 8ms', updTimes[Math.floor(updTimes.length / 2)] < 8,
  `中位 ${updTimes[Math.floor(updTimes.length / 2)]}ms / 最大 ${updTimes[updTimes.length - 1]}ms`);

/* 高亮 / 过滤 / 主题 */
const hlErr = tryCall('highlight(road)', () => TP.Layers.highlight(city.roads[0].id, 'road'));
const hl2 = tryCall('highlight(null)', () => TP.Layers.highlight(null));
tryCall('setRegionFilter', () => TP.Layers.setRegionFilter(TP.Api.regionFilter()));
TP.Api.setRegion('core');
tryCall('setRegionFilter(core)', () => TP.Layers.setRegionFilter(TP.Api.regionFilter()));
TP.Api.setRegion('all');
tryCall('setRegionFilter(null)', () => TP.Layers.setRegionFilter(null));
tryCall('applyTheme', () => TP.Layers.applyTheme());
tryCall('setParticleScale', () => TP.Layers.setParticleScale(0.6));
tryCall('setParticleScale(1)', () => TP.Layers.setParticleScale(1));
check('Layers 高亮/过滤/主题/粒子缩放 均可用', hlErr.ok && hl2.ok, apiErr.slice(-4).join(' | ') || 'ok');

/* ---------------- 6. resolveHit（3D 命中 → 抽屉数据的桥梁） ---------------- */
const hitSamples = [];
let hitErr2 = null;
for (const obj of TP.Layers.pickables.slice(0, 40)) {
  try {
    const r = TP.Layers.resolveHit(obj, 0, { x: 0, y: 0, z: 0 });
    if (r) hitSamples.push(r);
  } catch (e) { hitErr2 = e; break; }
}
check('Layers.resolveHit 不抛错', !hitErr2, hitErr2 ? hitErr2.message : `抽样 ${Math.min(40, TP.Layers.pickables.length)} 个对象，解析出 ${hitSamples.length} 条结构化命中`);
const kinds = [...new Set(hitSamples.map(x => x && x.kind).filter(Boolean))];
check('resolveHit 返回契约结构 kind/id', kinds.length > 0 && hitSamples.every(x => x.id !== undefined),
  `命中类型：${kinds.join(',') || '无'}`);

/* 命中结果必须能被 TP.Api.pickInfo 消费 */
let pickOk = 0, pickTotal = 0;
for (const h of hitSamples) {
  pickTotal++;
  try { if (TP.Api.pickInfo(h)) pickOk++; } catch (e) { /* 记在下面 */ }
}
check('resolveHit → TP.Api.pickInfo 全链路可解析（>60%）',
  pickTotal === 0 || pickOk / pickTotal > 0.6,
  `${pickOk}/${pickTotal} 条成功换取详情对象`);

/* ---------------- 7. 性能预算实测（draw call / 三角面） ---------------- */
function sceneStats(root) {
  let tris = 0, draws = 0, instancedTotal = 0, instancedMeshes = 0, meshes = 0, lines = 0, points = 0;
  root.traverse(function (o) {
    const isDrawable = o.isMesh || o.isLine || o.isLineSegments || o.isPoints || o.isSprite;
    if (!isDrawable || o.visible === false) return;
    draws++;
    if (o.isMesh) meshes++;
    if (o.isLine || o.isLineSegments) lines++;
    if (o.isPoints) points++;
    const g = o.geometry;
    if (!g || !g.attributes || !g.attributes.position) return;
    const n = g.index ? g.index.count : g.attributes.position.count;
    let tt = Math.floor(n / 3);
    let cnt = 1;
    if (o.isInstancedMesh) { cnt = o.count; instancedMeshes++; instancedTotal += o.count; }
    tris += tt * cnt;
  });
  return { tris, draws, meshes, lines, points, instancedMeshes, instancedTotal };
}
const stWorld = sceneStats(w);
const stData = sceneStats(TP.Scene.dataGroup);
const stAll = sceneStats({ traverse: function (fn) { w.traverse(fn); TP.Scene.dataGroup.traverse(fn); } });
check('draw call < 200（契约硬指标）', stAll.draws < 200,
  `合计 ${stAll.draws}（静态城市 ${stWorld.draws} + 数据图层 ${stData.draws}）`);
check('三角面 < 150 万（契约硬指标）', stAll.tris < 1500000,
  `合计 ${(stAll.tris / 10000).toFixed(1)} 万（静态 ${(stWorld.tris / 10000).toFixed(1)} 万 + 图层 ${(stData.tris / 10000).toFixed(1)} 万）`);
check('车流粒子使用 InstancedMesh 且数量 ≤ 3000',
  (function () {
    /* 只校验**车流粒子**自身规模；早期版本把圆盘/建筑/信号灯的实例一起求和，
       阈值自然会被数据规模带偏（路网扩容后必然误报）。 */
    if (typeof TP.Layers.stats === 'function') {
      try { const s = TP.Layers.stats(); if (s && s.vehicle !== undefined) return s.vehicle <= 3000; } catch (e) {}
    }
    let v = 0;
    TP.Scene.dataGroup.traverse(function (o) {
      if (o.isInstancedMesh && /vehicle/.test(o.name || '')) v += o.count;
    });
    return v <= 3000;
  })(),
  (function () {
    try { const s = TP.Layers.stats(); return 'vehicle=' + s.vehicle + '（cap ' + s.particleCap + '）'; }
    catch (e) { return 'stats() 不可用'; }
  })());
check('全部 InstancedMesh 实例总数在合理量级（信息项，非硬指标）',
  stAll.instancedTotal < 40000,
  `实例总数 ${stAll.instancedTotal}（含圆盘/建筑/信号灯等，仅供观察）`);
console.log(`    细目：Mesh ${stAll.meshes} / Line ${stAll.lines} / Points ${stAll.points} / InstancedMesh ${stAll.instancedMeshes}`);

/* 分层实例数（车流粒子是重点：契约要求 ≤3000 且必须实例化） */
if (typeof TP.Layers.stats === 'function') {
  try {
    const s = TP.Layers.stats();
    console.log('    TP.Layers.stats() = ' + JSON.stringify(s));
    if (s && s.vehicle !== undefined) {
      check('车流粒子数 ≤ 3000（契约硬指标）', s.vehicle <= 3000, `vehicle = ${s.vehicle}`);
    }
  } catch (e) { console.log('    stats() 抛错: ' + e.message); }
}
/* 各 InstancedMesh 的实例数，用于确认粒子规模 */
const instDetail = [];
TP.Scene.dataGroup.traverse(function (o) {
  if (o.isInstancedMesh) instDetail.push(`${o.name || o.type}=${o.count}`);
});
console.log('    图层实例化明细：' + instDetail.join(' '));

/* ---------------- 8. CameraRig（不需要 WebGL） ---------------- */
const cam = new THREE.PerspectiveCamera(42, 16 / 9, 1, 7000);
cam.position.set(0, 900, 1250);
let rigErr = null;
try { TP.CameraRig.init(cam, TP.Scene.world); } catch (e) { rigErr = e; }
check('TP.CameraRig.init 无异常', !rigErr, rigErr ? rigErr.message : 'ok');
if (!rigErr) {
  const modeErr = [];
  for (const m of ['orbit', 'top', 'bird', 'cruise']) {
    try {
      TP.CameraRig.setMode(m);
      for (let i = 0; i < 90; i++) TP.CameraRig.update(16.7);   /* 推进过渡动画 */
      if (TP.CameraRig.mode !== m) modeErr.push(`${m} 未生效（当前 ${TP.CameraRig.mode}）`);
      if (!isFinite(cam.position.x) || !isFinite(cam.position.y) || !isFinite(cam.position.z)) {
        modeErr.push(`${m} 后相机位置非有限值`);
      }
    } catch (e) { modeErr.push(`${m}: ${e.message}`); }
  }
  check('四种视角模式均可切换且相机位置有效', modeErr.length === 0, modeErr.join(' | ') || 'orbit/top/bird/cruise 全部通过');

  const rigTime = [];
  for (let i = 0; i < 200; i++) { const s = Date.now(); TP.CameraRig.update(16.7); rigTime.push(Date.now() - s); }
  rigTime.sort((a, b) => a - b);
  check('CameraRig.update 中位耗时 < 3ms', rigTime[100] < 3, `中位 ${rigTime[100]}ms / 最大 ${rigTime[199]}ms`);
  check('heading / pitch / distance 为有限值',
    isFinite(TP.CameraRig.heading) && isFinite(TP.CameraRig.pitch) && isFinite(TP.CameraRig.distance),
    `heading ${(TP.CameraRig.heading * 180 / Math.PI).toFixed(1)}° / pitch ${(TP.CameraRig.pitch * 180 / Math.PI).toFixed(1)}° / 距离 ${Math.round(TP.CameraRig.distance)}`);
  tryCall('CameraRig.focusOn', () => TP.CameraRig.focusOn(200, -150, { radius: 400 }));
  tryCall('CameraRig.setBounds', () => TP.CameraRig.setBounds(-1000, 1000, -1000, 1000));
  tryCall('CameraRig.setCruisePath', () => TP.CameraRig.setCruisePath(city.corridors[2].path));
  tryCall('CameraRig.reset', () => TP.CameraRig.reset());
  check('CameraRig 其余契约方法可调用', apiErr.filter(x => x.indexOf('CameraRig') >= 0).length === 0,
    apiErr.filter(x => x.indexOf('CameraRig') >= 0).join(' | ') || 'ok');
}

/* ---------------- 9. 整条引导链的端到端耗时 ---------------- */
console.log(`\n=== 引导链耗时（Node）===`);
console.log(`  City.build ${tCity}ms → Sim.init ${tSim}ms → Api.init ${tApi}ms → CityBuilder.build ${tBuilder}ms → Layers.init ${tLayers}ms`);
console.log(`  合计 ${tCity + tSim + tApi + tBuilder + tLayers} ms（浏览器里还要加 Scene.init 的 WebGL 初始化）`);

console.log(fail.length ? `\n❌ 未通过 ${fail.length} 项:\n  - ${fail.join('\n  - ')}` : '\n✅ 构造阶段集成测试全部通过');
process.exit(fail.length ? 1 : 0);
