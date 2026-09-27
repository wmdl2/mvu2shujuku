'use strict';

// MVU 命令的解析与内存应用；浏览器构建以内联工厂调用同一份实现。
function createMvuCommands(deps) {
    'use strict';
    const { getMvuYamlLibs } = deps || {};

    function parseMvuCmdValue(raw) {
        const t = String(raw == null ? '' : raw).trim();
        if (t === 'true') return true;
        if (t === 'false') return false;
        if (t === 'null') return null;
        if (t === 'undefined') return undefined;
        try { return JSON.parse(t); } catch (e) {}
        if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
        return t.replace(/^['"]|['"]$/g, '');
    }
    function splitMvuCmdArgs(argsStr) {
        const out = [];
        let cur = '', depth = 0, inStr = null;
        for (let i = 0; i < argsStr.length; i++) {
            const ch = argsStr[i];
            if (inStr) { cur += ch; if (ch === '\\') { cur += argsStr[i + 1] || ''; i++; continue; } if (ch === inStr) inStr = null; continue; }
            if (ch === "'" || ch === '"') { inStr = ch; cur += ch; continue; }
            if (ch === '(' || ch === '[' || ch === '{') depth++;
            if (ch === ')' || ch === ']' || ch === '}') depth--;
            if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
            cur += ch;
        }
        if (cur.trim()) out.push(cur.trim());
        return out;
    }
    // 与卡内桥同一套通用命令规则：解析 <UpdateVariable>/<json_patch> 中的 _.set/_.add/_.remove 等指令
    function parseMvuCommands(text) {
        const cmds = [];
        const blockRe = /<(updatevariable|json_?patch)>[\s\S]*?(?:\/\1>)/gi;
        let m;
        while ((m = blockRe.exec(String(text || '')))) {
            let inner = m[0].replace(/<[^>]+>/g, '').replace(/\x60\x60\x60[^\x60]*\x60\x60\x60/g, '').trim();
            let isJsonBlock = m[1].toLowerCase().indexOf('json') === 0;
            // 标准写法 <UpdateVariable><Analysis>…</Analysis><JSONPatch>…</JSONPatch></UpdateVariable>：
            // 外层是 updatevariable 时，若内部含 json_patch 子块，则整块按 JSONPatch 解析
            const sub = m[0].match(/<(json_?patch)>[\s\S]*?(?:\/\1>)/i);
            if (sub) { inner = sub[0].replace(/<[^>]+>/g, '').trim(); isJsonBlock = true; }
            if (isJsonBlock) {
                try {
                    let patch = null;
                    try { patch = JSON.parse(inner); } catch (e) {
                        try {
                            const libs = getMvuYamlLibs();
                            patch = JSON.parse((libs && typeof libs.jsonrepair === 'function') ? libs.jsonrepair(inner) : inner);
                        } catch (e2) { patch = null; }
                    }
                    if (Array.isArray(patch)) {
                        for (const op of patch) {
                            if (!op || (!op.path && !op.to)) continue;
                            const jt = op.op === 'delta' ? 'add' : (op.op === 'remove' ? 'delete' : ((op.op === 'insert' || op.op === 'add') ? 'insert' : op.op || 'set'));
                            const jp = String(op.path || op.to || '').replace(/^\//, '').replace(/\//g, '.');
                            const jpParts = jp.split('.');
                            const jpKey = jpParts.pop();
                            const jpParent = jpParts.join('.');
                            const rawArgs = jt === 'move' ? [String(op.from || '').replace(/^\//, '').replace(/\//g, '.'), jp]
                                : jt === 'delete' ? [jp]
                                : jt === 'insert' || op.op === 'add' ? [jpParent, jpKey, JSON.stringify(op.value)]
                                : [jp, JSON.stringify(op.value)];
                            cmds.push({ type: jt, path: (jt === 'insert' || op.op === 'add') ? jpParent : jp, keyOrIndex: (jt === 'insert' || op.op === 'add') ? parseMvuCmdValue(jpKey) : undefined, value: op.value, from: op.from, rawArgs, full_match: JSON.stringify(op), reason: 'json_patch' });
                        }
                    }
                } catch (e) {}
                continue;
            }
            const cmdRe = /\.(set|assign|insert|remove|unset|delete|add)\(/g;
            let cm;
            while ((cm = cmdRe.exec(inner))) {
                const open = inner.indexOf('(', cm.index + cm[0].length - 1);
                if (open === -1) continue;
                let depth = 1, end = -1, inS = null;
                for (let k = open + 1; k < inner.length; k++) {
                    const c = inner[k];
                    if (inS) { if (c === '\\') { k++; continue; } if (c === inS) inS = null; continue; }
                    if (c === "'" || c === '"') { inS = c; continue; }
                    if (c === '(') depth++;
                    else if (c === ')') { depth--; if (depth === 0) { end = k; break; } }
                }
                if (end === -1) break;
                const args = splitMvuCmdArgs(inner.slice(open + 1, end));
                const after = inner.slice(end + 1).replace(/^\s*;\s*/, '');
                let reason = '';
                const rm = after.match(/^\/\/\s*([^\n]*)/);
                if (rm) reason = rm[1].trim();
                const type = cm[1];
                const path = String(args[0] || '').replace(/^['"]|['"]$/g, '').replace(/^\//, '').replace(/\//g, '.');
                const full_match = inner.slice(cm.index, end + 1);
                if (type === 'remove' || type === 'unset' || type === 'delete') cmds.push({ type: 'delete', path, keyOrIndex: args[1] !== undefined ? parseMvuCmdValue(args[1]) : undefined, rawArgs: args, full_match, reason });
                else if (type === 'insert' || type === 'assign') cmds.push({ type: 'insert', path, keyOrIndex: args[2] !== undefined ? parseMvuCmdValue(args[1]) : null, value: args[2] !== undefined ? parseMvuCmdValue(args[2]) : parseMvuCmdValue(args[1]), rawArgs: args, full_match, reason });
                else if (type === 'add') cmds.push({ type: 'add', path, value: args[1] !== undefined ? parseMvuCmdValue(args[1]) : undefined, rawArgs: args, full_match, reason });
                else cmds.push({ type: 'set', path, expected: args[2] !== undefined ? parseMvuCmdValue(args[1]) : undefined, value: args[2] !== undefined ? parseMvuCmdValue(args[2]) : (args[1] !== undefined ? parseMvuCmdValue(args[1]) : undefined), rawArgs: args, full_match, reason });
                cmdRe.lastIndex = end + 1;
            }
        }
        if (!cmds.length && /\.(set|assign|insert|remove|unset|delete|add)\(/.test(String(text || '')) && !/<(updatevariable|json_?patch)>/i.test(String(text || ''))) {
            return parseMvuCommands('<UpdateVariable>' + String(text || '') + '</UpdateVariable>');
        }
        return cmds;
    }
    function mvuCommandInfoFromInternal(cmd) {
        let type = cmd.type;
        if (type === 'assign') type = 'insert';
        if (type === 'remove' || type === 'unset') type = 'delete';
        let args = Array.isArray(cmd.rawArgs) ? cmd.rawArgs.slice() : null;
        if (!args) {
            if (type === 'move') args = [String(cmd.from || ''), String(cmd.path || '')];
            else if (type === 'delete') args = cmd.keyOrIndex === undefined ? [String(cmd.path || '')] : [String(cmd.path || ''), cmd.keyOrIndex];
            else if (type === 'insert') args = cmd.keyOrIndex === null || cmd.keyOrIndex === undefined ? [String(cmd.path || ''), cmd.value] : [String(cmd.path || ''), cmd.keyOrIndex, cmd.value];
            else if (type === 'set' && cmd.expected !== undefined) args = [String(cmd.path || ''), cmd.expected, cmd.value];
            else args = [String(cmd.path || ''), cmd.value];
        }
        return { type, full_match: cmd.full_match || '', args, reason: cmd.reason || '' };
    }
    function mvuInternalFromCommandInfo(info) {
        if (!info || !Array.isArray(info.args) || !info.args.length) return null;
        let type = String(info.type || 'set').toLowerCase();
        if (type === 'assign') type = 'insert';
        if (type === 'remove' || type === 'unset') type = 'delete';
        const args = info.args;
        const cleanPath = (v) => String(v == null ? '' : v).replace(/^['"]|['"]$/g, '').replace(/^\//, '').replace(/\//g, '.');
        if (type === 'move') return { type, from: cleanPath(args[0]), path: cleanPath(args[1]), full_match: info.full_match || '', reason: info.reason || '' };
        const path = cleanPath(args[0]);
        if (type === 'delete') return { type, path, keyOrIndex: args.length > 1 ? parseMvuCmdValue(args[1]) : undefined, full_match: info.full_match || '', reason: info.reason || '' };
        if (type === 'insert') return { type, path, keyOrIndex: args.length > 2 ? parseMvuCmdValue(args[1]) : null, value: parseMvuCmdValue(args[args.length - 1]), full_match: info.full_match || '', reason: info.reason || '' };
        if (type === 'add') return { type, path, value: parseMvuCmdValue(args[1]), full_match: info.full_match || '', reason: info.reason || '' };
        return { type: 'set', path, expected: args.length > 2 ? parseMvuCmdValue(args[1]) : undefined, value: parseMvuCmdValue(args[args.length - 1]), full_match: info.full_match || '', reason: info.reason || '' };
    }
    function applyMvuCommands(stat, cmds, display) {
        const setPathArr = (obj, parts, value) => {
            let cur = obj;
            for (let i = 0; i < parts.length - 1; i++) {
                if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object' || Array.isArray(cur[parts[i]])) cur[parts[i]] = {};
                cur = cur[parts[i]];
            }
            cur[parts[parts.length - 1]] = value;
        };
        const note = (path, oldV, newV, reason) => {
            const r = reason ? ' (' + reason + ')' : '';
            const parts = String(path).split('.').filter(Boolean);
            const value = String(oldV) + '->' + String(newV) + r;
            if (display) setPathArr(display, parts, value);
            const delta = stat.$internal && stat.$internal.delta_data;
            if (delta) setPathArr(delta, parts, value);
        };
        for (const cmd of cmds) {
            if (!cmd.path) continue;
            const parts = String(cmd.path).split('.').filter((p) => p !== '');
            if (parts.some((p) => p.charAt(0) === '_')) continue;
            if (cmd.type === 'move') {
                const mf = String(cmd.from || '').replace(/^\//, '').replace(/\//g, '.').split('.').filter((p) => p !== '');
                if (mf.some((p) => p.charAt(0) === '_')) continue;
                let mv;
                let mc = stat, mok = true;
                for (let i = 0; i < mf.length - 1; i++) { mc = mc ? mc[mf[i]] : null; if (!mc) { mok = false; break; } }
                if (mok && mc) {
                    const mkey = mf[mf.length - 1];
                    if (Array.isArray(mc) && /^\d+$/.test(String(mkey))) { mv = mc[Number(mkey)]; mc.splice(Number(mkey), 1); }
                    else { mv = mc[mkey]; try { delete mc[mkey]; } catch (e) {} }
                }
                if (mv !== undefined) {
                    setPathArr(stat, parts, mv);
                    note(cmd.path, '(移动)', mv, cmd.reason);
                }
                continue;
            }
            if (cmd.type === 'delete') {
                let oldDel = null;
                if (cmd.keyOrIndex !== undefined) {
                    let collection = stat;
                    for (const p of parts) collection = collection == null ? undefined : collection[p];
                    oldDel = collection;
                    if (Array.isArray(collection)) {
                        const ri = typeof cmd.keyOrIndex === 'number' ? cmd.keyOrIndex : collection.findIndex(v => JSON.stringify(v) === JSON.stringify(cmd.keyOrIndex));
                        if (ri >= 0 && ri < collection.length) collection.splice(ri, 1);
                    } else if (collection && typeof collection === 'object') {
                        const dk = typeof cmd.keyOrIndex === 'number' ? Object.keys(collection)[cmd.keyOrIndex] : String(cmd.keyOrIndex);
                        if (dk !== undefined) delete collection[dk];
                    }
                } else {
                    let cur = stat, ok = true;
                    for (let d = 0; d < parts.length - 1; d++) { cur = cur ? cur[parts[d]] : null; if (!cur) { ok = false; break; } }
                    if (ok && cur) {
                        const dk = parts[parts.length - 1];
                        oldDel = cur[dk];
                        if (Array.isArray(cur) && /^\d+$/.test(String(dk))) cur.splice(Number(dk), 1); else try { delete cur[dk]; } catch (e) {}
                    }
                }
                if (Array.isArray(oldDel) && oldDel.length === 2) oldDel = oldDel[0];
                note(cmd.path, oldDel, '(移除)', cmd.reason);
                continue;
            }
            if (cmd.type === 'insert') {
                let container = stat;
                for (const p of parts) container = container == null ? undefined : container[p];
                if (container == null || (typeof container !== 'object' && !Array.isArray(container))) continue;
                const key = cmd.keyOrIndex;
                if (key === null || key === undefined) {
                    if (Array.isArray(container)) container.push(cmd.value);
                    else if (cmd.value && typeof cmd.value === 'object' && !Array.isArray(cmd.value)) Object.assign(container, cmd.value);
                } else if (Array.isArray(container) && (key === '-' || /^-?\d+$/.test(String(key)))) {
                    const idx = key === '-' || Number(key) === -1 ? container.length : Number(key);
                    container.splice(idx, 0, cmd.value);
                } else if (container && typeof container === 'object') container[String(key)] = cmd.value;
                note(cmd.path, '(新增)', cmd.value, cmd.reason);
                continue;
            }
            if (cmd.type === 'assign' && cmd.keyOrIndex !== undefined) {
                let acont = stat, aok = true;
                for (let d5 = 0; d5 < parts.length - 1; d5++) { acont = acont ? acont[parts[d5]] : null; if (!acont) { aok = false; break; } }
                if (aok && acont && typeof acont === 'object') {
                    const akey = cmd.keyOrIndex;
                    if (akey === '-' && Array.isArray(acont)) acont.push(cmd.value);
                    else if (Array.isArray(acont) && /^\d+$/.test(String(akey))) acont.splice(Number(akey), 0, cmd.value);
                    else if (acont && typeof acont === 'object') acont[akey] = cmd.value;
                    note(cmd.path, '(变更)', cmd.value, cmd.reason);
                }
                continue;
            }
            if (cmd.type === 'assign' && cmd.value && typeof cmd.value === 'object' && !Array.isArray(cmd.value)) {
                let tgt = stat, ok3 = true;
                for (let d3 = 0; d3 < parts.length - 1; d3++) { tgt = tgt ? tgt[parts[d3]] : null; if (!tgt) { ok3 = false; break; } }
                if (ok3 && tgt && typeof tgt === 'object') { Object.keys(cmd.value).forEach((kk) => { tgt[kk] = cmd.value[kk]; }); note(cmd.path, '(变更)', cmd.value, cmd.reason); }
                continue;
            }
            if (cmd.type === 'add') {
                // delta：数值相加 / 日期加毫秒 / 数组追加 / 否则整体替换（与 MVU 语义一致）
                const oldV = (() => { let c = stat; for (const p of parts) { c = c ? c[p] : undefined; } return c; })();
                const base = Array.isArray(oldV) && oldV.length ? oldV[0] : oldV;
                const delta = parseFloat(cmd.value);
                let dateVal = null;
                if (typeof base === 'string') { const dtest = new Date(base); if (!isNaN(dtest.getTime()) && isNaN(Number(base))) dateVal = dtest; }
                if (dateVal && !isNaN(delta)) {
                    const nd = new Date(dateVal.getTime() + delta);
                    setPathArr(stat, parts, nd.toISOString());
                    note(cmd.path, base, nd.toISOString(), cmd.reason);
                } else {
                    const num = parseFloat(base);
                    if (!isNaN(num) && !isNaN(delta)) {
                        const nv2 = parseFloat((num + delta).toPrecision(12));
                        setPathArr(stat, parts, nv2);
                        note(cmd.path, base, nv2, cmd.reason);
                    } else if (Array.isArray(oldV)) {
                        const arr = oldV.slice();
                        if (Array.isArray(cmd.value)) cmd.value.forEach((vv) => arr.push(vv)); else arr.push(cmd.value);
                        setPathArr(stat, parts, arr);
                        note(cmd.path, '(数组追加)', cmd.value, cmd.reason);
                    } else {
                        setPathArr(stat, parts, cmd.value);
                        note(cmd.path, base, cmd.value, cmd.reason);
                    }
                }
                continue;
            }
            // 官方 set 语义：路径必须已存在（缺失则跳过，不自动创建）；VWD 成对数组更新 [0]；数字强转
            let cur = stat, okSet = true;
            for (let i = 0; i < parts.length - 1; i++) {
                cur = cur ? cur[parts[i]] : undefined;
                if (cur === undefined || cur === null || typeof cur !== 'object' || Array.isArray(cur)) { okSet = false; break; }
            }
            if (!okSet || cur === undefined || cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, parts[parts.length - 1])) continue;
            const oldV = cur[parts[parts.length - 1]];
            let newV = cmd.value;
            if (newV instanceof Date) newV = newV.toISOString();
            if (Array.isArray(oldV) && oldV.length === 2 && typeof oldV[1] === 'string' && !Array.isArray(oldV[0])) {
                const oc = JSON.parse(JSON.stringify(oldV[0]));
                oldV[0] = (typeof oc === 'number' && newV !== null) ? Number(newV) : newV;
                note(cmd.path, oc, newV, cmd.reason);
            } else {
                if (typeof oldV === 'number' && newV !== null && !isNaN(Number(newV))) newV = Number(newV);
                cur[parts[parts.length - 1]] = newV;
                note(cmd.path, oldV, newV, cmd.reason);
            }
        }
    }

    return { parseMvuCommands, mvuCommandInfoFromInternal,
        mvuInternalFromCommandInfo, applyMvuCommands };
}

module.exports = createMvuCommands;
