import { Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError, TimeoutError } from '@sovovs/bycli/errors';

export const HOST = 'mail.iwhalecloud.com';
export const BASE = `https://${HOST}`;
export const metadata = { site: 'iwhalecloud', domain: HOST, access: 'read', strategy: Strategy.COOKIE,
  browser: true, navigateBefore: false, siteSession: 'persistent' };
export const idArg = { name: 'emailId', positional: true, required: true, help: 'list 返回的 emailId（请加引号）' };
export const SORT_FIELDS = Object.freeze({ date: 'DateTimeReceived', from: 'From', to: 'DisplayTo',
  subject: 'Subject', attachments: 'HasAttachments', importance: 'Importance', size: 'Size',
  sent: 'DateTimeSent', created: 'DateTimeCreated' });
const FOLDERS = Object.freeze({ inbox: 'inbox', sent: 'sentitems', drafts: 'drafts', trash: 'deleteditems', spam: 'junkemail' });
export function integer(value, name, min, max) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new ArgumentError(`${name} must be an integer between ${min} and ${max}`);
  return n;
}
export function requiredId(value) {
  const id = String(value ?? '').trim();
  if (!id) throw new ArgumentError('emailId is required; use an emailId returned by list');
  return id;
}
export function folderId(args) {
  if (args['folder-id']) return { __type: 'FolderId:#Exchange', Id: String(args['folder-id']) };
  const key = String(args.folder ?? 'inbox');
  if (!Object.hasOwn(FOLDERS, key)) throw new ArgumentError(`Unknown folder; choose ${Object.keys(FOLDERS).join(', ')} or --folder-id`);
  return { __type: 'DistinguishedFolderId:#Exchange', Id: FOLDERS[key] };
}
export async function connect(page) {
  await page.goto(`${BASE}/owa/`, { waitUntil: 'load' });
}

// Keep the session token inside the browser; never include it in CLI output or errors.
export async function request(page, action, body) {
  const result = await page.evaluate(async (actionName, requestBody) => {
    if (location.origin !== 'https://mail.iwhalecloud.com' || /\/auth\//i.test(location.pathname)) return { auth: true };
    const cookie = document.cookie.split(';').map(x => x.trim()).find(x => x.startsWith('X-OWA-CANARY='));
    if (!cookie) return { auth: true };
    try {
      const response = await fetch(`/owa/service.svc?action=${actionName}`, {
        method: 'POST', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { 'Content-Type': 'application/json; charset=utf-8', Action: actionName,
          'X-OWA-CANARY': decodeURIComponent(cookie.slice('X-OWA-CANARY='.length)) },
        body: JSON.stringify({ __type: `${actionName}JsonRequest:#Exchange`,
          Header: { __type: 'JsonRequestHeaders:#Exchange', RequestServerVersion: 'Exchange2013' }, Body: requestBody }),
      });
      if ([401, 403, 440].includes(response.status)) return { auth: true };
      if (!response.ok) return { status: response.status };
      const text = await response.text();
      if (/^\s*</.test(text)) return { auth: true };
      try { return { data: JSON.parse(text) }; } catch { return { malformed: true }; }
    } catch (error) {
      return { timeout: error.name === 'TimeoutError' || error.name === 'AbortError', failed: true };
    }
  }, action, body);
  if (result?.auth) throw new AuthRequiredError(HOST);
  if (result?.timeout) throw new TimeoutError(`iwhalecloud ${action}`, 30);
  if (!result?.data) throw new CommandExecutionError(`iwhalecloud ${action} request failed${result?.status ? ` (HTTP ${result.status})` : ''}`);
  const messages = result.data.Body?.ResponseMessages?.Items;
  if (!Array.isArray(messages) || !messages.length) throw new CommandExecutionError(`iwhalecloud ${action}: invalid response envelope`);
  for (const message of messages) {
    if (message.ResponseClass !== 'Success' || message.ResponseCode !== 'NoError') {
      const code = String(message.ResponseCode ?? 'UnknownError');
      if (['ErrorInvalidClientAccessToken', 'ErrorInvalidUserSid'].includes(code)) throw new AuthRequiredError(HOST);
      if (code === 'ErrorItemNotFound') throw new EmptyResultError(`iwhalecloud ${action}`, 'The mail may have been moved or deleted; refresh list');
      throw new CommandExecutionError(`iwhalecloud ${action}: ${code}`);
    }
  }
  return messages[0];
}

export function mailRow(item) {
  if (!item?.ItemId?.Id) throw new CommandExecutionError('OWA returned an item without an emailId');
  const sender = item.From?.Mailbox ?? item.Sender?.Mailbox ?? {};
  return { emailId: item.ItemId.Id, subject: item.Subject ?? '', fromName: sender.Name ?? '', fromEmail: sender.EmailAddress ?? '',
    toDisplay: item.DisplayTo ?? '', date: item.DateTimeReceived ?? '', times: { sentAt: item.DateTimeSent ?? '', createdAt: item.DateTimeCreated ?? '' },
    unread: typeof item.IsRead === 'boolean' ? !item.IsRead : null, hasAttachments: item.HasAttachments ?? false,
    importance: item.Importance ?? '', size: item.Size ?? 0,
    url: `${BASE}/owa/#path=/mail/item/${encodeURIComponent(item.ItemId.Id)}` };
}
export const listColumns = ['emailId', 'subject', 'fromName', 'fromEmail', 'toDisplay', 'date', 'times', 'unread', 'hasAttachments', 'importance', 'size', 'url'];

export async function getMail(page, emailId, bodyType = 'text') {
  const message = await request(page, 'GetItem', { __type: 'GetItemRequest:#Exchange', ShapeName: 'ItemPart',
    ItemShape: { __type: 'ItemResponseShape:#Exchange', BaseShape: 'AllProperties', BodyType: bodyType === 'html' ? 'HTML' : 'Text',
      MaximumBodySize: 0, MaximumRecipientsToReturn: 10000 }, ItemIds: [{ __type: 'ItemId:#Exchange', Id: emailId }] });
  if (!Array.isArray(message.Items) || message.Items.length !== 1 || message.Items[0]?.ItemId?.Id !== emailId) {
    throw new CommandExecutionError('OWA GetItem did not return the requested mail');
  }
  return message.Items[0];
}
export function attachmentsOf(item) {
  if (item.Attachments != null && !Array.isArray(item.Attachments)) throw new CommandExecutionError('OWA returned invalid attachments');
  return (item.Attachments ?? []).map((a, index) => ({ index: index + 1, attachmentId: a.AttachmentId?.Id ?? '',
    name: a.Name ?? '', contentType: a.ContentType ?? '', size: a.Size ?? 0, inline: a.IsInline ?? false,
    kind: a.__type?.split(':')[0] ?? 'Unknown' }));
}
