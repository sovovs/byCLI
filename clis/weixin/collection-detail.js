import { ArgumentError, EmptyResultError } from '@sovovs/bycli/errors';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { resolveBrowserCredentials } from './_wechat/auth-session.js';
import { fetchCollectionDetail, findCollectionById } from './_wechat/collections.js';

const SAFE_REFERER = 'https://mp.weixin.qq.com/cgi-bin/appmsgalbum?action=list';
const PAGE_SIZE = 20;

export const collectionDetailCommand = cli({
  site: 'weixin',
  name: 'collection-detail',
  access: 'read',
  description: 'Show one WeChat content collection with its settings and items',
  domain: 'mp.weixin.qq.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'collectionId', positional: true, required: true, help: 'Collection ID returned by weixin collections' },
    { name: 'max-pages', type: 'int', default: 5, help: 'Maximum number of collection pages to scan' },
  ],
  columns: [
    'collectionId', 'title', 'description', 'collectionType', 'coverUrl', 'itemCount',
    'createdAt', 'updatedAt', 'settingsJson', 'itemsJson',
  ],
  func: async (page, args) => {
    const collectionId = String(args.collectionId ?? '').trim();
    if (!collectionId) throw new ArgumentError('collectionId is required');
    const maxPages = args['max-pages'];
    if (!Number.isSafeInteger(maxPages) || maxPages <= 0) {
      throw new ArgumentError('max-pages must be a positive safe integer');
    }
    const limit = maxPages * PAGE_SIZE;
    if (!Number.isSafeInteger(limit)) {
      throw new ArgumentError('max-pages is too large');
    }
    const { token } = await resolveBrowserCredentials(page);
    const found = await findCollectionById({
      page,
      token,
      safeReferer: SAFE_REFERER,
      collectionId,
      pageSize: PAGE_SIZE,
      maxPages,
    });
    if (found === null) {
      throw new EmptyResultError(
        'weixin collection-detail',
        `Collection ${collectionId} was not found within the scanned collection pages.`,
      );
    }
    const detail = await fetchCollectionDetail({
      page,
      token,
      safeReferer: SAFE_REFERER,
      collectionId,
      collectionType: found.collectionTypeRaw,
      limit,
      pageSize: PAGE_SIZE,
      maxPages,
    });
    return [{
      collectionId: detail.collectionId,
      title: detail.title,
      description: detail.description,
      collectionType: detail.collectionType,
      coverUrl: detail.coverUrl,
      itemCount: detail.itemCount,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
      settingsJson: JSON.stringify(detail.settings),
      itemsJson: JSON.stringify(detail.items),
    }];
  },
});
