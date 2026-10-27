import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
const { check, ytdlp, http } = vi.hoisted(() => ({ check: vi.fn(), ytdlp: vi.fn(), http: vi.fn() }));
vi.mock('./index.js', async () => ({
  ...await vi.importActual<typeof import('./index.js')>('./index.js'),
  checkYtdlp: check, ytdlpDownload: ytdlp, httpDownload: http,
}));
import { downloadMedia } from './media-download.js';

beforeEach(() => { check.mockReset(); ytdlp.mockReset(); http.mockReset(); });
describe('media yt-dlp routing', () => {
  it('does not save a webpage via HTTP when yt-dlp is missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-routing-'));
    try {
      check.mockReturnValue(false);
      const [result] = await downloadMedia([{ type: 'video-ytdlp', url: 'https://www.youtube.com/watch?v=abc' }], { output: dir, verbose: false });
      expect(result.status).toBe('failed'); expect(result.size).toContain('yt-dlp not installed');
      expect(http).not.toHaveBeenCalled(); expect(fs.readdirSync(dir)).toEqual([]);
    } finally { fs.rmSync(dir, { force: true, recursive: true }); }
  });
  it('forwards the deadline and exposes the actual postprocessed path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-routing-'));
    try {
      check.mockReturnValue(true); ytdlp.mockResolvedValue({ success: true, size: 20, path: path.join(dir, 'actual.mkv') });
      const [result] = await downloadMedia([{ type: 'video-ytdlp', url: 'https://example.com' }], { output: dir, timeout: 12345, verbose: false });
      expect(ytdlp).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ timeout: 12345 }));
      expect(result).toMatchObject({ path: path.join(dir, 'actual.mkv'), bytes: 20 });
    } finally { fs.rmSync(dir, { force: true, recursive: true }); }
  });
});
