'use strict';
const { test } = require('./runner');
const { core, assert } = require('./helpers');

function simpleCard() {
    return { name: '提示精简测试', first_mes: '开场', character_book: { entries: [
        { comment: '[InitVar]', content: JSON.stringify({ obj: { visible: 1, other: 2 } }) },
    ] } };
}

test('字段说明保真：同范围各列保留各自描述、单位与格式，不合并归属', () => {
    for (const descriptions of [['左侧防御消耗', '右侧攻击消耗'], ['', '右侧攻击消耗'], ['每轮消耗一点', '每轮消耗一点']]) {
        const card = { name: '字段说明', first_mes: '', character_book: { entries: [{ comment: '[InitVar]',
            content: JSON.stringify({ 状态: { 左臂能量: 5, 右臂能量: 5 } }) }] }, extensions: { tavern_helper: { scripts: [{
                name: '结构', content: `const S=z.object({状态:z.object({左臂能量:z.number().min(0).max(10).describe(${JSON.stringify(descriptions[0])}),右臂能量:z.number().min(0).max(10).describe(${JSON.stringify(descriptions[1])})})});registerMvuSchema(S);`,
            }] } } };
        for (const mode of ['both', 'native', 'sqlite']) {
            const result = core.convert(card, { mode });
            const sheet = Object.values(result.template).find(s => s.name === '状态表');
            const note = sheet.sourceData.note;
            const left = note.split('- 左臂能量：')[1].split('- 右臂能量：')[0];
            const right = note.split('- 右臂能量：')[1];
            assert.ok(left.includes(descriptions[0]) && right.includes(descriptions[1]));
            assert.match(left, /数值范围 0~10/);
            assert.match(right, /数值范围 0~10/);
            assert.doesNotMatch(note, /\$\{左\|右\}/);
            assert.ok(sheet.content[0].includes('左臂能量') && sheet.sourceData.ddl.includes('-- 右臂能量'));
        }
    }
});

test('字段说明保真：VWD 描述的独有条件和多行说明保留在所属字段', () => {
    const card = { name: 'VWD说明', first_mes: '', character_book: { entries: [{ comment: '[InitVar]',
        content: JSON.stringify({ 状态: { 左侧: [5, '单位：点\n防御后扣减'], 右侧: [5, '单位：点\n攻击后扣减'] } }) }] } };
    const result = core.convert(card);
    const sheet = Object.values(result.template).find(s => s.name === '状态表');
    assert.match(sheet.sourceData.note, /左侧：单位：点\n  防御后扣减/);
    assert.match(sheet.sourceData.note, /右侧：单位：点\n  攻击后扣减/);
    assert.match(sheet.sourceData.note, /【字段说明与规则】/);
    const plain = Object.values(core.convert(simpleCard()).template).find(s => s.name === 'obj表');
    assert.doesNotMatch(plain.sourceData.note, /【字段说明与规则】\s*更新以正文/);
});

test('字段说明保真：只读业务描述可读，关联标识的独有说明不因字段职责丢失', () => {
    const result = core.convert({ name: '说明职责', first_mes: '', character_book: { entries: [{ comment: '[InitVar]',
        content: JSON.stringify({ 状态: { _冷却: [2, '单位为回合；由脚本倒数'], 备注: '无' } }) }] } });
    const sheet = Object.values(result.template).find(s => s.name === '状态表');
    assert.match(sheet.sourceData.note, /只读字段「_冷却」说明：单位为回合；由脚本倒数/);
    assert.match(sheet.sourceData.note, /严禁更新/);
    const g = result.schema[0];
    g.kind = 'nestedRows'; g.keyCol = '备注'; g.parentKeyCol = '_冷却';
    g.ancestorKeyCols = [{ col: '_冷却', parentTable: '来源表', parentKeyCol: '标识' }];
    g.columns.find(c => c.zh === '备注').desc = '使用作者给定的稳定编号，不能改为昵称';
    const related = Object.values(core.generateTemplate([g])).find(s => s.sourceData);
    assert.match(related.sourceData.note, /备注：使用作者给定的稳定编号，不能改为昵称/);
});

test('表格提示：移除纯列映射但保留自定义规则，三种模式数据与 DDL 不变', () => {
    const results = Object.fromEntries(['native', 'both', 'sqlite'].map(mode => [mode, core.convert(simpleCard(), { mode })]));
    for (const mode of Object.keys(results)) {
        const result = results[mode];
        const group = result.schema.find(g => g.name === 'obj');
        group.columns.find(c => c.zh === 'visible').check = ['剧情变化时才更新'];
        const template = core.generateTemplate(result.schema, { mode, report: { warnings: [], warn() {}, note() {} } });
        const sheet = Object.values(template).find(t => t.name === 'obj表');
        assert.doesNotMatch(sheet.sourceData.note, /【列定义】|visible visible|other other/);
        assert.match(sheet.sourceData.note, /剧情变化时才更新/);
        assert.deepStrictEqual(sheet.content, result.template[Object.keys(result.template).find(k => result.template[k].name === 'obj表')].content);
        assert.strictEqual(sheet.sourceData.ddl, result.template[Object.keys(result.template).find(k => result.template[k].name === 'obj表')].sourceData.ddl);
    }
});

test('表格提示：统一关联字段名称，完整定位并明确同步删除和标识变更', () => {
    const card = { name: '关系提示测试', first_mes: '开场', character_book: { entries: [
        { comment: '[InitVar]', content: JSON.stringify({ 关系: { 甲: { 背包: { 药: { 效果: { 疗愈: { 描述: '好' } } } } } } }) },
        { comment: '[mvu_update]', content: '变量更新规则:\n  关系:\n    type: |-\n      { [名称: string]: { 背包: { [物品: string]: { 效果: { [效果: string]: { 描述: string; } } } } } }' },
    ] } };
    const result = core.convert(card, { mode: 'native' });
    const child = Object.values(result.template).find(t => t && typeof t.name === 'string' && t.name.includes('背包'));
    assert.ok(child, '应生成关系子表');
    assert.match(child.sourceData.note, /关联字段：/);
    assert.match(child.sourceData.note, /删除.*对应记录/);
    assert.match(child.sourceData.note, /标识值变更.*关联字段/);
    assert.match(child.sourceData.note, /请在本次填表中完成/);
    for (const group of result.schema.filter(g => g.kind === 'nestedRows')) {
        const sheet = Object.values(result.template).find(t => t.name === group.tableName);
        const locator = sheet.sourceData.note.split('\n').find(line => line.startsWith('定位记录须'));
        for (const key of [...group.ancestorKeyCols.map(a => a.col), group.keyCol]) assert.ok(locator.includes(`「${key}」`));
        assert.doesNotMatch(Object.values(sheet.sourceData).join('\n'), /父键|祖先键|关系键|父表|子表|FOREIGN KEY/);
    }
});
