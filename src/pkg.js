'use strict';

/**
 * 场景包（.pkg）解包
 *
 * Wallpaper Engine 的 .pkg 是私有打包格式，管理器自身不解析它，
 * 而是调用外部的 RePKG.exe（NotScuffed/repkg）把内容导出：
 *   RePKG.exe extract -o <输出目录> --overwrite <pkg>
 * RePKG 默认会把 .tex 贴图转成 png，因此解包后能直接拿到场景画面。
 *
 * 解包产物一律写入应用自己的缓存目录，绝不写进 Steam 订阅文件夹
 * （那里被 Steam 校验托管，写入可能被覆盖或导致订阅异常）。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;
const META_NAME = '.repkg-meta.json';

/**
 * 缓存目录标记文件。
 * 只有带这个文件的目录才会被当作解包缓存：
 * 用户可以自由指定缓存位置，万一选到自己的文件夹，也不会被统计、
 * 清理或迁移逻辑当成缓存误删。
 */
const CACHE_MARKER = '.pkg-cache.json';
const CACHE_SCHEMA = 1;

/**
 * 明显不是“画面”的贴图（法线、遮罩、特效），预览时过滤掉，
 * 否则弹窗里会混进一堆小方块贴图。
 */
const NOISE_PATTERN = /(^|[\\/])(masks?|effects?|shaders?)([\\/])|(normal|noise|_mask|mask_|_n\.png)/i;

/* ------------------------------------------------------------------ *
 * RePKG 定位
 * ------------------------------------------------------------------ */

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 允许用户传入 exe 路径或 RePKG 所在目录 */
function normalizeExePath(input) {
  if (!input) return null;
  try {
    const st = fs.statSync(input);
    if (st.isDirectory()) {
      const exe = path.join(input, 'RePKG.exe');
      return isFile(exe) ? exe : null;
    }
    return st.isFile() ? input : null;
  } catch {
    return null;
  }
}

/**
 * 随应用分发的 RePKG.exe（vendor/RePKG/RePKG.exe）。
 * 开发时 src/ 与 vendor/ 同级；打包后是 resources/app/src 与 resources/app/vendor。
 * @returns {string|null}
 */
function bundledRePKG() {
  const exe = path.join(__dirname, '..', 'vendor', 'RePKG', 'RePKG.exe');
  return isFile(exe) ? exe : null;
}

/** 内置 RePKG.exe 的绝对路径（不存在时返回 null） */
function bundledRePKGPath() {
  return bundledRePKG();
}

/**
 * 读取 RePKG 版本号（`RePKG.exe --version` 输出形如 `RePKG 0.4.0+hash`）。
 * 失败时返回 null，调用方按“未知版本”显示即可。
 * @param {string} exePath
 * @returns {Promise<string|null>}
 */
function readVersion(exePath) {
  return new Promise((resolve) => {
    if (!exePath) {
      resolve(null);
      return;
    }
    let out = '';
    let child;
    try {
      child = spawn(exePath, ['--version'], { windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
      resolve(null);
    }, 4000);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      /*
       * 只认 "RePKG 0.4.0+hash" / "RePKG v0.4.0" 这种明确的版本行。
       * 帮助文本、错误信息、路径回显里出现的数字都不算，
       * 拿不到就返回 null，让界面显示「版本未知」而不是编一个。
       */
      const m = out.match(/\bRePKG\s+v?(\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.]+)?(?:\+[0-9A-Za-z.]+)?)/i);
      resolve(m ? m[1].split('+')[0] : null);
    });
  });
}

/**
 * 探测 RePKG.exe
 * @param {string} [explicitPath] 用户手动指定的路径（exe 或目录）
 * @returns {string|null}
 */
function detectRePKG(explicitPath) {
  const fromUser = normalizeExePath(explicitPath);
  if (fromUser) return fromUser;

  // 内置版本优先，这样无需用户本机另行安装 RePKG
  const bundled = bundledRePKG();
  if (bundled) return bundled;

  const env = process.env;
  const candidates = [];

  // 常见安装位置
  for (const drive of ['C:', 'D:', 'E:']) {
    candidates.push(`${drive}\\RePKG\\RePKG.exe`);
  }

  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA, env.APPDATA].filter(Boolean);
  for (const root of roots) {
    candidates.push(path.join(root, 'RePKG', 'RePKG.exe'));
    candidates.push(path.join(root, 'RePKG', 'RePKG', 'RePKG.exe'));
  }

  // PATH
  for (const dir of String(env.PATH || '').split(';')) {
    const d = dir.trim();
    if (d) candidates.push(path.join(d, 'RePKG.exe'));
  }

  const seen = new Set();
  for (const c of candidates) {
    let norm;
    try {
      norm = path.resolve(c).toLowerCase();
    } catch {
      continue;
    }
    if (seen.has(norm)) continue;
    seen.add(norm);
    if (isFile(c)) return c;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 执行 RePKG
 * ------------------------------------------------------------------ */

function runRePKG(exePath, args, onLine) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exePath, args, { windowsHide: true });
    } catch (err) {
      resolve({ ok: false, error: err.message, lines: [], files: 0 });
      return;
    }

    const lines = [];
    let files = 0;
    let buffer = '';
    let finished = false;

    const finish = (result) => {
      if (finished) return;
      finished = true;
      resolve(result);
    };

    const pump = (chunk) => {
      buffer += chunk.toString('utf8');
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() || '';
      for (const raw of parts) {
        const line = raw.replace(/\u0000/g, '').trim();
        if (!line) continue;
        if (line.includes('Extracting:')) files += 1;
        lines.push(line);
        if (lines.length > 500) lines.shift();
        if (onLine) onLine(line, files);
      }
    };

    child.stdout.on('data', pump);
    child.stderr.on('data', pump);

    child.on('error', (err) => {
      finish({ ok: false, error: err.message, lines, files });
    });

    child.on('close', (code) => {
      finish({ ok: code === 0, code, lines, files });
    });

    // 兜底：RePKG 理论上不会挂住，但避免 UI 永远转圈
    setTimeout(() => {
      if (!finished) {
        try { child.kill(); } catch { /* 忽略 */ }
        finish({ ok: false, error: '解包超时（5 分钟）', lines, files });
      }
    }, 5 * 60 * 1000).unref();
  });
}

/* ------------------------------------------------------------------ *
 * 缓存
 * ------------------------------------------------------------------ */

async function readMeta(dir) {
  try {
    return JSON.parse(await fsp.readFile(path.join(dir, META_NAME), 'utf8'));
  } catch {
    return null;
  }
}

/** 递归收集解包出的图片，按文件大小降序（主画面通常最大） */
async function collectImages(rootDir) {
  const out = [];

  async function walk(dir, rel) {
    let ents;
    try {
      ents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(full, relPath);
        continue;
      }
      if (!IMAGE_EXT.test(e.name) || NOISE_PATTERN.test(relPath)) continue;
      try {
        const st = await fsp.stat(full);
        out.push({ name: e.name, rel: relPath, path: full, size: st.size });
      } catch {
        /* 忽略单个读取失败的文件 */
      }
    }
  }

  await walk(rootDir, '');
  out.sort((a, b) => b.size - a.size);
  return out;
}

/**
 * 解包一个 PKG（带缓存）
 * @param {object} opts
 * @param {string} opts.repkgPath   RePKG.exe 路径
 * @param {string} opts.cacheRoot   缓存根目录
 * @param {string} opts.itemId      订阅 ID（用作缓存子目录名）
 * @param {string} opts.pkgPath     .pkg 文件路径
 * @param {boolean} [opts.force]    忽略缓存，强制重新解包
 * @param {(info:object)=>void} [opts.onProgress]
 */
async function extractPkg({ repkgPath, cacheRoot, itemId, pkgPath, force = false, onProgress }) {
  if (!repkgPath) return { ok: false, error: 'REPKG_NOT_FOUND' };

  // 只往「空目录 / 已标记的缓存目录」里写，避免污染用户自己选的文件夹
  const guard = await inspectCacheDir(cacheRoot);
  if (!guard.ok) {
    return { ok: false, error: '缓存目录不是空的，请到「设置 → 场景包」重新选择' };
  }
  await ensureCacheMarker(cacheRoot);

  let stat;
  try {
    stat = await fsp.stat(pkgPath);
  } catch (err) {
    return { ok: false, error: `无法读取 PKG：${err.message}` };
  }

  const itemDir = path.join(cacheRoot, itemId);

  // 命中缓存：PKG 的大小与修改时间都没变
  if (!force) {
    const meta = await readMeta(itemDir);
    if (
      meta &&
      meta.pkgSize === stat.size &&
      Math.abs((meta.pkgMtime || 0) - stat.mtimeMs) < 1000
    ) {
      const images = await collectImages(itemDir);

      // 记录最近使用时间，供自动清理按 LRU 淘汰
      meta.lastUsed = Date.now();
      try {
        await fsp.writeFile(path.join(itemDir, META_NAME), JSON.stringify(meta, null, 2), 'utf8');
      } catch {
        /* 写失败不影响使用 */
      }

      return {
        ok: true,
        cached: true,
        dir: itemDir,
        images,
        fileCount: meta.fileCount || 0,
        extractedAt: meta.extractedAt || 0,
      };
    }
  }

  // 重新解包前清掉旧产物
  try {
    await fsp.rm(itemDir, { recursive: true, force: true });
  } catch {
    /* 目录可能被占用，继续尝试 */
  }
  await fsp.mkdir(itemDir, { recursive: true });

  if (onProgress) onProgress({ phase: 'start' });

  const res = await runRePKG(
    repkgPath,
    ['extract', '-o', itemDir, '--overwrite', pkgPath],
    (line, files) => {
      if (onProgress && files) onProgress({ phase: 'extract', files });
    }
  );

  if (!res.ok) {
    return {
      ok: false,
      error: res.error || `RePKG 退出码 ${res.code}`,
      log: res.lines.slice(-12),
    };
  }

  const images = await collectImages(itemDir);

  const meta = {
    pkgName: path.basename(pkgPath),
    pkgSize: stat.size,
    pkgMtime: stat.mtimeMs,
    extractedAt: Date.now(),
    lastUsed: Date.now(),
    fileCount: res.files,
    imageCount: images.length,
    // 记下图片清单，重启后无需重新遍历目录即可还原预览
    images: images.map((img) => ({ name: img.name, rel: img.rel, size: img.size })),
  };
  try {
    await fsp.writeFile(path.join(itemDir, META_NAME), JSON.stringify(meta, null, 2), 'utf8');
  } catch {
    /* meta 写失败不影响使用 */
  }

  return {
    ok: true,
    cached: false,
    dir: itemDir,
    images,
    fileCount: res.files,
    extractedAt: meta.extractedAt,
  };
}

/* ------------------------------------------------------------------ *
 * 缓存目录识别
 * ------------------------------------------------------------------ */

/** 目录是否是本应用的解包缓存目录（认标记文件，而不是看目录名） */
async function isCacheDir(dir) {
  if (!dir) return false;
  try {
    const raw = await fsp.readFile(path.join(dir, CACHE_MARKER), 'utf8');
    const meta = JSON.parse(raw);
    return !!meta && meta.app === 'we-content-manager';
  } catch {
    return false;
  }
}

/** 给目录打上缓存标记（已存在则不重写） */
async function ensureCacheMarker(dir) {
  await fsp.mkdir(dir, { recursive: true });
  const marker = path.join(dir, CACHE_MARKER);
  if (fs.existsSync(marker)) return true;
  await fsp.writeFile(
    marker,
    JSON.stringify({ app: 'we-content-manager', schema: CACHE_SCHEMA, createdAt: Date.now() }, null, 2),
    'utf8'
  );
  return true;
}

/**
 * 判断一个目录能不能直接拿来当缓存目录：
 * - 不存在 / 空目录 → 可用（使用前打标记）
 * - 已带标记 → 可用（已有缓存）
 * - 非空且没有标记 → 拒绝，避免把用户自己的文件混进缓存，或被清理逻辑误删
 * @returns {Promise<{ok:boolean, kind:'empty'|'cache'|'occupied'}>}
 */
async function inspectCacheDir(dir) {
  if (await isCacheDir(dir)) return { ok: true, kind: 'cache' };
  let dirents;
  try {
    dirents = await fsp.readdir(dir);
  } catch {
    return { ok: true, kind: 'empty' }; // 目录不存在，稍后创建
  }
  if (!dirents.length) return { ok: true, kind: 'empty' };
  return { ok: false, kind: 'occupied' };
}

/* ------------------------------------------------------------------ *
 * 缓存统计与清理
 * ------------------------------------------------------------------ */

async function dirSize(dir) {
  let total = 0;
  let count = 0;
  async function walk(d) {
    let ents;
    try {
      ents = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else {
        try {
          total += (await fsp.stat(full)).size;
          count += 1;
        } catch {
          /* 忽略 */
        }
      }
    }
  }
  await walk(dir);
  return { bytes: total, files: count };
}

/**
 * 还原磁盘上已有的解包结果（应用重启后再次打开弹窗仍能看到预览）
 * @returns {Promise<Record<string, {dir:string, images:Array, fileCount:number, extractedAt:number}>>}
 */
async function restoreCache(cacheRoot) {
  const out = {};
  // 非缓存目录一律不读，避免把用户文件里的同名目录当缓存
  if (!(await isCacheDir(cacheRoot))) return out;

  let dirs;
  try {
    dirs = await fsp.readdir(cacheRoot, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const d of dirs) {
    if (!d.isDirectory() || !/^\d+$/.test(d.name)) continue;
    const itemDir = path.join(cacheRoot, d.name);
    const meta = await readMeta(itemDir);
    if (!meta || !Array.isArray(meta.images) || !meta.images.length) continue;

    out[d.name] = {
      dir: itemDir,
      fileCount: meta.fileCount || 0,
      extractedAt: meta.extractedAt || 0,
      images: meta.images.map((img) => ({
        name: img.name,
        rel: img.rel,
        size: img.size,
        path: path.join(itemDir, img.rel),
      })),
    };
  }
  return out;
}

/** 缓存总占用：只统计订阅 ID 目录，标记文件等不计入 */
async function cacheInfo(cacheRoot) {
  if (!fs.existsSync(cacheRoot)) return { bytes: 0, files: 0, items: 0 };
  if (!(await isCacheDir(cacheRoot))) return { bytes: 0, files: 0, items: 0 };

  let dirents;
  try {
    dirents = await fsp.readdir(cacheRoot, { withFileTypes: true });
  } catch {
    return { bytes: 0, files: 0, items: 0 };
  }

  let bytes = 0;
  let files = 0;
  let items = 0;
  for (const d of dirents) {
    if (!d.isDirectory() || !/^\d+$/.test(d.name)) continue;
    const info = await dirSize(path.join(cacheRoot, d.name));
    bytes += info.bytes;
    files += info.files;
    items += 1;
  }
  return { bytes, files, items };
}

/**
 * 按容量上限自动清理：LRU 淘汰，优先删最久未使用的条目
 * @param {string} cacheRoot
 * @param {number} limitBytes 0 或负数表示不限制
 * @param {string} [keepItemId] 要保住的项目 ID（通常是刚解包的那个）
 * @returns {Promise<{removed: Array<{id:string,bytes:number}>, freed:number, bytes:number}>}
 */
async function enforceCacheLimit(cacheRoot, limitBytes, keepItemId) {
  const empty = { removed: [], freed: 0, bytes: 0 };
  if (!limitBytes || limitBytes <= 0) return empty;
  if (!fs.existsSync(cacheRoot)) return empty;
  // 没有缓存标记的目录绝不自动清理
  if (!(await isCacheDir(cacheRoot))) return empty;

  let dirents;
  try {
    dirents = await fsp.readdir(cacheRoot, { withFileTypes: true });
  } catch {
    return empty;
  }

  const entries = [];
  let total = 0;

  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const dir = path.join(cacheRoot, d.name);
    const { bytes } = await dirSize(dir);
    total += bytes;
    if (!/^\d+$/.test(d.name)) continue; // 只淘汰标准缓存目录
    const meta = await readMeta(dir);
    entries.push({
      id: d.name,
      dir,
      bytes,
      usedAt: (meta && (meta.lastUsed || meta.extractedAt)) || 0,
    });
  }

  if (total <= limitBytes) return { removed: [], freed: 0, bytes: total };

  entries.sort((a, b) => a.usedAt - b.usedAt);

  // 多删一点留余量，避免每次解包都触发一轮清理
  const target = Math.max(0, Math.floor(limitBytes * 0.9));
  const removed = [];
  let freed = 0;

  for (const e of entries) {
    if (total <= target) break;
    if (keepItemId && e.id === String(keepItemId)) continue;
    try {
      await fsp.rm(e.dir, { recursive: true, force: true });
      total -= e.bytes;
      freed += e.bytes;
      removed.push({ id: e.id, bytes: e.bytes });
    } catch {
      /* 单个目录删不掉就跳过，不影响其余 */
    }
  }

  return { removed, freed, bytes: Math.max(0, total) };
}

/**
 * 清理缓存；不传 itemId 时清空全部解包结果。
 * 只处理带缓存标记的目录，并保留标记文件本身，
 * 这样即使误把缓存目录指到别处，也不会把用户的文件删掉。
 */
async function clearCache(cacheRoot, itemId) {
  if (!(await isCacheDir(cacheRoot))) {
    return { ok: false, error: 'NOT_CACHE_DIR' };
  }

  if (itemId) {
    try {
      await fsp.rm(path.join(cacheRoot, String(itemId)), { recursive: true, force: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  let dirents;
  try {
    dirents = await fsp.readdir(cacheRoot, { withFileTypes: true });
  } catch (err) {
    return { ok: false, error: err.message };
  }

  for (const d of dirents) {
    if (d.name === CACHE_MARKER) continue;
    try {
      await fsp.rm(path.join(cacheRoot, d.name), { recursive: true, force: true });
    } catch {
      /* 单个删不掉就跳过 */
    }
  }
  return { ok: true };
}

module.exports = {
  detectRePKG,
  bundledRePKGPath,
  readVersion,
  isCacheDir,
  ensureCacheMarker,
  inspectCacheDir,
  CACHE_MARKER,
  normalizeExePath,
  extractPkg,
  collectImages,
  restoreCache,
  cacheInfo,
  enforceCacheLimit,
  clearCache,
  META_NAME,
};
