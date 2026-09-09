import { listKnowledgeBases, readKnowledgeBaseFromApi } from './native-api.js';

const IMA_WIKIS_URL = 'https://ima.qq.com/wikis';
const IMA_GET_MEDIA_URL = 'https://ima.qq.com/cgi-bin/file_manager/get_media';
const IMA_READER_URL = 'https://ima.qq.com/cgi-bin/knowledge_tab_reader';

function imaBknFromCookie(cookie) {
    const token = String(cookie).split(';').map((part) => part.trim())
        .find((part) => part.startsWith('IMA-TOKEN='))?.slice('IMA-TOKEN='.length);
    if (!token) return '';
    let hash = 5381;
    for (const character of token) hash += (hash << 5) + character.charCodeAt(0);
    return String(hash & 0x7fffffff);
}

function directImaRequest(page, dependencies = {}) {
    const imaCookie = dependencies.imaCookie ?? process.env.BYCLI_IMA_COOKIE;
    if (!imaCookie || !page || typeof page.fetchJson !== 'function') return null;
    const headers = {
        'x-ima-cookie': String(imaCookie),
        'x-ima-bkn': dependencies.imaBkn ?? imaBknFromCookie(imaCookie),
        from_browser_ima: '1',
        extension_version: String(dependencies.extensionVersion ?? process.env.BYCLI_IMA_EXTENSION_VERSION ?? '2.1.23'),
    };
    return (path, body) => page.fetchJson(`${IMA_READER_URL}${path}`, {
        method: 'POST', headers, body,
    });
}

function codedError(code, message) {
    return Object.assign(new Error(message), { code });
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForImaAuth(page, timeoutMs, sleep) {
    const deadline = Date.now() + timeoutMs;
    do {
        const auth = await page.readImaAuth();
        if (auth?.authId) return auth.authId;
        if (Date.now() >= deadline) break;
        await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
    } while (true);
    throw codedError(
        'IMA_CHROME_AUTH_REQUIRED',
        'ima reader authentication was not observed in the Chrome session',
    );
}

async function triggerImaAuthRequest(page, query) {
    await page.evaluate((knowledgeBase) => {
        const candidates = [...document.querySelectorAll('._knowledgeListItem_xfmpc_1')];
        const target = candidates.find((element) => element.innerText?.trim() === knowledgeBase)
            ?? candidates[0];
        if (!target) return false;
        target.click();
        return true;
    }, query);
}

async function acquireImaChromeAuth(page, query, dependencies = {}) {
    if (!page || typeof page.startImaAuthCapture !== 'function'
        || typeof page.readImaAuth !== 'function' || typeof page.requestImaReader !== 'function'
        || typeof page.evaluate !== 'function') {
        throw codedError(
            'IMA_CHROME_AUTH_REQUIRED',
            'The installed bycli Browser Bridge does not support private ima reader authentication',
        );
    }
    const timeoutMs = dependencies.timeoutMs ?? 30_000;
    const sleep = dependencies.sleep ?? wait;
    try {
        await page.startImaAuthCapture();
        await page.goto(IMA_WIKIS_URL);
        await triggerImaAuthRequest(page, query);
        return await waitForImaAuth(page, timeoutMs, sleep);
    } catch (error) {
        if (error?.code === 'IMA_CHROME_AUTH_REQUIRED') throw error;
        throw codedError(
            'IMA_CHROME_AUTH_REQUIRED',
            `Chrome Browser Bridge could not acquire ima reader authentication: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

async function releaseImaAuth(page, authId) {
    if (typeof page.releaseImaAuth === 'function') {
        await page.releaseImaAuth(authId).catch(() => {});
    }
}

export async function readKnowledgeBasesFromChrome(page, dependencies = {}) {
    const directRequest = directImaRequest(page, dependencies);
    if (directRequest) return listKnowledgeBases(directRequest);
    const authId = await acquireImaChromeAuth(page, undefined, dependencies);
    try {
        return await listKnowledgeBases((path, body) => page.requestImaReader(authId, path, body));
    } finally {
        await releaseImaAuth(page, authId);
    }
}

export async function readKnowledgeBaseFromChrome(page, query, dependencies = {}) {
    const directRequest = directImaRequest(page, dependencies);
    if (directRequest) return readKnowledgeBaseFromApi(query, directRequest);
    const authId = await acquireImaChromeAuth(page, query, dependencies);
    try {
        return await readKnowledgeBaseFromApi(
            query,
            (path, body) => page.requestImaReader(authId, path, body),
        );
    } finally {
        await releaseImaAuth(page, authId);
    }
}

export async function readImaMediaUrl(page, item, dependencies = {}) {
    const imaCookie = dependencies.imaCookie ?? process.env.BYCLI_IMA_COOKIE;
    if (imaCookie && page && typeof page.fetchJson === 'function') {
        const response = await page.fetchJson(IMA_GET_MEDIA_URL, {
            method: 'POST',
            headers: {
                'x-ima-cookie': String(imaCookie),
                'x-ima-bkn': dependencies.imaBkn ?? imaBknFromCookie(imaCookie),
                from_browser_ima: '1',
                extension_version: String(dependencies.extensionVersion ?? process.env.BYCLI_IMA_EXTENSION_VERSION ?? '2.1.23'),
            },
            body: {
                knowledge_base_id: String(item?.knowledgeBaseId ?? ''),
                media_id: String(item?.mediaId ?? ''),
                scene: dependencies.scene ?? 4,
            },
        });
        const data = response && typeof response === 'object' ? response : {};
        const url = data.jumpUrlInfo?.url ?? data.jump_url_info?.url;
        if (Number(data.action) !== 1 || typeof url !== 'string' || !url) {
            throw codedError('IMA_ORIGINAL_URL_UNAVAILABLE', data.toastText || data.toast_text || 'IMA did not return an exportable file URL');
        }
        return url;
    }
    if (typeof page.requestImaMedia === 'function' && typeof page.startImaAuthCapture === 'function') {
        const authId = await acquireImaChromeAuth(page, item?.knowledgeBaseId, dependencies);
        try {
            const response = await page.requestImaMedia(authId, {
                knowledge_base_id: String(item?.knowledgeBaseId ?? ''),
                media_id: String(item?.mediaId ?? ''),
                scene: dependencies.scene ?? 4,
                ...(item?.shareId ? { share_id: String(item.shareId) } : {}),
                ...(item?.sourceKnowledgeBaseId ? { source_knowledge_base_id: String(item.sourceKnowledgeBaseId) } : {}),
            });
            const data = response && typeof response === 'object' ? response : {};
            const url = data.jumpUrlInfo?.url ?? data.jump_url_info?.url;
            if (Number(data.action) !== 1 || typeof url !== 'string' || !url) {
                throw codedError('IMA_ORIGINAL_URL_UNAVAILABLE', data.toastText || data.toast_text || 'IMA did not return an exportable file URL');
            }
            return url;
        } finally {
            await releaseImaAuth(page, authId);
        }
    }
    if (!page || typeof page.fetchJson !== 'function') {
        throw codedError('IMA_ORIGINAL_URL_UNAVAILABLE', 'IMA browser page cannot call get_media');
    }
    const response = await page.fetchJson(IMA_GET_MEDIA_URL, {
        method: 'POST',
        body: {
            knowledgeBaseId: String(item?.knowledgeBaseId ?? item?.knowledge_base_id ?? ''),
            mediaId: String(item?.mediaId ?? item?.media_id ?? ''),
            scene: dependencies.scene ?? 4,
        },
    });
    const data = response && typeof response === 'object' ? response : {};
    const url = data.jumpUrlInfo?.url ?? data.jump_url_info?.url;
    if (Number(data.action) !== 1 || typeof url !== 'string' || !url) {
        throw codedError('IMA_ORIGINAL_URL_UNAVAILABLE', data.toastText || data.toast_text || 'IMA did not return an exportable file URL');
    }
    return url;
}
