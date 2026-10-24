'use strict';

const {
  app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol, clipboard, globalShortcut,
  nativeImage,
} = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { Readable } = require('node:stream');
const scanner = require('./src/scanner');
const pkg = require('./src/pkg');

/* ------------------------------------------------------------------ *
 * 资源协议：把本地绝对路径映射为渲染进程可安全引用的 URL
 * 形如 we-asset://local/?p=<encodeURIComponent(absPath)>
 * 支持 Range 请求，保证视频可以拖动进度条。
 * ------------------------------------------------------------------ */

const ASSET_SCHEME = 'we-asset';

protocol.registerSchemesAsPrivileged([
  {
    scheme: ASSET_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.ts': 'video/mp2t',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.apng': 'image/apng',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
};

function toAssetUrl(absPath) {
  return `${ASSET_SCHEME}://local/?p=${encodeURIComponent(absPath)}`;
}

function decodeAssetPath(requestUrl) {
  try {
    const url = new URL(requestUrl);
    return url.searchParams.get('p') || '';
  } catch {
    return '';
  }
}

function registerAssetProtocol() {
  protocol.handle(ASSET_SCHEME, async (request) => {
    const filePath = decodeAssetPath(request.url);
    if (!filePath) return new Response('Bad request', { status: 400 });

    let stat;
    try {
      stat = await fsp.stat(filePath);
      if (!stat.isFile()) throw new Error('not a file');
    } catch {
      return new Response('Not found', { status: 404 });
    }

    const mime = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const rangeHeader = request.headers.get('range');

    if (rangeHeader) {
      const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
        if (Number.isFinite(start) && start <= end && start < stat.size) {
          const stream = Readable.toWeb(fs.createReadStream(filePath, { start, end }));
          return new Response(stream, {
            status: 206,
            headers: {
              'Content-Type': mime,
              'Content-Length': String(end - start + 1),
              'Content-Range': `bytes ${start}-${end}/${stat.size}`,
              'Accept-Ranges': 'bytes',
            },
          });
        }
      }
    }

    const stream = Readable.toWeb(fs.createReadStream(filePath));
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Content-Length': String(stat.size),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      },
    });
  });
}

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

const DEFAULTS = {
  rootDir: null, // 旧版单目录配置，仅用于迁移
  /** 要扫描的订阅目录列表（可跨多个 Steam 库） */
  rootDirs: [],
  /** 'all' 表示合并查看，否则为某个具体目录 */
  activeDir: 'all',
  viewMode: 'grid',
  sortBy: 'title-asc',
  /** RePKG.exe 路径；null 表示自动探测 */
  repkgPath: null,
  /** 解包缓存上限（MB）；0 表示不自动清理 */
  pkgCacheLimitMB: 2048,
  /** 解包缓存目录；null 表示用默认位置（userData/pkg-cache） */
  pkgCacheDir: null,
  appearance: {
    cardMin: 238,
    density: 'normal',
    accent: 'blue',
    showTags: true,
    showSize: true,
  },
  /**
   * NSFW 内容：hide=从列表/详情切换中剔除，blur=封面模糊。
   * 默认不隐藏、默认模糊，避免首次使用就看到成人内容封面。
   */
  nsfw: {
    hide: false,
    blur: true,
  },
};

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return {
      ...DEFAULTS,
      ...raw,
      appearance: { ...DEFAULTS.appearance, ...(raw.appearance || {}) },
      nsfw: { ...DEFAULTS.nsfw, ...(raw.nsfw || {}) },
    };
  } catch {
    return {
      ...DEFAULTS,
      appearance: { ...DEFAULTS.appearance },
      nsfw: { ...DEFAULTS.nsfw },
    };
  }
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.error('[config] 写入失败:', err.message);
  }
  return next;
}

/* ------------------------------------------------------------------ *
 * 应用状态
 * ------------------------------------------------------------------ */

const state = {
  config: null,
  env: {
    steamLibraries: [],
    workshopDirs: [],
    localProjectsDir: null,
  },
  /** 本次要扫描的目录列表 */
  dirs: [],
  /** 每个目录扫描出的条目数 [{ path, count }] */
  dirStats: [],
  items: [],
  scanning: false,
  mainWindow: null,
  /** RePKG.exe 探测结果 { path: string|null } */
  repkg: { path: null },
};

function isDirSync(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 默认的解包缓存目录（放在 userData 下，不碰 Steam 订阅文件夹） */
function defaultPkgCacheRoot() {
  return path.join(app.getPath('userData'), 'pkg-cache');
}

/** 实际生效的解包缓存目录：配置里指定过就用它，否则用默认位置 */
function pkgCacheRoot() {
  const custom = state.config && state.config.pkgCacheDir;
  if (typeof custom === 'string' && custom.trim()) {
    try {
      return path.resolve(custom.trim());
    } catch {
      /* 非法路径，回退默认 */
    }
  }
  return defaultPkgCacheRoot();
}

/**
 * 把旧缓存目录里的条目搬到新目录。
 * 同盘用 rename（瞬间完成），跨盘退化为复制后删除；
 * 新目录若已有同名条目则跳过，避免覆盖新位置的解包结果。
 * @returns {Promise<number>} 成功迁移的条目数
 */
async function migrateCacheDir(from, to) {
  if (!from || !to) return 0;
  try {
    if (path.resolve(from) === path.resolve(to)) return 0;
  } catch {
    return 0;
  }
  if (!isDirSync(from)) return 0;

  // 旧目录必须是本应用的缓存目录，否则里面的东西不是缓存，不能搬
  if (!(await pkg.isCacheDir(from))) return 0;

  try {
    await fsp.mkdir(to, { recursive: true });
  } catch (err) {
    console.warn('[pkg] 创建缓存目录失败:', err.message);
    return 0;
  }

  let dirents = [];
  try {
    dirents = await fsp.readdir(from, { withFileTypes: true });
  } catch {
    return 0;
  }

  let moved = 0;
  for (const d of dirents) {
    // 只搬订阅 ID 目录（缓存条目），旧目录里其它文件原地保留
    if (!d.isDirectory() || !/^\d+$/.test(d.name)) continue;

    const src = path.join(from, d.name);
    const dst = path.join(to, d.name);
    try {
      if (fs.existsSync(dst)) continue;
      try {
        await fsp.rename(src, dst);
      } catch {
        await fsp.cp(src, dst, { recursive: true });
        await fsp.rm(src, { recursive: true, force: true });
      }
      moved += 1;
    } catch (err) {
      console.warn('[pkg] 迁移缓存失败:', d.name, err.message);
    }
  }

  await pkg.ensureCacheMarker(to);
  return moved;
}

/**
 * 兼容旧版本的缓存目录：旧版没有标记文件，
 * 当目录里只有订阅 ID 子目录（或本来就是空的）时补上标记继续用；
 * 混有其它文件的目录不认领，避免把用户文件夹当成缓存。
 */
async function adoptLegacyCacheDir(dir) {
  if (!dir || !isDirSync(dir)) return false;
  if (await pkg.isCacheDir(dir)) return true;

  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  const onlyCacheEntries = dirents.every((d) => d.isDirectory() && /^\d+$/.test(d.name));
  if (!onlyCacheEntries) return false;

  await pkg.ensureCacheMarker(dir);
  return true;
}

/** RePKG 版本号缓存（undefined 表示还没读过） */
let repkgVersionCache;

/** 读取并缓存 RePKG 版本号 */
async function repkgVersion() {
  if (repkgVersionCache !== undefined) return repkgVersionCache;
  if (!state.repkg.path) return null;
  repkgVersionCache = await pkg.readVersion(state.repkg.path);
  return repkgVersionCache;
}

/** 重新探测 RePKG 并更新缓存状态 */
function refreshRePKG() {
  state.repkg = { path: pkg.detectRePKG(state.config && state.config.repkgPath) };
  repkgVersionCache = undefined;
  return state.repkg;
}

/** 判断当前使用的 RePKG 是不是随包内置的那一份 */
function isBundledRePKG(exePath) {
  const bundled = pkg.bundledRePKGPath();
  if (!exePath || !bundled) return false;
  try {
    return path.resolve(exePath).toLowerCase() === path.resolve(bundled).toLowerCase();
  } catch {
    return false;
  }
}

/** 目录列表去重（Windows 路径不区分大小写），并剔除已不存在的目录 */
function normalizeDirs(list) {
  const out = [];
  const seen = new Set();
  for (const d of Array.isArray(list) ? list : []) {
    if (typeof d !== 'string' || !d.trim()) continue;
    let key;
    try {
      key = path.resolve(d).replace(/[\\/]+$/, '').toLowerCase();
    } catch {
      continue;
    }
    if (seen.has(key) || !isDirSync(d)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/** 决定要扫描的目录列表 */
function resolveRootDirs(config, env) {
  const configured = normalizeDirs(config.rootDirs);
  if (configured.length) return configured;
  // 兼容旧版单目录配置
  if (config.rootDir && isDirSync(config.rootDir)) return [config.rootDir];
  if (env.workshopDirs.length) return normalizeDirs(env.workshopDirs);
  if (env.localProjectsDir) return [env.localProjectsDir];
  return [];
}

function sameList(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */

let htmlViewerWindows = new Set();

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#101116',
    title: 'Wallpaper Engine 内容管理器',
    autoHideMenuBar: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // npm run dev：自动打开开发者工具，方便调试前端
  if (process.argv.includes('--dev')) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => {
    state.mainWindow = null;
  });

  state.mainWindow = win;
  return win;
}

/* ------------------------------------------------------------------ *
 * 老板键：一键隐藏 / 恢复窗口
 * ------------------------------------------------------------------ */

/** 全局老板键（与设置面板里展示的文案保持一致） */
const BOSS_KEY = 'CommandOrControl+Shift+H';

/**
 * 立即隐藏主窗口，并静音正在播放的视频，避免只藏住画面却还在出声。
 * @returns {boolean} 是否成功隐藏
 */
function hideMainWindow() {
  const win = state.mainWindow;
  if (!win) return false;
  try {
    win.webContents.setAudioMuted(true);
  } catch {
    /* 忽略 */
  }
  win.hide();
  return true;
}

/** 老板键：可见时隐藏，隐藏时恢复并取消静音 */
function toggleBossKey() {
  const win = state.mainWindow;
  if (!win) return;
  if (win.isVisible()) {
    hideMainWindow();
    return;
  }
  try {
    win.webContents.setAudioMuted(false);
  } catch {
    /* 忽略 */
  }
  win.show();
  win.focus();
}

/** 注册老板键；被其它程序占用时只告警，不影响应用启动 */
function registerBossKey() {
  try {
    if (!globalShortcut.register(BOSS_KEY, toggleBossKey)) {
      console.warn('[boss] 老板键注册失败（可能被其它程序占用）:', BOSS_KEY);
    }
  } catch (err) {
    console.warn('[boss] 老板键注册异常:', err.message);
  }
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '添加订阅目录…',
          accelerator: 'CmdOrCtrl+O',
          click: () => state.mainWindow && state.mainWindow.webContents.send('menu:pickRoot'),
        },
        {
          label: '重新检测 Steam 库',
          click: () => state.mainWindow && state.mainWindow.webContents.send('menu:redetect'),
        },
        { type: 'separator' },
        {
          label: '重新扫描',
          accelerator: 'F5',
          click: () => state.mainWindow && state.mainWindow.webContents.send('menu:rescan'),
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载界面' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放', accelerator: 'CmdOrCtrl+0' },
        /*
         * role: 'zoomIn' 的默认加速键是 CmdOrCtrl+Plus，只认小键盘的加号：
         * 主键盘打 + 实际是 Shift+=，多一个 Shift 修饰键就匹配不上，
         * 于是 Ctrl+- 能用、Ctrl++ 没反应。
         * 这里显式补上 = 和 Shift+= 两种按法，小键盘的 Plus 也保留。
         */
        { role: 'zoomIn', label: '放大', accelerator: 'CmdOrCtrl+=' },
        { role: 'zoomIn', label: '放大', accelerator: 'CmdOrCtrl+Shift+=', visible: false },
        { role: 'zoomIn', label: '放大', accelerator: 'CmdOrCtrl+Plus', visible: false },
        { role: 'zoomOut', label: '缩小', accelerator: 'CmdOrCtrl+-' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '打开订阅目录',
          click: () => {
            const dirs = state.dirs || [];
            const active = state.config && state.config.activeDir;
            const target = active && active !== 'all' && dirs.includes(active) ? active : dirs[0];
            if (target) shell.openPath(target);
          },
        },
        {
          label: '关于',
          click: () => {
            dialog.showMessageBox(state.mainWindow, {
              type: 'info',
              title: '关于',
              message: 'Wallpaper Engine 内容管理器',
              detail: `版本 ${app.getVersion()}\n\n浏览并打开创意工坊订阅内容（AppID 431960）。\n前端源码位于 renderer/ 目录，修改后按 Ctrl+R 即可生效。`,
              buttons: ['好'],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ *
 * 扫描
 * ------------------------------------------------------------------ */

async function doScan() {
  if (state.scanning) {
    return { items: state.items, dirs: state.dirStats, error: null, skipped: true };
  }

  const dirs = state.dirs.length ? state.dirs : resolveRootDirs(state.config, state.env);
  if (!dirs.length) return { items: [], dirs: [], error: '尚未设置订阅目录' };

  state.scanning = true;
  const started = Date.now();
  const progress = new Map();

  const report = () => {
    let done = 0;
    let total = 0;
    for (const p of progress.values()) {
      done += p.done;
      total += p.total;
    }
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.webContents.send('scan:progress', { done, total });
    }
  };

  try {
    // 多个库并行扫描，进度按所有目录的合计值汇报
    const results = await Promise.all(dirs.map(async (dir) => {
      if (!isDirSync(dir)) return { dir, items: [], error: `目录不存在：${dir}` };
      const res = await scanner.scanRoot(
        dir,
        (done, total) => {
          progress.set(dir, { done, total });
          report();
        },
        toAssetUrl
      );
      return { dir, ...res };
    }));

    const items = [];
    const dirStats = [];
    const errors = [];
    for (const r of results) {
      for (const it of r.items) items.push(it);
      dirStats.push({ path: r.dir, count: r.items.length });
      if (r.error) errors.push(r.error);
    }

    items.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));

    state.items = items;
    state.dirStats = dirStats;

    return {
      items,
      dirs: dirStats,
      error: errors.length ? errors.join('；') : null,
      elapsed: Date.now() - started,
      counts: countByKind(items),
    };
  } finally {
    state.scanning = false;
  }
}

function countByKind(items) {
  const counts = { all: items.length };
  for (const it of items) counts[it.kind] = (counts[it.kind] || 0) + 1;
  return counts;
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 缩略图缓存
 * ------------------------------------------------------------------ */

/** 内存里最多保留多少张缩略图 */
const THUMB_MAX_CACHE = 600;
/** key = `${宽}|${绝对路径}` → data URL */
const thumbCache = new Map();

/** 只允许为已配置订阅目录下的文件生成缩略图，避免被当成任意文件读取器 */
function isUnderRootDirs(filePath) {
  if (!filePath) return false;
  let target;
  try {
    target = path.resolve(String(filePath)).toLowerCase();
  } catch {
    return false;
  }
  return (state.dirs || []).some((dir) => {
    let root;
    try {
      root = path.resolve(dir).toLowerCase();
    } catch {
      return false;
    }
    return target === root || target.startsWith(root + path.sep);
  });
}

/** 写入缩略图缓存，超出上限时丢弃最早的一半 */
function rememberThumb(key, url) {
  if (thumbCache.size >= THUMB_MAX_CACHE) {
    const keys = [...thumbCache.keys()].slice(0, Math.floor(THUMB_MAX_CACHE / 2));
    for (const k of keys) thumbCache.delete(k);
  }
  thumbCache.set(key, url);
}

function registerIpc() {
  ipcMain.handle('app:bootstrap', async () => {
    state.config = readConfig();
    state.env = await scanner.detectEnvironment();

    const dirs = resolveRootDirs(state.config, state.env);
    if (dirs.length && !sameList(dirs, state.config.rootDirs || [])) {
      state.config = writeConfig({ rootDirs: dirs });
    }
    state.dirs = dirs;

    // activeDir 指向的目录已不在列表里时，回退到「全部」
    if (state.config.activeDir !== 'all' && !dirs.includes(state.config.activeDir)) {
      state.config = writeConfig({ activeDir: 'all' });
    }

    refreshRePKG();

    // 启动时按上限收敛一次缓存（异步，不阻塞界面）
    const limitMB = state.config.pkgCacheLimitMB || 0;
    if (limitMB > 0) {
      pkg.enforceCacheLimit(pkgCacheRoot(), limitMB * 1024 * 1024, null).catch(() => {});
    }

    return {
      rootDirs: dirs,
      activeDir: state.config.activeDir,
      config: state.config,
      env: state.env,
      repkg: { path: state.repkg.path, available: !!state.repkg.path },
      pkgCache: {
        dir: pkgCacheRoot(),
        defaultDir: defaultPkgCacheRoot(),
        isDefault: !(state.config && state.config.pkgCacheDir),
      },
      platform: process.platform,
      version: app.getVersion(),
    };
  });

  /** 添加一个目录（可重复调用，累积多个库） */
  ipcMain.handle('config:pickRoot', async () => {
    const result = await dialog.showOpenDialog(state.mainWindow, {
      title: '添加订阅目录（通常为 .../steamapps/workshop/content/431960）',
      properties: ['openDirectory'],
      defaultPath: state.dirs[0] || state.env.workshopDirs[0] || undefined,
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };

    const dir = result.filePaths[0];
    if (!isDirSync(dir)) return { canceled: false, ok: false, error: '目录不存在' };

    const next = normalizeDirs([...state.dirs, dir]);
    state.config = writeConfig({ rootDirs: next });
    state.dirs = next;
    return { canceled: false, ok: true, rootDirs: next, added: dir };
  });

  /** 用单个目录替换整个列表 */
  ipcMain.handle('config:setRoot', (_e, dir) => {
    if (typeof dir !== 'string' || !isDirSync(dir)) return { ok: false, error: '目录不存在' };
    const next = normalizeDirs([dir]);
    state.config = writeConfig({ rootDirs: next, activeDir: 'all' });
    state.dirs = next;
    return { ok: true, rootDirs: next, activeDir: 'all' };
  });

  ipcMain.handle('config:removeDir', (_e, dir) => {
    const next = state.dirs.filter((d) => d !== dir);
    state.config = writeConfig({ rootDirs: next });
    state.dirs = next;
    if (state.config.activeDir !== 'all' && !next.includes(state.config.activeDir)) {
      state.config = writeConfig({ activeDir: 'all' });
    }
    return { ok: true, rootDirs: next, activeDir: state.config.activeDir };
  });

  ipcMain.handle('config:setActiveDir', (_e, dir) => {
    const value = dir === 'all' || state.dirs.includes(dir) ? dir : 'all';
    state.config = writeConfig({ activeDir: value });
    return { ok: true, activeDir: value };
  });

  ipcMain.handle('config:redetect', async () => {
    state.env = await scanner.detectEnvironment();

    // 把新发现的订阅目录并入列表，已存在的不重复添加
    const before = state.dirs.length;
    const next = normalizeDirs([...state.dirs, ...state.env.workshopDirs]);
    if (next.length !== before) {
      state.config = writeConfig({ rootDirs: next });
      state.dirs = next;
    }

    return {
      env: state.env,
      rootDirs: state.dirs,
      added: next.length - before,
    };
  });

  ipcMain.handle('config:save', (_e, patch) => {
    if (patch && typeof patch === 'object') {
      const next = { ...patch };
      // 缓存上限做一次收敛，避免写入非法值
      if ('pkgCacheLimitMB' in next) {
        const n = Number(next.pkgCacheLimitMB);
        next.pkgCacheLimitMB = Number.isFinite(n)
          ? Math.max(0, Math.min(102400, Math.round(n)))
          : DEFAULTS.pkgCacheLimitMB;
      }
      state.config = writeConfig(next);
    }
    return { ok: true, config: state.config };
  });

  /**
   * 卡片右键原生菜单。
   * 菜单里只放“必须由主进程做”的动作，需要界面配合的（如内置预览）通过返回值回传。
   */
  ipcMain.handle('menu:card', (event, payload = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const { title, dir, primaryPath, workshopId, canInlineOpen, canExtract } = payload;

    return new Promise((resolve) => {
      let action = null;
      const template = [];

      if (canInlineOpen) {
        template.push({ label: '打开', click: () => { action = 'open'; } });
      }
      if (canExtract) {
        template.push({ label: '解包并预览画面', click: () => { action = 'extract'; } });
      }
      if (primaryPath) {
        template.push({
          label: '用默认程序打开',
          click: () => { shell.openPath(primaryPath); },
        });
      }
      if (template.length) template.push({ type: 'separator' });

      template.push({
        label: '打开资源管理器',
        click: () => { if (dir) shell.openPath(dir); },
      });
      template.push({
        label: '在文件夹中显示',
        click: () => { if (dir) shell.showItemInFolder(dir); },
      });

      template.push({ type: 'separator' });
      template.push({
        label: '复制标题',
        click: () => { clipboard.writeText(String(title ?? '')); },
      });
      template.push({
        label: '复制路径',
        click: () => { clipboard.writeText(String(dir ?? '')); },
      });
      if (workshopId) {
        template.push({
          label: '复制创意工坊 ID',
          click: () => { clipboard.writeText(String(workshopId)); },
        });
        template.push({ type: 'separator' });
        template.push({
          label: '在 Steam 创意工坊中查看',
          click: () => {
            shell.openExternal(`https://steamcommunity.com/sharedfiles/filedetails/?id=${workshopId}`);
          },
        });
      }

      const menu = Menu.buildFromTemplate(template);
      menu.popup({ window: win, callback: () => resolve({ action }) });
    });
  });

  ipcMain.handle('items:scan', () => doScan());

  ipcMain.handle('open:external', async (_e, targetPath) => {
    if (typeof targetPath !== 'string' || !targetPath) return { ok: false, error: '无效路径' };
    try {
      await fsp.access(targetPath);
    } catch {
      return { ok: false, error: '文件不存在或已被删除' };
    }
    const err = await shell.openPath(targetPath);
    return err ? { ok: false, error: err } : { ok: true };
  });

  ipcMain.handle('reveal:path', async (_e, targetPath) => {
    if (typeof targetPath !== 'string' || !targetPath) return { ok: false };
    shell.showItemInFolder(targetPath);
    return { ok: true };
  });

  /** 设置面板里的「立即隐藏」：无需全局热键也能一键藏起窗口 */
  ipcMain.handle('window:hide', () => ({ ok: hideMainWindow() }));

  /**
   * 生成小尺寸缩略图（data URL）。
   * 图集里动辄几十张几十 MB 的原图，直接塞进 62×36 的按钮会解码很久；
   * 这里用系统缩略图能力压到 96 px 左右，并做内存缓存。
   */
  ipcMain.handle('thumb:get', async (_e, filePath, size) => {
    if (!isUnderRootDirs(filePath)) return { ok: false, error: '路径不在订阅目录内' };

    const width = Math.min(256, Math.max(48, Number(size) || 96));
    let abs;
    try {
      abs = path.resolve(String(filePath));
    } catch {
      return { ok: false, error: '路径无效' };
    }

    const key = `${width}|${abs.toLowerCase()}`;
    const cached = thumbCache.get(key);
    if (cached) return { ok: true, url: cached, cached: true };

    try {
      const img = await nativeImage.createThumbnailFromPath(abs, {
        width,
        height: Math.round(width * 0.5625),
      });
      if (img.isEmpty()) return { ok: false, error: '无法生成缩略图' };
      const url = img.toDataURL();
      rememberThumb(key, url);
      return { ok: true, url };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('shell:openFolder', async (_e, dir) => {
    if (typeof dir !== 'string' || !isDirSync(dir)) return { ok: false, error: '目录不存在' };
    const err = await shell.openPath(dir);
    return err ? { ok: false, error: err } : { ok: true };
  });

  /** 在独立窗口内打开 HTML 类壁纸（相对资源可正常加载） */
  ipcMain.handle('window:openHtml', async (_e, htmlPath) => {
    if (typeof htmlPath !== 'string' || !htmlPath) return { ok: false, error: '无效路径' };
    try {
      await fsp.access(htmlPath);
    } catch {
      return { ok: false, error: '文件不存在' };
    }
    const win = new BrowserWindow({
      width: 1100,
      height: 720,
      backgroundColor: '#000000',
      title: path.basename(htmlPath),
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    htmlViewerWindows.add(win);
    win.on('closed', () => htmlViewerWindows.delete(win));
    win.loadFile(htmlPath);
    return { ok: true };
  });

  ipcMain.handle('clipboard:copy', (_e, text) => {
    clipboard.writeText(String(text ?? ''));
    return { ok: true };
  });

  /* ---------------- 场景包（.pkg）解包 ---------------- */

  ipcMain.handle('pkg:status', async () => {
    if (!state.repkg.path) refreshRePKG();
    return {
      repkgPath: state.repkg.path,
      available: !!state.repkg.path,
      version: await repkgVersion(),
      bundled: isBundledRePKG(state.repkg.path),
      cacheDir: pkgCacheRoot(),
      defaultCacheDir: defaultPkgCacheRoot(),
      isDefault: !(state.config && state.config.pkgCacheDir),
    };
  });

  /** 放弃外部 RePKG，回到随包内置的那一份 */
  ipcMain.handle('pkg:resetRepkg', () => {
    state.config = writeConfig({ repkgPath: null });
    refreshRePKG();
    return {
      ok: true,
      available: !!state.repkg.path,
      bundled: isBundledRePKG(state.repkg.path),
    };
  });

  /** 选择新的缓存目录（只是选，不切换） */
  ipcMain.handle('pkg:pickCacheDir', async () => {
    const res = await dialog.showOpenDialog(state.mainWindow, {
      title: '选择解包缓存目录',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: pkgCacheRoot(),
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    return { path: res.filePaths[0] };
  });

  /**
   * 切换缓存目录。旧缓存如何处理交给用户选：
   * 迁移 / 仅切换（旧文件保留）/ 取消。
   */
  ipcMain.handle('pkg:setCacheDir', async (_e, target) => {
    const oldRoot = pkgCacheRoot();
    const toDefault = !target;
    let nextRoot;
    try {
      nextRoot = toDefault ? defaultPkgCacheRoot() : path.resolve(String(target));
    } catch {
      return { ok: false, error: '路径无效' };
    }

    if (path.resolve(nextRoot) === path.resolve(oldRoot)) {
      return {
        ok: true,
        unchanged: true,
        cacheDir: oldRoot,
        isDefault: !(state.config && state.config.pkgCacheDir),
        cache: await pkg.cacheInfo(oldRoot),
      };
    }

    if (path.parse(nextRoot).root === nextRoot) {
      return { ok: false, error: '不能直接使用磁盘根目录，请选择子文件夹' };
    }

    /*
     * 只接受「空目录」或「已经带缓存标记的目录」：
     * 否则缓存会和用户自己的文件混在一起，清理时还可能误删。
     */
    const usable = await pkg.inspectCacheDir(nextRoot);
    if (!usable.ok) {
      return {
        ok: false,
        error: '这个文件夹里已经有其它文件，为避免把缓存混进去，请选择空文件夹或已有的缓存目录',
      };
    }

    // 目标目录必须可写，否则解包时才报错就晚了
    try {
      await fsp.mkdir(nextRoot, { recursive: true });
      const probe = path.join(nextRoot, '.write-test');
      await fsp.writeFile(probe, 'ok');
      await fsp.rm(probe, { force: true });
    } catch (err) {
      return { ok: false, error: `目录不可写：${err.message}` };
    }

    // 新目录打上标记，之后才认它是缓存
    await pkg.ensureCacheMarker(nextRoot);

    // 旧目录如果压根不是缓存目录，就没有可迁移的内容
    const oldWasCache = await pkg.isCacheDir(oldRoot);
    const oldInfo = oldWasCache ? await pkg.cacheInfo(oldRoot) : { bytes: 0, files: 0, items: 0 };
    let migrate = false;

    if (oldInfo.items > 0) {
      const mb = Math.max(1, Math.round((oldInfo.bytes || 0) / (1024 * 1024)));
      const { response } = await dialog.showMessageBox(state.mainWindow, {
        type: 'question',
        buttons: ['迁移到新目录', '仅切换（旧缓存保留）', '取消'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
        message: '原有的解包缓存怎么处理？',
        detail: `现有缓存：${oldInfo.items} 个项目，约 ${mb} MB\n旧位置：${oldRoot}\n新位置：${nextRoot}\n\n`
          + '迁移：把已解包的画面搬到新目录继续使用；\n'
          + '仅切换：旧文件留在原处不再使用，可自行删除。',
      });
      if (response === 2) return { ok: false, canceled: true };
      migrate = response === 0;
    }

    let moved = 0;
    if (migrate) moved = await migrateCacheDir(oldRoot, nextRoot);

    state.config = writeConfig({ pkgCacheDir: toDefault ? null : nextRoot });

    return {
      ok: true,
      migrated: moved,
      oldWasCache,
      cacheDir: pkgCacheRoot(),
      isDefault: !(state.config && state.config.pkgCacheDir),
      cache: await pkg.cacheInfo(pkgCacheRoot()),
    };
  });

  /** 打开缓存目录（不存在就先建好） */
  ipcMain.handle('pkg:openCacheDir', async () => {
    const dir = pkgCacheRoot();
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch {
      /* 忽略 */
    }
    const err = await shell.openPath(dir);
    return err ? { ok: false, error: err } : { ok: true };
  });

  ipcMain.handle('pkg:pickRepkg', async () => {
    const result = await dialog.showOpenDialog(state.mainWindow, {
      title: '选择 RePKG.exe',
      properties: ['openFile'],
      filters: [{ name: '可执行文件', extensions: ['exe'] }],
      defaultPath: state.config.repkgPath || 'C:\\RePKG',
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };

    const picked = pkg.normalizeExePath(result.filePaths[0]);
    if (!picked) return { canceled: false, ok: false, error: '这不是有效的 RePKG.exe' };

    state.config = writeConfig({ repkgPath: picked });
    state.repkg = { path: picked };
    return { canceled: false, ok: true, repkgPath: picked };
  });

  ipcMain.handle('pkg:extract', async (event, payload = {}) => {
    const { itemId, pkgPath, force } = payload;

    // 只允许订阅 ID 作为缓存目录名，避免路径穿越
    if (!/^\d+$/.test(String(itemId || ''))) {
      return { ok: false, error: '无效的订阅 ID' };
    }
    if (typeof pkgPath !== 'string' || !/\.pkg$/i.test(pkgPath)) {
      return { ok: false, error: '无效的 PKG 路径' };
    }

    if (!state.repkg.path) refreshRePKG();
    if (!state.repkg.path) return { ok: false, error: 'REPKG_NOT_FOUND' };

    const result = await pkg.extractPkg({
      repkgPath: state.repkg.path,
      cacheRoot: pkgCacheRoot(),
      itemId: String(itemId),
      pkgPath,
      force: !!force,
      onProgress: (info) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('pkg:progress', { itemId: String(itemId), ...info });
        }
      },
    });

    if (result.ok) {
      result.images = result.images.map((img) => ({
        name: img.name,
        rel: img.rel,
        size: img.size,
        path: img.path,
        url: toAssetUrl(img.path),
      }));

      // 解包完成后按配置的上限做一次 LRU 清理（保住刚解包的这个）
      const limitMB = state.config.pkgCacheLimitMB || 0;
      if (limitMB > 0) {
        try {
          const cleanup = await pkg.enforceCacheLimit(
            pkgCacheRoot(),
            limitMB * 1024 * 1024,
            String(itemId)
          );
          if (cleanup.removed.length) {
            result.autoCleanup = {
              count: cleanup.removed.length,
              freed: cleanup.freed,
              ids: cleanup.removed.map((r) => r.id),
            };
          }
        } catch {
          /* 清理失败不影响本次解包结果 */
        }
      }
    }
    return result;
  });

  /** 立即按当前上限清理一次（修改设置后调用） */
  ipcMain.handle('pkg:enforceLimit', async () => {
    const limitMB = state.config.pkgCacheLimitMB || 0;
    if (limitMB <= 0) {
      return { ok: true, skipped: true, cache: await pkg.cacheInfo(pkgCacheRoot()) };
    }
    const res = await pkg.enforceCacheLimit(pkgCacheRoot(), limitMB * 1024 * 1024, null);
    return {
      ok: true,
      freed: res.freed,
      count: res.removed.length,
      ids: res.removed.map((r) => r.id),
      cache: await pkg.cacheInfo(pkgCacheRoot()),
    };
  });

  /** 还原磁盘上已有的解包结果（应用重启后仍能直接预览） */
  ipcMain.handle('pkg:restore', async () => {
    const map = await pkg.restoreCache(pkgCacheRoot());
    const out = {};
    for (const [id, entry] of Object.entries(map)) {
      out[id] = {
        dir: entry.dir,
        fileCount: entry.fileCount,
        extractedAt: entry.extractedAt,
        images: entry.images.map((img) => ({
          name: img.name,
          rel: img.rel,
          size: img.size,
          path: img.path,
          url: toAssetUrl(img.path),
        })),
      };
    }
    return out;
  });

  ipcMain.handle('pkg:cacheInfo', () => pkg.cacheInfo(pkgCacheRoot()));

  ipcMain.handle('pkg:clearCache', async (_e, itemId) => {
    const id = itemId != null ? String(itemId) : null;
    if (id && !/^\d+$/.test(id)) return { ok: false, error: '无效的订阅 ID' };
    const res = await pkg.clearCache(pkgCacheRoot(), id);
    return { ...res, cache: await pkg.cacheInfo(pkgCacheRoot()) };
  });
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = state.mainWindow;
    if (!win) return;
    // 老板键藏起窗口后，再次启动应用也能把它叫回来
    if (!win.isVisible()) {
      try {
        win.webContents.setAudioMuted(false);
      } catch {
        /* 忽略 */
      }
      win.show();
    }
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    registerAssetProtocol();
    state.config = readConfig();
    // 旧版本的缓存目录没有标记文件，启动时补上，避免升级后旧缓存“消失”
    await adoptLegacyCacheDir(pkgCacheRoot()).catch(() => {});
    registerIpc();
    buildMenu();
    createMainWindow();
    registerBossKey();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
