import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthRequiredError } from '@sovovs/bycli/errors';
import { getRegistry } from '@sovovs/bycli/registry';

getRegistry().delete('weixin/create-draft');
await import('./create-draft.js');

const command = getRegistry().get('weixin/create-draft');
let temporaryDirectory;
let validCover;

function navigationTrap() {
    return {
        goto: vi.fn(() => {
            throw new Error('must not navigate');
        }),
    };
}

function scriptedPage(evaluations) {
    const queue = [...evaluations];
    return {
        goto: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockImplementation(async () => queue.shift()),
        setFileInput: vi.fn().mockResolvedValue(undefined),
    };
}

function baseEditorSequence(...afterContent) {
    return [
        '123456',
        true,
        { ok: true, value: 'title' },
        { ok: true, value: 'body' },
        ...afterContent,
    ];
}

describe('weixin create-draft command', () => {
    it('describes the supported publishing modes and content formats', () => {
        const args = Object.fromEntries(command.args.map((arg) => [arg.name, arg]));

        expect(command.description).toContain('官方 API');
        expect(command.example).toContain('--content-format html');
        expect(args.content.help).toContain('--content-file');
        expect(args['content-format'].help).toContain('text=纯文本');
        expect(args.appid.help).toContain('不打开浏览器');
        expect(args['dry-run'].help).toContain('不会保存草稿');
    });

    beforeEach(async () => {
        temporaryDirectory = await mkdtemp(join(tmpdir(), 'bycli-create-draft-'));
        validCover = join(temporaryDirectory, 'cover.png');
        await writeFile(validCover, 'png bytes');
    });

    afterEach(async () => {
        await rm(temporaryDirectory, { recursive: true, force: true });
    });

    afterAll(() => getRegistry().delete('weixin/create-draft'));

    it.each([
        [
            'the backend session token is missing',
            [undefined],
            'Could not extract session token',
        ],
        [
            'the article editor reports an expired session',
            ['123456', false],
            'Article editor did not load',
        ],
    ])('requires authentication when %s', async (_condition, evaluations, message) => {
        const page = scriptedPage(evaluations);

        const error = await command.func(page, {
            title: 'title',
            content: 'body',
        }).catch((caught) => caught);

        expect(error).toBeInstanceOf(AuthRequiredError);
        expect(error).toMatchObject({
            code: 'AUTH_REQUIRED',
            domain: 'mp.weixin.qq.com',
            message: expect.stringContaining(message),
        });
    });

    it('navigates to the editor without injecting stealth patches', async () => {
        const page = scriptedPage(['123456', false]);

        await expect(command.func(page, {
            title: 'title',
            content: 'body',
        })).rejects.toBeInstanceOf(AuthRequiredError);

        expect(page.goto).toHaveBeenNthCalledWith(1, 'https://mp.weixin.qq.com/', { stealth: false });
        expect(page.goto).toHaveBeenNthCalledWith(
            2,
            expect.stringContaining('https://mp.weixin.qq.com/cgi-bin/appmsg'),
            { stealth: false },
        );
    });

    it('uses the official API when both appid and appsecret are supplied', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ access_token: 'token' }) })
            .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ media_id: 'cover-media' }) })
            .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ media_id: 'draft-media' }) });
        vi.stubGlobal('fetch', fetchMock);

        await expect(command.func(navigationTrap(), {
            title: 'title', content: '<p>body</p>',
            appid: 'wx123', appsecret: 'secret', 'cover-image': validCover,
        })).resolves.toEqual([{
            status: 'draft created',
            detail: '"title" (media_id: draft-media)',
        }]);
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('rejects partial API credentials before opening a browser', async () => {
        await expect(command.func(navigationTrap(), {
            title: 'title', content: 'body', appid: 'wx123',
        })).rejects.toMatchObject({ code: 'ARGUMENT' });
    });

    it.each([
        [{ title: '   ', content: 'body' }, 'title'],
        [{ title: 'title', content: '   ' }, 'content'],
        [{ title: '一'.repeat(65), content: 'body' }, '64'],
        [{ title: 'title', content: 'body', author: '一'.repeat(9) }, '8'],
        [{ title: 'title', content: 'body', author: '   ' }, 'author'],
    ])('rejects invalid input before navigation: %j', async (kwargs, message) => {
        const page = navigationTrap();

        await expect(command.func(page, kwargs)).rejects.toMatchObject({
            code: 'ARGUMENT',
            message: expect.stringContaining(message),
        });
        expect(page.goto).not.toHaveBeenCalled();
    });

    it.each([
        ['missing file', async () => join(temporaryDirectory, 'missing.png')],
        ['directory', async () => {
            const directory = join(temporaryDirectory, 'cover-directory.png');
            await mkdir(directory);
            return directory;
        }],
        ['empty file', async () => {
            const file = join(temporaryDirectory, 'empty.png');
            await writeFile(file, '');
            return file;
        }],
        ['unsupported extension', async () => {
            const file = join(temporaryDirectory, 'cover.txt');
            await writeFile(file, 'not an image');
            return file;
        }],
    ])('rejects an invalid cover before navigation: %s', async (_label, arrangeCover) => {
        const page = navigationTrap();
        const cover = await arrangeCover();

        await expect(command.func(page, {
            title: 'title',
            content: 'body',
            'cover-image': cover,
        })).rejects.toMatchObject({ code: 'ARGUMENT' });
        expect(page.goto).not.toHaveBeenCalled();
    });

    it.each([
        ['title', [{ ok: false, reason: 'title value mismatch' }], { title: 'title', content: 'body' }],
        ['author', [{ ok: true }, { ok: false, reason: 'author value mismatch' }], { title: 'title', content: 'body', author: 'Author' }],
        ['content', [{ ok: true }, { ok: false, reason: 'content value mismatch' }], { title: 'title', content: 'body' }],
    ])('fails when the %s field cannot be verified', async (field, fieldResults, kwargs) => {
        const page = scriptedPage(['123456', true, ...fieldResults]);

        await expect(command.func(page, kwargs)).rejects.toMatchObject({
            code: 'COMMAND_EXEC',
            message: expect.stringContaining(field),
        });
    });

    it('fails when the summary field cannot be verified', async () => {
        const page = scriptedPage(baseEditorSequence({ ok: false, reason: 'summary value mismatch' }));

        await expect(command.func(page, {
            title: 'title',
            content: 'body',
            summary: 'summary',
        })).rejects.toMatchObject({
            code: 'COMMAND_EXEC',
            message: expect.stringContaining('summary'),
        });
    });

    it('writes through the registered UEditor instance when the editor is available', async () => {
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn().mockImplementation(async (script) => {
                if (script.includes('window.location.href.match')) return '123456';
                if (script === '!!document.querySelector("textarea#title")') return true;
                if (script.includes("textarea#title")) return { ok: true, value: 'title' };
                if (script.includes('window.UE.instants')) return { ok: true, value: 'body' };
                if (script.includes('div[contenteditable="true"]')) return { ok: false, reason: 'wrong editor selected' };
                if (script.includes('保存为草稿')) return { ok: true };
                return true;
            }),
        };

        await expect(command.func(page, { title: 'title', content: 'body' })).resolves.toEqual([{
            status: 'draft saved',
            detail: '"title"',
        }]);
        expect(page.evaluate).toHaveBeenCalledWith(expect.stringContaining('window.UE.instants'));
    });

    it('always uses the native rich HTML paste path', async () => {
        const html = '<p><strong>Lightfield</strong></p>';
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            cdp: vi.fn().mockResolvedValue({}),
            nativeClick: vi.fn().mockResolvedValue(undefined),
            nativeKeyPress: vi.fn().mockResolvedValue(undefined),
            focusWindow: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn().mockImplementation(async (script) => {
                if (script.includes('window.location.href.match')) return '123456';
                if (script === '!!document.querySelector("textarea#title")') return true;
                if (script.includes("textarea#title")) return { ok: true, value: 'title' };
                if (script.includes('getBoundingClientRect')) return { ok: true, rect: { x: 120, y: 240, width: 600, height: 300 } };
                if (script.includes('navigator.clipboard.write')) return { ok: true };
                if (script.includes('contenteditable')) return { ok: true, html, text: 'Lightfield' };
                if (script.includes('保存为草稿')) return { ok: true };
                return true;
            }),
        };

        await expect(command.func(page, {
            title: 'title', content: html, 'content-format': 'html',
        })).resolves.toEqual([{
            status: 'draft saved',
            detail: '"title"',
        }]);

        const scripts = page.evaluate.mock.calls.map(([script]) => String(script));
        expect(scripts.some(script => script.includes('setContent'))).toBe(false);
        expect(page.nativeKeyPress).toHaveBeenCalledWith('v', ['Meta']);
    });

    it('pastes HTML through the native clipboard when the editor is ProseMirror', async () => {
        const html = '<p><strong>Lightfield</strong></p>';
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            cdp: vi.fn().mockResolvedValue({}),
            nativeKeyPress: vi.fn().mockResolvedValue(undefined),
            nativeClick: vi.fn().mockResolvedValue(undefined),
            focusWindow: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn().mockImplementation(async (script) => {
                if (script.includes('window.location.href.match')) return '123456';
                if (script === '!!document.querySelector("textarea#title")') return true;
                if (script.includes("textarea#title")) return { ok: true, value: 'title' };
                if (script.includes('getBoundingClientRect')) return { ok: true, rect: { x: 120, y: 240, width: 600, height: 300 } };
                if (script.includes('navigator.clipboard.write')) return { ok: true };
                if (script.includes('contenteditable')) return { ok: true, html, text: 'Lightfield' };
                if (script.includes('保存为草稿')) return { ok: true };
                return true;
            }),
        };

        await expect(command.func(page, {
            title: 'title', content: html, 'content-format': 'html',
        })).resolves.toEqual([{
            status: 'draft saved',
            detail: '"title"',
        }]);

        expect(page.nativeKeyPress).toHaveBeenCalledWith('v', ['Meta']);
    });

    it('supports a no-save HTML insertion check for browser verification', async () => {
        const html = '<p><strong>Lightfield</strong></p>';
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            cdp: vi.fn().mockResolvedValue({}),
            nativeKeyPress: vi.fn().mockResolvedValue(undefined),
            nativeClick: vi.fn().mockResolvedValue(undefined),
            focusWindow: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn().mockImplementation(async (script) => {
                if (script.includes('window.location.href.match')) return '123456';
                if (script === '!!document.querySelector("textarea#title")') return true;
                if (script.includes("textarea#title")) return { ok: true, value: 'title' };
                if (script.includes('getBoundingClientRect')) return { ok: true, rect: { x: 120, y: 240, width: 600, height: 300 } };
                if (script.includes('navigator.clipboard.write')) return { ok: true };
                if (script.includes('contenteditable')) return { ok: true, html, text: 'Lightfield' };
                if (script.includes('保存为草稿')) throw new Error('save must not be called in dry-run');
                return true;
            }),
        };

        await expect(command.func(page, {
            title: 'title', content: html, 'content-format': 'html', 'dry-run': true,
        })).resolves.toEqual([{
            status: 'draft ready',
            detail: '"title" (dry-run)',
        }]);
    });

    it('removes the temporary inline image inserted by WeChat before pasting the full HTML', async () => {
        const contentFile = join(temporaryDirectory, 'article.html');
        await writeFile(contentFile, '<p>Before</p><img src="./cover.png"><p>After</p>');
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            cdp: vi.fn().mockResolvedValue({}),
            nativeKeyPress: vi.fn().mockResolvedValue(undefined),
            nativeClick: vi.fn().mockResolvedValue(undefined),
            focusWindow: vi.fn().mockResolvedValue(undefined),
            setFileInput: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn().mockImplementation(async (script) => {
                if (script.includes('window.location.href.match')) return '123456';
                if (script === '!!document.querySelector("textarea#title")') return true;
                if (script.includes("textarea#title")) return { ok: true, value: 'title' };
                if (script.includes('getBoundingClientRect')) return { ok: true, rect: { x: 120, y: 240, width: 600, height: 300 } };
                if (script.includes('#js_editor_insertimage') || script.includes('.js_img_dropdown_menu')) return true;
                if (script.includes("var editors = document.querySelectorAll('#ueditor_0")) return ['https://mmbiz.qpic.cn/uploaded'];
                if (script.includes('navigator.clipboard.write')) return { ok: true };
                if (script.includes('contenteditable')) return { ok: true, html: '<p>Before</p><img src="https://mmbiz.qpic.cn/uploaded"><p>After</p>', text: 'Before After' };
                return true;
            }),
        };

        await expect(command.func(page, {
            title: 'title', 'content-file': contentFile, 'content-format': 'html', 'dry-run': true,
        })).resolves.toEqual([{
            status: 'draft ready',
            detail: '"title" (dry-run)',
        }]);

        expect(page.nativeKeyPress).toHaveBeenCalledTimes(3);
        expect(page.nativeKeyPress).toHaveBeenCalledWith('Backspace', []);
        expect(page.nativeKeyPress).toHaveBeenCalledWith('v', ['Meta']);
    });

    it('accepts HTML from content-file without requiring a positional content argument', async () => {
        const html = '<p><strong>From file</strong></p>';
        const contentFile = join(temporaryDirectory, 'article.html');
        await writeFile(contentFile, html);
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            cdp: vi.fn().mockResolvedValue({}),
            nativeClick: vi.fn().mockResolvedValue(undefined),
            nativeKeyPress: vi.fn().mockResolvedValue(undefined),
            focusWindow: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn().mockImplementation(async (script) => {
                if (script.includes('window.location.href.match')) return '123456';
                if (script === '!!document.querySelector("textarea#title")') return true;
                if (script.includes("textarea#title")) return { ok: true, value: 'title' };
                if (script.includes('getBoundingClientRect')) return { ok: true, rect: { x: 120, y: 240, width: 600, height: 300 } };
                if (script.includes('navigator.clipboard.write')) return { ok: true };
                if (script.includes('contenteditable')) return { ok: true, html, text: 'From file' };
                if (script.includes('保存为草稿')) return { ok: true };
                return true;
            }),
        };

        await expect(command.func(page, {
            title: 'title', 'content-file': contentFile, 'content-format': 'html',
        })).resolves.toEqual([{
            status: 'draft saved',
            detail: '"title"',
        }]);
    });

    it('uses native input for the rich-text editor when no UEditor instance is exposed', async () => {
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            typeText: vi.fn().mockResolvedValue({ match_level: 'exact', matches_n: 1 }),
            evaluate: vi.fn().mockImplementation(async (script) => {
                if (script.includes('window.location.href.match')) return '123456';
                if (script === '!!document.querySelector("textarea#title")') return true;
                if (script.includes("textarea#title")) return { ok: true, value: 'title' };
                if (script.includes("input#author")) return { ok: true, value: 'Author' };
                if (script.includes('nativeTargetFocused')) return { ok: false, nativeTargetFocused: true };
                if (script.includes('editor content verification')) return { ok: true, value: 'body' };
                if (script.includes('安全隐患')) return { closed: 0 };
                if (script.includes('保存为草稿')) return { ok: true };
                return true;
            }),
        };

        await expect(command.func(page, { title: 'title', content: 'body' })).resolves.toEqual([{
            status: 'draft saved',
            detail: '"title"',
        }]);
        expect(page.typeText).toHaveBeenCalledWith(
            'div[contenteditable="true"][data-bycli-content-target="true"]',
            'body'
        );
        const focusScript = page.evaluate.mock.calls
            .map(([script]) => script)
            .find(script => script.includes('nativeTargetFocused'));
        const verificationScript = page.evaluate.mock.calls
            .map(([script]) => script)
            .find(script => script.includes('editor content verification'));
        expect(focusScript).toContain('data-bycli-content-target');
        expect(focusScript).not.toMatch(/\.innerHTML\s*=/);
        expect(focusScript).not.toContain('selectNodeContents');
        expect(verificationScript).toContain('[data-bycli-content-target="true"]');
    });

    it('waits for the editor and metadata fields before entering content', async () => {
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            typeText: vi.fn().mockResolvedValue({ match_level: 'exact', matches_n: 1 }),
            evaluate: vi.fn().mockImplementation(async (script) => {
                if (script.includes('window.location.href.match')) return '123456';
                if (script === '!!document.querySelector("textarea#title")') return true;
                if (script.includes("textarea#title")) return { ok: true, value: 'title' };
                if (script.includes("input#author")) return { ok: true, value: 'Author' };
                if (script.includes('nativeTargetFocused')) return { ok: false, nativeTargetFocused: true };
                if (script.includes('editor content verification')) return { ok: true, value: 'body' };
                if (script.includes('安全隐患')) return { closed: 0 };
                if (script.includes('保存为草稿')) return { ok: true };
                return true;
            }),
        };

        await expect(command.func(page, { title: 'title', author: 'Author', content: 'body' })).resolves.toEqual([{
            status: 'draft saved',
            detail: '"title" by Author',
        }]);

        const editorTarget = 'div[contenteditable="true"][data-bycli-content-target="true"]';
        expect(page.typeText).toHaveBeenCalledWith(editorTarget, 'body');
        expect(page.wait.mock.calls.filter(([seconds]) => seconds === 10)).toHaveLength(2);
    });

    it('enters long rich-text content in bounded native-input chunks', async () => {
        const content = 'a'.repeat(801);
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            typeText: vi.fn().mockResolvedValue({ match_level: 'exact', matches_n: 1 }),
            evaluate: vi.fn().mockImplementation(async (script) => {
                if (script.includes('window.location.href.match')) return '123456';
                if (script === '!!document.querySelector("textarea#title")') return true;
                if (script.includes("textarea#title")) return { ok: true, value: 'title' };
                if (script.includes('nativeTargetFocused')) return { ok: false, nativeTargetFocused: true };
                if (script.includes('editor content verification')) return { ok: true, value: content };
                if (script.includes('安全隐患')) return { closed: 0 };
                if (script.includes('保存为草稿')) return { ok: true };
                return true;
            }),
        };

        await expect(command.func(page, { title: 'title', content })).resolves.toEqual([{
            status: 'draft saved',
            detail: '"title"',
        }]);

        expect(page.typeText).toHaveBeenCalledWith(
            'div[contenteditable="true"][data-bycli-content-target="true"]',
            content
        );
    });

    it('fails when the requested cover cannot be selected', async () => {
        const page = scriptedPage(baseEditorSequence(
            undefined,
            undefined,
            1,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            true,
            undefined,
            false,
        ));

        await expect(command.func(page, {
            title: 'title',
            content: 'body',
            'cover-image': validCover,
        })).rejects.toMatchObject({
            code: 'COMMAND_EXEC',
            message: expect.stringContaining('cover'),
        });
    });

    it('waits for an uploaded image to appear in the editor before selecting the cover', async () => {
        const page = scriptedPage(baseEditorSequence(
            undefined,
            undefined,
            0,
            0,
            1,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            true,
            undefined,
            true,
            { ok: true },
            true,
        ));

        await expect(command.func(page, {
            title: 'title',
            content: 'body',
            'cover-image': validCover,
        })).resolves.toEqual([{
            status: 'draft saved',
            detail: '"title" (with cover)',
        }]);
    });

    it('waits for the cropped cover to appear after the crop request', async () => {
        const page = scriptedPage(baseEditorSequence(
            undefined, undefined, 1,
            undefined, undefined, undefined, undefined, undefined,
            true, undefined,
            false, false, true,
            { ok: true }, true,
        ));

        await expect(command.func(page, {
            title: 'title', content: 'body', 'cover-image': validCover,
        })).resolves.toEqual([{
            status: 'draft saved', detail: '"title" (with cover)',
        }]);
    });

    it('fails when draft saving cannot be confirmed', async () => {
        const page = scriptedPage(baseEditorSequence(
            { ok: true },
            false,
            false,
            false,
            false,
            false,
        ));

        await expect(command.func(page, {
            title: 'title',
            content: 'body',
        })).rejects.toMatchObject({
            code: 'COMMAND_EXEC',
            message: expect.stringContaining('confirm'),
        });
    });

    it('returns draft saved only after every requested step is confirmed', async () => {
        const page = scriptedPage([
            '123456',
            true,
            { ok: true, value: 'Verified draft' },
            { ok: true, value: 'Author' },
            { ok: true, value: 'body' },
            undefined,
            undefined,
            1,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            true,
            undefined,
            true,
            { ok: true, value: 'summary' },
            { ok: true },
            true,
        ]);

        await expect(command.func(page, {
            title: 'Verified draft',
            content: 'body',
            author: 'Author',
            summary: 'summary',
            'cover-image': validCover,
        })).resolves.toEqual([{
            status: 'draft saved',
            detail: '"Verified draft" by Author (with cover)',
        }]);
    });
});
