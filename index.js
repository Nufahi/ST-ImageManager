/*
 * Image Manager for SillyTavern
 * A storage-focused image manager for the /user/images folder.
 * Browse every character's image folder, pin favorites and bulk-delete
 * unwanted images to free up space — handy on mobile where the
 * user/images folder tends to grow unchecked.
 *
 * Uses the same built-in server API as the native Gallery extension:
 *   POST /api/images/folders   -> string[] of folder names
 *   POST /api/images/list      -> string[] of file names in a folder
 *   POST /api/images/delete    -> deletes a file by its user-relative path
 */

const MODULE_NAME = 'ST-ImageManager';
const EXT_PATH = `scripts/extensions/third-party/${MODULE_NAME}`;
const SETTINGS_KEY = 'imageManager';

/* ============================================================
 * I18N — lightweight translation layer.
 * Strings live in i18n/<lang>.json next to this file. The language is
 * auto-detected from SillyTavern's UI locale (the one set via the top-bar
 * language selector / /lang), falling back to navigator.language and finally
 * to English. RU users get Russian, everyone else gets English.
 * ============================================================ */
const I18N_FALLBACK = 'en';
const I18N_SUPPORTED = ['en', 'ru'];
let I18N_LANG = I18N_FALLBACK;
let I18N_STRINGS = {};
let I18N_FALLBACK_STRINGS = {};

function i18nDetectLang() {
    const candidates = [];
    try {
        const c = SillyTavern?.getContext?.();
        if (c) {
            // ST 1.12+ exposes the current locale via getCurrentLocale().
            if (typeof c.getCurrentLocale === 'function') candidates.push(c.getCurrentLocale());
            candidates.push(c?.powerUserSettings?.locale);
            candidates.push(c?.accountStorage?.getItem?.('language'));
        }
    } catch (e) { /* ignore */ }
    try { candidates.push(localStorage.getItem('language')); } catch (e) { /* ignore */ }
    try { candidates.push(navigator.language || navigator.userLanguage); } catch (e) { /* ignore */ }

    for (const raw of candidates) {
        if (typeof raw !== 'string' || !raw) continue;
        const lang = raw.toLowerCase().split(/[-_]/)[0];
        if (I18N_SUPPORTED.includes(lang)) return lang;
    }
    return I18N_FALLBACK;
}

async function i18nLoad() {
    I18N_LANG = i18nDetectLang();
    // Always load English first as the fallback so a missing key in another
    // locale never surfaces a raw key string in the UI.
    try {
        const res = await fetch(`/${EXT_PATH}/i18n/${I18N_FALLBACK}.json`);
        if (res.ok) I18N_FALLBACK_STRINGS = await res.json();
    } catch (e) {
        console.warn(`[${MODULE_NAME}] i18n: failed to load fallback (${I18N_FALLBACK})`, e);
    }
    if (I18N_LANG === I18N_FALLBACK) {
        I18N_STRINGS = I18N_FALLBACK_STRINGS;
        return;
    }
    try {
        const res = await fetch(`/${EXT_PATH}/i18n/${I18N_LANG}.json`);
        if (res.ok) {
            I18N_STRINGS = await res.json();
        } else {
            I18N_STRINGS = I18N_FALLBACK_STRINGS;
            I18N_LANG = I18N_FALLBACK;
        }
    } catch (e) {
        console.warn(`[${MODULE_NAME}] i18n: failed to load ${I18N_LANG}`, e);
        I18N_STRINGS = I18N_FALLBACK_STRINGS;
        I18N_LANG = I18N_FALLBACK;
    }
}

/** Translate a key, substituting {{var}} placeholders from params. Falls back
 *  to English, then to the raw key so missing strings stay visible. */
function t(key, params) {
    let str = I18N_STRINGS[key];
    if (str === undefined) str = I18N_FALLBACK_STRINGS[key];
    if (str === undefined) return key;
    if (!params) return str;
    return str.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

const DISPLAY_NAME = () => t('app');

/** "N image(s)" with locale-aware singular/plural. */
function tImages(count) {
    return t(count === 1 ? 'summary.images.one' : 'summary.images.many', { count });
}

/** Apply translations to a DOM subtree using our own data-i18n attributes.
 *  Supports:
 *    data-i18n="key"                  -> sets textContent
 *    data-i18n-title="key"            -> sets the title attribute
 *    data-i18n-placeholder="key"      -> sets the placeholder attribute
 *    data-i18n-aria-label="key"       -> sets the aria-label attribute
 *  This is intentionally independent of SillyTavern's own i18n system so the
 *  extension fully controls its own strings (including via the HTML fetch
 *  fallback, where ST's auto-translation does not run). */
function i18nApplyDom(root) {
    if (!root) return;
    root.querySelectorAll('[data-i18n]').forEach((el) => {
        el.textContent = t(el.getAttribute('data-i18n'));
    });
    const attrs = [
        ['data-i18n-title', 'title'],
        ['data-i18n-placeholder', 'placeholder'],
        ['data-i18n-aria-label', 'aria-label'],
    ];
    for (const [dataAttr, realAttr] of attrs) {
        root.querySelectorAll(`[${dataAttr}]`).forEach((el) => {
            el.setAttribute(realAttr, t(el.getAttribute(dataAttr)));
        });
    }
}
const ROOT_FOLDER = '__root__'; // images that live directly in /user/images
const ALL_FOLDERS = '__all__';
const TRASH_FOLDER = '__trash__'; // virtual view: images soft-deleted into the trash

const FAVORITES_FOLDER = '__favorites__';

const PAGE_SIZE_OPTIONS = Object.freeze([10, 20, 30, 60, 120, 240]);

const VIDEO_EXTENSIONS = ['mp4', 'webm', 'ogv', 'mov', 'mkv'];

// localStorage keys for device-local UI preferences.
const LS_MODE = 'imageManager.mode';     // 'modal' | 'floating'
const LS_FLOAT = 'imageManager.floatBox'; // { left, top, width, height }
const LS_COLS = 'imageManager.cols';     // mobile cards-per-row (2..4)
const LS_SIDEBAR_W = 'imageManager.sidebarW';        // desktop sidebar width (px)
const LS_SIDEBAR_COLLAPSED = 'imageManager.sidebarCollapsed'; // '1' | '0'
const LS_THEME = 'imageManager.theme';   // manager colour theme id (see THEMES)

/* ---------- Manager themes ----------
 * Self-contained colour schemes for the manager UI. `adaptive` keeps following
 * the live SillyTavern theme (no override); every other id maps to a
 * `[data-im-theme="<id>"]` block in style.css. The `accent`/`bg` here are only
 * used to draw the little swatch in the picker — the real colours live in CSS.
 * `i18n` is the translation key for the human label. */
const THEMES = Object.freeze([
    { id: 'adaptive', i18n: 'theme.adaptive', accent: '#6a9cff', bg: '#1a1a1a' },
    { id: 'amoled',   i18n: 'theme.amoled',   accent: '#4f9dff', bg: '#000000' },
    { id: 'brown',    i18n: 'theme.brown',    accent: '#d9a066', bg: '#2b211a' },
    { id: 'blue',     i18n: 'theme.blue',     accent: '#5aa9ff', bg: '#0f1a2e' },
    { id: 'dracula',  i18n: 'theme.dracula',  accent: '#bd93f9', bg: '#282a36' },
    { id: 'pink',     i18n: 'theme.pink',     accent: '#ff79c6', bg: '#2e1722' },
    { id: 'green',    i18n: 'theme.green',    accent: '#50fa7b', bg: '#122019' },
    { id: 'purple',   i18n: 'theme.purple',   accent: '#b388ff', bg: '#1e152e' },
]);
const DEFAULT_THEME = 'adaptive';
const THEME_IDS = THEMES.map(t => t.id);

// Desktop folder-sidebar width bounds (px).
const SIDEBAR_MIN_W = 120;
const SIDEBAR_MAX_W = 420;
const SIDEBAR_DEFAULT_W = 220;

// How many cards per row the mobile grid can show. The user cycles through
// these with the columns button; cards shrink to fit the chosen count.
const COLS_OPTIONS = Object.freeze([2, 3, 4]);
const DEFAULT_COLS = 2;

const DEFAULT_SETTINGS = Object.freeze({
    sort: 'date-desc',
    pageSize: 60,
    favorites: [], // pinned paths, protected from trash and permanent deletion
    // Soft "Recycle bin". Items are not removed from disk — their paths are
    // parked here with the moment they were trashed (ms epoch) so the user can
    // restore them or manually purge them for good later.
    trash: [], // [{ path: string, date: number }]
});

/* ============================================================
 * STATE
 * ============================================================ */
const state = {
    initialized: false,
    isOpen: false,
    isLoading: false,
    /** @type {Array<{folder: string, files: string[]}>} */
    folders: [],
    /** All images flattened: { path, folder, file, url, isVideo, mtime } */
    images: [],
    imageByPath: new Map(), // path -> image record (O(1) lookups)
    filterCache: null,      // memoised getFilteredImages() result (see below)
    sizeCache: new Map(), // path -> bytes (lazily filled)
    activeFolder: ALL_FOLDERS,
    autoFolderPending: false, // jump to current character's folder on next load
    folderSearch: '',   // toolbar folder finder (filters the sidebar list)
    sort: DEFAULT_SETTINGS.sort,
    pageSize: DEFAULT_SETTINGS.pageSize,
    currentPage: 1,
    selected: new Set(), // set of paths
    dom: {},
    sizeQueue: [],
    sizeQueued: new Set(), // mirrors sizeQueue for O(1) dedupe
    sizeRunning: false,
    mode: 'modal',      // 'modal' (centered) | 'floating' (movable window)
    floatBox: null,     // { left, top, width, height } when floating
    cols: DEFAULT_COLS, // mobile cards-per-row (2..4)
    sidebarWidth: SIDEBAR_DEFAULT_W, // desktop folder-sidebar width (px)
    sidebarCollapsed: false,         // desktop folder-sidebar collapsed?
    theme: DEFAULT_THEME,            // manager colour theme id
    trashMigrated: false,            // legacy trash records normalised once?
    deleting: new Set(),             // paths with a delete request in flight
    actionDialog: null,
};

/* ============================================================
 * UTILS
 * ============================================================ */
function ctx() {
    return SillyTavern.getContext();
}

/**
 * The image folder name of the character currently being chatted with, or null
 * if none is open (welcome screen) or a group chat is active. SillyTavern stores
 * each character's images in /user/images/<character name>/, so the folder name
 * equals the character's name — exactly the value the folder sidebar uses. This
 * lets us auto-open the right folder instead of dumping the user into "All".
 */
function getCurrentCharFolder() {
    try {
        const c = ctx();
        // Group chats don't map to a single image folder — leave them on "All".
        if (c.groupId) return null;
        if (c.characterId == null) return null;
        const char = c.characters?.[c.characterId];
        const name = char?.name;
        return (typeof name === 'string' && name.trim()) ? name : null;
    } catch (e) {
        return null;
    }
}

function reqHeaders(extra = {}) {
    const c = ctx();
    if (typeof c.getRequestHeaders === 'function') {
        return Object.assign(c.getRequestHeaders(), extra);
    }
    return Object.assign({ 'Content-Type': 'application/json' }, extra);
}

function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function isVideoFile(name) {
    return VIDEO_EXTENSIONS.some(ext => new RegExp(`\\.${ext}$`, 'i').test(name));
}

function humanSize(bytes) {
    if (bytes == null || isNaN(bytes)) return '';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024;
        i++;
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}

function getSettings() {
    const c = ctx();
    if (!c.extensionSettings[SETTINGS_KEY] || typeof c.extensionSettings[SETTINGS_KEY] !== 'object') {
        c.extensionSettings[SETTINGS_KEY] = structuredClone(DEFAULT_SETTINGS);
    }
    const s = c.extensionSettings[SETTINGS_KEY];
    if (!PAGE_SIZE_OPTIONS.includes(Number(s.pageSize))) s.pageSize = DEFAULT_SETTINGS.pageSize;
    if (typeof s.sort !== 'string') s.sort = DEFAULT_SETTINGS.sort;
    if (!Array.isArray(s.favorites)) s.favorites = [];
    // Retire old settings: previously hidden files become visible again.
    if ('hidden' in s || 'showHidden' in s || 'trashRetentionDays' in s) {
        delete s.hidden;
        delete s.showHidden;
        delete s.trashRetentionDays;
        saveSettings();
    }
    // Trash must always be an array, but we DON'T rebuild it on every call —
    // getSettings() sits in hot render paths (filtering, folder counts, every
    // card), so re-allocating the array + its records each time would add real
    // CPU/GC pressure with a large bin. Migration of legacy shapes (plain
    // string paths) happens once, lazily, via normalizeTrashOnce().
    if (!Array.isArray(s.trash)) s.trash = [];
    return s;
}

/** One-time migration: coerce any legacy/odd trash entries into { path, date }
 *  records. Runs at startup and is a no-op once the list is already clean, so
 *  the per-call getSettings() can safely assume well-formed records. */
function normalizeTrashOnce() {
    const c = ctx();
    const s = c.extensionSettings[SETTINGS_KEY];
    if (!s || !Array.isArray(s.trash) || !s.trash.length) return;
    let changed = false;
    const cleaned = [];
    for (const entry of s.trash) {
        if (entry && typeof entry === 'object' && typeof entry.path === 'string'
            && typeof entry.date === 'number') {
            cleaned.push(entry);
            continue;
        }
        changed = true;
        if (typeof entry === 'string') {
            cleaned.push({ path: entry, date: Date.now() });
        } else if (entry && typeof entry.path === 'string') {
            cleaned.push({ path: entry.path, date: Number(entry.date) || Date.now() });
        }
        // anything else is dropped (changed already flagged)
    }
    if (changed) {
        s.trash = cleaned;
        saveSettings();
    }
}

function saveSettings() {
    ctx().saveSettingsDebounced();
}

function getFavoriteSet() {
    return new Set(getSettings().favorites);
}

function isFavorite(path) {
    return getSettings().favorites.includes(path);
}

/** Filter before confirming, then check again at the actual mutation. */
function unprotectedPaths(paths) {
    const favorites = getFavoriteSet();
    const allowed = paths.filter(p => !favorites.has(p));
    if (allowed.length !== paths.length) toastr.info(t('favorite.protected'));
    return allowed;
}

/* ---------- Trash (soft recycle bin) ----------
 * The trash is a list of { path, date } records in settings. Files are NOT
 * touched on disk — they're just hidden from every normal view and gathered
 * into the dedicated "Trash" folder, where they can be restored or purged for
 * good. Favorites cannot be moved here. */
function getTrashSet() {
    return new Set(getSettings().trash.map(e => e.path));
}

/** Move unprotected paths into the trash (records the current time). */
function addPathsToTrash(paths) {
    const s = getSettings();
    const existing = new Set(s.trash.map(e => e.path));
    const favorites = getFavoriteSet();
    const now = Date.now();
    let added = 0;
    for (const p of paths) {
        if (existing.has(p) || favorites.has(p) || state.deleting.has(p)) continue;
        s.trash.push({ path: p, date: now });
        existing.add(p);
        added++;
    }
    saveSettings();
    invalidateFilterCache();
    return added;
}

/** Restore paths from the trash back to their normal (visible) state. */
function restorePathsFromTrash(paths) {
    const s = getSettings();
    const drop = new Set(paths);
    const before = s.trash.length;
    s.trash = s.trash.filter(e => !drop.has(e.path));
    saveSettings();
    invalidateFilterCache();
    return before - s.trash.length;
}

/* ---------- device-local UI preferences (localStorage) ---------- */
function loadMode() {
    const raw = localStorage.getItem(LS_MODE);
    return raw === 'floating' ? 'floating' : 'modal';
}

function saveMode(value) {
    localStorage.setItem(LS_MODE, value === 'floating' ? 'floating' : 'modal');
}

function loadCols() {
    const raw = Number(localStorage.getItem(LS_COLS));
    return COLS_OPTIONS.includes(raw) ? raw : DEFAULT_COLS;
}

function saveCols(value) {
    const v = COLS_OPTIONS.includes(Number(value)) ? Number(value) : DEFAULT_COLS;
    localStorage.setItem(LS_COLS, String(v));
}

/** Push the chosen cards-per-row count onto the grid as a CSS variable.
 *  The CSS only honours it on the mobile layout (where columns are flexible);
 *  on desktop the grid auto-fills fixed-width cards, so this is a no-op there. */
function applyCols() {
    const grid = state.dom.grid;
    if (grid) grid.style.setProperty('--im-cols', String(state.cols));
    // Reflect the current count in the toolbar button label, if present.
    if (state.dom.colsLabel) state.dom.colsLabel.textContent = String(state.cols);
}

/** Cycle to the next cards-per-row option (2 -> 3 -> 4 -> 2). */
function cycleCols() {
    const idx = COLS_OPTIONS.indexOf(state.cols);
    state.cols = COLS_OPTIONS[(idx + 1) % COLS_OPTIONS.length];
    saveCols(state.cols);
    applyCols();
}

/* ---------- desktop folder-sidebar width / collapse ---------- */
function clampSidebarWidth(px) {
    const n = Number(px);
    if (!Number.isFinite(n)) return SIDEBAR_DEFAULT_W;
    return Math.min(Math.max(n, SIDEBAR_MIN_W), SIDEBAR_MAX_W);
}

function loadSidebarWidth() {
    return clampSidebarWidth(localStorage.getItem(LS_SIDEBAR_W) || SIDEBAR_DEFAULT_W);
}

function saveSidebarWidth(px) {
    localStorage.setItem(LS_SIDEBAR_W, String(clampSidebarWidth(px)));
}

function loadSidebarCollapsed() {
    return localStorage.getItem(LS_SIDEBAR_COLLAPSED) === '1';
}

function saveSidebarCollapsed(on) {
    localStorage.setItem(LS_SIDEBAR_COLLAPSED, on ? '1' : '0');
}

/* ---------- manager theme ---------- */
function loadTheme() {
    const raw = localStorage.getItem(LS_THEME);
    return THEME_IDS.includes(raw) ? raw : DEFAULT_THEME;
}

function saveTheme(id) {
    const v = THEME_IDS.includes(id) ? id : DEFAULT_THEME;
    localStorage.setItem(LS_THEME, v);
}

/** Stamp the chosen theme onto the main panel. `adaptive` removes the marker so
 *  the manager keeps following the live SillyTavern theme. The full-size image
 *  viewer (a separate popup) is themed on the fly when it opens, via
 *  applyThemeTo(). */
function applyTheme() {
    const id = state.theme || DEFAULT_THEME;
    applyThemeTo(state.dom.panel);
    // Keep the picker's active-row highlight in sync if the menu is built.
    if (state.dom.themeMenu) {
        state.dom.themeMenu.querySelectorAll('.im_theme_item').forEach((el) => {
            el.classList.toggle('is-active', el.dataset.theme === id);
        });
    }
}

/** Apply the current theme attribute to an arbitrary element (used for both the
 *  main panel and the viewer popup so they stay visually consistent). */
function applyThemeTo(el) {
    if (!el) return;
    const id = state.theme || DEFAULT_THEME;
    if (id === 'adaptive') el.removeAttribute('data-im-theme');
    else el.setAttribute('data-im-theme', id);
}

/** Build the theme picker dropdown rows once. */
function buildThemeMenu() {
    const menu = state.dom.themeMenu;
    if (!menu) return;
    menu.innerHTML = '';
    for (const theme of THEMES) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'im_theme_item';
        btn.dataset.theme = theme.id;
        if (theme.id === (state.theme || DEFAULT_THEME)) btn.classList.add('is-active');

        const swatch = document.createElement('span');
        swatch.className = 'im_theme_swatch';
        swatch.style.setProperty('--sw-accent', theme.accent);
        swatch.style.setProperty('--sw-bg', theme.bg);

        const label = document.createElement('span');
        label.className = 'im_theme_label';
        label.textContent = t(theme.i18n);

        btn.appendChild(swatch);
        btn.appendChild(label);
        btn.addEventListener('click', () => {
            setTheme(theme.id);
            closeThemeMenu();
        });
        menu.appendChild(btn);
    }
}

function setTheme(id) {
    state.theme = THEME_IDS.includes(id) ? id : DEFAULT_THEME;
    saveTheme(state.theme);
    applyTheme();
}

function toggleThemeMenu() {
    const menu = state.dom.themeMenu;
    if (!menu) return;
    if (menu.classList.contains('im_hidden')) openThemeMenu();
    else closeThemeMenu();
}

function openThemeMenu() {
    const menu = state.dom.themeMenu;
    if (!menu) return;
    buildThemeMenu(); // rebuild so the active row reflects the current theme
    menu.classList.remove('im_hidden');
    // Close on the next outside click.
    setTimeout(() => document.addEventListener('click', onThemeOutsideClick, true), 0);
}

function closeThemeMenu() {
    state.dom.themeMenu?.classList.add('im_hidden');
    document.removeEventListener('click', onThemeOutsideClick, true);
}

function onThemeOutsideClick(e) {
    const wrap = state.dom.themeToggle?.closest('.im_theme_wrap');
    if (wrap && !wrap.contains(e.target)) closeThemeMenu();
}

/** Push the desktop sidebar width / collapsed state onto the DOM. The CSS only
 *  acts on this in the desktop layout; on mobile the sidebar is a dropdown. */
function applySidebarSize() {
    const content = state.dom.content;
    if (!content) return;
    content.style.setProperty('--im-sidebar-w', `${state.sidebarWidth}px`);
    content.classList.toggle('im_sidebar_collapsed', state.sidebarCollapsed);
}

function toggleSidebarCollapsed() {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    saveSidebarCollapsed(state.sidebarCollapsed);
    applySidebarSize();
}

function loadFloatBox() {
    try {
        const raw = JSON.parse(localStorage.getItem(LS_FLOAT) || 'null');
        if (raw && typeof raw === 'object'
            && Number.isFinite(raw.left) && Number.isFinite(raw.top)
            && Number.isFinite(raw.width) && Number.isFinite(raw.height)) {
            return raw;
        }
    } catch (e) { /* ignore */ }
    return null;
}

function saveFloatBox(box) {
    try { localStorage.setItem(LS_FLOAT, JSON.stringify(box)); } catch (e) { /* ignore */ }
}

/** A sensible default window box (top-right area, clamped to the viewport). */
function defaultFloatBox() {
    const width = Math.min(460, window.innerWidth - 24);
    const height = Math.min(640, window.innerHeight - 24);
    const left = Math.max(12, window.innerWidth - width - 24);
    const top = Math.max(12, (window.innerHeight - height) / 3);
    return { left, top, width, height };
}

/** Keep a box inside the viewport. */
function clampFloatBox(box) {
    const minW = 320, minH = 300;
    box.width = Math.min(Math.max(minW, box.width), window.innerWidth - 8);
    box.height = Math.min(Math.max(minH, box.height), window.innerHeight - 8);
    box.left = Math.min(Math.max(0, box.left), window.innerWidth - box.width);
    box.top = Math.min(Math.max(0, box.top), window.innerHeight - box.height);
    return box;
}

/** True on phones / narrow screens / touch — floating is forced off there so
 *  the panel uses the full-screen mobile layout instead. */
function isMobileLayout() {
    return window.matchMedia('(max-width: 1000px), (pointer: coarse)').matches;
}

/** Push the floating box onto the panel as inline styles. */
function applyFloatBox() {
    const panel = state.dom.panel;
    if (!panel || !state.floatBox) return;
    const b = state.floatBox;
    panel.style.left = `${b.left}px`;
    panel.style.top = `${b.top}px`;
    panel.style.width = `${b.width}px`;
    panel.style.height = `${b.height}px`;
}

/** Clear inline floating styles (back to centered modal). */
function clearFloatBox() {
    const panel = state.dom.panel;
    if (!panel) return;
    panel.style.left = panel.style.top = panel.style.width = panel.style.height = '';
}

/** Apply the modal/floating mode to the DOM. */
function applyMode() {
    const modal = state.dom.modal;
    if (!modal) return;
    // Floating is desktop-only; on mobile always use the full-screen layout.
    const isFloating = state.mode === 'floating' && !isMobileLayout();
    modal.classList.toggle('im_floating', isFloating);
    // Scroll-lock the page only for the centered (non-floating) modal.
    document.body.classList.toggle('im_modal_open', !isFloating && state.isOpen);

    if (isFloating) {
        if (!state.floatBox) state.floatBox = loadFloatBox() || defaultFloatBox();
        clampFloatBox(state.floatBox);
        applyFloatBox();
    } else {
        clearFloatBox();
    }

    if (state.dom.floatLabel) {
        state.dom.floatLabel.textContent = isFloating ? t('header.center') : t('header.float');
    }
}

/* ---------- Draggable folder-sidebar divider (desktop) ---------- */
function initSidebarResizer() {
    const resizer = state.dom.sidebarResizer;
    const content = state.dom.content;
    if (!resizer || !content) return;

    let dragging = false;

    const onMove = (e) => {
        if (!dragging) return;
        const x = (e.touches && e.touches[0]) ? e.touches[0].clientX : e.clientX;
        // Width = pointer X relative to the content box's left edge.
        const rect = content.getBoundingClientRect();
        state.sidebarWidth = clampSidebarWidth(x - rect.left);
        // Dragging implies the sidebar is shown.
        if (state.sidebarCollapsed) {
            state.sidebarCollapsed = false;
            saveSidebarCollapsed(false);
        }
        applySidebarSize();
        e.preventDefault();
    };
    const onEnd = () => {
        if (!dragging) return;
        dragging = false;
        content.classList.remove('im_sidebar_dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onEnd);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onEnd);
        saveSidebarWidth(state.sidebarWidth);
    };
    const onStart = (e) => {
        if (dragging) return;
        if (isMobileLayout()) return; // mobile uses the dropdown, not the divider
        dragging = true;
        content.classList.add('im_sidebar_dragging');
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onEnd);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onEnd);
        e.preventDefault();
    };

    resizer.addEventListener('mousedown', onStart);
    resizer.addEventListener('touchstart', onStart, { passive: false });
    // Double-click the divider to collapse / restore the sidebar.
    resizer.addEventListener('dblclick', (e) => {
        e.preventDefault();
        toggleSidebarCollapsed();
    });
}

/* ---------- Drag & resize for the floating window ---------- */
function initFloatingInteractions() {
    const header = state.dom.header;
    const handle = state.dom.resizeHandle;

    const pointXY = (e) => (e.touches && e.touches[0])
        ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
        : { x: e.clientX, y: e.clientY };

    // Re-entry guard: if a previous drag/resize never received its mouseup
    // (e.g. the button was released outside the window), starting a new one
    // would stack a second set of document listeners that never get removed.
    // The flag makes a fresh gesture a no-op until the previous one ends.
    let interacting = false;

    // --- DRAG (header) ---
    const startDrag = (e) => {
        if (interacting) return;
        if (state.mode !== 'floating' || isMobileLayout()) return;
        if (e.target.closest('button')) return; // don't drag when tapping buttons
        if (!state.floatBox) return;
        interacting = true;
        const p = pointXY(e);
        const start = { x: p.x, y: p.y, left: state.floatBox.left, top: state.floatBox.top };
        state.dom.modal.classList.add('im_dragging');

        const move = (ev) => {
            const m = pointXY(ev);
            state.floatBox.left = start.left + (m.x - start.x);
            state.floatBox.top = start.top + (m.y - start.y);
            clampFloatBox(state.floatBox);
            applyFloatBox();
            ev.preventDefault();
        };
        const end = () => {
            interacting = false;
            state.dom.modal.classList.remove('im_dragging');
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', end);
            document.removeEventListener('touchmove', move);
            document.removeEventListener('touchend', end);
            saveFloatBox(state.floatBox);
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', end);
        document.addEventListener('touchmove', move, { passive: false });
        document.addEventListener('touchend', end);
        e.preventDefault();
    };
    header?.addEventListener('mousedown', startDrag);
    header?.addEventListener('touchstart', startDrag, { passive: false });

    // --- RESIZE (corner handle) ---
    const startResize = (e) => {
        if (interacting) return;
        if (state.mode !== 'floating' || isMobileLayout() || !state.floatBox) return;
        interacting = true;
        const p = pointXY(e);
        const start = { x: p.x, y: p.y, w: state.floatBox.width, h: state.floatBox.height };
        state.dom.modal.classList.add('im_dragging');

        const move = (ev) => {
            const m = pointXY(ev);
            state.floatBox.width = start.w + (m.x - start.x);
            state.floatBox.height = start.h + (m.y - start.y);
            clampFloatBox(state.floatBox);
            applyFloatBox();
            ev.preventDefault();
        };
        const end = () => {
            interacting = false;
            state.dom.modal.classList.remove('im_dragging');
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', end);
            document.removeEventListener('touchmove', move);
            document.removeEventListener('touchend', end);
            saveFloatBox(state.floatBox);
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', end);
        document.addEventListener('touchmove', move, { passive: false });
        document.addEventListener('touchend', end);
        e.preventDefault();
        e.stopPropagation();
    };
    handle?.addEventListener('mousedown', startResize);
    handle?.addEventListener('touchstart', startResize, { passive: false });
}

/* ============================================================
 * SERVER API
 * ============================================================ */
async function apiGetFolders() {
    try {
        const res = await fetch('/api/images/folders', {
            method: 'POST',
            headers: reqHeaders(),
            body: JSON.stringify({}),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return Array.isArray(data) ? data : null;
    } catch (error) {
        console.error(`[${MODULE_NAME}] Failed to fetch folders`, error);
        return null;
    }
}

async function apiListImages(folder, sortField = 'date', sortOrder = 'desc') {
    try {
        const res = await fetch('/api/images/list', {
            method: 'POST',
            headers: reqHeaders(),
            body: JSON.stringify({
                folder: folder,
                sortField,
                sortOrder,
                // 1 = IMAGE, 2 = VIDEO (bitwise). Request both.
                type: 1 | 2,
            }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return Array.isArray(data) ? data : null;
    } catch (error) {
        console.error(`[${MODULE_NAME}] Failed to list images in "${folder}"`, error);
        return null;
    }
}

async function apiDeleteImage(userRelativePath) {
    if (isFavorite(userRelativePath) || state.deleting.has(userRelativePath)) return false;
    state.deleting.add(userRelativePath);
    try {
        const res = await fetch('/api/images/delete', {
            method: 'POST',
            headers: reqHeaders(),
            body: JSON.stringify({ path: userRelativePath }),
        });
        return res.ok;
    } catch (error) {
        console.error(`[${MODULE_NAME}] Failed to delete "${userRelativePath}"`, error);
        return false;
    } finally {
        state.deleting.delete(userRelativePath);
    }
}

/**
 * Lazily fetch the byte size of an image via a HEAD request (Content-Length).
 * Light on bandwidth — we never download the body.
 */
async function fetchSize(url) {
    try {
        const res = await fetch(url, { method: 'HEAD', headers: reqHeaders({}) });
        if (!res.ok) return null;
        const len = res.headers.get('content-length');
        const size = len?.trim() ? Number(len) : NaN;
        if (Number.isFinite(size) && size >= 0) return size;
    } catch (error) {
        /* ignore — size just stays unknown */
    }
    return null;
}

/* ============================================================
 * DATA LOADING
 * ============================================================ */
async function loadAll() {
    // Re-entry guard: spam-clicking Refresh (or open + refresh) must not run
    // two overlapping scans that interleave their state writes.
    if (state.isLoading) return;
    state.isLoading = true;
    renderLoading(true);

    try {
        const folderNames = await apiGetFolders();
        if (!folderNames) {
            toastr.error(t('toast.loadFailed'));
            return;
        }
        // The root folder isn't returned by /folders (only sub-dirs), but listing
        // with an empty-ish folder returns the root files. We add a synthetic root.
        // All folders are listed IN PARALLEL (limited concurrency) — the previous
        // one-at-a-time loop meant a library with 100 characters took 100 serial
        // round trips to open.
        const CONCURRENCY = 6;
        const jobs = [
            { name: ROOT_FOLDER, label: '(root)', query: '.' },
            ...folderNames.map(name => ({ name, label: name, query: name })),
        ];
        const results = new Array(jobs.length);
        let next = 0;
        const worker = async () => {
            while (next < jobs.length) {
                const i = next++;
                results[i] = await apiListImages(jobs[i].query);
            }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
        if (results.some(files => files === null)) {
            // Keep the last complete snapshot and its protection/trash metadata.
            toastr.error(t('toast.loadFailed'));
            return;
        }

        const folders = [];
        for (let i = 0; i < jobs.length; i++) {
            const files = results[i] || [];
            // Keep the synthetic root only when it actually has files.
            if (jobs[i].name === ROOT_FOLDER && !files.length) continue;
            folders.push({ name: jobs[i].name, label: jobs[i].label, files });
        }

        state.folders = folders;

        // Flatten
        const images = [];
        let seq = 0;
        for (const f of folders) {
            const folderSeg = f.name === ROOT_FOLDER ? '' : `${encodeURIComponent(f.name)}/`;
            const rawSeg = f.name === ROOT_FOLDER ? '' : `${f.name}/`;
            for (const file of f.files) {
                images.push({
                    folder: f.name,
                    folderLabel: f.label,
                    file,
                    // user-relative path used by the delete endpoint
                    path: `user/images/${rawSeg}${file}`,
                    // browser URL (encoded)
                    url: `user/images/${folderSeg}${encodeURIComponent(file)}`,
                    isVideo: isVideoFile(file),
                    // Real date sort key: timestamp embedded in the file name
                    // (ST names inline images with Date.now()). null if unknown.
                    mtime: extractTimestamp(file),
                    // Stable fallback ordering: API order within a folder (newer
                    // first), then a global sequence so the sort is deterministic.
                    seq: seq++,
                });
            }
        }
        state.images = images;
        // O(1) path -> image lookups for the size queue / card wiring.
        state.imageByPath = new Map(images.map(i => [i.path, i]));
        invalidateFilterCache();

        // Garbage-collect trash records whose files no longer exist on
        // disk (deleted outside the manager). Without this the settings arrays
        // grow forever and slowly poison every filter pass.
        gcStaleSettingPaths();

        // On a fresh open, jump straight to the folder of the character you're
        // currently chatting with (so you don't have to hunt for it every time you
        // reload the page). Only do this once per open, only if that folder
        // actually exists, and never override an explicit folder pick or a refresh.
        if (state.autoFolderPending) {
            state.autoFolderPending = false;
            const charFolder = getCurrentCharFolder();
            if (charFolder && folders.some(f => f.name === charFolder)) {
                state.activeFolder = charFolder;
                state.currentPage = 1;
                updateSidebarLabel();
            }
        }
    } finally {
        state.isLoading = false;
        renderLoading(false);
    }
    render();

    // Kick off lazy size fetching for visible page
    queueVisibleSizes();

}

/** Clean trash metadata only after a complete successful scan. Favorite paths
 *  stay protected even if a file temporarily disappears outside the manager. */
function gcStaleSettingPaths() {
    if (!state.imageByPath || !state.imageByPath.size) return;
    const s = getSettings();
    let dirty = false;
    const trashBefore = s.trash.length;
    s.trash = s.trash.filter(e => state.imageByPath.has(e.path));
    if (s.trash.length !== trashBefore) dirty = true;
    if (dirty) {
        saveSettings();
        invalidateFilterCache();
    }
}

/* ============================================================
 * SIZE QUEUE (lazy, throttled)
 * ============================================================ */
function queueVisibleSizes() {
    if (!state.isOpen) return;
    const visible = getPageImages();
    for (const img of visible) {
        if (!state.sizeCache.has(img.path) && !state.sizeQueued.has(img.path)) {
            state.sizeQueue.push(img.path);
            state.sizeQueued.add(img.path);
        }
    }
    // Also measure the whole current view so the total MB in the summary is
    // complete (visible page is prioritised because it's queued first).
    queueFolderSizes();
    runSizeQueue();
}

/** Prioritise the current view, then measure other folders for sidebar totals.
 *  Only HEAD requests, throttled by runSizeQueue and stopped on close. */
function queueFolderSizes() {
    for (const img of [...getFilteredImages(), ...state.images]) {
        if (!state.sizeCache.has(img.path) && !state.sizeQueued.has(img.path)) {
            state.sizeQueue.push(img.path);
            state.sizeQueued.add(img.path);
        }
    }
    runSizeQueue();
}

/** Drop all pending size lookups (e.g. when the manager closes — no point
 *  hammering the server with HEAD requests for a window nobody sees). */
function drainSizeQueue() {
    state.sizeQueue.length = 0;
    state.sizeQueued.clear();
}

async function runSizeQueue() {
    if (state.sizeRunning) return;
    state.sizeRunning = true;
    const CONCURRENCY = 4;
    let sinceRefresh = 0;

    const worker = async () => {
        while (state.sizeQueue.length) {
            const path = state.sizeQueue.shift();
            state.sizeQueued.delete(path);
            const img = state.imageByPath.get(path);
            if (!img) continue;
            const size = await fetchSize(img.url);
            state.sizeCache.set(path, size);
            updateCardSize(path, size);
            // Periodically refresh the running totals so the MB figures tick
            // up. Text-only updates — no full re-render / re-sort per tick.
            if (++sinceRefresh >= 8) {
                sinceRefresh = 0;
                updateViewSummaryText();
                updateStorageSummary();
                updateFolderStats();
            }
        }
    };

    try {
        const workers = [];
        for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
        await Promise.all(workers);
    } catch (error) {
        // A worker throwing must never permanently wedge the queue: without the
        // finally below, state.sizeRunning would stay true and all future size
        // scanning would silently stop for the rest of the session.
        console.warn(`[${MODULE_NAME}] size queue error`, error);
    } finally {
        state.sizeRunning = false;
    }
    // Size sorting depends on the cache we just filled — re-sort once at the
    // end of the scan (not per-file) so the grid settles into the right order.
    if (state.sort.startsWith('size') && state.isOpen) {
        invalidateFilterCache();
        renderGrid();
    }
    renderPageControls();
    updateStorageSummary();
    updateFolderStats();
}

function updateCardSize(path, size) {
    const el = state.dom.grid?.querySelector(`[data-path="${cssEscape(path)}"] .im_card_size`);
    if (el) el.textContent = size != null ? humanSize(size) : '—';
}

function cssEscape(str) {
    if (window.CSS && CSS.escape) return CSS.escape(str);
    return String(str).replace(/["\\]/g, '\\$&');
}

/* ============================================================
 * FILTERING / SORTING / PAGING
 * ============================================================ */
/**
 * A single comparable "age" key for date sorting, where a BIGGER value means
 * NEWER. This unifies dated and undated files onto one scale so the order is
 * consistent (and direction-aware) in the mixed "All images" view.
 *
 *  - Files with a real timestamp in their name use it directly (ms since
 *    epoch — always > 0 for sane dates).
 *  - Files WITHOUT a timestamp can't be dated, so they all sort as "older than
 *    everything dated" by getting a negative key. Within that group they keep
 *    a stable order derived from the global sequence (the API lists each
 *    folder newest-first, so a smaller seq means newer → negate it so newer
 *    still maps to a bigger key).
 */
function dateSortKey(img) {
    if (img.mtime != null) return img.mtime;
    // Undated: park below any real timestamp (negative), newer-first within the
    // group. -1 offset guarantees the key stays strictly negative.
    return -1 - img.seq;
}

/* getFilteredImages() used to do a full filter + sort of the whole library on
 * EVERY call — and one render() calls it 5-6 times (grid, page controls,
 * summary, folder counts, page slice), with the size scanner re-triggering
 * renders in the background. On big libraries that was constant jank. The
 * result is now memoised: mutators bump `filterVersion` and the cached list is
 * reused until either the version or one of the cheap view inputs changes. */
let filterVersion = 0;

function invalidateFilterCache() {
    filterVersion++;
    state.filterCache = null;
}

function getFilteredImages() {
    const cacheKey = [
        filterVersion,
        state.activeFolder,
        state.sort,
    ].join('\u0000');
    if (state.filterCache && state.filterCache.key === cacheKey) {
        return state.filterCache.list;
    }

    const favorites = getFavoriteSet();
    const trashed = getTrashSet();
    const trashView = state.activeFolder === TRASH_FOLDER;

    const list = state.images.filter((img) => {
        const isTrashedImg = trashed.has(img.path);
        // The Trash view shows ONLY trashed images (across every folder); every
        // other view excludes them entirely.
        if (trashView) {
            if (!isTrashedImg) return false;
        } else {
            if (isTrashedImg) return false;
            if (state.activeFolder === FAVORITES_FOLDER) return favorites.has(img.path);
            if (state.activeFolder !== ALL_FOLDERS && img.folder !== state.activeFolder) return false;
        }
        return true;
    });

    const [field, order] = state.sort.split('-');
    const dir = order === 'asc' ? 1 : -1;
    list.sort((a, b) => {
        const pinned = Number(favorites.has(b.path)) - Number(favorites.has(a.path));
        if (pinned) return pinned;
        if (field === 'name') {
            return a.file.localeCompare(b.file, undefined, { numeric: true }) * dir;
        }
        if (field === 'size') {
            // Sizes are collected lazily via HEAD requests, so some may still be
            // unknown — those always sink to the END of the list (regardless of
            // direction) instead of polluting the top. The order refines itself
            // as the background scan fills the cache in.
            const sa = state.sizeCache.get(a.path);
            const sb = state.sizeCache.get(b.path);
            const ha = sa != null;
            const hb = sb != null;
            if (ha !== hb) return ha ? -1 : 1;      // unknown sizes last
            if (ha && sa !== sb) return (sa - sb) * dir;
            return (b.seq - a.seq) * dir;            // deterministic tie-break
        }
        // Date sort. Every image gets a single comparable numeric "age" key so
        // the order is consistent and direction-aware even in the "All images"
        // view where dated and undated files from different folders are mixed.
        // A BIGGER key always means NEWER, so `* dir` cleanly flips
        // Newest/Oldest for the whole list at once.
        const ka = dateSortKey(a);
        const kb = dateSortKey(b);
        if (ka !== kb) return (ka - kb) * dir;
        // Exact tie (e.g. two undated files): keep a deterministic order.
        return (b.seq - a.seq) * dir;
    });

    state.filterCache = { key: cacheKey, list };
    return list;
}

/** Total number of pages for the current filtered set. */
function getPageCount() {
    const total = getFilteredImages().length;
    return Math.max(1, Math.ceil(total / state.pageSize));
}

/** Clamp currentPage into a valid range and return it. */
function clampPage() {
    const pages = getPageCount();
    if (state.currentPage < 1) state.currentPage = 1;
    if (state.currentPage > pages) state.currentPage = pages;
    return state.currentPage;
}

/** The slice of images shown on the current page. */
function getPageImages() {
    const all = getFilteredImages();
    clampPage();
    const start = (state.currentPage - 1) * state.pageSize;
    return all.slice(start, start + state.pageSize);
}

/** Jump to a page and re-render the grid (scrolls back to top). */
function goToPage(page) {
    state.currentPage = page;
    clampPage();
    renderGrid();
    renderPageControls();
    queueVisibleSizes();
    if (state.dom.grid) state.dom.grid.scrollTop = 0;
}

/* ============================================================
 * RENDER
 * ============================================================ */
function render() {
    if (!state.dom.grid) return;
    renderFolders();
    renderBreadcrumb();
    renderGrid();
    renderPageControls();
    renderSelectBar();
    renderTrashControls();
    updateStorageSummary();
}

function renderLoading(show) {
    if (!state.dom.loading) return;
    state.dom.loading.classList.toggle('im_hidden', !show);
}

/** Match sidebar counts to each view; trashed files count only in the bin. */
function getFolderStats() {
    const stats = new Map();
    const favorites = getFavoriteSet();
    const trashed = getTrashSet();
    const add = (folder, size) => {
        let entry = stats.get(folder);
        if (!entry) stats.set(folder, entry = { count: 0, bytes: 0, known: 0, pending: 0 });
        entry.count++;
        if (size === undefined) entry.pending++;
        if (Number.isFinite(size) && size >= 0) {
            entry.bytes += size;
            entry.known++;
        }
    };
    for (const img of state.images) {
        const size = state.sizeCache.get(img.path);
        if (trashed.has(img.path)) add(TRASH_FOLDER, size);
        else {
            add(ALL_FOLDERS, size);
            add(img.folder, size);
            if (favorites.has(img.path)) add(FAVORITES_FOLDER, size);
        }
    }
    return stats;
}

/** Text-only updates preserve sidebar focus and scroll during background scans. */
function updateFolderStats() {
    const list = state.dom.folderList;
    if (!list) return;
    const stats = getFolderStats();
    list.querySelectorAll('.im_folder_item').forEach(button => {
        const entry = stats.get(button.dataset.folder) || { count: 0, bytes: 0, known: 0, pending: 0 };
        let size = humanSize(entry.bytes);
        if (entry.count && !entry.known) size = entry.pending ? '…' : '—';
        else if (entry.known < entry.count) size = `~${size}${entry.pending ? '…' : ''}`;
        button.querySelector('.im_folder_count').textContent = entry.count;
        const label = button.querySelector('.im_folder_size');
        label.textContent = size;
        label.title = t(entry.known < entry.count ? 'folder.sizePartial' : 'folder.size');
    });
}

function renderFolders() {
    const list = state.dom.folderList;
    if (!list) return;

    // Toolbar folder finder: narrows the sidebar folder list down by name.
    const folderQuery = state.folderSearch.trim().toLowerCase();

    const entries = [{ name: ALL_FOLDERS, label: t('folder.all'), icon: 'fa-layer-group' }];
    entries.push({ name: FAVORITES_FOLDER, label: t('folder.favorites'), icon: 'fa-star' });
    for (const f of state.folders) {
        const label = f.name === ROOT_FOLDER ? t('folder.root') : f.name;
        // "All images" and the trash stay visible regardless of the filter —
        // only the character folders are narrowed down.
        if (folderQuery && !label.toLowerCase().includes(folderQuery)) continue;
        entries.push({ name: f.name, label, icon: 'fa-folder' });
    }
    // The recycle bin sits at the bottom of the folder list.
    entries.push({ name: TRASH_FOLDER, label: t('folder.trash'), icon: 'fa-trash-can' });

    list.innerHTML = entries.map((e) => {
        const active = e.name === state.activeFolder ? ' is-active' : '';
        return `<button type="button" class="im_folder_item${active}" data-folder="${escapeHtml(e.name)}" title="${escapeHtml(e.label)}">
            <i class="fa-solid ${e.icon}"></i>
            <span class="im_folder_name">${escapeHtml(e.label)}</span>
            <span class="im_folder_stats"><span class="im_folder_count"></span><span class="im_folder_size"></span></span>
        </button>`;
    }).join('');

    list.querySelectorAll('.im_folder_item').forEach((btn) => {
        btn.addEventListener('click', () => selectFolder(btn.dataset.folder));
    });
    updateFolderStats();
}

/** Switch the active folder view and refresh everything. Shared by the sidebar
 *  folder list and the clickable folder tag on each card. */
function selectFolder(folderName) {
    if (!folderName) return;
    state.autoFolderPending = false;
    state.selected.clear();
    state.activeFolder = folderName;
    state.currentPage = 1;
    updateSidebarLabel();
    collapseSidebarOnMobile();
    render();
    queueVisibleSizes();
    if (state.dom.grid) state.dom.grid.scrollTop = 0;
}

function updateSidebarLabel() {
    if (!state.dom.sidebarToggleLabel) return;
    state.dom.sidebarToggleLabel.textContent = folderLabel(state.activeFolder);
}

/** Human label for a folder id (handles the synthetic All/root/trash views). */
function folderLabel(f) {
    if (f === ALL_FOLDERS) return t('folder.all');
    if (f === ROOT_FOLDER) return t('folder.root');
    if (f === TRASH_FOLDER) return t('folder.trash');
    if (f === FAVORITES_FOLDER) return t('folder.favorites');
    return f;
}

function collapseSidebarOnMobile() {
    // Same breakpoint as the rest of the mobile layout (was a hardcoded 768
    // that disagreed with the CSS media queries / isMobileLayout()).
    if (isMobileLayout() && state.dom.sidebar) {
        state.dom.sidebar.classList.add('is-collapsed');
    }
}

function renderBreadcrumb() {
    if (!state.dom.breadcrumb) return;
    const f = state.activeFolder;
    const label = folderLabel(f);
    if (f === FAVORITES_FOLDER) {
        state.dom.breadcrumb.innerHTML = `<i class="fa-solid fa-star"></i> ${escapeHtml(label)}`;
        return;
    }

    if (f === TRASH_FOLDER) {
        // The trash view gets its own icon + a quiet hint explaining that items
        // here are NOT yet removed from disk (they still take up space).
        state.dom.breadcrumb.innerHTML =
            `<i class="fa-solid fa-trash-can"></i> ${escapeHtml(label)} `
            + `<i class="fa-solid fa-circle-info im_folder_hint" title="${escapeHtml(t('breadcrumb.trashHint'))}"></i>`;
        return;
    }

    // SillyTavern stores images in /user/images/<character name>/. Characters
    // that share the same name therefore share ONE folder on disk — the server
    // has no way to separate them, and neither do we. Show a quiet hint when a
    // real character folder is open so this isn't mistaken for a bug.
    const sharedHint = (f !== ALL_FOLDERS && f !== ROOT_FOLDER)
        ? ` <i class="fa-solid fa-circle-info im_folder_hint" title="${escapeHtml(t('breadcrumb.sharedHint'))}"></i>`
        : '';

    state.dom.breadcrumb.innerHTML =
        `<i class="fa-solid fa-folder-open"></i> ${escapeHtml(label)}${sharedHint}`;
}

/** True while the user is viewing the recycle bin. */
function inTrashView() {
    return state.activeFolder === TRASH_FOLDER;
}

/* ---------- Lazy media loading (IntersectionObserver) ----------
 * Only the cards actually scrolled into view get their real media URL, so a
 * 240-image page no longer tries to decode 240 files at once (the thing that
 * crashes the tab on phones / Termux). Each media element starts with the URL
 * parked in data-src; the observer promotes it to src on first sight, then
 * stops watching that element. */
let mediaObserver = null;

function promoteMedia(media) {
    if (!media) return;
    const url = media.dataset.src;
    if (!url || media.src) return; // already loaded
    media.src = url;
    if (media.tagName === 'VIDEO') {
        // Now that it's in view, allow the poster frame to load.
        media.preload = 'metadata';
    } else {
        media.loading = 'lazy';
    }
}

function getMediaObserver() {
    if (mediaObserver) return mediaObserver;
    if (!('IntersectionObserver' in window)) return null;
    mediaObserver = new IntersectionObserver((entries, obs) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            promoteMedia(entry.target);
            obs.unobserve(entry.target);
        }
    }, {
        // Start loading a little before the card is fully on screen so it feels
        // instant while scrolling, without loading the whole page up front.
        root: state.dom.grid || null,
        rootMargin: '300px 0px',
        threshold: 0.01,
    });
    return mediaObserver;
}

/** Stop watching every card (called before re-rendering the grid). */
function resetMediaObserver() {
    if (mediaObserver) mediaObserver.disconnect();
}

/** Build the HTML for a single image card. */
function cardHtml(img, favorites) {
    const selected = state.selected.has(img.path) ? ' is-selected' : '';
    const favorite = favorites.has(img.path);
    const cachedSize = state.sizeCache.get(img.path);
    const sizeText = cachedSize != null ? humanSize(cachedSize) : '…';
    // Media tags carry no inline onerror handler (CSP-friendly); the error
    // fallback is wired up in JS in wireCard() instead. A broken/missing file
    // therefore degrades to a placeholder instead of a blank/crashed card.
    //
    // IMPORTANT (performance / mobile stability): we DON'T put the real URL in
    // `src` here. The browser would otherwise try to fetch + decode every image
    // on the page at once — with a big page size (e.g. 240) on a phone / Termux
    // that exhausts memory and crashes the tab ("critical error"). Instead the
    // URL lives in `data-src` and is only promoted to `src` when the card scrolls
    // into view, via an IntersectionObserver wired up in wireCard().
    const media = img.isVideo
        ? `<video class="im_card_media" data-src="${escapeHtml(img.url)}" preload="none" muted></video>`
        : `<img class="im_card_media" data-src="${escapeHtml(img.url)}" alt="">`;
    // In the "All images" / Trash view each card shows which folder (= character)
    // the image belongs to. The tag is clickable: it jumps the view to that
    // folder. In the trash view it's informational only (clicking still works).
    const folderTag = (state.activeFolder === ALL_FOLDERS || state.activeFolder === FAVORITES_FOLDER || inTrashView())
        ? `<button type="button" class="im_card_folder" data-folder="${escapeHtml(img.folder)}" title="${escapeHtml(t('card.openFolder', { folder: img.folderLabel }))}"><i class="fa-solid fa-folder"></i> ${escapeHtml(img.folderLabel)}</button>`
        : '';

    const favoriteTitle = t(favorite ? 'favorite.remove' : 'favorite.add');
    const trashTitle = t(inTrashView() ? 'card.restoreTitle' : 'card.trashTitle');
    const actions = `<button type="button" class="im_card_btn im_favorite_btn" data-act="favorite" aria-pressed="${favorite}" title="${escapeHtml(favoriteTitle)}" aria-label="${escapeHtml(favoriteTitle)}"><i class="${favorite ? 'fa-solid' : 'fa-regular'} fa-star"></i></button>
        <button type="button" class="im_card_btn" data-act="trash" ${favorite && !inTrashView() ? 'disabled' : ''} title="${escapeHtml(trashTitle)}" aria-label="${escapeHtml(trashTitle)}"><i class="fa-solid ${inTrashView() ? 'fa-rotate-left' : 'fa-trash-arrow-up'}"></i></button>
        <button type="button" class="im_card_btn" data-act="more" aria-haspopup="dialog" title="${escapeHtml(t('actions.more'))}" aria-label="${escapeHtml(t('actions.more'))}"><i class="fa-solid fa-ellipsis"></i></button>`;

    return `<div class="im_card${selected}${favorite ? ' is-favorite' : ''}" data-path="${escapeHtml(img.path)}">
        <div class="im_card_thumb">
            ${media}
            <label class="im_card_check" title="${escapeHtml(t('card.selectTitle'))}">
                <input type="checkbox" aria-label="${escapeHtml(t('card.selectTitle'))}" ${state.selected.has(img.path) ? 'checked' : ''}>
            </label>
            ${img.isVideo ? '<span class="im_card_badge"><i class="fa-solid fa-film"></i></span>' : ''}
        </div>
        <div class="im_card_actions">${actions}</div>
        <div class="im_card_meta">
            <span class="im_card_name" title="${escapeHtml(img.file)}">${escapeHtml(img.file)}</span>
            <span class="im_card_size">${escapeHtml(sizeText)}</span>
        </div>
        ${folderTag}
    </div>`;
}

/** Attach click/select handlers to one card element. */
function wireCard(card) {
    const path = card.dataset.path;
    const img = state.imageByPath.get(path);

    card.querySelector('.im_card_check input')?.addEventListener('change', (e) => {
        toggleSelect(path, e.target.checked);
    });

    // Tap the thumbnail (the image itself, not the buttons/checkbox) to open
    // the full-size viewer. This is the natural gesture on phones where there
    // is no hover to reveal the action buttons.
    const media = card.querySelector('.im_card_media');
    if (media) {
        media.tabIndex = 0;
        media.setAttribute('role', 'button');
        media.setAttribute('aria-label', t('card.open', { file: img.file }));
        media.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                viewImage(img);
            }
        });
    }
    media?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (img) viewImage(img);
    });

    // Lazy-load the media: only fetch/decode it once the card scrolls into
    // view, so big pages don't load everything at once and crash on mobile.
    if (media) {
        const obs = getMediaObserver();
        if (obs) obs.observe(media);
        else promoteMedia(media); // no IntersectionObserver -> load eagerly
    }

    // Gracefully handle a media file that fails to load (deleted on disk,
    // corrupt, unsupported codec, network hiccup). Without this the card would
    // show a broken-image glyph or, for videos, an unhandled media error in the
    // console. We swap in a quiet placeholder so the grid never "crashes".
    if (media) {
        media.addEventListener('error', () => {
            if (card.querySelector('.im_card_broken')) return; // already handled
            media.style.display = 'none';
            const ph = document.createElement('div');
            ph.className = 'im_card_broken';
            ph.title = t('media.broken');
            ph.innerHTML = '<i class="fa-solid fa-image"></i>';
            (card.querySelector('.im_card_thumb') || card).insertBefore(ph, media.nextSibling);
        }, { once: true });
    }

    card.querySelectorAll('.im_card_btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const act = btn.dataset.act;
            if (act === 'favorite') toggleFavorite(path);
            else if (act === 'trash') {
                if (inTrashView()) restoreOne(img);
                else trashOne(img);
            }
            else if (act === 'more') showImageActions(img);
        });
    });

    // Click the folder tag (shown in the "All images" view) to jump into that
    // folder. This makes the previously-decorative label actually useful.
    card.querySelector('.im_card_folder')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        selectFolder(e.currentTarget.dataset.folder);
    });
}

function renderGrid() {
    const grid = state.dom.grid;
    if (!grid) return;
    const scrollTop = grid.scrollTop;

    const totalFiltered = getFilteredImages().length;

    if (totalFiltered === 0) {
        resetMediaObserver();
        grid.innerHTML = '';
        if (state.dom.empty) {
            state.dom.empty.classList.remove('im_hidden');
            state.dom.empty.innerHTML =
                `<i class="fa-solid fa-image"></i><span>${escapeHtml(t('empty.none'))}</span>`;
        }
        return;
    }
    state.dom.empty?.classList.add('im_hidden');

    // Render only the current page (e.g. 30/60/... images), so the browser
    // never has to lay out thousands of cards at once. This is what keeps the
    // thumbnails square and the UI responsive.
    const favorites = getFavoriteSet();
    const pageImages = getPageImages();

    // Stop watching the previous page's cards before we replace them, so the
    // observer doesn't hold references to detached nodes.
    resetMediaObserver();
    grid.innerHTML = pageImages.map(img => cardHtml(img, favorites)).join('');
    grid.querySelectorAll('.im_card').forEach(wireCard);

    grid.scrollTop = scrollTop;
}

function renderPageControls() {
    const total = getFilteredImages().length;
    const pages = getPageCount();
    clampPage();

    // Page picker: rebuild the option list only when the page count changes,
    // then sync the selected value to the current page.
    const sel = state.dom.pageSelect;
    if (sel) {
        const needRebuild = Number(sel.dataset.pages) !== pages;
        if (needRebuild) {
            let opts = '';
            for (let p = 1; p <= pages; p++) opts += `<option value="${p}">${p}</option>`;
            sel.innerHTML = opts;
            sel.dataset.pages = String(pages);
        }
        sel.value = String(state.currentPage);
        sel.disabled = pages <= 1;
    }
    if (state.dom.pageTotal) {
        state.dom.pageTotal.textContent = total > 0 ? t('page.of', { pages }) : '';
    }
    updateViewSummaryText();
    if (state.dom.prevPage) state.dom.prevPage.disabled = state.currentPage <= 1;
    if (state.dom.nextPage) state.dom.nextPage.disabled = state.currentPage >= pages;
}

/** Count + total size of the CURRENT view (folder/search). Split out of
 *  renderPageControls() so the background size scanner can refresh just this
 *  text without triggering the heavier page-control work every few files. */
function updateViewSummaryText() {
    if (!state.dom.summary) return;
    // The size is filled in lazily in the background, so it grows as scanning
    // proceeds.
    let known = 0, counted = 0;
    const list = getFilteredImages();
    for (const img of list) {
        const s = state.sizeCache.get(img.path);
        if (s != null) { known += s; counted++; }
    }
    let txt = tImages(list.length);
    if (counted > 0) {
        const scanning = counted < list.length;
        txt += ` · ${scanning ? '~' : ''}${humanSize(known)}${scanning ? '…' : ''}`;
    }
    state.dom.summary.textContent = txt;
}

function renderSelectBar() {
    const bar = state.dom.selectBar;
    if (!bar) return;
    const count = state.selected.size;
    bar.classList.toggle('im_hidden', count === 0);
    if (state.dom.selectCount) {
        state.dom.selectCount.textContent = t('select.count', { count });
    }
    if (state.dom.selectSize) {
        let known = 0;
        let unknown = 0;
        for (const p of state.selected) {
            const s = state.sizeCache.get(p);
            if (s != null) known += s;
            else unknown++;
        }
        state.dom.selectSize.textContent = known > 0
            ? `~${humanSize(known)}${unknown ? ' +?' : ''}`
            : '';
    }

    const trash = inTrashView();
    state.dom.bulkTrash?.classList.toggle('im_hidden', trash);
    state.dom.bulkRestore?.classList.toggle('im_hidden', !trash);
    const favorites = getFavoriteSet();
    const protectedCount = [...state.selected].filter(p => favorites.has(p)).length;
    if (state.dom.selectProtected) {
        state.dom.selectProtected.textContent = protectedCount ? t('favorite.selected', { count: protectedCount }) : '';
    }
    if (state.dom.bulkTrash) state.dom.bulkTrash.disabled = count === protectedCount;
    if (state.dom.bulkDelete) state.dom.bulkDelete.disabled = count === protectedCount;
}

/** Show the trash-only header controls. */
function renderTrashControls() {
    const wrap = state.dom.trashControls;
    if (!wrap) return;
    const trash = inTrashView();
    wrap.classList.toggle('im_hidden', !trash);
}

function updateStorageSummary() {
    if (!state.dom.storageSummary) return;

    // File / folder counts come straight from the API's file lists, so they
    // are always exact — no estimation involved.
    const totalCount = state.images.length;
    const folderCount = state.folders.length;

    let known = 0;
    let counted = 0;
    for (const img of state.images) {
        const s = state.sizeCache.get(img.path);
        if (s != null) { known += s; counted++; }
    }

    const countText = t(
        folderCount === 1 ? 'summary.acrossFolders.one' : 'summary.acrossFolders.many',
        { images: tImages(totalCount), count: folderCount },
    );

    // The size is measured lazily in the background; show it quietly and only
    // mark it approximate while still scanning, without the confusing "N/M".
    let sizeText = '';
    if (counted > 0) {
        const stillScanning = counted < totalCount;
        sizeText = `${stillScanning ? '~' : ''}${humanSize(known)}${stillScanning ? '…' : ''}`;
    }

    state.dom.storageSummary.innerHTML = sizeText
        ? `${escapeHtml(countText)} <span class="im_summary_size">· ${escapeHtml(sizeText)}</span>`
        : escapeHtml(countText);
}

/* ============================================================
 * ACTIONS
 * ============================================================ */
function toggleSelect(path, on) {
    if (on) state.selected.add(path);
    else state.selected.delete(path);
    const card = state.dom.grid?.querySelector(`[data-path="${cssEscape(path)}"]`);
    card?.classList.toggle('is-selected', on);
    // Keep the card's native checkbox in sync. When the toggle comes from
    // outside the grid (e.g. the preview viewer's select button), the card's
    // highlight was updated but the checkbox `.checked` was left stale — so it
    // showed a selected (highlighted) card with an EMPTY checkbox, and the next
    // tap on it just re-checked it (needing a second tap to actually clear).
    const check = card?.querySelector('.im_card_check input');
    if (check) check.checked = on;
    renderSelectBar();
}

function selectAllVisible() {
    for (const img of getPageImages()) state.selected.add(img.path);
    renderGrid();
    renderSelectBar();
}

/** Select EVERY image that matches the current folder/search/filter — across
 *  all pages, not just the one on screen. */
function selectAllFiltered() {
    for (const img of getFilteredImages()) state.selected.add(img.path);
    renderGrid();
    renderSelectBar();
}

function clearSelection() {
    state.selected.clear();
    renderGrid();
    renderSelectBar();
}

function toggleFavorite(path) {
    // A file already being deleted cannot truthfully be pinned/protected.
    if (state.deleting.has(path)) {
        toastr.info(t('favorite.busy'));
        return false;
    }
    const s = getSettings();
    const set = new Set(s.favorites);
    if (set.has(path)) set.delete(path);
    else {
        set.add(path);
        s.trash = s.trash.filter(e => e.path !== path);
    }
    s.favorites = [...set];
    saveSettings();
    invalidateFilterCache();
    render();
    queueVisibleSizes();
    return true;
}

/* ---------- Trash actions ----------
 * Moving to / restoring from the trash never touches the file on disk — only
 * the settings list. Permanent deletion ("purge") is the one that calls the
 * server delete API. All of these refresh the grid + sizes afterwards. */

/** Move a single image into the recycle bin. */
function trashOne(img) {
    if (!img || !unprotectedPaths([img.path]).length) return false;
    if (!addPathsToTrash([img.path])) return false;
    state.selected.delete(img.path);
    toastr.info(t('toast.trashed.one'));
    render();
    queueVisibleSizes();
    return true;
}

/** Restore a single image from the recycle bin. */
function restoreOne(img) {
    if (!img) return;
    restorePathsFromTrash([img.path]);
    state.selected.delete(img.path);
    toastr.success(t('toast.restored.one'));
    render();
    queueVisibleSizes();
}

/** Permanently delete a single image, with a confirm dialog. `purging` only
 *  changes the confirm title (trash view wording). Returns true when the file
 *  was actually deleted — callers (e.g. the viewer) use that to advance.
 *  Shared by the grid's delete/purge buttons and the viewer's delete tool. */
async function deleteOneConfirmed(img, purging) {
    if (!img || !unprotectedPaths([img.path]).length) return false;
    const c = ctx();
    const confirmed = await c.Popup.show.confirm(
        purging ? t('toast.purgeConfirm.titleOne') : t('toast.deleteConfirm.titleOne'),
        `${escapeHtml(img.file)}<br><small>${escapeHtml(t('toast.deleteConfirm.bodyOne'))}</small>`,
    );
    if (!confirmed) return false;
    if (!unprotectedPaths([img.path]).length) return false;
    const ok = await apiDeleteImage(img.path);
    if (!ok) {
        toastr.error(t('toast.deleteFailed'));
        return false;
    }
    // removeImageFromState() also drops the path from the trash list.
    removeImageFromState(img.path);
    toastr.success(t('toast.deleted.one'));
    render();
    queueVisibleSizes();
    return true;
}

/** Move the current selection into the recycle bin. */
function bulkTrash() {
    if (!state.selected.size) return;
    const paths = unprotectedPaths([...state.selected]);
    if (!paths.length) return;
    const added = addPathsToTrash(paths);
    toastr.info(t('toast.trashed.many', { count: added }));
    for (const path of paths) state.selected.delete(path);
    render();
    queueVisibleSizes();
}

/** Restore the current selection from the recycle bin. */
function bulkRestore() {
    if (!state.selected.size) return;
    const n = restorePathsFromTrash([...state.selected]);
    toastr.success(t('toast.restored.many', { count: n }));
    state.selected.clear();
    render();
    queueVisibleSizes();
}

/** Restore EVERYTHING from the recycle bin in one click (no confirm needed —
 *  restoring is safe, files aren't touched; the symmetric twin of "Empty"). */
function restoreAllTrash() {
    const trashPaths = getSettings().trash.map(e => e.path);
    if (!trashPaths.length) return;
    const n = restorePathsFromTrash(trashPaths);
    for (const p of trashPaths) state.selected.delete(p);
    toastr.success(t('toast.restored.many', { count: n }));
    render();
    queueVisibleSizes();
}

/** Empty the entire recycle bin (permanently delete every trashed file). */
async function emptyTrash() {
    const trashPaths = unprotectedPaths(getSettings().trash.map(e => e.path));
    if (!trashPaths.length) return;
    const c = ctx();
    let knownSize = 0;
    for (const p of trashPaths) {
        const s = state.sizeCache.get(p);
        if (s != null) knownSize += s;
    }
    const sizeNote = knownSize > 0
        ? `<br><small>${escapeHtml(t('toast.deleteConfirm.frees', { size: humanSize(knownSize) }))}</small>`
        : '';
    const confirmed = await c.Popup.show.confirm(
        t('toast.emptyConfirm.title', { count: trashPaths.length }),
        `${escapeHtml(t('toast.emptyConfirm.body'))}${sizeNote}`,
    );
    if (!confirmed) return;
    await purgePaths(trashPaths);
}

/** Permanently delete the selected items that are in the trash. */
async function bulkPurgeSelected() {
    if (!state.selected.size) return;
    const c = ctx();
    const trash = getTrashSet();
    const paths = unprotectedPaths([...state.selected].filter(p => trash.has(p)));
    if (!paths.length) return;
    const confirmed = await c.Popup.show.confirm(
        t('toast.purgeConfirm.titleMany', { count: paths.length }),
        t('toast.deleteConfirm.bodyMany'),
    );
    if (!confirmed) return;
    await purgePaths(paths);
}

/** Shared worker: delete the given paths from the server, then drop them from
 *  the trash list + in-memory state. Used by Empty-trash and bulk purge. */
async function purgePaths(paths) {
    paths = unprotectedPaths(paths);
    if (!paths.length) return;
    let failed = 0;
    const deleted = [];
    toastr.info(t('toast.deleting', { count: paths.length }));
    for (const path of paths) {
        if (isFavorite(path)) continue;
        const ok = await apiDeleteImage(path);
        if (ok) deleted.push(path);
        else failed++;
    }
    // Apply all the bookkeeping in one pass (avoids O(N²) per-item filtering
    // and N separate saveSettings() calls).
    removeImagesFromState(deleted);
    render();
    queueVisibleSizes();
    if (failed) toastr.warning(t('toast.deletePartial', { success: deleted.length, failed }));
    else toastr.success(t('toast.deleted.many', { count: deleted.length }));
}

/* ── Minimal ZIP writer (STORE method, no external dependency) ──
 * Produces a standard, uncompressed ZIP archive. Images/videos are already
 * compressed, so "store" is fine and keeps this dependency-free (no CDN /
 * JSZip needed — works offline). Each entry is { name, bytes: Uint8Array }. */
const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
        crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** Build a ZIP Blob from [{ name, bytes }] entries (bytes is a Uint8Array). */
function createZipBlob(files) {
    const encoder = new TextEncoder();
    const fileParts = [];
    const central = [];
    let offset = 0;

    const dosTime = 0;
    const dosDate = 0x21; // 1980-01-01, a valid neutral timestamp.

    for (const file of files) {
        const nameBytes = encoder.encode(file.name);
        const dataBytes = file.bytes;
        const crc = crc32(dataBytes);
        const size = dataBytes.length;

        const localHeader = new DataView(new ArrayBuffer(30));
        localHeader.setUint32(0, 0x04034b50, true); // local file header signature
        localHeader.setUint16(4, 20, true);          // version needed
        localHeader.setUint16(6, 0x0800, true);      // flags: UTF-8 names
        localHeader.setUint16(8, 0, true);           // compression: store
        localHeader.setUint16(10, dosTime, true);
        localHeader.setUint16(12, dosDate, true);
        localHeader.setUint32(14, crc, true);
        localHeader.setUint32(18, size, true);       // compressed size
        localHeader.setUint32(22, size, true);       // uncompressed size
        localHeader.setUint16(26, nameBytes.length, true);
        localHeader.setUint16(28, 0, true);          // extra field length

        fileParts.push(new Uint8Array(localHeader.buffer), nameBytes, dataBytes);

        const centralHeader = new DataView(new ArrayBuffer(46));
        centralHeader.setUint32(0, 0x02014b50, true); // central dir signature
        centralHeader.setUint16(4, 20, true);          // version made by
        centralHeader.setUint16(6, 20, true);          // version needed
        centralHeader.setUint16(8, 0x0800, true);      // flags: UTF-8
        centralHeader.setUint16(10, 0, true);          // compression: store
        centralHeader.setUint16(12, dosTime, true);
        centralHeader.setUint16(14, dosDate, true);
        centralHeader.setUint32(16, crc, true);
        centralHeader.setUint32(20, size, true);
        centralHeader.setUint32(24, size, true);
        centralHeader.setUint16(28, nameBytes.length, true);
        centralHeader.setUint16(30, 0, true);          // extra field length
        centralHeader.setUint16(32, 0, true);          // comment length
        centralHeader.setUint16(34, 0, true);          // disk number start
        centralHeader.setUint16(36, 0, true);          // internal attrs
        centralHeader.setUint32(38, 0, true);          // external attrs
        centralHeader.setUint32(42, offset, true);     // local header offset

        central.push(new Uint8Array(centralHeader.buffer), nameBytes);

        offset += 30 + nameBytes.length + size;
    }

    const centralSize = central.reduce((sum, part) => sum + part.length, 0);
    const centralOffset = offset;

    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);          // end of central dir signature
    end.setUint16(4, 0, true);                    // disk number
    end.setUint16(6, 0, true);                    // disk with central dir
    end.setUint16(8, files.length, true);         // entries on this disk
    end.setUint16(10, files.length, true);        // total entries
    end.setUint32(12, centralSize, true);
    end.setUint32(16, centralOffset, true);
    end.setUint16(20, 0, true);                   // comment length

    return new Blob([...fileParts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

/** Save a Blob to disk under the given filename via a temporary object URL. */
function saveBlob(blob, filename) {
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke a touch later so the download has time to start.
    setTimeout(() => URL.revokeObjectURL(objUrl), 8000);
}

/**
 * Download a single file to the user's device. We fetch the bytes ourselves so
 * the browser keeps the original filename and doesn't just open the image.
 */
async function downloadOne(img) {
    const res = await fetch(img.url, { headers: reqHeaders({}) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    saveBlob(await res.blob(), img.file);
}

/**
 * Save many files as ONE .zip archive (desktop), using the built-in dependency-
 * free ZIP writer. Returns how many made it into the archive (and how many
 * failed to fetch). File-name collisions (same name from different folders) are
 * de-duplicated with a numeric suffix. Throws if nothing could be added.
 */
async function downloadAsZip(imgs) {
    const entries = [];
    const used = new Set();
    let failed = 0;

    for (const img of imgs) {
        try {
            const res = await fetch(img.url, { headers: reqHeaders({}) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const bytes = new Uint8Array(await res.arrayBuffer());
            // Ensure a unique name inside the zip.
            let name = img.file;
            if (used.has(name)) {
                const dot = name.lastIndexOf('.');
                const base = dot > 0 ? name.slice(0, dot) : name;
                const ext = dot > 0 ? name.slice(dot) : '';
                let n = 2;
                while (used.has(`${base}_${n}${ext}`)) n++;
                name = `${base}_${n}${ext}`;
            }
            used.add(name);
            entries.push({ name, bytes });
        } catch (error) {
            console.error(`[${MODULE_NAME}] zip add failed for "${img.path}"`, error);
            failed++;
        }
    }

    if (!entries.length) throw new Error('nothing to zip');
    const blob = createZipBlob(entries);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    saveBlob(blob, `images-${stamp}.zip`);
    return { added: entries.length, failed };
}

async function bulkDownload() {
    if (!state.selected.size) return;
    const paths = [...state.selected];
    const imgs = paths
        .map(p => state.imageByPath.get(p))
        .filter(Boolean);
    if (!imgs.length) return;

    // Desktop: pack everything into one .zip (no download spam, single file).
    // Mobile: keep saving files one-by-one (mobile browsers handle zips poorly
    // and the per-file flow already works well there).
    const useZip = imgs.length > 1 && !isMobileLayout();

    if (useZip) {
        toastr.info(t('toast.zipping', { count: imgs.length }));
        try {
            const { added, failed } = await downloadAsZip(imgs);
            if (failed && added) toastr.warning(t('toast.downloadPartial', { success: added, failed }));
            else toastr.success(t('toast.zipped', { count: added }));
            return;
        } catch (error) {
            // Building/saving the zip failed unexpectedly — fall back to
            // saving files one-by-one so the user still gets their images.
            console.warn(`[${MODULE_NAME}] zip failed, falling back to per-file`, error);
            toastr.warning(t('toast.zipFallback'));
        }
    }

    // Per-file path (mobile, single file, or zip fallback).
    toastr.info(t('toast.downloading', { count: imgs.length }));
    let success = 0;
    let failed = 0;
    for (const img of imgs) {
        try {
            await downloadOne(img);
            success++;
        } catch (error) {
            console.error(`[${MODULE_NAME}] download failed for "${img.path}"`, error);
            failed++;
        }
        // Small gap so the browser doesn't drop back-to-back saves.
        if (imgs.length > 1) await new Promise(r => setTimeout(r, 300));
    }

    if (failed && success) toastr.warning(t('toast.downloadPartial', { success, failed }));
    else if (failed) toastr.error(t('toast.downloadFailed'));
    else toastr.success(t('toast.downloaded', { count: success }));
}

/** Top-layer action sheet: readable labels and full-width touch targets. */
function chooseAction(title, actions) {
    if (state.actionDialog) return Promise.resolve(null);
    return new Promise(resolve => {
        const opener = document.activeElement;
        const dialog = document.createElement('dialog');
        dialog.className = 'im_action_dialog';
        dialog.setAttribute('aria-labelledby', 'im_action_title');
        applyThemeTo(dialog);
        dialog.innerHTML = `<h3 id="im_action_title">${escapeHtml(title)}</h3>
            <div class="im_action_list">${actions.map((action, i) => `<button type="button" data-action="${i}" ${action.disabled ? 'disabled' : ''} class="im_action_item${action.danger ? ' im_btn_danger' : ''}"><i class="fa-solid ${action.icon}" aria-hidden="true"></i><span>${escapeHtml(action.label)}</span></button>`).join('')}</div>
            <button type="button" class="im_action_item im_action_cancel">${escapeHtml(t('select.cancel'))}</button>`;
        let result = null;
        dialog.addEventListener('click', e => {
            const button = e.target.closest('[data-action]');
            if (button && !button.disabled) {
                result = actions[Number(button.dataset.action)].id;
                dialog.close();
            } else if (e.target.closest('.im_action_cancel') || e.target === dialog) {
                dialog.close();
            }
        });
        dialog.addEventListener('close', () => {
            state.actionDialog = null;
            dialog.remove();
            if (opener?.isConnected) opener.focus({ preventScroll: true });
            resolve(result);
        }, { once: true });
        document.body.append(dialog);
        state.actionDialog = dialog;
        dialog.showModal();
    });
}

async function showImageActions(img) {
    if (!img) return false;
    const trashed = getTrashSet().has(img.path);
    const favorite = isFavorite(img.path);
    const action = await chooseAction(img.file, [
        { id: 'download', icon: 'fa-download', label: t('viewer.download') },
        { id: 'trash', icon: trashed ? 'fa-rotate-left' : 'fa-trash-arrow-up', label: t(trashed ? 'viewer.restore' : 'viewer.trash'), disabled: !trashed && favorite },
        { id: 'delete', icon: 'fa-trash-can', label: t('viewer.purge'), danger: true, disabled: favorite },
    ]);
    if (action === 'download') {
        try {
            await downloadOne(img);
            toastr.success(t('toast.downloaded', { count: 1 }));
        } catch (error) {
            toastr.error(t('toast.downloadFailed'));
        }
    } else if (action === 'trash') {
        if (trashed) { restoreOne(img); return true; }
        return trashOne(img);
    } else if (action === 'delete') {
        return deleteOneConfirmed(img, trashed);
    }
    return false;
}

async function viewImage(img) {
    if (!img) return;
    const c = ctx();

    // Build a navigable list from the CURRENT filtered view, so the arrows walk
    // through exactly what the user is browsing (across pages), in the same
    // order. Fall back to a single-item list if the image isn't in the view.
    let list = [...getFilteredImages()];
    let index = list.findIndex(i => i.path === img.path);
    if (index < 0) { list = [img]; index = 0; }

    const wrap = document.createElement('div');
    wrap.className = 'im_view_wrap';
    applyThemeTo(wrap);   // match the manager's chosen colour theme
    wrap.innerHTML = `
        <div class="im_view_stage">
            <button type="button" class="im_view_nav im_view_prev" data-nav="prev" title="${escapeHtml(t('viewer.prev'))}" aria-label="${escapeHtml(t('viewer.prev'))}"><i class="fa-solid fa-chevron-left"></i></button>
            <div class="im_view_media_wrap"></div>
            <button type="button" class="im_view_nav im_view_next" data-nav="next" title="${escapeHtml(t('viewer.next'))}" aria-label="${escapeHtml(t('viewer.next'))}"><i class="fa-solid fa-chevron-right"></i></button>
        </div>
        <div class="im_view_caption"></div>
        <div class="im_view_toolbar">
            <div class="im_view_zoom_group">
                <button type="button" class="im_view_tool im_view_zoom_out" title="${escapeHtml(t('viewer.zoomOut'))}" aria-label="${escapeHtml(t('viewer.zoomOut'))}"><i class="fa-solid fa-magnifying-glass-minus"></i></button>
                <button type="button" class="im_view_zoom_val" title="${escapeHtml(t('viewer.zoomReset'))}" aria-label="${escapeHtml(t('viewer.zoomReset'))}">100%</button>
                <button type="button" class="im_view_tool im_view_zoom_in" title="${escapeHtml(t('viewer.zoomIn'))}" aria-label="${escapeHtml(t('viewer.zoomIn'))}"><i class="fa-solid fa-magnifying-glass-plus"></i></button>
            </div>
            <label class="im_view_tool im_view_tool_check" title="${escapeHtml(t('viewer.select'))}">
                <input type="checkbox" class="im_view_check">
                <i class="fa-regular fa-square im_view_check_icon"></i>
            </label>
            <button type="button" class="im_view_tool im_favorite_btn"><i class="fa-regular fa-star"></i></button>
            <button type="button" class="im_view_tool im_view_more" aria-haspopup="dialog" title="${escapeHtml(t('actions.more'))}" aria-label="${escapeHtml(t('actions.more'))}"><i class="fa-solid fa-ellipsis"></i></button>
        </div>`;

    const mediaWrap = wrap.querySelector('.im_view_media_wrap');
    const caption = wrap.querySelector('.im_view_caption');
    const prevBtn = wrap.querySelector('[data-nav="prev"]');
    const nextBtn = wrap.querySelector('[data-nav="next"]');
    const checkLabel = wrap.querySelector('.im_view_tool_check');
    const checkInput = wrap.querySelector('.im_view_check');
    const checkIcon = wrap.querySelector('.im_view_check_icon');
    const favoriteBtn = wrap.querySelector('.im_favorite_btn');
    const moreBtn = wrap.querySelector('.im_view_more');
    const zoomInBtn = wrap.querySelector('.im_view_zoom_in');
    const zoomOutBtn = wrap.querySelector('.im_view_zoom_out');
    const zoomValBtn = wrap.querySelector('.im_view_zoom_val');

    let popupRef = null;

    // --- Zoom state ---
    // zoom = 1 means "fit to popup" (the media's natural max-width/max-height
    // CSS). Zooming measures the fitted size once, then sets explicit width /
    // height = base × zoom and lets the media wrap scroll (pan) the overflow.
    const ZOOM_STEP = 1.25;
    const ZOOM_MIN = 0.25;
    const ZOOM_MAX = 8;
    let zoom = 1;
    let zoomBase = null; // { w, h } of the fitted media, measured lazily

    const syncZoomUi = () => {
        zoomValBtn.textContent = `${Math.round(zoom * 100)}%`;
        zoomInBtn.disabled = zoom >= ZOOM_MAX - 1e-6;
        zoomOutBtn.disabled = zoom <= ZOOM_MIN + 1e-6;
        mediaWrap.classList.toggle('is-zoomed', zoom !== 1);
    };

    const applyZoom = () => {
        const media = mediaWrap.querySelector('.im_view_media');
        if (!media) return;
        if (zoom === 1) {
            // Back to "fit": drop the explicit size so CSS max-* rules rule again.
            media.style.width = '';
            media.style.height = '';
            zoomBase = null;
        } else {
            // Measure the fitted size once per image, on first zoom.
            if (!zoomBase) {
                const rect = media.getBoundingClientRect();
                if (!rect.width || !rect.height) return; // not laid out yet
                zoomBase = { w: rect.width, h: rect.height };
            }
            media.style.width = `${Math.round(zoomBase.w * zoom)}px`;
            media.style.height = `${Math.round(zoomBase.h * zoom)}px`;
        }
        syncZoomUi();
    };

    const setZoom = (next) => {
        zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
        // Snap tiny float drift back to exactly 1 so "fit" is reachable.
        if (Math.abs(zoom - 1) < 0.01) zoom = 1;
        applyZoom();
    };

    zoomInBtn.addEventListener('click', (e) => { e.stopPropagation(); setZoom(zoom * ZOOM_STEP); });
    zoomOutBtn.addEventListener('click', (e) => { e.stopPropagation(); setZoom(zoom / ZOOM_STEP); });
    zoomValBtn.addEventListener('click', (e) => { e.stopPropagation(); setZoom(1); });

    // Drop the item at the current index from the viewer's navigation list and
    // either advance to the next image or close the viewer if it was the last.
    const advanceAfterRemoval = (path) => {
        const removedIndex = list.findIndex(item => item.path === path);
        if (removedIndex < 0) return;
        list.splice(removedIndex, 1);
        if (removedIndex < index) index--;
        if (!list.length) {
            try { popupRef?.completeCancelled?.(); } catch (err) { /* ignore */ }
            return;
        }
        if (index >= list.length) index = list.length - 1;
        renderViewer();
    };

    // Reflect the current image's selected state in the bottom toolbar checkbox.
    const syncToolbar = () => {
        const cur = list[index];
        if (!cur) return;
        const favorite = isFavorite(cur.path);
        favoriteBtn.setAttribute('aria-pressed', String(favorite));
        favoriteBtn.title = t(favorite ? 'favorite.remove' : 'favorite.add');
        favoriteBtn.setAttribute('aria-label', favoriteBtn.title);
        favoriteBtn.innerHTML = `<i class="${favorite ? 'fa-solid' : 'fa-regular'} fa-star"></i>`;
        const sel = state.selected.has(cur.path);
        checkInput.checked = sel;
        checkLabel.classList.toggle('is-selected', sel);
        checkLabel.title = sel ? t('viewer.deselect') : t('viewer.select');
        // Swap the icon so the checked/unchecked state is visually obvious
        // (the native checkbox itself is hidden behind the round button).
        if (checkIcon) {
            checkIcon.classList.toggle('fa-solid', sel);
            checkIcon.classList.toggle('fa-square-check', sel);
            checkIcon.classList.toggle('fa-regular', !sel);
            checkIcon.classList.toggle('fa-square', !sel);
        }
    };

    // Render the image/video at the current index into the stage.
    const renderViewer = () => {
        const cur = list[index];
        if (!cur) return;
        // Every image starts at "fit" — zoom never carries over between photos.
        zoom = 1;
        zoomBase = null;
        mediaWrap.classList.remove('is-zoomed');
        mediaWrap.innerHTML = cur.isVideo
            ? `<video src="${escapeHtml(cur.url)}" controls autoplay class="im_view_media"></video>`
            : `<img src="${escapeHtml(cur.url)}" class="im_view_media" alt="">`;
        const pos = list.length > 1 ? ` (${index + 1}/${list.length})` : '';
        caption.textContent = `${cur.file}${pos}`;
        // Broken-media fallback for the full-size view.
        mediaWrap.querySelector('.im_view_media')?.addEventListener('error', () => {
            caption.textContent = `${cur.file} — ${t('media.broken')}`;
        }, { once: true });
        // Only one item -> hide the arrows entirely.
        const multi = list.length > 1;
        prevBtn.classList.toggle('im_hidden', !multi);
        nextBtn.classList.toggle('im_hidden', !multi);
        syncToolbar();
        syncZoomUi();
    };

    const go = (delta) => {
        if (list.length < 2) return;
        // Wrap around so it loops endlessly in both directions.
        index = (index + delta + list.length) % list.length;
        renderViewer();
    };

    prevBtn.addEventListener('click', (e) => { e.stopPropagation(); go(-1); });
    nextBtn.addEventListener('click', (e) => { e.stopPropagation(); go(1); });

    // --- Bottom toolbar: select / download / delete THIS image ---

    // Checkbox: toggle selection of the currently-viewed image without leaving
    // the viewer (handy on phones — fix a mis-tap and keep browsing). This keeps
    // the grid card and the selection bar behind the viewer in sync.
    //
    // We drive the toggle from the label's own click (and own the checkbox
    // state ourselves) instead of relying on the native checkbox `change`
    // event. On touch devices `change` can fire late, so the highlight on the
    // round button lagged a frame and only cleared on the next tap.
    checkLabel.addEventListener('click', (e) => {
        e.preventDefault();   // we'll set checkInput.checked ourselves in syncToolbar
        e.stopPropagation();
        const cur = list[index];
        if (!cur) return;
        toggleSelect(cur.path, !state.selected.has(cur.path));
        syncToolbar();
    });

    favoriteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const cur = list[index];
        if (!cur) return;
        if (toggleFavorite(cur.path)) {
            if (!getFilteredImages().some(item => item.path === cur.path)) advanceAfterRemoval(cur.path);
            else syncToolbar();
        }
    });

    let actionPending = false;
    moreBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const cur = list[index];
        if (!cur || actionPending) return;
        actionPending = true;
        try {
            if (await showImageActions(cur)) advanceAfterRemoval(cur.path);
        } finally {
            actionPending = false;
        }
    });

    // Keyboard arrows while the viewer is open.
    const onKey = (e) => {
        if (actionPending) return;
        if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    };
    document.addEventListener('keydown', onKey, true);

    // --- Swipe navigation (mobile) ---
    // Flip prev/next by swiping the media horizontally instead of hunting for
    // the small on-screen arrows. A mostly-horizontal drag past a threshold
    // triggers a page; vertical drags are left alone (so the popup can scroll).
    let touchStartX = 0;
    let touchStartY = 0;
    let swiping = false;
    const SWIPE_THRESHOLD = 45; // px of horizontal travel needed to flip
    mediaWrap.addEventListener('touchstart', (e) => {
        // While zoomed in, horizontal drags pan the enlarged image (the wrap
        // scrolls) — don't hijack them for prev/next navigation.
        if (zoom !== 1 || list.length < 2 || e.touches.length !== 1) { swiping = false; return; }
        swiping = true;
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
    }, { passive: true });
    mediaWrap.addEventListener('touchend', (e) => {
        if (!swiping) return;
        swiping = false;
        const touch = e.changedTouches[0];
        if (!touch) return;
        const dx = touch.clientX - touchStartX;
        const dy = touch.clientY - touchStartY;
        // Only act on a deliberate, mostly-horizontal swipe.
        if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) < Math.abs(dy)) return;
        go(dx < 0 ? 1 : -1); // swipe left -> next, swipe right -> prev
    }, { passive: true });

    // --- Pinch zoom + double-tap (mobile) ---
    // On touch devices the zoom BUTTONS are hidden (CSS) — pinch with two
    // fingers to zoom instead, keeping the picture point between your fingers
    // in place; double-tap resets to fit (or jumps to 2x when already fitted).
    // `touch-action: pan-x pan-y` on the media wrap (CSS) stops the browser's
    // own page pinch-zoom / double-tap zoom from hijacking these gestures.
    let pinching = false;
    let pinchStartDist = 0;
    let pinchStartZoom = 1;
    const touchDist = (a, b) => Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
    mediaWrap.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
            pinching = true;
            swiping = false;   // a second finger cancels any pending swipe
            pinchStartDist = touchDist(e.touches[0], e.touches[1]);
            pinchStartZoom = zoom;
        }
    }, { passive: true });
    mediaWrap.addEventListener('touchmove', (e) => {
        if (!pinching || e.touches.length !== 2 || !pinchStartDist) return;
        e.preventDefault();   // keep the page itself from pinch-zooming
        const [t0, t1] = [e.touches[0], e.touches[1]];
        // Focal point (pinch midpoint) relative to the wrap's viewport — used
        // to keep the spot between the fingers stationary while scaling.
        const rect = mediaWrap.getBoundingClientRect();
        const midX = (t0.clientX + t1.clientX) / 2 - rect.left;
        const midY = (t0.clientY + t1.clientY) / 2 - rect.top;
        const prev = zoom;
        setZoom(pinchStartZoom * (touchDist(t0, t1) / pinchStartDist));
        const f = zoom / prev;
        if (f !== 1) {
            mediaWrap.scrollLeft = (mediaWrap.scrollLeft + midX) * f - midX;
            mediaWrap.scrollTop = (mediaWrap.scrollTop + midY) * f - midY;
        }
    }, { passive: false });
    mediaWrap.addEventListener('touchend', (e) => {
        if (pinching && e.touches.length < 2) {
            pinching = false;
            pinchEndedAt = Date.now();   // fingers lifting off a pinch are not taps
        }
    }, { passive: true });

    // Double-tap: reset a zoomed image back to fit; from fit, jump to 2x
    // (pinching in needs two fingers — double-tap is the quick one-thumb way).
    let lastTap = { t: 0, x: 0, y: 0 };
    let pinchEndedAt = 0;
    mediaWrap.addEventListener('touchend', (e) => {
        if (pinching || e.touches.length || e.changedTouches.length !== 1) return;
        if (Date.now() - pinchEndedAt < 350) return;   // tail end of a pinch
        // Videos keep their native tap behaviour (play/pause, controls) —
        // double-tap zoom is for still images only. Pinch still works.
        if (e.target instanceof Element && e.target.closest('video')) return;
        const t = e.changedTouches[0];
        const now = Date.now();
        const isDouble = (now - lastTap.t) < 320
            && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < 40;
        lastTap = { t: now, x: t.clientX, y: t.clientY };
        if (!isDouble) return;
        lastTap.t = 0;   // don't let a triple-tap re-trigger
        setZoom(zoom !== 1 ? 1 : 2);
    }, { passive: true });

    renderViewer();

    try {
        const popup = new c.Popup(wrap, c.POPUP_TYPE.DISPLAY, '', { allowVerticalScrolling: true });
        popupRef = popup;
        // Tag the popup shell so our CSS can make its body a full-height flex
        // column — that's what lets the image + action bar sit centred in the
        // popup instead of clinging to the top.
        try {
            const shell = popup.dlg || wrap.closest('.popup') || wrap.closest('dialog');
            shell?.classList.add('im_view_popup');
            applyThemeTo(shell);
        } catch (e) { /* non-fatal: just lose the perfect centring */ }
        await popup.show();
    } catch (error) {
        // Fallback: open in new tab
        window.open(list[index]?.url || img.url, '_blank');
    } finally {
        document.removeEventListener('keydown', onKey, true);
    }
}

async function bulkDelete() {
    if (!state.selected.size) return;
    const c = ctx();
    const paths = unprotectedPaths([...state.selected]);
    if (!paths.length) return;
    let knownSize = 0;
    for (const p of paths) {
        const s = state.sizeCache.get(p);
        if (s != null) knownSize += s;
    }
    const sizeNote = knownSize > 0
        ? `<br><small>${escapeHtml(t('toast.deleteConfirm.frees', { size: humanSize(knownSize) }))}</small>`
        : '';
    const confirmed = await c.Popup.show.confirm(
        t('toast.deleteConfirm.titleMany', { count: paths.length }),
        `${escapeHtml(t('toast.deleteConfirm.bodyMany'))}${sizeNote}`,
    );
    if (!confirmed) return;
    // Same delete-loop + single-pass cleanup as the trash purge.
    await purgePaths(paths);
}

function removeImageFromState(path) {
    removeImagesFromState([path]);
}

/**
 * Remove a batch of images from in-memory state + settings in a SINGLE pass.
 * Removing one-by-one in a loop is O(N × images) (each call re-filters the
 * whole image list and every folder's file list), which can freeze the UI when
 * emptying a large recycle bin. This does it once: O(images + N).
 */
function removeImagesFromState(paths) {
    if (!paths || !paths.length) return;
    const drop = new Set(paths);

    state.images = state.images.filter(i => !drop.has(i.path));
    for (const f of state.folders) {
        const rawSeg = f.name === ROOT_FOLDER ? '' : `${f.name}/`;
        f.files = f.files.filter(file => !drop.has(`user/images/${rawSeg}${file}`));
    }
    for (const p of drop) {
        state.selected.delete(p);
        state.sizeCache.delete(p);
        state.imageByPath.delete(p);
    }
    invalidateFilterCache();

    // Drop from the trash list if present (one save at the end).
    const s = getSettings();
    let dirty = false;
    const trashBefore = s.trash.length;
    s.trash = s.trash.filter(e => !drop.has(e.path));
    if (s.trash.length !== trashBefore) dirty = true;
    if (dirty) saveSettings();
}


/**
 * Try to pull a millisecond timestamp out of an ST image filename.
 * ST uses Date.now() prefixes, e.g. "1718200000000_xxxx.png" or "1718200000000.png".
 * The 13 digits must stand alone (not be a slice of a longer number), so a
 * random hash/ID that happens to contain 13+ consecutive digits doesn't get
 * misread as a date.
 */
function extractTimestamp(filename) {
    // No lookbehind (kept out on purpose — it's a parse-time SyntaxError on
    // older Safari, which would kill the whole script). Scan digit runs and
    // only accept EXACTLY 13-digit ones instead.
    const runs = String(filename).match(/\d+/g) || [];
    for (const run of runs) {
        if (run.length !== 13) continue;
        const ts = Number(run);
        if (ts > 1262304000000 && ts < Date.now() + 86400000) return ts; // sane range (2010+)
    }
    return null;
}

/* ============================================================
 * MODAL OPEN/CLOSE
 * ============================================================ */
function openManager() {
    if (!state.dom.modal) return;
    // Migrate any legacy trash entries exactly once (settings are reliably
    // available by the time the manager is opened). After this getSettings()
    // can treat trash records as already well-formed in its hot paths.
    if (!state.trashMigrated) {
        normalizeTrashOnce();
        state.trashMigrated = true;
    }
    const s = getSettings();
    state.sort = s.sort;
    state.pageSize = s.pageSize;

    if (state.dom.sort) state.dom.sort.value = state.sort;
    if (state.dom.pageSize) state.dom.pageSize.value = String(state.pageSize);

    state.dom.modal.classList.remove('im_hidden');
    state.isOpen = true;
    // Ask loadAll() to auto-jump to the current character's folder this time.
    state.autoFolderPending = true;
    applyMode();   // centered modal vs floating window
    applyCols();   // restore the chosen mobile cards-per-row
    applySidebarSize(); // restore desktop sidebar width / collapsed state
    applyTheme();  // restore the chosen manager colour theme
    updateSidebarLabel();
    loadAll();
}

function closeManager() {
    state.actionDialog?.close();
    if (!state.dom.modal) return;
    state.dom.modal.classList.add('im_hidden');
    state.isOpen = false;
    document.body.classList.remove('im_modal_open');
    state.selected.clear();
    // Stop hammering the server with HEAD size lookups for a window nobody
    // sees any more (any in-flight worker drains naturally once the queue is
    // empty; re-opening re-queues whatever is still unknown).
    drainSizeQueue();
}

/* ============================================================
 * INIT
 * ============================================================ */
async function injectUI() {
    const c = ctx();
    let html;
    try {
        html = await c.renderExtensionTemplateAsync(`third-party/${MODULE_NAME}`, 'manager');
    } catch (error) {
        // Fallback: fetch the html directly
        const res = await fetch(`scripts/extensions/third-party/${MODULE_NAME}/manager.html`);
        html = await res.text();
    }
    document.body.insertAdjacentHTML('beforeend', html);

    // Apply our own localization to the freshly-injected template. This runs
    // regardless of which path produced the HTML (ST template render or the
    // raw fetch fallback), so the panel is always in the right language.
    const modalEl = document.getElementById('im_modal');
    i18nApplyDom(modalEl);

    const $ = (id) => document.getElementById(id);
    state.dom = {
        modal: $('im_modal'),
        panel: document.querySelector('#im_modal .im_panel'),
        header: document.querySelector('#im_modal .im_header'),
        resizeHandle: $('im_resize_handle'),
        loading: $('im_loading'),
        empty: $('im_empty'),
        grid: $('im_grid'),
        folderList: $('im_folder_list'),
        folderSearch: $('im_folder_search'),
        content: document.querySelector('#im_modal .im_content'),
        sidebar: $('im_sidebar'),
        sidebarResizer: $('im_sidebar_resizer'),
        sidebarToggle: $('im_sidebar_toggle'),
        sidebarToggleLabel: $('im_sidebar_toggle_label'),
        breadcrumb: $('im_breadcrumb'),
        summary: $('im_summary'),
        storageSummary: $('im_storage_summary'),
        pageSelect: $('im_page_select'),
        pageTotal: $('im_page_total'),
        prevPage: $('im_prev_page'),
        nextPage: $('im_next_page'),
        sort: $('im_sort'),
        pageSize: $('im_page_size'),
        refresh: $('im_refresh'),
        themeToggle: $('im_theme_toggle'),
        themeMenu: $('im_theme_menu'),
        floatToggle: $('im_float_toggle'),
        floatLabel: document.querySelector('#im_float_toggle .im_float_label'),
        colsToggle: $('im_cols_toggle'),
        colsLabel: $('im_cols_label'),
        selectBar: $('im_select_bar'),
        selectCount: $('im_select_count'),
        selectSize: $('im_select_size'),
        selectProtected: $('im_select_protected'),
        selectAll: $('im_select_all'),
        selectAllFiltered: $('im_select_all_filtered'),
        toolbarSelectAll: $('im_toolbar_select_all'),
        deselectAll: $('im_deselect_all'),
        bulkDownload: $('im_bulk_download'),
        bulkTrash: $('im_bulk_trash'),
        bulkRestore: $('im_bulk_restore'),
        bulkDelete: $('im_bulk_delete'),
        trashControls: $('im_trash_controls'),
        restoreTrash: $('im_restore_trash'),
        emptyTrash: $('im_empty_trash'),
    };

    bindEvents();
}

function bindEvents() {
    const d = state.dom;

    // Close actions
    d.modal?.querySelectorAll('[data-im-action="close"]').forEach((el) => {
        el.addEventListener('click', closeManager);
    });

    d.refresh?.addEventListener('click', () => {
        state.sizeCache.clear();
        drainSizeQueue();
        invalidateFilterCache();
        loadAll();
    });

    // Theme palette: open the picker; choosing a row re-skins the manager.
    d.themeToggle?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleThemeMenu();
    });
    buildThemeMenu();

    // Toolbar folder finder (debounced): narrows the sidebar folder list down
    // by name — with many characters the list is otherwise a chore to scroll.
    let folderSearchTimer = null;
    d.folderSearch?.addEventListener('input', () => {
        clearTimeout(folderSearchTimer);
        folderSearchTimer = setTimeout(() => {
            state.folderSearch = d.folderSearch.value;
            renderFolders();
            // On mobile the folder list lives behind the collapsed dropdown —
            // pop it open so the narrowed list is actually visible.
            if (state.folderSearch.trim() && isMobileLayout()) {
                state.dom.sidebar?.classList.remove('is-collapsed');
            }
        }, 150);
    });

    d.sort?.addEventListener('change', () => {
        state.sort = d.sort.value;
        getSettings().sort = state.sort;
        saveSettings();
        state.currentPage = 1;
        render();
        queueVisibleSizes();
        if (d.grid) d.grid.scrollTop = 0;
    });

    d.pageSize?.addEventListener('change', () => {
        state.pageSize = Number(d.pageSize.value);
        getSettings().pageSize = state.pageSize;
        saveSettings();
        state.currentPage = 1;
        render();
        queueVisibleSizes();
        if (d.grid) d.grid.scrollTop = 0;
    });

    // Floating / centered window toggle.
    d.floatToggle?.addEventListener('click', () => {
        state.mode = state.mode === 'floating' ? 'modal' : 'floating';
        saveMode(state.mode);
        applyMode();
    });
    initFloatingInteractions();
    initSidebarResizer();

    // Cards-per-row cycle button (mobile): 2 -> 3 -> 4 -> 2. Cards shrink to
    // fit the chosen column count.
    d.colsToggle?.addEventListener('click', cycleCols);

    // Pagination: previous / next page buttons + jump-to-page picker.
    d.prevPage?.addEventListener('click', () => goToPage(state.currentPage - 1));
    d.nextPage?.addEventListener('click', () => goToPage(state.currentPage + 1));
    d.pageSelect?.addEventListener('change', () => goToPage(Number(d.pageSelect.value) || 1));

    d.selectAll?.addEventListener('click', selectAllVisible);
    d.selectAllFiltered?.addEventListener('click', selectAllFiltered);
    d.toolbarSelectAll?.addEventListener('click', selectAllFiltered);
    d.deselectAll?.addEventListener('click', clearSelection);
    d.bulkDownload?.addEventListener('click', bulkDownload);
    d.bulkTrash?.addEventListener('click', bulkTrash);
    d.bulkRestore?.addEventListener('click', bulkRestore);
    // In the trash view, the Delete button purges the selection for good; in
    // every other view it's the original permanent delete.
    d.bulkDelete?.addEventListener('click', () => {
        if (inTrashView()) bulkPurgeSelected();
        else bulkDelete();
    });
    d.emptyTrash?.addEventListener('click', emptyTrash);
    d.restoreTrash?.addEventListener('click', restoreAllTrash);

    d.sidebarToggle?.addEventListener('click', () => {
        d.sidebar?.classList.toggle('is-collapsed');
    });

    // ESC closes — only for the centered modal. A floating window is meant to
    // sit alongside the chat, so ESC should not dismiss it.
    document.addEventListener('keydown', (e) => {
        if (document.querySelector('dialog[open]')) return;
        if (e.key === 'Escape' && state.isOpen && state.mode !== 'floating') closeManager();
    });

    // Auto-close when the user taps one of SillyTavern's top-bar buttons
    // (settings / presets / extensions / persona / world-info, etc.). Those
    // open full-screen drawers that would otherwise sit hidden behind the
    // manager, so dismiss the manager just like hitting the X. Delegated on
    // `document` (capture) so it works no matter when the top bar is built.
    document.addEventListener('click', onTopBarClick, true);
}

/** Top-bar buttons that should auto-close the manager when tapped. ST's top
 *  navigation lives in #top-settings-holder; every drawer toggle there carries
 *  the `drawer-toggle` / `drawer-icon` class. We also catch the wand and a few
 *  known IDs directly for older / themed builds. */
function onTopBarClick(e) {
    if (!state.isOpen) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    // Ignore clicks inside the manager itself (its own header/toolbar buttons).
    if (target.closest('#im_modal')) return;

    const hit = target.closest(
        '#top-settings-holder .drawer-toggle, '
        + '#top-settings-holder .drawer-icon, '
        + '#extensionsMenuButton, '
        + '.fillLeft .drawer-toggle, '
        + '#sys-settings-button, #user-settings-button, #persona-management-button, '
        + '#advanced-formatting-button, #WIDrawerIcon, #rightNavDrawerIcon, '
        + '#leftNavDrawerIcon, #extensions-settings-button, #logo_block'
    );
    if (hit) closeManager();
}

/** Close the wand / extensions dropdown the same way SillyTavern does.
 *  ST toggles these menus with jQuery (display:none / fadeOut), not a CSS
 *  class, so we mirror that. Wrapped in try/catch because jQuery may not be
 *  present on every build. */
function closeExtensionsMenu() {
    try {
        if (window.jQuery) {
            const $ = window.jQuery;
            $('#extensionsMenu').fadeOut?.(150);
            $('#extensionsMenu').hide?.();
            // The wand popper wrapper (newer ST) — hide it too if present.
            $('.options-content, #extensionsMenuButton').trigger?.('mouseleave');
        }
    } catch (e) { /* ignore */ }
    // Plain-DOM fallbacks.
    const menu = document.getElementById('extensionsMenu');
    if (menu) menu.style.display = 'none';
}

function addWandButton() {
    const container = document.getElementById('gallery_wand_container')
        || document.getElementById('extensionsMenu');
    if (!(container instanceof HTMLElement)) return false;
    if (document.getElementById('im_wand_button')) return true;

    const btn = document.createElement('div');
    btn.id = 'im_wand_button';
    btn.classList.add('list-group-item', 'flex-container', 'flexGap5', 'interactable');
    btn.tabIndex = 0;
    btn.setAttribute('role', 'button');
    btn.style.cursor = 'pointer';
    btn.title = t('wand.title');

    const icon = document.createElement('div');
    icon.classList.add('fa-solid', 'fa-images', 'extensionsMenuExtensionButton');
    const text = document.createElement('span');
    text.textContent = DISPLAY_NAME();

    btn.appendChild(icon);
    btn.appendChild(text);

    // Guard against the handler firing twice (touch devices can fire both a
    // touchend AND a synthetic click for the same tap).
    let lastFire = 0;
    const activate = (e) => {
        // IMPORTANT: only preventDefault — do NOT stopPropagation here.
        // SillyTavern closes the wand/extensions dropdown via a delegated
        // click handler on `document`; if we stop the event from bubbling,
        // that handler never runs and the menu stays open until you tap the
        // screen again. Letting the click bubble lets ST auto-close it.
        e.preventDefault();

        const now = Date.now();
        if (now - lastFire < 400) return; // debounce double-fire
        lastFire = now;

        openManager();

        // Belt-and-suspenders fallback for ST builds / mobile webviews where
        // the document click handler doesn't fire: explicitly hide the menu.
        closeExtensionsMenu();
    };

    // click covers mouse + modern touch; touchend is a fallback for older
    // mobile webviews where the synthetic click never reaches a <div>.
    btn.addEventListener('click', activate);
    btn.addEventListener('touchend', activate, { passive: false });

    container.appendChild(btn);
    return true;
}

async function init() {
    if (state.initialized) return;
    state.initialized = true;

    // Load translations BEFORE building any UI so the panel, wand button and
    // slash command help all appear in the right language on first paint.
    await i18nLoad();
    console.log(`[${MODULE_NAME}] i18n locale: ${I18N_LANG}`);

    await injectUI();

    // Restore device-local UI preferences.
    state.mode = loadMode();
    applyMode();
    state.cols = loadCols();
    applyCols();
    state.sidebarWidth = loadSidebarWidth();
    state.sidebarCollapsed = loadSidebarCollapsed();
    applySidebarSize();
    state.theme = loadTheme();
    applyTheme();

    // The wand container may not exist yet at load — retry a few times.
    if (!addWandButton()) {
        let tries = 0;
        const timer = setInterval(() => {
            tries++;
            if (addWandButton() || tries > 40) clearInterval(timer);
        }, 500);
    }

    // Slash command for convenience: /image-manager  (alias /im)
    try {
        const c = ctx();
        const { SlashCommandParser, SlashCommand } = c;
        if (SlashCommandParser && SlashCommand) {
            SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                name: 'image-manager',
                aliases: ['im'],
                callback: () => { openManager(); return ''; },
                helpString: t('slash.help'),
            }));
        }
    } catch (error) {
        /* slash command registration is optional */
    }

    console.log(`[${MODULE_NAME}] ready`);
}

// Boot
jQuery(async () => {
    try {
        await init();
    } catch (error) {
        console.error(`[${MODULE_NAME}] init failed`, error);
    }
});
