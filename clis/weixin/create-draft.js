import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';

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

function normalizeCreateDraftArgs(kwargs) {
    const title = requiredText(kwargs.title, 'title');
    requiredText(kwargs.content, 'content');
    if (codePointLength(title) > MAX_TITLE_LENGTH) {
        throw new ArgumentError(`title must be at most ${MAX_TITLE_LENGTH} characters`);
    }
    const author = kwargs.author == null ? null : requiredText(kwargs.author, 'author');
    if (author && codePointLength(author) > MAX_AUTHOR_LENGTH) {
        throw new ArgumentError(`author must be at most ${MAX_AUTHOR_LENGTH} characters`);
    }
    return {
        title,
        content: String(kwargs.content),
        author,
        summary: kwargs.summary == null ? null : String(kwargs.summary).trim(),
        coverImage: validateCoverImage(kwargs['cover-image']),
    };
}

async function getToken(page) {
    return page.evaluate(`(window.location.href.match(/token=(\\d+)/)||[])[1]`);
}

async function navigateToEditor(page) {
    await page.goto(WEIXIN_HOME);
    await page.wait(3);
    const token = await getToken(page);
    if (!token) {
        throw new AuthRequiredError(
            WEIXIN_DOMAIN,
            'Could not extract session token. Please log in to mp.weixin.qq.com',
        );
    }
    await page.goto(`https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77&token=${token}&lang=zh_CN`);
    await page.wait(4);
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

async function fillContent(page, text) {
    return page.evaluate(`(() => {
        var editors = document.querySelectorAll('div[contenteditable="true"]');
        var editor = editors[editors.length - 1];
        if (!editor) return { ok: false, reason: 'content editor not found' };
        editor.focus();
        if (editor.querySelector('[contenteditable="false"]')) editor.innerHTML = '';
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, ${JSON.stringify(text)});
        editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
        var normalize = value => String(value ?? '').replace(/\\r\\n?/g, '\\n').trim();
        var expected = normalize(${JSON.stringify(text)});
        var actual = normalize(editor.innerText ?? editor.textContent ?? '');
        return actual === expected
            ? { ok: true, value: actual }
            : { ok: false, reason: 'value mismatch', value: actual };
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
        const cdnCount = await page.evaluate(`(() => {
            var editors = document.querySelectorAll('#ueditor_0, div[contenteditable="true"]');
            var count = 0;
            editors.forEach(function(editor) {
                count += editor.querySelectorAll('img[src*="mmbiz"], img[data-src*="mmbiz"]').length;
            });
            return count;
        })()`);
        if (cdnCount > 0) return;
    }
    throw new CommandExecutionError('Image did not upload to WeChat CDN');
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
                if (area.querySelector('img[src*="mmbiz"], img[data-src*="mmbiz"]')) found = true;
                [area].concat(Array.from(area.querySelectorAll('*'))).forEach(function(el) {
                    var bg = window.getComputedStyle(el).backgroundImage;
                    if (bg && bg.includes('mmbiz')) found = true;
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
    description: '创建微信公众号图文草稿',
    domain: WEIXIN_DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [
        { name: 'title', required: true, help: '文章标题 (最长64字)' },
        { name: 'content', required: true, positional: true, help: '文章正文' },
        { name: 'author', help: '作者名 (最长8字)' },
        { name: 'cover-image', help: '封面图片路径 (会先上传到正文再设为封面)' },
        { name: 'summary', help: '文章摘要' },
        { name: 'timeout', type: 'int', required: false, default: 180, help: 'Max seconds for the overall command (default: 180)' },
    ],
    columns: ['status', 'detail'],

    func: async (page, kwargs) => {
        const args = normalizeCreateDraftArgs(kwargs);
        await navigateToEditor(page);

        const titleResult = await fillField(page, 'textarea#title', args.title);
        requirePageResult(titleResult, 'title');

        if (args.author) {
            const authorResult = await fillField(page, 'input#author', args.author);
            requirePageResult(authorResult, 'author');
        }

        const contentResult = await fillContent(page, args.content);
        requirePageResult(contentResult, 'content');

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
    },
});
