'use strict';
// v0.3.17 (1c4c9a6) 的旧桥源码快照，仅用于已有卡迁移回归，不参与构建。
module.exports = function createLegacyBridgeGenerator(core) {
const VERSION = '0.3.17';
const buildLayout = core.buildLayout;
const btoaSafe = s => Buffer.from(s, 'utf8').toString('base64');
const getTableCodecFactory = () => (function(){ const module={exports:{}};
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
                else if (L.kind === 'json') { sd[L.group] = L.scalarType === 'number' ? ((L.cols || [])[0] || [])[2] ?? 0 : {}; }
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

return module.exports;})();
const getTableWriterFactory = () => (function(){ const module={exports:{}};
'use strict';

/**
 * 将 stat_data 差异适配为插件原生 CRUD。
 * 宿主 API、布局、快照均显式传入；模块不安装事件、不选择聊天、不保存宿主。
 * 保留计划操作数量与 lastStatWriteFailed 契约；调用方负责会话校验和串行调度。
 */
function createTableWriter(dependencies) {
    const { parseJson: safeParseJson, readCachedTemplate = () => null,
        debugOn: mvu2shujukuDebugOn = () => false,
        debug: dbg = () => {}, warn: dbgWarn = () => {} } = dependencies;
    if (typeof safeParseJson !== 'function') throw new Error('写入模块需要 JSON 解析函数');
    let statWriteHadFailure = false;
    async function writeStatDiffToDb(api, layoutEntries, prevStat, nextStat, persistedTables) {
        statWriteHadFailure = false;
        let abortWrites = false;
        const markWriteFailure = (label, error) => {
            statWriteHadFailure = true;
            abortWrites = true;
            if (error) dbgWarn(' ' + label + ' 失败:', error);
            else dbgWarn(' ' + label + ' 返回失败结果。');
        };
        const entries = Array.isArray(layoutEntries) ? layoutEntries : [];
        const pathParts = (s) => String(s || '').split('.');
        const tableEntryByPath = (pathStr) => {
            let best = null;
            const pp = pathParts(pathStr);
            for (const L of entries) {
                if (L.kind === 'array') {
                    if (pathStr === L.group) return { layout: L, kind: 'array' };
                    continue;
                }
                if (L.kind === 'pathArray') {
                    const prefix = L.path || [];
                    if (pathStr === prefix.join('.')) return { layout: L, kind: L.kind, prefix };
                    continue;
                }
                if (L.kind === 'nestedArray') {
                    const p = L.path || [];
                    if (pp.length === 3 && pp[0] === L.group && p.length && pp[2] === p[p.length - 1]) {
                        return { layout: L, kind: L.kind, prefix: [pp[0], pp[1], pp[2]] };
                    }
                    continue;
                }
                if (L.kind === 'nestedRows') {
                    const pattern = (L.writePaths && L.writePaths[0]) || [...(L.parentPath || [L.group]), '*', L.childKey];
                    // 集合路径本身也要路由到关系表，随后递归到条目/字段；若要求必须
                    // 已带条目键，上一层行表会先把整个集合误判成 _扩展数据。
                    const matches = pp.length >= pattern.length && pattern.every((p, i) => p === '*' || pp[i] === p);
                    if (matches) {
                        const prefix = pattern.map((p, i) => p === '*' ? pp[i] : p);
                        const ancestorValues = pattern.map((p, i) => p === '*' ? pp[i] : undefined).filter(v => v !== undefined);
                        if (!best || prefix.length > best.prefix.length) best = { layout: L, kind: L.kind, prefix, ancestorValues };
                    }
                    continue;
                }
                const prefix = L.kind === 'singleton' ? [L.group] : ((L.writePaths || [])[0] || [L.group]);
                const pre = prefix.join('.');
                if (pathStr === pre || pathStr.indexOf(pre + '.') === 0) {
                    // 最长前缀优先：避免单例组遮蔽其子表路径（如 主角.储物袋.* 应路由到子表）
                    if (!best || prefix.length > best.prefix.length) best = { layout: L, kind: L.kind, prefix };
                }
            }
            return best;
        };
        let tables = {};
        try { tables = api.exportTableAsJson() || {}; } catch (e) {}
        // 前端“渲染回写”抑制的辅助判定：`_` 前缀内部状态（如 _hypnoos）是否为“全默认/空”。
        // version 键按“任何数字=默认”处理（schema 版本号），其余数字须为 0；
        // 只要有任何真实内容（非空容器/true/非零值）即为非默认 → 允许落库（用户真实操作）。
        const isStructurallyDefault = (v, isVersion) => {
            if (v === undefined || v === null) return true;
            if (typeof v === 'string') return v === '';
            if (typeof v === 'boolean') return v === false;
            if (typeof v === 'number') return isVersion ? true : v === 0;
            if (Array.isArray(v)) return v.length === 0;
            if (typeof v === 'object') {
                for (const kk in v) {
                    if (!isStructurallyDefault(v[kk], kk === 'version')) return false;
                }
                return true;
            }
            return false;
        };
        const sheetOf = (name) => {
            for (const k in tables) {
                if (k.indexOf('sheet_') === 0 && tables[k] && tables[k].name === name) return { key: k, sheet: tables[k] };
            }
            return null;
        };
        const findRowByColumn = (sheet, colName, value) => {
            if (!sheet || !Array.isArray(sheet.content)) return -1;
            const ci = sheet.content[0] ? sheet.content[0].indexOf(colName) : -1;
            if (ci === -1) return -1;
            for (let i = 1; i < sheet.content.length; i++) {
                if (sheet.content[i] && String(sheet.content[i][ci]) === String(value)) return i;
            }
            return -1;
        };
        const findRelationRow = (sheet, parentCol, parentValue, keyCol, keyValue) => {
            if (!sheet || !Array.isArray(sheet.content) || !sheet.content[0]) return -1;
            const pi = sheet.content[0].indexOf(parentCol);
            const ki = sheet.content[0].indexOf(keyCol);
            if (pi === -1 || ki === -1) return -1;
            for (let i = 1; i < sheet.content.length; i++) {
                const row = sheet.content[i];
                if (row && String(row[pi]) === String(parentValue) && String(row[ki]) === String(keyValue)) return i;
            }
            return -1;
        };
        const findRelationRowByAncestors = (sheet, layout, ancestorValues, keyValue) => {
            if (!sheet || !Array.isArray(sheet.content) || !sheet.content[0]) return -1;
            const cols = Array.isArray(layout.ancestorKeyCols) && layout.ancestorKeyCols.length ? layout.ancestorKeyCols : [layout.parentKeyCol];
            const idxs = cols.map(col => sheet.content[0].indexOf(col));
            const ki = sheet.content[0].indexOf(layout.keyCol);
            if (ki === -1 || idxs.some(i => i === -1)) return -1;
            for (let i = 1; i < sheet.content.length; i++) {
                const row = sheet.content[i];
                if (row && idxs.every((idx, ai) => String(row[idx]) === String((ancestorValues || [])[ai])) && String(row[ki]) === String(keyValue)) return i;
            }
            return -1;
        };
        const sameValue = (a, b) => {
            const na = a === undefined || a === null ? '' : a;
            const nb = b === undefined || b === null ? '' : b;
            // SP 单元格不能存布尔（SyncBridge 归一化 true→1/false→0），而快照/读回侧仍是
            // 布尔。布尔与数字按数值等价比较，否则 1↔true 每轮都被判为差异，形成
            // “写入 true → 存为 1 → 下轮再判差异”的回声（圣樱学院-RE 开场 19 条无效写）。
            const aIsBool = typeof na === 'boolean';
            const bIsBool = typeof nb === 'boolean';
            if ((aIsBool || bIsBool) && (aIsBool || typeof na === 'number') && (bIsBool || typeof nb === 'number')) {
                return Number(na) === Number(nb);
            }
            return String(na) === String(nb);
        };
        const ops = [];
        const collect = (prevObj, nextObj, pathStr) => {
            const keys = Object.keys(nextObj || {});
            for (const k of keys) {
                const np = pathStr ? pathStr + '.' + k : k;
                const nv = nextObj[k];
                const pv = prevObj ? prevObj[k] : undefined;
                const entry = tableEntryByPath(np);
                if (entry && (entry.kind === 'array' || entry.kind === 'pathArray' || entry.kind === 'nestedArray')) {
                    ops.push({ np, entry, value: nv, replace: true });
                    continue;
                }
                if (entry && entry.kind === 'json') {
                    if (entry.layout.scalarType === 'number' && (typeof nv !== 'number' || !Number.isFinite(nv))) {
                        markWriteFailure('数值表「' + entry.layout.table + '」只接受有限数字');
                        continue;
                    }
                    // JSON 组允许对象、数组和标量；数据形状不能证明调用来自默认值回写。
                    // 统一接收实际变化，后续与数据库当前内容比较以跳过无变化的重复写入。
                    ops.push({ np, entry, value: nv, json: true });
                    continue;
                }
                if (entry && (entry.kind === 'singleton' || entry.kind === 'rows' || entry.kind === 'nestedRows')) {
                    const pre = entry.prefix.join('.');
                    const rel = np === pre ? [] : np.slice(pre.length + 1).split('.');
                    const fIdx = (entry.kind === 'rows' || entry.kind === 'nestedRows') ? 1 : 0;
                    if (rel.length > fIdx) {
                        // 展平后的嵌套 JSON 列也必须在容器边界整块写入。例如动态行表的
                        // 登神长阶.要素 对应列 path=[登神长阶,要素]。旧逻辑只按首段
                        // `登神长阶` 找列，找不到后继续递归到对象叶子，最终新行的 JSON
                        // 列保持空字符串并触发 json_valid CHECK。
                        const logicalPath = rel.slice(fIdx);
                        const exactColDef = (entry.layout.cols || []).find(c => {
                            let cp = Array.isArray(c) ? (c[3] || []) : (c.path || []);
                            if (entry.kind === 'singleton' && cp[0] === entry.layout.group) cp = cp.slice(1);
                            return Array.isArray(cp) && cp.length === logicalPath.length && cp.every((p, i) => p === logicalPath[i]);
                        });
                        const exactColType = exactColDef && (Array.isArray(exactColDef) ? exactColDef[1] : exactColDef.type);
                        if (exactColDef && /object|json/i.test(String(exactColType || ''))) {
                            ops.push({
                                np,
                                entry,
                                value: nv,
                                prev: pv,
                                jsonCell: true,
                                col: Array.isArray(exactColDef) ? exactColDef[0] : exactColDef.zh,
                            });
                            continue;
                        }
                        if (exactColDef && (nv === null || typeof nv !== 'object')) {
                            ops.push({
                                np,
                                entry,
                                value: nv,
                                prev: pv,
                                col: Array.isArray(exactColDef) ? exactColDef[0] : exactColDef.zh,
                            });
                            continue;
                        }
                        const fld = rel[fIdx];
                        const declared = entry.layout.cols.some(c => c[0] === fld);
                        if (!declared) {
                            // 与 mergeOverflow 同一套排除：子表与已展平为列的嵌套容器
                            // （如 主角.炼丹 → 炼丹阶级/炼丹熟练度 列）不是溢出字段，
                            // 递归到叶子后按列路径落列，绝不能写进 _扩展数据。
                            const groupName0 = String(entry.layout.group || entry.prefix[0] || '');
                            let isChildGroup = false;
                            let isFlattened = false;
                            for (const L2 of entries) {
                                if (L2 === entry.layout) continue;
                                const wp = (L2.writePaths || [])[0];
                                if (Array.isArray(wp) && wp.length >= 2 && wp[0] === groupName0 && wp[1] === fld) { isChildGroup = true; break; }
                            }
                            if (!isChildGroup) {
                                for (const c of (entry.layout.cols || [])) {
                                    const cp = Array.isArray(c) ? (c[3] || []) : (c.path || []);
                                    if (Array.isArray(cp) && (
                                        ((entry.kind === 'rows' || entry.kind === 'nestedRows') && cp.length > 1 && cp[0] === fld) ||
                                        (entry.kind !== 'rows' && cp.length > 1 && cp[0] === groupName0 && cp[1] === fld)
                                    )) { isFlattened = true; break; }
                                }
                            }
                            if (!isChildGroup && !isFlattened) {
                                // 前端渲染回写抑制（通用）：`_` 前缀内部状态字段（如 _hypnoos）
                                // 当前不存在且新值为“全默认/空”时，标记为“回声候选”，稍后按
                                // 组级判定：同批写入若有其他真实变化（如成就领取同时改 当前MC点）
                                // 则放行；只有它自己是唯一变化时才是前端 schema 默认回声，跳过。
                                const mk0 = (entry.kind === 'rows' || entry.kind === 'nestedRows') ? rel[1] : rel[0];
                                if (String(mk0).charAt(0) === '_' && pv === undefined && isStructurallyDefault(nv)) {
                                    ops.push({ np, entry, value: nv, prev: pv, overflow: true, echoCandidate: true, mergeKey: mk0, mergePath: [mk0], rowKey: (entry.kind === 'rows' || entry.kind === 'nestedRows') ? rel[0] : undefined, parentKey: entry.kind === 'nestedRows' ? entry.prefix[entry.prefix.length - 2] : undefined });
                                    continue;
                                }
                                ops.push({ np, entry, value: nv, overflow: true, mergeKey: (entry.kind === 'rows' || entry.kind === 'nestedRows') ? rel[1] : rel[0], mergePath: [(entry.kind === 'rows' || entry.kind === 'nestedRows') ? rel[1] : rel[0]], rowKey: (entry.kind === 'rows' || entry.kind === 'nestedRows') ? rel[0] : undefined, parentKey: entry.kind === 'nestedRows' ? entry.prefix[entry.prefix.length - 2] : undefined });
                                continue;
                            }
                            if (!isChildGroup && isFlattened) {
                                // 同一容器可能只有部分叶子建列。以往只要看到一个
                                // 已展开兄弟就把整个容器视为“已处理”，未建列兄弟会在叶子处丢失。
                                // 若当前路径既不是列也不是任一列的祖先，将这一支按嵌套
                                // 路径放入 _扩展数据，而不是静默丢弃。
                                const logicalPath = rel.slice(fIdx);
                                const normalizedColPaths = (entry.layout.cols || []).map(c => {
                                    let cp = Array.isArray(c) ? (c[3] || []) : (c.path || []);
                                    if (entry.kind === 'singleton' && cp[0] === groupName0) cp = cp.slice(1);
                                    return cp;
                                }).filter(cp => Array.isArray(cp) && cp.length);
                                const exact = normalizedColPaths.some(cp => cp.length === logicalPath.length && cp.every((p, i) => p === logicalPath[i]));
                                const ancestor = normalizedColPaths.some(cp => cp.length > logicalPath.length && logicalPath.every((p, i) => p === cp[i]));
                                if (!exact && !ancestor) {
                                    ops.push({ np, entry, value: nv, overflow: true, mergeKey: logicalPath[0], mergePath: logicalPath, rowKey: (entry.kind === 'rows' || entry.kind === 'nestedRows') ? rel[0] : undefined, parentKey: entry.kind === 'nestedRows' ? entry.prefix[entry.prefix.length - 2] : undefined });
                                    continue;
                                }
                            }
                        }
                        // 声明为对象列（JSON 存储，如 系统._管理考核）：路径正好落在对象列上时，
                        // 整对象一次性写入，不再向下递归到子字段（子字段没有独立列）。
                        const colDef = entry.layout.cols.find(c => c[0] === fld);
                        if (colDef && rel.length === fIdx + 1 && /object|json/i.test(String(colDef[1] || ''))) {
                            ops.push({ np, entry, value: nv, prev: pv, jsonCell: true, col: fld });
                            continue;
                        }
                    }
                }
                if (nv && typeof nv === 'object' && !Array.isArray(nv)) {
                    collect(pv && typeof pv === 'object' && !Array.isArray(pv) ? pv : {}, nv, np);
                } else {
                    ops.push({ np, entry, value: nv, prev: pv });
                }
            }
        };
        collect(prevStat || {}, nextStat || {}, '');
        // 行表删除检测：stat_data 中已不存在的行键 → 对应表行应删除（补齐 diff 路径的删除方向；
        // 参考卡前端删除直接走 api.deleteRow，这里把 stat_data 删键翻译成删行）
        for (const L of entries) {
            if (L.kind !== 'rows') continue;
            const wp = (L.writePaths || [])[0] || [L.group];
            const dictAt = (obj) => {
                let c = obj;
                for (const p of wp) { if (c === null || c === undefined || typeof c !== 'object') return undefined; c = c[p]; }
                return c;
            };
            const prevDict = dictAt(prevStat);
            const nextDict = dictAt(nextStat);
            if (!prevDict || typeof prevDict !== 'object' || Array.isArray(prevDict)) continue;
            const nextObj = (nextDict && typeof nextDict === 'object' && !Array.isArray(nextDict)) ? nextDict : null;
            const nextKeys = nextObj ? new Set(Object.keys(nextObj)) : new Set();
            // 空组保护只在 target 完全没提供该组（nextObj 为 null，前端分批写）时生效：
            // 此时组缺失≠删除意图，跳过扫描避免 DELETE-only 误删。
            // 显式把组置空（nextObj 存在但无键，如前端点删除后整组变 {}）是明确的删除意图，必须执行删除。
            if (nextDict === undefined && Object.keys(prevDict).length > 0 && nextKeys.size === 0) continue;
            for (const k of Object.keys(prevDict)) {
                if (!nextKeys.has(k)) {
                    ops.push({ np: wp.concat([k]).join('.'), entry: { layout: L, kind: 'rows', prefix: wp }, kind: 'row-delete', rowKey: k });
                }
            }
        }
        // 关系子表删除检测：每个父条目下的子键独立比对。
        for (const L of entries) {
            if (L.kind !== 'nestedRows') continue;
            const pattern = (L.writePaths && L.writePaths[0]) || [...(L.parentPath || [L.group]), '*', L.childKey];
            const walk = (prevNode, nextNode, pos, concrete, ancestors) => {
                if (!prevNode || typeof prevNode !== 'object' || Array.isArray(prevNode)) return;
                if (pos === pattern.length - 1) {
                    const childName = pattern[pos];
                    const prevChild = prevNode[childName];
                    if (!prevChild || typeof prevChild !== 'object' || Array.isArray(prevChild)) return;
                    if (nextNode === undefined) return; // 上级记录删除由上级表处理
                    const nextChild = nextNode && typeof nextNode === 'object' ? nextNode[childName] : undefined;
                    const nextKeys = nextChild && typeof nextChild === 'object' && !Array.isArray(nextChild) ? new Set(Object.keys(nextChild)) : new Set();
                    const prefix = [...concrete, childName];
                    for (const rowKey of Object.keys(prevChild)) {
                        if (!nextKeys.has(rowKey)) ops.push({
                            np: prefix.concat([rowKey]).join('.'),
                            entry: { layout: L, kind: 'nestedRows', prefix, ancestorValues: ancestors.slice() },
                            kind: 'row-delete', rowKey, parentKey: ancestors[ancestors.length - 1], ancestorValues: ancestors.slice(),
                        });
                    }
                    return;
                }
                const token = pattern[pos];
                if (token === '*') {
                    for (const key of Object.keys(prevNode)) walk(prevNode[key], nextNode && nextNode[key], pos + 1, [...concrete, key], [...ancestors, key]);
                } else {
                    walk(prevNode[token], nextNode && nextNode[token], pos + 1, [...concrete, token], ancestors);
                }
            };
            walk(prevStat, nextStat, 0, [], []);
        }
        // 溢出字段删除检测：stat_data 中整个被移除的动态字段（未声明列/子表）要从对应行
        // _扩展数据 里同步删除（只处理“第一层未声明字段”整个消失；字段仍在但子键减少时，
        // 前端会整对象写回，由 overflow 写操作覆盖，无需在此处理）。
        const detectOverflowRemovals = (prevObj, nextObj, pathStr) => {
            if (!prevObj || typeof prevObj !== 'object' || Array.isArray(prevObj)) return;
            for (const k of Object.keys(prevObj)) {
                const nextHas = nextObj && typeof nextObj === 'object' && !Array.isArray(nextObj) && k in nextObj;
                const np = pathStr ? pathStr + '.' + k : k;
                if (nextHas) {
                    const pv = prevObj[k];
                    const nv = nextObj[k];
                    if (pv && typeof pv === 'object' && !Array.isArray(pv) && nv && typeof nv === 'object' && !Array.isArray(nv)) {
                        detectOverflowRemovals(pv, nv, np);
                    }
                    continue;
                }
                const entry = tableEntryByPath(np);
                if (!entry || (entry.kind !== 'singleton' && entry.kind !== 'rows')) continue;
                const pre = entry.prefix.join('.');
                const rel = np === pre ? [] : np.slice(pre.length + 1).split('.');
                const fIdx = entry.kind === 'rows' ? 1 : 0;
                // 仅“第一层未声明字段”整个消失时处理；整行删除由 row-delete 检测负责，
                // 更深层子键消失由整对象写回覆盖。
                if (rel.length !== fIdx + 1) continue;
                const fld = rel[fIdx];
                // 与 mergeOverflow 同一套排除：声明列、子表（如 主角.气运/储物袋）、
                // 已展平为列的嵌套容器（如 主角.炼丹 → 炼丹阶级）都不属于溢出字段，
                // 删除/缺失时不得当作 _扩展数据 里的动态字段清理。
                const groupName = String(entry.layout.group || entry.prefix[0] || '');
                const childGroupKeys = new Set();
                for (const L2 of entries) {
                    if (L2 === entry.layout) continue;
                    const wp = (L2.writePaths || [])[0];
                    if (Array.isArray(wp) && wp.length >= 2 && wp[0] === groupName) childGroupKeys.add(wp[1]);
                }
                const flattenedContainers = new Set();
                for (const c of (entry.layout.cols || [])) {
                    const cp = Array.isArray(c) ? (c[3] || []) : (c.path || []);
                    if (!Array.isArray(cp) || cp.length <= 1) continue;
                    flattenedContainers.add(entry.kind === 'rows' ? cp[0] : (cp[0] === groupName ? cp[1] : cp[0]));
                }
                if (entry.layout.cols.some(c => c[0] === fld) || childGroupKeys.has(fld) || flattenedContainers.has(fld)) continue;
                ops.push({
                    np, entry,
                    overflowRemove: true,
                    mergeKey: fld,
                    rowKey: entry.kind === 'rows' ? rel[0] : undefined,
                });
            }
        };
        detectOverflowRemovals(prevStat || {}, nextStat || {}, '');

        // 组级判定：`_` 前缀内部字段的“回声候选”仅在同表没有其他真实写入时才跳过。
        // 前端真实操作（如成就领取：当前MC点 +PT 与 _hypnoos 同批写回）会带声明列/真实
        // 变化 → 放行；渲染回声（只有 _hypnoos 全默认，其余声明列同值）→ 跳过不落库。
        const echoCandidates = ops.filter(op => op && op.echoCandidate);
        if (echoCandidates.length) {
            const realTables = new Set();
            for (const op of ops) {
                if (!op || op.echoCandidate) continue;
                const tbl = op.entry && op.entry.layout && op.entry.layout.table;
                if (!tbl) continue;
                // 声明列 cell（无 kind/json/overflow/replace 标记）：值类型等价时不产生写入，
                // 不算真实变化（渲染回声的整组声明列都是同值，不能因此放行 _hypnoos）。
                const isPlainCell = !op.kind && !op.json && !op.overflow && !op.replace;
                if (isPlainCell && sameValue(op.value, op.prev)) continue;
                realTables.add(tbl);
            }
            for (const op of ops) {
                if (op && op.echoCandidate) {
                    const tbl = op.entry && op.entry.layout && op.entry.layout.table;
                    if (realTables.has(tbl)) {
                        delete op.echoCandidate;
                    } else {
                        dbg(' [渲染回写抑制] 组级判定：' + op.np + ' 是同表唯一全默认内部状态回声，跳过不落库。');
                    }
                }
            }
            // echoCandidate 已清除的保留；其余回声候选被过滤掉
            const keptOps = ops.filter(op => !(op && op.echoCandidate));
            ops.length = 0;
            for (const kept of keptOps) ops.push(kept);
        }

        // 单例/整组JSON表若缺初始行（插件可能只保留表头+seedRows，未物化到 content），先按模板补行，
        // 避免 updateCell: Row index 1 out of bounds 导致写入落空
        const seedNeeded = {};
        for (const op of ops) {
            if (op && op.entry && op.entry.layout && (op.entry.kind === 'singleton' || op.entry.kind === 'json')) {
                // 只对真正有变化的操作补行：值未变化的 op 不会产生写入，也不需要物化初始行
                if (op.overflow || op.json || op.value !== op.prev) {
                    seedNeeded[op.entry.layout.table] = op.entry;
                }
            }
        }
        if (Object.keys(seedNeeded).length) {
            let tplSrc = null;
            try { tplSrc = await Promise.resolve(api.getTableTemplate({ scope: 'chat' })) || null; } catch (e) { tplSrc = null; }
            // 插件拿不到模板时，退回扩展启动时缓存的卡内模板（__ACU_TEMPLATE_DATA__）
            if (!tplSrc) {
                try {
                    tplSrc = readCachedTemplate() || null;
                } catch (e) {}
            }
            for (const tableName in seedNeeded) {
                if (abortWrites) break;
                const SE = seedNeeded[tableName];
                const SE0 = SE.layout || SE;
                const found2 = sheetOf(SE0.table);
                if (!found2 || !Array.isArray(found2.sheet.content) || found2.sheet.content.length > 1) continue;
                // 持久化帧里该表已有数据行（checkpoint/content 非空）→ 运行时仅表头只是插件
                // 回放未完成。此时补行会造出重复/错位行（row_id 对不上重放），触发插件的
                // “手动追平持久化完整性校验失败：V2 replay 与本轮已提交数据不一致”。
                // 跳过补行：updateCell 越界 → 合并层延迟重试，等回放完成后直接写。
                if (persistedTables && typeof persistedTables === 'object') {
                    const pSheet = Object.values(persistedTables).find(s => s && s.name === SE0.table);
                    if (pSheet && Array.isArray(pSheet.content) && pSheet.content.length > 1) continue;
                }
                // 初始行对象：布局列默认值兜底（布局一定在，且默认值=卡模板初始行），
                // 再叠加模板（若拿得到）里的值。之前只依赖 getTableTemplate/模板缓存，
                // 首楼替换窗口里两者都可能缺失 → sObj={} → INSERT 依赖列 DEFAULT，
                // 某些表/时刻会失败且返回值被忽略 → updateCell 全部越界 → 注入部分丢失。
                let sObj = {};
                const layoutCols = Array.isArray(SE0.cols) ? SE0.cols : [];
                for (const c of layoutCols) {
                    const colZh = Array.isArray(c) ? c[0] : (c && c.zh);
                    if (!colZh || colZh === '_扩展数据') continue;
                    const fb = Array.isArray(c) ? c[2] : c.fallback;
                    sObj[colZh] = (fb === undefined || fb === null) ? '' : fb;
                }
                if (tplSrc && typeof tplSrc === 'object') {
                    for (const k in tplSrc) {
                        if (k.indexOf('sheet_') === 0 && tplSrc[k] && tplSrc[k].name === SE0.table) {
                            const s = tplSrc[k];
                            const hdr = Array.isArray(s.content) && Array.isArray(s.content[0]) ? s.content[0] : [];
                            const row = Array.isArray(s.content) && s.content[1] ? s.content[1] : [];
                            for (let i = 1; i < hdr.length; i++) sObj[hdr[i]] = (row[i] !== undefined && row[i] !== null) ? row[i] : '';
                            break;
                        }
                    }
                }
                if (SE.kind === 'json') {
                    // 整组 JSON 表：身份行 + 内容列必须是合法 JSON（模板行可能为空串，
                    // 插件 SQLite 表带 CHECK json_valid(neirong)，空串/非 JSON 会被拒绝）
                    if (SE0.keyCol && !sObj[SE0.keyCol]) sObj[SE0.keyCol] = SE0.keyValue || 'row1';
                    const jv0 = sObj['内容'];
                    if (SE0.scalarType === 'number') {
                        const fallback = ((SE0.cols || [])[0] || [])[2] ?? 0;
                        sObj['内容'] = jv0 !== '' && jv0 !== null && jv0 !== undefined && Number.isFinite(Number(jv0)) ? Number(jv0) : fallback;
                    }
                    else if (jv0 === undefined || jv0 === null || jv0 === '') sObj['内容'] = '{}';
                    else { try { JSON.parse(jv0); } catch (e) { sObj['内容'] = '{}'; } }
                }
                try {
                    const ir = await Promise.resolve(api.insertRow(SE0.table, sObj));
                    if (ir === -1 || ir === false || ir === undefined || ir === null) {
                        markWriteFailure('补初始行 insertRow(' + SE0.table + ')');
                        dbgWarn(' 补初始行失败：insertRow(' + SE0.table + ') 返回 ' + String(ir) + '（原表仅表头）。');
                    } else {
                        dbg(' 已为表「' + SE0.table + '」补初始行（原表仅表头）。');
                    }
                } catch (e) {
                    markWriteFailure('补初始行 insertRow(' + SE0.table + ')', e);
                    dbgWarn(' 补初始行失败:', e);
                }
            }
            try { tables = api.exportTableAsJson() || {}; } catch (e) {}
        }

        // 解析差异操作并跳过值未变化的写入
        const resolved = [];
        const directOps = [];
        const newRows = new Map();
        const parseObj = (v) => safeParseJson(v);
        const setNestedValue = (obj, path, value) => {
            const parts = Array.isArray(path) && path.length ? path : [];
            if (!parts.length) return obj;
            let cur = obj;
            for (let i = 0; i < parts.length - 1; i++) {
                if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object' || Array.isArray(cur[parts[i]])) cur[parts[i]] = {};
                cur = cur[parts[i]];
            }
            cur[parts[parts.length - 1]] = value;
            return obj;
        };
        for (const op of ops) {
            const E = op.entry;
            if (!E) continue;
            const L = E.layout;
            const found = sheetOf(L.table);
            if (!found) continue;
            const sheet = found.sheet;
            const header = sheet.content && sheet.content[0] ? sheet.content[0] : [];
            // 未变化的默认投影不应写进尚未物化的单例表；只有真实变化才补行。
            if (E.kind === 'singleton' && sheet.content.length <= 1 &&
                !op.overflow && !op.overflowRemove && !op.json && sameValue(op.value, op.prev)) continue;
            const ancestorValues = E.kind === 'nestedRows'
                ? ((Array.isArray(E.ancestorValues) && E.ancestorValues.length) ? E.ancestorValues
                    : (Array.isArray(op.ancestorValues) && op.ancestorValues.length) ? op.ancestorValues
                    : [op.parentKey])
                : [];
            if (op.kind === 'row-delete' && (E.kind === 'rows' || E.kind === 'nestedRows')) {
                const rowIndex = E.kind === 'nestedRows'
                    ? findRelationRowByAncestors(sheet, L, ancestorValues, op.rowKey)
                    : findRowByColumn(sheet, L.keyCol, op.rowKey);
                if (rowIndex !== -1) {
                    resolved.push({ kind: 'row-delete', key: found.key, sheet, header, layout: L, rowIndex });
                } else {
                    // 行可能只在 seedRows（未物化）：从当前运行时 seedRows 移除（尽力；插件可能从模板 scope 补回）
                    const ki = header.indexOf(L.keyCol);
                    const before = Array.isArray(sheet.seedRows) ? sheet.seedRows.length : 0;
                    if (Array.isArray(sheet.seedRows) && ki >= 0) {
                        sheet.seedRows = sheet.seedRows.filter(r => !(Array.isArray(r) && String(r[ki]) === String(op.rowKey)));
                    }
                    if (Array.isArray(sheet.seedRows) && sheet.seedRows.length !== before) {
                        dbg(' 行表「' + L.table + '」seedRows 已移除键「' + op.rowKey + '」（diff 路径）');
                    } else {
                        dbg(' 行表「' + L.table + '」键「' + op.rowKey + '」既不在 content 也不在 seedRows，跳过删除。');
                    }
                }
                continue;
            }
            if (op.json && E.kind === 'json') {
                const jcIdx = header.indexOf('内容');
                if (jcIdx === -1) {
                    dbgWarn(' 整组JSON表「' + L.table + '」缺少「内容」列（旧模板/旧聊天），写入已跳过；请重新转换角色卡并新开聊天。');
                    continue;
                }
                const jNew = L.scalarType === 'number' ? op.value : (op.value === undefined || op.value === null ? '{}' : JSON.stringify(op.value));
                const jCur = sheet.content[1] ? sheet.content[1][jcIdx] : undefined;
                if (sameValue(jCur, jNew)) continue;
                directOps.push({ kind: 'json', key: found.key, sheet, header, layout: L, value: jNew });
                continue;
            }
            if (op.overflowRemove) {
                const ovcIdx = header.indexOf('_扩展数据');
                if (ovcIdx === -1) continue;
                let ovRow = 1;
                if (E.kind === 'rows' || E.kind === 'nestedRows') {
                    const ovKey = op.rowKey;
                    if (ovKey === undefined) continue;
                    ovRow = E.kind === 'nestedRows'
                        ? findRelationRowByAncestors(sheet, L, ancestorValues, ovKey)
                        : findRowByColumn(sheet, L.keyCol, ovKey);
                    if (ovRow === -1) continue; // 行已不存在，无需清理
                }
                // 删除在运行时读取当前单元格再执行，避免覆盖同批次的溢出写入（见 runDirectOps）
                directOps.push({ kind: 'overflow-remove', key: found.key, sheet, header, layout: L, rowIndex: ovRow, removeKey: op.mergeKey });
                continue;
            }
            if (op.overflow) {
                const ovcIdx = header.indexOf('_扩展数据');
                if (ovcIdx === -1) {
                    dbgWarn(' 表「' + L.table + '」缺少「_扩展数据」列（旧模板/旧聊天），动态字段写入已跳过；请重新转换角色卡并新开聊天。');
                    continue;
                }
                let ovRow = 1;
                if (E.kind === 'rows' || E.kind === 'nestedRows') {
                    const ovKey = op.rowKey;
                    if (ovKey === undefined) continue;
                    ovRow = E.kind === 'nestedRows'
                        ? findRelationRowByAncestors(sheet, L, ancestorValues, ovKey)
                        : findRowByColumn(sheet, L.keyCol, ovKey);
                    if (ovRow === -1) {
                        // 行可能只存在于 seedRows：跳过，避免 INSERT 撞 UNIQUE
                        const srH2 = header;
                        const srF2 = Array.isArray(sheet.seedRows) && sheet.seedRows.length
                            ? findRowByColumn({ content: [srH2, ...sheet.seedRows] }, L.keyCol, ovKey)
                            : -1;
                        if (srF2 !== -1) {
                            dbg(' 表「' + L.table + '」键「' + ovKey + '」存在于 seedRows，溢出字段跳过（等待插件物化）。');
                            continue;
                        }
                        // 合并进同一新行（与已声明字段同一条 INSERT，避免重复 INSERT 撞 UNIQUE）
                        const nk2 = E.kind === 'nestedRows'
                            ? L.table + '\u0000' + ancestorValues.map(v => String(v == null ? '' : v)).join('\u0000') + '\u0000' + ovKey
                            : L.table + '\u0000' + ovKey;
                        let nr2 = newRows.get(nk2);
                        if (!nr2) { nr2 = { table: L.table, header, layout: L, keyCol: L.keyCol, keyVal: ovKey, ancestorKeyCols: E.kind === 'nestedRows' ? (L.ancestorKeyCols || [L.parentKeyCol]) : [], ancestorValues, cells: {} }; newRows.set(nk2, nr2); }
                        const ovObj = {};
                        setNestedValue(ovObj, op.mergePath || [op.mergeKey], op.value);
                        const ovCell = JSON.stringify(ovObj);
                        const prevOv = nr2.cells['_扩展数据'];
                        if (prevOv) {
                            try { const m = JSON.parse(prevOv); setNestedValue(m, op.mergePath || [op.mergeKey], op.value); nr2.cells['_扩展数据'] = JSON.stringify(m); } catch (e) { nr2.cells['_扩展数据'] = ovCell; }
                        } else {
                            nr2.cells['_扩展数据'] = ovCell;
                        }
                        continue;
                    }
                }
                const ovCur = parseObj(sheet.content[ovRow] ? sheet.content[ovRow][ovcIdx] : undefined);
                const ovMerged = JSON.parse(JSON.stringify(ovCur || {}));
                setNestedValue(ovMerged, op.mergePath || [op.mergeKey], op.value);
                const ovStr = JSON.stringify(ovMerged);
                if (sameValue(sheet.content[ovRow] ? sheet.content[ovRow][ovcIdx] : undefined, ovStr)) continue;
                // 运行时再读当前单元格合并写入（同批次可能有删除操作，见 runDirectOps）
                directOps.push({ kind: 'overflow', key: found.key, sheet, header, layout: L, rowIndex: ovRow, mergeKey: op.mergeKey, mergePath: op.mergePath || [op.mergeKey], value: op.value });
                continue;
            }
            if (op.replace && (E.kind === 'array' || E.kind === 'pathArray' || E.kind === 'nestedArray')) {
                const arr = Array.isArray(op.value) ? op.value : [];
                const valueIdx = header.indexOf(L.valueCol || (header[1] || '内容'));
                const parentIdx = E.kind === 'nestedArray' ? header.indexOf(L.parentKeyCol) : -1;
                const parentVal = E.kind === 'nestedArray' ? E.prefix[1] : undefined;
                const oldRows = sheet.content.slice(1).filter(r => E.kind !== 'nestedArray' || (r && parentIdx >= 0 && String(r[parentIdx]) === String(parentVal)));
                const oldVals = oldRows.map(r => (r && valueIdx >= 0 ? r[valueIdx] : undefined));
                const valueDef = (L.cols || []).find(c => c[0] === (L.valueCol || (header[1] || '内容')));
                const isJsonScalarArray = E.kind === 'array' && valueDef && valueDef[1] === 'jsonScalar';
                const encodeArrayValue = (v) => {
                    if (!isJsonScalarArray) return v;
                    try { const encoded = JSON.stringify(v); return encoded === undefined ? 'null' : encoded; } catch (e) { return 'null'; }
                };
                const unchanged = oldVals.length === arr.length && oldVals.every((v, i) => sameValue(v, encodeArrayValue(arr[i])));
                if (unchanged) continue;
                resolved.push({ kind: E.kind === 'nestedArray' ? 'nested-array' : 'array', key: found.key, sheet, header, layout: L, arr, parentIdx, parentVal, valueIdx, isJsonScalarArray });
                continue;
            }
            const parts = pathParts(op.np);
            let rowIndex = -1;
            let newRowArr = null;
            let newRowObj = null;
            if (E.kind === 'singleton') {
                // 显式定位 row_id=1（模板单例行）：垫脚行等其他 row_id 的行不应成为写入目标，
                // 否则数据会落在垫脚行上、随后被去重删掉
                rowIndex = 1;
                for (let ri = 1; ri < sheet.content.length; ri++) {
                    const r = sheet.content[ri];
                    if (r && String(r[0]) === '1') { rowIndex = ri; break; }
                }
            } else if (E.kind === 'rows' || E.kind === 'nestedRows') {
                const keyVal = parts[E.prefix.length];
                if (keyVal === undefined) continue;
                rowIndex = E.kind === 'nestedRows'
                    ? findRelationRowByAncestors(sheet, L, ancestorValues, keyVal)
                    : findRowByColumn(sheet, L.keyCol, keyVal);
                if (rowIndex === -1) {
                    // 行不在 content：直接 INSERT（含 seedRows 里的模板行——插件 seed 物化
                    // 会按业务键去重，不会重复；快照兜底已删，跳过 = 永远落不了库）
                    // 同一新行的多个字段合并为一条 INSERT，避免重复 INSERT 撞 UNIQUE
                    // collect 阶段已按完整逻辑路径解析出的列名优先级最高；不能再用路径
                    // 末段覆盖。否则同时存在「要素」与「登神长阶_要素」时会误写前者。
                    let colZh = op.col || parts[parts.length - 1];
                    if (L.scalarValueCol && parts.length === E.prefix.length + 1) {
                        // 标量条目（如 修仙秘闻 的 {标题: 内容}）：值落在「描述/数值」列，
                        // 而不是把条目键当成列名。
                        colZh = L.scalarValueCol;
                    } else if (header.indexOf(colZh) === -1) {
                        // 展平容器路径（如 主角.炼丹.熟练度 → 炼丹熟练度 列）
                        for (const c of (L.cols || [])) {
                            const cp = Array.isArray(c) ? (c[3] || []) : (c.path || []);
                            const logicalParts = E.kind === 'rows' ? parts.slice(E.prefix.length + 1) : parts;
                            if (Array.isArray(cp) && cp.length === logicalParts.length && cp.every((p, i) => p === logicalParts[i])) {
                                colZh = Array.isArray(c) ? c[0] : (c.zh);
                                break;
                            }
                        }
                    }
                    const nk = E.kind === 'nestedRows'
                        ? L.table + '\u0000' + ancestorValues.map(v => String(v == null ? '' : v)).join('\u0000') + '\u0000' + keyVal
                        : L.table + '\u0000' + keyVal;
                    let nr = newRows.get(nk);
                    if (!nr) { nr = { table: L.table, header, layout: L, keyCol: L.keyCol, keyVal, ancestorKeyCols: E.kind === 'nestedRows' ? (L.ancestorKeyCols || [L.parentKeyCol]) : [], ancestorValues, cells: {} }; newRows.set(nk, nr); }
                    // 对象列（JSON 存储，如 宗门.资源/建筑）：新行合并时整对象 JSON 序列化，
                    // 否则 String(对象) 会落成 '[object Object]'（旧行更新有 jsonCell 处理，
                    // 新行合并路径此前漏了）。
                    const colDefN = (L.cols || []).find(c => c[0] === colZh);
                    const colTypeN = colDefN ? String(Array.isArray(colDefN) ? colDefN[1] : (colDefN.type || '')) : '';
                    const objColN = /object/i.test(colTypeN);
                    nr.cells[colZh] = /jsonScalar/i.test(colTypeN)
                        ? JSON.stringify(op.value)
                        : ((objColN && op.value && typeof op.value === 'object') ? JSON.stringify(op.value) : op.value);
                    continue;
                }
            }
            if (rowIndex < 0 && !newRowArr) continue;
            let colZh = op.col || parts[parts.length - 1];
            let colIdx = header.indexOf(colZh);
            if (L.scalarValueCol && parts.length === E.prefix.length + 1) {
                // 标量条目（如 修仙秘闻 的 {标题: 内容}）：值落在「描述/数值」列，
                // 而不是把条目键当成列名。
                colZh = L.scalarValueCol;
                colIdx = header.indexOf(colZh);
            }
            if (colIdx === -1) {
                // 展平容器路径（如 主角.炼丹.熟练度 → 炼丹熟练度 列）
                for (const c of (L.cols || [])) {
                    const cp = Array.isArray(c) ? (c[3] || []) : (c.path || []);
                    const logicalParts = E.kind === 'rows' ? parts.slice(E.prefix.length + 1) : parts;
                    if (Array.isArray(cp) && cp.length === logicalParts.length && cp.every((p, i) => p === logicalParts[i])) {
                        colZh = Array.isArray(c) ? c[0] : (c.zh);
                        colIdx = header.indexOf(colZh);
                        break;
                    }
                }
            }
            if (colIdx === -1) continue;
            const targetColDef = (L.cols || []).find(c => (Array.isArray(c) ? c[0] : c.zh) === colZh);
            const targetColType = targetColDef ? String(Array.isArray(targetColDef) ? targetColDef[1] : (targetColDef.type || '')) : '';
            if (/jsonScalar/i.test(targetColType)) {
                const encoded = JSON.stringify(op.value);
                const cur = sheet.content[rowIndex] ? sheet.content[rowIndex][colIdx] : undefined;
                if (sameValue(cur, encoded)) continue;
                resolved.push({ kind: 'cell', key: found.key, sheet, header, layout: L, rowIndex, colIdx, colZh, value: encoded, newRowArr, newRowObj });
                continue;
            }
            if (op.jsonCell) {
                // 对象列：整对象 JSON 序列化后写入（脚本对 系统._管理考核 这类嵌套状态整体读写）
                const jNew = JSON.stringify(op.value === undefined || op.value === null ? {} : op.value);
                const cur = sheet.content[rowIndex] ? sheet.content[rowIndex][colIdx] : undefined;
                if (sameValue(cur, jNew)) continue;
                resolved.push({ kind: 'cell', key: found.key, sheet, header, layout: L, rowIndex, colIdx, colZh, value: jNew, newRowArr, newRowObj });
                continue;
            }
            if (!newRowArr) {
                const cur = sheet.content[rowIndex] ? sheet.content[rowIndex][colIdx] : undefined;
                if (sameValue(cur, op.value)) continue;
            }
            resolved.push({ kind: 'cell', key: found.key, sheet, header, layout: L, rowIndex, colIdx, colZh, value: op.value, newRowArr, newRowObj });
        }
        // 把合并后的新行转换成单个 resolved 条目（批量 SQL 一条 INSERT / 回退路径一次 insertRow）
        for (const nr of newRows.values()) {
            const arr = new Array(nr.header.length).fill('');
            const obj = {};
            // INSERT 若只涉及部分字段，其他 JSON 列也不能留成空字符串；DDL 的
            // json_valid/json_type CHECK 会在整行写入时检查所有列。按布局默认值补齐，
            // 对象通常为 {}，数组通常为 []。
            for (const c of (nr.layout.cols || [])) {
                const colZh = Array.isArray(c) ? c[0] : c.zh;
                const colType = Array.isArray(c) ? c[1] : c.type;
                if (!colZh || Object.prototype.hasOwnProperty.call(nr.cells, colZh) || !/object/i.test(String(colType || ''))) continue;
                let fallback = Array.isArray(c) ? c[2] : c.fallback;
                if (typeof fallback !== 'string' || !/^\s*[\[{]/.test(fallback)) fallback = '{}';
                nr.cells[colZh] = fallback;
            }
            for (const colZh of Object.keys(nr.cells)) {
                const cIdx = nr.header.indexOf(colZh);
                if (cIdx >= 0) { arr[cIdx] = String(nr.cells[colZh]); obj[colZh] = nr.cells[colZh]; }
            }
            const ki = nr.header.indexOf(nr.keyCol);
            if (ki >= 0) { arr[ki] = String(nr.keyVal); obj[nr.keyCol] = String(nr.keyVal); }
            (nr.ancestorKeyCols || []).forEach((col, ai) => {
                const pi = nr.header.indexOf(col);
                if (pi >= 0) { arr[pi] = String((nr.ancestorValues || [])[ai] == null ? '' : nr.ancestorValues[ai]); obj[col] = arr[pi]; }
            });
            resolved.push({ kind: 'cell', key: nr.table, sheet: null, header: nr.header, layout: nr.layout, rowIndex: -1, colIdx: -1, colZh: '', value: undefined, newRowArr: arr, newRowObj: obj });
        }
        if (resolved.length === 0 && directOps.length === 0) return 0;
        // 多行删除时，先删的行会让后续行索引前移：按行索引降序执行删除，
        // 避免整组替换行表（如切换开场分支）时误删其他行。
        resolved.sort((a, b) => {
            if (a.kind === 'row-delete' && b.kind === 'row-delete') return (b.rowIndex || 0) - (a.rowIndex || 0);
            return 0;
        });

        // 原生 CRUD 写入：同一既有行的多个单元格优先合并为一次 updateRow，避免插件为
        // 每个 updateCell 都执行一次完整 V2 持久化；旧版插件或行更新失败时逐格回退。
        // insertRow/deleteRow 仍逐条执行，保持行结构变更与回放语义不变。
        // row_upsert/row_delete 操作，回放确定性恢复。不使用 executeSqlBatch——那会存成
        // sql_sheet_batch（回放重跑 SQL），且批量 DELETE 误删时无法恢复（实测丢行根因）。
        // 批量性能由插件的提交管线与酒馆保存防抖兜底。
        const consumedCellUpdates = new Set();
        let updateRowUsable = typeof api.updateRow === 'function';
        const cellUpdatesByRow = new Map();
        for (const candidate of resolved) {
            if (candidate.kind !== 'cell' || candidate.newRowObj || !candidate.layout) continue;
            const key = candidate.layout.table + '\u0000' + candidate.rowIndex;
            const group = cellUpdatesByRow.get(key) || [];
            group.push(candidate);
            cellUpdatesByRow.set(key, group);
        }
        for (const r of resolved) {
            if (abortWrites) break;
            if (consumedCellUpdates.has(r)) continue;
            const L = r.layout;
            try {
                if (r.kind === 'row-delete') {
                    try {
                        const ok = await Promise.resolve(api.deleteRow(L.table, r.rowIndex));
                        if (!ok) markWriteFailure('deleteRow(' + L.table + ')');
                    } catch (e) { markWriteFailure('deleteRow(' + L.table + ')', e); }
                    continue;
                }
                if (r.kind === 'array') {
                    for (let rr = r.sheet.content.length - 1; rr >= 1; rr--) {
                        // deleteRow 的 rowIndex 是 content 数组索引（0=表头，1=第一数据行），
                        // rr 正是数组索引，直接传 rr；传 rr-1 会误删表头/前一数据行。
                        try {
                            const ok = await Promise.resolve(api.deleteRow(L.table, rr));
                            if (!ok) { markWriteFailure('数组 deleteRow(' + L.table + ')'); break; }
                        } catch (e) { markWriteFailure('数组 deleteRow(' + L.table + ')', e); break; }
                    }
                    if (abortWrites) continue;
                    for (let ai = 0; ai < r.arr.length; ai++) {
                        const o = {}; const av = r.arr[ai];
                        let encoded = r.isJsonScalarArray ? JSON.stringify(av) : (av && typeof av === 'object' ? JSON.stringify(av) : String(av));
                        if (encoded === undefined) encoded = 'null';
                        o[L.valueCol || r.header[1] || '内容'] = encoded;
                        try {
                            const ir = await Promise.resolve(api.insertRow(L.table, o));
                            if (ir === -1 || ir === false || ir === undefined || ir === null) { markWriteFailure('数组 insertRow(' + L.table + ')'); break; }
                        } catch (e) { markWriteFailure('数组 insertRow(' + L.table + ')', e); break; }
                    }
                    continue;
                }
                if (r.kind === 'nested-array') {
                    for (let rr = r.sheet.content.length - 1; rr >= 1; rr--) {
                        const row = r.sheet.content[rr];
                        if (row && r.parentIdx >= 0 && String(row[r.parentIdx]) === String(r.parentVal)) {
                            try {
                                const ok = await Promise.resolve(api.deleteRow(L.table, rr));
                                if (!ok) { markWriteFailure('嵌套数组 deleteRow(' + L.table + ')'); break; }
                            } catch (e) { markWriteFailure('嵌套数组 deleteRow(' + L.table + ')', e); break; }
                        }
                    }
                    if (abortWrites) continue;
                    for (const item of r.arr) {
                        const o = {};
                        o[L.parentKeyCol] = String(r.parentVal);
                        o[L.valueCol || '内容'] = item && typeof item === 'object' ? JSON.stringify(item) : String(item);
                        try {
                            const ir = await Promise.resolve(api.insertRow(L.table, o));
                            if (ir === -1 || ir === false || ir === undefined || ir === null) { markWriteFailure('嵌套数组 insertRow(' + L.table + ')'); break; }
                        } catch (e) { markWriteFailure('嵌套数组 insertRow(' + L.table + ')', e); break; }
                    }
                    continue;
                }
                if (r.newRowObj) {
                    // 行表 INSERT 前检查：若持久化帧里该表已有同键行，说明运行时仅表头只是
                    // 插件回放未完成（切聊天/刷新窗口）。此刻 insertRow 会造出重复行，
                    // 回放完成后 row_id 错位 → 触发插件“手动追平完整性校验失败”/多余行。
                    // 跳过并标记失败，由合并层延迟重试等回放完成。
                    if (persistedTables && typeof persistedTables === 'object') {
                        const pSheet2 = Object.values(persistedTables).find(s => s && s.name === L.table);
                        if (pSheet2 && Array.isArray(pSheet2.content) && pSheet2.content.length > 1) {
                            const ki2 = pSheet2.content[0] ? pSheet2.content[0].indexOf(L.keyCol) : -1;
                            let dupKey = false;
                            if (ki2 >= 0) {
                                const want = String(r.newRowObj[L.keyCol] == null ? '' : r.newRowObj[L.keyCol]);
                                for (let ri2 = 1; ri2 < pSheet2.content.length; ri2++) {
                                    const row2 = pSheet2.content[ri2];
                                    if (Array.isArray(row2) && String(row2[ki2] == null ? '' : row2[ki2]) === want) { dupKey = true; break; }
                                }
                            }
                            if (dupKey) {
                                dbg(' 行表「' + L.table + '」持久化已有键「' + r.newRowObj[L.keyCol] + '」而运行时空（回放中），跳过 INSERT 稍后重试。');
                                statWriteHadFailure = true;
                                continue;
                            }
                        }
                    }
                    try {
                        const ir = await Promise.resolve(api.insertRow(L.table, r.newRowObj));
                        if (ir === -1 || ir === false || ir === undefined || ir === null) markWriteFailure('insertRow(' + L.table + ')');
                    } catch (e) { markWriteFailure('insertRow(' + L.table + ')', e); }
                    continue;
                }
                try {
                    // 单例/JSON 表 updateCell 前检查：运行时仅表头（回放未完成）而持久化已有
                    // 该表数据行时，updateCell 必然越界报错（Row index 1 out of bounds）且插件
                    // 日志刷屏。直接跳过并标记失败，由合并层延迟重试（等插件回放完成）。
                    if (r.rowIndex >= 1 && r.sheet && Array.isArray(r.sheet.content) && r.sheet.content.length <= 1) {
                        if (persistedTables && typeof persistedTables === 'object') {
                            const pSheet3 = Object.values(persistedTables).find(s => s && s.name === L.table);
                            if (pSheet3 && Array.isArray(pSheet3.content) && pSheet3.content.length > 1) {
                                dbg(' 表「' + L.table + '」运行时仅表头而持久化已有数据行（回放窗口），跳过 updateCell 稍后重试。');
                                statWriteHadFailure = true;
                                continue;
                            }
                        }
                    }
                    // updateRow 的 payload 是 { 列名: 新值 }。仅合并同表同一现有行的普通
                    // cell 操作；INSERT/DELETE/数组替换与动态 JSON 合并继续保持原顺序。
                    const group = cellUpdatesByRow.get(L.table + '\u0000' + r.rowIndex) || [r];
                    const sameRow = [];
                    if (updateRowUsable) for (const x of group) if (x !== r && !consumedCellUpdates.has(x)) sameRow.push(x);
                    let ok = false;
                    if (sameRow.length > 0 && updateRowUsable) {
                        const payload = { [r.colZh]: r.value };
                        for (const x of sameRow) payload[x.colZh] = x.value;
                        try {
                            ok = !!(await Promise.resolve(api.updateRow(L.table, r.rowIndex, payload)));
                        } catch (e) { ok = false; }
                        if (ok) for (const x of sameRow) consumedCellUpdates.add(x);
                        else updateRowUsable = false;
                    }
                    if (!ok) {
                        ok = !!(await Promise.resolve(api.updateCell(L.table, r.rowIndex, r.colZh, r.value)));
                    }
                    if (!ok) {
                        markWriteFailure('updateCell(' + L.table + ')');
                        if (mvu2shujukuDebugOn()) {
                            dbg(' updateCell 失败: ' + L.table + ' row=' + r.rowIndex + ' col=' + r.colZh +
                                ' 运行时行数=' + (Array.isArray(r.sheet && r.sheet.content) ? r.sheet.content.length : 0));
                        }
                    }
                } catch (e) { markWriteFailure('updateCell(' + L.table + ')', e); }
            } catch (e) { markWriteFailure('写入 ' + L.table, e); }
        }
        await runDirectOps();
        return resolved.length + directOps.length;

        async function runDirectOps() {
            for (const d of directOps) {
                if (abortWrites) break;
                try {
                    if (d.kind === 'json') {
                        // 整组 JSON 表同样可能在回放窗口仅表头：持久化已有行而运行时为空时跳过，
                        // 由合并层延迟重试（否则 updateCell(…, 1, …) 越界刷屏）。
                        if (persistedTables && typeof persistedTables === 'object') {
                            const pSheetJ = Object.values(persistedTables).find(s => s && s.name === d.layout.table);
                            if (pSheetJ && Array.isArray(pSheetJ.content) && pSheetJ.content.length > 1 &&
                                (!d.sheet || !Array.isArray(d.sheet.content) || d.sheet.content.length <= 1)) {
                                dbg(' JSON表「' + d.layout.table + '」运行时仅表头而持久化已有数据行（回放窗口），跳过写入稍后重试。');
                                statWriteHadFailure = true;
                                continue;
                            }
                        }
                        const jok = await Promise.resolve(api.updateCell(d.layout.table, 1, '内容', d.value));
                        if (!jok) markWriteFailure('JSON updateCell(' + d.layout.table + ')');
                    } else if (d.kind === 'overflow' || d.kind === 'overflow-remove') {
                        // 同一次写入可能同时有“改动态字段”和“删动态字段”：必须读当前单元格再
                        // 合并/删除，不能直接覆盖整列（否则先写后删会把本次新增也抹掉）。
                        const curRow = d.sheet && d.sheet.content && d.sheet.content[d.rowIndex];
                        const ovcIdx = curRow && Array.isArray(d.header) ? d.header.indexOf('_扩展数据') : -1;
                        if (curRow && ovcIdx !== -1) {
                            const cur = parseObj(curRow[ovcIdx]);
                            if (d.kind === 'overflow-remove') delete cur[d.removeKey];
                            else setNestedValue(cur, d.mergePath || [d.mergeKey], d.value);
                            const out = JSON.stringify(cur);
                            if (!sameValue(curRow[ovcIdx], out)) {
                                const ook = await Promise.resolve(api.updateCell(d.layout.table, d.rowIndex, '_扩展数据', out));
                                if (!ook) markWriteFailure('溢出列 updateCell(' + d.layout.table + ')');
                            }
                        }
                    } else if (d.kind === 'overflow-insert') {
                        const oir = await Promise.resolve(api.insertRow(d.layout.table, d.rowObj));
                        if (oir === -1 || oir === false || oir === undefined || oir === null) markWriteFailure('溢出行 insertRow(' + d.layout.table + ')');
                    }
                } catch (e) {
                    markWriteFailure('整组JSON/溢出列写入', e);
                    dbgWarn(' 整组JSON/溢出列写入失败:', e);
                }
            }
        }
    }
    return { writeStatDiffToDb, get lastStatWriteFailed() { return statWriteHadFailure; } };
}

if (typeof module !== 'undefined' && module.exports) module.exports = createTableWriter;

return module.exports;})();
const getBridgeLifecycleFactory = () => (function(){ const module={exports:{}};
'use strict';

// 自包含工厂：桥退出后禁止新任务，并等待已经发出的 API 调用结束。
function createBridgeLifecycle(host) {
    let stopped = false, ready = null;
    const timers = new Map(), cleanups = [], calls = new Set(), proxies = new WeakMap();
    let notifyStop;
    const stoppedPromise = new Promise(resolve => { notifyStop = resolve; });
    const guard = fn => function (...args) { if (!stopped) return fn.apply(this, args); };
    function timer(repeat, fn, delay) {
        if (stopped) return null;
        const schedule = repeat ? host.setInterval : host.setTimeout;
        if (typeof schedule !== 'function') return null;
        let id;
        id = schedule.call(host, function () {
            if (!repeat) timers.delete(id);
            if (!stopped) fn();
        }, delay);
        timers.set(id, repeat);
        return id;
    }
    function clear(id) {
        const repeat = timers.get(id);
        timers.delete(id);
        const cancel = repeat ? host.clearInterval : host.clearTimeout;
        if (typeof cancel === 'function') cancel.call(host, id);
    }
    function cleanup(fn) {
        if (stopped) { try { fn(); } catch (_) {} }
        else cleanups.push(fn);
    }
    function on(bus, name, fn) {
        if (stopped || !bus || typeof bus.on !== 'function') return;
        const wrapped = guard(fn);
        bus.on(name, wrapped);
        cleanup(() => {
            const off = bus.off || bus.removeListener;
            if (typeof off === 'function') off.call(bus, name, wrapped);
        });
    }
    function eventOn(subscribe, name, fn) {
        if (stopped || typeof subscribe !== 'function') return;
        const handle = subscribe(name, guard(fn));
        cleanup(() => { if (handle && typeof handle.stop === 'function') handle.stop(); });
        return handle;
    }
    function run(fn) {
        if (stopped) return Promise.resolve(false);
        let finish;
        const pending = new Promise(resolve => { finish = resolve; });
        calls.add(pending);
        const done = () => { calls.delete(pending); finish(); };
        try {
            return Promise.resolve(fn()).then(value => { done(); return value; }, error => { done(); throw error; });
        } catch (error) { done(); return Promise.reject(error); }
    }
    function api(raw) {
        if (!raw) return raw;
        if (proxies.has(raw)) return proxies.get(raw);
        const proxy = new Proxy(raw, {
            get(target, key) {
                const value = target[key];
                if (typeof value !== 'function') return value;
                return function (...args) {
                    if (stopped) throw new Error('旧桥已退出，数据库调用已取消');
                    // 在调用宿主前登记，覆盖宿主同步回调触发扩展加载的重入情况。
                    let finish;
                    const pending = new Promise(resolve => { finish = resolve; });
                    calls.add(pending);
                    const done = () => { calls.delete(pending); finish(); };
                    try {
                        const result = value.apply(target, args);
                        if (result && typeof result.then === 'function') return Promise.resolve(result).then(
                            answer => { done(); return answer; }, error => { done(); throw error; });
                        done();
                        return result;
                    } catch (error) { done(); throw error; }
                };
            },
        });
        proxies.set(raw, proxy);
        return proxy;
    }
    function stop() {
        if (ready) return ready;
        stopped = true;
        notifyStop(false);
        for (const id of Array.from(timers.keys())) clear(id);
        for (const fn of cleanups.splice(0)) { try { fn(); } catch (_) {} }
        ready = Promise.all(Array.from(calls)).then(() => undefined);
        return ready;
    }
    return {
        get stopped() { return stopped; }, stop, cleanup, guard, on, eventOn, api, run,
        setTimeout: (fn, delay) => timer(false, fn, delay),
        setInterval: (fn, delay) => timer(true, fn, delay),
        clearTimeout: clear, clearInterval: clear,
        sleep(delay) { return Promise.race([stoppedPromise, new Promise(resolve => timer(false, () => resolve(true), delay))]); },
    };
}

module.exports = createBridgeLifecycle;

return module.exports;})();
const statDataFromTables = getTableCodecFactory()().statDataFromTables;
const DB_INIT_SNIPPET = [
        'function mvu2shujukuDecodeB64(b){try{var bin=atob(b);var bytes=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);return new TextDecoder("utf-8").decode(bytes);}catch(e){return decodeURIComponent(escape(atob(b)));}}',
        'function mvu2shujukuExpectedTableNames(tpl){var names=[];if(!tpl||typeof tpl!=="object")return names;for(var k in tpl){if(k.indexOf("sheet_")!==0)continue;var s=tpl[k];if(s&&typeof s==="object"&&typeof s.name==="string"&&names.indexOf(s.name)===-1)names.push(s.name);}return names;}',
        'function mvu2shujukuSheetByName(tpl,name){if(!tpl||typeof tpl!=="object")return null;for(var k in tpl){if(k.indexOf("sheet_")===0&&tpl[k]&&tpl[k].name===name)return tpl[k];}return null;}',
        'function mvu2shujukuHasExtraRows(api,tpl){try{var all=api.exportTableAsJson()||{};for(var k in tpl){if(k.indexOf("sheet_")!==0)continue;var ts=tpl[k];if(!ts||typeof ts!=="object"||typeof ts.name!=="string")continue;var rs=null;for(var k2 in all){if(k2.indexOf("sheet_")===0&&all[k2]&&all[k2].name===ts.name){rs=all[k2];break;}}if(!rs)continue;var tRows=Array.isArray(ts.content)?ts.content.length-1:0;var rRows=Array.isArray(rs.content)?rs.content.length-1:0;var rSeed=Array.isArray(rs.seedRows)?rs.seedRows.length:0;if(rRows+rSeed>tRows)return true;}return false;}catch(e){return false;}}',
        'function mvu2shujukuTablesSafeToAnchor(api,tpl){try{var all=api.exportTableAsJson()||{};var names=mvu2shujukuExpectedTableNames(tpl);for(var i=0;i<names.length;i++){var name=names[i];var rs=null;for(var k in all){if(k.indexOf("sheet_")===0&&all[k]&&all[k].name===name){rs=all[k];break;}}if(!rs)continue;var rows=(Array.isArray(rs.content)?rs.content.length:0)-1;var seed=Array.isArray(rs.seedRows)?rs.seedRows.length:0;var ts=mvu2shujukuSheetByName(tpl,name);var tRows=ts&&Array.isArray(ts.content)?ts.content.length-1:0;if(rows+seed>tRows)return false;if(rows>0&&ts&&Array.isArray(ts.content)&&ts.content[1]&&Array.isArray(rs.content)&&rs.content[1]){var th=ts.content[0]||[];var r1=rs.content[1]||[];for(var ci=1;ci<th.length;ci++){if(String(ts.content[1][ci]==null?"":ts.content[1][ci])!==String(r1[ci]==null?"":r1[ci]))return false;}}}return true;}catch(e){return false;}}',
        'function mvu2shujukuMissingTableNames(api,names){var all={};try{all=api.exportTableAsJson()||{};}catch(e){}var have={};for(var k in all){if(k.indexOf("sheet_")===0&&all[k]&&typeof all[k].name==="string")have[all[k].name]=true;}var missing=[];for(var i=0;i<names.length;i++){if(!have[names[i]])missing.push(names[i]);}return missing;}',
        'function mvu2shujukuExpectedColumns(tpl){var map={};if(!tpl||typeof tpl!=="object")return map;for(var k in tpl){if(k.indexOf("sheet_")!==0)continue;var s=tpl[k];if(!s||typeof s!=="object"||typeof s.name!=="string")continue;var hdr=Array.isArray(s.content)&&Array.isArray(s.content[0])?s.content[0]:[];var cols=[];for(var i=1;i<hdr.length;i++){if(cols.indexOf(hdr[i])===-1)cols.push(hdr[i]);}map[s.name]=cols;}return map;}',
        'function mvu2shujukuMissingColumns(api,expected){var all={};try{all=api.exportTableAsJson()||{};}catch(e){}var have={};for(var k in all){if(k.indexOf("sheet_")===0&&all[k]&&typeof all[k].name==="string")have[all[k].name]=all[k];}var mismatch=[];for(var name in expected){var sheet=have[name];if(!sheet)continue;var hdr=Array.isArray(sheet.content)&&Array.isArray(sheet.content[0])?sheet.content[0]:[];var exp=expected[name];for(var i=0;i<exp.length;i++){if(hdr.indexOf(exp[i])===-1){mismatch.push(name+"(缺列:"+exp[i]+")");break;}}}return mismatch;}',
        // 世界书的 substituteParams 发生在正文注入链上；数据库模板是直接解码导入，必须在这里显式调用同一原生接口。
        // 仅处理 content 数据行与 seedRows；表名中的宏已在转换时静态规范化，表头仍是不可含运行时宏的固定结构。
        'function mvu2shujukuMacroMark(s){s=String(s==null?"":s);return /<(?:USER|BOT|CHAR|CHARIFNOTGROUP|GROUP)>/i.test(s)||/\\{\\{[\\s\\S]*?\\}\\}/.test(s);}',
        'function mvu2shujukuMacroEnv(){var win=(typeof window!=="undefined"?window:(typeof globalThis!=="undefined"?globalThis:null));var tries=[];function add(w){try{if(w&&tries.indexOf(w)===-1)tries.push(w);}catch(e){}}add(win);if(win){try{add(win.parent);}catch(e){}try{add(win.top);}catch(e){}}for(var i=0;i<tries.length;i++){var w=tries[i],ctx=null;try{if(w.SillyTavern&&typeof w.SillyTavern.getContext==="function")ctx=w.SillyTavern.getContext();}catch(e){}try{if(!ctx&&typeof w.getContext==="function")ctx=w.getContext();}catch(e){}if(ctx&&typeof ctx.substituteParams==="function")return {ctx:ctx,fn:ctx.substituteParams,holder:w};}return null;}',
        'function mvu2shujukuMacroCacheKey(seed,ctx){var s=String(seed||"")+"|"+String(ctx&&(ctx.chatId||ctx.chat_id||ctx.chatFile||ctx.chatFileName)||"unknown");var h=2166136261;for(var i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return String(h>>>0);}',
        'function mvu2shujukuCheckRowKeyCollision(rows,start,sheet){var ddl=String(sheet&&sheet.sourceData&&sheet.sourceData.ddl||"");var um=ddl.match(/\\bUNIQUE\\s*\\(([^)]+)\\)/i);var keyCount=um?um[1].split(",").length:(/\\bUNIQUE\\b/i.test(ddl)?1:0);if(!keyCount||!Array.isArray(rows))return;var seen={};for(var i=start;i<rows.length;i++){var row=rows[i];if(!Array.isArray(row)||row.length<keyCount+1)continue;var vals=[];for(var k=0;k<keyCount;k++)vals.push(String(row[k+1]==null?"":row[k+1]));if(vals.some(function(v){return !v;}))continue;var key=vals.join("\\u0000");if(seen[key])throw new Error("表「"+String(sheet&&sheet.name||"")+"」宏替换后键名冲突："+vals.join(" / "));seen[key]=true;}}',
        'function mvu2shujukuResolveTemplateMacros(tpl,seed){var has=false;for(var k in tpl){if(k.indexOf("sheet_")!==0)continue;var s=tpl[k];if(!s||typeof s!=="object")continue;var hdr=Array.isArray(s.content)&&Array.isArray(s.content[0])?s.content[0]:[];for(var hi=0;hi<hdr.length;hi++)if(mvu2shujukuMacroMark(hdr[hi]))return {ok:false,status:"error",message:"固定列名不支持运行时宏："+hdr[hi]};var lists=[];if(Array.isArray(s.content))lists.push({rows:s.content,start:1});if(Array.isArray(s.seedRows))lists.push({rows:s.seedRows,start:0});for(var li=0;li<lists.length;li++){var rs=lists[li].rows;for(var ri=lists[li].start;ri<rs.length;ri++){var row=rs[ri];if(!Array.isArray(row))continue;for(var ci=0;ci<row.length;ci++)if(typeof row[ci]==="string"&&mvu2shujukuMacroMark(row[ci]))has=true;}}}if(!has)return {ok:true,template:tpl};var env=mvu2shujukuMacroEnv();if(!env)return {ok:false,status:"partial",message:"初始数据含有 SillyTavern 宏，但 substituteParams 尚未就绪，等待重试"};var ck=mvu2shujukuMacroCacheKey(seed,env.ctx);var holder=env.holder||{};var cache=holder.__mvu2shujukuResolvedMacroTemplates||(holder.__mvu2shujukuResolvedMacroTemplates={});if(cache[ck])return {ok:true,template:cache[ck]};var out=JSON.parse(JSON.stringify(tpl));try{for(var k2 in out){if(k2.indexOf("sheet_")!==0)continue;var sh=out[k2];if(!sh||typeof sh!=="object")continue;var sets=[];if(Array.isArray(sh.content))sets.push({rows:sh.content,start:1});if(Array.isArray(sh.seedRows))sets.push({rows:sh.seedRows,start:0});for(var si=0;si<sets.length;si++){var rows=sets[si].rows;for(var r=sets[si].start;r<rows.length;r++){if(!Array.isArray(rows[r]))continue;for(var c=0;c<rows[r].length;c++){if(typeof rows[r][c]==="string")rows[r][c]=String(env.fn.call(env.ctx,rows[r][c]));}}mvu2shujukuCheckRowKeyCollision(rows,sets[si].start,sh);}}}catch(e){return {ok:false,status:"error",message:e&&e.message?e.message:String(e)};}cache[ck]=out;return {ok:true,template:out};}',
        // 聊天里是否已存在 full checkpoint：表格数据以持久化的 checkpoint 为准。
        // 插件回放是异步的，刷新/切聊天时运行时表格可能暂时为空，仅凭 exportTableAsJson
        // 判断“缺表”会误触发 initGameSession(默认模板)，把带数据的好 checkpoint 覆盖成默认值。
        'function mvu2shujukuHasFullFrame(o){try{if(!o||typeof o!=="object")return false;var fr=o.storageFrame;if(fr&&typeof fr==="object"&&fr.version===2&&Array.isArray(fr.logEntries)&&fr.checkpoint&&fr.checkpoint.kind==="full")return true;for(var ck in o){var child=o[ck];if(typeof child==="string"){try{child=JSON.parse(child);}catch(e){continue;}}if(child&&typeof child==="object"){var fr2=child.storageFrame;if(fr2&&typeof fr2==="object"&&fr2.version===2&&Array.isArray(fr2.logEntries)&&fr2.checkpoint&&fr2.checkpoint.kind==="full")return true;}}return false;}catch(e){return false;}}',
        'function mvu2shujukuChatHasFullCheckpoint(){try{var win=(typeof window!=="undefined"?window:(typeof globalThis!=="undefined"?globalThis:null));var ctx=null;var tries=[win];if(win){try{if(win.parent&&win.parent!==win)tries.push(win.parent);}catch(e){}}for(var ti=0;ti<tries.length;ti++){var w=tries[ti];if(!w)continue;try{if(w.SillyTavern&&typeof w.SillyTavern.getContext==="function"){ctx=w.SillyTavern.getContext();break;}}catch(e){}try{if(typeof w.getContext==="function"){ctx=w.getContext();break;}}catch(e){}}var chat=ctx&&Array.isArray(ctx.chat)?ctx.chat:[];for(var mi=0;mi<chat.length;mi++){var msg=chat[mi];if(!msg||typeof msg!=="object")continue;for(var k in msg){if(k.indexOf("TavernDB_ACU_")!==0&&k.indexOf("_acu_")!==0)continue;var v=msg[k];if(typeof v==="string"){try{v=JSON.parse(v);}catch(e){continue;}}if(mvu2shujukuHasFullFrame(v))return true;}}return false;}catch(e){return false;}}',
        // 只有“恰好一个非用户首楼”才算可安全修复的新聊天；任何用户楼层都意味着可能已有游玩数据。
        'function mvu2shujukuChatIsPristineOpening(){try{var win=(typeof window!=="undefined"?window:(typeof globalThis!=="undefined"?globalThis:null));var ctx=null;var tries=[win];if(win){try{if(win.parent&&win.parent!==win)tries.push(win.parent);}catch(e){}}for(var ti=0;ti<tries.length;ti++){var w=tries[ti];if(!w)continue;try{if(w.SillyTavern&&typeof w.SillyTavern.getContext==="function"){ctx=w.SillyTavern.getContext();break;}}catch(e){}try{if(typeof w.getContext==="function"){ctx=w.getContext();break;}}catch(e){}}var chat=ctx&&Array.isArray(ctx.chat)?ctx.chat:[];return chat.length===1&&!!chat[0]&&!chat[0].is_user;}catch(e){return false;}}',
        // full checkpoint 存在时不能因 replay 暂时为空就重置；必须在运行时已明确看到至少一张当前模板之外的外来表。
        'function mvu2shujukuForeignRuntimeTableNames(api,names){var out=[];try{var all=api.exportTableAsJson()||{};for(var k in all){if(k.indexOf("sheet_")!==0||!all[k]||typeof all[k].name!=="string")continue;var name=all[k].name;if(names.indexOf(name)===-1&&out.indexOf(name)===-1)out.push(name);}}catch(e){}return out;}',
        // 聊天是否有 AI 楼层（非 user 消息）：插件 initGameSession 需要 AI 楼层才能写初始化 checkpoint。
        // 新聊天首楼还在加载、或切聊天回来 context.chat 尚未就绪时没有 AI 楼层，此时绝不能调
        // initGameSession（会报“当前聊天不存在可写入初始化 checkpoint 的 AI 楼层”），要返回可重试状态。
        'function mvu2shujukuChatHasAiFloor(){try{var win=(typeof window!=="undefined"?window:(typeof globalThis!=="undefined"?globalThis:null));var ctx=null;var tries=[win];if(win){try{if(win.parent&&win.parent!==win)tries.push(win.parent);}catch(e){}}for(var ti=0;ti<tries.length;ti++){var w=tries[ti];if(!w)continue;try{if(w.SillyTavern&&typeof w.SillyTavern.getContext==="function"){ctx=w.SillyTavern.getContext();break;}}catch(e){}try{if(typeof w.getContext==="function"){ctx=w.getContext();break;}}catch(e){}}var chat=ctx&&Array.isArray(ctx.chat)?ctx.chat:[];for(var mi=0;mi<chat.length;mi++){if(chat[mi]&&!chat[mi].is_user)return true;}return false;}catch(e){return false;}}',
        'var mvu2shujukuInitSessionHung=false;var mvu2shujukuInitSessionHungChat="";',
        'function mvu2shujukuRuntimeChatKey(){try{var win=(typeof window!=="undefined"?window:(typeof globalThis!=="undefined"?globalThis:null));var ctx=null;var tries=[win];if(win){try{if(win.parent&&win.parent!==win)tries.push(win.parent);}catch(e){}}for(var ti=0;ti<tries.length;ti++){var w=tries[ti];if(!w)continue;try{if(w.SillyTavern&&typeof w.SillyTavern.getContext==="function"){ctx=w.SillyTavern.getContext();break;}}catch(e){}try{if(typeof w.getContext==="function"){ctx=w.getContext();break;}}catch(e){}}return String(ctx&&(ctx.chatId||ctx.chat_id||ctx.chatFile||ctx.chatFileName)||"unknown");}catch(e){return "unknown";}}',
        'function mvu2shujukuWithTimeout(promise,ms,label){var done=false;var tid=null;var timeoutPromise=new Promise(function(resolve){tid=setTimeout(function(){if(!done){done=true;resolve({timeout:true,message:label+" 超时("+(ms/1000)+"s)"});}},ms);});return Promise.race([Promise.resolve(promise).then(function(v){if(!done){done=true;if(tid)clearTimeout(tid);}return v;}),timeoutPromise]);}',
        'async function mvu2shujukuEnsureInit(api,b64,presetName,to){var out={status:"skip",message:"",missing:[],replacedFreshForeignCheckpoint:false};var t1=(to&&to.importMs)||15000;var t2=(to&&to.initMs)||20000;var tpl=null;if(to&&to.preparedTemplate&&typeof to.preparedTemplate==="object"){tpl=JSON.parse(JSON.stringify(to.preparedTemplate));}else{try{tpl=JSON.parse(mvu2shujukuDecodeB64(b64));}catch(e){out.status="error";out.message="模板解码失败: "+(e&&e.message?e.message:e);return out;}}var macroResult=mvu2shujukuResolveTemplateMacros(tpl,b64);if(!macroResult.ok){out.status=macroResult.status||"error";out.message=macroResult.message||"初始数据宏替换失败";return out;}tpl=macroResult.template;out.template=tpl;var names=mvu2shujukuExpectedTableNames(tpl);if(!names.length){out.status="error";out.message="模板中没有 sheet_* 表";return out;}out.missing=mvu2shujukuMissingTableNames(api,names);var hasFullCheckpoint=mvu2shujukuChatHasFullCheckpoint();var foreignRuntimeTables=hasFullCheckpoint?mvu2shujukuForeignRuntimeTableNames(api,names):[];var replaceFreshForeign=hasFullCheckpoint&&out.missing.length>0&&foreignRuntimeTables.length>0&&mvu2shujukuChatIsPristineOpening();if(hasFullCheckpoint&&!replaceFreshForeign){out.status="skip";out.message="聊天已有 full checkpoint，跳过自动建表（以持久化数据为准，运行时物化由插件完成）";return out;}if(replaceFreshForeign)out.replacedFreshForeignCheckpoint=true;if(!mvu2shujukuChatHasAiFloor()){out.status="partial";out.message="聊天暂无 AI 楼层（首楼未就绪或切换加载中），等待重试";return out;}var colMiss=[];var needsImport=out.missing.length>0;if(!needsImport){colMiss=mvu2shujukuMissingColumns(api,mvu2shujukuExpectedColumns(tpl));needsImport=colMiss.length>0;}if(!needsImport){var all2={};try{all2=api.exportTableAsJson()||{};}catch(e){}var rtCount=0;var rtEmptyAll=true;var rtHasSeed=false;var tplHasRows=false;for(var k2 in all2){if(k2.indexOf("sheet_")!==0)continue;var sh2=all2[k2];if(!sh2||typeof sh2!=="object"||typeof sh2.name!=="string")continue;rtCount++;if(Array.isArray(sh2.content)&&sh2.content.length>1)rtEmptyAll=false;if(Array.isArray(sh2.seedRows)&&sh2.seedRows.length)rtHasSeed=true;}for(var tk in tpl){if(tk.indexOf("sheet_")!==0)continue;var tsx=tpl[tk];if(tsx&&typeof tsx==="object"&&Array.isArray(tsx.content)&&tsx.content.length>1){tplHasRows=true;break;}}/* 根因修复：插件 native 初始化可能已用“仅表头”模板建表（content 无行、无 checkpoint）。此时跳过 initGameSession 会让 checkpoint 停在无行状态，刷新后 v2-replay 无法恢复任何行（插件 loadFromData 的 hasRealDataRows 门禁 + 有 checkpoint 后 seedRows 不再物化）。只要运行时全表仅表头且带有模板 seedRows（插件 native 初始化签名），就继续走 initGameSession 用完整模板原子建锚+补行（无损：无真实数据行）。*/var headerOnlyFresh=rtCount>0&&rtEmptyAll&&rtHasSeed&&tplHasRows;if(!headerOnlyFresh){var emptyS=[];try{for(var k3 in all2){if(k3.indexOf("sheet_")!==0)continue;var sh3=all2[k3];if(!sh3||typeof sh3!=="object"||typeof sh3.name!=="string")continue;if(Array.isArray(sh3.content)&&sh3.content.length>1)continue;if(Array.isArray(sh3.seedRows)&&sh3.seedRows.length)continue;var ts3=mvu2shujukuSheetByName(tpl,sh3.name);if(!ts3||!Array.isArray(ts3.content)||ts3.content.length!==2)continue;emptyS.push(sh3.name);}}catch(e){}if(emptyS.length){for(var ei=0;ei<emptyS.length;ei++){try{var ts2=mvu2shujukuSheetByName(tpl,emptyS[ei]);var hdr2=ts2.content[0];var row2=ts2.content[1];var obj2={};for(var ci=1;ci<hdr2.length;ci++){obj2[hdr2[ci]]=(row2[ci]!==undefined&&row2[ci]!==null)?row2[ci]:"";}await Promise.resolve(api.insertRow(emptyS[ei],obj2));}catch(e){}}out.status="skip";out.message="已为仅表头的单例/JSON表补初始行："+emptyS.join("、");return out;}out.status="skip";out.message="已有全部表格且结构匹配，跳过开局建表";return out;}}var steps=[];if(replaceFreshForeign)steps.push("检测到新聊天的异卡 checkpoint（"+foreignRuntimeTables.join("、")+"），已按当前卡模板重建");var initOk=false;try{if(mvu2shujukuInitSessionHung&&mvu2shujukuInitSessionHungChat&&mvu2shujukuInitSessionHungChat!==mvu2shujukuRuntimeChatKey()){mvu2shujukuInitSessionHung=false;}}catch(e){}if(typeof api.initGameSession==="function"&&!mvu2shujukuInitSessionHung){try{var r2=await mvu2shujukuWithTimeout(api.initGameSession({},{injectTemplate:true,loadPreset:false,templateData:tpl,templatePresetName:presetName||"",resetExistingTableData:true}),t2,"initGameSession");if(r2&&r2.timeout){mvu2shujukuInitSessionHung=true;try{mvu2shujukuInitSessionHungChat=mvu2shujukuRuntimeChatKey();}catch(e){}steps.push("initGameSession: 超时，已跳过后续重试");}else if(r2&&r2.success===false){steps.push("initGameSession: "+(r2.message||"失败"));}else{initOk=true;steps.push("initGameSession: 完成"+(r2&&r2.runtimeReady===false?"（运行时未就绪）":""));}}catch(e){steps.push("initGameSession异常: "+(e&&e.message?e.message:e));}}else if(typeof api.initGameSession!=="function"){steps.push("initGameSession: 不可用");}if(!initOk&&typeof api.importTemplateFromData==="function"){try{var r1=await mvu2shujukuWithTimeout(api.importTemplateFromData(tpl,{scope:"chat",presetName:presetName||""}),t1,"importTemplateFromData");steps.push(r1&&r1.timeout?r1.message:(r1&&r1.success===false?("importTemplateFromData: "+(r1.message||"失败")):"importTemplateFromData: 完成"));}catch(e){steps.push("importTemplateFromData异常: "+(e&&e.message?e.message:e));}}out.missing=mvu2shujukuMissingTableNames(api,names);colMiss=out.missing.length?[]:mvu2shujukuMissingColumns(api,mvu2shujukuExpectedColumns(tpl));out.status=(out.missing.length||colMiss.length)?"partial":"ok";out.message=steps.join("；")+"；剩余缺表："+(out.missing.length?out.missing.join("、"):"无")+(colMiss.length?"；结构不匹配："+colMiss.join("、"):"");return out;}',
    ].join('\n');
function buildLayoutJson(layout) {
        const safe = layout.entries.map(e => ({
            kind: e.kind,
            group: e.group,
            table: e.table,
            keyCol: e.keyCol || '',
            keyValue: e.keyValue || '',
            childKey: e.childKey || '',
            parentKeyCol: e.parentKeyCol || '',
            ancestorKeyCols: e.ancestorKeyCols || (e.parentKeyCol ? [e.parentKeyCol] : []),
            parentTable: e.parentTable || '',
            parentPath: e.parentPath || [],
            path: e.path || [],
            valueCol: e.valueCol || '',
            scalarValueCol: e.scalarValueCol || '',
            scalarType: e.scalarType,
            emptyValue: Object.prototype.hasOwnProperty.call(e, 'emptyValue') ? e.emptyValue : undefined,
            cols: (e.cols || []).map(c => e.kind === 'singleton'
                ? [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, c.path || [], !!c.isPair, c.desc || '']
                : [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, c.path || [], !!c.isPair, c.desc || '']),
            writePaths: e.writePaths || [],
            mirrors: e.mirrors || [],
        }));
        return JSON.stringify(safe);
    }
function generateBridgeScript(schema, template, opts = {}) {
        const layout = buildLayout(schema);
        const layoutJson = buildLayoutJson(layout);
        const templateJson = JSON.stringify(template);
        const initialTables = JSON.parse(templateJson);
        for (const key in initialTables) {
            const sheet = initialTables[key];
            if (key.indexOf('sheet_') !== 0 || !sheet || !Array.isArray(sheet.content) || sheet.content.length > 1 || !Array.isArray(sheet.seedRows) || !sheet.seedRows.length) continue;
            sheet.content = [sheet.content[0], ...sheet.seedRows];
        }
        const initialMvuJson = JSON.stringify(statDataFromTables(JSON.parse(layoutJson), initialTables));
        const b64 = opts.templateB64 || (typeof Buffer !== 'undefined'
            ? Buffer.from(templateJson, 'utf8').toString('base64')
            : btoaSafe(templateJson));
        const installMvuShim = opts.installMvuShim !== false;
        const appendPlaceholder = !!opts.appendPlaceholder;
        const statusPlaceholderNeeded = !!opts.statusPlaceholderNeeded;
        const name = opts.bridgeScriptName || 'MVU转数据库-数据桥';
        const ver = opts.version || VERSION;
        const jsonrepairInline = opts.jsonrepairInline || '';
        // 桥只属于本转换卡：切卡守卫用它判断当前角色是否还是本卡（名+头像，
        // 与扩展的布局归属判定一致，头像拿不到时按卡名兜底）。
        const bridgeCardName = opts.bridgeCardName || '';
        const bridgeCardAvatar = opts.bridgeCardAvatar || '';
        const bridgeConvertedAt = opts.bridgeConvertedAt || '';

        const script = [
            `window.__MVU2SHUJUKU_TEMPLATE_BASE64="${b64}";`,
            `try{if(window.top)window.top.__MVU2SHUJUKU_TEMPLATE_BASE64="${b64}";}catch(e){}`,
            `(function ${'mvu2shujukuBridge'}(){`,
            `'use strict';`,
            `var VERSION=${JSON.stringify(ver)};`,
            `var BRIDGE_NAME=${JSON.stringify(name)};`,
            `var BRIDGE_CARD_NAME=${JSON.stringify(bridgeCardName)};`,
            `var BRIDGE_CARD_AVATAR=${JSON.stringify(bridgeCardAvatar)};`,
            `var INITIAL_MVU_DATA=${initialMvuJson};`,
            `console.log('['+BRIDGE_NAME+'] 桥启动 v'+VERSION);`,
            ...(jsonrepairInline ? [
                `// jsonrepair（与 MVU 源码同款，JSONPatch 容错解析；扩展内联的完整库优先）`,
                `var mvuBridgeJsonrepair=(function(){`,
                `  try{var full=(rootWindow.__MVU2SHUJUKU_YAML_LIBS__&&rootWindow.__MVU2SHUJUKU_YAML_LIBS__.jsonrepair);if(typeof full==='function')return full;}catch(e){}`,
                `  var module={exports:{}};`,
                `  var exports=module.exports;`,
                jsonrepairInline,
                `  return module.exports.jsonrepair||module.exports;`,
                `})();`,
                '',
            ] : []),
            '',
            `function rootWin(){try{return window.top||window;}catch(e){return window;}}`,
            `var rootWindow=rootWin();`,
            `var bridgePayload={bridgeVersion:VERSION,cardName:BRIDGE_CARD_NAME,cardAvatar:BRIDGE_CARD_AVATAR,convertedAt:${JSON.stringify(bridgeConvertedAt)},layout:${layoutJson},templateBase64:${JSON.stringify(b64)},installMvuShim:${installMvuShim ? 'true' : 'false'},statusPlaceholderNeeded:${statusPlaceholderNeeded ? 'true' : 'false'},sourceWindow:window};`,
            `// 正常环境由扩展作为唯一运行时。桥只提交卡级 payload，扩展确认接管后`,
            `// 立即退出，不再安装第二套 Mvu/事件/写库状态机。后续完整实现仅用于旧环境兼容。`,
            `try{`,
            `  var runtimeRegistry=rootWindow&&rootWindow.__mvu2shujukuRuntime;`,
            `  if(runtimeRegistry&&runtimeRegistry.owner==='extension'&&typeof runtimeRegistry.registerCard==='function'){`,
            `    runtimeRegistry.registerCard(bridgePayload);`,
            `    console.log('['+BRIDGE_NAME+'] 已交由扩展统一运行时接管 v'+String(runtimeRegistry.version||''));`,
            `    return;`,
            `  }`,
            `}catch(e){console.warn('['+BRIDGE_NAME+'] 扩展运行时握手失败:',e);if(runtimeRegistry&&runtimeRegistry.owner==='extension')return;}`,
            `var bridgeLife=(${getBridgeLifecycleFactory().toString()})(window);`,
            `var bridgeInstalled=false;`,
            `var legacyBridges=rootWindow.__mvu2shujukuLegacyBridges||(rootWindow.__mvu2shujukuLegacyBridges=[]);`,
            `var bridgeController={payload:bridgePayload,stop:bridgeLife.stop};legacyBridges.push(bridgeController);`,
            `bridgeLife.cleanup(function(){`,
            `  statOverlayGen++;pendingStatOverlay=null;`,
            `  var done=statOverlayResolve;statOverlayResolve=null;statOverlayPromise=null;if(done)done(false);`,
            `  if(bridgeInstalled)mvuBridgeRestoreGlobals();`,
            `  var index=legacyBridges.indexOf(bridgeController);if(index>=0)legacyBridges.splice(index,1);`,
            `  if(rootWindow.__mvu2shujukuDataBridgeBroadcast===broadcastBridgeEvent)delete rootWindow.__mvu2shujukuDataBridgeBroadcast;`,
            `});`,
            `var roots=[];`,
            `function addRoot(r){try{if(r&&roots.indexOf(r)===-1)roots.push(r);}catch(e){}}`,
            `addRoot(window);`,
            `try{addRoot(window.parent);}catch(e){}`,
            `try{addRoot(window.top);}catch(e){}`,
            `addRoot(rootWindow);`,
            '',
            `// 尽早提供 eventOn/eventOff：前端（body.load 注入）可能在 TH 全局就绪前就调用 eventOn，`,
            `// 若此时没有 eventOn，前端的 VARIABLE_UPDATE_ENDED 监听会注册失败，导致写入后不刷新`,
            `(function installEventOnEarly(){`,
            `  for(var i=0;i<roots.length;i++){`,
            `    var w=roots[i];`,
            `    if(!w||typeof w.addEventListener!=='function')continue;`,
            `    if(typeof w.eventOn==='function')continue;`,
            `    w.eventOn=function(evName,handler){`,
            `      var wrapped=function(e){try{var d=e&&e.detail;if(d&&Object.prototype.hasOwnProperty.call(d,'after')){handler(d.after,d.before);}else{handler(d);}}catch(err){}};`,
            `      w.addEventListener(evName,wrapped);`,
            `      return {stop:function(){try{w.removeEventListener(evName,wrapped);}catch(e2){}}};`,
            `    };`,
            `    w.eventOff=function(evName,handler){try{w.removeEventListener(evName,handler);}catch(e2){}};`,
            `    w.eventOn.__mvu2shujukuFallback=true;`,
            `    w.eventOff.__mvu2shujukuFallback=true;`,
            `  }`,
            `})();`,
            '',
            `function getApi(raw){`,
            `  for(var i=0;i<roots.length;i++){`,
            `    try{var a=roots[i].AutoCardUpdaterAPI;if(a&&typeof a.exportTableAsJson==='function')return raw?a:bridgeLife.api(a);}catch(e){}`,
            `  }`,
            `  return null;`,
            `}`,
            `function getContext(){`,
            `  for(var i=0;i<roots.length;i++){`,
            `    try{if(roots[i].SillyTavern&&typeof roots[i].SillyTavern.getContext==='function')return roots[i].SillyTavern.getContext();}catch(e){}`,
            `    try{if(typeof roots[i].getContext==='function')return roots[i].getContext();}catch(e){}`,
            `  }`,
            `  return null;`,
            `}`,
            '',
            `var API=getApi();`,
            `console.log('['+BRIDGE_NAME+'] 插件 API 就绪:', !!API);`,
            `if(!API){bridgeLife.setTimeout(function(){bridgeLife.stop();mvu2shujukuBridge();},2000);return;}`,
            '',
            `var TEMPLATE_B64=window.__MVU2SHUJUKU_TEMPLATE_BASE64||'';`,
            `function parseTemplate(){`,
            `  try{`,
            `    var bin=atob(TEMPLATE_B64);`,
            `    var bytes=new Uint8Array(bin.length);`,
            `    for(var i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);`,
            `    var txt=new TextDecoder('utf-8').decode(bytes);`,
            `    return JSON.parse(txt);`,
            `  }catch(e){`,
            `    try{return JSON.parse(decodeURIComponent(escape(atob(TEMPLATE_B64))));}catch(e2){return null;}`,
            `  }`,
            `}`,
            `var TEMPLATE=parseTemplate();`,
            '',
            // 开局建表核心流程（与扩展本体同一份逻辑：缺表时按插件 API 初始化）
            ...DB_INIT_SNIPPET.split('\n'),
            '',
            `var SD_LAYOUT=${layoutJson};`,
            `function resolveLayoutMacrosLocal(layout){`,
            `  var out;try{out=JSON.parse(JSON.stringify(layout||[]));}catch(e){out=[];}`,
            `  var ctx=getContext();var sub=ctx&&ctx.substituteParams;`,
            `  if(typeof sub!=='function')return out;`,
            `  function val(v){if(typeof v!=='string'||!/(?:<(?:user|bot|char|charifnotgroup|group)>|\\{\\{[^{}]+\\}\\})/i.test(v))return v;try{return String(sub.call(ctx,v));}catch(e){return v;}}`,
            `  function path(p){if(!Array.isArray(p))return p;for(var i=0;i<p.length;i++)p[i]=val(p[i]);return p;}`,
            `  for(var i=0;i<out.length;i++){var L=out[i];if(!L||typeof L!=='object')continue;`,
            `    L.group=val(L.group);L.keyValue=val(L.keyValue);L.childKey=val(L.childKey);L.parentPath=path(L.parentPath);L.path=path(L.path);`,
            `    if(Array.isArray(L.writePaths))for(var j=0;j<L.writePaths.length;j++)L.writePaths[j]=path(L.writePaths[j]);`,
            `    if(Array.isArray(L.cols))for(var c=0;c<L.cols.length;c++)if(Array.isArray(L.cols[c]))L.cols[c][3]=path(L.cols[c][3]);`,
            `    if(Array.isArray(L.mirrors))for(var m=0;m<L.mirrors.length;m++)if(L.mirrors[m]&&typeof L.mirrors[m]==='object')L.mirrors[m].path=path(L.mirrors[m].path);`,
            `  }return out;`,
            `}`,
            `SD_LAYOUT=resolveLayoutMacrosLocal(SD_LAYOUT);`,
            '',
            `window.getSheetByName=function(tableName){`,
            `  var all={};try{var reader=bridgeLife.stopped?getApi(true):API;all=reader.exportTableAsJson()||{};}catch(e){}`,
            `  for(var key in all){if(key.indexOf('sheet_')===0&&all[key]&&all[key].name===tableName)return all[key];}`,
            `  return null;`,
            `};`,
            `try{rootWindow.getSheetByName=window.getSheetByName;}catch(e){}`,
            '',
            `window.getCellByHeader=function(tableName,rowIndex,colName){`,
            `  var s=window.getSheetByName(tableName);`,
            `  if(!s||!Array.isArray(s.content))return null;`,
            `  var ci=s.content[0]?s.content[0].indexOf(colName):-1;`,
            `  if(ci===-1)return null;`,
            `  return s.content[rowIndex]?s.content[rowIndex][ci]:null;`,
            `};`,
            `try{rootWindow.getCellByHeader=window.getCellByHeader;}catch(e){}`,
            '',
            `window.findRowByColumn=function(tableName,colName,value){`,
            `  var s=window.getSheetByName(tableName);`,
            `  if(!s||!Array.isArray(s.content))return -1;`,
            `  var ci=s.content[0]?s.content[0].indexOf(colName):-1;`,
            `  if(ci===-1)return -1;`,
            `  for(var i=1;i<s.content.length;i++){`,
            `    if(s.content[i]&&String(s.content[i][ci])===String(value))return i;`,
            `  }`,
            `  return -1;`,
            `};`,
            `try{rootWindow.findRowByColumn=window.findRowByColumn;}catch(e){}`,
            '',
            `function sheetOf(name){return window.getSheetByName(name);}`,
            `// 与扩展复用同一编解码工厂；这里只注入桥侧的 JSON 修复函数。`,
            `var tableCodec=(${getTableCodecFactory().toString()})(mvuBridgeJsonrepair);`,
            `var text=tableCodec.text,number=tableCodec.number,boolean=tableCodec.boolean;`,
            `var parseObject=tableCodec.parseObject,convertCell=tableCodec.convertCell;`,
            `var setPath=tableCodec.setPath,getPath=tableCodec.getPath,mergeMissing=tableCodec.mergeMissing;`,
            '',
            `var runtimeDisplay={};`,
            '',
            `// 合并写入：前端一次操作常连续触发多次 replaceMvuData（如同步资源+追加操作日志），`,
            `// 短窗口内合并为一次持久化，读路径直接返回待写快照保证写后立即读一致`,
            `var pendingStatOverlay=null;`,
            `var pendingStatOverlayChatKey='';`,
            `var statOverlayTimer=null;`,
            `var statOverlayGen=0;`,
            `var statOverlayPromise=null;var statOverlayResolve=null;`,
            `function mvuWrap(stat){return {stat_data:stat,display_data:stat,delta_data:{},initialized_lorebooks:{}};}`,
            `function flushStatOverlay(){`,
            `  if(bridgeLife.stopped)return;`,
            `  statOverlayTimer=null;`,
            `  var target=pendingStatOverlay;`,
            `  if(target===null)return;`,
            `  var gen=statOverlayGen;`,
            `  // 归属守卫：150ms 合并窗口内切换聊天时丢弃本次待写，避免旧聊天快照写进新聊天`,
            `  try{`,
            `    var flushChatKeyNow=currentChatKey();`,
            `    if(pendingStatOverlayChatKey&&pendingStatOverlayChatKey!==flushChatKeyNow){`,
            `      console.warn('['+BRIDGE_NAME+'] 合并写库被跳过：聊天已切换（'+pendingStatOverlayChatKey+' -> '+flushChatKeyNow+'），丢弃待写快照。');`,
            `      pendingStatOverlay=null;`,
            `      var dg=statOverlayResolve;statOverlayResolve=null;statOverlayPromise=null;`,
            `      if(dg)dg(false);`,
            `      return;`,
            `    }`,
            `  }catch(e){}`,
            `  bridgeLife.run(async function(){`,
            `    var settled=false;`,
            `    var tableEventsSuppressed=false;`,
            `    try{`,
            `      try{rootWindow.__mvu2shujukuSuppressTableMvuEnded=(Number(rootWindow.__mvu2shujukuSuppressTableMvuEnded)||0)+1;tableEventsSuppressed=true;}catch(e){}`,
            `      // 对齐参考卡：写库直接 diff 落表，不做锚点重建/表重置（运行时保持最小）`,
            `      try{API=getApi();}catch(e){}`,
            `      var prev=currentStat();`,
            `      // 空组保护（行表/关系子表）：target 空组可能是前端“数据未加载”而非`,
            `      // “删除所有行”，保留 prev 内容，避免 DELETE-only 误删全部行`,
            `      try{`,
            `        for(var gk in target){`,
            `          var tv2=target[gk];`,
            `          if(!tv2||typeof tv2!=='object'||Array.isArray(tv2))continue;`,
            `          if(Object.keys(tv2).length)continue;`,
            `          var pv2=prev&&prev[gk];`,
            `          if(!pv2||typeof pv2!=='object'||Array.isArray(pv2)||!Object.keys(pv2).length)continue;`,
            `          var gl=null;for(var li=0;li<SD_LAYOUT.length;li++){if(SD_LAYOUT[li]&&SD_LAYOUT[li].group===gk){gl=SD_LAYOUT[li];break;}}`,
            `          if(gl&&(gl.kind==='rows'||gl.kind==='nestedRows'))target[gk]=JSON.parse(JSON.stringify(pv2));`,
            `        }`,
            `      }catch(e){}`,
            `      var bulkOk=false;`,
            `      try{bulkOk=await bridgeOpeningBulkInit(prev,target);}catch(e){}`,
            `      if(bulkOk){`,
            `        console.log('['+BRIDGE_NAME+'] 开局整表初始化快速路径完成（一次 initGameSession）。');`,
            `        try{emitMvuEvent('mag_variable_initialized',mvuWrap(target),0);}catch(e){}`,
            `        broadcastBridgeEvent(mvuWrap(target),mvuWrap(prev));`,
            `        settled=true;`,
            `      }else{`,
            `        var n2=await writeDiffToDb(prev,target);`,
            `        // 只有真正有差异操作才广播：无差异回声写广播会让前端重渲染后再回声，形成循环`,
            `        if(n2>0)broadcastBridgeEvent(mvuWrap(target),mvuWrap(prev));`,
            `        settled=true;`,
            `      }`,
            `    }catch(e){console.warn('['+BRIDGE_NAME+'] 合并写库异常:',e);}`,
            `    finally{try{if(tableEventsSuppressed)rootWindow.__mvu2shujukuSuppressTableMvuEnded=Math.max(0,(Number(rootWindow.__mvu2shujukuSuppressTableMvuEnded)||1)-1);}catch(e){}if(statOverlayGen===gen){pendingStatOverlay=null;var done=statOverlayResolve;statOverlayResolve=null;statOverlayPromise=null;if(done)done(settled);}}`,
            `  });`,
            `}`,
            `function scheduleStatOverlay(next){`,
            `  if(bridgeLife.stopped)return Promise.resolve(false);`,
            `  if(!statOverlayPromise)statOverlayPromise=new Promise(function(resolve){statOverlayResolve=resolve;});`,
            `  var wait=statOverlayPromise;`,
            `  statOverlayGen++;`,
            `  pendingStatOverlay=next;`,
            `  try{pendingStatOverlayChatKey=currentChatKey();}catch(e){}`,
            `  if(statOverlayTimer)bridgeLife.clearTimeout(statOverlayTimer);`,
            `  statOverlayTimer=bridgeLife.setTimeout(flushStatOverlay,150);`,
            `  return wait;`,
            `}`,
            `var openingBulkUsedChats={};`,
            `var openingBulkClosedChats={};`,
            `var OPENING_BULK_MAX_SNAPSHOTS=4;`,
            `function bridgeNormalizeCellForSync(v){`,
            `  if(v===null||v===undefined)return '';`,
            `  if(typeof v==='boolean')return v?1:0;`,
            `  if(typeof v==='number')return v;`,
            `  if(typeof v==='string')return v;`,
            `  try{return JSON.stringify(v);}catch(e){return String(v);}`,
            `}`,
            `function bridgeOpeningBulkInit(prev,next){`,
            `  return new Promise(function(resolve){`,
            `    try{`,
            `      var ctx=getContext();`,
            `      var chat=ctx&&Array.isArray(ctx.chat)?ctx.chat:[];`,
            `      var chatKey=currentChatKey();`,
            `      if(chat.length===0||chat.length>3){openingBulkClosedChats[chatKey]=true;console.log('['+BRIDGE_NAME+'] 开局整表路径跳过：chat_length='+chat.length);return resolve(false);}`,
            `      if(openingBulkClosedChats[chatKey]){console.log('['+BRIDGE_NAME+'] 开局整表路径跳过：init_phase_closed');return resolve(false);}`,
            `      var bulkState=openingBulkUsedChats[chatKey];`,
            `      if(bulkState&&bulkState.count>=OPENING_BULK_MAX_SNAPSHOTS){openingBulkClosedChats[chatKey]=true;console.log('['+BRIDGE_NAME+'] 开局整表路径跳过：snapshot_limit');return resolve(false);}`,
            `      var nextHash='';try{nextHash=JSON.stringify(next||{});}catch(e){}`,
            `      if(bulkState&&nextHash&&bulkState.lastHash===nextHash){console.log('['+BRIDGE_NAME+'] 开局整表路径跳过：duplicate_snapshot');return resolve(false);}`,
            `      var frontendLoaded=!!((rootWindow&&rootWindow.__mvu2shujukuFrontendLoaded)||(window&&window.__mvu2shujukuFrontendLoaded));`,
            `      try{if(window&&window.parent&&window.parent.__mvu2shujukuFrontendLoaded)frontendLoaded=true;}catch(e){}`,
            `      try{if(window&&window.top&&window.top.__mvu2shujukuFrontendLoaded)frontendLoaded=true;}catch(e){}`,
            `      if(!frontendLoaded)return resolve(false);`,
            `      var groups=Object.keys(next||{}).filter(function(k){return k!=='$internal';});`,
            `      if(groups.length<2)return resolve(false);`,
            `      var tpl=parseTemplate();`,
            `      var sharedCore=(rootWindow&&rootWindow.MVU2SHUJUKU_CORE)||(window&&window.MVU2SHUJUKU_CORE);`,
            `      if(!tpl||!sharedCore||typeof sharedCore.writeStatDiffToDb!=='function'||typeof sharedCore.statDataFromTables!=='function')return resolve(false);`,
            `      var tables=JSON.parse(JSON.stringify(tpl));`,
            `      var fakeApi={`,
            `        exportTableAsJson:function(){return tables;},`,
            `        updateCell:async function(tableName,rowIndex,col,value){var sh=null;for(var k in tables){if(tables[k]&&tables[k].name===tableName){sh=tables[k];break;}}if(!sh||!sh.content[rowIndex])return false;var ci=sh.content[0].indexOf(col);if(ci===-1)return false;sh.content[rowIndex][ci]=bridgeNormalizeCellForSync(value);return true;},`,
            `        insertRow:async function(tableName,obj){var sh=null;for(var k in tables){if(tables[k]&&tables[k].name===tableName){sh=tables[k];break;}}if(!sh)return 0;var row=sh.content[0].map(function(){return '';});for(var ok2 in obj){var ci=sh.content[0].indexOf(ok2);if(ci>=0)row[ci]=bridgeNormalizeCellForSync(obj[ok2]);}var mxr=0;for(var xr=1;xr<sh.content.length;xr++){var xrn=Number(sh.content[xr]&&sh.content[xr][0]);if(isFinite(xrn)&&xrn>mxr)mxr=xrn;}row[0]=mxr+1;sh.content.push(row);return row[0];},`,
            `        deleteRow:async function(tableName,rowIndex){var sh=null;for(var k in tables){if(tables[k]&&tables[k].name===tableName){sh=tables[k];break;}}if(!sh||!sh.content[rowIndex])return false;sh.content.splice(rowIndex,1);return true;}`,
            `      };`,
            `      var baseWrap=sharedCore.statDataFromTables(SD_LAYOUT,tables);`,
            `      var baseStat=baseWrap&&baseWrap.stat_data&&typeof baseWrap.stat_data==='object'?baseWrap.stat_data:{};`,
            `      // 内存模板先追平当前数据库状态，再应用本次差异。若直接在原始模板上做`,
            `      // prev→next，next 未携带/未变化的字段会留在模板默认值，整表注入后造成回滚。`,
            `      sharedCore.writeStatDiffToDb(fakeApi,SD_LAYOUT,baseStat,prev,tables).then(function(){`,
            `        return sharedCore.writeStatDiffToDb(fakeApi,SD_LAYOUT,prev,next,tables);`,
            `      }).then(function(){`,
            `        try{API=getApi();}catch(e){}`,
            `        return API.initGameSession({}, {injectTemplate:true,loadPreset:false,templateData:tables,templatePresetName:''});`,
            `      }).then(function(out){`,
            `        if(out&&out.success===false)throw new Error(out.message||'initGameSession 失败');`,
            `        openingBulkUsedChats[chatKey]={count:(bulkState?bulkState.count:0)+1,lastAt:Date.now(),lastHash:nextHash};`,
            `        resolve(true);`,
            `      }).catch(function(e){console.warn('['+BRIDGE_NAME+'] 开局整表初始化快速路径失败，回退卡内写库:',e);resolve(false);});`,
            `    }catch(e){resolve(false);}`,
            `  });`,
            `}`,
            '',
            // 先登记各窗口“真原始值”再接管：getAllVariables 在脚本顶部定义，
            // 登记必须在此之前，否则会把自家函数当原始值跳过（切卡无法还原）。
            `try{for(var nori=0;nori<roots.length;nori++){if(roots[nori])mvuBridgeNoteOriginal(roots[nori]);}}catch(e){}`,
            `bridgeInstalled=true;`,
            `window.getAllVariables=function(){`,
            `  var data={stat_data:{},display_data:{}};`,
            `  try{`,
            `    try{API=getApi();}catch(e){}`,
            `    var tablesSnap={};`,
            `    try{tablesSnap=API.exportTableAsJson()||{};}catch(e){}`,
            `    data=tableCodec.statDataFromTables(SD_LAYOUT,tablesSnap);`,
            `  }catch(e){console.error('['+BRIDGE_NAME+'] getAllVariables 出错:',e);}`,
            `  try{for(var rk in runtimeDisplay){if(runtimeDisplay.hasOwnProperty(rk))setPath(data.display_data,rk.split('.'),runtimeDisplay[rk]);}}catch(e){}`,
            `  return data;`,
            `};`,
            `console.log('['+BRIDGE_NAME+'] window.getAllVariables 已定义');`,
            `try{window.getAllVariables.__mvu2shujukuBridge=true;}catch(e){}`,
            `try{rootWindow.getAllVariables=window.getAllVariables;}catch(e){}`,
            `function installTavernHelperShim(){`,
            `  for(var i=0;i<roots.length;i++){`,
            `    try{`,
            `      var th=roots[i].TavernHelper;`,
            `      if(!th)continue;`,
            `      if(typeof th.getVariables!=='function')th.getVariables=function(){return window.getAllVariables();};`,
            `    }catch(e){}`,
            `  }`,
            `}`,
            `installTavernHelperShim();`,
            '',
            `// ── 切卡隔离：接管只属于本转换卡，切到其他卡（尤其真 MVU 卡）必须还原原始函数 ──`,
            `// 共享注册表（与扩展共用）：先接管者记录各窗口的“真原始函数”，还原时从这里取值，`,
            `// 避免把桥/扩展自己的接管函数当成“原始值”保存/恢复（跨层污染是切卡不还原的根因）。`,
            `function mvuBridgeSharedState(){`,
            `  try{`,
            `    if(!rootWindow.__mvu2shujukuGlobalState)rootWindow.__mvu2shujukuGlobalState={list:[]};`,
            `    return rootWindow.__mvu2shujukuGlobalState;`,
            `  }catch(e){return null;}`,
            `}`,
            `function mvuBridgeIsOurs(fn){return !!(fn&&typeof fn==='function'&&(fn.__mvu2shujukuBridge||fn.__mvu2shujuku));}`,
            `function mvuBridgeNoteOriginal(gw){`,
            `  var reg=mvuBridgeSharedState();if(!reg)return null;`,
            `  var rec=null;`,
            `  for(var i=0;i<reg.list.length;i++){if(reg.list[i].w===gw){rec=reg.list[i];break;}}`,
            `  if(!rec){rec={w:gw,get:undefined,hasGet:false,upd:undefined,hasUpd:false,rep:undefined,hasRep:false,ins:undefined,hasIns:false,mvu:undefined,hasMvu:false,gav:undefined,hasGav:false,wait:undefined,hasWait:false,msg:undefined,hasMsg:false};reg.list.push(rec);}`,
            `  try{`,
            `    if(!rec.hasGet&&typeof gw.getVariables==='function'&&!mvuBridgeIsOurs(gw.getVariables)){rec.get=gw.getVariables;rec.hasGet=true;}`,
            `    if(!rec.hasUpd&&typeof gw.updateVariablesWith==='function'&&!mvuBridgeIsOurs(gw.updateVariablesWith)){rec.upd=gw.updateVariablesWith;rec.hasUpd=true;}`,
            `    if(!rec.hasRep&&typeof gw.replaceVariables==='function'&&!mvuBridgeIsOurs(gw.replaceVariables)){rec.rep=gw.replaceVariables;rec.hasRep=true;}`,
            `    if(!rec.hasIns&&typeof gw.insertOrAssignVariables==='function'&&!mvuBridgeIsOurs(gw.insertOrAssignVariables)){rec.ins=gw.insertOrAssignVariables;rec.hasIns=true;}`,
            `    if(!rec.hasMvu&&gw.Mvu&&!mvuBridgeIsOurs(gw.Mvu)&&!gw.Mvu.__mvu2shujukuBridgeFake&&!gw.Mvu.__mvu2shujukuFake){rec.mvu=gw.Mvu;rec.hasMvu=true;}`,
            `    if(!rec.hasGav&&typeof gw.getAllVariables==='function'&&!mvuBridgeIsOurs(gw.getAllVariables)){rec.gav=gw.getAllVariables;rec.hasGav=true;}`,
            `    if(!rec.hasWait&&typeof gw.waitGlobalInitialized==='function'&&!mvuBridgeIsOurs(gw.waitGlobalInitialized)){rec.wait=gw.waitGlobalInitialized;rec.hasWait=true;}`,
            `    if(!rec.hasMsg&&typeof gw.getChatMessages==='function'&&!mvuBridgeIsOurs(gw.getChatMessages)){rec.msg=gw.getChatMessages;rec.hasMsg=true;}`,
            `  }catch(e){}`,
            `  return rec;`,
            `}`,
            `function mvuBridgeRestoreGlobals(){`,
            `  var reg=mvuBridgeSharedState();if(!reg)return;`,
            `  for(var i=0;i<reg.list.length;i++){`,
            `    var rec=reg.list[i];var gw=rec.w;if(!gw)continue;`,
            `    try{`,
            `      if(mvuBridgeIsOurs(gw.getVariables)){if(rec.hasGet)gw.getVariables=rec.get;else delete gw.getVariables;}`,
            `      if(mvuBridgeIsOurs(gw.updateVariablesWith)){if(rec.hasUpd)gw.updateVariablesWith=rec.upd;else delete gw.updateVariablesWith;}`,
            `      if(mvuBridgeIsOurs(gw.replaceVariables)){if(rec.hasRep)gw.replaceVariables=rec.rep;else delete gw.replaceVariables;}`,
            `      if(mvuBridgeIsOurs(gw.insertOrAssignVariables)){if(rec.hasIns)gw.insertOrAssignVariables=rec.ins;else delete gw.insertOrAssignVariables;}`,
            `      if(gw.getAllVariables&&mvuBridgeIsOurs(gw.getAllVariables)){if(rec.hasGav)gw.getAllVariables=rec.gav;else delete gw.getAllVariables;}`,
            `      if(gw.Mvu&&(gw.Mvu.__mvu2shujukuBridgeFake||gw.Mvu.__mvu2shujukuFake)){if(rec.hasMvu)gw.Mvu=rec.mvu;else delete gw.Mvu;}`,
            `      if(mvuBridgeIsOurs(gw.waitGlobalInitialized)){if(rec.hasWait)gw.waitGlobalInitialized=rec.wait;else delete gw.waitGlobalInitialized;}`,
            `      if(mvuBridgeIsOurs(gw.getChatMessages)){if(rec.hasMsg)gw.getChatMessages=rec.msg;else delete gw.getChatMessages;}`,
            `    }catch(e){}`,
            `  }`,
            `}`,
            `// 与 MVU/TH 生态一致：提供裸全局 getVariables / updateVariablesWith（游戏逻辑脚本直接调用）`,
            `function mvuBridgeStat(){try{if(window.__mvu2shujukuPendingStat&&typeof window.__mvu2shujukuPendingStat==='object')return window.__mvu2shujukuPendingStat;var a=window.getAllVariables?window.getAllVariables():{stat_data:{}};return a.stat_data||{};}catch(e){return {};}}`,
            `function mvuBridgeDeepEqualCanon(a,b){if(a===b)return true;if(typeof a!==typeof b)return false;if(a===null||b===null)return a===b;if(Array.isArray(a)||Array.isArray(b)){if(!Array.isArray(a)||!Array.isArray(b)||a.length!==b.length)return false;for(var di=0;di<a.length;di++){if(!mvuBridgeDeepEqualCanon(a[di],b[di]))return false;}return true;}if(typeof a==='object'){var ka=Object.keys(a).sort(),kb=Object.keys(b).sort();if(ka.length!==kb.length)return false;for(var ki=0;ki<ka.length;ki++){if(ka[ki]!==kb[ki])return false;if(!mvuBridgeDeepEqualCanon(a[ka[ki]],b[kb[ki]]))return false;}return true;}return a===b;}`,
            `function mvuBridgeInstallGlobals(){`,
            `  if(bridgeLife.stopped)return;`,
            `  for(var gi=0;gi<roots.length;gi++){`,
            `    var gw=roots[gi];`,
            `    if(!gw)continue;`,
            `    try{mvuBridgeNoteOriginal(gw);}catch(e){}`,
            `    try{`,
            `      var msgRec=mvuBridgeNoteOriginal(gw);`,
            `      if(msgRec&&msgRec.hasMsg&&(typeof gw.getChatMessages!=='function'||!mvuBridgeIsOurs(gw.getChatMessages))){`,
            `        var fnMsg=(function(rec){return function(){var result=rec.msg.apply(this,arguments);var decorate=function(list){if(!Array.isArray(list))return list;var stat=mvuBridgeStat();return list.map(function(item){if(!item||typeof item!=='object')return item;var copy=Object.assign({},item);copy.data=Object.assign({},item.data||{},{stat_data:stat,display_data:stat});return copy;});};return result&&typeof result.then==='function'?result.then(decorate):decorate(result);};})(msgRec);`,
            `        fnMsg.__mvu2shujukuBridge=true;gw.getChatMessages=fnMsg;`,
            `      }`,
            `    }catch(e){}`,
            `    try{`,
            `      var curG=gw.getVariables;`,
            `      if(typeof curG!=='function'||mvuBridgeIsOurs(curG)){`,
            `        var fnGet=function(){return mvuWrap(mvuBridgeStat());};`,
            `        fnGet.__mvu2shujukuBridge=true;`,
            `        gw.getVariables=fnGet;`,
            `      }`,
            `    }catch(e){}`,
            `    try{`,
            `      var curU=gw.updateVariablesWith;`,
            `      if(typeof curU!=='function'||mvuBridgeIsOurs(curU)){`,
            `        var fnUpd=async function(updater,opts){`,
            `          if(bridgeLife.stopped)return false;`,
            `          try{`,
            `            if(typeof updater!=='function')return false;`,
            `            var all=window.getAllVariables?window.getAllVariables():{stat_data:{}};`,
            `            var base=(window.__mvu2shujukuPendingStat&&typeof window.__mvu2shujukuPendingStat==='object')?window.__mvu2shujukuPendingStat:(all.stat_data||{});`,
            `            var next=JSON.parse(JSON.stringify(base));`,
            `            var wrapper={stat_data:next,display_data:all.display_data||{},delta_data:all.delta_data||{},initialized_lorebooks:all.initialized_lorebooks||{}};`,
            `            var result=updater(wrapper)||wrapper;`,
            `            var nextStat=result.stat_data||wrapper.stat_data||{};`,
            `            if(mvuBridgeDeepEqualCanon(nextStat,base))return true;`,
            `            var m=window.Mvu||mvuFake;`,
            `            if(m&&typeof m.replaceMvuData==='function')return await m.replaceMvuData({stat_data:nextStat,display_data:result.display_data||all.display_data||{},delta_data:result.delta_data||all.delta_data||{},initialized_lorebooks:result.initialized_lorebooks||all.initialized_lorebooks||{}},opts);`,
            `            return false;`,
            `          }catch(e){console.warn('['+BRIDGE_NAME+'] updateVariablesWith 异常:',e);return false;}`,
            `        };`,
            `        fnUpd.__mvu2shujukuBridge=true;`,
            `        gw.updateVariablesWith=fnUpd;`,
            `      }`,
            `    }catch(e){}`,
            `    try{`,
            `      var curR=gw.replaceVariables;`,
            `      if(typeof curR!=='function'||mvuBridgeIsOurs(curR)){`,
            `        var fnRep=async function(variables,opts){`,
            `          if(bridgeLife.stopped)return false;`,
            `          try{`,
            `            var m=window.Mvu||mvuFake;`,
            `            if(m&&typeof m.replaceMvuData==='function')return await m.replaceMvuData(variables,opts);`,
            `            return false;`,
            `          }catch(e){console.warn('['+BRIDGE_NAME+'] replaceVariables 异常:',e);return false;}`,
            `        };`,
            `        fnRep.__mvu2shujukuBridge=true;`,
            `        gw.replaceVariables=fnRep;`,
            `      }`,
            `    }catch(e){}`,
            `  }`,
            `}`,
            `mvuBridgeInstallGlobals();`,
            `// 切卡守卫：事件优先 + 3s 周期兜底（事件源缺失/漏事件也能还原）。`,
            `// 切到其他卡（尤其真 MVU 卡）→ 还原原始函数；切回本卡 → 重新接管。`,
            `function bridgeOwnCardActive(){`,
            `  if(bridgeLife.stopped)return false;`,
            `  try{`,
            `    var ctx=getContext();if(!ctx)return true;`,
            `    var chars=null;var cid=null;`,
            `    try{chars=ctx.characters;cid=ctx.characterId;}catch(e){}`,
            `    if(!chars||!Array.isArray(chars)||typeof cid!=='number'||!chars[cid]){`,
            `      // 拿不到角色列表（测试沙箱/TH 早期上下文）：不主动撤销，避免误伤`,
            `      return true;`,
            `    }`,
            `    var ch=chars[cid];`,
            `    var n=String(ch&&ch.name||'');`,
            `    var a=String(ch&&ch.avatar||'');`,
            `    if(!n){try{n=String(ctx.name||ctx.charName||ctx.characterName||'');}catch(e2){}}`,
            `    if(!n)return true; // 拿不到当前角色信息时不主动撤销（避免误伤）`,
            `    if(n!==BRIDGE_CARD_NAME)return false;`,
            `    if(a&&BRIDGE_CARD_AVATAR&&a!==BRIDGE_CARD_AVATAR)return false;`,
            `    return true;`,
            `  }catch(e){return true;}`,
            `}`,
            `var mvuBridgeRestored=false;`,
            `function mvuBridgeGuard(){`,
            `  if(bridgeLife.stopped)return;`,
            `  try{`,
            `    if(bridgeOwnCardActive()){`,
            `      if(mvuBridgeRestored){mvuBridgeRestored=false;mvuBridgeInstallGlobals();}`,
            `      return;`,
            `    }`,
            `    if(!mvuBridgeRestored){mvuBridgeRestoreGlobals();mvuBridgeRestored=true;}`,
            `  }catch(e){}`,
            `}`,
            `(function(){`,
            `  try{`,
            `    var ctx=getContext();`,
            `    var es=ctx&&(ctx.eventSource||ctx.event_source);`,
            `    var et=ctx&&(ctx.event_types||ctx.eventTypes);`,
            `    if(es&&typeof es.on==='function'){bridgeLife.on(es,(et&&et.CHAT_CHANGED)||'chat_changed',function(){try{mvuBridgeGuard();}catch(e){}});}`,
            `  }catch(e){}`,
            `  if(typeof setInterval==='function')bridgeLife.setInterval(function(){try{mvuBridgeGuard();}catch(e){}},3000);`,
            `})();`,
            `// 自包含 EJS 数据入口：只导入转换卡时也向 st-prompt-template 注册。`,
            `var ejsDefineRetries=0;`,
            `function installBridgeEjsDefine(){`,
            `  if(bridgeLife.stopped)return;`,
            `  var installed=false;var ws=[];`,
            `  function addW(w){try{if(w&&ws.indexOf(w)===-1)ws.push(w);}catch(e){}}`,
            `  addW(window);addW(rootWindow);for(var ri=0;ri<roots.length;ri++)addW(roots[ri]);`,
            `  for(var wi=0;wi<ws.length;wi++){`,
            `    try{`,
            `      var ej=ws[wi].EjsTemplate;if(!ej||!ej.defines||typeof ej.defines!=='object')continue;`,
            `      var old=ej.defines.mvu2shujukuGetAllVariables;`,
            `      if(typeof old!=='function'||old.__mvu2shujukuBridge){`,
            `        var fn=function(){try{if(!bridgeOwnCardActive())return {stat_data:{}};return window.getAllVariables?window.getAllVariables():{stat_data:{}};}catch(e){return {stat_data:{}};}};`,
            `        fn.__mvu2shujukuBridge=true;ej.defines.mvu2shujukuGetAllVariables=fn;`,
            `      }`,
            `      var getMsg=function(path,opts){var fb=opts&&typeof opts==='object'&&Object.prototype.hasOwnProperty.call(opts,'defaults')?opts.defaults:opts;try{var all=window.getAllVariables?window.getAllVariables():{stat_data:{}};var ps=String(path||'').split('.').filter(function(p){return p!=='';});var cur=all;for(var pi=0;pi<ps.length;pi++){if(cur==null)return fb;cur=cur[ps[pi]];}return cur===undefined?fb:cur;}catch(e){return fb;}};`,
            `      getMsg.__mvu2shujukuBridge=true;ej.defines.mvu2shujukuGetMessageVar=getMsg;`,
            `      var formatMsg=function(path){try{var value=getMsg(path);var core=(rootWindow&&rootWindow.MVU2SHUJUKU_CORE)||(window&&window.MVU2SHUJUKU_CORE);if(core&&typeof core.formatMessageVariableValue==='function')return core.formatMessageVariableValue(value);if(value===undefined)return '';if(value===null)return 'null';if(typeof value!=='object')return String(value);var seen=[];var clean=function(v){if(v===null||typeof v!=='object')return v;if(seen.indexOf(v)>=0)return null;seen.push(v);if(Array.isArray(v))return v.map(clean);var o={};Object.keys(v).forEach(function(k){if(String(k).charAt(0)!=='$')o[k]=clean(v[k]);});return o;};return JSON.stringify(clean(value),null,2);}catch(e){return '';}};`,
            `      formatMsg.__mvu2shujukuBridge=true;ej.defines.mvu2shujukuFormatMessageVariable=formatMsg;`,
            `      var setMsg=function(path,value){try{var ps=String(path||'').split('.').filter(function(p){return p!=='';});if(ps[0]!=='stat_data'||ps.length<2)return value;var all=window.getAllVariables?window.getAllVariables():{stat_data:{}};var next=JSON.parse(JSON.stringify(all.stat_data||{}));setPath(next,ps.slice(1),value);scheduleStatOverlay(next);return value;}catch(e){return value;}};`,
            `      setMsg.__mvu2shujukuBridge=true;ej.defines.mvu2shujukuSetMessageVar=setMsg;`,
            `      var resolveMacro=function(body){var raw='{{'+String(body==null?'':body)+'}}';try{var cx=getContext();var fn=cx&&cx.substituteParams;if(typeof fn==='function')return String(fn.call(cx,raw));}catch(e){}try{if(typeof rootWindow.substituteParams==='function')return String(rootWindow.substituteParams(raw));}catch(e){}return raw;};`,
            `      resolveMacro.__mvu2shujukuBridge=true;ej.defines.mvu2shujukuResolveMacro=resolveMacro;`,
            `      var applyWiRegex=function(name,originalB64,b64,initiallyEnabled){var enabled=!!initiallyEnabled;var original='';try{original=mvu2shujukuDecodeB64(String(originalB64||''));var cx=getContext();var ch=cx&&Array.isArray(cx.characters)?cx.characters[cx.characterId]:null;var ex=ch&&(ch.extensions||(ch.data&&ch.data.extensions));var rs=ex&&Array.isArray(ex.regex_scripts)?ex.regex_scripts:[];for(var qi=0;qi<rs.length;qi++){if(String(rs[qi].scriptName||'')===String(name||'')){enabled=!rs[qi].disabled;break;}}if(!enabled)return original;var rep=mvu2shujukuDecodeB64(String(b64||''));var fn=cx&&cx.substituteParams;if(typeof fn==='function')return String(fn.call(cx,rep));if(!/\\{\\{[\\s\\S]*?\\}\\}/.test(rep))return rep;}catch(e){}return original;};`,
            `      applyWiRegex.__mvu2shujukuBridge=true;ej.defines.mvu2shujukuApplyWorldInfoRegex=applyWiRegex;`,
            `      installed=true;`,
            `    }catch(e){}`,
            `  }`,
            `  if(!installed&&ejsDefineRetries++<60&&typeof setTimeout==='function')bridgeLife.setTimeout(installBridgeEjsDefine,1000);`,
            `  return installed;`,
            `}`,
            `installBridgeEjsDefine();`,
            '',
            `var currentStat=function(){`,
            `  try{return window.getAllVariables().stat_data||{};}catch(e){return {};}`,
            `};`,
            '',
            `// 独立桥使用私有写入实例，避免与扩展共享可变失败状态。`,
            `var bridgeTableWriter=(${getTableWriterFactory().toString()})({`,
            `  parseJson:parseObject,`,
            `  readCachedTemplate:function(){return JSON.parse(mvu2shujukuDecodeB64(TEMPLATE_B64));},`,
            `  warn:function(){console.warn.apply(console,['['+BRIDGE_NAME+']'].concat(Array.prototype.slice.call(arguments)));}`,
            `});`,
            `async function writeDiffToDb(prev,next){`,
            `  var count=await bridgeTableWriter.writeStatDiffToDb(API,SD_LAYOUT,prev,next);`,
            `  if(bridgeTableWriter.lastStatWriteFailed)throw new Error('数据库差异写入未完成');`,
            `  return count;`,
            `}`,
            '',
            `// 完整的 Mvu 兼容层：按 MVU 官方全局 API（createMvu）实现数据库读写，`,
            `// 覆盖式接管运行环境里可能残留的真 MVU 对象（避免双轨冲突）。`,
            `var mvuShimTimer=null;`,
            `async function emitMvuEvent(name){`,
            `  if(bridgeLife.stopped)return;`,
            `  var args=Array.prototype.slice.call(arguments,1);`,
            `  var targets=[];`,
            `  function add(t){try{if(t&&typeof t.dispatchEvent==='function'&&targets.indexOf(t)===-1)targets.push(t);}catch(e){}}`,
            `  add(window);add(rootWindow);`,
            `  for(var i=0;i<roots.length;i++){`,
            `    try{`,
            `      var frames=roots[i].document?roots[i].document.querySelectorAll('iframe'):[];`,
            `      for(var f=0;f<frames.length;f++){try{add(frames[f].contentWindow);}catch(e){}}`,
            `    }catch(e){}`,
            `  }`,
            `  var EventCtor=null;`,
            `  try{EventCtor=window.CustomEvent||rootWindow.CustomEvent||CustomEvent;}catch(e){EventCtor=CustomEvent;}`,
            `  var pending=[];var emitted=[];`,
            `  function invoke(fn,owner){if(typeof fn!=='function'||emitted.indexOf(fn)!==-1)return false;emitted.push(fn);try{pending.push(Promise.resolve(fn.apply(owner,[name].concat(args))));}catch(e){}return true;}`,
            `  for(var t=0;t<targets.length;t++){`,
            `    try{targets[t].dispatchEvent(new EventCtor(name,{detail:{args:args,after:args[0],before:args[1]}}));}catch(e){}`,
            `  }`,
            `  // 主窗口与 iframe 的 eventEmit 是同一 TH 总线的不同包装，只发一次。`,
            `  var busEmitted=false;`,
            `  try{if(typeof eventEmit==='function')busEmitted=invoke(eventEmit,window)||busEmitted;}catch(e){}`,
            `  if(!busEmitted){for(var bt=0;bt<targets.length;bt++){try{if(invoke(targets[bt].eventEmit,targets[bt])){busEmitted=true;break;}}catch(e){}}}`,
            `  if(!busEmitted){for(var bs=0;bs<targets.length;bs++){try{if(targets[bs].eventSource&&invoke(targets[bs].eventSource.emit,targets[bs].eventSource))break;}catch(e){}}}`,
            `  // 缺少 ST 事件总线（如消息 iframe）时提供 eventOn/eventOff 兜底，绑定到同名 CustomEvent`,
            `  for(var t2=0;t2<targets.length;t2++){`,
            `    try{`,
            `      var w=targets[t2];`,
            `      if(w&&typeof w.eventOn!=='function'&&typeof w.addEventListener==='function'){`,
            `        w.eventOn=function(evName,handler){`,
            `          var wrapped=function(e){try{var d=e&&e.detail;if(d&&Array.isArray(d.args)){handler.apply(null,d.args);}else if(d&&Object.prototype.hasOwnProperty.call(d,'after')){handler(d.after,d.before);}else{handler(d);}}catch(err){}};`,
            `          w.addEventListener(evName,wrapped);`,
            `          return {stop:function(){try{w.removeEventListener(evName,wrapped);}catch(e2){}}};`,
            `        };`,
            `        w.eventOff=function(evName,handler){try{w.removeEventListener(evName,handler);}catch(e2){}};`,
            `        w.eventOn.__mvu2shujukuFallback=true;`,
            `        w.eventOff.__mvu2shujukuFallback=true;`,
            `      }`,
            `    }catch(e){}`,
            `  }`,
            `  if(pending.length)await Promise.allSettled(pending);`,
            `}`,
            `var mvuFake=null;`,
            `function applyMvuShim(){`,
            `  if(bridgeLife.stopped)return;`,
            `  if(!bridgeOwnCardActive()){`,
            `    if(!mvuBridgeRestored){try{mvuBridgeRestoreGlobals();}catch(e){}mvuBridgeRestored=true;}`,
            `    return;`,
            `  }`,
            `  mvuBridgeRestored=false;`,
            `  if(!mvuFake){`,
            `    mvuFake={};`,
            `    try{mvuFake.__mvu2shujukuBridgeFake=true;}catch(e){}`,
            `    mvuFake.events={`,
            `      VARIABLE_INITIALIZED:'mag_variable_initialized',`,
            `      VARIABLE_UPDATE_STARTED:'mag_variable_update_started',`,
            `      COMMAND_PARSED:'mag_command_parsed',`,
            `      VARIABLE_UPDATE_ENDED:'mag_variable_update_ended',`,
            `      BEFORE_MESSAGE_UPDATE:'mag_before_message_update',`,
            `      SINGLE_VARIABLE_UPDATED:'mag_variable_updated'`,
            `    };`,
            `    mvuFake.getMvuData=function(opts){`,
            `      // 有待写快照时直接返回，保证 写→读 一致（持久化由合并定时器落库）`,
            `      if(pendingStatOverlay)return {stat_data:pendingStatOverlay,display_data:{},delta_data:{},initialized_lorebooks:{}};`,
            `      var all=window.getAllVariables?window.getAllVariables():{stat_data:{}};`,
            `      return {stat_data:all.stat_data||{},display_data:all.display_data||{},delta_data:{},initialized_lorebooks:{}};`,
            `    };`,
            `    mvuFake.getMvuVariable=function(mvu_data,path,opts){`,
            `      try{`,
            `        opts=opts||{};`,
            `        var cat=opts.category||'stat';`,
            `        var data=(cat==='display'?(mvu_data&&mvu_data.display_data):(cat==='delta'?(mvu_data&&mvu_data.delta_data):(mvu_data&&mvu_data.stat_data)));`,
            `        var parts=String(path||'').split('.').filter(function(p){return p!=='';});`,
            `        var cur=data;`,
            `        for(var i=0;i<parts.length;i++){if(cur==null)break;cur=cur[parts[i]];}`,
            `        var v=cur===undefined?opts.default_value:cur;`,
            `        if(Array.isArray(v)&&v.length===2)return v[0];`,
            `        return v;`,
            `      }catch(e){return opts&&opts.default_value!==undefined?opts.default_value:undefined;}`,
            `    };`,
            `    mvuFake.getRecordFromMvuData=function(mvu_data,category){`,
            `      if(!mvu_data)return undefined;`,
            `      if(category==='display')return mvu_data.display_data;`,
            `      if(category==='delta')return mvu_data.delta_data;`,
            `      return mvu_data.stat_data;`,
            `    };`,
            `    mvuFake.setMvuVariable=async function(mvu_data,path,new_value,opts){`,
            `      try{`,
            `        opts=opts||{};`,
            `        if(!mvu_data||typeof mvu_data!=='object')return false;`,
            `        if(!mvu_data.stat_data||typeof mvu_data.stat_data!=='object')mvu_data.stat_data={};`,
            `        var parts=String(path||'').split('.').filter(function(p){return p!=='';});`,
            `        if(!parts.length)return false;`,
            `        // 与官方 updateVariable 一致：路径不存在返回 false，不自动创建`,
            `        var cur=mvu_data.stat_data;`,
            `        var okP=true;`,
            `        for(var i=0;i<parts.length-1;i++){if(cur[parts[i]]==null||typeof cur[parts[i]]!=='object'||Array.isArray(cur[parts[i]])){okP=false;break;}cur=cur[parts[i]];}`,
            `        if(!okP||cur==null||typeof cur!=='object'||!Object.prototype.hasOwnProperty.call(cur,parts[parts.length-1]))return false;`,
            `        var display_data=(mvu_data.stat_data.$internal&&mvu_data.stat_data.$internal.display_data);`,
            `        var delta_data=(mvu_data.stat_data.$internal&&mvu_data.stat_data.$internal.delta_data);`,
            `        var lastK=parts[parts.length-1];`,
            `        var oldVal=cur[lastK];`,
            `        var finalValue=new_value instanceof Date?new_value.toISOString():new_value;`,
            `        if(Array.isArray(oldVal)&&oldVal.length===2&&typeof oldVal[1]==='string'&&!Array.isArray(oldVal[0])){`,
            `          var oc=JSON.parse(JSON.stringify(oldVal[0]));`,
            `          oldVal[0]=(typeof oc==='number'&&finalValue!==null)?Number(finalValue):finalValue;`,
            `          finalValue=oldVal[0];oldVal=oc;`,
            `        }else{`,
            `          if(typeof oldVal==='number'&&finalValue!==null&&!isNaN(Number(finalValue)))finalValue=Number(finalValue);`,
            `          cur[lastK]=finalValue;`,
            `        }`,
            `        var reason=opts.reason||'';`,
            `        var ds=trimDisplay(oldVal)+'->'+trimDisplay(finalValue)+(reason?(' ('+reason+')'):'');`,
            `        if(display_data){try{setPath(display_data,parts,ds);}catch(e){}}`,
            `        if(delta_data){try{setPath(delta_data,parts,ds);}catch(e){}}`,
            `        console.log('['+BRIDGE_NAME+'] Mvu.setMvuVariable:',path,'=',trimDisplay(finalValue)+(reason?(' ('+reason+')'):''));`,
            `        if(opts.is_recursive){try{emitMvuEvent('mag_variable_updated',mvu_data.stat_data,path,oldVal,finalValue);}catch(e){}}`,
            `        return true;`,
            `      }catch(e){`,
            `        console.warn('['+BRIDGE_NAME+'] Mvu.setMvuVariable 异常:',e);`,
            `        return false;`,
            `      }`,
            `    };`,
            `    async function waitBridgeTablesReady(timeoutMs){var start=Date.now();while(!bridgeLife.stopped&&Date.now()-start<timeoutMs){try{if(tablesReady())return true;}catch(e){}await bridgeLife.sleep(250);}return false;}`,
            `    mvuFake.replaceMvuData=async function(data,opts){`,
            `      var ready=await waitBridgeTablesReady(10000);if(!ready)return false;`,
            `      var nextStat=(data&&data.stat_data)||{};var ok=!!(await scheduleStatOverlay(nextStat));`,
            `      if(ok){try{rootWindow.__mvu2shujukuOpeningStatCandidate={chatKey:currentChatKey(),stat:JSON.parse(JSON.stringify(nextStat)),at:Date.now()};}catch(e){}}`,
            `      return ok;`,
            `    };`,
            `    mvuFake.parseMessage=async function(message,old_data){`,
            `      try{`,
            `        return await runMvuUpdateCycle(message,old_data);`,
            `      }catch(e){console.warn('['+BRIDGE_NAME+'] Mvu.parseMessage 异常:',e);return undefined;}`,
            `    };`,
            `    mvuFake.reloadInitVar=async function(mvu_data){`,
            `      try{if(!mvu_data||!INITIAL_MVU_DATA)return false;var initial=INITIAL_MVU_DATA;mvu_data.stat_data=JSON.parse(JSON.stringify(initial.stat_data||{}));mvu_data.display_data=JSON.parse(JSON.stringify(initial.display_data||initial.stat_data||{}));mvu_data.delta_data={};mvu_data.initialized_lorebooks=mvu_data.initialized_lorebooks||{};return true;}catch(e){return false;}`,
            `    };`,
            `    mvuFake.getCurrentMvuData=function(){return mvuFake.getMvuData({type:'message',message_id:'latest'});};`,
            `    mvuFake.replaceCurrentMvuData=async function(mvu_data){return mvuFake.replaceMvuData(mvu_data,{type:'message',message_id:'latest'});};`,
            `    mvuFake.isDuringExtraAnalysis=function(){return false;};`,
            `  }`,
            `  var targets=[];`,
            `  function addTarget(t){try{if(t&&targets.indexOf(t)===-1)targets.push(t);}catch(e){}}`,
            `  addTarget(window);addTarget(rootWindow);`,
            `  for(var i=0;i<roots.length;i++){`,
            `    addTarget(roots[i]);`,
            `    try{`,
            `      var frames2=roots[i].document?roots[i].document.querySelectorAll('iframe'):[];`,
            `      for(var f2=0;f2<frames2.length;f2++){try{addTarget(frames2[f2].contentWindow);}catch(e){}}`,
            `    }catch(e){}`,
            `  }`,
            `  for(var i2=0;i2<targets.length;i2++){`,
            `    try{`,
            `      var w=targets[i2];`,
            `      var originalRec=mvuBridgeNoteOriginal(w);`,
            `      var oldM=w.Mvu;`,
            `      if(oldM&&typeof oldM==='object'&&oldM!==mvuFake){`,
            `        // 保留旧对象上的自定义属性（非 MVU 官方 API），避免破坏其它代码引用`,
            `        for(var pk in oldM){`,
            `          if(!Object.prototype.hasOwnProperty.call(oldM,pk))continue;`,
            `          if(pk==='getMvuData'||pk==='replaceMvuData'||pk==='setMvuVariable'||pk==='getMvuVariable'||pk==='getRecordFromMvuData'||pk==='parseMessage'||pk==='reloadInitVar'||pk==='getCurrentMvuData'||pk==='replaceCurrentMvuData'||pk==='isDuringExtraAnalysis'||pk==='events')continue;`,
            `          if(mvuFake[pk]===undefined)mvuFake[pk]=oldM[pk];`,
            `        }`,
            `      }`,
            `      w.Mvu=mvuFake;`,
            `      if(originalRec&&originalRec.hasWait){`,
            `        var waitFn=(function(owner,original){return function(name){if(String(name)==='Mvu'){try{owner.Mvu=mvuFake;}catch(e){}return Promise.resolve(mvuFake);}return original.apply(owner,arguments);};})(w,originalRec.wait);`,
            `        waitFn.__mvu2shujukuBridge=true;w.waitGlobalInitialized=waitFn;`,
            `      }`,
            `    }catch(e){}`,
            `  }`,
            `  // 完整遵循 TavernHelper 全局共享协议，使 waitGlobalInitialized('Mvu') 立即完成。`,
            `  var initKey='__mvu2shujukuMvuInitializers_'+VERSION;var initFns=rootWindow[initKey]||(rootWindow[initKey]=[]);`,
            `  for(var gi=0;gi<targets.length;gi++){try{var ig=targets[gi]&&targets[gi].initializeGlobal;if(typeof ig==='function'&&initFns.indexOf(ig)===-1){initFns.push(ig);ig.call(targets[gi],'Mvu',mvuFake);}}catch(e){}}`,
            `  var announceKey='__mvu2shujukuMvuGlobalAnnounced_'+VERSION;`,
            `  if(!rootWindow[announceKey]){`,
            `    rootWindow[announceKey]=true;`,
            `    var EC=null;try{EC=window.CustomEvent||rootWindow.CustomEvent||CustomEvent;}catch(e){}`,
            `    for(var ga=0;ga<targets.length;ga++){try{if(EC&&typeof targets[ga].dispatchEvent==='function')targets[ga].dispatchEvent(new EC('global_Mvu_initialized',{detail:{args:[]}}));}catch(e){}}`,
            `    var busDone=false;for(var gb=0;gb<targets.length;gb++){try{if(!busDone&&typeof targets[gb].eventEmit==='function'){targets[gb].eventEmit('global_Mvu_initialized');busDone=true;}}catch(e){}}`,
            `  }`,
            `}`,
            `function installMvuShim(){`,
            `  if(mvuShimTimer)return;`,
            `  applyMvuShim();`,
            `  // MVU exported_events 对外入口：旧卡内桥独立运行时也保持与扩展一致。`,
            `  try{`,
            `    var exportKey='__mvu2shujukuExportedEvents_'+VERSION;`,
            `    if(!rootWindow[exportKey]&&typeof eventOn==='function'){`,
            `      rootWindow[exportKey]=[`,
            `        bridgeLife.eventOn(eventOn,'mag_invoke_mvu',async function(messageContent,variableInfo){if(!variableInfo||variableInfo.old_variables===undefined)return undefined;var next=await runMvuUpdateCycle(String(messageContent||''),variableInfo.old_variables);variableInfo.new_variables=next;return next;}),`,
            `        bridgeLife.eventOn(eventOn,'mag_update_variable',async function(statData,path,newValue,reason,isRecursive){if(!statData||typeof statData!=='object')return false;return await mvuFake.setMvuVariable({stat_data:statData,display_data:{},delta_data:{},initialized_lorebooks:{}},path,newValue,{reason:reason||'',is_recursive:!!isRecursive});})`,
            `      ];`,
            `    }`,
            `  }catch(e){console.warn('['+BRIDGE_NAME+'] MVU 对外事件接口安装失败:',e);}`,
            `  // 真 MVU 可能异步 import 后重新挂载 window.Mvu；周期复查接管（2s），并监听其初始化事件立即接管`,
            `  if(typeof setInterval==='function')mvuShimTimer=bridgeLife.setInterval(function(){try{applyMvuShim();}catch(e){}},2000);`,
            `  // 句柄保存到共享注册表并先停掉旧监听：扩展升级 VERSION 后旧脚本残留的`,
            `  // 监听器不会被移除，累积后 applyMvuShim 会被多代脚本重复触发。`,
            `  try{if(typeof eventOn==='function'){var ginReg=null;try{ginReg=rootWindow.__mvu2shujukuGlobalMvuInitListeners||(rootWindow.__mvu2shujukuGlobalMvuInitListeners=[]);}catch(e){}if(ginReg){for(var gsi=0;gsi<ginReg.length;gsi++){try{if(ginReg[gsi]&&typeof ginReg[gsi].stop==='function')ginReg[gsi].stop();}catch(e){}}ginReg.length=0;}var ginH=bridgeLife.eventOn(eventOn,'global_Mvu_initialized',function(){try{applyMvuShim();}catch(e){}});if(ginReg&&ginH)ginReg.push(ginH);}}catch(e){}`,
            `}`,
            (installMvuShim ? `installMvuShim();` : ``),
            '',
            `function broadcastBridgeEvent(after,before){`,
            `  if(bridgeLife.stopped)return;`,
            `  // 与 MVU 原版一致：写库完成后广播 VARIABLE_UPDATE_ENDED，携带更新前后的完整 MvuData（after, before）`,
            `  try{emitMvuEvent('mag_variable_update_ended',after,before);}catch(e){}`,
            `  // shujuku 生态兼容别名：shujuku 原生状态栏/前端监听同名 CustomEvent（如道渊 v5.2.111-sqlite 版），一并派发`,
            `  try{emitMvuEvent('shujuku-table-updated',null);}catch(e){}`,
            `}`,
            `rootWindow.__mvu2shujukuDataBridgeBroadcast=rootWindow.__mvu2shujukuDataBridgeBroadcast||broadcastBridgeEvent;`,
            '',
            `if(typeof API.registerTableUpdateCallback==='function'){`,
            `  var cbKey='__mvu2shujukuTableUpdateCallback_'+VERSION;`,
            `  if(!rootWindow[cbKey]){`,
            `    rootWindow[cbKey]=function(){`,
            `      if(bridgeLife.stopped)return;`,
            `      try{if(Number(rootWindow.__mvu2shujukuSuppressTableMvuEnded)>0)return;}catch(e){}`,
            `      try{broadcastBridgeEvent(mvuWrap(currentStat()),null);}catch(e){}`,
            `    };`,
            `  }`,
            `  // SP 重载运行时后可能更换回调容器；同一函数反复注册由 API 自身去重。`,
            `  API.registerTableUpdateCallback(rootWindow[cbKey]);`,
            `  var callbackApi=getApi(true),ownedCallback=rootWindow[cbKey];`,
            `  bridgeLife.cleanup(function(){`,
            `    if(callbackApi&&typeof callbackApi.unregisterTableUpdateCallback==='function')callbackApi.unregisterTableUpdateCallback(ownedCallback);`,
            `    if(rootWindow[cbKey]===ownedCallback)delete rootWindow[cbKey];`,
            `  });`,
            `}`,
            '',
            `function currentChatKey(){`,
            `  var ctx=getContext();`,
            `  return String(ctx&&(ctx.chatId||ctx.chat_id||ctx.chatFile||ctx.chatFileName)||'unknown');`,
            `}`,
            `function currentCharName(){`,
            `  var ctx=getContext();`,
            `  try{var n=ctx&&(ctx.name||ctx.charName||ctx.characterName);n=String(n||'').trim();if(n)return n;}catch(e){}`,
            `  // 新建/切换聊天时上下文可能尚未暴露角色名；转换时固化的卡名是可靠兜底。`,
            `  var embedded=String(BRIDGE_CARD_NAME||'').trim();`,
            `  return embedded||'角色';`,
            `}`,
            `var initState={running:false,done:false,key:''};`,
            `var initRetries=0;`,
            `var anchorChat='';var anchorTries=0;`,
            `function hasFullCheckpoint(){`,
            `  try{`,
            `    var ctx=getContext();`,
            `    var chat=ctx&&Array.isArray(ctx.chat)?ctx.chat:[];`,
            `    for(var mi=0;mi<chat.length;mi++){`,
            `      var msg=chat[mi];if(!msg||typeof msg!=='object')continue;`,
            `      var keys=Object.keys(msg);`,
            `      for(var ki=0;ki<keys.length;ki++){`,
            `        var k=keys[ki];`,
            `        if(k.indexOf('TavernDB_ACU_')!==0&&k.indexOf('_acu_')!==0)continue;`,
            `        var v=msg[k];`,
            `        if(typeof v==='string'){try{v=JSON.parse(v);}catch(e){continue;}}`,
            `        if(!v||typeof v!=='object')continue;`,
            `        // 与插件 hasAnyV2Checkpoint_ACU 一致：V2 帧（version=2 + logEntries）且 checkpoint.kind === 'full'`,
            `        if(v.storageFrame&&v.storageFrame.version===2&&Array.isArray(v.storageFrame.logEntries)&&v.storageFrame.checkpoint&&v.storageFrame.checkpoint.kind==='full')return true;`,
            `        var ckeys=Object.keys(v);`,
            `        for(var cki=0;cki<ckeys.length;cki++){`,
            `          var child=v[ckeys[cki]];`,
            `          if(typeof child==='string'){try{child=JSON.parse(child);}catch(e){continue;}}`,
            `          if(child&&typeof child==='object'&&child.storageFrame&&child.storageFrame.version===2&&Array.isArray(child.storageFrame.logEntries)&&child.storageFrame.checkpoint&&child.storageFrame.checkpoint.kind==='full')return true;`,
            `        }`,
            `      }`,
            `    }`,
            `  }catch(e){}`,
            `  return false;`,
            `}`,
            `function bridgeIsOpeningPhase(){`,
            `  try{var ctx=getContext();var chat=ctx&&Array.isArray(ctx.chat)?ctx.chat:[];return chat.length<=2;}catch(e){return true;}`,
            `}`,
            `function ensureTemplateInit(){return bridgeLife.run(ensureTemplateInitWork);}`,
            `async function ensureTemplateInitWork(){`,
            `  if(bridgeLife.stopped)return;`,
            `  if(!TEMPLATE_B64)return;`,
            `  var key=currentChatKey();`,
            `  console.log('['+BRIDGE_NAME+'] ensureTemplateInit: key='+key+' | done='+initState.done+' | running='+initState.running+' | retries='+initRetries);`,
            `  if(initState.key!==key)initRetries=0;`,
            `  // 对齐参考卡：只做“缺表才初始化”（initGameSession，每个聊天 done 去重一次）；`,
            `  // 不做锚点重建/表重置，避免切聊天误清数据。`,
            `  if(initState.done&&initState.key===key)return;`,
            `  if(initState.running)return;`,
            `  initState.running=true;`,
            `  initState.key=key;`,
            `  try{`,
            `    // 每次现取 API（插件可能晚于脚本加载就绪；捕获的 API 可能为 null）`,
            `    var apiNow=getApi();`,
            `    if(!apiNow){console.warn('['+BRIDGE_NAME+'] 插件 API 未就绪，稍后重试建表');initState.running=false;if(initRetries<15){initRetries++;bridgeLife.setTimeout(ensureTemplateInit,3000);}return;}`,
            `    var hadCheckpointBeforeInit=hasFullCheckpoint();`,
            `    var out=await mvu2shujukuEnsureInit(apiNow,TEMPLATE_B64,currentCharName()+'模板');`,
            `    if(bridgeLife.stopped)return;`,
            `    if(out&&out.template)TEMPLATE=out.template;`,
            `    console.log('['+BRIDGE_NAME+'] ensureTemplateInit 结果:', out.status, out.message);`,
            `    if(out.status==='error'||out.status==='partial'){`,
            `      console.warn('['+BRIDGE_NAME+'] 开局建表未完全成功:',out.message);`,
            `      initState.done=false;`,
            `      // 开场白切换/重渲染可能打断插件的运行时初始化；轮询重试直到建表成功`,
            `      if(initRetries<15){initRetries++;bridgeLife.setTimeout(ensureTemplateInit,4000);}`,
            `    }else{`,
            `      console.log('['+BRIDGE_NAME+'] '+out.message);`,
            `      initRetries=0;`,
            `      initState.done=true;`,
            `      if((!hadCheckpointBeforeInit||(out&&out.replacedFreshForeignCheckpoint))&&hasFullCheckpoint()){try{rootWindow.__mvu2shujukuFreshOpeningCheckpoint={chatKey:key,at:Date.now()};}catch(e){}}`,
            `      // 建表/初始化成功 ≈ MVU 的 VARIABLE_INITIALIZED 时机，广播给前端`,
            `      try{var curStat2=currentStat();var sw=0;var cx=getContext();var cc=cx&&Array.isArray(cx.chat)?cx.chat:[];for(var si=cc.length-1;si>=0;si--){if(cc[si]&&!cc[si].is_user){sw=Number(cc[si].swipe_id||0);break;}}emitMvuEvent('mag_variable_initialized',mvuWrap(curStat2),sw);}catch(e){}`,
            `    }`,
            `  }catch(e){`,
            `    console.warn('['+BRIDGE_NAME+'] 开局建表异常:',e);`,
            `    initState.done=false;`,
            `    if(initRetries<15){initRetries++;bridgeLife.setTimeout(ensureTemplateInit,4000);}`,
            `  }`,
            `  initState.running=false;`,
            `}`,
            `function tablesReady(){`,
            `  try{`,
            `    var tpl=parseTemplate();`,
            `    if(!tpl)return false;`,
            `    return mvu2shujukuMissingTableNames(API,mvu2shujukuExpectedTableNames(tpl)).length===0;`,
            `  }catch(e){return false;}`,
            `}`,
            `Promise.resolve(ensureTemplateInit()).then(function(){try{applyPendingUpdateBlocks();}catch(e){}});`,
            '',
            `// MVU 更新块兼容：解析 <UpdateVariable>/<json_patch> 中的 _.set/_.add/_.remove 等指令，`,
            `// 先应用到 stat_data 副本，再 diff 写回数据库（与 Mvu.replaceMvuData 同一套机制）。`,
            `function parseCommandValue2(raw){`,
            `  var t=String(raw==null?'':raw).trim();`,
            `  if(t==='true')return true;`,
            `  if(t==='false')return false;`,
            `  if(t==='null')return null;`,
            `  if(t==='undefined')return undefined;`,
            `  try{return JSON.parse(t);}catch(e){}`,
            `  if(/^-?\\d+(\\.\\d+)?$/.test(t))return Number(t);`,
            `  return t.replace(/^['\"]|['\"]$/g,'');`,
            `}`,
            `function splitCommandArgs(argsStr){`,
            `  var out=[];`,
            `  var cur='';`,
            `  var depth=0;`,
            `  var inStr=null;`,
            `  for(var i=0;i<argsStr.length;i++){`,
            `    var ch=argsStr[i];`,
            `    if(inStr){cur+=ch;if(ch==='\\\\'){cur+=argsStr[i+1]||'';i++;continue;}if(ch===inStr)inStr=null;continue;}`,
            `    if(ch==='\\''||ch==='\"'){inStr=ch;cur+=ch;continue;}`,
            `    if(ch==='('||ch==='['||ch==='{')depth++;`,
            `    if(ch===')'||ch===']'||ch==='}')depth--;`,
            `    if(ch===','&&depth===0){out.push(cur.trim());cur='';continue;}`,
            `    cur+=ch;`,
            `  }`,
            `  if(cur.trim())out.push(cur.trim());`,
            `  return out;`,
            `}`,
            `function parseUpdateCommands(text){`,
            `  var cmds=[];`,
            `  var blockRe=/<(updatevariable|json_?patch)>[\\s\\S]*?(?:\\/\\1>)/gi;`,
            `  var m;`,
            `  while((m=blockRe.exec(String(text||'')))){`,
            `    var inner=m[0].replace(/<[^>]+>/g,'').replace(/\\\`\\\`\\\`[^\\\`]*\\\`\\\`\\\`/g,'').trim();`,
            `    var isJsonBlock=m[1].toLowerCase().indexOf('json')===0;`,
            `    // 标准写法 <UpdateVariable><Analysis>…</Analysis><JSONPatch>…</JSONPatch></UpdateVariable>：`,
            `    // 外层是 updatevariable 时，若内部含 json_patch 子块，则整块按 JSONPatch 解析`,
            `    var sub=m[0].match(/<(json_?patch)>[\\s\\S]*?(?:\\/\\1>)/i);`,
            `    if(sub){inner=sub[0].replace(/<[^>]+>/g,'').trim();isJsonBlock=true;}`,
            `    if(isJsonBlock){`,
            `      try{`,
            `        var patch=null;`,
            `        try{patch=JSON.parse(inner);}catch(e){`,
            `          try{patch=JSON.parse((typeof mvuBridgeJsonrepair==='function'?mvuBridgeJsonrepair(inner):inner));}catch(e2){patch=null;}`,
            `        }`,
            `        if(Array.isArray(patch)){`,
            `          for(var pi=0;pi<patch.length;pi++){`,
            `            var op=patch[pi]||{};`,
            `            if(!op.path&&!op.to)continue;`,
            `            var jt=op.op==='delta'?'add':(op.op==='remove'?'delete':((op.op==='insert'||op.op==='add')?'insert':op.op||'set'));`,
            `            var jp=String(op.path||op.to||'').replace(/^\\//,'').replace(/\\//g,'.');`,
            `            var jpp=jp.split('.');var jpk=jpp.pop();var jparent=jpp.join('.');`,
            `            var rawArgs=jt==='move'?[String(op.from||'').replace(/^\\//,'').replace(/\\//g,'.'),jp]:(jt==='delete'?[jp]:(jt==='insert'?[jparent,jpk,JSON.stringify(op.value)]:[jp,JSON.stringify(op.value)]));`,
            `            cmds.push({type:jt,path:jt==='insert'?jparent:jp,keyOrIndex:jt==='insert'?parseCommandValue2(jpk):undefined,value:op.value,from:op.from,rawArgs:rawArgs,full_match:JSON.stringify(op),reason:'json_patch'});`,
            `          }`,
            `        }`,
            `      }catch(e){}`,
            `      continue;`,
            `    }`,
            `    var cmdRe=/\\.(set|assign|insert|remove|unset|delete|add)\\(/g;`,
            `    var cm;`,
            `    while((cm=cmdRe.exec(inner))){`,
            `      var open=inner.indexOf('(',cm.index+cm[0].length-1);`,
            `      if(open===-1)continue;`,
            `      var depth=1;`,
            `      var end=-1;`,
            `      var inS=null;`,
            `      for(var k=open+1;k<inner.length;k++){`,
            `        var c2=inner[k];`,
            `        if(inS){if(c2==='\\\\'){k++;continue;}if(c2===inS)inS=null;continue;}`,
            `        if(c2==='\\''||c2==='\"'){inS=c2;continue;}`,
            `        if(c2==='(')depth++;`,
            `        else if(c2===')'){depth--;if(depth===0){end=k;break;}}`,
            `      }`,
            `      if(end===-1)break;`,
            `      var args=splitCommandArgs(inner.slice(open+1,end));`,
            `      var after=inner.slice(end+1).replace(/^\\s*;\\s*/,'');`,
            `      var reason='';`,
            `      var rmatch=after.match(/^\\/\\/\s*([^\\n]*)/);`,
            `      if(rmatch)reason=rmatch[1].trim();`,
            `      var type=cm[1];`,
            `      var path=String(args[0]||'').replace(/^['\"]|['\"]$/g,'').replace(/^\\//,'').replace(/\\//g,'.');`,
            `      var fullMatch=inner.slice(cm.index,end+1);`,
            `      if(type==='remove'||type==='unset'||type==='delete'){cmds.push({type:'delete',path:path,keyOrIndex:args[1]!==undefined?parseCommandValue2(args[1]):undefined,rawArgs:args,full_match:fullMatch,reason:reason});}`,
            `      else if(type==='insert'||type==='assign'){cmds.push({type:'insert',path:path,keyOrIndex:args[2]!==undefined?parseCommandValue2(args[1]):null,value:args[2]!==undefined?parseCommandValue2(args[2]):parseCommandValue2(args[1]),rawArgs:args,full_match:fullMatch,reason:reason});}`,
            `      else if(type==='add'){cmds.push({type:'add',path:path,value:args[1]!==undefined?parseCommandValue2(args[1]):undefined,rawArgs:args,full_match:fullMatch,reason:reason});}`,
            `      else {cmds.push({type:'set',path:path,expected:args[2]!==undefined?parseCommandValue2(args[1]):undefined,value:args[2]!==undefined?parseCommandValue2(args[2]):(args[1]!==undefined?parseCommandValue2(args[1]):undefined),rawArgs:args,full_match:fullMatch,reason:reason});}`,
            `      cmdRe.lastIndex=end+1;`,
            `    }`,
            `  }`,
            `  if(!cmds.length&&/\\.(set|assign|insert|remove|unset|delete|add)\\(/.test(String(text||''))&&!/<(updatevariable|json_?patch)>/i.test(String(text||'')))return parseUpdateCommands('<UpdateVariable>'+String(text||'')+'</UpdateVariable>');`,
            `  return cmds;`,
            `}`,
            `function commandInfoFromInternal(cmd){`,
            `  var type=cmd.type;if(type==='assign')type='insert';if(type==='remove'||type==='unset')type='delete';`,
            `  var args=Array.isArray(cmd.rawArgs)?cmd.rawArgs.slice():null;`,
            `  if(!args){if(type==='move')args=[String(cmd.from||''),String(cmd.path||'')];else if(type==='delete')args=cmd.keyOrIndex===undefined?[String(cmd.path||'')]:[String(cmd.path||''),cmd.keyOrIndex];else if(type==='insert')args=cmd.keyOrIndex===null||cmd.keyOrIndex===undefined?[String(cmd.path||''),cmd.value]:[String(cmd.path||''),cmd.keyOrIndex,cmd.value];else if(type==='set'&&cmd.expected!==undefined)args=[String(cmd.path||''),cmd.expected,cmd.value];else args=[String(cmd.path||''),cmd.value];}`,
            `  return {type:type,full_match:cmd.full_match||'',args:args,reason:cmd.reason||''};`,
            `}`,
            `function internalFromCommandInfo(info){`,
            `  if(!info||!Array.isArray(info.args)||!info.args.length)return null;var type=String(info.type||'set').toLowerCase();if(type==='assign')type='insert';if(type==='remove'||type==='unset')type='delete';var args=info.args;`,
            `  function clean(v){return String(v==null?'':v).replace(/^['\"]|['\"]$/g,'').replace(/^\\//,'').replace(/\\//g,'.');}`,
            `  if(type==='move')return {type:type,from:clean(args[0]),path:clean(args[1]),full_match:info.full_match||'',reason:info.reason||''};var path=clean(args[0]);`,
            `  if(type==='delete')return {type:type,path:path,keyOrIndex:args.length>1?parseCommandValue2(args[1]):undefined,full_match:info.full_match||'',reason:info.reason||''};`,
            `  if(type==='insert')return {type:type,path:path,keyOrIndex:args.length>2?parseCommandValue2(args[1]):null,value:parseCommandValue2(args[args.length-1]),full_match:info.full_match||'',reason:info.reason||''};`,
            `  if(type==='add')return {type:type,path:path,value:parseCommandValue2(args[1]),full_match:info.full_match||'',reason:info.reason||''};`,
            `  return {type:'set',path:path,expected:args.length>2?parseCommandValue2(args[1]):undefined,value:parseCommandValue2(args[args.length-1]),full_match:info.full_match||'',reason:info.reason||''};`,
            `}`,
            `function trimDisplay(v){try{return String(JSON.stringify(v)).replace(/^"|"$/g,'').replace(/\\\\"/g,'"');}catch(e){return String(v);}}`,
            `function noteDisplay(display,path,oldV,newV,reason){if(!display)return;var r=reason?(' ('+reason+')'):'';display[path]=trimDisplay(oldV)+'->'+trimDisplay(newV)+r;}`,
            `function applyCommandsToStat(stat,cmds,display){`,
            `  for(var ci=0;ci<cmds.length;ci++){`,
            `    var cmd=cmds[ci];`,
            `    if(!cmd.path)continue;`,
            `    var parts=String(cmd.path).split('.').filter(function(p){return p!=='';});`,
            `    if(parts.some(function(p){return p.charAt(0)==='_';}))continue;`,
            `    if(cmd.type==='move'){`,
            `      var mf=String(cmd.from||'').replace(/^\\//,'').replace(/\\//g,'.').split('.').filter(function(p){return p!=='';});`,
            `      if(mf.some(function(p){return p.charAt(0)==='_';}))continue;`,
            `      var mv;`,
            `      var mc=stat;var mok=true;`,
            `      for(var mi2=0;mi2<mf.length-1;mi2++){mc=mc?mc[mf[mi2]]:null;if(!mc){mok=false;break;}}`,
            `      if(mok&&mc){var mkey=mf[mf.length-1];if(Array.isArray(mc)&&/^\\d+$/.test(String(mkey))){mv=mc[Number(mkey)];mc.splice(Number(mkey),1);}else{mv=mc[mkey];try{delete mc[mkey];}catch(e){}}}`,
            `      var mparts=String(cmd.path).split('.').filter(function(p){return p!=='';});`,
            `      var mt=stat;var mok2=true;`,
            `      for(var mj=0;mj<mparts.length-1;mj++){if(mt[mparts[mj]]===undefined)mt[mparts[mj]]={};mt=mt[mparts[mj]];if(!mt||typeof mt!=='object'){mok2=false;break;}}`,
            `      if(mok2&&mv!==undefined){mt[mparts[mparts.length-1]]=mv;noteDisplay(display,cmd.path,'(移动)',mv,cmd.reason);}`,
            `      continue;`,
            `    }`,
            `    if(cmd.type==='delete'){`,
            `      var oldDel=null;`,
            `      if(cmd.keyOrIndex!==undefined){`,
            `        var dc=stat;for(var dpi=0;dpi<parts.length;dpi++)dc=dc==null?undefined:dc[parts[dpi]];oldDel=dc;`,
            `        if(Array.isArray(dc)){var dri=typeof cmd.keyOrIndex==='number'?cmd.keyOrIndex:-1;if(dri<0){for(var di=0;di<dc.length;di++){try{if(JSON.stringify(dc[di])===JSON.stringify(cmd.keyOrIndex)){dri=di;break;}}catch(e){}}}if(dri>=0&&dri<dc.length)dc.splice(dri,1);}`,
            `        else if(dc&&typeof dc==='object'){var dkey=typeof cmd.keyOrIndex==='number'?Object.keys(dc)[cmd.keyOrIndex]:String(cmd.keyOrIndex);if(dkey!==undefined)try{delete dc[dkey];}catch(e){}}`,
            `      }else{`,
            `        var cur=stat;`,
            `        var ok=true;`,
            `        for(var d=0;d<parts.length-1;d++){cur=cur?cur[parts[d]]:null;if(!cur){ok=false;break;}}`,
            `        if(ok&&cur){var dl=parts[parts.length-1];oldDel=cur[dl];if(Array.isArray(cur)&&/^\\d+$/.test(String(dl)))cur.splice(Number(dl),1);else try{delete cur[dl];}catch(e){}}`,
            `      }`,
            `      if(Array.isArray(oldDel)&&oldDel.length===2)oldDel=oldDel[0];`,
            `      noteDisplay(display,cmd.path,oldDel,'(移除)',cmd.reason);`,
            `      continue;`,
            `    }`,
            `    if(cmd.type==='insert'){`,
            `      var container=stat;`,
            `      for(var d2=0;d2<parts.length;d2++)container=container==null?undefined:container[parts[d2]];`,
            `      if(container==null||typeof container!=='object')continue;var key=cmd.keyOrIndex;`,
            `      if(key===null||key===undefined){if(Array.isArray(container))container.push(cmd.value);else if(cmd.value&&typeof cmd.value==='object'&&!Array.isArray(cmd.value)){for(var mk in cmd.value)if(Object.prototype.hasOwnProperty.call(cmd.value,mk))container[mk]=cmd.value[mk];}}`,
            `      else if(Array.isArray(container)&&(key==='-'||/^-?\\d+$/.test(String(key)))){var ii=key==='-'||Number(key)===-1?container.length:Number(key);container.splice(ii,0,cmd.value);}`,
            `      else if(container&&typeof container==='object'){container[String(key)]=cmd.value;}`,
            `      noteDisplay(display,cmd.path,'(新增)',cmd.value,cmd.reason);`,
            `      continue;`,
            `    }`,
            `    if(cmd.type==='assign'&&cmd.keyOrIndex!==undefined){`,
            `      var acont=stat;`,
            `      var aok=true;`,
            `      for(var d5=0;d5<parts.length-1;d5++){acont=acont?acont[parts[d5]]:null;if(!acont){aok=false;break;}}`,
            `      if(aok&&acont&&typeof acont==='object'){`,
            `        var akey=cmd.keyOrIndex;`,
            `        if(akey==='-'&&Array.isArray(acont))acont.push(cmd.value);`,
            `        else if(Array.isArray(acont)&&/^\\d+$/.test(String(akey)))acont.splice(Number(akey),0,cmd.value);`,
            `        else if(acont&&typeof acont==='object')acont[akey]=cmd.value;`,
            `        noteDisplay(display,cmd.path,(Array.isArray(acont)&&acont.length&&acont[0]!==cmd.value?acont[0]:'(变更)'),cmd.value,cmd.reason);`,
            `      }`,
            `      continue;`,
            `    }`,
            `    if(cmd.type==='assign'&&cmd.value&&typeof cmd.value==='object'&&!Array.isArray(cmd.value)){`,
            `      var tgt=stat;`,
            `      var ok3=true;`,
            `      for(var d3=0;d3<parts.length-1;d3++){tgt=tgt?tgt[parts[d3]]:null;if(!tgt){ok3=false;break;}}`,
            `      if(ok3&&tgt&&typeof tgt==='object'){for(var ak of Object.keys(cmd.value))tgt[ak]=cmd.value[ak];continue;}`,
            `    }`,
            `    var target=stat;`,
            `    var ok4=true;`,
            `    for(var d4=0;d4<parts.length-1;d4++){`,
            `      if(target[parts[d4]]===undefined)target[parts[d4]]={};`,
            `      target=target[parts[d4]];`,
            `      if(!target||typeof target!=='object'){ok4=false;break;}`,
            `    }`,
            `    if(!ok4)continue;`,
            `    var last=parts[parts.length-1];`,
            `    var existing=target[last];`,
            `    // 官方语义：set / add 要求路径已存在（缺失跳过，不自动创建）`,
            `    if(existing===undefined){continue;}`,
            `    if(cmd.type==='add'){`,
            `      var base=Array.isArray(existing)&&existing.length?existing[0]:existing;`,
            `      var delta=parseFloat(cmd.value);`,
            `      var dateVal=null;`,
            `      if(typeof base==='string'){var dtest=new Date(base);if(!isNaN(dtest.getTime())&&isNaN(Number(base)))dateVal=dtest;}`,
            `      if(dateVal&&!isNaN(delta)){`,
            `        var nd=new Date(dateVal.getTime()+delta);`,
            `        target[last]=nd.toISOString();`,
            `        noteDisplay(display,cmd.path,base,target[last],cmd.reason);`,
            `      }else{`,
            `        var num=parseFloat(base);`,
            `        if(!isNaN(num)&&!isNaN(delta)){`,
            `          target[last]=parseFloat((num+delta).toPrecision(12));`,
            `          noteDisplay(display,cmd.path,base,target[last],cmd.reason);`,
            `        }else if(Array.isArray(existing)){`,
            `          existing.push(cmd.value);`,
            `          noteDisplay(display,cmd.path,'(数组追加)',cmd.value,cmd.reason);`,
            `        }else{`,
            `          target[last]=cmd.value;`,
            `          noteDisplay(display,cmd.path,base,target[last],cmd.reason);`,
            `        }`,
            `      }`,
            `    }else{`,
            `      // 官方 set 语义：路径必须已存在（缺失跳过）；VWD 成对数组更新 [0]；数字强转`,
            `      var oldSet=Array.isArray(existing)&&existing.length===2?existing[0]:existing;`,
            `      var nv2=cmd.value instanceof Date?cmd.value.toISOString():cmd.value;`,
            `      if(Array.isArray(existing)&&existing.length===2&&typeof existing[1]==='string'&&!Array.isArray(existing[0])){`,
            `        var oc=JSON.parse(JSON.stringify(existing[0]));`,
            `        existing[0]=(typeof oc==='number'&&nv2!==null)?Number(nv2):nv2;`,
            `        noteDisplay(display,cmd.path,oc,nv2,cmd.reason);`,
            `      }else{`,
            `        if(typeof oldSet==='number'&&nv2!==null&&!isNaN(Number(nv2)))nv2=Number(nv2);`,
            `        target[last]=nv2;`,
            `        noteDisplay(display,cmd.path,oldSet,nv2,cmd.reason);`,
            `      }`,
            `    }`,
            `  }`,
            `  return stat;`,
            `}`,
            `async function applyCommandsWithMvuEvents(stat,cmds,display){`,
            `  function at(path){var c=stat;var ps=String(path||'').split('.').filter(function(p){return p!=='';});for(var i=0;i<ps.length;i++)c=c==null?undefined:c[ps[i]];try{return JSON.parse(JSON.stringify(c));}catch(e){return c;}}`,
            `  for(var i=0;i<cmds.length;i++){var cmd=cmds[i];var oldV=at(cmd.path);applyCommandsToStat(stat,[cmd],display);var newV=at(cmd.path);try{if(JSON.stringify(oldV)!==JSON.stringify(newV))await emitMvuEvent('mag_variable_updated',stat,cmd.path,oldV,newV);}catch(e){}}`,
            `}`,
            `async function runMvuUpdateCycle(message,oldData){`,
            `  try{openingBulkClosedChats[currentChatKey()]=true;}catch(e){}`,
            `  var out=JSON.parse(JSON.stringify(oldData||{}));if(!out.stat_data||typeof out.stat_data!=='object')out.stat_data={};if(!out.display_data||typeof out.display_data!=='object')out.display_data={};if(!out.delta_data||typeof out.delta_data!=='object')out.delta_data={};`,
            `  var before=JSON.parse(JSON.stringify(out));out.stat_data.$internal={display_data:out.display_data,delta_data:out.delta_data};`,
            `  await emitMvuEvent('mag_variable_update_started',out);`,
            `  var originalMessage=String(message||'');var processedMessage=originalMessage;try{var sm=(typeof substitudeMacros==='function'?substitudeMacros:(rootWindow&&typeof rootWindow.substitudeMacros==='function'?rootWindow.substitudeMacros:null));if(sm)processedMessage=String(sm(originalMessage));}catch(e){}`,
            `  var raw=parseUpdateCommands(processedMessage);var infos=[];for(var i=0;i<raw.length;i++)infos.push(commandInfoFromInternal(raw[i]));`,
            `  await emitMvuEvent('mag_command_parsed',out,infos,originalMessage);`,
            `  // 数据库 Schema 已接管类型与约束。仍按官方顺序通知旧 Zod 监听器，`,
            `  // 但使用隔离快照，防止旧 Schema 按 MVU 路径过滤掉已转成数据库列的命令。`,
            `  var zodOut=JSON.parse(JSON.stringify(out));var zodInfos=JSON.parse(JSON.stringify(infos));`,
            `  await emitMvuEvent('mag_command_parsed_for_zod',zodOut,zodInfos,originalMessage);`,
            `  await emitMvuEvent('mag_command_parsed_ended_for_zod',zodOut,zodInfos,originalMessage);`,
            `  var cmds=[];for(var j=0;j<infos.length;j++){var c=internalFromCommandInfo(infos[j]);if(c)cmds.push(c);}if(cmds.length)await applyCommandsWithMvuEvents(out.stat_data,cmds,out.display_data);`,
            `  out.delta_data=JSON.parse(JSON.stringify(out.display_data||{}));if(out.stat_data.$internal)out.stat_data.$internal.delta_data=out.delta_data;`,
            `  await emitMvuEvent('mag_variable_update_ended',out,before);`,
            `  delete out.stat_data.$internal;`,
            `  var zodEnded=JSON.parse(JSON.stringify(out));var zodBefore=JSON.parse(JSON.stringify(before));`,
            `  await emitMvuEvent('mag_variable_update_ended_for_zod',zodEnded,zodBefore);return out;`,
            `}`,
            `var appliedBlocks=null;`,
            `function applyPendingUpdateBlocks(){`,
            `  if(bridgeLife.stopped)return;`,
            `  var ctx=getContext();`,
            `  var chat=ctx&&Array.isArray(ctx.chat)?ctx.chat:[];`,
            `  if(!chat.length)return;`,
            `  if(!tablesReady())return;`,
            `  console.log('['+BRIDGE_NAME+'] applyPendingUpdateBlocks: 扫描 '+chat.length+' 条消息');`,
            `  if(!appliedBlocks)appliedBlocks={};`,
            `  var key=currentChatKey();`,
            `  for(var mi=0;mi<chat.length;mi++){`,
            `    var msg=chat[mi];`,
            `    if(!msg||msg.is_user)continue;`,
            `    var text=String(msg.mes||msg.message||'');`,
            `    if(!/<updatevariable|<json_?patch/i.test(text))continue;`,
            `    var msgKey=key+':'+mi+':'+String(msg.swipe_id||0);`,
            `    if(appliedBlocks[msgKey])continue;`,
            `    appliedBlocks[msgKey]=true;`,
            `    var parsedNow=parseUpdateCommands(text);`,
            `    console.log('['+BRIDGE_NAME+'] 消息 #'+mi+' 含更新块，解析出 '+parsedNow.length+' 条命令');`,
            `    if(!parsedNow.length)continue;`,
            `    (function(messageText){Promise.resolve().then(async function(){`,
            `      try{`,
            `        var prev=currentStat();`,
            `        var nextWrap=await runMvuUpdateCycle(messageText,mvuWrap(prev));`,
            `        var next=(nextWrap&&nextWrap.stat_data)||{};`,
            `        var modified=JSON.stringify(next)!==JSON.stringify(prev);`,
            `        if(modified){var updateContext={variables:nextWrap,message_content:messageText};await emitMvuEvent('mag_before_message_update',updateContext);nextWrap=updateContext.variables||nextWrap;next=(nextWrap&&nextWrap.stat_data)||next;}`,
            `        try{rootWindow.__mvu2shujukuSuppressTableMvuEnded=(Number(rootWindow.__mvu2shujukuSuppressTableMvuEnded)||0)+1;}catch(e){}`,
            `        return writeDiffToDb(prev,next).then(function(){`,
            `          var disp=(nextWrap&&nextWrap.display_data)||{};for(var dk in disp){if(Object.prototype.hasOwnProperty.call(disp,dk))runtimeDisplay[dk]=disp[dk];}`,
            `        }).finally(function(){`,
            `          try{rootWindow.__mvu2shujukuSuppressTableMvuEnded=Math.max(0,(Number(rootWindow.__mvu2shujukuSuppressTableMvuEnded)||1)-1);}catch(e){}`,
            `        });`,
            `      }catch(e){console.warn('['+BRIDGE_NAME+'] 应用 MVU 更新块失败:',e);}`,
            `    });})(text);`,
            `  }`,
            `}`,
            (appendPlaceholder ? [
                ``,
                `var placeholderRuntime=null;`,
                `// 复刻 MVU 的占位符维护：AI 回复后若卡内正则依赖 <StatusPlaceHolderImpl/>，就在消息末尾补上占位符，`,
                `// 前端注入正则才能命中每条消息（原卡由 MVU 引擎完成，转换后桥接管）`,
                `var statusPlaceholderNeeded=${statusPlaceholderNeeded ? 'true' : 'false'};`,
                `var placeholderMsgKey='';var placeholderAt=0;var placeholderRetryTimer=null;var placeholderRetryCount=0;`,
                `function detectStatusPlaceholder(){`,
                `  try{`,
                `    var ctx0=getContext();`,
                `    var ch0=ctx0&&ctx0.characters?ctx0.characters[ctx0.characterId]:null;`,
                `    var ex0=ch0&&(ch0.extensions||(ch0.data&&ch0.data.extensions))||null;`,
                `    var rx=(ex0&&ex0.regex_scripts)||[];`,
                `    for(var i=0;i<rx.length;i++){`,
                `      var f=String((rx[i]&&rx[i].findRegex)||'');`,
                `      if(f.indexOf('StatusPlaceHolderImpl')!==-1){statusPlaceholderNeeded=true;break;}`,
                `    }`,
                `  }catch(e){}`,
                `}`,
                `function bridgeSetChatMessages(){`,
                `  // 优先使用 TH 脚本作用域注入的裸 setChatMessages（MVU 引擎同款调用方式）`,
                `  try{if(typeof setChatMessages==='function')return setChatMessages;}catch(e){}`,
                `  try{var c=getContext();if(c&&typeof c.setChatMessages==='function')return c.setChatMessages.bind(c);}catch(e){}`,
                `  try{if(typeof window.setChatMessages==='function')return window.setChatMessages;}catch(e){}`,
                `  for(var i=0;i<roots.length;i++){`,
                `    try{if(roots[i].TavernHelper&&typeof roots[i].TavernHelper.setChatMessages==='function')return roots[i].TavernHelper.setChatMessages.bind(roots[i].TavernHelper);}catch(e){}`,
                `    try{if(typeof roots[i].setChatMessages==='function')return roots[i].setChatMessages;}catch(e){}`,
                `  }`,
                `  return null;`,
                `}`,
                `function ensureStatusPlaceholder(){`,
                `  if(bridgeLife.stopped)return;`,
                `  if(!statusPlaceholderNeeded)return;`,
                `  try{`,
                `    var ctx=getContext();`,
                `    if(!ctx||!Array.isArray(ctx.chat)||!ctx.chat.length){console.log('['+BRIDGE_NAME+'][占位符] 跳过：无聊天上下文');return;}`,
                `    if(ctx.generating===true||ctx.isStreaming===true){`,
                `      if(!placeholderRetryTimer&&placeholderRetryCount<10){`,
                `        placeholderRetryTimer=bridgeLife.setTimeout(function(){placeholderRetryTimer=null;placeholderRetryCount+=1;ensureStatusPlaceholder();},1000);`,
                `      }`,
                `      return;`,
                `    }`,
                `    placeholderRetryCount=0;`,
                `    var msg=ctx.chat[ctx.chat.length-1];`,
                `    if(!msg){console.log('['+BRIDGE_NAME+'][占位符] 跳过：无最新消息');return;}`,
                `    if(msg.is_user){console.log('['+BRIDGE_NAME+'][占位符] 跳过：最新消息是用户消息');return;}`,
                `    if(String(msg.name||'')==='System'){console.log('['+BRIDGE_NAME+'][占位符] 跳过：最新消息是 System');return;}`,
                `    var text=String(msg.mes!=null?msg.mes:(msg.message||''));`,
                `    if(text.indexOf('<StatusPlaceHolderImpl/>')!==-1)return;`,
                `    var msgKey=(msg.message_id!=null?msg.message_id:(ctx.chat.length-1))+':'+text.length;`,
                `    var now=Date.now();`,
                `    if(msgKey===placeholderMsgKey&&now-placeholderAt<5000)return;`,
                `    var next=text+'\\n\\n<StatusPlaceHolderImpl/>';`,
                `    var setter=bridgeSetChatMessages();`,
                `    if(setter){`,
                `      setter([{message_id:msg.message_id!=null?msg.message_id:(ctx.chat.length-1),message:next,mes:next}],{refresh:'affected'});`,
                `      console.log('['+BRIDGE_NAME+'][占位符] 已追加到消息 id='+(msg.message_id!=null?msg.message_id:(ctx.chat.length-1)));`,
                `    }else{`,
                `      // 找不到 setChatMessages：只改内存，不调 saveChat（避免保存超时风暴）`,
                `      msg.mes=next;if(msg.message!==undefined)msg.message=next;`,
                `      if(!window.__mvu2shujukuPlaceholderFallbackWarned){window.__mvu2shujukuPlaceholderFallbackWarned=true;console.warn('['+BRIDGE_NAME+'][占位符] 未找到 setChatMessages，已直接写入内存消息');}`,
                `    }`,
                `    placeholderMsgKey=msgKey;placeholderAt=now;`,
                `  }catch(e){console.warn('['+BRIDGE_NAME+'][占位符] 追加失败:',e);}`,
                `}`,
                `function installMessageRuntime(){`,
                `  if(bridgeLife.stopped)return;`,
                `  if(placeholderRuntime&&placeholderRuntime.bound)return;`,
                `  var ctx=getContext();`,
                `  var es=ctx&&ctx.eventSource;`,
                `  var et=ctx&&(ctx.event_types||ctx.eventTypes);`,
                `  var evName=et&&et.MESSAGE_RECEIVED;`,
                `  if(!es||!evName||typeof es.on!=='function'){`,
                `    if(!placeholderRuntime)placeholderRuntime={bound:false,timer:null};`,
                `    placeholderRuntime.timer=bridgeLife.setTimeout(installMessageRuntime,1500);`,
                `    return;`,
                `  }`,
                `  function onMessage(){`,
                `    // 复刻 MVU：消息一到立即补占位符（不延迟），随后再处理建表/更新块`,
                `    try{ensureStatusPlaceholder();}catch(e){}`,
                `    bridgeLife.setTimeout(function(){`,
                `      console.log('['+BRIDGE_NAME+'] 消息收尾触发: 建表/更新块/状态栏刷新');`,
                `      try{var _ctx=getContext();var _m=_ctx&&_ctx.chat&&_ctx.chat[_ctx.chat.length-1];console.log('['+BRIDGE_NAME+'][占位符] MESSAGE_RECEIVED 最新消息 role='+(_m&&_m.is_user?'user':(_m&&_m.name||'?'))+' | 含占位符='+(String(_m&&(_m.mes!=null?_m.mes:(_m.message||''))).indexOf('<StatusPlaceHolderImpl/>')!==-1));}catch(e){}`,
                `      Promise.resolve(ensureTemplateInit()).then(function(){try{applyPendingUpdateBlocks();}catch(e){}});`,
                `      try{broadcastBridgeEvent(mvuWrap(currentStat()),null);}catch(e){}`,
                `      try{ensureStatusPlaceholder();}catch(e){}`,
                `    },250);`,
                `  }`,
                `  bridgeLife.on(es,evName,onMessage);`,
                `  // 开场白/首楼换 swipe 会丢插件 full checkpoint，需及时重建锚点避免 V2 写库 mismatch`,
                `  for(var ei=0;ei<['MESSAGE_SWIPED','MESSAGE_UPDATED','MESSAGE_EDITED'].length;ei++){`,
                `    try{var evName2=et[['MESSAGE_SWIPED','MESSAGE_UPDATED','MESSAGE_EDITED'][ei]];if(evName2&&typeof evName2==='string')bridgeLife.on(es,evName2,onMessage);}catch(e){}`,
                `  }`,
                `  // 新聊天打开即触发建表（参考卡：进入聊天就初始化，不等第一条 AI 回复）；`,
                `  // ensureTemplateInit 按聊天 key 去重，已有表格的聊天不会重初始化`,
                `  try{`,
                `    var evName3=et.CHAT_CHANGED;`,
                `    if(evName3&&typeof evName3==='string'){`,
                `      bridgeLife.on(es,evName3,function(){bridgeLife.setTimeout(function(){try{ensureTemplateInit();}catch(e){}},300);});`,
                `    }`,
                `  }catch(e){}`,
                `  if(placeholderRuntime){placeholderRuntime.bound=true;placeholderRuntime.handler=onMessage;}`,
                `  else placeholderRuntime={bound:true,handler:onMessage};`,
                `}`,
                `detectStatusPlaceholder();`,
                `console.log('['+BRIDGE_NAME+'][占位符] 维护已启用，needed='+statusPlaceholderNeeded);`,
                `installMessageRuntime();`,
                `bridgeLife.setTimeout(function(){try{ensureStatusPlaceholder();}catch(e){}},3000);`,
            ].join('\n') : ``),
            ``,
            `console.log('['+BRIDGE_NAME+'] 数据桥已就绪：getAllVariables/getSheetByName/getCellByHeader/findRowByColumn');`,
            `})();`,
        ].join('\n');
        return script;
    }
return generateBridgeScript;
};
