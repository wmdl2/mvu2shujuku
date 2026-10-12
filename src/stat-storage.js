'use strict';

// Preserve original display filtering independently of storage. This factory is
// inlined in the browser; it has no Node or ambient runtime dependencies.
function createStatStorage(options = {}) {
    // Legacy layouts retain their original split. New conversions explicitly
    // select version 2 and preserve each object's complete ownership boundary.
    const completeContainers = () => options.readPolicy?.()?.version >= 2;
    const declaredDollarWrites = () => options.readPolicy?.()?.version >= 3;
    const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
    const object = value => value !== null && typeof value === 'object';
    const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    const put = (target, key, value) => Object.defineProperty(target, key,
        { value, enumerable: true, writable: true, configurable: true });
    const matches = (pattern, path) => pattern.length <= path.length && pattern.every((part, i) => part === '*' || part === path[i]);
    const prefixes = entry => entry.writePaths?.length ? entry.writePaths : [entry.path?.length ? entry.path : [entry.group]];
    const columnPaths = (entry, column) => {
        const path = Array.isArray(column) ? column[3] : column.path;
        const name = Array.isArray(column) ? column[0] : column.zh;
        if (['rows', 'nestedRows'].includes(entry.kind)) {
            if (name === entry.keyCol || (entry.ancestorKeyCols || []).includes(name) || name === entry.parentKeyCol) return [];
            if (name === entry.scalarValueCol) return prefixes(entry).map(prefix => [...prefix, '*']);
            return prefixes(entry).map(prefix => [...prefix, '*', ...(path?.length ? path : [name])]);
        }
        return [path?.length ? path : [entry.group, name]];
    };
    function rules(layout) {
        const result = [];
        for (const entry of layout || []) {
            if (entry.kind === 'nestedArray') {
                const path = entry.path || [entry.group];
                result.push([...path.slice(0, -1), '*', path[path.length - 1]]);
                continue;
            }
            if (['json', 'array', 'pathArray'].includes(entry.kind)) {
                for (const path of prefixes(entry)) result.push(path);
                continue;
            }
            for (const column of entry.cols || []) {
                const name = Array.isArray(column) ? column[0] : column.zh;
                if (name === (entry.overflowCol || '_扩展数据')) continue;
                result.push(...columnPaths(entry, column));
            }
            if (entry.overflowCol) {
                for (const prefix of prefixes(entry)) result.push([...prefix, ...(['rows', 'nestedRows'].includes(entry.kind) ? ['*'] : []), '*']);
            }
        }
        return result;
    }
    // Visibility follows the original formatting macro: $ descendants are omitted
    // from its default display. This is storage routing, never an actor permission.
    function split(stat, displayOnly = false) {
        // 没有启用原消息分流的旧卡，所有映射字段仍按原布局存入数据库。
        // displayOnly 则始终沿用 MVU 展示时过滤 $ 字段的规则。
        if (!displayOnly && options.enabled && !options.enabled()) return { database: stat === undefined ? {} : stat, native: {} };
        if (completeContainers() && displayOnly !== true) {
            const database = {}, native = {};
            const policy = options.readPolicy?.() || {};
            const roots = new Set(policy.roots || []);
            // Root entries have independent ownership. Hidden descendants stay
            // inside their complete object while SQL executes the operation once.
            for (const key of Object.keys(stat || {})) {
                if (key === '$internal') continue;
                const unmapped = Array.isArray(policy.roots) && !roots.has(key) && !policy.rootContainer;
                put(unmapped || key.startsWith('$') && !declaredDollarWrites() ? native : database, key, stat[key]);
            }
            return { database, native };
        }
        const seen = new WeakMap();
        function walk(value) {
            if (!object(value)) return { database: value };
            if (seen.has(value)) return seen.get(value);
            // 投影不能先把非法 JSON 序列化成合法值；原写入校验必须看到原类型、缺口和循环。
            if (!Array.isArray(value) && Object.prototype.toString.call(value) !== '[object Object]') return { database: value };
            const database = Array.isArray(value) ? new Array(value.length) : Object.create(Object.getPrototypeOf(value));
            const native = Array.isArray(value) ? [] : {};
            const result = { database };
            seen.set(value, result);
            let hasNative = false;
            for (const key of Object.keys(value)) {
                if (key.startsWith('$')) {
                    if (key !== '$internal') { put(native, key, clone(value[key])); hasNative = true; }
                    continue;
                }
                const part = walk(value[key]);
                put(database, key, part.database);
                if (own(part, 'native')) { put(native, key, part.native); hasNative = true; }
            }
            if (hasNative) result.native = native;
            return result;
        }
        const part = walk(stat === undefined ? {} : stat);
        return { database: part.database, native: part.native || {} };
    }
    // The inspected schema stays intact for execution. Only its layout/display
    // descriptor omits fields hidden by the original formatting convention.
    function displaySchemaNode(node) {
        if (!object(node)) return node;
        const out = { ...node };
        if (node.fields) {
            out.fields = {};
            for (const [key, child] of Object.entries(node.fields)) {
                if (!key.startsWith('$')) put(out.fields, key, displaySchemaNode(child));
            }
        }
        if (node.value) out.value = displaySchemaNode(node.value);
        if (node.element) out.element = displaySchemaNode(node.element);
        for (const key of ['defaultValue', 'prefaultValue']) if (own(node, key) && object(node[key])) out[key] = split(node[key], true).database;
        return out;
    }
    function project(stat, layout = options.readLayout?.() || []) {
        const rootEntry = layout.find(entry => entry.rootContainer);
        if (rootEntry) {
            const data = {};
            for (const key of Object.keys(stat || {})) if (key !== '$internal' && (declaredDollarWrites() || rootEntry.statStorageVersion >= 3 || !key.startsWith('$'))) put(data, key, stat[key]);
            return { [rootEntry.group]: data };
        }
        const fallback = layout.find(entry => entry.publicFallback);
        if (!fallback) return stat;
        const seenNumbers = new WeakSet();
        const checkNumbers = value => {
            if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('变量包含非有限数值');
            if (object(value) && !seenNumbers.has(value)) {
                seenNumbers.add(value);
                for (const child of Object.values(value)) checkNumbers(child);
            }
        };
        checkNumbers(stat);
        stat = split(stat).database;
        const accepted = rules(layout.filter(entry => !entry.publicFallback));
        function walk(value, path) {
            if (accepted.some(pattern => matches(pattern, path))) return { mapped: value };
            const ancestor = accepted.some(pattern => path.length < pattern.length && path.every((part, i) => pattern[i] === '*' || pattern[i] === part));
            if (!ancestor) return { extra: value };
            if (!object(value)) return { extra: value };
            const mapped = Array.isArray(value) ? [] : {}, extra = Array.isArray(value) ? [] : {};
            let hasExtra = false;
            for (const key of Object.keys(value)) {
                const part = walk(value[key], path.concat(key));
                if (own(part, 'mapped')) put(mapped, key, part.mapped);
                if (own(part, 'extra')) { put(extra, key, part.extra); hasExtra = true; }
            }
            return { mapped, ...(hasExtra ? { extra } : {}) };
        }
        const part = walk(stat || {}, []), out = part.mapped || {};
        put(out, fallback.group, part.extra || {});
        return out;
    }
    function planLegacy(schema, shapeInfo, initial, layout, makeIdent) {
        const retained = [];
        for (const group of schema) {
            const entry = layout.find(item => item.table === group.tableName);
            if (!entry || prefixes(entry).every(path => path.some(key => String(key).startsWith('$')))) continue;
            if (group.kind === 'json' && !group.aiReadonly) group.jsonAiWritable = true;
            const originalColumns = group.columns.slice();
            const originalRows = (group.rows || []).map(row => row.slice());
            group.columns = group.columns.filter(column => column.zh === group.vwdMetaZh || column.zh !== '_扩展数据' &&
                !columnPaths(entry, entry.cols.find(item => item.zh === column.zh) || column).some(path => path.some(key => String(key).startsWith('$'))));
            if (!group.columns.length) continue;
            const fields = group.columns.filter(column => column.zh !== group.vwdMetaZh && column.zh !== group.keyCol && column.zh !== group.parentKeyCol);
            if (group.kind === 'singleton' && fields.length && fields.every(column => column.aiReadonly)) group.aiReadonly = true;
            const cleanCell = (column, cell) => {
                if (completeContainers()) return cell;
                if (!column.isObject || typeof cell !== 'string' || !cell.trim()) return cell;
                try { return JSON.stringify(split(JSON.parse(cell)).database); } catch (_) { return cell; }
            };
            for (const column of group.columns) column.value = cleanCell(column, column.value);
            group.rows = originalRows.map(row => [row[0], ...group.columns.map(column => {
                const oldIndex = originalColumns.findIndex(old => old.zh === column.zh);
                return cleanCell(column, row[oldIndex + 1]);
            })]);
            retained.push(group);
            if (completeContainers() && group.columns.some(column => column.isObject)) group.fullStatContainer = true;
        }
        schema.splice(0, schema.length, ...retained);
        // One ordinary writable JSON table carries public runtime fields which
        // have no fixed column. It is not a hidden column or script-only storage.
        const names = new Set(schema.map(group => group.name)), tables = new Set(schema.map(group => group.tableName));
        let name = '动态变量', n = 2;
        while (names.has(name) || tables.has(name + '表') || own(initial, name)) name = '动态变量' + n++;
        const tableName = name + '表';
        const group = { name, tableName, ident: makeIdent(tableName, new Set(schema.map(group => group.ident)), 'table'),
            kind: 'json', publicFallback: true, jsonAiWritable: true, keyCol: '', keyValue: '', childTables: [],
            columns: [{ zh: '内容', ident: makeIdent('内容', new Set(['row_id']), 'column'), path: [name, '内容'],
                value: '{}', type: 'TEXT', isObject: true, jsonKind: 'object', desc: '未单独映射到其他表的公开变量（JSON）；内部键保留原变量名，已映射字段使用对应表列更新。' }],
            rows: [[1, '{}']], source: 'public-dynamic-state',
            groupChecks: ['仅承接未单独映射到其他表的公开变量；遵守原变量业务规则，已映射字段使用对应表列更新。'] };
        schema.push(group);
        const current = layout.filter(entry => retained.some(group => group.tableName === entry.table)).map(entry => {
            const g = retained.find(group => group.tableName === entry.table);
            return { ...entry, cols: entry.cols.filter(c => g.columns.some(column => column.zh === (Array.isArray(c) ? c[0] : c.zh))) };
        });
        const extra = project(split(initial).database, [...current, { kind: 'json', group: name, publicFallback: true }])[name];
        group.rows[0][1] = JSON.stringify(extra);
        group.fullStatContainer = completeContainers();
        return { version: completeContainers() ? 2 : 1, visibility: 'original-dollar-display', initial: split(initial).native };
    }
    function plan(schema, shapeInfo, initial, layout, makeIdent) {
        if (!completeContainers()) return planLegacy(schema, shapeInfo, initial, layout, makeIdent);
        const get = (value, path) => path.reduce((v, key) => own(v, key) ? v[key] : undefined, value);
        const relative = (entry, col) => {
            const path = columnPaths(entry, col)[0];
            if (!path) return null;
            return path.slice(prefixes(entry)[0].length + (entry.kind === 'rows' ? 1 : 0));
        };
        const residual = (raw, paths) => {
            const out = clone(raw) || {};
            const remove = (value, path, i = 0) => {
                if (!object(value) || !own(value, path[i])) return;
                if (i === path.length - 1) delete value[path[i]];
                else {
                    remove(value[path[i]], path, i + 1);
                    if (object(value[path[i]]) && !Array.isArray(value[path[i]]) && !Object.keys(value[path[i]]).length) delete value[path[i]];
                }
            };
            for (const path of paths) if (path?.length) remove(out, path);
            return out;
        };
        const retained = [];
        for (const group of schema) {
            const entry = layout.find(e => e.table === group.tableName);
            if (!entry || !declaredDollarWrites() && prefixes(entry).every(path => path.some(key => String(key).startsWith('$')))) continue;
            const old = group.columns.slice();
            group.columns = group.columns.filter(c => c.zh !== '_扩展数据' && c.zh !== group.vwdMetaZh &&
                !(declaredDollarWrites() && group.privateRoot ? [] : columnPaths(entry, entry.cols.find(x => x.zh === c.zh) || c))
                    .some(path => path.some(key => String(key).startsWith('$'))));
            if (!group.columns.length) continue;
            const fields = group.columns.filter(c => c.zh !== group.keyCol && c.zh !== group.parentKeyCol);
            if (group.kind === 'singleton' && fields.length && fields.every(c => c.aiReadonly)) group.aiReadonly = true;
            // Complex ownership has already been collapsed to a complete JSON
            // boundary by the schema layout. Ordinary records retain their columns.
            const extraNeeded = ['singleton', 'rows'].includes(entry.kind) && !entry.valueCol && !entry.scalarValueCol;
            let extra;
            if (extraNeeded) {
                let zh = '扩展数据', n = 2;
                while (group.columns.some(c => c.zh === zh)) zh = '扩展数据' + n++;
                extra = { zh, ident: makeIdent(zh, new Set(['row_id', ...group.columns.map(c => c.ident)]), 'column'),
                    path: [entry.group, zh], itemPath: [zh], value: '{}', type: 'TEXT', isObject: true,
                    jsonKind: 'object', jsonDefaultMissing: true,
                    desc: '保存本记录中没有对应独立列的字段；没有明确更新依据时保持原样。' };
                group.overflowCol = zh;
            }
            const base = entry.rootContainer ? split(initial).database : get(initial, prefixes(entry)[0]);
            const keyIndex = old.findIndex(c => c.zh === entry.keyCol) + 1;
            // The final layout is the ownership plan. Delegated child tables
            // must not also be serialized into the parent's residual JSON.
            const paths = group.columns.map(c => relative(entry, entry.cols.find(x => x.zh === c.zh) || c)).filter(Boolean);
            for (const prefix of prefixes(entry)) {
                const owner = [...prefix, ...(entry.kind === 'rows' ? ['*'] : [])];
                for (const child of layout) {
                    if (child === entry) continue;
                    for (const path of prefixes(child)) {
                        if (path.length > owner.length && owner.every((key, i) => key === path[i]))
                            paths.push(path.slice(owner.length));
                    }
                }
            }
            const sourceRows = (group.rows || []).map(row => row.slice());
            if (entry.kind === 'rows' && object(base)) {
                const existing = new Set(sourceRows.map(row => String(row[keyIndex])));
                for (const key of Object.keys(base)) {
                    if (existing.has(key)) continue;
                    const raw = base[key];
                    sourceRows.push([sourceRows.length + 1, ...old.map(c => {
                        if (c.zh === entry.keyCol) return key;
                        let value = get(raw, relative(entry, entry.cols.find(x => x.zh === c.zh) || c) || []);
                        if (c.isPair && Array.isArray(value)) value = value[0];
                        if (c.isObject) return value === undefined ? '' : JSON.stringify(value);
                        return value === undefined ? '' : value;
                    })]);
                }
            }
            group.rows = sourceRows.map(row => {
                const raw = entry.kind === 'rows' ? base?.[String(row[keyIndex])] : base;
                const cells = group.columns.map(c => {
                    const value = (entry.kind === 'json' || entry.valueCol) && c.isObject ? raw
                        : get(raw, relative(entry, entry.cols.find(x => x.zh === c.zh) || c) || []);
                    // Preserve the existing scalar/pair coercion and optional
                    // encoders. Only complete object cells need raw restoration.
                    if (c.isObject && c.zh !== entry.keyCol && value !== undefined)
                        return JSON.stringify(value);
                    return row[old.findIndex(o => o.zh === c.zh) + 1];
                });
                if (extra) cells.push(JSON.stringify(residual(raw, paths)));
                return [row[0], ...cells];
            });
            if (extra) group.columns.push(extra);
            if (group.kind === 'json' && !group.aiReadonly) group.jsonAiWritable = true;
            group.fullStatContainer = group.columns.some(c => c.isObject);
            group.statStorageVersion = declaredDollarWrites() ? 3 : 2;
            retained.push(group);
        }
        schema.splice(0, schema.length, ...retained);
        const roots = retained.flatMap(g => {
            const entry = layout.find(e => e.table === g.tableName);
            return entry ? prefixes(entry).map(path => path[0]).filter(Boolean) : [];
        });
        return { version: declaredDollarWrites() ? 3 : 2, visibility: 'original-dollar-display', roots: [...new Set(roots)], rootContainer: retained.some(g => g.rootContainer), initial: {} };
    }
    // Reuse SQLite's own JSON path production and removal. No parser for keys,
    // arrays or SQL is emulated here. Invalid/absent JSON never sends raw text.
    function sendRowsSql(group) {
        const quote = name => '"' + String(name).replace(/"/g, '""') + '"';
        const visibleJson = col => {
            const value = 't.' + quote(col.ident);
            return `CASE WHEN json_valid(${value}) THEN (WITH RECURSIVE hidden(n,path) AS (`
                + `SELECT row_number() OVER (ORDER BY length(fullkey) DESC,fullkey),fullkey FROM json_tree(${value}) WHERE substr(CAST(key AS TEXT),1,1)=char(36)),`
                + `pruned(n,value) AS (SELECT 0,${value} UNION ALL SELECT pruned.n+1,json_remove(pruned.value,hidden.path) FROM pruned JOIN hidden ON hidden.n=pruned.n+1)`
                + ` SELECT value FROM pruned ORDER BY n DESC LIMIT 1) ELSE '' END AS ${quote(col.ident)}`;
        };
        const key = group.kind === 'rows' && group.columns.find(c => c.zh === group.keyCol);
        const sql = 'SELECT t.row_id,' + group.columns.map(c => c.isObject ? visibleJson(c) : 't.' + quote(c.ident)).join(',')
            + ' FROM ' + quote(group.ident) + ' AS t'
            + (group.privateRoot ? ' WHERE 0' : key ? " WHERE substr(CAST(t." + quote(key.ident) + " AS TEXT),1,1)<>char(36)" : '') + ' ORDER BY t.row_id';
        // The host inserts table text using String.replace with a string.
        // Spell the dollar as SQLite char(36): a literal dollar followed by
        // an SQL closing quote would be JS's replacement-suffix token.
        // The prepare pass executes only a constant. The resulting inner macro
        // reads data in the host's final, snapshot-scoped SQL pass after EJS.
        const inner = "{[sql '" + sql + "']}";
        return '{[sql "SELECT \'' + inner.replace(/'/g, "''") + '\'"]}';
    }
    function read(index) {
        const chat = options.readChat?.() || [];
        index = index == null ? chat.length - 1 : index;
        for (let i = index; i >= 0; i--) {
            const message = chat[i], data = message?.variables?.[Number(message.swipe_id || 0)];
            if (object(data) && own(data, 'stat_data')) return split(data.stat_data).native;
        }
        return clone(options.readPolicy?.()?.initial || {});
    }
    function combine(database, native) {
        if (completeContainers()) {
            const out = {};
            for (const part of [native, database]) for (const key of Object.keys(part || {})) put(out, key, clone(part[key]));
            return out;
        }
        if (!object(database) || !object(native) || Array.isArray(database) !== Array.isArray(native)) return clone(database);
        const out = clone(native);
        for (const key of Object.keys(database)) {
            if (own(native, key) && object(database[key]) && object(native[key])) put(out, key, combine(database[key], native[key]));
            else put(out, key, clone(database[key]));
        }
        return out;
    }
    function merge(wrap, index) {
        if (!wrap?.stat_data || options.enabled && !options.enabled()) return wrap;
        // Preserve original reads, including explicitly displayed $ values.
        // Display omission is not a write lock on JSON content.
        const part = split(wrap.stat_data), database = part.database;
        const native = combine(part.native, read(index));
        return { ...wrap, stat_data: combine(database, native),
            ...(wrap.display_data ? { display_data: combine(wrap.display_data, native) } : {}) };
    }
    function stage(stat, session) {
        if (options.enabled && !options.enabled()) return { changed: false, rollback() {} };
        const native = split(stat).native;
        const old = read(session?.writeTarget?.index), stateChanged = JSON.stringify(old) !== JSON.stringify(native);
        if (!stateChanged && Object.keys(native).length === 0) return { changed: false, stateChanged: false, rollback() {} };
        session = options.bindSession ? options.bindSession(session) : session;
        options.assertCurrent(session);
        const chat = options.readChat(), target = session.writeTarget;
        if (!target || !chat[target.index]) throw new Error('脚本状态写入目标已变化');
        const message = chat[target.index], swipe = Number(message.swipe_id || 0);
        const previous = message.variables, previousData = previous?.[swipe];
        if (!stateChanged && own(previousData, 'stat_data')) return { changed: false, stateChanged: false, rollback() {} };
        const variables = Array.isArray(previous) ? previous.slice() : { ...(previous || {}) };
        variables[swipe] = { ...(previousData || {}), stat_data: native };
        message.variables = variables;
        return { changed: true, stateChanged, rollback() {
            if (message.variables !== variables) return;
            const currentData = variables[swipe];
            if (currentData?.stat_data !== native) return;
            if (own(previousData, 'stat_data')) currentData.stat_data = previousData.stat_data; else delete currentData.stat_data;
            const sameKeys = Object.keys(currentData).every(key => own(previousData, key) && currentData[key] === previousData[key]) && Object.keys(previousData || {}).length === Object.keys(currentData).length;
            const unchangedOtherSwipes = Object.keys(variables).every(key => Number(key) === swipe || variables[key] === previous?.[key]);
            if (sameKeys && unchangedOtherSwipes) { if (previous === undefined) delete message.variables; else message.variables = previous; }
        } };
    }
    return { split, plan, rules, project, read, merge, stage, combine, sendRowsSql, displaySchemaNode };
}
module.exports = createStatStorage;
