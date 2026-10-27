import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', async () => ({
  ...await vi.importActual<typeof import('node:child_process')>('node:child_process'), spawn: spawnMock,
}));
vi.mock('../external.js', () => ({ isBinaryInstalled: () => true }));
import { ytdlpDownload } from './index.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-ytdlp-test-')); spawnMock.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

function fakeProcess(run: (proc: any, output: string, args: string[]) => void) {
  spawnMock.mockImplementation((_binary, args: string[]) => {
    const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    queueMicrotask(() => run(proc, args[args.indexOf('-o') + 1], args));
    return proc;
  });
}
function receipt(proc: any, filename: string) { proc.stdout.write(`BYCLI_FILE:${JSON.stringify(filename)}\n`); }
const options = { cookiesFromBrowser: false as const };

describe('yt-dlp completion and deadlines', () => {
  it('rejects nonzero exit even with a receipt, partial file and old destination', async () => {
    const dest = path.join(dir, 'video.mp4');
    fs.writeFileSync(dest, 'old video');
    fs.writeFileSync(dest + '.part', 'old partial');
    fakeProcess((proc, output) => { fs.writeFileSync(output, 'new but failed'); receipt(proc, output); proc.emit('close', 1); });
    expect((await ytdlpDownload('https://example.com', dest, options)).success).toBe(false);
    expect(fs.readFileSync(dest, 'utf8')).toBe('old video');
    expect(fs.readdirSync(dir)).toEqual(['video.mp4', 'video.mp4.part']);
  });

  it.each(['missing', 'empty', 'partial', 'outside'])('rejects a zero-exit %s result', async kind => {
    const dest = path.join(dir, 'video.mp4');
    fs.writeFileSync(dest, 'old');
    fakeProcess((proc, output) => {
      if (kind === 'outside') receipt(proc, dest);
      else if (kind !== 'missing') {
        const filename = kind === 'partial' ? output + '.part' : output;
        fs.writeFileSync(filename, kind === 'empty' ? '' : 'partial'); receipt(proc, filename);
      }
      proc.emit('close', 0);
    });
    expect((await ytdlpDownload('https://example.com', dest, options)).success).toBe(false);
    expect(fs.readFileSync(dest, 'utf8')).toBe('old');
    expect(fs.readdirSync(dir)).toEqual(['video.mp4']);
  });

  it('uses the reported postprocessed extension and returns the actual path', async () => {
    fakeProcess((proc, output, args) => {
      expect(args).not.toContain('--cookies-from-browser');
      expect(args).toContain('--ignore-config');
      expect(args[args.lastIndexOf('-f') + 1]).toBe('bestvideo+bestaudio');
      const actual = output.replace(/\.mp4$/, '.mkv');
      fs.writeFileSync(actual, 'completed');
      // Chunk boundaries need not align with receipt lines.
      const line = `\r[download] 100%\rBYCLI_FILE:${JSON.stringify(actual)}\n`;
      proc.stdout.write(line.slice(0, 9)); proc.stdout.write(line.slice(9)); proc.emit('close', 0);
    });
    const result = await ytdlpDownload('https://example.com', path.join(dir, 'video.mp4'), { ...options, extraArgs: ['-f', 'bestvideo+bestaudio'] });
    expect(result).toEqual({ success: true, size: 9, path: path.join(dir, 'video.mkv') });
    expect(fs.readdirSync(dir)).toEqual(['video.mkv']);
  });

  it('validates MP4 before replacing an existing file', async () => {
    const dest = path.join(dir, 'video.mp4'); fs.writeFileSync(dest, 'old');
    fakeProcess((proc, output) => { fs.writeFileSync(output, '<html>login</html>'); receipt(proc, output); proc.emit('close', 0); });
    expect((await ytdlpDownload('https://example.com', dest, { ...options, expectedMedia: 'mp4' })).success).toBe(false);
    expect(fs.readFileSync(dest, 'utf8')).toBe('old');
  });

  it('kills an unresponsive process after the deadline, removes staging and preserves the old file', async () => {
    const dest = path.join(dir, 'video.mp4'); fs.writeFileSync(dest, 'old');
    let child: any;
    fakeProcess((proc, output) => {
      child = proc; fs.writeFileSync(output + '.part', 'partial');
      proc.kill.mockImplementation((signal: string) => { if (signal === 'SIGKILL') queueMicrotask(() => proc.emit('close', null)); });
    });
    const result = await ytdlpDownload('https://example.com', dest, { ...options, timeout: 20 });
    expect(result).toMatchObject({ success: false, error: 'Download timed out after 20ms' });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM'); expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(fs.readdirSync(dir)).toEqual(['video.mp4']);
    expect(fs.readFileSync(dest, 'utf8')).toBe('old');
  });

  it('signals the whole POSIX process group on timeout', async () => {
    if (process.platform === 'win32') return;
    const groupKill = vi.spyOn(process, 'kill');
    fakeProcess((proc) => {
      proc.pid = 43210;
      groupKill.mockImplementation(() => { queueMicrotask(() => proc.emit('close', null)); return true; });
    });
    const result = await ytdlpDownload('https://example.com', path.join(dir, 'video.mp4'), { ...options, timeout: 20 });
    expect(result.success).toBe(false);
    expect(groupKill).toHaveBeenCalledWith(-43210, 'SIGTERM');
  });

  it('does not silently switch browser sessions when a cookie file is missing', async () => {
    expect(await ytdlpDownload('https://example.com', path.join(dir, 'video.mp4'), { cookiesFile: path.join(dir, 'missing') }))
      .toMatchObject({ success: false, error: 'Cookies file not found' });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
