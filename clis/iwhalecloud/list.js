import { cli } from '@sovovs/bycli/registry';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@sovovs/bycli/errors';
import { metadata, SORT_FIELDS, integer, folderId, connect, request, mailRow, listColumns } from './client.js';

export async function runList(page, args) {
  const limit = integer(args.limit ?? 20, 'limit', 1, 10000);
  let offset = integer(args.offset ?? 0, 'offset', 0, 2147483647);
  const sort = String(args.sort ?? 'default');
  const order = String(args.order ?? 'default');
  if (sort !== 'default' && !Object.hasOwn(SORT_FIELDS, sort)) throw new ArgumentError(`Unknown sort: ${sort}`);
  if (!['default', 'asc', 'desc'].includes(order)) throw new ArgumentError('order must be default, asc or desc');
  if (sort === 'default' && order !== 'default') throw new ArgumentError('Specify --sort to use --order; default preserves server ordering');
  const folder = folderId(args);
  await connect(page);
  const rows = [];
  const seen = new Set();
  while (rows.length < limit) {
    // Split the validated total into server pages; do not cap the caller's total.
    const remaining = limit - rows.length;
    const batchSize = remaining > 100 ? 100 : remaining;
    const body = { __type: 'FindItemRequest:#Exchange',
      ItemShape: { __type: 'ItemResponseShape:#Exchange', BaseShape: 'AllProperties' },
      ParentFolderIds: [folder], Traversal: 'Shallow',
      Paging: { __type: 'IndexedPageView:#Exchange', BasePoint: 'Beginning', Offset: offset, MaxEntriesReturned: batchSize } };
    if (sort !== 'default') {
      const ascending = order === 'asc' || (order === 'default' && ['from', 'to', 'subject'].includes(sort));
      body.SortOrder = [{ __type: 'SortResults:#Exchange', Order: ascending ? 'Ascending' : 'Descending',
        Path: { __type: 'PropertyUri:#Exchange', FieldURI: SORT_FIELDS[sort] } }];
      if (sort !== 'date') body.SortOrder.push({ __type: 'SortResults:#Exchange', Order: 'Descending',
        Path: { __type: 'PropertyUri:#Exchange', FieldURI: 'DateTimeReceived' } });
    }
    const message = await request(page, 'FindItem', body);
    const root = message.RootFolder;
    if (!root || !Array.isArray(root.Items)) throw new CommandExecutionError('OWA FindItem returned invalid items');
    for (const item of root.Items) {
      const row = mailRow(item);
      if (seen.has(row.emailId)) throw new CommandExecutionError('Mailbox changed while paging; repeat list to avoid incomplete results');
      seen.add(row.emailId); rows.push(row);
      if (rows.length === limit) break;
    }
    if (root.IncludesLastItemInRange === true || rows.length >= limit) break;
    const next = root.IndexedPagingOffset;
    if (!root.Items.length || !Number.isSafeInteger(next) || next <= offset) throw new CommandExecutionError('OWA pagination did not advance');
    offset = next;
  }
  if (!rows.length) throw new EmptyResultError('iwhalecloud list', 'No mail at this folder/offset');
  return rows;
}

cli({ ...metadata, name: 'list', description: '浩鲸邮箱邮件列表：服务端分页、默认排序及 9 种字段排序',
  example: 'bycli iwhalecloud list --sort date --order desc --limit 50 -f yaml',
  args: [
    { name: 'folder', default: 'inbox', choices: ['inbox', 'sent', 'drafts', 'trash', 'spam'], help: '邮件文件夹' },
    { name: 'folder-id', help: '自定义文件夹的 OWA FolderId，优先于 --folder' },
    { name: 'limit', type: 'int', default: 20, help: '返回数量，1–10000；自动分页' },
    { name: 'offset', type: 'int', default: 0, help: '服务端起始偏移，0 表示第一封' },
    { name: 'sort', default: 'default', choices: ['default', ...Object.keys(SORT_FIELDS)], help: 'default 保留服务端默认顺序' },
    { name: 'order', default: 'default', choices: ['default', 'asc', 'desc'], help: '默认：姓名/主题升序，其余降序；显式方向须指定 --sort' },
  ], columns: listColumns, func: runList });
