import { parse, serialize, type DefaultTreeAdapterTypes } from 'parse5';
import { CommandExecutionError } from '../errors.js';

export const MAX_WECHAT_HTML_BYTES = 10 * 1024 * 1024;
export const MAX_WECHAT_NODES = 100_000;
export const MAX_WECHAT_CODE_BLOCKS = 1_000;

type Node = DefaultTreeAdapterTypes.Node;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type Element = DefaultTreeAdapterTypes.Element;

function isElement(node: Node): node is Element {
  return 'tagName' in node;
}

function attr(node: Element, name: string): string | undefined {
  return node.attrs.find(item => item.name === name)?.value;
}

function hasClass(node: Element, name: string): boolean {
  return (attr(node, 'class') || '').split(/\s+/).includes(name);
}

function textContent(node: Node): string {
  if ('value' in node) return node.value;
  if (!('childNodes' in node)) return '';
  return node.childNodes.map(textContent).join('');
}

export interface ExtractedWechatArticle {
  contentHtml: string;
  imageUrls: string[];
}

export function extractWechatArticleHtml(html: string): ExtractedWechatArticle {
  if (Buffer.byteLength(html, 'utf8') > MAX_WECHAT_HTML_BYTES) {
    throw new CommandExecutionError('WeChat article HTML exceeds the 10 MiB limit');
  }
  const document = parse(html);
  let content: Element | undefined;
  let nodes = 0;
  let codeBlocks = 0;
  const stack: Node[] = [document];
  while (stack.length > 0) {
    const node = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_WECHAT_NODES) throw new CommandExecutionError('WeChat article HTML exceeds the DOM node limit');
    if (isElement(node)) {
      if (attr(node, 'id') === 'js_content') content = node;
      if (node.tagName === 'pre') {
        codeBlocks += 1;
        if (codeBlocks > MAX_WECHAT_CODE_BLOCKS) throw new CommandExecutionError('WeChat article HTML exceeds the code block limit');
      }
    }
    if ('childNodes' in node) {
      for (let i = node.childNodes.length - 1; i >= 0; i -= 1) stack.push(node.childNodes[i]);
    }
  }
  if (!content) throw new CommandExecutionError('WeChat article has no #js_content');

  const parents: ParentNode[] = [content];
  while (parents.length > 0) {
    const parent = parents.pop()!;
    parent.childNodes = parent.childNodes.filter(node => {
      if (!isElement(node)) return true;
      return !['script', 'style'].includes(node.tagName)
        && !hasClass(node, 'qr_code_pc') && !hasClass(node, 'reward_area')
        && !hasClass(node, 'code-snippet__line-index');
    });
    for (const node of parent.childNodes) {
      if (isElement(node)) {
        if (node.tagName === 'img') {
          const lazy = attr(node, 'data-src');
          if (lazy) {
            node.attrs = node.attrs.filter(item => !['src', 'data-src'].includes(item.name));
            node.attrs.push({ name: 'src', value: lazy });
          }
        }
        if (hasClass(node, 'code-snippet__fix')) {
          const descendants: Node[] = [...node.childNodes].reverse();
          let pre: Element | undefined;
          const lines: string[] = [];
          while (descendants.length > 0) {
            const descendant = descendants.pop()!;
            if (isElement(descendant)) {
              if (descendant.tagName === 'pre') pre = descendant;
              if (descendant.tagName === 'code') {
                const line = textContent(descendant);
                if (!/^[ce]?ounter\(line/.test(line)) lines.push(line);
                continue;
              }
            }
            if ('childNodes' in descendant) {
              for (let i = descendant.childNodes.length - 1; i >= 0; i -= 1) descendants.push(descendant.childNodes[i]);
            }
          }
          if (pre && lines.length > 0) {
            pre.childNodes = [{ nodeName: '#text', value: lines.join('\n'), parentNode: pre }];
          }
        }
        parents.push(node);
      }
    }
  }
  const imageUrls: string[] = [];
  const seenImages = new Set<string>();
  const imageStack: Node[] = [content];
  while (imageStack.length > 0) {
    const node = imageStack.pop()!;
    if (isElement(node) && node.tagName === 'img') {
      const src = attr(node, 'src');
      if (src && !seenImages.has(src)) {
        seenImages.add(src);
        imageUrls.push(src);
      }
    }
    if ('childNodes' in node) {
      for (let i = node.childNodes.length - 1; i >= 0; i -= 1) imageStack.push(node.childNodes[i]);
    }
  }
  const fragment: DefaultTreeAdapterTypes.DocumentFragment = {
    nodeName: '#document-fragment', childNodes: content.childNodes,
  };
  return { contentHtml: serialize(fragment), imageUrls };
}
