/* ============================================================
   路面测量工作台 · 移动端 App 逻辑
   - 计算逻辑与桌面版一致（已逐项验证）
   - 持久化：sql.js（SQLite WASM）→ survey.db，存于 IndexedDB
   - 失败回退 localStorage
   ============================================================ */

let state;

function defaultState() {
  return {
    project: {
      name: '兴运道东段沥青混凝土路面测量',
      layers: [
        { key: 'ac_fine',  name: '细粒式改性沥青混凝土上面层', thickness: 0.04 },
        { key: 'ac_mid',   name: '中粒式沥青混凝土中面层',     thickness: 0.06 },
        { key: 'cs_upper', name: '水泥稳定碎石上基层',         thickness: 0.18 },
        { key: 'cs_lower', name: '水泥稳定碎石下基层',         thickness: 0.18 },
        { key: 'cs_sub',   name: '水泥稳定碎石底基层',         thickness: 0.18 }
      ],
      subItem: 'ac_fine',
      looseThickness: 0.0,
      crossSlope: 0.02,
      offsets: [0, 5, 10],
      tolerance: 5,
      benchmarks: [
        { name: 'BM1', elevation: 9.0 },
        { name: 'BM2', elevation: 9.5 }
      ],
      controlPoints: [
        { station: 'K0+600', elevation: 9.326 },
        { station: 'K0+620', elevation: 9.370 }
      ]
    },
    measureSetup: { benchmark: 'BM1', backsight: 1.5, los: '' },
    measures: [],
    inputMode: 'normal',
    showMeasureElev: true,
    showMeasureDiff: true,
    showMeasureOrig: false,
    measureSessions: [],
    showSessionElev: true,
    showSessionDiff: true,
    showSessionOrig: true
  };
}

/* ---------- 桩号解析 ---------- */
function parseStation(s) {
  if (!s) return NaN;
  const m = String(s).toUpperCase().match(/^K?(\d+)\+(\d+)$/);
  if (!m) return NaN;
  return parseInt(m[1], 10) * 1000 + parseInt(m[2], 10);
}
function formatStation(meters) {
  if (isNaN(meters)) return '';
  const km = Math.floor(meters / 1000);
  const m = meters - km * 1000;
  return `K${km}+${String(m).padStart(3, '0')}`;
}

/* ---------- 核心计算 ---------- */
function elevationAtStation(stationM) {
  const cps = state.project.controlPoints
    .map(c => ({ m: parseStation(c.station), e: parseFloat(c.elevation) }))
    .filter(c => !isNaN(c.m) && !isNaN(c.e))
    .sort((a, b) => a.m - b.m);
  if (!cps.length) return NaN;
  if (stationM <= cps[0].m) return cps[0].e;
  if (stationM >= cps[cps.length - 1].m) return cps[cps.length - 1].e;
  for (let i = 0; i < cps.length - 1; i++) {
    if (stationM >= cps[i].m && stationM <= cps[i + 1].m) {
      const t = (stationM - cps[i].m) / (cps[i + 1].m - cps[i].m);
      return cps[i].e + t * (cps[i + 1].e - cps[i].e);
    }
  }
  return NaN;
}

// 测量目标高程（摊铺前应达到的设计高程）= 设计标高 − 不生效层厚之和 + 虚铺 − 偏距×横坡
// 不生效层厚之和 = 全部层厚 − 生效层厚，等价于旧公式 (总厚 − 生效层厚)，但不再依赖手填的"总厚度"字段
function computeMeasureInputs(designElev) {
  const D = parseFloat(designElev);
  const act = activeLayerKeys();
  const allLayers = totalLayerThickness();
  const sumLayers = state.project.layers.reduce((s, l) => s + (act.has(l.key) ? (parseFloat(l.thickness) || 0) : 0), 0);
  const inactive = allLayers - sumLayers; // 不生效层厚之和
  const loose = parseFloat(state.project.looseThickness);
  const cs = parseFloat(state.project.crossSlope);
  const o = state.project.offsets;
  const offsetMap = [o[2], o[1], o[0], o[1], o[2]]; // 南/南腰/中/北腰/北
  if (isNaN(D) || isNaN(loose) || isNaN(cs)) return [null, null, null, null, null];
  return offsetMap.map(d => D - inactive + loose - d * cs);
}

// 测量高程（实测） = 视线高 − 原始数据
function computeMeasureElev(m) {
  const los = parseFloat(state.measureSetup.los);
  const od = m.originalData || [null, null, null, null, null];
  if (isNaN(los)) return [null, null, null, null, null];
  return od.map(v => (v !== null && v !== '') ? (los - v) : null);
}

// 测量差值（偏差） = 视线高 − 目标高程 − 原始数据 = 实测 − 设计目标
function computeMeasureDiffs(m) {
  const los = parseFloat(state.measureSetup.los);
  const od = m.originalData || [null, null, null, null, null];
  if (isNaN(los)) return [null, null, null, null, null];
  const mi = computeMeasureInputs(m.designElev);
  return mi.map((v, k) => (v !== null && od[k] !== null && od[k] !== '') ? (los - v - od[k]) : null);
}

/* ============================================================
   持久化：SQLite (sql.js) + IndexedDB 回退
   ============================================================ */
let SQL = null, db = null, useLS = false, _saveTimer = null;

function idbGet(key) {
  return new Promise((res, rej) => {
    const r = indexedDB.open('surveyDB', 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('kv')) r.result.createObjectStore('kv'); };
    r.onsuccess = () => {
      const tx = r.result.transaction('kv', 'readonly').objectStore('kv').get(key);
      tx.onsuccess = () => res(tx.result); tx.onerror = () => rej(tx.error);
    };
    r.onerror = () => rej(r.error);
  });
}
function idbSet(key, val) {
  return new Promise((res, rej) => {
    const r = indexedDB.open('surveyDB', 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('kv')) r.result.createObjectStore('kv'); };
    r.onsuccess = () => {
      const tx = r.result.transaction('kv', 'readwrite').objectStore('kv').put(val, key);
      tx.onsuccess = () => res(); tx.onerror = () => rej(tx.error);
    };
    r.onerror = () => rej(r.error);
  });
}

async function initDB() {
  try {
    if (typeof initSqlJs !== 'function') throw new Error('sql.js 未加载');
    // 部分运行环境（如沙箱预览 iframe）fetch wasm 会挂起不返回，
    // 加超时强制回退 localStorage，避免启动卡在"初始化数据库"。
    const SQL_ = await Promise.race([
      initSqlJs({ locateFile: f => 'lib/' + f }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('sql.js 加载超时')), 4000))
    ]);
    SQL = SQL_;
    const bytes = await idbGet('survey_db_v1');
    if (bytes && bytes.byteLength) db = new SQL.Database(new Uint8Array(bytes));
    else { db = new SQL.Database(); db.run('CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT)'); }
  } catch (e) {
    console.warn('SQLite 初始化失败，回退 localStorage：', e.message);
    useLS = true;
  }
}

function persistDB() {
  if (useLS || !db) return;
  try { idbSet('survey_db_v1', db.export()); } catch (e) { console.warn('persistDB 失败', e); }
}
function saveAll() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    if (useLS) { try { localStorage.setItem('survey_state', JSON.stringify(state)); } catch (e) {} return; }
    if (!db) return;
    db.run('INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)', ['app_state', JSON.stringify(state)]);
    persistDB();
  }, 250);
}
function loadAll() {
  let parsed = null;
  if (useLS) {
    try { parsed = JSON.parse(localStorage.getItem('survey_state') || 'null'); } catch (e) {}
  } else if (db) {
    try {
      const r = db.exec("SELECT value FROM kv WHERE key='app_state'");
      if (r.length && r[0].values.length) parsed = JSON.parse(r[0].values[0][0]);
    } catch (e) { console.warn('loadAll 失败', e); }
  }
  const base = defaultState();
  if (parsed && typeof parsed === 'object') {
    // 深合并，保证新增字段不丢失
    state = Object.assign(base, parsed);
    state.project = Object.assign(base.project, parsed.project || {});
    state.measureSetup = Object.assign(base.measureSetup, parsed.measureSetup || {});
    if (!Array.isArray(state.project.layers)) state.project.layers = base.project.layers;
    if (!Array.isArray(state.project.benchmarks)) state.project.benchmarks = base.project.benchmarks;
    if (!Array.isArray(state.project.controlPoints)) state.project.controlPoints = base.project.controlPoints;
    if (!Array.isArray(state.measures)) state.measures = [];
    if (!Array.isArray(state.measureSessions)) state.measureSessions = [];
  } else {
    state = base;
  }
}

function exportDB() {
  if (useLS || !db) { toast('当前为 localStorage 模式，无数据库文件'); return; }
  const bytes = db.export();
  downloadBlob(new Blob([bytes], { type: 'application/x-sqlite3' }), 'survey.db');
  toast('已导出 survey.db');
}
async function importDB(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    if (!useLS && SQL) {
      db = new SQL.Database(bytes);
      await idbSet('survey_db_v1', bytes);
    } else {
      localStorage.removeItem('survey_state');
    }
    loadAll();
    bindAll(); renderAll();
    toast('数据库已导入');
  } catch (e) {
    toast('导入失败：' + e.message);
  }
  input.value = '';
}
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 120);
}

/* ============================================================
   项目设置
   ============================================================ */
function bindProjectInputs() {
  document.getElementById('projectName').value = state.project.name || '';
  populateSubItem();
  document.getElementById('looseThickness').value = state.project.looseThickness;
  document.getElementById('crossSlope').value = state.project.crossSlope;
  const ltEl = document.getElementById('layerTotal');
  if (ltEl) ltEl.value = totalLayerThickness().toFixed(2);
  document.getElementById('off1').value = state.project.offsets[0];
  document.getElementById('off2').value = state.project.offsets[1];
  document.getElementById('off3').value = state.project.offsets[2];
  document.getElementById('tolerance').value = state.project.tolerance;
}
function onProjectChange() {
  state.project.looseThickness = parseFloat(document.getElementById('looseThickness').value) || 0;
  state.project.crossSlope = parseFloat(document.getElementById('crossSlope').value) || 0;
  state.project.offsets = [
    parseFloat(document.getElementById('off1').value) || 0,
    parseFloat(document.getElementById('off2').value) || 0,
    parseFloat(document.getElementById('off3').value) || 0
  ];
  state.project.tolerance = parseFloat(document.getElementById('tolerance').value) || 0;
  saveAll(); renderMeasures(); renderControlList();
}

// 分项工程：选到某层时，该层及其以下（朝路床方向，数组靠后）各层生效，其上各层不生效
function activeLayerKeys() {
  const cps = state.project.layers || [];
  let sel = state.project.subItem;
  if (!sel || !cps.some(l => l.key === sel)) sel = cps.length ? cps[0].key : '';
  const idx = cps.findIndex(l => l.key === sel);
  if (idx < 0) return new Set(cps.map(l => l.key));
  return new Set(cps.filter((l, i) => i >= idx).map(l => l.key)); // 选中层 + 以下
}
// 全部结构层厚度之和（替代手填的"总厚度"字段，避免与分层厚度不一致）
function totalLayerThickness() {
  return (state.project.layers || []).reduce((s, l) => s + (parseFloat(l.thickness) || 0), 0);
}
// 刷新"结构层总厚(m)·自动"显示：只改 layerTotal 这一个元素，
// 不整表重渲染，避免丢失正在输入的结构层厚度焦点
function updateLayerTotal() {
  const ltEl = document.getElementById('layerTotal');
  if (ltEl) ltEl.value = totalLayerThickness().toFixed(2);
}
// 用结构层名称填充分项工程下拉框（顺序与路面结构层卡片一致）
function populateSubItem() {
  const sel = document.getElementById('subItem');
  if (!sel) return;
  const cps = state.project.layers || [];
  let cur = state.project.subItem;
  if (!cur || !cps.some(l => l.key === cur)) cur = cps.length ? cps[0].key : '';
  state.project.subItem = cur;
  sel.innerHTML = cps.map(l => `<option value="${l.key}" ${l.key === cur ? 'selected' : ''}>${l.name}</option>`).join('');
}
function onSubItemChange() {
  const sel = document.getElementById('subItem');
  if (sel) state.project.subItem = sel.value;
  saveAll(); renderLayerList(); renderMeasures();
}

function renderLayerList() {
  const act = activeLayerKeys();
  const box = document.getElementById('layerList');
  box.innerHTML = state.project.layers.map((l, i) => `
    <div class="layer-item ${act.has(l.key) ? 'is-active' : 'is-inactive'}">
      <input type="text" value="${l.name}" onchange="state.project.layers[${i}].name=this.value;saveAll();populateSubItem();renderLayerList()">
      <input type="number" step="0.01" value="${l.thickness}" oninput="state.project.layers[${i}].thickness=parseFloat(this.value)||0;updateLayerTotal();saveAll();renderMeasures()">
      <span class="layer-state ${act.has(l.key) ? 'on' : 'off'}">${act.has(l.key) ? '生效' : '不生效'}</span>
      <button class="btn btn-sm btn-danger del" onclick="deleteLayer('${l.key}')">删</button>
    </div>`).join('');
  const ltEl = document.getElementById('layerTotal');
  if (ltEl) ltEl.value = totalLayerThickness().toFixed(2);
}
function addLayer() {
  state.project.layers.push({ key: 'L' + Date.now(), name: '新结构层', thickness: 0.05 });
  populateSubItem(); renderLayerList(); saveAll(); renderMeasures();
}
function deleteLayer(key) {
  state.project.layers = state.project.layers.filter(l => l.key !== key);
  populateSubItem(); renderLayerList(); saveAll(); renderMeasures();
}

function renderBenchmarkList() {
  const box = document.getElementById('benchmarkList');
  box.innerHTML = state.project.benchmarks.map((b, i) => `
    <div class="layer-item">
      <input type="text" value="${b.name}" onchange="state.project.benchmarks[${i}].name=this.value;saveAll();populateBenchmarks()">
      <input type="number" step="0.001" value="${b.elevation}" onchange="state.project.benchmarks[${i}].elevation=parseFloat(this.value)||0;saveAll();if(state.measureSetup.benchmark==='${b.name}')updateLineOfSight()">
      <button class="btn btn-sm btn-danger del" onclick="deleteBenchmark(${i})">删</button>
    </div>`).join('');
}
function addBenchmark() {
  state.project.benchmarks.push({ name: 'BM' + (state.project.benchmarks.length + 1), elevation: 0 });
  renderBenchmarkList(); populateBenchmarks(); saveAll();
}
function deleteBenchmark(i) {
  state.project.benchmarks.splice(i, 1);
  renderBenchmarkList(); populateBenchmarks(); saveAll();
}

function renderControlList() {
  const box = document.getElementById('controlList');
  const o = state.project.offsets || [0, 5, 10];
  const cs = parseFloat(state.project.crossSlope) || 0;
  box.innerHTML = state.project.controlPoints.map((c, i) => {
    const e = parseFloat(c.elevation) || 0;
    const e0 = e - o[0] * cs;
    const e5 = e - o[1] * cs;
    const e10 = e - o[2] * cs;
    return `
    <div class="cp-row">
      <div class="cp-main">
        <input type="text" value="${c.station}" onchange="state.project.controlPoints[${i}].station=this.value;saveAll();renderMeasures()">
        <input type="number" step="0.001" value="${c.elevation}" onchange="state.project.controlPoints[${i}].elevation=parseFloat(this.value)||0;saveAll();renderMeasures();renderControlList()">
        <button class="btn btn-sm btn-danger del" onclick="deleteControlPoint(${i})">删</button>
      </div>
      <div class="cp-offsets">
        <span class="cp-off"><i>偏距${o[0]}m</i><b>${e0.toFixed(3)}</b></span>
        <span class="cp-off"><i>偏距${o[1]}m</i><b>${e5.toFixed(3)}</b></span>
        <span class="cp-off"><i>偏距${o[2]}m</i><b>${e10.toFixed(3)}</b></span>
      </div>
    </div>`;
  }).join('');
}
function addControlPoint() {
  state.project.controlPoints.push({ station: 'K0+000', elevation: 0 });
  renderControlList(); saveAll(); renderMeasures();
}
function deleteControlPoint(i) {
  state.project.controlPoints.splice(i, 1);
  renderControlList(); saveAll(); renderMeasures();
}

// 批量粘贴导入控制点：每行「桩号 设计标高」（空格/Tab 分隔），支持大小写与 k1+5 简写
function importControlPoints() {
  const ta = document.getElementById('cpImport');
  const replace = document.getElementById('cpReplace') && document.getElementById('cpReplace').checked;
  const lines = (ta.value || '').split(/\r?\n/);
  const parsed = [];
  const skipped = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const tk = line.split(/\s+/);
    const st = tk[0];
    const ev = tk.length > 1 ? tk[tk.length - 1] : null; // 取末段，防尾随空格
    const m = parseStation(st);
    const e = parseFloat(ev);
    if (isNaN(m) || isNaN(e)) { skipped.push(line); continue; }
    parsed.push({ station: formatStation(m), elevation: e });
  }
  if (!parsed.length) { toast('未解析到有效控制点，请检查格式'); return; }
  let merged = replace ? parsed : state.project.controlPoints.concat(parsed);
  // 按桩号去重（保留先出现者）
  const seen = new Set();
  merged = merged.filter(c => {
    const k = parseStation(c.station);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  state.project.controlPoints = merged;
  renderControlList(); saveAll(); renderMeasures();
  if (skipped.length) toast(`已导入 ${parsed.length} 个，跳过 ${skipped.length} 行无效数据`);
  else toast(`已导入 ${parsed.length} 个控制点`);
}
function generateStations() {
  const cps = state.project.controlPoints
    .map(c => parseStation(c.station)).filter(m => !isNaN(m)).sort((a, b) => a - b);
  if (cps.length < 2) { toast('请至少录入 2 个控制点'); return; }
  const min = cps[0], max = cps[cps.length - 1], step = 10;
  const existing = new Set(state.measures.map(m => m.station));
  for (let m = min; m <= max; m += step) {
    const st = formatStation(m);
    if (existing.has(st)) continue;
    state.measures.push({ station: st, designElev: elevationAtStation(m).toFixed(4), originalData: [null, null, null, null, null], isControl: false });
    existing.add(st);
  }
  saveAll(); renderOriginalData(); renderMeasures();
  toast('已生成桩号序列（步距 10m）');
}

/* ============================================================
   原始数据
   ============================================================ */
function addMeasureRow(isControl) {
  state.measures.push({
    _id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2),
    station: '', designElev: '',
    originalData: [null, null, null, null, null],
    isControl: !!isControl
  });
  saveAll(); renderOriginalData(); renderMeasures();
}
function deleteMeasureRow(id) {
  state.measures = state.measures.filter(m => m._id !== id);
  saveAll(); renderOriginalData(); renderMeasures();
}
function renderOriginalData() {
  const body = document.getElementById('origdataBody');
  if (!state.measures.length) {
    body.innerHTML = '<tr><td colspan="8" class="empty-state"><p>暂无数据，点下方"添加测量行"</p></td></tr>';
    return;
  }
  body.innerHTML = state.measures.map(m => {
    const cells = (m.originalData || [null, null, null, null, null]).map((v, k) =>
      `<td><input type="number" step="0.001" value="${v !== null ? v : ''}" oninput="onOrigInput('${m._id}',${k},this.value)"></td>`
    ).join('');
    return `<tr class="${m.isControl ? 'row-control' : ''}">
      <td><input type="text" value="${m.station || ''}" placeholder="K0+600" oninput="onStationInput('${m._id}',this.value)" style="width:88px"></td>
      <td class="de-cell" id="de-${m._id}">${m.designElev || ''}</td>
      ${cells}
      <td><button class="btn btn-sm btn-danger" onclick="deleteMeasureRow('${m._id}')">删</button></td>
    </tr>`;
  }).join('');
}
function onOrigInput(id, k, val) {
  const m = state.measures.find(x => x._id === id);
  if (!m) return;
  m.originalData[k] = val === '' ? null : parseFloat(val);
  saveAll(); renderMeasures();
}
function onStationInput(id, val) {
  const m = state.measures.find(x => x._id === id);
  if (!m) return;
  m.station = val;
  const sm = parseStation(val);
  m.designElev = !isNaN(sm) ? elevationAtStation(sm).toFixed(4) : '';
  const deCell = document.getElementById('de-' + id);
  if (deCell) deCell.textContent = m.designElev || '';
  saveAll(); renderMeasures();
}
let _delArmed = false, _delTimer = null;
function deleteAllMeasures(btn) {
  if (!_delArmed) {
    _delArmed = true; btn.textContent = '确认删除？'; btn.classList.add('btn-armed');
    _delTimer = setTimeout(() => { _delArmed = false; btn.textContent = '全部删除'; btn.classList.remove('btn-armed'); }, 3000);
    return;
  }
  clearTimeout(_delTimer); _delArmed = false; btn.textContent = '全部删除'; btn.classList.remove('btn-armed');
  state.measures = [];
  saveAll(); renderOriginalData(); renderMeasures(); renderResults();
  toast('已清空全部测量行');
}

/* ============================================================
   测量录入
   ============================================================ */
function populateBenchmarks() {
  const sel = document.getElementById('bmSelect');
  const cur = state.measureSetup.benchmark;
  sel.innerHTML = state.project.benchmarks.map(b => `<option value="${b.name}" ${b.name === cur ? 'selected' : ''}>${b.name} (${b.elevation} m)</option>`).join('');
  if (!state.project.benchmarks.some(b => b.name === cur) && state.project.benchmarks.length) {
    state.measureSetup.benchmark = state.project.benchmarks[0].name;
  }
}
function onBenchmarkSelect() {
  state.measureSetup.benchmark = document.getElementById('bmSelect').value;
  updateLineOfSight(); saveAll();
}
function updateLineOfSight() {
  state.measureSetup.backsight = parseFloat(document.getElementById('backsight').value) || 0;
  const bm = state.project.benchmarks.find(b => b.name === state.measureSetup.benchmark);
  const los = bm ? (parseFloat(bm.elevation) + state.measureSetup.backsight) : NaN;
  state.measureSetup.los = isNaN(los) ? '' : los;
  document.getElementById('losValue').textContent = isNaN(los) ? '—' : los.toFixed(4);
  saveAll(); renderMeasures();
}
function renderMeasureHead() {
  const head = document.getElementById('measureHead');
  const showE = state.showMeasureElev, showD = state.showMeasureDiff, showO = state.showMeasureOrig;
  const pts = '<th>南</th><th>南腰</th><th>中</th><th>北腰</th><th>北</th>';
  const gE = showE ? '<th colspan="5" style="background:rgba(76,175,80,0.12)">测量高程</th>' : '';
  const gD = showD ? '<th colspan="5" style="background:rgba(33,150,243,0.12)">测量差值</th>' : '';
  const gO = showO ? '<th colspan="5" style="background:rgba(255,152,0,0.10)">原始数据</th>' : '';
  head.innerHTML = `<tr>
    <th rowspan="2" style="width:40px">序</th>
    <th rowspan="2" style="width:90px">桩号</th>
    <th rowspan="2" style="width:90px">设计标高(m)</th>
    ${gE}${gD}${gO}
    <th rowspan="2" style="width:60px">操作</th>
  </tr><tr>${showE ? pts : ''}${showD ? pts : ''}${showO ? pts : ''}</tr>`;
}
function toggleMeasureCol(which, on) {
  if (which === 'elev') state.showMeasureElev = on;
  else if (which === 'diff') state.showMeasureDiff = on;
  else state.showMeasureOrig = on;
  renderMeasureHead(); renderMeasures(); saveAll();
}
function renderMeasures() {
  renderMeasureHead();
  const body = document.getElementById('measureBody');
  const rows = state.measures.filter(m => (m.originalData || []).some(d => d !== null));
  const colCount = 3 + (state.showMeasureElev ? 5 : 0) + (state.showMeasureDiff ? 5 : 0) + (state.showMeasureOrig ? 5 : 0) + 1;
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="${colCount}" class="empty-state"><p>尚无已录入原始数据的桩号；请先在「原始数据」页录入 5 点读数</p></td></tr>`;
    return;
  }
  body.innerHTML = rows.map((m, i) => {
    const sm = parseStation(m.station);
    const de = !isNaN(sm) ? elevationAtStation(sm) : NaN;
    m.designElev = isNaN(de) ? '' : de.toFixed(4);
    const me = computeMeasureElev(m);
    const md = computeMeasureDiffs(m);
    const meCells = state.showMeasureElev ? me.map(v =>
      `<td><input class="calculated" value="${v !== null ? v.toFixed(4) : ''}" readonly></td>`).join('') : '';
    const mdCells = state.showMeasureDiff ? md.map(v => {
      if (v === null || v === '') return '<td class="calculated text-muted">-</td>';
      const cls = Math.abs(v) > (state.project.tolerance || 0) / 1000 ? (v > 0 ? 'dev-positive' : 'dev-negative') : 'dev-zero';
      return `<td class="calculated diff ${cls}">${v.toFixed(3)}</td>`;
    }).join('') : '';
    const odCells = state.showMeasureOrig ? (m.originalData || [null, null, null, null, null]).map(v =>
      `<td><input class="calculated" value="${v !== null ? v.toFixed(4) : ''}" readonly></td>`).join('') : '';
    return `<tr>
      <td>${i + 1}</td>
      <td class="station-cell">${m.station || ''}</td>
      <td>${m.designElev || ''}</td>
      ${meCells}${mdCells}${odCells}
      <td><button class="btn btn-sm btn-danger" onclick="deleteMeasureRow('${m._id}')">删</button></td>
    </tr>`;
  }).join('');
}

/* ============================================================
   计算结果 · 模块累积
   ============================================================ */
function saveMeasureSession() {
  const los = parseFloat(state.measureSetup.los);
  if (isNaN(los)) { toast('请先在「测量录入」设置水准点与后视，得到视线高'); return; }
  const rows = state.measures.filter(m => (m.originalData || []).some(d => d !== null));
  if (!rows.length) { toast('当前没有可保存的测量数据'); return; }
  const bm = state.project.benchmarks.find(b => b.name === state.measureSetup.benchmark) || {};
  const session = {
    id: 's' + Date.now(),
    timestamp: new Date().toLocaleString('zh-CN', { hour12: false }),
    benchmarkName: state.measureSetup.benchmark || '—',
    benchmarkElev: bm.elevation !== undefined ? bm.elevation : '',
    backsight: state.measureSetup.backsight,
    los: los,
    rows: rows.map(m => {
      const sm = parseStation(m.station);
      const de = !isNaN(sm) ? elevationAtStation(sm) : NaN;
      m.designElev = isNaN(de) ? '' : de.toFixed(4);
      return {
        station: m.station,
        designElev: m.designElev,
        measureElev: computeMeasureElev(m),
        measureDiff: computeMeasureDiffs(m),
        originalData: (m.originalData || []).slice()
      };
    })
  };
  state.measureSessions.push(session);
  state.measures = []; // 清空工作区，便于换水准点继续
  saveAll(); renderOriginalData(); renderMeasures(); renderResults();
  toast('已保存测量模块 #' + state.measureSessions.length);
}
function renderResults() {
  const sessions = state.measureSessions || [];
  const totalPoints = sessions.reduce((s, x) => s + x.rows.length, 0);
  document.getElementById('resultStats').innerHTML = `
    <div class="stat-card"><div class="stat-label">已保存模块数</div><div class="stat-value info">${sessions.length}</div></div>
    <div class="stat-card"><div class="stat-label">累计桩号数</div><div class="stat-value info">${totalPoints}</div></div>`;
  const container = document.getElementById('sessionModules');
  if (!sessions.length) {
    container.innerHTML = '<div class="empty-state"><p>暂无已保存的测量模块。请在「测量录入」页录入数据后点击「保存测量模块」。</p></div>';
    return;
  }
  container.innerHTML = sessions.map((s, idx) => sessionModuleHTML(s, idx + 1)).join('');
}
function sessionModuleHTML(s, num) {
  const pts = '<th>南</th><th>南腰</th><th>中</th><th>北腰</th><th>北</th>';
  const tol = (state.project.tolerance || 0) / 1000;
  const eE = state.showSessionElev, eD = state.showSessionDiff, eO = state.showSessionOrig;
  const gE = eE ? '<th colspan="5" style="background:rgba(76,175,80,0.12)">测量高程</th>' : '';
  const gD = eD ? '<th colspan="5" style="background:rgba(33,150,243,0.12)">测量差值</th>' : '';
  const gO = eO ? '<th colspan="5" style="background:rgba(255,152,0,0.10)">原始数据</th>' : '';
  const subHead = `${eE ? pts : ''}${eD ? pts : ''}${eO ? pts : ''}`;
  const rowHTML = s.rows.map(r => {
    const me = r.measureElev || [null, null, null, null, null];
    const md = r.measureDiff || [null, null, null, null, null];
    const od = r.originalData || [null, null, null, null, null];
    const meCells = eE ? me.map(v => `<td class="calculated grp-elev">${v !== null ? v.toFixed(4) : ''}</td>`).join('') : '';
    const mdCells = eD ? md.map(v => {
      if (v === null || v === '') return '<td class="calculated text-muted grp-diff">-</td>';
      const cls = Math.abs(v) > tol ? (v > 0 ? 'dev-positive' : 'dev-negative') : 'dev-zero';
      return `<td class="calculated diff grp-diff ${cls}">${v.toFixed(3)}</td>`;
    }).join('') : '';
    const odCells = eO ? od.map(v => `<td class="calculated grp-orig">${v !== null ? v.toFixed(4) : ''}</td>`).join('') : '';
    return `<tr><td class="station-cell">${r.station || ''}</td><td>${r.designElev || ''}</td>${meCells}${mdCells}${odCells}</tr>`;
  }).join('');
  return `<div class="card session-module">
    <div class="card-title">
      <span>测量模块 #${num}　<span class="text-sm text-muted">${s.timestamp || ''}</span></span>
      <button class="btn btn-sm btn-danger" onclick="deleteMeasureSession('${s.id}', this)">删除模块</button>
    </div>
    <div class="session-meta">
      <span><b>水准点：</b>${s.benchmarkName || '—'}</span>
      <span><b>水准点高程：</b>${s.benchmarkElev !== '' && s.benchmarkElev != null ? s.benchmarkElev + ' m' : '—'}</span>
      <span><b>后视读数：</b>${s.backsight !== '' && s.backsight != null ? s.backsight + ' m' : '—'}</span>
      <span><b>视线高：</b>${s.los !== '' && s.los != null ? s.los + ' m' : '—'}</span>
      <span class="text-sm text-muted">共 ${s.rows.length} 个桩号</span>
    </div>
    <div class="table-wrapper${eE && eD && eO ? ' table-scroll' : ''}">
      <table class="data-table">
        <thead><tr><th rowspan="2">桩号</th><th rowspan="2">设计标高(m)</th>${gE}${gD}${gO}</tr>${subHead ? `<tr>${subHead}</tr>` : ''}</thead>
        <tbody>${rowHTML}</tbody>
      </table>
    </div>
  </div>`;
}
let _sessArmed = null, _sessTimer = null;
function deleteMeasureSession(id, btn) {
  if (_sessArmed !== id) {
    _sessArmed = id; btn.textContent = '确认删除？'; btn.classList.add('btn-armed');
    _sessTimer = setTimeout(() => { _sessArmed = null; btn.textContent = '删除模块'; btn.classList.remove('btn-armed'); }, 3000);
    return;
  }
  clearTimeout(_sessTimer); _sessArmed = null; btn.textContent = '删除模块'; btn.classList.remove('btn-armed');
  state.measureSessions = state.measureSessions.filter(s => s.id !== id);
  saveAll(); renderResults();
  toast('已删除该模块');
}
function toggleSessionCol(which, on) {
  if (which === 'elev') state.showSessionElev = on;
  else if (which === 'diff') state.showSessionDiff = on;
  else if (which === 'orig') state.showSessionOrig = on;
  renderResults(); saveAll();
}
function exportSessionsXLSX() {
  const sessions = state.measureSessions || [];
  if (!sessions.length) { toast('暂无模块可导出'); return; }
  if (typeof buildStyledXLSX === 'undefined') { toast('xlsx 导出库未加载，无法导出'); return; }
  const subLayer = state.project.layers.find(l => l.key === state.project.subItem);
  const subName = subLayer ? subLayer.name : (state.project.subItem || '—');
  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  const pts = ['南', '南腰', '中', '北腰', '北'];
  const colHeader = ['桩号', '设计标高(m)',
    ...pts.map(p => '测量高程(' + p + ')'), ...pts.map(p => '原始数据(' + p + ')'), ...pts.map(p => '测量差值(' + p + ')')];
  const cell = (v, s) => ({ v: v, s: s });
  const _num = (v, d) => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? '' : +Number(v).toFixed(d);
  // 每个模块一张 sheet（一个模块一整个部分）；三块列横向并列，配色与结果页一致：
  // 1 标题(深底白字) 2 标签(灰底白字) 3 值(左) 4 数字4位 5 数字3位
  // 6 分组-绿 7 分组-橙 8 分组-蓝  9 表头-绿 10 表头-橙 11 表头-蓝
  // 12 数据-绿 13 数据-橙 14 数据-蓝 15 桩号(粗)
  const sheets = sessions.map((s, i) => {
    const rows = [];
    rows.push([cell('路面测量工作台 · 测量模块汇总', 1)]);
    rows.push([cell('工程名称', 2), cell(state.project.name || '', 3)]);
    rows.push([cell('分项工程', 2), cell(subName, 3)]);
    rows.push([cell('导出时间', 2), cell(now, 3)]);
    rows.push([]);
    rows.push([cell('模块 #' + (i + 1), 2), null, cell('保存时间', 2), cell(s.timestamp || '', 3),
      cell('水准点', 2), cell(s.benchmarkName || '—', 3), cell('桩号数', 2), cell((s.rows ? s.rows.length : 0), 3)]);
    rows.push([cell('水准点高程(m)', 2), cell(_num(s.benchmarkElev, 4), 4),
      cell('后视读数(m)', 2), cell(_num(s.backsight, 4), 4), cell('视线高(m)', 2), cell(_num(s.los, 4), 4)]);
    rows.push([]);
    const grp = Array(17).fill(null);
    grp[2] = cell('【测量高程】', 6); grp[7] = cell('【原始数据】', 7); grp[12] = cell('【测量差值】', 8);
    rows.push(grp);
    rows.push(colHeader.map((t, idx) => idx <= 1 ? cell(t, 2) : idx <= 6 ? cell(t, 9) : idx <= 11 ? cell(t, 10) : cell(t, 11)));
    (s.rows || []).forEach(r => {
      const me = r.measureElev || [], md = r.measureDiff || [], od = r.originalData || [];
      rows.push([cell(r.station || '', 15), cell(_num(r.designElev, 4), 4),
        ...me.map(v => cell(_num(v, 4), 12)), ...od.map(v => cell(_num(v, 4), 13)), ...md.map(v => cell(_num(v, 3), 14))]);
    });
    return { name: '模块' + (i + 1), rows: rows, merges: ['A1:Q1', 'C9:G9', 'H9:L9', 'M9:Q9'],
      freeze: { x: 2, y: 10 }, cols: [{ w: 11 }, { w: 12 }, ...Array(15).fill({ w: 11 })] };
  });
  const bytes = buildStyledXLSX(sheets);
  downloadBlob(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), '测量模块汇总.xlsx');
  toast('已导出 XLSX');
}
function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/* ============================================================
   导航 / 通用
   ============================================================ */
function switchTab(tabId) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const panel = document.getElementById('tab-' + tabId);
  if (panel) panel.classList.add('active');
  const nav = document.querySelector(`.nav-item[data-tab="${tabId}"]`);
  if (nav) nav.classList.add('active');
  if (tabId === 'measure') { populateBenchmarks(); updateLineOfSight(); renderMeasures(); }
  if (tabId === 'result') renderResults();
}
let _toastTimer = null;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function bindAll() {
  bindProjectInputs();
  renderLayerList(); renderBenchmarkList(); renderControlList();
  populateBenchmarks();
  document.getElementById('backsight').value = state.measureSetup.backsight || '';
  document.getElementById('bmSelect').value = state.measureSetup.benchmark || '';
  updateLineOfSight();
}
function renderAll() {
  renderLayerList(); renderBenchmarkList(); renderControlList();
  renderOriginalData(); renderMeasures(); renderResults();
}

/* ============================================================
   启动
   ============================================================ */
async function boot() {
  try {
    await initDB();
    loadAll();
    bindAll();
    renderAll();
    document.getElementById('boot').style.display = 'none';
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW 注册失败', e));
    }
  } catch (e) {
    console.error(e);
    document.getElementById('boot').innerHTML = '<div style="color:#e74c3c">初始化失败：' + e.message + '</div>';
  }
}
boot();
