'use strict';

// 预加载脚本:目前不需要向 Web UI 暴露任何 Node 能力,保持最小面。
// 以后如需「在资源管理器中打开文件」等原生集成,在这里通过 contextBridge 扩展。
window.addEventListener('DOMContentLoaded', () => {
  document.title = 'DeepSeek Harness';
});
