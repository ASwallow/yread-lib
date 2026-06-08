/* ============================================================
   yread Lib — 主逻辑
   ============================================================ */

// ---- 检测存储驱动 ----
let STORAGE_DRIVER = null;

async function initStorage() {
    // 按优先级尝试驱动
    const drivers = [localforage.INDEXEDDB, localforage.WEBSQL, localforage.LOCALSTORAGE];
    for (const driver of drivers) {
        try {
            localforage.config({ name: 'LuminaLibrary', storeName: 'books', driver: driver });
            await localforage.setItem('_test', 1);
            await localforage.removeItem('_test');
            STORAGE_DRIVER = driver;
            console.log('[Lumina] 存储驱动:', driver);
            return;
        } catch (e) {
            console.warn('[Lumina] 驱动不可用:', driver, e);
        }
    }
    console.error('[Lumina] 无可用存储驱动！');
}

/** 安全存储：拷贝 Uint8Array 内容，避免 ArrayBuffer 被 detach 导致崩溃 */
function uint8ToArray(uint8) {
    return Array.from(uint8);
}
function arrayToUint8(arr) {
    return new Uint8Array(arr);
}

/** 本地日期 YYYY-MM-DD（避免 toISOString 的 UTC 时区偏移） */
function localDateStr(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ============================================================
//  全局状态
// ============================================================
localforage.config({ name: 'LuminaLibrary', storeName: 'books' });

let library = [];        // [{ id, name, cover, coverColor, tags, addedAt, pageCount, notes: {text,drawing}, _pdfUint8 (运行时) }]
let readingStats = [];   // [{ bookId, date, duration, page }]
let openedCount = 0;
let currentBookId = null;
let currentCoverBookId = null;
let activeTagFilter = '全部';
let bookNameFontSize = 24; // 书名字号，可调

// 阅读器状态
let pdfDoc = null;
let currentPage = 1;
let totalPages = 1;
let currentZoom = 1.5;
let readStartTime = null;
let readMode = 'single';  // single | double | scroll
let scrollObserver = null; // IntersectionObserver for scroll mode

// 目录侧边栏状态
let tocOutline = null;       // 缓存的outline结构 [{title, pageNum, items:[]}]
let tocOpen = false;

// PDF搜索状态
let pdfSearchOpen = false;
let pageTextCache = {};      // {pageNum: [{str, transform}]}
let searchMatches = [];      // [{pageNum, itemIndex, startIdx, endIdx}]
let searchCurrentIdx = -1;
let searchQuery = '';
let searchDebounceTimer = null;

// 笔记面板状态
let signaturePad = null;
let notesSaveTimer = null;
let currentNotesTab = 'write';

// 论文状态
let papers = [];               // [{ id, name, cover, coverColor, tags, status, addedAt, pageCount, fileSize, author, journal, year, doi, url, notes, description, highlights: [{page,x,y,w,h}], _pdfUint8 }]
let activePaperTagFilter = '全部';
let activePaperStatusFilter = '全部';
let currentTab = 'shelf';      // shelf | papers | dashboard | notes
let isPaperReader = false;     // 当前阅读器是否在读论文
let highlightMode = false;     // 高亮标注模式
let selectedHighlight = null;

// 独立笔记状态
let standaloneNotes = [];      // [{ id, title, content, drawing, links: [noteId], createdAt, updatedAt }]
let currentEditNoteId = null;  // 当前编辑的笔记ID
let noteEditorSignaturePad = null;
let noteEditorSaveTimer = null;
let currentNoteEditorTab = 'edit';

// 差分阅读状态
let diffState = null;          // { left: {pdfDoc,currentPage,totalPages,zoom,type,noteId}, right: {...} }

// 关系图状态
let graphAnimFrame = null;

const DEFAULT_PAPER_TAGS = ['计算机', '数学', '物理', '工程', '经济', '生物', '医学', '社科', '其他'];
const READING_STATUS = { unread: '未读', reading: '在读', finished: '已读', reread: '重读' };

// ============================================================
//  数据持久化
// ============================================================
async function loadState() {
    try {
        const saved = await localforage.getItem('library');
        if (saved && Array.isArray(saved)) library = saved;
        // 兼容旧数据：初始化 notes 字段
        library.forEach(b => {
            if (!b.notes) b.notes = { text: '', drawing: null };
        });
        const stats = await localforage.getItem('readingStats');
        if (stats) readingStats = stats;
        const oc = await localforage.getItem('openedCount');
        if (oc) openedCount = oc;
        // 恢复主题色（必须在主题切换前加载）
        const dci = await localforage.getItem('darkThemeColorIdx');
        if (dci != null) darkThemeColorIdx = dci;
        const lci = await localforage.getItem('lightThemeColorIdx');
        if (lci != null) lightThemeColorIdx = lci;
        // 恢复主题
        const theme = await localforage.getItem('theme');
        if (theme === 'light') applyTheme('light');
        // 恢复阅读模式
        const mode = await localforage.getItem('readMode');
        if (mode) readMode = mode;
        // 恢复书名字号
        const fs = await localforage.getItem('bookNameFontSize');
        if (fs) bookNameFontSize = fs;
        // 加载论文
        const savedPapers = await localforage.getItem('papers');
        if (savedPapers && Array.isArray(savedPapers)) papers = savedPapers;
        papers.forEach(p => {
            if (!p.notes) p.notes = { text: '', drawing: null };
            if (!p.highlights) p.highlights = [];
            if (!p.status) p.status = 'unread';
        });
        console.log('[Lumina] 加载完成，书库:', library.length, '本，论文:', papers.length, '篇');
    } catch (e) {
        console.error('[Lumina] 加载失败:', e);
    }
    // 加载独立笔记（在 try-catch 外，避免影响主加载）
    await loadStandaloneNotes();
}

// ============================================================
//  主题切换 + 主题色
// ============================================================

// 可选主题色：{ name, dark: {accent, bg, gradient, gradientFill}, light: {...} }
const THEME_COLORS = [
    {
        name: '靛蓝', dark: { accent: '#818cf8', rgb: '129,140,248', bg: 'rgba(99,102,241,0.15)', hover: 'rgba(99,102,241,0.1)', gradient: 'linear-gradient(135deg,#818cf8,#c084fc)', gradientFill: 'linear-gradient(90deg,#6366f1,#a78bfa)', bgProgress: 'rgba(99,102,241,0.15)' },
        light: { accent: '#4f46e5', rgb: '79,70,229', bg: 'rgba(79,70,229,0.12)', hover: 'rgba(79,70,229,0.08)', gradient: 'linear-gradient(135deg,#4f46e5,#7c3aed)', gradientFill: 'linear-gradient(90deg,#4f46e5,#818cf8)', bgProgress: 'rgba(99,102,241,0.12)' }
    },
    {
        name: '紫色', dark: { accent: '#c084fc', rgb: '192,132,252', bg: 'rgba(168,85,247,0.15)', hover: 'rgba(168,85,247,0.1)', gradient: 'linear-gradient(135deg,#c084fc,#e879f9)', gradientFill: 'linear-gradient(90deg,#a855f7,#d946ef)', bgProgress: 'rgba(168,85,247,0.15)' },
        light: { accent: '#9333ea', rgb: '147,51,234', bg: 'rgba(147,51,234,0.12)', hover: 'rgba(147,51,234,0.08)', gradient: 'linear-gradient(135deg,#9333ea,#c026d3)', gradientFill: 'linear-gradient(90deg,#9333ea,#a855f7)', bgProgress: 'rgba(147,51,234,0.12)' }
    },
    {
        name: '青色', dark: { accent: '#22d3ee', rgb: '34,211,238', bg: 'rgba(6,182,212,0.15)', hover: 'rgba(6,182,212,0.1)', gradient: 'linear-gradient(135deg,#22d3ee,#67e8f9)', gradientFill: 'linear-gradient(90deg,#06b6d4,#22d3ee)', bgProgress: 'rgba(6,182,212,0.15)' },
        light: { accent: '#0891b2', rgb: '8,145,178', bg: 'rgba(8,145,178,0.12)', hover: 'rgba(8,145,178,0.08)', gradient: 'linear-gradient(135deg,#0891b2,#06b6d4)', gradientFill: 'linear-gradient(90deg,#0891b2,#0e7490)', bgProgress: 'rgba(8,145,178,0.12)' }
    },
    {
        name: '翠绿', dark: { accent: '#34d399', rgb: '52,211,153', bg: 'rgba(16,185,129,0.15)', hover: 'rgba(16,185,129,0.1)', gradient: 'linear-gradient(135deg,#34d399,#6ee7b7)', gradientFill: 'linear-gradient(90deg,#10b981,#34d399)', bgProgress: 'rgba(16,185,129,0.15)' },
        light: { accent: '#059669', rgb: '5,150,105', bg: 'rgba(5,150,105,0.12)', hover: 'rgba(5,150,105,0.08)', gradient: 'linear-gradient(135deg,#059669,#10b981)', gradientFill: 'linear-gradient(90deg,#059669,#047857)', bgProgress: 'rgba(5,150,105,0.12)' }
    },
    {
        name: '玫红', dark: { accent: '#fb7185', rgb: '251,113,133', bg: 'rgba(244,63,94,0.15)', hover: 'rgba(244,63,94,0.1)', gradient: 'linear-gradient(135deg,#fb7185,#fda4af)', gradientFill: 'linear-gradient(90deg,#f43f5e,#fb7185)', bgProgress: 'rgba(244,63,94,0.15)' },
        light: { accent: '#e11d48', rgb: '225,29,72', bg: 'rgba(225,29,72,0.12)', hover: 'rgba(225,29,72,0.08)', gradient: 'linear-gradient(135deg,#e11d48,#f43f5e)', gradientFill: 'linear-gradient(90deg,#e11d48,#be123c)', bgProgress: 'rgba(225,29,72,0.12)' }
    }
];

function applyAccentColor(theme, colorIdx) {
    const isLight = theme === 'light';
    const palette = THEME_COLORS[colorIdx] || THEME_COLORS[0];
    const c = isLight ? palette.light : palette.dark;
    const root = document.documentElement.style;
    root.setProperty('--accent', c.accent);
    root.setProperty('--accent-rgb', c.rgb);
    root.setProperty('--accent-bg', c.bg);
    root.setProperty('--accent-bg-hover', c.hover);
    root.setProperty('--accent-border', c.hover);
    root.setProperty('--accent-gradient', c.gradient);
    root.setProperty('--accent-gradient-fill', c.gradientFill);
    root.setProperty('--bg-progress', c.bgProgress);
}

let darkThemeColorIdx = 0;  // 暗色主题色索引
let lightThemeColorIdx = 0; // 亮色主题色索引

function applyTheme(theme) {
    const isLight = theme === 'light';
    document.body.classList.toggle('light-theme', isLight);
    const icon = document.getElementById('theme-icon');
    icon.setAttribute('data-lucide', isLight ? 'moon' : 'sun');
    lucide.createIcons();
    applyAccentColor(theme, isLight ? lightThemeColorIdx : darkThemeColorIdx);
}

function toggleTheme() {
    const isLight = document.body.classList.contains('light-theme');
    const next = isLight ? 'dark' : 'light';
    applyTheme(next);
    localforage.setItem('theme', next);
    generatePenroseBackground();
    // 刷新颜色选择器高亮
    updateColorSwatchActive();
}

/** 保存书库元数据 */
async function saveLibrary() {
    const meta = library.map(b => ({
        id: b.id, name: b.name, cover: b.cover,
        coverColor: b.coverColor, tags: b.tags,
        addedAt: b.addedAt, pageCount: b.pageCount,
        fileSize: b.fileSize, notes: b.notes,
        description: b.description || ''
    }));
    await localforage.setItem('library', meta);
}

/** 保存单本书的 PDF 二进制 */
async function savePdfData(bookId, uint8) {
    await localforage.setItem('pdf_' + bookId, uint8ToArray(uint8));
}

/** 加载单本书的 PDF 二进制 */
async function loadPdfData(bookId) {
    const raw = await localforage.getItem('pdf_' + bookId);
    if (!raw) return null;
    return arrayToUint8(raw);
}

async function saveStats() {
    await localforage.setItem('readingStats', readingStats);
    await localforage.setItem('openedCount', openedCount);
}

/** 保存论文元数据 */
async function savePapers() {
    const meta = papers.map(p => ({
        id: p.id, name: p.name, cover: p.cover,
        coverColor: p.coverColor, tags: p.tags, status: p.status,
        addedAt: p.addedAt, pageCount: p.pageCount, fileSize: p.fileSize,
        author: p.author || '', journal: p.journal || '', year: p.year || '',
        doi: p.doi || '', url: p.url || '',
        notes: p.notes, description: p.description || '',
        highlights: p.highlights || []
    }));
    await localforage.setItem('papers', meta);
}

/** 保存/加载论文 PDF 二进制 */
async function savePaperPdfData(paperId, uint8) {
    await localforage.setItem('pdf_paper_' + paperId, uint8ToArray(uint8));
}
async function loadPaperPdfData(paperId) {
    const raw = await localforage.getItem('pdf_paper_' + paperId);
    if (!raw) return null;
    return arrayToUint8(raw);
}

// ---- 独立笔记持久化 ----
async function loadStandaloneNotes() {
    try {
        const saved = await localforage.getItem('standaloneNotes');
        if (saved && Array.isArray(saved)) standaloneNotes = saved;
        console.log('[Lumina] 加载独立笔记:', standaloneNotes.length, '条');
    } catch (e) {
        console.error('[Lumina] 加载独立笔记失败:', e);
    }
}

async function saveStandaloneNotes() {
    await localforage.setItem('standaloneNotes', standaloneNotes);
}

// ============================================================
//  工具函数
// ============================================================
function escHtml(s) {
    return s ? String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : '';
}

/** 文字自动换行，返回行数组 */
function wrapText(ctx, text, maxW) {
    const chars = text.split('');
    const lines = [];
    let line = '';
    for (const ch of chars) {
        if (ctx.measureText(line + ch).width > maxW && line) {
            lines.push(line);
            line = ch;
        } else {
            line += ch;
        }
    }
    if (line) lines.push(line);
    return lines.slice(0, 5);
}

/** 粒子爆炸动画 */
function spawnParticles(x, y, count) {
    for (let i = 0; i < count; i++) {
        const p = document.createElement('div');
        p.className = 'particle';
        const size = 4 + Math.random() * 8;
        const angle = Math.random() * Math.PI * 2;
        const dist = 40 + Math.random() * 80;
        p.style.cssText = `
            left:${x}px; top:${y}px;
            width:${size}px; height:${size}px;
            background:hsl(${Math.random() * 360}, 80%, 60%);
            --tx:${Math.cos(angle) * dist}px;
            --ty:${Math.sin(angle) * dist}px;
        `;
        document.body.appendChild(p);
        setTimeout(() => p.remove(), 1000);
    }
}

// ============================================================
//  页面切换
// ============================================================
function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.nav-item').forEach(el =>
        el.classList.toggle('active', el.dataset.tab === tab)
    );
    document.getElementById('page-shelf').classList.toggle('hidden', tab !== 'shelf');
    document.getElementById('page-papers').classList.toggle('hidden', tab !== 'papers');
    document.getElementById('page-notes').classList.toggle('hidden', tab !== 'notes');
    document.getElementById('page-dashboard').classList.toggle('hidden', tab !== 'dashboard');
    document.getElementById('page-settings').classList.toggle('hidden', tab !== 'settings');
    // 更新导入按钮标签和可见性
    const importBtn = document.getElementById('import-btn');
    if (tab === 'settings' || tab === 'notes') {
        importBtn.style.display = 'none';
    } else {
        importBtn.style.display = '';
        document.getElementById('import-btn-label').textContent = tab === 'papers' ? '导入论文' : '批量导入';
    }
    // 设置和统计页隐藏四宫格
    document.getElementById('fab-group').style.display = (tab === 'settings' || tab === 'dashboard') ? 'none' : '';
    if (tab === 'papers') {
        renderPapersShelf();
    } else if (tab === 'notes') {
        renderNotesPage();
    } else if (tab === 'dashboard') {
        try { renderDashboard(); } catch (e) {
            console.error('[Lumina] 统计渲染失败:', e);
        }
    } else if (tab === 'settings') {
        initSettings();
    }
}

// ============================================================
//  导入 PDF
// ============================================================
/** 显示/隐藏导入进度提示 */
function showImportToast(text) {
    const toast = document.getElementById('import-toast');
    document.getElementById('import-toast-text').textContent = text;
    toast.classList.add('show');
}
function hideImportToast() {
    document.getElementById('import-toast').classList.remove('show');
}

async function handleImport(event) {
    if (currentTab === 'papers') {
        return handlePaperImport(event);
    }
    const files = Array.from(event.target.files).filter(f => f.name.toLowerCase().endsWith('.pdf'));
    if (files.length === 0) return;

    const total = files.length;
    let done = 0;
    let skipped = 0;

    for (const file of files) {
        done++;
        showImportToast(`导入中 (${done}/${total}): ${file.name}`);

        const bookName = file.name.replace(/\.pdf$/i, '');

        // 自动去重：书名 + 文件大小 相同则跳过
        const isDuplicate = library.some(b => b.name === bookName && b.fileSize === file.size);
        if (isDuplicate) {
            skipped++;
            console.log('[Lumina] 跳过重复:', file.name);
            continue;
        }

        const bookId = crypto.randomUUID();
        const arrayBuffer = await file.arrayBuffer();
        const uint8 = new Uint8Array(arrayBuffer);

        console.log('[Lumina] 导入:', file.name, '大小:', uint8.length, '字节');

        // 先存档，再解析封面
        await savePdfData(bookId, uint8);

        // 提取封面和页数
        const { cover, pageCount } = await extractPdfCoverAndPages(uint8);

        const tag = guessTag(file.name);
        const book = {
            id: bookId,
            name: bookName,
            cover: cover,
            coverColor: null,
            tags: [tag],
            addedAt: Date.now(),
            pageCount: pageCount || 0,
            fileSize: file.size,
            _pdfUint8: uint8
        };

        library.push(book);
    }

    await saveLibrary();

    hideImportToast();
    renderShelf();
    if (skipped > 0) {
        showImportToast(`导入完成，跳过 ${skipped} 本重复书籍`);
        setTimeout(hideImportToast, 3000);
    }
    console.log('[Lumina] 批量导入完成，共', total, '本，跳过重复', skipped, '本，书库:', library.length, '本');

    // 粒子效果
    const rect = event.target.closest('label').getBoundingClientRect();
    spawnParticles(rect.left + rect.width / 2, rect.top + rect.height / 2, 16);
    event.target.value = '';
}

/** 一键去重：同名书籍只保留最先导入的一本 */
async function dedupLibrary() {
    const seen = new Map();
    const toRemove = [];

    library.forEach(b => {
        const key = b.name;
        if (seen.has(key)) {
            toRemove.push(b);
        } else {
            seen.set(key, b);
        }
    });

    if (toRemove.length === 0) {
        showToast('没有发现重复书籍');
        return;
    }

    // 删除重复书籍的 PDF 数据
    for (const book of toRemove) {
        await localforage.removeItem('pdf_' + book.id);
    }

    // 清理相关的阅读统计
    const removeIds = new Set(toRemove.map(b => b.id));
    readingStats = readingStats.filter(r => !removeIds.has(r.bookId));
    await saveStats();

    // 更新书库
    library = library.filter(b => !removeIds.has(b.id));
    await saveLibrary();

    renderShelf();
    showToast(`已去除 ${toRemove.length} 本重复书籍`);
    console.log('[Lumina] 去重完成，移除', toRemove.length, '本，剩余:', library.length, '本');
}

function showToast(msg) {
    const p = document.createElement('div');
    p.className = 'import-toast show';
    p.innerHTML = `<span>${escHtml(msg)}</span>`;
    document.body.appendChild(p);
    setTimeout(() => p.classList.remove('show'), 2000);
    setTimeout(() => p.remove(), 2500);
}

/** 带超时的 Promise 包装 */
function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`超时: ${label} (${ms}ms)`)), ms)
        )
    ]);
}

/** 通用 PDF 解析：主线程解析（Tauri 自定义协议不支持 Worker） */
async function parsePdf(uint8, timeoutMs) {
    const copy = new Uint8Array(uint8);
    return await withTimeout(
        pdfjsLib.getDocument({ data: copy, disableWorker: true }).promise,
        timeoutMs,
        'PDF 解析'
    );
}

/** 从 PDF 第一页生成封面缩略图 + 获取页数 */
async function extractPdfCoverAndPages(uint8) {
    try {
        const pdf = await parsePdf(uint8, 15000);
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 1.0 });

        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d');

        await page.render({ canvasContext: ctx, viewport }).promise;

        const cover = await new Promise((resolve) => {
            canvas.toBlob(function(blob) {
                if (!blob) { resolve(null); return; }
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => resolve(null);
                reader.readAsDataURL(blob);
            }, 'image/jpeg', 0.7);
        });

        return { cover: cover, pageCount: pdf.numPages };
    } catch (e) {
        console.warn('[Lumina] PDF 封面提取失败:', e);
        return { cover: null, pageCount: 0 };
    }
}

/** 根据文件名猜测标签 */
function guessTag(name) {
    const n = name.toLowerCase();
    if (/programming|python|java|code|rust|go\b|c\+\+|html|css|js|算法|编程|开发/.test(n)) return '技术';
    if (/novel|story|fiction|小说|文学|散文|诗歌/.test(n)) return '文学';
    if (/history|历史/.test(n)) return '历史';
    if (/science|科学|physics|化学|数学/.test(n)) return '科学';
    if (/philosophy|哲学|mind/.test(n)) return '哲学';
    if (/business|商业|经济|金融|管理/.test(n)) return '商业';
    if (/art|艺术|设计|美术/.test(n)) return '艺术';
    return '其他';
}

/** 根据文件名猜测论文标签 */
function guessPaperTag(name) {
    const n = name.toLowerCase();
    if (/computer|算法|computing|machine learning|deep learning|neural|ai\b|nlp|cv\b|编程|software|database|网络|security/.test(n)) return '计算机';
    if (/math|数学|algebra|calculus|statistics|概率|optimization/.test(n)) return '数学';
    if (/physics|物理|quantum|力学|光学|thermodynamics/.test(n)) return '物理';
    if (/engineer|工程|电路|mechanical|材料|civil|chemical/.test(n)) return '工程';
    if (/econom|经济|金融|finance|market|trade|business/.test(n)) return '经济';
    if (/biolog|生物|genetic|基因|cell|ecology|evolution/.test(n)) return '生物';
    if (/medic|医学|临床|clinical|health|药学|pharma/.test(n)) return '医学';
    if (/social|社科|sociology|psychology|政治|law|教育/.test(n)) return '社科';
    return '其他';
}

// ============================================================
//  导入论文
// ============================================================
async function handlePaperImport(event) {
    const files = Array.from(event.target.files).filter(f => f.name.toLowerCase().endsWith('.pdf'));
    if (files.length === 0) return;

    const total = files.length;
    let done = 0;
    let skipped = 0;

    for (const file of files) {
        done++;
        showImportToast(`导入论文 (${done}/${total}): ${file.name}`);

        const paperName = file.name.replace(/\.pdf$/i, '');
        const isDuplicate = papers.some(p => p.name === paperName && p.fileSize === file.size);
        if (isDuplicate) { skipped++; continue; }

        const paperId = crypto.randomUUID();
        const arrayBuffer = await file.arrayBuffer();
        const uint8 = new Uint8Array(arrayBuffer);

        await savePaperPdfData(paperId, uint8);
        const { cover, pageCount } = await extractPdfCoverAndPages(uint8);
        const tag = guessPaperTag(file.name);

        papers.push({
            id: paperId, name: paperName, cover, coverColor: null,
            tags: [tag], status: 'unread', addedAt: Date.now(),
            pageCount: pageCount || 0, fileSize: file.size,
            author: '', journal: '', year: '', doi: '', url: '',
            notes: { text: '', drawing: null }, description: '',
            highlights: [], _pdfUint8: uint8
        });
    }

    await savePapers();
    hideImportToast();
    renderPapersShelf();
    if (skipped > 0) {
        showImportToast(`导入完成，跳过 ${skipped} 篇重复论文`);
        setTimeout(hideImportToast, 3000);
    }
    const rect = event.target.closest('label').getBoundingClientRect();
    spawnParticles(rect.left + rect.width / 2, rect.top + rect.height / 2, 16);
    event.target.value = '';
}

// ============================================================
//  生成占位封面（渐变 + PDF标识 + 书名）
// ============================================================
function generatePlaceholder(name) {
    const gradients = [
        ['#4f46e5', '#7c3aed'], ['#059669', '#34d399'],
        ['#dc2626', '#f97316'], ['#0891b2', '#06b6d4'],
        ['#9333ea', '#ec4899'], ['#d97706', '#f59e0b'],
        ['#2563eb', '#60a5fa'], ['#be185d', '#f472b6']
    ];
    const idx = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % gradients.length;
    const [c1, c2] = gradients[idx];

    const canvas = document.createElement('canvas');
    canvas.width = 300;
    canvas.height = 440;
    const ctx = canvas.getContext('2d');

    const g = ctx.createLinearGradient(0, 0, 300, 440);
    g.addColorStop(0, c1);
    g.addColorStop(1, c2);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 300, 440);

    // 装饰圆
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(240, 80, 120, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(60, 380, 80, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // PDF 字样
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.font = 'bold 72px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('PDF', 150, 210);

    // 书名
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 22px system-ui, sans-serif';
    const lines = wrapText(ctx, name, 240);
    const startY = 290;
    lines.slice(0, 3).forEach((line, i) => {
        ctx.fillText(line, 150, startY + i * 30);
    });

    return canvas.toDataURL('image/jpeg', 0.85);
}

// ============================================================
//  提取封面主色调
// ============================================================
function extractDominantColor(imgSrc) {
    return new Promise(resolve => {
        const fallback = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#818cf8';
        if (!imgSrc || imgSrc.length < 10) { resolve(fallback()); return; }
        const img = new Image();
        img.onload = () => {
            try {
                const c = document.createElement('canvas');
                c.width = 1;
                c.height = 1;
                const ctx = c.getContext('2d');
                ctx.drawImage(img, 0, 0, 1, 1);
                const d = ctx.getImageData(0, 0, 1, 1).data;
                resolve(`rgb(${d[0]},${d[1]},${d[2]})`);
            } catch (e) {
                resolve(fallback());
            }
        };
        img.onerror = () => resolve(fallback());
        img.src = imgSrc;
    });
}

// ============================================================
//  渲染论文列表
// ============================================================
function renderPapersShelf() {
    const container = document.getElementById('papers-container');
    const tagBar = document.getElementById('paper-tag-filter-bar');
    const statusBar = document.getElementById('paper-status-filter-bar');

    if (papers.length === 0) {
        tagBar.innerHTML = '';
        statusBar.innerHTML = '';
        container.innerHTML = `
            <div class="empty-shelf">
                <i data-lucide="file-text"></i>
                <p>论文库为空</p>
                <p class="hint">点击右上角「导入论文」按钮添加 PDF 论文</p>
            </div>`;
        lucide.createIcons();
        return;
    }

    // 标签筛选
    const tagCounts = { '全部': papers.length };
    papers.forEach(p => {
        const t = p.tags[0] || '其他';
        tagCounts[t] = (tagCounts[t] || 0) + 1;
    });
    tagBar.innerHTML = Object.entries(tagCounts).map(([tag, count]) =>
        `<button class="tag-filter-btn${tag === activePaperTagFilter ? ' active' : ''}" data-tag="${escHtml(tag)}">${escHtml(tag)} <span>${count}</span></button>`
    ).join('');
    tagBar.querySelectorAll('.tag-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => { activePaperTagFilter = btn.dataset.tag; renderPapersShelf(); });
    });

    // 状态筛选
    const statusCounts = { '全部': papers.length };
    papers.forEach(p => { const s = p.status || 'unread'; statusCounts[s] = (statusCounts[s] || 0) + 1; });
    statusBar.innerHTML = `<button class="status-filter-btn${activePaperStatusFilter === '全部' ? ' active' : ''}" data-status="全部">全部 <span>${papers.length}</span></button>` +
        Object.entries(READING_STATUS).map(([key, label]) => {
            const count = statusCounts[key] || 0;
            return `<button class="status-filter-btn${activePaperStatusFilter === key ? ' active' : ''}" data-status="${key}">
                <span class="status-dot status-dot-${key}"></span>${label} <span>${count}</span></button>`;
        }).join('');
    statusBar.querySelectorAll('.status-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => { activePaperStatusFilter = btn.dataset.status; renderPapersShelf(); });
    });

    // 筛选
    let filtered = papers;
    if (activePaperTagFilter !== '全部') filtered = filtered.filter(p => (p.tags[0] || '其他') === activePaperTagFilter);
    if (activePaperStatusFilter !== '全部') filtered = filtered.filter(p => (p.status || 'unread') === activePaperStatusFilter);

    if (filtered.length === 0) {
        container.innerHTML = '<div class="empty-shelf"><p>没有匹配的论文</p></div>';
        lucide.createIcons();
        return;
    }

    container.innerHTML = `<div class="papers-grid">${filtered.map(paper => {
        const hasRealCover = paper.cover && paper.cover.startsWith('data:');
        const coverSrc = hasRealCover ? paper.cover : generatePlaceholder(paper.name);
        const statusLabel = READING_STATUS[paper.status || 'unread'] || '未读';
        const metaParts = [];
        if (paper.author) metaParts.push(paper.author);
        if (paper.year) metaParts.push(paper.year);
        if (paper.pageCount) metaParts.push(paper.pageCount + '页');
        return `<div class="paper-card" data-id="${paper.id}">
            <div class="paper-card-cover">
                <img src="${coverSrc}" alt="${escHtml(paper.name)}" loading="lazy">
                <span class="paper-status-badge ${paper.status || 'unread'}">${statusLabel}</span>
            </div>
            <div class="paper-card-body">
                <div class="paper-card-title">${escHtml(paper.name)}</div>
                <div class="paper-card-meta">${escHtml(metaParts.join(' · ') || '暂无元数据')}</div>
            </div>
        </div>`;
    }).join('')}</div>`;

    container.querySelectorAll('.paper-card').forEach(card => {
        card.addEventListener('click', () => openPaperDetail(card.dataset.id));
    });
    lucide.createIcons();
}

/** 论文一键去重 */
async function dedupPapers() {
    const seen = new Map();
    const toRemove = [];
    papers.forEach(p => {
        if (seen.has(p.name)) toRemove.push(p);
        else seen.set(p.name, p);
    });
    if (toRemove.length === 0) { showToast('没有发现重复论文'); return; }
    for (const p of toRemove) await localforage.removeItem('pdf_paper_' + p.id);
    const removeIds = new Set(toRemove.map(p => p.id));
    readingStats = readingStats.filter(r => !removeIds.has(r.bookId));
    papers = papers.filter(p => !removeIds.has(p.id));
    await savePapers();
    await saveStats();
    renderPapersShelf();
    showToast(`已去除 ${toRemove.length} 篇重复论文`);
}

// ============================================================
//  论文详情页
// ============================================================
async function openPaperDetail(paperId) {
    const paper = papers.find(p => p.id === paperId);
    if (!paper) return;

    const hasRealCover = paper.cover && paper.cover.startsWith('data:');
    const coverSrc = hasRealCover ? paper.cover : generatePlaceholder(paper.name);
    if (!paper.coverColor) {
        paper.coverColor = await extractDominantColor(coverSrc);
        await savePapers();
    }

    const content = document.getElementById('paper-detail-content');
    content.innerHTML = `
        <div class="detail-hero">
            <img class="detail-hero-blur" src="${coverSrc}">
            <div class="detail-hero-fade"></div>
        </div>
        <div class="detail-body">
            <div class="detail-top">
                <div class="detail-cover"><img src="${coverSrc}"></div>
                <div class="detail-meta">
                    <h2 class="detail-book-name" id="paper-detail-name" title="点击编辑">${escHtml(paper.name)}</h2>
                    <div class="tag-editor" id="paper-tag-editor">
                        <span class="tag tag-current" id="paper-tag-current" title="点击修改分类">
                            ${escHtml(paper.tags[0] || '其他')}
                            <i data-lucide="chevron-down" style="width:12px;height:12px;margin-left:4px;"></i>
                        </span>
                        <div class="tag-dropdown" id="paper-tag-dropdown">
                            <div class="tag-dropdown-list" id="paper-tag-dropdown-list"></div>
                            <div class="tag-dropdown-custom">
                                <input type="text" id="paper-tag-custom-input" placeholder="自定义分类..." maxlength="20">
                                <button class="btn btn-primary btn-sm" id="paper-tag-custom-add">添加</button>
                            </div>
                        </div>
                    </div>
                    ${paper.pageCount ? `<div class="info">${paper.pageCount} 页</div>` : ''}
                    <div class="info">添加于 ${new Date(paper.addedAt).toLocaleDateString('zh-CN')}</div>
                </div>
            </div>
            <!-- 阅读状态 -->
            <div class="summary-card" style="margin-top:16px;">
                <div class="summary-header"><i data-lucide="book-marked"></i><span>阅读状态</span></div>
                <div class="status-selector">
                    ${Object.entries(READING_STATUS).map(([key, label]) =>
                        `<button class="status-option${paper.status === key ? ' active' : ''}" data-status="${key}">
                            <span class="status-dot status-dot-${key}"></span>${label}
                        </button>`
                    ).join('')}
                </div>
            </div>
            <!-- 元数据 -->
            <div class="summary-card">
                <div class="summary-header"><i data-lucide="info"></i><span>论文信息</span></div>
                <div class="meta-edit-row"><label>作者</label><input type="text" class="meta-field" data-field="author" value="${escHtml(paper.author || '')}" placeholder="作者姓名"></div>
                <div class="meta-edit-row"><label>期刊</label><input type="text" class="meta-field" data-field="journal" value="${escHtml(paper.journal || '')}" placeholder="期刊/会议名称"></div>
                <div class="meta-edit-row"><label>年份</label><input type="text" class="meta-field" data-field="year" value="${escHtml(paper.year || '')}" placeholder="发表年份"></div>
                <div class="meta-edit-row"><label>DOI</label><input type="text" class="meta-field" data-field="doi" value="${escHtml(paper.doi || '')}" placeholder="DOI 编号"></div>
                <div class="meta-edit-row"><label>URL</label><input type="text" class="meta-field" data-field="url" value="${escHtml(paper.url || '')}" placeholder="论文链接"></div>
            </div>
            <!-- 操作按钮 -->
            <div class="detail-actions">
                <button class="btn btn-primary" id="btn-paper-read-${paper.id}"><i data-lucide="book-open"></i> 阅读</button>
                <button class="btn" id="btn-paper-qv-${paper.id}"><i data-lucide="zap"></i> 速览</button>
                <button class="btn" id="btn-paper-cover-${paper.id}"><i data-lucide="palette"></i> 封面</button>
                <button class="btn btn-delete" id="btn-paper-del-${paper.id}"><i data-lucide="trash-2"></i> 删除</button>
            </div>
            <!-- 读书笔记 -->
            <div class="summary-card">
                <div class="summary-header"><i data-lucide="file-text"></i><span>读书笔记</span></div>
                <textarea id="paper-description" class="book-desc-textarea" placeholder="写下你对这篇论文的想法...">${escHtml(paper.description || '')}</textarea>
            </div>
        </div>`;

    // 绑定按钮
    document.getElementById(`btn-paper-read-${paper.id}`).addEventListener('click', () => startPaperReading(paper.id));
    document.getElementById(`btn-paper-qv-${paper.id}`).addEventListener('click', () => { closePaperDetail(); startPaperReading(paper.id, true); });
    document.getElementById(`btn-paper-cover-${paper.id}`).addEventListener('click', () => openCoverGen(paper.id));
    document.getElementById(`btn-paper-del-${paper.id}`).addEventListener('click', () => deletePaper(paper.id));

    // 状态选择器
    content.querySelectorAll('.status-option').forEach(btn => {
        btn.addEventListener('click', async () => {
            paper.status = btn.dataset.status;
            await savePapers();
            content.querySelectorAll('.status-option').forEach(b => b.classList.toggle('active', b.dataset.status === paper.status));
            renderPapersShelf();
        });
    });

    // 元数据自动保存
    let metaTimer = null;
    content.querySelectorAll('.meta-field').forEach(input => {
        input.addEventListener('input', () => {
            clearTimeout(metaTimer);
            metaTimer = setTimeout(async () => {
                paper[input.dataset.field] = input.value;
                await savePapers();
                renderPapersShelf();
            }, 500);
        });
    });

    // 标签编辑器
    setupPaperTagEditor(paper);

    // 书名编辑
    setupPaperNameEditor(paper);

    // 笔记自动保存
    const descTA = document.getElementById('paper-description');
    let descTimer = null;
    descTA.addEventListener('input', () => {
        clearTimeout(descTimer);
        descTimer = setTimeout(async () => { paper.description = descTA.value; await savePapers(); }, 500);
    });

    document.getElementById('paper-detail-overlay').classList.add('open');
    lucide.createIcons();
}

function setupPaperTagEditor(paper) {
    const current = document.getElementById('paper-tag-current');
    const dropdown = document.getElementById('paper-tag-dropdown');
    const list = document.getElementById('paper-tag-dropdown-list');
    const customInput = document.getElementById('paper-tag-custom-input');
    const customAdd = document.getElementById('paper-tag-custom-add');
    if (!current) return;

    const allTags = new Set(DEFAULT_PAPER_TAGS);
    papers.forEach(p => (p.tags || []).forEach(t => allTags.add(t)));

    function renderTagList() {
        list.innerHTML = '';
        allTags.forEach(tag => {
            const div = document.createElement('div');
            div.className = 'tag-option' + (tag === paper.tags[0] ? ' active' : '');
            div.textContent = tag;
            div.addEventListener('click', () => {
                paper.tags = [tag];
                current.innerHTML = escHtml(tag) + ' <i data-lucide="chevron-down" style="width:12px;height:12px;margin-left:4px;"></i>';
                dropdown.classList.remove('open');
                lucide.createIcons();
                savePapers();
                renderPapersShelf();
            });
            list.appendChild(div);
        });
    }

    current.addEventListener('click', (e) => { e.stopPropagation(); renderTagList(); dropdown.classList.toggle('open'); });
    dropdown.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', (e) => { if (!dropdown.contains(e.target) && e.target !== current) dropdown.classList.remove('open'); });
    customAdd.addEventListener('click', () => {
        const val = customInput.value.trim();
        if (!val) return;
        allTags.add(val);
        paper.tags = [val];
        current.innerHTML = escHtml(val) + ' <i data-lucide="chevron-down" style="width:12px;height:12px;margin-left:4px;"></i>';
        dropdown.classList.remove('open');
        lucide.createIcons();
        savePapers();
        renderPapersShelf();
        customInput.value = '';
    });
    customInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') customAdd.click(); });
}

function setupPaperNameEditor(paper) {
    const el = document.getElementById('paper-detail-name');
    if (!el) return;
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'text'; input.value = paper.name;
        input.style.cssText = 'font-size:inherit;font-weight:inherit;color:inherit;background:var(--bg-surface-hover);border:1px solid var(--accent);border-radius:6px;padding:2px 8px;outline:none;width:100%;box-sizing:border-box;';
        el.replaceWith(input); input.focus(); input.select();
        async function save() {
            const newName = input.value.trim();
            if (newName && newName !== paper.name) { paper.name = newName; await savePapers(); }
            const h2 = document.createElement('h2');
            h2.className = 'detail-book-name'; h2.id = 'paper-detail-name';
            h2.title = '点击编辑'; h2.style.cursor = 'pointer'; h2.textContent = paper.name;
            input.replaceWith(h2); setupPaperNameEditor(paper);
        }
        input.addEventListener('blur', save);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = paper.name; input.blur(); } });
    });
}

function closePaperDetail() {
    document.getElementById('paper-detail-overlay').classList.remove('open');
}

async function deletePaper(paperId) {
    if (!confirm('确定删除这篇论文吗？')) return;
    papers = papers.filter(p => p.id !== paperId);
    readingStats = readingStats.filter(s => s.bookId !== paperId);
    await localforage.removeItem('pdf_paper_' + paperId);
    await savePapers();
    await saveStats();
    closePaperDetail();
    renderPapersShelf();
}

// ============================================================
//  论文阅读器
// ============================================================
async function startPaperReading(paperId, autoQuickView) {
    const paper = papers.find(p => p.id === paperId);
    if (!paper) return;

    if (!paper._pdfUint8) {
        const data = await loadPaperPdfData(paperId);
        if (!data) { alert('PDF 数据丢失，请重新导入'); return; }
        paper._pdfUint8 = data;
    }

    closePaperDetail();
    isPaperReader = true;
    readStartTime = Date.now();
    currentBookId = paperId;
    currentPage = 1;
    currentZoom = 1.5;
    openedCount++;
    highlightMode = false;
    selectedHighlight = null;
    await saveStats();

    // 显示论文专用按钮
    document.querySelectorAll('.paper-only-btn').forEach(b => b.classList.remove('hidden'));

    document.getElementById('reader-title').textContent = paper.name;
    document.getElementById('reader-overlay').classList.add('open');
    lucide.createIcons();

    // 标记为在读
    if (paper.status === 'unread') {
        paper.status = 'reading';
        await savePapers();
        renderPapersShelf();
    }

    initNotesPanel(paper);

    try {
        pdfDoc = await parsePdf(paper._pdfUint8, 30000);
        totalPages = pdfDoc.numPages;

        const lastRead = [...readingStats].reverse().find(s => s.bookId === paperId);
        if (lastRead && lastRead.page) currentPage = Math.min(lastRead.page, totalPages);
        if (readMode === 'double') currentPage = Math.ceil(currentPage / 2) * 2 - 1;

        updateModeButtons();
        await renderByMode();
        loadOutline();

        if (autoQuickView) openQuickView();
    } catch (e) {
        document.getElementById('reader-body').innerHTML = `
            <div class="loading-center" style="flex-direction:column;gap:12px;">
                <i data-lucide="alert-circle" style="width:48px;height:48px;color:#71717a;"></i>
                <p style="color:var(--text-secondary);">PDF 解析失败</p>
                <p style="color:var(--text-tertiary);font-size:13px;">${escHtml(e.message)}</p>
            </div>`;
        lucide.createIcons();
    }
}
function renderShelf() {
    const container = document.getElementById('shelf-container');
    const filterBar = document.getElementById('tag-filter-bar');
    const actionsBar = document.getElementById('shelf-actions');

    if (library.length === 0) {
        filterBar.innerHTML = '';
        if (actionsBar) actionsBar.style.display = 'none';
        container.innerHTML = `
            <div class="empty-shelf">
                <i data-lucide="book-open"></i>
                <p>书架空空如也</p>
                <p class="hint">点击右上角「导入」按钮添加 PDF 电子书</p>
            </div>`;
        lucide.createIcons();
        return;
    }

    if (actionsBar) actionsBar.style.display = '';

    // 收集所有标签及其数量
    const tagCounts = { '全部': library.length };
    library.forEach(b => {
        const tag = b.tags[0] || '其他';
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    });

    // 渲染标签筛选栏
    let filterHtml = '';
    for (const [tag, count] of Object.entries(tagCounts)) {
        const active = tag === activeTagFilter ? ' active' : '';
        filterHtml += `<button class="tag-filter-btn${active}" data-tag="${escHtml(tag)}">${escHtml(tag)} <span>${count}</span></button>`;
    }
    filterBar.innerHTML = filterHtml;

    filterBar.querySelectorAll('.tag-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            activeTagFilter = btn.dataset.tag;
            renderShelf();
        });
    });

    // 筛选书籍
    const filtered = activeTagFilter === '全部'
        ? library
        : library.filter(b => (b.tags[0] || '其他') === activeTagFilter);

    // 按标签分组（全部模式下分组，筛选模式下不分组）
    let html = '';
    if (activeTagFilter === '全部') {
        const groups = {};
        filtered.forEach(b => {
            const tag = b.tags[0] || '其他';
            if (!groups[tag]) groups[tag] = [];
            groups[tag].push(b);
        });
        for (const [tag, books] of Object.entries(groups)) {
            html += renderBookGroup(tag, books);
        }
    } else {
        html = renderBookGroup(activeTagFilter, filtered);
    }

    container.innerHTML = html;

    // 绑定点击事件
    container.querySelectorAll('.book-card').forEach(card => {
        card.addEventListener('click', () => openDetail(card.dataset.id));
    });

    // 绑定字号滑块
    container.querySelectorAll('.font-size-slider').forEach(slider => {
        slider.addEventListener('input', (e) => {
            e.stopPropagation();
            const val = parseInt(slider.value);
            bookNameFontSize = val;
            container.querySelectorAll('.book-card-name').forEach(name => {
                name.style.fontSize = val + 'px';
            });
        });
        slider.addEventListener('change', async () => {
            await localforage.setItem('bookNameFontSize', bookNameFontSize);
        });
        slider.addEventListener('click', e => e.stopPropagation());
        slider.addEventListener('mousedown', e => e.stopPropagation());
    });

    lucide.createIcons();
}

function renderBookGroup(tag, books) {
    let html = `<div class="shelf-group-label">${escHtml(tag)} <span>(${books.length})</span></div>`;
    html += `<div class="bookshelf">`;
    for (const book of books) {
        const hasRealCover = book.cover && book.cover.startsWith('data:');
        const coverSrc = hasRealCover ? book.cover : generatePlaceholder(book.name);
        html += `
            <div class="book-card" data-id="${book.id}">
                <div class="book-cover">
                    <img src="${coverSrc}" alt="${escHtml(book.name)}" loading="lazy">
                    <div class="book-spine" style="background:linear-gradient(to right, ${book.coverColor || 'var(--accent)'}, transparent);"></div>
                    <div class="book-title-overlay">
                        <div class="name">${escHtml(book.name)}</div>
                        ${book.pageCount ? `<div class="pages">${book.pageCount} 页</div>` : ''}
                    </div>
                </div>
                <div class="book-card-name" style="font-size:${bookNameFontSize}px">${escHtml(book.name)}</div>
                <div class="font-size-control" title="拖动调整字号">
                    <span class="font-size-icon">A</span>
                    <input type="range" class="font-size-slider" min="12" max="48" value="${bookNameFontSize}" data-stop-prop="true">
                    <span class="font-size-icon" style="font-size:16px">A</span>
                </div>
            </div>`;
    }
    html += `</div>`;
    return html;
}

// ============================================================
//  书籍详情页
// ============================================================
async function openDetail(bookId) {
    const book = library.find(b => b.id === bookId);
    if (!book) return;

    const hasRealCover = book.cover && book.cover.startsWith('data:');
    const coverSrc = hasRealCover ? book.cover : generatePlaceholder(book.name);

    // 提取封面主色
    if (!book.coverColor) {
        book.coverColor = await extractDominantColor(coverSrc);
        await saveLibrary();
    }

    const bookDesc = book.description || '';
    const content = document.getElementById('detail-content');

    content.innerHTML = `
        <div class="detail-hero">
            <img class="detail-hero-blur" src="${coverSrc}">
            <div class="detail-hero-fade"></div>
        </div>
        <div class="detail-body">
            <div class="detail-top">
                <div class="detail-cover">
                    <img src="${coverSrc}">
                </div>
                <div class="detail-meta">
                    <h2 class="detail-book-name" id="detail-book-name" title="点击编辑书名">${escHtml(book.name)}</h2>
                    <div class="tag-editor" id="tag-editor">
                        <span class="tag tag-current" id="tag-current" title="点击修改分类">
                            ${escHtml(book.tags[0] || '其他')}
                            <i data-lucide="chevron-down" style="width:12px;height:12px;margin-left:4px;"></i>
                        </span>
                        <div class="tag-dropdown" id="tag-dropdown">
                            <div class="tag-dropdown-list" id="tag-dropdown-list"></div>
                            <div class="tag-dropdown-custom">
                                <input type="text" id="tag-custom-input" placeholder="自定义分类..." maxlength="20">
                                <button class="btn btn-primary btn-sm" id="tag-custom-add">添加</button>
                            </div>
                        </div>
                    </div>
                    ${book.pageCount ? `<div class="info">${book.pageCount} 页</div>` : ''}
                    <div class="info">添加于 ${new Date(book.addedAt).toLocaleDateString('zh-CN')}</div>
                    ${(() => {
                        const bookMin = readingStats.filter(s => s.bookId === book.id).reduce((s, r) => s + r.duration, 0);
                        return bookMin > 0 ? `<div class="info">已读 ${bookMin >= 60 ? (bookMin / 60).toFixed(1) + ' 小时' : bookMin + ' 分钟'}</div>` : '';
                    })()}
                </div>
            </div>
            <div class="detail-actions">
                <button class="btn btn-primary" id="btn-read-${book.id}">
                    <i data-lucide="book-open"></i> 开始阅读
                </button>
                <button class="btn" id="btn-cover-${book.id}">
                    <i data-lucide="palette"></i> 生成封面
                </button>
                <button class="btn btn-delete" id="btn-del-${book.id}">
                    <i data-lucide="trash-2"></i> 删除
                </button>
            </div>
            <div class="summary-card">
                <div class="summary-header">
                    <i data-lucide="file-text"></i>
                    <span>读书笔记</span>
                </div>
                <textarea id="book-description" class="book-desc-textarea" placeholder="写下你对这本书的想法...">${escHtml(bookDesc)}</textarea>
            </div>
        </div>`;

    // 绑定按钮
    document.getElementById(`btn-read-${book.id}`).addEventListener('click', () => startReading(book.id));
    document.getElementById(`btn-cover-${book.id}`).addEventListener('click', () => openCoverGen(book.id));
    document.getElementById(`btn-del-${book.id}`).addEventListener('click', () => deleteBook(book.id));

    // 设置标签编辑器
    setupTagEditor(book);

    // 设置书名编辑
    setupBookNameEditor(book);

    // 设置读书笔记自动保存
    setupDescriptionEditor(book);

    document.getElementById('detail-overlay').classList.add('open');
    lucide.createIcons();
}

// ============================================================
//  标签编辑器
// ============================================================
const DEFAULT_TAGS = ['技术', '文学', '历史', '科学', '哲学', '商业', '艺术', '其他'];

function setupTagEditor(book) {
    const current = document.getElementById('tag-current');
    const dropdown = document.getElementById('tag-dropdown');
    const list = document.getElementById('tag-dropdown-list');
    const customInput = document.getElementById('tag-custom-input');
    const customAdd = document.getElementById('tag-custom-add');

    // 收集所有已有的标签
    const allTags = new Set(DEFAULT_TAGS);
    library.forEach(b => (b.tags || []).forEach(t => allTags.add(t)));

    function renderTagList() {
        list.innerHTML = '';
        allTags.forEach(tag => {
            const div = document.createElement('div');
            div.className = 'tag-option' + (tag === book.tags[0] ? ' active' : '');
            div.textContent = tag;
            div.addEventListener('click', () => selectTag(tag));
            list.appendChild(div);
        });
    }

    function selectTag(tag) {
        book.tags = [tag];
        current.innerHTML = escHtml(tag) + ' <i data-lucide="chevron-down" style="width:12px;height:12px;margin-left:4px;"></i>';
        dropdown.classList.remove('open');
        lucide.createIcons();
        saveLibrary();
        renderShelf(); // 更新书架分组
    }

    // 点击当前标签打开/关闭下拉
    current.addEventListener('click', (e) => {
        e.stopPropagation();
        renderTagList();
        dropdown.classList.toggle('open');
    });
    dropdown.addEventListener('click', (e) => e.stopPropagation());

    // 点击其他地方关闭
    document.addEventListener('click', (e) => {
        if (!dropdown.contains(e.target) && e.target !== current) {
            dropdown.classList.remove('open');
        }
    });

    // 自定义标签
    customAdd.addEventListener('click', () => {
        const val = customInput.value.trim();
        if (!val) return;
        allTags.add(val);
        selectTag(val);
        customInput.value = '';
    });
    customInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') customAdd.click();
    });
}

// ============================================================
//  书名编辑
// ============================================================
function setupBookNameEditor(book) {
    const el = document.getElementById('detail-book-name');
    if (!el) return;

    el.style.cursor = 'pointer';
    el.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = book.name;
        input.className = 'detail-book-name-input';
        input.style.cssText = 'font-size:inherit;font-weight:inherit;color:inherit;background:var(--bg-surface-hover);border:1px solid var(--accent);border-radius:6px;padding:2px 8px;outline:none;width:100%;box-sizing:border-box;';

        el.replaceWith(input);
        input.focus();
        input.select();

        async function save() {
            const newName = input.value.trim();
            if (newName && newName !== book.name) {
                book.name = newName;
                await saveLibrary();
            }
            const h2 = document.createElement('h2');
            h2.className = 'detail-book-name';
            h2.id = 'detail-book-name';
            h2.title = '点击编辑书名';
            h2.style.cursor = 'pointer';
            h2.textContent = book.name;
            input.replaceWith(h2);
            setupBookNameEditor(book);
        }

        input.addEventListener('blur', save);
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') input.blur();
            if (e.key === 'Escape') { input.value = book.name; input.blur(); }
        });
    });
}

// ============================================================
//  读书笔记编辑
// ============================================================
function setupDescriptionEditor(book) {
    const textarea = document.getElementById('book-description');
    if (!textarea) return;
    let saveTimer = null;
    textarea.addEventListener('input', () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(async () => {
            book.description = textarea.value;
            await saveLibrary();
        }, 500);
    });
}

function closeDetail() {
    document.getElementById('detail-overlay').classList.remove('open');
}

// ============================================================
//  PDF 阅读器
// ============================================================
async function startReading(bookId) {
    const book = library.find(b => b.id === bookId);
    if (!book) return;

    // 如果内存中没有 PDF 数据，从 localForage 加载
    if (!book._pdfUint8) {
        const data = await loadPdfData(bookId);
        if (!data) { alert('PDF 数据丢失，请重新导入'); return; }
        book._pdfUint8 = data;
    }

    closeDetail();
    readStartTime = Date.now();
    currentBookId = bookId;
    currentPage = 1;
    currentZoom = 1.5;
    openedCount++;
    await saveStats();

    document.getElementById('reader-title').textContent = book.name;
    document.getElementById('reader-overlay').classList.add('open');
    lucide.createIcons();

    // 初始化笔记面板
    initNotesPanel(book);

    try {
        pdfDoc = await parsePdf(book._pdfUint8, 30000);

        totalPages = pdfDoc.numPages;

        // 恢复到上次阅读页
        const lastRead = [...readingStats].reverse().find(s => s.bookId === bookId);
        if (lastRead && lastRead.page) {
            currentPage = Math.min(lastRead.page, totalPages);
        }
        if (readMode === 'double') currentPage = Math.ceil(currentPage / 2) * 2 - 1;

        // 同步模式按钮状态
        updateModeButtons();
        await renderByMode();
        loadOutline();
    } catch (e) {
        document.getElementById('reader-body').innerHTML = `
            <div class="loading-center" style="flex-direction:column;gap:12px;">
                <i data-lucide="alert-circle" style="width:48px;height:48px;color:#71717a;"></i>
                <p style="color:var(--text-secondary);">PDF 解析失败</p>
                <p style="color:var(--text-tertiary);font-size:13px;">${escHtml(e.message)}</p>
            </div>`;
        lucide.createIcons();
    }
}

// ============================================================
//  笔记面板
// ============================================================
function initNotesPanel(book) {
    const panel = document.getElementById('notes-panel');
    const textarea = document.getElementById('notes-textarea');
    const drawWrap = document.getElementById('notes-draw-wrap');

    // 重置面板状态
    panel.classList.add('collapsed');
    currentNotesTab = 'edit';
    updateNotesTabUI();

    // 加载笔记内容
    textarea.value = book.notes ? book.notes.text || '' : '';

    // 清空画布
    drawWrap.classList.add('hidden');

    // 销毁旧的 signaturePad
    if (signaturePad) { signaturePad.off(); signaturePad = null; }

    // 初始渲染预览
    renderNotesPreview();

    // 绑定 textarea 实时预览 + 自动保存
    textarea.oninput = () => {
        renderNotesPreview();
        clearTimeout(notesSaveTimer);
        notesSaveTimer = setTimeout(() => saveCurrentNotes(), 500);
    };
}

async function toggleNotesPanel() {
    const panel = document.getElementById('notes-panel');
    const collapsing = !panel.classList.contains('collapsed');
    panel.classList.toggle('collapsed');
    if (!collapsing) {
        const savedWidth = await localforage.getItem('notesPanelWidth');
        if (savedWidth) panel.style.width = savedWidth + 'px';
        if (currentNotesTab === 'draw') initSignaturePad();
    }
}

function switchNotesTab(tab) {
    currentNotesTab = tab;
    updateNotesTabUI();

    const editWrap = document.getElementById('notes-edit-wrap');
    const drawWrap = document.getElementById('notes-draw-wrap');

    editWrap.classList.toggle('hidden', tab !== 'edit');
    drawWrap.classList.toggle('hidden', tab !== 'draw');

    if (tab === 'edit') {
        renderNotesPreview();
    }
    if (tab === 'draw') {
        initSignaturePad();
    }
}

function updateNotesTabUI() {
    document.querySelectorAll('.notes-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.notesTab === currentNotesTab);
    });
}

function renderNotesPreview() {
    const textarea = document.getElementById('notes-textarea');
    const preview = document.getElementById('notes-preview');
    const text = textarea.value;
    if (!text) {
        preview.innerHTML = '<span style="color:var(--text-tertiary);">暂无笔记，在「编写」tab 中输入内容</span>';
        return;
    }

    let html = (typeof marked !== 'undefined') ? marked.parse(text) : escHtml(text);

    // KaTeX 数学公式渲染：先处理 $$...$$ 块级，再处理 $...$ 行内
    if (typeof katex !== 'undefined') {
        html = html.replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => {
            try { return katex.renderToString(expr.trim(), { displayMode: true, throwOnError: false }); }
            catch { return `<code>${escHtml(expr)}</code>`; }
        });
        html = html.replace(/\$([^\$\n]+?)\$/g, (_, expr) => {
            try { return katex.renderToString(expr.trim(), { displayMode: false, throwOnError: false }); }
            catch { return `<code>${escHtml(expr)}</code>`; }
        });
    }

    preview.innerHTML = html;
}

function initSignaturePad() {
    const canvas = document.getElementById('draw-canvas');
    if (!canvas) return;

    // 如果已初始化且有效，不重复创建
    if (signaturePad && signaturePad._canvas === canvas) return;

    // 适配 canvas 尺寸
    const wrap = canvas.parentElement;
    const rect = wrap.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height - 44; // 减去 draw-actions 高度

    if (signaturePad) signaturePad.off();
    signaturePad = new SignaturePad(canvas, {
        penColor: document.body.classList.contains('light-theme') ? '#1a1a20' : '#e0e0e6',
        backgroundColor: 'rgba(0,0,0,0)',
        minWidth: 1,
        maxWidth: 3
    });

    // 加载已有的笔迹
    const item = isPaperReader
        ? papers.find(p => p.id === currentBookId)
        : library.find(b => b.id === currentBookId);
    if (item && item.notes && item.notes.drawing) {
        signaturePad.fromDataURL(item.notes.drawing);
    }

    // 笔迹变化时自动保存
    signaturePad.addEventListener('endStroke', () => {
        clearTimeout(notesSaveTimer);
        notesSaveTimer = setTimeout(() => saveCurrentNotes(), 500);
    });

    signaturePad._canvas = canvas;
}

async function saveCurrentNotes() {
    if (!currentBookId) return;
    const item = isPaperReader
        ? papers.find(p => p.id === currentBookId)
        : library.find(b => b.id === currentBookId);
    if (!item) return;

    if (!item.notes) item.notes = { text: '', drawing: null };

    const textarea = document.getElementById('notes-textarea');
    if (textarea) item.notes.text = textarea.value;

    if (signaturePad && !signaturePad.isEmpty()) {
        item.notes.drawing = signaturePad.toDataURL();
    }

    if (isPaperReader) await savePapers();
    else await saveLibrary();
}

// ---- 笔记导出（保存到 exe 所在目录的 notes/ 子文件夹） ----
let _exeDir = null;
async function getExeDir() {
    if (_exeDir) return _exeDir;
    try {
        _exeDir = await window.__TAURI__.core.invoke('get_exe_dir');
        return _exeDir;
    } catch (e) {
        console.warn('[Lumina] 获取 exe 目录失败:', e);
        return null;
    }
}

function getCurrentNoteItem() {
    return isPaperReader
        ? papers.find(p => p.id === currentBookId)
        : library.find(b => b.id === currentBookId);
}

function sanitizeFilename(name) {
    return (name || '未命名').replace(/[\\/:*?"<>|]/g, '_').substring(0, 80);
}

function dataUrlToBytes(dataUrl) {
    const base64 = dataUrl.split(',')[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/** 将透明底的 dataUrl 图片合成到白底上，返回 PNG Uint8Array */
function dataUrlToWhiteBgBytes(dataUrl) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const cvs = document.createElement('canvas');
            cvs.width = img.width;
            cvs.height = img.height;
            const ctx = cvs.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, cvs.width, cvs.height);
            ctx.drawImage(img, 0, 0);
            cvs.toBlob((blob) => {
                blob.arrayBuffer().then(buf => resolve(new Uint8Array(buf)));
            }, 'image/png');
        };
        img.onerror = () => resolve(dataUrlToBytes(dataUrl)); // fallback
        img.src = dataUrl;
    });
}

async function saveFileViaTauri(path, contents) {
    try {
        await window.__TAURI__.core.invoke('save_file', { path, contents: Array.from(contents) });
        return true;
    } catch (e) {
        console.error('[Lumina] 保存文件失败:', e);
        showToast('保存失败: ' + e);
        return false;
    }
}

async function exportNotesAsMd() {
    const item = getCurrentNoteItem();
    if (!item) { showToast('请先打开一本书'); return; }

    const hasText = item.notes && item.notes.text && item.notes.text.trim();
    const hasDrawing = item.notes && item.notes.drawing;

    if (!hasText && !hasDrawing) {
        showToast('暂无笔记内容');
        return;
    }

    const exeDir = await getExeDir();
    if (!exeDir) { showToast('无法获取应用目录'); return; }

    const safeName = sanitizeFilename(item.name);
    const dir = exeDir + '\\notes\\' + safeName;

    // 如果有手写，先把图片单独存为 PNG（白底），md 里用相对路径引用
    let mdContent = `# ${item.name}\n\n`;
    if (hasText) mdContent += item.notes.text + '\n';
    if (hasDrawing) {
        const imgBytes = await dataUrlToWhiteBgBytes(item.notes.drawing);
        const imgPath = dir + '\\drawing.png';
        const saved = await saveFileViaTauri(imgPath, imgBytes);
        if (saved) {
            mdContent += '\n\n## 手写笔记\n\n![手写笔记](drawing.png)\n';
        }
    }

    const mdPath = dir + '\\' + safeName + '.md';
    const encoder = new TextEncoder();
    const ok = await saveFileViaTauri(mdPath, encoder.encode(mdContent));
    if (ok) showToast('已导出到 notes\\' + safeName);
}

async function exportNotesDrawing() {
    const item = getCurrentNoteItem();
    if (!item || !item.notes || !item.notes.drawing) {
        showToast('暂无手写笔记');
        return;
    }

    const exeDir = await getExeDir();
    if (!exeDir) { showToast('无法获取应用目录'); return; }

    const safeName = sanitizeFilename(item.name);
    const imgBytes = await dataUrlToWhiteBgBytes(item.notes.drawing);
    const imgPath = exeDir + '\\notes\\' + safeName + '\\drawing.png';
    const ok = await saveFileViaTauri(imgPath, imgBytes);
    if (ok) showToast('已导出到 notes\\' + safeName + '\\drawing.png');
}

function initNotesPanelResize() {
    const handle = document.getElementById('notes-panel-resize');
    const panel = document.getElementById('notes-panel');
    if (!handle || !panel) return;

    let startX, startWidth;

    handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        startX = e.clientX;
        startWidth = panel.offsetWidth;
        handle.classList.add('dragging');
        panel.style.transition = 'none';

        function onMove(e) {
            const dx = startX - e.clientX;
            panel.style.width = Math.max(220, Math.min(600, startWidth + dx)) + 'px';
        }

        function onUp() {
            handle.classList.remove('dragging');
            panel.style.transition = '';
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            localforage.setItem('notesPanelWidth', panel.offsetWidth);
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

function initNotesPanelDrag() {
    const header = document.getElementById('notes-panel-header');
    const panel = document.getElementById('notes-panel');
    if (!header || !panel) return;

    let startX, startY, startRight, startTop;

    header.addEventListener('mousedown', (e) => {
        if (e.target.closest('.btn-icon')) return;
        e.preventDefault();
        const rect = panel.getBoundingClientRect();
        const parentRect = panel.offsetParent.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        startRight = parentRect.right - rect.right;
        startTop = rect.top - parentRect.top;
        panel.style.transition = 'none';

        function onMove(e) {
            const dx = startX - e.clientX;
            const dy = e.clientY - startY;
            const pr = panel.offsetParent.getBoundingClientRect();
            const newRight = Math.max(0, Math.min(pr.width - 100, startRight + dx));
            const newTop = Math.max(0, Math.min(pr.height - 100, startTop + dy));
            panel.style.right = newRight + 'px';
            panel.style.top = newTop + 'px';
            panel.style.left = 'auto';
        }

        function onUp() {
            panel.style.transition = '';
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

// ============================================================
//  阅读模式切换
// ============================================================
function setReadMode(mode) {
    readMode = mode;
    localforage.setItem('readMode', mode);
    if (mode === 'double') currentPage = Math.ceil(currentPage / 2) * 2 - 1;
    updateModeButtons();
    cleanupScrollObserver();
    renderByMode();
}

function updateModeButtons() {
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === readMode);
    });
}

async function renderByMode() {
    if (!pdfDoc) return;
    if (readMode === 'single') await renderSinglePage();
    else if (readMode === 'double') await renderDoublePage();
    else if (readMode === 'scroll') await renderScrollMode();
}

function updatePageUI() {
    document.getElementById('page-indicator').textContent = `${currentPage} / ${totalPages}`;
    document.getElementById('zoom-indicator').textContent = `${Math.round(currentZoom / 1.5 * 100)}%`;
    document.getElementById('reader-progress-fill').style.width = `${(currentPage / totalPages) * 100}%`;
    updateTocHighlight();
    if (pdfSearchOpen && searchMatches.length > 0) renderSearchHighlights();
}

// ---- 单页模式 ----
async function renderSinglePage() {
    const page = await pdfDoc.getPage(currentPage);
    const viewport = page.getViewport({ scale: currentZoom });
    const w = Math.floor(viewport.width);
    const h = Math.floor(viewport.height);

    const body = document.getElementById('reader-body');
    body.className = 'reader-body';
    body.innerHTML = '';

    const canvas = document.createElement('canvas');
    canvas.id = 'pdf-canvas';
    canvas.width = w;
    canvas.height = h;
    canvas.style.display = 'block';
    canvas.style.margin = '0 auto';
    canvas.style.boxShadow = 'var(--shadow-canvas)';
    canvas.style.borderRadius = '4px';
    body.appendChild(canvas);

    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    canvas.classList.add('page-flip');
    setTimeout(() => canvas.classList.remove('page-flip'), 400);
    updatePageUI();
}

// ---- 双页模式 ----
async function renderDoublePage() {
    const leftPage = currentPage;
    const rightPage = currentPage + 1 <= totalPages ? currentPage + 1 : null;
    const gap = 16;

    const p1 = await pdfDoc.getPage(leftPage);
    const v1 = p1.getViewport({ scale: currentZoom });

    let canvasW, canvasH;
    let canvas;

    const body = document.getElementById('reader-body');
    body.className = 'reader-body';
    body.innerHTML = '';

    if (rightPage) {
        const p2 = await pdfDoc.getPage(rightPage);
        const v2 = p2.getViewport({ scale: currentZoom });
        canvasW = Math.floor(v1.width) + gap + Math.floor(v2.width);
        canvasH = Math.max(Math.floor(v1.height), Math.floor(v2.height));

        canvas = document.createElement('canvas');
        canvas.id = 'pdf-canvas';
        canvas.width = canvasW;
        canvas.height = canvasH;
        canvas.style.display = 'block';
        canvas.style.margin = '0 auto';
        canvas.style.boxShadow = 'var(--shadow-canvas)';
        canvas.style.borderRadius = '4px';
        body.appendChild(canvas);

        const ctx = canvas.getContext('2d');
        ctx.fillStyle = document.body.classList.contains('light-theme') ? '#e0e0e6' : '#1a1a20';
        ctx.fillRect(Math.floor(v1.width), 0, gap, canvasH);

        await p1.render({ canvasContext: ctx, viewport: v1 }).promise;
        ctx.save();
        ctx.translate(Math.floor(v1.width) + gap, 0);
        await p2.render({ canvasContext: ctx, viewport: v2 }).promise;
        ctx.restore();
    } else {
        canvasW = Math.floor(v1.width);
        canvasH = Math.floor(v1.height);

        canvas = document.createElement('canvas');
        canvas.id = 'pdf-canvas';
        canvas.width = canvasW;
        canvas.height = canvasH;
        canvas.style.display = 'block';
        canvas.style.margin = '0 auto';
        canvas.style.boxShadow = 'var(--shadow-canvas)';
        canvas.style.borderRadius = '4px';
        body.appendChild(canvas);

        await p1.render({ canvasContext: canvas.getContext('2d'), viewport: v1 }).promise;
    }

    canvas.classList.add('page-flip');
    setTimeout(() => canvas.classList.remove('page-flip'), 400);
    updatePageUI();
}

// ---- 滚动模式 ----
async function renderScrollMode() {
    const body = document.getElementById('reader-body');
    body.className = 'reader-scroll';
    body.innerHTML = '';

    // 先创建当前页附近的 canvas，立刻显示，其余分批创建
    const BATCH_SIZE = 50;
    const cur = currentPage;
    const startPage = Math.max(1, cur - 20);
    const endPage = Math.min(totalPages, cur + 20);

    // 第一批：当前页附近，立即创建并挂载
    const frag = document.createDocumentFragment();
    for (let i = startPage; i <= endPage; i++) {
        frag.appendChild(createScrollCanvas(i));
    }
    body.appendChild(frag);

    // IntersectionObserver 懒渲染
    cleanupScrollObserver();
    scrollObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const canvas = entry.target;
                const pn = parseInt(canvas.dataset.page);
                if (!canvas.dataset.rendered) renderScrollPage(canvas, pn);
                currentPage = pn;
                updatePageUI();
            }
        });
    }, { root: body, rootMargin: '200px', threshold: 0.01 });

    body.querySelectorAll('canvas').forEach(c => { c.dataset.observed = '1'; scrollObserver.observe(c); });
    updatePageUI();

    // 滚动到当前页
    const target = document.getElementById('scroll-page-' + currentPage);
    if (target) target.scrollIntoView({ behavior: 'instant', block: 'start' });

    // 剩余页面分批创建，每批之间让出主线程
    await createCanvasBatches(body, 1, startPage - 1, BATCH_SIZE);
    await createCanvasBatches(body, endPage + 1, totalPages, BATCH_SIZE);
}

function createScrollCanvas(pageNum) {
    const canvas = document.createElement('canvas');
    canvas.id = 'scroll-page-' + pageNum;
    canvas.dataset.page = pageNum;
    canvas.style.width = 'min(100%, ' + Math.round(612 * currentZoom / 1.5) + 'px)';
    return canvas;
}

async function createCanvasBatches(body, from, to, batchSize) {
    if (from > to) return;
    for (let start = from; start <= to; start += batchSize) {
        if (!pdfDoc) return; // 阅读器已关闭，中止
        const end = Math.min(to, start + batchSize - 1);
        const frag = document.createDocumentFragment();
        for (let i = start; i <= end; i++) {
            frag.appendChild(createScrollCanvas(i));
        }
        body.appendChild(frag);
        // 让出主线程，避免卡顿
        await new Promise(r => setTimeout(r, 0));
    }
    // 新加入的 canvas 也要被 observer 监听
    if (scrollObserver && pdfDoc) {
        body.querySelectorAll('canvas:not([data-observed])').forEach(c => {
            c.dataset.observed = '1';
            scrollObserver.observe(c);
        });
    }
}

async function renderScrollPage(canvas, pageNum) {
    if (canvas.dataset.rendered === '1') return;
    canvas.dataset.rendered = '1';
    try {
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: currentZoom });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = '';
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    } catch (e) {
        canvas.dataset.rendered = '';
        console.warn('渲染第', pageNum, '页失败:', e);
    }
}

function cleanupScrollObserver() {
    if (scrollObserver) { scrollObserver.disconnect(); scrollObserver = null; }
}

// ---- 导航 ----
function prevPage() {
    if (readMode === 'scroll') {
        const target = document.getElementById('scroll-page-' + Math.max(1, currentPage - 1));
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
    }
    const step = readMode === 'double' ? 2 : 1;
    if (currentPage > 1) { currentPage = Math.max(1, currentPage - step); renderByMode(); }
}
function nextPage() {
    if (readMode === 'scroll') {
        const target = document.getElementById('scroll-page-' + Math.min(totalPages, currentPage + 1));
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
    }
    const step = readMode === 'double' ? 2 : 1;
    if (currentPage < totalPages) { currentPage = Math.min(totalPages, currentPage + step); renderByMode(); }
}
function zoomIn() {
    if (currentZoom < 3) { currentZoom += 0.25; applyZoom(); }
}
function zoomOut() {
    if (currentZoom > 0.75) { currentZoom -= 0.25; applyZoom(); }
}
function applyZoom() {
    if (readMode === 'scroll') {
        const body = document.getElementById('reader-body');
        const curPage = currentPage;
        const curCanvas = document.getElementById('scroll-page-' + curPage);

        // 缩放前：记录当前页内的偏移比例
        let savedRatio = 0;
        if (curCanvas && curCanvas.offsetHeight > 0) {
            const bodyRect = body.getBoundingClientRect();
            const canvasTopInContent = curCanvas.getBoundingClientRect().top - bodyRect.top + body.scrollTop;
            savedRatio = (body.scrollTop - canvasTopInContent) / curCanvas.offsetHeight;
        }

        // 更新所有 canvas 占位宽度 + 重置渲染标记
        body.querySelectorAll('canvas').forEach(c => {
            c.dataset.rendered = '';
            c.style.width = 'min(100%, ' + Math.round(612 * currentZoom / 1.5) + 'px)';
        });

        // 立即渲染当前页，恢复位置后再渲染其他可见页
        if (curCanvas) {
            renderScrollPage(curCanvas, curPage).then(() => {
                const bodyRect = body.getBoundingClientRect();
                const canvasTopInContent = curCanvas.getBoundingClientRect().top - bodyRect.top + body.scrollTop;
                body.scrollTop = canvasTopInContent + savedRatio * curCanvas.offsetHeight;

                // 当前页位置恢复后，渲染其他可见页
                if (scrollObserver) {
                    body.querySelectorAll('canvas').forEach(c => {
                        if (c === curCanvas) return;
                        const rect = c.getBoundingClientRect();
                        const rootRect = body.getBoundingClientRect();
                        if (rect.top < rootRect.bottom && rect.bottom > rootRect.top) {
                            if (!c.dataset.rendered) renderScrollPage(c, parseInt(c.dataset.page));
                        }
                    });
                }
            });
        }

        updatePageUI();
    } else {
        // 单页/双页模式：直接重渲染
        renderByMode();
    }
}

/** 保存当前阅读进度（供 closeReader 和 beforeunload 调用） */
function recordReadingStat() {
    if (!readStartTime || !currentBookId) return;
    // Math.ceil：即使只读了 30 秒也记为 1 分钟，不丢数据
    const duration = Math.max(1, Math.ceil((Date.now() - readStartTime) / 60000));
    const now = new Date();
    readingStats.push({
        bookId: currentBookId,
        date: localDateStr(now),
        duration,
        page: currentPage,
        isPaper: isPaperReader || false,
        hour: now.getHours(),
        timestamp: now.getTime()
    });
    // 同步保存（不 await，供 beforeunload 使用）
    localforage.setItem('readingStats', readingStats);
    localforage.setItem('openedCount', openedCount);
    readStartTime = Date.now(); // 重置起点，避免重复累计
}

async function closeReader() {
    recordReadingStat();
    cleanupScrollObserver();
    exitHighlightMode();
    await saveCurrentNotes();

    const wasPaper = isPaperReader;

    document.getElementById('reader-overlay').classList.remove('open');
    document.getElementById('reader-body').innerHTML = '';
    document.getElementById('notes-panel').classList.add('collapsed');
    document.getElementById('notes-panel').style.right = '';
    document.getElementById('notes-panel').style.top = '';
    document.querySelectorAll('.paper-only-btn').forEach(b => b.classList.add('hidden'));
    document.getElementById('highlight-hint').classList.add('hidden');

    // 清理目录和搜索状态
    tocOpen = false;
    document.getElementById('toc-sidebar').classList.add('collapsed');
    closePdfSearch();
    pageTextCache = {};
    searchMatches = [];
    searchCurrentIdx = -1;
    tocOutline = null;

    pdfDoc = null;
    currentBookId = null;
    readStartTime = null;
    isPaperReader = false;
    highlightMode = false;

    if (wasPaper) renderPapersShelf();
    else renderShelf();
}

// ============================================================
//  删除书籍
// ============================================================
async function deleteBook(bookId) {
    if (!confirm('确定删除这本书吗？')) return;
    library = library.filter(b => b.id !== bookId);
    readingStats = readingStats.filter(s => s.bookId !== bookId);
    await localforage.removeItem('pdf_' + bookId); // 清理 PDF 二进制
    await saveLibrary();
    await saveStats();
    closeDetail();
    renderShelf();
}

// ============================================================
//  搜索书籍
// ============================================================
function openSearch() {
    document.getElementById('search-overlay').classList.add('open');
    const input = document.getElementById('search-input');
    input.value = '';
    renderSearchResults('');
    setTimeout(() => input.focus(), 100);
}

function closeSearch() {
    document.getElementById('search-overlay').classList.remove('open');
}

function renderSearchResults(query) {
    const container = document.getElementById('search-results');
    if (!query) {
        container.innerHTML = '<div class="search-result-empty">输入名称搜索书籍和论文</div>';
        return;
    }
    const q = query.toLowerCase();
    const bookMatches = library.filter(b => b.name.toLowerCase().includes(q)).map(b => ({ ...b, type: 'book' }));
    const paperMatches = papers.filter(p => {
        const searchStr = [p.name, p.author, p.journal, p.year].join(' ').toLowerCase();
        return searchStr.includes(q);
    }).map(p => ({ ...p, type: 'paper' }));
    const matches = [...bookMatches, ...paperMatches];
    if (matches.length === 0) {
        container.innerHTML = '<div class="search-result-empty">未找到匹配的内容</div>';
        return;
    }
    container.innerHTML = matches.map(item => {
        const hasRealCover = item.cover && item.cover.startsWith('data:');
        const coverSrc = hasRealCover ? item.cover : generatePlaceholder(item.name);
        const metaParts = item.type === 'paper'
            ? [item.author, item.year, READING_STATUS[item.status || 'unread']].filter(Boolean).join(' · ')
            : [item.tags[0] || '其他', item.pageCount ? item.pageCount + ' 页' : ''].filter(Boolean).join(' · ');
        return `<div class="search-result-item" data-id="${item.id}" data-type="${item.type}">
            <div class="search-result-cover"><img src="${coverSrc}" alt="${escHtml(item.name)}"></div>
            <div class="search-result-info">
                <div class="search-result-name">${item.type === 'paper' ? '[论文] ' : ''}${escHtml(item.name)}</div>
                <div class="search-result-meta">${escHtml(metaParts)}</div>
            </div>
        </div>`;
    }).join('');

    container.querySelectorAll('.search-result-item').forEach(item => {
        item.addEventListener('click', () => {
            closeSearch();
            if (item.dataset.type === 'paper') openPaperDetail(item.dataset.id);
            else openDetail(item.dataset.id);
        });
    });
}

// ============================================================
//  悬浮按钮组拖动 + 计算器
// ============================================================
function initFabGroup() {
    const group = document.getElementById('fab-group');
    if (!group) return;
    let isDragging = false, hasMoved = false;
    let startX, startY, startLeft, startTop;

    // 拖动整个组
    group.addEventListener('mousedown', onDown);
    group.addEventListener('touchstart', onDown, { passive: false });

    function onDown(e) {
        e.preventDefault();
        isDragging = true; hasMoved = false;
        const pt = e.touches ? e.touches[0] : e;
        startX = pt.clientX; startY = pt.clientY;
        const rect = group.getBoundingClientRect();
        startLeft = rect.left; startTop = rect.top;
        group.classList.add('dragging');
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onUp);
    }
    function onMove(e) {
        if (!isDragging) return;
        e.preventDefault();
        const pt = e.touches ? e.touches[0] : e;
        const dx = pt.clientX - startX, dy = pt.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
        group.style.left = (startLeft + dx) + 'px';
        group.style.top = (startTop + dy) + 'px';
        group.style.right = 'auto'; group.style.bottom = 'auto';
    }
    function onUp() {
        isDragging = false;
        group.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onUp);
    }

    // 各按钮点击（仅在未拖动时触发）
    document.getElementById('fab-search').addEventListener('click', () => {
        if (!hasMoved && !document.getElementById('reader-overlay').classList.contains('open')) openSearch();
    });
    document.getElementById('fab-calc').addEventListener('click', () => { if (!hasMoved) toggleCalc(group); });
    document.getElementById('fab-empty1').addEventListener('click', () => { if (!hasMoved) {} });
    document.getElementById('fab-empty2').addEventListener('click', () => { if (!hasMoved) {} });

    // 监听阅读器状态，动态禁用搜索按钮
    const searchFab = document.getElementById('fab-search');
    const observer = new MutationObserver(() => {
        const inReader = document.getElementById('reader-overlay').classList.contains('open');
        searchFab.classList.toggle('disabled', inReader);
        searchFab.title = inReader ? '阅读中不可用' : '搜索书籍';
    });
    observer.observe(document.getElementById('reader-overlay'), { attributes: true, attributeFilter: ['class'] });

    // 图标颜色：亮黑暗白跟随主题，由 CSS 控制
}

// ============================================================
//  计算器
// ============================================================
const calc = { expr: '', display: '0', sci: false, base: false, rad: false, justEval: false };

function toggleCalc(group) {
    const panel = document.getElementById('calc-panel');
    if (panel.classList.contains('open')) { closeCalc(); return; }
    const rect = group.getBoundingClientRect();
    // 先显示以获取实际尺寸
    panel.classList.add('open');
    lucide.createIcons({ nodes: [panel] });
    // 计算位置，确保不超出视口
    const panelH = panel.offsetHeight;
    const panelW = panel.offsetWidth;
    let top = rect.top - 40;
    let left = rect.left - panelW - 8;
    // 如果上方放不下，往下移
    if (top + panelH > window.innerHeight - 8) top = window.innerHeight - panelH - 8;
    if (top < 8) top = 8;
    // 如果左侧放不下，放到右侧
    if (left < 8) left = rect.right + 8;
    if (left + panelW > window.innerWidth - 8) left = window.innerWidth - panelW - 8;
    panel.style.top = top + 'px';
    panel.style.left = left + 'px';
}

function closeCalc() { document.getElementById('calc-panel').classList.remove('open'); }

function clampCalcPosition() {
    const panel = document.getElementById('calc-panel');
    if (!panel.classList.contains('open')) return;
    const panelH = panel.offsetHeight;
    const panelW = panel.offsetWidth;
    let top = parseInt(panel.style.top) || 0;
    let left = parseInt(panel.style.left) || 0;
    // 确保不超出视口底部
    if (top + panelH > window.innerHeight - 8) top = window.innerHeight - panelH - 8;
    if (top < 8) top = 8;
    if (left < 8) left = 8;
    if (left + panelW > window.innerWidth - 8) left = window.innerWidth - panelW - 8;
    panel.style.top = top + 'px';
    panel.style.left = left + 'px';
}

function renderCalc() {
    const exprEl = document.querySelector('.calc-expr');
    const resEl = document.querySelector('.calc-result');
    if (exprEl) exprEl.textContent = calc.expr;
    if (resEl) resEl.textContent = calc.display;
}

function fmtNum(r) { return r === 'Error' ? 'Error' : parseFloat(r.toPrecision(12)).toString(); }

function calcInput(val) {
    if (val === 'C') {
        calc.expr = ''; calc.display = '0'; calc.justEval = false;
    } else if (val === 'back') {
        if (!calc.expr) return;
        calc.expr = calc.expr.slice(0, -1);
        try { calc.display = fmtNum(evalCalcExpr(calc.expr || '0')); } catch(e) { calc.display = '...'; }
    } else if (val === '=') {
        try {
            const r = evalCalcExpr(calc.expr);
            calc.display = fmtNum(r);
            calc.expr = calc.display;
            calc.justEval = true;
        } catch(e) { calc.display = 'Error'; calc.justEval = true; }
    } else if ('+-*/'.includes(val)) {
        calc.justEval = false;
        calc.expr += val;
    } else if (val === '.') {
        if (calc.justEval) { calc.expr = '0'; calc.justEval = false; }
        calc.expr += '.';
    } else if (val === '(' || val === ')') {
        if (calc.justEval && val === '(') { calc.expr = ''; calc.justEval = false; }
        calc.expr += val;
    } else {
        // 数字
        if (calc.justEval) { calc.expr = ''; calc.justEval = false; }
        calc.expr += val;
        // 实时预览结果
        try { calc.display = fmtNum(evalCalcExpr(calc.expr)); } catch(e) { /* 表达式不完整，忽略 */ }
    }
    renderCalc();
}

function calcSciFn(fn) {
    const v = parseFloat(calc.display);
    let r;
    switch (fn) {
        case 'sin':   r = Math.sin(calc.rad ? v : v * Math.PI / 180); break;
        case 'cos':   r = Math.cos(calc.rad ? v : v * Math.PI / 180); break;
        case 'tan':   r = Math.tan(calc.rad ? v : v * Math.PI / 180); break;
        case 'asin':  r = v < -1 || v > 1 ? 'Error' : Math.asin(v) * (calc.rad ? 1 : 180 / Math.PI); break;
        case 'acos':  r = v < -1 || v > 1 ? 'Error' : Math.acos(v) * (calc.rad ? 1 : 180 / Math.PI); break;
        case 'atan':  r = Math.atan(v) * (calc.rad ? 1 : 180 / Math.PI); break;
        case 'sinh':  r = Math.sinh(v); break;
        case 'cosh':  r = Math.cosh(v); break;
        case 'tanh':  r = Math.tanh(v); break;
        case 'asinh': r = Math.asinh(v); break;
        case 'acosh': r = v < 1 ? 'Error' : Math.acosh(v); break;
        case 'atanh': r = v <= -1 || v >= 1 ? 'Error' : Math.atanh(v); break;
        case 'log':   r = v <= 0 ? 'Error' : Math.log10(v); break;
        case 'log2':  r = v <= 0 ? 'Error' : Math.log2(v); break;
        case 'ln':    r = v <= 0 ? 'Error' : Math.log(v); break;
        case 'exp':   r = Math.exp(v); break;
        case 'sqrt':  r = v < 0 ? 'Error' : Math.sqrt(v); break;
        case 'cbrt':  r = Math.cbrt(v); break;
        case 'pow2':  r = v * v; break;
        case 'pow3':  r = v * v * v; break;
        case 'pow10': r = Math.pow(10, v); break;
        case 'pow2x': r = Math.pow(2, v); break;
        case 'fact':  r = v < 0 || v > 170 ? 'Error' : factorial(v); break;
        case '1/x':   r = v === 0 ? 'Error' : 1 / v; break;
        case 'abs':   r = Math.abs(v); break;
        case 'pi':    r = Math.PI; break;
        case 'ee':    calc.expr += 'e'; return renderCalc();
        case 'mod':   calc.expr += '%'; return renderCalc();
        case 'ran':   r = Math.random(); break;
        default: return;
    }
    const s = fmtNum(r);
    calc.display = s;
    calc.expr = s;
    calc.justEval = true;
    renderCalc();
}

function factorial(n) {
    n = Math.round(n);
    if (n < 0) return 'Error';
    if (n === 0 || n === 1) return 1;
    if (n > 170) return Infinity;
    let r = 1; for (let i = 2; i <= n; i++) r *= i; return r;
}

// ============================================================
//  科学计算器表达式解析器（支持括号和函数调用）
// ============================================================
function evalCalcExpr(expr) {
    if (!expr || !expr.trim()) return 0;
    const tokens = tokenize(expr);
    let pos = 0;

    function peek() { return pos < tokens.length ? tokens[pos] : null; }
    function consume() { return tokens[pos++]; }

    function parseExpr() {
        let left = parseTerm();
        while (peek() === '+' || peek() === '-') {
            const op = consume();
            const right = parseTerm();
            left = op === '+' ? left + right : left - right;
        }
        return left;
    }

    function parseTerm() {
        let left = parsePower();
        while (peek() === '*' || peek() === '/' || peek() === '%') {
            const op = consume();
            const right = parsePower();
            if (op === '*') left *= right;
            else if (op === '/') { if (right === 0) throw 'Error'; left /= right; }
            else { if (right === 0) throw 'Error'; left %= right; }
        }
        return left;
    }

    function parsePower() {
        let left = parseUnary();
        if (peek() === '^') { consume(); left = Math.pow(left, parseUnary()); }
        return left;
    }

    function parseUnary() {
        if (peek() === '-') { consume(); return -parseAtom(); }
        if (peek() === '+') { consume(); return parseAtom(); }
        return parseAtom();
    }

    function parseAtom() {
        const t = peek();
        if (t === '(') {
            consume(); const v = parseExpr();
            if (peek() === ')') consume();
            return v;
        }
        if (t && /^[a-z]+$/i.test(t)) {
            const fn = consume();
            if (peek() === '(') {
                consume(); const arg = parseExpr();
                if (peek() === ')') consume();
                return applyFn(fn, arg);
            }
            return applyFn(fn, parseAtom());
        }
        if (t && /^[\d.e]+$/i.test(t)) {
            consume();
            // 处理科学记数法
            if (peek() === 'e' || peek() === 'E') {
                const eChar = consume();
                let expStr = '';
                if (peek() === '-' || peek() === '+') expStr += consume();
                if (peek() && /^\d+$/.test(peek())) expStr += consume();
                return parseFloat(t + 'e' + expStr);
            }
            return parseFloat(t);
        }
        consume(); return 0;
    }

    function applyFn(fn, arg) {
        switch (fn) {
            case 'sin':   return Math.sin(calc.rad ? arg : arg * Math.PI / 180);
            case 'cos':   return Math.cos(calc.rad ? arg : arg * Math.PI / 180);
            case 'tan':   return Math.tan(calc.rad ? arg : arg * Math.PI / 180);
            case 'asin':  return Math.asin(arg) * (calc.rad ? 1 : 180 / Math.PI);
            case 'acos':  return Math.acos(arg) * (calc.rad ? 1 : 180 / Math.PI);
            case 'atan':  return Math.atan(arg) * (calc.rad ? 1 : 180 / Math.PI);
            case 'sinh':  return Math.sinh(arg);
            case 'cosh':  return Math.cosh(arg);
            case 'tanh':  return Math.tanh(arg);
            case 'asinh': return Math.asinh(arg);
            case 'acosh': return Math.acosh(arg);
            case 'atanh': return Math.atanh(arg);
            case 'log':   return Math.log10(arg);
            case 'log2':  return Math.log2(arg);
            case 'ln':    return Math.log(arg);
            case 'exp':   return Math.exp(arg);
            case 'sqrt':  return Math.sqrt(arg);
            case 'cbrt':  return Math.cbrt(arg);
            case 'abs':   return Math.abs(arg);
            case 'fact':  return factorial(arg);
            default: return arg;
        }
    }

    const result = parseExpr();
    if (typeof result === 'number' && !isFinite(result)) throw 'Error';
    return result;
}

function tokenize(expr) {
    const tokens = [];
    let i = 0;
    while (i < expr.length) {
        const c = expr[i];
        if (c === ' ') { i++; continue; }
        if ('+-*/%^()'.includes(c)) {
            // 处理负号：在运算符或开头后的负号是负号的一部分
            if (c === '-' && (tokens.length === 0 || '+-*/%^('.includes(tokens[tokens.length - 1]))) {
                let num = '-';
                i++;
                while (i < expr.length && (expr[i] >= '0' && expr[i] <= '9' || expr[i] === '.')) { num += expr[i]; i++; }
                tokens.push(num);
                continue;
            }
            tokens.push(c);
            i++;
        } else if ((c >= '0' && c <= '9') || c === '.') {
            let num = '';
            while (i < expr.length && ((expr[i] >= '0' && expr[i] <= '9') || expr[i] === '.')) { num += expr[i]; i++; }
            // 科学记数法
            if (i < expr.length && (expr[i] === 'e' || expr[i] === 'E')) {
                num += expr[i]; i++;
                if (i < expr.length && (expr[i] === '-' || expr[i] === '+')) { num += expr[i]; i++; }
                while (i < expr.length && expr[i] >= '0' && expr[i] <= '9') { num += expr[i]; i++; }
            }
            tokens.push(num);
        } else if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
            let name = '';
            while (i < expr.length && ((expr[i] >= 'a' && expr[i] <= 'z') || (expr[i] >= 'A' && expr[i] <= 'Z'))) { name += expr[i]; i++; }
            tokens.push(name);
        } else {
            i++;
        }
    }
    return tokens;
}

// ---- 进制转换 ----
function getBaseFrom() {
    const sel = document.getElementById('calc-base-from').value;
    if (sel === 'n') {
        const v = parseInt(document.getElementById('calc-base-from-n').value);
        return (v >= 2 && v <= 36) ? v : 10;
    }
    return parseInt(sel);
}
function getBaseTo() {
    const sel = document.getElementById('calc-base-to').value;
    if (sel === 'n') {
        const v = parseInt(document.getElementById('calc-base-to-n').value);
        return (v >= 2 && v <= 36) ? v : 16;
    }
    return parseInt(sel);
}

function convertBase() {
    const input = document.getElementById('calc-base-input').value.trim();
    const resultEl = document.getElementById('calc-base-result');
    if (!input) { resultEl.textContent = '0'; renderBaseAll(); return; }
    const fromBase = getBaseFrom();
    const toBase = getBaseTo();
    // 解析输入：支持负数和小数
    const negative = input.startsWith('-');
    const raw = negative ? input.slice(1) : input;
    const parts = raw.split('.');
    const intPart = parts[0];
    const fracPart = parts[1] || '';

    // 验证整数部分
    const validChars = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, fromBase);
    for (const ch of intPart.toLowerCase()) {
        if (!validChars.includes(ch)) { resultEl.textContent = '非法字符'; renderBaseAll(); return; }
    }
    for (const ch of fracPart.toLowerCase()) {
        if (!validChars.includes(ch)) { resultEl.textContent = '非法字符'; renderBaseAll(); return; }
    }

    // 整数部分转十进制
    let decInt = 0n;
    try {
        decInt = BigInt(parseInt(intPart, fromBase));
    } catch(e) { resultEl.textContent = 'Error'; renderBaseAll(); return; }

    // 小数部分转十进制
    let decFrac = 0;
    if (fracPart) {
        for (let i = 0; i < fracPart.length; i++) {
            const digit = parseInt(fracPart[i], fromBase);
            decFrac += digit / Math.pow(fromBase, i + 1);
        }
    }

    // 十进制转目标进制
    function toBaseStr(intVal, fracVal, base) {
        const intStr = intVal === 0n ? '0' : intVal.toString(base).toUpperCase();
        if (fracVal === 0) return intStr;
        // 小数部分最多转换 12 位
        let frac = fracVal;
        let fracStr = '';
        const seen = new Set();
        for (let i = 0; i < 12 && frac > 0; i++) {
            frac *= base;
            const digit = Math.floor(frac);
            fracStr += digit.toString(base).toUpperCase();
            frac -= digit;
        }
        return intStr + '.' + fracStr;
    }

    const result = toBaseStr(decInt, decFrac, toBase);
    const sign = negative && decInt !== 0n ? '-' : '';
    resultEl.textContent = sign + result;
    renderBaseAll();
}

function renderBaseAll() {
    const input = document.getElementById('calc-base-input').value.trim();
    const container = document.getElementById('calc-base-all');
    if (!input) { container.classList.add('hidden'); container.innerHTML = ''; return; }
    container.classList.remove('hidden');

    const fromBase = getBaseFrom();
    const negative = input.startsWith('-');
    const raw = negative ? input.slice(1) : input;
    const parts = raw.split('.');
    const intPart = parts[0];
    const fracPart = parts[1] || '';

    const validChars = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, fromBase);
    for (const ch of intPart.toLowerCase()) {
        if (!validChars.includes(ch)) { container.innerHTML = ''; return; }
    }
    for (const ch of fracPart.toLowerCase()) {
        if (!validChars.includes(ch)) { container.innerHTML = ''; return; }
    }

    let decInt = 0n;
    try { decInt = BigInt(parseInt(intPart, fromBase)); } catch(e) { container.innerHTML = ''; return; }
    let decFrac = 0;
    if (fracPart) {
        for (let i = 0; i < fracPart.length; i++) {
            decFrac += parseInt(fracPart[i], fromBase) / Math.pow(fromBase, i + 1);
        }
    }

    function toBaseStr(intVal, fracVal, base) {
        const intStr = intVal === 0n ? '0' : intVal.toString(base).toUpperCase();
        if (fracVal === 0) return intStr;
        let frac = fracVal, fracStr = '';
        for (let i = 0; i < 12 && frac > 0; i++) {
            frac *= base;
            const digit = Math.floor(frac);
            fracStr += digit.toString(base).toUpperCase();
            frac -= digit;
        }
        return intStr + '.' + fracStr;
    }

    const bases = [
        { label: 'BIN', base: 2 },
        { label: 'OCT', base: 8 },
        { label: 'DEC', base: 10 },
        { label: 'HEX', base: 16 },
    ];
    const sign = negative && decInt !== 0n ? '-' : '';
    container.innerHTML = bases.map(b => {
        const val = sign + toBaseStr(decInt, decFrac, b.base);
        return '<div class="calc-base-tag"><strong>' + b.label + '</strong> ' + escHtml(val) + '</div>';
    }).join('');
}

function initBaseConversion() {
    const inputEl = document.getElementById('calc-base-input');
    const fromSel = document.getElementById('calc-base-from');
    const toSel = document.getElementById('calc-base-to');
    const fromN = document.getElementById('calc-base-from-n');
    const toN = document.getElementById('calc-base-to-n');
    const swapBtn = document.getElementById('calc-base-swap');

    inputEl.addEventListener('input', convertBase);
    fromSel.addEventListener('change', () => {
        fromN.classList.toggle('hidden', fromSel.value !== 'n');
        convertBase();
    });
    toSel.addEventListener('change', () => {
        toN.classList.toggle('hidden', toSel.value !== 'n');
        convertBase();
    });
    fromN.addEventListener('input', convertBase);
    toN.addEventListener('input', convertBase);

    swapBtn.addEventListener('click', () => {
        const fv = fromSel.value, tv = toSel.value;
        fromSel.value = tv; toSel.value = fv;
        fromN.classList.toggle('hidden', fromSel.value !== 'n');
        toN.classList.toggle('hidden', toSel.value !== 'n');
        // 交换后把结果填入输入框
        const result = document.getElementById('calc-base-result').textContent;
        if (result && result !== 'Error' && result !== '非法字符') {
            inputEl.value = result;
        }
        convertBase();
    });
}

function initCalc() {
    // 数字键盘
    document.getElementById('calc-grid').addEventListener('click', (e) => {
        const btn = e.target.closest('.calc-btn');
        if (btn) calcInput(btn.dataset.val);
    });
    // 科学函数
    document.getElementById('calc-sci').addEventListener('click', (e) => {
        const btn = e.target.closest('.calc-sci-btn');
        if (btn) calcSciFn(btn.dataset.fn);
    });
    // 模式切换
    document.querySelectorAll('.calc-mode-btn').forEach(b => {
        b.addEventListener('click', () => {
            document.querySelectorAll('.calc-mode-btn').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
            const mode = b.dataset.calcMode;
            calc.sci = mode === 'scientific';
            calc.base = mode === 'base';
            document.getElementById('calc-sci').classList.toggle('hidden', !calc.sci);
            document.getElementById('calc-base').classList.toggle('hidden', !calc.base);
            document.getElementById('calc-grid').classList.toggle('hidden', calc.base);
            document.getElementById('calc-display').classList.toggle('hidden', calc.base);
            if (calc.base) renderBaseAll();
            clampCalcPosition();
        });
    });
    // Deg/Rad 切换
    document.getElementById('calc-angle-btn').addEventListener('click', function() {
        calc.rad = !calc.rad;
        this.textContent = calc.rad ? 'Rad' : 'Deg';
        this.classList.toggle('rad', calc.rad);
    });
    // 关闭按钮
    document.getElementById('btn-close-calc').addEventListener('click', closeCalc);
    // 面板外点击关闭
    document.addEventListener('mousedown', (e) => {
        const panel = document.getElementById('calc-panel');
        if (panel.classList.contains('open') && !panel.contains(e.target) && !document.getElementById('fab-calc').contains(e.target)) {
            closeCalc();
        }
    });
    // 进制转换初始化
    initBaseConversion();
}

// ============================================================
//  艺术封面生成器（蒙德里安 / 波普风格）
// ============================================================
function openCoverGen(bookId) {
    currentCoverBookId = bookId;
    document.getElementById('cover-gen-modal').classList.add('open');
    generateArtCover();
}

function closeCoverGen() {
    document.getElementById('cover-gen-modal').classList.remove('open');
}

function generateArtCover() {
    const book = library.find(b => b.id === currentCoverBookId);
    if (!book) return;

    const canvas = document.getElementById('cover-canvas');
    const ctx = canvas.getContext('2d');
    const W = 300, H = 440;

    // 以书名 + 时间为种子的确定性 PRNG（mulberry32）
    function seedHash(str) {
        let h = 0;
        for (let i = 0; i < str.length; i++) {
            h = ((h << 5) - h + str.charCodeAt(i)) | 0;
        }
        return h >>> 0;
    }
    const _seed = seedHash((book.name || 'untitled') + Date.now());
    let _s = _seed || 1;
    function srand() {
        _s |= 0; _s = _s + 0x6D2B79F5 | 0;
        let t = Math.imul(_s ^ _s >>> 15, 1 | _s);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }
    function srandRange(a, b) { return a + srand() * (b - a); }
    function srandInt(a, b) { return Math.floor(srandRange(a, b + 1)); }

    // 获取当前选择的类型
    const activeType = document.querySelector('.cover-type-btn.active');
    const coverType = activeType ? activeType.dataset.coverType : 'knot';
    const subtypeIdx = parseInt(document.getElementById('cover-subtype-select').value) || 0;

    // ---- 琼斯多项式种子生成 ----
    // 用书名种子生成伪琼斯多项式参数，决定纽结的交叉数、拧数等
    function jonesPolynomialSeed() {
        let h = _seed;
        // 琼斯多项式 V(t) = Σ a_i * t^i，生成系数
        const crossings = 3 + (h % 12); // 3~14 交叉数
        h = (h * 1103515245 + 12345) & 0x7fffffff;
        const writhe = (h % (crossings * 2 + 1)) - crossings; // 拧数
        h = (h * 1103515245 + 12345) & 0x7fffffff;
        const numComponents = 1 + (h % 3); // 1~3 分量数
        h = (h * 1103515245 + 12345) & 0x7fffffff;
        // 琼斯多项式系数（用于确定曲线参数）
        const coeffs = [];
        for (let i = 0; i < 6; i++) {
            h = (h * 1103515245 + 12345) & 0x7fffffff;
            coeffs.push((h % 200 - 100) / 100); // -1 到 1
        }
        return { crossings, writhe, numComponents, coeffs };
    }

    const jp = jonesPolynomialSeed();

    // ---- 调色板 ----
    function getPalette() {
        const p = srandInt(0, 4);
        const palettes = [
            { bg: '#f8f6f0', colors: ['#2a2a2a', '#555', '#888'] },
            { bg: '#0f0f1a', colors: ['#818cf8', '#c084fc', '#67e8f9'] },
            { bg: '#1a0f0f', colors: ['#fb7185', '#f59e0b', '#ef4444'] },
            { bg: '#0f1a0f', colors: ['#34d399', '#10b981', '#6ee7b7'] },
            { bg: '#f0f0ff', colors: ['#312e81', '#4f46e5', '#6366f1'] },
        ];
        return palettes[p];
    }
    const palette = getPalette();

    ctx.fillStyle = palette.bg;
    ctx.fillRect(0, 0, W, H);

    if (coverType === 'knot') {
        // ---- 纽结图集：复杂不对称形状 + 上下遮挡交叉关系 ----
        const knotDefs = [
            { name: 'Trefoil 3₁', fn: (t, v) => [Math.sin(t)+2*Math.sin(2*t)+v[0]*Math.cos(3*t), Math.cos(t)-2*Math.cos(2*t)+v[1]*Math.sin(2*t), -Math.sin(3*t)+v[2]*Math.cos(t)] },
            { name: 'Figure-8 4₁', fn: (t, v) => [(2+Math.cos(2*t+v[0]))*Math.cos(3*t), (2+Math.cos(2*t+v[0]))*Math.sin(3*t), Math.sin(4*t)+2*Math.sin(2*t)+v[1]*Math.cos(3*t)] },
            { name: 'Cinquefoil 5₁', fn: (t, v) => { const r=2+Math.cos(5*t+v[0]); return [r*Math.cos(2*t)+v[1]*0.3, r*Math.sin(2*t)+v[2]*0.3, Math.sin(5*t)]; } },
            { name: 'Torus(3,4)', fn: (t, v) => { const R=2.5+v[0]*0.3,r=0.8+v[1]*0.15; return [(R+r*Math.cos(4*t))*Math.cos(3*t), (R+r*Math.cos(4*t))*Math.sin(3*t), r*Math.sin(4*t)+v[2]*0.3]; } },
            { name: 'Torus(3,5)', fn: (t, v) => { const R=2.5+v[0]*0.3,r=0.7+v[1]*0.15; return [(R+r*Math.cos(5*t))*Math.cos(3*t+v[2]*0.5), (R+r*Math.cos(5*t))*Math.sin(3*t+v[2]*0.5), r*Math.sin(5*t)]; } },
            { name: 'Torus(2,7)', fn: (t, v) => { const R=2.5+v[0]*0.3,r=0.6+v[1]*0.15; return [(R+r*Math.cos(7*t))*Math.cos(2*t), (R+r*Math.cos(7*t))*Math.sin(2*t), r*Math.sin(7*t)+v[2]*0.4]; } },
            { name: 'Stevedore 6₂', fn: (t, v) => [3*Math.cos(2*t)*(1+(0.5+v[0]*0.15)*Math.cos(3*t)), 3*Math.sin(2*t)*(1+(0.5+v[0]*0.15)*Math.cos(3*t)), 2*Math.sin(3*t)+Math.sin(5*t)+v[1]*0.4] },
            { name: 'Solomon 6₁', fn: (t, v) => { const r=2+0.8*Math.sin(3*t+v[0]); return [r*Math.cos(2*t)+0.5*Math.sin(5*t)+v[1]*0.3, r*Math.sin(2*t)+0.5*Math.cos(5*t)+v[2]*0.3, Math.sin(4*t)]; } },
            { name: 'Knot 7₂', fn: (t, v) => { const r=2+0.5*Math.cos(4*t+v[0]); return [r*Math.cos(3*t)+0.3*Math.sin(6*t)+v[1]*0.3, r*Math.sin(3*t)+0.3*Math.cos(6*t)+v[2]*0.3, Math.sin(5*t)+0.4*Math.cos(3*t)]; } },
            { name: 'Knot 8₃', fn: (t, v) => { const r=2+0.4*Math.cos(5*t+v[0]); return [r*Math.cos(3*t)+0.3*Math.sin(7*t)+v[1]*0.3, r*Math.sin(3*t)+0.3*Math.cos(7*t)+v[2]*0.3, Math.sin(6*t)+0.3*Math.cos(4*t)]; } },
        ];

        const knotIdx = subtypeIdx % knotDefs.length;
        const knot = knotDefs[knotIdx];

        // 种子驱动的拓扑变化参数
        const vary = [srandRange(-0.4, 0.4), srandRange(-0.4, 0.4), srandRange(-0.4, 0.4)];

        // 种子驱动的 3D 旋转（每次生成不同视角）
        const kRotX = srandRange(0.2, 0.9);
        const kRotY = srandRange(0, Math.PI * 2);
        function kRot3D(x, y, z) {
            let x1 = x * Math.cos(kRotY) + z * Math.sin(kRotY);
            let z1 = -x * Math.sin(kRotY) + z * Math.cos(kRotY);
            let y1 = y * Math.cos(kRotX) - z1 * Math.sin(kRotX);
            let z2 = y * Math.sin(kRotX) + z1 * Math.cos(kRotX);
            return [x1, y1, z2];
        }

        const knotScale = 48;
        const cx = W / 2, cy = H / 2 - 80;
        const N = 500;
        const gapLen = 7; // 擦除圆半径

        // 采样曲线点（含 z 坐标用于判断交叉上下关系）
        const pts = [];
        for (let i = 0; i < N; i++) {
            const t = (i / N) * Math.PI * 2;
            const [x, y, z] = knot.fn(t, vary);
            const [rx, ry, rz] = kRot3D(x, y, z);
            pts.push({ x: cx + rx * knotScale, y: cy + ry * knotScale, z: rz });
        }

        // 查找自交叉点（线段-线段相交检测）
        const crossings = [];
        for (let i = 0; i < N; i++) {
            for (let j = i + 12; j < N; j++) {
                if (Math.abs(i - j) < 8 || (i === 0 && j >= N - 8)) continue;
                const a1 = pts[i], a2 = pts[(i + 1) % N];
                const b1 = pts[j], b2 = pts[(j + 1) % N];
                const dx1 = a2.x - a1.x, dy1 = a2.y - a1.y;
                const dx2 = b2.x - b1.x, dy2 = b2.y - b1.y;
                const denom = dx1 * dy2 - dy1 * dx2;
                if (Math.abs(denom) < 0.001) continue;
                const tt = ((b1.x - a1.x) * dy2 - (b1.y - a1.y) * dx2) / denom;
                const ss = ((b1.x - a1.x) * dy1 - (b1.y - a1.y) * dx1) / denom;
                if (tt > 0.05 && tt < 0.95 && ss > 0.05 && ss < 0.95) {
                    const z1 = a1.z + tt * (a2.z - a1.z);
                    const z2 = b1.z + ss * (b2.z - b1.z);
                    crossings.push({
                        seg1: i, seg2: j, t1: tt, t2: ss,
                        x: a1.x + tt * dx1, y: a1.y + tt * dy1,
                        over1: z1 > z2
                    });
                }
            }
        }

        // 第一遍：画完整曲线
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        pts.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
        ctx.closePath();
        ctx.strokeStyle = palette.colors[0];
        ctx.stroke();

        // 第二遍：在每个交叉点擦除下方线段，再沿上方方向补回
        crossings.forEach(c => {
            const underSeg = c.over1 ? c.seg2 : c.seg1;
            const underT = c.over1 ? c.t2 : c.t1;
            const overSeg = c.over1 ? c.seg1 : c.seg2;

            const u1 = pts[underSeg], u2 = pts[(underSeg + 1) % N];
            const udx = u2.x - u1.x, udy = u2.y - u1.y;
            const ulen = Math.hypot(udx, udy) || 1;
            const ux = u1.x + udx * underT, uy = u1.y + udy * underT;

            // 擦除：填充圆（背景色）
            ctx.beginPath();
            ctx.arc(ux, uy, gapLen, 0, Math.PI * 2);
            ctx.fillStyle = palette.bg;
            ctx.fill();

            // 补回：沿上方方向画线段
            const o1 = pts[overSeg], o2 = pts[(overSeg + 1) % N];
            const odx = o2.x - o1.x, ody = o2.y - o1.y;
            const olen = Math.hypot(odx, ody) || 1;
            ctx.beginPath();
            ctx.moveTo(ux - (odx / olen) * gapLen, uy - (ody / olen) * gapLen);
            ctx.lineTo(ux + (odx / olen) * gapLen, uy + (ody / olen) * gapLen);
            ctx.strokeStyle = palette.colors[0];
            ctx.lineWidth = 4;
            ctx.lineCap = 'round';
            ctx.stroke();
        });

        // 纽结名称标注
        ctx.fillStyle = palette.colors[0];
        ctx.globalAlpha = 0.3;
        ctx.font = '10px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(knot.name, 16, H - 108);
        ctx.globalAlpha = 1;

    } else if (coverType === 'topology') {
        // ---- 拓扑类型：3D 透视旋转 + 表面彩色曲线 ----
        const topoType = subtypeIdx % 5;
        const rotY = srandRange(0.3, 0.9);
        const rotX = 0.55;

        function rot3D(x, y, z) {
            let x1 = x * Math.cos(rotY) + z * Math.sin(rotY);
            let z1 = -x * Math.sin(rotY) + z * Math.cos(rotY);
            let y1 = y * Math.cos(rotX) - z1 * Math.sin(rotX);
            let z2 = y * Math.sin(rotX) + z1 * Math.cos(rotX);
            return [x1, y1, z2];
        }
        function proj(x, y, z) {
            const fov = 6, s = fov / (fov + z);
            return [W / 2 + x * s * 55, H / 2 - 60 + y * s * 55];
        }

        function topoPoint(u, v) {
            let x, y, z;
            if (topoType === 0) {
                const R = 2, r = 0.8;
                x = (R + r * Math.cos(v)) * Math.cos(u);
                y = (R + r * Math.cos(v)) * Math.sin(u);
                z = r * Math.sin(v);
            } else if (topoType === 1) {
                const a = 3;
                const cu = Math.cos(u), su = Math.sin(u);
                const cv = Math.cos(v), sv = Math.sin(v);
                if (u < Math.PI) {
                    x = (a + cv * Math.sin(u / 2) - sv * Math.sin(u)) * cu;
                    y = (a + cv * Math.sin(u / 2) - sv * Math.sin(u)) * su;
                    z = cv * Math.cos(u / 2);
                } else {
                    x = (a + cv * Math.sin(u / 2) + sv * Math.sin(u)) * cu;
                    y = (a + cv * Math.sin(u / 2) + sv * Math.sin(u)) * su;
                    z = cv * Math.cos(u / 2);
                }
            } else if (topoType === 2) {
                const a = 2, half = v / 2;
                x = (a + u * Math.cos(half)) * Math.cos(v);
                y = (a + u * Math.cos(half)) * Math.sin(v);
                z = u * Math.sin(half);
            } else if (topoType === 3) {
                // 卡拉比-丘流形（五次超曲面投影近似）
                const cu = Math.cos(u), su = Math.sin(u);
                const cv = Math.cos(v), sv = Math.sin(v);
                const r = 1.8 + 0.6 * Math.cos(3 * u) * Math.cos(2 * v);
                x = r * cu * (1 + 0.3 * Math.cos(5 * v));
                y = r * su * (1 + 0.3 * Math.sin(5 * u));
                z = r * 0.8 * sv * Math.cos(3 * u + 2 * v);
            } else {
                // Boy 曲面
                const a = 0.5;
                x = Math.cos(u) * (a + Math.cos(v / 2) * Math.sin(u) - Math.sin(v / 2) * Math.sin(2 * u) / 2);
                y = Math.sin(u) * (a + Math.cos(v / 2) * Math.sin(u) - Math.sin(v / 2) * Math.sin(2 * u) / 2);
                z = Math.sin(v / 2) * Math.sin(u) + Math.cos(v / 2) * Math.sin(2 * u) / 2;
            }
            return [x, y, z];
        }

        const uSteps = 50, vSteps = 30;

        // 绘制 3D 网格线（带透视）
        ctx.lineWidth = 1.2;
        ctx.lineJoin = 'round';
        for (let i = 0; i <= uSteps; i += 2) {
            const u = (i / uSteps) * Math.PI * 2;
            ctx.beginPath();
            ctx.strokeStyle = palette.colors[i % palette.colors.length];
            ctx.globalAlpha = 0.5;
            for (let j = 0; j <= vSteps; j++) {
                const v = (j / vSteps) * Math.PI * 2;
                const [x, y, z] = topoPoint(u, v);
                const [rx, ry, rz] = rot3D(x, y, z);
                const [px, py] = proj(rx, ry, rz);
                if (j === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
            ctx.stroke();
        }
        for (let j = 0; j <= vSteps; j += 2) {
            const v = (j / vSteps) * Math.PI * 2;
            ctx.beginPath();
            ctx.strokeStyle = palette.colors[(j + 1) % palette.colors.length];
            ctx.globalAlpha = 0.5;
            for (let i = 0; i <= uSteps; i++) {
                const u = (i / uSteps) * Math.PI * 2;
                const [x, y, z] = topoPoint(u, v);
                const [rx, ry, rz] = rot3D(x, y, z);
                const [px, py] = proj(rx, ry, rz);
                if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
            ctx.stroke();
        }
        ctx.globalAlpha = 1;

        // 环面上绘制经线 + 纬线彩色曲线
        if (topoType === 0) {
            const R = 2, r = 0.8;
            // 经线（固定 u）
            const mu = srandRange(0, Math.PI * 2);
            ctx.beginPath();
            ctx.strokeStyle = '#ff6b6b';
            ctx.lineWidth = 2.5;
            for (let j = 0; j <= vSteps; j++) {
                const v = (j / vSteps) * Math.PI * 2;
                const x = (R + r * Math.cos(v)) * Math.cos(mu);
                const y = (R + r * Math.cos(v)) * Math.sin(mu);
                const z = r * Math.sin(v);
                const [rx, ry, rz] = rot3D(x, y, z);
                const [px, py] = proj(rx, ry, rz);
                if (j === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
            ctx.stroke();
            // 纬线（固定 v）
            const mv = srandRange(0, Math.PI * 2);
            ctx.beginPath();
            ctx.strokeStyle = '#4ecdc4';
            ctx.lineWidth = 2.5;
            for (let i = 0; i <= uSteps; i++) {
                const u = (i / uSteps) * Math.PI * 2;
                const x = (R + r * Math.cos(mv)) * Math.cos(u);
                const y = (R + r * Math.cos(mv)) * Math.sin(u);
                const z = r * Math.sin(mv);
                const [rx, ry, rz] = rot3D(x, y, z);
                const [px, py] = proj(rx, ry, rz);
                if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
            ctx.stroke();
        }

        // 拓扑标注
        const topoNames = ['Torus T²', 'Klein Bottle', 'Möbius Strip', 'Calabi-Yau', 'Boy Surface'];
        ctx.fillStyle = palette.colors[0];
        ctx.globalAlpha = 0.3;
        ctx.font = '10px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(topoNames[topoType], 16, H - 108);
        ctx.globalAlpha = 1;

    } else {
        // ---- 几何类型：分形、螺旋、对称图案 ----
        const geoType = subtypeIdx % 5;

        if (geoType === 0) {
            // 分形树
            function drawTree(x, y, angle, depth, len) {
                if (depth <= 0 || len < 2) return;
                const x2 = x + Math.cos(angle) * len;
                const y2 = y + Math.sin(angle) * len;
                ctx.beginPath();
                ctx.moveTo(x, y);
                ctx.lineTo(x2, y2);
                ctx.strokeStyle = palette.colors[depth % palette.colors.length];
                ctx.lineWidth = depth * 0.5;
                ctx.globalAlpha = 0.3 + depth * 0.1;
                ctx.stroke();
                const branchAngle = 0.3 + jp.coeffs[0] * 0.3;
                const shrink = 0.65 + jp.coeffs[1] * 0.1;
                drawTree(x2, y2, angle - branchAngle, depth - 1, len * shrink);
                drawTree(x2, y2, angle + branchAngle, depth - 1, len * shrink);
            }
            drawTree(W / 2, H - 140, -Math.PI / 2, 10, 80);
            ctx.globalAlpha = 1;

        } else if (geoType === 1) {
            // 阿基米德螺旋
            const cx = W / 2, cy = H / 2 - 60;
            const a = 2, b = 0.5 + Math.abs(jp.coeffs[0]) * 0.5;
            ctx.beginPath();
            ctx.strokeStyle = palette.colors[0];
            ctx.lineWidth = 2;
            for (let t = 0; t < Math.PI * 12; t += 0.02) {
                const r = a + b * t;
                const x = cx + r * Math.cos(t);
                const y = cy + r * Math.sin(t);
                if (t === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
            // 对数螺旋叠加
            ctx.beginPath();
            ctx.strokeStyle = palette.colors[1];
            ctx.lineWidth = 1.5;
            ctx.globalAlpha = 0.6;
            const k = 0.1 + Math.abs(jp.coeffs[2]) * 0.1;
            for (let t = 0; t < Math.PI * 8; t += 0.02) {
                const r = 5 * Math.exp(k * t);
                const x = cx + r * Math.cos(t);
                const y = cy + r * Math.sin(t);
                if (t === 0) ctx.moveTo(x, y);
                else if (r < 200) ctx.lineTo(x, y);
            }
            ctx.stroke();
            ctx.globalAlpha = 1;

        } else if (geoType === 2) {
            // 对称镶嵌（彭罗斯风格）
            const cx = W / 2, cy = H / 2 - 60;
            const n = 5 + (jp.crossings % 4); // 5~8 重对称
            const rings = 4;
            for (let ring = 1; ring <= rings; ring++) {
                const r = ring * 35;
                const count = n * ring;
                for (let i = 0; i < count; i++) {
                    const angle = (i / count) * Math.PI * 2 + ring * 0.2;
                    const x = cx + r * Math.cos(angle);
                    const y = cy + r * Math.sin(angle);
                    const size = 6 + ring * 2;
                    ctx.beginPath();
                    // 交替多边形
                    const sides = n;
                    for (let s = 0; s <= sides; s++) {
                        const a = (s / sides) * Math.PI * 2 + angle;
                        const px = x + size * Math.cos(a);
                        const py = y + size * Math.sin(a);
                        if (s === 0) ctx.moveTo(px, py);
                        else ctx.lineTo(px, py);
                    }
                    ctx.closePath();
                    ctx.strokeStyle = palette.colors[ring % palette.colors.length];
                    ctx.lineWidth = 1.2;
                    ctx.globalAlpha = 0.5 + ring * 0.1;
                    ctx.stroke();
                }
            }
            ctx.globalAlpha = 1;

        } else if (geoType === 3) {
            // 谢尔宾斯基三角
            function sierpinski(x, y, size, depth) {
                if (depth <= 0 || size < 4) {
                    ctx.beginPath();
                    ctx.moveTo(x, y - size);
                    ctx.lineTo(x - size * 0.866, y + size * 0.5);
                    ctx.lineTo(x + size * 0.866, y + size * 0.5);
                    ctx.closePath();
                    ctx.fillStyle = palette.colors[depth % palette.colors.length];
                    ctx.globalAlpha = 0.4 + depth * 0.1;
                    ctx.fill();
                    return;
                }
                const half = size / 2;
                sierpinski(x, y - half, half, depth - 1);
                sierpinski(x - half * 0.866, y + half * 0.5, half, depth - 1);
                sierpinski(x + half * 0.866, y + half * 0.5, half, depth - 1);
            }
            sierpinski(W / 2, H / 2 - 40, 160, 5);
            ctx.globalAlpha = 1;

        } else {
            // 李萨如图形
            const cx = W / 2, cy = H / 2 - 60;
            const a = 3 + Math.abs(Math.round(jp.coeffs[0] * 3));
            const b = 3 + Math.abs(Math.round(jp.coeffs[1] * 3));
            const delta = jp.coeffs[2] * Math.PI;
            ctx.beginPath();
            ctx.strokeStyle = palette.colors[0];
            ctx.lineWidth = 2;
            for (let t = 0; t < Math.PI * 2; t += 0.005) {
                const x = cx + 100 * Math.sin(a * t + delta);
                const y = cy + 100 * Math.sin(b * t);
                if (t === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.closePath();
            ctx.stroke();
            // 叠加第二条
            ctx.beginPath();
            ctx.strokeStyle = palette.colors[1];
            ctx.lineWidth = 1.5;
            ctx.globalAlpha = 0.5;
            const delta2 = delta + Math.PI / 4;
            for (let t = 0; t < Math.PI * 2; t += 0.005) {
                const x = cx + 90 * Math.sin((a + 1) * t + delta2);
                const y = cy + 90 * Math.sin((b + 1) * t);
                if (t === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.closePath();
            ctx.stroke();
            ctx.globalAlpha = 1;
        }
    }

    // 书名标签
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(20, H - 100, W - 40, 60);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 18px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const nameLines = wrapText(ctx, book.name, W - 60);
    nameLines.slice(0, 2).forEach((line, i) => {
        ctx.fillText(line, W / 2, H - 70 + (i - (Math.min(nameLines.length, 2) - 1) / 2) * 22);
    });
}

async function applyArtCover() {
    const book = library.find(b => b.id === currentCoverBookId);
    if (!book) return;
    const canvas = document.getElementById('cover-canvas');
    book.cover = canvas.toDataURL('image/jpeg', 0.9);
    book.coverColor = null; // 重置以便重新提取
    await saveLibrary();
    closeCoverGen();
    renderShelf();
    openDetail(book.id);
}

// ============================================================
//  统计仪表盘
// ============================================================
let booksWeeklyChart = null;
let booksTagsChart = null;
let papersWeeklyChart = null;
let papersTagsChart = null;

/** 从当前主题色生成一组调色板（10色） */
function generateAccentPalette() {
    const root = getComputedStyle(document.documentElement);
    const hex = root.getPropertyValue('--accent').trim() || '#818cf8';
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;
    if (max === min) { h = s = 0; }
    else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        else if (max === g) h = ((b - r) / d + 2) / 6;
        else h = ((r - g) / d + 4) / 6;
    }
    h *= 360;
    const colors = [];
    for (let i = 0; i < 10; i++) {
        const shift = (h + i * 36 + 180) % 360;
        const sat = Math.round(Math.min(100, Math.max(40, s * 100 + (i % 3 - 1) * 15)));
        const lit = Math.round(Math.min(70, Math.max(45, l * 100 + (i % 2) * 10)));
        colors.push(`hsl(${Math.round(shift)}, ${sat}%, ${lit}%)`);
    }
    return colors;
}

function renderDashboard() {
    const tagColors = generateAccentPalette();
    const chartOpts = {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
            x: { ticks: { color: '#a1a1aa', font: { size: 12 } }, grid: { color: 'rgba(255,255,255,0.03)' } },
            y: { ticks: { color: '#a1a1aa', font: { size: 12 } }, grid: { color: 'rgba(255,255,255,0.03)' } }
        }
    };
    const doughnutOpts = (legend) => ({
        responsive: true,
        plugins: { legend: { position: 'bottom', labels: { color: '#a1a1aa', padding: 12, usePointStyle: true, pointStyle: 'circle', font: { size: 11 } } } }
    });

    // 判断每条记录是书籍还是论文
    function isPaperStat(r) {
        if (r.isPaper !== undefined) return r.isPaper;
        return papers.some(p => p.id === r.bookId);
    }

    const bookStats = readingStats.filter(r => !isPaperStat(r));
    const paperStats = readingStats.filter(r => isPaperStat(r));

    // ---- 总览 ----
    document.getElementById('stat-total').textContent = library.length + papers.length;
    const totalMin = readingStats.reduce((s, r) => s + r.duration, 0);
    document.getElementById('stat-time').textContent = totalMin >= 60 ? (totalMin / 60).toFixed(1) + 'h' : totalMin + 'min';
    document.getElementById('stat-opened').textContent = openedCount;

    // ---- 书籍统计 ----
    document.getElementById('stat-books-count').textContent = library.length;
    const booksMin = bookStats.reduce((s, r) => s + r.duration, 0);
    document.getElementById('stat-books-time').textContent = booksMin >= 60 ? (booksMin / 60).toFixed(1) + 'h' : booksMin + 'min';
    document.getElementById('stat-books-sessions').textContent = bookStats.length;

    // 书籍按周
    const now = new Date();
    const weekKeys = [];
    for (let i = 6; i >= 0; i--) { const d = new Date(now); d.setDate(d.getDate() - i); weekKeys.push(localDateStr(d).slice(5)); }
    const booksWeek = {}; weekKeys.forEach(k => booksWeek[k] = 0);
    bookStats.forEach(r => { const k = r.date.slice(5, 10); if (booksWeek[k] !== undefined) booksWeek[k] += r.duration; });

    const accentRGB = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim() || '129,140,248';

    if (booksWeeklyChart) booksWeeklyChart.destroy();
    booksWeeklyChart = new Chart(document.getElementById('chart-books-weekly'), {
        type: 'bar', data: { labels: weekKeys, datasets: [{ label: '分钟', data: Object.values(booksWeek), backgroundColor: `rgba(${accentRGB},0.6)`, borderColor: `rgba(${accentRGB},1)`, borderWidth: 1, borderRadius: 6 }] }, options: chartOpts
    });

    // 书籍标签
    const bookTagCounts = {};
    library.forEach(b => { const t = b.tags[0] || '其他'; bookTagCounts[t] = (bookTagCounts[t] || 0) + 1; });
    if (booksTagsChart) booksTagsChart.destroy();
    booksTagsChart = new Chart(document.getElementById('chart-books-tags'), {
        type: 'doughnut', data: { labels: Object.keys(bookTagCounts), datasets: [{ data: Object.values(bookTagCounts), backgroundColor: tagColors.slice(0, Object.keys(bookTagCounts).length), borderWidth: 0 }] }, options: doughnutOpts()
    });

    // 书籍阅读时长排行
    const bookTimes = {};
    bookStats.forEach(r => { bookTimes[r.bookId] = (bookTimes[r.bookId] || 0) + r.duration; });
    const sortedBooks = Object.entries(bookTimes).map(([id, min]) => ({ id, min, item: library.find(b => b.id === id) })).filter(e => e.item).sort((a, b) => b.min - a.min);
    renderItemList('per-book-stats', sortedBooks);

    // ---- 论文统计 ----
    document.getElementById('stat-papers-count').textContent = papers.length;
    const papersMin = paperStats.reduce((s, r) => s + r.duration, 0);
    document.getElementById('stat-papers-time').textContent = papersMin >= 60 ? (papersMin / 60).toFixed(1) + 'h' : papersMin + 'min';
    document.getElementById('stat-papers-sessions').textContent = paperStats.length;
    document.getElementById('stat-papers-finished').textContent = papers.filter(p => p.status === 'finished' || p.status === 'reread').length;

    // 论文按周
    const papersWeek = {}; weekKeys.forEach(k => papersWeek[k] = 0);
    paperStats.forEach(r => { const k = r.date.slice(5, 10); if (papersWeek[k] !== undefined) papersWeek[k] += r.duration; });

    if (papersWeeklyChart) papersWeeklyChart.destroy();
    papersWeeklyChart = new Chart(document.getElementById('chart-papers-weekly'), {
        type: 'bar', data: { labels: weekKeys, datasets: [{ label: '分钟', data: Object.values(papersWeek), backgroundColor: `rgba(${accentRGB},0.6)`, borderColor: `rgba(${accentRGB},1)`, borderWidth: 1, borderRadius: 6 }] }, options: chartOpts
    });

    // 论文标签
    const paperTagCounts = {};
    papers.forEach(p => { (p.tags || []).forEach(t => { paperTagCounts[t] = (paperTagCounts[t] || 0) + 1; }); });
    if (papersTagsChart) papersTagsChart.destroy();
    papersTagsChart = new Chart(document.getElementById('chart-papers-tags'), {
        type: 'doughnut', data: { labels: Object.keys(paperTagCounts), datasets: [{ data: Object.values(paperTagCounts), backgroundColor: tagColors.slice(0, Object.keys(paperTagCounts).length), borderWidth: 0 }] }, options: doughnutOpts()
    });

    // 论文阅读时长排行
    const paperTimes = {};
    paperStats.forEach(r => { paperTimes[r.bookId] = (paperTimes[r.bookId] || 0) + r.duration; });
    const sortedPapers = Object.entries(paperTimes).map(([id, min]) => ({ id, min, item: papers.find(p => p.id === id) })).filter(e => e.item).sort((a, b) => b.min - a.min);
    renderItemList('per-paper-stats', sortedPapers);

    // ---- 热力图 ----
    initHeatmapToggle();
    renderHeatmap();
    setupHeatmapTooltip();

    // ---- 阅读时段直方图 ----
    renderTimePeriodHistogram();

    // ---- 知识图谱分析 ----
    renderGraphAnalysis();
}

function renderItemList(containerId, items) {
    const container = document.getElementById(containerId);
    if (items.length === 0) {
        container.innerHTML = '<div class="per-book-empty">暂无阅读记录</div>';
        return;
    }
    const maxMin = items[0].min;
    container.innerHTML = '<div class="per-book-list">' + items.map((e, i) => {
        const pct = maxMin > 0 ? (e.min / maxMin * 100) : 0;
        const label = e.min >= 60 ? (e.min / 60).toFixed(1) + 'h' : e.min + 'min';
        return `<div class="per-book-row">
            <span class="per-book-rank">${i + 1}</span>
            <span class="per-book-name">${escHtml(e.item.name)}</span>
            <div class="per-book-bar-wrap"><div class="per-book-bar-fill" style="width:${pct}%"></div></div>
            <span class="per-book-time">${label}</span>
        </div>`;
    }).join('') + '</div>';
}

// ---- 知识图谱分析 ----
function renderGraphAnalysis() {
    // 构建有向图：A写[[B]] → 边 B→A（B被A引用）
    const allNodes = standaloneNotes.map(n => n.id);
    const nodeTitleMap = {};
    standaloneNotes.forEach(n => { nodeTitleMap[n.id] = n.title || '未命名'; });

    // 有向边（去重）
    const directedEdges = [];
    const edgeSet = new Set();
    // 无向邻接表（用于弱连通分量检测）
    const undirAdj = {};
    allNodes.forEach(id => { undirAdj[id] = []; });

    standaloneNotes.forEach(n => {
        (n.links || []).forEach(targetId => {
            if (allNodes.includes(targetId) && targetId !== n.id) {
                const key = targetId + '->' + n.id; // B→A
                if (!edgeSet.has(key)) {
                    edgeSet.add(key);
                    directedEdges.push({ from: targetId, to: n.id });
                    // 无向邻接
                    if (!undirAdj[targetId].includes(n.id)) undirAdj[targetId].push(n.id);
                    if (!undirAdj[n.id].includes(targetId)) undirAdj[n.id].push(targetId);
                }
            }
        });
    });

    // BFS 弱连通分量
    const visited = new Set();
    const components = [];
    allNodes.forEach(id => {
        if (visited.has(id)) return;
        const comp = [];
        const queue = [id];
        visited.add(id);
        while (queue.length) {
            const cur = queue.shift();
            comp.push(cur);
            for (const nb of undirAdj[cur]) {
                if (!visited.has(nb)) {
                    visited.add(nb);
                    queue.push(nb);
                }
            }
        }
        components.push(comp);
    });

    // 去重无向连接（A→B 和 B→A 算 1 条连接），用于统计
    const undirEdges = [];
    const undirEdgeSet = new Set();
    directedEdges.forEach(e => {
        const key = e.from < e.to ? e.from + '|' + e.to : e.to + '|' + e.from;
        if (!undirEdgeSet.has(key)) {
            undirEdgeSet.add(key);
            undirEdges.push({ a: e.from, b: e.to });
        }
    });

    // 计算每个子图的特征
    function compFeatures(comp) {
        const nodeSet = new Set(comp);
        const n = comp.length;
        // 统计无向连接数和有向边数
        let connectionCount = 0;
        let directedCount = 0;
        undirEdges.forEach(e => { if (nodeSet.has(e.a) && nodeSet.has(e.b)) connectionCount++; });
        directedEdges.forEach(e => { if (nodeSet.has(e.from) && nodeSet.has(e.to)) directedCount++; });
        // 平均度 = 2 × 无向连接数 / 节点数
        const avgDegree = n > 0 ? (connectionCount * 2 / n) : 0;
        // 无向独立环（圈秩）= 无向连接数 - 节点数 + 1
        const undirCycleRank = Math.max(0, connectionCount - n + 1);
        // 有向独立环（圈秩）= 有向边数 - 节点数 + 1
        const dirCycleRank = Math.max(0, directedCount - n + 1);

        // BFS 找最短环（基于无向连接）
        let shortestCycleLen = Infinity;
        if (n > 1 && connectionCount >= n) {
            const subAdj = {};
            comp.forEach(id => { subAdj[id] = []; });
            undirEdges.forEach(e => {
                if (nodeSet.has(e.a) && nodeSet.has(e.b)) {
                    subAdj[e.a].push(e.b);
                    subAdj[e.b].push(e.a);
                }
            });
            comp.forEach(startId => {
                const dist = {};
                const parent = {};
                dist[startId] = 0;
                parent[startId] = null;
                const queue = [startId];
                while (queue.length) {
                    const cur = queue.shift();
                    for (const nb of subAdj[cur]) {
                        if (dist[nb] === undefined) {
                            dist[nb] = dist[cur] + 1;
                            parent[nb] = cur;
                            queue.push(nb);
                        } else if (parent[cur] !== nb) {
                            const cycleLen = dist[cur] + dist[nb] + 1;
                            if (cycleLen < shortestCycleLen) shortestCycleLen = cycleLen;
                        }
                    }
                }
            });
        }
        if (shortestCycleLen === Infinity) shortestCycleLen = 0;
        return { nodeCount: n, edgeCount: connectionCount, avgDegree, undirCycleRank, dirCycleRank, shortestCycleLen };
    }

    const features = components.map(comp => ({ ids: comp, ...compFeatures(comp) }));
    features.sort((a, b) => b.nodeCount - a.nodeCount);

    // 填充选择器
    const select = document.getElementById('graph-subgraph-select');
    const countSpan = document.getElementById('graph-subgraph-count');
    select.innerHTML = '<option value="all">全部子图（' + components.length + ' 个）</option>';
    features.forEach((f, i) => {
        const label = '子图 ' + (i + 1) + '（' + f.nodeCount + ' 节点，' + f.edgeCount + ' 边）';
        select.innerHTML += '<option value="' + i + '">' + label + '</option>';
    });
    countSpan.textContent = components.length + ' 个独立知识网';

    function updateMetrics(idx) {
        let f;
        if (idx === 'all') {
            const totalNodes = features.reduce((s, f) => s + f.nodeCount, 0);
            const totalEdges = features.reduce((s, f) => s + f.edgeCount, 0);
            const totalUndirCycles = features.reduce((s, f) => s + f.undirCycleRank, 0);
            const totalDirCycles = features.reduce((s, f) => s + f.dirCycleRank, 0);
            const avgDeg = totalNodes > 0 ? (totalEdges * 2 / totalNodes) : 0;
            const minCycle = features.filter(f => f.shortestCycleLen > 0).map(f => f.shortestCycleLen);
            f = {
                nodeCount: totalNodes, edgeCount: totalEdges,
                avgDegree: avgDeg, undirCycleRank: totalUndirCycles, dirCycleRank: totalDirCycles,
                shortestCycleLen: minCycle.length ? Math.min(...minCycle) : 0
            };
            countSpan.textContent = components.length + ' 个独立知识网';
        } else {
            f = features[parseInt(idx)];
            countSpan.textContent = '节点 ' + f.nodeCount + ' · 连接 ' + f.edgeCount;
        }
        document.getElementById('ga-nodes').textContent = f.nodeCount;
        document.getElementById('ga-edges').textContent = f.edgeCount;
        document.getElementById('ga-avg-degree').textContent = f.avgDegree.toFixed(1);
        document.getElementById('ga-cycles-undir').textContent = f.undirCycleRank;
        document.getElementById('ga-cycles-dir').textContent = f.dirCycleRank;
        document.getElementById('ga-shortest').textContent = f.shortestCycleLen || '-';

        const detail = document.getElementById('graph-analysis-detail');
        const parts = [];
        parts.push('平均每个节点连接 ' + f.avgDegree.toFixed(1) + ' 条边');
        if (f.undirCycleRank > 0 || f.dirCycleRank > 0) {
            parts.push('无向独立环 ' + f.undirCycleRank + ' 个，有向独立环 ' + f.dirCycleRank + ' 个');
            if (f.shortestCycleLen > 0) parts.push('最短环长度 ' + f.shortestCycleLen);
        } else {
            parts.push('无环（树结构或孤立节点）');
        }
        detail.textContent = parts.join('；');
    }

    select.onchange = () => updateMetrics(select.value);
    updateMetrics('all');
}

// ============================================================
//  阅读热力图 + 时段分布
// ============================================================
let heatmapCells = [];
let heatmapView = 'week'; // 'week' | 'month' | 'year'
let timePeriodChart = null;

function initHeatmapToggle() {
    const group = document.getElementById('heatmap-toggle');
    if (!group) return;
    const btns = group.querySelectorAll('.toggle-btn');
    const slider = group.querySelector('.toggle-slider');

    function updateSlider() {
        const active = group.querySelector('.toggle-btn.active');
        if (!active || !slider) return;
        slider.style.left = active.offsetLeft + 'px';
        slider.style.width = active.offsetWidth + 'px';
    }
    updateSlider();
    // 延迟一帧确保布局完成
    requestAnimationFrame(updateSlider);

    btns.forEach(btn => {
        btn.addEventListener('click', () => {
            btns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            heatmapView = btn.dataset.view;
            updateSlider();
            renderHeatmap();
        });
    });
}

function renderHeatmap() {
    const canvas = document.getElementById('chart-heatmap');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    heatmapCells = [];
    const accentRGB = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim() || '129,140,248';
    const isLight = document.body.classList.contains('light-theme');

    // 按日期聚合
    const dayMap = {};
    readingStats.forEach(r => {
        const key = r.date;
        if (!dayMap[key]) dayMap[key] = { duration: 0, count: 0 };
        dayMap[key].duration += r.duration;
        dayMap[key].count += 1;
    });

    const cellSize = 13, gap = 3;
    const labelW = 32, labelH = 22;

    function drawRoundedRect(x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
        ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
        ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
        ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
        ctx.closePath();
    }

    function cellColor(val, maxVal) {
        if (val === 0) return isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)';
        const t = Math.min(val / maxVal, 1);
        return `rgba(${accentRGB},${0.2 + t * 0.8})`;
    }

    const today = new Date();
    const endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    if (heatmapView === 'week') {
        // ---- 周视图：过去 53 周 GitHub 风格 ----
        const endDow = endDate.getDay();
        const gridEnd = new Date(endDate);
        gridEnd.setDate(gridEnd.getDate() + (6 - endDow));
        const gridStart = new Date(gridEnd);
        gridStart.setDate(gridStart.getDate() - 53 * 7 - 6);

        let maxVal = 0;
        Object.values(dayMap).forEach(v => { if (v.duration > maxVal) maxVal = v.duration; });
        if (maxVal === 0) maxVal = 1;

        const totalWeeks = Math.ceil((gridEnd - gridStart) / (7 * 86400000)) + 1;
        const W = labelW + totalWeeks * (cellSize + gap) + 12;
        const H = labelH + 7 * (cellSize + gap) + 28;
        canvas.width = W; canvas.height = H;
        canvas.style.width = W + 'px'; canvas.style.height = H + 'px'; canvas.style.maxWidth = 'none';
        ctx.clearRect(0, 0, W, H);

        // 星期标签
        ctx.font = '12px system-ui, sans-serif'; ctx.textAlign = 'right';
        ctx.fillStyle = isLight ? '#52525b' : '#a1a1aa';
        ['', '一', '', '三', '', '五', ''].forEach((l, d) => {
            if (l) ctx.fillText(l, labelW - 4, labelH + d * (cellSize + gap) + cellSize - 2);
        });

        let lastMonth = -1;
        ctx.textAlign = 'center';
        const cur = new Date(gridStart);
        while (cur <= gridEnd) {
            const dow = cur.getDay();
            const weekIdx = Math.floor((cur - gridStart) / (7 * 86400000));
            const x = labelW + weekIdx * (cellSize + gap);
            const y = labelH + dow * (cellSize + gap);
            const m = cur.getMonth();
            if (m !== lastMonth && dow === 0) {
                const monthNames = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
                ctx.fillStyle = isLight ? '#52525b' : '#a1a1aa';
                ctx.fillText(monthNames[m], x + cellSize / 2, labelH - 6);
                lastMonth = m;
            }
            const dateKey = localDateStr(cur);
            const val = dayMap[dateKey] || { duration: 0, count: 0 };
            drawRoundedRect(x, y, cellSize, cellSize, 2);
            if (cur > endDate) {
                ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.12)';
                ctx.lineWidth = 1; ctx.setLineDash([3, 2]); ctx.stroke(); ctx.setLineDash([]);
                ctx.fillStyle = 'transparent';
            } else {
                ctx.fillStyle = cellColor(val.duration, maxVal);
            }
            ctx.fill();
            heatmapCells.push({ x, y, w: cellSize, h: cellSize, date: dateKey, duration: val.duration, count: val.count, future: cur > endDate });
            cur.setDate(cur.getDate() + 1);
        }
        // 图例
        const legendY = labelH + 7 * (cellSize + gap) + 4;
        ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'left';
        ctx.fillStyle = isLight ? '#52525b' : '#a1a1aa';
        ctx.fillText('少', labelW, legendY + 9);
        for (let i = 0; i < 5; i++) {
            ctx.beginPath(); ctx.roundRect(labelW + 18 + i * (cellSize + gap), legendY, cellSize, cellSize, 2);
            ctx.fillStyle = i === 0 ? `rgba(${accentRGB},0.15)` : `rgba(${accentRGB},${0.2 + (i / 4) * 0.8})`;
            ctx.fill();
        }
        ctx.fillStyle = isLight ? '#71717a' : '#52525b';
        ctx.fillText('多', labelW + 18 + 5 * (cellSize + gap) + 2, legendY + 9);

    } else if (heatmapView === 'month') {
        // ---- 月视图：当年 12 个月 × 31 天 ----
        const year = today.getFullYear();
        let maxVal = 0;
        for (let m = 0; m < 12; m++) {
            const daysInMonth = new Date(year, m + 1, 0).getDate();
            for (let d = 1; d <= daysInMonth; d++) {
                const key = `${year}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                const v = dayMap[key]; if (v && v.duration > maxVal) maxVal = v.duration;
            }
        }
        if (maxVal === 0) maxVal = 1;

        const cols = 12, rows = 31;
        const mCellSize = 20, mGap = 4;
        const W = labelW + cols * (mCellSize + mGap) + 12;
        const H = labelH + rows * (mCellSize + mGap) + 28;
        canvas.width = W; canvas.height = H;
        canvas.style.width = W + 'px'; canvas.style.height = H + 'px'; canvas.style.maxWidth = 'none';
        ctx.clearRect(0, 0, W, H);

        const monthNames = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
        ctx.font = '12px system-ui, sans-serif'; ctx.textAlign = 'center';
        for (let m = 0; m < 12; m++) {
            ctx.fillStyle = isLight ? '#52525b' : '#a1a1aa';
            ctx.fillText(monthNames[m], labelW + m * (mCellSize + mGap) + mCellSize / 2, labelH - 6);
        }
        // 日期标签
        ctx.textAlign = 'right';
        for (let d = 0; d < 31; d++) {
            if ((d + 1) % 5 === 1 || d === 30) {
                ctx.fillText(String(d + 1), labelW - 4, labelH + d * (mCellSize + mGap) + mCellSize - 2);
            }
        }
        for (let m = 0; m < 12; m++) {
            const daysInMonth = new Date(year, m + 1, 0).getDate();
            for (let d = 0; d < 31; d++) {
                const x = labelW + m * (mCellSize + mGap);
                const y = labelH + d * (mCellSize + mGap);
                if (d < daysInMonth) {
                    const key = `${year}-${String(m + 1).padStart(2, '0')}-${String(d + 1).padStart(2, '0')}`;
                    const val = dayMap[key] || { duration: 0, count: 0 };
                    const isFuture = new Date(year, m, d + 1) > endDate;
                    drawRoundedRect(x, y, mCellSize, mCellSize, 2);
                    if (isFuture) {
                        ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.12)';
                        ctx.lineWidth = 1; ctx.setLineDash([3, 2]); ctx.stroke(); ctx.setLineDash([]);
                        ctx.fillStyle = 'transparent';
                    } else {
                        ctx.fillStyle = cellColor(val.duration, maxVal);
                    }
                    ctx.fill();
                    heatmapCells.push({ x, y, w: mCellSize, h: mCellSize, date: key, duration: val.duration, count: val.count, future: isFuture });
                } else {
                    drawRoundedRect(x, y, mCellSize, mCellSize, 2);
                    ctx.fillStyle = 'transparent'; ctx.fill();
                }
            }
        }

    } else {
        // ---- 年视图：过去 5 年 × 12 月，按月聚合 ----
        const year = today.getFullYear();
        let maxVal = 0;
        const monthData = {};
        for (let y = year - 4; y <= year; y++) {
            for (let m = 0; m < 12; m++) {
                const mk = `${y}-${String(m + 1).padStart(2, '0')}`;
                let total = 0;
                Object.keys(dayMap).forEach(k => { if (k.startsWith(mk)) total += dayMap[k].duration; });
                monthData[mk] = total;
                if (total > maxVal) maxVal = total;
            }
        }
        if (maxVal === 0) maxVal = 1;

        const cols = 5, rows = 12;
        const cellSz = 28, gap2 = 6;
        const W = labelW + cols * (cellSz + gap2) + 12;
        const H = labelH + rows * (cellSz + gap2) + 28;
        canvas.width = W; canvas.height = H;
        canvas.style.width = W + 'px'; canvas.style.height = H + 'px'; canvas.style.maxWidth = 'none';
        ctx.clearRect(0, 0, W, H);

        const monthNames = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
        // 年份标签
        ctx.font = '12px system-ui, sans-serif'; ctx.textAlign = 'center';
        for (let i = 0; i < 5; i++) {
            ctx.fillStyle = isLight ? '#52525b' : '#a1a1aa';
            ctx.fillText(String(year - 4 + i), labelW + i * (cellSz + gap2) + cellSz / 2, labelH - 6);
        }
        // 月份标签
        ctx.textAlign = 'right';
        for (let m = 0; m < 12; m++) {
            ctx.fillStyle = isLight ? '#52525b' : '#a1a1aa';
            ctx.fillText(monthNames[m], labelW - 4, labelH + m * (cellSz + gap2) + cellSz - 3);
        }
        for (let i = 0; i < 5; i++) {
            const y = year - 4 + i;
            for (let m = 0; m < 12; m++) {
                const x = labelW + i * (cellSz + gap2);
                const yy = labelH + m * (cellSz + gap2);
                const mk = `${y}-${String(m + 1).padStart(2, '0')}`;
                const val = monthData[mk] || 0;
                const isFuture = new Date(y, m + 1, 0) > endDate;
                drawRoundedRect(x, yy, cellSz, cellSz, 3);
                if (isFuture) {
                    ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.12)';
                    ctx.lineWidth = 1; ctx.setLineDash([3, 2]); ctx.stroke(); ctx.setLineDash([]);
                    ctx.fillStyle = 'transparent';
                } else {
                    ctx.fillStyle = cellColor(val, maxVal);
                }
                ctx.fill();
                heatmapCells.push({ x, y: yy, w: cellSz, h: cellSz, date: mk, duration: val, count: 0, future: isFuture });
            }
        }
    }
}

function setupHeatmapTooltip() {
    const canvas = document.getElementById('chart-heatmap');
    if (!canvas) return;
    const wrap = canvas.parentElement;
    let tooltip = wrap.querySelector('.heatmap-tooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.className = 'heatmap-tooltip';
        wrap.appendChild(tooltip);
    }

    canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        const wrapRect = wrap.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const cell = heatmapCells.find(c => mx >= c.x && mx <= c.x + c.w && my >= c.y && my <= c.y + c.h);
        if (cell) {
            const dateStr = cell.date;
            if (cell.future) {
                tooltip.innerHTML = `<b>${dateStr}</b><br>尚未到来`;
            } else if (cell.duration === 0) {
                tooltip.innerHTML = `<b>${dateStr}</b><br>无阅读记录`;
            } else {
                const durStr = cell.duration >= 60 ? (cell.duration / 60).toFixed(1) + ' 小时' : cell.duration + ' 分钟';
                tooltip.innerHTML = `<b>${dateStr}</b><br>${durStr}<br>${cell.count} 次阅读`;
            }
            tooltip.style.display = 'block';
            // 自动翻转：上方/右侧出界时调整位置
            const tipH = tooltip.offsetHeight || 48;
            const tipW = tooltip.offsetWidth || 120;
            let tx = cell.x + cell.w / 2;
            let ty = cell.y - 8;
            // 顶部出界 → 放到方块下方
            const flipBelow = (ty - tipH < 0);
            if (flipBelow) ty = cell.y + cell.h + 8;
            tooltip.classList.toggle('below', flipBelow);
            // 左侧出界
            if (tx - tipW / 2 < 0) tx = tipW / 2 + 4;
            // 右侧出界
            const maxRight = wrap.scrollLeft + wrap.clientWidth;
            if (tx + tipW / 2 > maxRight) tx = maxRight - tipW / 2 - 4;
            tooltip.style.left = tx + 'px';
            tooltip.style.top = ty + 'px';
        } else {
            tooltip.style.display = 'none';
        }
    });
    canvas.addEventListener('mouseleave', () => {
        tooltip.style.display = 'none';
    });
}

// ---- 阅读时段直方图 ----
function renderTimePeriodHistogram() {
    const canvas = document.getElementById('chart-time-period');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const accentRGB = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim() || '129,140,248';
    const isLight = document.body.classList.contains('light-theme');

    // 按小时聚合
    const hourMap = new Array(24).fill(0);
    readingStats.forEach(r => {
        const h = r.hour !== undefined ? r.hour : (r.timestamp ? new Date(r.timestamp).getHours() : 12);
        hourMap[h] += r.duration;
    });

    let maxVal = Math.max(...hourMap);
    if (maxVal === 0) maxVal = 1;

    const W = canvas.parentElement.clientWidth - 48;
    const H = 160;
    canvas.width = W; canvas.height = H;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.clearRect(0, 0, W, H);

    const barW = Math.max(6, (W - 60) / 24 - 2);
    const chartLeft = 40, chartTop = 10, chartH = H - 36;

    // Y 轴网格线
    ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = chartTop + (chartH / 4) * i;
        ctx.beginPath(); ctx.moveTo(chartLeft, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // Y 轴标签
    ctx.font = '12px system-ui, sans-serif'; ctx.textAlign = 'right';
    ctx.fillStyle = isLight ? '#3f3f46' : '#d4d4d8';
    for (let i = 0; i <= 4; i++) {
        const v = Math.round(maxVal * (4 - i) / 4);
        const label = v >= 60 ? (v / 60).toFixed(0) + 'h' : v + 'm';
        ctx.fillText(label, chartLeft - 4, chartTop + (chartH / 4) * i + 3);
    }

    // 柱状图
    for (let h = 0; h < 24; h++) {
        const x = chartLeft + h * ((W - chartLeft) / 24) + 1;
        const barH = (hourMap[h] / maxVal) * chartH;
        const y = chartTop + chartH - barH;

        // 渐变色柱
        const grad = ctx.createLinearGradient(x, y, x, chartTop + chartH);
        grad.addColorStop(0, `rgba(${accentRGB},0.85)`);
        grad.addColorStop(1, `rgba(${accentRGB},0.35)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.roundRect(x, y, barW, barH, [3, 3, 0, 0]);
        ctx.fill();

        // X 轴标签
        if (h % 3 === 0) {
            ctx.font = '12px system-ui, sans-serif'; ctx.textAlign = 'center';
            ctx.fillStyle = isLight ? '#3f3f46' : '#d4d4d8';
            ctx.fillText(String(h).padStart(2, '0'), x + barW / 2, H - 6);
        }
    }
}

// ============================================================
//  速览（Abstract / Figures / Conclusion）
// ============================================================
async function openQuickView() {
    if (!pdfDoc) return;
    const overlay = document.getElementById('quickview-overlay');
    document.getElementById('qv-abstract').innerHTML = '<span class="quickview-text empty">提取中...</span>';
    document.getElementById('qv-figures').innerHTML = '<span class="quickview-text empty">提取中...</span>';
    document.getElementById('qv-conclusion').innerHTML = '<span class="quickview-text empty">提取中...</span>';
    overlay.classList.add('open');
    lucide.createIcons();

    try {
        const abstractText = await extractSection(['abstract'], 1, Math.min(3, totalPages));
        const figuresText = await extractFigures(1, Math.min(10, totalPages));
        const conclusionText = await extractSection(['conclusion', 'conclusions', '总结', '结论', 'discussion'], Math.max(1, totalPages - 4), totalPages);

        document.getElementById('qv-abstract').textContent = abstractText || '未检测到 Abstract 内容';
        document.getElementById('qv-abstract').className = abstractText ? 'quickview-text' : 'quickview-text empty';
        document.getElementById('qv-figures').textContent = figuresText || '未检测到 Figure 说明';
        document.getElementById('qv-figures').className = figuresText ? 'quickview-text' : 'quickview-text empty';
        document.getElementById('qv-conclusion').textContent = conclusionText || '未检测到 Conclusion 内容';
        document.getElementById('qv-conclusion').className = conclusionText ? 'quickview-text' : 'quickview-text empty';
    } catch (e) {
        console.warn('[Lumina] 速览提取失败:', e);
    }
}

function closeQuickView() {
    document.getElementById('quickview-overlay').classList.remove('open');
}

/** 从指定页面范围提取指定章节标题后的内容 */
async function extractSection(keywords, startPage, endPage) {
    let found = false;
    let result = '';
    for (let i = startPage; i <= endPage; i++) {
        const page = await pdfDoc.getPage(i);
        const textContent = await page.getTextContent();
        const text = textContent.items.map(item => item.str).join('\n');
        if (!found) {
            const lowerText = text.toLowerCase();
            for (const kw of keywords) {
                const idx = lowerText.indexOf(kw);
                if (idx !== -1) {
                    found = true;
                    result += text.substring(idx) + ' ';
                    break;
                }
            }
        } else {
            result += text + ' ';
        }
    }
    // 截取合理长度
    if (result.length > 1500) result = result.substring(0, 1500) + '...';
    return result.trim() || null;
}

/** 提取 Figure 说明文字 */
async function extractFigures(startPage, endPage) {
    const captions = [];
    const figureRegex = /(?:Figure|Fig\.|图)\s*\d+[.:：]\s*([^\n]{10,200})/gi;
    for (let i = startPage; i <= endPage; i++) {
        const page = await pdfDoc.getPage(i);
        const textContent = await page.getTextContent();
        const text = textContent.items.map(item => item.str).join(' ');
        let match;
        while ((match = figureRegex.exec(text)) !== null) {
            captions.push(match[0].trim());
            if (captions.length >= 5) break;
        }
        if (captions.length >= 5) break;
    }
    return captions.length > 0 ? captions.join('\n\n') : null;
}

// ============================================================
//  PDF 高亮标注（荧光笔自由画线）
// ============================================================
let hlDrawing = false;
let hlPoints = [];
let hlBrushRadius = 12;
let hlCursorEl = null;
let hlFilterCounter = 0;

function toggleHighlightMode() {
    if (highlightMode) exitHighlightMode();
    else enterHighlightMode();
}

function enterHighlightMode() {
    highlightMode = true;
    selectedHighlight = null;
    hlFilterCounter = 0;
    document.getElementById('btn-highlight').classList.add('active');
    document.getElementById('highlight-hint').classList.remove('hidden');
    lucide.createIcons();

    const body = document.getElementById('reader-body');
    body.style.cursor = 'none';

    // 创建荧光笔光标
    hlCursorEl = document.createElement('div');
    hlCursorEl.className = 'highlighter-cursor';
    hlCursorEl.style.width = hlCursorEl.style.height = (hlBrushRadius * 2) + 'px';
    hlCursorEl.style.marginLeft = hlCursorEl.style.marginTop = (-hlBrushRadius) + 'px';
    document.body.appendChild(hlCursorEl);

    body.addEventListener('mousemove', hlOnMouseMove);
    body.addEventListener('mousedown', hlOnMouseDown);
    body.addEventListener('mouseup', hlOnMouseUp);
    document.addEventListener('mousemove', hlCursorGlobal);

    createHighlightOverlays();
}

function exitHighlightMode() {
    highlightMode = false;
    hlDrawing = false;
    hlPoints = [];
    document.getElementById('btn-highlight').classList.remove('active');
    document.getElementById('highlight-hint').classList.add('hidden');

    const body = document.getElementById('reader-body');
    body.style.cursor = '';
    body.removeEventListener('mousemove', hlOnMouseMove);
    body.removeEventListener('mousedown', hlOnMouseDown);
    body.removeEventListener('mouseup', hlOnMouseUp);
    document.removeEventListener('mousemove', hlCursorGlobal);

    if (hlCursorEl) { hlCursorEl.remove(); hlCursorEl = null; }
    document.querySelectorAll('.hl-svg-overlay').forEach(el => el.remove());
}

/** 荧光笔光标跟随鼠标（全局） */
function hlCursorGlobal(e) {
    if (!hlCursorEl) return;
    hlCursorEl.style.left = e.clientX + 'px';
    hlCursorEl.style.top = e.clientY + 'px';
}

/** 调整画笔大小 */
function setHighlightBrushRadius(r) {
    hlBrushRadius = Math.max(4, Math.min(30, r));
    if (hlCursorEl) {
        hlCursorEl.style.width = hlCursorEl.style.height = (hlBrushRadius * 2) + 'px';
        hlCursorEl.style.marginLeft = hlCursorEl.style.marginTop = (-hlBrushRadius) + 'px';
    }
}

// ---- 鼠标事件 ----
function hlGetTarget(e) {
    const wrap = e.target.closest('.hl-canvas-wrap');
    if (!wrap) return null;
    const svg = wrap.querySelector('.hl-svg-overlay');
    const canvas = wrap.querySelector('canvas');
    if (!svg || !canvas) return null;
    return { wrap, svg, canvas };
}

function hlOnMouseMove(e) {
    if (!hlDrawing) return;
    const t = hlGetTarget(e);
    if (!t) return;
    const rect = t.canvas.getBoundingClientRect();
    hlPoints.push({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    renderLiveStroke(t.svg);
}

function hlOnMouseDown(e) {
    if (!highlightMode || e.button !== 0) return;
    const t = hlGetTarget(e);
    if (!t) return;
    e.preventDefault();
    hlDrawing = true;
    const rect = t.canvas.getBoundingClientRect();
    hlPoints = [{ x: e.clientX - rect.left, y: e.clientY - rect.top }];
}

function hlOnMouseUp(e) {
    if (!hlDrawing) return;
    hlDrawing = false;
    if (hlPoints.length < 2) { hlPoints = []; return; }

    const t = hlGetTarget(e);
    if (!t) { hlPoints = []; return; }
    const pageNum = parseInt(t.svg.dataset.hlPage);

    const paper = papers.find(p => p.id === currentBookId);
    if (!paper) { hlPoints = []; return; }
    if (!paper.highlights) paper.highlights = [];

    paper.highlights.push({ type: 'stroke', page: pageNum, points: hlPoints.slice(), radius: hlBrushRadius });
    hlPoints = [];
    savePapers();
    renderStrokePaths(t.svg, pageNum);
}

// ---- SVG 覆盖层 ----
function createHighlightOverlays() {
    // 清除旧覆盖层并拆开包裹
    document.querySelectorAll('.hl-canvas-wrap').forEach(wrap => {
        const canvas = wrap.querySelector('canvas');
        if (canvas) wrap.parentNode.insertBefore(canvas, wrap);
        wrap.remove();
    });

    const body = document.getElementById('reader-body');
    body.querySelectorAll('canvas').forEach(canvas => {
        const pn = readMode === 'scroll' ? (parseInt(canvas.dataset.page) || currentPage) : currentPage;
        wrapCanvasWithSvg(canvas, pn);
    });
}

function wrapCanvasWithSvg(canvas, pageNum) {
    const wrap = document.createElement('div');
    wrap.className = 'hl-canvas-wrap';
    canvas.parentNode.insertBefore(wrap, canvas);
    wrap.appendChild(canvas);
    createSvgIn(wrap, canvas.width, canvas.height, pageNum);
}

function createSvgIn(parent, w, h, pageNum) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.classList.add('hl-svg-overlay');
    svg.dataset.hlPage = pageNum;
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:auto;cursor:none;z-index:10;';

    const filterId = 'glow-' + (++hlFilterCounter);
    const defs = document.createElementNS(ns, 'defs');
    const filter = document.createElementNS(ns, 'filter');
    filter.setAttribute('id', filterId);
    filter.setAttribute('x', '-30%'); filter.setAttribute('y', '-30%');
    filter.setAttribute('width', '160%'); filter.setAttribute('height', '160%');
    const gb = document.createElementNS(ns, 'feGaussianBlur');
    gb.setAttribute('stdDeviation', '0.005'); gb.setAttribute('result', 'blur');
    filter.appendChild(gb);
    const merge = document.createElementNS(ns, 'feMerge');
    ['blur', 'SourceGraphic'].forEach(inp => {
        const n = document.createElementNS(ns, 'feMergeNode');
        n.setAttribute('in', inp); merge.appendChild(n);
    });
    filter.appendChild(merge);
    defs.appendChild(filter);
    svg.appendChild(defs);
    svg.dataset.filterId = filterId;

    parent.appendChild(svg);
    renderStrokePaths(svg, pageNum);
    return svg;
}

// ---- 渲染笔画 ----
function renderLiveStroke(svg) {
    if (hlPoints.length < 2) return;
    let live = svg.querySelector('.hl-live');
    if (!live) {
        const ns = 'http://www.w3.org/2000/svg';
        live = document.createElementNS(ns, 'path');
        live.classList.add('hl-live');
        live.setAttribute('fill', 'none');
        live.setAttribute('stroke', 'rgba(255,230,0,0.5)');
        live.setAttribute('stroke-width', hlBrushRadius * 2);
        live.setAttribute('stroke-linecap', 'round');
        live.setAttribute('stroke-linejoin', 'round');
        live.setAttribute('filter', 'url(#' + svg.dataset.filterId + ')');
        live.style.pointerEvents = 'none';
        svg.appendChild(live);
    }
    live.setAttribute('stroke-width', hlBrushRadius * 2);
    live.setAttribute('d', pointsToPath(hlPoints));
}

function renderStrokePaths(svg, pageNum) {
    const paper = papers.find(p => p.id === currentBookId);
    if (!paper || !paper.highlights) return;

    // 清除旧笔画
    svg.querySelectorAll('.hl-stroke').forEach(el => el.remove());
    const live = svg.querySelector('.hl-live');
    if (live) live.remove();

    const ns = 'http://www.w3.org/2000/svg';

    paper.highlights.forEach((hl, idx) => {
        if (hl.type !== 'stroke' || hl.page !== pageNum) return;
        const path = document.createElementNS(ns, 'path');
        path.classList.add('hl-stroke');
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'rgba(255,230,0,0.4)');
        path.setAttribute('stroke-width', (hl.radius || 12) * 2);
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        path.setAttribute('filter', 'url(#' + svg.dataset.filterId + ')');
        path.setAttribute('d', pointsToPath(hl.points));
        path.dataset.hlIndex = idx;
        path.style.pointerEvents = 'auto';
        path.style.cursor = 'pointer';

        path.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            if (path.classList.contains('hl-selected')) {
                paper.highlights.splice(idx, 1);
                savePapers();
                renderStrokePaths(svg, pageNum);
            } else {
                svg.querySelectorAll('.hl-stroke').forEach(el => {
                    el.classList.remove('hl-selected');
                    el.setAttribute('stroke', 'rgba(255,230,0,0.4)');
                });
                path.classList.add('hl-selected');
                path.setAttribute('stroke', 'rgba(239,68,68,0.5)');
            }
        });

        svg.appendChild(path);
    });
}

function pointsToPath(pts) {
    if (pts.length < 2) return '';
    let d = 'M' + pts[0].x + ',' + pts[0].y;
    for (let i = 1; i < pts.length; i++) {
        const p = pts[i - 1], c = pts[i];
        d += ' Q' + p.x + ',' + p.y + ' ' + ((p.x + c.x) / 2) + ',' + ((p.y + c.y) / 2);
    }
    d += ' L' + pts[pts.length - 1].x + ',' + pts[pts.length - 1].y;
    return d;
}

function hlUndoLast() {
    const paper = papers.find(p => p.id === currentBookId);
    if (!paper || !paper.highlights || paper.highlights.length === 0) return;
    paper.highlights.pop();
    savePapers();
    createHighlightOverlays();
}

function hlClearAll() {
    const paper = papers.find(p => p.id === currentBookId);
    if (!paper || !paper.highlights) return;
    paper.highlights = [];
    savePapers();
    createHighlightOverlays();
}

// 包装 renderByMode：渲染后添加高亮覆盖层
const _origRenderByMode = renderByMode;
renderByMode = async function() {
    await _origRenderByMode();
    if (isPaperReader && highlightMode) {
        createHighlightOverlays();
    }
};

// ============================================================
//  章节目录侧边栏
// ============================================================
async function loadOutline() {
    tocOutline = null;
    if (!pdfDoc) return;
    try {
        const outline = await pdfDoc.getOutline();
        if (!outline || outline.length === 0) {
            document.getElementById('toc-body').innerHTML = '<div class="toc-empty">此PDF无章节目录</div>';
            return;
        }
        tocOutline = await parseOutlineItems(outline);
        renderToc();
    } catch (e) {
        console.warn('[Lumina] 目录提取失败:', e);
        document.getElementById('toc-body').innerHTML = '<div class="toc-empty">目录提取失败</div>';
    }
}

async function parseOutlineItems(items) {
    const result = [];
    for (const item of items) {
        let pageNum = null;
        if (item.dest) {
            pageNum = await resolveDestPage(item.dest);
        }
        const entry = { title: item.title || '未命名', pageNum: pageNum };
        if (item.items && item.items.length > 0) {
            entry.items = await parseOutlineItems(item.items);
        }
        result.push(entry);
    }
    return result;
}

async function resolveDestPage(dest) {
    try {
        let explicitDest = dest;
        if (typeof dest === 'string') {
            explicitDest = await pdfDoc.getDestination(dest);
        }
        if (explicitDest && explicitDest.length > 0) {
            const pageRef = explicitDest[0];
            const pageIndex = await pdfDoc.getPageIndex(pageRef);
            return pageIndex + 1; // 1-indexed
        }
    } catch (e) {
        console.warn('[Lumina] 解析目录目标失败:', e);
    }
    return null;
}

function renderToc() {
    const container = document.getElementById('toc-body');
    if (!tocOutline || tocOutline.length === 0) {
        container.innerHTML = '<div class="toc-empty">此PDF无章节目录</div>';
        return;
    }
    container.innerHTML = '';
    container.appendChild(buildTocDom(tocOutline, 0));
    updateTocHighlight();
}

function buildTocDom(items, depth) {
    const frag = document.createDocumentFragment();
    items.forEach((item, idx) => {
        const hasChildren = item.items && item.items.length > 0;
        const row = document.createElement('div');
        row.className = 'toc-item';
        row.dataset.page = item.pageNum || '';
        row.dataset.depth = depth;
        row.style.paddingLeft = (14 + depth * 12) + 'px';

        // 折叠箭头
        const toggle = document.createElement('span');
        toggle.className = 'toc-item-toggle' + (hasChildren ? '' : ' empty');
        toggle.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>';
        row.appendChild(toggle);

        // 标题
        const label = document.createElement('span');
        label.className = 'toc-item-label';
        label.textContent = item.title;
        row.appendChild(label);

        // 页码
        if (item.pageNum) {
            const page = document.createElement('span');
            page.className = 'toc-item-page';
            page.textContent = item.pageNum;
            row.appendChild(page);
        }

        // 点击跳转
        row.addEventListener('click', (e) => {
            if (e.target.closest('.toc-item-toggle') && hasChildren) {
                e.stopPropagation();
                toggle.classList.toggle('expanded');
                const childrenEl = row.nextElementSibling;
                if (childrenEl && childrenEl.classList.contains('toc-children')) {
                    childrenEl.classList.toggle('collapsed');
                }
                return;
            }
            if (item.pageNum) goToPage(item.pageNum);
        });

        frag.appendChild(row);

        // 子条目
        if (hasChildren) {
            const childContainer = document.createElement('div');
            childContainer.className = 'toc-children collapsed';
            childContainer.appendChild(buildTocDom(item.items, depth + 1));
            frag.appendChild(childContainer);
        }
    });
    return frag;
}

function updateTocHighlight() {
    const items = document.querySelectorAll('#toc-body .toc-item');
    items.forEach(el => {
        const p = parseInt(el.dataset.page);
        el.classList.toggle('active', p === currentPage);
    });
}

function toggleToc() {
    tocOpen = !tocOpen;
    document.getElementById('toc-sidebar').classList.toggle('collapsed', !tocOpen);
}

function goToPage(pageNum) {
    if (!pdfDoc || pageNum < 1 || pageNum > totalPages) return;
    if (readMode === 'scroll') {
        currentPage = pageNum;
        const target = document.getElementById('scroll-page-' + pageNum);
        if (target) target.scrollIntoView({ behavior: 'instant', block: 'start' });
        updatePageUI();
        updateTocHighlight();
    } else {
        currentPage = pageNum;
        if (readMode === 'double') currentPage = Math.ceil(currentPage / 2) * 2 - 1;
        renderByMode();
        updateTocHighlight();
    }
}

// ============================================================
//  PDF 全文搜索
// ============================================================
function togglePdfSearch() {
    pdfSearchOpen = !pdfSearchOpen;
    document.getElementById('pdf-search-bar').classList.toggle('collapsed', !pdfSearchOpen);
    if (pdfSearchOpen) {
        setTimeout(() => document.getElementById('pdf-search-input').focus(), 100);
    } else {
        clearSearchHighlights();
    }
}

function closePdfSearch() {
    pdfSearchOpen = false;
    document.getElementById('pdf-search-bar').classList.add('collapsed');
    clearSearchHighlights();
}

async function performPdfSearch(query) {
    searchQuery = query;
    searchMatches = [];
    searchCurrentIdx = -1;
    if (!query || !pdfDoc) {
        updateSearchUI();
        clearSearchHighlights();
        return;
    }

    const statusEl = document.getElementById('pdf-search-status');
    statusEl.textContent = '搜索中...';

    const lowerQuery = query.toLowerCase();

    for (let p = 1; p <= totalPages; p++) {
        const textItems = await getPageTextItems(p);
        if (!textItems || textItems.length === 0) continue;
        for (let i = 0; i < textItems.length; i++) {
            const item = textItems[i];
            if (!item.str) continue;
            const lowerStr = item.str.toLowerCase();
            let startIdx = 0;
            while (true) {
                const found = lowerStr.indexOf(lowerQuery, startIdx);
                if (found === -1) break;
                searchMatches.push({ pageNum: p, itemIndex: i, startIdx: found, endIdx: found + query.length, item: item });
                startIdx = found + 1;
            }
        }
    }

    if (searchMatches.length > 0) {
        searchCurrentIdx = 0;
        statusEl.textContent = `找到 ${searchMatches.length} 处匹配`;
        navigateToMatch(0);
    } else {
        statusEl.textContent = '未找到匹配项';
    }
    updateSearchUI();
}

async function getPageTextItems(pageNum) {
    if (pageTextCache[pageNum]) return pageTextCache[pageNum];
    if (!pdfDoc) { console.warn('[Lumina] getPageTextItems: pdfDoc 为空'); return null; }
    try {
        const page = await pdfDoc.getPage(pageNum);
        const textContent = await page.getTextContent();
        const items = textContent.items.map(item => ({
            str: item.str,
            transform: item.transform,
            width: item.width,
            height: item.height || item.transform[0]
        }));
        pageTextCache[pageNum] = items;
        return items;
    } catch (e) {
        console.warn('[Lumina] 提取第', pageNum, '页文本失败:', e);
        return null;
    }
}

function navigateToMatch(idx) {
    if (idx < 0 || idx >= searchMatches.length) return;
    searchCurrentIdx = idx;
    const match = searchMatches[idx];
    goToPage(match.pageNum);
    updateSearchUI();
    renderSearchHighlights();
}

function searchNext() {
    if (searchMatches.length === 0) return;
    navigateToMatch((searchCurrentIdx + 1) % searchMatches.length);
}

function searchPrev() {
    if (searchMatches.length === 0) return;
    navigateToMatch((searchCurrentIdx - 1 + searchMatches.length) % searchMatches.length);
}

function updateSearchUI() {
    const countEl = document.getElementById('pdf-search-count');
    if (searchMatches.length === 0) {
        countEl.textContent = searchQuery ? '无匹配' : '';
    } else {
        countEl.textContent = `${searchCurrentIdx + 1} / ${searchMatches.length}`;
    }
}

async function renderSearchHighlights() {
    clearSearchHighlights();
    if (searchMatches.length === 0 || !pdfDoc) return;

    // 获取当前页所有匹配
    const currentMatches = searchMatches.filter(m => m.pageNum === currentPage);
    if (currentMatches.length === 0) return;

    try {
        // 找到当前页对应的canvas
        let canvas;
        if (readMode === 'scroll') {
            canvas = document.getElementById('scroll-page-' + currentPage);
        } else {
            canvas = document.getElementById('pdf-canvas');
        }
        if (!canvas || !canvas.width || !canvas.height) return;

        // 获取或创建高亮覆盖层canvas
        const hlCanvas = getOrCreateSearchHlCanvas(canvas);
        const ctx = hlCanvas.getContext('2d');
        ctx.clearRect(0, 0, hlCanvas.width, hlCanvas.height);

        for (const match of currentMatches) {
            const item = match.item;
            const t = item.transform;

            const scaledX = t[4] * currentZoom;
            const scaledY = t[5] * currentZoom;

            const charW = (item.width / Math.max(item.str.length, 1)) * currentZoom;
            const hlX = scaledX + match.startIdx * charW;
            const hlW = Math.max((match.endIdx - match.startIdx) * charW, 4);
            const fontSize = Math.abs(t[3]) * currentZoom;
            const hlH = fontSize * 1.3;

            const hlY = canvas.height - scaledY - hlH * 0.85;

            const isCurrent = match === searchMatches[searchCurrentIdx];
            ctx.fillStyle = isCurrent
                ? 'rgba(250, 204, 21, 0.55)'
                : 'rgba(250, 204, 21, 0.3)';
            ctx.fillRect(hlX, hlY, hlW, hlH);

            if (isCurrent) {
                ctx.strokeStyle = 'rgba(250, 204, 21, 0.8)';
                ctx.lineWidth = 1.5;
                ctx.strokeRect(hlX, hlY, hlW, hlH);
            }
        }
    } catch (e) {
        console.warn('[Lumina] 渲染搜索高亮失败:', e);
    }
}

/** 获取或创建搜索高亮覆盖层canvas（嵌入在 canvas 的 wrap 容器内） */
function getOrCreateSearchHlCanvas(canvas) {
    let wrap = canvas.parentElement;
    // 如果canvas没有被wrap，创建一个
    if (!wrap.classList.contains('hl-canvas-wrap')) {
        wrap = document.createElement('div');
        wrap.className = 'hl-canvas-wrap';
        canvas.parentNode.insertBefore(wrap, canvas);
        wrap.appendChild(canvas);
    }
    // 查找已有的搜索高亮canvas
    let hl = wrap.querySelector('.search-hl-overlay');
    if (!hl) {
        hl = document.createElement('canvas');
        hl.className = 'search-hl-overlay';
        hl.width = canvas.width;
        hl.height = canvas.height;
        hl.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:5;';
        wrap.appendChild(hl);
    }
    // 同步尺寸
    if (hl.width !== canvas.width || hl.height !== canvas.height) {
        hl.width = canvas.width;
        hl.height = canvas.height;
    }
    return hl;
}

/** 清除所有搜索高亮覆盖层 */
function clearSearchHighlights() {
    document.querySelectorAll('.search-hl-overlay').forEach(c => {
        const ctx = c.getContext('2d');
        ctx.clearRect(0, 0, c.width, c.height);
    });
}

function handlePdfSearchInput(e) {
    clearTimeout(searchDebounceTimer);
    const query = e.target.value;
    searchDebounceTimer = setTimeout(() => performPdfSearch(query), 300);
}

function bindEvents() {
    // 主题切换
    document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

    // 导航标签切换
    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // 导入按钮
    document.querySelector('#import-btn input').addEventListener('change', handleImport);

    // 一键去重
    document.getElementById('btn-dedup').addEventListener('click', dedupLibrary);

    // 详情背景点击关闭
    document.getElementById('detail-bg').addEventListener('click', closeDetail);
    document.getElementById('paper-detail-bg').addEventListener('click', closePaperDetail);

    // 论文去重
    document.getElementById('btn-paper-dedup').addEventListener('click', dedupPapers);

    // 搜索弹窗
    document.getElementById('search-backdrop').addEventListener('click', closeSearch);
    document.getElementById('btn-close-search').addEventListener('click', closeSearch);
    document.getElementById('search-input').addEventListener('input', (e) => {
        renderSearchResults(e.target.value);
    });

    // 悬浮按钮组拖动 + 计算器
    initFabGroup();
    initCalc();

    // 封面生成器
    document.getElementById('btn-close-cover-gen').addEventListener('click', closeCoverGen);
    document.getElementById('btn-regen-cover').addEventListener('click', generateArtCover);
    document.getElementById('btn-apply-cover').addEventListener('click', applyArtCover);
    document.querySelectorAll('.cover-type-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.cover-type-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            populateCoverSubtypes(btn.dataset.coverType);
            generateArtCover();
        });
    });

    // 封面子类型图集
    const coverSubtypes = {
        knot: ['Trefoil 3₁', 'Figure-8 4₁', 'Cinquefoil 5₁', 'Torus(3,4)', 'Torus(3,5)', 'Torus(2,7)', 'Stevedore 6₂', 'Solomon 6₁', 'Knot 7₂', 'Knot 8₃'],
        topology: ['Torus T²', 'Klein Bottle', 'Möbius Strip', 'Calabi-Yau', 'Boy Surface'],
        geometry: ['分形树', '阿基米德螺旋', '彭罗斯镶嵌', '谢尔宾斯基', '李萨如图形'],
    };
    function populateCoverSubtypes(type) {
        const sel = document.getElementById('cover-subtype-select');
        const list = coverSubtypes[type] || [];
        sel.innerHTML = list.map((name, i) => `<option value="${i}">${name}</option>`).join('');
    }
    populateCoverSubtypes('knot');

    // 阅读器
    document.getElementById('btn-close-reader').addEventListener('click', closeReader);
    document.getElementById('btn-prev-page').addEventListener('click', prevPage);
    document.getElementById('btn-next-page').addEventListener('click', nextPage);
    document.getElementById('btn-zoom-in').addEventListener('click', zoomIn);
    document.getElementById('btn-zoom-out').addEventListener('click', zoomOut);
    document.getElementById('btn-diff-read').addEventListener('click', openDiffFromReader);

    // 目录侧边栏
    document.getElementById('btn-toggle-toc').addEventListener('click', toggleToc);
    document.getElementById('btn-close-toc').addEventListener('click', toggleToc);

    // PDF全文搜索
    document.getElementById('btn-toggle-search-bar').addEventListener('click', togglePdfSearch);
    document.getElementById('btn-close-pdf-search').addEventListener('click', closePdfSearch);
    document.getElementById('btn-search-prev').addEventListener('click', searchPrev);
    document.getElementById('btn-search-next').addEventListener('click', searchNext);
    document.getElementById('pdf-search-input').addEventListener('input', handlePdfSearchInput);
    document.getElementById('pdf-search-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.shiftKey ? searchPrev() : searchNext(); }
        if (e.key === 'Escape') closePdfSearch();
    });

    // 论文专用按钮
    document.getElementById('btn-quick-view').addEventListener('click', openQuickView);
    document.getElementById('btn-highlight').addEventListener('click', toggleHighlightMode);
    document.getElementById('btn-exit-highlight').addEventListener('click', exitHighlightMode);
    document.getElementById('hl-brush-size').addEventListener('input', e => setHighlightBrushRadius(+e.target.value));
    document.getElementById('btn-undo-hl').addEventListener('click', hlUndoLast);
    document.getElementById('btn-clear-hl').addEventListener('click', hlClearAll);
    document.getElementById('quickview-backdrop').addEventListener('click', closeQuickView);
    document.getElementById('btn-close-quickview').addEventListener('click', closeQuickView);

    // 阅读模式选择
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.addEventListener('click', () => setReadMode(btn.dataset.mode));
    });

    // 笔记面板
    document.getElementById('btn-toggle-notes-panel').addEventListener('click', toggleNotesPanel);
    document.getElementById('btn-close-notes-panel').addEventListener('click', toggleNotesPanel);
    document.querySelectorAll('.notes-tab').forEach(btn => {
        btn.addEventListener('click', () => switchNotesTab(btn.dataset.notesTab));
    });
    document.getElementById('btn-clear-draw').addEventListener('click', () => {
        if (signaturePad) { signaturePad.clear(); saveCurrentNotes(); }
    });
    document.getElementById('btn-undo-draw').addEventListener('click', () => {
        if (!signaturePad) return;
        const data = signaturePad.toData();
        if (data.length > 0) { data.pop(); signaturePad.fromData(data); saveCurrentNotes(); }
    });

    // 笔记导出
    document.getElementById('btn-export-notes-md').addEventListener('click', exportNotesAsMd);
    document.getElementById('btn-export-notes-pdf').addEventListener('click', exportNotesDrawing);

    // 笔记面板拖拽调整宽度
    initNotesPanelResize();
    initNotesPanelDrag();

    // 键盘快捷键
    document.addEventListener('keydown', e => {
        // 速览弹层 Escape
        if (document.getElementById('quickview-overlay').classList.contains('open')) {
            if (e.key === 'Escape') closeQuickView();
            return;
        }
        // 关系图 Escape
        if (document.getElementById('graph-overlay').classList.contains('open')) {
            if (e.key === 'Escape') closeGraph();
            return;
        }
        // 笔记编辑器 Escape
        if (document.getElementById('note-editor-overlay').classList.contains('open')) {
            if (e.key === 'Escape') closeNoteEditor();
            return;
        }
        // 差分阅读器 Escape
        if (document.getElementById('diff-reader-overlay').classList.contains('open')) {
            if (e.key === 'Escape') closeDiffReader();
            return;
        }
        if (!document.getElementById('reader-overlay').classList.contains('open')) return;
        // Ctrl+F 打开PDF搜索
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
            e.preventDefault();
            if (!pdfSearchOpen) togglePdfSearch();
            else document.getElementById('pdf-search-input').focus();
            return;
        }
        switch (e.key) {
            case 'PageUp': prevPage(); break;
            case 'PageDown': nextPage(); break;
            case 'Escape':
                if (pdfSearchOpen) { closePdfSearch(); break; }
                if (highlightMode) exitHighlightMode();
                else closeReader();
                break;
            case '+': case '=': zoomIn(); break;
            case '-': zoomOut(); break;
        }
    });

    // 关闭浏览器/标签页时保存阅读进度
    window.addEventListener('beforeunload', () => {
        recordReadingStat();
    });

    // ---- 独立笔记页 ----
    document.getElementById('btn-new-note').addEventListener('click', createNewNote);
    document.getElementById('btn-import-notes').addEventListener('click', () => {
        document.getElementById('note-file-input').click();
    });
    document.getElementById('note-file-input').addEventListener('change', (e) => {
        if (e.target.files.length > 0) importObsidianNotes(e.target.files);
        e.target.value = '';
    });
    document.getElementById('btn-open-graph').addEventListener('click', openGraph);
    document.getElementById('btn-close-note-editor').addEventListener('click', closeNoteEditor);
    document.getElementById('note-editor-overlay').addEventListener('click', (e) => {
        if (e.target === document.getElementById('note-editor-overlay')) closeNoteEditor();
    });
    document.getElementById('btn-delete-note').addEventListener('click', deleteCurrentNote);
    document.getElementById('btn-export-note-md').addEventListener('click', exportCurrentNoteMd);
    document.getElementById('btn-note-diff-read').addEventListener('click', openDiffFromNote);
    document.querySelectorAll('[data-note-editor-tab]').forEach(btn => {
        btn.addEventListener('click', () => switchNoteEditorTab(btn.dataset.noteEditorTab));
    });
    document.getElementById('btn-note-undo-draw').addEventListener('click', () => {
        if (!noteEditorSignaturePad) return;
        const data = noteEditorSignaturePad.toData();
        if (data.length > 0) { data.pop(); noteEditorSignaturePad.fromData(data); saveCurrentNoteEditor(); }
    });
    document.getElementById('btn-note-clear-draw').addEventListener('click', () => {
        if (noteEditorSignaturePad) { noteEditorSignaturePad.clear(); saveCurrentNoteEditor(); }
    });
    // 笔记颜色选择器
    const NOTE_COLORS = ['', '#818cf8', '#c084fc', '#22d3ee', '#34d399', '#fb7185', '#f59e0b', '#3b82f6'];
    const colorPalette = document.getElementById('note-color-palette');
    colorPalette.innerHTML = NOTE_COLORS.map((c, i) =>
        c ? `<div class="note-color-swatch${i === 0 ? ' none' : ''}" data-color="${c}" style="background:${c}"></div>`
          : `<div class="note-color-swatch none active" data-color="" title="无颜色"></div>`
    ).join('');
    document.getElementById('btn-note-color').addEventListener('click', (e) => {
        e.stopPropagation();
        colorPalette.classList.toggle('hidden');
    });
    colorPalette.addEventListener('click', (e) => {
        const swatch = e.target.closest('.note-color-swatch');
        if (!swatch) return;
        const note = getCurrentEditNote();
        if (!note) return;
        note.color = swatch.dataset.color;
        note.updatedAt = Date.now();
        saveStandaloneNotes();
        colorPalette.querySelectorAll('.note-color-swatch').forEach(s => s.classList.remove('active'));
        swatch.classList.add('active');
    });
    document.addEventListener('click', (e) => {
        if (!document.getElementById('note-color-wrap').contains(e.target)) {
            colorPalette.classList.add('hidden');
        }
    });

    // ---- 笔记关系图 ----
    document.getElementById('btn-close-graph').addEventListener('click', closeGraph);
    document.getElementById('graph-overlay').addEventListener('click', (e) => {
        if (e.target === document.getElementById('graph-overlay')) closeGraph();
    });

    // ---- 差分阅读器 ----
    document.getElementById('btn-close-diff-reader').addEventListener('click', closeDiffReader);
    document.getElementById('diff-left-prev').addEventListener('click', () => diffNav('left', -1));
    document.getElementById('diff-left-next').addEventListener('click', () => diffNav('left', 1));
    document.getElementById('diff-left-zoom-in').addEventListener('click', () => diffZoom('left', 0.25));
    document.getElementById('diff-left-zoom-out').addEventListener('click', () => diffZoom('left', -0.25));
    document.getElementById('diff-right-prev').addEventListener('click', () => diffNav('right', -1));
    document.getElementById('diff-right-next').addEventListener('click', () => diffNav('right', 1));
    document.getElementById('diff-right-zoom-in').addEventListener('click', () => diffZoom('right', 0.25));
    document.getElementById('diff-right-zoom-out').addEventListener('click', () => diffZoom('right', -0.25));

    // ---- 图设置 ----
    const gns = document.getElementById('graph-node-size-slider');
    if (gns) {
        localforage.getItem('graphNodeSize').then(v => { if (v != null) { gns.value = v; document.getElementById('graph-node-size-value').textContent = v; } });
        gns.oninput = () => { document.getElementById('graph-node-size-value').textContent = gns.value; localforage.setItem('graphNodeSize', +gns.value); };
    }
    const grs = document.getElementById('graph-repulsion-slider');
    if (grs) {
        localforage.getItem('graphRepulsion').then(v => { if (v != null) { grs.value = v; document.getElementById('graph-repulsion-value').textContent = v; } });
        grs.oninput = () => { document.getElementById('graph-repulsion-value').textContent = grs.value; localforage.setItem('graphRepulsion', +grs.value); };
    }
    const gew = document.getElementById('graph-edge-width-slider');
    if (gew) {
        localforage.getItem('graphEdgeWidth').then(v => { if (v != null) { gew.value = v; document.getElementById('graph-edge-width-value').textContent = v; } });
        gew.oninput = () => { document.getElementById('graph-edge-width-value').textContent = gew.value; localforage.setItem('graphEdgeWidth', +gew.value); };
    }
}

// ============================================================
//  独立笔记 — 页面渲染
// ============================================================
function renderNotesPage() {
    const container = document.getElementById('notes-container');
    if (!standaloneNotes.length) {
        container.innerHTML = `
            <div class="empty-notes">
                <i data-lucide="sticky-note"></i>
                <p>还没有笔记，点击「新建笔记」开始</p>
            </div>`;
        lucide.createIcons();
        return;
    }

    // 按更新时间倒序
    const sorted = [...standaloneNotes].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    let html = '<div class="notes-grid">';
    for (const note of sorted) {
        const preview = (note.content || '').replace(/[#*\[\]`>_~-]/g, '').substring(0, 120);
        const linkCount = (note.links || []).length;
        const dateStr = new Date(note.updatedAt || note.createdAt).toLocaleDateString('zh-CN');
        const colorBar = note.color ? `<div class="note-card-color-bar" style="background:${escHtml(note.color)}"></div>` : '';
        html += `
            <div class="note-card" data-id="${note.id}">
                ${colorBar}
                <div class="note-card-title">${escHtml(note.title || '未命名笔记')}</div>
                <div class="note-card-preview">${escHtml(preview) || '暂无内容'}</div>
                <div class="note-card-meta">
                    <span>${dateStr}</span>
                    ${linkCount > 0 ? `<span class="note-card-links"><i data-lucide="link"></i><span>${linkCount}</span></span>` : ''}
                </div>
            </div>`;
    }
    html += '</div>';
    container.innerHTML = html;

    container.querySelectorAll('.note-card').forEach(card => {
        card.addEventListener('click', () => openNoteEditor(card.dataset.id));
    });
    lucide.createIcons();
}

// ============================================================
//  Obsidian Markdown 解析器
// ============================================================
function parseObsidianMarkdown(md) {
    let content = md;

    // 1. 去除 YAML frontmatter
    content = content.replace(/^---\n[\s\S]*?\n---\n/, '');

    // 2. 转换 admonition 块 (```ad-type ... ```)
    const adTypes = { 'ad-note': 'note', 'ad-tip': 'tip', 'ad-important': 'important', 'ad-example': 'example', 'ad-info': 'info' };
    const adColors = { note: '#448aff', tip: '#00bfa5', important: '#ff6d00', example: '#aa00ff', info: '#2979ff' };
    content = content.replace(/```ad-(\w+)\ntitle:\s*(.*?)\n([\s\S]*?)```/g, (_, type, title, body) => {
        const cls = adTypes['ad-' + type] || 'note';
        const color = adColors[cls] || '#448aff';
        return `<div class="admonition admonition-${cls}" style="border-left:4px solid ${color};background:${color}11;padding:12px 16px;margin:12px 0;border-radius:0 8px 8px 0;"><div style="font-weight:700;margin-bottom:6px;color:${color};">${escHtml(title)}</div><div>${body.trim()}</div></div>`;
    });

    // 3. Wikilinks [[note]] → <a class="wikilink" data-link="note">note</a>
    content = content.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '<a class="wikilink" data-link="$1">$2</a>');
    content = content.replace(/\[\[([^\]]+)\]\]/g, '<a class="wikilink" data-link="$1">$1</a>');

    // 4. 嵌入图片 ![[file.png|width]] → <img>
    content = content.replace(/!\[\[([^\]|]+\.(png|jpg|jpeg|gif|svg|webp))\|?(\d*)\]\]/gi, (_, file, ext, w) => {
        const size = w ? ` style="width:${w}px"` : '';
        return `<img src="${file}" alt="${file}"${size} class="note-embedded-img">`;
    });

    // 5. 其他嵌入 ![[file.pdf]] → 占位
    content = content.replace(/!\[\[([^\]]+\.(pdf))\]\]/gi, (_, file) => {
        return `<div class="note-embedded-file">📎 ${escHtml(file)}</div>`;
    });

    // 6. 去除 inline metadata (key:: value)
    content = content.replace(/\s*\(\w+::\s*[^)]*\)/g, '');

    // 7. Templater 代码块 → 普通代码块
    content = content.replace(/```js\s+\/\/templater/g, '```javascript');

    // 8. TikZ 块 → 标记为代码
    content = content.replace(/```tikz/g, '```latex');

    // 9. 提取 [[links]] 用于笔记双链
    const links = [];
    const linkRe = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    let m;
    while ((m = linkRe.exec(md)) !== null) {
        if (!links.includes(m[1])) links.push(m[1]);
    }

    return { content, links };
}

function importObsidianNotes(files) {
    const readers = [];
    for (const file of files) {
        readers.push(new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve({ name: file.name.replace(/\.md$/i, ''), text: reader.result });
            reader.onerror = () => resolve(null);
            reader.readAsText(file);
        }));
    }
    Promise.all(readers).then(results => {
        let count = 0;
        results.filter(Boolean).forEach(({ name, text }) => {
            const { content, links } = parseObsidianMarkdown(text);
            // 去重：同名笔记跳过
            if (standaloneNotes.some(n => n.title === name)) return;
            const note = {
                id: 'note_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                title: name,
                content,
                drawing: null,
                links,
                color: '',
                createdAt: Date.now(),
                updatedAt: Date.now()
            };
            standaloneNotes.push(note);
            count++;
        });
        if (count > 0) {
            saveStandaloneNotes();
            renderNotesPage();
            alert(`成功导入 ${count} 篇笔记`);
        } else {
            alert('没有可导入的笔记（可能已存在同名笔记）');
        }
    });
}

// ============================================================
//  独立笔记 — CRUD
// ============================================================
function createNewNote() {
    const note = {
        id: 'note_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        title: '',
        content: '',
        drawing: null,
        links: [],
        color: '',
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
    standaloneNotes.push(note);
    saveStandaloneNotes();
    openNoteEditor(note.id);
}

function deleteCurrentNote() {
    if (!currentEditNoteId) return;
    if (!confirm('确定删除此笔记？')) return;
    standaloneNotes = standaloneNotes.filter(n => n.id !== currentEditNoteId);
    // 清理其他笔记中指向此笔记的链接
    const deletedTitle = currentEditNoteId;
    standaloneNotes.forEach(n => {
        if (n.links) n.links = n.links.filter(id => id !== currentEditNoteId);
    });
    saveStandaloneNotes();
    currentEditNoteId = null;
    closeNoteEditor();
    renderNotesPage();
}

function getCurrentEditNote() {
    return standaloneNotes.find(n => n.id === currentEditNoteId);
}

// ============================================================
//  独立笔记 — 编辑器
// ============================================================
function openNoteEditor(noteId) {
    const note = standaloneNotes.find(n => n.id === noteId);
    if (!note) return;
    currentEditNoteId = noteId;

    document.getElementById('note-editor-title').value = note.title || '';
    document.getElementById('note-editor-textarea').value = note.content || '';

    const meta = `创建于 ${new Date(note.createdAt).toLocaleString('zh-CN')} · 更新于 ${new Date(note.updatedAt).toLocaleString('zh-CN')}`;
    document.getElementById('note-editor-meta').textContent = meta;

    // 设置颜色选择器状态
    document.querySelectorAll('#note-color-palette .note-color-swatch').forEach(s => {
        s.classList.toggle('active', s.dataset.color === (note.color || ''));
    });

    // 重置tab
    currentNoteEditorTab = 'edit';
    updateNoteEditorTabUI();
    document.getElementById('note-edit-wrap').classList.remove('hidden');
    document.getElementById('note-preview-full').classList.add('hidden');
    document.getElementById('note-draw-wrap').classList.add('hidden');

    // 渲染预览
    renderNoteEditorPreview();

    // 绑定输入事件
    const textarea = document.getElementById('note-editor-textarea');
    textarea.oninput = () => {
        renderNoteEditorPreview();
        saveCurrentNoteEditor();
    };
    document.getElementById('note-editor-title').oninput = () => {
        saveCurrentNoteEditor();
    };

    // 初始化 Markdown 自动补全
    initMdAutocomplete(textarea);

    // 销毁旧的 signaturePad
    if (noteEditorSignaturePad) { noteEditorSignaturePad.off(); noteEditorSignaturePad = null; }

    document.getElementById('note-editor-overlay').classList.add('open');
    lucide.createIcons();
}

function closeNoteEditor() {
    saveCurrentNoteEditor();
    document.getElementById('note-editor-overlay').classList.remove('open');
    currentEditNoteId = null;
    if (noteEditorSignaturePad) { noteEditorSignaturePad.off(); noteEditorSignaturePad = null; }
    renderNotesPage();
}

function switchNoteEditorTab(tab) {
    currentNoteEditorTab = tab;
    updateNoteEditorTabUI();
    document.getElementById('note-edit-wrap').classList.toggle('hidden', tab !== 'edit');
    document.getElementById('note-preview-full').classList.toggle('hidden', tab !== 'preview');
    document.getElementById('note-draw-wrap').classList.toggle('hidden', tab !== 'draw');
    if (tab === 'edit' || tab === 'preview') {
        renderNoteEditorPreview();
    }
    if (tab === 'draw') {
        initNoteEditorSignaturePad();
    }
}

function updateNoteEditorTabUI() {
    document.querySelectorAll('[data-note-editor-tab]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.noteEditorTab === currentNoteEditorTab);
    });
}

function parseWikiLinks(html) {
    return html.replace(/\[\[([^\]]+)\]\]/g, (_, title) => {
        const targetNote = standaloneNotes.find(n => n.title === title.trim());
        if (targetNote) {
            return `<a class="wiki-link" data-note-id="${targetNote.id}" onclick="openNoteEditor('${targetNote.id}')">${escHtml(title.trim())}</a>`;
        }
        return `<span class="wiki-link" style="opacity:0.6;">${escHtml(title.trim())}</span>`;
    });
}

function renderNoteEditorPreview() {
    const textarea = document.getElementById('note-editor-textarea');
    const previewSide = document.getElementById('note-editor-preview');
    const previewFull = document.getElementById('note-preview-full');
    const text = textarea.value;

    const renderTarget = currentNoteEditorTab === 'preview' ? previewFull : previewSide;

    if (!text) {
        renderTarget.innerHTML = '<span style="color:var(--text-tertiary);">暂无内容</span>';
        return;
    }

    let html = (typeof marked !== 'undefined') ? marked.parse(text) : escHtml(text);

    // KaTeX 数学公式
    if (typeof katex !== 'undefined') {
        html = html.replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => {
            try { return katex.renderToString(expr.trim(), { displayMode: true, throwOnError: false }); }
            catch { return `<code>${escHtml(expr)}</code>`; }
        });
        html = html.replace(/\$([^\$\n]+?)\$/g, (_, expr) => {
            try { return katex.renderToString(expr.trim(), { displayMode: false, throwOnError: false }); }
            catch { return `<code>${escHtml(expr)}</code>`; }
        });
    }

    // 解析 [[wiki links]]
    html = parseWikiLinks(html);

    renderTarget.innerHTML = html;

    // 更新 links 数据
    extractNoteLinks();
}

function extractNoteLinks() {
    const note = getCurrentEditNote();
    if (!note) return;
    const textarea = document.getElementById('note-editor-textarea');
    const text = textarea.value;
    const linkTitles = [];
    const re = /\[\[([^\]]+)\]\]/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const linked = standaloneNotes.find(n => n.title === m[1].trim());
        if (linked && linked.id !== note.id) {
            linkTitles.push(linked.id);
        }
    }
    note.links = [...new Set(linkTitles)];
}

function saveCurrentNoteEditor() {
    const note = getCurrentEditNote();
    if (!note) return;
    note.title = document.getElementById('note-editor-title').value;
    note.content = document.getElementById('note-editor-textarea').value;
    note.updatedAt = Date.now();
    if (noteEditorSignaturePad && !noteEditorSignaturePad.isEmpty()) {
        note.drawing = noteEditorSignaturePad.toDataURL();
    }
    extractNoteLinks();
    saveStandaloneNotes();
}

function initNoteEditorSignaturePad() {
    const canvas = document.getElementById('note-draw-canvas');
    if (!canvas) return;
    if (noteEditorSignaturePad && noteEditorSignaturePad._canvas === canvas) return;

    const wrap = canvas.parentElement;
    const rect = wrap.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height - 44;

    if (noteEditorSignaturePad) noteEditorSignaturePad.off();
    noteEditorSignaturePad = new SignaturePad(canvas, {
        penColor: document.body.classList.contains('light-theme') ? '#1a1a20' : '#e0e0e6',
        backgroundColor: 'rgba(0,0,0,0)',
        minWidth: 1, maxWidth: 3
    });

    const note = getCurrentEditNote();
    if (note && note.drawing) {
        noteEditorSignaturePad.fromDataURL(note.drawing);
    }

    noteEditorSignaturePad.addEventListener('endStroke', () => {
        clearTimeout(noteEditorSaveTimer);
        noteEditorSaveTimer = setTimeout(() => saveCurrentNoteEditor(), 500);
    });
    noteEditorSignaturePad._canvas = canvas;
}

async function exportCurrentNoteMd() {
    const note = getCurrentEditNote();
    if (!note) return;
    const exeDir = await getExeDir();
    if (!exeDir) { showToast('无法获取应用目录'); return; }
    const safeName = sanitizeFilename(note.title || '未命名笔记');
    const dir = exeDir + '\\notes\\standalone\\' + safeName;
    let mdContent = `# ${note.title || '未命名笔记'}\n\n`;
    if (note.content) mdContent += note.content + '\n';
    if (note.drawing) {
        const imgBytes = await dataUrlToWhiteBgBytes(note.drawing);
        const imgPath = dir + '\\drawing.png';
        const saved = await saveFileViaTauri(imgPath, imgBytes);
        if (saved) mdContent += '\n\n## 手写笔记\n\n![手写笔记](drawing.png)\n';
    }
    const mdPath = dir + '\\' + safeName + '.md';
    const encoder = new TextEncoder();
    const ok = await saveFileViaTauri(mdPath, encoder.encode(mdContent));
    if (ok) showToast('已导出到 notes\\standalone\\' + safeName);
}

// ============================================================
//  差分阅读器
// ============================================================
async function openDiffFromNote() {
    const note = getCurrentEditNote();
    if (!note) return;
    // 让用户选择一个 PDF 来源（书架或论文）
    const pdfItems = [
        ...library.map(b => ({ id: b.id, name: b.name, type: 'book' })),
        ...papers.map(p => ({ id: p.id, name: p.name, type: 'paper' }))
    ];
    if (!pdfItems.length) { showToast('书库为空，请先导入 PDF'); return; }

    // 简单选择弹窗
    const selected = await showPdfPicker(pdfItems);
    if (!selected) return;

    let pdfData;
    if (selected.type === 'book') {
        const book = library.find(b => b.id === selected.id);
        if (!book._pdfUint8) {
            book._pdfUint8 = await loadPdfData(selected.id);
        }
        pdfData = book._pdfUint8;
    } else {
        const paper = papers.find(p => p.id === selected.id);
        if (!paper._pdfUint8) {
            paper._pdfUint8 = await loadPaperPdfData(selected.id);
        }
        pdfData = paper._pdfUint8;
    }
    if (!pdfData) { showToast('PDF 数据丢失'); return; }

    closeNoteEditor();
    await openDiffReader({
        left: { type: 'pdf', pdfData, name: selected.name, currentPage: 1, zoom: 1.5 },
        right: { type: 'note', noteId: note.id, noteTitle: note.title }
    });
}

async function openDiffFromReader() {
    if (!pdfDoc || !currentBookId) return;
    const currentPdfData = isPaperReader
        ? papers.find(p => p.id === currentBookId)?._pdfUint8
        : library.find(b => b.id === currentBookId)?._pdfUint8;
    if (!currentPdfData) { showToast('当前 PDF 数据不可用'); return; }

    const currentName = document.getElementById('reader-title').textContent;
    // 让用户选择另一个 PDF
    const otherItems = [
        ...library.filter(b => b.id !== currentBookId || isPaperReader).map(b => ({ id: b.id, name: b.name, type: 'book' })),
        ...papers.filter(p => p.id !== currentBookId || !isPaperReader).map(p => ({ id: p.id, name: p.name, type: 'paper' }))
    ];
    if (!otherItems.length) { showToast('没有其他 PDF 可用于对比'); return; }

    const selected = await showPdfPicker(otherItems);
    if (!selected) return;

    let otherPdfData;
    if (selected.type === 'book') {
        const book = library.find(b => b.id === selected.id);
        if (!book._pdfUint8) book._pdfUint8 = await loadPdfData(selected.id);
        otherPdfData = book._pdfUint8;
    } else {
        const paper = papers.find(p => p.id === selected.id);
        if (!paper._pdfUint8) paper._pdfUint8 = await loadPaperPdfData(selected.id);
        otherPdfData = paper._pdfUint8;
    }
    if (!otherPdfData) { showToast('PDF 数据丢失'); return; }

    closeReader();
    await openDiffReader({
        left: { type: 'pdf', pdfData: currentPdfData, name: currentName, currentPage: 1, zoom: 1.5 },
        right: { type: 'pdf', pdfData: otherPdfData, name: selected.name, currentPage: 1, zoom: 1.5 }
    });
}

function showPdfPicker(items) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'note-editor-overlay open';
        overlay.style.zIndex = '200';
        overlay.innerHTML = `
            <div style="background:var(--bg-modal);border:1px solid var(--border-strong);border-radius:16px;padding:24px;max-width:500px;width:90vw;max-height:70vh;overflow-y:auto;">
                <h3 style="margin-bottom:16px;font-size:16px;">选择 PDF 文档</h3>
                <div style="display:flex;flex-direction:column;gap:8px;" id="pdf-picker-list">
                    ${items.map(it => `
                        <button class="btn" data-id="${it.id}" data-type="${it.type}" style="justify-content:flex-start;text-align:left;">
                            <i data-lucide="${it.type === 'book' ? 'library' : 'file-text'}"></i>
                            ${escHtml(it.name)}
                        </button>
                    `).join('')}
                </div>
                <div style="margin-top:16px;text-align:right;">
                    <button class="btn" id="pdf-picker-cancel">取消</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        lucide.createIcons();

        overlay.querySelector('#pdf-picker-cancel').addEventListener('click', () => {
            overlay.remove();
            resolve(null);
        });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) { overlay.remove(); resolve(null); }
        });
        overlay.querySelectorAll('#pdf-picker-list .btn').forEach(btn => {
            btn.addEventListener('click', () => {
                overlay.remove();
                resolve({ id: btn.dataset.id, type: btn.dataset.type, name: btn.textContent.trim() });
            });
        });
    });
}

async function openDiffReader(config) {
    diffState = {
        left: { ...config.left, totalPages: 0, pdfDoc: null },
        right: { ...config.right }
    };

    document.getElementById('diff-reader-title').textContent =
        `${config.left.name || ''} ↔ ${config.right.noteTitle || config.right.name || ''}`;

    // 加载左侧 PDF
    if (config.left.type === 'pdf') {
        try {
            diffState.left.pdfDoc = await parsePdf(config.left.pdfData, 30000);
            diffState.left.totalPages = diffState.left.pdfDoc.numPages;
        } catch (e) {
            showToast('左侧 PDF 解析失败');
            return;
        }
    }

    // 加载右侧 PDF（如果有的话）
    if (config.right.type === 'pdf') {
        try {
            diffState.right.pdfDoc = await parsePdf(config.right.pdfData, 30000);
            diffState.right.totalPages = diffState.right.pdfDoc.numPages;
        } catch (e) {
            showToast('右侧 PDF 解析失败');
            return;
        }
    }

    document.getElementById('diff-reader-overlay').classList.add('open');
    lucide.createIcons();

    await renderDiffPanel('left');
    await renderDiffPanel('right');
    updateDiffUI();
    initDiffDivider();
}

function closeDiffReader() {
    document.getElementById('diff-reader-overlay').classList.remove('open');
    document.getElementById('diff-panel-left').innerHTML = '';
    document.getElementById('diff-panel-right').innerHTML = '';
    diffState = null;
}

async function renderDiffPanel(side) {
    const panel = document.getElementById('diff-panel-' + side);
    const state = diffState[side];
    panel.innerHTML = '';

    if (state.type === 'pdf' && state.pdfDoc) {
        const page = await state.pdfDoc.getPage(state.currentPage);
        const viewport = page.getViewport({ scale: state.zoom });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.maxWidth = '100%';
        canvas.style.height = 'auto';
        panel.appendChild(canvas);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    } else if (state.type === 'note') {
        const note = standaloneNotes.find(n => n.id === state.noteId);
        if (note) {
            // 可编辑的笔记面板：左侧编辑 + 右侧预览
            const wrap = document.createElement('div');
            wrap.className = 'diff-note-edit-wrap';
            wrap.style.cssText = 'display:flex;flex:1;overflow:hidden;width:100%;';

            const textarea = document.createElement('textarea');
            textarea.className = 'diff-note-textarea';
            textarea.value = note.content || '';
            textarea.placeholder = '支持 Markdown 语法...\n使用 [[笔记名]] 创建双链';
            textarea.style.cssText = 'flex:1;background:transparent;border:none;color:var(--text-primary);font-size:14px;line-height:1.7;padding:16px 20px;resize:none;outline:none;font-family:"Cascadia Code","Fira Code","Consolas",monospace;';

            const preview = document.createElement('div');
            preview.className = 'diff-note-preview';
            preview.style.cssText = 'flex:1;padding:16px 20px;overflow-y:auto;font-size:14px;line-height:1.7;border-left:1px solid var(--border);';

            // 渲染预览
            function renderDiffNotePreview() {
                const text = textarea.value;
                if (!text) { preview.innerHTML = '<span style="color:var(--text-tertiary);">暂无内容</span>'; return; }
                let html = (typeof marked !== 'undefined') ? marked.parse(text) : escHtml(text);
                if (typeof katex !== 'undefined') {
                    html = html.replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => {
                        try { return katex.renderToString(expr.trim(), { displayMode: true, throwOnError: false }); }
                        catch { return `<code>${escHtml(expr)}</code>`; }
                    });
                    html = html.replace(/\$([^\$\n]+?)\$/g, (_, expr) => {
                        try { return katex.renderToString(expr.trim(), { displayMode: false, throwOnError: false }); }
                        catch { return `<code>${escHtml(expr)}</code>`; }
                    });
                }
                html = html.replace(/\[\[([^\]]+)\]\]/g, (_, t) => `<span style="color:var(--accent);background:var(--accent-bg);padding:1px 6px;border-radius:4px;">${escHtml(t.trim())}</span>`);
                preview.innerHTML = html;
            }
            renderDiffNotePreview();

            // 自动保存
            let saveTimer = null;
            textarea.oninput = () => {
                renderDiffNotePreview();
                clearTimeout(saveTimer);
                saveTimer = setTimeout(() => {
                    note.content = textarea.value;
                    note.updatedAt = Date.now();
                    // 提取链接
                    const linkTitles = [];
                    const re = /\[\[([^\]]+)\]\]/g;
                    let m;
                    while ((m = re.exec(textarea.value)) !== null) {
                        const linked = standaloneNotes.find(n2 => n2.title === m[1].trim());
                        if (linked && linked.id !== note.id) linkTitles.push(linked.id);
                    }
                    note.links = [...new Set(linkTitles)];
                    saveStandaloneNotes();
                }, 500);
            };

            wrap.appendChild(textarea);
            wrap.appendChild(preview);
            panel.appendChild(wrap);
        }
    }
}

function updateDiffUI() {
    if (!diffState) return;
    ['left', 'right'].forEach(side => {
        const s = diffState[side];
        document.getElementById('diff-' + side + '-page').textContent =
            s.type === 'pdf' ? `${s.currentPage} / ${s.totalPages}` : '—';
        document.getElementById('diff-' + side + '-zoom').textContent =
            s.type === 'pdf' ? `${Math.round(s.zoom / 1.5 * 100)}%` : '—';
    });
}

async function diffNav(side, delta) {
    if (!diffState || !diffState[side]) return;
    const s = diffState[side];
    if (s.type !== 'pdf' || !s.pdfDoc) return;
    s.currentPage = Math.max(1, Math.min(s.totalPages, s.currentPage + delta));
    await renderDiffPanel(side);
    updateDiffUI();
}

async function diffZoom(side, delta) {
    if (!diffState || !diffState[side]) return;
    const s = diffState[side];
    if (s.type !== 'pdf') return;
    s.zoom = Math.max(0.75, Math.min(3.0, s.zoom + delta));
    await renderDiffPanel(side);
    updateDiffUI();
}

function initDiffDivider() {
    const divider = document.getElementById('diff-panel-divider');
    const leftPanel = document.getElementById('diff-panel-left');
    const rightPanel = document.getElementById('diff-panel-right');
    const body = document.querySelector('.diff-reader-body');
    if (!divider || !body) return;

    let startX, startLeftWidth;

    divider.onmousedown = (e) => {
        e.preventDefault();
        startX = e.clientX;
        startLeftWidth = leftPanel.offsetWidth;
        divider.style.background = 'var(--accent)';

        function onMove(e) {
            const dx = e.clientX - startX;
            const totalWidth = body.offsetWidth - divider.offsetWidth;
            const newLeftWidth = Math.max(200, Math.min(totalWidth - 200, startLeftWidth + dx));
            leftPanel.style.flex = 'none';
            leftPanel.style.width = newLeftWidth + 'px';
            rightPanel.style.flex = '1';
        }

        function onUp() {
            divider.style.background = '';
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    };
}

// ============================================================
//  笔记关系图 — 力导向图动画
// ============================================================
async function openGraph() {
    if (!standaloneNotes.length) { showToast('还没有笔记'); return; }
    const overlay = document.getElementById('graph-overlay');
    overlay.classList.add('open');

    const canvas = document.getElementById('graph-canvas');
    const ctx = canvas.getContext('2d');

    // 读取设置
    const nodeSize = (await localforage.getItem('graphNodeSize')) || 10;
    const repulsion = (await localforage.getItem('graphRepulsion')) || 2000;
    const graphColorIdx = (await localforage.getItem('graphColorIdx')) || 0;
    const graphColors = ['#818cf8', '#c084fc', '#22d3ee', '#34d399', '#fb7185', '#f59e0b', '#3b82f6'];
    const nodeColor = graphColors[graphColorIdx] || graphColors[0];
    const edgeWidth = (await localforage.getItem('graphEdgeWidth')) || 2.5;
    const edgeColorIdx = (await localforage.getItem('graphEdgeColorIdx')) || 0;
    const edgeColor = graphColors[edgeColorIdx] || graphColors[0];
    const isLight = document.body.classList.contains('light-theme');

    // 构建节点和边
    const nodes = standaloneNotes.map((n, i) => ({
        id: n.id,
        label: n.title || '未命名',
        x: canvas.width / 2 + (Math.random() - 0.5) * 400,
        y: canvas.height / 2 + (Math.random() - 0.5) * 400,
        vx: 0, vy: 0,
        radius: nodeSize
    }));
    const nodeMap = {};
    nodes.forEach(n => nodeMap[n.id] = n);

    // 有向边：A写[[B]] → B→A（B被A引用，箭头从B指向A）
    const edges = [];
    standaloneNotes.forEach(n => {
        (n.links || []).forEach(targetId => {
            if (nodeMap[targetId]) {
                edges.push({ source: targetId, target: n.id });
            }
        });
    });

    // 力导向图模拟
    function resize() {
        canvas.width = overlay.clientWidth;
        canvas.height = overlay.clientHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    let animating = true;
    let damping = 0.95;

    function simulate() {
        if (!animating) return;

        // 斥力（所有节点对）
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const a = nodes[i], b = nodes[j];
                let dx = b.x - a.x, dy = b.y - a.y;
                let dist = Math.sqrt(dx * dx + dy * dy) || 1;
                let force = repulsion / (dist * dist);
                let fx = (dx / dist) * force, fy = (dy / dist) * force;
                a.vx -= fx; a.vy -= fy;
                b.vx += fx; b.vy += fy;
            }
        }

        // 引力（边）
        edges.forEach(e => {
            const a = nodeMap[e.source], b = nodeMap[e.target];
            if (!a || !b) return;
            let dx = b.x - a.x, dy = b.y - a.y;
            let dist = Math.sqrt(dx * dx + dy * dy) || 1;
            let force = (dist - 150) * 0.005;
            let fx = (dx / dist) * force, fy = (dy / dist) * force;
            a.vx += fx; a.vy += fy;
            b.vx -= fx; b.vy -= fy;
        });

        // 中心引力
        const cx = canvas.width / 2, cy = canvas.height / 2;
        nodes.forEach(n => {
            n.vx += (cx - n.x) * 0.0005;
            n.vy += (cy - n.y) * 0.0005;
        });

        // 更新位置
        nodes.forEach(n => {
            n.vx *= damping;
            n.vy *= damping;
            n.x += n.vx;
            n.y += n.vy;
            // 边界约束
            n.x = Math.max(n.radius, Math.min(canvas.width - n.radius, n.x));
            n.y = Math.max(n.radius, Math.min(canvas.height - n.radius, n.y));
        });

        // 绘制
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // 有向边 — 带箭头
        const edgeAlpha = isLight ? 0.45 : 0.35;
        const edgeColorFull = edgeColor + Math.round(edgeAlpha * 255).toString(16).padStart(2, '0');
        ctx.lineWidth = edgeWidth;
        ctx.lineCap = 'round';
        const arrowLen = 10 + edgeWidth * 2;
        const arrowAngle = Math.PI / 7;
        edges.forEach(e => {
            const a = nodeMap[e.source], b = nodeMap[e.target];
            if (!a || !b) return;
            const dx = b.x - a.x, dy = b.y - a.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            // 箭头终点缩进到节点边缘
            const endX = b.x - (dx / dist) * (b.radius + 2);
            const endY = b.y - (dy / dist) * (b.radius + 2);
            const startX = a.x + (dx / dist) * (a.radius + 2);
            const startY = a.y + (dy / dist) * (a.radius + 2);
            // 线段
            ctx.strokeStyle = edgeColorFull;
            ctx.beginPath();
            ctx.moveTo(startX, startY);
            ctx.lineTo(endX, endY);
            ctx.stroke();
            // 箭头
            const angle = Math.atan2(endY - startY, endX - startX);
            ctx.fillStyle = edgeColorFull;
            ctx.beginPath();
            ctx.moveTo(endX, endY);
            ctx.lineTo(endX - arrowLen * Math.cos(angle - arrowAngle), endY - arrowLen * Math.sin(angle - arrowAngle));
            ctx.lineTo(endX - arrowLen * Math.cos(angle + arrowAngle), endY - arrowLen * Math.sin(angle + arrowAngle));
            ctx.closePath();
            ctx.fill();
        });

        // 节点
        nodes.forEach(n => {
            // 光晕
            ctx.beginPath();
            ctx.arc(n.x, n.y, n.radius + 4, 0, Math.PI * 2);
            ctx.fillStyle = nodeColor + '30';
            ctx.fill();

            // 节点
            ctx.beginPath();
            ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
            ctx.fillStyle = nodeColor;
            ctx.fill();

            // 标签
            ctx.fillStyle = document.body.classList.contains('light-theme') ? '#18181b' : '#e4e4e7';
            ctx.font = '12px "Segoe UI", system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(n.label.length > 10 ? n.label.substring(0, 10) + '…' : n.label, n.x, n.y + n.radius + 16);
        });

        graphAnimFrame = requestAnimationFrame(simulate);
    }

    simulate();

    // 双击节点打开笔记
    canvas.ondblclick = (e) => {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        for (const n of nodes) {
            const dx = mx - n.x, dy = my - n.y;
            if (dx * dx + dy * dy <= (n.radius + 4) * (n.radius + 4)) {
                closeGraph();
                openNoteEditor(n.id);
                return;
            }
        }
    };

    // 拖拽节点
    let dragNode = null;
    canvas.onmousedown = (e) => {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        for (const n of nodes) {
            const dx = mx - n.x, dy = my - n.y;
            if (dx * dx + dy * dy <= (n.radius + 4) * (n.radius + 4)) {
                dragNode = n;
                break;
            }
        }
    };
    canvas.onmousemove = (e) => {
        if (!dragNode) return;
        const rect = canvas.getBoundingClientRect();
        dragNode.x = e.clientX - rect.left;
        dragNode.y = e.clientY - rect.top;
        dragNode.vx = 0;
        dragNode.vy = 0;
    };
    canvas.onmouseup = () => { dragNode = null; };

    // 存储清理函数
    overlay._cleanup = () => {
        animating = false;
        if (graphAnimFrame) cancelAnimationFrame(graphAnimFrame);
        window.removeEventListener('resize', resize);
    };
}

function closeGraph() {
    const overlay = document.getElementById('graph-overlay');
    overlay.classList.remove('open');
    if (overlay._cleanup) { overlay._cleanup(); overlay._cleanup = null; }
}

// ============================================================
//  Markdown 自动补全
// ============================================================
const MD_COMPLETIONS = [
    { trigger: '#', items: [
        { label: '# 标题', insert: '# ', hint: '一级标题' },
        { label: '## 标题', insert: '## ', hint: '二级标题' },
        { label: '### 标题', insert: '### ', hint: '三级标题' },
    ]},
    { trigger: '*', items: [
        { label: '* 列表', insert: '* ', hint: '无序列表' },
        { label: '**粗体**', insert: '****', cursor: 2, hint: '粗体' },
        { label: '*斜体*', insert: '**', cursor: 1, hint: '斜体' },
    ]},
    { trigger: '-', items: [
        { label: '- 列表', insert: '- ', hint: '无序列表' },
    ]},
    { trigger: '`', items: [
        { label: '`代码`', insert: '``', cursor: 1, hint: '行内代码' },
        { label: '```代码块', insert: '```\n\n```', cursor: 4, hint: '代码块' },
    ]},
    { trigger: '[', items: [
        { label: '[链接](url)', insert: '[](url)', cursor: 1, hint: '超链接' },
        { label: '[[双链]]', insert: '[[]]', cursor: 2, hint: '笔记双链' },
    ]},
    { trigger: '!', items: [
        { label: '![图片](url)', insert: '![](url)', cursor: 2, hint: '图片' },
    ]},
    { trigger: '>', items: [
        { label: '> 引用', insert: '> ', hint: '引用块' },
    ]},
    { trigger: '$', items: [
        { label: '$行内公式$', insert: '$$', cursor: 1, hint: '行内数学' },
        { label: '$$公式块$$', insert: '$$\n\n$$', cursor: 4, hint: '块级数学' },
    ]},
    { trigger: '\\', items: [
        // 希腊字母小写
        { label: '\\alpha', insert: '\\alpha ', hint: 'α' },
        { label: '\\beta', insert: '\\beta ', hint: 'β' },
        { label: '\\gamma', insert: '\\gamma ', hint: 'γ' },
        { label: '\\delta', insert: '\\delta ', hint: 'δ' },
        { label: '\\epsilon', insert: '\\epsilon ', hint: 'ε' },
        { label: '\\varepsilon', insert: '\\varepsilon ', hint: 'ε（变体）' },
        { label: '\\zeta', insert: '\\zeta ', hint: 'ζ' },
        { label: '\\eta', insert: '\\eta ', hint: 'η' },
        { label: '\\theta', insert: '\\theta ', hint: 'θ' },
        { label: '\\lambda', insert: '\\lambda ', hint: 'λ' },
        { label: '\\mu', insert: '\\mu ', hint: 'μ' },
        { label: '\\nu', insert: '\\nu ', hint: 'ν' },
        { label: '\\xi', insert: '\\xi ', hint: 'ξ' },
        { label: '\\pi', insert: '\\pi ', hint: 'π' },
        { label: '\\rho', insert: '\\rho ', hint: 'ρ' },
        { label: '\\sigma', insert: '\\sigma ', hint: 'σ' },
        { label: '\\tau', insert: '\\tau ', hint: 'τ' },
        { label: '\\phi', insert: '\\phi ', hint: 'φ' },
        { label: '\\varphi', insert: '\\varphi ', hint: 'φ（变体）' },
        { label: '\\chi', insert: '\\chi ', hint: 'χ' },
        { label: '\\psi', insert: '\\psi ', hint: 'ψ' },
        { label: '\\omega', insert: '\\omega ', hint: 'ω' },
        // 希腊字母大写
        { label: '\\Gamma', insert: '\\Gamma ', hint: 'Γ' },
        { label: '\\Delta', insert: '\\Delta ', hint: 'Δ' },
        { label: '\\Theta', insert: '\\Theta ', hint: 'Θ' },
        { label: '\\Lambda', insert: '\\Lambda ', hint: 'Λ' },
        { label: '\\Xi', insert: '\\Xi ', hint: 'Ξ' },
        { label: '\\Pi', insert: '\\Pi ', hint: 'Π' },
        { label: '\\Sigma', insert: '\\Sigma ', hint: 'Σ' },
        { label: '\\Phi', insert: '\\Phi ', hint: 'Φ' },
        { label: '\\Psi', insert: '\\Psi ', hint: 'Ψ' },
        { label: '\\Omega', insert: '\\Omega ', hint: 'Ω' },
        // 运算符
        { label: '\\frac{}{}', insert: '\\frac{}{}', cursor: 6, hint: '分数' },
        { label: '\\sqrt{}', insert: '\\sqrt{}', cursor: 6, hint: '根号' },
        { label: '\\sum', insert: '\\sum ', hint: '求和 Σ' },
        { label: '\\prod', insert: '\\prod ', hint: '连乘 Π' },
        { label: '\\int', insert: '\\int ', hint: '积分 ∫' },
        { label: '\\lim', insert: '\\lim ', hint: '极限' },
        { label: '\\infty', insert: '\\infty ', hint: '无穷 ∞' },
        { label: '\\partial', insert: '\\partial ', hint: '偏导 ∂' },
        { label: '\\nabla', insert: '\\nabla ', hint: '梯度 ∇' },
        // 关系符
        { label: '\\leq', insert: '\\leq ', hint: '≤' },
        { label: '\\geq', insert: '\\geq ', hint: '≥' },
        { label: '\\neq', insert: '\\neq ', hint: '≠' },
        { label: '\\approx', insert: '\\approx ', hint: '≈' },
        { label: '\\equiv', insert: '\\equiv ', hint: '≡' },
        { label: '\\subset', insert: '\\subset ', hint: '⊂' },
        { label: '\\supset', insert: '\\supset ', hint: '⊃' },
        { label: '\\in', insert: '\\in ', hint: '∈' },
        { label: '\\notin', insert: '\\notin ', hint: '∉' },
        { label: '\\perp', insert: '\\perp ', hint: '⊥' },
        { label: '\\parallel', insert: '\\parallel ', hint: '∥' },
        // 箭头
        { label: '\\rightarrow', insert: '\\rightarrow ', hint: '→' },
        { label: '\\leftarrow', insert: '\\leftarrow ', hint: '←' },
        { label: '\\Rightarrow', insert: '\\Rightarrow ', hint: '⇒' },
        { label: '\\Leftarrow', insert: '\\Leftarrow ', hint: '⇐' },
        { label: '\\leftrightarrow', insert: '\\leftrightarrow ', hint: '↔' },
        { label: '\\uparrow', insert: '\\uparrow ', hint: '↑' },
        { label: '\\downarrow', insert: '\\downarrow ', hint: '↓' },
        // 函数
        { label: '\\sin', insert: '\\sin ', hint: '正弦' },
        { label: '\\cos', insert: '\\cos ', hint: '余弦' },
        { label: '\\tan', insert: '\\tan ', hint: '正切' },
        { label: '\\log', insert: '\\log ', hint: '对数' },
        { label: '\\ln', insert: '\\ln ', hint: '自然对数' },
        { label: '\\exp', insert: '\\exp ', hint: '指数' },
        // 符号
        { label: '\\cdot', insert: '\\cdot ', hint: '·' },
        { label: '\\times', insert: '\\times ', hint: '×' },
        { label: '\\pm', insert: '\\pm ', hint: '±' },
        { label: '\\mp', insert: '\\mp ', hint: '∓' },
        { label: '\\star', insert: '\\star ', hint: '⋆' },
        { label: '\\circ', insert: '\\circ ', hint: '∘' },
        { label: '\\bullet', insert: '\\bullet ', hint: '•' },
        { label: '\\forall', insert: '\\forall ', hint: '∀' },
        { label: '\\exists', insert: '\\exists ', hint: '∃' },
        { label: '\\neg', insert: '\\neg ', hint: '¬' },
        { label: '\\land', insert: '\\land ', hint: '∧' },
        { label: '\\lor', insert: '\\lor ', hint: '∨' },
        { label: '\\emptyset', insert: '\\emptyset ', hint: '∅' },
        // 标注
        { label: '\\hat{}', insert: '\\hat{}', cursor: 5, hint: '帽' },
        { label: '\\bar{}', insert: '\\bar{}', cursor: 5, hint: '上横线' },
        { label: '\\vec{}', insert: '\\vec{}', cursor: 5, hint: '向量' },
        { label: '\\dot{}', insert: '\\dot{}', cursor: 5, hint: '点' },
        { label: '\\ddot{}', insert: '\\ddot{}', cursor: 6, hint: '两点' },
        { label: '\\tilde{}', insert: '\\tilde{}', cursor: 6, hint: '波浪' },
        // 括号
        { label: '\\left( \\right)', insert: '\\left(  \\right)', cursor: 7, hint: '自适应括号' },
        { label: '\\langle \\rangle', insert: '\\langle  \\rangle', cursor: 9, hint: '尖括号' },
        { label: '\\lfloor \\rfloor', insert: '\\lfloor  \\rfloor', cursor: 9, hint: '下取整' },
        { label: '\\lceil \\rceil', insert: '\\lceil  \\rceil', cursor: 8, hint: '上取整' },
        // 矩阵
        { label: '\\begin{pmatrix}', insert: '\\begin{pmatrix}\n  \n\\end{pmatrix}', cursor: 16, hint: '圆括号矩阵' },
        { label: '\\begin{bmatrix}', insert: '\\begin{bmatrix}\n  \n\\end{bmatrix}', cursor: 16, hint: '方括号矩阵' },
        // 其他
        { label: '\\text{}', insert: '\\text{}', cursor: 6, hint: '文本' },
        { label: '\\mathrm{}', insert: '\\mathrm{}', cursor: 8, hint: '罗马体' },
        { label: '\\mathbf{}', insert: '\\mathbf{}', cursor: 8, hint: '粗体' },
        { label: '\\mathcal{}', insert: '\\mathcal{}', cursor: 9, hint: '花体' },
        { label: '\\boxed{}', insert: '\\boxed{}', cursor: 7, hint: '框' },
    ]},
];

function initMdAutocomplete(textarea) {
    // 创建下拉容器
    let dropdown = textarea.parentElement.querySelector('.md-autocomplete');
    if (!dropdown) {
        dropdown = document.createElement('div');
        dropdown.className = 'md-autocomplete';
        textarea.parentElement.style.position = 'relative';
        textarea.parentElement.appendChild(dropdown);
    }

    let activeIdx = 0;
    let currentItems = [];
    let triggerStart = -1;
    let visible = false;

    function getContext() {
        const pos = textarea.selectionStart;
        const text = textarea.value;
        let wordStart = pos;
        while (wordStart > 0 && text[wordStart - 1] !== ' ' && text[wordStart - 1] !== '\n') wordStart--;
        const word = text.substring(wordStart, pos);
        return { word, wordStart, pos };
    }

    function getFilteredItems() {
        const { word } = getContext();
        const backslash = MD_COMPLETIONS.find(c => c.trigger === '\\');
        if (!backslash) return [];
        if (!word.startsWith('\\') || word.length < 2) return [];
        return backslash.items.filter(it =>
            it.label.toLowerCase().startsWith(word.toLowerCase())
        );
    }

    function renderDropdown(items) {
        currentItems = items;
        activeIdx = 0;
        dropdown.innerHTML = items.map((item, i) => {
            let previewHtml = '';
            if (typeof katex !== 'undefined' && item.hint) {
                try {
                    // hint 里存的是符号（如 α、β、≤），用 KaTeX 渲染
                    previewHtml = katex.renderToString(item.hint, { throwOnError: false, displayMode: false });
                } catch { previewHtml = `<span>${escHtml(item.hint)}</span>`; }
            }
            return `<div class="md-ac-item${i === 0 ? ' active' : ''}" data-idx="${i}">
                <code>${escHtml(item.label)}</code>
                <span class="ac-preview">${previewHtml}</span>
            </div>`;
        }).join('');
    }

    function showDropdown() {
        const filtered = getFilteredItems();
        if (!filtered.length) { hideDropdown(); return; }
        renderDropdown(filtered);
        dropdown.classList.add('show');
        visible = true;

        // 定位
        const rect = textarea.getBoundingClientRect();
        const parentRect = textarea.parentElement.getBoundingClientRect();
        dropdown.style.left = '8px';
        dropdown.style.bottom = (parentRect.bottom - rect.top + 4) + 'px';
        dropdown.style.top = 'auto';

        dropdown.querySelectorAll('.md-ac-item').forEach(el => {
            el.onmousedown = (e) => { e.preventDefault(); activeIdx = +el.dataset.idx; complete(); };
        });
    }

    function hideDropdown() {
        dropdown.classList.remove('show');
        visible = false;
        currentItems = [];
        triggerStart = -1;
    }

    function complete() {
        if (!currentItems.length) return;
        const item = currentItems[activeIdx];
        const { wordStart, pos } = getContext();
        const before = textarea.value.substring(0, wordStart);
        const after = textarea.value.substring(pos);
        textarea.value = before + item.insert + after;
        const cursorPos = item.cursor != null
            ? wordStart + item.cursor
            : wordStart + item.insert.length;
        textarea.setSelectionRange(cursorPos, cursorPos);
        hideDropdown();
        textarea.focus();
        textarea.dispatchEvent(new Event('input'));
    }

    function updateActive() {
        dropdown.querySelectorAll('.md-ac-item').forEach((el, i) => {
            el.classList.toggle('active', i === activeIdx);
        });
        const activeEl = dropdown.querySelector('.md-ac-item.active');
        if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
    }

    // Tab 触发/确认，方向键选择
    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
            const { word } = getContext();
            if (word.startsWith('\\') && word.length >= 2) {
                e.preventDefault();
                if (visible && currentItems.length) {
                    complete(); // 已显示 → 确认
                } else {
                    showDropdown(); // 未显示 → 展开
                }
            }
        } else if (visible && e.key === 'ArrowDown') {
            e.preventDefault();
            activeIdx = (activeIdx + 1) % currentItems.length;
            updateActive();
        } else if (visible && e.key === 'ArrowUp') {
            e.preventDefault();
            activeIdx = (activeIdx - 1 + currentItems.length) % currentItems.length;
            updateActive();
        } else if (visible && e.key === 'Escape') {
            e.preventDefault();
            hideDropdown();
        } else if (visible && (e.key === 'Enter')) {
            // Enter 不拦截，允许换行
        }
    });

    // 输入时实时过滤（如果下拉已展开则更新，否则不自动弹出）
    textarea.addEventListener('input', () => {
        if (visible) {
            const filtered = getFilteredItems();
            if (filtered.length) {
                renderDropdown(filtered);
                dropdown.querySelectorAll('.md-ac-item').forEach(el => {
                    el.onmousedown = (e) => { e.preventDefault(); activeIdx = +el.dataset.idx; complete(); };
                });
            } else {
                hideDropdown();
            }
        }
    });

    textarea.addEventListener('blur', () => { setTimeout(hideDropdown, 200); });
}

// ============================================================
//  彭罗斯镶嵌底纹（五重对称 P3 tiling）
// ============================================================
function generatePenroseBackground() {
    const existing = document.querySelector('.penrose-bg');
    if (existing) existing.remove();

    const canvas = document.createElement('canvas');
    // 画布大于视口，旋转时不会露出边缘
    const W = 1920, H = 1440;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    // 彭罗斯 P3 镶嵌：从 10 个等腰三角形开始，细分 5 次
    const PHI = (1 + Math.sqrt(5)) / 2;

    // 辅助：向量运算
    function vLerp(a, b, t) {
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }

    const cx = W / 2, cy = H / 2;
    const R = Math.min(W, H) * 0.48;

    // 初始：10 个三角形围绕中心，交替 A/B
    let triangles = [];
    for (let i = 0; i < 10; i++) {
        const a1 = (Math.PI * 2 * i) / 10 - Math.PI / 2;
        const a2 = (Math.PI * 2 * (i + 1)) / 10 - Math.PI / 2;
        const p1 = { x: cx, y: cy };
        const p2 = { x: cx + R * Math.cos(a1), y: cy + R * Math.sin(a1) };
        const p3 = { x: cx + R * Math.cos(a2), y: cy + R * Math.sin(a2) };
        // p1 是顶点（中心），p2-p3 是底边
        // 偶数 A（尖端朝外），奇数 B（翻转）
        triangles.push({ type: i % 2 === 0 ? 'A' : 'B', p1, p2, p3 });
    }

    // P3 deflation 规则
    // A（36-72-72，p1 为 36° 顶点）→ 1 个 A + 1 个 B
    // B（108-36-36，p1 为 108° 顶点）→ 2 个 B + 1 个 A
    function subdivide(tris) {
        const result = [];
        for (const t of tris) {
            const { type, p1, p2, p3 } = t;
            if (type === 'A') {
                // 在 p1→p3 上取黄金分割点 q
                const q = vLerp(p1, p3, 1 / PHI);
                result.push({ type: 'A', p1: p2, p2: q, p3: p1 });
                result.push({ type: 'B', p1: q, p2: p3, p3: p2 });
            } else {
                // B 类型：在两条等边上取黄金分割点
                const r = vLerp(p2, p1, 1 / PHI);
                const s = vLerp(p2, p3, 1 / PHI);
                result.push({ type: 'B', p1: r, p2: p3, p3: p1 });
                result.push({ type: 'B', p1: s, p2: r, p3: p2 });
                result.push({ type: 'A', p1: p3, p2: s, p3: r });
            }
        }
        return result;
    }

    // 细分 5 次
    for (let iter = 0; iter < 5; iter++) {
        triangles = subdivide(triangles);
    }

    const isLight = document.body.classList.contains('light-theme');
    // 取当前主题色
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#818cf8';
    const accentRGB = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim() || '129,140,248';
    // 主题色（暗主题下提高对比度）
    const fillA = isLight ? `rgba(${accentRGB},0.12)` : `rgba(${accentRGB},0.35)`;
    const fillB = isLight ? `rgba(${accentRGB},0.05)` : `rgba(${accentRGB},0.15)`;
    const lineColor = isLight ? `rgba(${accentRGB},0.4)` : `rgba(${accentRGB},0.7)`;

    // 绘制填充
    for (const t of triangles) {
        const { p1, p2, p3 } = t;
        if (p1.x < -50 || p1.x > W + 50 || p1.y < -50 || p1.y > H + 50) continue;
        if (p2.x < -50 || p2.x > W + 50 || p2.y < -50 || p2.y > H + 50) continue;
        if (p3.x < -50 || p3.x > W + 50 || p3.y < -50 || p3.y > H + 50) continue;

        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.lineTo(p3.x, p3.y);
        ctx.closePath();
        ctx.fillStyle = t.type === 'A' ? fillA : fillB;
        ctx.fill();
    }

    // 绘制边线
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 0.6;
    for (const t of triangles) {
        const { p1, p2, p3 } = t;
        if (p1.x < -50 || p1.x > W + 50 || p1.y < -50 || p1.y > H + 50) continue;
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.lineTo(p3.x, p3.y);
        ctx.closePath();
        ctx.stroke();
    }

    // 转为图片背景（大画布 + CSS 动画旋转漂移）
    const div = document.createElement('div');
    div.className = 'penrose-bg';
    div.style.width = W + 'px';
    div.style.height = H + 'px';
    div.style.backgroundImage = `url(${canvas.toDataURL()})`;
    div.style.backgroundSize = '100% 100%';
    document.body.prepend(div);

    // 应用已保存的透明度
    localforage.getItem('penroseOpacity').then(val => {
        if (val != null) {
            document.documentElement.style.setProperty('--penrose-opacity', val / 100);
        }
    });
}

// ---- 设置页 ----
function initSettings() {
    const slider = document.getElementById('penrose-opacity-slider');
    const valueEl = document.getElementById('penrose-opacity-value');
    if (!slider) return;

    // 读取已保存的透明度
    localforage.getItem('penroseOpacity').then(val => {
        const v = val != null ? val : 7;
        slider.value = v;
        valueEl.textContent = v + '%';
    });

    slider.oninput = () => {
        const v = +slider.value;
        valueEl.textContent = v + '%';
        document.documentElement.style.setProperty('--penrose-opacity', v / 100);
        localforage.setItem('penroseOpacity', v);
    };

    // 渲染主题色选择器
    renderColorPicks('dark-color-picks', 'dark');
    renderColorPicks('light-color-picks', 'light');

    // 渲染图节点颜色选择器
    renderGraphColorPicks('graph-color-picks', 'graphColorIdx');
    // 渲染图连线颜色选择器
    renderGraphColorPicks('graph-edge-color-picks', 'graphEdgeColorIdx');

    lucide.createIcons();
}

function renderColorPicks(containerId, mode) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    const isLight = mode === 'light';
    THEME_COLORS.forEach((palette, idx) => {
        const c = isLight ? palette.light : palette.dark;
        const activeIdx = isLight ? lightThemeColorIdx : darkThemeColorIdx;
        const swatch = document.createElement('div');
        swatch.className = 'color-swatch' + (idx === activeIdx ? ' active' : '');
        swatch.style.background = c.accent;
        swatch.title = palette.name;
        swatch.addEventListener('click', () => {
            if (isLight) {
                lightThemeColorIdx = idx;
                localforage.setItem('lightThemeColorIdx', idx);
            } else {
                darkThemeColorIdx = idx;
                localforage.setItem('darkThemeColorIdx', idx);
            }
            // 应用当前主题对应的颜色
            const currentTheme = document.body.classList.contains('light-theme') ? 'light' : 'dark';
            if ((isLight && currentTheme === 'light') || (!isLight && currentTheme === 'dark')) {
                applyAccentColor(currentTheme, idx);
                generatePenroseBackground();
            }
            // 重新渲染选择器高亮
            renderColorPicks(containerId, mode);
        });
        container.appendChild(swatch);
    });
}

function updateColorSwatchActive() {
    document.querySelectorAll('#dark-color-picks .color-swatch').forEach((el, idx) => {
        el.classList.toggle('active', idx === darkThemeColorIdx);
    });
    document.querySelectorAll('#light-color-picks .color-swatch').forEach((el, idx) => {
        el.classList.toggle('active', idx === lightThemeColorIdx);
    });
}

const GRAPH_NODE_COLORS = ['#818cf8', '#c084fc', '#22d3ee', '#34d399', '#fb7185', '#f59e0b', '#3b82f6'];

function renderGraphColorPicks(containerId, storageKey) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    localforage.getItem(storageKey).then(savedIdx => {
        const activeIdx = savedIdx || 0;
        GRAPH_NODE_COLORS.forEach((color, idx) => {
            const swatch = document.createElement('div');
            swatch.className = 'graph-color-swatch' + (idx === activeIdx ? ' active' : '');
            swatch.style.background = color;
            swatch.addEventListener('click', () => {
                localforage.setItem(storageKey, idx);
                renderGraphColorPicks(containerId, storageKey);
            });
            container.appendChild(swatch);
        });
    });
}

// ============================================================
//  初始化
// ============================================================
(async function init() {
    try {
        await initStorage();
        await loadState();
        // 如果是暗色主题（默认），手动应用主题色
        if (!document.body.classList.contains('light-theme')) {
            applyAccentColor('dark', darkThemeColorIdx);
        }
        bindEvents();
        renderShelf();
        await generatePenroseBackground();
        // 应用已保存的底纹透明度
        const savedOpacity = await localforage.getItem('penroseOpacity');
        if (savedOpacity != null) {
            document.documentElement.style.setProperty('--penrose-opacity', savedOpacity / 100);
        }
        lucide.createIcons();
        console.log('[Lumina] 初始化完成，驱动:', STORAGE_DRIVER, '书籍:', library.length);
    } catch (e) {
        console.error('[Lumina] 初始化失败:', e);
        document.getElementById('shelf-container').innerHTML =
            '<div class="empty-shelf"><p>初始化失败，请按 F12 查看控制台</p><p class="hint">' + escHtml(e.message) + '</p></div>';
    }
})();