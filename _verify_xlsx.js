// 验证 lib/xlsx-export.js 的 buildStyledXLSX（模拟 app.js exportSessionsXLSX 的结构）
const { buildStyledXLSX } = require('./lib/xlsx-export.js');
const cell = (v, s) => ({ v: v, s: s });
const _num = (v, d) => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? '' : +Number(v).toFixed(d);
const sessions = [
  { timestamp: '2026-08-19 10:00:00', benchmarkName: 'BM1', benchmarkElev: 9.0, backsight: 1.5, los: 10.5,
    rows: [
      { station: 'K0+600', designElev: '9.3260', measureElev: [9.1900,9.2000,9.2100,9.2200,9.2300], measureDiff: [-0.186,-0.176,-0.166,-0.156,-0.146], originalData: [1.3100,1.3000,1.2900,1.2800,1.2700] },
      { station: 'K0+620', designElev: '9.3700', measureElev: [9.2340,9.2440,9.2540,9.2640,9.2740], measureDiff: [-0.186,-0.176,-0.166,-0.156,-0.146], originalData: [1.2660,1.2560,1.2460,1.2360,1.2260] }
    ] }
];
const subName = '细粒式改性沥青混凝土上面层';
const now = '2026/8/19 12:20:00';
const pts = ['南','南腰','中','北腰','北'];
const colHeader = ['桩号','设计标高(m)', ...pts.map(p=>'测量高程('+p+')'), ...pts.map(p=>'原始数据('+p+')'), ...pts.map(p=>'测量差值('+p+')')];
const sheets = sessions.map((s, i) => {
  const rows = [];
  rows.push([cell('路面测量工作台 · 测量模块汇总', 1)]);
  rows.push([cell('工程名称',2), cell('兴运道东段',3)]);
  rows.push([cell('分项工程',2), cell(subName,3)]);
  rows.push([cell('导出时间',2), cell(now,3)]);
  rows.push([]);
  rows.push([cell('模块 #'+(i+1),2), null, cell('保存时间',2), cell(s.timestamp||'',3), cell('水准点',2), cell(s.benchmarkName||'—',3), cell('桩号数',2), cell((s.rows?s.rows.length:0),3)]);
  rows.push([cell('水准点高程(m)',2), cell(_num(s.benchmarkElev,4),4), cell('后视读数(m)',2), cell(_num(s.backsight,4),4), cell('视线高(m)',2), cell(_num(s.los,4),4)]);
  rows.push([]);
  const grp = Array(17).fill(null); grp[2]=cell('【测量高程】',6); grp[7]=cell('【原始数据】',7); grp[12]=cell('【测量差值】',8);
  rows.push(grp);
  rows.push(colHeader.map((t,idx)=> idx<=1?cell(t,2): idx<=6?cell(t,9): idx<=11?cell(t,10):cell(t,11)));
  (s.rows||[]).forEach(r => {
    const me=r.measureElev||[], md=r.measureDiff||[], od=r.originalData||[];
    rows.push([cell(r.station||'',15), cell(_num(r.designElev,4),4), ...me.map(v=>cell(_num(v,4),12)), ...od.map(v=>cell(_num(v,4),13)), ...md.map(v=>cell(_num(v,3),14))]);
  });
  return { name: '模块'+(i+1), rows: rows, merges: ['A1:Q1','C9:G9','H9:L9','M9:Q9'], freeze: { x: 2, y: 10 }, cols: [{w:11},{w:12}, ...Array(15).fill({w:11})] };
});
const bytes = buildStyledXLSX(sheets);
require('fs').writeFileSync('__sample_export.xlsx', Buffer.from(bytes));
console.log('XLSX 生成成功，字节数:', bytes.length, 'typeof:', bytes.constructor.name);
