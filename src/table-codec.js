'use strict';

/**
 * 数据库表格与 MVU 视图的共用编解码基础。
 * 不读取 window、宿主 API 或缓存；JSON 修复能力由调用方注入。
 * 工厂保持自包含，构建时把同一函数内联进扩展与旧卡桥。
 */
function createTableCodec(repairJson) {
    function parseObject(v) {
        try {
            if (!v) return {};
            if (typeof v === 'object') return v;
            const source = String(v);
            try { return JSON.parse(source); } catch (e) {}
            try {
                const repaired = typeof repairJson === 'function' ? repairJson(source) : null;
                if (repaired) return JSON.parse(repaired);
            } catch (e) {}
            return {};
        } catch (e) { return {}; }
    }

    const text = (v, fb) => (v === undefined || v === null || v === '' ? (fb === undefined ? '' : fb) : String(v));
    const number = (v, fb) => { const n = parseFloat(v); return isNaN(n) ? (fb === undefined ? 0 : fb) : n; };
    const boolean = (v, fb) => {
        if (typeof v === 'boolean') return v;
        if (typeof v === 'number') return v !== 0;
        const s = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
        if (s === '1' || s === 'true') return true;
        if (s === '0' || s === 'false' || s === '') return s === '' && typeof fb === 'boolean' ? fb : false;
        const n = Number(s);
        return Number.isFinite(n) ? n !== 0 : (typeof fb === 'boolean' ? fb : false);
    };
    const convertCell = (type, v, fb, desc, jsonKind) => {
        if ((type === 'jsonScalarOptional' || type === 'jsonPairOptional')) {
            if (v === undefined || v === null || v === '') return undefined;
            // 新编码不猜测裸文本，也不把坏单元格伪造成 {}。旧 jsonScalar 解码不变。
            try {
                const parsed = JSON.parse(String(v));
                return parsed === null || typeof parsed !== 'object' ? (type === 'jsonPairOptional' ? [parsed, desc || ''] : parsed) : undefined;
            } catch (e) { return undefined; }
        }
        if (type === 'jsonObjectOptional') {
            if (v === undefined || v === null || v === '') return undefined;
            try {
                const parsed = JSON.parse(String(v));
                if (parsed === null) return parsed;
                if (jsonKind === 'array') return Array.isArray(parsed) ? parsed : undefined;
                return !Array.isArray(parsed) && parsed && typeof parsed === 'object' ? parsed : undefined;
            } catch (e) { return undefined; }
        }
        if (type === 'number') return number(v, fb);
        if (type === 'textExact') return v === undefined || v === null ? (fb === undefined ? '' : fb) : String(v);
        if (type === 'boolean') return boolean(v, fb);
        if (type === 'jsonScalar') {
            if (v === undefined || v === null || v === '') return fb === undefined ? '' : fb;
            return parseObject(v);
        }
        if (type === 'object') return parseObject(v);
        if (type === 'pair') return [text(v, fb), desc || ''];
        return text(v, fb);
    };
    const setPath = (obj, path, value) => {
        let cur = obj;
        for (let i = 0; i < path.length - 1; i++) {
            if (!cur[path[i]] || typeof cur[path[i]] !== 'object' || Array.isArray(cur[path[i]])) cur[path[i]] = {};
            cur = cur[path[i]];
        }
        if (value !== undefined) cur[path[path.length - 1]] = value;
    };

    /* ---------------- VWD 动态说明（第一版：单例表 pair / jsonPairOptional） ----------------
     * 字段身份 = layout.vwd.fields[].id（登记路径数组的 JSON 串）。
     * 覆盖集合只保存与静态默认不同的说明；显式 "" 是有效覆盖；未登记键一律忽略，
     * 因此内部元数据永远不会被反投影成业务变量。任何非法元数据都降级为“无覆盖”。
     */
    const VWD_META_ID_MAX = 512;

    function vwdFieldId(path) {
        try { return JSON.stringify((Array.isArray(path) ? path : []).map(String)); } catch (e) { return ''; }
    }

    function vwdFieldsOf(entry) {
        const vwd = entry && entry.vwd;
        if (!vwd || typeof vwd !== 'object' || Number(vwd.v) !== 1) return null;
        return Array.isArray(vwd.fields) ? vwd.fields : null;
    }

    // 运行时表里元数据列是 JSON 单元格；模板里可能是 JSON 文本。两种都接受，
    // 不是合法对象形状时返回 null（降级为无覆盖），不抛错、不部分套用。
    function parseVwdMetaObject(raw) {
        if (raw === undefined || raw === null || raw === '') return null;
        if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
        if (typeof raw !== 'string') return null;
        try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        } catch (e) { return null; }
    }

    function vwdOverridesFromRow(entry, header, row) {
        const fields = vwdFieldsOf(entry);
        if (!fields) return {};
        const vwd = entry.vwd;
        const metaCol = typeof vwd.metaCol === 'string' && vwd.metaCol ? vwd.metaCol : '';
        if (!metaCol || !Array.isArray(row)) return {};
        let idx = Array.isArray(header) && header.length ? header.indexOf(metaCol) : -1;
        if (idx < 0) {
            // 无表头时按列定义顺序退化定位，仍以 layout 登记的物理名为准。
            const pos = (entry.cols || []).findIndex(c => c && c[0] === metaCol);
            idx = pos < 0 ? -1 : pos + 1;
        }
        if (idx < 0 || idx >= row.length) return new Map();
        const blob = parseVwdMetaObject(row[idx]);
        if (!blob) return new Map();
        const known = new Set(fields.map(f => f && f.id).filter(Boolean));
        const out = new Map();
        const take = source => {
            for (const key of Object.keys(source)) {
                if (!known.has(key) || key.length > VWD_META_ID_MAX) continue;
                if (typeof source[key] === 'string') out.set(key, source[key]);
            }
        };
        if (blob.v === 1 && blob.o && typeof blob.o === 'object' && !Array.isArray(blob.o)) take(blob.o);
        // 兼容早期无版本号的裸覆盖集合；未知键依旧忽略。
        else if (blob.v === undefined) take(blob);
        return out;
    }

    // 当前说明 = 覆盖文本（存在时，含显式 ""）→ 否则静态默认。字段不在本次布局登记
    // 范围时不改写单元格，继续保持既有静态读回契约。
    // overrides: Map<fieldId, string>；运行时表项没有登记字段时视作无 VWD 布局。
    function applyVwdDescriptions(entry, overrides, sd) {
        const fields = vwdFieldsOf(entry);
        if (!fields) return;
        for (const field of fields) {
            if (!field || typeof field !== 'object' || !field.id) continue;
            const path = Array.isArray(field.path) && field.path.length ? field.path : null;
            if (!path) continue;
            const current = getPath(sd, path);
            const overridden = overrides && overrides.has(field.id);
            if ((field.type === 'number' || field.type === 'boolean') && current !== undefined && !Array.isArray(current)) {
                setPath(sd, path, [current, overridden ? String(overrides.get(field.id)) : String(field.desc || '')]);
            } else if (overridden && Array.isArray(current) && current.length === 2) {
                current[1] = String(overrides.get(field.id));
            }
        }
    }
    const getPath = (obj, path) => {
        let cur = obj;
        for (const p of path || []) { if (cur === null || cur === undefined || typeof cur !== 'object') return undefined; cur = cur[p]; }
        return cur;
    };
    // 溢出数据只补齐未建列的部分，已建列值始终以表格列为准。
    // 这也允许同一对象“部分展开”：例如 身体数据.胸部.罩杯 建列，
    // 而 腰部/臀部 仍保存在 _扩展数据，读回时两者无损合并。
    const mergeMissing = (target, extra) => {
        if (!target || typeof target !== 'object' || Array.isArray(target) || !extra || typeof extra !== 'object' || Array.isArray(extra)) return target;
        for (const k of Object.keys(extra)) {
            const ev = extra[k];
            if (!(k in target)) {
                target[k] = ev;
            } else if (target[k] && typeof target[k] === 'object' && !Array.isArray(target[k]) && ev && typeof ev === 'object' && !Array.isArray(ev)) {
                mergeMissing(target[k], ev);
            }
        }
        return target;
    };

    function statDataFromTables(layoutEntries, tables) {
        const data = { stat_data: {} };
        const sd = data.stat_data;
        const entries = Array.isArray(layoutEntries) ? layoutEntries : [];
        const tbl = tables && typeof tables === 'object' ? tables : {};
        // 一次读快照只建一次表名索引；重复表名沿用旧扫描的“首次匹配”语义。
        const tablesByName = new Map();
        for (const key in tbl) {
            const sheet = tbl[key];
            if (!key.startsWith('sheet_') || !sheet) continue;
            const name = sheet.name;
            if (!tablesByName.has(name)) tablesByName.set(name, sheet);
        }
        const sheetOf = name => tablesByName.get(name) || null;
        const vwdPending = [];
        for (const L of entries) {
            const s = sheetOf(L.table);
            // 内部说明元数据列：既不落进 stat_data，也不参与缺表补默认值。
            const vwdMetaCol = L.vwd && typeof L.vwd.metaCol === 'string' ? L.vwd.metaCol : '';
            const isMetaCol = c => !!vwdMetaCol && c[0] === vwdMetaCol;
            // 新单例完整容器投影：内容列本身就是顶层值，而不是 { 内容: 值 }。
            // 仅缺表窗口使用登记初值；有表而单元格为空/无数据行时保留缺失。
            if (L.kind === 'singleton' && L.valueCol) {
                const c = (L.cols || []).find(c => c[0] === L.valueCol);
                if (!c || c[1] !== 'jsonObjectOptional') continue;
                const rows = s && Array.isArray(s.content) && s.content.length ? s.content : null;
                const ci = rows ? (rows[0] || []).indexOf(L.valueCol) : -1;
                const row = rows && rows.slice(1).find(r => r && String(r[0]) === '1');
                const raw = rows ? (row && ci >= 0 ? row[ci] : undefined) : (c[6] === true ? undefined : c[2]);
                const value = convertCell(c[1], raw, c[2], c[5], c[7]);
                if (value !== undefined) sd[L.group] = value;
                continue;
            }
            if (!s || !Array.isArray(s.content) || !s.content.length) {
                if (L.kind === 'singleton') {
                    // EJS/前端可能在插件回放与布局建立之间同步读取。即使整张表
                    // 尚未出现，也先按布局构造单例组及嵌套路径，避免
                    // stat_data.世界运转.场景 在加载窗口因中间组 undefined 直接抛错。
                    sd[L.group] = {};
                    for (const c of L.cols || []) {
                        if (c[0] === '_扩展数据' || isMetaCol(c)) continue;
                        const cp = Array.isArray(c[3]) && c[3].length ? c[3] : [L.group, c[0]];
                        setPath(sd, cp, ((c[1] === 'jsonScalarOptional' || c[1] === 'jsonPairOptional') || c[1] === 'jsonObjectOptional') ? (c[6] === true ? undefined : convertCell(c[1], c[1] === 'jsonObjectOptional' ? c[2] : JSON.stringify(c[2]), c[2], c[5], c[7])) : convertCell(c[1], undefined, c[2], c[5], c[7]));
                    }
                }
                else if (L.kind === 'rows') { for (const wp of L.writePaths || []) setPath(sd, wp, L.emptyValue === null ? null : {}); }
                else if (L.kind === 'nestedRows') { /* 所属实体记录尚未出现时不虚构关联键 */ }
                else if (L.kind === 'pathArray') { setPath(sd, L.path || [L.group], []); }
                else if (L.kind === 'nestedArray') { /* 同上，不虚构关联键 */ }
                else if (L.kind === 'array') { sd[L.group] = []; for (const m of L.mirrors || []) setPath(sd, m.path, ''); }
                else if (L.kind === 'json') { sd[L.group] = L.scalarType === 'number' ? ((L.cols || [])[0] || [])[2] ?? 0 : {}; }
                if (L.kind === 'singleton' && vwdMetaCol) vwdPending.push({ entry: L, header: [], row: [] });
                continue;
            }
            // 读方向只认 content（真实数据）：seedRows 是插件"模板基底/待物化"行，
            // 若把它们当已存在数据展示，删除后插件补回 seedRows 时 UI 会"死而复生"。
            // 真实数据是否进 content 由写路径的物化保证（首写强制物化 + 快照提交）。
            const sRows = s.content && s.content.length ? s.content : [s.content && s.content[0] || ['row_id']];
            const header = sRows[0] || [];
            const idxs = (L.cols || []).map(c => header.indexOf(c[0]));
            if (L.kind === 'singleton') {
                const row = sRows[1] || [];
                sd[L.group] = {};
                for (let j = 0; j < (L.cols || []).length; j++) {
                    const c = L.cols[j];
                    if (c[0] === '_扩展数据' || isMetaCol(c)) continue;
                    const vj = idxs[j] >= 0 ? row[idxs[j]] : undefined;
                    const cp = c.length > 3 && c[3] && c[3].length ? c[3] : [L.group, c[0]];
                    // 兼容旧布局里值为空的容器列（如 主角.资产）：它只是“该对象已拆
                    // 列/子表”的占位，不应覆盖前面已经重建好的嵌套对象，否则
                    // 资产.场币/状态.生命值百分比 等标量字段会全部丢失。
                    const existingAt = getPath(sd, cp);
                    if (existingAt && typeof existingAt === 'object' && !Array.isArray(existingAt) && (vj === undefined || vj === null || vj === '')) continue;
                    setPath(sd, cp, convertCell(c[1], vj, c[2], c[5], c[7]));
                }
                if (vwdMetaCol) vwdPending.push({ entry: L, header, row });
                const sovIdx = header.indexOf('_扩展数据');
                if (sovIdx >= 0 && row[sovIdx]) {
                    const sov = parseObject(row[sovIdx]);
                    mergeMissing(sd[L.group], sov);
                }
            } else if (L.kind === 'array') {
                const arr = [];
                // 新 layout 带 valueCol/cols，元素以 JSON 标量保存；旧卡的 layout
                // 没有这些字段，继续把第一列按文本读取，避免把旧字符串误解析。
                const valueCol = L.valueCol || ((L.cols || [])[0] && L.cols[0][0]) || header[1] || '内容';
                const valueIdx = header.indexOf(valueCol);
                const valueDef = (L.cols || []).find(c => c[0] === valueCol);
                for (let r = 1; r < sRows.length; r++) {
                    const rw = sRows[r];
                    if (rw && valueIdx >= 0 && rw[valueIdx] !== undefined) {
                        arr.push(valueDef ? convertCell(valueDef[1], rw[valueIdx], valueDef[2], valueDef[5], valueDef[7]) : text(rw[valueIdx]));
                    }
                }
                sd[L.group] = arr;
                for (const m of L.mirrors || []) setPath(sd, m.path, m.mode === 'first' ? (arr.length ? arr[0] : '') : arr);
            } else if (L.kind === 'pathArray') {
                const arr = [];
                const vc = (L.cols || []).find(c => c[0] === L.valueCol) || (L.cols || [])[0];
                const vi = header.indexOf(L.valueCol);
                for (let r = 1; r < sRows.length; r++) {
                    const rw = sRows[r];
                    if (rw && vi >= 0) arr.push(convertCell(vc ? vc[1] : 'text', rw[vi], vc ? vc[2] : '', vc ? vc[5] : '', vc ? vc[7] : undefined));
                }
                setPath(sd, L.path, arr);
            } else if (L.kind === 'nestedArray') {
                const pi = header.indexOf(L.parentKeyCol);
                const vi = header.indexOf(L.valueCol);
                const vc = (L.cols || []).find(c => c[0] === L.valueCol);
                const parents = sd[L.group];
                if (parents && typeof parents === 'object' && !Array.isArray(parents)) {
                    const childKey = L.path && L.path.length ? L.path[L.path.length - 1] : '';
                    for (const pk of Object.keys(parents)) if (parents[pk] && typeof parents[pk] === 'object') parents[pk][childKey] = [];
                    for (let r = 1; r < sRows.length; r++) {
                        const rw = sRows[r];
                        if (!rw || pi < 0 || vi < 0) continue;
                        const pk = text(rw[pi]);
                        if (!pk || !parents[pk] || typeof parents[pk] !== 'object') continue;
                        parents[pk][childKey].push(convertCell(vc ? vc[1] : 'text', rw[vi], vc ? vc[2] : '', vc ? vc[5] : '', vc ? vc[7] : undefined));
                    }
                }
            } else if (L.kind === 'json') {
                const jrow = sRows[1] || [];
                const jidx = header.indexOf('内容');
                const jv = jidx >= 0 ? jrow[jidx] : undefined;
                const numeric = L.scalarType === 'number';
                const fallback = ((L.cols || [])[0] || [])[2] ?? 0;
                const n = (typeof jv === 'number' || (typeof jv === 'string' && jv.trim())) ? Number(jv) : NaN;
                const jparsed = numeric ? (Number.isFinite(n) ? n : fallback) : parseObject(jv);
                sd[L.group] = jparsed === undefined ? {} : jparsed;
                for (const m of L.mirrors || []) setPath(sd, m.path, m.mode === 'first' ? (jparsed && typeof jparsed === 'object' && !Array.isArray(jparsed) ? jparsed : '') : jparsed);
            } else if (L.kind === 'nestedRows') {
                const ancestorCols = Array.isArray(L.ancestorKeyCols) && L.ancestorKeyCols.length ? L.ancestorKeyCols : [L.parentKeyCol];
                const ancestorIdxs = ancestorCols.map(col => header.indexOf(col));
                const keyIdx = header.indexOf(L.keyCol);
                const relationPattern = (L.writePaths && L.writePaths[0]) || [...(L.parentPath || [L.group]), '*', L.childKey];
                const prepareContainers = (cur, pos) => {
                    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return;
                    if (pos === relationPattern.length - 1) {
                        const child = relationPattern[pos];
                        if (!(child in cur) || !cur[child] || typeof cur[child] !== 'object' || Array.isArray(cur[child])) cur[child] = {};
                        return;
                    }
                    const token = relationPattern[pos];
                    if (token === '*') {
                        for (const k of Object.keys(cur)) prepareContainers(cur[k], pos + 1);
                    } else {
                        prepareContainers(cur[token], pos + 1);
                    }
                };
                prepareContainers(sd, 0);
                for (let r2 = 1; r2 < sRows.length; r2++) {
                    const rw2 = sRows[r2];
                    if (!rw2) continue;
                    const ancestorValues = ancestorIdxs.map(i => i >= 0 ? rw2[i] : undefined);
                    const kv = keyIdx >= 0 ? rw2[keyIdx] : undefined;
                    if (ancestorValues.some(v => v === undefined || v === null || v === '') || kv === undefined || kv === null || kv === '') continue;
                    let container = sd;
                    let ancestorPos = 0;
                    for (let pi = 0; pi < relationPattern.length - 1; pi++) {
                        const token = relationPattern[pi];
                        const actual = token === '*' ? text(ancestorValues[ancestorPos++]) : token;
                        if (!container || typeof container !== 'object' || Array.isArray(container) || !container[actual] || typeof container[actual] !== 'object' || Array.isArray(container[actual])) {
                            container = null;
                            break;
                        }
                        container = container[actual];
                    }
                    if (!container) continue;
                    const childKey = relationPattern[relationPattern.length - 1] || L.childKey;
                    if (!container[childKey] || typeof container[childKey] !== 'object' || Array.isArray(container[childKey])) container[childKey] = {};
                    const childDict = container[childKey];
                    if (L.scalarValueCol) {
                        const svc = (L.cols || []).find(c => c[0] === L.scalarValueCol);
                        const svIdx = svc ? header.indexOf(svc[0]) : -1;
                        const sv = svIdx >= 0 ? rw2[svIdx] : undefined;
                        setPath(childDict, [text(kv)], svc ? convertCell(svc[1], sv, svc[2], svc[5], svc[7]) : text(sv));
                        continue;
                    }
                    const item = {};
                    for (let j2 = 0; j2 < (L.cols || []).length; j2++) {
                        const c2 = L.cols[j2];
                        if (ancestorCols.includes(c2[0]) || c2[0] === L.keyCol || c2[0] === '_扩展数据') continue;
                        const vj2 = idxs[j2] >= 0 ? rw2[idxs[j2]] : undefined;
                        const cp2 = c2.length > 3 && Array.isArray(c2[3]) && c2[3].length ? c2[3] : [c2[0]];
                        setPath(item, cp2, convertCell(c2[1], vj2, c2[2], c2[5], c2[7]));
                    }
                    const ovIdx = header.indexOf('_扩展数据');
                    if (ovIdx >= 0 && rw2[ovIdx]) mergeMissing(item, parseObject(rw2[ovIdx]) || {});
                    childDict[text(kv)] = item;
                }
            } else {
                const dict = {};
                const keyIdx = header.indexOf(L.keyCol);
                for (let r2 = 1; r2 < sRows.length; r2++) {
                    const rw2 = sRows[r2];
                    if (!rw2) continue;
                    const kv = keyIdx >= 0 ? rw2[keyIdx] : undefined;
                    if (kv === undefined || kv === null || kv === '') continue;
                    // 标量条目行表（如 修仙秘闻: { 标题: 内容 }）：读回 {键: 标量}，
                    // 保持与 MVU 原 shape 一致（前端 zod 声明 z.record(z.string(), z.string())）。
                    if (L.scalarValueCol) {
                        const svc = (L.cols || []).find(c => c[0] === L.scalarValueCol);
                        const svIdx = svc ? header.indexOf(svc[0]) : -1;
                        const sv = svIdx >= 0 ? rw2[svIdx] : undefined;
                        setPath(dict, [text(kv)], svc ? convertCell(svc[1], sv, svc[2], svc[5], svc[7]) : (sv === undefined || sv === null ? '' : String(sv)));
                        continue;
                    }
                    const item = {};
                    for (let j2 = 0; j2 < (L.cols || []).length; j2++) {
                        const c2 = L.cols[j2];
                        if (c2[0] === '_扩展数据' || c2[0] === L.keyCol) continue;
                        const vj2 = idxs[j2] >= 0 ? rw2[idxs[j2]] : undefined;
                        // 条目对象键优先用列 path 末尾的原始中文：列名因拼音冲突被
                        // 消歧改名（山西→山西2）时，读回仍还原 stat_data.<组>.<山西>，
                        // 不破坏 MVU 原 shape（普通行表列 path 末尾即字段名，行为不变）。
                        const cp2 = c2 && c2.length > 3 && Array.isArray(c2[3]) && c2[3].length ? c2[3] : null;
                        setPath(item, cp2 || [c2[0]], convertCell(c2[1], vj2, c2[2], c2[5], c2[7]));
                    }
                    const ovIdx = header.indexOf('_扩展数据');
                    if (ovIdx >= 0 && rw2[ovIdx]) {
                        const ov = parseObject(rw2[ovIdx]);
                        mergeMissing(item, ov);
                    }
                    dict[text(kv)] = item;
                }
                const rowValue = Object.keys(dict).length === 0 && L.emptyValue === null ? null : dict;
                for (const wp2 of L.writePaths || []) setPath(sd, wp2, rowValue);
            }
        }
        // 说明覆盖在所有业务列重建完成后再套用：只改 pair 叶子的当前说明，
        // 不改值、不建键、不触碰未登记字段。
        for (const item of vwdPending) {
            const overrides = vwdOverridesFromRow(item.entry, item.header, item.row);
            applyVwdDescriptions(item.entry, overrides, sd);
        }
        try { data.display_data = JSON.parse(JSON.stringify(sd)); } catch (e) {}
        return data;
    }

    /* ---------------- VWD 说明插槽：note 重建的确定性纯函数 ----------------
     * 转换期为每个 VWD 字段在 note 的【字段说明与规则】中该字段条目的说明位置留下
     * 唯一插槽，并把整份 note 存进 layout.vwd.plan。运行期只做一次按字段的 token
     * 替换，不猜位置、不做 replace(旧说明, 新说明)，因此两个字段说明相同、多行说明、
     * 空说明都能正确归属。插槽计划属于内部渲染数据，不进入模型请求。
     */
    const VWD_TOKEN_PREFIX = '\u0000VWD·';
    const VWD_TOKEN_SUFFIX = '\u0000';
    const VWD_TOKEN_RE = /\u0000VWD·(\d+)\u0000/g;

    function vwdToken(index) {
        return VWD_TOKEN_PREFIX + String(index) + VWD_TOKEN_SUFFIX;
    }

    function vwdNoteTokens() {
        return { token: vwdToken, prefix: VWD_TOKEN_PREFIX, suffix: VWD_TOKEN_SUFFIX, regex: VWD_TOKEN_RE };
    }

    // 用 token→说明 的回调替换插槽。缺失/非法插槽按空说明处理，并整行丢弃：
    // 说明缺失的字段不应在提示词里留下“字段名：”这类空壳。
    function vwdNoteFromSlots(plan, resolver) {
        const source = String(plan == null ? '' : plan);
        if (!source) return '';
        const lines = source.split('\n');
        const out = [];
        for (const line of lines) {
            VWD_TOKEN_RE.lastIndex = 0;
            if (!VWD_TOKEN_RE.test(line)) { out.push(line); continue; }
            VWD_TOKEN_RE.lastIndex = 0;
            const replaced = line.replace(VWD_TOKEN_RE, (whole, digits) => {
                const value = typeof resolver === 'function' ? resolver(Number(digits)) : undefined;
                return value === undefined || value === null ? '' : String(value);
            });
            if (!replaced.replace(/[\s\u3000]/g, '')) continue;
            out.push(replaced);
        }
        return out.join('\n');
    }

    /* ---------------- VWD 说明差量预检（原始数据，未折叠） ----------------
     * 供候选快照构造在折叠 pair 之前调用：折叠会丢掉第二项，只看折叠后的数据会漏掉
     * 说明变化。这里按 layout.vwd.fields 登记范围逐字段比较原始说明，返回拒绝原因字符串
     * （空串表示放行）。登记范围内的字段一律检查，与它有没有 note 插槽无关。
     */
    function vwdDescriptionDelta(layoutEntries, prevStat, nextStat) {
        for (const L of (Array.isArray(layoutEntries) ? layoutEntries : [])) {
            if (!L || L.kind !== 'singleton') continue;
            const fields = vwdFieldsOf(L);
            if (!fields) continue;
            const changed = [];
            for (const field of fields) {
                if (!field || !field.id || !Array.isArray(field.path) || !field.path.length) continue;
                const nd = vwdDescriptionAt_(nextStat, field.path);
                const pd = vwdDescriptionAt_(prevStat, field.path);
                // 只有“确实提供了字符串说明、且与原说明不同”才算说明变化：
                // 字段被删除、值不是 [值, 说明] 形状时都不算。
                if (nd !== undefined && nd !== pd) changed.push(field.col || field.id);
            }
            if (changed.length) {
                return '表「' + L.table + '」字段 ' + changed.join('、') + ' 的说明变化无法同步进提示词';
            }
        }
        return '';
    }

    function vwdDescriptionAt_(node, path) {
        let cur = node;
        for (const part of path) {
            if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
            cur = cur[part];
        }
        return Array.isArray(cur) && cur.length === 2 && typeof cur[1] === 'string' ? cur[1] : undefined;
    }

    // 转换期落进卡与 sourceData 的 note：插槽全部换成字段静态说明。这样没有运行期
    // 覆盖时，写进 sourceData 的文本与旧版逐字节相同；插槽计划只留在内部布局里。
    function stripVwdNoteTokens(plan, fields) {
        const list = Array.isArray(fields) ? fields : [];
        return vwdNoteFromSlots(plan, index => {
            const field = list[index];
            return field ? String(field.desc == null ? '' : field.desc) : '';
        });
    }

    // 当前有效说明表（fieldId → 说明文本）：覆盖优先，未覆盖回退该字段静态默认。
    // 契约是**逐键回退**：覆盖集合里合法的字符串项照常生效，非法项（数值、未登记键、
    // 版本不符、无效 JSON）单独忽略，不影响同表其它字段；不报成功也不部分套用非法项。
    function vwdCurrentDescriptions(entry, row, header) {
        const fields = vwdFieldsOf(entry);
        const out = new Map();
        if (!fields) return out;
        const overrides = row === undefined && header === undefined ? null : vwdOverridesFromRow(entry, header, row);
        for (const field of fields) {
            if (!field || typeof field !== 'object' || !field.id) continue;
            out.set(field.id, overrides && overrides.has(field.id) ? overrides.get(field.id) : String(field.desc == null ? '' : field.desc));
        }
        return out;
    }

    // 说明是数据，不是待执行模板。普通文字保持可读；可能触发下游 EJS、酒馆宏、
    // SP 查询/条件/随机模板的字符使用可逆的 JSON 字符串表示，不能靠代码块保护。
    function formatVwdPromptDescription(value) {
        const text = String(value == null ? '' : value);
        if (!/[<>{}$&\u0000-\u001f\u2028\u2029]/.test(text)) return text;
        return '（说明以 JSON 字符串表示）' + JSON.stringify(text).replace(/[<>{}$&\u2028\u2029]/g,
            ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
    }

    function vwdPromptParts(plan, table) {
        const fields = plan && Array.isArray(plan.fields) ? plan.fields : [];
        const js = value => JSON.stringify(value).replace(/[<>{}$&\u2028\u2029]/g,
            ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
        const variable = '__mvu2shujukuVwd_' + Array.from(String(table)).map(ch => ch.codePointAt(0).toString(16)).join('_');
        return { fields, variable, prelude: '<% var ' + variable + ' = mvu2shujukuVwdDescriptions('
            + js(String(table)) + ', ' + js(fields.map(f => f.id)) + '); %>' };
    }

    // 原规则/宏继续在原位置执行；只将字段说明插槽换为动态数据读取。
    function buildVwdPromptNote(plan, table) {
        if (!plan || plan.promptVersion !== 1 || typeof plan.plan !== 'string') return null;
        const { fields, variable, prelude } = vwdPromptParts(plan, table);
        return prelude + '\n' + vwdNoteFromSlots(plan.plan, index => {
            const fieldIndex = fields.findIndex(field => field.id === plan.tokens[index]);
            return fieldIndex < 0 ? '' : '<%- ' + variable + '[' + fieldIndex + '] %>';
        });
    }

    function vwdPromptMatches(entry, sheet) {
        if (!entry || !entry.vwd || entry.vwd.promptVersion !== 1 || !sheet || sheet.name !== entry.table) return false;
        if (!Array.isArray(sheet.content) || !Array.isArray(sheet.content[0]) || !sheet.content[0].includes(entry.vwd.metaCol)) return false;
        if (!entry.vwd.fields.every(field => field.noteSlot && entry.vwd.plan.includes(field.noteSlot))) return false;
        return sheet.sourceData && sheet.sourceData.note === entry.vwd.noteTemplate
            && vwdPromptShapeMatches(entry.vwd, entry.table, sheet.sourceData.note);
    }

    function vwdPromptShapeMatches(plan, table, note) {
        if (!plan || plan.promptVersion !== 1 || typeof note !== 'string') return false;
        const { fields, variable, prelude } = vwdPromptParts(plan, table);
        return note.startsWith(prelude) && fields.every((field, index) =>
            field.noteSlot && plan.plan.includes(field.noteSlot) && note.includes('<%- ' + variable + '[' + index + '] %>'));
    }

    function bindVwdPromptNote(plan, table, note) {
        if (!vwdPromptShapeMatches(plan, table, note)) return false;
        plan.noteTemplate = note;
        return true;
    }

    function vwdPromptDescriptions(entry, sheet) {
        if (!vwdPromptMatches(entry, sheet) || !Array.isArray(sheet.content) || !Array.isArray(sheet.content[1])) {
            throw new Error('动态说明的布局、模板或已提交数据不完整');
        }
        const current = vwdCurrentDescriptions(entry, sheet.content[1], sheet.content[0]);
        return entry.vwd.fields.map(field => formatVwdPromptDescription(current.get(field.id)));
    }

    // 按插槽计划为整表重建 note。没有插槽计划（旧布局/无 VWD 字段）返回 null，
    // 调用方继续使用原 sourceData.note，旧行为不变。
    function resolveVwdNote(entry, row, header) {
        const plan = entry && entry.vwd && typeof entry.vwd.plan === 'string' ? entry.vwd.plan : '';
        if (!plan) return null;
        const current = vwdCurrentDescriptions(entry, row, header);
        const slots = entry.vwd.tokens || [];
        return vwdNoteFromSlots(plan, index => {
            const token = slots[index];
            return token && current.has(token) ? current.get(token) : '';
        });
    }

    return { statDataFromTables, text, number, boolean, parseObject, convertCell, setPath, getPath, mergeMissing, vwdFieldId, applyVwdDescriptions, vwdOverridesFromRow, vwdNoteFromSlots, stripVwdNoteTokens, vwdCurrentDescriptions, resolveVwdNote, vwdNoteTokens, vwdDescriptionDelta, formatVwdPromptDescription, buildVwdPromptNote, vwdPromptMatches, vwdPromptDescriptions, bindVwdPromptNote };
}

if (typeof module !== 'undefined' && module.exports) module.exports = createTableCodec;
