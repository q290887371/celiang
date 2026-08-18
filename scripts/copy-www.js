// 把静态资源整理到 www/ 目录，供 Capacitor 原生打包（Android/iOS）使用。
// 这样既能用根目录直接当 PWA 部署，也能用 www/ 编译原生 App，互不干扰。
const fs = require('fs');
const path = require('path');

const root = __dirname.replace(/[\\/]scripts$/, '');
const www = path.join(root, 'www');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
  console.log('  copy', path.relative(root, dest));
}

// 需要进入原生包的静态文件（sw.js 不放进来——原生包资源已内置，SW 缓存无意义）
const files = [
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'lib/sql-wasm.js',
  'lib/sql-wasm.wasm',
  'assets/icon.svg'
];

// 清空并重建 www/
fs.rmSync(www, { recursive: true, force: true });
ensureDir(www);
console.log('Building www/ ...');
files.forEach(f => {
  const src = path.join(root, f);
  if (fs.existsSync(src)) copyFile(src, path.join(www, f));
  else console.warn('  [跳过] 缺失:', f);
});
console.log('www/ 构建完成。');
