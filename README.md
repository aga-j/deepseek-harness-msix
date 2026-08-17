# DeepSeek Harness Windows 桌面客户端

把开源项目 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 包装成 Windows 桌面应用:用户双击 exe 安装后,从桌面图标启动,主窗口内直接显示 dsh 的 Web UI,无需安装 Node.js、无需敲任何命令。

## 工作原理(方案 A)

```
双击图标
  → Electron 启动,显示启动画面
  → 用安装包内嵌的 node.exe 启动内嵌的 dsh web(端口由系统随机分配)
  → 轮询 http://127.0.0.1:<端口> 直到服务就绪
  → 创建主窗口加载 Web UI(就是浏览器里那个界面)
  → 关闭窗口时自动杀掉整个 dsh 进程树
```

- Node 运行时和 `@deepseek-ai/dsh`(含全部依赖)在**构建时**打包进安装包,用户机器零依赖、离线可用;
- 用户数据(会话、日志、工作区)存放在 `%APPDATA%\DeepSeekHarness`,不受安装目录权限影响;
- dsh 版本锁定在 `scripts/prepare-resources.js` 顶部的 `DSH_VERSION`,上游发布新版后改版本号、重新构建即可。

## 产出 Windows 安装包(exe)

### 方式一:GitHub Actions 自动构建(推荐,零本地环境要求)

三步拿到 exe:

1. **上传**:把本目录推送到你自己的 GitHub 仓库(私有仓库也可以);
2. **触发**:在仓库页面点 **Actions → Build Windows Installer → Run workflow**(或者打 tag:`git tag v0.1.0 && git push origin v0.1.0`);
3. **下载**:约 5~10 分钟后,在 **Actions 产物(Artifacts)** 或 **Releases** 页面拿到 `DeepSeek.Harness-Setup-x.x.x.exe`(约 150MB,内嵌完整 Node 24 运行时和 dsh),发给任何人双击即可安装,全程不需要对方装任何环境。安装向导本身 1 分钟内完成;**首次启动**时会一次性解压初始化组件(约 1~3 分钟,启动画面有提示),之后每次启动都是秒开。

### 方式二:本地构建(需要 Windows 机器)

```bash
npm install          # 安装 electron / electron-builder
npm run dist         # 自动下载 node.exe + 预装 dsh,然后打出 NSIS 安装包
```

产物在 `release\DeepSeek-Harness-Setup-0.1.0.exe`。

> macOS / Linux 上也可以构建 Windows 安装包,但需要先安装 Wine(electron-builder 依赖它修改 exe 元数据),建议直接用方式一。

## 目录结构

```
├── main.js                  # Electron 主进程:拉起 dsh 服务 + 窗口生命周期
├── preload.js               # 预加载脚本(预留原生能力扩展口)
├── splash.html              # 启动画面(服务就绪前显示)
├── build/icon.png|ico       # 应用图标,可替换
├── scripts/
│   └── prepare-resources.js # 构建期脚本:下载 node.exe + 预装 dsh
├── resources/               # 构建时生成:node/ 和 dsh/(不提交 git)
└── .github/workflows/
    └── build.yml            # Windows 安装包自动构建流水线
```

## 升级 dsh 版本

dsh 目前处于开发者预览阶段,迭代很快。升级步骤:

1. 修改 `scripts/prepare-resources.js` 中的 `DSH_VERSION`;
2. 本地删掉 `resources/dsh/` 后重新 `npm run dist`,或直接推 tag 让 CI 构建;
3. 升级客户端版本号(`package.json` 的 `version`)。

## 常见问题

- **首次启动慢**:首启要把内嵌的 dsh.zip(数万个依赖文件)解压到 `%APPDATA%\DeepSeekHarness\runtime`,启动画面会显示实时解压进度(如 `12345 / 58000 个文件`)。解压速度主要取决于磁盘和 Windows Defender 实时扫描,快则 1~2 分钟,慢则 5~10 分钟,**只发生这一次**;之后每次启动秒开;
- **安装向导慢**(0.1.0 旧版问题):旧版安装包逐个写入数万个小文件,叠加 Defender 实时扫描,安装可能要 5~15 分钟;0.1.1 起改为单压缩包,安装 1 分钟内完成;
- **杀毒软件/SmartScreen 提示**:安装包未做代码签名,属正常现象,点"仍要运行"即可。正式发布建议购买 OV 代码签名证书,然后在 CI 里配置 `CSC_LINK` / `CSC_KEY_PASSWORD` 两个 Secret;
- **端口冲突**:不存在此问题——每次启动由操作系统随机分配空闲端口;
- **卸载残留**:卸载程序会自动清理安装目录;用户数据保留在 `%APPDATA%\DeepSeekHarness`,可手动删除。

## 许可

本壳工程 MIT。DeepSeek Harness 本体为 MIT,见上游仓库。
