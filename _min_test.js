
const XLSX = require('./lib/xlsx.full.min.js');
console.log('XLSX version:', XLSX.version);
const ws = XLSX.utils.aoa_to_sheet([['a','b'],[1,2]]);
ws['A1'].s = { fill: { fgColor: { rgb: 'FFFF0000' } } };
console.log('写前 A1.s =', JSON.stringify(ws['A1'].s));
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'S');
const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array', cellStyles: true });
const buf = Buffer.isBuffer(out) ? out : Buffer.from(out);
require('fs').writeFileSync('__min.xlsx', buf);
console.log('bytes:', buf.length);
