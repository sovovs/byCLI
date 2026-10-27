import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, CommandExecutionError } from '@sovovs/bycli/errors';
import { checkYtdlp, ytdlpDownload } from '@sovovs/bycli/download';

const QUALITIES = ['best', '1080p', '720p', '480p'];
const BROWSERS = ['none', 'chrome', 'chromium', 'firefox', 'edge', 'brave', 'safari'];

export function normalizeVideoDownloadUrl(site, value) {
    const raw = String(value ?? '').trim();
    if (site === 'youtube' && /^[A-Za-z0-9_-]{11}$/.test(raw)) {
        return { id: raw, url: `https://www.youtube.com/watch?v=${raw}` };
    }
    let parsed;
    try { parsed = new URL(raw); } catch { throw new ArgumentError('A valid video URL is required'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) {
        throw new ArgumentError('Use an HTTPS video URL without credentials or a custom port');
    }
    const host = parsed.hostname.toLowerCase();
    if (site === 'youtube') {
        const youtubeHost = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host);
        const id = host === 'youtu.be' ? parsed.pathname.match(/^\/([A-Za-z0-9_-]{11})\/?$/)?.[1]
            : youtubeHost && parsed.pathname === '/watch' ? parsed.searchParams.get('v')
            : youtubeHost ? parsed.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})\/?$/)?.[1] : null;
        if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) throw new ArgumentError('Use a YouTube video URL or an 11-character video ID');
        return { id, url: `https://www.youtube.com/watch?v=${id}` };
    }
    const video = ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com'].includes(host)
        && parsed.pathname.match(/^\/@([A-Za-z0-9._-]+)\/video\/(\d+)\/?$/);
    if (video) return { id: video[2], url: `https://www.tiktok.com/@${video[1]}/video/${video[2]}` };
    const short = ['vm.tiktok.com', 'vt.tiktok.com'].includes(host)
        && parsed.pathname.match(/^\/([A-Za-z0-9_-]+)\/?$/);
    if (short) return { id: short[1], url: `https://${host}/${short[1]}/` };
    throw new ArgumentError('Use a TikTok /@user/video/id URL or vm.tiktok.com / vt.tiktok.com share link');
}

export function makeVideoDownloadCommand(site) {
    return {
        site, name: 'download', access: 'read', strategy: Strategy.PUBLIC, browser: false,
        description: `Download a ${site === 'youtube' ? 'YouTube' : 'TikTok'} video using yt-dlp and ffmpeg`,
        args: [
            { name: 'url', required: true, positional: true, help: 'Video URL (YouTube also accepts a video ID)' },
            { name: 'output', valueRequired: true, default: `./${site}-downloads`, help: 'Output directory' },
            { name: 'quality', valueRequired: true, default: 'best', choices: QUALITIES, help: 'Maximum video height, or best available' },
            { name: 'timeout', valueRequired: true, default: 600, help: 'Total download and postprocessing deadline in seconds (1–3600)' },
            { name: 'cookies-from-browser', valueRequired: true, default: 'none', choices: BROWSERS, help: 'Use local browser cookies when login is required' },
        ],
        columns: ['id', 'url', 'status', 'path', 'bytes'],
        func: async (kwargs) => {
            const { id, url } = normalizeVideoDownloadUrl(site, kwargs.url);
            const quality = kwargs.quality ?? 'best';
            const timeout = Number(kwargs.timeout ?? 600);
            const browser = kwargs['cookies-from-browser'] ?? 'none';
            if (!QUALITIES.includes(quality)) throw new ArgumentError('Unsupported quality');
            if (typeof kwargs.timeout === 'boolean' || !Number.isInteger(timeout) || timeout < 1 || timeout > 3600) throw new ArgumentError('timeout must be an integer from 1 to 3600 seconds');
            if (!BROWSERS.includes(browser)) throw new ArgumentError('Unsupported cookie browser');
            if (typeof kwargs.output !== 'undefined' && (typeof kwargs.output !== 'string' || !kwargs.output.trim())) throw new ArgumentError('output must be a directory');
            if (!checkYtdlp()) throw new CommandExecutionError('yt-dlp is required', 'Install yt-dlp and ffmpeg, then retry');
            for (const binary of ['ffmpeg', 'ffprobe']) {
                try { execFileSync(binary, ['-version'], { stdio: 'ignore', timeout: 5000 }); }
                catch { throw new CommandExecutionError(`${binary} is required`, 'Install ffmpeg, then retry'); }
            }
            const cap = quality === 'best' ? '' : `[height<=${parseInt(quality, 10)}]`;
            const format = `bv*${cap}[ext=mp4]+ba[ext=m4a]/b${cap}[ext=mp4]/bv*${cap}+ba/b${cap}`;
            const destination = path.resolve(kwargs.output ?? `./${site}-downloads`, `${site}_${id}.mp4`);
            const result = await ytdlpDownload(url, destination, {
                format, timeout: timeout * 1000, cookiesFromBrowser: browser === 'none' ? false : browser,
                expectedMedia: 'mp4',
                extraArgs: ['--js-runtimes', 'node', '--merge-output-format', 'mp4', '--remux-video', 'mp4',
                    '--match-filter', '!is_live & !is_upcoming'],
            });
            if (!result.success) throw new CommandExecutionError(`${site} video download failed: ${result.error || 'No completed video'}`);
            return [{ id, url, status: 'success', path: result.path, bytes: result.size }];
        },
    };
}
