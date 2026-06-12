// qqmail inbox — list mail in a QQ Mail folder (web version, wx.mail.qq.com).
import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError } from '@sovovs/bycli/errors';

const BASE = 'https://wx.mail.qq.com';
const HOST = 'wx.mail.qq.com';

// QQ Mail folder ids (dirid). Inbox is 1; the rest are stable system folders.
const FOLDERS = {
  inbox: 1,
  sent: 4,
  draft: 2,
  trash: 5,
  spam: 6,
};

async function readSid(page) {
  // sid lives in the SPA URL (…/home/index?sid=XXX#/…). It's the per-session
  // auth token every list/* cgi requires alongside the login cookies. Loading
  // the mail root redirects a logged-in user to that authenticated URL; the
  // redirect is client-side, so navigate (retry once) and poll for the sid.
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto(`${BASE}/`, { waitUntil: 'load', settleMs: 1500 });
    for (let i = 0; i < 8; i++) {
      const sid = await page.evaluate(() => {
        const m = String(location.href).match(/[?&]sid=([^&#]+)/);
        return m ? decodeURIComponent(m[1]) : '';
      });
      if (sid) return sid;
      await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));
    }
  }
  return '';
}

// Format a Unix-seconds timestamp as local "YYYY-MM-DD HH:MM:SS" so the date
// column matches the local-time semantics of the --since/--until/--date filters.
function localStamp(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function senderOf(it) {
  const s = it?.senders?.item?.[0];
  if (!s) return { nick: '', addr: '' };
  // Display names sometimes arrive wrapped in literal quotes ("Foo Bar").
  const nick = String(s.nick || '').replace(/^"(.*)"$/, '$1');
  return { nick, addr: s.email || '' };
}

// Parse "YYYY-MM-DD" or "YYYY-MM-DD HH:MM[:SS]" as a LOCAL-time boundary.
// endOfDay=true fills a bare date to 23:59:59.999 (inclusive upper bound).
function parseBound(value, label, endOfDay) {
  const str = String(value).trim();
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) throw new ArgumentError(`${label} must be YYYY-MM-DD or "YYYY-MM-DD HH:MM" (got "${str}")`);
  const [, y, mo, d, hh, mi, ss] = m;
  const hasTime = hh !== undefined;
  const dt = new Date(
    Number(y), Number(mo) - 1, Number(d),
    hasTime ? Number(hh) : (endOfDay ? 23 : 0),
    hasTime ? Number(mi) : (endOfDay ? 59 : 0),
    hasTime ? Number(ss ?? 0) : (endOfDay ? 59 : 0),
    hasTime ? 0 : (endOfDay ? 999 : 0),
  );
  if (Number.isNaN(dt.getTime())) throw new ArgumentError(`${label} is not a valid date: "${str}"`);
  return Math.floor(dt.getTime() / 1000); // Unix seconds, matches totime
}

cli({
  site: 'qqmail',
  name: 'inbox',
  access: 'read',
  description: 'QQ 邮箱邮件列表（默认收件箱，按时间倒序，支持日期过滤）',
  example: 'bycli qqmail inbox --since 2026-06-01 --until 2026-06-07',
  domain: HOST,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'limit', type: 'int', default: 20, help: '返回数量 (max 200)' },
    { name: 'folder', type: 'string', default: 'inbox', help: '文件夹：inbox / sent / draft / trash / spam' },
    { name: 'since', type: 'string', default: '', help: '起始日期（含），YYYY-MM-DD 或 "YYYY-MM-DD HH:MM"' },
    { name: 'until', type: 'string', default: '', help: '截止日期（含），YYYY-MM-DD 或 "YYYY-MM-DD HH:MM"' },
    { name: 'date', type: 'string', default: '', help: '只看某一天，YYYY-MM-DD（等价 since+until 同日）' },
  ],
  columns: ['index', 'subject', 'fromNick', 'fromEmail', 'date', 'unread', 'sizeKb', 'digest', 'emailId'],
  func: async (page, args) => {
    const limit = Number(args.limit ?? 20);
    if (!Number.isInteger(limit) || limit <= 0) throw new ArgumentError('limit must be a positive integer');
    if (limit > 200) throw new ArgumentError('limit must be <= 200');

    const folderKey = String(args.folder ?? 'inbox').toLowerCase();
    const dirid = FOLDERS[folderKey];
    if (dirid === undefined) {
      throw new ArgumentError(`Unknown folder "${folderKey}". Valid: ${Object.keys(FOLDERS).join(', ')}`);
    }

    // Date filters (all optional). --date is shorthand for a single day.
    const dateArg = String(args.date ?? '').trim();
    let sinceTs = null;
    let untilTs = null;
    if (dateArg) {
      sinceTs = parseBound(dateArg, 'date', false);
      untilTs = parseBound(dateArg, 'date', true);
    } else {
      if (String(args.since ?? '').trim()) sinceTs = parseBound(args.since, 'since', false);
      if (String(args.until ?? '').trim()) untilTs = parseBound(args.until, 'until', true);
    }
    if (sinceTs !== null && untilTs !== null && sinceTs > untilTs) {
      throw new ArgumentError('since must not be later than until');
    }
    const filtering = sinceTs !== null || untilTs !== null;

    const sid = await readSid(page);
    if (!sid) throw new AuthRequiredError(HOST);

    // ad_maillist is the web inbox listing cgi: page_now is 0-based page index,
    // page_size is rows per page, results are newest-first by totime. When a
    // date filter is set we page forward until we cross the `since` boundary
    // (or run out); otherwise a single page sized to `limit` is enough.
    const PAGE_SIZE = filtering ? 50 : limit;
    const MAX_PAGES = filtering ? 40 : 1; // safety cap: 40*50 = 2000 mails
    const rows = [];

    for (let pageNow = 0; pageNow < MAX_PAGES; pageNow++) {
      const url = `${BASE}/list/ad_maillist?sid=${encodeURIComponent(sid)}`
        + `&r=${Date.now()}${Math.floor(Math.random() * 1000)}`
        + `&dir=1&dirid=${dirid}&func=1&sort_type=1&sort_direction=1`
        + `&page_now=${pageNow}&page_size=${PAGE_SIZE}&enable_topmail=true`;

      let data;
      try {
        data = await page.fetchJson(url, { headers: { Referer: `${BASE}/` } });
      } catch (error) {
        throw new CommandExecutionError(`qqmail inbox request failed: ${error?.message || error}`);
      }

      const ret = data?.head?.ret;
      if (ret !== 0) {
        // ret -5002 / login-related codes mean the sid expired → re-login needed.
        throw new AuthRequiredError(HOST);
      }

      const list = Array.isArray(data?.body?.list) ? data.body.list : [];
      if (list.length === 0) break; // ran past the last page

      let crossedSince = false;
      for (const it of list) {
        const ts = Number(it.totime) || 0;
        if (filtering) {
          if (sinceTs !== null && ts && ts < sinceTs) { crossedSince = true; break; }
          if (untilTs !== null && ts && ts > untilTs) continue; // newer than window, skip
          if (sinceTs !== null && ts && ts < sinceTs) continue;
        }
        rows.push(it);
        if (rows.length >= limit) break;
      }

      if (rows.length >= limit) break;
      if (crossedSince) break;             // remaining mails are all older than `since`
      if (list.length < PAGE_SIZE) break;  // last page reached
    }

    if (rows.length === 0) {
      const scope = filtering ? `folder "${folderKey}" in the given date range` : `folder "${folderKey}"`;
      throw new EmptyResultError('qqmail inbox', `no mail in ${scope}`);
    }

    return rows.slice(0, limit).map((it, i) => {
      const from = senderOf(it);
      const ts = Number(it.totime) || 0;
      return {
        index: i + 1,
        subject: it.subject || '(无主题)',
        fromNick: from.nick,
        fromEmail: from.addr,
        date: localStamp(ts),
        unread: Number(it.unread) === 1,
        sizeKb: Math.round((Number(it.size) || 0) / 1024),
        digest: (it.maildigest || '').slice(0, 120),
        emailId: it.emailid || '',
      };
    });
  },
});
