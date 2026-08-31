import { ArgumentError, EmptyResultError } from '@sovovs/bycli/errors';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { readEnvironmentCredentials, resolveBrowserCredentials } from './_wechat/auth-session.js';
import { captureSearchBizFingerprint } from './_wechat/fingerprint.js';
import { executeSearchBiz } from './_wechat/search-biz.js';
import { readAuthSource } from './_wechat/args.js';

const DOMAIN = 'mp.weixin.qq.com';
const browserRequired = args => readAuthSource(args) === 'browser';

export const getPublicAccountInfoCommand = cli({
  site: 'weixin', name: 'get-public-account-info', access: 'read', domain: DOMAIN,
  description: 'Search WeChat official accounts and return their fakeids',
  strategy: Strategy.INTERCEPT, browser: browserRequired,
  args: [
    { name: 'query', positional: true, required: true, help: 'Official-account name to search for' },
    { name: 'limit', type: 'int', default: 10, help: 'Maximum number of matching accounts to return' },
    { name: 'auth-source', default: 'browser', choices: ['browser', 'env'], help: 'Credential source: browser session or environment variables' },
  ],
  columns: ['nickname', 'fakeid', 'alias'],
  func: async (page, args) => {
    const query = String(args.query ?? '').trim();
    if (!query) throw new ArgumentError('query is required');
    const limit = args.limit ?? 10;
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new ArgumentError('limit must be a positive safe integer');
    const authSource = readAuthSource(args);
    let credentials;
    if (authSource === 'env') {
      credentials = readEnvironmentCredentials(true);
    } else {
      credentials = await resolveBrowserCredentials(page);
      credentials = { ...credentials, fingerprint: await captureSearchBizFingerprint(page, query) };
    }
    const rows = await executeSearchBiz({ page, source: authSource, credentials, query, limit });
    if (rows.length === 0) throw new EmptyResultError('weixin get-public-account-info', `No official accounts matched "${query}".`);
    return rows.map(row => ({ nickname: row.nickname, fakeid: row.fakeid, alias: row.alias || null }));
  },
});
