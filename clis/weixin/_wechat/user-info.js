import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';

const DOMAIN = 'mp.weixin.qq.com';
const ORIGIN = `https://${DOMAIN}`;

export const TAB_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'account_details', label: '账号详情' }),
  Object.freeze({ id: 'feature_settings', label: '功能设置' }),
  Object.freeze({ id: 'authorization_management', label: '授权管理' }),
]);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function execution(condition, message) {
  if (!condition) throw new CommandExecutionError(message);
}

function text(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().replace(/\s+/g, ' ');
  return normalized || null;
}

export function buildSettingsUrl(token) {
  if (typeof token !== 'string' || !token.trim()) {
    throw new ArgumentError('token is required');
  }
  const parameters = new URLSearchParams({
    t: 'setting/index',
    action: 'index',
    token,
    lang: 'zh_CN',
  });
  return `${ORIGIN}/cgi-bin/settingpage?${parameters}`;
}

export function sanitizeActionPath(value) {
  if (typeof value !== 'string' || !value.trim() || /^javascript:/i.test(value.trim())) {
    return null;
  }
  try {
    const url = new URL(value, ORIGIN);
    return url.origin === ORIGIN ? url.pathname : null;
  } catch {
    return null;
  }
}

export function buildSelectTabScript(label) {
  return `(() => {
    const compact = value => String(value || '').trim().replace(/\\s+/g, ' ');
    const visible = node => {
      if (!node || node.hidden || node.closest('[hidden], [aria-hidden="true"]')) return false;
      const style = window.getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const candidates = Array.from(document.querySelectorAll([
      '[role="tab"]',
      '.weui-desktop-tab__nav',
      '.tab_nav',
      'a',
      'button',
      'li',
    ].join(',')));
    const node = candidates.find(candidate => visible(candidate)
      && compact(candidate.textContent) === ${JSON.stringify(label)});
    if (!node) return { selected: false, disabled: false };
    const disabled = node.disabled === true
      || node.getAttribute('aria-disabled') === 'true'
      || /(^|\\s)(disabled|is-disabled)(\\s|$)/.test(node.className || '');
    if (disabled) return { selected: false, disabled: true };
    node.click();
    return { selected: true, disabled: false };
  })()`;
}

export const SETTINGS_SESSION_SCRIPT = `(() => {
  const selectors = [
    'form[action*="login"]',
    'img[src*="qrcode"]',
    'canvas[class*="qrcode"]',
  ];
  const visible = node => {
    if (!node || node.hidden || node.closest('[hidden], [aria-hidden="true"]')) return false;
    const style = window.getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  return {
    href: window.location.href,
    hasLoginUi: selectors.some(selector => Array.from(document.querySelectorAll(selector)).some(visible))
      || /扫码登录|使用微信扫码/.test(document.body && document.body.innerText || ''),
  };
})()`;

export function assertSettingsSessionState(payload) {
  execution(object(payload) && typeof payload.href === 'string',
    'WeChat account settings returned an unreadable page state');
  if (payload.hasLoginUi === true) {
    throw new AuthRequiredError(DOMAIN, 'WeChat account settings login has expired');
  }
  let url;
  try {
    url = new URL(payload.href);
  } catch {
    throw new CommandExecutionError('WeChat account settings returned an invalid page URL');
  }
  if (url.origin === ORIGIN
    && (url.pathname === '/' || /login/i.test(url.pathname) || !url.searchParams.get('token')?.trim())) {
    throw new AuthRequiredError(DOMAIN, 'WeChat account settings login has expired');
  }
  execution(url.origin === ORIGIN && url.pathname === '/cgi-bin/settingpage',
    'WeChat account settings redirected to an unexpected page');
}

export const USER_INFO_EXTRACT_SCRIPT = `(() => {
  const compact = value => {
    const normalized = String(value || '').trim().replace(/\\s+/g, ' ');
    return normalized || null;
  };
  const visible = node => {
    if (!node || node.hidden || node.closest('[hidden], [aria-hidden="true"]')) return false;
    const style = window.getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  const firstVisible = (root, selectors) => {
    for (const selector of selectors) {
      const matched = Array.from(root.querySelectorAll(selector)).find(visible);
      if (matched) return matched;
    }
    return null;
  };
  const actionNodes = root => Array.from(root.querySelectorAll('a, button, [role="button"]'))
    .filter(node => {
      if (!visible(node)) return false;
      const label = compact(node.textContent || node.getAttribute('aria-label') || node.title);
      const hint = [node.className, node.title, node.getAttribute('aria-label')].join(' ');
      return label && !/(help|question|icon-question|帮助|说明)/i.test(hint);
    });
  const action = node => ({
    label: compact(node.textContent || node.getAttribute('aria-label') || node.title),
    enabled: !(node.disabled === true
      || node.getAttribute('aria-disabled') === 'true'
      || /(^|\\s)(disabled|is-disabled)(\\s|$)/.test(node.className || '')),
    href: node.tagName === 'A' && node.getAttribute('href') ? node.href : null,
  });
  const rowSelectors = [
    '.setting_item',
    '.weui-desktop-setting__item',
    '.weui-desktop-form__control-group',
    'tr',
    'dl',
  ];
  const sectionSelectors = [
    '.setting_area',
    '.weui-desktop-panel',
    '.weui-desktop-card',
    'section',
  ];
  const rowSelector = rowSelectors.join(',');
  let sectionNodes = Array.from(document.querySelectorAll(sectionSelectors.join(',')))
    .filter(visible);
  sectionNodes = sectionNodes.filter(node => !sectionNodes.some(other => other !== node && other.contains(node)));
  if (sectionNodes.length === 0) {
    const fallbackRows = Array.from(document.querySelectorAll(rowSelector)).filter(visible);
    if (fallbackRows.length > 0) sectionNodes = [document.body];
  }

  const sections = sectionNodes.flatMap(sectionNode => {
    const heading = firstVisible(sectionNode, [
      '.setting_area_hd h3',
      '.setting_area_hd',
      '.weui-desktop-panel__title',
      '.weui-desktop-card__title',
      'h2',
      'h3',
      'h4',
    ]);
    const label = compact(heading && heading.textContent)
      || compact(sectionNode.getAttribute('aria-label'))
      || '其他信息';
    let rows = Array.from(sectionNode.querySelectorAll(rowSelector)).filter(visible);
    rows = rows.filter(node => !rows.some(other => other !== node && other.contains(node)));
    const fields = [];
    const actions = [];
    const seenFields = new Set();
    const seenActions = new Set();

    for (const row of rows) {
      const labelNode = firstVisible(row, [
        '.frm_label',
        '.weui-desktop-setting__label',
        '.weui-desktop-form__label',
        'dt',
        'th',
      ]);
      const fieldLabel = compact(labelNode && labelNode.textContent);
      const rowActions = actionNodes(row);
      for (const node of rowActions) {
        const item = action(node);
        const key = JSON.stringify(item);
        if (!seenActions.has(key)) {
          seenActions.add(key);
          actions.push(item);
        }
      }
      if (!fieldLabel) continue;
      const valueNode = firstVisible(row, [
        '.weui-desktop-setting__value',
        '.setting_value',
        '.frm_value',
        'dd',
        'td',
        '.frm_controls',
      ]);
      const statusNode = firstVisible(row, [
        '.weui-desktop-setting__status',
        '.setting_status',
        '.status',
      ]);
      let fieldValue = null;
      if (valueNode) {
        const copy = valueNode.cloneNode(true);
        copy.querySelectorAll('a, button, [role="button"], .setting_opr, .weui-desktop-setting__status, .setting_status, .status')
          .forEach(node => node.remove());
        fieldValue = compact(copy.textContent);
      }
      const item = {
        label: fieldLabel,
        value: fieldValue,
        status: compact(statusNode && statusNode.textContent),
      };
      const key = JSON.stringify(item);
      if (!seenFields.has(key)) {
        seenFields.add(key);
        fields.push(item);
      }
    }

    const rowSet = new Set(rows);
    for (const node of actionNodes(sectionNode)) {
      if (rows.some(row => rowSet.has(row) && row.contains(node))) continue;
      const item = action(node);
      const key = JSON.stringify(item);
      if (!seenActions.has(key)) {
        seenActions.add(key);
        actions.push(item);
      }
    }
    return fields.length > 0 || actions.length > 0 ? [{ label, fields, actions }] : [];
  });

  if (sections.length === 0 && /(无权限|暂无权限|暂不支持|不可用)/.test(document.body.textContent || '')) {
    return { available: false, sections: [] };
  }
  return { available: true, sections };
})()`;

function normalizeField(field, tabLabel, sectionIndex, fieldIndex) {
  const prefix = `WeChat ${tabLabel} returned an invalid field at section ${sectionIndex} index ${fieldIndex}`;
  execution(object(field), prefix);
  const label = text(field.label);
  execution(label, prefix);
  return {
    label,
    value: text(field.value),
    status: text(field.status),
  };
}

function normalizeAction(action, tabLabel, sectionIndex, actionIndex) {
  const prefix = `WeChat ${tabLabel} returned an invalid action at section ${sectionIndex} index ${actionIndex}`;
  execution(object(action), prefix);
  const label = text(action.label);
  execution(label, prefix);
  return {
    label,
    enabled: action.enabled !== false,
    path: sanitizeActionPath(action.href ?? action.path),
  };
}

export function normalizeUserInfoTab(tabId, payload) {
  const definition = TAB_DEFINITIONS.find(tab => tab.id === tabId);
  execution(definition, `WeChat account settings returned an unknown tab: ${String(tabId)}`);
  execution(object(payload), `WeChat ${definition.label} returned an unreadable payload`);

  if (payload.available === false) {
    return { label: definition.label, available: false, sections: [] };
  }

  execution(Array.isArray(payload.sections), `WeChat ${definition.label} returned an invalid section list`);
  const sections = payload.sections.flatMap((section, sectionIndex) => {
    const prefix = `WeChat ${definition.label} returned an invalid section at index ${sectionIndex}`;
    execution(object(section), prefix);
    const label = text(section.label);
    execution(label, prefix);
    const rawFields = section.fields ?? [];
    const rawActions = section.actions ?? [];
    execution(Array.isArray(rawFields) && Array.isArray(rawActions), prefix);
    const fields = rawFields.map((field, fieldIndex) => (
      normalizeField(field, definition.label, sectionIndex, fieldIndex)
    ));
    const actions = rawActions.map((action, actionIndex) => (
      normalizeAction(action, definition.label, sectionIndex, actionIndex)
    ));
    return fields.length > 0 || actions.length > 0 ? [{ label, fields, actions }] : [];
  });

  execution(sections.length > 0, `WeChat ${definition.label} exposed no recognizable settings`);
  return { label: definition.label, available: true, sections };
}

export async function collectUserInfoTabs(page, { settle = 2 } = {}) {
  const result = [];
  let recognizedTabs = 0;
  for (const definition of TAB_DEFINITIONS) {
    const selection = await page.evaluate(buildSelectTabScript(definition.label));
    if (!selection?.selected && !selection?.disabled) {
      result.push({
        id: definition.id,
        data: normalizeUserInfoTab(definition.id, { available: false, sections: [] }),
      });
      continue;
    }
    recognizedTabs += 1;
    if (selection.disabled) {
      result.push({
        id: definition.id,
        data: normalizeUserInfoTab(definition.id, { available: false, sections: [] }),
      });
      continue;
    }
    await page.wait(settle);
    const payload = await page.evaluate(USER_INFO_EXTRACT_SCRIPT);
    result.push({ id: definition.id, data: normalizeUserInfoTab(definition.id, payload) });
  }
  if (recognizedTabs === 0) {
    throw new CommandExecutionError(
      'WeChat account settings did not expose any recognized tabs',
      'Reload the Official Account settings page and run the command again.',
    );
  }
  return result;
}
