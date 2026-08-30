import { ArgumentError } from '@sovovs/bycli/errors';
import { cli, Strategy } from '@sovovs/bycli/registry';
import {
  getFreepublishArticle, materializeFreepublishRows, normalizeFreepublishPayload,
  readOfficialApiCredentials, resolveOfficialApiAccessToken,
} from './_wechat/api-freepublish.js';
import { contentMode, FREEPUBLISH_COLUMNS, OFFICIAL_API_ARGS } from './freepublish-list.js';

export const freepublishGetCommand = cli({
  site: 'weixin', name: 'freepublish-get', access: 'read', domain: 'api.weixin.qq.com',
  description: 'Get one published Weixin article through the official freepublish API',
  strategy: Strategy.LOCAL, browser: false,
  args: [
    { name: 'articleId', positional: true, required: true, help: 'Published article_id returned by freepublish-list' },
    { name: 'content', default: 'inline', choices: ['none', 'inline', 'file'], help: 'HTML handling: omit, return inline, or save files' },
    { name: 'output', default: './weixin-published', help: 'Artifact directory when --content file is used' },
    ...OFFICIAL_API_ARGS,
  ],
  columns: FREEPUBLISH_COLUMNS,
  func: async args => {
    const articleId = String(args.articleId ?? '').trim();
    if (!articleId) throw new ArgumentError('articleId is required');
    const mode = contentMode(args.content, 'inline');
    const credentials = readOfficialApiCredentials(args);
    const accessToken = await resolveOfficialApiAccessToken(credentials);
    const payload = await getFreepublishArticle({ accessToken, articleId });
    const rows = normalizeFreepublishPayload({ ...payload, article_id: payload.article_id ?? articleId });
    return materializeFreepublishRows(rows, { contentMode: mode, output: args.output });
  },
});
