'use strict';

// 酒馆宿主与角色对象访问；兼容浅角色对象和嵌套 data。
function createStAdapter(window) {
    function charExtensions(ch) {
        try {
            if (ch && ch.extensions && typeof ch.extensions === 'object') return ch.extensions;
            if (ch && ch.data && ch.data.extensions && typeof ch.data.extensions === 'object') return ch.data.extensions;
        } catch (e) {}
        return null;
    }

    function charWorldBook(ch) {
        try {
            if (ch && ch.character_book && typeof ch.character_book === 'object') return ch.character_book;
            if (ch && ch.data && ch.data.character_book && typeof ch.data.character_book === 'object') return ch.data.character_book;
        } catch (e) {}
        return null;
    }

    function characterDisplayName(ch) {
        try {
            const raw = ch && (ch.name || (ch.data && ch.data.name));
            return String(raw || '').trim();
        } catch (e) { return ''; }
    }

    function getHostWindow() {
        try {
            if (window.parent && window.parent !== window && window.parent.document) return window.parent;
        } catch (_) {}
        return window;
    }

    function getContextSafe() {
        if (!window.SillyTavern || typeof window.SillyTavern.getContext !== 'function') {
            throw new Error('SillyTavern.getContext() 不可用：请确认当前运行在 SillyTavern 原生扩展环境内');
        }
        return window.SillyTavern.getContext();
    }

    function currentCharacter() {
        const context = getContextSafe();
        try {
            if (context.characters && context.characterId != null) return context.characters[context.characterId];
        } catch (e) {}
        try {
            const st = hostWindow.SillyTavern_API || hostWindow.SillyTavern;
            if (st && st.characters && st.characterId != null) return st.characters[st.characterId];
        } catch (e) {}
        return null;
    }
    const hostWindow = getHostWindow();
    return { charExtensions, charWorldBook, characterDisplayName, getHostWindow, getContextSafe, currentCharacter };
}

module.exports = createStAdapter;
