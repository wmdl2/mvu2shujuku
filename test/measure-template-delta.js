'use strict';
// 同输入模板对照；可对一份已捕获的请求替换 note，隔离说明改动的增量。不会发送请求。
const fs = require('fs'), path = require('path'), assert = require('assert');
const core = require('../src/mvu2shujuku');
const refs = process.env.MVU_REFERENCE_ROOT || path.resolve(__dirname, '../../参考资料');
const tokenizer = require(path.join(refs, 'SillyTavern/node_modules/tiktoken')).get_encoding('o200k_base');
const count = text => tokenizer.encode(String(text), [], []).length;
const fields = ['note', 'ddl', 'initNode', 'insertNode', 'updateNode', 'deleteNode'];
function readTemplate(file) {
    const bytes = fs.readFileSync(file);
    const input = bytes[0] === 0x89 ? core.parseCardPng(bytes).card : JSON.parse(bytes.toString('utf8'));
    if (input.template) return input.template;
    if (Object.keys(input).some(k => k.startsWith('sheet_'))) return input;
    const data = input.data || input;
    const entry = data.character_book?.entries?.find(e => (e.keys || []).includes('__ACU_TEMPLATE_DATA__'));
    assert.ok(entry, '需要模板或已转换角色卡，未找到内嵌模板');
    return JSON.parse(Buffer.from(entry.content.trim(), 'base64').toString('utf8'));
}
function sheets(template) { return Object.values(template).filter(s => s && s.content && s.sourceData); }
function inventory(template) {
    const tables = sheets(template);
    const parts = Object.fromEntries(fields.map(field => [field, tables.reduce((sum, s) => {
        const text = String(s.sourceData[field] || '');
        return {chars:sum.chars + text.length, tokens:sum.tokens + count(text)};
    }, {chars:0, tokens:0})]));
    const values = Object.values(parts);
    return { tables: tables.length, parts, total: values.reduce((sum, p) => ({chars:sum.chars + p.chars, tokens:sum.tokens + p.tokens}), {chars:0, tokens:0}),
        contentTokens:tables.reduce((sum, s) => sum + count(JSON.stringify(s.content)), 0) };
}
function requestDelta(capture, before, after) {
    const byName = new Map(sheets(before).map(s => [s.name, s]));
    const changes = sheets(after).filter(s => s.sourceData.note !== byName.get(s.name)?.sourceData.note);
    for (const s of sheets(after)) for (const field of fields.filter(f => f !== 'note')) {
        assert.strictEqual(s.sourceData[field], byName.get(s.name)?.sourceData[field], '请求增量仅支持 note 差异');
    }
    return (capture.requests || []).map(request => {
        const messages = request.messages || [];
        let replacements = 0;
        const modified = messages.map(message => {
            let text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
            if (!text.includes('<当前表格数据>\n')) return text;
            for (const sheet of changes) {
                const old = byName.get(sheet.name).sourceData.note, current = sheet.sourceData.note;
                const sql = text.includes('-- Note: ' + current.replace(/\n/g, '\n-- '));
                const encode = value => sql ? '-- Note: ' + value.replace(/\n/g, '\n-- ') : '  - Note: ' + value;
                const needle = encode(current);
                assert.strictEqual(text.split(needle).length - 1, 1, '本次完整表格请求必须恰好包含一份目标 note：' + sheet.name);
                text = text.replace(needle, () => encode(old));
                replacements++;
            }
            return text;
        });
        assert.strictEqual(replacements, changes.length, '请求未覆盖全部修改的表格说明');
        const actual = messages.reduce((n, m) => n + count(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)), 0);
        const reconstructedBefore = modified.reduce((n, text) => n + count(text), 0);
        return { actualContentTokens:actual, reconstructedBeforeContentTokens:reconstructedBefore,
            deltaTokens:actual - reconstructedBefore, changedNotes:replacements };
    });
}
try {
    const args = Object.fromEntries(process.argv.slice(2).map(arg => { const i=arg.indexOf('='); return [arg.slice(2,i), arg.slice(i+1)]; }));
    assert.ok(args.before && args.after, '用法：node test/measure-template-delta.js --before=模板或卡 --after=模板或卡 [--request=实际请求文件]');
    const before = readTemplate(args.before), after = readTemplate(args.after);
    const structure = template => sheets(template).map(s => [s.name, s.content, s.sourceData.ddl]);
    const sameStructure = JSON.stringify(structure(before)) === JSON.stringify(structure(after));
    assert.ok(sameStructure, '当前对照要求表名、顺序、数据与 DDL 完全一致');
    const a=inventory(before), b=inventory(after);
    const result = { encoding:'o200k_base', scope:'sum of separate template components; not a full request or billing estimate', sameStructure,
        before:a, after:b, delta:{chars:b.total.chars-a.total.chars, tokens:b.total.tokens-a.total.tokens} };
    if (args.request) {
        result.requestScope='actual captured message content versus the same content with only changed notes replaced; baseline is reconstructed, excludes role/protocol overhead and output';
        result.requests=requestDelta(JSON.parse(fs.readFileSync(args.request,'utf8')), before, after);
    }
    console.log(JSON.stringify(result,null,2));
} finally { tokenizer.free(); }
