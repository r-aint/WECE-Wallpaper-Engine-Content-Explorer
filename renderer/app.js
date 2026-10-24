'use strict';

/* =================================================================
 * Wallpaper Engine 内容管理器 — 渲染进程
 * 纯原生 JS，无构建步骤。修改后按 Ctrl+R 即可看到效果。
 * ================================================================= */

const KINDS = {
  video: { label: '视频', hint: '内置播放 / 默认播放器' },
  image: { label: '图片', hint: '内置查看 / 默认查看器' },
  web: { label: '网页', hint: 'HTML 交互壁纸' },
  scene: { label: '场景包', hint: '需由 Wallpaper Engine 渲染 (.pkg)' },
  application: { label: '程序', hint: '可执行内容' },
  other: { label: '其他', hint: '未知类型' },
};

/** 单击卡片时是否可以直接在管理器内打开 */
const INLINE_OPENABLE = new Set(['video', 'image']);

/** 主题色预设 */
const THEMES = [
  { id: 'blue', label: '经典蓝', accent: '#5b8cff', accent2: '#7c5cff' },
  { id: 'cyan', label: '青蓝', accent: '#22d3ee', accent2: '#3b82f6' },
  { id: 'green', label: '森绿', accent: '#34d399', accent2: '#059669' },
  { id: 'amber', label: '琥珀', accent: '#fbbf24', accent2: '#f97316' },
  { id: 'pink', label: '品红', accent: '#f472b6', accent2: '#a855f7' },
  { id: 'rose', label: '绯红', accent: '#fb7185', accent2: '#e11d48' },
];

/** 间距密度档位 */
const DENSITIES = {
  compact: { gap: 10, label: '紧凑' },
  normal: { gap: 16, label: '标准' },
  comfy: { gap: 24, label: '宽松' },
};

/** 外观默认值（与主进程 DEFAULTS.appearance 保持一致） */
const APPEARANCE_DEFAULT = {
  cardMin: 238,
  density: 'normal',
  accent: 'blue',
  showTags: true,
  showSize: true,
};

/** NSFW 默认值（与主进程 DEFAULTS.nsfw 保持一致） */
const NSFW_DEFAULT = {
  hide: false, // 默认不隐藏，避免首次使用就看不到内容
  blur: true,  // 默认模糊封面
};

/** project.json 的 contentrating 取值 */
const NSFW_RATING = /(mature|nsfw|adult|18\+|r18|questionable|explicit)/i;
/** 创作者常用的成人内容标签 */
const NSFW_TAGS = /^(mature|nsfw|adult|nude|nudity|sexual|sexual content|hentai|r18|18\+|ecchi|explicit)$/i;

/**
 * 判定条目是否属于 NSFW。
 * 只看 project.json 的 contentrating 与 tags，不改动原始数据；
 * 解析失败（parseOk=false）时这两项为空，会按“非 NSFW”处理。
 */
function isNsfw(item) {
  if (!item) return false;
  if (NSFW_RATING.test(String(item.contentRating || ''))) return true;
  return (item.tags || []).some((t) => NSFW_TAGS.test(String(t).trim()));
}

const state = {
  items: [],
  list: [],
  filter: 'all',
  search: '',
  sortBy: 'title-asc',
  viewMode: 'grid',
  rootDirs: [],
  dirStats: [],
  activeDir: 'all',
  env: {},
  activeItem: null,
  mediaIndex: 0,
  // 外观
  appearance: { ...APPEARANCE_DEFAULT },
  // NSFW 内容处理
  nsfw: { ...NSFW_DEFAULT },
  // 多选
  selecting: false,
  selected: new Set(),
  anchorIndex: -1,
  // 键盘导航
  focusIndex: -1,
  // 场景包解包
  repkg: { available: false, path: null },
  pkgExtracted: new Map(), // itemId -> { images, dir, fileCount, extractedAt }
  pkgExtracting: new Set(),
  pkgProgress: new Map(), // itemId -> 已提取文件数
  pkgCache: { bytes: 0, items: 0, files: 0 },
  pkgCacheLimitMB: 2048,
  // 解包缓存目录（可在设置里改到其它磁盘）
  pkgCacheDir: '',
  pkgCacheIsDefault: true,
};

const $ = (sel) => document.querySelector(sel);

const el = {
  rootPath: $('#rootPath'),
  rootPathText: $('#rootPathText'),
  dirPanel: $('#dirPanel'),
  dirList: $('#dirList'),
  dirAdd: $('#dirAdd'),
  dirClose: $('#dirClose'),
  search: $('#search'),
  searchClear: $('#searchClear'),
  filters: $('#filters'),
  grid: $('#grid'),
  empty: $('#empty'),
  emptyTitle: $('#emptyTitle'),
  emptyDesc: $('#emptyDesc'),
  emptyAction: $('#emptyAction'),
  statusText: $('#statusText'),
  sortBy: $('#sortBy'),
  viewToggle: $('#viewToggle'),
  btnRescan: $('#btnRescan'),
  btnDetect: $('#btnDetect'),
  btnPickRoot: $('#btnPickRoot'),
  progress: $('#progress'),
  progressBar: $('#progressBar'),
  modal: $('#modal'),
  modalMedia: $('#modalMedia'),
  mediaStage: $('#mediaStage'),
  itemPrev: $('#itemPrev'),
  itemNext: $('#itemNext'),
  mediaPrev: $('#mediaPrev'),
  mediaNext: $('#mediaNext'),
  modalIndex: $('#modalIndex'),
  modalTitle: $('#modalTitle'),
  modalKind: $('#modalKind'),
  modalSize: $('#modalSize'),
  modalTags: $('#modalTags'),
  modalActions: $('#modalActions'),
  modalPath: $('#modalPath'),
  modalFiles: $('#modalFiles'),
  modalFileCount: $('#modalFileCount'),
  modalFilesSection: $('#modalFilesSection'),
  modalDesc: $('#modalDesc'),
  modalDescSection: $('#modalDescSection'),
  toast: $('#toast'),
  btnAppearance: $('#btnAppearance'),
  settings: $('#settings'),
  settingsClose: $('#settingsClose'),
  settingsReset: $('#settingsReset'),
  setWidth: $('#setWidth'),
  setWidthValue: $('#setWidthValue'),
  setDensity: $('#setDensity'),
  setAccent: $('#setAccent'),
  setShowTags: $('#setShowTags'),
  setShowSize: $('#setShowSize'),
  setNsfwHide: $('#setNsfwHide'),
  setNsfwBlur: $('#setNsfwBlur'),
  nsfwCount: $('#nsfwCount'),
  nsfwHideNow: $('#nsfwHideNow'),
  settingsTabs: $('#settingsTabs'),
  btnSelect: $('#btnSelect'),
  bulkbar: $('#bulkbar'),
  bulkCount: $('#bulkCount'),
  pkgStatusBox: $('#pkgStatusBox'),
  repkgTitle: $('#repkgTitle'),
  repkgSub: $('#repkgSub'),
  repkgState: $('#repkgState'),
  pkgPickBtn: $('#pkgPickBtn'),
  pkgResetRepkg: $('#pkgResetRepkg'),
  pkgClearBtn: $('#pkgClearBtn'),
  pkgLimit: $('#pkgLimit'),
  pkgCachePath: $('#pkgCachePath'),
  pkgCacheSize: $('#pkgCacheSize'),
  pkgOpenDir: $('#pkgOpenDir'),
  pkgChangeDir: $('#pkgChangeDir'),
  pkgResetDir: $('#pkgResetDir'),
};

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function formatBytes(bytes) {
  if (!bytes || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function formatDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function kindInfo(kind) {
  return KINDS[kind] || KINDS.other;
}

let toastTimer = null;
function toast(message, ms = 2200) {
  el.toast.textContent = message;
  el.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), ms);
}

function setStatus(text) {
  el.statusText.textContent = text;
}

function showProgress(done, total) {
  if (!total) return;
  el.progress.classList.remove('hidden');
  el.progressBar.style.width = `${Math.round((done / total) * 100)}%`;
}

function hideProgress() {
  el.progressBar.style.width = '0%';
  el.progress.classList.add('hidden');
}

function svgIcon(pathData, cls = 'ico') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls);
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', pathData);
  svg.appendChild(p);
  return svg;
}

const ICONS = {
  play: 'M8 5v14l11-7z',
  folder: 'M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z',
  external: 'M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7zM5 5h5V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5h-2v5H5V5z',
  info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z',
  image: 'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 2v8.6l3.6-3.6 3.2 3.2 2.6-2.6L19 16V6H5zm3 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z',
  monitor: 'M21 3H3a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h7v2H7v2h10v-2h-3v-2h7a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 13H3V5h18v11z',
  browser: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.93 6h-2.95a15.6 15.6 0 0 0-1.32-3.36A8.03 8.03 0 0 1 18.93 8zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14A7.8 7.8 0 0 1 4 12c0-.7.1-1.37.26-2h3.38a17 17 0 0 0 0 4H4.26zm.82 2h2.95c.34 1.2.79 2.33 1.32 3.36A8.03 8.03 0 0 1 5.08 16zm2.95-8H5.08a8.03 8.03 0 0 1 4.27-3.36A15.6 15.6 0 0 0 8.03 8zM12 19.96A13.8 13.8 0 0 1 10.09 16h3.82A13.8 13.8 0 0 1 12 19.96zM14.34 14H9.66a15 15 0 0 1 0-4h4.68a15 15 0 0 1 0 4zm.31 5.36c.53-1.03.98-2.16 1.32-3.36h2.95a8.03 8.03 0 0 1-4.27 3.36zM16.36 14a17 17 0 0 0 0-4h3.38c.16.63.26 1.3.26 2s-.1 1.37-.26 2h-3.38z',
  copy: 'M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z',
  check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
  box: 'M12 2 3 6.5v11L12 22l9-4.5v-11L12 2zm0 2.2 6.5 3.25L12 10.7 5.5 7.45 12 4.2zM5 8.9l6 3v8.1l-6-3V8.9zm8 11.1v-8.1l6-3v8.1l-6 3z',
};

/* ------------------------------------------------------------------ *
 * 外观（缩略图大小 / 密度 / 主题色）
 * ------------------------------------------------------------------ */

function themeById(id) {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}

function applyAppearance() {
  const a = state.appearance;
  const root = document.documentElement;
  const theme = themeById(a.accent);
  const density = DENSITIES[a.density] || DENSITIES.normal;
  root.style.setProperty('--card-min', `${a.cardMin}px`);
  root.style.setProperty('--grid-gap', `${density.gap}px`);
  root.style.setProperty('--accent', theme.accent);
  root.style.setProperty('--accent-2', theme.accent2);
}

function saveAppearance(patch) {
  const needRerender = 'showTags' in patch || 'showSize' in patch;
  state.appearance = { ...state.appearance, ...patch };
  applyAppearance();
  we.save({ appearance: state.appearance });
  if (needRerender) render();
}

function renderSettingsPanel() {
  const a = state.appearance;

  el.setWidth.value = String(a.cardMin);
  el.setWidthValue.textContent = `${a.cardMin} px`;

  el.setDensity.textContent = '';
  for (const [key, cfg] of Object.entries(DENSITIES)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.density = key;
    b.textContent = cfg.label;
    b.classList.toggle('active', a.density === key);
    el.setDensity.appendChild(b);
  }

  el.setAccent.textContent = '';
  for (const t of THEMES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `swatch-btn${a.accent === t.id ? ' active' : ''}`;
    b.title = t.label;
    b.style.background = `linear-gradient(135deg, ${t.accent}, ${t.accent2})`;
    b.addEventListener('click', () => {
      saveAppearance({ accent: t.id });
      renderSettingsPanel();
    });
    el.setAccent.appendChild(b);
  }

  el.setShowTags.checked = a.showTags !== false;
  el.setShowSize.checked = a.showSize !== false;

  // NSFW 选项与识别情况
  el.setNsfwHide.checked = state.nsfw.hide === true;
  el.setNsfwBlur.checked = state.nsfw.blur !== false;
  if (el.nsfwCount) {
    const total = state.items.length;
    const n = state.items.filter(isNsfw).length;
    el.nsfwCount.textContent = total ? `识别 ${n} / ${total} 项` : '';
  }
}

/** 保存 NSFW 选项；隐藏状态变化时同步刷新列表与计数 */
function saveNsfw(patch) {
  const hideChanged = 'hide' in patch && patch.hide !== state.nsfw.hide;
  state.nsfw = { ...state.nsfw, ...patch };
  we.save({ nsfw: state.nsfw });

  if (hideChanged) {
    // 详情弹窗里的条目可能刚好被隐藏，直接收起，避免停留在已不可见的内容上
    if (state.activeItem) closeModal();
    // 已选中的 NSFW 条目也从选择集里移除，避免批量操作误伤被隐藏的内容
    if (state.nsfw.hide) {
      for (const it of state.items) {
        if (isNsfw(it)) state.selected.delete(it.id);
      }
    }
    renderFilters();
  }
  render();
  renderSettingsPanel();
}

/** 设置面板当前分组（appearance / nsfw / pkg），仅在本次运行内记忆 */
let settingsPane = 'appearance';

function setSettingsPane(name) {
  settingsPane = name;
  for (const b of el.settingsTabs.querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.pane === name);
  }
  for (const p of el.settings.querySelectorAll('.settings-pane')) {
    p.classList.toggle('hidden', p.dataset.pane !== name);
  }
}

function openSettings() {
  renderSettingsPanel();
  renderPkgSettings();
  setSettingsPane(settingsPane);
  el.settings.classList.remove('hidden');
  el.btnAppearance.classList.add('active');

  // 缓存占用可能被外部变化，打开面板时刷新一次
  we.pkgCacheInfo().then((c) => {
    state.pkgCache = c;
    renderPkgSettings();
  }).catch(() => { /* 忽略 */ });
}

function closeSettings() {
  el.settings.classList.add('hidden');
  el.btnAppearance.classList.remove('active');
}

function toggleSettings() {
  if (el.settings.classList.contains('hidden')) openSettings();
  else closeSettings();
}

/* ------------------------------------------------------------------ *
 * 多选
 * ------------------------------------------------------------------ */

function setSelecting(on) {
  state.selecting = on;
  document.body.classList.toggle('selecting', on);
  el.btnSelect.classList.toggle('active', on);
  if (!on) state.selected.clear();
  updateBulkbar();
  syncSelectionClasses();
}

function toggleSelect(item, on) {
  if (on) state.selected.add(item.id);
  else state.selected.delete(item.id);
  updateBulkbar();
  syncSelectionClasses();
}

function selectedItems() {
  return state.items.filter((it) => state.selected.has(it.id));
}

function syncSelectionClasses() {
  for (const card of el.grid.querySelectorAll('.card')) {
    card.classList.toggle('selected', state.selected.has(card.dataset.id));
  }
}

function updateBulkbar() {
  const n = state.selected.size;
  const show = state.selecting || n > 0;
  el.bulkbar.classList.toggle('hidden', !show);
  if (show) el.bulkCount.textContent = `已选择 ${n} 项`;
}

/* ------------------------------------------------------------------ *
 * 数据筛选与排序
 * ------------------------------------------------------------------ */

/** 当前来源范围内的全部条目（合并显示时为全部），不含 NSFW 过滤 */
function scopedItemsRaw() {
  if (state.activeDir === 'all') return state.items;
  return state.items.filter((it) => it.rootDir === state.activeDir);
}

/**
 * 当前来源范围内可见的条目。
 * 「隐藏 NSFW」在这里统一过滤，列表、类型计数、详情翻页都基于同一份结果。
 */
function scopedItems() {
  const base = scopedItemsRaw();
  return state.nsfw.hide ? base.filter((it) => !isNsfw(it)) : base;
}

function computeList() {
  const q = state.search.trim().toLowerCase();
  let list = scopedItems();

  if (state.filter !== 'all') {
    list = list.filter((it) => it.kind === state.filter);
  }

  if (q) {
    list = list.filter((it) =>
      it.title.toLowerCase().includes(q) ||
      it.id.includes(q) ||
      (it.tags || []).some((t) => t.toLowerCase().includes(q)) ||
      (it.description || '').toLowerCase().includes(q)
    );
  }

  const sorted = list.slice();
  switch (state.sortBy) {
    case 'title-asc':
      sorted.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
      break;
    case 'title-desc':
      sorted.sort((a, b) => b.title.localeCompare(a.title, 'zh-Hans-CN'));
      break;
    case 'mtime-desc':
      sorted.sort((a, b) => b.mtime - a.mtime);
      break;
    case 'mtime-asc':
      sorted.sort((a, b) => a.mtime - b.mtime);
      break;
    case 'size-desc':
      sorted.sort((a, b) => b.totalSize - a.totalSize);
      break;
    case 'size-asc':
      sorted.sort((a, b) => a.totalSize - b.totalSize);
      break;
    case 'kind':
      sorted.sort((a, b) => a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title, 'zh-Hans-CN'));
      break;
  }
  state.list = sorted;
  return sorted;
}

function countByKind(items = scopedItems()) {
  const counts = { all: items.length };
  for (const it of items) counts[it.kind] = (counts[it.kind] || 0) + 1;
  return counts;
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

function renderFilters() {
  const counts = countByKind();
  el.filters.textContent = '';

  const makeChip = (key, label, count, color) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `chip${state.filter === key ? ' active' : ''}`;
    chip.dataset.filter = key;

    if (color) {
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = color;
      chip.appendChild(sw);
    }

    const text = document.createElement('span');
    text.textContent = label;
    chip.appendChild(text);

    const c = document.createElement('span');
    c.className = 'count';
    c.textContent = String(count);
    chip.appendChild(c);

    el.filters.appendChild(chip);
  };

  makeChip('all', '全部', counts.all, null);
  for (const key of Object.keys(KINDS)) {
    const n = counts[key] || 0;
    if (!n) continue;
    makeChip(key, KINDS[key].label, n, `var(--${key})`);
  }
}

function buildCard(item) {
  const card = document.createElement('article');
  card.className = 'card';
  card.tabIndex = 0;
  card.dataset.id = item.id;
  card.title = `${item.title}\n${kindInfo(item.kind).hint}`;
  if (state.selected.has(item.id)) card.classList.add('selected');
  // 封面模糊只对 NSFW 条目生效，标题与标签保持清晰
  if (state.nsfw.blur && isNsfw(item)) card.classList.add('nsfw-blur');

  // 缩略图
  const thumb = document.createElement('div');
  thumb.className = 'thumb';

  if (item.preview && item.preview.url) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = item.title;
    img.src = item.preview.url;
    img.addEventListener('load', () => img.classList.add('loaded'));
    img.addEventListener('error', () => img.remove());
    thumb.appendChild(img);
  } else {
    const ph = document.createElement('div');
    ph.className = 'no-preview';
    ph.appendChild(svgIcon(ICONS.image, ''));
    thumb.appendChild(ph);
  }

  const badge = document.createElement('span');
  badge.className = `badge k-${item.kind}`;
  badge.textContent = kindInfo(item.kind).label;
  thumb.appendChild(badge);

  if (item.preview && item.preview.animated) {
    const flag = document.createElement('span');
    flag.className = 'gif-flag';
    flag.textContent = 'GIF';
    thumb.appendChild(flag);
  }

  // 悬停操作
  const hover = document.createElement('div');
  hover.className = 'card-hover';
  const mkBtn = (icon, label, handler) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'iconbtn';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.appendChild(svgIcon(icon));
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      handler();
    });
    return b;
  };

  const primary = primaryAction(item);
  if (primary) {
    hover.appendChild(mkBtn(primary.icon, primary.label, primary.run));
  }
  hover.appendChild(mkBtn(ICONS.folder, '打开资源管理器', () =>
    we.openFolder(item.dir).then((r) => !r.ok && toast(r.error || '打开失败'))));
  hover.appendChild(mkBtn(ICONS.info, '查看详情', () => openDetail(item)));
  thumb.appendChild(hover);

  // 多选勾选框（仅在多选模式下可见）
  const check = document.createElement('div');
  check.className = 'card-check';
  check.appendChild(svgIcon(ICONS.check, ''));
  thumb.appendChild(check);

  // 文本
  const body = document.createElement('div');
  body.className = 'card-body';

  const title = document.createElement('h3');
  title.className = 'card-title';
  title.textContent = item.title;
  body.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'card-meta';

  if (state.appearance.showTags !== false) {
    const tags = document.createElement('div');
    tags.className = 'tags';
    const tagList = (item.tags || []).slice(0, 2);
    if (tagList.length) {
      for (const t of tagList) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = t;
        tags.appendChild(tag);
      }
    } else {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = `#${item.id}`;
      tags.appendChild(tag);
    }
    meta.appendChild(tags);
  } else {
    const spacer = document.createElement('div');
    spacer.className = 'tags';
    meta.appendChild(spacer);
  }

  if (state.appearance.showSize !== false) {
    const size = document.createElement('span');
    size.textContent = formatBytes(item.totalSize);
    meta.appendChild(size);
  }

  body.appendChild(meta);

  card.appendChild(thumb);
  card.appendChild(body);

  card.addEventListener('click', (ev) => handleCardClick(item, ev));
  card.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    openCardMenu(item);
  });
  card.addEventListener('keydown', (ev) => {
    // 空格统一交给 document 层处理（避免与全局快捷键重复触发）
    if (ev.key === 'Enter') {
      ev.preventDefault();
      handleCardClick(item, ev);
    }
  });
  // 用 Tab 键把焦点移到卡片上时，同步键盘导航的当前位置
  card.addEventListener('focus', () => {
    const idx = state.list.findIndex((x) => x.id === item.id);
    if (idx >= 0 && idx !== state.focusIndex) setFocusIndex(idx);
  });

  return card;
}

function render() {
  const list = computeList();
  el.grid.classList.toggle('list', state.viewMode === 'list');
  el.grid.textContent = '';

  // 清理已不在当前数据里的选中项
  if (state.selected.size) {
    const alive = new Set(state.items.map((it) => it.id));
    for (const id of [...state.selected]) {
      if (!alive.has(id)) state.selected.delete(id);
    }
  }

  if (!list.length) {
    el.empty.classList.remove('hidden');
    const scope = scopedItems();
    const raw = scopedItemsRaw();
    if (!raw.length) {
      el.emptyTitle.textContent = state.rootDirs.length ? '没有找到订阅内容' : '还没有设置订阅目录';
      el.emptyDesc.textContent = state.rootDirs.length
        ? `已扫描 ${state.rootDirs.length} 个目录，但没有包含 project.json 的子文件夹。请确认选的是 .../steamapps/workshop/content/431960。`
        : '点击下方按钮选择 Wallpaper Engine 的订阅目录（通常位于 Steam 库的 steamapps/workshop/content/431960）。';
      el.emptyAction.classList.remove('hidden');
    } else if (!scope.length) {
      // 全部条目都被 NSFW 过滤掉时给出明确提示，避免误以为扫描失败
      el.emptyTitle.textContent = '内容已按设置隐藏';
      el.emptyDesc.textContent = `当前开启了「隐藏 NSFW 内容」，这 ${raw.length} 项都被判定为 NSFW。可在「设置 → NSFW 内容」里关闭该选项。`;
      el.emptyAction.classList.add('hidden');
    } else {
      el.emptyTitle.textContent = '没有符合条件的内容';
      el.emptyDesc.textContent = '试试调整筛选条件或清空搜索关键词。';
      el.emptyAction.classList.add('hidden');
    }
    setStatus(`共 ${scope.length} 项 · 当前显示 0 项`);
    return;
  }

  el.empty.classList.add('hidden');

  const frag = document.createDocumentFragment();
  for (const item of list) frag.appendChild(buildCard(item));
  el.grid.appendChild(frag);

  state.focusIndex = -1;
  updateBulkbar();

  const counts = countByKind();
  const parts = Object.keys(KINDS)
    .filter((k) => counts[k])
    .map((k) => `${KINDS[k].label} ${counts[k]}`);
  // 「隐藏 NSFW」生效时，明确告诉用户被过滤掉多少项
  const hiddenNsfw = scopedItemsRaw().length - counts.all;
  const nsfwNote = hiddenNsfw > 0 ? ` · 已隐藏 ${hiddenNsfw} 项 NSFW` : '';
  setStatus(`共 ${counts.all} 项（${parts.join(' · ')}） · 当前显示 ${list.length} 项${nsfwNote}`);
}

/* ------------------------------------------------------------------ *
 * 打开行为
 * ------------------------------------------------------------------ */

/** 卡片主操作（悬停第一个按钮） */
function primaryAction(item) {
  if (item.kind === 'video' && item.videos.length) {
    return {
      icon: ICONS.play,
      label: '用默认播放器播放',
      run: () => openExternal(item.videos[0].path, '已用默认播放器打开'),
    };
  }
  if (item.kind === 'image' && item.images.length) {
    return {
      icon: ICONS.image,
      label: '查看图片',
      run: () => openPreview(item),
    };
  }
  if (item.kind === 'web' && item.htmls.length) {
    return {
      icon: ICONS.browser,
      label: '在浏览器中打开',
      run: () => openExternal(item.htmls[0].path, '已在浏览器中打开'),
    };
  }
  // 程序 / 其他类型里也常能看到画面（子目录中的媒体），有就优先预览
  if ((item.kind === 'other' || item.kind === 'application') && item.videos.length) {
    return {
      icon: ICONS.play,
      label: '用默认播放器播放',
      run: () => openExternal(item.videos[0].path, '已用默认播放器打开'),
    };
  }
  if ((item.kind === 'other' || item.kind === 'application') && item.images.length) {
    return {
      icon: ICONS.image,
      label: '查看图片',
      run: () => openPreview(item),
    };
  }
  // 其余类型的主操作就是“打开资源管理器”，由卡片上固定的按钮承担
  return null;
}

async function openExternal(targetPath, successMsg) {
  const res = await we.openExternal(targetPath);
  if (res.ok) {
    if (successMsg) toast(successMsg);
  } else {
    toast(res.error || '打开失败');
  }
}

/** 单击卡片（ev 可能来自键盘事件，属性缺失时按普通点击处理） */
function handleCardClick(item, ev) {
  const index = state.list.findIndex((x) => x.id === item.id);

  // Ctrl / Cmd + 点击：切换该项并进入多选模式
  if (ev && (ev.ctrlKey || ev.metaKey)) {
    if (!state.selecting) setSelecting(true);
    toggleSelect(item, !state.selected.has(item.id));
    state.anchorIndex = index;
    return;
  }

  // Shift + 点击：从锚点到当前项做范围选择
  if (ev && ev.shiftKey && index >= 0) {
    if (!state.selecting) setSelecting(true);
    const anchor = state.anchorIndex >= 0 ? state.anchorIndex : index;
    const from = Math.min(anchor, index);
    const to = Math.max(anchor, index);
    for (let i = from; i <= to; i += 1) state.selected.add(state.list[i].id);
    updateBulkbar();
    syncSelectionClasses();
    return;
  }

  // 多选模式下普通点击 = 勾选 / 取消勾选
  if (state.selecting) {
    toggleSelect(item, !state.selected.has(item.id));
    state.anchorIndex = index;
    return;
  }

  if (INLINE_OPENABLE.has(item.kind)) {
    openPreview(item);
    return;
  }

  // 场景包可以在详情里解包预览画面，单击直接进详情
  if (item.kind === 'scene') {
    openDetail(item);
    return;
  }

  // 程序 / 未知类型：目录里（含子目录）找到了媒体就进详情预览
  if (item.kind === 'application' || item.kind === 'other') {
    if (item.videos.length || item.images.length) {
      openDetail(item);
      return;
    }
    we.openFolder(item.dir).then((r) => {
      if (!r.ok) toast(r.error || '打开失败');
      else toast(`${kindInfo(item.kind).label}无法在管理器内预览，已打开资源管理器`, 2600);
    });
    return;
  }

  openDetail(item);
}

/** 该项目可交给系统默认程序打开的主文件 */
function mainOpenPath(item) {
  if (item.kind === 'video' && item.videos.length) return item.videos[0].path;
  if (item.kind === 'image' && item.images.length) return item.images[0].path;
  if (item.kind === 'web' && item.htmls.length) return item.htmls[0].path;
  return null;
}

/** 右键卡片 → 系统原生菜单（菜单由主进程弹出） */
async function openCardMenu(item) {
  const wid = String(item.workshopId || item.id || '');
  let res = null;
  try {
    res = await we.showCardMenu({
      title: item.title,
      dir: item.dir,
      kind: item.kind,
      primaryPath: mainOpenPath(item),
      canInlineOpen: INLINE_OPENABLE.has(item.kind) && mediaSources(item).length > 0,
      canExtract: item.kind === 'scene' && (item.pkgs || []).length > 0,
      workshopId: /^\d+$/.test(wid) && wid !== '0' ? wid : null,
    });
  } catch (err) {
    toast(`菜单打开失败：${err.message}`);
    return;
  }
  if (!res) return;
  if (res.action === 'open') {
    handleCardClick(item);
  } else if (res.action === 'extract') {
    openDetail(item);
    extractItemPkg(item);
  }
}

/* ------------------------------------------------------------------ *
 * 场景包（.pkg）解包
 * ------------------------------------------------------------------ */

/** 让用户指定 RePKG.exe 的位置 */
async function pickRePkg() {
  const res = await we.pkgPickRepkg();
  if (res.canceled) return false;
  if (!res.ok) {
    toast(res.error || '选择失败');
    return false;
  }
  state.repkg = {
    available: true, path: res.repkgPath, version: null, bundled: false,
  };
  toast('已切换 RePKG');
  // 版本与「是否内置」由主进程重新读取，界面稍后刷新即可
  we.pkgStatus().then((s) => {
    state.repkg = {
      available: s.available, path: s.repkgPath, version: s.version, bundled: s.bundled,
    };
    renderPkgSettings();
  }).catch(() => { /* 忽略 */ });
  renderPkgSettings();
  if (state.activeItem) renderActions(state.activeItem);
  return true;
}

/** 缓存目录切换后：刷新占用、重建解包映射 */
async function applyCacheDirChange(res) {
  state.pkgCache = res.cache || state.pkgCache;
  state.pkgCacheDir = res.cacheDir || state.pkgCacheDir;
  state.pkgCacheIsDefault = res.isDefault !== false;

  state.pkgExtracted.clear();
  try {
    const restored = await we.pkgRestore();
    for (const [id, entry] of Object.entries(restored || {})) {
      state.pkgExtracted.set(id, entry);
    }
  } catch {
    /* 忽略 */
  }

  renderPkgSettings();
  if (state.activeItem) renderMedia(state.activeItem);

  if (res.migrated) toast(`已迁移 ${res.migrated} 个缓存项目`);
  else if (res.oldWasCache === false) toast('已切换目录；原目录不是缓存目录，没有迁移任何文件', 3000);
  else toast('缓存目录已更新');
}

/** 解包场景包，并把解出来的画面并入弹窗预览 */
async function extractItemPkg(item, force = false) {
  const pkgFile = (item.pkgs || [])[0];
  if (!pkgFile) {
    toast('这个项目里没有 .pkg 文件');
    return;
  }

  if (!state.repkg.available) {
    const ok = await pickRePkg();
    if (!ok) return;
  }

  state.pkgExtracting.add(item.id);
  state.pkgProgress.set(item.id, 0);
  if (state.activeItem) renderActions(state.activeItem);

  let res;
  try {
    res = await we.pkgExtract({ itemId: item.id, pkgPath: pkgFile.path, force });
  } catch (err) {
    res = { ok: false, error: err.message };
  }

  state.pkgExtracting.delete(item.id);
  state.pkgProgress.delete(item.id);

  if (res.ok) {
    state.pkgExtracted.set(item.id, {
      images: res.images || [],
      dir: res.dir,
      fileCount: res.fileCount || 0,
      extractedAt: res.extractedAt || Date.now(),
    });
    if (state.activeItem && state.activeItem.id === item.id) {
      state.mediaIndex = 0;
      renderMedia(item);
    }
    // 自动清理可能删掉了别的条目，同步剔除内存里的预览数据
    if (res.autoCleanup && res.autoCleanup.ids) {
      for (const id of res.autoCleanup.ids) state.pkgExtracted.delete(id);
    }

    const n = (res.images || []).length;
    let msg = res.cached
      ? `已从缓存加载（${n} 张图片）`
      : `解包完成：${res.fileCount || 0} 个文件，${n} 张图片`;
    if (res.autoCleanup && res.autoCleanup.count) {
      msg += ` · 已清理 ${res.autoCleanup.count} 个旧缓存`;
    }
    toast(msg, res.autoCleanup ? 4000 : 2400);
    we.pkgCacheInfo().then((c) => {
      state.pkgCache = c;
      renderPkgSettings();
    });
  } else if (res.error === 'REPKG_NOT_FOUND') {
    state.repkg = { available: false, path: null, version: null, bundled: false };
    toast('未找到 RePKG.exe，请先指定它的位置', 3600);
  } else {
    if (res.log) console.warn('[pkg] RePKG 输出:', res.log);
    toast(`解包失败：${res.error}`, 4200);
  }

  if (state.activeItem) renderActions(state.activeItem);
  renderPkgSettings();
}

/** 设置面板里的 RePKG 状态与缓存占用 */
function renderPkgSettings() {
  if (!el.repkgTitle) return;

  // RePKG：只展示来源与版本，完整路径不再占用版面
  const ok = !!state.repkg.available;
  el.pkgStatusBox.classList.toggle('warn', !ok);
  el.repkgTitle.textContent = ok
    ? (state.repkg.bundled ? '内置 RePKG' : '外部 RePKG')
    : '未找到 RePKG.exe';
  // 版本读不出来就明说「版本未知」，不要显示成已确认的样子
  if (!ok) el.repkgSub.textContent = '场景包解包需要它，可指定一个 exe';
  else if (state.repkg.version) el.repkgSub.textContent = `v${state.repkg.version}`;
  else el.repkgSub.textContent = '版本未知';
  el.repkgState.textContent = ok ? '已就绪' : '不可用';
  // 已经在用内置版本（或根本没找到）时，“恢复内置”没有可执行的动作
  el.pkgResetRepkg.disabled = state.repkg.bundled === true || !ok;

  // 缓存目录与占用
  el.pkgCachePath.textContent = state.pkgCacheDir || '';
  el.pkgCachePath.title = state.pkgCacheDir || '';
  el.pkgResetDir.disabled = state.pkgCacheIsDefault !== false;

  const items = state.pkgCache.items || 0;
  const mb = (state.pkgCache.bytes || 0) / (1024 * 1024);
  el.pkgCacheSize.textContent = items
    ? `${items} 项 · ${mb < 1 ? mb.toFixed(1) : Math.round(mb)} MB`
    : '空';
  el.pkgClearBtn.disabled = items === 0;

  // 上限下拉：兼容手工改过配置里的非预设值
  const val = String(state.pkgCacheLimitMB);
  if (![...el.pkgLimit.options].some((o) => o.value === val)) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = `超过 ${state.pkgCacheLimitMB} MB`;
    el.pkgLimit.appendChild(opt);
  }
  el.pkgLimit.value = val;
}

/* ------------------------------------------------------------------ *
 * 批量操作
 * ------------------------------------------------------------------ */

/** 一次批量打开的上限，避免一下子弹出几十个窗口 */
const BULK_OPEN_LIMIT = 12;

async function runBulk(action) {
  const items = selectedItems();

  if (action === 'clear') {
    state.selected.clear();
    setSelecting(false);
    return;
  }

  if (action === 'selectAll') {
    for (const it of state.list) state.selected.add(it.id);
    updateBulkbar();
    syncSelectionClasses();
    return;
  }

  if (action === 'invert') {
    for (const it of state.list) {
      if (state.selected.has(it.id)) state.selected.delete(it.id);
      else state.selected.add(it.id);
    }
    updateBulkbar();
    syncSelectionClasses();
    return;
  }

  if (!items.length) {
    toast('请先选择内容', 2000);
    return;
  }

  if (action === 'copyPaths') {
    await we.copyText(items.map((it) => it.dir).join('\r\n'));
    toast(`已复制 ${items.length} 条路径`);
    return;
  }

  if (action === 'copyTitles') {
    await we.copyText(items.map((it) => it.title).join('\r\n'));
    toast(`已复制 ${items.length} 个标题`);
    return;
  }

  if (action === 'open') {
    const targets = items.filter((it) => mainOpenPath(it));
    if (!targets.length) {
      toast('所选项没有可用默认程序打开的内容', 2600);
      return;
    }
    if (targets.length > BULK_OPEN_LIMIT) {
      toast(`一次最多打开 ${BULK_OPEN_LIMIT} 项，当前选中 ${targets.length} 项`, 3400);
      return;
    }
    for (const it of targets) {
      await we.openExternal(mainOpenPath(it));
    }
    const skipped = items.length - targets.length;
    toast(skipped > 0
      ? `已打开 ${targets.length} 项，${skipped} 项无默认程序可打开`
      : `已打开 ${targets.length} 项`);
  }
}

/* ------------------------------------------------------------------ *
 * 键盘导航
 * ------------------------------------------------------------------ */

function isTypingTarget(node) {
  if (!node) return false;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable;
}

function gridColumnCount() {
  if (state.viewMode === 'list') return 1;
  const cards = el.grid.querySelectorAll('.card');
  if (!cards.length) return 1;
  const firstTop = cards[0].offsetTop;
  let n = 0;
  for (const c of cards) {
    if (c.offsetTop !== firstTop) break;
    n += 1;
  }
  return Math.max(1, n);
}

function setFocusIndex(idx) {
  const cards = [...el.grid.querySelectorAll('.card')];
  if (!cards.length) return;
  const next = Math.max(0, Math.min(cards.length - 1, idx));
  if (state.focusIndex >= 0 && cards[state.focusIndex]) {
    cards[state.focusIndex].classList.remove('focused');
  }
  state.focusIndex = next;
  const card = cards[next];
  card.classList.add('focused');
  card.scrollIntoView({ block: 'nearest' });
}

function moveFocus(delta) {
  const cards = el.grid.querySelectorAll('.card');
  if (!cards.length) return;
  const start = state.focusIndex < 0 ? (delta > 0 ? -1 : cards.length) : state.focusIndex;
  setFocusIndex(start + delta);
}

function focusedItem() {
  const card = el.grid.querySelectorAll('.card')[state.focusIndex];
  if (!card) return null;
  return state.items.find((it) => it.id === card.dataset.id) || null;
}

/* ------------------------------------------------------------------ *
 * 预览弹窗
 * ------------------------------------------------------------------ */

function openPreview(item) {
  openDetail(item);
}

function mediaSources(item) {
  // 场景包解包后，优先展示从 .pkg 里解出来的画面
  if (item.kind === 'scene') {
    const extracted = state.pkgExtracted.get(item.id);
    if (extracted && extracted.images.length) {
      return extracted.images.map((img) => ({
        type: 'image',
        url: img.url,
        name: img.rel || img.name,
        path: img.path,
      }));
    }
    // 解包失败或没有 RePKG 时继续往下走，回退到目录里找到的媒体
  }

  // 网页壁纸的重点是 HTML，目录里的截图不作为主画面
  if (item.kind === 'web') return [];

  /*
   * 其余类型都按「目录里实际存在的媒体」来预览：
   * 视频优先、图片其次。扫描时若顶层没有媒体，会补扫子目录，
   * 因此「其他 / 程序」类的预设包同样能在这里看到画面。
   */
  const sources = [];
  for (const v of item.videos || []) {
    sources.push({ type: 'video', url: v.url, name: v.name, path: v.path });
  }
  for (const img of item.images || []) {
    sources.push({ type: 'image', url: img.url, name: img.name, path: img.path });
  }
  return sources;
}

/* ---------------- 弹窗内的媒体切换 ----------------
 * 项目切换走弹窗外侧的按钮 / ↑↓ / Alt+←→，
 * 弹窗内的 ‹ › 与 ← → 只作用于当前项目的媒体。
 */

/* ---------------- 缩略条缩略图 ----------------
 * 图集里的原图往往几十 MB，直接塞进 62×36 的按钮要解码很久。
 * 这里让主进程生成 96px 小图（data URL），并限制并发、只加载可见区域。
 */

const THUMB_CONCURRENCY = 4;
let thumbRunning = 0;
const thumbQueue = [];
let stripObserver = null;

function pumpThumbQueue() {
  while (thumbRunning < THUMB_CONCURRENCY && thumbQueue.length) {
    const job = thumbQueue.shift();
    thumbRunning += 1;
    (async () => {
      const im = job.btn.querySelector('img');
      // 缩略条已经被重建时就不必再问了
      if (!job.btn.isConnected || !im) return;
      try {
        const res = await we.thumb(job.path, 96);
        if (res && res.ok && res.url) im.src = res.url;
      } catch {
        /* 失败就保留占位，不影响切换 */
      } finally {
        job.btn.classList.remove('thumb-pending');
      }
    })()
      .catch(() => { /* 忽略 */ })
      .finally(() => {
        thumbRunning -= 1;
        pumpThumbQueue();
      });
  }
}

function requestThumb(filePath, btn) {
  if (!filePath || !btn || btn.dataset.thumbAsked === '1') return;
  btn.dataset.thumbAsked = '1';
  thumbQueue.push({ path: filePath, btn });
  pumpThumbQueue();
}

/** 缩略条自动隐藏的计时器 */
let stripHideTimer = 0;

/** 让缩略条重新出现并重新计时 */
function keepStripVisible() {
  const strip = el.mediaStage.querySelector('.media-strip');
  if (!strip) return;
  strip.classList.remove('idle');
  clearTimeout(stripHideTimer);
  stripHideTimer = setTimeout(() => {
    const s = el.mediaStage.querySelector('.media-strip');
    // 鼠标停在缩略条上时保持可见
    if (s && !s.matches(':hover')) s.classList.add('idle');
  }, 2600);
}

/** 在当前项目的媒体之间切换（图片上一张 / 下一张，首尾循环） */
function switchMedia(step) {
  const item = state.activeItem;
  if (!item) return;
  const sources = mediaSources(item);
  if (sources.length < 2) return;

  state.mediaIndex = (state.mediaIndex + step + sources.length) % sources.length;
  renderMedia(item);
  renderActions(item);
}

/** 弹窗内 ‹ › 的行为：视频快退 / 快进，多图上一张 / 下一张 */
function stepMedia(step) {
  const video = el.mediaStage.querySelector('video');
  if (video) {
    seekVideo(video, step * SEEK_STEP);
    return;
  }
  switchMedia(step);
}

/**
 * 更新弹窗内按钮：视频显示快进快退，多图显示上一张 / 下一张，
 * 只有一份媒体时直接隐藏。
 */
function updateMediaNav(sources, current) {
  const isVideo = !!current && current.type === 'video';
  const many = sources.length > 1;

  if (!isVideo && !many) {
    el.mediaPrev.classList.add('hidden');
    el.mediaNext.classList.add('hidden');
    return;
  }

  el.mediaPrev.classList.remove('hidden');
  el.mediaNext.classList.remove('hidden');

  if (isVideo) {
    el.mediaPrev.title = '快退 5 秒（←）';
    el.mediaNext.title = '快进 5 秒（→）';
  } else {
    const pos = state.mediaIndex + 1;
    el.mediaPrev.title = `上一张（←）${pos} / ${sources.length}`;
    el.mediaNext.title = `下一张（→）${pos} / ${sources.length}`;
  }
}

function renderMedia(item) {
  const sources = mediaSources(item);
  stopMedia();
  if (stripObserver) {
    stripObserver.disconnect();
    stripObserver = null;
  }
  el.mediaStage.textContent = '';
  el.mediaStage.classList.remove('has-strip');

  if (!sources.length) {
    const note = document.createElement('div');
    // 有预览封面时压缩图标与文案宽度，把更多空间留给封面
    note.className = item.preview && item.preview.url
      ? 'media-note has-cover'
      : 'media-note';
    note.appendChild(svgIcon(
      item.kind === 'web' ? ICONS.browser : ICONS.monitor,
      'big-ico'
    ));

    const h = document.createElement('h3');
    h.textContent = `${kindInfo(item.kind).label}内容`;
    note.appendChild(h);

    const p = document.createElement('p');
    if (item.kind === 'web') {
      p.textContent = '这是 HTML 交互式壁纸，管理器内无法直接渲染。可以在浏览器或独立窗口中打开查看效果。';
    } else if (item.kind === 'scene') {
      p.textContent = '这是 Wallpaper Engine 场景包（.pkg）。' +
        (state.repkg.available
          ? '可以解包查看其中的画面资源。'
          : '解包需要 RePKG.exe，当前未找到。');
    } else {
      p.textContent = kindInfo(item.kind).hint + '。可打开资源管理器查看该项目的文件。';
    }
    note.appendChild(p);

    if (item.preview && item.preview.url) {
      const img = document.createElement('img');
      img.className = state.nsfw.blur && isNsfw(item) ? 'note-cover nsfw-blur' : 'note-cover';
      img.src = item.preview.url;
      img.alt = item.title;
      img.loading = 'lazy';
      img.addEventListener('error', () => img.remove());
      note.appendChild(img);
    }

    el.mediaStage.appendChild(note);
    updateMediaNav([], null);
    return;
  }

  const current = sources[Math.min(state.mediaIndex, sources.length - 1)];
  updateMediaNav(sources, current);

  if (current.type === 'video') {
    const video = document.createElement('video');
    video.src = current.url;
    video.controls = true;
    video.autoplay = true;
    video.loop = true;
    video.playsInline = true;
    if (item.preview && item.preview.url) video.poster = item.preview.url;
    video.addEventListener('error', () => toast('视频加载失败，可尝试用默认播放器打开'));
    el.mediaStage.appendChild(video);
    video.play().catch(() => { /* 需要用户交互，忽略 */ });
  } else {
    const img = document.createElement('img');
    img.src = current.url;
    img.alt = item.title;
    img.decoding = 'async';
    el.mediaStage.appendChild(img);
  }

  if (sources.length > 1) {
    el.mediaStage.classList.add('has-strip');
    const strip = document.createElement('div');
    strip.className = 'media-strip';
    sources.forEach((src, idx) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = idx === state.mediaIndex ? 'active' : '';
      b.title = src.name;

      /*
       * 缩略图要用各自的文件：之前所有按钮都取 preview，
       * 图集里就会看到一排完全相同的图。
       */
      const im = document.createElement('img');
      im.alt = '';
      im.decoding = 'async';
      b.appendChild(im);

      if (src.type === 'image') {
        // 原图可能几十 MB：先占位，进入视口后再向主进程要 96px 小图
        b.classList.add('thumb-pending');
        b.dataset.thumbPath = src.path;
      } else {
        // 视频用项目自带的 preview（本身就是小图）
        im.src = (item.preview && item.preview.url) || src.url;
      }

      b.addEventListener('click', () => {
        state.mediaIndex = idx;
        renderMedia(item);
        renderActions(item);
      });
      strip.appendChild(b);
    });

    // 鼠标停在缩略条上时不要淡出
    strip.addEventListener('mouseenter', () => {
      strip.classList.remove('idle');
      clearTimeout(stripHideTimer);
    });
    strip.addEventListener('mouseleave', keepStripVisible);

    // 缩略条过长时，滚轮可以直接横向快速浏览
    strip.addEventListener('wheel', (ev) => {
      if (strip.scrollWidth <= strip.clientWidth) return;
      ev.preventDefault();
      strip.scrollLeft += (ev.deltaY + ev.deltaX) * 1.6;
      keepStripVisible();
    }, { passive: false });

    el.mediaStage.appendChild(strip);

    // 只给滚到可视范围内的缩略图取小图，避免一次解码几十张
    const pending = [...strip.querySelectorAll('[data-thumb-path]')];
    if (pending.length && typeof IntersectionObserver === 'function') {
      stripObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          stripObserver.unobserve(entry.target);
          requestThumb(entry.target.dataset.thumbPath, entry.target);
        }
      }, { root: strip, rootMargin: '160px' });
      pending.forEach((b) => stripObserver.observe(b));
    } else {
      pending.forEach((b) => requestThumb(b.dataset.thumbPath, b));
    }

    // 首屏先加载，剩下的过一会儿按顺序补齐，滚动过去时基本都好了
    const rest = pending;
    if (rest.length) {
      setTimeout(() => {
        for (const b of rest) {
          if (b.isConnected) requestThumb(b.dataset.thumbPath, b);
        }
      }, 1200);
    }

    // 打开时先亮着，2.6 秒无操作后自动淡出
    keepStripVisible();
  }
}

function renderActions(item) {
  el.modalActions.textContent = '';

  const addBtn = (label, icon, handler, cls = 'btn') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    if (icon) b.appendChild(svgIcon(icon));
    const span = document.createElement('span');
    span.textContent = label;
    b.appendChild(span);
    b.addEventListener('click', handler);
    el.modalActions.appendChild(b);
    return b;
  };

  if (item.kind === 'video' && item.videos.length) {
    addBtn('用默认播放器打开', ICONS.external,
      () => openExternal(item.videos[state.mediaIndex]?.path || item.videos[0].path), 'btn primary');
  } else if (item.kind === 'image' && item.images.length) {
    addBtn('用默认查看器打开', ICONS.external,
      () => openExternal(item.images[state.mediaIndex]?.path || item.images[0].path), 'btn primary');
  } else if (item.kind === 'web' && item.htmls.length) {
    addBtn('在浏览器中打开', ICONS.browser,
      () => openExternal(item.htmls[0].path, '已在浏览器中打开'), 'btn primary');
    addBtn('在独立窗口中打开', ICONS.external,
      () => we.openHtmlWindow(item.htmls[0].path).then((r) => !r.ok && toast(r.error || '打开失败')));
  } else if (item.kind === 'other' || item.kind === 'application') {
    // 子目录里找到了媒体，就能像普通视频 / 图片一样用系统程序打开
    const media = mediaSources(item);
    const current = media[state.mediaIndex] || media[0];
    if (current) {
      addBtn(current.type === 'video' ? '用默认播放器打开' : '用默认查看器打开', ICONS.external,
        () => openExternal(current.path), 'btn primary');
    }
  } else if (item.kind === 'scene') {
    const extracted = state.pkgExtracted.get(item.id);
    const extracting = state.pkgExtracting.has(item.id);

    if (extracting) {
      const files = state.pkgProgress.get(item.id) || 0;
      const b = addBtn(
        files ? `正在解包… 已提取 ${files} 个文件` : '正在解包…',
        ICONS.box,
        () => { /* 解包中 */ }
      );
      b.disabled = true;
      b.dataset.pkgProgress = '1';
    } else if (!state.repkg.available) {
      addBtn('指定 RePKG.exe 路径', ICONS.box, () => pickRePkg(), 'btn primary');
    } else if (extracted) {
      addBtn('打开解包目录', ICONS.folder, () => we.openFolder(extracted.dir));
      addBtn(`重新解包（${extracted.images.length} 张图）`, ICONS.box,
        () => extractItemPkg(item, true));
    } else {
      addBtn('解包并预览画面', ICONS.box, () => extractItemPkg(item), 'btn primary');
    }
  }

  const hasFolderMedia = (item.kind === 'other' || item.kind === 'application')
    && (item.videos.length || item.images.length);
  const folderIsPrimary = !INLINE_OPENABLE.has(item.kind)
    && !(item.kind === 'web' && item.htmls.length)
    && item.kind !== 'scene'
    && !hasFolderMedia;
  addBtn('打开资源管理器', ICONS.folder,
    () => we.openFolder(item.dir).then((r) => !r.ok && toast(r.error || '打开失败')),
    folderIsPrimary ? 'btn primary' : 'btn');
  addBtn('在文件夹中显示', ICONS.external,
    () => we.revealPath(item.dir));
}

function renderFileList(item) {
  const files = [];
  if (item.preview) files.push({ name: item.preview.name, size: null, note: '预览' });
  if (item.mainFile) files.push({ name: item.mainFile, size: null, note: '主文件' });
  for (const v of item.videos) files.push({ name: v.name, size: v.size });
  for (const i of item.images) files.push({ name: i.name, size: i.size });
  for (const h of item.htmls) files.push({ name: h.name, size: h.size });
  for (const p of item.pkgs) files.push({ name: p.name, size: p.size });
  for (const x of item.execs) files.push({ name: x.name, size: x.size });

  // 去重（主文件可能与内容文件重复）
  const seen = new Set();
  const uniq = files.filter((f) => {
    if (seen.has(f.name)) return false;
    seen.add(f.name);
    return true;
  });

  el.modalFiles.textContent = '';
  for (const f of uniq) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = f.note ? `${f.name}  (${f.note})` : f.name;
    const meta = document.createElement('span');
    meta.textContent = f.size == null ? '' : formatBytes(f.size);
    li.appendChild(name);
    li.appendChild(meta);
    el.modalFiles.appendChild(li);
  }
  el.modalFileCount.textContent = ` (${uniq.length})`;
}

function openDetail(item) {
  state.activeItem = item;
  state.mediaIndex = 0;

  el.modalTitle.textContent = item.title;

  el.modalKind.className = `badge k-${item.kind}`;
  el.modalKind.textContent = kindInfo(item.kind).label;

  el.modalSize.textContent = `${formatBytes(item.totalSize)} · 更新于 ${formatDate(item.mtime)}`;

  el.modalTags.textContent = '';
  for (const t of item.tags || []) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = t;
    el.modalTags.appendChild(tag);
  }
  if (item.contentRating) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = item.contentRating;
    el.modalTags.appendChild(tag);
  }

  renderMedia(item);
  renderActions(item);
  renderFileList(item);

  el.modalPath.textContent = item.dir;
  el.modalPath.title = '点击复制';

  if (item.description && item.description.trim()) {
    el.modalDescSection.classList.remove('hidden');
    el.modalDesc.textContent = item.description;
  } else {
    el.modalDescSection.classList.add('hidden');
  }

  updateDetailNav(item);
  el.modal.classList.remove('hidden');
}

function closeModal() {
  el.modal.classList.add('hidden');
  stopMedia();
  el.mediaStage.textContent = '';
  state.activeItem = null;
}

/** 停止并释放媒体区里的视频，避免切换条目后继续出声 */
function stopMedia() {
  for (const v of el.mediaStage.querySelectorAll('video')) {
    try {
      v.pause();
      v.removeAttribute('src');
      v.load();
    } catch {
      /* 忽略 */
    }
  }
}

/* ---------------- 详情页视频键盘控制 ----------------
 * 详情弹窗打开后由 document 层的 keydown 统一处理，不依赖 video 获得焦点，
 * 因此打开即可用键盘控制，不需要先点一下画面。
 */

/** 左右键的单次步长（秒） */
const SEEK_STEP = 5;

/** 相对当前位置快退 / 快进，自动夹在 [0, duration] 内 */
function seekVideo(video, delta) {
  if (!video) return;
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  if (duration <= 0) return; // 元数据还没加载好，忽略
  video.currentTime = Math.min(Math.max(0, video.currentTime + delta), duration);
}

function togglePlayback(video) {
  if (!video) return;
  if (video.paused) video.play().catch(() => { /* 需要用户交互时忽略 */ });
  else video.pause();
}

function toggleVideoFullscreen(video) {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => { /* 忽略 */ });
  } else if (video && video.requestFullscreen) {
    video.requestFullscreen().catch(() => { /* 忽略 */ });
  }
}

/** 刷新详情页的位置指示与上一个 / 下一个按钮状态 */
function updateDetailNav(item) {
  const idx = state.list.findIndex((it) => it.id === item.id);
  const total = state.list.length;

  el.modalIndex.textContent = idx >= 0 ? `${idx + 1} / ${total}` : '';
  el.itemPrev.disabled = idx <= 0;
  el.itemNext.disabled = idx < 0 || idx >= total - 1;
}

/** 在当前筛选 / 排序结果里切换到相邻条目 */
function navigateDetail(step) {
  if (!state.activeItem) return;
  const idx = state.list.findIndex((it) => it.id === state.activeItem.id);
  if (idx < 0) return;

  const target = state.list[idx + step];
  if (!target) return;

  openDetail(target);

  // 让背后的网格跟着对齐，关掉弹窗后能接着刚才的位置看
  const card = el.grid.querySelector(`.card[data-id="${target.id}"]`);
  if (card) card.scrollIntoView({ block: 'nearest' });
}

/* ------------------------------------------------------------------ *
 * 顶栏目录显示
 * ------------------------------------------------------------------ */

function updateRootPath() {
  const dirs = state.rootDirs;

  if (state.activeDir !== 'all') {
    el.rootPathText.textContent = state.activeDir;
  } else if (dirs.length > 1) {
    el.rootPathText.textContent = `全部来源 · ${dirs.length} 个目录`;
  } else {
    el.rootPathText.textContent = dirs[0] || '未设置订阅目录';
  }

  el.rootPath.classList.toggle('warn', dirs.length === 0);
  el.rootPath.title = dirs.length
    ? (state.activeDir === 'all' ? '合并显示所有目录，点击切换来源' : `${state.activeDir}\n点击切换来源`)
    : '点击添加 Wallpaper Engine 订阅目录';
}

/* ------------------------------------------------------------------ *
 * 内容来源面板
 * ------------------------------------------------------------------ */

function renderDirPanel() {
  el.dirList.textContent = '';

  const addItem = (dir, label, count, isAll) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `dir-item${isAll ? ' all' : ''}${state.activeDir === dir ? ' active' : ''}`;
    item.dataset.dir = dir;
    item.title = isAll ? '合并显示所有目录' : dir;

    const name = document.createElement('span');
    name.className = 'dir-name';
    name.textContent = label;

    const countEl = document.createElement('span');
    countEl.className = 'dir-count';
    countEl.textContent = String(count);

    item.appendChild(name);
    item.appendChild(countEl);

    // 只有一个目录时不显示移除按钮，避免误操作后无法恢复
    if (!isAll && state.rootDirs.length > 1) {
      const remove = document.createElement('span');
      remove.className = 'dir-remove';
      remove.textContent = '×';
      remove.title = '移除这个目录';
      remove.dataset.remove = dir;
      item.appendChild(remove);
    }

    el.dirList.appendChild(item);
  };

  addItem('all', '全部（合并显示）', state.items.length, true);

  const stats = state.dirStats.length
    ? state.dirStats
    : state.rootDirs.map((p) => ({ path: p, count: 0 }));

  for (const d of stats) addItem(d.path, d.path, d.count, false);
}

function openDirPanel() {
  renderDirPanel();
  el.dirPanel.classList.remove('hidden');
  el.rootPath.classList.add('active');
}

function closeDirPanel() {
  if (el.dirPanel.classList.contains('hidden')) return;
  el.dirPanel.classList.add('hidden');
  el.rootPath.classList.remove('active');
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function rescan() {
  if (!state.rootDirs.length) {
    render();
    return;
  }
  setStatus(`正在扫描 ${state.rootDirs.length} 个目录…`);
  el.progress.classList.remove('hidden');
  el.btnRescan.disabled = true;
  try {
    const res = await we.scan();
    if (res.error && !(res.items || []).length) {
      toast(res.error, 4000);
      setStatus(res.error);
      return;
    }
    state.items = res.items || [];
    state.dirStats = res.dirs || [];

    // activeDir 指向的目录可能已被移除
    if (state.activeDir !== 'all' && !state.rootDirs.includes(state.activeDir)) {
      state.activeDir = 'all';
      updateRootPath();
    }

    renderFilters();
    render();
    if (res.elapsed != null) {
      setStatus(`${el.statusText.textContent} · 耗时 ${res.elapsed} ms`);
    }
    if (res.error) toast(res.error, 3600);
  } catch (err) {
    toast(`扫描失败：${err.message}`, 4000);
  } finally {
    hideProgress();
    el.btnRescan.disabled = false;
  }
}

/** 添加一个目录（可重复添加，用于合并多个 Steam 库） */
async function pickRoot() {
  const res = await we.pickRoot();
  if (res.canceled) return;
  if (!res.ok) {
    toast(res.error || '添加失败');
    return;
  }
  state.rootDirs = res.rootDirs || state.rootDirs;
  state.activeDir = 'all';
  updateRootPath();
  await rescan();
  toast('已添加目录，当前合并显示所有来源');
}

async function redetect() {
  const res = await we.redetect();
  state.env = res.env || {};
  state.rootDirs = res.rootDirs || state.rootDirs;

  if (state.activeDir !== 'all' && !state.rootDirs.includes(state.activeDir)) {
    state.activeDir = 'all';
  }
  updateRootPath();

  if (res.added > 0) {
    toast(`新发现 ${res.added} 个订阅目录，共 ${state.rootDirs.length} 个`, 3200);
    await rescan();
  } else {
    const dirs = state.env.workshopDirs || [];
    const local = state.env.localProjectsDir ? ' · 1 个本地项目目录' : '';
    toast(`检测到 ${dirs.length} 个订阅目录${local}，没有新增`, 3000);
  }
}

function bindEvents() {
  // 搜索
  let searchTimer = null;
  el.search.addEventListener('input', () => {
    el.searchClear.classList.toggle('hidden', !el.search.value);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = el.search.value;
      render();
    }, 140);
  });
  el.searchClear.addEventListener('click', () => {
    el.search.value = '';
    state.search = '';
    el.searchClear.classList.add('hidden');
    el.search.focus();
    render();
  });

  // 筛选
  el.filters.addEventListener('click', (ev) => {
    const chip = ev.target.closest('.chip');
    if (!chip) return;
    state.filter = chip.dataset.filter;
    renderFilters();
    render();
  });

  // 排序
  el.sortBy.value = state.sortBy;
  el.sortBy.addEventListener('change', () => {
    state.sortBy = el.sortBy.value;
    we.save({ sortBy: state.sortBy });
    render();
  });

  // 视图
  el.viewToggle.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-view]');
    if (!btn) return;
    state.viewMode = btn.dataset.view;
    for (const b of el.viewToggle.querySelectorAll('button')) {
      b.classList.toggle('active', b === btn);
    }
    we.save({ viewMode: state.viewMode });
    render();
  });

  // 外观面板
  el.btnAppearance.addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggleSettings();
  });
  el.settings.addEventListener('click', (ev) => ev.stopPropagation());
  el.settingsClose.addEventListener('click', closeSettings);
  el.settingsTabs.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-pane]');
    if (!btn) return;
    setSettingsPane(btn.dataset.pane);
  });
  el.settingsReset.addEventListener('click', () => {
    state.appearance = { ...APPEARANCE_DEFAULT };
    applyAppearance();
    renderSettingsPanel();
    we.save({ appearance: state.appearance });
    render();
    toast('外观已恢复默认');
  });
  el.setWidth.addEventListener('input', () => {
    const v = Number(el.setWidth.value);
    el.setWidthValue.textContent = `${v} px`;
    state.appearance.cardMin = v;
    applyAppearance();
  });
  el.setWidth.addEventListener('change', () => {
    saveAppearance({ cardMin: Number(el.setWidth.value) });
  });
  el.setDensity.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-density]');
    if (!btn) return;
    saveAppearance({ density: btn.dataset.density });
    renderSettingsPanel();
  });
  el.setShowTags.addEventListener('change', () => {
    saveAppearance({ showTags: el.setShowTags.checked });
  });
  el.setShowSize.addEventListener('change', () => {
    saveAppearance({ showSize: el.setShowSize.checked });
  });
  el.setNsfwHide.addEventListener('change', () => {
    saveNsfw({ hide: el.setNsfwHide.checked });
  });
  el.setNsfwBlur.addEventListener('change', () => {
    saveNsfw({ blur: el.setNsfwBlur.checked });
  });
  el.nsfwHideNow.addEventListener('click', () => {
    we.hideWindow();
  });
  // 点击别处收起面板（面板内部的点击已 stopPropagation）
  document.addEventListener('click', () => {
    if (!el.settings.classList.contains('hidden')) closeSettings();
    closeDirPanel();
  });

  // 场景包解包（设置面板内）
  el.pkgPickBtn.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    await pickRePkg();
    renderPkgSettings();
  });
  el.pkgResetRepkg.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    if (el.pkgResetRepkg.disabled) return;

    const res = await we.pkgResetRepkg();
    if (!res.ok) {
      toast(res.error || '恢复失败');
      return;
    }

    try {
      const s = await we.pkgStatus();
      state.repkg = {
        available: s.available, path: s.repkgPath, version: s.version, bundled: s.bundled,
      };
    } catch {
      state.repkg = { available: res.available, path: null, version: null, bundled: res.bundled };
    }
    renderPkgSettings();
    if (state.activeItem) renderActions(state.activeItem);
    toast(res.available ? '已恢复使用内置 RePKG' : '没有找到内置 RePKG');
  });
  el.pkgOpenDir.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const res = await we.pkgOpenCacheDir();
    if (!res.ok) toast(res.error || '打开失败');
  });
  el.pkgChangeDir.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const picked = await we.pkgPickCacheDir();
    if (picked.canceled || !picked.path) return;
    const res = await we.pkgSetCacheDir(picked.path);
    if (res.canceled) return; // 用户在“旧缓存怎么处理”里点了取消
    if (!res.ok) {
      toast(res.error || '切换失败');
      return;
    }
    await applyCacheDirChange(res);
  });
  el.pkgResetDir.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const res = await we.pkgSetCacheDir(null);
    if (res.canceled) return;
    if (!res.ok) {
      toast(res.error || '恢复失败');
      return;
    }
    await applyCacheDirChange(res);
  });
  el.pkgClearBtn.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const res = await we.pkgClearCache();
    if (!res.ok) {
      toast(res.error || '清理失败');
      return;
    }
    state.pkgCache = res.cache;
    state.pkgExtracted.clear();
    renderPkgSettings();
    if (state.activeItem) {
      renderMedia(state.activeItem);
      renderActions(state.activeItem);
    }
    toast('解包缓存已清空');
  });

  // 修改自动清理上限：保存并立刻按新上限收敛一次
  el.pkgLimit.addEventListener('change', async () => {
    const mb = Number(el.pkgLimit.value);
    state.pkgCacheLimitMB = mb;
    await we.save({ pkgCacheLimitMB: mb });

    if (mb <= 0) {
      toast('已关闭自动清理');
      return;
    }

    const res = await we.pkgEnforceLimit();
    if (res.cache) state.pkgCache = res.cache;

    if (res.ids && res.ids.length) {
      for (const id of res.ids) state.pkgExtracted.delete(id);
      if (state.activeItem) {
        renderMedia(state.activeItem);
        renderActions(state.activeItem);
      }
    }

    renderPkgSettings();
    toast(res.count > 0
      ? `已清理 ${res.count} 个旧缓存，释放 ${formatBytes(res.freed)}`
      : '当前缓存未超过上限', 3000);
  });

  // 解包进度：只更新按钮文字，避免反复重建整个按钮区
  we.onPkgProgress(({ itemId, files }) => {
    state.pkgProgress.set(itemId, files);
    if (!state.activeItem || state.activeItem.id !== itemId) return;
    const btn = el.modalActions.querySelector('[data-pkg-progress]');
    const span = btn && btn.querySelector('span');
    if (span) span.textContent = `正在解包… 已提取 ${files} 个文件`;
  });

  // 多选
  el.btnSelect.addEventListener('click', () => setSelecting(!state.selecting));
  el.bulkbar.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-bulk]');
    if (btn) runBulk(btn.dataset.bulk);
  });

  // 顶栏按钮
  el.btnRescan.addEventListener('click', rescan);
  el.btnDetect.addEventListener('click', redetect);
  el.btnPickRoot.addEventListener('click', pickRoot);
  el.emptyAction.addEventListener('click', pickRoot);

  // 内容来源面板
  el.rootPath.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (el.dirPanel.classList.contains('hidden')) openDirPanel();
    else closeDirPanel();
  });
  el.dirPanel.addEventListener('click', (ev) => ev.stopPropagation());
  el.dirClose.addEventListener('click', closeDirPanel);
  el.dirAdd.addEventListener('click', async () => {
    await pickRoot();
    renderDirPanel();
  });
  el.dirList.addEventListener('click', async (ev) => {
    const removeBtn = ev.target.closest('[data-remove]');
    if (removeBtn) {
      ev.stopPropagation();
      const res = await we.removeDir(removeBtn.dataset.remove);
      if (!res.ok) {
        toast('移除失败');
        return;
      }
      state.rootDirs = res.rootDirs;
      state.activeDir = res.activeDir;
      updateRootPath();
      await rescan();
      renderDirPanel();
      toast('已移除该目录');
      return;
    }

    const item = ev.target.closest('.dir-item');
    if (!item) return;

    const dir = item.dataset.dir;
    if (dir === state.activeDir) {
      closeDirPanel();
      return;
    }

    state.activeDir = dir;
    await we.setActiveDir(dir);
    updateRootPath();
    renderFilters();
    render();
    renderDirPanel();
    closeDirPanel();
  });

  // 弹窗
  el.modal.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-close]') || ev.target === el.modal) closeModal();
  });
  el.modalPath.addEventListener('click', async () => {
    if (!state.activeItem) return;
    await we.copyText(state.activeItem.dir);
    toast('路径已复制');
  });

  // 弹窗外侧：切换上一个 / 下一个项目
  el.itemPrev.addEventListener('click', () => navigateDetail(-1));
  el.itemNext.addEventListener('click', () => navigateDetail(1));

  // 弹窗内侧：只处理当前项目的媒体（图片上一张 / 下一张，视频快退 / 快进）
  el.mediaPrev.addEventListener('click', () => {
    stepMedia(-1);
    keepStripVisible();
  });
  el.mediaNext.addEventListener('click', () => {
    stepMedia(1);
    keepStripVisible();
  });

  // 鼠标在画面上移动时，把自动隐藏的缩略条叫回来
  let lastWake = 0;
  el.mediaStage.addEventListener('mousemove', () => {
    const now = Date.now();
    if (now - lastWake < 200) return;
    lastWake = now;
    keepStripVisible();
  });

  // 键盘
  document.addEventListener('keydown', (ev) => {
    const modalOpen = !el.modal.classList.contains('hidden');

    if (ev.key === 'Escape') {
      if (modalOpen) closeModal();
      else if (!el.settings.classList.contains('hidden')) closeSettings();
      else if (state.selecting) setSelecting(false);
      return;
    }

    /*
     * 弹窗打开时的按键优先级：
     *   1. Alt + ← / → 与 ↑ / ↓  → 切换上一个 / 下一个（任何媒体都可用）
     *   2. 视频存在时，← / → 优先给播放器做快退 / 快进 5 秒
     *   3. 没有视频（图片 / 网页 / 场景包）时，← / → 才是切换上一个 / 下一个
     */
    if (modalOpen) {
      if (ev.altKey && ev.key === 'ArrowLeft') { ev.preventDefault(); navigateDetail(-1); return; }
      if (ev.altKey && ev.key === 'ArrowRight') { ev.preventDefault(); navigateDetail(1); return; }
      if (ev.key === 'ArrowUp') { ev.preventDefault(); navigateDetail(-1); return; }
      if (ev.key === 'ArrowDown') { ev.preventDefault(); navigateDetail(1); return; }

      const video = el.mediaStage.querySelector('video');
      if (video) {
        if (ev.key === 'ArrowLeft') { ev.preventDefault(); seekVideo(video, -SEEK_STEP); return; }
        if (ev.key === 'ArrowRight') { ev.preventDefault(); seekVideo(video, SEEK_STEP); return; }
        if (ev.key === ' ' || ev.key === 'Spacebar') { ev.preventDefault(); togglePlayback(video); return; }
        if (ev.key.toLowerCase() === 'm') {
          ev.preventDefault();
          video.muted = !video.muted;
          toast(video.muted ? '已静音' : '已取消静音');
          return;
        }
        if (ev.key.toLowerCase() === 'f') { ev.preventDefault(); toggleVideoFullscreen(video); return; }
      }

      /*
       * 图片 / 图集：← → 只在本项目的媒体之间切换，不翻项目。
       * 翻项目用弹窗外侧的按钮，或 ↑ ↓、Alt + ← →。
       */
      if (ev.key === 'ArrowLeft') { ev.preventDefault(); switchMedia(-1); keepStripVisible(); return; }
      if (ev.key === 'ArrowRight') { ev.preventDefault(); switchMedia(1); keepStripVisible(); return; }
      return;
    }

    // 在输入框里打字时不劫持按键
    if (isTypingTarget(document.activeElement)) return;

    if (ev.key === '/') {
      ev.preventDefault();
      el.search.focus();
      return;
    }
    if (ev.key === 'F5') {
      ev.preventDefault();
      rescan();
      return;
    }

    // Ctrl/Cmd + A：全选当前列表
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'a') {
      ev.preventDefault();
      if (!state.selecting) setSelecting(true);
      runBulk('selectAll');
      return;
    }

    // 方向键在卡片之间移动焦点
    const cols = gridColumnCount();
    if (ev.key === 'ArrowRight') { ev.preventDefault(); moveFocus(1); return; }
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); moveFocus(-1); return; }
    if (ev.key === 'ArrowDown') { ev.preventDefault(); moveFocus(cols); return; }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); moveFocus(-cols); return; }
    if (ev.key === 'Home') { ev.preventDefault(); setFocusIndex(0); return; }
    if (ev.key === 'End') { ev.preventDefault(); setFocusIndex(state.list.length - 1); return; }

    // 空格：多选模式下切换选中，否则打开当前聚焦项
    if (ev.key === ' ' || ev.key === 'Spacebar') {
      const item = focusedItem();
      if (!item) return;
      ev.preventDefault();
      if (state.selecting) toggleSelect(item, !state.selected.has(item.id));
      else handleCardClick(item);
    }
  });

  // 主进程菜单
  we.onMenu('menu:rescan', rescan);
  we.onMenu('menu:pickRoot', pickRoot);
  we.onMenu('menu:redetect', redetect);

  // 扫描进度
  we.onScanProgress(({ done, total }) => showProgress(done, total));
}

async function init() {
  bindEvents();
  try {
    const boot = await we.bootstrap();
    state.rootDirs = boot.rootDirs || [];
    state.activeDir = boot.activeDir || 'all';
    state.env = boot.env || {};
    state.viewMode = (boot.config && boot.config.viewMode) || 'grid';
    state.sortBy = (boot.config && boot.config.sortBy) || 'title-asc';
    state.appearance = {
      ...APPEARANCE_DEFAULT,
      ...((boot.config && boot.config.appearance) || {}),
    };
    state.nsfw = {
      ...NSFW_DEFAULT,
      ...((boot.config && boot.config.nsfw) || {}),
    };
    const limitFromConfig = boot.config && boot.config.pkgCacheLimitMB;
    state.pkgCacheLimitMB = Number.isFinite(Number(limitFromConfig)) ? Number(limitFromConfig) : 2048;
    applyAppearance();
    el.sortBy.value = state.sortBy;

    // 场景包解包：RePKG 状态 + 缓存目录 + 还原磁盘上已有的解包结果
    state.repkg = {
      available: !!(boot.repkg && boot.repkg.available),
      path: (boot.repkg && boot.repkg.path) || null,
      version: null,
      bundled: false,
    };
    state.pkgCacheDir = (boot.pkgCache && boot.pkgCache.dir) || '';
    state.pkgCacheIsDefault = boot.pkgCache ? boot.pkgCache.isDefault !== false : true;

    // 版本号要执行一次 RePKG 才知道，异步补齐即可
    we.pkgStatus().then((s) => {
      state.repkg = {
        available: s.available,
        path: s.repkgPath,
        version: s.version,
        bundled: s.bundled,
      };
      state.pkgCacheDir = s.cacheDir || state.pkgCacheDir;
      state.pkgCacheIsDefault = s.isDefault !== false;
      renderPkgSettings();
    }).catch(() => { /* 忽略 */ });
    try {
      const restored = await we.pkgRestore();
      for (const [id, entry] of Object.entries(restored || {})) {
        state.pkgExtracted.set(id, entry);
      }
    } catch (err) {
      console.warn('[pkg] 还原解包缓存失败:', err);
    }
    we.pkgCacheInfo().then((c) => {
      state.pkgCache = c;
      renderPkgSettings();
    }).catch(() => { /* 忽略 */ });

    for (const b of el.viewToggle.querySelectorAll('button')) {
      b.classList.toggle('active', b.dataset.view === state.viewMode);
    }

    updateRootPath();
    render();

    if (!state.rootDirs.length) {
      const dirs = state.env.workshopDirs || [];
      if (dirs.length) {
        setStatus(`发现订阅目录但未启用：${dirs[0]}`);
      } else {
        setStatus('未检测到 Wallpaper Engine 订阅目录，请手动选择');
      }
      return;
    }
    await rescan();
  } catch (err) {
    setStatus(`初始化失败：${err.message}`);
    toast(`初始化失败：${err.message}`, 5000);
  }
}

init();
