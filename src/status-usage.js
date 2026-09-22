'use strict';

// 前端字段扫描仅补充可识别的静态读取；不执行卡内代码。
function createStatusUsage({ maskJsStringsAndComments, splitJsTopLevelArgs, isSchemaFieldName, cardTextBlobs }) {
    function sourceTexts(text) {
        const source = String(text || '').replace(/^```(?:html|javascript|js)?[ \t]*\r?$/gm, '');
        if (!/^\s*<(?:!doctype|html|head|body|div|style|script)\b/i.test(source)) return [source];
        // HTML/Markdown 不是 JS；先提取可执行片段，避免把围栏当模板字符串吞掉整个前端。
        const scripts = [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
            .filter(m => !/\btype\s*=/.test(m[1]) || /\btype\s*=\s*["']?(?:module|(?:text|application)\/javascript)\b/i.test(m[1]))
            .map(m => m[2]);
        const ejs = [...source.matchAll(/<%[-=]?([\s\S]*?)%>/g)].map(m => m[1]);
        return [...scripts, ...(ejs.length ? [ejs.join('\n')] : [])];
    }

    function createBindings(text) {
        const code = maskJsStringsAndComments(text);
        const root = { start: 0, end: code.length + 1, parent: null, names: new Map() };
        const scopes = [root], stack = [root], parens = [], pairs = new Map();
        const previous = index => { while (index >= 0 && /\s/.test(code[index])) index--; return index; };
        const wordEndingAt = end => {
            let start = end;
            while (start >= 0 && /[\w$]/.test(code[start])) start--;
            return code.slice(start + 1, end + 1);
        };
        for (let i = 0; i < code.length; i++) {
            if (code[i] === '(') parens.push(i);
            if (code[i] === ')' && parens.length) pairs.set(i, parens.pop());
            if (code[i] === '{') {
                const scope = { start: i, end: code.length + 1, parent: stack[stack.length - 1], names: new Map() };
                let end = previous(i - 1), arrow = false;
                if (code.slice(end - 1, end + 1) === '=>') { arrow = true; end = previous(end - 2); }
                let params = '';
                if (code[end] === ')' && pairs.has(end)) {
                    const open = pairs.get(end);
                    const word = wordEndingAt(previous(open - 1));
                    if (arrow || !['if', 'for', 'while', 'switch', 'with'].includes(word)) params = code.slice(open + 1, end);
                } else if (arrow) params = wordEndingAt(end);
                // 参数是当前函数的新绑定；解构或默认参数中的不确定名字也不继承外层别名。
                for (const param of splitJsTopLevelArgs(params)) {
                    const declaration = param.split('=')[0];
                    for (const name of declaration.match(/[A-Za-z_$][\w$]*/g) || []) scope.names.set(name, [{ at: i, value: null }]);
                }
                scopes.push(scope); stack.push(scope);
            } else if (code[i] === '}' && stack.length > 1) stack.pop().end = i + 1;
        }
        // 表达式体箭头函数也有参数作用域，例如 rows.map(item => item.字段)。
        for (const match of code.matchAll(/=>/g)) {
            let start = match.index + 2;
            while (/\s/.test(code[start] || '') && start < code.length) start++;
            if (code[start] === '{') continue;
            const last = previous(match.index - 1);
            const params = code[last] === ')' && pairs.has(last) ? code.slice(pairs.get(last) + 1, last) : wordEndingAt(last);
            let end = start, depth = 0;
            for (; end < code.length; end++) {
                const ch = code[end];
                if ('([{'.includes(ch)) depth++;
                else if (')]}'.includes(ch)) { if (!depth) break; depth--; }
                else if (!depth && /[,;\n]/.test(ch)) break;
            }
            const scope = { start, end, parent: null, names: new Map() };
            for (const param of splitJsTopLevelArgs(params)) {
                for (const name of param.split('=')[0].match(/[A-Za-z_$][\w$]*/g) || []) scope.names.set(name, [{ at: start, value: null }]);
            }
            scopes.push(scope);
        }
        scopes.sort((a, b) => a.start - b.start || b.end - a.end);
        const ancestors = [];
        for (const scope of scopes) {
            while (ancestors.length && scope.start >= ancestors[ancestors.length - 1].end) ancestors.pop();
            scope.parent = ancestors[ancestors.length - 1] || null;
            ancestors.push(scope);
        }
        const scopeAt = at => {
            let lo = 0, hi = scopes.length;
            while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (scopes[mid].start <= at) lo = mid; else hi = mid; }
            let scope = scopes[lo];
            while (scope.parent && at >= scope.end) scope = scope.parent;
            return scope;
        };
        const bind = (name, value, at) => {
            const scope = scopeAt(at), list = scope.names.get(name) || [];
            const existing = list.find(entry => entry.at === at);
            if (existing) {
                if (JSON.stringify(existing.value) === JSON.stringify(value)) return false;
                existing.value = value;
            }
            else list.push({ at, value });
            scope.names.set(name, list);
            return true;
        };
        // 未识别的局部声明/重新赋值也遮蔽旧别名，不把碰巧同名的变量当成数据对象。
        const declarations = /\b(?:const|let|var)\s+/g;
        let declaration;
        while ((declaration = declarations.exec(code))) {
            let end = declarations.lastIndex, depth = 0;
            for (; end < code.length; end++) {
                const ch = code[end];
                if ('([{'.includes(ch)) depth++;
                else if (')]}'.includes(ch)) { if (!depth) break; depth--; }
                else if (!depth && /[;\n]/.test(ch)) break;
            }
            for (const part of splitJsTopLevelArgs(code.slice(declarations.lastIndex, end))) {
                for (const name of part.split('=')[0].match(/[A-Za-z_$][\w$]*/g) || []) bind(name, null, declaration.index);
            }
        }
        const assignments = /(?:^|[;{}\n])\s*([A-Za-z_$][\w$]*)\s*=(?!=|>)/g;
        while ((declaration = assignments.exec(code))) bind(declaration[1], null, declaration.index + declaration[0].lastIndexOf(declaration[1]));
        const get = (name, at) => {
            for (let scope = scopeAt(at); scope; scope = scope.parent) {
                const entries = scope.names.get(name);
                if (!entries) continue;
                let found = null;
                for (const entry of entries) if (entry.at <= at && (!found || entry.at >= found.at)) found = entry;
                return found && found.value;
            }
            return null;
        };
        return { code, bind, get, scopeAt, isCode: at => !!code.slice(at, at + 1).trim() };
    }

    function scanStatusUsage(card, groupNames) {
            const usage = {};
            const usageTypes = {};
            Object.defineProperty(usage, '__types', { value: usageTypes, enumerable: false });
            const addField = (group, field, kind) => {
                if (!field || !isSchemaFieldName(field)) return;
                if (!usage[group]) usage[group] = [];
                if (!usage[group].includes(field)) usage[group].push(field);
                if (kind) {
                    usageTypes[group] = usageTypes[group] || {};
                    usageTypes[group][field] = kind;
                }
            };

            // 已知组名来自 initvar 顶层键（扫描只针对这些组做归属）
            const knownGroups = new Set(Array.isArray(groupNames) ? groupNames : []);

            const blobs = cardTextBlobs(card).flatMap(blob => sourceTexts(blob.text).map(text => ({ text, bindings: createBindings(text) })));

            // 阶段1：直接 stat 映射（只跑一轮即可稳定）
            for (const { text, bindings } of blobs) {
                // EJS 条件里的 getvar('stat_data.组.条目.字段') / getvar('stat_data.组.字段')
                const reGetvar = /getvar\s*\(\s*['"]stat_data\.([\u4e00-\u9fff]+)(?:\.([\u4e00-\u9fff]+)(?:\.([\u4e00-\u9fff]+))?)?['"]/g;
                let gm;
                while ((gm = reGetvar.exec(text))) {
                    if (!bindings.isCode(gm.index)) continue;
                    const group = gm[1];
                    if (!knownGroups.has(group)) continue;
                    // 三段式 组.条目.字段 → 条目行表的列；两段式 组.字段 → 单例列（若 initvar 已含则跳过重复）
                    const field = gm[3] || gm[2];
                    if (field) addField(group, field);
                }
                // const X = ...stat_data.组[键].字段...  → 嵌套对象；只到组 → 组变量
                const re1 = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:all_variables|getAllVariables\(\))?[^;\n]*?\bstat_data\s*\.\s*([\u4e00-\u9fff]+)((?:\[[^\]]*\])*)((?:\s*\.\s*[\u4e00-\u9fff]+)*)/g;
                let m;
                while ((m = re1.exec(text))) {
                    if (!bindings.isCode(m.index)) continue;
                    const v = m[1], g = m[2];
                    if (!knownGroups.has(g)) continue;
                    const tail = (m[4] || '').trim();
                    bindings.bind(v, { group: g, nested: tail !== '' }, m.index);
                }
                // const X = stat.组 / const X = (stat.组 || {})[键] / const X = stat.组[键]
                const re1b = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\(?\s*stat\s*\.\s*([\u4e00-\u9fff]+)\s*\)?|stat\s*\.\s*([\u4e00-\u9fff]+))\s*(?:\|\|\s*\{\}\s*)?(\[[^\]]*\])?((?:\s*\.\s*[\u4e00-\u9fff]+)*)/g;
                while ((m = re1b.exec(text))) {
                    if (!bindings.isCode(m.index)) continue;
                    const g = m[2] || m[3];
                    if (!knownGroups.has(g)) continue;
                    const tail = (m[5] || '').trim();
                    bindings.bind(m[1], { group: g, nested: tail !== '' }, m.index);
                }
                // const X = <已映射>.子表名
                const re1c = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\.\s*([\u4e00-\u9fff]+)/g;
                while ((m = re1c.exec(text))) {
                    if (!bindings.isCode(m.index)) continue;
                    const parentGroup = bindings.get(m[2], m.index);
                    if (parentGroup && !parentGroup.nested) bindings.bind(m[1], { group: m[3] }, m.index);
                }
                // const X = Object.entries(Y)（如 sortedBeauties）
                const re1d = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*Object\s*\.\s*entries\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
                while ((m = re1d.exec(text))) {
                    if (!bindings.isCode(m.index)) continue;
                    const source = bindings.get(m[2], m.index);
                    if (source && !source.nested && knownGroups.has(source.group)) bindings.bind(m[1], { group: source.group, entries: true }, m.index);
                }
            }

            // helper、条目回调与普通属性读取共用同一作用域/绑定表。
            // 只在真实代码位置登记，不按 render 方法的字符串切片或变量名 data 猜归属。
            for (const { text, bindings } of blobs) {
                const rootRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:get|list)\s*\(\s*d\s*,\s*['"]([^'"]+)['"]/g;
                let m;
                while ((m = rootRe.exec(text))) {
                    if (!bindings.isCode(m.index)) continue;
                    const group = m[2].split('.').filter(Boolean).pop();
                    if (knownGroups.has(group)) bindings.bind(m[1], { group, helper: true, level: 0 }, m.index);
                }
                // 处理参数体开头，既覆盖 { ... }，也覆盖 item => val(item, '字段')。
                const callbackBody = at => {
                    while (at < bindings.code.length && /\s/.test(bindings.code[at])) at++;
                    return at;
                };
                const bindCallback = (name, value, at) => {
                    const scope = bindings.scopeAt(at);
                    // 仅允许绑定解析器已经确认的参数；不能向外层或任意 {} 写名字。
                    const entries = scope.names.get(name);
                    if (!entries || !entries.some(entry => entry.at === scope.start)) return false;
                    return bindings.bind(name, value, scope.start);
                };
                // 别名可能依赖 callback 参数，callback 又可能依赖 entries 别名。
                // 每轮仅更新有来源证据的绑定，达到稳定后停止。
                for (let round = 0; round < 6; round++) {
                    let changed = false;
                    const aliasRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$]*\s*\?\s*)?([A-Za-z_$][\w$]*)(\s*\[[^\]\n]+\]|\s*\.\s*[\u4e00-\u9fff]+|\s*\.\s*(?:slice|filter)\s*\(|(?=\s*[;,\n]))/g;
                    while ((m = aliasRe.exec(text))) {
                        if (!bindings.isCode(m.index)) continue;
                        const source = bindings.get(m[2], m.index);
                        if (!source) continue;
                        const tail = m[3].trim();
                        const indexed = tail.startsWith('[');
                        const member = tail.match(/^\.\s*([\u4e00-\u9fff]+)/);
                        const level = (source.level || 0) + (indexed || member ? 1 : 0);
                        // helper 的第二层索引是字段内部对象，不能提升成表格列。
                        const nested = !!source.nested || !!member || (source.helper && level > 1);
                        // 旧前端也会从主角对象访问附属组（如 p.功法）。保留这条
                        // 有直接属性读取支撑的映射；条目内部/辅助函数第二层不能借同名提升。
                        const next = member && !source.helper && !source.level && !source.nested
                            ? { group: member[1], nested: false } : { ...source, level, nested };
                        changed = bindings.bind(m[1], next, m.index) || changed;
                    }
                    const entriesRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*Object\.entries\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
                    while ((m = entriesRe.exec(text))) {
                        if (!bindings.isCode(m.index)) continue;
                        const source = bindings.get(m[2], m.index);
                        if (source && !source.nested) changed = bindings.bind(m[1], { ...source, entries: true }, m.index) || changed;
                    }
                    const entriesCallback = /(?:Object\.entries\(\s*([A-Za-z_$][\w$]*)\s*\)|([A-Za-z_$][\w$]*))(?:(?:\s*\.\s*(?:sort|slice|filter))\s*\((?:[^()]|\([^()]*\))*\))*\s*\.\s*(?:forEach|map)\s*\(\s*\(\s*\[[^,\]]+,\s*([A-Za-z_$][\w$]*)\s*\]\s*\)\s*=>/g;
                    while ((m = entriesCallback.exec(text))) {
                        if (!bindings.isCode(m.index)) continue;
                        const source = bindings.get(m[1] || m[2], m.index);
                        if (!source || source.nested || (!m[1] && !source.entries)) continue;
                        changed = bindCallback(m[3], { ...source, entries: false, level: (source.level || 0) + 1 }, callbackBody(entriesCallback.lastIndex)) || changed;
                    }
                    const helperCallback = /([A-Za-z_$][\w$]*)\s*\.\s*(?:forEach|map|filter|find|some|every)\s*\(\s*(?:function\s*\(\s*([A-Za-z_$][\w$]*)\s*\)|\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>|([A-Za-z_$][\w$]*)\s*=>)/g;
                    while ((m = helperCallback.exec(text))) {
                        if (!bindings.isCode(m.index)) continue;
                        const source = bindings.get(m[1], m.index);
                        if (!source || !source.helper || source.entries || source.nested) continue;
                        const level = (source.level || 0) + 1;
                        changed = bindCallback(m[2] || m[3] || m[4], { ...source, level, nested: level > 1 }, callbackBody(helperCallback.lastIndex)) || changed;
                    }
                    if (!changed) break;
                }
                const valRe = /\bval\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*['"]([^'"]+)['"]/g;
                while ((m = valRe.exec(text))) {
                    if (!bindings.isCode(m.index)) continue;
                    const source = bindings.get(m[1], m.index);
                    if (!source || source.nested || !knownGroups.has(source.group)) continue;
                    const before = bindings.code.slice(Math.max(0, m.index - 24), m.index);
                    const after = text.slice(valRe.lastIndex, valRe.lastIndex + 32);
                    const numeric = /parseInt\s*\(\s*$|Number\s*\(\s*$/.test(before) || /^\s*,\s*-?\d+(?:\.\d+)?\s*\)/.test(after);
                    addField(source.group, m[2], numeric ? 'number' : '');
                }
            }

            // 阶段3：成员访问收集（跳过嵌套对象变量）
            for (const { text, bindings } of blobs) {
                const re2 = /([A-Za-z_$][\w$]*)\.([\u4e00-\u9fff]{1,12})/g;
                let m;
                while ((m = re2.exec(bindings.code))) {
                    const v = m[1], field = m[2];
                    const source = bindings.get(v, m.index);
                    if (source && !source.nested) addField(source.group, field);
                }
            }

            // 阶段4：直接赋值给组/组变量的对象字面量键
            // 形如：stat.组[键] = { 字段: ... }
            for (const { text, bindings } of blobs) {
                const assignRe = /stat_data\s*\.\s*([\u4e00-\u9fff]+)(?:\s*\[[^\]]*\])*(?:\s*\.\s*[\u4e00-\u9fff]+)?\s*=\s*\{([^{}]*)\}/g;
                let m;
                while ((m = assignRe.exec(text))) {
                    if (!bindings.isCode(m.index)) continue;
                    const g = m[1];
                    if (!knownGroups.has(g)) continue;
                    const literal = m[2];
                    const keyRe = /["']?([\u4e00-\u9fff]{1,12})["']?\s*:/g;
                    let km;
                    while ((km = keyRe.exec(literal))) {
                        if (!knownGroups.has(km[1])) addField(g, km[1]);
                    }
                }
            }

            // 清理：去掉明显不是字段的词
            const stop = new Set(['length', 'forEach', 'map', 'filter', 'reduce', 'keys', 'values', 'entries', 'push', 'indexOf', 'includes', 'slice', 'join', 'split', 'trim', 'replace', 'toLowerCase', 'toUpperCase', 'some', 'every', 'find', 'string', 'number', 'boolean']);
            for (const g of Object.keys(usage)) {
                usage[g] = usage[g].filter(f => !stop.has(f) && !usage[g].includes(f) ? true : !stop.has(f));
                usage[g] = [...new Set(usage[g])];
            }
            return usage;
        }


    return scanStatusUsage;
}

module.exports = createStatusUsage;
