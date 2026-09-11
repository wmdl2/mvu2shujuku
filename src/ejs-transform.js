'use strict';

function createEjsTransform() {
    /* ================================================================
     * EJS 数据源重写（rewriteEjsConditions）
     *
     * 世界书条目里的 EJS 结构整体保留，只把 MVU 的数据读取位置改为扩展注册的函数：
     *   getvar('stat_data.组.字段')        → mvu2shujukuGetMessageVar('stat_data.组.字段')
     *   getvar("stat_data").组["字段"][0]  → mvu2shujukuGetAllVariables().stat_data.组["字段"][0]
     *   _.has(getvar("stat_data"), '路径') → _.has(mvu2shujukuGetAllVariables().stat_data, '路径')
     * 扩展启动时把 mvu2shujukuGetAllVariables 注册进 st-prompt-template 模板上下文
     * （EjsTemplate.defines），并用卡内布局 + 插件表格惰性重建 stat_data（window.getAllVariables），
     * 不依赖卡内桥是否运行。
     * ================================================================ */
    function findJsCallEnd(source, openIndex) {
        const code = maskJsStringsAndComments(source);
        let depth = 0;
        for (let i = openIndex; i < code.length; i++) {
            const ch = code[i];
            if (ch === '(') depth++;
            else if (ch === ')' && --depth === 0) return i;
        }
        return -1;
    }

    function splitJsTopLevelArgs(argsStr) {
        const source = String(argsStr || '');
        const code = maskJsStringsAndComments(source);
        const parts = [];
        let start = 0;
        let depth = 0;
        for (let i = 0; i < code.length; i++) {
            const ch = code[i];
            if (ch === '(' || ch === '[' || ch === '{') depth++;
            else if (ch === ')' || ch === ']' || ch === '}') depth--;
            if (ch === ',' && depth === 0) { parts.push(source.slice(start, i).trim()); start = i + 1; }
        }
        if (source.slice(start).trim()) parts.push(source.slice(start).trim());
        return parts;
    }

    // 改写函数调用但不执行 JS。balanced-call 扫描允许 fallback 中包含对象、数组或函数调用，
    // 比旧版只接受 getvar("stat_data") 的单条正则覆盖更完整。
    function rewriteStatDataCalls(source) {
        let out = String(source || '');
        let count = 0;
        let code = maskJsStringsAndComments(out);
        const isBareCall = (index, length) => {
            if (!code.slice(index, index + length).trim() || /[\w$]/.test(code[index - 1] || '')) return false;
            let previous = index - 1;
            while (previous >= 0 && /\s/.test(code[previous])) previous--;
            return code[previous] !== '.';
        };
        const getvarRe = /\bgetvar\s*\(/gi;
        let m;
        while ((m = getvarRe.exec(out))) {
            if (!isBareCall(m.index, 6)) continue;
            const open = out.indexOf('(', m.index);
            const end = findJsCallEnd(out, open);
            if (end < 0) break;
            const args = out.slice(open + 1, end);
            const first = args.match(/^\s*(["'])(stat_data(?:\.[^"']*)?)\1(?:\s*,[\s\S]*)?$/i);
            if (!first) { getvarRe.lastIndex = end + 1; continue; }
            const path = first[2];
            const suffix = path.slice('stat_data'.length).replace(/^\./, '');
            const topArgs = splitJsTopLevelArgs(args);
            // 完整字面路径必须保留 TavernHelper getvar 的安全取值语义：任意中间层
            // 缺失时返回 undefined/defaults，而不是生成 a.b.c 连续访问并在 b 缺失时抛错。
            // 只读取 stat_data 根对象的官方教程写法仍返回整个对象，供后续属性链/_.has 使用。
            const replacement = suffix
                ? `mvu2shujukuGetMessageVar(${topArgs[0]}${topArgs[1] ? ', ' + topArgs[1] : ''})`
                : 'mvu2shujukuGetAllVariables().stat_data';
            out = out.slice(0, m.index) + replacement + out.slice(end + 1);
            code = maskJsStringsAndComments(out);
            count++;
            getvarRe.lastIndex = m.index + replacement.length;
        }

        // 酒馆助手的 MessageVar 不属于 Mvu.* 公开 API，但部分 MVU 卡会用它
        // 直接读写 stat_data。只改写首参数明确为 stat_data 字面量的调用，
        // getLocalVar/setLocalVar 及其他 MessageVar 保持酒馆助手原语义。
        for (const spec of [
            { name: 'getMessageVar', replacement: 'mvu2shujukuGetMessageVar' },
            { name: 'setMessageVar', replacement: 'mvu2shujukuSetMessageVar' },
        ]) {
            const callRe = new RegExp('\\b' + spec.name + '\\s*\\(', 'gi');
            let cm;
            while ((cm = callRe.exec(out))) {
                if (!isBareCall(cm.index, spec.name.length)) continue;
                const open = out.indexOf('(', cm.index);
                const end = findJsCallEnd(out, open);
                if (end < 0) break;
                const args = out.slice(open + 1, end);
                if (!/^\s*(["'])stat_data(?:\.[^"']*)?\1(?:\s*,|\s*$)/i.test(args)) {
                    callRe.lastIndex = end + 1;
                    continue;
                }
                out = out.slice(0, cm.index) + spec.replacement + out.slice(open, end + 1) + out.slice(end + 1);
                code = maskJsStringsAndComments(out);
                count++;
                callRe.lastIndex = cm.index + spec.replacement.length + (end - open + 1);
            }
        }

        // 通用 setvar 只有在静态可证明写入“当前消息变量”、且没有条件写入/历史楼层/
        // 特殊返回值语义时才等价于数据库 setter。其余形式保持原文，交给人工核对。
        const setvarRe = /\bsetvar\s*\(/gi;
        let sm;
        while ((sm = setvarRe.exec(out))) {
            if (!isBareCall(sm.index, 6)) continue;
            const open = out.indexOf('(', sm.index);
            const end = findJsCallEnd(out, open);
            if (end < 0) break;
            const argsText = out.slice(open + 1, end);
            const args = splitJsTopLevelArgs(argsText);
            const pathMatch = args[0] && args[0].match(/^\s*(["'])(stat_data(?:\.[^"']*)?)\1\s*$/i);
            const options = args[2] && args[2].trim();
            // 目前只接受仅含 outscope:'message' 的对象；加入任何其它选项都可能改变
            // flags/results/楼层选择等行为，宁可保留也不声称等价。
            const messageScopeOnly = options && /^\{\s*(?:outscope|["']outscope["'])\s*:\s*(["'])message\1\s*,?\s*\}$/i.test(options);
            if (!pathMatch || args.length !== 3 || !messageScopeOnly) {
                setvarRe.lastIndex = end + 1;
                continue;
            }
            const replacement = 'mvu2shujukuSetMessageVar(' + args[0] + ', ' + args[1] + ')';
            out = out.slice(0, sm.index) + replacement + out.slice(end + 1);
            code = maskJsStringsAndComments(out);
            count++;
            setvarRe.lastIndex = sm.index + replacement.length;
        }

        // 这些入口在不同版本的 MVU/提示词模板教程中都出现过。只改写明确读取
        // `.stat_data` 的形式；不碰普通 getVariables()，以免改变非 MVU 变量语义。
        const directReaders = [
            /\bgetAllVariables\s*\(\s*\)\s*\.\s*stat_data\b/gi,
            /\bEjsTemplate\s*\.\s*allVariables\s*\(\s*\)\s*\.\s*stat_data\b/gi,
            /\ballVariables\s*\(\s*\)\s*\.\s*stat_data\b/gi,
            /\ball_variables\s*\.\s*stat_data\b/gi,
            /(^|[^\w$.])(?:window|globalThis)\s*\.\s*stat_data\b/gi,
            /(^|[^\w$.])variables\s*\.\s*stat_data\b/gi,
            /\bTavernHelper\s*\.\s*getVariables\s*\(\s*\)\s*\.\s*stat_data\b/gi,
            /\bgetVariables\s*\(\s*\)\s*\.\s*stat_data\b/gi,
        ];
        for (const re of directReaders) {
            out = out.replace(re, (match, ...args) => {
                const offset = args[args.length - 2];
                const prefix = typeof args[0] === 'string' ? args[0] : '';
                if (!code.slice(offset + prefix.length, offset + match.length).trim()) return match;
                count++;
                // window/globalThis.stat_data 与 variables.stat_data 的正则有 prefix
                // 捕获组；其余正则的第二个 replace 回调参数是数字
                // offset，绝不能拼到输出前面（会生成 123mvu...）。
                return prefix + 'mvu2shujukuGetAllVariables().stat_data';
            });
            code = maskJsStringsAndComments(out);
        }
        return { text: out, count };
    }

    function ejsScriptBlocks(text) {
        const blocks = [];
        const re = /<%([_#=-]?)([\s\S]*?)(?:[_-]?%>)/g;
        let m;
        while ((m = re.exec(String(text || '')))) {
            if (m[1] !== '#') blocks.push(m[2]);
        }
        return blocks;
    }

    // 保留源码偏移的词法视图。字符串/注释/正则字面量遮蔽，模板字符串中的
    // ${...} 仍是可执行表达式，必须递归扫描；不能把字符串示例当作真正调用。
    function maskJsStringsAndComments(source) {
        const s = String(source || '');
        const out = s.split('');
        const blank = (a, b) => { for (let n = a; n < b; n++) if (s[n] !== '\n' && s[n] !== '\r') out[n] = ' '; };
        let i = 0;
        const scan = (templateExpression = false) => {
            let braces = 0, expressionStart = true, lastWord = '';
            const parens = [];
            while (i < s.length) {
                const ch = s[i], next = s[i + 1], start = i;
                if (/\s/.test(ch)) { i++; continue; }
                if (ch === '/' && next === '/') {
                    i += 2; while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++;
                    blank(start, i); continue;
                }
                if (ch === '/' && next === '*') {
                    const end = s.indexOf('*/', i + 2); i = end < 0 ? s.length : end + 2;
                    blank(start, i); continue;
                }
                if (ch === '"' || ch === "'") {
                    i++;
                    while (i < s.length) { if (s[i] === '\\') i += 2; else if (s[i++] === ch) break; }
                    blank(start, Math.min(i, s.length)); expressionStart = false; continue;
                }
                if (ch === '`') {
                    blank(i, ++i);
                    while (i < s.length) {
                        if (s[i] === '\\') { blank(i, Math.min(i + 2, s.length)); i += 2; continue; }
                        if (s[i] === '`') { blank(i, i + 1); i++; break; }
                        if (s[i] === '$' && s[i + 1] === '{') {
                            // 保留一对括号阻止参数/语句扫描把插值里的逗号当作外层分隔符。
                            out[i] = ' '; out[i + 1] = '('; i += 2;
                            scan(true); continue;
                        }
                        blank(i, i + 1); i++;
                    }
                    expressionStart = false; continue;
                }
                if (ch === '/' && expressionStart) {
                    let j = i + 1, charClass = false, closed = false;
                    for (; j < s.length && s[j] !== '\n' && s[j] !== '\r'; j++) {
                        if (s[j] === '\\') { j++; continue; }
                        if (s[j] === '[') charClass = true;
                        else if (s[j] === ']') charClass = false;
                        else if (s[j] === '/' && !charClass) { j++; closed = true; break; }
                    }
                    if (closed) { while (/[a-z]/i.test(s[j] || '') && j < s.length) j++; blank(i, j); i = j; expressionStart = false; continue; }
                }
                if (/[\w$\u3400-\u9fff]/.test(ch)) {
                    i++; while (i < s.length && /[\w$\u3400-\u9fff]/.test(s[i])) i++;
                    lastWord = s.slice(start, i);
                    expressionStart = /^(?:return|throw|case|delete|void|typeof|instanceof|in|of|yield|await|else|do)$/.test(lastWord);
                    continue;
                }
                if (ch === '(') { parens.push(/^(?:if|while|for|with|switch|catch)$/.test(lastWord)); expressionStart = true; }
                else if (ch === ')') expressionStart = !!parens.pop();
                else if (ch === '{') { braces++; expressionStart = true; }
                else if (ch === '}') {
                    if (templateExpression && braces === 0) { out[i++] = ')'; return; }
                    braces--; expressionStart = true;
                } else expressionStart = !/[\].]/.test(ch) && !(ch === '+' && next === '+') && !(ch === '-' && next === '-');
                lastWord = ''; i++;
            }
        };
        scan();
        return out.join('');
    }

    function ejsLexicalDeclarationNames(text) {
        const names = new Set();
        for (const block of ejsScriptBlocks(text)) {
            const code = maskJsStringsAndComments(block);
            for (const m of code.matchAll(/\b(?:const|let|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
        }
        return names;
    }

    function ejsFallbackVarNames(text) {
        const names = new Set();
        for (const block of ejsScriptBlocks(text)) {
            // 只接受整个 scriptlet 就是该回退声明的形态，不解析任意业务 JS。
            const m = String(block).trim().match(/^if\s*\(\s*typeof\s+([A-Za-z_$][\w$]*)\s*={2,3}\s*(["'])undefined\2\s*\)\s*var\s+([A-Za-z_$][\w$]*)\s*=\s*[\s\S]+;\s*$/);
            if (m && m[1] === m[3]) names.add(m[1]);
        }
        return names;
    }

    function isolateCrossEntryEjsFallbacks(entries, report) {
        const list = Array.isArray(entries) ? entries : [];
        const active = list.map((entry, index) => ({ entry, index })).filter(({ entry }) => (
            entry && entry.enabled !== false && entry.disable !== true && String(entry.content || '').includes('<%')
        ));
        const lexicalOwners = new Map();
        for (const { entry, index } of active) {
            for (const name of ejsLexicalDeclarationNames(entry.content)) {
                if (!lexicalOwners.has(name)) lexicalOwners.set(name, new Set());
                lexicalOwners.get(name).add(index);
            }
        }
        for (const { entry, index } of active) {
            const conflicts = [...ejsFallbackVarNames(entry.content)].filter(name => {
                const owners = lexicalOwners.get(name);
                return owners && [...owners].some(owner => owner !== index);
            });
            if (!conflicts.length) continue;
            entry.content = `<%_ await (async () => { _%>\n${String(entry.content || '')}\n<%_ })(); _%>`;
            if (report) {
                report.auto(`条目「${String(entry.comment || entry.name || index)}」已放入独立 EJS 作用域，避免 typeof+var 回退变量与其他条目的 const/let 声明冲突：${conflicts.join('、')}。`);
            }
        }
        return list;
    }

    function unresolvedEjsDataReads(text) {
        const found = [];
        const blocks = String(text || '').match(/<%[\s\S]*?%>/g) || [];
        for (const block of blocks) {
            // 只报告仍直接访问 stat_data 的旧入口。一个 EJS 块中可能同时含已改写的
            // stat_data 读取与普通 getvar/动态 MessageVar；后者应继续走酒馆助手原语义，
            // 不能仅因同块出现 stat_data 字样就误报为“漏接管”。
            const suspicious =
                /\b(?:getvar|getMessageVar|setMessageVar)\s*\(\s*(["'])stat_data(?:\.[^"']*)?\1/i.test(block) ||
                /\b(?:getAllVariables|getVariables|allVariables)\s*\(\s*\)\s*\.\s*stat_data\b/i.test(block) ||
                /\ball_variables\s*\.\s*stat_data\b/i.test(block) ||
                /(^|[^\w$.])variables\s*\.\s*stat_data\b/i.test(block) ||
                /\bTavernHelper\s*\.\s*getVariables\s*\(\s*\)\s*\.\s*stat_data\b/i.test(block) ||
                /\bsetvar\s*\([\s\S]*?["']stat_data(?:\.|["'])/i.test(block) ||
                // 动态 getvar 无法静态确认；仅当同块明确把变量设为 stat_data 时报告。
                (/\bgetvar\s*\(\s*(?!["'])[^)]*\)/i.test(block) && /["']stat_data(?:\.|["'])/i.test(block));
            if (!suspicious) continue;
            const oneLine = block.replace(/\s+/g, ' ').trim();
            if (!found.includes(oneLine)) found.push(oneLine.slice(0, 240));
        }
        return found;
    }

    function parseStaticStatAccessor(expr) {
        let s = String(expr || '').trim();
        let m = s.match(/^getvar\s*\(\s*(["'])stat_data((?:\.[^"']*)?)\1\s*\)([\s\S]*)$/i);
        if (m) s = (m[2] ? m[2] : '') + (m[3] || '');
        else {
            m = s.match(/^getvar\s*\(\s*(["'])stat_data\1\s*(?:,[\s\S]*?)?\)([\s\S]*)$/i);
            if (!m) return null;
            s = m[2] || '';
        }
        const parts = [];
        const tokenRe = /\.\s*([A-Za-z_$\u4e00-\u9fff][\w$\u4e00-\u9fff]*)|\[\s*(["'])(.*?)\2\s*\]|\[\s*(\d+)\s*\]/g;
        let pos = 0;
        let tm;
        while ((tm = tokenRe.exec(s))) {
            if (s.slice(pos, tm.index).trim()) return null;
            if (tm[4] !== undefined) {
                // [值,说明] 叶子的 [0] 与数据库标量列等价；其它动态下标不安全。
                if (tm[4] !== '0') return null;
            } else parts.push(tm[1] !== undefined ? tm[1] : tm[3]);
            pos = tokenRe.lastIndex;
        }
        return !s.slice(pos).trim() && parts.length ? parts : null;
    }

    function dbConditionForStaticPath(parts, operator, literal, layout) {
        const entries = layout && Array.isArray(layout.entries) ? layout.entries : [];
        const esc = v => String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        let rhs = String(literal).trim();
        if (/^["']/.test(rhs)) {
            try { rhs = "'" + esc(Function('return (' + rhs + ')')()) + "'"; } catch (e) { return null; }
        }
        const op = operator === '===' ? '==' : (operator === '!==' ? '!=' : operator);
        for (const L of entries) {
            const prefixes = L.kind === 'singleton' ? [[L.group]] : (L.writePaths || [[L.group]]);
            for (const prefix of prefixes) {
                if (!prefix.every((p, i) => parts[i] === p)) continue;
                const rest = parts.slice(prefix.length);
                if (L.kind === 'singleton' && rest.length === 1 && (L.cols || []).some(c => c.zh === rest[0])) {
                    return `db.${L.table}.where('${esc(L.keyCol)}','${esc(L.keyValue)}').get('${esc(rest[0])}') ${op} ${rhs}`;
                }
                if (L.kind === 'rows' && rest.length === 2 && (L.cols || []).some(c => c.zh === rest[1])) {
                    return `db.${L.table}.where('${esc(L.keyCol)}','${esc(rest[0])}').get('${esc(rest[1])}') ${op} ${rhs}`;
                }
            }
        }
        return null;
    }

    // 可选且刻意保守：只转换“单个静态字段 与 字面量比较”的无 else EJS。
    // 复杂分支继续保留 EJS，避免正则式翻译悄悄改变 JavaScript 语义。
    function translateSimpleEjsConditions(text, layout, report) {
        let count = 0;
        const out = String(text || '').replace(
            /<%_?\s*if\s*\(\s*((?:getvar\s*\([\s\S]*?\)[\s\S]*?))\s*(===|!==|==|!=|>=|<=|>|<)\s*((?:["'](?:\\.|[^"'\\])*["'])|-?\d+(?:\.\d+)?|true|false|null)\s*\)\s*\{\s*_?%>([^<]*?)<%_?\s*\}\s*_?%>/gi,
            (whole, accessor, op, literal, body) => {
                const parts = parseStaticStatAccessor(accessor);
                const condition = parts && dbConditionForStaticPath(parts, op, literal, layout);
                if (!condition) return whole;
                count++;
                return `<if db="${condition.replace(/"/g, '&quot;')}">${body}</if>`;
            }
        );
        if (count && report) report.auto(`已将 ${count} 个简单只读 EJS 条件转换为数据库 <if db>；复杂 EJS 继续保留兼容执行。`);
        return { text: out, count };
    }

    function rewriteEjsConditions(text, layout, report, options = {}) {
        const items = [];
        let out = String(text || '');
        if (options.translateSimpleEjs) out = translateSimpleEjsConditions(out, layout, report).text;
        const rewritten = rewriteStatDataCalls(out);
        out = rewritten.text;
        if (rewritten.count) {
            const count = rewritten.count;
            items.push({ original: 'getvar(\'stat_data…\')', rewritten: 'mvu2shujukuGetMessageVar(...) / mvu2shujukuGetAllVariables().stat_data', status: 'auto' });
            report.auto(`已把 ${count} 处 MVU/EJS 数据读取入口改为数据库安全取值函数（完整路径保留缺失返回/defaults 语义；stat_data 根读取保留对象访问；函数由扩展或卡内桥注册进模板上下文）。`);
        }
        // 非 MVU 的 getwi 等引用：保留并提示
        const orphanRe = /<%[-=]\s*await\s+getwi[\s\S]*?-?%>/g;
        const orphans = out.match(orphanRe);
        if (orphans) {
            report.note(`检测到 ${orphans.length} 处 getwi 世界书引用（非 MVU 语法），已原样保留；若目标环境不支持请人工处理。`);
        }
        const unresolved = unresolvedEjsDataReads(out);
        for (const snippet of unresolved) {
            report.manual(`检测到无法安全自动改写的 EJS 数据读取，请核对：\`${snippet.replace(/`/g, '\\`')}\``);
        }
        return { text: out, items };
    }

        return {
            findJsCallEnd,
            splitJsTopLevelArgs,
            rewriteStatDataCalls,
            ejsScriptBlocks,
            maskJsStringsAndComments,
            ejsLexicalDeclarationNames,
            ejsFallbackVarNames,
            isolateCrossEntryEjsFallbacks,
            unresolvedEjsDataReads,
            parseStaticStatAccessor,
            dbConditionForStaticPath,
            translateSimpleEjsConditions,
            rewriteEjsConditions,
        };
    }
if (typeof module !== "undefined" && module.exports) module.exports = createEjsTransform;
