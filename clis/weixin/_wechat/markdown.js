import { decodeWechatEntities, extractWechatArticleContentFromHtml } from './article-content.js';

function htmlToMarkdown(html) {
  return decodeWechatEntities(html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_m, level, text) => `\n${'#'.repeat(Number(level))} ${text.replace(/<[^>]+>/g, '')}\n`)
    .replace(/<img\b[^>]*\balt\s*=\s*(["'])(.*?)\1[^>]*\bsrc\s*=\s*(["'])(.*?)\3[^>]*>/gi, '\n![$2]($4)\n')
    .replace(/<img\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi, '\n![]($2)\n')
    .replace(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi, '[$3]($2)')
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, '**$2**')
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, '*$2*')
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi, '\n- $1')
    .replace(/<\/?(?:p|div|section|article|ul|ol|blockquote|pre)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\u00a0/g, ' '));
}

export function cleanMarkdownFilename(title, maxLength = 100) {
  let cleaned = String(title || '')
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_')
    .trim().replace(/[. ]+$/g, '');
  let bounded = '';
  for (const char of [...cleaned].slice(0, maxLength)) {
    if (Buffer.byteLength(`${bounded}${char}.md`) > 255) break;
    bounded += char;
  }
  cleaned = bounded.replace(/[. ]+$/g, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)) cleaned = `_${cleaned}`;
  return cleaned || 'untitled';
}

export function wechatArticleToMarkdown({ html, title, accountName, author, publishedAt, url }) {
  const extracted = extractWechatArticleContentFromHtml(html);
  let markdown = htmlToMarkdown(extracted.contentHtml);
  extracted.codeBlocks.forEach((block, index) => {
    markdown = markdown.replace(`CODEBLOCK-PLACEHOLDER-${index}`, `\n\`\`\`${block.lang}\n${block.code}\n\`\`\`\n`);
  });
  markdown = markdown.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  const metadata = [accountName && `> 公众号: ${accountName}`, author && `> 作者: ${author}`,
    publishedAt && `> 发布时间: ${publishedAt}`, url && `> 原文链接: ${url}`].filter(Boolean);
  return [`# ${title || 'Untitled'}`, ...metadata, '', '---', '', markdown, ''].join('\n');
}
