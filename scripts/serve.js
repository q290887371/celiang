// 本地静态服务器：用于电脑或手机同 WiFi 预览。
// 用法：npm run dev  然后浏览器打开 http://localhost:5173
// 手机访问：http://电脑内网IP:5173 （需同一 WiFi）
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname.replace(/[\\/]scripts$/, '');
const port = process.env.PORT || 5173;
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json'
};

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = path.join(root, p);
  fs.readFile(fp, (e, d) => {
    if (e) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': mime[path.extname(fp)] || 'application/octet-stream' });
    res.end(d);
  });
}).listen(port, () => {
  console.log('服务已启动：');
  console.log('  本机：  http://localhost:' + port);
  console.log('  手机：  http://<你电脑的内网IP>:' + port + '  (需同一 WiFi)');
});
