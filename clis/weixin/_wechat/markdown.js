import { convertArticleHtmlToMarkdown, extractWechatArticleHtml } from '@sovovs/bycli/download/article-download';

export function cleanMarkdownFilename(title, maxLength = 100, suffix = '') {
  let cleaned = String(title || '')
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_')
    .trim().replace(/[. ]+$/g, '');
  let bounded = '';
  for (const char of [...cleaned].slice(0, maxLength)) {
    if (Buffer.byteLength(`${bounded}${char}${suffix}.md`) > 255) break;
    bounded += char;
  }
  cleaned = bounded.replace(/[. ]+$/g, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)) cleaned = `_${cleaned}`;
  return cleaned || 'untitled';
}

export function wechatArticleToMarkdown({ html, title, accountName, author, publishedAt, url, digest }) {
  const extracted = extractWechatArticleHtml(String(html || ''));
  let markdown = convertArticleHtmlToMarkdown(extracted.contentHtml, { safeFencedCodeBlocks: true });
  markdown = markdown.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  const safe = value => String(value || '').replace(/\s+/g, ' ').trim()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    .replace(/([\\`*_[\]{}()#+.!|>~-])/g, '\\$1');
  // A URL must not go through `safe()`: escaping `. _ - ( ) #` and entity-encoding
  // `&` corrupts the link so it can no longer be copied or followed. Rendered as an
  // autolink it only needs whitespace and control characters dropped, `<`/`>`
  // percent-encoded so the autolink cannot be closed early, and an http(s) scheme
  // allowlist to reject `javascript:` and other hostile schemes.
  const safeUrl = value => {
    const raw = [...String(value || '')]
      .filter(char => char > ' ' && char.codePointAt(0) !== 127)
      .join('');
    if (!/^https?:\/\//i.test(raw)) return '';
    return raw.replace(/</g, '%3C').replace(/>/g, '%3E');
  };
  const articleUrl = safeUrl(url);
  const metadata = [accountName && `> 公众号: ${safe(accountName)}`, author && `> 作者: ${safe(author)}`,
    publishedAt && `> 发布时间: ${safe(publishedAt)}`, digest && `> 摘要: ${safe(digest)}`,
    articleUrl && `> 原文链接: <${articleUrl}>`].filter(Boolean);
  return [`# ${safe(title || 'Untitled')}`, ...metadata, '', '---', '', markdown, ''].join('\n');
}
