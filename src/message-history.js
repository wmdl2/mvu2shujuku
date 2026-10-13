'use strict';

// The host owns replay. This adapter only prepares disposable, synchronous
// reads for author APIs which cannot return a Promise.
function createMessageHistory(deps) {
    let generation = null;
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    // Keep a read-only property snapshot of the host's JSON graph. Primitive
    // strings stay shared, so unchanged SQL/JSON cells need no re-encoding.
    // Parent references and every child property are checked: an in-place edit
    // cannot hide behind an unchanged storage-container reference.
    function captureProperties(roots) {
        const seen = new WeakSet(), records = [], pending = [];
        const add = value => {
            if (value && typeof value === 'object' && !seen.has(value)) {
                seen.add(value); pending.push(value);
            }
        };
        for (const root of roots) {
            if (root && typeof root === 'object') JSON.stringify(root); // Reject non-serializable host storage as before.
            add(root);
        }
        for (let index = 0; index < pending.length; index++) {
            const object = pending[index];
            if (typeof object.toJSON === 'function') {
                records.push({ object, serialized: true, encoded: JSON.stringify(object) });
                continue;
            }
            const keys = Object.keys(object);
            const dense = Array.isArray(object) && keys.length === object.length
                && keys.every((key, index) => key === String(index));
            const values = keys.map(key => object[key]);
            records.push({ object, keys: dense ? null : keys, values, length: Array.isArray(object) ? object.length : null });
            values.forEach(add);
        }
        return records;
    }
    function propertiesMatch(records) {
        for (const record of records) {
            if (record.serialized) {
                if (JSON.stringify(record.object) !== record.encoded) return false;
                continue;
            }
            if (record.length !== null && record.object.length !== record.length) return false;
            if (record.keys) {
                const keys = Object.keys(record.object);
                if (keys.length !== record.keys.length) return false;
                for (let index = 0; index < keys.length; index++) {
                    if (keys[index] !== record.keys[index] || record.object[keys[index]] !== record.values[index]) return false;
                }
            } else {
                for (let index = 0; index < record.values.length; index++) {
                    if (record.object[index] !== record.values[index]) return false;
                }
            }
        }
        return true;
    }
    function failure(code, message) {
        const error = new Error(message); error.code = code; return error;
    }
    function capture() {
        const api = deps.readApi(), chat = deps.readChat();
        if (!api || typeof api.exportTableSnapshotsAtMessages !== 'function') return null;
        const runtime = api.exportTableAsJson?.();
        const session = deps.readSessionKey(), layout = deps.readLayoutKey();
        const slotsMatch = generation && generation.slots.length === chat.length && generation.slots.every((slot, index) =>
            slot.swipe === chat[index]?.swipe_id && slot.storage === chat[index]?.TavernDB_ACU_IsolatedData);
        if (!generation || generation.api !== api || generation.chat !== chat
            || generation.runtime !== runtime || generation.session !== session || generation.layout !== layout
            || !slotsMatch || !propertiesMatch(generation.properties)) {
            const slots = chat.map(message => ({ swipe: message?.swipe_id, storage: message?.TavernDB_ACU_IsolatedData }));
            generation = { api, chat, runtime, session, layout, slots,
                properties: captureProperties([layout, ...slots.map(slot => slot.storage)]), values: new Map(), pending: new Set() };
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
            const snapshots = new Map();
            for (const snapshot of result.snapshots || []) {
                if (!snapshots.has(snapshot.messageIndex)) snapshots.set(snapshot.messageIndex, snapshot);
            }
            let yieldedAt = Date.now();
            for (const index of missing) {
                const snapshot = snapshots.get(index);
                const value = snapshot && deps.project(snapshot.data, index);
                if (!value) throw failure('MVU_HISTORY_UNAVAILABLE', '数据库历史快照缺失或不符合当前转换布局');
                candidates.set(index, clone(value));
                if (typeof deps.yieldToHost === 'function' && Date.now() - yieldedAt >= 8) {
                    await deps.yieldToHost();
                    if (!current(owner)) throw failure('MVU_HISTORY_CONTEXT_CHANGED', '历史读取期间聊天或数据库状态已变化');
                    yieldedAt = Date.now();
                }
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
