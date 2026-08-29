import { EmptyResultError } from '@sovovs/bycli/errors';
import { cli, Strategy } from '@sovovs/bycli/registry';
import { resolveBrowserCredentials } from './_wechat/auth-session.js';
import {
  collectAttributes,
  parseAttributeDimension,
  resolveAttributeDate,
} from './_wechat/user-analysis.js';

const COLUMNS = ['date', 'dimension', 'name', 'code', 'parent_code', 'count', 'percent'];

export const userAttributesCommand = cli({
  site: 'weixin',
  name: 'user-attributes',
  access: 'read',
  domain: 'mp.weixin.qq.com',
  description: '读取公众号用户属性，包括性别、年龄、语言、地区、平台和设备品牌',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'date', help: '快照日期（YYYY-MM-DD）；默认昨天' },
    {
      name: 'dimension',
      default: 'all',
      choices: ['all', 'gender', 'age', 'language', 'region', 'platform', 'brand'],
      help: '属性维度；默认返回全部维度',
    },
  ],
  columns: COLUMNS,
  func: async (page, args) => {
    const { token } = await resolveBrowserCredentials(page);
    const date = resolveAttributeDate(args.date);
    const dimension = parseAttributeDimension(args.dimension);
    const rows = await collectAttributes({ page, token, date, dimension });
    if (rows.length === 0) {
      throw new EmptyResultError('weixin user-attributes', `No ${dimension} attribute rows are available for ${date}.`);
    }
    return rows.map(row => ({
      date: row.date,
      dimension: row.dimension,
      name: row.name,
      code: row.code,
      parent_code: row.parentCode,
      count: row.count,
      percent: row.percent,
    }));
  },
});
