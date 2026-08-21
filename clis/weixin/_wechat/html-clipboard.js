import { CommandExecutionError } from '@sovovs/bycli/errors';

const RICH_NODE_PATTERN = /<(?:p|h[1-6]|strong|em|a|ul|ol|table|img|div|section|span)\b/i;

function plainTextFromHtml(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/\s+/gu, ' ')
    .trim();
}

function clipboardWriteScript(html, text) {
  return `(() => {
    const html = ${JSON.stringify(html)};
    const text = ${JSON.stringify(text)};
    if (!navigator.clipboard || typeof navigator.clipboard.write !== 'function' || typeof ClipboardItem !== 'function') {
      return { ok: false, reason: 'Clipboard API is unavailable' };
    }
    const item = new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    });
    return navigator.clipboard.write([item])
      .then(() => ({ ok: true }))
      .catch(error => ({ ok: false, reason: error && error.message ? error.message : String(error) }));
  })()`;
}

function editorReadScript() {
  return `(() => {
    const editors = [...document.querySelectorAll('div[contenteditable="true"], [contenteditable="true"]')];
    const visibleEditors = editors.filter(node => node.offsetParent !== null);
    const editor = visibleEditors[visibleEditors.length - 1] || editors[editors.length - 1];
    if (!editor) return { ok: false, reason: 'contenteditable editor not found' };
    return { ok: true, html: editor.innerHTML || '', text: editor.innerText || editor.textContent || '' };
  })()`;
}

export async function pasteHtmlThroughClipboard(page, html, {
  origin = 'https://mp.weixin.qq.com',
  platform = process.platform,
} = {}) {
  if (typeof page?.cdp !== 'function') {
    throw new CommandExecutionError('Rich HTML paste requires Browser Bridge CDP support');
  }
  if (typeof page?.evaluate !== 'function' || typeof page?.nativeKeyPress !== 'function') {
    throw new CommandExecutionError('Rich HTML paste requires page evaluation and native key support');
  }

  const source = String(html ?? '');
  if (!source.trim()) throw new CommandExecutionError('Rich HTML content must not be empty');

  if (typeof page.focusWindow === 'function') {
    try { await page.focusWindow(); } catch { /* the native paste will report focus failures */ }
  }

  try {
    await page.cdp('Browser.grantPermissions', {
      origin,
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    });
  } catch (error) {
    const message = String(error?.message ?? error);
    if (!message.includes('CDP method not permitted: Browser.grantPermissions')) {
      throw new CommandExecutionError(`Could not grant clipboard permission: ${message}`);
    }
  }

  const focused = await page.evaluate(`(() => {
    const editors = [...document.querySelectorAll('div[contenteditable="true"], [contenteditable="true"]')];
    const visibleEditors = editors.filter(node => node.offsetParent !== null);
    const editor = visibleEditors[visibleEditors.length - 1] || editors[editors.length - 1];
    if (!editor) return { ok: false, reason: 'contenteditable editor not found' };
    editor.focus();
    if (editor.childNodes.length) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    const rect = editor.getBoundingClientRect();
    return {
      ok: document.activeElement === editor || editor.contains(document.activeElement),
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    };
  })()`);
  if (!focused?.ok) throw new CommandExecutionError(`Could not focus rich-text editor: ${focused?.reason ?? 'unknown error'}`);

  if (typeof page.focusWindow === 'function') {
    try { await page.focusWindow(); } catch { /* the clipboard write reports the actionable error */ }
  }
  if (typeof page.nativeClick === 'function' && focused.rect) {
    const x = Math.round(focused.rect.x + focused.rect.width / 2);
    const y = Math.round(focused.rect.y + focused.rect.height / 2);
    await page.nativeClick(x, y);
    await page.evaluate(`(() => {
      const editors = [...document.querySelectorAll('div[contenteditable="true"], [contenteditable="true"]')];
      const visibleEditors = editors.filter(node => node.offsetParent !== null);
      const editor = visibleEditors[visibleEditors.length - 1] || editors[editors.length - 1];
      if (!editor) return false;
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    })()`);
  }

  const written = await page.evaluate(clipboardWriteScript(source, plainTextFromHtml(source)));
  if (!written?.ok) throw new CommandExecutionError(`Could not write HTML to clipboard: ${written?.reason ?? 'unknown error'}`);

  const modifiers = platform === 'darwin' ? 4 : 2;
  try {
    await page.cdp('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'v', code: 'KeyV', modifiers,
      windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86,
    });
    await page.cdp('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'v', code: 'KeyV', modifiers,
      windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86,
    });
  } catch {
    await page.nativeKeyPress('v', platform === 'darwin' ? ['Meta'] : ['Ctrl']);
  }
  if (typeof page.wait === 'function') await page.wait(1);

  const result = await page.evaluate(editorReadScript());
  if (!result?.ok || !String(result.text ?? '').trim() || !RICH_NODE_PATTERN.test(String(result.html ?? ''))) {
    const actualHtml = String(result?.html ?? '');
    const actualText = String(result?.text ?? '');
    const tags = [...actualHtml.matchAll(/<([a-z0-9]+)/giu)].map(match => match[1].toLowerCase());
    throw new CommandExecutionError(
      `rich HTML content was not retained by the editor (htmlLength=${actualHtml.length}, textLength=${actualText.length}, tags=${tags.join(',') || 'none'})`,
    );
  }
  return { html: result.html, text: result.text };
}

export { plainTextFromHtml };
