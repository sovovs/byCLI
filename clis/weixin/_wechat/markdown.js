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

export function wechatArticleToMarkdown({ html, title, accountName, author, publishedAt, url }) {
  const extracted = extractWechatArticleHtml(String(html || ''));
  let markdown = convertArticleHtmlToMarkdown(extracted.contentHtml);
  markdown = markdown.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  const safe = value => String(value || '').replace(/\s+/g, ' ').trim()
    .replace(/([\\`*_[\]{}()#+.!|>~-])/g, '\\$1');
  const metadata = [accountName && `> 公众号: ${safe(accountName)}`, author && `> 作者: ${safe(author)}`,
    publishedAt && `> 发布时间: ${safe(publishedAt)}`, url && `> 原文链接: ${safe(url)}`].filter(Boolean);
  return [`# ${safe(title || 'Untitled').replace(/\\>/g, '&gt;')}`, ...metadata, '', '---', '', markdown, ''].join('\n');
}
