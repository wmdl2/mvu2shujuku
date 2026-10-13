'use strict';

// The host owns replay. This adapter only prepares disposable, synchronous
// reads for author APIs which cannot return a Promise.
function createMessageHistory(deps) {
    let generation = null;
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    function failure(code, message) {
        const error = new Error(message); error.code = code; return error;
    }
    function capture() {
        const api = deps.readApi(), chat = deps.readChat();
        if (!api || typeof api.exportTableSnapshotsAtMessages !== 'function') return null;
        const runtime = api.exportTableAsJson?.();
        const key = JSON.stringify([deps.readSessionKey(), deps.readLayoutKey(),
            chat.map(message => [message?.swipe_id, message?.TavernDB_ACU_IsolatedData])]);
        if (!generation || generation.api !== api || generation.chat !== chat
            || generation.runtime !== runtime || generation.key !== key) {
            generation = { api, chat, runtime, key, values: new Map(), pending: new Set() };
        }
        return generation;
    }
    function current(owner) { return capture() === owner; }
    async function prepare(indices) {
        const owner = capture();
        if (!owner) return false;
        const requested = [...new Set(indices)].filter(index => Number.isInteger(index)
            && index >= 0 && index < owner.chat.length);
        // Share in-flight batches. Failures are not cached, so a later explicit
        // preparation can recover after the host has finished loading.
        if (owner.pending.size) await Promise.all([...owner.pending]);
        if (!current(owner)) throw failure('MVU_HISTORY_CONTEXT_CHANGED', '历史读取期间聊天或数据库状态已变化');
        const missing = requested.filter(index => !owner.values.has(index));
        if (!missing.length) return true;
        const task = (async () => {
            const result = await owner.api.exportTableSnapshotsAtMessages(missing);
            if (!current(owner)) throw failure('MVU_HISTORY_CONTEXT_CHANGED', '历史读取期间聊天或数据库状态已变化');
            if (!result?.success) {
                const error = failure('MVU_HISTORY_UNAVAILABLE', result?.error || '数据库历史回放失败');
                error.historyCode = result?.code; error.failurePoint = result?.failurePoint; throw error;
            }
            const candidates = new Map();
            for (const index of missing) {
                const snapshot = result.snapshots?.find(item => item.messageIndex === index);
                const value = snapshot && deps.project(snapshot.data, index);
                if (!value) throw failure('MVU_HISTORY_UNAVAILABLE', '数据库历史快照缺失或不符合当前转换布局');
                candidates.set(index, clone(value));
            }
            if (!current(owner)) throw failure('MVU_HISTORY_CONTEXT_CHANGED', '历史读取期间聊天或数据库状态已变化');
            for (const [index, value] of candidates) owner.values.set(index, value);
        })();
        owner.pending.add(task);
        try { await task; } finally { owner.pending.delete(task); }
        return true;
    }
    function read(index) {
        const owner = capture();
        if (!owner) return deps.readFallback(index);
        if (!owner.values.has(index)) {
            // Prime on demand, but never disguise a pending/failed SQL replay as
            // an empty variable object or current-floor data.
            prepare([index]).catch(deps.onError || (() => {}));
            throw failure('MVU_HISTORY_NOT_READY', '历史状态尚未准备完成，请等待状态栏就绪后读取');
        }
        return clone(owner.values.get(index));
    }
    function invalidate() { generation = null; }
    return { prepare, read, invalidate };
}

module.exports = createMessageHistory;
