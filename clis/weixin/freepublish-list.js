import { ArgumentError, EmptyResultError } from '@sovovs/bycli/errors';
import { cli, Strategy } from '@sovovs/bycli/registry';
import {
  batchGetFreepublish, materializeFreepublishRows, normalizeFreepublishPayload,
  readOfficialApiCredentials, resolveOfficialApiAccessToken,
} from './_wechat/api-freepublish.js';

export const FREEPUBLISH_COLUMNS = [
  'article_id', 'article_index', 'article_type', 'title', 'author', 'digest',
  'published_url', 'thumb_media_id', 'updated_at', 'content_html',
  'artifact_paths_json', 'image_info_json',
];

export const OFFICIAL_API_ARGS = [
  { name: 'appid', help: 'WeChat Official Account AppID; falls back to WECHAT_APPID' },
  { name: 'appsecret', help: 'WeChat AppSecret; prefer WECHAT_APPSECRET to avoid shell history' },
  { name: 'access-token', help: 'Existing API token; falls back to WECHAT_ACCESS_TOKEN' },
];

function contentMode(value, fallback) {
  const mode = String(value ?? fallback);
  if (!['none', 'inline', 'file'].includes(mode)) throw new ArgumentError('content must be none, inline, or file');
  return mode;
}

export const freepublishListCommand = cli({
  site: 'weixin', name: 'freepublish-list', access: 'read', domain: 'api.weixin.qq.com',
  description: 'List published Weixin articles through the official freepublish API',
  strategy: Strategy.LOCAL, browser: false,
  args: [
    { name: 'offset', type: 'int', default: 0, help: 'Zero-based published-material offset' },
    { name: 'count', type: 'int', default: 20, help: 'Number of published materials to return (1–20)' },
    { name: 'content', default: 'none', choices: ['none', 'inline', 'file'], help: 'HTML handling: omit, return inline, or save files' },
    { name: 'output', default: './weixin-published', help: 'Artifact directory when --content file is used' },
    ...OFFICIAL_API_ARGS,
  ],
  columns: FREEPUBLISH_COLUMNS,
  func: async args => {
    const offset = args.offset ?? 0;
    const count = args.count ?? 20;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new ArgumentError('offset must be a non-negative safe integer');
    if (!Number.isSafeInteger(count) || count < 1 || count > 20) throw new ArgumentError('count must be an integer from 1 to 20');
    const mode = contentMode(args.content, 'none');
    const credentials = readOfficialApiCredentials(args);
    const accessToken = await resolveOfficialApiAccessToken(credentials);
    const payload = await batchGetFreepublish({ accessToken, offset, count, noContent: mode === 'none' ? 1 : 0 });
    const rows = normalizeFreepublishPayload(payload);
    if (rows.length === 0) throw new EmptyResultError('weixin freepublish-list', 'No published articles were returned by the official API.');
    return materializeFreepublishRows(rows, { contentMode: mode, output: args.output });
  },
});

export { contentMode };
