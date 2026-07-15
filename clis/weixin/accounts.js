import { ArgumentError, EmptyResultError } from '@sovovs/bycli/errors';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { readEnvironmentCredentials, resolveBrowserCredentials } from './_wechat/auth-session.js';
import { captureSearchBizFingerprint } from './_wechat/fingerprint.js';
import { executeSearchBiz } from './_wechat/search-biz.js';

const DOMAIN = 'mp.weixin.qq.com';
const browserRequired = args => args['auth-source'] !== 'env';

function source(args) {
  const value = args['auth-source'] ?? 'browser';
  if (value !== 'browser' && value !== 'env') throw new ArgumentError('auth-source must be browser or env');
  return value;
}

export const accountsCommand = cli({
  site: 'weixin', name: 'accounts', access: 'read', domain: DOMAIN,
  strategy: Strategy.INTERCEPT, browser: browserRequired,
  args: [
    { name: 'query', positional: true, required: true, help: 'Official-account name to search for' },
    { name: 'limit', type: 'int', default: 10 },
    { name: 'auth-source', default: 'browser' },
  ],
  columns: ['nickname', 'fakeid', 'alias'],
  func: async (page, args) => {
    const query = String(args.query ?? '').trim();
    if (!query) throw new ArgumentError('query is required');
    const limit = args.limit ?? 10;
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new ArgumentError('limit must be a positive safe integer');
    const authSource = source(args);
    let credentials;
    if (authSource === 'env') {
      credentials = readEnvironmentCredentials(true);
    } else {
      credentials = await resolveBrowserCredentials(page);
      credentials = { ...credentials, fingerprint: await captureSearchBizFingerprint(page, query) };
    }
    const rows = await executeSearchBiz({ page, source: authSource, credentials, query, limit });
    if (rows.length === 0) throw new EmptyResultError('weixin accounts', `No official accounts matched "${query}".`);
    return rows.map(row => ({ nickname: row.nickname, fakeid: row.fakeid, alias: row.alias || null }));
  },
});
