'use strict';

/**
 * DeepSeek Harness Desktop —— Electron 主进程
 *
 * 工作流程:
 *   1. 首次运行时,把安装包内的 dsh.zip 解压到用户目录(仅一次,避免安装向导
 *      逐个写入数万个小文件导致安装极慢、且避开 Program Files 写权限问题)
 *   2. 申请一个空闲端口(避免与用户机器上已有服务冲突)
 *   3. 用随包分发的 node.exe 启动 dsh web 服务
 *   4. 轮询 http://127.0.0.1:<port> 直到服务就绪(期间显示启动画面)
 *   5. 创建主窗口加载 Web UI
 *   6. 退出时杀掉整个 dsh 进程树
 */

const { app, BrowserWindow, dialog } = require('electron');
const { spawn, spawnSync } = require('child_process');
const net = require('net');
const http = require('http');
const path = require('path');
const fs = require('fs');

const HOST = '127.0.0.1';
const STARTUP_TIMEOUT_MS = 120000; // 首次启动较慢,给 2 分钟

let serverProcess = null;
let serverPort = 0;
let mainWindow = null;
let splashWindow = null;
let quitting = false;

// ---------------------------------------------------------------------------
// 路径:开发模式取项目内 resources/,安装后取安装目录 resources/
// ---------------------------------------------------------------------------
function resourcesDir() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, 'resources');
}

function nodeExePath() {
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  return path.join(resourcesDir(), 'node', exe);
}

/** dsh 的用户数据(会话、日志、工作区)放在系统用户目录下,避免装在 Program Files 时的权限问题 */
function dshDataDir() {
  const dir = path.join(app.getPath('appData'), 'DeepSeekHarness');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 运行时目录:首启时把 dsh.zip 解压到这里 */
function runtimeDir() {
  return path.join(dshDataDir(), 'runtime');
}

/** 开发模式直接用 resources/dsh 松散目录;安装版用首启解压出来的目录 */
function dshHome() {
  const loose = path.join(resourcesDir(), 'dsh');
  if (fs.existsSync(path.join(loose, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
    return loose;
  }
  return path.join(runtimeDir(), 'dsh');
}

function dshCliPath() {
  return path.join(
    dshHome(),
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js'
  );
}

function dshZipPath() {
  return path.join(resourcesDir(), 'dsh.zip');
}

/** 构建期写入的 dsh 文件总数,用于首启解压时显示百分比 */
function dshFileTotal() {
  try {
    const info = JSON.parse(
      fs.readFileSync(path.join(resourcesDir(), 'build-info.json'), 'utf8')
    );
    return info.dshFileCount || 0;
  } catch {
    return 0;
  }
}

function setSplashHint(text) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents
      .executeJavaScript(
        `document.querySelector('.hint').textContent = ${JSON.stringify(text)}`
      )
      .catch(() => {});
  }
}

/** 首次运行:把安装包内的 dsh.zip 解压到用户目录(只需一次) */
function ensureDshRuntime() {
  if (fs.existsSync(dshCliPath())) return Promise.resolve();
  const zipPath = dshZipPath();
  if (!fs.existsSync(zipPath)) {
    return Promise.reject(new Error('缺少内嵌运行时资源(dsh),请重新安装应用。'));
  }
  setSplashHint('首次运行,正在初始化组件(仅这一次)…');
  fs.mkdirSync(runtimeDir(), { recursive: true });
  const total = dshFileTotal();
  return new Promise((resolve, reject) => {
    // Windows 10+ 自带 tar.exe(bsdtar),可直接解压 zip;
    // -v 输出每个解压的文件名,借此统计实时进度(解压瓶颈常在 Defender 实时扫描)
    const p = spawn('tar', ['-xvf', zipPath, '-C', runtimeDir()], { windowsHide: true });
    let count = 0;
    let lastUpdate = 0;
    p.stdout.on('data', (chunk) => {
      for (const ch of chunk) if (ch === 10) count++;
      const now = Date.now();
      if (now - lastUpdate > 400) {
        lastUpdate = now;
        setSplashHint(
          total > 0
            ? `首次运行,正在初始化组件… ${count} / ${total} 个文件(仅这一次)`
            : `首次运行,正在初始化组件… 已解压 ${count} 个文件(仅这一次)`
        );
      }
    });
    p.once('error', reject);
    p.once('exit', (code) => {
      if (code === 0 && fs.existsSync(dshCliPath())) return resolve();
      reject(new Error(`运行时初始化失败(tar 退出码 ${code}),请重新安装应用。`));
    });
  });
}

// ---------------------------------------------------------------------------
// 端口:让系统分配一个空闲端口
// ---------------------------------------------------------------------------
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, HOST, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------
// 启动 dsh web 子进程
// ---------------------------------------------------------------------------
function startServer(port) {
  const args = [dshCliPath(), 'web', '--host', HOST, '--port', String(port)];

  serverProcess = spawn(nodeExePath(), args, {
    cwd: dshDataDir(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      // 禁用颜色/交互,避免子进程输出控制字符
      NO_COLOR: '1',
      CI: '1'
    }
  });

  serverProcess.stdout.on('data', (d) => console.log('[dsh]', String(d).trim()));
  serverProcess.stderr.on('data', (d) => console.error('[dsh]', String(d).trim()));

  serverProcess.once('exit', (code) => {
    console.error(`[dsh] process exited with code ${code}`);
    if (!quitting && mainWindow) {
      dialog
        .showMessageBox(mainWindow, {
          type: 'error',
          title: 'DeepSeek Harness',
          message: '后端服务意外退出,应用即将关闭。',
          buttons: ['退出']
        })
        .finally(() => app.quit());
    }
  });
}

/** 轮询直到 Web UI 可访问 */
function waitForServer(url) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) return resolve();
        retry();
      });
      req.on('error', retry);
      req.setTimeout(2000, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() > deadline) {
        return reject(new Error('启动超时:DeepSeek Harness 服务在 2 分钟内未就绪。'));
      }
      setTimeout(attempt, 500);
    };
    attempt();
  });
}

// ---------------------------------------------------------------------------
// 进程清理:Windows 上必须杀进程树,否则 node.exe 会残留
// ---------------------------------------------------------------------------
function stopServer() {
  if (!serverProcess || serverProcess.killed) return;
  const pid = serverProcess.pid;
  if (process.platform === 'win32' && pid) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  } else {
    serverProcess.kill('SIGTERM');
  }
  serverProcess = null;
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------
function createSplash() {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 300,
    frame: false,
    resizable: false,
    alwaysOnTop: false,
    transparent: false,
    show: true,
    webPreferences: { contextIsolation: true }
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
}

function createMainWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0e14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    splashWindow = null;
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadURL(url);
}

// ---------------------------------------------------------------------------
// 应用生命周期
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    createSplash();
    try {
      if (!fs.existsSync(nodeExePath())) {
        throw new Error('缺少内嵌 Node 运行时,请重新安装应用。');
      }
      await ensureDshRuntime();
      setSplashHint('正在启动本地服务,请稍候…');
      serverPort = await getFreePort();
      startServer(serverPort);
      const url = `http://${HOST}:${serverPort}`;
      await waitForServer(url);
      createMainWindow(url);
    } catch (err) {
      console.error(err);
      if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
      dialog
        .showMessageBox({
          type: 'error',
          title: 'DeepSeek Harness 启动失败',
          message: String(err && err.message ? err.message : err),
          buttons: ['退出']
        })
        .finally(() => app.quit());
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    stopServer();
  });
}
