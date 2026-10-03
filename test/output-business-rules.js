'use strict';
const { test } = require('./runner');
const { core, assert } = require('./helpers');
const format = '<UpdateVariable>\n<JSONPatch>[]</JSONPatch>\n</UpdateVariable>';
function run(content, title = '[本体][变量][mvu_update]变量输出规则') {
    return core.convert({ name: '输出文档保真', character_book: { entries: [
        { comment: '[InitVar]', content: '{状态:{数量:1}}' }, { comment: title, content },
    ] } });
}
const output = rules => 'variables_update_format:\n  rule:\n' + rules.map(r=>'    - '+JSON.stringify(r)).join('\n') + '\n  format: |-\n' + format.split('\n').map(x=>'    '+x).join('\n');
test('输出约束：中文业务条件、类型空值和信息保真规则保留，移除旧格式', () => {
    const rules = ['数量不能少于零，清空时保留等级记录', 'When a typed variable requires an empty state, assign a concrete empty value. Do not use null.', 'When updating variables, preserve EVERY piece of information verbatim', '不得把 JSONPatch 阵营的物品移出仓库'];
    const r = run(output(rules)), text = r.card.character_book.entries.map(e=>e.content).join('\n');
    const preserved = r.card.character_book.entries.find(e=>e.comment.includes('保留数据约束'));
    const decoded = require('../src/vendor/mvu-yaml-libs').YAML.parse(preserved.content.slice(preserved.content.indexOf('\n')+1));
    assert.deepStrictEqual(decoded.rule, rules);
    assert.ok(!text.includes('<JSONPatch>'));
    assert.ok(r.reportText.includes('数据约束保留'));
});
test('输出约束：纯格式和完整已知输出机制删除，未知规则不按关键词删', () => {
    const r = run(output(['You MUST output the update analysis and the actual update commands at once in the end of the next reply']), '变量输出规则');
    assert.ok(!r.card.character_book.entries.some(e=>e.comment.includes('变量输出规则')));
    const mixed = run(output(['每轮输出 JSON Patch 时必须先核对库存']), '变量输出规则');
    assert.ok(mixed.card.character_book.entries.some(e=>e.content.includes('必须先核对库存')));
});
test('输出约束：EJS、不可解析或混入格式块的业务内容保守保留', () => {
    for (const text of [output(['数量不能少于零'])+'\n<% if (true) { %>业务<% } %>', '每轮必须输出<UpdateVariable>，库存低于零时禁止更新', 'variables_update_format:\n  format: |-\n    库存不得低于零\n    '+format]) {
        assert.ok(run(text, '变量输出规则').card.character_book.entries.some(e=>e.content === text));
    }
});
