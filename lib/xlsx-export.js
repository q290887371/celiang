/*
 * xlsx-export.js —— 零依赖的带样式 .xlsx 生成器（手写 OOXML + stored zip）。
 * 仅用于本工程的「测量结果导出」，支持每个单元格独立的填充色/字体/数字格式/合并/冻结。
 * 浏览器与 Node 端通用：浏览器挂 window.buildStyledXLSX，Node 端 module.exports。
 *
 * 用法：
 *   const bytes = buildStyledXLSX(sheets, filename);
 *   sheets: [{ name, rows:[[cell,...],...], merges:['A1:Q1',...], freeze:{x,y}, cols:[{w:11},...] }]
 *   cell: null(跳过) | string | number | { v, s }   （s = 样式索引，见下方 STYLES_XML 的 cellXfs 0-15）
 */
(function (global) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>'"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&apos;', '"': '&quot;' }[c];
    });
  }
  var COLS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  function colLetter(c) {
    if (c < 26) return COLS[c];
    return COLS[Math.floor(c / 26) - 1] + COLS[c % 26];
  }

  // CRC32（stored zip 必需）
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function encBuf(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var code = s.charCodeAt(i), c = code;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
    }
    return new Uint8Array(out);
  }

  // stored（无压缩）zip 打包
  function zipStored(files) {
    var parts = [], offset = 0, central = [];
    files.forEach(function (f) {
      var nameBytes = encBuf(f.name);
      var data = f.data;
      var crc = crc32(data), size = data.length;
      var lh = new Uint8Array(30 + nameBytes.length);
      var dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true); dv.setUint16(6, 0, true); dv.setUint16(8, 0, true);
      dv.setUint16(10, 0, true); dv.setUint16(12, 0, true);
      dv.setUint32(14, crc, true); dv.setUint32(18, size, true); dv.setUint32(22, size, true);
      dv.setUint16(26, nameBytes.length, true); dv.setUint16(28, 0, true);
      lh.set(nameBytes, 30);
      var cd = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0, true); cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true); cv.setUint16(14, 0, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, size, true); cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true); cv.setUint16(36, 0, true); cv.setUint16(38, 0, true);
      cv.setUint32(42, offset, true);
      cd.set(nameBytes, 46);
      parts.push(lh); parts.push(data); central.push(cd);
      offset += lh.length + data.length;
    });
    var centralSize = central.reduce(function (s, c) { return s + c.length; }, 0);
    var end = new Uint8Array(22);
    var ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true); ev.setUint16(20, 0, true);
    parts.push.apply(parts, central); parts.push(end);
    var total = parts.reduce(function (s, c) { return s + c.length; }, 0);
    var out = new Uint8Array(total); var p = 0;
    parts.forEach(function (c) { out.set(c, p); p += c.length; });
    return out;
  }

  // 16 个样式（cellXfs 索引 0-15）
  // 0 默认 | 1 标题(白字深底) | 2 标签(白字灰底) | 3 值(左对齐) | 4 数字4位 | 5 数字3位
  // 6 分组-绿 | 7 分组-橙 | 8 分组-蓝 | 9 表头-绿 | 10 表头-橙 | 11 表头-蓝
  // 12 数据-绿(4位) | 13 数据-橙(4位) | 14 数据-蓝(3位) | 15 桩号(粗体)
  var STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="2"><numFmt numFmtId="164" formatCode="0.0000"/><numFmt numFmtId="165" formatCode="0.000"/></numFmts>' +
    '<fonts count="3">' +
      '<font><sz val="11"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>' +
    '</fonts>' +
    '<fills count="13">' +
      '<fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FF2A3440"/><bgColor indexed="64"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FF3A4750"/><bgColor indexed="64"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FF81C784"/><bgColor indexed="64"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFFFB74D"/><bgColor indexed="64"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FF64B5F6"/><bgColor indexed="64"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFA5D6A7"/><bgColor indexed="64"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFFFCC80"/><bgColor indexed="64"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FF90CAF9"/><bgColor indexed="64"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFC8E6C9"/><bgColor indexed="64"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFFFE0B2"/><bgColor indexed="64"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFBBDEFB"/><bgColor indexed="64"/></patternFill></fill>' +
    '</fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="16">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
      '<xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>' +
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
      '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="1" fillId="4" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="1" fillId="5" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="1" fillId="6" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="1" fillId="7" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="1" fillId="8" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="1" fillId="9" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
      '<xf numFmtId="164" fontId="0" fillId="10" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
      '<xf numFmtId="164" fontId="0" fillId="11" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
      '<xf numFmtId="165" fontId="0" fillId="12" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';

  function cellXml(ref, cell) {
    if (cell == null || cell === '') {
      return '<c r="' + ref + '"' + (cell && cell.s != null ? ' s="' + cell.s + '"' : '') + '/>';
    }
    var s = cell.s != null ? ' s="' + cell.s + '"' : '';
    var v = cell.v;
    if (typeof v === 'number') return '<c r="' + ref + '"' + s + '><v>' + v + '</v></c>';
    return '<c r="' + ref + '"' + s + ' t="inlineStr"><is><t xml:space="preserve">' + esc(v) + '</t></is></c>';
  }

  function sheetXml(sheet) {
    var body = '';
    sheet.rows.forEach(function (row, ri) {
      var cells = '';
      row.forEach(function (cell, ci) {
        if (cell == null) return;
        var ref = colLetter(ci) + (ri + 1);
        cells += cellXml(ref, cell);
      });
      body += '<row r="' + (ri + 1) + '">' + cells + '</row>';
    });
    var colsXml = '';
    if (sheet.cols) {
      colsXml = '<cols>' + sheet.cols.map(function (c, i) {
        return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + (c.w || 11) + '" customWidth="1"/>';
      }).join('') + '</cols>';
    }
    var mergesXml = '';
    if (sheet.merges && sheet.merges.length) {
      mergesXml = '<mergeCells count="' + sheet.merges.length + '">' +
        sheet.merges.map(function (m) { return '<mergeCell ref="' + m + '"/>'; }).join('') + '</mergeCells>';
    }
    var viewXml;
    if (sheet.freeze) {
      var tl = colLetter(sheet.freeze.x) + (sheet.freeze.y + 1);
      viewXml = '<sheetViews><sheetView workbookViewId="0"><pane xSplit="' + sheet.freeze.x +
        '" ySplit="' + sheet.freeze.y + '" topLeftCell="' + tl + '" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>';
    } else {
      viewXml = '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
    }
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      colsXml + viewXml + '<sheetData>' + body + '</sheetData>' + mergesXml + '</worksheet>';
  }

  function buildStyledXLSX(sheets) {
    var files = [];
    var sheetTags = '', sheetRels = '';
    sheets.forEach(function (sh, i) {
      var idx = i + 1;
      sheetTags += '<sheet name="' + esc(sh.name) + '" sheetId="' + idx + '" r:id="rId' + idx + '"/>';
      sheetRels += '<Relationship Id="rId' + idx + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + idx + '.xml"/>';
      files.push({ name: 'xl/worksheets/sheet' + idx + '.xml', data: encBuf(sheetXml(sh)) });
    });
    var workbookXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets>' + sheetTags + '</sheets></workbook>';
    var workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheetRels +
      '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>';
    var contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets.map(function (sh, i) {
        return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
      }).join('') +
      '</Types>';
    var rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>';
    files.push({ name: 'xl/workbook.xml', data: encBuf(workbookXml) });
    files.push({ name: 'xl/_rels/workbook.xml.rels', data: encBuf(workbookRels) });
    files.push({ name: 'xl/styles.xml', data: encBuf(STYLES_XML) });
    files.push({ name: '[Content_Types].xml', data: encBuf(contentTypes) });
    files.push({ name: '_rels/.rels', data: encBuf(rootRels) });
    return zipStored(files);
  }

  var api = { buildStyledXLSX: buildStyledXLSX };
  global.buildStyledXLSX = buildStyledXLSX;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
