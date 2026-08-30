import { CommandExecutionError } from '@sovovs/bycli/errors';

const API_BASE = 'https://api.weixin.qq.com/cgi-bin/component';
const REQUEST_TIMEOUT_MS = 30_000;

function text(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function redact(message, secrets = []) {
  let redacted = String(message ?? '');
  for (const secret of secrets) {
    const value = text(secret);
    if (!value) continue;
    redacted = redacted.replaceAll(value, '[REDACTED]');
    redacted = redacted.replaceAll(encodeURIComponent(value), '[REDACTED]');
  }
  redacted = redacted.replace(/([?&](?:component_access_token|access_token)=)[^&\s]*/giu, '$1[REDACTED]');
  return redacted;
}

async function postJson(path, body, { query = {}, fetchImpl = globalThis.fetch, secrets = [] } = {}) {
  if (typeof fetchImpl !== 'function') throw new CommandExecutionError('Weixin Open Platform requires fetch support');
  const url = new URL(`${API_BASE}/${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  let response;
  try {
    response = await fetchImpl(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new CommandExecutionError(`Weixin Open Platform ${path} request failed`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new CommandExecutionError(`Weixin Open Platform ${path} returned invalid JSON`);
  }
  if (!response.ok) throw new CommandExecutionError(`Weixin Open Platform ${path} returned HTTP ${response.status}`);
  if (payload?.errcode != null && payload.errcode !== 0) {
    const message = redact(payload.errmsg || 'unknown error', secrets);
    throw new CommandExecutionError(`Weixin Open Platform ${path} failed (${payload.errcode}): ${message}`);
  }
  return payload;
}

export async function getComponentAccessToken({
  componentAppid,
  componentAppsecret,
  componentVerifyTicket,
  fetchImpl = globalThis.fetch,
} = {}) {
  const payload = await postJson('api_component_token', {
    component_appid: componentAppid,
    component_appsecret: componentAppsecret,
    component_verify_ticket: componentVerifyTicket,
  }, {
    fetchImpl,
    secrets: [componentAppsecret, componentVerifyTicket],
  });
  const accessToken = text(payload?.component_access_token);
  if (!accessToken) {
    throw new CommandExecutionError('Weixin Open Platform api_component_token returned no component access token');
  }
  return accessToken;
}

export function normalizeAuthorizerProfile(payload, requestedAuthorizerAppid) {
  const requested = text(requestedAuthorizerAppid);
  const authorizerInfo = payload?.authorizer_info;
  if (!requested || !authorizerInfo || typeof authorizerInfo !== 'object' || Array.isArray(authorizerInfo)) {
    throw new CommandExecutionError('Weixin Open Platform returned an incomplete account profile');
  }
  const responseAppid = text(payload?.authorization_info?.authorizer_appid)
    ?? text(payload?.authorization_info?.authorization_appid);
  if (responseAppid && responseAppid !== requested) {
    throw new CommandExecutionError('Weixin Open Platform authorizer AppID did not match the request');
  }
  const nickname = text(authorizerInfo.nick_name);
  const username = text(authorizerInfo.user_name);
  const principalName = text(authorizerInfo.principal_name);
  if (!nickname || !username || !principalName) {
    throw new CommandExecutionError('Weixin Open Platform returned an incomplete account profile');
  }
  return {
    appid: requested,
    nickname,
    username,
    principal_name: principalName,
  };
}

export async function fetchAuthorizerProfile({
  componentAppid,
  componentAccessToken,
  authorizerAppid,
  fetchImpl = globalThis.fetch,
} = {}) {
  const payload = await postJson('api_get_authorizer_info', {
    component_appid: componentAppid,
    authorizer_appid: authorizerAppid,
  }, {
    query: { component_access_token: componentAccessToken },
    fetchImpl,
    secrets: [componentAccessToken],
  });
  return normalizeAuthorizerProfile(payload, authorizerAppid);
}
