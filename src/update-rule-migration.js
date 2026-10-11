'use strict';

// Business prose and executable templates stay at their original locations.
// Only complete, static format examples are omitted from request copies.
function createUpdateRuleMigration({ YAML, isProtocolRule = () => false }) {
    const guideCall = '<% /* mvu2shujuku:fill-adaptation:v1 */ %>';
    const guideTitle = '[M2SJK]填表适配说明';
    const guidance = '本次任务是根据当前对话、数据库状态和作者业务要求更新数据库。输出格式、表列名称和记录定位遵循本次数据库填表协议及提供的表结构、列说明。\n' +
        '保留作者要求中的条件、数值、阈值、例外和禁止事项。原文要求使用 JSONPatch、UpdateVariable 等旧格式时，执行其业务要求，输出改用本次数据库协议。具体操作列表中的目标和值仍是变更要求；这些名称若属于业务数据，保留原值。';
    const guideContent = guideCall + '\n' + guidance;
    const blockedTitleTerms = ['规则', '思维链', 'cot', 'MVU', 'mvu', '变量', '状态',
        'Status', 'Rule', 'rule', '检定', '判断', '叙事', '文风', 'InitVar', '格式'];
    function fillTitle(comment, id) {
        const name = String(comment || '').replace(/\[(?:mvu[ _-]?update|mvuupdate|M2SJK)\]/ig, '').trim();
        if (!name || blockedTitleTerms.some(term => name.includes(term))) {
            const number = Number(id);
            return `[M2SJK]更新要求（${id != null && Number.isInteger(number) && number >= 0 ? number : '未编号'}）`;
        }
        return '[M2SJK]' + name;
    }
    const formatKey = /^(?:format(?:_template)?|output_format|格式)$/i;
    const documentKey = /^(?:Force_Structured_Output|variables?_update_format|output_format|变量(?:输出(?:规则|格式)|更新格式)(?:强调)?)$/i;
    const quoteKey = /^(?:examples?|samples?|dialogue|quotes?|code|narrative|story|示例|样例|台词|引用|代码|正文|剧情|故事)$/i;
    const placeholder = value => typeof value === 'string' &&
        /^\$\{\/[^{}\n]+\}$/.test(value);
    // Recognize syntax and placeholder targets; never interpret Analysis prose.
    function formatParts(value) {
        if (typeof value !== 'string' || /<%|%>|&lt;%/.test(value)) return null;
        let text = value.trim();
        const update = /^<UpdateVariable>\s*([\s\S]*?)\s*<\/UpdateVariable>$/i.exec(text);
        if (!update) return false;
        text = update[1];
        // The slot can contain business rules. Preserve its contents verbatim.
        const analysis = /<Analysis>([\s\S]*?)<\/Analysis>/i.exec(text);
        if (analysis) text = text.replace(analysis[0], '');
        const patch = /^\s*<JSON_?Patch>\s*([\s\S]*?)\s*<\/JSON_?Patch>\s*$/i.exec(text);
        if (!patch) return false;
        let operations;
        try { operations = JSON.parse(patch[1]); }
        catch (_) {
            const lines = patch[1].trim().split('\n').map(s => s.trim());
            if (lines.shift() !== '[' || lines.pop() !== ']') return false;
            try { operations = lines.filter(s => s && s !== '...' && s !== '...,').map(s => JSON.parse(s.replace(/,$/, ''))); }
            catch (_) { return false; }
        }
        const placeholders = Array.isArray(operations) && operations.every(op => op && typeof op === 'object' &&
            ['add', 'remove', 'replace', 'move', 'copy', 'test', 'delta', 'insert'].includes(op.op) &&
            placeholder(op.path || op.from) && (!('path' in op) || placeholder(op.path)) &&
            (!('from' in op) || placeholder(op.from)) && (!('to' in op) || placeholder(op.to)) &&
            Object.keys(op).every(k => ['op', 'path', 'from', 'to', 'value'].includes(k)));
        return placeholders ? { pure: !analysis || !analysis[1].trim() || /^(?:\.{3}|…)$/.test(analysis[1].trim()) } : null;
    }
    function syntaxCuts(source, start, end) {
        const raw = source.slice(start, end), cuts = [];
        const opening = /<UpdateVariable>/i.exec(raw), closings = [...raw.matchAll(/<\/UpdateVariable>/gi)];
        if (opening) cuts.push([start + opening.index, start + opening.index + opening[0].length]);
        const closing = closings.at(-1);
        if (closing) cuts.push([start + closing.index, start + closing.index + closing[0].length]);
        const analysis = /<Analysis>([\s\S]*?)<\/Analysis>/i.exec(raw);
        let visible = raw;
        if (analysis) {
            cuts.push([start + analysis.index, start + analysis.index + '<Analysis>'.length]);
            const closeStart = analysis.index + analysis[0].length - '</Analysis>'.length;
            cuts.push([start + closeStart, start + closeStart + '</Analysis>'.length]);
            // Protocol names inside opaque business text are data, not tags to cut.
            visible = raw.slice(0, analysis.index) + ' '.repeat(analysis[0].length) + raw.slice(analysis.index + analysis[0].length);
        }
        const patch = /<JSON_?Patch>[\s\S]*?<\/JSON_?Patch>/i.exec(visible);
        if (patch) cuts.push([start + patch.index, start + patch.index + patch[0].length]);
        return cuts.sort((a, b) => a[0] - b[0]);
    }
    function envelope(source) {
        let start = 0, end = source.length;
        for (let depth = 0; depth < 8; depth++) {
            const raw = source.slice(start, end), text = raw.trim(), trimStart = raw.indexOf(text);
            start += trimStart; end = start + text.length;
            const xml = /^<([\p{L}_][\p{L}\p{N}_.:-]*)[ \t]*>([\s\S]*?)<\/\1[ \t]*>$/iu.exec(text);
            if (xml && !/^(?:script|style|template|html|head|body|UpdateVariable|JSON_?Patch|initvar|status_current_variables?)$/i.test(xml[1])) {
                const tag = xml[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                if (!new RegExp('<\\/?' + tag + '(?:\\s|>)', 'iu').test(xml[2])) {
                    start += text.indexOf('>') + 1; end = start + xml[2].length; continue;
                }
            }
            const fence = /^(`{3,}|~{3,})[ \t]*(?:yaml|yml|json|json5)?[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/i.exec(text);
            if (fence && !new RegExp('^' + fence[1] + '[ \\t]*$', 'm').test(fence[2])) {
                start += text.indexOf('\n') + 1; end = start + fence[2].length; continue;
            }
            break;
        }
        return { start, end };
    }
    function plan(source, { outputOnly = false } = {}) {
        source = String(source || '');
        const result = { text: source, excluded: [], issues: [] };
        // Preserve offsets while shielding all executable blocks from parsing.
        const tokens = [...source.matchAll(/<%[\s\S]*?%>/g)].map(m => [m.index, m.index + m[0].length]);
        const masked = source.replace(/<%[\s\S]*?%>/g, m => m.replace(/[^\r\n]/g, ' '));
        if (/<%|%>|&lt;%/.test(masked)) return result;
        const outer = envelope(source), body = source.slice(outer.start, outer.end);
        const whole = outputOnly && formatParts(body);
        if (whole) result.excluded = whole.pure ? [[outer.start, outer.end]] : syntaxCuts(source, outer.start, outer.end);
        else {
            let doc;
            try { doc = YAML.parseDocument(masked.slice(outer.start, outer.end), { uniqueKeys: true }); }
            catch (_) { return result; }
            if (doc.errors.length || !YAML.isMap(doc.contents)) return result;
            let shared = false;
            YAML.visit(doc, (_, node) => { if (YAML.isAlias(node) || node?.anchor || node?.tag && node.tag !== 'tag:yaml.org,2002:str') shared = true; });
            if (shared) return result;
            const cuts = [];
            const span = node => [outer.start + node.range[0], outer.start + node.range[2]];
            const pairSpan = pair => {
                const begin = outer.start + pair.key.range[0];
                const line = source.lastIndexOf('\n', begin - 1) + 1;
                return [/^[ \t]*$/.test(source.slice(line, begin)) ? line : begin, outer.start + pair.value.range[1]];
            };
            function walk(map, inDocument = outputOnly) {
                const complete = map.items.some(pair => formatKey.test(String(pair.key?.value || '')) && formatParts(pair.value?.value));
                for (const pair of map.items) {
                    if (!pair.key || !pair.value || !pair.key.range || !pair.value.range) continue;
                    const key = String(pair.key.value || '');
                    if (quoteKey.test(key)) continue;
                    if (formatKey.test(key)) {
                        const range = pairSpan(pair);
                        if (tokens.some(([a, b]) => a < range[1] && b > range[0])) continue;
                        const parts = formatParts(pair.value.value);
                        if (parts) cuts.push(...(parts.pure ? [range] : syntaxCuts(source, ...range)));
                    }
                    else if (inDocument && complete && /^(?:rules?|输出规则|规则)$/i.test(key) && YAML.isSeq(pair.value)) {
                        for (const item of pair.value.items) {
                            if (!item?.range || !isProtocolRule(item.toJSON())) continue;
                            // YAML comments can be business instructions too. A
                            // known protocol value does not prove its comments disposable.
                            let commented = false;
                            YAML.visit(item, (_, node) => { if (node?.comment || node?.commentBefore) commented = true; });
                            if (commented) continue;
                            const range = span(item), line = source.lastIndexOf('\n', range[0] - 1) + 1;
                            if (/^[ \t]*-[ \t]*$/.test(source.slice(line, range[0]))) range[0] = line;
                            cuts.push(range);
                        }
                    } else if (YAML.isMap(pair.value) && documentKey.test(key)) walk(pair.value, true);
                }
            }
            walk(doc.contents);
            result.excluded = cuts.sort((a, b) => a[0] - b[0]);
        }
        for (const [start, end] of result.excluded.slice().reverse()) result.text = result.text.slice(0, start) + result.text.slice(end);
        return result;
    }
    function guideTokens(text) {
        return [...text.matchAll(/<%([_=#-]?)([\s\S]*?)([-_]?)%>/g)]
            .filter(m => m[0] === guideCall && (m.index === 0 || text[m.index - 1] === '\n') &&
                (m.index + m[0].length === text.length || /[\r\n]/.test(text[m.index + m[0].length])));
    }
    function preparePrompt(code, entries = []) {
        let text = String(code || '');
        // The private comment is the fill-view marker, not an arbitrary keyword.
        if (!guideTokens(text).length) return { text, adapted: false };
        for (const entry of entries) {
            if (!entry || entry.enabled === false || !entry.extensions?.mvu2shujukuFillView) continue;
            const source = String(entry.content || '').trim();
            if (!source || !text.includes(source)) continue;
            const view = plan(source, { outputOnly: entry.extensions.mvu2shujukuFillView.outputOnly });
            if (!view.excluded.length) continue;
            // Match whole entry text. Never remove individual words, patches or
            // a partial match inside a quotation / larger business sentence.
            let from = 0;
            while (from <= text.length) {
                const index = text.indexOf(source, from);
                if (index < 0) break;
                const end = index + source.length;
                if ((index === 0 || text[index - 1] === '\n') && (end === text.length || text[end] === '\n')) {
                    text = text.slice(0, index) + view.text + text.slice(end); from = index + view.text.length;
                } else from = end;
            }
        }
        for (const token of guideTokens(text).slice().reverse()) {
            const duplicate = token.index !== guideTokens(text)[0].index && text.slice(token.index).startsWith(guideContent);
            text = text.slice(0, token.index) + text.slice(token.index + (duplicate ? guideContent.length : guideCall.length));
        }
        return { text, adapted: true };
    }
    return { guideCall, guideContent, guideTitle, guidance, fillTitle, plan, preparePrompt };
}
module.exports = createUpdateRuleMigration;
