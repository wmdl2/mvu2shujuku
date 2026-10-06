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
test('输出约束：格式块移除，未知补充规则保留并报告', () => {
    const rules = ['数量不能少于零，清空时保留等级记录', 'When a typed variable requires an empty state, assign a concrete empty value. Do not use null.', 'When updating variables, preserve EVERY piece of information verbatim', '不得把 JSONPatch 阵营的物品移出仓库'];
    const r = run(output(rules));
    const entry = r.card.character_book.entries.find(e => e.comment.includes('变量输出规则'));
    assert(entry);
    for (const rule of rules) assert(entry.content.includes(rule));
    assert.doesNotMatch(entry.content, /<UpdateVariable>|<JSONPatch>/);
    assert.match(entry.content, /旧输出语法由数据库填表协议接管/);
    assert.match(r.reportText, /剩余内容未迁入填表侧/);
});
test('输出约束：未知字段不因短长措辞或协议名而整条删除', () => {
    for (const delta of ['update the value of existing number paths by a delta value', 'update the value of existing number paths by a delta value (the delta value MUST be a number without quotes)']) {
        const content = '变量输出格式:\n  rule:\n    - JSON Patch:\n        - delta: '+delta+'\n    - 字段只读要求\n  format: |-\n'+format.split('\n').map(x=>'    '+x).join('\n');
        const r = run(content, '[mvu_update]变量输出格式');
        const entry = r.card.character_book.entries.find(e=>e.comment.includes('变量输出格式'));
        assert(entry.content.includes(delta));
        assert(entry.content.includes('字段只读要求'));
        assert.doesNotMatch(entry.content, /<UpdateVariable>|<JSONPatch>/);
    }
});
test('输出约束：EJS、不可解析或混入格式块的业务内容保守保留', () => {
    for (const text of [output(['数量不能少于零'])+'\n<% if (true) { %>业务<% } %>', '每轮必须输出<UpdateVariable>，库存低于零时禁止更新', 'variables_update_format:\n  format: |-\n    库存不得低于零\n    '+format]) {
        assert.ok(run(text, '变量输出规则').card.character_book.entries.some(e=>e.content === text));
    }
});
test('输出约束：剧情条目和非输出文档不因名称或关键词删除', () => {
    for (const [text,title] of [[output(['库存不可清空']),'[mvu_plot]变量输出格式'], ['JSONPatch 阵营的商人不出售违禁品','[mvu_update]变量输出格式']]) {
        const r = run(text,title);
        assert.ok(r.card.character_book.entries.some(e=>e.comment===title && e.content===text));
    }
});

function ruleEntry(result) {
    return result.card.character_book.entries.find(e => e.comment === '[mvu_update]变量更新规则');
}
test('规则拆分：已迁移字段移除，任意未匹配分组及注入设置保留', () => {
    const content = '变量更新规则:\n  状态:\n    数量:\n      type: number\n      range: 0~10\n      check: 数量变化时更新\n  任意分组:\n    # 保留此处的补充说明\n    check: 发现占位值时按设定补全\n';
    const card = { name: '规则拆分', character_book: { entries: [
        { comment: '[InitVar]', content: '{状态:{数量:1}}' },
        { comment: '[mvu_update]变量更新规则', content, enabled: true, constant: true, extensions: { position: 4, depth: 2 } },
    ] } };
    const result = core.convert(card);
    const entry = ruleEntry(result);
    assert.ok(entry);
    assert.doesNotMatch(entry.content, /数量变化时更新|状态:/);
    assert.match(entry.content, /任意分组:|发现占位值时按设定补全|保留此处的补充说明/);
    assert.ok(entry.content.includes('发现占位值时按设定补全'));
    assert.strictEqual(entry.constant, true);
    assert.deepStrictEqual(entry.extensions, { position: 4, depth: 2 });
    assert.ok(Object.values(result.template).some(t => t.sourceData && t.sourceData.note.includes('数量变化时更新')));
    assert.match(result.reportText, /剩余内容未迁入填表侧.*仍按原世界书设置注入/);
});
test('规则拆分：同文异路径不误删，未承接列表完整保留', () => {
    const content = '变量更新规则:\n  状态:\n    数量:\n      check: 数量变化时更新\n    不存在字段:\n      check:\n        - 数量变化时更新\n        - 无法定位的业务要求\n  任意分组:\n    check: 数量变化时更新\n';
    const result = run(content, '[mvu_update]变量更新规则');
    const entry = ruleEntry(result);
    assert.ok(entry);
    assert.doesNotMatch(entry.content, /数量:\n/);
    assert.match(entry.content, /不存在字段:/);
    assert.match(entry.content, /任意分组:/);
    assert.strictEqual((entry.content.match(/数量变化时更新/g) || []).length, 2);
    assert.match(entry.content, /无法定位的业务要求/);
});
test('规则拆分：未知补充字段保留，别名共享节点不拆分', () => {
    const content = '变量更新规则:\n  状态:\n    数量:\n      check: 数量变化时更新\n      补充要求: 更新前确认叙事依据\n';
    const entry = ruleEntry(run(content, '[mvu_update]变量更新规则'));
    assert.match(entry.content, /补充要求: 更新前确认叙事依据/);
    assert.doesNotMatch(entry.content, /数量变化时更新/);
    const aliased = '变量更新规则:\n  状态:\n    数量: &rule\n      check: 数量变化时更新\n  未知组:\n    值: *rule\n';
    assert.strictEqual(ruleEntry(run(aliased, '[mvu_update]变量更新规则')).content, aliased);
});
test('规则拆分：点路径及所属组的相对规则按迁移证据移除', () => {
    const content = '变量更新规则:\n  状态:\n    嵌套.指标:\n      type: "{ 数量: number; 备注: string }"\n      check: 指标变化时同步记录\n  补充组:\n    check: 未承接要求\n';
    const r = core.convert({ name: '点路径规则', character_book: { entries: [
        { comment: '[InitVar]', content: '{状态:{嵌套:{指标:{数量:1,备注:""}}}}' },
        { comment: '[mvu_update]变量更新规则', content },
    ] } });
    assert.ok(Object.values(r.template).some(t => t.sourceData && t.sourceData.note.includes('指标变化时同步记录')));
    assert.doesNotMatch(ruleEntry(r).content, /指标变化时同步记录|嵌套\.指标/);
    assert.match(ruleEntry(r).content, /未承接要求/);
});
test('规则拆分：全部迁移删除整条，EJS和解析失败保留原文', () => {
    const content = '变量更新规则:\n  状态:\n    数量:\n      check: 数量变化时更新\n';
    assert.ok(!ruleEntry(run(content, '[mvu_update]变量更新规则')));
    for (const mixed of [content + '<% print("剧情") %>', content + '坏字段: [']) {
        assert.strictEqual(ruleEntry(run(mixed, '[mvu_update]变量更新规则')).content, mixed);
    }
});
