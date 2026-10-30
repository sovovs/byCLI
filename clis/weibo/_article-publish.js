/** Save a Weibo long article draft through the logged-in browser UI. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';
import { getSelfUid, unwrapEvaluateResult } from './utils.js';

const EDITOR_URL = 'https://card.weibo.com/article/v5/editor#/draft';
const MAX_TITLE = 32;
const MAX_SUMMARY = 44;
const BODY_IMAGE_EXT = /\.(?:jpe?g|png|gif|webp)$/i;
const COVER_EXT = /\.(?:jpe?g|png|gif|bmp)$/i;
const WEIBO_IMAGE_URL = /^https?:\/\/[^/]*sinaimg\.cn\//i;
const IMAGE_TOKEN_PREFIX = 'BYCLI_WEIBO_IMAGE_';
const FILE_INPUT_ID = 'bycli-weibo-article-file';
const IMAGE_UPLOAD_TIMEOUT_SECONDS = 90;
const IMG_TAG = /<img\b[^>]*>/gi;
const FIGURE_BLOCK = /<figure\b[^>]*>(?:(?!<\/figure>)[\s\S])*?<\/figure>/gi;

function readContent(kwargs) {
    const inline = String(kwargs?.content || '').trim();
    const file = String(kwargs?.['content-file'] || kwargs?.contentFile || '').trim();
    if (inline && file) throw new ArgumentError('Use either --content or --content-file, not both');
    const requested = String(kwargs?.['content-format'] || kwargs?.contentFormat || '').trim().toLowerCase();
    if (requested && requested !== 'text' && requested !== 'html') throw new ArgumentError('--content-format must be text or html');
    if (file) {
        const absolute = path.resolve(file);
        const stat = fs.statSync(absolute, { throwIfNoEntry: false });
        if (!stat?.isFile()) throw new ArgumentError(`Not a valid content file: ${absolute}`);
        if (/\.(?:md|markdown)$/i.test(absolute)) {
            throw new ArgumentError('Markdown is not converted by bycli. Render it to HTML offline and pass the .html file.');
        }
        const format = requested || (/\.html?$/i.test(absolute) ? 'html' : 'text');
        return { text: fs.readFileSync(absolute, 'utf8').trim(), source: absolute, baseDir: path.dirname(absolute), format };
    }
    if (!inline) throw new ArgumentError('Weibo article content is required via --content or --content-file');
    return { text: inline, source: 'inline', baseDir: process.cwd(), format: requested || 'text' };
}

function validateTitle(value) {
    const title = String(value || '').trim();
    if (!title) throw new ArgumentError('Weibo article title is required');
    if ([...title].length > MAX_TITLE) throw new ArgumentError(`Weibo article title exceeds ${MAX_TITLE} characters`);
    return title;
}

function validateSummary(value) {
    const summary = String(value || '').trim();
    if ([...summary].length > MAX_SUMMARY) throw new ArgumentError(`Weibo article summary exceeds ${MAX_SUMMARY} characters`);
    return summary;
}

function validateCover(value) {
    if (!value) return null;
    const absolute = path.resolve(String(value).trim());
    const stat = fs.statSync(absolute, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new ArgumentError(`Not a valid cover image: ${absolute}`);
    if (!COVER_EXT.test(absolute)) throw new ArgumentError('Cover must be jpg, jpeg, png, gif, or bmp');
    return absolute;
}

function escapeHtml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function textToHtml(text) {
    return String(text).split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean)
        .map((block) => `<p>${block.split('\n').map(escapeHtml).join('<br>')}</p>`).join('');
}

function imgSrc(tag) {
    const match = tag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    return match ? (match[1] ?? match[2] ?? match[3] ?? '').trim() : '';
}

function resolveLocalImage(src, baseDir) {
    if (/^file:/i.test(src)) return fileURLToPath(src);
    let decoded = src;
    try { decoded = decodeURI(src); } catch { /* keep raw src */ }
    return path.resolve(baseDir, decoded);
}

function htmlText(html) {
    return html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(?:p|h[1-6]|li|blockquote|div|tr)>/gi, '\n')
        .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function hasMarkdownResidue(text) {
    return /^\s{0,3}#{1,6}\s+\S/m.test(text) || /!\[[^\]]*\]\([^)]*\)/.test(text);
}

/**
 * Checks that offline-prepared HTML matches what the Weibo editor keeps.
 * The HTML is never rewritten here; violations are reported so the upstream renderer can fix them.
 */
function analyzeHtml(html, baseDir) {
    const errors = [];
    const warnings = [];
    const images = [];
    for (const tag of html.match(IMG_TAG) || []) {
        const src = imgSrc(tag);
        if (!src) { errors.push('An <img> has no src'); continue; }
        if (/^data:/i.test(src)) {
            const match = /^data:image\/([a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(src);
            if (!match) { errors.push('Unsupported data: image; only base64 image payloads are accepted'); continue; }
            const ext = match[1].toLowerCase().replace('jpeg', 'jpg').replace('svg+xml', 'svg');
            if (!BODY_IMAGE_EXT.test(`x.${ext}`)) { errors.push(`Unsupported data: image type: ${match[1]}`); continue; }
            images.push({ kind: 'data', src, ext, base64: match[2].replace(/\s+/g, '') });
            continue;
        }
        if (/^https?:/i.test(src)) {
            if (WEIBO_IMAGE_URL.test(src)) images.push({ kind: 'remote', src });
            else errors.push(`Remote image is not hosted on sinaimg.cn; download it locally first: ${src}`);
            continue;
        }
        const file = resolveLocalImage(src, baseDir);
        if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) { errors.push(`Image file not found: ${src} -> ${file}`); continue; }
        if (!BODY_IMAGE_EXT.test(file)) { errors.push(`Unsupported image type: ${file}`); continue; }
        images.push({ kind: 'local', src, file });
    }
    const paragraphsWithImages = (html.match(/<p\b[^>]*>(?:(?!<\/p>)[\s\S])*?<\/p>/gi) || []).filter((p) => /<img\b/i.test(p)).length;
    if (paragraphsWithImages) {
        errors.push(`${paragraphsWithImages} <img> inside <p>; the Weibo editor drops them. Put each image at block level (<img> or <figure class="image">).`);
    }
    if (hasMarkdownResidue(htmlText(html))) errors.push('Body still contains Markdown markers (## or ![...](...)); render it to HTML offline first');
    const anchors = (html.match(/<a\b[^>]*\bhref\s*=\s*(?:"(?!https?:)|'(?!https?:)|(?!["']|https?:))/gi) || []).length;
    if (anchors) warnings.push(`${anchors} non-http link(s) will lose their link (the editor only keeps http/https)`);
    return { errors, warnings, images };
}

function prepareBody(content) {
    if (content.format === 'text') {
        if (hasMarkdownResidue(content.text)) throw new ArgumentError('Text content contains Markdown markers; render it to HTML offline and use --content-format html');
        return { html: textToHtml(content.text), images: [], uploads: [], warnings: [] };
    }
    const report = analyzeHtml(content.text, content.baseDir);
    if (report.errors.length) throw new ArgumentError(`HTML is not ready for the Weibo editor:\n- ${report.errors.join('\n- ')}`);
    const uploads = [];
    const placeholder = (file) => { uploads.push(file); return `<p>${IMAGE_TOKEN_PREFIX}${uploads.length - 1}</p>`; };
    const imageFor = (tag) => report.images.find((img) => (img.kind === 'local' || img.kind === 'data') && img.src === imgSrc(tag));
    const imageBlock = new RegExp(`${FIGURE_BLOCK.source}|${IMG_TAG.source}`, 'gi');
    const html = content.text.replace(imageBlock, (block) => {
        const tag = (block.match(IMG_TAG) || [])[0];
        const image = tag && imageFor(tag);
        if (!image) return block;
        const label = image.kind === 'local' ? path.basename(image.file) : 'data: image';
        if (/<figcaption\b/i.test(block)) report.warnings.push(`Caption dropped for uploaded image: ${label}`);
        return placeholder(image);
    });
    return { html, images: report.images, uploads, warnings: report.warnings };
}

async function evaluate(page, js) {
    return unwrapEvaluateResult(await page.evaluate(js));
}

const EDITOR_JS = `document.querySelector('.ProseMirror')?.editor`;
// A fresh Weibo editor holds a zero-width space, so Tiptap's isEmpty is always false.
const EDITOR_BLANK_JS = `((editor) => { let blocks = 0; editor.state.doc.descendants((node) => { if (node.type.name === 'figure' || node.type.name === 'table') blocks++; }); return !blocks && !editor.getText().replace(/[\\u200b\\s]/g, ''); })`;

const EDITOR_STATE_JS = `(() => ({ url: location.href, draftId: (location.hash.match(/#\\/draft\\/(\\d+)/) || [])[1] || null, ready: !!(${EDITOR_JS}) && !!document.querySelector('textarea[placeholder="请输入标题"]'), empty: !!(${EDITOR_JS}) && ${EDITOR_BLANK_JS}(${EDITOR_JS}) && !document.querySelector('textarea[placeholder="请输入标题"]').value }))()`;

async function waitForEditorState(page, accept) {
    for (let i = 0; i < 20; i++) {
        const state = await evaluate(page, EDITOR_STATE_JS);
        if (state?.url && /passport\.weibo|login/i.test(state.url)) throw new AuthRequiredError('weibo.com', 'Weibo article editor redirected to login');
        if (state?.ready && accept(state)) return state;
        await page.wait({ time: 1 });
    }
    return null;
}

/**
 * The editor only saves into a draft created by 写文章; the bare #/draft view rejects saves with 参数错误.
 * On load the editor may also jump back to the last opened draft, so only a new draft id counts.
 */
async function openNewDraft(page) {
    if (!await waitForEditorState(page, () => true)) throw new CommandExecutionError('Weibo article editor did not load; the editor layout may have changed.');
    await page.wait({ time: 2 });
    const previousId = (await evaluate(page, EDITOR_STATE_JS))?.draftId || null;
    const clicked = await evaluate(page, `(() => { const button = [...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && (b.innerText || '').trim() === '写文章'); if (!button) return false; button.click(); return true; })()`);
    if (!clicked) throw new CommandExecutionError('Weibo article 写文章 button was not found; the editor layout may have changed.');
    const state = await waitForEditorState(page, (s) => !!s.draftId && s.draftId !== previousId);
    if (!state) throw new CommandExecutionError('Weibo did not create a new article draft');
    // The hash switches before the new draft is loaded into the editor, which then replaces whatever is there.
    let blankPolls = 0;
    for (let i = 0; i < 15 && blankPolls < 3; i++) {
        await page.wait({ time: 1 });
        const current = await evaluate(page, EDITOR_STATE_JS);
        if (current?.draftId !== state.draftId) throw new CommandExecutionError(`Weibo editor left new draft ${state.draftId}; check 草稿箱 manually.`);
        blankPolls = current.empty ? blankPolls + 1 : 0;
    }
    if (blankPolls < 3) throw new CommandExecutionError(`New Weibo draft ${state.draftId} is not empty; check 草稿箱 manually.`);
    return state.draftId;
}

async function fillTextarea(page, placeholder, value) {
    const ok = await evaluate(page, `(() => { const el = document.querySelector('textarea[placeholder=${JSON.stringify(placeholder)}]'); if (!el) return false; el.focus(); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); el.blur(); return el.value === ${JSON.stringify(value)}; })()`);
    if (!ok) throw new CommandExecutionError(`Could not fill Weibo article field: ${placeholder}`);
}

async function setBody(page, html, placeholderCount) {
    const ok = await evaluate(page, `(() => { const editor = ${EDITOR_JS}; if (!editor) return false; editor.commands.setContent(${JSON.stringify(html)}, true); return !${EDITOR_BLANK_JS}(editor); })()`);
    if (!ok) throw new CommandExecutionError('Could not write the Weibo article body');
    await page.wait({ time: 2 });
    const found = await evaluate(page, `(() => { const editor = ${EDITOR_JS}; if (!editor || ${EDITOR_BLANK_JS}(editor)) return -1; return (editor.getText().match(/${IMAGE_TOKEN_PREFIX}\\d+/g) || []).length; })()`);
    if (found !== placeholderCount) throw new CommandExecutionError('The Weibo editor replaced the article body after it was written; check 草稿箱 manually.');
}

async function figureState(page) {
    return evaluate(page, `(() => { const editor = ${EDITOR_JS}; const figures = []; editor.state.doc.descendants((node) => { if (node.type.name === 'figure') figures.push({ src: String(node.attrs.src || ''), uploadState: node.attrs.uploadState ?? null }); }); return figures; })()`);
}

function writeTempImage(image) {
    const file = path.join(os.tmpdir(), `bycli-weibo-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${image.ext}`);
    fs.writeFileSync(file, Buffer.from(image.base64, 'base64'));
    return file;
}

async function uploadBodyImage(page, file, index, expectedFigures) {
    await evaluate(page, `(() => { let input = document.getElementById(${JSON.stringify(FILE_INPUT_ID)}); if (!input) { input = document.createElement('input'); input.type = 'file'; input.id = ${JSON.stringify(FILE_INPUT_ID)}; input.accept = 'image/*'; input.style.display = 'none'; document.body.appendChild(input); } input.value = ''; return true; })()`);
    await page.setFileInput([file], `#${FILE_INPUT_ID}`);
    const token = `${IMAGE_TOKEN_PREFIX}${index}`;
    const findToken = `let target = null; editor.state.doc.descendants((node, pos) => { if (!target && node.type.name === 'paragraph' && node.textContent.trim() === ${JSON.stringify(token)}) target = { pos, size: node.nodeSize }; });`;
    // setFigureWithUpload expects a position inside a text block and inserts the figure after that block.
    const placed = await evaluate(page, `(() => { const editor = ${EDITOR_JS}; const file = document.getElementById(${JSON.stringify(FILE_INPUT_ID)})?.files?.[0]; if (!file) return 'no-file'; ${findToken} if (!target) return 'no-placeholder at ' + location.hash + ', body starts: ' + JSON.stringify(editor.getText().slice(0, 60)); editor.commands.setFigureWithUpload({ file, pos: target.pos + 1 }); return 'ok'; })()`);
    if (placed !== 'ok') throw new CommandExecutionError(`Could not insert body image ${path.basename(file)} (${placed})`);
    for (let i = 0; i < IMAGE_UPLOAD_TIMEOUT_SECONDS; i++) {
        await page.wait({ time: 1 });
        const figures = await figureState(page);
        if (figures.length === expectedFigures && figures.every((fig) => WEIBO_IMAGE_URL.test(fig.src))) {
            const removed = await evaluate(page, `(() => { const editor = ${EDITOR_JS}; ${findToken} if (!target) return false; return editor.chain().deleteRange({ from: target.pos, to: target.pos + target.size }).run(); })()`);
            if (!removed) throw new CommandExecutionError(`Could not remove the placeholder for body image ${path.basename(file)}`);
            return;
        }
        if (i >= 5 && figures.length < expectedFigures) throw new CommandExecutionError(`Weibo rejected body image ${path.basename(file)}; check its size (175px to 3840x2160) and format.`);
    }
    throw new CommandExecutionError(`Timed out uploading body image ${path.basename(file)}`);
}

async function verifyBody(page, expectedFigures) {
    const state = await evaluate(page, `(() => { const editor = ${EDITOR_JS}; return { text: editor.getText(), chars: editor.storage?.characterCount?.characters?.() ?? null }; })()`);
    const figures = await figureState(page);
    const problems = [];
    if (figures.length !== expectedFigures) problems.push(`expected ${expectedFigures} images, editor has ${figures.length}`);
    const foreign = figures.filter((fig) => !WEIBO_IMAGE_URL.test(fig.src));
    if (foreign.length) problems.push(`${foreign.length} image(s) are not on sinaimg.cn`);
    if (String(state?.text || '').includes(IMAGE_TOKEN_PREFIX)) problems.push('image placeholders remain in the body');
    if (hasMarkdownResidue(String(state?.text || ''))) problems.push('body contains Markdown markers');
    if (problems.length) throw new CommandExecutionError(`Weibo article body check failed: ${problems.join('; ')}. Nothing was saved.`);
    return state?.chars ?? null;
}

async function clickDialogButton(page, pattern) {
    return evaluate(page, `(() => { const dialogs = [...document.querySelectorAll('.n-dialog')]; const dialog = dialogs[dialogs.length - 1]; if (!dialog) return false; const button = [...dialog.querySelectorAll('button')].reverse().find((b) => b.offsetParent !== null && !b.disabled && ${pattern}.test((b.innerText || '').trim())); if (!button) return false; button.click(); return true; })()`);
}

/**
 * Cover flow: 设置文章封面 -> 图片库 tab -> upload -> select the new .image-item -> 下一步 -> 图片裁剪 确定.
 * Failures leave the cover for manual setup instead of aborting the draft.
 */
async function setCover(page, cover) {
    const opened = await evaluate(page, `(() => { const entry = document.querySelector('.cover-empty'); if (!entry) return false; entry.click(); return true; })()`);
    if (!opened) return 'manual: cover entry not found';
    await page.wait({ time: 1 });
    const tab = await evaluate(page, `(() => { const dialog = document.querySelector('.n-dialog'); const tab = dialog && [...dialog.querySelectorAll('*')].filter((n) => n.children.length === 0 && (n.textContent || '').trim() === '图片库').pop(); if (!tab) return false; tab.click(); return true; })()`);
    if (!tab) return 'manual: cover library tab not found';
    await page.wait({ time: 1 });
    const before = await evaluate(page, `(() => { const input = document.querySelector('.n-dialog input[type="file"]'); if (!input) return null; input.setAttribute('data-bycli-weibo-cover', '1'); return [...document.querySelectorAll('.n-dialog .image-item img')].map((img) => img.src); })()`);
    if (!Array.isArray(before)) return 'manual: cover upload input not found';
    await page.setFileInput([cover], '[data-bycli-weibo-cover="1"]');
    // Clicking the <img> opens a preview; selection is bound to the .image-item wrapper.
    // Clicking toggles selection and the class updates on the next render, so each uploaded item is clicked once.
    // While uploading, the library shows a temporary preview that is re-rendered once the sinaimg URL exists.
    let picked = false;
    let clickedSrc = null;
    for (let i = 0; i < 30 && !picked; i++) {
        await page.wait({ time: 1 });
        const state = await evaluate(page, `(() => { const known = new Set(${JSON.stringify(before)}); const item = [...document.querySelectorAll('.n-dialog .image-item')].find((el) => { const src = el.querySelector('img')?.src || ''; return /sinaimg\\.cn\\//.test(src) && !known.has(src); }); if (!item) return { status: 'missing' }; const src = item.querySelector('img').src; if (item.classList.contains('is-selected')) return { status: 'selected', src }; if (src === ${JSON.stringify(clickedSrc)}) return { status: 'pending', src }; item.click(); return { status: 'clicked', src }; })()`);
        if (state?.status === 'clicked') clickedSrc = state.src;
        picked = state?.status === 'selected';
    }
    if (!picked) { await clickDialogButton(page, '/^取消$/'); return 'manual: uploaded cover did not appear in the library'; }
    let next = false;
    for (let i = 0; i < 5 && !next; i++) {
        await page.wait({ time: 1 });
        next = await clickDialogButton(page, '/^下一步$/');
    }
    if (!next) { await clickDialogButton(page, '/^取消$/'); return 'manual: cover next step not available'; }
    let confirmed = false;
    for (let i = 0; i < 10 && !confirmed; i++) {
        await page.wait({ time: 1 });
        confirmed = await evaluate(page, `(() => { const dialog = [...document.querySelectorAll('.n-dialog')].find((d) => /图片裁剪/.test(d.innerText || '')); const button = dialog && [...dialog.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '确定' && !b.disabled); if (!button) return false; button.click(); return true; })()`);
    }
    if (!confirmed) { await clickDialogButton(page, '/^取消$/'); return 'manual: cover crop dialog not found'; }
    for (let i = 0; i < 15; i++) {
        await page.wait({ time: 1 });
        const done = await evaluate(page, `(() => !!document.querySelector('.cover-preview img') && !document.querySelector('.n-dialog'))()`);
        if (done) return 'set';
    }
    return 'manual: cover preview did not appear';
}

/**
 * The success toast is unreliable and autosave hits the same endpoint, so the result is read from
 * draft/save responses for this draft that arrive after the click (code 100000 means saved).
 */
async function saveDraft(page, draftId) {
    const clicked = await evaluate(page, `(() => {
        window.__bycliWeiboSaves = [];
        if (!window.__bycliWeiboSaveHook) {
            window.__bycliWeiboSaveHook = true;
            const open = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function (method, url, ...rest) { this.__bycliUrl = String(url); return open.call(this, method, url, ...rest); };
            const send = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.send = function (...args) {
                if (/\\/aj\\/editor\\/draft\\/save/.test(this.__bycliUrl || '')) {
                    this.addEventListener('loadend', () => { let body = null; try { body = JSON.parse(this.responseText); } catch {} window.__bycliWeiboSaves?.push({ url: this.__bycliUrl, status: this.status, body }); });
                }
                return send.apply(this, args);
            };
        }
        const button = [...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && (b.innerText || '').trim() === '保存草稿');
        if (!button) return false;
        button.click();
        return true;
    })()`);
    if (!clicked) throw new CommandExecutionError('Weibo article 保存草稿 button was not found; the editor layout may have changed.');
    for (let i = 0; i < 20; i++) {
        await page.wait({ time: 1 });
        const saves = (await evaluate(page, `(() => window.__bycliWeiboSaves || [])()`) || []).filter((s) => new RegExp(`[?&]id=${draftId}(?:&|$)`).test(s.url));
        const last = saves[saves.length - 1];
        if (!last) continue;
        if (last.body?.code === 100000) return { time: last.body.data?.time || null, contentLength: last.body.data?.content_length ?? null };
        if (last.body?.data?.geetest?.length) throw new CommandExecutionError('Weibo asked for a captcha while saving; finish it in the browser, then save manually.');
        throw new CommandExecutionError(`Weibo did not save the draft: ${last.body?.msg || `HTTP ${last.status}`}`);
    }
    throw new CommandExecutionError('Weibo draft save result was unclear. Check 草稿箱 manually; do not retry automatically.');
}

export async function runWeiboArticlePublish(page, kwargs) {
    const title = validateTitle(kwargs?.title);
    const summary = validateSummary(kwargs?.summary);
    const content = readContent(kwargs);
    if (!content.text) throw new ArgumentError('Weibo article content cannot be empty');
    const cover = validateCover(kwargs?.cover);
    const body = prepareBody(content);
    const localImages = body.images.filter((img) => img.kind === 'local' || img.kind === 'data');
    const row = {
        title,
        content_format: content.format,
        content_source: content.source,
        images: `${localImages.length} local, ${body.images.length - localImages.length} remote`,
        cover: cover || null,
        warnings: body.warnings.join('; ') || null,
    };
    const execute = kwargs?.execute === true || kwargs?.execute === 'true';
    if (!execute) {
        return [{ status: 'dry-run', ...row, message: 'Preview only; pass --execute to save a draft. Publishing stays manual.' }];
    }
    if (!page) throw new CommandExecutionError('Browser session required for weibo article-publish');
    await page.goto('https://weibo.com', { waitUntil: 'load', settleMs: 2000 });
    try { await getSelfUid(page); } catch (error) {
        if (error instanceof AuthRequiredError) throw error;
        throw new CommandExecutionError('Not logged into Weibo. Please login at weibo.com first.');
    }
    // The query forces a reload; a hash-only navigation would keep the previous editor state.
    await page.goto(EDITOR_URL.replace('#', `?_=${Date.now()}#`), { waitUntil: 'load', settleMs: 1500 });
    const draftId = await openNewDraft(page);
    await fillTextarea(page, '请输入标题', title);
    if (summary) await fillTextarea(page, '导语（选填）', summary);
    await setBody(page, body.html, body.uploads?.length || 0);
    const remoteCount = body.images.length - localImages.length;
    for (let i = 0; i < body.uploads.length; i++) {
        const upload = body.uploads[i];
        let file = upload.kind === 'local' ? upload.file : null;
        let tempFile = null;
        if (!file) { tempFile = writeTempImage(upload); file = tempFile; }
        try {
            await uploadBodyImage(page, file, i, remoteCount + i + 1);
        } finally {
            if (tempFile) fs.rmSync(tempFile, { force: true });
        }
    }
    const chars = await verifyBody(page, body.images.length);
    const coverStatus = cover ? await setCover(page, cover) : null;
    const saved = await saveDraft(page, draftId);
    return [{
        status: 'draft-saved',
        draft_id: draftId,
        ...row,
        content_chars: saved.contentLength ?? chars,
        cover: coverStatus,
        message: `Draft saved at ${saved.time || 'unknown time'}. To publish: open the draft, click 下一步, pass Weibo's slider identity check by hand, then click 发布.`,
        url: `https://card.weibo.com/article/v5/editor#/draft/${draftId}`,
    }];
}


export const __test__ = { readContent, validateTitle, validateSummary, validateCover, analyzeHtml, prepareBody, textToHtml };

export { MAX_TITLE, MAX_SUMMARY };
