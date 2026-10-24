'use strict';

/**
 * 订阅扫描模块
 * - 自动定位 Steam 库与 Wallpaper Engine（AppID 431960）订阅目录
 * - 解析每个订阅项的 project.json / preview / 内容文件
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

/** Wallpaper Engine 在 Steam 上的 AppID */
const WE_APP_ID = '431960';

const VIDEO_EXT = new Set([
  '.mp4', '.webm', '.avi', '.mov', '.mkv', '.wmv', '.flv', '.m4v', '.mpg', '.mpeg', '.ts',
]);
const IMAGE_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.apng', '.avif',
]);
const HTML_EXT = new Set(['.html', '.htm']);
const EXEC_EXT = new Set(['.exe']);
const PACKAGE_EXT = new Set(['.pkg']);

/* ------------------------------------------------------------------ *
 * Steam 定位
 * ------------------------------------------------------------------ */

/** 从注册表读取 Steam 安装路径（失败返回 null） */
function readSteamPathFromRegistry() {
  if (process.platform !== 'win32') return null;
  const keys = [
    ['HKCU\\Software\\Valve\\Steam', 'SteamPath'],
    ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
    ['HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'],
  ];
  for (const [key, valueName] of keys) {
    try {
      const out = execFileSync('reg', ['query', key, '/v', valueName], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
      });
      const m = out.match(/REG_SZ\s+(.+)\s*$/m);
      if (m && m[1].trim()) return path.normalize(m[1].trim());
    } catch {
      /* 忽略：换下一个候选 */
    }
  }
  return null;
}

/** 生成常见的 Steam 安装候选路径 */
function commonSteamPaths() {
  const list = [];
  if (process.platform !== 'win32') return list;
  const drives = ['C:', 'D:', 'E:', 'F:', 'G:'];
  const templates = [
    'Program Files (x86)\\Steam',
    'Program Files\\Steam',
    'Steam',
    'SteamLibrary',
    'Games\\Steam',
    'Games\\SteamLibrary',
  ];
  for (const d of drives) {
    for (const t of templates) list.push(`${d}\\${t}`);
  }
  return list;
}

/** 解析 libraryfolders.vdf，取出所有 Steam 库根目录 */
async function readLibraryFolders(steamRoot) {
  const vdfPath = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf');
  try {
    const text = await fsp.readFile(vdfPath, 'utf8');
    const dirs = [];
    const re = /"path"\s*"([^"]+)"/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      dirs.push(path.normalize(m[1].replace(/\\\\/g, '\\')));
    }
    return dirs;
  } catch {
    return [];
  }
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 同步版存在性检查，用于路径解析 */
function existsSync(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 探测整个环境：Steam 库、订阅目录、本地项目目录
 * @returns {Promise<{steamLibraries:string[], workshopDirs:string[], localProjectsDir:string|null}>}
 */
async function detectEnvironment() {
  // Windows 路径不区分大小写，用规范化 key 去重，并保留先加入的“好看”写法
  const normKey = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  const makePusher = () => {
    const seen = new Set();
    return (list, p) => {
      const key = normKey(p);
      if (seen.has(key)) return false;
      seen.add(key);
      list.push(p);
      return true;
    };
  };
  const pushCandidate = makePusher();
  const pushLibrary = makePusher();

  const candidates = [];
  for (const p of commonSteamPaths()) {
    if (existsSync(p)) pushCandidate(candidates, p);
  }
  const reg = readSteamPathFromRegistry();
  if (reg && existsSync(reg)) pushCandidate(candidates, reg);

  const steamLibraries = [];
  for (const root of candidates) {
    pushLibrary(steamLibraries, root);
    for (const lib of await readLibraryFolders(root)) {
      if (existsSync(lib)) pushLibrary(steamLibraries, lib);
    }
  }

  const workshopDirs = [];
  let localProjectsDir = null;

  for (const lib of steamLibraries) {
    const workshop = path.join(lib, 'steamapps', 'workshop', 'content', WE_APP_ID);
    if (existsSync(workshop) && !workshopDirs.some((d) => normKey(d) === normKey(workshop))) {
      workshopDirs.push(workshop);
    }

    if (!localProjectsDir) {
      const projects = path.join(lib, 'steamapps', 'common', 'wallpaper_engine', 'projects', 'myprojects');
      if (existsSync(projects)) localProjectsDir = projects;
    }
  }

  return {
    steamLibraries: [...steamLibraries],
    workshopDirs,
    localProjectsDir,
  };
}

/* ------------------------------------------------------------------ *
 * project.json 解析
 * ------------------------------------------------------------------ */

/** 容错解析：JSON.parse 失败时用正则兜底提取关键字段 */
function parseProjectJson(text) {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    const pick = (key) => {
      const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
      const m = text.match(re);
      if (!m) return undefined;
      try {
        return JSON.parse(`"${m[1]}"`);
      } catch {
        return m[1];
      }
    };
    return {
      title: pick('title'),
      type: pick('type'),
      file: pick('file'),
      preview: pick('preview'),
      description: pick('description'),
      _fallback: true,
    };
  }
}

/* ------------------------------------------------------------------ *
 * 单项目扫描
 * ------------------------------------------------------------------ */

function fileUrl(absPath) {
  try {
    return pathToFileURL(absPath).href;
  } catch {
    return null;
  }
}

function isPreviewFile(name, meta) {
  const lower = name.toLowerCase();
  if (meta && meta.preview && name === meta.preview) return true;
  const base = lower.replace(/\.[^.]+$/, '');
  return base === 'preview';
}

/* ------------------------------------------------------------------ *
 * 子目录补扫
 *
 * 订阅目录里的「其他 / 程序」类项目，很多其实是别的壁纸的预设包，
 * 媒体文件（视频 / 图片）放在子文件夹里。只看顶层就会既没有画面、
 * 也无法预览，所以顶层没有媒体时按需向下找一层到三层。
 * ------------------------------------------------------------------ */

const NESTED_MEDIA_MAX_DEPTH = 3;
const NESTED_MEDIA_MAX_FILES = 60;
/** 明显与画面无关的目录，直接跳过 */
const NESTED_MEDIA_SKIP = new Set(['node_modules', '.git', '.svn', 'cache', 'temp', 'tmp', 'logs']);

/**
 * 递归收集子目录中的视频 / 图片，按体积降序（主画面通常排最前）。
 * @param {string} rootDir 项目根目录
 * @param {string} [excludePath] 需要排除的文件（通常是 preview）
 */
async function collectNestedMedia(rootDir, excludePath) {
  const videos = [];
  const images = [];
  const total = () => videos.length + images.length;

  async function walk(dir, depth) {
    if (depth > NESTED_MEDIA_MAX_DEPTH || total() >= NESTED_MEDIA_MAX_FILES) return;

    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const d of dirents) {
      if (total() >= NESTED_MEDIA_MAX_FILES) return;

      const full = path.join(dir, d.name);

      if (d.isDirectory()) {
        if (NESTED_MEDIA_SKIP.has(d.name.toLowerCase())) continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!d.isFile() || full === excludePath) continue;

      const ext = path.extname(d.name).toLowerCase();
      const isVideo = VIDEO_EXT.has(ext);
      if (!isVideo && !IMAGE_EXT.has(ext)) continue;

      let stat;
      try {
        stat = await fsp.stat(full);
      } catch {
        continue;
      }

      const entry = { name: path.relative(rootDir, full), full, size: stat.size };
      if (isVideo) videos.push(entry);
      else images.push(entry);
    }
  }

  await walk(rootDir, 1);

  const bySize = (a, b) => b.size - a.size;
  videos.sort(bySize);
  images.sort(bySize);
  return { videos, images };
}

/**
 * 扫描单个订阅/项目目录
 * @param {string} itemDir 项目根目录
 * @param {string} [origin] 'workshop' | 'local'
 * @param {(absPath:string)=>string} [toUrl] 把绝对路径转换为渲染进程可用的 URL
 */
async function scanItem(itemDir, origin = 'workshop', toUrl = fileUrl) {
  let dirents;
  try {
    dirents = await fsp.readdir(itemDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const id = path.basename(itemDir);
  const entries = [];
  for (const d of dirents) {
    if (!d.isFile()) continue;
    const full = path.join(itemDir, d.name);
    let stat = null;
    try {
      stat = await fsp.stat(full);
    } catch {
      continue;
    }
    entries.push({
      name: d.name,
      full,
      ext: path.extname(d.name).toLowerCase(),
      size: stat.size,
      mtime: stat.mtimeMs,
    });
  }

  // 读取 project.json
  let meta = null;
  const projectEntry = entries.find((e) => e.name.toLowerCase() === 'project.json');
  if (projectEntry) {
    try {
      meta = parseProjectJson(await fsp.readFile(projectEntry.full, 'utf8'));
    } catch {
      meta = null;
    }
  }

  const previewEntry =
    entries.find((e) => isPreviewFile(e.name, meta) && IMAGE_EXT.has(e.ext)) ||
    entries.find((e) => isPreviewFile(e.name, meta)) ||
    null;

  const contentFiles = entries.filter((e) => e !== previewEntry && e.name !== 'project.json');

  let videos = contentFiles
    .filter((e) => VIDEO_EXT.has(e.ext))
    .map((e) => ({ name: e.name, size: e.size, url: toUrl(e.full), path: e.full }));

  let images = contentFiles
    .filter((e) => IMAGE_EXT.has(e.ext))
    .map((e) => ({ name: e.name, size: e.size, url: toUrl(e.full), path: e.full }));

  const htmls = contentFiles
    .filter((e) => HTML_EXT.has(e.ext))
    .map((e) => ({ name: e.name, size: e.size, url: toUrl(e.full), path: e.full }));

  const pkgs = contentFiles
    .filter((e) => PACKAGE_EXT.has(e.ext))
    .map((e) => ({ name: e.name, size: e.size, path: e.full }));

  const execs = contentFiles
    .filter((e) => EXEC_EXT.has(e.ext))
    .map((e) => ({ name: e.name, size: e.size, path: e.full }));

  let totalSize = entries.reduce((sum, e) => sum + e.size, 0);

  /*
   * 顶层没有可预览的画面、也没有 .pkg 时，去子目录补扫一遍：
   * 这样「其他 / 程序」类预设包里的视频、图片也能在详情页预览。
   * 有 .pkg 的项目不补扫，交给 RePKG 解包处理，避免翻遍整个资源目录。
   */
  if (!videos.length && !images.length && !pkgs.length) {
    const nested = await collectNestedMedia(itemDir, previewEntry && previewEntry.full);
    if (nested.videos.length || nested.images.length) {
      videos = nested.videos.map((e) => ({
        name: e.name, size: e.size, url: toUrl(e.full), path: e.full,
      }));
      images = nested.images.map((e) => ({
        name: e.name, size: e.size, url: toUrl(e.full), path: e.full,
      }));
      totalSize += nested.videos.concat(nested.images).reduce((sum, e) => sum + e.size, 0);
    }
  }

  // 部分项目（如 category=Asset 的素材包）把资源放在 contents 子目录里
  const hasContentsDir = dirents.some((d) => d.isDirectory() && d.name.toLowerCase() === 'contents');

  const declaredType = (meta && meta.type) || null;
  let kind;
  if (declaredType === 'web' && htmls.length) kind = 'web';
  else if (videos.length) kind = 'video';
  else if (htmls.length) kind = 'web';
  else if (execs.length) kind = 'application';
  else if (pkgs.length || hasContentsDir) kind = 'scene';
  else if (images.length) kind = 'image';
  else kind = 'other';

  return {
    id,
    origin,
    dir: itemDir,
    folderName: path.basename(itemDir),
    title: (meta && (meta.title || meta.name)) || path.basename(itemDir),
    declaredType,
    kind,
    tags: Array.isArray(meta && meta.tags) ? meta.tags : [],
    description: (meta && meta.description) || '',
    contentRating: (meta && meta.contentrating) || '',
    workshopId: (meta && meta.workshopid) || null,
    mainFile: (meta && meta.file) || null,
    parseOk: !!meta && !meta._fallback,
    preview: previewEntry
      ? {
          name: previewEntry.name,
          path: previewEntry.full,
          url: toUrl(previewEntry.full),
          animated: ['.gif', '.webp', '.apng'].includes(previewEntry.ext),
        }
      : null,
    videos,
    images,
    htmls,
    pkgs,
    execs,
    fileCount: entries.length,
    totalSize,
    mtime: entries.reduce((max, e) => Math.max(max, e.mtime), 0),
  };
}

/**
 * 扫描订阅根目录下的全部项目
 * @param {string} rootDir
 * @param {(done:number,total:number)=>void} [onProgress]
 * @param {(absPath:string)=>string} [toUrl] 把绝对路径转换为渲染进程可用的 URL
 */
async function scanRoot(rootDir, onProgress, toUrl = fileUrl) {
  const items = [];
  let dirents;
  try {
    dirents = await fsp.readdir(rootDir, { withFileTypes: true });
  } catch (err) {
    return { items, error: `无法读取目录：${err.message}` };
  }

  const dirs = dirents.filter((d) => d.isDirectory() && !d.name.startsWith('.'));
  const total = dirs.length;
  let done = 0;
  const concurrency = 12;

  let cursor = 0;
  async function worker() {
    while (cursor < dirs.length) {
      const d = dirs[cursor++];
      const item = await scanItem(path.join(rootDir, d.name), 'workshop', toUrl);
      if (item) {
        item.rootDir = rootDir; // 合并多个库时用来区分来源
        items.push(item);
      }
      done += 1;
      if (onProgress && (done % 8 === 0 || done === total)) onProgress(done, total);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, total || 1) }, worker));

  items.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
  return { items, error: null };
}

module.exports = {
  WE_APP_ID,
  VIDEO_EXT,
  IMAGE_EXT,
  detectEnvironment,
  scanRoot,
  scanItem,
  fileUrl,
  exists,
};
