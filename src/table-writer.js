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
