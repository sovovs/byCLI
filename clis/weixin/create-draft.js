import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';
import { loadDraftContent, prepareHtmlContent } from './_wechat/draft-content.js';
import { pasteHtmlThroughClipboard } from './_wechat/html-clipboard.js';
import { createDraftViaApi } from './_wechat/api-draft.js';
import { stageDraftHtmlImages } from './_wechat/draft-image-stage.js';

const WEIXIN_DOMAIN = 'mp.weixin.qq.com';
const WEIXIN_HOME = 'https://mp.weixin.qq.com/';
const MAX_TITLE_LENGTH = 64;
const MAX_AUTHOR_LENGTH = 8;
const SUPPORTED_COVER_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

function codePointLength(value) {
    return [...value].length;
}

function requiredText(value, name) {
    const text = String(value ?? '').trim();
    if (!text) throw new ArgumentError(`${name} must not be empty`);
    return text;
}

function validateCoverImage(value) {
    if (value === undefined || value === null) return null;
    const coverPath = nodePath.resolve(requiredText(value, 'cover-image'));
    const extension = nodePath.extname(coverPath).toLowerCase();
    if (!SUPPORTED_COVER_EXTENSIONS.has(extension)) {
        throw new ArgumentError('cover-image must be a jpg, jpeg, png, gif, or webp file');
    }
    const info = nodeFs.statSync(coverPath, { throwIfNoEntry: false });
    if (!info?.isFile() || info.size <= 0) {
        throw new ArgumentError(`cover-image must be a readable non-empty file: ${coverPath}`);
    }
    try {
        nodeFs.accessSync(coverPath, nodeFs.constants.R_OK);
    } catch {
        throw new ArgumentError(`cover-image must be readable: ${coverPath}`);
    }
    return coverPath;
}

function readApiCredentials(kwargs) {
    const appid = kwargs.appid == null ? '' : String(kwargs.appid).trim();
    const appsecret = kwargs.appsecret == null ? '' : String(kwargs.appsecret).trim();
    if (Boolean(appid) !== Boolean(appsecret)) {
        throw new ArgumentError('appid and appsecret must be provided together');
    }
    return { appid: appid || null, appsecret: appsecret || null };
}

function requiresBrowser(kwargs) {
    const { appid, appsecret } = readApiCredentials(kwargs);
    if (kwargs['dry-run'] === true) return true;
    return !(appid && appsecret);
}

function normalizeCreateDraftArgs(kwargs) {
    const title = requiredText(kwargs.title, 'title');
    if (codePointLength(title) > MAX_TITLE_LENGTH) {
        throw new ArgumentError(`title must be at most ${MAX_TITLE_LENGTH} characters`);
    }
    const author = kwargs.author == null ? null : requiredText(kwargs.author, 'author');
    if (author && codePointLength(author) > MAX_AUTHOR_LENGTH) {
        throw new ArgumentError(`author must be at most ${MAX_AUTHOR_LENGTH} characters`);
    }
    const draftContent = loadDraftContent({
        content: kwargs.content,
        contentFile: kwargs['content-file'],
        contentFormat: kwargs['content-format'],
    });
    const { appid, appsecret } = readApiCredentials(kwargs);
    return {
        title,
        ...draftContent,
        author,
        summary: kwargs.summary == null ? null : String(kwargs.summary).trim(),
        coverImage: validateCoverImage(kwargs['cover-image']),
        dryRun: kwargs['dry-run'] === true,
        allowPrivateImageHosts: kwargs['allow-private-image-hosts'] === true,
        appid,
        appsecret,
    };
}

async function getToken(page) {
    return page.evaluate(`(window.location.href.match(/token=(\\d+)/)||[])[1]`);
}

async function navigateToEditor(page) {
    await page.goto(WEIXIN_HOME, { stealth: false });
    await page.wait(3);
    const token = await getToken(page);
    if (!token) {
        throw new AuthRequiredError(
            WEIXIN_DOMAIN,
            'Could not extract session token. Please log in to mp.weixin.qq.com',
        );
    }
    await page.goto(`https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77&token=${token}&lang=zh_CN`, { stealth: false });
    await page.wait(10);
    const hasTitle = await page.evaluate('!!document.querySelector("textarea#title")');
    if (!hasTitle) {
        throw new AuthRequiredError(
            WEIXIN_DOMAIN,
            'Article editor did not load. Session may have expired',
        );
    }
}

async function fillField(page, selector, value) {
    return page.evaluate(`(() => {
        var el = document.querySelector('${selector}');
        if (!el) return { ok: false, reason: 'not found: ${selector}' };
        var expected = ${JSON.stringify(value)};
        el.focus();
        var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        var setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) setter.set.call(el, expected);
        else el.value = expected;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: expected }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.blur();
        return el.value === expected
            ? { ok: true, value: el.value }
            : { ok: false, reason: 'value mismatch', value: el.value };
    })()`);
}

// WeChat's editor-integrity check can raise a "浏览器插件存在安全隐患" modal. It is a
// blocking overlay, so any later click (cover picker, save) would land on its mask.
// Dismiss it via its own 我知道了 button rather than removing the node, so the
// editor's own teardown runs.
async function dismissPluginWarning(page) {
    return page.evaluate(`(() => {
        var closed = 0;
        document.querySelectorAll('.weui-desktop-dialog__wrp, .weui-desktop-dialog').forEach(function(dialog) {
            if ((dialog.innerText || '').indexOf('\\u5b89\\u5168\\u9690\\u60a3') < 0) return;
            var wrap = dialog.closest('.weui-desktop-dialog__wrp') || dialog;
            if (window.getComputedStyle(wrap).display === 'none' || wrap.offsetHeight <= 0) return;
            var buttons = wrap.querySelectorAll('button, a, .weui-desktop-btn');
            for (var i = 0; i < buttons.length; i++) {
                if ((buttons[i].textContent || '').trim() === '\\u6211\\u77e5\\u9053\\u4e86') {
                    buttons[i].click();
                    closed++;
                    return;
                }
            }
        });
        return { closed: closed };
    })()`);
}

async function fillContent(page, text) {
    var result = await page.evaluate(`(() => {
        var normalize = value => String(value ?? '').replace(/\\r\\n?/g, '\\n').trim();
        var expected = normalize(${JSON.stringify(text)});
        var instances = window.UE && window.UE.instants ? Object.values(window.UE.instants) : [];
        var ueditor = instances.find(instance => instance
            && typeof instance.setContent === 'function'
            && typeof instance.getContentTxt === 'function');
        if (ueditor && typeof ueditor.setContent === 'function' && typeof ueditor.getContentTxt === 'function') {
            ueditor.setContent(${JSON.stringify(text)});
            var ueditorActual = normalize(ueditor.getContentTxt());
            if (ueditorActual === expected) {
                return { ok: true, value: ueditorActual };
            }
        }
        // The editor is a rich-text framework (ProseMirror) that owns its DOM, so
        // only tag it here. Do NOT clear innerHTML, build a Range, or send a
        // select-all chord: WeChat's editor-integrity check reads those as plugin
        // tampering and shows a blocking "当前使用的浏览器插件存在安全隐患" modal.
        // Once that mask is up every click lands on it and no text is ever typed.
        // page.typeText() drives the editor through CDP DOM.focus + Input.insertText,
        // which the editor accepts as genuine input.
        var editors = document.querySelectorAll('div[contenteditable="true"]');
        var editor = editors[editors.length - 1];
        if (!editor) return { ok: false, reason: 'content editor not found' };
        document.querySelectorAll('[data-bycli-content-target]').forEach(element => {
            element.removeAttribute('data-bycli-content-target');
        });
        editor.setAttribute('data-bycli-content-target', 'true');
        return { ok: false, nativeTargetFocused: true };
    })()`);

    if (!result?.nativeTargetFocused) return result;

    const editorTarget = 'div[contenteditable="true"][data-bycli-content-target="true"]';
    if (typeof page.focusWindow === 'function') {
        try { await page.focusWindow(); } catch { /* focus is best-effort */ }
    }

    if (typeof page.typeText !== 'function') {
        return { ok: false, reason: 'page.typeText is unavailable for content entry' };
    }
    try {
        await page.typeText(editorTarget, text);
    } catch (err) {
        return { ok: false, reason: `content typing failed: ${String(err).slice(0, 120)}` };
    }
    await page.wait(1);
    await dismissPluginWarning(page);

    return page.evaluate(`(() => {
        // The editor renders paragraph breaks as its own block structure, so its
        // innerText carries extra blank lines the source text does not have.
        // Compare on collapsed whitespace instead of exact line breaks.
        var normalize = value => String(value ?? '')
            .replace(/\\r\\n?/g, '\\n')
            .replace(/[\\s\\u00a0\\u200b]+/g, ' ')
            .trim();
        var expected = normalize(${JSON.stringify(text)});
        var editor = document.querySelector('${editorTarget}');
        if (!editor) return { ok: false, reason: 'content editor not found' };
        var actual = normalize(editor.innerText ?? editor.textContent ?? '');
        return actual === expected
            ? { ok: true, value: actual }
            : { ok: false, reason: 'editor content verification failed', value: actual };
    })()`);
}

function requirePageResult(result, label) {
    if (!result?.ok) {
        throw new CommandExecutionError(`Failed to fill ${label}: ${result?.reason ?? 'unverified page state'}`);
    }
}

async function uploadContentImage(page, imagePath) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const absPath = path.default.resolve(imagePath);
    if (!fs.default.existsSync(absPath)) {
        throw new CommandExecutionError(`Image not found: ${absPath}`);
    }
    if (!page.setFileInput) {
        throw new CommandExecutionError('Image upload requires Browser Bridge with CDP support');
    }

    await page.evaluate(`(() => {
        var li = document.querySelector('#js_editor_insertimage');
        if (li) li.click();
    })()`);
    await page.wait(1);
    await page.evaluate(`(() => {
        var items = document.querySelectorAll('.js_img_dropdown_menu .tpl_dropdown_menu_item');
        if (items[0]) items[0].click();
    })()`);
    await page.wait(1);

    await page.setFileInput([absPath], 'input[type="file"][name="file"]');

    for (let attempt = 0; attempt < 15; attempt++) {
        await page.wait(1);
        const uploaded = await page.evaluate(`(() => {
            var editors = document.querySelectorAll('#ueditor_0, div[contenteditable="true"]');
            var sources = [];
            editors.forEach(function(editor) {
                editor.querySelectorAll('img[src*=".qpic.cn"], img[data-src*=".qpic.cn"]').forEach(function(image) {
                    var src = image.getAttribute('src') || image.getAttribute('data-src') || '';
                    if (src && !sources.includes(src)) sources.push(src);
                });
            });
            return sources;
        })()`);
        if (Array.isArray(uploaded) && uploaded.length > 0) return uploaded[uploaded.length - 1];
        if (typeof uploaded === 'string' && uploaded) return uploaded;
        if (typeof uploaded === 'number' && uploaded > 0) return true;
    }
    throw new CommandExecutionError('Image did not upload to WeChat CDN');
}

async function removeTemporaryInsertedImage(page) {
    if (typeof page.nativeKeyPress !== 'function') return;
    await page.nativeKeyPress('Backspace', []);
    await page.nativeKeyPress('Backspace', []);
    if (typeof page.wait === 'function') await page.wait(1);
}

async function selectCoverFromContent(page) {
    await page.evaluate('document.querySelector("#js_cover_description_area")?.scrollIntoView()');
    await page.wait(1);

    await page.evaluate('document.querySelector(".js_cover_btn_area")?.click()');
    await page.wait(1);

    await page.evaluate(`(() => {
        var links = document.querySelectorAll('a.pop-opr__button');
        for (var i = 0; i < links.length; i++) {
            if (links[i].textContent.trim() === '从正文选择') { links[i].click(); return; }
        }
    })()`);
    await page.wait(2);

    await page.evaluate(`(() => {
        var img = document.querySelector('.weui-desktop-dialog_img-picker .appmsg_content_img');
        if (img) img.click();
    })()`);
    await page.wait(1);

    await page.evaluate(`(() => {
        var btns = document.querySelectorAll('.weui-desktop-dialog_img-picker button');
        for (var i = 0; i < btns.length; i++) {
            if (btns[i].textContent.trim() === '下一步' && !btns[i].disabled) { btns[i].click(); return; }
        }
    })()`);

    // Crop dialog image rendering can be slow
    for (let attempt = 0; attempt < 8; attempt++) {
        await page.wait(2);
        const ready = await page.evaluate(`(() => {
            var btns = document.querySelectorAll('button');
            for (var i = 0; i < btns.length; i++) {
                if (btns[i].textContent.trim() === '确认' && btns[i].offsetHeight > 0 && !btns[i].disabled) return true;
            }
            return false;
        })()`);
        if (ready) break;
    }

    await page.evaluate(`(() => {
        var btns = document.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) {
            if (btns[i].textContent.trim() === '确认' && btns[i].offsetHeight > 0 && !btns[i].disabled) { btns[i].click(); return; }
        }
    })()`);
    for (let attempt = 0; attempt < 15; attempt++) {
        await page.wait(1);
        const hasCover = await page.evaluate(`(() => {
            var areas = document.querySelectorAll('#js_cover_area, #js_cover_description_area, #appmsgItem');
            var found = false;
            areas.forEach(function(area) {
                if (area.querySelector('img[src*=".qpic.cn"], img[data-src*=".qpic.cn"]')) found = true;
                [area].concat(Array.from(area.querySelectorAll('*'))).forEach(function(el) {
                    var bg = window.getComputedStyle(el).backgroundImage;
                    if (bg && bg.includes('.qpic.cn')) found = true;
                });
            });
            return found;
        })()`);
        if (hasCover) return true;
    }
    return false;
}

async function clickSaveDraft(page) {
    const result = await page.evaluate(`(() => {
        var btns = document.querySelectorAll('span, button, a');
        for (var i = 0; i < btns.length; i++) {
            if ((btns[i].textContent || '').trim() === '保存为草稿') { btns[i].click(); return { ok: true }; }
        }
        return { ok: false };
    })()`);
    if (!result?.ok) throw new CommandExecutionError('Save draft button not found');

    for (let attempt = 0; attempt < 5; attempt++) {
        await page.wait(2);
        const saved = await page.evaluate(`(() => {
            var el = document.querySelector('#js_save_success');
            if (el && window.getComputedStyle(el).display !== 'none') return true;
            return document.body.innerText.includes('已保存');
        })()`);
        if (saved) return true;
    }
    throw new CommandExecutionError('Draft save could not be confirmed');
}

export const createDraftCommand = cli({
    site: 'weixin',
    name: 'create-draft',
    access: 'write',
    description: '创建微信公众号草稿（支持浏览器富文本或官方 API）',
    example: 'bycli weixin create-draft --title "文章标题" --content-file article.html --content-format html --cover-image cover.jpg',
    domain: WEIXIN_DOMAIN,
    strategy: Strategy.COOKIE,
    browser: requiresBrowser,
    navigateBefore: false,
    args: [
        { name: 'title', required: true, help: '文章标题（最长 64 字）' },
        { name: 'content', required: false, positional: true, help: '正文文本；也可用 --content-file 读取 HTML 文件' },
        { name: 'content-file', help: '正文文件路径；HTML 模式支持本地图片' },
        { name: 'content-format', choices: ['text', 'html', 'html-text'], default: 'text', help: '正文格式：text=纯文本，html=富文本，html-text=保留段落但忽略样式' },
        { name: 'author', help: '作者名（最长 8 字）' },
        { name: 'cover-image', help: '封面图路径；API 模式必填，浏览器模式会上传后设为封面' },
        { name: 'summary', help: '文章摘要；API 模式对应 digest' },
        { name: 'appid', help: '公众号 AppID；与 --appsecret 同传时走官方 API，不打开浏览器' },
        { name: 'appsecret', help: '公众号 AppSecret；请勿提交到 shell 历史或日志' },
        { name: 'dry-run', type: 'boolean', default: false, help: '浏览器模式：填充并验证正文后停止，不会保存草稿' },
        { name: 'allow-private-image-hosts', type: 'boolean', default: false, help: '允许下载 localhost/内网 HTTP(S) 正文图片；云元数据地址始终禁止' },
        { name: 'timeout', type: 'int', required: false, default: 180, help: '命令总超时时间（秒，默认 180）' },
    ],
    columns: ['status', 'detail'],

    func: async (page, kwargs) => {
        const args = normalizeCreateDraftArgs(kwargs);
        if (!args.dryRun && args.appid && args.appsecret) {
            const baseDir = args.filePath ? nodePath.dirname(args.filePath) : process.cwd();
            const result = await createDraftViaApi({
                appid: args.appid,
                appsecret: args.appsecret,
                title: args.title,
                author: args.author ?? '',
                digest: args.summary ?? '',
                coverImage: args.coverImage,
                html: args.content,
                baseDir,
                allowPrivateImageHosts: args.allowPrivateImageHosts,
            });
            return [{
                status: 'draft created',
                detail: `"${args.title}" (media_id: ${result.mediaId})`,
            }];
        }
        const baseDir = args.filePath ? nodePath.dirname(args.filePath) : process.cwd();
        const staged = args.format === 'html'
            ? await stageDraftHtmlImages(args.content, {
                baseDir,
                allowPrivateHosts: args.allowPrivateImageHosts,
            })
            : null;
        try {
            await navigateToEditor(page);


            const titleResult = await fillField(page, 'textarea#title', args.title);
            requirePageResult(titleResult, 'title');

            if (args.author) {
                const authorResult = await fillField(page, 'input#author', args.author);
                requirePageResult(authorResult, 'author');
            }

            await page.wait(10);

            const content = staged?.html ?? args.content;
            if (args.format === 'html') {
                const prepared = await prepareHtmlContent(content, {
                    baseDir,
                    allowRemoteImages: false,
                    resolveImage: async imagePath => {
                        const uploaded = await uploadContentImage(page, imagePath);
                        await removeTemporaryInsertedImage(page);
                        return uploaded;
                    },
                });
                await pasteHtmlThroughClipboard(page, prepared.html, { origin: `https://${WEIXIN_DOMAIN}` });
            } else {
                const contentResult = await fillContent(page, content);
                requirePageResult(contentResult, 'content');
            }

            if (args.dryRun) {
                return [{
                    status: 'draft ready',
                    detail: `"${args.title}" (dry-run)`,
                }];
            }

            if (args.coverImage) {
                await uploadContentImage(page, args.coverImage);
                const coverSet = await selectCoverFromContent(page);
                if (!coverSet) {
                    throw new CommandExecutionError('Failed to set the requested cover image');
                }
            }

            if (args.summary) {
                const summaryResult = await fillField(page, 'textarea#js_description', args.summary);
                requirePageResult(summaryResult, 'summary');
            }

            await page.wait(1);
            await clickSaveDraft(page);

            return [{
                status: 'draft saved',
                detail: `"${args.title}"${args.author ? ` by ${args.author}` : ''}${args.coverImage ? ' (with cover)' : ''}`,
            }];
        } finally {
            await staged?.cleanup();
        }
    },
});
