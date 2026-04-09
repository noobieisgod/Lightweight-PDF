#!/usr/bin/env node
let createCanvas = null;
try {
    const m = await import('./node_modules/@napi-rs/canvas/index.js');
    createCanvas = m.createCanvas ?? m.default?.createCanvas ?? null;
    if (m.ImageData)
        globalThis.ImageData = m.ImageData;
    if (m.Image)
        globalThis.Image = m.Image;
    globalThis.createImageBitmap = async function (source) {
        const w = source?.width ?? source?.naturalWidth ?? 1;
        const h = source?.height ?? source?.naturalHeight ?? 1;
        const c = createCanvas(w, h);
        const ctx = c.getContext('2d');
        try {
            if (source instanceof globalThis.ImageData) {
                ctx.putImageData(source, 0, 0);
            }
            else {
                const raw = source?.data ?? source?.rgba;
                if (raw && raw.length > 0) {
                    const bytes = (raw instanceof Uint8ClampedArray)
                        ? raw : new Uint8ClampedArray(raw.buffer ?? raw);
                    ctx.putImageData(new globalThis.ImageData(bytes, w, h), 0, 0);
                }
            }
        }
        catch { }
        return c;
    };
}
catch { }
if (typeof globalThis.DOMMatrix === 'undefined') {
    await import('./pdfjs-polyfill.mjs');
}
const { getDocument, VerbosityLevel, OPS } = await import('./node_modules/pdfjs-dist/legacy/build/pdf.mjs');
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import http from 'http';
import { spawnSync, spawn } from 'child_process';
const { McpServer } = await import('./node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js');
const { StdioServerTransport } = await import('./node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js');
const z = (await import('./node_modules/zod/index.js')).default;
const ROW_Y_TOLERANCE = 4;
const COL_X_TOLERANCE = 6;
const TABLE_MIN_ROWS = 2;
const TABLE_MIN_COLS = 2;
const TABLE_MIN_COV = 0.6;
const SCAN_MAX_NATIVE_WORDS = 10;
const SCAN_MIN_IMAGE_COVERAGE = 0.70;

const CAPTION_MAX_DIST = 42;
const HEADER_ZONE_PT = 60;
const FOOTER_ZONE_PT = 60;
const HF_Y_BUCKET = 5;
const HF_MIN_PAGES = 2;
const HF_MIN_RATIO = 0.40;
const HF_MAX_WORDS = 10;
const FILTER_MAX_WORDS = 6;
const FILTER_NEAR_EMPTY_WORDS = 18;
const FILTER_SEPARATOR_ROLE_RATIO = 0.85;
const FILTER_LOW_IMAGE_COVERAGE = 0.02;
const ROUTE_TABLE_LIKELIHOOD = 0.45;
const ROUTE_DENSE_TEXT_WORDS = 120;
const ROUTE_LOW_IMAGE_COVERAGE = 0.08;
const ROUTE_VISUAL_IMAGE_COVERAGE = 0.18;
const ROUTE_TEXT_DENSITY = 0.00022;
const IMAGE_DECORATIVE_AREA_RATIO = 0.015;
const IMAGE_LARGE_AREA_RATIO = 0.20;
const DEDUP_MIN_HASH_MATCH = 60;

const SUMMARY_MIN_CONFIDENCE = 0.6;
const OCR_MAX_NATIVE_WORDS = 24;
const OCR_MIN_IMAGE_COVERAGE = 0.08;
const OCR_MIN_WORDS = 10;
const OCR_MIN_CHARS = 45;
const OCR_MIN_ALNUM_RATIO = 0.45;
const OCR_MAX_REPEATED_RATIO = 0.35;
const PARALLEL_CHUNK_SIZE = 5;
function fetchUrl(url) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https://') ? https : http;
        mod.get(url, { headers: { 'User-Agent': 'pdf-extract-addon/1.0' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const redirected = new URL(res.headers.location, url).href;
                return fetchUrl(redirected).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}
async function fetchPdfBytes(url) {
    if (url.startsWith('file:///')) {
        const p = decodeURIComponent(url.slice(8).replace(/\//g, path.sep));
        return fs.promises.readFile(p);
    }
    if (url.startsWith('file://')) {
        const p = decodeURIComponent(url.slice(7).replace(/\//g, path.sep));
        return fs.promises.readFile(p);
    }
    if (url.startsWith('http://') || url.startsWith('https://')) {
        return fetchUrl(url);
    }
    return fs.promises.readFile(url);
}
const LOCAL_FONT_DIR = fileURLToPath(new URL('./node_modules/pdfjs-dist/standard_fonts/', import.meta.url));
class LocalStandardFontDataFactory {
    async fetch({ filename }) {
        return fs.readFileSync(path.join(LOCAL_FONT_DIR, filename));
    }
}
function patchCanvasContext(ctx) {
    if (ctx.__pdfExtractPatched)
        return ctx;
    Object.defineProperty(ctx, '__pdfExtractPatched', { value: true, enumerable: false });
    for (const name of ['fill', 'clip', 'stroke']) {
        const orig = ctx[name].bind(ctx);
        ctx[name] = function (...args) {
            try {
                return orig(...args);
            }
            catch {
                const rule = args.find(a => typeof a === 'string');
                return orig(...(rule ? [rule] : []));
            }
        };
    }
    return ctx;
}
class NodeCanvasFactory {
    create(w, h) {
        const c = createCanvas(w, h);
        const ctx = patchCanvasContext(c.getContext('2d'));
        return { canvas: c, context: ctx };
    }
    reset(cac, w, h) { cac.canvas.width = w; cac.canvas.height = h; }
    destroy(cac) { cac.canvas.width = 0; cac.canvas.height = 0; }
}
async function getDocMetadata(pdfjsDoc) {
    try {
        const { info, metadata } = await pdfjsDoc.getMetadata();
        const s = v => (typeof v === 'string' && v.trim()) ? v.trim() : null;
        const m = {};
        if (s(info?.Title))
            m.title = s(info.Title);
        if (s(info?.Author))
            m.author = s(info.Author);
        if (s(info?.Subject))
            m.subject = s(info.Subject);
        if (s(info?.Keywords))
            m.keywords = s(info.Keywords);
        if (s(info?.Creator))
            m.creator = s(info.Creator);
        if (s(info?.CreationDate))
            m.creationDate = s(info.CreationDate);
        if (s(info?.ModDate))
            m.modDate = s(info.ModDate);
        if (metadata) {
            if (!m.title && s(metadata.get?.('dc:title')))
                m.title = s(metadata.get('dc:title'));
            if (!m.author && s(metadata.get?.('dc:creator')))
                m.author = s(metadata.get('dc:creator'));
        }
        return Object.keys(m).length ? m : null;
    }
    catch {
        return null;
    }
}
async function getDocOutline(pdfjsDoc) {
    try {
        const raw = await pdfjsDoc.getOutline();
        if (!raw?.length)
            return null;
        async function resolvePageNum(dest) {
            try {
                if (!dest)
                    return null;
                const explicit = typeof dest === 'string'
                    ? await pdfjsDoc.getDestination(dest) : dest;
                if (!Array.isArray(explicit) || !explicit[0])
                    return null;
                return (await pdfjsDoc.getPageIndex(explicit[0])) + 1;
            }
            catch {
                return null;
            }
        }
        async function fmt(item) {
            const page = await resolvePageNum(item.dest);
            const out = { title: item.title };
            if (page !== null)
                out.page = page;
            if (item.items?.length)
                out.items = await Promise.all(item.items.map(fmt));
            return out;
        }
        return await Promise.all(raw.map(fmt));
    }
    catch {
        return null;
    }
}
function hfKey(item, pageHeight) {
    const fromTop = item.yTop;
    const fromBottom = pageHeight - item.yTop;
    if (fromTop < HEADER_ZONE_PT)
        return `H${Math.round(fromTop / HF_Y_BUCKET)}`;
    if (fromBottom < FOOTER_ZONE_PT)
        return `F${Math.round(fromBottom / HF_Y_BUCKET)}`;
    return null;
}
function normalizeHFText(str) {
    return str
        .trim()
        .replace(/\d+/g, '#')
        .replace(/\s+/g, ' ')
        .toLowerCase();
}
function hfSignature(item, pageHeight) {
    const zone = hfKey(item, pageHeight);
    if (!zone)
        return null;
    const text = item.str?.trim();
    if (!text || text.split(/\s+/).length > HF_MAX_WORDS)
        return null;
    const xBucket = Math.round((item.x ?? 0) / 24);
    return `${zone}|x${xBucket}|${normalizeHFText(text)}`;
}
function detectHFKeys(allPageData) {
    const keyPages = new Map();
    for (let pi = 0; pi < allPageData.length; pi++) {
        const { rawItems, pageHeight } = allPageData[pi];
        for (const item of rawItems) {
            const k = hfSignature(item, pageHeight);
            if (!k)
                continue;
            if (!keyPages.has(k))
                keyPages.set(k, new Set());
            keyPages.get(k).add(pi);
        }
    }
    const minPages = Math.max(HF_MIN_PAGES, Math.ceil(allPageData.length * HF_MIN_RATIO));
    const result = new Set();
    for (const [k, pages] of keyPages) {
        if (pages.size >= minPages)
            result.add(k);
    }
    return result;
}
const ANN_LABEL = {
    Text: 'Note', FreeText: 'Note', Highlight: 'Highlight',
    Underline: 'Underline', Squiggly: 'Squiggly', StrikeOut: 'Strikethrough',
    Stamp: 'Stamp', FileAttachment: 'File', Link: 'Link',
};
async function getPageAnnotations(pdfjsPage, pageHeight) {
    try {
        const anns = await pdfjsPage.getAnnotations({ intent: 'display' });
        const result = [];
        for (const ann of anns) {
            const sub = ann.subtype;
            if (sub === 'Widget' || sub === 'Popup')
                continue;
            if (sub === 'Link' && !ann.url && !ann.contents?.trim())
                continue;
            const out = { type: ANN_LABEL[sub] ?? sub };
            if (ann.title?.trim())
                out.author = ann.title.trim();
            if (ann.contents?.trim())
                out.content = ann.contents.trim();
            if (sub === 'Link' && ann.url)
                out.url = ann.url;
            if (ann.rect)
                out.y = Math.round(pageHeight - ann.rect[3]);
            result.push(out);
        }
        result.sort((a, b) => (a.y ?? 0) - (b.y ?? 0));
        return result;
    }
    catch {
        return [];
    }
}
function imgDataToCanvas(imgData) {
    const { width, height, data, kind } = imgData;
    if (!width || !height || !data) {
        throw new Error('Decoded image object is missing width, height, or pixel data');
    }
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const raw = data instanceof Uint8ClampedArray || data instanceof Uint8Array
        ? data
        : new Uint8Array(data.buffer ?? data);
    let rgba;
    if (!kind || kind === 3) {
        if (raw.length !== width * height * 4) {
            throw new Error(`Unexpected RGBA image length ${raw.length} for ${width}x${height}`);
        }
        rgba = raw instanceof Uint8ClampedArray ? raw : new Uint8ClampedArray(raw);
    }
    else if (kind === 2) {
        if (raw.length !== width * height * 3) {
            throw new Error(`Unexpected RGB image length ${raw.length} for ${width}x${height}`);
        }
        rgba = new Uint8ClampedArray(width * height * 4);
        for (let i = 0; i < width * height; i++) {
            rgba[i * 4] = raw[i * 3];
            rgba[i * 4 + 1] = raw[i * 3 + 1];
            rgba[i * 4 + 2] = raw[i * 3 + 2];
            rgba[i * 4 + 3] = 255;
        }
    }
    else if (kind === 1) {
        const bytesPerRow = (width + 7) >> 3;
        if (raw.length < bytesPerRow * height) {
            throw new Error(`Unexpected bitonal image length ${raw.length} for ${width}x${height}`);
        }
        rgba = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const byte = raw[y * bytesPerRow + (x >> 3)];
                const v = ((byte >> (7 - (x & 7))) & 1) ? 255 : 0;
                const j = (y * width + x) * 4;
                rgba[j] = rgba[j + 1] = rgba[j + 2] = v;
                rgba[j + 3] = 255;
            }
        }
    }
    else {
        throw new Error(`Unsupported pdf.js image kind: ${kind}`);
    }
    ctx.putImageData(new globalThis.ImageData(rgba, width, height), 0, 0);
    return canvas;
}
function scaleCanvas(canvas, maxImageDim) {
    if (!maxImageDim || Math.max(canvas.width, canvas.height) <= maxImageDim) {
        return canvas;
    }
    const s = maxImageDim / Math.max(canvas.width, canvas.height);
    const dw = Math.max(1, Math.round(canvas.width * s));
    const dh = Math.max(1, Math.round(canvas.height * s));
    const scaled = createCanvas(dw, dh);
    scaled.getContext('2d').drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, dw, dh);
    return scaled;
}
async function canvasToBase64Png(canvas) {
    const png = await canvas.encode('png');
    return Buffer.from(png).toString('base64');
}
async function renderPageCanvas(pdfjsPage, viewport) {
    if (!createCanvas) {
        throw new Error('Canvas unavailable; install @napi-rs/canvas-win32-x64-msvc@0.1.97');
    }
    const fullCanvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const fullCtx = patchCanvasContext(fullCanvas.getContext('2d'));
    await pdfjsPage.render({
        canvasContext: fullCtx,
        viewport,
        canvasFactory: new NodeCanvasFactory(),
    }).promise;
    return fullCanvas;
}
function cropPlacementFromCanvas(fullCanvas, placement, maxImageDim) {
    const sx = Math.max(0, Math.floor(placement.x));
    const sy = Math.max(0, Math.floor(placement.yTop));
    const sw = Math.max(1, Math.min(fullCanvas.width - sx, Math.ceil(placement.w)));
    const sh = Math.max(1, Math.min(fullCanvas.height - sy, Math.ceil(placement.h)));
    const crop = createCanvas(sw, sh);
    crop.getContext('2d').drawImage(fullCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
    return scaleCanvas(crop, maxImageDim);
}
function isCanvasMostlyBlank(canvas) {
    const ctx = canvas.getContext('2d');
    const sampleW = Math.max(1, Math.min(canvas.width, 32));
    const sampleH = Math.max(1, Math.min(canvas.height, 32));

    const offsets = [
        [Math.max(0, Math.floor((canvas.width - sampleW) / 2)), Math.max(0, Math.floor((canvas.height - sampleH) / 2))],
    ];
    if (canvas.width > 64 && canvas.height > 64) {
        offsets.push(
            [Math.floor(canvas.width / 4), Math.floor(canvas.height / 4)],
            [Math.max(0, Math.floor(canvas.width * 3 / 4) - sampleW), Math.floor(canvas.height / 4)],
            [Math.floor(canvas.width / 4), Math.max(0, Math.floor(canvas.height * 3 / 4) - sampleH)],
            [Math.max(0, Math.floor(canvas.width * 3 / 4) - sampleW), Math.max(0, Math.floor(canvas.height * 3 / 4) - sampleH)],
        );
    }
    for (const [offsetX, offsetY] of offsets) {
        const { data } = ctx.getImageData(offsetX, offsetY, sampleW, sampleH);
        let opaque = 0;
        let nearWhite = 0;
        let dark = 0;
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const a = data[i + 3];
            if (a < 8) {
                continue;
            }
            opaque++;
            if (r >= 248 && g >= 248 && b >= 248) {
                nearWhite++;
            }
            if (r <= 235 || g <= 235 || b <= 235) {
                dark++;
            }
        }
        if (opaque === 0) {
            continue;
        }
        if (!(nearWhite / opaque >= 0.985 && dark / opaque <= 0.01)) {
            return false;
        }
    }
    return true;
}
function getTextStats(items) {
    const joined = items.map(item => item.str).join(' ').trim();
    const chars = joined.length;
    const words = joined ? joined.split(/\s+/).length : 0;
    const alnum = (joined.match(/[A-Za-z0-9]/g) ?? []).length;
    const printable = (joined.match(/[ -~]/g) ?? []).length;
    return {
        text: joined,
        chars,
        words,
        printable,
        alnumRatio: printable > 0 ? alnum / printable : 0,
    };
}
function getImageCoverage(placements, viewport) {
    if (!placements.size)
        return 0;
    const pageArea = Math.max(1, viewport.width * viewport.height);
    let covered = 0;
    for (const pos of placements.values()) {
        covered += Math.max(1, pos.w) * Math.max(1, pos.h);
    }
    return Math.min(1, covered / pageArea);
}

let tesseractAvailableCache;
function detectTesseract() {
    if (typeof tesseractAvailableCache === 'boolean') {
        return tesseractAvailableCache;
    }
    try {
        const probe = spawnSync('tesseract', ['--version'], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 5000,
        });
        tesseractAvailableCache = probe.status === 0;
    }
    catch {
        tesseractAvailableCache = false;
    }
    return tesseractAvailableCache;
}
function ocrTextLooksGood(text) {
    const trimmed = (text ?? '').trim();
    if (!trimmed) {
        return { ok: false, reason: 'OCR output was empty' };
    }
    const chars = trimmed.length;
    const words = trimmed.split(/\s+/).filter(Boolean).length;
    const alnum = (trimmed.match(/[A-Za-z0-9]/g) ?? []).length;
    const alnumRatio = chars ? alnum / chars : 0;
    const repeatedRuns = (trimmed.match(/(.)\1{4,}/g) ?? []).join('').length;
    const repeatedRatio = chars ? repeatedRuns / chars : 0;
    if (words < OCR_MIN_WORDS || chars < OCR_MIN_CHARS) {
        return { ok: false, reason: 'OCR output too short' };
    }
    if (alnumRatio < OCR_MIN_ALNUM_RATIO) {
        return { ok: false, reason: 'OCR output had too little readable text' };
    }
    if (repeatedRatio > OCR_MAX_REPEATED_RATIO) {
        return { ok: false, reason: 'OCR output looked repetitive or corrupted' };
    }
    return { ok: true, reason: null };
}
async function runTesseractOcr(pngBytes, pageNum) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-extract-addon-ocr-'));
    const inputPath = path.join(tempDir, `page-${pageNum}.png`);
    try {
        fs.writeFileSync(inputPath, pngBytes);
        const text = await new Promise((resolve, reject) => {
            const proc = spawn('tesseract', [inputPath, 'stdout', '--psm', '6'], { windowsHide: true });
            const chunks = [], errChunks = [];
            proc.stdout.on('data', d => chunks.push(d));
            proc.stderr.on('data', d => errChunks.push(d));
            const timer = setTimeout(() => { proc.kill(); reject(new Error('Tesseract timed out')); }, 30000);
            proc.on('close', code => {
                clearTimeout(timer);
                if (code !== 0) reject(new Error(Buffer.concat(errChunks).toString().trim() || `tesseract exited with status ${code}`));
                else resolve(Buffer.concat(chunks).toString('utf8'));
            });
            proc.on('error', err => { clearTimeout(timer); reject(err); });
        });
        const cleaned = text.replace(/\r\n/g, '\n').trim();
        const quality = ocrTextLooksGood(cleaned);
        if (!quality.ok) return { ok: false, text: cleaned, reason: quality.reason };
        return { ok: true, text: cleaned, reason: null };
    }
    catch (err) {
        return { ok: false, text: '', reason: err?.message ?? String(err) };
    }
    finally {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        catch { }
    }
}
function buildTextLines(items) {
    const sorted = [...items].sort((a, b) => a.yTop - b.yTop || a.x - b.x);
    const lines = [];
    for (const item of sorted) {
        const last = lines[lines.length - 1];
        if (last && Math.abs(item.yTop - last.yTop) <= ROW_Y_TOLERANCE) {
            last.items.push(item);
            last.yBottom = Math.max(last.yBottom, item.yTop + (item.h || 12));
            last.x2 = Math.max(last.x2, item.x + (item.w || 0));
            last.text = '';
        }
        else {
            lines.push({
                yTop: item.yTop,
                yBottom: item.yTop + (item.h || 12),
                x: item.x,
                x2: item.x + (item.w || 0),
                items: [item],
                text: '',
            });
        }
    }
    for (const line of lines) {
        line.items.sort((a, b) => a.x - b.x);
        line.text = line.items.map(item => item.str).join(' ').trim();
    }
    return lines.filter(line => line.text);
}
function classifyBlockRole(text) {
    if (/^\s*(?:[-*•]|\d+[.)])\s+/.test(text))
        return 'list';
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (words.length <= 12 && text.length <= 100 && !/[.?!]$/.test(text))
        return 'heading';
    return 'paragraph';
}
function buildTextBlocks(items) {
    const lines = buildTextLines(items);
    if (!lines.length)
        return [];
    const blocks = [];
    for (const line of lines) {
        const last = blocks[blocks.length - 1];
        const gap = last ? line.yTop - last.yBottom : 0;
        if (last && gap <= Math.max(10, (line.yBottom - line.yTop) * 1.2) && last.role !== 'heading') {
            last.lines.push(line.text);
            last.text = `${last.text}\n${line.text}`;
            last.yBottom = line.yBottom;
            last.bbox.height = last.yBottom - last.yTop;
            last.bbox.width = Math.max(last.bbox.width, line.x2 - last.x);
        }
        else {
            blocks.push({
                text: line.text,
                lines: [line.text],
                role: classifyBlockRole(line.text),
                x: line.x,
                yTop: line.yTop,
                yBottom: line.yBottom,
                bbox: { x: line.x, y: line.yTop, width: line.x2 - line.x, height: line.yBottom - line.yTop },
            });
        }
    }
    return blocks.map(block => ({
        role: block.role,
        text: block.text,
        bbox: block.bbox,
    }));
}
function normalizeLooseText(text) {
    return (text ?? '')
        .trim()
        .replace(/\d+/g, '#')
        .replace(/\s+/g, ' ')
        .toLowerCase();
}
function getDominantBlockRole(textBlocks) {
    const counts = new Map();
    for (const block of textBlocks ?? []) {
        counts.set(block.role, (counts.get(block.role) ?? 0) + 1);
    }
    let best = 'paragraph';
    let bestCount = -1;
    for (const [role, count] of counts) {
        if (count > bestCount) {
            best = role;
            bestCount = count;
        }
    }
    return best;
}
function groupItemsIntoRows(items) {
    const sorted = [...items].sort((a, b) => a.yTop - b.yTop || a.x - b.x);
    const rows = [];
    for (const item of sorted) {
        const last = rows[rows.length - 1];
        if (last && Math.abs(item.yTop - last[0].yTop) <= ROW_Y_TOLERANCE) {
            last.push(item);
        } else {
            rows.push([item]);
        }
    }
    return rows;
}
function estimateTableLikelihood(items) {
    if (!items.length) return 0;
    const rows = groupItemsIntoRows(items);
    const multiColRows = rows.filter(r => r.length >= 2).length;
    return rows.length ? multiColRows / rows.length : 0;
}

function hashString(str) {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}
function buildPageProfile(pageNum, bodyItems, textBlocks, imagePlacements, viewport, annotations, strippedByBoilerplate) {
    const textStats = getTextStats(bodyItems);
    const imageCoverage = getImageCoverage(imagePlacements, viewport);
    const tableLikelihood = estimateTableLikelihood(bodyItems);
    const dominantRole = getDominantBlockRole(textBlocks);
    const textDensity = textStats.words / Math.max(1, viewport.width * viewport.height);
    const normalizedBlocks = (textBlocks ?? [])
        .map(block => normalizeLooseText(block.text))
        .filter(Boolean);
    return {
        page: pageNum,
        wordCount: textStats.words,
        textChars: textStats.chars,
        textDensity,
        imageCoverage,
        tableLikelihood,
        dominantRole,
        contentClassHint: (imageCoverage >= 0.35 && dominantRole === 'heading' && textStats.words <= 20)
            ? 'photo'
            : dominantRole === 'list'
                ? 'structured_text'
                : 'text',
        annotationsCount: annotations?.length ?? 0,
        pageFingerprint: hashString(normalizedBlocks.join('|') || `${textStats.words}|${imagePlacements.size}|${dominantRole}`),
        strippedByBoilerplate,
    };
}
function decidePageRouting(profile) {
    if (profile.wordCount === 0 && profile.imageCoverage === 0 && profile.annotationsCount === 0) {
        return {
            extractionMode: 'filtered',
            routingMode: 'filtered',
            contentClass: 'blank',
            filteredReason: 'Blank page',
        };
    }
    if (profile.wordCount <= FILTER_MAX_WORDS &&
        profile.imageCoverage <= FILTER_LOW_IMAGE_COVERAGE &&
        profile.annotationsCount === 0 &&
        (profile.dominantRole === 'heading' || profile.dominantRole === 'list')) {
        return {
            extractionMode: 'filtered',
            routingMode: 'filtered',
            contentClass: 'separator',
            filteredReason: 'Low-information separator/title page',
        };
    }
    if (profile.wordCount <= SCAN_MAX_NATIVE_WORDS &&
        profile.imageCoverage >= SCAN_MIN_IMAGE_COVERAGE) {
        if (profile.contentClassHint === 'photo') {
            return {
                extractionMode: 'visual_fallback',
                routingMode: 'page_visual_fallback',
                contentClass: 'visual',
                filteredReason: null,
            };
        }
        return {
            extractionMode: 'ocr',
            routingMode: 'page_ocr',
            contentClass: 'scan_like',
            filteredReason: null,
        };
    }
    if (profile.wordCount <= OCR_MAX_NATIVE_WORDS &&
        profile.imageCoverage >= OCR_MIN_IMAGE_COVERAGE &&
        profile.contentClassHint !== 'photo') {
        return {
            extractionMode: 'ocr',
            routingMode: 'page_ocr',
            contentClass: 'ocr_candidate',
            filteredReason: null,
        };
    }
    if (profile.tableLikelihood >= ROUTE_TABLE_LIKELIHOOD) {
        return {
            extractionMode: 'native',
            routingMode: 'native_table_heavy',
            contentClass: 'table',
            filteredReason: null,
        };
    }
    if (profile.wordCount >= ROUTE_DENSE_TEXT_WORDS &&
        profile.imageCoverage <= ROUTE_LOW_IMAGE_COVERAGE &&
        profile.textDensity >= ROUTE_TEXT_DENSITY) {
        return {
            extractionMode: 'native',
            routingMode: 'native_text',
            contentClass: 'dense_text',
            filteredReason: null,
        };
    }
    if (profile.imageCoverage >= ROUTE_VISUAL_IMAGE_COVERAGE) {
        return {
            extractionMode: 'native',
            routingMode: 'native_visual_regions',
            contentClass: 'visual',
            filteredReason: null,
        };
    }
    return {
        extractionMode: 'native',
        routingMode: 'native_text',
        contentClass: profile.dominantRole === 'list' ? 'structured_text' : 'text',
        filteredReason: null,
    };
}
function classifyRegionKind(placement, caption, pageProfile) {
    const pageArea = Math.max(1, pageProfile.viewportWidth * pageProfile.viewportHeight);
    const areaRatio = (placement.w * placement.h) / pageArea;
    if (areaRatio <= IMAGE_DECORATIVE_AREA_RATIO && !caption) {
        return 'decorative';
    }
    if (caption || pageProfile.tableLikelihood >= ROUTE_TABLE_LIKELIHOOD || pageProfile.textDensity >= ROUTE_TEXT_DENSITY) {
        return 'diagram';
    }
    if (areaRatio >= IMAGE_LARGE_AREA_RATIO) {
        return 'photo';
    }
    return 'graphic';
}
function shouldTryOcr(pageProfile, routing) {
    return routing.routingMode === 'page_ocr';
}
function getTargetImageDim(regionKind, pageProfile, maxImageDim, caption) {
    const hardMax = maxImageDim ?? 768;
    if (regionKind === 'decorative') {
        return Math.min(hardMax, 224);
    }
    if (regionKind === 'photo') {
        return Math.min(hardMax, 512);
    }
    if (regionKind === 'diagram') {
        return Math.min(hardMax, pageProfile.textDensity >= ROUTE_TEXT_DENSITY || caption ? 1024 : 896);
    }
    return Math.min(hardMax, 640);
}
function imageHashBits(canvas) {
    const size = 8;
    const tiny = createCanvas(size, size);
    const ctx = tiny.getContext('2d');
    ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);
    const gray = [];
    for (let i = 0; i < data.length; i += 4) {
        gray.push(Math.round((data[i] + data[i + 1] + data[i + 2]) / 3));
    }
    const avg = gray.reduce((a, b) => a + b, 0) / gray.length;
    return gray.map(v => (v >= avg ? '1' : '0')).join('');
}
function hashMatchScore(a, b) {
    const len = Math.min(a.length, b.length);
    let same = 0;
    for (let i = 0; i < len; i++) {
        if (a[i] === b[i]) {
            same++;
        }
    }
    return same;
}
function buildNormalizedStructure(pageText, textBlocks) {
    const keyValueLines = [];
    const headingFacts = [];
    for (const block of textBlocks ?? []) {
        const lines = block.text.split('\n').map(line => line.trim()).filter(Boolean);
        for (const line of lines) {
            if (/^[A-Za-z][A-Za-z0-9 /&()-]{1,40}:\s+\S+/.test(line)) {
                keyValueLines.push(line);
            }
        }
        if (block.role === 'heading') {
            headingFacts.push(block.text);
        }
    }
    const facts = [];
    if (keyValueLines.length) {
        facts.push(...keyValueLines);
    }
    else if (headingFacts.length && pageText.length <= 1200) {
        facts.push(...headingFacts);
    }
    return {
        summaryText: facts.join('\n'),
        confidence: keyValueLines.length ? 0.9 : headingFacts.length >= 2 ? 0.65 : 0,
    };
}
function findCaptionForImage(imagePos, textBlocks) {
    for (const block of textBlocks) {
        const vertical = block.bbox.y - (imagePos.yTop + imagePos.h);
        const horizontalOverlap = Math.max(0, Math.min(block.bbox.x + block.bbox.width, imagePos.x + imagePos.w) - Math.max(block.bbox.x, imagePos.x));
        if (vertical >= 0 && vertical <= CAPTION_MAX_DIST && horizontalOverlap > 0 && block.text.length <= 180) {
            return block.text;
        }
    }
    return null;
}
function normalizeTableRows(rows) {
    const merged = [];
    for (const row of rows) {
        const populated = row.reduce((n, cell) => n + (cell ? 1 : 0), 0);
        const prev = merged[merged.length - 1];
        if (prev && populated > 0 && populated <= Math.max(1, Math.floor(row.length / 3))) {
            row.forEach((cell, idx) => {
                if (cell)
                    prev[idx] = prev[idx] ? `${prev[idx]} ${cell}` : cell;
            });
        }
        else {
            merged.push(row.map(cell => (cell || '').trim()));
        }
    }
    return merged;
}
function resolveObjAsync(objs, name, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for obj "${name}"`)), timeoutMs);
        try {
            objs.get(name, (data) => {
                clearTimeout(timer);
                resolve(data);
            });
        }
        catch (e) {
            clearTimeout(timer);
            reject(e);
        }
    });
}
async function renderPageImages(pdfjsPage, viewport, placements, imagePlans, maxImageDim) {
    const result = new Map();
    if (placements.size === 0)
        return result;
    if (!createCanvas) {
        for (const name of placements.keys())
            result.set(name, {
                data: null,
                mimeType: null,
                error: 'Canvas unavailable; install @napi-rs/canvas-win32-x64-msvc@0.1.97',
            });
        return result;
    }
    let fullCanvas = null;
    let renderError = null;
    try {
        fullCanvas = await renderPageCanvas(pdfjsPage, viewport);
    }
    catch (err) {
        renderError = err;
    }
    for (const [name, placement] of placements) {
        try {
            let canvas = null;
            const plan = imagePlans?.get(name);
            const targetDim = plan?.targetMaxDim ?? maxImageDim;
            let directError = null;
            let imgData = null;
            try {
                imgData = await resolveObjAsync(pdfjsPage.objs, name);
            }
            catch (err) {
                directError = err;
            }
            if (!imgData) {
                try {
                    imgData = await resolveObjAsync(pdfjsPage.commonObjs, name);
                }
                catch (err) {
                    if (!directError) {
                        directError = err;
                    }
                }
            }
            if (imgData?.data instanceof Uint8ClampedArray || imgData?.data instanceof Uint8Array) {
                const directCanvas = scaleCanvas(imgDataToCanvas(imgData), targetDim);
                if (!isCanvasMostlyBlank(directCanvas)) {
                    canvas = directCanvas;
                }
            }
            if (!canvas && fullCanvas) {
                const renderedCanvas = cropPlacementFromCanvas(fullCanvas, placement, targetDim);
                if (!isCanvasMostlyBlank(renderedCanvas)) {
                    canvas = renderedCanvas;
                }
            }
            if (!canvas) {
                const msg = directError?.message ?? renderError?.message ?? 'Unable to render or extract image';
                result.set(name, { data: null, mimeType: null, error: `Extract error: ${msg}` });
                continue;
            }
            result.set(name, {
                data: await canvasToBase64Png(canvas),
                mimeType: 'image/png',
                hashBits: imageHashBits(canvas),
                error: null,
            });
        }
        catch (err) {
            result.set(name, {
                data: null,
                mimeType: null,
                error: `Extract error: ${err?.message ?? err}`,
            });
        }
    }
    return result;
}
async function getImagePlacements(pdfjsPage, pageHeight) {
    const placements = new Map();
    let ops;
    try {
        ops = await pdfjsPage.getOperatorList();
    }
    catch {
        return placements;
    }
    const stack = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    const mul = (a, b) => [
        a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
    ];
    for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        const args = ops.argsArray[i];
        if (fn === OPS.save) {
            stack.push([...ctm]);
        }
        else if (fn === OPS.restore) {
            if (stack.length)
                ctm = stack.pop();
        }
        else if (fn === OPS.transform) {
            ctm = mul(ctm, args);
        }
        else if (fn === OPS.paintImageXObject) {
            const name = args[0];
            const imgW = Math.abs(ctm[0]) || Math.abs(ctm[2]) || 1;
            const imgH = Math.abs(ctm[3]) || Math.abs(ctm[1]) || 1;
            const imgX = ctm[4];
            const imgY = ctm[5];
            const yTop = pageHeight - imgY - imgH;
            if (!placements.has(name)) {
                placements.set(name, { x: imgX, yTop, w: imgW, h: imgH });
            }
        }
    }
    return placements;
}
function buildMcidMapAndRawItems(tcItems, pageHeight) {
    const mcidMap = new Map();
    const rawItems = [];
    let currentMcid = null;
    let mcidTexts = [];
    let mcidYTop = null;
    for (const item of tcItems) {
        if (item.type === 'beginMarkedContentProps' && item.id) {
            currentMcid = item.id;
            mcidTexts = [];
            mcidYTop = null;
        } else if (item.type === 'endMarkedContent') {
            if (currentMcid !== null) {
                mcidMap.set(currentMcid, {
                    text: mcidTexts.map(s => s.trim()).filter(Boolean).join(' '),
                    yTop: mcidYTop,
                });
            }
            currentMcid = null;
            mcidTexts = [];
            mcidYTop = null;
        } else if (item.str?.trim()) {
            const [, , , , tx, ty] = item.transform;
            const yTop = pageHeight - ty;
            if (currentMcid !== null) {
                mcidTexts.push(item.str);
                if (mcidYTop === null) mcidYTop = yTop;
            }
            rawItems.push({ str: item.str, x: tx, yTop, w: item.width ?? 0, h: item.height ?? 12, mcid: currentMcid });
        }
    }
    return { mcidMap, rawItems };
}
function extractStructTables(structTree, mcidMap) {
    if (!structTree) return [];
    function getCellText(node) {
        if (node.type === 'content') return mcidMap.get(node.id)?.text ?? '';
        return (node.children ?? []).map(getCellText).filter(Boolean).join(' ');
    }
    function getTableMcids(node, ids = new Set()) {
        if (node.type === 'content' && node.id) ids.add(node.id);
        for (const child of node.children ?? []) getTableMcids(child, ids);
        return ids;
    }
    const tables = [];
    function walkNode(node) {
        if (node.role === 'Table') {
            const rows = [];
            for (const child of node.children ?? []) {
                const trs = child.role === 'TR' ? [child]
                    : ['TBody', 'THead', 'TFoot'].includes(child.role)
                        ? (child.children ?? []).filter(c => c.role === 'TR')
                        : [];
                for (const tr of trs) {
                    const cells = (tr.children ?? []).filter(c => c.role === 'TD' || c.role === 'TH');
                    if (!cells.length) continue;
                    const row = cells.map(c => getCellText(c).trim());
                    if (row.some(Boolean)) rows.push(row);
                }
            }
            if (rows.length >= TABLE_MIN_ROWS) {
                const mcids = getTableMcids(node);
                let yTop = Infinity, yBottom = 0;
                for (const id of mcids) {
                    const e = mcidMap.get(id);
                    if (e?.yTop != null) {
                        yTop = Math.min(yTop, e.yTop);
                        yBottom = Math.max(yBottom, e.yTop + 12);
                    }
                }
                tables.push({ rows, mcids, yTop: isFinite(yTop) ? yTop : 0, yBottom: yBottom || 100 });
            }
            return;
        }
        for (const child of node.children ?? []) walkNode(child);
    }
    walkNode(structTree);
    return tables;
}
function detectTables(items) {
    if (items.length === 0)
        return { tables: [], nonTableItems: [] };
    const rows = groupItemsIntoRows(items);
    for (const row of rows)
        row.sort((a, b) => a.x - b.x);
    if (rows.length < TABLE_MIN_ROWS) {
        return { tables: [], nonTableItems: items };
    }
    const allX = rows.flatMap(r => r.map(it => it.x)).sort((a, b) => a - b);
    const colAnchors = [];
    for (const x of allX) {
        const last = colAnchors[colAnchors.length - 1];
        if (last !== undefined && Math.abs(x - last) <= COL_X_TOLERANCE) {
            colAnchors[colAnchors.length - 1] = (last + x) / 2;
        }
        else {
            colAnchors.push(x);
        }
    }
    if (colAnchors.length < TABLE_MIN_COLS) {
        return { tables: [], nonTableItems: items };
    }
    const rowScores = rows.map(row => {
        const hits = row.filter(it => colAnchors.some(ax => Math.abs(it.x - ax) <= COL_X_TOLERANCE)).length;
        return hits / Math.max(colAnchors.length, 1);
    });
    const inTable = rowScores.map(s => s >= TABLE_MIN_COV);
    const tables = [];
    const nonTableItems = [];
    let ri = 0;
    while (ri < rows.length) {
        if (!inTable[ri]) {
            nonTableItems.push(...rows[ri]);
            ri++;
            continue;
        }
        const tableRows = [];
        while (ri < rows.length && inTable[ri]) {
            tableRows.push(rows[ri]);
            ri++;
        }
        if (tableRows.length < TABLE_MIN_ROWS) {
            nonTableItems.push(...tableRows.flat());
            continue;
        }
        const tableX = tableRows.flatMap(r => r.map(it => it.x)).sort((a, b) => a - b);
        const tableCols = [];
        for (const x of tableX) {
            const last = tableCols[tableCols.length - 1];
            if (last !== undefined && Math.abs(x - last) <= COL_X_TOLERANCE) {
                tableCols[tableCols.length - 1] = (last + x) / 2;
            }
            else {
                tableCols.push(x);
            }
        }
        if (tableCols.length < TABLE_MIN_COLS) {
            nonTableItems.push(...tableRows.flat());
            continue;
        }
        const grid = tableRows.map(row => {
            const cells = new Array(tableCols.length).fill('');
            for (const it of row) {
                const ci = tableCols.reduce((best, ax, idx) => Math.abs(ax - it.x) < Math.abs(tableCols[best] - it.x) ? idx : best, 0);
                cells[ci] = cells[ci] ? `${cells[ci]} ${it.str}` : it.str;
            }
            return cells;
        });
        const yTop = tableRows[0][0].yTop;
        const lastRow = tableRows[tableRows.length - 1];
        const yBottom = lastRow[0].yTop + (lastRow[0].h || 12);
        tables.push({ rows: grid, yTop, yBottom });
    }
    return { tables, nonTableItems };
}
function buildPageText(textItems, imagePlacements, tables, imageIds, tableIds) {
    const elements = [];
    for (const it of textItems) {
        elements.push({ yTop: it.yTop, x: it.x, kind: 'text', str: it.str });
    }
    for (const [name, pos] of imagePlacements.entries()) {
        const id = imageIds.get(name);
        if (id)
            elements.push({ yTop: pos.yTop, x: pos.x, kind: 'marker', str: `[${id}]` });
    }
    for (const [idx, tbl] of tables.entries()) {
        const id = tableIds.get(idx);
        if (id)
            elements.push({ yTop: tbl.yTop, x: 0, kind: 'marker', str: `[${id}]` });
    }
    elements.sort((a, b) => {
        const dy = a.yTop - b.yTop;
        return Math.abs(dy) > ROW_Y_TOLERANCE ? dy : a.x - b.x;
    });
    const lines = [];
    let line = [];
    let lastY = null;
    for (const el of elements) {
        if (lastY !== null && Math.abs(el.yTop - lastY) > ROW_Y_TOLERANCE) {
            if (line.length)
                lines.push(line.map(e => e.str).join(' '));
            line = [];
        }
        line.push(el);
        lastY = el.yTop;
    }
    if (line.length)
        lines.push(line.map(e => e.str).join(' '));
    return lines.join('\n');
}
function buildHeaderLines(result) {
    const headerLines = [];
    if (result.metadata) {
        const m = result.metadata;
        if (m.title)
            headerLines.push(`Title:    ${m.title}`);
        if (m.author)
            headerLines.push(`Author:   ${m.author}`);
        if (m.subject)
            headerLines.push(`Subject:  ${m.subject}`);
        if (m.keywords)
            headerLines.push(`Keywords: ${m.keywords}`);
        if (m.creationDate)
            headerLines.push(`Created:  ${m.creationDate}`);
    }
    if (result.outline?.length) {
        function fmtOutline(items, depth) {
            return items.flatMap(item => {
                const children = item.items?.length ? fmtOutline(item.items, depth + 1) : [];
                if (!item.title?.trim()) return children;
                const indent = '  '.repeat(depth);
                const page = item.page ? ` (p.${item.page})` : '';
                const line = `${indent}• ${item.title}${page}`;
                return [line, ...children];
            });
        }
        headerLines.push('', 'Outline:');
        headerLines.push(...fmtOutline(result.outline, 1));
    }
    if (result.strippedHF) {
        const hf = result.strippedHF;
        const stripped = [];
        if (hf.headers.length)
            stripped.push(`headers: ${hf.headers.map(s => `"${s}"`).join(', ')}`);
        if (hf.footers.length)
            stripped.push(`footers: ${hf.footers.map(s => `"${s}"`).join(', ')}`);
        if (hf.hasPageNums)
            stripped.push('page numbers');
        if (stripped.length)
            headerLines.push('', `[Repeated headers/footers stripped: ${stripped.join(' | ')}]`);
    }
    return headerLines;
}
async function processOnePage({ pageNum, pdfjsPage, viewport, pageHeight, rawItems, mcidMap }, hfPositions, maxImageDim) {
    const bodyItems = hfPositions.size > 0
        ? rawItems.filter(item => {
            const k = hfSignature(item, pageHeight);
            return !k || !hfPositions.has(k) || item.str.trim().split(/\s+/).length > HF_MAX_WORDS;
        })
        : rawItems;
    const strippedByBoilerplate = rawItems.length ? (rawItems.length - bodyItems.length) / rawItems.length : 0;
    const [imagePlacements, annotations] = await Promise.all([
        getImagePlacements(pdfjsPage, pageHeight),
        getPageAnnotations(pdfjsPage, pageHeight),
    ]);
    const textBlocks = buildTextBlocks(bodyItems);
    const pageProfile = {
        ...buildPageProfile(pageNum, bodyItems, textBlocks, imagePlacements, viewport, annotations, strippedByBoilerplate),
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
    };
    const routing = decidePageRouting(pageProfile);
    let extractionMode = routing.extractionMode;
    let routingMode = routing.routingMode;
    let contentClass = routing.contentClass;
    let fallbackReason = null;
    let filteredReason = routing.filteredReason ?? null;
    let rawPageImage = null;
    let rawImages = [];
    let rawTables = [];
    let pageText = '';
    let structuredSummary = null;
    let ocrAttempted = false;
    let ocrAccepted = false;
    let ocrReason = null;
    let cachedFullCanvas = null;
    if (extractionMode === 'filtered') {
        pageText = '';
    }
    if (shouldTryOcr(pageProfile, routing)) {
        if (!detectTesseract()) {
            extractionMode = 'visual_fallback';
            routingMode = 'page_visual_fallback';
            contentClass = 'scan_like';
            ocrReason = 'Tesseract not available on PATH';
        }
        else {
            ocrAttempted = true;
            cachedFullCanvas = await renderPageCanvas(pdfjsPage, viewport);
            const ocrCanvas = scaleCanvas(cachedFullCanvas, Math.min(maxImageDim ?? 1400, 1400));
            const ocrPng = await ocrCanvas.encode('png');
            const ocrResult = await runTesseractOcr(Buffer.from(ocrPng), pageNum);
            if (ocrResult.ok) {
                extractionMode = 'ocr';
                routingMode = 'page_ocr';
                contentClass = 'ocr_text';
                ocrAccepted = true;
                pageText = ocrResult.text;
            }
            else {
                extractionMode = 'visual_fallback';
                routingMode = 'page_visual_fallback';
                contentClass = 'scan_like';
                ocrReason = ocrResult.reason;
            }
        }
    }
    if (extractionMode === 'visual_fallback') {
        const fullCanvas = cachedFullCanvas ?? await renderPageCanvas(pdfjsPage, viewport);
        const fallbackMaxDim = pageProfile.textDensity >= ROUTE_TEXT_DENSITY ? Math.min(maxImageDim ?? 1400, 1400) : Math.min(maxImageDim ?? 960, 960);
        const scaledPageCanvas = scaleCanvas(fullCanvas, fallbackMaxDim);
        const pageImageData = await canvasToBase64Png(scaledPageCanvas);
        fallbackReason = ocrReason ?? 'Low-text page routed to whole-page visual fallback';
        rawPageImage = { width: scaledPageCanvas.width, height: scaledPageCanvas.height, data: pageImageData, mimeType: 'image/png' };
        pageText = `[PAGE_IMAGE_LOCAL_0]\n(Page rendered as an image for visual reading)`;
    }
    if (extractionMode === 'native') {
        const structTree = await pdfjsPage.getStructTree();
        const structTables = extractStructTables(structTree, mcidMap);
        let tables, nonTableItems;
        if (structTables.length > 0) {
            const tableMcids = new Set(structTables.flatMap(t => [...t.mcids]));
            tables = structTables;
            nonTableItems = bodyItems.filter(it => it.mcid == null || !tableMcids.has(it.mcid));
        } else {
            ({ tables, nonTableItems } = detectTables(bodyItems));
        }
        const normalizedTables = tables.map(table => ({ ...table, rows: normalizeTableRows(table.rows) }));
        const imagePlans = new Map();
        const activePlacements = new Map();
        for (const [name, placement] of imagePlacements.entries()) {
            const caption = findCaptionForImage(placement, textBlocks);
            const regionKind = classifyRegionKind(placement, caption, pageProfile);
            if (regionKind === 'decorative') continue;
            activePlacements.set(name, placement);
            imagePlans.set(name, {
                caption,
                regionKind,
                targetMaxDim: getTargetImageDim(regionKind, pageProfile, maxImageDim, caption),
            });
        }
        const renderedImages = await renderPageImages(pdfjsPage, viewport, activePlacements, imagePlans, maxImageDim);
        const imageIds = new Map();
        let localImageIdx = 0;
        rawImages = [];
        for (const [name, pl] of activePlacements.entries()) {
            const localId = `IMG_LOCAL_${localImageIdx++}`;
            const img = renderedImages.get(name) ?? { data: null, mimeType: null, error: 'Image render failed' };
            imageIds.set(name, localId);
            const plan = imagePlans.get(name);
            const area = Math.ceil(pl.w * pl.h);
            const ratio = pl.h ? pl.w / pl.h : 1;
            const base = { hashBits: img.hashBits ?? null, area, ratio, bbox: { x: pl.x, y: pl.yTop, width: pl.w, height: pl.h }, caption: plan?.caption ?? null, regionKind: plan?.regionKind ?? null };
            rawImages.push(img.data
                ? { ...base, width: Math.ceil(pl.w), height: Math.ceil(pl.h), data: img.data, mimeType: img.mimeType ?? 'image/png', fallbackNeeded: false, fallbackReason: null }
                : { ...base, hashBits: null, width: null, height: null, data: null, mimeType: null, fallbackNeeded: true, fallbackReason: img.error ?? 'Canvas unavailable; install @napi-rs/canvas-win32-x64-msvc@0.1.97' });
        }
        const tableIds = new Map();
        let localTableIdx = 0;
        rawTables = [];
        for (let ti = 0; ti < normalizedTables.length; ti++) {
            tableIds.set(ti, `TBL_LOCAL_${localTableIdx++}`);
            rawTables.push({ rows: normalizedTables[ti].rows, bbox: { x: 0, y: normalizedTables[ti].yTop, width: viewport.width, height: normalizedTables[ti].yBottom - normalizedTables[ti].yTop } });
        }
        pageText = buildPageText(nonTableItems, activePlacements, normalizedTables, imageIds, tableIds);
        structuredSummary = buildNormalizedStructure(pageText, textBlocks);
        if (structuredSummary?.confidence >= SUMMARY_MIN_CONFIDENCE && structuredSummary.summaryText) {
            const compactSummary = structuredSummary.summaryText.trim();
            if (compactSummary && compactSummary.length < pageText.length * 0.8) {
                pageText = compactSummary;
            }
        }
    }
    pdfjsPage.cleanup();
    return {
        page: pageNum,
        extractionMode,
        routingMode,
        contentClass,
        fallbackReason,
        filteredReason,
        ocrAttempted,
        ocrAccepted,
        ocrReason,
        text: pageText,
        textBlocks,
        annotations,
        structuredSummary,
        pageProfile,
        rawImages,
        rawTables,
        rawPageImage,
    };
}
async function extractPageContent(pdfBytes, requestedPages, maxImageDim) {
    const uint8 = new Uint8Array(pdfBytes);
    const pdfjsDoc = await getDocument({
        data: uint8,
        StandardFontDataFactory: LocalStandardFontDataFactory,
        canvasFactory: createCanvas ? new NodeCanvasFactory() : undefined,
        verbosity: VerbosityLevel.ERRORS,
        useWorkerFetch: false,
        isEvalSupported: false,
    }).promise;
    const totalPages = pdfjsDoc.numPages;
    let pageNums;
    if (!requestedPages || requestedPages.length === 0) {
        pageNums = Array.from({ length: totalPages }, (_, i) => i + 1);
    }
    else {
        const set = new Set();
        for (const interval of requestedPages) {
            const s = Math.max(1, interval.start ?? 1);
            const e = Math.min(totalPages, interval.end ?? totalPages);
            for (let p = s; p <= e; p++)
                set.add(p);
        }
        pageNums = [...set].sort((a, b) => a - b);
    }
    const [docMetadata, docOutline] = await Promise.all([
        getDocMetadata(pdfjsDoc),
        getDocOutline(pdfjsDoc),
    ]);
    const allPageData = await Promise.all(pageNums.map(async (pageNum) => {
        const pdfjsPage = await pdfjsDoc.getPage(pageNum);
        const viewport = pdfjsPage.getViewport({ scale: 1 });
        const pageHeight = viewport.height;
        const tc = await pdfjsPage.getTextContent({ includeMarkedContent: true });
        const { mcidMap, rawItems } = buildMcidMapAndRawItems(tc.items, pageHeight);
        return { pageNum, pdfjsPage, viewport, pageHeight, rawItems, mcidMap };
    }));
    const hfPositions = detectHFKeys(allPageData);
    const hfHeaderSamples = new Set();
    const hfFooterSamples = new Set();
    let hfHasPageNums = false;
    if (hfPositions.size > 0) {
        for (const { rawItems, pageHeight } of allPageData) {
            for (const item of rawItems) {
                const k = hfSignature(item, pageHeight);
                if (!k || !hfPositions.has(k))
                    continue;
                if (item.str.trim().split(/\s+/).length > HF_MAX_WORDS)
                    continue;
                const isPageNum = /^\s*[-–—]?\s*\d+\s*[-–—]?\s*$/.test(item.str) ||
                    /^page\s+\d+(\s+of\s+\d+)?$/i.test(item.str.trim());
                if (isPageNum) {
                    hfHasPageNums = true;
                    continue;
                }
                (k.startsWith('H') ? hfHeaderSamples : hfFooterSamples).add(item.str.trim());
            }
        }
    }
    const rawPageResults = [];
    for (let i = 0; i < allPageData.length; i += PARALLEL_CHUNK_SIZE) {
        const chunk = allPageData.slice(i, i + PARALLEL_CHUNK_SIZE);
        const chunkResults = await Promise.all(chunk.map(pd => processOnePage(pd, hfPositions, maxImageDim)));
        rawPageResults.push(...chunkResults);
    }
    let globalImageIdx = 1, globalTableIdx = 1, globalPageImageIdx = 1;
    const seenVisualHashes = [];
    const results = [];
    for (const raw of rawPageResults) {
        const imageIdMap = new Map();
        const imageResults = [];
        for (let li = 0; li < raw.rawImages.length; li++) {
            const img = raw.rawImages[li];
            const id = `IMAGE_${globalImageIdx++}`;
            imageIdMap.set(li, id);
            let dedupRef = null;
            if (img.hashBits) {
                const existing = seenVisualHashes.find(e =>
                    Math.abs(e.area - img.area) / Math.max(1, img.area) < 0.3 &&
                    Math.abs(e.ratio - img.ratio) < 0.2 &&
                    hashMatchScore(e.hashBits, img.hashBits) >= DEDUP_MIN_HASH_MATCH
                );
                if (existing) dedupRef = existing.id;
                else seenVisualHashes.push({ id, hashBits: img.hashBits, area: img.area, ratio: img.ratio });
            }
            imageResults.push({
                id,
                width: img.width,
                height: img.height,
                data: dedupRef ? null : img.data,
                mimeType: img.mimeType,
                fallbackNeeded: img.fallbackNeeded,
                fallbackReason: img.fallbackReason,
                bbox: img.bbox,
                caption: img.caption,
                dedupRef,
                regionKind: img.regionKind,
            });
        }
        const tableIdMap = new Map();
        const tableResults = [];
        for (let li = 0; li < raw.rawTables.length; li++) {
            const id = `TABLE_${globalTableIdx++}`;
            tableIdMap.set(li, id);
            tableResults.push({ id, data: raw.rawTables[li].rows, bbox: raw.rawTables[li].bbox });
        }
        let pageImage = null;
        let pageImageId = null;
        if (raw.rawPageImage) {
            pageImageId = `PAGE_IMAGE_${globalPageImageIdx++}`;
            pageImage = { id: pageImageId, ...raw.rawPageImage };
        }
        let text = raw.text;
        for (const [li, id] of imageIdMap) text = text.replaceAll(`[IMG_LOCAL_${li}]`, `[${id}]`);
        for (const [li, id] of tableIdMap) text = text.replaceAll(`[TBL_LOCAL_${li}]`, `[${id}]`);
        if (pageImageId) text = text.replace('[PAGE_IMAGE_LOCAL_0]', `[${pageImageId}]`);
        results.push({
            page: raw.page,
            extractionMode: raw.extractionMode,
            routingMode: raw.routingMode,
            contentClass: raw.contentClass,
            fallbackReason: raw.fallbackReason,
            filteredReason: raw.filteredReason,
            ocrAttempted: raw.ocrAttempted,
            ocrAccepted: raw.ocrAccepted,
            ocrReason: raw.ocrReason,
            text,
            textBlocks: raw.textBlocks,
            images: imageResults,
            tables: tableResults,
            pageImage,
            annotations: raw.annotations,
            structuredSummary: raw.structuredSummary,
            pageProfile: raw.pageProfile,
        });
    }
    pdfjsDoc.destroy();
    return {
        totalPages,
        metadata: docMetadata,
        outline: docOutline,
        strippedHF: hfPositions.size > 0 ? {
            headers: [...hfHeaderSamples],
            footers: [...hfFooterSamples],
            hasPageNums: hfHasPageNums,
        } : null,
        pages: results,
    };
}
const server = new McpServer({
    name: 'pdf-extract-addon',
    version: '1.0.0',
});
const PageIntervalSchema = z.object({
    start: z.number().int().min(1).optional(),
    end: z.number().int().min(1).optional(),
});
server.tool('extract_pdf_content', `Extract optimised content from a PDF document.

Returns document metadata and outline once, then per-page content as Claude-optimised text with inline markers and image blocks.`, {
    url: z.string().describe('PDF URL (https://) or local file path. Use list_pdfs tool first to find local files.'),
    pages: z.preprocess(v => typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return v; } })() : v, z.array(PageIntervalSchema).optional()).describe('Page ranges to extract. [{start:1,end:5}] or [{}] for all. Defaults to all pages.'),
    max_image_dim: z.preprocess(v => typeof v === 'string' ? Number(v) : v, z.number().int().min(64).max(4096).optional()).describe('Downscale images larger than this dimension (px) before returning. Saves tokens for high-res images.'),
}, async ({ url, pages, max_image_dim }) => {
    let pdfBytes;
    try {
        pdfBytes = await fetchPdfBytes(url);
    }
    catch (err) {
        return {
            content: [{ type: 'text', text: `Failed to fetch PDF: ${err.message}` }],
            isError: true,
        };
    }
    let result;
    try {
        result = await extractPageContent(pdfBytes, pages, max_image_dim);
    }
    catch (err) {
        return {
            content: [{ type: 'text', text: `Extraction failed: ${err.message}` }],
            isError: true,
        };
    }
    const content = [];
    const headerLines = buildHeaderLines(result);
    if (headerLines.length) {
        content.push({ type: 'text', text: headerLines.join('\n') });
    }
    for (const page of result.pages) {
        if (page.extractionMode === 'filtered') {
            continue;
        }
        const modeNote = page.extractionMode !== 'native' ? ' [' + page.extractionMode + ']' : '';
        content.push({
            type: 'text',
            text: '\nPage ' + page.page + ' / ' + result.totalPages + modeNote + '\n' + (page.text || '(no text)'),
        });
        if (page.structuredSummary?.summaryText && page.structuredSummary.confidence >= SUMMARY_MIN_CONFIDENCE && page.text !== page.structuredSummary.summaryText && page.structuredSummary.summaryText.length < page.text.length * 0.8) {
            content.push({ type: 'text', text: '[Structured Summary]\n' + page.structuredSummary.summaryText });
        }
        for (const tbl of page.tables) {
            content.push({ type: 'text', text: '[' + tbl.id + ']\n' + JSON.stringify(tbl.data) });
        }
        if (page.pageImage?.data) {
            content.push({ type: 'text', text: '[' + page.pageImage.id + ']' });
            content.push({ type: 'image', data: page.pageImage.data, mimeType: page.pageImage.mimeType });
        }
        for (const img of page.images) {
            if (img.data) {
                content.push({ type: 'text', text: '[' + img.id + ']' + (img.caption ? ' ' + img.caption : '') });
                content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
            }
            else if (img.dedupRef) {
                content.push({ type: 'text', text: '[' + img.id + '] same as ' + img.dedupRef });
            }
            else {
                content.push({ type: 'text', text: '[' + img.id + '] ' + img.fallbackReason });
            }
        }
        if (page.annotations?.length) {
            const annLines = page.annotations.map(a => {
                const who = a.author ? ' <- ' + a.author : '';
                const body = a.content ? ': "' + a.content + '"' : '';
                const link = a.url ? ' <- ' + a.url : '';
                return '  [' + a.type + ']' + who + body + link;
            });
            content.push({ type: 'text', text: '[Annotations]\n' + annLines.join('\n') });
        }
    }
    return { content };
});
const args = process.argv.slice(2);
if (args.includes('--stdio')) {
    await server.connect(new StdioServerTransport());
}
else {
    console.error('Usage: node pdf-extract-addon.mjs --stdio');
    process.exit(1);
}
