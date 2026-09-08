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
    const convertCell = (type, v, fb, desc) => {
        if (type === 'number') return number(v, fb);
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
        cur[path[path.length - 1]] = value;
    };
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
        for (const L of entries) {
            const s = sheetOf(L.table);
            if (!s || !Array.isArray(s.content) || !s.content.length) {
                if (L.kind === 'singleton') {
                    // EJS/前端可能在插件回放与布局建立之间同步读取。即使整张表
                    // 尚未出现，也先按布局构造单例组及嵌套路径，避免
                    // stat_data.世界运转.场景 在加载窗口因中间组 undefined 直接抛错。
                    sd[L.group] = {};
                    for (const c of L.cols || []) {
                        if (c[0] === '_扩展数据') continue;
                        const cp = Array.isArray(c[3]) && c[3].length ? c[3] : [L.group, c[0]];
                        setPath(sd, cp, convertCell(c[1], undefined, c[2], c[5]));
                    }
                }
                else if (L.kind === 'rows') { for (const wp of L.writePaths || []) setPath(sd, wp, L.emptyValue === null ? null : {}); }
                else if (L.kind === 'nestedRows') { /* 所属实体记录尚未出现时不虚构关联键 */ }
                else if (L.kind === 'pathArray') { setPath(sd, L.path || [L.group], []); }
                else if (L.kind === 'nestedArray') { /* 同上，不虚构关联键 */ }
                else if (L.kind === 'array') { sd[L.group] = []; for (const m of L.mirrors || []) setPath(sd, m.path, ''); }
                else if (L.kind === 'json') { sd[L.group] = {}; }
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
                    if (c[0] === '_扩展数据') continue;
                    const vj = idxs[j] >= 0 ? row[idxs[j]] : undefined;
                    const cp = c.length > 3 && c[3] && c[3].length ? c[3] : [L.group, c[0]];
                    // 兼容旧布局里值为空的容器列（如 主角.资产）：它只是“该对象已拆
                    // 列/子表”的占位，不应覆盖前面已经重建好的嵌套对象，否则
                    // 资产.场币/状态.生命值百分比 等标量字段会全部丢失。
                    const existingAt = getPath(sd, cp);
                    if (existingAt && typeof existingAt === 'object' && !Array.isArray(existingAt) && (vj === undefined || vj === null || vj === '')) continue;
                    setPath(sd, cp, convertCell(c[1], vj, c[2], c[5]));
                }
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
                        arr.push(valueDef ? convertCell(valueDef[1], rw[valueIdx], valueDef[2], valueDef[5]) : text(rw[valueIdx]));
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
                    if (rw && vi >= 0) arr.push(convertCell(vc ? vc[1] : 'text', rw[vi], vc ? vc[2] : '', vc ? vc[5] : ''));
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
                        parents[pk][childKey].push(convertCell(vc ? vc[1] : 'text', rw[vi], vc ? vc[2] : '', vc ? vc[5] : ''));
                    }
                }
            } else if (L.kind === 'json') {
                const jrow = sRows[1] || [];
                const jidx = header.indexOf('内容');
                const jv = jidx >= 0 ? jrow[jidx] : undefined;
                const jparsed = parseObject(jv);
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
                        childDict[text(kv)] = svc ? convertCell(svc[1], sv, svc[2], svc[5]) : text(sv);
                        continue;
                    }
                    const item = {};
                    for (let j2 = 0; j2 < (L.cols || []).length; j2++) {
                        const c2 = L.cols[j2];
                        if (ancestorCols.includes(c2[0]) || c2[0] === L.keyCol || c2[0] === '_扩展数据') continue;
                        const vj2 = idxs[j2] >= 0 ? rw2[idxs[j2]] : undefined;
                        const cp2 = c2.length > 3 && Array.isArray(c2[3]) && c2[3].length ? c2[3] : [c2[0]];
                        setPath(item, cp2, convertCell(c2[1], vj2, c2[2], c2[5]));
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
                        dict[text(kv)] = svc ? convertCell(svc[1], sv, svc[2], svc[5]) : (sv === undefined || sv === null ? '' : String(sv));
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
                        setPath(item, cp2 || [c2[0]], convertCell(c2[1], vj2, c2[2], c2[5]));
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
        try { data.display_data = JSON.parse(JSON.stringify(sd)); } catch (e) {}
        return data;
    }

    return { statDataFromTables, text, number, boolean, parseObject, convertCell, setPath, getPath, mergeMissing };
}

if (typeof module !== 'undefined' && module.exports) module.exports = createTableCodec;
