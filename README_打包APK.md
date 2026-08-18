# 路面测量工作台 · 安卓 App

公路沥青混凝土路面测量工具：横断面 5 点（南/南腰/中/北腰/北）高程与铺筑偏差计算，
支持换水准点分段测量、按模块累积保存，内置 **SQLite 数据库文件（survey.db）** 持久化。

文件结构：

```
安卓测量App/
├── index.html              入口页面（移动端布局，底部 4 标签）
├── styles.css              深色主题、移动端优先样式
├── app.js                  全部计算 + SQLite 持久化 + 导入导出逻辑
├── lib/sql-wasm.js          SQLite 的 WebAssembly 移植（无需联网）
├── lib/sql-wasm.wasm        数据库引擎字节码
├── sw.js                    Service Worker（离线缓存）
├── manifest.webmanifest     PWA 清单（可"添加到主屏幕"）
├── assets/icon.svg          App 图标
├── capacitor.config.json    Capacitor 原生打包配置
├── package.json             原生打包依赖
└── README_打包APK.md        本说明
```

---

## 方式一：不打包，直接当 App 用（推荐，零门槛）

在安卓手机上用 **Chrome** 打开本目录部署后的网址（见下方"本地部署"），
点浏览器菜单 → **"安装应用" / "添加到主屏幕"**，即生成一个全屏、可离线使用的 App 图标。
所有数据存进 `survey.db`（SQLite），可用顶部"导出数据库"备份成 `.db` 文件。

> iOS（Safari）：分享 → "添加到主屏幕" 同样可用。

---

## 方式二：用 GitHub 免费云端编译 APK（**无需 Android Studio** ✅）

本机没有 JDK/Android SDK 也没关系——把代码推到 GitHub，由 GitHub Actions 在云端
自动安装 JDK + Android SDK 把 APK 编出来，你只管下载安装。完全免费（公开仓库无限时长，
私有仓库每月 2000 分钟额度足够）。

### 1. 在 GitHub 新建一个仓库
- 登录 github.com → New repository（仓库名随意，如 `road-survey-app`）。
- 选 **Public**（公开，编译免费无限；私有也可，额度够用）。
- 不要勾选 "Add a README"（我们用已有的）。

### 2. 把 `安卓测量App/` 目录内容推上去
在本机 `安卓测量App/` 目录执行（把 `你的用户名/仓库名` 换成你的）：
```bash
git init
git add .
git commit -m "road survey app"
git branch -M main
git remote add origin https://github.com/你的用户名/road-survey-app.git
git push -u origin main
```
> 文件结构里已包含 `.github/workflows/build-apk.yml`（编译工作流）、
> `capacitor.config.json`、`package.json`，推上去即可被识别。

### 3. 触发编译并下载 APK
- 推送后自动触发；或到仓库 **Actions** 标签 → 左侧 `Build Android APK` → 右上 **Run workflow** 手动触发。
- 等状态变绿（约 3–6 分钟，首次会慢一点，要下载 Gradle 和 Android SDK）。
- 点进该次运行 → 底部 **Artifacts** → 下载 `app-debug-apk`（就是 `app-debug.apk`）。
- 把 `app-debug.apk` 拷到安卓手机安装即可。

### 4. 之后怎么更新 App
改完代码 → `git add . && git commit && git push` → 云端自动重新编译 → 再下载新 APK。
不用本地装任何 Android 工具。

---

## 方式三：本地用 Android Studio 打包（可选，有 Windows 环境时）

需要：**Node.js 18+**、**Android Studio（含 Android SDK）**、**JDK 17**。

### 1. 安装 Capacitor 依赖（在 `安卓测量App/` 目录）
```bash
npm install
```

### 2. 生成安卓原生工程
```bash
npx cap add android
```
会在目录下生成 `android/` 文件夹（Gradle 工程）。

### 3. 同步网页资源到原生工程
每次修改网页后执行：
```bash
npx cap sync
```

### 4. 用 Android Studio 打开并编译 APK
```bash
npx cap open android
```
在 Android Studio 中：菜单 **Build → Build Bundle(s) / APK(s) → Build APK(s)**，
编译完成会在 `android/app/build/outputs/apk/debug/` 得到 `app-debug.apk`，
拷到手机安装即可。要发布到应用商店则选 **Generate Signed Bundle / APK** 做签名。

> 注意：本机（开发机）当前**没有 JDK 与 Android SDK**，无法在此直接编译 APK；
> 上述步骤在你自己的 Windows（已装 Android Studio）上执行即可。App 的网页与数据库逻辑
> 本身已在本环境验证通过。

---

## 本地预览 / 调试（电脑或手机）

```bash
npm install
npm run dev
```
- 本机浏览器：http://localhost:5173
- 手机同 WiFi：http://<电脑内网IP>:5173

**必须用 http(s) 访问**（不能用 `file://` 直接双击打开），否则 Service Worker 与
SQLite WASM 无法加载——此时会自动回退到 localStorage 存储（功能仍可用，但无独立 .db 文件）。

> 注意：`npm run dev` 直接用根目录 `index.html` 预览（PWA 形态）；
> 原生打包用的 `www/` 由 `npm run build:www` 自动生成，无需手动维护。

---

## 数据库说明

- 数据存于 SQLite 数据库 `survey.db`，由 sql.js 在浏览器内创建，字节保存在 IndexedDB。
- **导出数据库**：顶部"导出数据库"按钮，下载 `survey.db`（可用 DB Browser for SQLite 等工具查看/编辑）。
- **导入数据库**：顶部"导入"按钮，选择 `.db` 文件覆盖恢复。
- 未部署为 http 服务（file:// 打开）时自动回退 localStorage，界面与计算不变。
