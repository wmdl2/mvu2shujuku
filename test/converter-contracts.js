'use strict';
const { test } = require('./runner');
const { core, assert, applyingApi } = require('./helpers');
const clone = value => JSON.parse(JSON.stringify(value));
function card(stat, type, rules) {
    return { name: '通用转换契约', character_book: { entries: [
        { comment: '[InitVar]', content: JSON.stringify(stat), enabled: false },
        ...(rules ? [{ comment: '[mvu_update]变量更新规则', content: rules }] : []),
    ] }, extensions: { tavern_helper: { scripts: type ? [
        { type: 'script', name: '变量结构', enabled: true, content: 'const Schema=z.object(' + type + ');registerMvuSchema(Schema);' },
    ] : [] } } };
}
async function roundTrip(input, before, after) {
    const result = core.convert(input, { targetSpVersion: 'naiv1.0.0' });
    const layout = JSON.parse(result.card.extensions.mvu2shujuku.layout), tables = clone(result.template);
    assert.deepStrictEqual(core.statDataFromTables(layout, tables).stat_data, before, '初始完整读回');
    const write = await core.writeStatDiffToDbResult(applyingApi(tables), layout, before, after, tables);
    assert.strictEqual(write.ok, true, '当前真实 writer 写入成功');
    assert.deepStrictEqual(core.statDataFromTables(layout, tables).stat_data, after, '写后完整读回');
    const restored = await core.writeStatDiffToDbResult(applyingApi(tables), layout, after, before, tables);
    assert.strictEqual(restored.ok, true);
    assert.deepStrictEqual(core.statDataFromTables(layout, tables).stat_data, before, '恢复原记录');
    return { result, layout, tables };
}
const values = [
    ['number', 'z.number()', 1, 2.5], ['string', 'z.string()', '初始', '更新'],
    ['boolean', 'z.boolean()', false, true], ['nullable', 'z.string().nullable()', null, '新值'],
    ['array', 'z.array(z.number())', [1, 2], [3, 4]],
    ['object', 'z.object({值:z.number()})', { 值: 1 }, { 值: 2 }],
    ['record', 'z.record(z.string(),z.string())', { 甲: '一' }, { 甲: '二', 乙: '三' }],
];
for (const [label, type, first, next] of values) for (const nested of [false, true]) for (const empty of [false, true]) {
    test(`转换契约：${nested ? '嵌套' : '根层'} ${label} 字典 ${empty ? '空' : '非空'} 初值/写入/恢复`, async () => {
        const wrap = value => nested ? { 组: { 记录: value } } : { 记录: value };
        const schema = nested ? '{组:z.object({记录:z.record(z.string(),' + type + ')})}' : '{记录:z.record(z.string(),' + type + ')}';
        const before = wrap(empty ? {} : { 普通: first }), after = wrap({ 普通: next });
        await roundTrip(card(before, schema), before, after);
    });
}
for (const key of ['甲.乙', '', '__proto__', 'constructor', '甲/乙', '甲~乙']) for (const scalar of [false, true]) {
    test(`转换契约：字面键 ${JSON.stringify(key)} ${scalar ? '标量' : '对象'} 完整生命周期`, async () => {
        const value = n => scalar ? n : { 数值: n };
        const stat = n => ({ 记录: Object.fromEntries([[key, value(n)]]) });
        const schema = '{记录:z.record(z.string(),' + (scalar ? 'z.number()' : 'z.object({数值:z.number()})') + ')}';
        await roundTrip(card(stat(1), schema), stat(1), stat(2));
        await roundTrip(card({ 记录: {} }, schema), { 记录: {} }, stat(1));
        assert.strictEqual(Object.prototype.数值, undefined, '字典写入不得修改全局原型');
    });
}
for (const parentKey of ['甲.乙', '']) test('转换契约：多层关系表字面祖先键 ' + JSON.stringify(parentKey) + '、空子键和溢出字段不互相覆盖', async () => {
    const schema = '{记录:z.record(z.string(),z.object({值:z.number(),子:z.record(z.string(),z.object({值:z.number()}))}))}';
    const before = { 记录: {} }, after = { 记录: { [parentKey]: { 值: 2, 子: { '': { 值: 3, '补.充': { '__literal': true } } } } } };
    await roundTrip(card(before, schema), before, after);
});
function ruleResult(stat, text) {
    const r = core.convert(card(stat, '', text));
    return { result: r, body: r.card.character_book.entries.find(e => e.comment === '[mvu_update]变量更新规则')?.content || '',
        note: Object.values(r.template).filter(t => t.sourceData).map(t => t.sourceData.note).join('\n') };
}
for (const field of ['_只读', '$私有']) test('转换契约：未进入填表说明的规则保留原文 ' + field, () => {
    const marker = 'EXCLUSIVE_RULE_RECEIPT';
    const { body, note } = ruleResult({ 状态: { [field]: 1, 可写: 2 } }, '变量更新规则:\n  状态:\n    ' + field + ':\n      check: ' + marker);
    assert.match(body, /EXCLUSIVE_RULE_RECEIPT/); assert.doesNotMatch(note, /EXCLUSIVE_RULE_RECEIPT/);
});
test('转换契约：同文异路径不能互相充当迁移凭证', () => {
    const { body, note } = ruleResult({ 状态: { _只读: 1, 可写: 2 } }, '变量更新规则:\n  状态:\n    _只读:\n      check: SAME_TEXT_RECEIPT\n    可写:\n      check: SAME_TEXT_RECEIPT');
    assert.match(body, /_只读/); assert.doesNotMatch(body, /可写:/); assert.match(note, /SAME_TEXT_RECEIPT/);
});
test('转换契约：未知声明对象不随已承接check连带删除', () => {
    const { body, note } = ruleResult({ 状态: { 数量: 2 } }, '变量更新规则:\n  状态:\n    数量:\n      type:\n        自定义说明: UNKNOWN_TYPE_PAYLOAD\n      check: 数量变化时更新');
    assert.match(body, /UNKNOWN_TYPE_PAYLOAD/); assert.doesNotMatch(body, /数量变化时更新/); assert.match(note, /数量变化时更新/);
});
test('转换契约：有限绑定使用解析展开凭证，全部承接后移除源节点', () => {
    const { body, note } = ruleResult({ 面板: { 属性: { 灵巧: 1, 坚韧: 2 } } }, '变量更新规则:\n  面板.属性.${维度}:\n    维度: [灵巧, 坚韧]\n    check: 更新须有依据');
    assert.strictEqual(body, ''); assert.match(note, /更新须有依据/);
});
test('转换契约：自定义模板没有实际承接约束时保留有限绑定来源', () => {
    const input = card({ 面板: { 属性: { 灵巧: 1, 坚韧: 2 } } }, '', '变量更新规则:\n  面板.属性.${维度}:\n    维度: [灵巧, 坚韧]\n    check: PARTIAL_FINITE_RECEIPT');
    const template = clone(core.convert(input).template);
    for (const sheet of Object.values(template)) if (sheet.sourceData) sheet.sourceData.note = sheet.sourceData.note.replaceAll('PARTIAL_FINITE_RECEIPT', '用户自定义说明');
    const r = core.convert(input, { template });
    assert.match(r.card.character_book.entries.find(e => e.comment === '[mvu_update]变量更新规则').content, /PARTIAL_FINITE_RECEIPT/);
});
test('转换契约：多层有限绑定的子字段保留原来源路径，承接后整节点清理', () => {
    const { body, note } = ruleResult({ 面板: { 甲: { 值: 1 }, 乙: { 值: 2 } } }, '变量更新规则:\n  面板.${项}:\n    项: [甲, 乙]\n    值:\n      check: NESTED_FINITE_RECEIPT');
    assert.strictEqual(body, ''); assert.match(note, /NESTED_FINITE_RECEIPT/);
});
test('转换契约：提醒数组按实际输出逐项拆分，未知标题与私有提醒保留', () => {
    const { body, note } = ruleResult({ 状态: { 数量: 2 } }, '变量更新规则:\n  _强制更新提醒:\n    - 状态.数量 — 出现变化时更新\n    - 状态 — 每轮核对数量\n    - 未知分组标题\n    - $私有 — 由脚本更新\n  状态:\n    数量:\n      check: 数量变化时更新');
    assert.doesNotMatch(body, /出现变化时更新|每轮核对数量|数量变化时更新/);
    assert.match(body, /未知分组标题/); assert.match(body, /\$私有/); assert.match(note, /出现变化时更新|每轮核对数量/);
});
test('转换契约：禁用结构脚本仅参考类型，不补默认值；InitVar禁用仍生效', () => {
    const input = card({ 状态: {} }, '{状态:z.object({数量:z.number().default(42)})}');
    input.extensions.tavern_helper.scripts[0].enabled = false;
    let r = core.convert(input);
    assert.deepStrictEqual(core.statDataFromTables(JSON.parse(r.card.extensions.mvu2shujuku.layout), r.template).stat_data, { 状态: {} });
    assert.match(r.reportText, /禁用.*仅作结构参考.*不补默认初值/);
    input.extensions.tavern_helper.scripts[0].enabled = true;
    r = core.convert(input);
    assert.deepStrictEqual(core.statDataFromTables(JSON.parse(r.card.extensions.mvu2shujuku.layout), r.template).stat_data, { 状态: { 数量: 42 } });
});
test('转换契约：任意transform明确列为人工项且不执行', () => {
    const input = card({ 状态: { 数量: 1 } }, '{状态:z.object({数量:z.number().transform(n=>{throw new Error("不得执行");})})}');
    const r = core.convert(input);
    assert.match(r.reportText, /无法静态等价迁移的 transform/); assert.match(r.reportText, /不会执行/);
});
test('转换契约：启用声明优先于禁用参考，不受脚本顺序影响', () => {
    for (const disabledFirst of [false, true]) {
        const input = card({ 状态: {} }, '{状态:z.object({数量:z.number().default(42)})}');
        const active = input.extensions.tavern_helper.scripts[0];
        const disabled = { ...active, enabled: false, name: '旧结构', content: 'const Schema=z.object({状态:z.object({数量:z.string().default("旧值")})});registerMvuSchema(Schema);' };
        input.extensions.tavern_helper.scripts = disabledFirst ? [disabled, active] : [active, disabled];
        const r = core.convert(input);
        assert.deepStrictEqual(core.statDataFromTables(JSON.parse(r.card.extensions.mvu2shujuku.layout), r.template).stat_data, { 状态: { 数量: 42 } });
    }
});
test('转换契约：XML包裹的完整结构输出移除，混合正文与EJS保留', () => {
    const source = '<Format>\nForce_Structured_Output:\n  output_rule:\n    - Reply only with the legacy update block.\n  output_format: |-\n    <UpdateVariable>\n    <JSONPatch>[]</JSONPatch>\n    </UpdateVariable>\n</Format>';
    for (const [text, retained] of [[source.replace('  output_rule:\n    - Reply only with the legacy update block.\n', ''), false], ['剧情说明\n' + source, true], [source + '\n<% if (true) { %>业务<% } %>', true]]) {
        const input = card({ 状态: { 数量: 1 } });
        input.character_book.entries.push({ comment: '[mvu_update]output_format', content: text, enabled: true, constant: true });
        const r = core.convert(input), e = r.card.character_book.entries.find(e => e.comment === '[mvu_update]output_format');
        assert.strictEqual(!!e, retained);
        if (!retained) assert.doesNotMatch(r.reportText, /YAML 解析失败/);
        else assert.match(r.reportText, /无法确认整条仅负责输出协议/);
    }
});
