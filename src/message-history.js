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
    function historySourceKey(api) {
        // Optional public source identity. Never infer isolation from equal data
        // or persisted/private settings; old hosts retain the runtime guard.
        if (typeof api.getTableHistoryContext !== 'function') return null;
        try {
            const context = api.getTableHistoryContext();
            const id = value => typeof value === 'string' || typeof value === 'number' && Number.isFinite(value);
            if (!context || context.version !== 1 || !id(context.chatId) || context.chatId === ''
                || context.characterId != null && !id(context.characterId)
                || context.groupId != null && !id(context.groupId) || typeof context.isolationKey !== 'string') return null;
            return JSON.stringify([context.chatId, context.characterId ?? null, context.groupId ?? null, context.isolationKey]);
        } catch (_) { return null; }
    }
    function capture() {
        const api = deps.readApi(), chat = deps.readChat();
        if (!api || typeof api.exportTableSnapshotsAtMessages !== 'function') return null;
        const source = historySourceKey(api);
        const runtime = source === null ? api.exportTableAsJson?.() : null;
        const session = deps.readSessionKey(), layout = deps.readLayoutKey();
        const old = generation;
        const contextChanged = !old || old.api !== api || old.chat !== chat
            || old.source !== source || old.runtime !== runtime || old.session !== session || old.layout !== layout
            || !propertiesMatch(old.layoutProperties);
        // A replay at floor N only depends on the prefix through N. Appending
        // or changing a later floor must not throw away earlier committed reads.
        // Without the optional public source contract, runtime replacement
        // remains a full boundary: value equality is no proof of isolation.
        let changed = contextChanged || old.slots.length !== chat.length;
        let firstChanged = contextChanged ? 0 : Math.min(old.slots.length, chat.length);
        const slots = chat.map((message, index) => {
            const previous = !contextChanged && old.slots[index];
            const swipe = message?.swipe_id, storage = message?.TavernDB_ACU_IsolatedData;
            if (previous && previous.swipe === swipe
                && previous.storage === storage && propertiesMatch(previous.properties)) return previous;
            changed = true;
            firstChanged = Math.min(firstChanged, index);
            return { swipe, storage, properties: captureProperties([storage]) };
        });
        if (!changed) return old;
        generation = { api, chat, source, runtime, session, layout, slots,
            layoutProperties: contextChanged ? captureProperties([layout]) : old.layoutProperties,
            values: new Map(old && !contextChanged ? [...old.values].filter(([index]) => index < firstChanged) : []),
            pending: new Set() };
        return generation;
    }
    function current(owner) { return capture() === owner; }
    async function prepare(indices) {
        const owner = capture();
        if (!owner) return false;
        const requested = [...new Set(indices)].filter(index => Number.isInteger(index)
            && index >= 0 && index < owner.chat.length);
        // Cached floors do not depend on an unrelated cold replay in flight.
        if (requested.every(index => owner.values.has(index))) return true;
        // Share in-flight batches. Failures are not cached, so a later explicit
        // preparation can recover after the host has finished loading.
        // Another waiter may start a new batch after the one we awaited ends.
        // Recheck before claiming missing floors, while keeping ready reads fast.
        while (owner.pending.size) {
            await Promise.all([...owner.pending]);
            if (!current(owner)) throw failure('MVU_HISTORY_CONTEXT_CHANGED', '历史读取期间聊天或数据库状态已变化');
            if (requested.every(index => owner.values.has(index))) return true;
        }
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
    function read(index, options) {
        const owner = capture();
        if (!owner) return deps.readFallback(index);
        if (!owner.values.has(index)) {
            // Prime on demand, but never disguise a pending/failed SQL replay as
            // an empty variable object or current-floor data.
            prepare([index]).catch(deps.onError || (() => {}));
            throw failure('MVU_HISTORY_NOT_READY', '历史状态尚未准备完成，请等待状态栏就绪后读取');
        }
        // Only the internal TH adapter defers this copy: its mergeRead always
        // clones the complete public result. EJS/ordinary reads keep a private
        // copy here, including callers whose second argument is a swipe index.
        const value = owner.values.get(index);
        return options?.copy === false ? value : clone(value);
    }
    function invalidate() { generation = null; }
    return { prepare, read, invalidate };
}

module.exports = createMessageHistory;
