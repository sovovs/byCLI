import { cli, Strategy } from '@sovovs/bycli/registry';
import { searchArgs, searchColumns, searchOptions, searchVideos } from './_shared/search.js';

export const searchCommand = cli({
  site: 'baijiahao', name: 'search', access: 'read', domain: 'haokan.baidu.com', strategy: Strategy.PUBLIC,
  browser: true, navigateBefore: false,
  description: '通过好看视频原生入口检索公开视频，返回可传给 baijiahao video-download 的链接',
  args: searchArgs, columns: searchColumns, validateArgs: searchOptions, func: searchVideos,
});
