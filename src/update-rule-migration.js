'use strict';

// Route complete update sections. Natural-language conditions are preserved,
// never interpreted; source spans keep the author's EJS control flow intact.
function createUpdateRuleMigration({ parseJs }) {
    const contract = '以下规则描述更新条件和目标变化；实际更新必须使用本次数据库填表协议，操作列表不作为输出格式。';
    // DB 1.2.5 / 1a5ffdb: its configuration UI hides these title substrings
    // and removes their selected UIDs. Keep safe author names without guessing
    // synonyms for blocked ones; the converter report retains the source name.
    const blockedTitleTerms = ['规则', '思维链', 'cot', 'MVU', 'mvu', '变量', '状态',
        'Status', 'Rule', 'rule', '检定', '判断', '叙事', '文风', 'InitVar', '格式'];
    function fillTitle(comment, id, split = false) {
        const name = String(comment || '').replace(/\[(?:mvu[ _-]?update|mvuupdate|M2SJK)\]/ig, '').trim();
        if (!name || blockedTitleTerms.some(term => name.includes(term))) {
            const number = Number(id);
            const ordinal = id != null && Number.isInteger(number) && number >= 0 ? String(number) : '未编号';
            return `[M2SJK]更新要求（${ordinal}）`;
        }
        return `[M2SJK]${name}${split ? '（更新要求）' : ''}`;
    }
    const protocol = /<\/?(?:JSON_?Patch|UpdateVariable)\b[^>]*>|\bJSON\s*Patch\b|\bRFC\s*6902\b/i;
    const updateKey = /^(?:checks?|instructions?|update_rules?|update_instructions?|variables?_update_rules?|variables?_update_format|variable_output_protocol|force_structured_output|output_format|mandatory_patch(?:_template)?|json_?patch|更新要求|更新指令|强制更新|变量更新规则|变量输出格式)$/i;
    const quotedKey = /^(?:examples?|samples?|dialogue|quotes?|code|narrative|story|示例|样例|台词|引用|代码|正文|剧情|故事)$/i;
    const patchKey = /^(?:mandatory_patch(?:_template)?|json_?patch)$/i;
    const pointer = /(?<![\p{L}\p{N}_$}])\/[\p{L}\p{N}_$](?:<[^<>\n]+>|[^\s，。、；;:："'<>()[\]（）|=≤≥])*/gu;
    function protocolReferences(literal) {
        // An exact quoted protocol name may be a business value, not a format.
        const data = [], protectedText = literal.replace(/(["'`])(?:JSON\s*Patch|<\/?(?:JSON_?Patch|UpdateVariable)>)(?:\1)/gi,
            value => { data.push(value); return '\u0000' + (data.length - 1) + '\u0000'; });
        return protectedText.replace(/<\/(?:JSON_?Patch|UpdateVariable)\s*>/gi, '')
            .replace(/<(?:JSON_?Patch|UpdateVariable)\s*>/gi, '本次数据库填表')
            .replace(/\bJSON\s*Patch\b|\bRFC\s*6902\b/gi, '数据库填表协议')
            .replace(/\u0000(\d+)\u0000/g, (_, index) => data[Number(index)]);
    }
    function segment(source) {
        const tokens = [], mask = source.split('');
        for (const match of source.matchAll(/<%([_=#-]?)([\s\S]*?)([-_]?)%>/g)) {
            const token = { start: match.index, end: match.index + match[0].length, raw: match[0],
                mode: match[1], code: match[2], close: match[3] };
            tokens.push(token);
            for (let i = token.start; i < token.end; i++) if (mask[i] !== '\n' && mask[i] !== '\r') mask[i] = ' ';
        }
        const visible = mask.join('');
        if (/<%|%>|&lt;%/.test(visible)) throw new Error('模板含无法完整识别的 EJS 边界');
        return { tokens, visible };
    }
    function safeTemplate(tokens) {
        if (!tokens.length) return;
        const code = tokens.filter(t => t.mode !== '#').map(t => t.mode === '=' || t.mode === '-'
            ? '__emit((' + t.code + '));' : t.code).join('\n');
        const ast = parseJs(code, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true });
        const locals = new Set(), functions = new Set();
        function walk(node, callback) {
            if (!node || typeof node !== 'object') return;
            if (typeof node.type === 'string') callback(node);
            for (const value of Object.values(node)) {
                if (Array.isArray(value)) value.forEach(child => walk(child, callback));
                else if (value && typeof value === 'object') walk(value, callback);
            }
        }
        walk(ast, n => {
            if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier') {
                locals.add(n.id.name);
                if (n.init && /Function/.test(n.init.type)) functions.add(n.id.name);
            }
            if (n.type === 'FunctionDeclaration' && n.id) { locals.add(n.id.name); functions.add(n.id.name); }
            if (/Function/.test(n.type)) for (const param of n.params || []) if (param.type === 'Identifier') locals.add(param.name);
        });
        const bare = new Set(['__emit', 'getvar', 'getAllVariables', 'mvu2shujukuGetAllVariables',
            'mvu2shujukuFormatMessageVariable', 'String', 'Number', 'Boolean', 'parseInt', 'parseFloat', 'isNaN', 'isFinite']);
        const globals = new Set([...bare, '_', 'Object', 'JSON', 'Math', 'Array', 'NaN', 'Infinity', 'undefined']);
        // Validate references in their lexical scope. A parameter in one function
        // does not establish that a same-named host object elsewhere is safe.
        function scoped(node, inherited = new Set()) {
            const scope = new Set(inherited);
            if (/Function/.test(node.type)) {
                if (node.id) scope.add(node.id.name);
                for (const param of node.params || []) {
                    if (param.type !== 'Identifier') throw new Error('EJS 参数绑定无法确认为只读计算');
                    scope.add(param.name);
                }
            }
            function gather(n) {
                if (!n || typeof n !== 'object') return;
                if (n.type === 'FunctionDeclaration' && n.id) scope.add(n.id.name);
                if (n !== node && (/Function/.test(n.type || '') || n.type === 'BlockStatement')) return;
                if (n.type === 'VariableDeclarator') {
                    if (n.id.type !== 'Identifier') throw new Error('EJS 变量绑定无法确认为只读计算');
                    scope.add(n.id.name);
                }
                for (const value of Object.values(n)) {
                    if (Array.isArray(value)) value.forEach(gather);
                    else if (value && typeof value === 'object') gather(value);
                }
            }
            gather(node);
            function visit(n, parent, key) {
                if (!n || typeof n !== 'object') return;
                if (n !== node && (/Function/.test(n.type || '') || n.type === 'BlockStatement')) { scoped(n, scope); return; }
                if (n.type === 'Identifier') {
                    const binding = parent && ((parent.type === 'VariableDeclarator' && key === 'id') ||
                        /Function/.test(parent.type) && (key === 'id' || key === 'params'));
                    const property = parent && !parent.computed &&
                        (parent.type === 'MemberExpression' && key === 'property' || parent.type === 'Property' && key === 'key');
                    if (!binding && !property && !scope.has(n.name) && !globals.has(n.name))
                        throw new Error('EJS 含无法确认为只读的外部依赖');
                }
                for (const [childKey, value] of Object.entries(n)) {
                    if (Array.isArray(value)) value.forEach(child => visit(child, n, childKey));
                    else if (value && typeof value === 'object') visit(value, n, childKey);
                }
            }
            visit(node, null, '');
        }
        scoped(ast);
        const methods = new Set(['get', 'has', 'clamp', 'round', 'floor', 'ceil', 'max', 'min', 'sum', 'sumBy',
            'keys', 'values', 'entries', 'isArray', 'isFinite', 'isInteger', 'parse', 'stringify',
            'map', 'filter', 'reduce', 'find', 'some', 'every', 'includes', 'join', 'slice', 'concat',
            'startsWith', 'endsWith', 'trim', 'replace', 'match', 'test', 'toLowerCase', 'toUpperCase', 'indexOf', 'forEach']);
        walk(ast, n => {
            if (['ImportExpression', 'NewExpression', 'AwaitExpression', 'WithStatement', 'ThisExpression'].includes(n.type))
                throw new Error('EJS 含无法安全拆分的宿主或异步依赖');
            if (n.type === 'AssignmentExpression' || n.type === 'UpdateExpression' ||
                n.type === 'UnaryExpression' && n.operator === 'delete')
                throw new Error('EJS 含无法安全拆分的写入或重绑定');
            if (n.type !== 'CallExpression') return;
            if (n.callee.type === 'Identifier' && (bare.has(n.callee.name) || functions.has(n.callee.name))) return;
            if (n.callee.type === 'MemberExpression' && !n.callee.computed && methods.has(n.callee.property.name)) {
                let base = n.callee.object;
                while (base.type === 'MemberExpression') base = base.object;
                if (base.type === 'Identifier' && (locals.has(base.name) || ['_', 'Object', 'JSON', 'Math', 'Array', 'Number'].includes(base.name))) return;
            }
            throw new Error('EJS 调用的行为无法确认为只读计算');
        });
    }
    function fields(visible, tokens = []) {
        const lines = [], nodes = [], stack = [];
        let offset = 0;
        for (const line of visible.split('\n')) { lines.push({ text: line, start: offset, end: offset + line.length + 1 }); offset += line.length + 1; }
        for (const line of lines) {
            if (!line.text.trim() || /^\s*#/.test(line.text)) continue;
            let indent = line.text.match(/^[ \t]*/)[0].length;
            const leadingCode = tokens.find(t => t.start >= line.start && t.start < line.start + indent);
            if (leadingCode) indent = leadingCode.start - line.start;
            while (stack.length && indent <= stack.at(-1).indent) stack.pop().end = line.start;
            const match = /^([ \t]*)([\p{L}\p{N}_$.-]+)[ \t]*:[ \t]*(.*)$/u.exec(line.text);
            if (!match) continue;
            const node = { key: match[2], indent, start: line.start, end: visible.length,
                parent: stack.at(-1) || null, lineEnd: Math.min(line.end, visible.length), value: match[3] };
            nodes.push(node); stack.push(node);
        }
        return nodes;
    }
    function literals(source, tokens, start, end, callback) {
        let cursor = start, out = '';
        for (const token of tokens.filter(t => t.end > start && t.start < end)) {
            if (token.start < start || token.end > end) throw new Error('更新段落与 EJS 标签交叉');
            out += callback(source.slice(cursor, token.start)); out += token.raw; cursor = token.end;
        }
        return out + callback(source.slice(cursor, end));
    }
    function migrate(source, { updateOnly = false, resolvePath }) {
        const result = { body: source, fill: '', migrated: 0, issues: [] };
        if (!protocol.test(source) && !/mandatory_patch|json_?patch\s*:/i.test(source)) return result;
        const issue = text => { if (!result.issues.includes(text)) result.issues.push(text); };
        let parts;
        try { parts = segment(source); safeTemplate(parts.tokens); }
        catch (error) { issue(error.message); return result; }
        const { visible, tokens } = parts;
        if (/(?:^|[\s:])[&*][A-Za-z_][\w-]*/m.test(visible)) { issue('含 YAML 共享节点，不能拆开其定义与引用'); return result; }
        if (/<(?:script|style|iframe)\b/i.test(visible)) { issue('含前端代码，不能作为更新段落拆分'); return result; }
        const nodes = fields(visible, tokens);
        let candidates = [];
        if (updateOnly && !/<\/?status_current_variables?\b/i.test(visible))
            candidates = [{ start: 0, end: source.length, key: '', parent: null, patch: false }];
        else for (const node of nodes) {
            let quoted = quotedKey.test(node.key);
            for (let parent = node.parent; parent; parent = parent.parent) quoted ||= quotedKey.test(parent.key);
            if (quoted || !updateKey.test(node.key)) continue;
            const text = visible.slice(node.start, node.end);
            if (protocol.test(text) || patchKey.test(node.key)) candidates.push({ ...node, patch: patchKey.test(node.key) });
        }
        // A complete source span is the migration unit, including every operation
        // of a patch list. Nested matches belong to their enclosing section.
        candidates = candidates.filter(n => !candidates.some(p => p !== n && p.start <= n.start && p.end >= n.end));
        const accepted = [];
        for (const candidate of candidates) {
            const text = visible.slice(candidate.start, candidate.end), mappings = new Map();
            const siblings = candidates.filter(n => n.parent === candidate.parent);
            const related = siblings.some(n => n.patch) ? siblings : [candidate];
            const bindingText = related.map(n => visible.slice(n.start, n.end)).join('\n');
            let unresolved = false;
            for (const tag of ['JSONPatch', 'JSON_Patch', 'UpdateVariable']) {
                const opens = [...text.matchAll(new RegExp('<'+tag+'\\b[^>]*>', 'gi'))].length;
                const closes = [...text.matchAll(new RegExp('</'+tag+'\\s*>', 'gi'))].length;
                if (opens !== closes && new RegExp('</'+tag+'\\s*>', 'i').test(visible)) unresolved = true;
            }
            if (unresolved) { issue('更新段落与旧协议标签边界交叉，整段保留'); continue; }
            const pathText = bindingText.replace(/<\/?[A-Za-z_][^>]*>/g, (markup, offset) => bindingText[offset - 1] === '/' ? markup : ' '.repeat(markup.length));
            for (const match of pathText.matchAll(pointer)) {
                const path = match[0];
                if (/~(?![01])/.test(path)) { unresolved = true; break; }
                const binding = resolvePath(path.slice(1).split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~')));
                if (!binding) { issue('无法绑定更新路径：' + path); unresolved = true; break; }
                mappings.set(path, binding.label);
            }
            if (unresolved) { issue('更新段落含无法绑定到实际表列的路径，整段保留'); continue; }
            if (!mappings.size && !/<\/?(?:JSON_?Patch|UpdateVariable)\b|\bJSON\s+Patch\b|\bRFC\s*6902\b|mandatory_patch|json_?patch\s*:/i.test(text)) {
                issue('仅有协议名称提及，不能确认为旧更新协议要求'); continue;
            }
            // An unmarked instruction mentioning the protocol without any target
            // cannot establish that it is an independent update requirement.
            if (!updateOnly && !mappings.size && !candidate.patch && !/update_|更新|输出格式|output_format|output_protocol|force_structured_output/i.test(candidate.key)) {
                issue('无法确认该段落的更新目标或独立更新职责'); continue;
            }
            const payloadNodes = nodes.filter(n => patchKey.test(n.key) && n.start >= candidate.start && n.end <= candidate.end);
            const payload = candidate.patch || payloadNodes.length > 0;
            const rewrite = literal => {
                let value = literal;
                value = value.replace(/^([ \t]*)(?:format|output_format|格式)([ \t]*:)/gim, '$1变更要求说明（非输出格式）$2');
                if (!payload) for (const [path, label] of [...mappings].sort((a, b) => b[0].length - a[0].length)) {
                    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    value = value.replace(new RegExp(escaped + '(?![\\p{L}\\p{N}_$/])', 'gu'), () => label);
                }
                // Payload strings are data, including a literal named JSONPatch.
                // A patch list keeps its contents and gains a local binding guide.
                return protocolReferences(value);
            };
            let rewritten;
            try {
                let cursor = candidate.start;
                rewritten = '';
                for (const node of payloadNodes.filter(n => !payloadNodes.some(p => p !== n && p.start <= n.start && p.end >= n.end)).sort((a,b)=>a.start-b.start)) {
                    rewritten += literals(source, tokens, cursor, node.start, rewrite);
                    rewritten += literals(source, tokens, node.start, node.end, literal => literal.replace(/^([ \t]*)(?:mandatory_patch(?:_template)?|json_?patch)([ \t]*:)/im, '$1数据库变更要求$2'));
                    cursor = node.end;
                }
                rewritten += literals(source, tokens, cursor, candidate.end, rewrite);
            }
            catch (error) { issue(error.message); continue; }
            if (payload && mappings.size) rewritten += '\n' + ' '.repeat(candidate.indent || 0) + '更新目标对应: ' + [...mappings].map(([path, label]) => path + ' → ' + label).join('；') + '。\n';
            accepted.push({ ...candidate, rewritten });
        }
        if (!accepted.length) return result;
        // Ancestor headers and static sibling fields carry explicit conditions.
        const context = [];
        for (const range of accepted) {
            for (let parent = range.parent; parent; parent = parent.parent) {
                context.push({ start: parent.start, end: parent.lineEnd });
                for (const sibling of nodes.filter(n => n.parent === parent && !accepted.some(a => a.start <= n.start && a.end >= n.end))) {
                    if (!nodes.some(n => n.parent === sibling) && !quotedKey.test(sibling.key) && !updateKey.test(sibling.key))
                        context.push({ start: sibling.start, end: sibling.end });
                }
            }
        }
        function render(fill) {
            let text = '', cursor = 0;
            const selected = (start, end) => (fill ? accepted.concat(context) : accepted).some(r => r.start <= start && r.end >= end);
            const cuts = [...new Set([0, source.length, ...accepted.flatMap(r => [r.start, r.end]), ...context.flatMap(r => [r.start, r.end]), ...tokens.flatMap(t => [t.start, t.end])])].sort((a, b) => a - b);
            for (let i = 0; i < cuts.length - 1; i++) {
                const start = cuts[i], end = cuts[i + 1];
                if (start < cursor || start === end) continue;
                const whole = accepted.find(r => r.start === start);
                if (fill && whole) { text += whole.rewritten; cursor = whole.end; continue; }
                const token = tokens.find(t => t.start === start);
                if (token) {
                    const keep = selected(token.start, token.end);
                    if (token.mode === '=' || token.mode === '-') {
                        text += (fill ? keep : !keep) ? token.raw : '<% void (' + token.code + '); ' + token.close + '%>';
                    } else text += token.raw;
                    cursor = token.end; continue;
                }
                if (fill ? selected(start, end) : !selected(start, end)) text += source.slice(start, end);
                cursor = end;
            }
            return text;
        }
        const isolate = text => tokens.length ? '<% { %>\n' + text + '\n<% } %>' : text;
        result.body = accepted.some(r => r.start === 0 && r.end === source.length) ? '' : isolate(render(false));
        result.fill = isolate(contract + '\n' + render(true));
        result.migrated = accepted.length;
        const fillVisible = segment(result.fill).visible;
        const withoutPayloads = fillVisible.split('');
        for (const field of fields(fillVisible).filter(n => n.key === '数据库变更要求'))
            for (let i = field.start; i < field.end; i++) withoutPayloads[i] = ' ';
        if (protocol.test(withoutPayloads.join(''))) issue('迁移结果仍含未承接协议引用，不能视为已完整清理');
        return result;
    }
    function normalizeRule(source, { resolvePath, jsonLocal = false }) {
        const result = { text: source, issues: [] };
        if (!protocol.test(source)) return result;
        let parts;
        try { parts = segment(source); } catch (error) { result.issues.push(error.message); return result; }
        const mappings = new Map();
        const text = parts.visible.replace(/<\/?[A-Za-z_][^>]*>/g, (markup, offset) => parts.visible[offset - 1] === '/' ? markup : ' '.repeat(markup.length));
        if (!jsonLocal) for (const match of text.matchAll(pointer)) {
            const path = match[0], binding = !/~(?![01])/.test(path) && resolvePath(path.slice(1).split('/').map(p=>p.replace(/~1/g,'/').replace(/~0/g,'~')));
            if (!binding) { result.issues.push('无法绑定更新路径：' + path); return result; }
            mappings.set(path, binding.label);
        }
        const rewritten = literals(source, parts.tokens, 0, source.length, literal => {
            let value = literal;
            for (const [path, label] of [...mappings].sort((a,b)=>b[0].length-a[0].length)) {
                const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                value = value.replace(new RegExp(escaped + '(?![\\p{L}\\p{N}_$/])', 'gu'), () => label);
            }
            return protocolReferences(value);
        });
        if (rewritten !== source) result.text = '业务更新要求（实际输出遵循数据库填表协议）：' + rewritten;
        return result;
    }
    return { migrate, normalizeRule, fillTitle };
}
module.exports = createUpdateRuleMigration;
