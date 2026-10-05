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
    function facade(original) {
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
            return decorateNames(original.getWorldbookNames.apply(original, args));
        });
        if (typeof original.getCharWorldbookNames === 'function') set('getCharWorldbookNames', function (...args) {
            const result = original.getCharWorldbookNames.apply(original, args);
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
    return { registerSchema, ready, validate, proofOf, facade, wrapCreate };
}
module.exports = createCardApi;
