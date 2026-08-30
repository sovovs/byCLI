import { ArgumentError, CommandExecutionError } from '@sovovs/bycli/errors';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { getAccessToken } from './api-draft.js';

const API_BASE = 'https://api.weixin.qq.com/cgi-bin/freepublish';

export class WechatOfficialApiError extends CommandExecutionError {
  constructor(context, errcode, errmsg) {
    super(`${context} failed (${String(errcode)}): ${String(errmsg || 'unknown error')}`);
    this.wechatErrcode = errcode;
  }
}

function text(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

export function readOfficialApiCredentials(args = {}, env = process.env) {
  const accessToken = text(args['access-token']) ?? text(env.WECHAT_ACCESS_TOKEN);
  if (accessToken) return { accessToken, appid: null, appsecret: null, configured: true };
  const explicitAppid = text(args.appid);
  const explicitSecret = text(args.appsecret);
  const usesExplicitPair = Boolean(explicitAppid || explicitSecret);
  const appid = usesExplicitPair ? explicitAppid : text(env.WECHAT_APPID);
  const appsecret = usesExplicitPair ? explicitSecret : text(env.WECHAT_APPSECRET);
  if (Boolean(appid) !== Boolean(appsecret)) {
    throw new ArgumentError('appid and appsecret must be provided together');
  }
  return {
    accessToken: null, appid, appsecret, configured: Boolean(appid && appsecret),
  };
}

export async function resolveOfficialApiAccessToken(credentials, fetchImpl = globalThis.fetch) {
  if (credentials?.accessToken) return credentials.accessToken;
  if (!credentials?.appid || !credentials?.appsecret) {
    throw new ArgumentError('Official Weixin API requires WECHAT_ACCESS_TOKEN or an AppID/AppSecret pair');
  }
  try {
    return await getAccessToken(credentials.appid, credentials.appsecret, fetchImpl);
  } catch (error) {
    const secret = String(credentials.appsecret);
    let message = error instanceof Error ? error.message : String(error);
    for (const value of [secret, encodeURIComponent(secret)]) message = message.replaceAll(value, '[REDACTED]');
    message = message.replace(/([?&]secret=)[^&\s]*/giu, '$1[REDACTED]');
    throw new CommandExecutionError(message);
  }
}

async function postJson(path, accessToken, body, fetchImpl) {
  if (typeof fetchImpl !== 'function') throw new CommandExecutionError('Official Weixin API requires fetch support');
  const url = new URL(`${API_BASE}/${path}`);
  url.searchParams.set('access_token', accessToken);
  let response;
  try {
    response = await fetchImpl(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new CommandExecutionError(`Weixin freepublish ${path} request failed`);
  }
  let payload;
  try { payload = await response.json(); } catch { throw new CommandExecutionError(`Weixin freepublish ${path} returned invalid JSON`); }
  if (!response.ok) throw new CommandExecutionError(`Weixin freepublish ${path} returned HTTP ${response.status}`);
  if (payload?.errcode != null && payload.errcode !== 0) {
    throw new WechatOfficialApiError(`Weixin freepublish ${path}`, payload.errcode, payload.errmsg);
  }
  return payload;
}

export function batchGetFreepublish({ accessToken, offset, count, noContent, fetchImpl = globalThis.fetch }) {
  return postJson('batchget', accessToken, { offset, count, no_content: noContent }, fetchImpl);
}

export function getFreepublishArticle({ accessToken, articleId, fetchImpl = globalThis.fetch }) {
  return postJson('getarticle', accessToken, { article_id: articleId }, fetchImpl);
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CommandExecutionError(`Weixin freepublish returned invalid ${label}`);
  }
  return value;
}

function unixIso(value) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new CommandExecutionError('Weixin freepublish returned invalid update_time');
  return new Date(value * 1000).toISOString();
}

function flattenArticle(container, articleId, updateTime) {
  const content = container.content && typeof container.content === 'object' ? container.content : container;
  const items = content.news_item;
  if (!Array.isArray(items)) throw new CommandExecutionError('Weixin freepublish returned invalid news_item');
  return items.map((raw, articleIndex) => {
    const item = record(raw, `news_item[${articleIndex}]`);
    const articleType = text(item.article_type) ?? (item.image_info ? 'newspic' : 'news');
    return {
      article_id: articleId,
      article_index: articleIndex,
      article_type: articleType,
      title: text(item.title),
      author: text(item.author),
      digest: text(item.digest),
      published_url: text(item.url),
      thumb_media_id: text(item.thumb_media_id),
      updated_at: unixIso(updateTime),
      content_html: item.content == null ? null : String(item.content),
      artifact_paths_json: null,
      image_info_json: item.image_info == null ? null : JSON.stringify(item.image_info),
    };
  });
}

export function normalizeFreepublishPayload(payload) {
  const response = record(payload, 'response');
  if (Array.isArray(response.item)) {
    return response.item.flatMap((raw, index) => {
      const item = record(raw, `item[${index}]`);
      const articleId = text(item.article_id);
      if (!articleId) throw new CommandExecutionError('Weixin freepublish returned an item without article_id');
      return flattenArticle(item, articleId, item.update_time);
    });
  }
  const articleId = text(response.article_id);
  if (!articleId) throw new CommandExecutionError('Weixin freepublish returned an article without article_id');
  return flattenArticle(response, articleId, response.update_time);
}

function safeStem(row) {
  const base = String(row.title || row.article_id || 'article')
    .normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '-').replace(/\.{2,}/gu, '-').trim();
  return (base || 'article').slice(0, 80);
}

async function writeUnique(directory, stem, extension, content) {
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const name = `${stem}${suffix === 0 ? '' : `-${suffix}`}.${extension}`;
    const path = join(directory, name);
    try {
      await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
      return path;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new CommandExecutionError('Could not allocate a unique freepublish artifact name');
}

export async function materializeFreepublishRows(rows, { contentMode = 'inline', output = './weixin-published' } = {}) {
  if (!['none', 'inline', 'file'].includes(contentMode)) throw new ArgumentError('content must be none, inline, or file');
  if (contentMode === 'none') return rows.map(row => ({ ...row, content_html: null, artifact_paths_json: null }));
  if (contentMode === 'inline') return rows.map(row => ({ ...row, artifact_paths_json: null }));
  const directory = resolve(output);
  await mkdir(directory, { recursive: true });
  const materialized = [];
  for (const row of rows) {
    const stem = `${safeStem(row)}-${row.article_index + 1}`;
    const html = await writeUnique(directory, stem, 'html', row.content_html ?? '');
    const metadata = await writeUnique(directory, stem, 'json', `${JSON.stringify(row, null, 2)}\n`);
    materialized.push({ ...row, content_html: null, artifact_paths_json: JSON.stringify({ html, metadata }) });
  }
  return materialized;
}
