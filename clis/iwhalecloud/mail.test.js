import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runList } from './list.js';
import { runRead } from './read.js';
import { runDownload } from './download.js';

const mail = (id, extra = {}) => ({ ItemId: { Id: id }, Subject: '测试邮件',
  DateTimeReceived: '2026-09-10T01:00:00Z', From: { Mailbox: { Name: 'Sender', EmailAddress: 'sender@example.test' } },
  IsRead: false, HasAttachments: false, Size: 100, Importance: 'Normal', ...extra });
const envelope = (message) => ({ Body: { ResponseMessages: { Items: [{ ResponseClass: 'Success', ResponseCode: 'NoError', ...message }] } } });
function pageFor(handler, { status = 200, cookie = 'X-OWA-CANARY=test-canary' } = {}) {
  const calls = [];
  return { calls, goto: async () => {}, getCookies: async () => [{ name: 'session', value: 'test', domain: 'mail.iwhalecloud.com' }],
    evaluate: async (fn, ...args) => vm.runInNewContext(`(${fn.toString()})(...args)`, {
      args, document: { cookie }, location: { origin: 'https://mail.iwhalecloud.com', pathname: '/owa/' },
      AbortSignal, fetch: async (url, options) => {
        const body = JSON.parse(options.body); const action = new URL(url, 'https://mail.iwhalecloud.com').searchParams.get('action');
        calls.push({ action, body }); const data = handler(action, body.Body);
        return { status, ok: status === 200, redirected: false, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify(data) };
      },
    }),
  };
}

describe('iwhalecloud list', () => {
  it('keeps default server ordering and follows the server offset across short pages', async () => {
    const page = pageFor((action, body) => envelope({ RootFolder: body.Paging.Offset === 0
      ? { Items: [mail('b')], IndexedPagingOffset: 4, IncludesLastItemInRange: false, TotalItemsInView: 5 }
      : { Items: [mail('a')], IndexedPagingOffset: 5, IncludesLastItemInRange: true, TotalItemsInView: 5 } }));
    expect((await runList(page, { limit: 2 })).map(x => x.emailId)).toEqual(['b', 'a']);
    expect(page.calls.map(x => x.body.Body.Paging.Offset)).toEqual([0, 4]);
    expect(page.calls.every(x => !('SortOrder' in x.body.Body))).toBe(true);
  });
  it.each([['date', 'DateTimeReceived'], ['from', 'From'], ['to', 'DisplayTo'], ['subject', 'Subject'],
    ['attachments', 'HasAttachments'], ['importance', 'Importance'], ['size', 'Size'], ['sent', 'DateTimeSent'], ['created', 'DateTimeCreated']])('sends %s sorting to the server before pagination', async (sort, field) => {
    const page = pageFor(() => envelope({ RootFolder: { Items: [mail('a')], IncludesLastItemInRange: true } }));
    const rows = await runList(page, { sort, order: 'asc', offset: 20, limit: 1, folder: 'sent' });
    expect(rows[0]).toMatchObject({ emailId: 'a', unread: true, fromEmail: 'sender@example.test' });
    expect(page.calls[0].body.Body.SortOrder[0]).toMatchObject({ Order: 'Ascending', Path: { FieldURI: field } });
    expect(page.calls[0].body.Body).toMatchObject({
      Paging: { Offset: 20 }, ParentFolderIds: [{ Id: 'sentitems' }] });
  });
  it.each([{ limit: 0 }, { limit: 10001 }, { offset: -1 }, { sort: 'unread' }, { order: 'up' },
    { folder: 'unknown' }, { sort: 'default', order: 'asc' }])('rejects invalid arguments %j', async args => {
    await expect(runList(pageFor(() => ({})), args)).rejects.toMatchObject({ code: 'ARGUMENT' });
  });
  it('does not silently return partial results when pagination stops advancing', async () => {
    const page = pageFor(() => envelope({ RootFolder: { Items: [mail('a')], IndexedPagingOffset: 0, IncludesLastItemInRange: false } }));
    await expect(runList(page, { limit: 2 })).rejects.toMatchObject({ code: 'COMMAND_EXEC' });
  });
  it('distinguishes an empty mailbox from a malformed response', async () => {
    await expect(runList(pageFor(() => envelope({ RootFolder: { Items: [], IncludesLastItemInRange: true } })), {})).rejects.toMatchObject({ code: 'EMPTY_RESULT' });
    await expect(runList(pageFor(() => envelope({})), {})).rejects.toMatchObject({ code: 'COMMAND_EXEC' });
  });
  it('reports expired authentication without leaking the canary', async () => {
    await expect(runList(pageFor(() => ({}), { status: 440 }), {})).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
  it('preserves server errors instead of treating them as an empty list', async () => {
    await expect(runList(pageFor(() => envelope({ ResponseClass: 'Error', ResponseCode: 'ErrorUnsupportedPathForSortGroup' })), {})).rejects.toMatchObject({ code: 'COMMAND_EXEC' });
  });
});

describe('iwhalecloud read', () => {
  it('does not silently report unavailable body content as a complete empty mail', async () => {
    await expect(runRead(pageFor(() => envelope({ Items: [mail('a')] })), { emailId: 'a' })).rejects.toMatchObject({ code: 'COMMAND_EXEC' });
  });
  it('returns full body, recipients and attachment IDs using only GetItem', async () => {
    const page = pageFor(() => envelope({ Items: [mail('a', { Body: { BodyType: 'Text', Value: '完整正文\n第二段' },
      ToRecipients: [{ Name: 'Reader', EmailAddress: 'reader@example.test' }],
      Attachments: [{ __type: 'FileAttachment:#Exchange', AttachmentId: { Id: 'att+/=' }, Name: '文档.pdf', Size: 50, ContentType: 'application/pdf' }] })] }));
    const [row] = await runRead(page, { emailId: 'a' });
    expect(row).toMatchObject({ emailId: 'a', body: '完整正文\n第二段', unread: true,
      to: [{ name: 'Reader', email: 'reader@example.test' }], attachments: [{ attachmentId: 'att+/=', name: '文档.pdf' }] });
    expect(page.calls.map(x => x.action)).toEqual(['GetItem']);
    expect(page.calls[0].body.Body.ItemShape.MaximumBodySize).toBe(0);
  });
});

describe('iwhalecloud download', () => {
  async function withDir(fn) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bycli-mail-test-')); try { await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); } }
  const attachment = (id, name) => ({ __type: 'FileAttachment:#Exchange', AttachmentId: { Id: id }, Name: name, ContentType: 'application/pdf', Size: 12 });
  const downloadPage = (attachments) => pageFor(() => envelope({ Items: [mail('a', { Attachments: attachments })] }));
  it('downloads binary files safely, keeps Chinese names and never overwrites collisions', async () => withDir(async output => {
    await fs.writeFile(path.join(output, '资料.pdf'), 'existing');
    const page = downloadPage([attachment('att+/=', '../资料.pdf'), attachment('other', '资料.pdf')]);
    const rows = await runDownload(page, { emailId: 'a', output }, { fetch: async url => {
      expect(new URL(url).origin).toBe('https://mail.iwhalecloud.com');
      expect(['att+/=', 'other']).toContain(new URL(url).searchParams.get('id'));
      return new Response(Buffer.from('%PDF-测试'), { headers: { 'content-type': 'application/octet-stream' } });
    } });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(x => x.path)).size).toBe(2);
    for (const row of rows) { expect(path.dirname(row.path)).toBe(output); expect((await fs.readFile(row.path)).equals(Buffer.from('%PDF-测试'))).toBe(true); }
    expect(await fs.readFile(path.join(output, '资料.pdf'), 'utf8')).toBe('existing');
  }));
  it('selects exactly the requested attachment', async () => withDir(async output => {
    const rows = await runDownload(downloadPage([attachment('x', 'a.pdf'), attachment('y', 'b.pdf')]),
      { emailId: 'a', attachment: '2', output }, { fetch: async () => new Response('data') });
    expect(rows.map(x => x.attachmentId)).toEqual(['y']);
  }));
  it('rejects login redirects and leaves no fake downloaded file', async () => withDir(async output => {
    await expect(runDownload(downloadPage([attachment('x', 'a.pdf')]), { emailId: 'a', output },
      { fetch: async () => new Response('', { status: 302, headers: { location: '/owa/auth/logon.aspx' } }) })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(await fs.readdir(output)).toEqual([]);
  }));
  it('removes a partial file if a binary stream fails', async () => withDir(async output => {
    let pulls = 0;
    const body = new ReadableStream({ pull(controller) {
      if (pulls++ === 0) controller.enqueue(new Uint8Array([1, 2, 3]));
      else controller.error(new Error('connection interrupted'));
    } });
    await expect(runDownload(downloadPage([attachment('x', 'a.pdf')]), { emailId: 'a', output },
      { fetch: async () => new Response(body) })).rejects.toMatchObject({ code: 'COMMAND_EXEC' });
    expect(await fs.readdir(output)).toEqual([]);
  }));
  it('does not download inline files when all is requested', async () => withDir(async output => {
    const rows = await runDownload(downloadPage([attachment('x', 'a.pdf'), { ...attachment('y', 'image.png'), IsInline: true }]),
      { emailId: 'a', output }, { fetch: async () => new Response('data') });
    expect(rows.map(x => x.attachmentId)).toEqual(['x']);
  }));
});
