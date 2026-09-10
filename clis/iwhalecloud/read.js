import { cli } from '@sovovs/bycli/registry';
import { ArgumentError, CommandExecutionError } from '@sovovs/bycli/errors';
import { metadata, idArg, requiredId, connect, getMail, mailRow, listColumns, attachmentsOf } from './client.js';

export async function runRead(page, args) {
  const id = requiredId(args.emailId);
  const bodyType = String(args['body-type'] ?? 'text');
  if (!['text', 'html'].includes(bodyType)) throw new ArgumentError('body-type must be text or html');
  await connect(page);
  const item = await getMail(page, id, bodyType);
  if (typeof item.Body?.Value !== 'string' || item.Body.IsTruncated === true) {
    throw new CommandExecutionError('OWA did not return a complete mail body', 'Open the mail in Outlook to check content restrictions');
  }
  const recipients = entries => (entries ?? []).map(entry => {
    const mailbox = entry.Mailbox ?? entry;
    return { name: mailbox.Name ?? '', email: mailbox.EmailAddress ?? '' };
  });
  return [{ ...mailRow(item), to: recipients(item.ToRecipients), cc: recipients(item.CcRecipients), bcc: recipients(item.BccRecipients),
    recipientCounts: item.RecipientCounts ?? {}, bodyType: item.Body?.BodyType ?? bodyType, body: item.Body?.Value ?? '',
    attachments: attachmentsOf(item) }];
}
cli({ ...metadata, name: 'read', description: '读取浩鲸邮件完整正文、收件人和附件列表（不标记已读）',
  example: 'bycli iwhalecloud read "<emailId>" -f yaml',
  args: [idArg, { name: 'body-type', default: 'text', choices: ['text', 'html'], help: '正文格式' }],
  columns: [...listColumns, 'to', 'cc', 'bcc', 'recipientCounts', 'bodyType', 'body', 'attachments'], func: runRead });
