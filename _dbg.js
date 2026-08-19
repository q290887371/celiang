
const fs = require('fs');
const buf = fs.readFileSync('__sample_export.xlsx');
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
// central dir
const eo = buf.length - 22;
const cdOffset = dv.getUint32(eo + 16, true);
let p = cdOffset, cnames = [];
while (p + 4 <= buf.length && dv.getUint32(p, true) === 0x02014b50) {
  const nlen = dv.getUint16(p + 28, true);
  cnames.push(buf.slice(p + 46, p + 46 + nlen).toString('utf8'));
  const clen = dv.getUint16(p+30,true)+dv.getUint16(p+32,true)+dv.getUint16(p+34,true)+dv.getUint16(p+36,true)+46+nlen;
  p += clen;
}
console.log('central dir 顺序:', cnames);
// local headers
let lp = 0, lnames = [];
while (lp + 4 <= buf.length && dv.getUint32(lp, true) === 0x04034b50) {
  const nlen = dv.getUint16(lp + 26, true);
  lnames.push(buf.slice(lp + 30, lp + 30 + nlen).toString('utf8'));
  const csize = dv.getUint32(lp + 18, true);
  lp += 30 + nlen + csize;
}
console.log('local headers 顺序:', lnames);
