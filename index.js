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
const DISPLAY_NAME = 'Image Manager';
const SETTINGS_KEY = 'imageManager';
const ROOT_FOLDER = '__root__'; // images that live directly in /user/images
const ALL_FOLDERS = '__all__';

const PAGE_SIZE_OPTIONS = Object.freeze([10, 20, 30, 60, 120, 240]);

const VIDEO_EXTENSIONS = ['mp4', 'webm', 'ogv', 'mov', 'mkv'];

// localStorage key for the device-local dock/window preference.
const LS_MODE = 'imageManager.mode'; // 'modal' | 'dock'

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
    search: '',
    sort: DEFAULT_SETTINGS.sort,
    pageSize: DEFAULT_SETTINGS.pageSize,
    showHidden: false,
    currentPage: 1,
    selected: new Set(), // set of paths
    dom: {},
    sizeQueue: [],
    sizeRunning: false,
    mode: 'modal',      // 'modal' | 'dock'
};

/* ============================================================
 * UTILS
 * ============================================================ */
function ctx() {
    return SillyTavern.getContext();
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
    return raw === 'dock' ? 'dock' : 'modal';
}

function saveMode(value) {
    localStorage.setItem(LS_MODE, value === 'dock' ? 'dock' : 'modal');
}


/** True on phones / narrow screens / touch — where dock mode makes no sense
 *  and the panel should always be the full-screen layout. */
function isMobileLayout() {
    return window.matchMedia('(max-width: 1000px), (pointer: coarse)').matches;
}

/** Apply the modal/dock mode to the DOM and body. */
function applyMode() {
    const modal = state.dom.modal;
    if (!modal) return;
    // Never use dock mode on mobile — it conflicts with the full-screen layout.
    const isDock = state.mode === 'dock' && !isMobileLayout();
    modal.classList.toggle('im_dock', isDock);
    document.body.classList.toggle('im_dock_open', isDock && state.isOpen);
    // The modal scroll-lock only makes sense for the windowed mode.
    document.body.classList.toggle('im_modal_open', !isDock && state.isOpen);
    if (state.dom.dockLabel) {
        state.dom.dockLabel.textContent = isDock ? 'Window' : 'Dock';
    }
    if (state.dom.dockToggle) {
        state.dom.dockToggle.title = isDock
            ? 'Restore as a floating window'
            : 'Dock as a side panel next to the chat';
    }
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
            });
        }
    }
    state.images = images;

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
    runSizeQueue();
}

async function runSizeQueue() {
    if (state.sizeRunning) return;
    state.sizeRunning = true;
    const CONCURRENCY = 4;

    const worker = async () => {
        while (state.sizeQueue.length) {
            const path = state.sizeQueue.shift();
            const img = state.images.find(i => i.path === path);
            if (!img) continue;
            const size = await fetchSize(img.url);
            state.sizeCache.set(path, size);
            updateCardSize(path, size);
        }
    };

    const workers = [];
    for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
    await Promise.all(workers);

    state.sizeRunning = false;
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
function getFilteredImages() {
    const hidden = getHiddenSet();
    const search = state.search.trim().toLowerCase();

    let list = state.images.filter((img) => {
        if (state.activeFolder !== ALL_FOLDERS && img.folder !== state.activeFolder) return false;
        if (!state.showHidden && hidden.has(img.path)) return false;
        if (search && !img.file.toLowerCase().includes(search)) return false;
        return true;
    });

    const [field, order] = state.sort.split('-');
    const dir = order === 'asc' ? 1 : -1;
    list = list.slice().sort((a, b) => {
        if (field === 'name') {
            return a.file.localeCompare(b.file) * dir;
        }
        // date — we don't have a real mtime from the API, but /list already
        // returns files in date order. We approximate by original index.
        return (state.images.indexOf(a) - state.images.indexOf(b)) * dir;
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
        if (!state.showHidden && hidden.has(img.path)) return false;
        return true;
    }).length;

    const entries = [{ name: ALL_FOLDERS, label: 'All images', icon: 'fa-layer-group' }];
    for (const f of state.folders) {
        entries.push({
            name: f.name,
            label: f.name === ROOT_FOLDER ? '(root)' : f.name,
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
        btn.addEventListener('click', () => {
            state.activeFolder = btn.dataset.folder;
            state.currentPage = 1;
            updateSidebarLabel();
            collapseSidebarOnMobile();
            render();
            queueVisibleSizes();
        });
    });
}

function updateSidebarLabel() {
    if (!state.dom.sidebarToggleLabel) return;
    const f = state.activeFolder;
    state.dom.sidebarToggleLabel.textContent =
        f === ALL_FOLDERS ? 'All images' : (f === ROOT_FOLDER ? '(root)' : f);
}

function collapseSidebarOnMobile() {
    if (window.innerWidth <= 768 && state.dom.sidebar) {
        state.dom.sidebar.classList.add('is-collapsed');
    }
}

function renderBreadcrumb() {
    if (!state.dom.breadcrumb) return;
    const f = state.activeFolder;
    const label = f === ALL_FOLDERS ? 'All images' : (f === ROOT_FOLDER ? '(root)' : f);

    // SillyTavern stores images in /user/images/<character name>/. Characters
    // that share the same name therefore share ONE folder on disk — the server
    // has no way to separate them, and neither do we. Show a quiet hint when a
    // real character folder is open so this isn't mistaken for a bug.
    const sharedHint = (f !== ALL_FOLDERS && f !== ROOT_FOLDER)
        ? ` <i class="fa-solid fa-circle-info im_folder_hint" title="SillyTavern keeps one image folder per character NAME. Different characters with the same name share this folder — that's a server limitation, not a bug. Tip: sort by Name or use search to group a single bot's files (they have different prefixes)."></i>`
        : '';

    state.dom.breadcrumb.innerHTML =
        `<i class="fa-solid fa-folder-open"></i> ${escapeHtml(label)}${sharedHint}`;
}

/** Build the HTML for a single image card. */
function cardHtml(img, hidden) {
    const selected = state.selected.has(img.path) ? ' is-selected' : '';
    const isHidden = hidden.has(img.path) ? ' is-hidden' : '';
    const cachedSize = state.sizeCache.get(img.path);
    const sizeText = cachedSize != null ? humanSize(cachedSize) : '…';
    const media = img.isVideo
        ? `<video class="im_card_media" src="${escapeHtml(img.url)}" preload="metadata" muted></video>`
        : `<img class="im_card_media" src="${escapeHtml(img.url)}" loading="lazy" alt="">`;
    const folderTag = state.activeFolder === ALL_FOLDERS
        ? `<span class="im_card_folder" title="${escapeHtml(img.folderLabel)}"><i class="fa-solid fa-folder"></i> ${escapeHtml(img.folderLabel)}</span>`
        : '';
    return `<div class="im_card${selected}${isHidden}" data-path="${escapeHtml(img.path)}">
        <div class="im_card_thumb">
            ${media}
            <label class="im_card_check" title="Select">
                <input type="checkbox" ${state.selected.has(img.path) ? 'checked' : ''}>
            </label>
            ${img.isVideo ? '<span class="im_card_badge"><i class="fa-solid fa-film"></i></span>' : ''}
            <div class="im_card_actions">
                <button type="button" class="im_card_btn" data-act="view" title="View full size"><i class="fa-solid fa-expand"></i></button>
                <button type="button" class="im_card_btn" data-act="hide" title="${hidden.has(img.path) ? 'Unhide' : 'Hide from manager'}"><i class="fa-solid ${hidden.has(img.path) ? 'fa-eye' : 'fa-eye-slash'}"></i></button>
                <button type="button" class="im_card_btn im_card_btn_danger" data-act="delete" title="Delete file"><i class="fa-solid fa-trash-can"></i></button>
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
        viewImage(img);
    });

    card.querySelectorAll('.im_card_btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const act = btn.dataset.act;
            if (act === 'view') viewImage(img);
            else if (act === 'hide') toggleHide(path);
            else if (act === 'delete') deleteOne(img);
        });
    });
}

function renderGrid() {
    const grid = state.dom.grid;
    if (!grid) return;

    const totalFiltered = getFilteredImages().length;

    if (totalFiltered === 0) {
        grid.innerHTML = '';
        state.dom.empty.classList.remove('im_hidden');
        state.dom.empty.innerHTML = state.search
            ? '<i class="fa-solid fa-magnifying-glass"></i><span>No images match your search.</span>'
            : '<i class="fa-solid fa-image"></i><span>No images here. Nothing to clean!</span>';
        return;
    }
    state.dom.empty.classList.add('im_hidden');

    // Render only the current page (e.g. 30/60/... images), so the browser
    // never has to lay out thousands of cards at once. This is what keeps the
    // thumbnails square and the UI responsive.
    const hidden = getHiddenSet();
    const pageImages = getPageImages();

    grid.innerHTML = pageImages.map(img => cardHtml(img, hidden)).join('');
    grid.querySelectorAll('.im_card').forEach(wireCard);

    // Jump back to the top whenever the grid is re-rendered.
    grid.scrollTop = 0;
}

function renderPageControls() {
    const total = getFilteredImages().length;
    const pages = getPageCount();
    clampPage();

    if (state.dom.pageLabel) {
        state.dom.pageLabel.textContent = total > 0
            ? `Page ${state.currentPage} / ${pages}`
            : '';
    }
    if (state.dom.summary) {
        state.dom.summary.textContent = `${total} image${total === 1 ? '' : 's'}`;
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
        state.dom.selectCount.textContent = `${count} selected`;
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

    const countText = `${totalCount} image${totalCount === 1 ? '' : 's'} across ${folderCount} folder${folderCount === 1 ? '' : 's'}`;

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

async function bulkHide() {
    if (!state.selected.size) return;
    const s = getSettings();
    const set = new Set(s.hidden);
    for (const p of state.selected) set.add(p);
    s.hidden = [...set];
    saveSettings();
    toastr.info(`${state.selected.size} image(s) hidden.`);
    state.selected.clear();
    render();
}

async function viewImage(img) {
    if (!img) return;
    const c = ctx();
    const wrap = document.createElement('div');
    wrap.className = 'im_view_wrap';
    if (img.isVideo) {
        wrap.innerHTML = `<video src="${escapeHtml(img.url)}" controls autoplay class="im_view_media"></video>
            <div class="im_view_caption">${escapeHtml(img.file)}</div>`;
    } else {
        wrap.innerHTML = `<img src="${escapeHtml(img.url)}" class="im_view_media" alt="">
            <div class="im_view_caption">${escapeHtml(img.file)}</div>`;
    }
    try {
        const popup = new c.Popup(wrap, c.POPUP_TYPE.DISPLAY, '', { large: true, wide: true, allowVerticalScrolling: true });
        await popup.show();
    } catch (error) {
        // Fallback: open in new tab
        window.open(img.url, '_blank');
    }
}

async function deleteOne(img) {
    if (!img) return;
    const c = ctx();
    const confirmed = await c.Popup.show.confirm(
        'Delete this image?',
        `${escapeHtml(img.file)}<br><small>This permanently removes the file from the server.</small>`,
    );
    if (!confirmed) return;

    const ok = await apiDeleteImage(img.path);
    if (ok) {
        removeImageFromState(img.path);
        toastr.success('Image deleted.');
        render();
        queueVisibleSizes();
    } else {
        toastr.error('Failed to delete image.');
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
    const sizeNote = knownSize > 0 ? `<br><small>Frees about ${humanSize(knownSize)}.</small>` : '';
    const confirmed = await c.Popup.show.confirm(
        `Delete ${paths.length} image(s)?`,
        `This permanently removes the selected files from the server.${sizeNote}`,
    );
    if (!confirmed) return;

    let success = 0;
    let failed = 0;
    toastr.info(`Deleting ${paths.length} image(s)...`);
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
    if (failed) toastr.warning(`Deleted ${success}, failed ${failed}.`);
    else toastr.success(`Deleted ${success} image(s).`);
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
 * Clean Old: delete images older than a chosen number of days.
 * The /list API returns files date-sorted, so "oldest first" gives us the
 * order; but we don't have exact mtimes. To stay accurate we measure age
 * from the filename when it carries a timestamp (ST names inline images as
 * `<timestamp>_...` / `<Date.now()>.<ext>`), falling back to list order.
 */
async function cleanOld() {
    const c = ctx();

    const form = document.createElement('div');
    form.className = 'im_clean_form';
    form.innerHTML = `
        <p>Delete images older than:</p>
        <div class="im_clean_row">
            <input id="im_clean_days" type="number" min="1" value="30" class="text_pole">
            <span>days</span>
        </div>
        <label class="im_toggle">
            <input id="im_clean_scope" type="checkbox" ${state.activeFolder !== ALL_FOLDERS ? 'checked' : ''}>
            <span>Only the current folder${state.activeFolder !== ALL_FOLDERS ? ` (${state.activeFolder === ROOT_FOLDER ? '(root)' : escapeHtml(state.activeFolder)})` : ''}</span>
        </label>
        <p class="im_clean_note"><i class="fa-solid fa-circle-info"></i> Age is read from the image's timestamp when available, otherwise from server file order.</p>
    `;

    // Use the Popup class directly because Popup.show.confirm only accepts
    // string content, while we need to embed a DOM form to read inputs from.
    const wrap = document.createElement('div');
    const heading = document.createElement('h3');
    heading.textContent = 'Clean old images';
    wrap.appendChild(heading);
    wrap.appendChild(form);

    const popup = new c.Popup(wrap, c.POPUP_TYPE.CONFIRM, '', {
        okButton: 'Find matches',
        cancelButton: 'Cancel',
    });
    const result = await popup.show();
    if (result !== c.POPUP_RESULT.AFFIRMATIVE) return;

    const days = Math.max(1, Number(form.querySelector('#im_clean_days')?.value) || 30);
    const onlyCurrent = form.querySelector('#im_clean_scope')?.checked;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    let pool = state.images.slice();
    if (onlyCurrent && state.activeFolder !== ALL_FOLDERS) {
        pool = pool.filter(i => i.folder === state.activeFolder);
    }

    const matches = pool.filter((img) => {
        const ts = extractTimestamp(img.file);
        if (ts != null) return ts < cutoff;
        return false; // unknown age -> skip to be safe
    });

    if (matches.length === 0) {
        toastr.info('No images older than that were found (with a readable date).');
        return;
    }

    // Show a preview popup with a thumbnail for every match. Each one is
    // checked by default; the user can untick anything they want to keep.
    const selectedToDelete = await cleanOldPreview(matches, days);
    if (!selectedToDelete || selectedToDelete.length === 0) {
        if (selectedToDelete && selectedToDelete.length === 0) {
            toastr.info('Nothing selected — no images deleted.');
        }
        return;
    }

    let success = 0;
    let failed = 0;
    toastr.info(`Cleaning ${selectedToDelete.length} image(s)...`);
    for (const img of selectedToDelete) {
        const ok = await apiDeleteImage(img.path);
        if (ok) { removeImageFromState(img.path); success++; }
        else failed++;
    }
    render();
    queueVisibleSizes();
    if (failed) toastr.warning(`Cleaned ${success}, failed ${failed}.`);
    else toastr.success(`Cleaned ${success} image(s).`);
}

/**
 * Renders a confirmation popup that previews every image that will be deleted.
 * Thumbnails are shown with a checkbox each (checked = will delete). The user
 * can untick images to keep them. Returns the array of images to actually
 * delete, or null if the user cancelled.
 *
 * NOTE: This never touches file names or paths — it only reads img.url for the
 * preview and img.path for deletion, exactly as the rest of the manager does.
 *
 * @param {Array} matches Images matched by the age filter
 * @param {number} days Age threshold (for the header)
 * @returns {Promise<Array|null>}
 */
async function cleanOldPreview(matches, days) {
    const c = ctx();

    const wrap = document.createElement('div');
    wrap.className = 'im_clean_preview';

    const head = document.createElement('div');
    head.className = 'im_clean_preview_head';
    head.innerHTML = `
        <h3><i class="fa-solid fa-broom"></i> Delete old images</h3>
        <p>Found <b>${matches.length}</b> image(s) older than <b>${days}</b> day(s).
        Untick anything you want to keep. <b>This cannot be undone.</b></p>
        <div class="im_clean_preview_bar">
            <button type="button" class="menu_button interactable" data-clean="all"><i class="fa-solid fa-check-double"></i> Select all</button>
            <button type="button" class="menu_button interactable" data-clean="none"><i class="fa-solid fa-xmark"></i> Deselect all</button>
            <span class="im_clean_preview_count"></span>
        </div>
    `;
    wrap.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'im_clean_preview_grid';
    grid.innerHTML = matches.map((img, i) => {
        const media = img.isVideo
            ? `<video class="im_clean_thumb_media" src="${escapeHtml(img.url)}" preload="metadata" muted></video>`
            : `<img class="im_clean_thumb_media" src="${escapeHtml(img.url)}" loading="lazy" alt="">`;
        return `<label class="im_clean_thumb" data-index="${i}">
            <input type="checkbox" checked>
            <span class="im_clean_thumb_frame">
                ${media}
                ${img.isVideo ? '<span class="im_card_badge"><i class="fa-solid fa-film"></i></span>' : ''}
            </span>
            <span class="im_clean_thumb_name" title="${escapeHtml(img.file)}">${escapeHtml(img.file)}</span>
        </label>`;
    }).join('');
    wrap.appendChild(grid);

    const updateCount = () => {
        const checked = grid.querySelectorAll('input[type="checkbox"]:checked').length;
        const countEl = head.querySelector('.im_clean_preview_count');
        if (countEl) countEl.textContent = `${checked} of ${matches.length} will be deleted`;
    };

    grid.addEventListener('change', (e) => {
        if (e.target instanceof HTMLInputElement) {
            e.target.closest('.im_clean_thumb')?.classList.toggle('is-unchecked', !e.target.checked);
            updateCount();
        }
    });

    head.addEventListener('click', (e) => {
        const btn = e.target instanceof Element ? e.target.closest('[data-clean]') : null;
        if (!btn) return;
        const on = btn.dataset.clean === 'all';
        grid.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
            cb.checked = on;
            cb.closest('.im_clean_thumb')?.classList.toggle('is-unchecked', !on);
        });
        updateCount();
    });

    updateCount();

    const popup = new c.Popup(wrap, c.POPUP_TYPE.CONFIRM, '', {
        okButton: 'Delete checked',
        cancelButton: 'Cancel',
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });
    const result = await popup.show();
    if (result !== c.POPUP_RESULT.AFFIRMATIVE) return null;

    const keep = [];
    grid.querySelectorAll('.im_clean_thumb').forEach((el) => {
        const idx = Number(el.dataset.index);
        const cb = el.querySelector('input[type="checkbox"]');
        if (cb && cb.checked && matches[idx]) keep.push(matches[idx]);
    });
    return keep;
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
    applyMode();   // sets the correct body classes for modal vs dock
    updateSidebarLabel();
    loadAll();
}

function closeManager() {
    if (!state.dom.modal) return;
    state.dom.modal.classList.add('im_hidden');
    state.isOpen = false;
    document.body.classList.remove('im_modal_open');
    document.body.classList.remove('im_dock_open');
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

    const $ = (id) => document.getElementById(id);
    state.dom = {
        modal: $('im_modal'),
        loading: $('im_loading'),
        empty: $('im_empty'),
        grid: $('im_grid'),
        folderList: $('im_folder_list'),
        sidebar: $('im_sidebar'),
        sidebarToggle: $('im_sidebar_toggle'),
        sidebarToggleLabel: $('im_sidebar_toggle_label'),
        breadcrumb: $('im_breadcrumb'),
        summary: $('im_summary'),
        storageSummary: $('im_storage_summary'),
        pageLabel: $('im_page_label'),
        prevPage: $('im_prev_page'),
        nextPage: $('im_next_page'),
        search: $('im_search'),
        sort: $('im_sort'),
        pageSize: $('im_page_size'),
        showHidden: $('im_show_hidden'),
        cleanOld: $('im_clean_old'),
        refresh: $('im_refresh'),
        dockToggle: $('im_dock_toggle'),
        dockLabel: document.querySelector('#im_dock_toggle .im_dock_label'),
        selectBar: $('im_select_bar'),
        selectCount: $('im_select_count'),
        selectSize: $('im_select_size'),
        selectAll: $('im_select_all'),
        selectAllFiltered: $('im_select_all_filtered'),
        toolbarSelectAll: $('im_toolbar_select_all'),
        deselectAll: $('im_deselect_all'),
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

    d.cleanOld?.addEventListener('click', cleanOld);

    // Dock / window mode toggle.
    d.dockToggle?.addEventListener('click', () => {
        state.mode = state.mode === 'dock' ? 'modal' : 'dock';
        saveMode(state.mode);
        applyMode();
    });

    // Pagination: previous / next page buttons.
    d.prevPage?.addEventListener('click', () => goToPage(state.currentPage - 1));
    d.nextPage?.addEventListener('click', () => goToPage(state.currentPage + 1));

    d.selectAll?.addEventListener('click', selectAllVisible);
    d.selectAllFiltered?.addEventListener('click', selectAllFiltered);
    d.toolbarSelectAll?.addEventListener('click', selectAllFiltered);
    d.deselectAll?.addEventListener('click', clearSelection);
    d.bulkHide?.addEventListener('click', bulkHide);
    d.bulkDelete?.addEventListener('click', bulkDelete);

    d.sidebarToggle?.addEventListener('click', () => {
        d.sidebar?.classList.toggle('is-collapsed');
    });

    // ESC closes — only in windowed mode. In dock mode the panel is meant to
    // stay open alongside the chat, so ESC should not dismiss it.
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && state.isOpen && state.mode !== 'dock') closeManager();
    });
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
    btn.title = 'Open the Image Manager to browse and clean stored images';

    const icon = document.createElement('div');
    icon.classList.add('fa-solid', 'fa-images', 'extensionsMenuExtensionButton');
    const text = document.createElement('span');
    text.textContent = DISPLAY_NAME;

    btn.appendChild(icon);
    btn.appendChild(text);

    // Guard against the handler firing twice (touch devices can fire both a
    // pointerup/touchend AND a synthetic click for the same tap).
    let lastFire = 0;
    const activate = (e) => {
        // Don't let the tap bubble up to ST's menu handlers, which on mobile
        // close the wand menu in a way that can swallow our click entirely.
        e.preventDefault();
        e.stopPropagation();

        const now = Date.now();
        if (now - lastFire < 400) return; // debounce double-fire
        lastFire = now;

        // Open FIRST, then close the dropdown — closing it before opening can
        // cancel the in-flight tap on some mobile webviews.
        openManager();
        document.getElementById('extensionsMenu')?.classList.remove('open');
    };

    // pointerup covers mouse + modern touch; touchend is a fallback for older
    // mobile webviews where the synthetic click never reaches a <div>.
    btn.addEventListener('click', activate);
    btn.addEventListener('touchend', activate, { passive: false });

    container.appendChild(btn);
    return true;
}

async function init() {
    if (state.initialized) return;
    state.initialized = true;

    await injectUI();

    // Restore device-local UI preferences.
    state.mode = loadMode();
    applyMode();

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
                helpString: 'Opens the Image Manager.',
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
