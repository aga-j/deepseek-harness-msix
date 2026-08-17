'use strict';

/**
 * DeepSeek Harness Desktop —— Electron 主进程
 *
 * 工作流程:
 *   1. 申请一个空闲端口(避免与用户机器上已有服务冲突)
 *   2. 用随包分发的 node.exe 启动内嵌的 dsh web 服务
 *   3. 轮询 http://127.0.0.1:<port> 直到服务就绪(期间显示启动画面)
 *   4. 创建主窗口加载 Web UI
 *   5. 退出时杀掉整个 dsh 进程树
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

function dshCliPath() {
  return path.join(
    resourcesDir(),
    'dsh',
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js'
  );
}

/** dsh 的用户数据(会话、日志、工作区)放在系统用户目录下,避免装在 Program Files 时的权限问题 */
function dshDataDir() {
  const dir = path.join(app.getPath('appData'), 'DeepSeekHarness');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
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
      if (!fs.existsSync(nodeExePath()) || !fs.existsSync(dshCliPath())) {
        throw new Error('缺少内嵌运行时资源(node 或 dsh),请重新安装应用。');
      }
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
