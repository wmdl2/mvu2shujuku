'use strict';

// 当前状态存档，不解释作者代码或模型提示词。浏览器与 Node 使用同一工厂。
function createStateTransfer() {
    const format = 'm2sjk-state';
    const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const clone = value => JSON.parse(JSON.stringify(value));
    function canonical(value) {
        if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
        if (record(value)) return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined)
            .map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
        return JSON.stringify(value);
    }
    const equal = (a, b) => canonical(a) === canonical(b);
    function equalRuntimeTables(a, b) {
        const runtime = value => {
            const copy = clone(value || {});
            // 数据库 hydrate 会把 guide 的初始化种子附到运行时表上。种子规则
            // 在调用方通过完整的目标模板／聊天元数据单独保护，不当作当前数据行。
            for (const key of Object.keys(copy)) if (key.startsWith('sheet_') && record(copy[key])) delete copy[key].seedRows;
            return copy;
        };
        return equal(runtime(a), runtime(b));
    }
    function stat(value) {
        if (!record(value)) throw new Error('stat_data 必须是 JSON 对象');
        function validate(node) {
            if (typeof node === 'number' && !Number.isFinite(node)) throw new Error('stat_data 包含无法用 JSON 无损保存的非有限数值');
            if (node && typeof node === 'object') for (const key of Object.keys(node)) {
                if (key === '$internal' && node === value) continue;
                validate(node[key]);
            }
        }
        validate(value);
        const result = clone(value);
        delete result.$internal; // MVU 更新事件中的临时引用；保留其他 $ 业务数据。
        return result;
    }
    function resolveImportSchema(schema, generateSchema) {
        if (record(schema) && typeof schema.type === 'string') return schema;
        // MVU Zod 的字符串占位由原 generateSchema 解释为 any。未知字符串
        // 仍视为规则缺失，不能用当前初值推导一份新的导入约束。
        if (typeof schema === 'string' && typeof generateSchema === 'function') {
            const normalized = generateSchema({}, schema);
            if (normalized?.type === 'any') return normalized;
        }
        return null;
    }
    // 新功能的字段匹配策略，不执行 MVU 更新、作者变换或字段改名推断。
    async function compatibleFields(source, target, options = {}) {
        source = stat(source); target = stat(target);
        const imported = [], skipped = [], retained = [];
        const pathText = path => '/' + path.map(k => String(k).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
        const put = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
        let visits = 0;
        function fits(value, node, previous) {
            if (node?.type === 'any') return true;
            if (!node) return previous === undefined || previous === null || value === null
                ? previous === undefined || previous === value : Array.isArray(previous) === Array.isArray(value) && typeof previous === typeof value;
            if (value === null) return node.nullable === true || node.type === 'null';
            if (node.type === 'array') return Array.isArray(value);
            if (node.type === 'object') return record(value) && Object.entries(node.properties || {}).every(([k, child]) =>
                own(value, k) ? fits(value[k], child) : child.required !== true);
            return typeof value === node.type;
        }
        async function atomic(value, previous, node, path) {
            let reason = fits(value, node, previous) ? '' : '目标类型或必需结构不相容';
            if (!reason && options.accept) reason = await options.accept(path, value) || '';
            if (reason) { skipped.push({ path: pathText(path), reason }); return previous === undefined ? undefined : clone(previous); }
            imported.push(pathText(path)); return clone(value);
        }
        async function walk(value, previous, node, path) {
            if (++visits > 20000) throw new Error('字段匹配超过安全处理规模，未导入');
            // 数组、动态记录和类型变化以完整容器为单位；不拼接行或下标。
            if (!record(value) || !record(previous) || node?.record === true || node?.type === 'any' || node && node.type !== 'object') return atomic(value, previous, node, path);
            const result = clone(previous);
            for (const key of Object.keys(previous)) if (!own(value, key)) {
                const child = node?.properties && own(node.properties, key) ? node.properties[key] : null;
                if (child?.optional === true) delete result[key];
                else retained.push(pathText([...path, key]));
            }
            for (const key of Object.keys(value)) {
                const child = node?.properties && own(node.properties, key) ? node.properties[key] : undefined;
                if (!own(previous, key) && !child && node?.extensible !== true && !(options.allowUndeclared && options.accept)) {
                    skipped.push({ path: pathText([...path, key]), reason: '目标没有同路径字段声明' }); continue;
                }
                const next = await walk(value[key], own(previous, key) ? previous[key] : undefined, child, [...path, key]);
                if (next !== undefined) put(result, key, next);
            }
            return result;
        }
        const result = await walk(source, target, options.schema, []);
        return { stat_data: result, imported, skipped, retained, partial: skipped.length > 0 || retained.length > 0 };
    }
    // 当前转换布局本身也是字段映射契约。旧产物没有公开 Schema 时，先用
    // 产品实际 writer/codec 验证完整快照，不把旧聊天的现有动态键当成声明。
    async function prepareImport(source, target, options) {
        source = stat(source); target = stat(target);
        const layoutOnly = options.layoutOnly === true && !options.schema;
        if (layoutOnly) {
            try { return { stat_data: source, fields: null, tables: await options.project(source) }; }
            catch (_) { /* 无损投影失败才按路径降级；不执行作者函数。 */ }
        }
        const probe = await compatibleFields(source, target, { schema: options.schema });
        const completeValid = options.validateComplete ? await options.validateComplete(source) : 'opaque';
        let fields = null, imported = source;
        const fieldProject = async (path, value) => {
            const reason = options.accept ? await options.accept(path, value) : '';
            if (reason) return reason;
            let candidate = clone(target);
            if (!path.length) candidate = clone(value);
            else {
                let node = candidate;
                for (const key of path.slice(0, -1)) {
                    if (!own(node, key) || !node[key] || typeof node[key] !== 'object')
                        Object.defineProperty(node, key, { value: {}, enumerable: true, writable: true, configurable: true });
                    node = node[key];
                }
                Object.defineProperty(node, path[path.length - 1], { value: clone(value), enumerable: true, writable: true, configurable: true });
            }
            try { await options.project(candidate); return ''; }
            catch (_) { return '目标布局无法无损保存此字段，保留目标值'; }
        };
        if (probe.partial || completeValid === 'invalid') {
            fields = await compatibleFields(source, target, { schema: options.schema,
                allowUndeclared: layoutOnly, accept: layoutOnly ? fieldProject : options.accept });
            imported = fields.stat_data;
        }
        let tables;
        try { tables = await options.project(imported); }
        catch (_) {
            fields = await compatibleFields(source, target, { schema: options.schema,
                allowUndeclared: layoutOnly, accept: fieldProject });
            imported = fields.stat_data;
            tables = await options.project(imported);
        }
        return { stat_data: imported, fields, tables };
    }
    function sheetRows(sheet) {
        const content = sheet?.content;
        if (!Array.isArray(content) || !Array.isArray(content[0]) || !content[0].length) throw new Error('额外表格缺少列定义');
        const headers = content[0];
        if (headers.some(v => typeof v !== 'string') || new Set(headers).size !== headers.length) throw new Error('额外表格列名无效或重复');
        for (const row of content.slice(1)) {
            if (!Array.isArray(row) || row.length !== headers.length || row.some(v => v !== null && (!['string', 'number', 'boolean'].includes(typeof v) || typeof v === 'number' && !Number.isFinite(v)))) {
                throw new Error('额外表格行结构无效：' + String(sheet.name || '未命名'));
            }
        }
        return clone(content);
    }
    function extraTables(tables, layout) {
        const mapped = new Set((layout || []).map(entry => String(entry.table || '')));
        return Object.keys(tables || {}).filter(key => key.startsWith('sheet_') && record(tables[key]) && !mapped.has(String(tables[key].name)))
            .map(key => {
                const sheet = tables[key];
                return { key, uid: String(sheet.uid || key), name: String(sheet.name || ''),
                    ddl: String(sheet.sourceData?.ddl || '').replace(/\r\n/g, '\n').trim(), content: sheetRows(sheet) };
            });
    }
    function archive(snapshot) {
        const mvu = snapshot.mvu || {};
        return { format, version: 1, exportedAt: new Date().toISOString(), source: clone(snapshot.source || {}),
            stat_data: stat(mvu.stat_data),
            mvu: { ...(record(mvu.schema) || typeof mvu.schema === 'string' ? { schema: clone(mvu.schema) } : {}),
                ...(record(mvu.initialized_lorebooks) ? { initialized_lorebooks: clone(mvu.initialized_lorebooks) } : {}) },
            extraTables: extraTables(snapshot.tables, snapshot.layout) };
    }
    function parse(text) {
        const value = typeof text === 'string' ? JSON.parse(text.replace(/^\uFEFF/, '')) : text;
        if (!record(value)) throw new Error('存档必须是 JSON 对象');
        if (value.format === format) {
            if (value.version !== 1) throw new Error('不支持的状态存档版本：' + value.version);
            if (!Array.isArray(value.extraTables)) throw new Error('状态存档额外表格清单无效');
            const restoredStat = stat(value.stat_data);
            for (const sheet of value.extraTables) sheetRows(sheet);
            const result = clone(value);
            result.stat_data = restoredStat;
            const seen = new Set();
            for (const sheet of result.extraTables) {
                if (!record(sheet) || typeof sheet.key !== 'string' || !sheet.key.startsWith('sheet_') || typeof sheet.name !== 'string' || typeof sheet.uid !== 'string' || typeof sheet.ddl !== 'string' || seen.has(sheet.key)) throw new Error('状态存档额外表格身份无效或重复');
                seen.add(sheet.key); sheet.content = sheetRows(sheet);
            }
            return result;
        }
        // 普通 MVU 的变量表导出，或裸 stat_data JSON。
        return { format, version: 1, source: {}, mvu: {}, stat_data: stat(record(value.stat_data) ? value.stat_data : value), extraTables: [] };
    }
    function matchExtras(extras, tables, layout) {
        const targets = extraTables(tables, layout), used = new Set(), matches = [], skipped = [];
        for (const source of extras) {
            const compatible = target => target.ddl === source.ddl && target.content[0].length === source.content[0].length && target.content[0].every(h => source.content[0].includes(h));
            const identities = targets.filter(t => t.uid === source.uid || t.key === source.key);
            const candidates = identities.length ? identities.filter(compatible) : targets.filter(t => t.name === source.name && compatible(t));
            if (candidates.length !== 1 || used.has(candidates[0]?.key)) {
                skipped.push({ name: source.name, reason: identities.length && !candidates.length ? '目标列结构或 DDL 不相容' : candidates.length > 1 || used.has(candidates[0]?.key) ? '匹配身份不唯一' : '没有相容目标模板' });
                continue;
            }
            const target = candidates[0]; used.add(target.key);
            const indices = target.content[0].map(h => source.content[0].indexOf(h));
            matches.push({ name: source.name, key: target.key,
                content: [target.content[0], ...source.content.slice(1).map(row => indices.map(i => row[i]))] });
        }
        return { matches, skipped };
    }
    function applyExtras(tables, matches) {
        const candidate = clone(tables || {});
        for (const match of matches) candidate[match.key].content = clone(match.content);
        return candidate;
    }
    function assertPersistentDbVersion(version) {
        const match = String(version || '').match(/^(naiv)?(\d+)\.(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
        const supported = match && (match[1]
            ? Number(match[2]) >= 1
            : Number(match[2]) > 8 || Number(match[2]) === 8 && Number(match[3]) >= 5);
        if (!supported) {
            throw new Error('涉及表格的状态导入需要可识别的 SP·数据库 8.5 或更新版本，或龙血玄黄·数据库 1.0.0 或更新版本；当前：' + String(version || '未知'));
        }
    }
    function verifyBackup(jsonl, chat, metadata) {
        let lines;
        try { lines = String(jsonl).replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l)); }
        catch (_) { throw new Error('聊天备份不是有效的酒馆 JSONL 文件'); }
        if (!record(lines[0]) || !own(lines[0], 'chat_metadata') || !equal(lines.slice(1), chat) || !equal(lines[0].chat_metadata, metadata || {})) {
            throw new Error('聊天文件与当前聊天不一致，可能尚未保存或已发生并发更新');
        }
        return true;
    }
    // stage/commit/restore 均由真实宿主适配注入；失败时仅回退仍属于本次操作的值。
    async function execute(plan, host) {
        let rollback, attemptedTables = false;
        host.assertUnchanged();
        if (plan.backup !== false) await host.backup();
        host.assertUnchanged();
        try {
            rollback = host.rollbackStage;
            rollback = await host.stage();
            host.assertCurrent();
            if (plan.writeTables) {
                attemptedTables = true;
                const result = await host.importTables(plan.tables);
                if (result !== true && result?.success !== true) throw new Error('数据库拒绝导入状态');
            }
            host.assertCurrent();
            await host.save(false);
            host.assertCurrent();
            await host.verify();
            return true;
        } catch (error) {
            const recovery = [];
            try { host.assertCurrent(); if (rollback) await rollback(); } catch (e) { recovery.push('变量回退：' + e.message); }
            try { host.assertCurrent(); if (attemptedTables) await host.restoreTables(); } catch (e) { recovery.push('表格回退：' + e.message); }
            try { host.assertCurrent(); await host.save(true); } catch (e) { recovery.push('保存回退：' + e.message); }
            error.message += (plan.backup !== false ? '。已下载覆盖前的完整聊天备份' : '。本次未选择下载聊天备份') + (recovery.length ? '；自动回退未完整确认：' + recovery.join('；') : '；已执行回退');
            throw error;
        }
    }
    return { format, archive, parse, resolveImportSchema, compatibleFields, prepareImport, matchExtras, applyExtras, assertPersistentDbVersion, verifyBackup, execute, stat, equal, equalRuntimeTables, clone };
}

module.exports = createStateTransfer;
