'use strict';

function createEjsTransform(deps = {}) {
    // EJS keeps native variable calls intact. The runtime context selects the
    // database backend after JavaScript resolves paths, options and bindings.
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
        if (!source.trim()) return [];
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
        if (!/\b(?:stat_data|getvar|getMessageVar|setMessageVar|setvar)\b/i.test(out)) return { text: out, count };
        let code = maskJsStringsAndComments(out);
        const isBareCall = (index, length) => {
            if (!code.slice(index, index + length).trim() || /[\w$]/.test(code[index - 1] || '')) return false;
            let previous = index - 1;
            while (previous >= 0 && /\s/.test(code[previous])) previous--;
            return code[previous] !== '.';
        };
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

    function parserLibrary() {
        if (deps.ejs) return deps.ejs;
        if (typeof globalThis !== 'undefined' && globalThis.__MVU2SHUJUKU_EJS_PARSER_FACTORY__)
            return deps.ejs = globalThis.__MVU2SHUJUKU_EJS_PARSER_FACTORY__();
        if (typeof require === 'function') return deps.ejs = require('./vendor/ejs-parser')();
        throw new Error('EJS parser library missing');
    }
    function acornLibrary() {
        if (deps.acorn) return deps.acorn;
        if (typeof globalThis !== 'undefined' && globalThis.__MVU2SHUJUKU_SCHEMA_ENGINE_LIBS__)
            return deps.acorn = globalThis.__MVU2SHUJUKU_SCHEMA_ENGINE_LIBS__.acorn;
        if (typeof require === 'function') return deps.acorn = require('./vendor/schema-engine-libs').acorn;
        throw new Error('Acorn tokenizer missing');
    }

    // Let the actual engine classify tags, escaped delimiters and nested tokens.
    // generateSource parses without running author JavaScript. scanLine is observed,
    // not replaced by a second delimiter/state machine; edits retain original spans.
    function ejsScriptRanges(text) {
        const source = String(text || '');
        if (!source.includes('<%')) return { ranges: [], error: null };
        const ejs = parserLibrary(), ranges = [];
        const template = new ejs.Template(source, { rmWhitespace: false });
        const scan = template.scanLine, executable = new Set([
            ejs.Template.modes.EVAL, ejs.Template.modes.ESCAPED, ejs.Template.modes.RAW,
        ]);
        let cursor = 0;
        template.scanLine = function (line) {
            const start = source.indexOf(line, cursor), previous = this.mode;
            if (start < 0) throw new Error('EJS 解析范围无法对应原文，保留源代码');
            scan.call(this, line);
            if (line && executable.has(previous) && this.mode === previous)
                ranges.push({ start, end: start + line.length });
            cursor = start + line.length;
        };
        try { template.generateSource(); return { ranges, error: null }; }
        catch (error) { return { ranges: [], error: error.message }; }
    }
    function ejsScriptBlocks(text) {
        const source = String(text || '');
        return ejsScriptRanges(source).ranges.map(range => source.slice(range.start, range.end));
    }

    // Acorn supplies string/comment/regexp/template token boundaries. Keeping offsets
    // permits source edits without executing code or guessing JavaScript lexing rules.
    function maskJsStringsAndComments(source) {
        const s = String(source || ''), out = s.split('');
        const blank = (a, b) => { for (let n = a; n < b; n++) if (s[n] !== '\n' && s[n] !== '\r') out[n] = ' '; };
        const lexer = acornLibrary().tokenizer(s, {
            ecmaVersion: 'latest', allowHashBang: true,
            onComment: (_block, _text, start, end) => blank(start, end),
        });
        try {
            for (;;) {
                const token = lexer.getToken(), label = token.type.label;
                if (label === 'eof') break;
                if (['string', 'regexp', 'template', '`'].includes(label)) blank(token.start, token.end);
                if (label === '${') out[token.start] = ' ';
            }
        } catch (_) {
            // Invalid/incomplete lexical input must not become an unsafe positive match.
            blank(0, s.length);
        }
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
        const blocks = ejsScriptBlocks(text);
        for (const block of blocks) {
            // getvar/MessageVar/setvar arguments are resolved by the execution
            // context adapter, including dynamic paths. Only unbridged direct
            // object readers remain a static conversion warning.
            const suspicious =
                /\b(?:getAllVariables|getVariables|allVariables)\s*\(\s*\)\s*\.\s*stat_data\b/i.test(block) ||
                /\ball_variables\s*\.\s*stat_data\b/i.test(block) ||
                /(^|[^\w$.])variables\s*\.\s*stat_data\b/i.test(block) ||
                /\bTavernHelper\s*\.\s*getVariables\s*\(\s*\)\s*\.\s*stat_data\b/i.test(block);
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
        const parsed = ejsScriptRanges(out);
        if (parsed.error) report.manual(`EJS 模板解析未完成：${parsed.error}`);
        let count = 0, cursor = 0, rewrittenText = '';
        for (const range of parsed.ranges) {
            const rewritten = rewriteStatDataCalls(out.slice(range.start, range.end));
            count += rewritten.count;
            rewrittenText += out.slice(cursor, range.start) + rewritten.text;
            cursor = range.end;
        }
        out = rewrittenText + out.slice(cursor);
        if (count) {
            items.push({ original: '直接读取 stat_data 的入口', rewritten: 'mvu2shujukuGetAllVariables().stat_data', status: 'auto' });
            report.auto(`已把 ${count} 处 MVU/EJS 数据读取入口改为数据库安全取值函数（变量函数调用保持原文，由运行时上下文适配数据库；兼容函数由扩展或卡内桥注册进模板上下文）。`);
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
            ejsScriptRanges,
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
