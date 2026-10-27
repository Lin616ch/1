/* 临时自测：数据接口门面 TP.Api（非交付物，验收后删除） */
global.window = {};
require('../js/utils.js');
require('../js/data/city-model.js');
require('../js/data/sim-engine.js');
require('../js/data/data-api.js');

const TP = global.window.TP;
const U = TP.Util;

const fail = [];
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
  if (!ok) fail.push(name);
}

const city = TP.City.build();
TP.Sim.init(city);
const Api = TP.Api;
Api.init();
Api.setMinute(1080);          // 晚高峰
Api.setDayType('weekday');

check('Api.ready() 为真', Api.ready() === true, String(Api.ready()));

/* ---------- 1. 快照完整性 ---------- */
const snap = Api.snapshot();
const reqTop = ['time', 'kpi', 'districts', 'layers', 'regions', 'views', 'modules', 'alerts'];
check('snapshot 顶层字段齐全', reqTop.every(k => snap[k] !== undefined),
  reqTop.filter(k => snap[k] === undefined).join(',') || '齐全');
const reqKpi = ['avgSpeed', 'congestionIndex', 'inNetVehicles', 'totalFlow', 'flowRate', 'incidentCount',
  'transitRidership', 'transitShare', 'parkingOccupancy', 'parkingAvailable', 'bikeRides',
  'bikeTurnover', 'carbonToday', 'carbonSaved', 'greenShare', 'onTimeRate', 'avgDelay',
  'avgQueue', 'signalCount', 'greenWaveCount', 'emergencyResp', 'congestionDelta', 'speedDelta'];
const missK = reqKpi.filter(k => snap.kpi[k] === undefined || !isFinite(snap.kpi[k]));
check('snapshot.kpi 字段齐全且为有限数', missK.length === 0, missK.join(',') || '齐全');
check('snapshot.districts 为 6 个且带实时统计',
  snap.districts.length === 6 && snap.districts.every(d => d.avgSpeed > 0 && d.congestionIndex >= 0),
  snap.districts.map(d => `${d.short} ${d.avgSpeed}km/h`).join(' | '));
let jsonOk = true, jsonErr = '';
try { JSON.parse(JSON.stringify(snap)); } catch (e) { jsonOk = false; jsonErr = e.message; }
check('snapshot 可 JSON 序列化（无循环引用）', jsonOk, jsonErr || `约 ${JSON.stringify(snap).length} 字节`);

/* ---------- 2. 顶栏 / KPI 卡 ---------- */
const tk = Api.ticker();
check('ticker 6~10 条且字段完整', tk.length >= 6 && tk.length <= 10 &&
  tk.every(x => x.label && x.value !== undefined && x.unit !== undefined),
  `${tk.length} 条：${tk.map(x => x.label + ' ' + x.value + x.unit).slice(0, 4).join(' / ')}…`);
const kc = Api.kpiCards();
check('kpiCards 为 4 张且带 spark 走势', kc.length === 4 && kc.every(c => Array.isArray(c.spark) && c.spark.length > 5),
  kc.map(c => `${c.label}=${c.value}${c.unit}`).join(' | '));
check('kpiCards 的 level 取值合法', kc.every(c => ['ok', 'warn', 'bad'].includes(c.level)),
  kc.map(c => c.level).join(','));

/* ---------- 3. 排行 ---------- */
let rankOk = true, rankMsg = [];
for (const kind of ['corridor', 'district', 'road', 'metroLine', 'busLine', 'parking']) {
  const r = Api.ranking(kind, null, 8);
  const good = r.length > 0 && r.every(x => x.id && x.name && isFinite(x.value) && isFinite(x.ratio) &&
    x.ratio >= 0 && x.ratio <= 1 && [0, 1, 2, 3].includes(x.level));
  if (!good) rankOk = false;
  rankMsg.push(`${kind}:${r.length}`);
}
check('ranking 六种口径均返回合法数据', rankOk, rankMsg.join(' '));
console.log('    走廊排行: ' + Api.ranking('corridor', null, 5).map(x =>
  `${x.name} 指数${x.display}`).join(' | '));
console.log('    行政区排行: ' + Api.ranking('district', null, 6).map(x =>
  `${x.name} ${x.display}`).join(' | '));

/* ---------- 4. 事件与播报 ---------- */
const inc = Api.incidents();
check('incidents 字段完整', inc.length > 0 && inc.every(x =>
  x.id && x.typeName && x.title && x.severityName && x.sinceHHMM && x.statusName && x.color),
  `${inc.length} 条，进行中 ${inc.filter(x => x.status === 'active').length} 条`);
check('alertsFeed 有内容且分级合法', snap.alerts.length > 0 &&
  snap.alerts.every(a => ['info', 'warn', 'danger'].includes(a.level)),
  `${snap.alerts.length} 条，最高级 ${snap.alerts[0].level}`);
const sum = Api.summary();
check('summary 为一段可读态势播报', typeof sum === 'string' && sum.length > 40 && sum.endsWith('。'),
  sum);

/* ---------- 5. 六个模块看板 ---------- */
const wantChart = { traffic: 'dualAxis', od: 'odMatrix', transit: 'barRank', signal: 'greenWave', park: 'stackedBar', carbon: 'pie' };
let boardOk = true;
for (const m of Api.MODULES) {
  const b = Api.moduleBoard(m.id);
  const ok = b && Array.isArray(b.metrics) && b.metrics.length >= 4 &&
    b.chart && b.chart.type === wantChart[m.id] &&
    b.metrics.every(x => x.label && x.value !== undefined);
  if (!ok) boardOk = false;
  console.log(`    ${m.id}: ${b.metrics.length} 指标 / chart=${b.chart.type} / legend=${b.legend.length}`);
}
check('六个模块看板结构正确（指标≥4 + 图表类型匹配）', boardOk, Object.values(wantChart).join(','));
Api.setModule('od');
const odb = Api.moduleBoard('od');
const mat = odb.chart.matrix;
check('OD 矩阵为 6×6 且对角线为 0', mat.values.length === 6 && mat.values.every(r => r.length === 6) &&
  mat.values.every((r, i) => r[i] === 0),
  `最大流向 ${odb.chart.top[0].from}→${odb.chart.top[0].to} ${odb.chart.top[0].volume}`);
const cb = Api.carbonBoard();
check('碳排构成合计 ≈ 当日总碳排',
  Math.abs(cb.perMode.reduce((s, x) => s + x.value, 0) - cb.total) < cb.total * 0.03,
  `合计 ${cb.perMode.reduce((s, x) => s + x.value, 0).toFixed(1)} vs ${cb.total}`);
check('绿色出行看板有减排分项', cb.greenModes.length >= 3 && cb.greenModes.every(g => g.saved > 0),
  cb.greenModes.map(g => `${g.name}${g.saved}吨`).join(' '));
Api.setModule('traffic');

/* ---------- 6. 序列 / 预测 / 时间轴 ---------- */
const se = Api.series('congestionIndex');
check('series 为 288 点', se.y.length === 288 && se.x.length === 288, `${se.y.length}`);
const fc = Api.forecast('congestionIndex', 60);
check('forecast 13 点且区间合法', fc.points.length === 13 && fc.points.every(p => p.lo <= p.v && p.v <= p.hi),
  `now=${fc.now} trend=${fc.trend} peak=${fc.peakHHMM}`);
const bands = Api.timelineBands();
check('timelineBands 为 144 格', bands.length === 144, `${bands.length}`);
check('时间轴 level 落在 1~4（契约的 data-level 口径）',
  bands.every(b => b.level >= 1 && b.level <= 4),
  `分布 ${[1, 2, 3, 4].map(l => l + ':' + bands.filter(b => b.level === l).length).join(' ')}`);
check('时间轴每格带颜色与提示文案', bands.every(b => b.color && b.label),
  `样例「${bands[108].label}」`);

/* ---------- 7. 详情：逐类型 ---------- */
const road = city.roads[0];
const ri = Api.roadInfo(road.id);
check('roadInfo 字段齐全', !!ri && ri.kind === 'road' && ri.title && ri.badges.length > 0 &&
  ri.metrics.length >= 6 && ri.series && ri.series.y.length === 288 && ri.forecast && ri.flowSteps.length > 0,
  ri ? `${ri.title} ${ri.subtitle}｜${ri.metrics.length} 指标｜24h 曲线 ${ri.series.y.length} 点｜预测 ${ri.forecast.points.length} 点｜周边线路 ${ri.transit.length}` : 'null');

const metroLine = city.transit.metroLines[0];
const mst = metroLine.stations[0];
const si = Api.stationInfo('metro', mst.id);
check('stationInfo(地铁站) 可用', !!si && si.title === mst.name && si.metrics.length >= 6,
  si ? `${si.title} @${si.subtitle} 满载${si.metrics[1].value}% 间隔${si.metrics[2].value}分` : 'null');
const busLine = city.transit.busLines[0];
const bst = busLine.stops[0];
const sb = Api.stationInfo('bus', bst.id);
check('stationInfo(公交站) 可用', !!sb && sb.title === bst.name,
  sb ? `${sb.title} @${sb.subtitle}` : 'null');

const park = city.facilities.parking[0];
const pi = Api.parkingInfo(park.id);
check('parkingInfo 可用', !!pi && pi.metrics.length === 4 && pi.color,
  pi ? `${pi.title} 占用${pi.metrics[0].value}% 余${pi.metrics[1].value}位` : 'null');
const bike = city.facilities.bike[0];
const bi = Api.bikeInfo(bike.id);
check('bikeInfo 可用', !!bi && bi.metrics.length === 4,
  bi ? `${bi.title} 可用${bi.metrics[0].value}辆` : 'null');
const ci = Api.corridorInfo(city.corridors[0].id);
check('corridorInfo 可用', !!ci && ci.metrics.length >= 5,
  ci ? `${ci.title} ${ci.subtitle}｜${ci.metrics.map(m => m.label + m.value).slice(0, 4).join(' ')}` : 'null');
const ii = Api.incidentInfo(inc[0].id);
check('incidentInfo 可用', !!ii && ii.metrics.length >= 5,
  ii ? `${ii.title}｜${ii.subtitle}｜影响半径${ii.metrics[0].value}km` : 'null');
const di = Api.districtInfo('core');
check('districtInfo 可用', !!di && di.metrics.length >= 8,
  di ? `${di.title}｜${di.subtitle}｜${di.badges[0].text}` : 'null');
const sigId = city.signals[0].id;
const sgi = Api.signalInfo(sigId);
check('signalInfo 可用', !!sgi && sgi.metrics.length >= 6 && sgi.splits.length >= 2,
  sgi ? `${sgi.title}｜${sgi.badges[0].text}｜相位${sgi.metrics[0].value} 余${sgi.metrics[1].value}s｜${sgi.splits.map(s => s.dir + ':' + s.green).join(',')}` : 'null');

/* ---------- 8. pickInfo 分派 ---------- */
const hitCases = [
  ['road', { kind: 'road', roadId: road.id, id: road.id }],
  ['parking', { kind: 'parking', id: park.id }],
  ['bike', { kind: 'bike', id: bike.id }],
  ['incident', { kind: 'incident', id: inc[0].id }],
  ['district', { kind: 'district', id: 'core' }],
  ['corridor', { kind: 'corridor', id: city.corridors[0].id }],
  ['station', { kind: 'station', id: mst.id, lineKind: 'metro' }],
  ['hub', { kind: 'hub', id: city.facilities.hubs[0].id }]
];
let pickOk = true, pickMsg = [];
for (const [name, hit] of hitCases) {
  const r = Api.pickInfo(hit);
  if (!r) { pickOk = false; pickMsg.push(name + ':null'); }
  else pickMsg.push(name + ':' + r.kind);
}
check('pickInfo 八种命中类型全部可解析', pickOk, pickMsg.join(' '));
check('pickInfo 对空输入返回 null', Api.pickInfo(null) === null && Api.pickInfo({}) === null, 'ok');

/* ---------- 9. 周边检索 ---------- */
const near = Api.searchNear(0, 0, 150);
check('searchNear 返回分类结果', near.roads.length > 0 && Array.isArray(near.stations) &&
  Array.isArray(near.parking) && Array.isArray(near.incidents),
  `道路${near.roads.length} 站点${near.stations.length} 停车${near.parking.length} 单车${near.bike.length} 事件${near.incidents.length}`);
check('searchNear 结果按距离升序', near.roads.every((x, i) => i === 0 || x.distanceM >= near.roads[i - 1].distanceM),
  near.roads[0] ? `最近 ${near.roads[0].name} ${near.roads[0].distanceM}m` : '');

/* ---------- 10. 区域筛选 ---------- */
Api.setRegion('core');
const vids = Api.visibleRoadIds();
const coreRoads = city.roads.filter(r => r.districtId === 'core');
check('setRegion 后 visibleRoadIds 只含该区路段', Object.keys(vids).length === coreRoads.length,
  `core ${Object.keys(vids).length} 条 / 全市 ${city.roads.length} 条`);
check('setRegion 后 regionRoads 同步收窄', Api.regionRoads().length === coreRoads.length, `${Api.regionRoads().length}`);
const rf = Api.regionFilter();
check('regionFilter 判定正确', rf({ districtId: 'core' }) === true && rf({ districtId: 'east' }) === false, 'ok');
Api.setRegion('all');
check('切回 all 后 regionFilter 恒真', Api.regionFilter()({ districtId: 'east' }) === true, 'ok');

/* ---------- 11. 图层元数据 ---------- */
const lm = Api.layersMeta();
check('图层数量与 3D 契约一致（12 个）', lm.length === 12, `${lm.length}`);
const wantLayers = ['traffic', 'vehicle', 'heat', 'incident', 'metro', 'bus', 'od', 'signal', 'parking', 'bike', 'carbon', 'district'];
check('图层 id 与 3D 契约 §5.1 逐字一致',
  wantLayers.every(id => lm.some(x => x.id === id)),
  lm.map(x => x.id).join(','));
check('每个图层都有图标 SVG 与实时数量', lm.every(x => x.icon && x.icon.indexOf('<svg') === 0 && isFinite(x.count)),
  lm.map(x => `${x.name}:${U.int(x.count)}`).join(' '));
check('默认开启的图层 = traffic/heat/incident/district',
  lm.filter(x => x.on).map(x => x.id).sort().join(',') === 'district,heat,incident,traffic',
  lm.filter(x => x.on).map(x => x.id).join(','));

/* ---------- 12. 事件总线 ---------- */
let got = {};
const off1 = Api.on('time', p => { got.time = p; });
Api.on('region', p => { got.region = p; });
Api.on('layer', p => { got.layer = p; });
Api.on('module', p => { got.module = p; });
Api.setMinute(500);
Api.setRegion('east');
Api.setLayer('metro', true);
Api.setModule('transit');
check('事件总线派发 time/region/layer/module',
  got.time && got.time.hhmm === '08:20' && got.region.regionId === 'east' &&
  got.layer.id === 'metro' && got.layer.on === true && got.module.moduleId === 'transit',
  `time=${got.time && got.time.hhmm} region=${got.region && got.region.regionId} layer=${got.layer && got.layer.id} module=${got.module && got.module.moduleId}`);
off1();
got.time = null;
Api.setMinute(600);
check('取消订阅后不再收到事件', got.time === null, 'ok');

/* ---------- 13. 状态联动（切模块/时间后派生数据确实变化） ---------- */
Api.setMinute(1080);
const snapA = Api.snapshot();
Api.setMinute(240);
const snapB = Api.snapshot();
check('不同时刻派生数据不同', snapA.kpi.avgSpeed !== snapB.kpi.avgSpeed,
  `18:00 ${snapA.kpi.avgSpeed} km/h vs 04:00 ${snapB.kpi.avgSpeed} km/h`);
const board18 = (Api.setMinute(1080), Api.moduleBoard('traffic'));
const board04 = (Api.setMinute(240), Api.moduleBoard('traffic'));
check('模块看板随时刻变化', board18.metrics[1].value !== board04.metrics[1].value,
  `拥堵指数 ${board04.metrics[1].value} → ${board18.metrics[1].value}`);

/* ---------- 14. 适配器与格式化 ---------- */
check('adapter 默认 mock 模式', Api.adapter.mode === 'mock' && typeof Api.adapter.fetchSnapshot === 'function', Api.adapter.mode);
check('fmt 格式化可用', Api.fmt.hhmm(1080) === '18:00' && Api.fmt.pct(46.83, 1) === '46.8%' &&
  Api.fmt.int(1792) === '1,792' && Api.fmt.levelName(2) === '拥堵' && Api.fmt.clsName('expressway') === '快速路',
  `${Api.fmt.hhmm(1080)} / ${Api.fmt.pct(46.83, 1)} / ${Api.fmt.int(1792)} / ${Api.fmt.levelName(2)}`);

/* ---------- 15. 缓存一致性（同状态重复取值必须一致） ---------- */
Api.setMinute(1080);
check('同状态下 snapshot 幂等',
  JSON.stringify(Api.snapshot()) === JSON.stringify(snapA), '逐字节一致');

console.log(`\n=== 数据接口自测 ===`);
console.log(fail.length ? `\n未通过 ${fail.length} 项:\n  - ${fail.join('\n  - ')}` : '\n全部通过');
process.exit(fail.length ? 1 : 0);
