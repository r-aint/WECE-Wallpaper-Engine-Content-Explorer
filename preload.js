'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** 菜单事件订阅（返回取消订阅函数） */
function onMenu(channel, cb) {
  const channels = ['menu:pickRoot', 'menu:redetect', 'menu:rescan'];
  if (!channels.includes(channel)) return () => {};
  const handler = () => cb();
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('we', {
  // 初始化
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),

  // 目录配置
  pickRoot: () => ipcRenderer.invoke('config:pickRoot'),
  setRoot: (dir) => ipcRenderer.invoke('config:setRoot', dir),
  removeDir: (dir) => ipcRenderer.invoke('config:removeDir', dir),
  setActiveDir: (dir) => ipcRenderer.invoke('config:setActiveDir', dir),
  redetect: () => ipcRenderer.invoke('config:redetect'),
  save: (patch) => ipcRenderer.invoke('config:save', patch),

  // 扫描
  scan: () => ipcRenderer.invoke('items:scan'),
  onScanProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('scan:progress', handler);
    return () => ipcRenderer.removeListener('scan:progress', handler);
  },

  // 右键原生菜单
  showCardMenu: (payload) => ipcRenderer.invoke('menu:card', payload),

  // 场景包（.pkg）解包
  pkgStatus: () => ipcRenderer.invoke('pkg:status'),
  pkgResetRepkg: () => ipcRenderer.invoke('pkg:resetRepkg'),
  pkgPickCacheDir: () => ipcRenderer.invoke('pkg:pickCacheDir'),
  pkgSetCacheDir: (dir) => ipcRenderer.invoke('pkg:setCacheDir', dir),
  pkgOpenCacheDir: () => ipcRenderer.invoke('pkg:openCacheDir'),
  pkgPickRepkg: () => ipcRenderer.invoke('pkg:pickRepkg'),
  pkgExtract: (payload) => ipcRenderer.invoke('pkg:extract', payload),
  pkgRestore: () => ipcRenderer.invoke('pkg:restore'),
  pkgCacheInfo: () => ipcRenderer.invoke('pkg:cacheInfo'),
  pkgEnforceLimit: () => ipcRenderer.invoke('pkg:enforceLimit'),
  pkgClearCache: (itemId) => ipcRenderer.invoke('pkg:clearCache', itemId),
  onPkgProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('pkg:progress', handler);
    return () => ipcRenderer.removeListener('pkg:progress', handler);
  },

  // 缩略图：返回 data URL，避免在界面里解码几十 MB 的原图
  thumb: (filePath, size) => ipcRenderer.invoke('thumb:get', filePath, size),

  // 窗口
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  openHtmlWindow: (p) => ipcRenderer.invoke('window:openHtml', p),

  // 打开动作
  openExternal: (p) => ipcRenderer.invoke('open:external', p),
  revealPath: (p) => ipcRenderer.invoke('reveal:path', p),
  openFolder: (dir) => ipcRenderer.invoke('shell:openFolder', dir),
  copyText: (text) => ipcRenderer.invoke('clipboard:copy', text),

  // 菜单
  onMenu: (channel, cb) => onMenu(channel, cb),
});
