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
      for (let current = node; current && current.nodeType === 1; current = current.parentElement) {
        const style = window.getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      }
      return true;
    };
    const selectors = [
      'a[href]',
      'button',
      '[role="tab"]',
      '.weui-desktop-tab__nav',
      '.tab_nav',
      'li',
    ];
    let node = null;
    for (const selector of selectors) {
      node = Array.from(document.querySelectorAll(selector)).find(candidate => visible(candidate)
        && compact(candidate.textContent) === ${JSON.stringify(label)});
      if (node) break;
    }
    if (!node) return { selected: false, disabled: false, href: null };
    const disabled = node.disabled === true
      || node.getAttribute('aria-disabled') === 'true'
      || /(^|\\s)(disabled|is-disabled)(\\s|$)/.test(node.className || '');
    if (disabled) return { selected: false, disabled: true, href: null };
    const rawHref = node.tagName === 'A' ? node.getAttribute('href') : null;
    if (rawHref) {
      const href = node.href;
      let destination = null;
      try { destination = new URL(href); } catch { /* handled as a click-only placeholder */ }
      const trustedNavigation = destination
        && destination.origin === window.location.origin
        && destination.pathname === '/cgi-bin/settingpage'
        && Boolean(destination.searchParams.get('token'));
      if (trustedNavigation) return { selected: true, disabled: false, href };
      const clickOnly = /^javascript:/i.test(rawHref)
        || rawHref.charAt(0) === '#'
        || (destination
          && destination.origin === window.location.origin
          && destination.pathname === '/cgi-bin/settingpage');
      if (!clickOnly) return { selected: true, disabled: false, href };
    }
    node.click();
    return { selected: true, disabled: false, href: null };
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
    for (let current = node; current && current.nodeType === 1; current = current.parentElement) {
      const style = window.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    }
    return true;
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
    for (let current = node; current && current.nodeType === 1; current = current.parentElement) {
      const style = window.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    }
    return true;
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
    const fieldRows = new Set();
    const genericParts = node => Array.from(node.children).flatMap(child => {
      if (!visible(child)
        || /^(H1|H2|H3|H4|H5|H6|A|BUTTON)$/.test(child.tagName)
        || child.getAttribute('role') === 'button') return [];
      const copy = child.cloneNode(true);
      copy.querySelectorAll('a, button, [role="button"], svg, .setting_opr, .weui-desktop-setting__status, .setting_status, .status')
        .forEach(item => item.remove());
      const value = compact(copy.textContent);
      return value ? [value] : [];
    });

    for (const row of rows) {
      const headerCells = row.tagName === 'TR' ? row.querySelectorAll(':scope > th') : [];
      const dataCells = row.tagName === 'TR' ? row.querySelectorAll(':scope > td') : [];
      if (headerCells.length > 0 && dataCells.length === 0) continue;
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
      let fieldStatus = compact(statusNode && statusNode.textContent);
      if (valueNode) {
        const copy = valueNode.cloneNode(true);
        copy.querySelectorAll('a, button, [role="button"], .setting_opr, .weui-desktop-setting__status, .setting_status, .status')
          .forEach(node => node.remove());
        fieldValue = compact(copy.textContent);
      }
      if (fieldValue === null) {
        const parts = genericParts(row);
        const labelIndex = parts.indexOf(fieldLabel);
        if (labelIndex !== -1) {
          fieldValue = parts[labelIndex + 1] || null;
          if (fieldStatus === null && parts.length > labelIndex + 2) {
            fieldStatus = parts.slice(labelIndex + 2).join(' ');
          }
        }
      }
      const item = {
        label: fieldLabel,
        value: fieldValue,
        status: fieldStatus,
      };
      const key = JSON.stringify(item);
      if (!seenFields.has(key)) {
        seenFields.add(key);
        fields.push(item);
      }
      fieldRows.add(row);
    }

    let genericRows = Array.from(sectionNode.querySelectorAll('div, li'))
      .filter(node => visible(node)
        && !fieldRows.has(node)
        && !rows.some(row => row !== node && row.contains(node))
        && genericParts(node).length >= 2);
    genericRows = genericRows.filter(node => !genericRows.some(other => other !== node && node.contains(other)));
    for (const row of genericRows) {
      const parts = genericParts(row);
      const item = {
        label: parts[0],
        value: parts[1] || null,
        status: parts.length > 2 ? parts.slice(2).join(' ') : null,
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
    if (fields.length > 0 || actions.length > 0) return [{ label, fields, actions }];
    const empty = Boolean(sectionNode.querySelector('table thead th, table tr > th'));
    return empty ? [{ label, fields, actions, empty: true }] : [];
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
    return fields.length > 0 || actions.length > 0 || section.empty === true
      ? [{ label, fields, actions }]
      : [];
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
    if (selection.href !== null && selection.href !== undefined) {
      let navigationUrl;
      try {
        navigationUrl = new URL(selection.href);
      } catch {
        throw new CommandExecutionError('WeChat account settings exposed an invalid tab destination');
      }
      execution(
        navigationUrl.origin === ORIGIN
          && Boolean(navigationUrl.searchParams.get('token')?.trim()),
        'WeChat account settings exposed an untrusted tab destination',
      );
      await page.goto(navigationUrl.toString());
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
