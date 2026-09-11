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
    function apiForSession(api, session) {
        if (!api) return api;
        return new Proxy(api, {
            get(target, property) {
                assertCurrent(session);
                const value = Reflect.get(target, property, target);
                if (typeof value !== 'function') return value;
                return function (...args) {
                    assertCurrent(session);
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
    return { capture, isCurrent, assertCurrent, scopedChatKey, apiForSession };
}

module.exports = createRuntimeSession;
