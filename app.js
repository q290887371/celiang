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
      designAdjustThickness: 0.0,
      returnThickness: 0.0,
      crossSlope: 0.02,
      offsets: [0, 5, 10],
      tolerance: { upper: 5, lower: -5, warn: 3 },
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
    levelRows: [],
    inputMode: 'normal',
    showMeasureElev: true,
    showMeasureDiff: true,
    showMeasureOrig: true,
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
  const adj = parseFloat(state.project.designAdjustThickness) || 0; // 设计调整厚度
  const ret = parseFloat(state.project.returnThickness) || 0;       // 下返厚度
  const cs = parseFloat(state.project.crossSlope);
  const o = state.project.offsets;
  const offsetMap = [o[2], o[1], o[0], o[1], o[2]]; // 南/南腰/中/北腰/北
  if (isNaN(D) || isNaN(loose) || isNaN(cs)) return [null, null, null, null, null];
  // 目标高程 = 偏距处设计高程(D−偏距×横坡) + 设计调整 − 结构层总厚 + 生效层厚度和 + 虚铺 + 下返
  //（= D − 不生效层厚和 + 虚铺 + 设计调整 + 下返 − 偏距×横坡）
  return offsetMap.map(d => D - inactive + loose + adj + ret - d * cs);
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

// 设计读数（理论塔尺读数）= 视线高 − 目标高程
// = 视线高 − (设计标高 − 不生效层厚之和 + 虚铺 − 偏距×横坡)
//（南/北用偏距3路边缘、腰用偏距2、中用偏距1）
function computeDesignReadings(m) {
  const los = parseFloat(state.measureSetup.los);
  if (isNaN(los)) return [null, null, null, null, null];
  const mi = computeMeasureInputs(m.designElev);
  return mi.map(v => (v !== null && !isNaN(v)) ? (los - v) : null);
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
    if (!Array.isArray(state.levelRows)) state.levelRows = [];
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
// 导出文件：原生(APK)用 Capacitor Filesystem 写入缓存 + Share 系统分享面板（选"保存到下载/文件"即落盘），
// 网页预览回退 <a download>。
// Blob 转 Base64（大文件分块）
function blobToB64(blob) {
  return blob.arrayBuffer().then(function (buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(s);
  });
}
// 网页降级：<a download>
function downloadAnchor(blob, name) {
  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  } catch (e) { console.error('download anchor failed', e); }
}
// Capacitor Filesystem 的 Directory / Encoding 是包内枚举，原生插件对象上没有，
// 这里用官方字符串枚举值（大小写：'CACHE'/'DOCUMENTS'/'EXTERNAL_STORAGE'、'base64'）
const CFS_DIR = { CACHE: 'CACHE', DOCUMENTS: 'DOCUMENTS', EXTERNAL_STORAGE: 'EXTERNAL_STORAGE' };
const CFS_ENC = { UTF8: 'utf8', BASE64: 'base64' };
// 原生导出：优先写公共 Download/测量记录，降级 Documents，再降级 Cache + 系统分享
function exportNativeFile(blob, name, folder) {
  const cap = window.Capacitor;
  const P = (cap && cap.Plugins) || {};
  const FS = P.Filesystem;
  if (!FS) return Promise.resolve('fallback');
  let b64;
  return blobToB64(blob)
    .then(function (b) { b64 = b; if (FS.requestPermissions) return FS.requestPermissions().catch(function () {}); })
    .then(function () {
      // 1) 公共 Download 目录 /storage/emulated/0/Download/测量记录/
      return FS.writeFile({ path: 'Download/' + folder + '/' + name, data: b64, directory: CFS_DIR.EXTERNAL_STORAGE, encoding: CFS_ENC.BASE64, recursive: true }).then(function () {
        return '/storage/emulated/0/Download/测量记录/';
      }).catch(function () {
        // 2) 公共 Documents 目录
        return FS.writeFile({ path: folder + '/' + name, data: b64, directory: CFS_DIR.DOCUMENTS, encoding: CFS_ENC.BASE64, recursive: true }).then(function () {
          return '/storage/emulated/0/Documents/测量记录/';
        }).catch(function () {
          // 3) Cache + 系统分享面板（选“保存到下载/文件”即可落盘）
          return FS.writeFile({ path: name, data: b64, directory: CFS_DIR.CACHE, encoding: CFS_ENC.BASE64 }).then(function () {
            return FS.getUri({ path: name, directory: CFS_DIR.CACHE });
          }).then(function (res) {
            if (P.Share) return P.Share.share({ title: name, files: [res.uri], dialogTitle: '导出 ' + name }).then(function () { return null; });
            return null;
          }).catch(function () { return 'fallback'; });
        });
      });
    });
}
// Web Share 兜底：弹系统分享/保存面板（含文件）
function webShareSave(blob, name) {
  try {
    const file = new File([blob], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      return navigator.share({ files: [file], title: name }).then(function () { return true; }).catch(function () { return false; });
    }
  } catch (e) { /* ignore */ }
  return Promise.resolve(false);
}
function downloadBlob(blob, name) {
  const cap = window.Capacitor;
  const native = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  const P = (cap && cap.Plugins) || {};
  if (!native) {
    downloadAnchor(blob, name);
    toast('【诊断·web】Capacitor 未注入，仅网页下载，可能不落盘：' + name);
    return;
  }
  if (!P.Filesystem) {
    downloadAnchor(blob, name);
    toast('【诊断·native】Filesystem 插件缺失（cap sync 未生效）' + name);
    return;
  }
  exportNativeFile(blob, name, '测量记录').then(function (r) {
    if (typeof r === 'string') toast('已保存：' + r + name + '　请到文件管理器查看');
    else if (r === 'fallback') {
      webShareSave(blob, name).then(function (ok) {
        if (ok) toast('已分享保存：' + name + '　请在面板选 保存到下载');
        else { downloadAnchor(blob, name); toast('【诊断】公共目录写入失败且无分享能力，请检查存储权限：' + name); }
      });
    } else toast('已调用系统分享：' + name + '　请在面板选 保存到下载/文件');
  }).catch(function (e) { console.error('导出失败', e); downloadAnchor(blob, name); toast('【诊断·error】' + (e && e.message ? e.message : '未知') + ' ' + name); });
}

/* ============================================================
   项目设置
   ============================================================ */
function bindProjectInputs() {
  document.getElementById('projectName').value = state.project.name || '';
  populateSubItem();
  document.getElementById('looseThickness').value = state.project.looseThickness;
  document.getElementById('designAdjustThickness').value = state.project.designAdjustThickness;
  document.getElementById('returnThickness').value = state.project.returnThickness;
  document.getElementById('crossSlope').value = state.project.crossSlope;
  const ltEl = document.getElementById('layerTotal');
  if (ltEl) ltEl.value = totalLayerThickness().toFixed(2);
  document.getElementById('off1').value = state.project.offsets[0];
  document.getElementById('off2').value = state.project.offsets[1];
  document.getElementById('off3').value = state.project.offsets[2];
  const tc = tolConfig();
  const uEl = document.getElementById('tolUpper'); if (uEl) uEl.value = tc.upper;
  const lEl = document.getElementById('tolLower'); if (lEl) lEl.value = tc.lower;
  const wEl = document.getElementById('tolWarn'); if (wEl) wEl.value = tc.warn;
}
function onProjectChange() {
  state.project.looseThickness = parseFloat(document.getElementById('looseThickness').value) || 0;
  state.project.designAdjustThickness = parseFloat(document.getElementById('designAdjustThickness').value) || 0;
  state.project.returnThickness = parseFloat(document.getElementById('returnThickness').value) || 0;
  state.project.crossSlope = parseFloat(document.getElementById('crossSlope').value) || 0;
  state.project.offsets = [
    parseFloat(document.getElementById('off1').value) || 0,
    parseFloat(document.getElementById('off2').value) || 0,
    parseFloat(document.getElementById('off3').value) || 0
  ];
  state.project.tolerance = {
    upper: parseFloat(document.getElementById('tolUpper').value) || 5,
    lower: parseFloat(document.getElementById('tolLower').value) || -5,
    warn: parseFloat(document.getElementById('tolWarn').value) || 3
  };
  saveAll(); renderMeasures(); renderControlList(); renderLevelRows();
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
  saveAll(); renderLayerList(); renderMeasures(); renderLevelRows(); renderControlList();
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
        <input type="number" step="0.001" value="${c.elevation}" onchange="state.project.controlPoints[${i}].elevation=parseFloat(this.value)||0;saveAll();renderMeasures();renderControlList();renderLevelRows()">
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
    state.measures.push({ station: st, designElev: elevationAtStation(m).toFixed(3), originalData: [null, null, null, null, null], isControl: false });
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
      <td><input type="text" value="${m.station || ''}" placeholder="K0+600" oninput="onStationInput('${m._id}',this.value)"></td>
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
  m.designElev = !isNaN(sm) ? elevationAtStation(sm).toFixed(3) : '';
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
   水准测量记录（水准测量记录表）
   ============================================================ */
// 从测点文本中提取桩号（如 K0+800中 / ZD1 / 左）
function stationInText(s) {
  const m = String(s || '').toUpperCase().match(/K\d+\+\d+/);
  return m ? parseStation(m[0]) : NaN;
}
// 按方位取该桩号设计标高控制点在对应偏距处的设计高程：
//   中→偏距0m(offsets[0])  南腰/北腰→偏距5m(offsets[1])  南/北→偏距10m(offsets[2])
// 设计高程 = 中桩设计标高 − 偏距×横坡
function designElevForPoint(pt, sm) {
  const base = elevationAtStation(sm);
  if (isNaN(base)) return NaN;
  const cs = parseFloat(state.project.crossSlope) || 0;
  const o = state.project.offsets || [0, 5, 10];
  let off;
  if (/腰/.test(String(pt || ''))) off = o[1];
  else if (/[南北]/.test(String(pt || ''))) off = o[2];
  else off = o[0];
  const offElev = base - off * cs; // 对应偏距处设计高程
  const total = totalLayerThickness();   // 结构层总厚·自动
  const act = activeLayerKeys();         // 当前分项工程生效层
  const sumAct = (state.project.layers || []).reduce((s, l) => s + (act.has(l.key) ? (parseFloat(l.thickness) || 0) : 0), 0);
  const loose = parseFloat(state.project.looseThickness) || 0;
  const adj = parseFloat(state.project.designAdjustThickness) || 0;
  const ret = parseFloat(state.project.returnThickness) || 0;
  // 设计高程 = 偏距处设计高程 + 设计调整厚度 − 结构层总厚 + 生效层厚度和 + 虚铺 + 下返
  return offElev + adj - total + sumAct + loose + ret;
}
function addLevelRow() {
  state.levelRows.push({
    _id: 'lv' + Date.now().toString(36) + Math.random().toString(36).slice(2),
    pt: '', bs: null, mid: null, fs: null,
    los: null, losManual: false,
    elev: '', elevManual: false,
    de: '', deAuto: false
  });
  saveAll(); renderLevelRows();
}
function openLevelModal() {
  ['lm-pt', 'lm-bs', 'lm-mid', 'lm-fs', 'lm-los', 'lm-elev'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  document.getElementById('levelModal').style.display = 'flex';
  const pt = document.getElementById('lm-pt'); if (pt) pt.focus();
}
function closeLevelModal() {
  const m = document.getElementById('levelModal');
  if (m) m.style.display = 'none';
}
function _lmNum(id) {
  const s = (document.getElementById(id) || {}).value || '';
  const t = String(s).trim();
  return (t === '' || isNaN(parseFloat(t))) ? null : parseFloat(t);
}
function saveLevelModal() {
  const pt = String((document.getElementById('lm-pt') || {}).value || '').trim();
  const bs = _lmNum('lm-bs'), mid = _lmNum('lm-mid'), fs = _lmNum('lm-fs'), los = _lmNum('lm-los');
  const elevStr = String((document.getElementById('lm-elev') || {}).value || '').trim();
  const row = {
    _id: 'lv' + Date.now().toString(36) + Math.random().toString(36).slice(2),
    pt: pt, bs: bs, mid: mid, fs: fs,
    los: los, losManual: los !== null,
    elev: (elevStr === '' || isNaN(parseFloat(elevStr))) ? elevStr : parseFloat(elevStr),
    elevManual: elevStr !== '',
    de: '', deAuto: false
  };
  state.levelRows.push(row);
  recomputeLevels();
  renderLevelRows();
  if (mid !== null && mid !== '' && pt && !isNaN(stationInText(pt))) syncLevelToOrigData(row);
  saveAll();
  closeLevelModal();
  toast('已记录一行');
}
function deleteLevelRow(id) {
  const r = state.levelRows.find(x => x._id === id);
  state.levelRows = state.levelRows.filter(x => x._id !== id);
  if (r) clearLevelOrigSync(r); // 同步清空原始数据表对应桩号+方位
  renderLevelRows(); renderOriginalData(); renderMeasures(); saveAll();
}
// 删除水准测量记录行时，清空原始数据录入表对应桩号+方位的读数；若该桩号行已无任何读数则整行移除
function clearLevelOrigSync(r) {
  const sm = stationInText(r.pt);
  if (isNaN(sm)) return;
  const idx = azimuthIndex(r.pt);
  const i = state.measures.findIndex(m => parseStation(m.station) === sm);
  if (i < 0) return;
  const row = state.measures[i];
  if (row.originalData) row.originalData[idx] = null;
  const hasData = (row.originalData || []).some(v => v !== null && v !== '');
  if (!hasData) state.measures.splice(i, 1);
}
let _lvArmed = false, _lvTimer = null;
function clearAllLevels(btn) {
  if (!_lvArmed) {
    _lvArmed = true; btn.textContent = '确认清空？'; btn.classList.add('btn-armed');
    _lvTimer = setTimeout(() => { _lvArmed = false; btn.textContent = '全部删除'; btn.classList.remove('btn-armed'); }, 3000);
    return;
  }
  clearTimeout(_lvTimer); _lvArmed = false; btn.textContent = '全部删除'; btn.classList.remove('btn-armed');
  state.levelRows = [];
  saveAll(); renderLevelRows();
  toast('已清空水准测量记录');
}
// 偏差值(m) = 高程 − 设计高程（带符号显示，3 位小数）
function levelDev(r) {
  const e = parseFloat(r.elev), d = parseFloat(r.de);
  if (isNaN(e) || isNaN(d)) return null;
  return +((e - d).toFixed(3));
}
function devText(v) {
  if (v === null || v === undefined) return '';
  return v > 0 ? '+' + v.toFixed(3) : v.toFixed(3);
}
// 统一按 3 位小数显示数值（水准测量记录/原始数据/测量录入 的计算结果）
function f3(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = (typeof v === 'number') ? v : Number(v);
  return isNaN(n) ? '' : n.toFixed(3);
}
// 水准测量递推（自上而下）：
//   视线高 = 本行高程 + 本行后视（有后视的行设新仪器高，并向下沿用）
//   本行高程 = 上一行视线高 − 本行中间点（或前视）
// 高程/视线高若被手工填写，则以手工值为准（作为已知点/覆盖）
function recomputeLevels() {
  let los = null; // 当前视线高（上一站）
  (state.levelRows || []).forEach(r => {
    // 设计高程：若为自动派生（来自 测点桩号+方位），随控制点/横坡/偏距变化实时重算
    if (r.deAuto) {
      const sm = stationInText(r.pt);
      if (!isNaN(sm)) {
        const d = designElevForPoint(r.pt, sm);
        if (!isNaN(d)) r.de = +d.toFixed(3);
      }
    }
    const fs = parseFloat(r.fs), mid = parseFloat(r.mid), bs = parseFloat(r.bs);
    const haveLos = los !== null && !isNaN(los);
    // ① 高程：非手工时按公式
    if (!r.elevManual) {
      let elev = NaN;
      if (!isNaN(fs) && haveLos) elev = los - fs;
      else if (!isNaN(mid) && haveLos) elev = los - mid;
      else if (r.elev !== '' && !isNaN(parseFloat(r.elev))) elev = parseFloat(r.elev);
      if (!isNaN(elev)) r.elev = +elev.toFixed(3);
    }
    const elev = parseFloat(r.elev);
    // ② 视线高：非手工时 高程+后视，否则沿用上一站
    if (r.losManual) {
      const ml = parseFloat(r.los);
      if (!isNaN(ml)) los = +ml.toFixed(3);
    } else {
      if (!isNaN(bs) && !isNaN(elev)) los = +(elev + bs).toFixed(3);
      if (los !== null && !isNaN(los)) r.los = +los.toFixed(3);
    }
    // ③ 偏差值
    r.dev = levelDev(r);
  });
}
// 只刷新各行计算单元格（不整表重渲，避免丢失输入焦点）
function updateLevelCells() {
  (state.levelRows || []).forEach(r => {
    const lEl = document.getElementById('lv-los-' + r._id);
    if (lEl) lEl.value = f3(r.los);
    const eEl = document.getElementById('lv-elev-' + r._id);
    if (eEl) eEl.value = f3(r.elev);
    const deEl = document.getElementById('lv-de-' + r._id);
    if (deEl) deEl.value = f3(r.de);
    const dEl = document.getElementById('lv-dev-' + r._id);
    if (dEl) {
      const dv = r.dev;
      dEl.textContent = devText(dv);
      dEl.className = 'lv-dev' + (dv != null && dv > 0 ? ' dev-positive' : dv != null && dv < 0 ? ' dev-negative' : '');
    }
  });
}
// 测点方位 → 原始数据列索引（南/南腰/中/北腰/北 = 0/1/2/3/4）
function azimuthIndex(pt) {
  const p = String(pt || '');
  if (p.includes('腰')) return p.includes('南') ? 1 : 3;
  if (p.includes('南')) return 0;
  if (p.includes('北')) return 4;
  return 2; // 中 / 无方位
}
// 把水准测量记录某行的「中间点」读数同步到原始数据录入表：对应桩号 + 对应方位
function syncLevelToOrigData(r) {
  const sm = stationInText(r.pt);
  if (isNaN(sm)) return;
  const idx = azimuthIndex(r.pt);
  const st = formatStation(sm);
  let row = state.measures.find(m => parseStation(m.station) === sm);
  if (!row) {
    const de = elevationAtStation(sm);
    row = { _id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2),
      station: st, designElev: !isNaN(de) ? de.toFixed(3) : '',
      originalData: [null, null, null, null, null], isControl: false };
    state.measures.push(row);
  }
  const v = (r.mid !== null && r.mid !== '' && !isNaN(parseFloat(r.mid))) ? parseFloat(r.mid) : null;
  row.originalData[idx] = v;
  renderOriginalData();
  renderMeasures(); // 同步刷新测量录入计算表
}
function onLevelInput(id, field, val) {
  const r = state.levelRows.find(x => x._id === id);
  if (!r) return;
  if (field === 'pt') {
    r.pt = val;
    r.deAuto = true; // 由桩号+方位自动派生设计高程（控制点变化会联动）
  } else if (field === 'de') {
    r.de = (val === '' || val === null) ? '' : parseFloat(val);
    r.deAuto = false; // 手工指定，之后不再自动覆盖
  } else if (field === 'elev') {
    r.elev = (val === '' || val === null) ? '' : parseFloat(val);
    r.elevManual = true;
  } else if (field === 'los') {
    r.los = (val === '' || val === null) ? null : parseFloat(val);
    r.losManual = true;
  } else {
    r[field] = (val === '' || val === null) ? null : parseFloat(val);
  }
  recomputeLevels();
  updateLevelCells();
  // 中间点读数 → 同步到原始数据录入表（对应桩号+方位）
  if (field === 'mid') syncLevelToOrigData(r);
  renderMeasures(); // 测量差值由水准偏差值按方位提供，随编辑联动
  saveAll();
}
function renderLevelRows() {
  const body = document.getElementById('levelBody');
  if (!body) return;
  recomputeLevels();
  if (!state.levelRows.length) {
    body.innerHTML = '<tr><td colspan="9" class="empty-state"><p>暂无记录，点下方「添加测量行」开始录入；先在第1行输入 已知点高程+后视 得到视线高，后续输入 中间点/前视 自动算高程</p></td></tr>';
    return;
  }
  body.innerHTML = state.levelRows.map(r => {
    const devCls = r.dev > 0 ? 'dev-positive' : (r.dev < 0 ? 'dev-negative' : '');
    return `<tr>
      <td><input type="text" value="${r.pt || ''}" placeholder="桩号+方位" oninput="onLevelInput('${r._id}','pt',this.value)" style="min-width:88px; white-space:nowrap"></td>
      <td><input type="number" step="0.001" value="${r.bs != null ? r.bs : ''}" oninput="onLevelInput('${r._id}','bs',this.value)"></td>
      <td><input type="number" step="0.001" value="${r.mid != null ? r.mid : ''}" oninput="onLevelInput('${r._id}','mid',this.value)"></td>
      <td><input type="number" step="0.001" value="${r.fs != null ? r.fs : ''}" oninput="onLevelInput('${r._id}','fs',this.value)"></td>
      <td><input type="number" step="0.001" id="lv-los-${r._id}" value="${f3(r.los)}" oninput="onLevelInput('${r._id}','los',this.value)" title="视线高=高程+后视（自动算，可手工覆盖）"></td>
      <td><input type="number" step="0.001" id="lv-elev-${r._id}" value="${f3(r.elev)}" oninput="onLevelInput('${r._id}','elev',this.value)" placeholder="高程" title="高程=上一行视线高−中间点(或前视)；首行/已知点手工填"></td>
      <td><input type="number" step="0.001" id="lv-de-${r._id}" value="${f3(r.de)}" oninput="onLevelInput('${r._id}','de',this.value)" placeholder="自动匹配"></td>
      <td class="lv-dev ${devCls}" id="lv-dev-${r._id}">${devText(r.dev)}</td>
      <td><button class="btn btn-sm btn-danger" onclick="deleteLevelRow('${r._id}')">删</button></td>
    </tr>`;
  }).join('');
}
function exportLevelXLSX() {
  const rows = state.levelRows || [];
  if (!rows.length) { toast('暂无水准测量记录可导出'); return; }
  if (typeof buildStyledXLSX === 'undefined') { toast('xlsx 导出库未加载，无法导出'); return; }
  recomputeLevels();
  const cell = (v, s) => ({ v: v, s: s });
  const _num = (v, d) => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? null : +Number(v).toFixed(d);
  const out = [];
  out.push([cell('测点', 16), cell('水准尺读数', 16), null, null, cell('视线高', 16), cell('高程\n(m)', 16), cell('设计高程\n(m)', 16), cell('偏差值\n(m)', 16)]);
  out.push([null, cell('后视', 17), cell('中间点', 17), cell('前视', 17), null, null, null, null]);
  rows.forEach(r => {
    out.push([
      cell(r.pt || '', 20),
      _num(r.bs, 3) === null ? null : cell(_num(r.bs, 3), 19),
      _num(r.mid, 3) === null ? null : cell(_num(r.mid, 3), 19),
      _num(r.fs, 3) === null ? null : cell(_num(r.fs, 3), 19),
      _num(r.los, 3) === null ? null : cell(_num(r.los, 3), 19),
      _num(r.elev, 3) === null ? null : cell(_num(r.elev, 3), 19),
      _num(r.de, 3) === null ? null : cell(_num(r.de, 3), 19),
      r.dev != null ? cell(+r.dev.toFixed(3), 19) : null
    ]);
  });
  const rowHeights = { 1: 28, 2: 18 };
  for (let i = 3; i <= 2 + rows.length; i++) rowHeights[i] = 18;
  const sheet = { name: '水准测量记录', rows: out,
    merges: ['A1:A2', 'B1:D1', 'E1:E2', 'F1:F2', 'G1:G2', 'H1:H2'],
    cols: [{ w: 12 }, { w: 10 }, { w: 10 }, { w: 10 }, { w: 11 }, { w: 10 }, { w: 11 }, { w: 11 }],
    rowHeights: rowHeights };
  const bytes = buildStyledXLSX([sheet]);
  downloadBlob(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), '水准测量记录.xlsx');
  toast('已导出 水准测量记录.xlsx');
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
  document.getElementById('losValue').textContent = isNaN(los) ? '—' : los.toFixed(3);
  saveAll(); renderMeasures();
}
function renderMeasureHead() {
  const head = document.getElementById('measureHead');
  const showE = state.showMeasureElev, showD = state.showMeasureDiff, showO = state.showMeasureOrig;
  const pts = '<th>南</th><th>南腰</th><th>中</th><th>北腰</th><th>北</th>';
  const gE = showE ? '<th colspan="5" style="background:rgba(76,175,80,0.12)">测量高程</th>' : '';
  const gD = showD ? '<th colspan="5" style="background:rgba(33,150,243,0.12)">测量差值</th>' : '';
  const gO = showO ? '<th colspan="5" style="background:rgba(255,152,0,0.10)">设计读数</th>' : '';
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
// 测量差值：由水准测量记录的偏差值按 桩号+方位 提供（南/南腰/中/北腰/北）
function measureDiffFromLevel(station) {
  const arr = [null, null, null, null, null];
  const sm = parseStation(station);
  if (isNaN(sm)) return arr;
  (state.levelRows || []).forEach(r => {
    if (stationInText(r.pt) === sm) {
      const idx = azimuthIndex(r.pt);
      if (idx >= 0 && r.dev != null && !isNaN(r.dev)) arr[idx] = +r.dev.toFixed(3);
    }
  });
  return arr;
}
// 测量高程：由水准测量记录的「高程」按 桩号+方位 提供
function measureElevFromLevel(station) {
  const arr = [null, null, null, null, null];
  const sm = parseStation(station);
  if (isNaN(sm)) return arr;
  (state.levelRows || []).forEach(r => {
    if (stationInText(r.pt) === sm) {
      const idx = azimuthIndex(r.pt);
      if (idx >= 0 && r.elev != null && r.elev !== '' && !isNaN(parseFloat(r.elev))) arr[idx] = +parseFloat(r.elev).toFixed(3);
    }
  });
  return arr;
}
function renderMeasures() {
  renderMeasureHead();
  const body = document.getElementById('measureBody');
  const rows = state.measures.filter(m => (m.originalData || []).some(d => d !== null));
  const colCount = 3 + (state.showMeasureElev ? 5 : 0) + (state.showMeasureDiff ? 5 : 0) + (state.showMeasureOrig ? 5 : 0) + 1;
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="${colCount}" class="empty-state"><p>尚无已录入原始数据的桩号；请在上方「原始数据录入」录入 5 点读数</p></td></tr>`;
    return;
  }
  body.innerHTML = rows.map((m, i) => {
    const sm = parseStation(m.station);
    const de = !isNaN(sm) ? elevationAtStation(sm) : NaN;
    m.designElev = isNaN(de) ? '' : de.toFixed(3);
    const me = measureElevFromLevel(m.station);
    const md = measureDiffFromLevel(m.station);
    const dr = computeDesignReadings(m);
    const meCells = state.showMeasureElev ? me.map(v =>
      `<td><input class="calculated" value="${v !== null ? v.toFixed(3) : ''}" readonly></td>`).join('') : '';
    const mdCells = state.showMeasureDiff ? md.map(v => {
      if (v === null || v === '' || isNaN(v)) return '<td class="calculated text-muted">-</td>';
      const j = judgeDiff(v);
      const cls = j === 2 ? (v > 0 ? 'dev-positive' : 'dev-negative') : j === 1 ? 'dev-warn' : 'dev-zero';
      return `<td class="calculated diff ${cls}">${v.toFixed(3)}</td>`;
    }).join('') : '';
    const drCells = state.showMeasureOrig ? dr.map(v =>
      `<td><input class="calculated" value="${v !== null ? v.toFixed(3) : ''}" readonly></td>`).join('') : '';
    return `<tr>
      <td>${i + 1}</td>
      <td class="station-cell">${m.station || ''}</td>
      <td>${m.designElev || ''}</td>
      ${meCells}${mdCells}${drCells}
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
      m.designElev = isNaN(de) ? '' : de.toFixed(3);
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
  const eE = state.showSessionElev, eD = state.showSessionDiff, eO = state.showSessionOrig;
  const gE = eE ? '<th colspan="5" style="background:rgba(76,175,80,0.12)">测量高程</th>' : '';
  const gD = eD ? '<th colspan="5" style="background:rgba(33,150,243,0.12)">测量差值</th>' : '';
  const gO = eO ? '<th colspan="5" style="background:rgba(255,152,0,0.10)">原始数据</th>' : '';
  const subHead = `${eE ? pts : ''}${eD ? pts : ''}${eO ? pts : ''}`;
  const rowHTML = s.rows.map(r => {
    const me = r.measureElev || [null, null, null, null, null];
    const md = r.measureDiff || [null, null, null, null, null];
    const od = r.originalData || [null, null, null, null, null];
    const meCells = eE ? me.map(v => `<td class="calculated grp-elev">${v !== null ? v.toFixed(3) : ''}</td>`).join('') : '';
    const mdCells = eD ? md.map(v => {
      if (v === null || v === '' || isNaN(v)) return '<td class="calculated text-muted grp-diff">-</td>';
      const j = judgeDiff(v);
      const cls = j === 2 ? (v > 0 ? 'dev-positive' : 'dev-negative') : j === 1 ? 'dev-warn' : 'dev-zero';
      return `<td class="calculated diff grp-diff ${cls}">${v.toFixed(3)}</td>`;
    }).join('') : '';
    const odCells = eO ? od.map(v => `<td class="calculated grp-orig">${v !== null ? v.toFixed(3) : ''}</td>`).join('') : '';
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

/* ============================================================
   质量情况 · 测量差值分析（沿用桌面版工作台：上下限+警告阈值三档判定）
   ============================================================ */
// 容差配置归一化：新版为 { upper, lower, warn }(mm)；老数据为单一对称值(如 5)
// 老数据无警告阈值，按 warn=上限 处理（保持两档：合格/不合格）
function tolConfig() {
  const t = state.project.tolerance;
  if (t && typeof t === 'object' && 'upper' in t && 'lower' in t) {
    const u = parseFloat(t.upper), l = parseFloat(t.lower);
    if (!isNaN(u) && !isNaN(l)) {
      let w = t.warn !== undefined ? parseFloat(t.warn) : NaN;
      if (isNaN(w)) w = Math.max(Math.abs(u), Math.abs(l));
      return { upper: u, lower: l, warn: w };
    }
  }
  const n = parseFloat(t) || 5;
  return { upper: n, lower: -n, warn: n };
}
// 三档判定：0=合格 1=警告 2=不合格 -1=无数据（v 单位 m，判定阈值单位 mm）
function judgeDiff(v) {
  if (v === null || v === undefined || isNaN(v)) return -1;
  const tol = tolConfig();
  const mm = v * 1000;
  if (mm > tol.upper || mm < tol.lower) return 2;
  if (Math.abs(mm) > tol.warn) return 1;
  return 0;
}

function renderQuality() {
  const sessions = state.measureSessions || [];
  const tol = tolConfig();
  const pts = ['南', '南腰', '中', '北腰', '北'];
  let totalSt = 0, totalPts = 0, passPts = 0, warnPts = 0, failPts = 0;
  let maxAbs = 0, sumAbs = 0, cntAbs = 0;
  const cards = sessions.map((s, idx) => {
    const rowsHtml = (s.rows || []).map(r => {
      const md = r.measureDiff || [null, null, null, null, null];
      let warnN = 0, failN = 0, maxAbsRow = 0;
      const cells = md.map(v => {
        if (v === null || v === '' || isNaN(v)) return '<td class="calculated text-muted">-</td>';
        const j = judgeDiff(v);
        if (j === 2) failN++; else if (j === 1) warnN++;
        const a = Math.abs(v);
        if (a > maxAbsRow) maxAbsRow = a;
        const cls = j === 2 ? (v > 0 ? 'dev-positive' : 'dev-negative') : j === 1 ? 'dev-warn' : 'dev-zero';
        return `<td class="calculated diff ${cls}">${v.toFixed(3)}</td>`;
      }).join('');
      totalSt++;
      const valid = md.filter(v => v !== null && v !== '' && !isNaN(v));
      totalPts += valid.length;
      valid.forEach(v => { const j = judgeDiff(v); if (j === 0) passPts++; else if (j === 1) warnPts++; else failPts++; sumAbs += Math.abs(v); cntAbs++; if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v); });
      const badge = failN > 0
        ? `<span class="q-badge fail">不合格 ${failN} 点</span>`
        : warnN > 0
          ? `<span class="q-badge warn">警告 ${warnN} 点</span>`
          : '<span class="q-badge pass">合格</span>';
      return `<tr>
        <td class="station-cell">${r.station || ''}</td>
        <td>${r.designElev || ''}</td>
        ${cells}
        <td class="calculated diff">${(maxAbsRow * 1000).toFixed(1)}</td>
        <td>${badge}</td>
      </tr>`;
    }).join('');
    return `<div class="card session-module">
      <div class="card-title">
        <span>模块 #${idx + 1}　<span class="text-sm text-muted">${s.timestamp || ''}</span></span>
      </div>
      <div class="session-meta">
        <span><b>水准点：</b>${s.benchmarkName || '—'}</span>
        <span><b>视线高：</b>${s.los !== '' && s.los != null ? s.los + ' m' : '—'}</span>
        <span><b>容许偏差：</b>上${tol.upper}/下${tol.lower}/警${tol.warn} mm</span>
        <span class="text-sm text-muted">共 ${s.rows ? s.rows.length : 0} 个桩号</span>
      </div>
      <div class="table-wrapper table-scroll">
        <table class="data-table">
          <thead>
            <tr><th>桩号</th><th>设计标高(m)</th><th colspan="5">测量差值（南→北）</th><th>最大偏差(mm)</th><th>判定</th></tr>
            <tr><th></th><th></th>${pts.map(p => '<th>' + p + '</th>').join('')}<th></th><th></th></tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    </div>`;
  }).join('');
  const permille = totalPts ? (passPts / totalPts * 100) : 0;
  const avgAbs = cntAbs ? (sumAbs / cntAbs * 1000) : 0;
  const st = document.getElementById('qualityStats');
  if (st) st.innerHTML = `
    <div class="stat-card"><div class="stat-label">模块数</div><div class="stat-value info">${sessions.length}</div></div>
    <div class="stat-card"><div class="stat-label">桩号总数</div><div class="stat-value info">${totalSt}</div></div>
    <div class="stat-card"><div class="stat-label">合格率(点)</div><div class="stat-value ${permille >= 90 ? 'success' : permille >= 80 ? 'warning' : 'fail'}">${permille.toFixed(1)}%</div></div>
    <div class="stat-card"><div class="stat-label">警告点</div><div class="stat-value warning">${warnPts}</div></div>
    <div class="stat-card"><div class="stat-label">不合格点</div><div class="stat-value fail">${failPts}</div></div>
    <div class="stat-card"><div class="stat-label">最大偏差</div><div class="stat-value warning">${(maxAbs * 1000).toFixed(1)} mm</div></div>
    <div class="stat-card"><div class="stat-label">平均偏差(绝对)</div><div class="stat-value info">${avgAbs.toFixed(1)} mm</div></div>`;
  const box = document.getElementById('qualityContainer');
  if (box) box.innerHTML = sessions.length
    ? cards
    : '<div class="empty-state"><p>暂无已保存的测量模块。请先在「测量录入」录入数据并保存，即可在此查看每个桩号的测量差值质量分析。</p></div>';
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
  if (tabId === 'measure') { populateBenchmarks(); updateLineOfSight(); renderLevelRows(); renderOriginalData(); renderMeasures(); }
  if (tabId === 'origdata') renderQuality();
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
  renderLevelRows(); renderOriginalData(); renderMeasures(); renderResults(); renderQuality();
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
