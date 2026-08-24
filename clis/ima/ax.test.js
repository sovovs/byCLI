import { describe, expect, it } from 'vitest';

import { __test__, parseDriverEnvelope } from './ax.js';

describe('ima AX driver contract', () => {
    it('targets ima and checks Accessibility permission', () => {
        expect(__test__.AX_KNOWLEDGE_SCRIPT).toContain('com.tencent.imamac');
        expect(__test__.AX_KNOWLEDGE_SCRIPT).toContain('AXIsProcessTrusted');
        expect(__test__.OPEN_KNOWLEDGE_APPLESCRIPT.join('\n')).toContain('知识库');
    });

    it('supports exact knowledge-base name and ID matching', () => {
        expect(__test__.AX_KNOWLEDGE_SCRIPT).toContain('query == candidate.name');
        expect(__test__.AX_KNOWLEDGE_SCRIPT).toContain('query == candidate.id');
    });

    it('tracks folders and reads public URLs before closing article windows', () => {
        expect(__test__.AX_KNOWLEDGE_SCRIPT).toContain('folderPath');
        expect(__test__.AX_KNOWLEDGE_SCRIPT).toContain('readPublicURL');
        expect(__test__.AX_KNOWLEDGE_SCRIPT).toContain('closeArticlePage');
    });

    it('guards full traversal and exact sidebar selection', () => {
        expect(__test__.AX_KNOWLEDGE_SCRIPT).toContain('sidebarTextElements');
        expect(__test__.AX_KNOWLEDGE_SCRIPT).toContain('AMBIGUOUS_KNOWLEDGE');
        expect(__test__.AX_KNOWLEDGE_SCRIPT).toContain('folderTargets');
        expect(__test__.AX_KNOWLEDGE_SCRIPT).toContain('visitedPages');
        expect(__test__.AX_KNOWLEDGE_SCRIPT).toContain('foldersAdded');
    });

    it('limits URL readiness to document locations and keeps row identities', () => {
        expect(__test__.AX_KNOWLEDGE_SCRIPT).toContain('isDocumentLocation');
        expect(__test__.AX_KNOWLEDGE_SCRIPT).toContain('ChromeAXNodeId');
        expect(__test__.AX_KNOWLEDGE_SCRIPT).toContain('reusedKnowledgeWindow');
    });
});

describe('parseDriverEnvelope', () => {
    it('returns successful driver data', () => {
        expect(parseDriverEnvelope('{"ok":true,"items":[]}')).toEqual({ ok: true, items: [] });
    });

    it('rejects non-JSON driver output', () => {
        expect(() => parseDriverEnvelope('swift warning')).toThrow('invalid JSON');
    });

    it('rejects envelopes without an ok flag', () => {
        expect(() => parseDriverEnvelope('{"items":[]}')).toThrow('missing ok flag');
    });
});
