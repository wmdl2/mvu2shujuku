'use strict';

// TavernHelper variable operations share one database projection and commit path.
// Non-message stores are owned by the helper; their defaults and receivers stay native.
function createVariableApi(options) {
    'use strict';
    const { lodash, readDatabase, replaceDatabase, assertCurrent, assertWritable } = options;
    const names = ['getVariables', 'replaceVariables', 'updateVariablesWith',
        'insertOrAssignVariables', 'insertVariables', 'deleteVariable'];
    const databaseScope = opts => opts && opts.type === 'message';
    const clone = value => lodash.cloneDeep(value);
    const stateKeys = new Set(['stat_data']);
    const auxiliary = wrap => Object.fromEntries(Object.entries(wrap || {}).filter(([key]) => !stateKeys.has(key)));
    function mergeRead(native, database) {
        const result = Object.assign({}, native, database);
        for (const name of ['display_data', 'delta_data', 'initialized_lorebooks']) {
            if (native && Object.prototype.hasOwnProperty.call(native, name)) result[name] = native[name];
        }
        return clone(result);
    }
    function messageViews(item) {
        if (!Number.isInteger(item?.message_id)) return null;
        const swipe = item.swipe_id ?? 0;
        const hasData = Object.hasOwn(item, 'data');
        const hasSwipe = Number.isInteger(swipe) && swipe >= 0 && Array.isArray(item.swipes_data)
            && Object.hasOwn(item.swipes_data, swipe);
        return hasData || hasSwipe ? { hasData, hasSwipe, swipe } : null;
    }
    function projectMessages(list) {
        if (!Array.isArray(list)) return list;
        return list.map(item => {
            const views = messageViews(item);
            if (!views) return item;
            const { stat_data, display_data } = options.readMessageVariables(item.message_id, item.swipe_id);
            const project = data => ({ ...data, stat_data: clone(stat_data || {}),
                display_data: data?.display_data ?? clone(display_data ?? stat_data ?? {}) });
            const result = { ...item };
            if (views.hasData) result.data = project(item.data);
            if (views.hasSwipe) {
                result.swipes_data = item.swipes_data.slice();
                result.swipes_data[views.swipe] = project(item.swipes_data[views.swipe]);
            }
            return result;
        });
    }
    function staleWriteTarget() {
        const error = new Error('变量写入所属的消息或候选已切换，已停止更新');
        error.code = 'MVU_VARIABLE_CONTEXT_STALE';
        throw error;
    }
    function requireWriteTarget(opts, expected) {
        assertCurrent();
        const target = assertWritable(opts);
        if (expected && (target?.message !== expected.message || target?.index !== expected.index || target?.swipe !== expected.swipe)) {
            staleWriteTarget();
        }
        return target;
    }
    function mark(fn, native) {
        fn.__mvu2shujuku = true;
        if (typeof native !== 'function') return fn;
        fn.__mvu2shujukuNative = native.__mvu2shujukuNative || native;
        // The helper injects iframe functions with fn.bind(window). Preserve the
        // native bound function too, so switching cards can restore that frame.
        Object.defineProperty(fn, 'bind', { configurable: true, value(receiver, ...args) {
            return mark(Function.prototype.bind.call(fn, receiver, ...args),
                Function.prototype.bind.call(fn.__mvu2shujukuNative, receiver, ...args));
        } });
        return fn;
    }
    function bind(native, receiver) {
        const call = (name, args) => {
            if (typeof native[name] !== 'function') throw new Error('酒馆助手未提供变量接口：' + name);
            return native[name].apply(receiver, args);
        };
        const read = opts => {
            if (!databaseScope(opts)) return call('getVariables', [opts]);
            assertCurrent();
            const nativeRead = typeof native.getVariables === 'function' ? call('getVariables', [opts]) : {};
            return mergeRead(nativeRead, readDatabase(opts));
        };
        const replace = async (value, opts, expected) => {
            const target = requireWriteTarget(opts, expected);
            if (value?.__mvu2shujukuReadUnavailable === true) {
                const error = new Error('不能提交数据库尚未加载时读取的变量表');
                error.code = 'MVU_DATA_NOT_READY';
                throw error;
            }
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('变量表必须是对象');
            const before = read(opts), next = value;
            if (!lodash.isEqual(before.stat_data || {}, next.stat_data || {})) {
                // Preserve the original schema proof and nonenumerable processing
                // token. Cloning here would validate/transform parsed state twice.
                const saved = await replaceDatabase(Object.prototype.hasOwnProperty.call(next, 'stat_data')
                    ? next : { ...next, stat_data: {} }, opts);
                if (saved === false) throw new Error('数据库未能保存变量，原更新未完成');
            }
            requireWriteTarget(opts, target);
            // stat_data in native message variables contains only the independent
            // native portion. Never copy the database projection into that store.
            const aux = auxiliary(next);
            if (!lodash.isEqual(auxiliary(before), aux)) {
                const nativeState = options.nativeState && options.nativeState(opts);
                await call('replaceVariables', [nativeState === undefined ? aux : { ...aux, stat_data: nativeState }, opts]);
                requireWriteTarget(opts, target);
            }
        };
        const api = {
            getVariables: read,
            replaceVariables(value, opts) {
                return databaseScope(opts) ? replace(value, opts) : call('replaceVariables', [value, opts]);
            },
            updateVariablesWith(updater, opts) {
                if (!databaseScope(opts)) return call('updateVariablesWith', [updater, opts]);
                return (async () => {
                    const target = requireWriteTarget(opts);
                    const next = await updater(read(opts));
                    await replace(next, opts, target);
                    return next;
                })();
            },
            insertOrAssignVariables(value, opts) {
                if (!databaseScope(opts)) return call('insertOrAssignVariables', [value, opts]);
                return api.updateVariablesWith(old => lodash.mergeWith(old, value,
                    (_left, right) => Array.isArray(right) ? right : undefined), opts);
            },
            insertVariables(value, opts) {
                if (!databaseScope(opts)) return call('insertVariables', [value, opts]);
                return api.updateVariablesWith(old => lodash.mergeWith({}, value, old,
                    (_left, right) => Array.isArray(right) ? right : undefined), opts);
            },
            deleteVariable(path, opts) {
                if (!databaseScope(opts)) return call('deleteVariable', [path, opts]);
                return (async () => {
                    let deleteOccurred;
                    const variables = await api.updateVariablesWith(old => {
                        deleteOccurred = lodash.unset(old, path);
                        return old;
                    }, opts);
                    return { variables, delete_occurred: deleteOccurred };
                })();
            },
        };
        for (const name of names) mark(api[name], native[name]);
        if (typeof native.getAllVariables === 'function' && options.readAll) {
            api.getAllVariables = mark(() => {
                assertCurrent();
                const original = native.getAllVariables.call(receiver);
                try { return mergeRead(original, options.readAll(receiver)); }
                catch (error) {
                    if (!['MVU_DATA_NOT_READY', 'MVU_HISTORY_NOT_READY'].includes(error.code)) throw error;
                    // Native getAllVariables may run before MVU is initialized.
                    // Preserve only the helper's actual variables for read-only
                    // UI fallback, never fabricate DB defaults/current history.
                    options.onUnavailableRead?.(receiver);
                    return Object.defineProperty(clone(original), '__mvu2shujukuReadUnavailable', { value: true });
                }
            }, native.getAllVariables);
        }
        if (typeof native.getChatMessages === 'function' && options.readMessageVariables) {
            api.getChatMessages = mark(function (...args) {
                assertCurrent();
                const result = native.getChatMessages.apply(receiver, args);
                return result && typeof result.then === 'function' ? result.then(async list => {
                    assertCurrent();
                    const indices = Array.isArray(list) ? list.filter(messageViews).map(item => item.message_id) : [];
                    await options.prepareMessages(indices);
                    assertCurrent();
                    return projectMessages(list);
                }) : projectMessages(result);
            }, native.getChatMessages);
        }
        if (typeof native.setChatMessages === 'function') {
            api.setChatMessages = mark(async function (messages, ...args) {
                assertCurrent();
                const items = Array.isArray(messages) ? messages : [];
                const writes = items.filter(item => item && Object.hasOwn(item, 'data'));
                // TavernHelper treats data as a single-page update even when the
                // getter's compatibility fields also include swipes_data.
                if (items.some(item => item && !Object.hasOwn(item, 'data')
                    && Array.isArray(item.swipes_data) && item.swipes_data.some(data => data && Object.hasOwn(data, 'stat_data')))) {
                    throw new Error('暂不支持通过 swipes_data 写入独立 MVU 状态');
                }
                if (writes.length > 1) throw new Error('一次更新多个消息变量暂不支持，请逐条提交');
                const [item] = writes;
                if (item && !Number.isInteger(item.message_id)) throw new TypeError('消息变量写入必须指定整数 message_id');
                const opts = item && { type: 'message', message_id: item.message_id };
                const target = item && requireWriteTarget(opts);
                if (target && Number.isInteger(item.swipe_id) && target.swipe !== item.swipe_id) staleWriteTarget();
                await options.beforeChatMutation?.();
                assertCurrent();
                if (!item) return call('setChatMessages', [messages, ...args]);
                await replace(item.data, opts, target);
                requireWriteTarget(opts, target);
                const stored = call('getVariables', [opts]);
                const nativeMessage = { ...item, data: stored };
                delete nativeMessage.swipes_data;
                return call('setChatMessages', [items.map(value => value === item ? nativeMessage : value), ...args]);
            }, native.setChatMessages);
        }
        return api;
    }
    function bindIframe(nativeBindings) {
        const bindings = { ...nativeBindings };
        const native = Object.fromEntries([...names, 'getAllVariables'].map(name => [name,
            nativeBindings['_' + name]?.__mvu2shujukuNative || nativeBindings['_' + name]]));
        for (const name of [...names, 'getAllVariables']) {
            if (typeof native[name] !== 'function') continue;
            bindings['_' + name] = mark(function (...args) {
                return bind(native, this)[name](...args);
            }, native[name]);
        }
        return bindings;
    }
    function reloadInitial(data, initial, book) {
        assertCurrent();
        if (!data || typeof data !== 'object') return false;
        if (!data.initialized_lorebooks || Array.isArray(data.initialized_lorebooks)) data.initialized_lorebooks = {};
        if (Object.prototype.hasOwnProperty.call(data.initialized_lorebooks, book)) return false;
        data.initialized_lorebooks[book] = [];
        data.stat_data = { ...clone(initial), ...data.stat_data };
        return true;
    }
    function messageIdForWindow(receiver) {
        const id = String(receiver.__TH_IFRAME_ID || receiver.frameElement?.id || receiver.name || '');
        if (id.startsWith('TH-script--')) return 'latest';
        return typeof receiver.getCurrentMessageId === 'function' ? receiver.getCurrentMessageId() : 'latest';
    }
    return { bind, bindIframe, reloadInitial, messageIdForWindow, names };
}

module.exports = createVariableApi;
