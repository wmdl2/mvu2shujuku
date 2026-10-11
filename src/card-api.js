'use strict';

// Per-session compatibility; no external code is executed during conversion.
function createCardApi(options) {
    const { readMetadata, isCurrent, readMvu } = options;
    const schemas = new Map();
    const proofs = new WeakMap();
    const proofOwner = {};
    let revision = 0;
    const clone = value => JSON.parse(JSON.stringify(value));
    function registerSchema(schema, key) {
        if (!isCurrent() || !(readMetadata().schemaKeys || []).includes(key)) return false;
        if (typeof schema !== 'function' && (!schema || typeof schema.safeParse !== 'function')) return false;
        if (schemas.get(key) !== schema) revision++;
        schemas.set(key, schema); return true;
    }
    async function ready() {
        if (!isCurrent()) throw new Error('Schema 所属会话已变化');
        const expected = readMetadata().schemaKeys || [];
        for (let retry = 0; expected.some(key => !schemas.has(key)) && options.wait && retry < 40; retry++) {
            await options.wait(250); if (!isCurrent()) throw new Error('Schema 等待期间会话已变化');
        }
        if (expected.some(key => !schemas.has(key))) throw new Error('原卡 Schema 尚未登记，已停止写入');
    }
    function proofOf(stat) { return stat && typeof stat === 'object' ? proofs.get(stat) : undefined; }
    async function validate(stat, proof) {
        await ready();
        let result = clone(stat || {}); delete result.$internal;
        const keys = readMetadata().schemaKeys || [], keySignature = JSON.stringify(keys);
        // A parsed candidate can reach persistence via cloned/merged snapshots. Skip
        // a second transform only when its entire value and schema registration match.
        const reusable = !keys.some(key => typeof schemas.get(key) === 'function');
        proof = proof || proofOf(stat);
        if (reusable && proof?.owner === proofOwner && proof.revision === revision && proof.keys === keySignature && proof.value === JSON.stringify(result)) {
            proofs.set(result, proof); return result;
        }
        for (const key of keys) {
            if (!schemas.has(key)) throw new Error('原卡 Schema 尚未登记，已停止写入');
            const provider = schemas.get(key), schema = typeof provider === 'function' ? provider() : provider;
            if (!schema || typeof schema.safeParse !== 'function') throw new Error('原卡 Schema 无效');
            const parsed = typeof schema.safeParseAsync === 'function' ? await schema.safeParseAsync(clone(result)) : schema.safeParse(clone(result));
            if (!isCurrent()) throw new Error('Schema 校验期间会话已变化');
            if (!parsed.success) throw new Error('原卡 Schema 校验失败：' + String(parsed.error?.message || '无效数据'));
            if (!parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) throw new Error('原卡 Schema 必须返回 stat_data 对象');
            result = clone(parsed.data);
        }
        if (reusable) proofs.set(result, { owner: proofOwner, revision, keys: keySignature, value: JSON.stringify(result) });
        return result;
    }
    // 状态恢复只借用无业务副作用的原 Zod 检查，不重新运行 transform/provider。
    async function stateImportRules() {
        await ready();
        const registered = (readMetadata().schemaKeys || []).map(key => schemas.get(key)), capturedRevision = revision;
        const assertCurrent = () => { if (!isCurrent() || revision !== capturedRevision) throw new Error('目标 Schema 已更新，请重新导入'); };
        const unwrap = schema => {
            while (['optional', 'nonoptional', 'nullable', 'readonly', 'default', 'prefault'].includes(schema?._zod?.def?.type)) schema = schema._zod.def.innerType;
            return schema;
        };
        const safeChecks = def => (def.checks || []).every(check => {
            const kind = check?._zod?.def?.check;
            if (typeof check?._zod?.def?.fn === 'function') return false;
            return ['greater_than', 'less_than', 'multiple_of', 'number_format', 'string_format', 'min_length', 'max_length', 'length_equals', 'min_size', 'max_size', 'size_equals', 'mime_type'].includes(kind);
        });
        function inert(schema, depth = 0) {
            const def = schema?._zod?.def;
            if (!def || depth > 48 || !safeChecks(def)) return false;
            if (['optional', 'nonoptional', 'nullable', 'readonly'].includes(def.type)) return inert(def.innerType, depth + 1);
            if (def.type === 'object') return Object.values(def.shape).every(child => inert(child, depth + 1)) && (!def.catchall || inert(def.catchall, depth + 1));
            if (def.type === 'record') return inert(def.keyType, depth + 1) && inert(def.valueType, depth + 1);
            if (def.type === 'array') return inert(def.element, depth + 1);
            return ['string', 'number', 'boolean', 'enum', 'literal', 'null', 'undefined', 'any', 'unknown', 'never', 'nan'].includes(def.type);
        }
        function pure(schema, value, depth = 0) {
            if (depth > 48) return false;
            const def = schema?._zod?.def;
            if (!def || !safeChecks(def)) return false;
            if (['optional', 'nonoptional', 'nullable', 'readonly'].includes(def.type)) return value === undefined && def.type === 'optional' ? inert(def.innerType, depth + 1) : value === null && def.type === 'nullable' || pure(def.innerType, value, depth + 1);
            // 值存在时 Zod 不调用默认函数；缺失时不能为了恢复进度生成默认值。
            if (['default', 'prefault'].includes(def.type)) return value !== undefined && pure(def.innerType, value, depth + 1);
            if (def.type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
                && Object.entries(def.shape).every(([k, child]) => pure(child, value[k], depth + 1))
                && (!def.catchall || Object.keys(value).every(k => Object.hasOwn(def.shape, k) || pure(def.catchall, value[k], depth + 1)));
            if (def.type === 'record') return value !== null && typeof value === 'object' && !Array.isArray(value)
                && Object.entries(value).every(([k, v]) => pure(def.keyType, k, depth + 1) && pure(def.valueType, v, depth + 1));
            if (def.type === 'array') return Array.isArray(value) && value.every(v => pure(def.element, v, depth + 1));
            return ['string', 'number', 'boolean', 'enum', 'literal', 'null', 'undefined', 'any', 'unknown', 'never', 'nan'].includes(def.type);
        }
        function shape(schema, depth = 0) {
            if (depth > 48) return { type: 'any' };
            let nullable = false, optional, hasDefault = false, wrapper = schema;
            while (['optional', 'nonoptional', 'nullable', 'readonly', 'default', 'prefault'].includes(wrapper?._zod?.def?.type)) {
                const def = wrapper._zod.def;
                nullable ||= def.type === 'nullable';
                if (optional === undefined && ['optional', 'nonoptional'].includes(def.type)) optional = def.type === 'optional';
                hasDefault ||= ['default', 'prefault'].includes(def.type);
                wrapper = def.innerType;
            }
            const unwrapped = unwrap(schema), def = unwrapped?._zod?.def;
            if (!def) return null;
            let node;
            if (def.type === 'object') {
                const properties = {};
                for (const [key, child] of Object.entries(def.shape)) Object.defineProperty(properties, key, { value: shape(child, depth + 1) || { type: 'any' }, enumerable: true });
                node = { type: 'object', properties, extensible: !!def.catchall && def.catchall._zod?.def?.type !== 'never' };
            } else if (def.type === 'record') node = { type: 'object', properties: {}, extensible: true, record: true };
            else if (def.type === 'array') node = { type: 'array', elementType: shape(def.element, depth + 1) || { type: 'any' } };
            else node = { type: ['string', 'number', 'boolean', 'null'].includes(def.type) ? def.type : 'any' };
            if (nullable) node.nullable = true;
            if (optional && !hasDefault) node.optional = true;
            return node;
        }
        function locate(schema, path) {
            for (const key of path) {
                while (['optional', 'nonoptional', 'nullable', 'readonly', 'default', 'prefault'].includes(schema?._zod?.def?.type)) {
                    if (!safeChecks(schema._zod.def)) return null;
                    schema = schema._zod.def.innerType;
                }
                const def = schema?._zod?.def;
                if (!def || !safeChecks(def)) return null;
                if (def.type === 'object') schema = Object.hasOwn(def.shape, key) ? def.shape[key] : def.catchall;
                else if (def.type === 'record') schema = def.valueType;
                else return null;
            }
            return schema;
        }
        const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}' : JSON.stringify(value);
        return {
            assertCurrent,
            schema: registered.map(s => shape(s)).find(Boolean),
            async validateComplete(value) {
                assertCurrent();
                for (const root of registered) {
                    if (typeof root === 'function' || !pure(root, value)) return 'opaque';
                    const parsed = typeof root.safeParseAsync === 'function' ? await root.safeParseAsync(clone(value)) : root.safeParse(clone(value));
                    assertCurrent();
                    if (!parsed.success) return 'invalid';
                }
                return 'valid';
            },
            async accept(path, value) {
                assertCurrent();
                for (const root of registered) {
                    const node = typeof root === 'function' ? null : locate(root, path);
                    if (!node || !pure(node, value)) return '目标 Schema 含无法安全独立校验的规则，保留目标值';
                    const parsed = typeof node.safeParseAsync === 'function' ? await node.safeParseAsync(clone(value)) : node.safeParse(clone(value));
                    assertCurrent();
                    if (!parsed.success || canonical(parsed.data) !== canonical(value)) return '值不符合目标 Schema 或需要变换，保留目标值';
                }
                return '';
            },
        };
    }
    function facade(original, facadeOptions = {}) {
        if (!original || typeof original !== 'object') return original;
        const out = Object.create(original);
        const set = (name, value) => Object.defineProperty(out, name, { value, writable: true, configurable: true, enumerable: true });
        const metadata = () => isCurrent() ? readMetadata() : {};
        const resolve = name => {
            const map = metadata().worldbookAliases || {};
            return Object.prototype.hasOwnProperty.call(map, name) ? map[name] : name;
        };
        for (const name of ['getWorldbook', 'replaceWorldbook', 'updateWorldbookWith', 'createWorldbookEntries', 'deleteWorldbookEntries']) {
            if (typeof original[name] !== 'function') continue;
            set(name, function (book, ...args) {
                if (!isCurrent()) throw new Error('世界书调用所属会话已变化');
                return original[name].call(original, resolve(book), ...args);
            });
        }
        const decorateNames = result => {
            const apply = names => {
                const aliases = metadata().worldbookAliases || {}, found = new Set(names || []);
                for (const [oldName, newName] of Object.entries(aliases)) if (found.has(newName)) found.add(oldName);
                return [...found];
            };
            return result && typeof result.then === 'function' ? result.then(apply) : apply(result);
        };
        if (typeof original.getWorldbookNames === 'function') set('getWorldbookNames', function (...args) {
            const result = original.getWorldbookNames.apply(original, args);
            return facadeOptions.includeAliases === false ? result : decorateNames(result);
        });
        if (typeof original.getCharWorldbookNames === 'function') set('getCharWorldbookNames', function (...args) {
            const result = original.getCharWorldbookNames.apply(original, args);
            if (facadeOptions.includeAliases === false) return result;
            const apply = info => {
                if (!info || typeof info !== 'object') return info;
                const aliases = metadata().worldbookAliases || {}, names = [info.primary, ...(info.additional || [])], additional = [...(info.additional || [])];
                for (const [oldName, newName] of Object.entries(aliases)) if (names.includes(newName) && !additional.includes(oldName)) additional.push(oldName);
                return { ...info, additional };
            };
            return result && typeof result.then === 'function' ? result.then(apply) : apply(result);
        });
        if (typeof original.createChatMessages === 'function') set('createChatMessages', wrapCreate(original.createChatMessages, original));
        return out;
    }
    function patchWorldbookGlobals(w, globals, facadeOptions) {
        const names = ['getWorldbook', 'replaceWorldbook', 'updateWorldbookWith', 'createWorldbookEntries', 'deleteWorldbookEntries', 'getWorldbookNames', 'getCharWorldbookNames'];
        const original = {}, pending = [];
        for (const name of names) {
            if (typeof w[name] !== 'function' || w[name].__mvu2shujukuCardApi === api) continue;
            const fn = globals.original(w, name);
            if (typeof fn !== 'function') continue;
            original[name] = (...args) => fn.apply(w, args);
            pending.push(name);
        }
        const wrapped = facade(original, facadeOptions);
        for (const name of pending) {
            wrapped[name].__mvu2shujuku = true;
            wrapped[name].__mvu2shujukuCardApi = api;
            globals.patch(w, name, wrapped[name]);
        }
        return pending.length;
    }
    function wrapCreate(original, receiver) {
        return async function (messages, ...args) {
            if (!isCurrent()) throw new Error('创建消息所属会话已变化');
            const snapshots = (Array.isArray(messages) ? messages : []).filter(m => m?.data?.stat_data && typeof m.data.stat_data === 'object');
            // Multiple snapshots require per-message transactions rather than silently keeping only the last.
            if (snapshots.length > 1) throw new Error('一次创建多个 MVU 档案暂不支持，请逐条提交');
            if (!snapshots.length) return original.call(receiver, messages, ...args);
            const item = snapshots[0], normalized = await validate(item.data.stat_data);
            const unmapped = options.unmapped(normalized);
            if (unmapped.length) throw new Error('档案包含未映射组：' + unmapped.join('、'));
            const safeMessages = messages.map(m => m === item ? { ...m, data: { ...m.data, stat_data: normalized } } : m);
            const result = await original.call(receiver, safeMessages, ...args);
            if (!isCurrent()) throw new Error('创建档案期间会话已变化');
            // The helper has now created the archive floor. Commit the snapshot there and await persistence.
            if (!await readMvu().replaceMvuData({ ...item.data, stat_data: normalized })) throw new Error('档案消息已创建，但数据库保存失败；请重试，尚未完成创角');
            return result;
        };
    }
    const api = { registerSchema, ready, validate, stateImportRules, proofOf, facade, patchWorldbookGlobals, wrapCreate };
    return api;
}
module.exports = createCardApi;
