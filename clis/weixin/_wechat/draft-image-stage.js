import { prepareHtmlContent } from './draft-content.js';
import { downloadRemoteImage } from './remote-image.js';
import { CommandExecutionError } from '@sovovs/bycli/errors';

function isRemoteImageSource(source) {
  return /^https?:\/\//iu.test(String(source || ''));
}

export async function stageDraftHtmlImages(html, {
  baseDir = process.cwd(),
  allowPrivateHosts = false,
  fetchImpl = globalThis.fetch,
  lookupImpl,
  downloadImpl = downloadRemoteImage,
} = {}) {
  const downloads = [];
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    const results = await Promise.allSettled(downloads.map(downloaded => downloaded.cleanup()));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) {
      throw new CommandExecutionError(`Failed to clean up a temporary Weixin image: ${failure.reason?.message ?? failure.reason}`);
    }
  };
  try {
    const prepared = await prepareHtmlContent(html, {
      baseDir,
      allowRemoteImages: true,
      resolveImage: async source => {
        if (!isRemoteImageSource(source)) return source;
        const downloaded = await downloadImpl(source, {
          allowPrivateHosts,
          fetchImpl,
          ...(lookupImpl ? { lookupImpl } : {}),
        });
        downloads.push(downloaded);
        return downloaded.path;
      },
    });
    return { html: prepared.html, cleanup };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new CommandExecutionError(`${error?.message ?? error}; ${cleanupError.message}`);
    }
    throw error;
  }
}
