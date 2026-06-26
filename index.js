/*
 * Image Manager for SillyTavern
 * A storage-focused image manager for the /user/images folder.
 * Browse every character's image folder, view, hide, bulk-delete and
 * clean out old images to free up space — handy on mobile where the
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
    { id: 'light',    i18n: 'theme.light',    accent: '#2563eb', bg: '#f4f4f7' },
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
    showHidden: false,
    hidden: [], // list of user-relative paths the user has chosen to hide
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
    sizeCache: new Map(), // path -> bytes (lazily filled)
    activeFolder: ALL_FOLDERS,
    autoFolderPending: false, // jump to current character's folder on next load
    search: '',
    sort: DEFAULT_SETTINGS.sort,
    pageSize: DEFAULT_SETTINGS.pageSize,
    showHidden: false,
    currentPage: 1,
    selected: new Set(), // set of paths
    dom: {},
    sizeQueue: [],
    sizeRunning: false,
    mode: 'modal',      // 'modal' (centered) | 'floating' (movable window)
    floatBox: null,     // { left, top, width, height } when floating
    cols: DEFAULT_COLS, // mobile cards-per-row (2..4)
    sidebarWidth: SIDEBAR_DEFAULT_W, // desktop folder-sidebar width (px)
    sidebarCollapsed: false,         // desktop folder-sidebar collapsed?
    theme: DEFAULT_THEME,            // manager colour theme id
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
    if (!Array.isArray(s.hidden)) s.hidden = [];
    if (typeof s.showHidden !== 'boolean') s.showHidden = false;
    return s;
}

function saveSettings() {
    ctx().saveSettingsDebounced();
}

function getHiddenSet() {
    return new Set(getSettings().hidden);
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
        return Array.isArray(data) ? data : [];
    } catch (error) {
        console.error(`[${MODULE_NAME}] Failed to fetch folders`, error);
        return [];
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
        return Array.isArray(data) ? data : [];
    } catch (error) {
        console.error(`[${MODULE_NAME}] Failed to list images in "${folder}"`, error);
        return [];
    }
}

async function apiDeleteImage(userRelativePath) {
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
    }
}

/**
 * Lazily fetch the byte size of an image via a HEAD request (Content-Length).
 * Light on bandwidth — we never download the body.
 */
async function fetchSize(url) {
    try {
        const res = await fetch(url, { method: 'HEAD', headers: reqHeaders({}) });
        const len = res.headers.get('content-length');
        if (len != null) return Number(len);
    } catch (error) {
        /* ignore — size just stays unknown */
    }
    return null;
}

/* ============================================================
 * DATA LOADING
 * ============================================================ */
async function loadAll() {
    state.isLoading = true;
    renderLoading(true);

    const folderNames = await apiGetFolders();
    // The root folder isn't returned by /folders (only sub-dirs), but listing
    // with an empty-ish folder returns the root files. We add a synthetic root.
    const folders = [];

    // Root images (directly under /user/images)
    const rootFiles = await apiListImages('.');
    if (rootFiles.length) {
        folders.push({ name: ROOT_FOLDER, label: '(root)', files: rootFiles });
    }

    for (const name of folderNames) {
        const files = await apiListImages(name);
        folders.push({ name, label: name, files });
    }

    state.folders = folders;

    // Flatten
    const images = [];
    let seq = 0;
    for (const f of folders) {
        const folderSeg = f.name === ROOT_FOLDER ? '' : `${encodeURIComponent(f.name)}/`;
        const rawSeg = f.name === ROOT_FOLDER ? '' : `${f.name}/`;
        // The API returns each folder's files newest-first. Keep a per-folder
        // index so we can fall back to that order when a file name has no
        // embedded timestamp.
        let folderIndex = 0;
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
                folderOrder: folderIndex++,
                seq: seq++,
            });
        }
    }
    state.images = images;

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

    state.isLoading = false;
    renderLoading(false);
    render();

    // Kick off lazy size fetching for visible page
    queueVisibleSizes();
}

/* ============================================================
 * SIZE QUEUE (lazy, throttled)
 * ============================================================ */
function queueVisibleSizes() {
    const visible = getPageImages();
    for (const img of visible) {
        if (!state.sizeCache.has(img.path) && !state.sizeQueue.includes(img.path)) {
            state.sizeQueue.push(img.path);
        }
    }
    // Also measure the whole current view so the total MB in the summary is
    // complete (visible page is prioritised because it's queued first).
    queueFolderSizes();
    runSizeQueue();
}

/** Enqueue size lookups for EVERY image in the current folder/search view, so
 *  the summary can show the real total size (in MB). Throttled by runSizeQueue. */
function queueFolderSizes() {
    for (const img of getFilteredImages()) {
        if (!state.sizeCache.has(img.path) && !state.sizeQueue.includes(img.path)) {
            state.sizeQueue.push(img.path);
        }
    }
    runSizeQueue();
}

async function runSizeQueue() {
    if (state.sizeRunning) return;
    state.sizeRunning = true;
    const CONCURRENCY = 4;
    let sinceRefresh = 0;

    const worker = async () => {
        while (state.sizeQueue.length) {
            const path = state.sizeQueue.shift();
            const img = state.images.find(i => i.path === path);
            if (!img) continue;
            const size = await fetchSize(img.url);
            state.sizeCache.set(path, size);
            updateCardSize(path, size);
            // Periodically refresh the running total so the MB figure ticks up.
            if (++sinceRefresh >= 8) {
                sinceRefresh = 0;
                renderPageControls();
                updateStorageSummary();
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
    renderPageControls();
    updateStorageSummary();
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

function getFilteredImages() {
    const hidden = getHiddenSet();
    const search = state.search.trim().toLowerCase();

    let list = state.images.filter((img) => {
        if (state.activeFolder !== ALL_FOLDERS && img.folder !== state.activeFolder) return false;
        // The "show hidden" toggle is an exclusive view switch:
        //   off -> show ONLY normal (non-hidden) images
        //   on  -> show ONLY hidden images
        const isHidden = hidden.has(img.path);
        if (state.showHidden ? !isHidden : isHidden) return false;
        if (search && !img.file.toLowerCase().includes(search)) return false;
        return true;
    });

    const [field, order] = state.sort.split('-');
    const dir = order === 'asc' ? 1 : -1;
    list = list.slice().sort((a, b) => {
        if (field === 'name') {
            return a.file.localeCompare(b.file, undefined, { numeric: true }) * dir;
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
    updateStorageSummary();
}

function renderLoading(show) {
    if (!state.dom.loading) return;
    state.dom.loading.classList.toggle('im_hidden', !show);
}

function renderFolders() {
    const list = state.dom.folderList;
    if (!list) return;
    const hidden = getHiddenSet();

    const countFor = (folderName) => state.images.filter((img) => {
        if (folderName !== ALL_FOLDERS && img.folder !== folderName) return false;
        // Match the exclusive view switch used in getFilteredImages().
        const isHidden = hidden.has(img.path);
        if (state.showHidden ? !isHidden : isHidden) return false;
        return true;
    }).length;

    const entries = [{ name: ALL_FOLDERS, label: t('folder.all'), icon: 'fa-layer-group' }];
    for (const f of state.folders) {
        entries.push({
            name: f.name,
            label: f.name === ROOT_FOLDER ? t('folder.root') : f.name,
            icon: 'fa-folder',
        });
    }

    list.innerHTML = entries.map((e) => {
        const active = e.name === state.activeFolder ? ' is-active' : '';
        const count = countFor(e.name);
        return `<button type="button" class="im_folder_item${active}" data-folder="${escapeHtml(e.name)}" title="${escapeHtml(e.label)}">
            <i class="fa-solid ${e.icon}"></i>
            <span class="im_folder_name">${escapeHtml(e.label)}</span>
            <span class="im_folder_count">${count}</span>
        </button>`;
    }).join('');

    list.querySelectorAll('.im_folder_item').forEach((btn) => {
        btn.addEventListener('click', () => selectFolder(btn.dataset.folder));
    });
}

/** Switch the active folder view and refresh everything. Shared by the sidebar
 *  folder list and the clickable folder tag on each card. */
function selectFolder(folderName) {
    if (!folderName) return;
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
    const f = state.activeFolder;
    state.dom.sidebarToggleLabel.textContent =
        f === ALL_FOLDERS ? t('folder.all') : (f === ROOT_FOLDER ? t('folder.root') : f);
}

function collapseSidebarOnMobile() {
    if (window.innerWidth <= 768 && state.dom.sidebar) {
        state.dom.sidebar.classList.add('is-collapsed');
    }
}

function renderBreadcrumb() {
    if (!state.dom.breadcrumb) return;
    const f = state.activeFolder;
    const label = f === ALL_FOLDERS ? t('folder.all') : (f === ROOT_FOLDER ? t('folder.root') : f);

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
function cardHtml(img, hidden) {
    const selected = state.selected.has(img.path) ? ' is-selected' : '';
    const isHidden = hidden.has(img.path) ? ' is-hidden' : '';
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
    // In the "All images" view each card shows which folder (= character) the
    // image belongs to. The tag is clickable: it jumps the view to that folder.
    const folderTag = state.activeFolder === ALL_FOLDERS
        ? `<button type="button" class="im_card_folder" data-folder="${escapeHtml(img.folder)}" title="${escapeHtml(t('card.openFolder', { folder: img.folderLabel }))}"><i class="fa-solid fa-folder"></i> ${escapeHtml(img.folderLabel)}</button>`
        : '';
    return `<div class="im_card${selected}${isHidden}" data-path="${escapeHtml(img.path)}">
        <div class="im_card_thumb">
            ${media}
            <label class="im_card_check" title="${escapeHtml(t('card.selectTitle'))}">
                <input type="checkbox" ${state.selected.has(img.path) ? 'checked' : ''}>
            </label>
            ${img.isVideo ? '<span class="im_card_badge"><i class="fa-solid fa-film"></i></span>' : ''}
            <div class="im_card_actions">
                <button type="button" class="im_card_btn" data-act="hide" title="${escapeHtml(hidden.has(img.path) ? t('card.unhideTitle') : t('card.hideTitle'))}"><i class="fa-solid ${hidden.has(img.path) ? 'fa-eye' : 'fa-eye-slash'}"></i></button>
                <button type="button" class="im_card_btn im_card_btn_danger" data-act="delete" title="${escapeHtml(t('card.deleteTitle'))}"><i class="fa-solid fa-trash-can"></i></button>
            </div>
        </div>
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
    const img = state.images.find(i => i.path === path);

    card.querySelector('.im_card_check input')?.addEventListener('change', (e) => {
        toggleSelect(path, e.target.checked);
    });

    // Tap the thumbnail (the image itself, not the buttons/checkbox) to open
    // the full-size viewer. This is the natural gesture on phones where there
    // is no hover to reveal the action buttons.
    const media = card.querySelector('.im_card_media');
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
            if (act === 'hide') toggleHide(path);
            else if (act === 'delete') deleteOne(img);
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

    const totalFiltered = getFilteredImages().length;

    if (totalFiltered === 0) {
        resetMediaObserver();
        grid.innerHTML = '';
        if (state.dom.empty) {
            state.dom.empty.classList.remove('im_hidden');
            state.dom.empty.innerHTML = state.search
                ? `<i class="fa-solid fa-magnifying-glass"></i><span>${escapeHtml(t('empty.noMatch'))}</span>`
                : `<i class="fa-solid fa-image"></i><span>${escapeHtml(t('empty.none'))}</span>`;
        }
        return;
    }
    state.dom.empty?.classList.add('im_hidden');

    // Render only the current page (e.g. 30/60/... images), so the browser
    // never has to lay out thousands of cards at once. This is what keeps the
    // thumbnails square and the UI responsive.
    const hidden = getHiddenSet();
    const pageImages = getPageImages();

    // Stop watching the previous page's cards before we replace them, so the
    // observer doesn't hold references to detached nodes.
    resetMediaObserver();
    grid.innerHTML = pageImages.map(img => cardHtml(img, hidden)).join('');
    grid.querySelectorAll('.im_card').forEach(wireCard);

    // Jump back to the top whenever the grid is re-rendered.
    grid.scrollTop = 0;
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
    if (state.dom.summary) {
        // Count + total size of the CURRENT view (folder/search). The size is
        // filled in lazily in the background, so it grows as scanning proceeds.
        let known = 0, counted = 0;
        const list = getFilteredImages();
        for (const img of list) {
            const s = state.sizeCache.get(img.path);
            if (s != null) { known += s; counted++; }
        }
        let txt = tImages(total);
        if (counted > 0) {
            const scanning = counted < total;
            txt += ` · ${scanning ? '~' : ''}${humanSize(known)}${scanning ? '…' : ''}`;
        }
        state.dom.summary.textContent = txt;
    }
    if (state.dom.prevPage) state.dom.prevPage.disabled = state.currentPage <= 1;
    if (state.dom.nextPage) state.dom.nextPage.disabled = state.currentPage >= pages;
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

function toggleHide(path) {
    const s = getSettings();
    const set = new Set(s.hidden);
    if (set.has(path)) set.delete(path);
    else set.add(path);
    s.hidden = [...set];
    saveSettings();
    state.selected.delete(path);
    render();
    queueVisibleSizes();
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
        .map(p => state.images.find(i => i.path === p))
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

async function bulkHide() {
    if (!state.selected.size) return;
    const s = getSettings();
    const set = new Set(s.hidden);
    for (const p of state.selected) set.add(p);
    s.hidden = [...set];
    saveSettings();
    toastr.info(t('toast.hidden', { count: state.selected.size }));
    state.selected.clear();
    render();
}

async function viewImage(img) {
    if (!img) return;
    const c = ctx();

    // Build a navigable list from the CURRENT filtered view, so the arrows walk
    // through exactly what the user is browsing (across pages), in the same
    // order. Fall back to a single-item list if the image isn't in the view.
    let list = getFilteredImages();
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
            <label class="im_view_tool im_view_tool_check" title="${escapeHtml(t('viewer.select'))}">
                <input type="checkbox" class="im_view_check">
                <i class="fa-regular fa-square im_view_check_icon"></i>
            </label>
            <button type="button" class="im_view_tool im_view_download" title="${escapeHtml(t('viewer.download'))}" aria-label="${escapeHtml(t('viewer.download'))}"><i class="fa-solid fa-download"></i></button>
            <button type="button" class="im_view_tool im_view_delete" title="${escapeHtml(t('viewer.delete'))}" aria-label="${escapeHtml(t('viewer.delete'))}"><i class="fa-solid fa-trash-can"></i></button>
        </div>`;

    const mediaWrap = wrap.querySelector('.im_view_media_wrap');
    const caption = wrap.querySelector('.im_view_caption');
    const prevBtn = wrap.querySelector('[data-nav="prev"]');
    const nextBtn = wrap.querySelector('[data-nav="next"]');
    const checkLabel = wrap.querySelector('.im_view_tool_check');
    const checkInput = wrap.querySelector('.im_view_check');
    const checkIcon = wrap.querySelector('.im_view_check_icon');
    const downloadBtn = wrap.querySelector('.im_view_download');
    const deleteBtn = wrap.querySelector('.im_view_delete');

    let popupRef = null;

    // Reflect the current image's selected state in the bottom toolbar checkbox.
    const syncToolbar = () => {
        const cur = list[index];
        if (!cur) return;
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

    // Download: save ONLY the currently-viewed file (not the whole selection).
    downloadBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const cur = list[index];
        if (!cur) return;
        try {
            await downloadOne(cur);
            toastr.success(t('toast.downloaded', { count: 1 }));
        } catch (error) {
            console.error(`[${MODULE_NAME}] viewer download failed for "${cur.path}"`, error);
            toastr.error(t('toast.downloadFailed'));
        }
    });

    // Delete: remove ONLY the currently-viewed file (ignores the checkbox
    // selection of other images). After deleting, the viewer advances to the
    // next image, or closes if that was the last one.
    deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const cur = list[index];
        if (!cur) return;
        const confirmed = await c.Popup.show.confirm(
            t('toast.deleteConfirm.titleOne'),
            `${escapeHtml(cur.file)}<br><small>${escapeHtml(t('toast.deleteConfirm.bodyOne'))}</small>`,
        );
        if (!confirmed) return;
        const ok = await apiDeleteImage(cur.path);
        if (!ok) { toastr.error(t('toast.deleteFailed')); return; }

        removeImageFromState(cur.path);
        toastr.success(t('toast.deleted.one'));
        // Refresh the grid behind the viewer.
        render();
        queueVisibleSizes();

        // Drop the deleted item from the viewer's own navigation list.
        list.splice(index, 1);
        if (!list.length) {
            // Nothing left to show — close the viewer.
            try { popupRef?.completeCancelled?.(); } catch (err) { /* ignore */ }
            return;
        }
        // Stay on the same slot (now the next image), clamping at the end.
        if (index >= list.length) index = list.length - 1;
        renderViewer();
    });

    // Keyboard arrows while the viewer is open.
    const onKey = (e) => {
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
        if (list.length < 2 || e.touches.length !== 1) { swiping = false; return; }
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

    renderViewer();

    try {
        const popup = new c.Popup(wrap, c.POPUP_TYPE.DISPLAY, '', { large: true, wide: true, allowVerticalScrolling: true });
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

async function deleteOne(img) {
    if (!img) return;
    const c = ctx();
    const confirmed = await c.Popup.show.confirm(
        t('toast.deleteConfirm.titleOne'),
        `${escapeHtml(img.file)}<br><small>${escapeHtml(t('toast.deleteConfirm.bodyOne'))}</small>`,
    );
    if (!confirmed) return;

    const ok = await apiDeleteImage(img.path);
    if (ok) {
        removeImageFromState(img.path);
        toastr.success(t('toast.deleted.one'));
        render();
        queueVisibleSizes();
    } else {
        toastr.error(t('toast.deleteFailed'));
    }
}

async function bulkDelete() {
    if (!state.selected.size) return;
    const c = ctx();
    const paths = [...state.selected];
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

    let success = 0;
    let failed = 0;
    toastr.info(t('toast.deleting', { count: paths.length }));
    for (const path of paths) {
        const img = state.images.find(i => i.path === path);
        const ok = await apiDeleteImage(img ? img.path : path);
        if (ok) {
            removeImageFromState(path);
            success++;
        } else {
            failed++;
        }
    }
    state.selected.clear();
    render();
    queueVisibleSizes();
    if (failed) toastr.warning(t('toast.deletePartial', { success, failed }));
    else toastr.success(t('toast.deleted.many', { count: success }));
}

function removeImageFromState(path) {
    state.images = state.images.filter(i => i.path !== path);
    for (const f of state.folders) {
        f.files = f.files.filter((file) => {
            const rawSeg = f.name === ROOT_FOLDER ? '' : `${f.name}/`;
            return `user/images/${rawSeg}${file}` !== path;
        });
    }
    state.selected.delete(path);
    state.sizeCache.delete(path);
    // also drop from hidden list if present
    const s = getSettings();
    if (s.hidden.includes(path)) {
        s.hidden = s.hidden.filter(p => p !== path);
        saveSettings();
    }
}


/**
 * Try to pull a millisecond timestamp out of an ST image filename.
 * ST uses Date.now() prefixes, e.g. "1718200000000_xxxx.png" or "1718200000000.png".
 */
function extractTimestamp(filename) {
    const m = String(filename).match(/(\d{13})/);
    if (m) {
        const ts = Number(m[1]);
        if (ts > 1262304000000 && ts < Date.now() + 86400000) return ts; // sane range (2010+)
    }
    return null;
}

/* ============================================================
 * MODAL OPEN/CLOSE
 * ============================================================ */
function openManager() {
    if (!state.dom.modal) return;
    const s = getSettings();
    state.sort = s.sort;
    state.pageSize = s.pageSize;
    state.showHidden = s.showHidden;

    if (state.dom.sort) state.dom.sort.value = state.sort;
    if (state.dom.pageSize) state.dom.pageSize.value = String(state.pageSize);
    if (state.dom.showHidden) state.dom.showHidden.checked = state.showHidden;

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
    if (!state.dom.modal) return;
    state.dom.modal.classList.add('im_hidden');
    state.isOpen = false;
    document.body.classList.remove('im_modal_open');
    state.selected.clear();
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
        search: $('im_search'),
        sort: $('im_sort'),
        pageSize: $('im_page_size'),
        showHidden: $('im_show_hidden'),
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
        selectAll: $('im_select_all'),
        selectAllFiltered: $('im_select_all_filtered'),
        toolbarSelectAll: $('im_toolbar_select_all'),
        deselectAll: $('im_deselect_all'),
        bulkDownload: $('im_bulk_download'),
        bulkHide: $('im_bulk_hide'),
        bulkDelete: $('im_bulk_delete'),
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
        loadAll();
    });

    // Theme palette: open the picker; choosing a row re-skins the manager.
    d.themeToggle?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleThemeMenu();
    });
    buildThemeMenu();

    d.search?.addEventListener('input', () => {
        state.search = d.search.value;
        state.currentPage = 1;
        renderGrid();
        renderPageControls();
        renderFolders();
        queueVisibleSizes();
    });

    d.sort?.addEventListener('change', () => {
        state.sort = d.sort.value;
        getSettings().sort = state.sort;
        saveSettings();
        state.currentPage = 1;
        render();
        queueVisibleSizes();
    });

    d.pageSize?.addEventListener('change', () => {
        state.pageSize = Number(d.pageSize.value);
        getSettings().pageSize = state.pageSize;
        saveSettings();
        state.currentPage = 1;
        render();
        queueVisibleSizes();
    });

    d.showHidden?.addEventListener('change', () => {
        state.showHidden = d.showHidden.checked;
        getSettings().showHidden = state.showHidden;
        saveSettings();
        state.currentPage = 1;
        render();
        queueVisibleSizes();
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
    d.bulkHide?.addEventListener('click', bulkHide);
    d.bulkDelete?.addEventListener('click', bulkDelete);

    d.sidebarToggle?.addEventListener('click', () => {
        d.sidebar?.classList.toggle('is-collapsed');
    });

    // ESC closes — only for the centered modal. A floating window is meant to
    // sit alongside the chat, so ESC should not dismiss it.
    document.addEventListener('keydown', (e) => {
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
