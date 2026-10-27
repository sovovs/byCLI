import { describe, it, expect, vi } from 'vitest';
const { download } = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock('@sovovs/bycli/download', () => ({ checkYtdlp: () => true, ytdlpDownload: download }));
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
import { makeVideoDownloadCommand, normalizeVideoDownloadUrl } from './video-download.js';

describe('video download channels', () => {
    it.each([
        ['youtube', 'https://youtu.be/BaW_jenozKc?t=1', 'BaW_jenozKc'],
        ['youtube', 'https://www.youtube.com/shorts/BaW_jenozKc', 'BaW_jenozKc'],
        ['youtube', 'BaW_jenozKc', 'BaW_jenozKc'],
        ['tiktok', 'https://www.tiktok.com/@user/video/123456?lang=en', '123456'],
        ['tiktok', 'https://vm.tiktok.com/Zshort/', 'Zshort'],
        ['tiktok', 'https://vt.tiktok.com/Zshort/', 'Zshort'],
    ])('normalizes %s video input %s', (site, url, id) => {
        expect(normalizeVideoDownloadUrl(site, url).id).toBe(id);
    });
    it.each([
        ['youtube', 'https://evil.test/watch?v=BaW_jenozKc'],
        ['youtube', 'https://youtube.com.evil.test/watch?v=BaW_jenozKc'],
        ['youtube', 'https://www.youtube.com/playlist?list=abc'],
        ['youtube', 'https://www.youtube.com/watch?v=bad'],
        ['tiktok', 'https://www.douyin.com/video/123'],
        ['tiktok', 'https://www.tiktok.com/@user/live'],
        ['tiktok', 'http://vm.tiktok.com/Zshort/'],
        ['tiktok', 'https://vm.tiktok.com:444/Zshort/'],
    ])('rejects unsupported %s URL %s', (site, url) => {
        expect(() => normalizeVideoDownloadUrl(site, url)).toThrow();
    });
    it.each(['youtube', 'tiktok'])('registers a browser-free %s downloader and reports actual artifacts', async site => {
        const cmd = makeVideoDownloadCommand(site);
        expect(cmd.browser).toBe(false); expect(cmd.access).toBe('read');
        download.mockResolvedValueOnce({ success: true, path: '/tmp/completed.mp4', size: 100 });
        const url = site === 'youtube' ? 'BaW_jenozKc' : 'https://www.tiktok.com/@user/video/123';
        const rows = await cmd.func({ url, quality: '720p', timeout: 90 });
        expect(rows[0]).toMatchObject({ status: 'success', path: '/tmp/completed.mp4', bytes: 100 });
        expect(download).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), expect.objectContaining({
            timeout: 90000, cookiesFromBrowser: false, expectedMedia: 'mp4',
            format: expect.stringContaining('[height<=720]'),
        }));
    });
    it('passes explicit cookie selection and fails loudly when the download fails', async () => {
        download.mockResolvedValueOnce({ success: false, error: 'HTTP 403' });
        await expect(makeVideoDownloadCommand('youtube').func({ url: 'BaW_jenozKc', 'cookies-from-browser': 'chrome' })).rejects.toThrow('HTTP 403');
        expect(download.mock.lastCall[2].cookiesFromBrowser).toBe('chrome');
    });
    it.each([0, -1, 3601, 1.5, 'bad', true])('rejects invalid timeout %s', async timeout => {
        await expect(makeVideoDownloadCommand('youtube').func({ url: 'BaW_jenozKc', timeout })).rejects.toThrow('timeout');
    });
});
