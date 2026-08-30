import * as nodePath from 'node:path';
import { access, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { ArgumentError, CommandExecutionError } from '@sovovs/bycli/errors';
import { downloadRemoteImage } from './remote-image.js';
import { getAccessToken, readJsonResponse, uploadImage } from './api-draft.js';

const API_BASE = 'https://api.weixin.qq.com/cgi-bin';
const MIN_IMAGES = 1;
const MAX_IMAGES = 20;
const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

function isRemoteImageSource(source) {
  return /^https?:\/\//iu.test(String(source || ''));
}

function validateImageCount(images) {
  if (!Array.isArray(images) || images.length < MIN_IMAGES || images.length > MAX_IMAGES) {
    throw new ArgumentError('newspic requires 1–20 images');
  }
}

async function resolveLocalImage(source, baseDir) {
  const imagePath = nodePath.resolve(baseDir, source);
  if (!SUPPORTED_IMAGE_EXTENSIONS.has(nodePath.extname(imagePath).toLowerCase())) {
    throw new ArgumentError(`newspic image must be a jpg, jpeg, png, gif, or webp file: ${source}`);
  }
  try {
    await access(imagePath, fsConstants.R_OK);
    const info = await stat(imagePath);
    if (!info.isFile() || info.size <= 0) throw new Error('not a non-empty file');
  } catch {
    throw new ArgumentError(`newspic image must be a readable non-empty file: ${imagePath}`);
  }
  return imagePath;
}

export async function stageNewspicImages(images, {
  baseDir = process.cwd(),
  allowPrivateHosts = false,
  fetchImpl = globalThis.fetch,
  lookupImpl,
  downloadImpl = downloadRemoteImage,
} = {}) {
  validateImageCount(images);
  const downloads = [];
  const paths = [];
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    const results = await Promise.allSettled(downloads.map(download => download.cleanup()));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) {
      throw new CommandExecutionError(`Failed to clean up a temporary Weixin image: ${failure.reason?.message ?? failure.reason}`);
    }
  };
  try {
    for (const rawSource of images) {
      const source = String(rawSource ?? '').trim();
      if (!source) throw new ArgumentError('newspic image source must not be empty');
      if (isRemoteImageSource(source)) {
        const downloaded = await downloadImpl(source, {
          allowPrivateHosts,
          fetchImpl,
          ...(lookupImpl ? { lookupImpl } : {}),
        });
        downloads.push(downloaded);
        paths.push(downloaded.path);
      } else {
        paths.push(await resolveLocalImage(source, baseDir));
      }
    }
    return { paths, cleanup };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new CommandExecutionError(`${error?.message ?? error}; ${cleanupError.message}`);
    }
    throw error;
  }
}

async function deleteMaterial(mediaId, token, fetchImpl) {
  const url = new URL(`${API_BASE}/material/del_material`);
  url.searchParams.set('access_token', token);
  const response = await fetchImpl(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ media_id: mediaId }),
  });
  await readJsonResponse(response, '删除图片素材');
}

export async function createNewspicDraftViaApi({
  appid,
  appsecret,
  title,
  content = '',
  images,
  baseDir = process.cwd(),
  fetchImpl = globalThis.fetch,
  imageFetchImpl = globalThis.fetch,
  lookupImpl,
  downloadImpl = downloadRemoteImage,
  allowPrivateImageHosts = false,
} = {}) {
  if (!String(appid ?? '').trim() || !String(appsecret ?? '').trim()) {
    throw new CommandExecutionError('newspic API requires both appid and appsecret');
  }
  if (typeof fetchImpl !== 'function') throw new CommandExecutionError('newspic API requires fetch support');
  validateImageCount(images);

  const staged = await stageNewspicImages(images, {
    baseDir,
    allowPrivateHosts: allowPrivateImageHosts,
    fetchImpl: imageFetchImpl,
    downloadImpl,
    ...(lookupImpl ? { lookupImpl } : {}),
  });
  let token;
  const imageMediaIds = [];
  let draftResult;
  try {
    token = await getAccessToken(String(appid).trim(), String(appsecret).trim(), fetchImpl);
    for (const imagePath of staged.paths) {
      const uploaded = await uploadImage(imagePath, token, fetchImpl);
      imageMediaIds.push(uploaded.media_id);
    }

    const url = new URL(`${API_BASE}/draft/add`);
    url.searchParams.set('access_token', token);
    const body = {
      articles: [{
        article_type: 'newspic',
        title: String(title ?? ''),
        content: String(content ?? ''),
        need_open_comment: 0,
        only_fans_can_comment: 0,
        image_info: {
          image_list: imageMediaIds.map(imageMediaId => ({ image_media_id: imageMediaId })),
        },
      }],
    };
    const response = await fetchImpl(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
    const payload = await readJsonResponse(response, '创建贴图草稿');
    if (!payload.media_id) throw new CommandExecutionError('创建贴图草稿 failed: response did not contain media_id');
    draftResult = { mediaId: payload.media_id, imageMediaIds };
  } catch (error) {
    const cleanupProblems = [];
    if (token && imageMediaIds.length > 0) {
      const results = await Promise.allSettled(imageMediaIds.map(mediaId => deleteMaterial(mediaId, token, fetchImpl)));
      const failedMediaIds = imageMediaIds.filter((_mediaId, index) => results[index].status === 'rejected');
      if (failedMediaIds.length > 0) {
        cleanupProblems.push(`failed to delete permanent materials: ${failedMediaIds.join(', ')}`);
      }
    }
    try {
      await staged.cleanup();
    } catch (cleanupError) {
      cleanupProblems.push(cleanupError.message);
    }
    if (cleanupProblems.length > 0) {
      throw new CommandExecutionError(`${error?.message ?? error}; cleanup incomplete: ${cleanupProblems.join('; ')}`);
    }
    throw error;
  }

  try {
    await staged.cleanup();
  } catch (cleanupError) {
    return { ...draftResult, cleanupWarning: cleanupError.message };
  }
  return draftResult;
}
