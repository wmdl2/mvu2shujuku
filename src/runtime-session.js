'use strict';

// 唯一会话代次与隐式目标 API 守卫；身份读取由 ST 适配层提供。
function createRuntimeSession(readIdentity) {
    let key = '', epoch = 0;
    function capture(validate) {
        const identity = readIdentity();
        const next = JSON.stringify([identity.characterKey, identity.groupKey, identity.chatKey]);
        if (next !== key) { key = next; epoch += 1; }
        return { key, epoch, chatKey: identity.chatKey, cardKey: identity.cardKey,
            ...(typeof validate === 'function' ? { validate } : {}) };
    }
    function isCurrent(session) {
        if (!session) return false;
        const current = capture();
        if (current.key !== session.key || current.epoch !== session.epoch) return false;
        try { return typeof session.validate !== 'function' || session.validate() === true; }
        catch (_) { return false; }
    }
    function assertCurrent(session) {
        if (isCurrent(session)) return;
        const error = new Error('会话或任务来源已变化，取消旧任务');
        error.code = 'MVU_SESSION_CHANGED';
        throw error;
    }
    function scopedChatKey(chatKey) {
        const parts = JSON.parse(capture().key);
        parts[2] = String(chatKey || 'unknown');
        return JSON.stringify(parts);
    }
    // Public writers target the AI reply visible when they are called, not a later reply.
    // All helpers live inside the factory because the browser serializes it with toString().
    function bindWriteTarget(session, readChat) {
        if (session.writeTarget) return session; // retries retain the original message identity
        const chat = readChat();
        if (!Array.isArray(chat)) return session;
        const latestIndex = rows => {
            for (let i = rows.length - 1; i >= 0; i--) if (rows[i] && !rows[i].is_user) return i;
            return -1;
        };
        const index = latestIndex(chat);
        if (index < 0) return session;
        const message = chat[index], swipe = message.swipe_id, text = message.mes ?? message.message;
        const sourceCurrent = () => {
            const current = readChat();
            return Array.isArray(current) && latestIndex(current) === index && current[index] === message
                && message.swipe_id === swipe && (message.mes ?? message.message) === text;
        };
        const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
        const isFrame = tag => isRecord(tag) && isRecord(tag.storageFrame)
            && tag.storageFrame.version === 2 && Array.isArray(tag.storageFrame.logEntries);
        const canUseCrud = () => {
            if (!sourceCurrent()) return false;
            if (index === 0) return true; // no earlier AI reply exists; preserve opening behavior
            const current = readChat(), targetTags = message.TavernDB_ACU_IsolatedData;
            // No public active-isolation getter exists in the tested SP API. Prove the floor
            // for EVERY possible scope instead: any earlier tag must also have a V2 frame here.
            // If a scope has no history, SP already falls back to the latest AI reply.
            for (let i = index; i >= 0; i--) {
                const row = current[i];
                if (!row || row.is_user) continue;
                if (row.TavernDB_ACU_IndependentData || row.TavernDB_ACU_Data || row.TavernDB_ACU_SummaryData) return false;
                const tags = row.TavernDB_ACU_IsolatedData;
                if (tags == null) continue;
                // Unknown / serialized legacy formats use the safe snapshot path, not guesses.
                if (!isRecord(tags)) return false;
                for (const key of Object.keys(tags)) {
                    if (!isFrame(tags[key]) || !isRecord(targetTags)
                        || !Object.prototype.hasOwnProperty.call(targetTags, key) || !isFrame(targetTags[key])) return false;
                }
            }
            return true;
        };
        return { ...session, writeTarget: { index, canUseCrud },
            validate: () => isCurrent(session) && sourceCurrent() };
    }
    function apiForSession(api, session) {
        if (!api) return api;
        return new Proxy(api, {
            get(target, property) {
                assertCurrent(session);
                const value = Reflect.get(target, property, target);
                if (typeof value !== 'function') return value;
                return function (...args) {
                    assertCurrent(session);
                    if (session.writeTarget && ['updateCell', 'updateRow', 'insertRow', 'deleteRow'].includes(property)
                        && !session.writeTarget.canUseCrud()) {
                        const error = new Error('当前回复尚无可靠表格记录，取消旧楼 CRUD 并重新规划快照');
                        error.code = 'MVU_WRITE_FLOOR_CHANGED';
                        throw error;
                    }
                    const result = value.apply(target, args);
                    if (result && typeof result.then === 'function') {
                        return Promise.resolve(result).then(out => { assertCurrent(session); return out; });
                    }
                    assertCurrent(session);
                    return result;
                };
            },
        });
    }
    return { capture, isCurrent, assertCurrent, scopedChatKey, bindWriteTarget, apiForSession };
}

module.exports = createRuntimeSession;
