const VOLATILE_QUERY_KEYS = new Set([
    'sessionid',
    'pass_ticket',
    'exportkey',
    'scene',
    'ascene',
    'devicetype',
    'version',
    'nettype',
    'abtest_cookie',
    'lang',
    'countrycode',
    'fontscale',
    'wx_header',
]);

export function normalizeArticleUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null;

    try {
        const raw = value.trim();
        const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

        parsed.hash = '';
        for (const key of [...parsed.searchParams.keys()]) {
            const normalizedKey = key.toLowerCase();
            if (VOLATILE_QUERY_KEYS.has(normalizedKey) || normalizedKey.startsWith('utm_')) {
                parsed.searchParams.delete(key);
            }
        }
        return parsed.toString();
    } catch {
        return null;
    }
}

export function toKnowledgeRow(item) {
    return {
        ...item,
        knowledgeBaseId: item.knowledgeBaseId || null,
        knowledgeBase: item.knowledgeBase,
        folderPath: Array.isArray(item.folderPath) ? item.folderPath : [],
        title: item.title,
        url: normalizeArticleUrl(item.url),
        contentType: item.contentType || null,
        addedDate: item.addedDate || null,
    };
}
