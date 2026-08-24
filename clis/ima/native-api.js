const MEDIA_TYPE_NAMES = new Map([
    [0, '未知'], [1, 'PDF'], [2, '网址'], [3, 'WORD'], [4, 'PPT'],
    [5, 'EXCEL'], [6, '公众号'], [7, 'MD'], [9, '图片'], [11, '笔记'],
    [12, '问答'], [13, 'TXT'], [14, 'XMIND'], [15, '音频'], [16, '视频网站'],
    [19, '播客'], [20, 'HTML'], [21, 'EPUB'], [98, '源代码'], [99, '文件夹'],
]);
function field(value, camelName, snakeName) {
    return value?.[camelName] ?? value?.[snakeName];
}

function codedError(code, message) {
    return Object.assign(new Error(message), { code });
}

function knowledgeBaseFromRaw(raw) {
    const basicInfo = field(raw, 'basicInfo', 'basic_info') || {};
    return {
        id: String(field(raw, 'id', 'id') || ''),
        name: String(field(basicInfo, 'name', 'name') || ''),
    };
}

function basesFromGroups(response) {
    const groups = field(response, 'results', 'results');
    if (!Array.isArray(groups)) throw new Error('ima API returned malformed knowledge-base groups');
    return groups.flatMap((group) => {
        const list = field(group, 'knowledgeBaseList', 'knowledge_base_list');
        return Array.isArray(list) ? list.map(knowledgeBaseFromRaw) : [];
    });
}

export async function findKnowledgeBase(query, request) {
    const initialGroups = [
        { type: 1001, limit: 20 },
        { type: 1002, limit: 20 },
        { type: 1004, limit: 20 },
        { type: 1005, limit: 50 },
    ];
    let response = await request('/get_knowledge_base_list', {
        params: initialGroups.map(({ type, limit }) => ({ type, cursor: '', limit })),
    });
    const all = [];
    const pendingPages = [];
    const queuedPages = new Set();

    for (;;) {
        if (Number(response?.code) !== 0) {
            throw new Error(response?.msg || `ima API error ${response?.code ?? 'unknown'}`);
        }
        all.push(...basesFromGroups(response));
        const groups = field(response, 'results', 'results');
        for (const group of groups) {
            const cursor = field(group, 'nextCursor', 'next_cursor');
            if (field(group, 'isEnd', 'is_end') === false) {
                const type = Number(field(group, 'type', 'type'));
                if (!cursor) {
                    throw new Error(`ima API returned a missing cursor for knowledge-base group ${type}`);
                }
                const pageKey = `${type}:${cursor}`;
                if (queuedPages.has(pageKey)) {
                    throw new Error(`ima API returned a repeated cursor for knowledge-base group ${type}`);
                }
                queuedPages.add(pageKey);
                pendingPages.push({
                    type,
                    cursor: String(cursor),
                    limit: 10,
                });
            }
        }
        const next = pendingPages.shift();
        if (!next) break;
        response = await request('/get_knowledge_base_list', {
            params: [next],
        });
    }

    const matches = all.filter((base) => base.id === query || base.name === query);
    if (matches.length === 0) {
        throw codedError('KNOWLEDGE_NOT_FOUND', `Knowledge base "${query}" was not found`);
    }
    const unique = [...new Map(matches.map((base) => [base.id, base])).values()];
    if (unique.length > 1) {
        throw codedError('AMBIGUOUS_KNOWLEDGE', `Knowledge base name "${query}" is ambiguous`);
    }
    return unique[0];
}

function articleFromRaw(raw, knowledgeBaseId, knowledgeBaseName, folderPath) {
    const mediaType = Number(field(raw, 'mediaType', 'media_type') ?? 0);
    const jumpUrl = field(raw, 'jumpUrl', 'jump_url');
    const sourcePath = field(raw, 'sourcePath', 'source_path');
    return {
        knowledgeBaseId,
        knowledgeBase: knowledgeBaseName,
        folderPath,
        title: field(raw, 'title', 'title') || '',
        url: jumpUrl || (/^https?:\/\//i.test(sourcePath || '') ? sourcePath : null),
        contentType: MEDIA_TYPE_NAMES.get(mediaType) ?? String(mediaType),
        addedDate: field(raw, 'timeWording', 'time_wording')
            || field(raw, 'createTime', 'create_time')
            || null,
    };
}

export async function collectKnowledgeTree({ knowledgeBaseId, knowledgeBaseName, request }) {
    const articles = [];
    const pendingFolders = [{ id: '', path: [] }];
    const visitedFolders = new Set();

    while (pendingFolders.length > 0) {
        const folder = pendingFolders.shift();
        if (visitedFolders.has(folder.id)) continue;
        visitedFolders.add(folder.id);
        let cursor = '';
        const visitedCursors = new Set();

        do {
            if (visitedCursors.has(cursor)) {
                throw new Error(`ima API returned a repeated cursor for folder ${folder.id || 'root'}`);
            }
            visitedCursors.add(cursor);
            const response = await request('/get_knowledge_list', {
                cursor,
                limit: 20,
                knowledge_base_id: knowledgeBaseId,
                need_default_cover: true,
                ...(folder.id ? { folder_id: folder.id } : {}),
                ext_info: { share_id: '' },
            });
            if (Number(response?.code) !== 0) {
                throw new Error(response?.msg || `ima API error ${response?.code ?? 'unknown'}`);
            }

            const items = field(response, 'knowledgeList', 'knowledge_list');
            if (!Array.isArray(items)) throw new Error('ima API returned malformed knowledge_list');
            for (const item of items) {
                const mediaType = Number(field(item, 'mediaType', 'media_type') ?? 0);
                if (mediaType === 99) {
                    const info = field(item, 'folderInfo', 'folder_info') || {};
                    const id = field(info, 'folderId', 'folder_id');
                    const name = field(info, 'name', 'name');
                    if (id && name) pendingFolders.push({ id, path: [...folder.path, name] });
                    continue;
                }
                articles.push(articleFromRaw(item, knowledgeBaseId, knowledgeBaseName, folder.path));
            }

            const isEnd = field(response, 'isEnd', 'is_end') !== false;
            cursor = String(field(response, 'nextCursor', 'next_cursor') || '');
            if (!isEnd && !cursor) {
                throw new Error(`ima API returned a missing cursor for folder ${folder.id || 'root'}`);
            }
            if (isEnd) cursor = '';
        } while (cursor);
    }

    return articles;
}

export async function readKnowledgeBaseFromApi(query, request) {
    const knowledgeBase = await findKnowledgeBase(query, request);
    const items = await collectKnowledgeTree({
        knowledgeBaseId: knowledgeBase.id,
        knowledgeBaseName: knowledgeBase.name,
        request,
    });
    return { ok: true, items };
}
