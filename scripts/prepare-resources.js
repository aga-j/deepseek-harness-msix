'use strict';

/**
 * 资源准备脚本(构建期运行):
 *   1. 下载 Windows 版 Node.js,取出 node.exe 放入 resources/node/
 *   2. 把 @deepseek-ai/dsh 预装到 resources/dsh/(含全部 node_modules)
 *
 * 最终用户机器上零依赖:node 运行时和 dsh 全部随安装包分发。
 *
 * 升级方式:改下面两个版本号,重新构建即可。
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---- 版本锁定 -------------------------------------------------------------
// 注意:dsh 依赖 zstd / Promise.withResolvers / stripTypeScriptTypes 等
// 仅存在于 Node 22.15+ 的 API,实测 Node 20 无法启动,必须 Node 24。
const NODE_VERSION = '24.19.0'; // Node.js 24 LTS (Krypton)
const DSH_VERSION = '0.1.0-rc.6'; // @deepseek-ai/dsh 版本,上游迭代快,务必锁定
// ---------------------------------------------------------------------------

const ROOT = path.join(__dirname, '..');
const RES = path.join(ROOT, 'resources');
const NODE_DIR = path.join(RES, 'node');
const DSH_DIR = path.join(RES, 'dsh');

async function download(url, dest) {
  console.log(`[prepare] downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败 ${res.status}: ${url}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

function run(cmd, args, opts = {}) {
  console.log(`[prepare] ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} 退出码 ${r.status}`);
}

async function prepareNode() {
  const exeName = process.platform === 'win32' ? 'node.exe' : 'node';
  const target = path.join(NODE_DIR, 'node.exe');
  if (fs.existsSync(target)) {
    console.log('[prepare] node.exe 已存在,跳过下载');
    return;
  }

  if (process.platform === 'win32') {
    // 构建机是 Windows:下载 win-x64 发行包,解出 node.exe
    const zip = `node-v${NODE_VERSION}-win-x64.zip`;
    const zipPath = path.join(RES, zip);
    fs.mkdirSync(RES, { recursive: true });
    await download(`https://nodejs.org/dist/v${NODE_VERSION}/${zip}`, zipPath);

    // Windows 10+ 自带 bsdtar,可直接解压 zip
    run('tar', ['-xf', zipPath, '-C', RES]);
    fs.mkdirSync(NODE_DIR, { recursive: true });
    fs.copyFileSync(
      path.join(RES, `node-v${NODE_VERSION}-win-x64`, 'node.exe'),
      target
    );
    fs.rmSync(path.join(RES, `node-v${NODE_VERSION}-win-x64`), { recursive: true, force: true });
    fs.rmSync(zipPath, { force: true });
  } else {
    // 非 Windows 构建机(如 macOS):同样下载 Windows 版 node.exe
    const zip = `node-v${NODE_VERSION}-win-x64.zip`;
    const zipPath = path.join(RES, zip);
    fs.mkdirSync(RES, { recursive: true });
    await download(`https://nodejs.org/dist/v${NODE_VERSION}/${zip}`, zipPath);
    run('tar', ['-xf', zipPath, '-C', RES]);
    fs.mkdirSync(NODE_DIR, { recursive: true });
    fs.copyFileSync(
      path.join(RES, `node-v${NODE_VERSION}-win-x64`, 'node.exe'),
      target
    );
    fs.rmSync(path.join(RES, `node-v${NODE_VERSION}-win-x64`), { recursive: true, force: true });
    fs.rmSync(zipPath, { force: true });
  }
  console.log(`[prepare] node.exe v${NODE_VERSION} 就绪`);
}

function prepareDsh() {
  const marker = path.join(DSH_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (fs.existsSync(marker)) {
    console.log('[prepare] dsh 已安装,跳过');
    return;
  }
  fs.mkdirSync(DSH_DIR, { recursive: true });
  // 初始化一个最小 package.json,避免 npm 向上查找污染
  const pkgPath = path.join(DSH_DIR, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, JSON.stringify({ name: 'dsh-runtime', private: true }, null, 2));
  }
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  run(npmCmd, [
    'install',
    '--prefix', DSH_DIR,
    `@deepseek-ai/dsh@${DSH_VERSION}`,
    // 关键:dsh 含平台相关原生模块(koffi/sharp/node-pty 等),
    // 显式指定目标平台,保证无论在什么系统上构建,装进来的都是 Windows x64 二进制
    '--os=win32',
    '--cpu=x64',
    // 原生模块的 .node 二进制由 @koromix/koffi-win32-x64、@img/sharp-win32-x64
    // 等平台可选包直接提供(已实测验证),不需要也不允许在构建机上跑安装脚本
    // (否则 koffi 的 cnoke 脚本会尝试用 CMake 从源码编译,在非 Windows 构建机上必失败)
    '--ignore-scripts',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    '--loglevel=error'
  ]);
  if (!fs.existsSync(marker)) throw new Error('dsh 安装失败:未找到 lib/bin.js');
  console.log(`[prepare] dsh v${DSH_VERSION} 安装完成`);
}

(async () => {
  fs.mkdirSync(RES, { recursive: true });
  await prepareNode();
  prepareDsh();
  fs.writeFileSync(
    path.join(RES, 'build-info.json'),
    JSON.stringify({ node: NODE_VERSION, dsh: DSH_VERSION, builtAt: new Date().toISOString() }, null, 2)
  );
  console.log('[prepare] 全部资源就绪');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
