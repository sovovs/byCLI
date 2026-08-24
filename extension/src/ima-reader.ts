const READER_ORIGIN = 'https://ima.qq.com';
const READER_PREFIX = '/cgi-bin/knowledge_tab_reader/';
const READER_PATHS = new Set([
  '/get_knowledge_base_list',
  '/get_knowledge_list',
]);
const AUTH_SOURCE_PATHS = new Set([
  '/cgi-bin/activity_tab/get_available_activities',
]);
const AUTH_TTL_MS = 30_000;

type ReaderHeaders = Record<string, string>;

type ReaderSession = {
  authId: string;
  expiresAt: number;
  headers: ReaderHeaders;
};

function normalizedHeaders(headers: Record<string, unknown> | undefined): ReaderHeaders {
  const allowed = new Set([
    'x-ima-cookie', 'x-ima-bkn', 'extension_version', 'from_browser_ima',
  ]);
  return Object.fromEntries(Object.entries(headers ?? {})
    .map(([name, value]) => [name.toLowerCase(), String(value)] as const)
    .filter(([name]) => allowed.has(name)));
}

export function isImaReaderRequest(url: string | undefined): boolean {
  try {
    const parsed = new URL(url ?? '');
    return parsed.origin === READER_ORIGIN
      && (parsed.pathname.startsWith(READER_PREFIX) || AUTH_SOURCE_PATHS.has(parsed.pathname));
  } catch {
    return false;
  }
}

function imaBknFromCookie(cookie: string): string | null {
  const token = cookie.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('IMA-TOKEN='))
    ?.slice('IMA-TOKEN='.length);
  if (!token) return null;
  let hash = 5381;
  for (const character of token) hash += (hash << 5) + character.charCodeAt(0);
  return String(hash & 0x7fffffff);
}

export class ImaReaderAuthStore {
  private readonly sessions = new Map<number, ReaderSession>();

  capture(tabId: number, request: { url?: string; headers?: Record<string, unknown> }): boolean {
    if (!isImaReaderRequest(request.url)) return false;
    const headers = normalizedHeaders(request.headers);
    if (!headers['x-ima-cookie']) return false;
    headers['x-ima-bkn'] ??= imaBknFromCookie(headers['x-ima-cookie']) ?? '';
    if (!headers['x-ima-bkn']) return false;
    const existing = this.sessions.get(tabId);
    this.sessions.set(tabId, {
      authId: existing && existing.expiresAt > Date.now() ? existing.authId : crypto.randomUUID(),
      expiresAt: Date.now() + AUTH_TTL_MS,
      headers,
    });
    return true;
  }

  read(tabId: number): { authId: string } | null {
    const session = this.sessions.get(tabId);
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(tabId);
      return null;
    }
    return { authId: session.authId };
  }

  async request<T>(
    tabId: number,
    authId: string,
    path: string,
    body: Record<string, unknown>,
    perform: (headers: ReaderHeaders, body: Record<string, unknown>) => Promise<T>,
  ): Promise<T> {
    if (!READER_PATHS.has(path)) throw new Error(`ima reader path is not allowed: ${path}`);
    const session = this.sessions.get(tabId);
    if (session?.authId === authId) {
      if (session.expiresAt <= Date.now()) this.sessions.delete(tabId);
      else return perform(session.headers, body);
    }
    throw new Error('ima reader authentication is missing or expired');
  }

  release(authId: string): void {
    for (const [tabId, session] of this.sessions) {
      if (session.authId === authId) this.sessions.delete(tabId);
    }
  }
}
