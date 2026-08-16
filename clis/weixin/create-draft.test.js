import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
