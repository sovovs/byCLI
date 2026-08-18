// Shared helpers for the GitHub adapters that hit the public REST API
// (api.github.com). No browser, no cookies — `GITHUB_TOKEN` is optional and
// only raises the rate limit (60/hr → 5000/hr core, 10/min → 30/min search).
import { ArgumentError, CommandExecutionError, EmptyResultError, RateLimitedError } from '@sovovs/bycli/errors';

export const GITHUB_API = 'https://api.github.com';
const UA = 'bycli-github-adapter (+https://github.com/sovovs/byCLI)';

// owner/repo full names: owner is 1-39 chars of alnum/hyphen, repo adds ._-
const FULL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/;

export function requireString(value, label) {
    const s = String(value ?? '').trim();
    if (!s) throw new ArgumentError(`github ${label} cannot be empty`);
    return s;
}

export function requireFullName(value) {
    const s = String(value ?? '').trim().replace(/^https?:\/\/(?:www\.)?github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
    if (!s) throw new ArgumentError('github repo is required (e.g. "facebook/react")');
    if (!FULL_NAME.test(s)) {
        throw new ArgumentError(
            `github repo "${value}" is not a valid "owner/repo" name`,
            'Pass the full name from a search row, e.g. "facebook/react" (or its github.com URL).',
        );
    }
    return s;
}

export function requireBoundedInt(value, defaultValue, maxValue, label = 'limit') {
    const raw = value ?? defaultValue;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
        throw new ArgumentError(`github ${label} must be a positive integer`);
    }
    if (n > maxValue) {
        throw new ArgumentError(`github ${label} must be <= ${maxValue}`);
    }
    return n;
}

function authHeaders() {
    const token = String(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '').trim();
    return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * Build a `>N` / `<N` / `>=N` / `A..B` numeric range qualifier from a raw arg.
 *
 * GitHub accepts `stars:>100`, `stars:>=100`, `stars:<50`, `stars:10..50` and
 * `stars:100..*`. A bare number is treated as `>=N`, which is what people mean
 * by "at least 1000 stars" — exact-match `stars:1000` is almost never wanted.
 */
export function buildRangeQualifier(field, value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    const compact = raw.replace(/\s+/g, '');
    if (/^\d+$/.test(compact)) return `${field}:>=${compact}`;
    if (/^(?:>=|<=|>|<)\d+$/.test(compact)) return `${field}:${compact}`;
    if (/^\d+\.\.(?:\d+|\*)$/.test(compact)) return `${field}:${compact}`;
    if (/^\*\.\.\d+$/.test(compact)) return `${field}:${compact}`;
    throw new ArgumentError(
        `github --${field} value "${raw}" is not a valid numeric filter`,
        'Use a bare number (>=N), a comparison (">100", ">=100", "<50"), or a range ("10..50", "100..*").',
    );
}

/** Same idea for date fields (`pushed`, `created`): ISO date or comparison/range. */
export function buildDateQualifier(field, value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    const compact = raw.replace(/\s+/g, '');
    const D = '\\d{4}-\\d{2}-\\d{2}';
    if (new RegExp(`^${D}$`).test(compact)) return `${field}:>=${compact}`;
    if (new RegExp(`^(?:>=|<=|>|<)${D}$`).test(compact)) return `${field}:${compact}`;
    if (new RegExp(`^${D}\\.\\.(?:${D}|\\*)$`).test(compact)) return `${field}:${compact}`;
    if (new RegExp(`^\\*\\.\\.${D}$`).test(compact)) return `${field}:${compact}`;
    throw new ArgumentError(
        `github --${field} value "${raw}" is not a valid date filter`,
        'Use YYYY-MM-DD (>=date), a comparison (">2026-01-01"), or a range ("2025-01-01..2026-01-01").',
    );
}

export async function githubFetch(url, label, { allow404 = true } = {}) {
    let resp;
    try {
        resp = await fetch(url, {
            headers: {
                'user-agent': UA,
                accept: 'application/vnd.github+json',
                'x-github-api-version': '2022-11-28',
                ...authHeaders(),
            },
            redirect: 'follow',
        });
    }
    catch (err) {
        throw new CommandExecutionError(
            `${label} request failed: ${err?.message ?? err}`,
            'Check that api.github.com is reachable from this network.',
        );
    }
    if (resp.status === 404 && allow404) {
        throw new EmptyResultError(label, `GitHub API returned 404 for ${url}.`);
    }
    // GitHub signals both rate limiting and abuse detection with 403/429.
    if (resp.status === 403 || resp.status === 429) {
        const remaining = resp.headers.get('x-ratelimit-remaining');
        const reset = Number(resp.headers.get('x-ratelimit-reset'));
        const waitHint = Number.isFinite(reset) && reset > 0
            ? ` Limit resets at ${new Date(reset * 1000).toISOString()}.`
            : '';
        if (remaining === '0' || resp.status === 429) {
            throw new RateLimitedError(
                `${label} hit the GitHub API rate limit (HTTP ${resp.status})`,
                `Unauthenticated search allows 10 req/min.${waitHint} Set GITHUB_TOKEN to raise it to 30 req/min.`,
            );
        }
        throw new CommandExecutionError(
            `${label} was refused by GitHub (HTTP 403)`,
            'The API may require authentication for this resource; set GITHUB_TOKEN.',
        );
    }
    if (resp.status === 422) {
        let detail = '';
        try {
            const body = await resp.json();
            const fields = Array.isArray(body?.errors)
                ? body.errors.map((e) => e?.field ?? e?.message).filter(Boolean).join(', ')
                : '';
            detail = fields ? ` (${fields})` : (body?.message ? ` (${body.message})` : '');
        }
        catch { /* body already unreadable; fall through with no detail */ }
        throw new ArgumentError(
            `${label} was rejected by GitHub as an invalid query${detail}`,
            'Check the qualifier syntax; GitHub rejects malformed values like "stars:abc".',
        );
    }
    if (!resp.ok) {
        throw new CommandExecutionError(`${label} returned HTTP ${resp.status}`);
    }
    let body;
    try {
        body = await resp.json();
    }
    catch (err) {
        throw new CommandExecutionError(`${label} returned malformed JSON: ${err?.message ?? err}`);
    }
    return body;
}
