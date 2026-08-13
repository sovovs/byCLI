import { ArgumentError, EmptyResultError } from '@sovovs/bycli/errors';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { resolveBrowserCredentials } from './_wechat/auth-session.js';
import { collectCollections } from './_wechat/collections.js';

const SAFE_REFERER = 'https://mp.weixin.qq.com/cgi-bin/appmsgalbum?action=list';
const PAGE_SIZE = 20;

const positiveSafeInteger = (value, name) => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ArgumentError(`${name} must be a positive safe integer`);
  }
  return value;
};

export const collectionsCommand = cli({
  site: 'weixin',
  name: 'collections',
  access: 'read',
  description: 'List WeChat official-account content collections',
  domain: 'mp.weixin.qq.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'limit', type: 'int', default: 20, help: 'Maximum number of collections to return' },
    { name: 'max-pages', type: 'int', default: 5, help: 'Maximum number of collection pages to scan' },
  ],
  columns: [
    'collectionId', 'title', 'collectionType', 'itemCount', 'views', 'continuousRead',
    'isUpdating', 'isBanned', 'isPaid', 'createdAt', 'updatedAt', 'coverUrl',
  ],
  func: async (page, args) => {
    const limit = positiveSafeInteger(args.limit, 'limit');
    const maxPages = positiveSafeInteger(args['max-pages'], 'max-pages');
    const { token } = await resolveBrowserCredentials(page);
    const rows = await collectCollections({
      page,
      token,
      safeReferer: SAFE_REFERER,
      limit,
      pageSize: PAGE_SIZE,
      maxPages,
    });
    if (rows.length === 0) {
      throw new EmptyResultError(
        'weixin collections',
        'No collections were found. Create a collection in the WeChat Official Accounts dashboard first.',
      );
    }
    return rows.map(row => ({
      collectionId: row.collectionId,
      title: row.title,
      collectionType: row.collectionType,
      itemCount: row.itemCount,
      views: row.views,
      continuousRead: row.continuousRead,
      isUpdating: row.isUpdating,
      isBanned: row.isBanned,
      isPaid: row.isPaid,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      coverUrl: row.coverUrl,
    }));
  },
});
