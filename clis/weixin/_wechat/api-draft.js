import * as nodeFs from 'node:fs/promises';
import * as nodePath from 'node:path';
import { CommandExecutionError } from '@sovovs/bycli/errors';
import { prepareHtmlContent } from './draft-content.js';

const API_BASE = 'https://api.weixin.qq.com/cgi-bin';

function apiError(context, payload) {
  const code = payload?.errcode == null ? 'unknown' : payload.errcode;
  const message = payload?.errmsg || 'unknown error';
  return new CommandExecutionError(`${context} failed (${code}): ${message}`);
}

async function readJsonResponse(response, context) {
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new CommandExecutionError(`${context} returned invalid JSON: ${error?.message ?? error}`);
  }
  if (!response.ok) throw new CommandExecutionError(`${context} returned HTTP ${response.status}`);
  if (payload?.errcode != null && payload.errcode !== 0) throw apiError(context, payload);
  return payload;
}

async function getAccessToken(appid, appsecret, fetchImpl) {
  const url = new URL(`${API_BASE}/token`);
  url.searchParams.set('grant_type', 'client_credential');
  url.searchParams.set('appid', appid);
  url.searchParams.set('secret', appsecret);
  const response = await fetchImpl(url.toString(), { method: 'GET' });
  const payload = await readJsonResponse(response, '获取 access_token');
  if (!payload.access_token) throw new CommandExecutionError('获取 access_token failed: response did not contain access_token');
  return payload.access_token;
}

function mimeType(filePath) {
  const extension = nodePath.extname(filePath).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.webp') return 'image/webp';
  return 'image/jpeg';
}

async function uploadImage(filePath, token, fetchImpl) {
  const data = await nodeFs.readFile(filePath);
  const form = new FormData();
  form.append('media', new Blob([data], { type: mimeType(filePath) }), nodePath.basename(filePath));
  const url = new URL(`${API_BASE}/material/add_material`);
  url.searchParams.set('access_token', token);
  url.searchParams.set('type', 'image');
  const response = await fetchImpl(url.toString(), { method: 'POST', body: form });
  const payload = await readJsonResponse(response, '上传图片');
  if (!payload.media_id) throw new CommandExecutionError('上传图片 failed: response did not contain media_id');
  return payload;
}

function removeCoverImage(html) {
  return String(html ?? '').replace(/<img\b[^>]*(?:alt|title)=["'][^"']*封面[^"']*["'][^>]*>\s*/giu, '');
}

export async function createDraftViaApi({
  appid,
  appsecret,
  title,
  author = '',
  digest = '',
  coverImage,
  html,
  baseDir = process.cwd(),
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!String(appid ?? '').trim() || !String(appsecret ?? '').trim()) {
    throw new CommandExecutionError('API mode requires both appid and appsecret');
  }
  if (typeof fetchImpl !== 'function') throw new CommandExecutionError('API mode requires fetch support');
  if (!coverImage) throw new CommandExecutionError('API mode requires cover-image');

  const token = await getAccessToken(String(appid).trim(), String(appsecret).trim(), fetchImpl);
  const cover = await uploadImage(nodePath.resolve(coverImage), token, fetchImpl);
  const prepared = await prepareHtmlContent(removeCoverImage(html), {
    baseDir,
    resolveImage: async imagePath => {
      const uploaded = await uploadImage(imagePath, token, fetchImpl);
      return uploaded.url || uploaded.media_id;
    },
  });

  const url = new URL(`${API_BASE}/draft/add`);
  url.searchParams.set('access_token', token);
  const body = {
    articles: [{
      title: String(title ?? ''),
      author: String(author ?? ''),
      digest: String(digest || title || ''),
      content: prepared.html,
      content_source_url: '',
      thumb_media_id: cover.media_id,
      show_cover_pic: 1,
      need_open_comment: 0,
      only_fans_can_comment: 0,
    }],
  };
  const response = await fetchImpl(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  const payload = await readJsonResponse(response, '创建草稿');
  if (!payload.media_id) throw new CommandExecutionError('创建草稿 failed: response did not contain media_id');
  return { mediaId: payload.media_id };
}

export { removeCoverImage };
