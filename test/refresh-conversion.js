'use strict';
const { test } = require('./runner');
const { core, assert } = require('./helpers');
const clone = value => JSON.parse(JSON.stringify(value));
const input = () => ({ name: '产物刷新测试', first_mes: '你好', character_book: { entries: [
    { comment: '[InitVar]', content: '{状态:{生命:100,名字:"测试"},列表:[1,2,3]}' },
] }, extensions: { tavern_helper: { scripts: [] }, regex_scripts: [] } });
const marker = result => (result.card.data || result.card).extensions.mvu2shujuku;
const normalizedCard = result => JSON.stringify(result.card).split(marker(result).convertedAt).join('<转换标识>');
const firstSheet = template => Object.values(template).find(value => value && value.content);

test('产物刷新：参数编辑与完整转换生成相同卡片、桥和模板', () => {
    const card = input(), original = core.convert(card), oldCard = JSON.stringify(original.card);
    firstSheet(original.template).updateConfig.updateFrequency = 7;
    const refreshed = core.refreshConversion(original);
    const full = core.convert(card, { template: clone(original.template) });
    assert.strictEqual(normalizedCard(refreshed), normalizedCard(full));
    assert.deepStrictEqual(refreshed.template, full.template);
    assert.strictEqual(refreshed.schema, original.schema, '参数编辑应复用已解析结构');
    assert.strictEqual(refreshed.template, original.template, '参数编辑器持有的表引用不能失效');
    assert.strictEqual(JSON.stringify(original.card), oldCard, '旧的角色卡产物应保持完整快照');
    const embedded = (refreshed.card.data || refreshed.card).character_book.entries.find(e => (e.keys || []).includes('__ACU_TEMPLATE_DATA__'));
    assert.deepStrictEqual(JSON.parse(Buffer.from(embedded.content, 'base64').toString()), refreshed.template);
});

test('产物刷新：重复下载无改动直接复用产物，第二次编辑仍生效', () => {
    const original = core.convert(input()), sheet = firstSheet(original.template);
    assert.strictEqual(core.refreshConversion(original), original);
    sheet.updateConfig.updateFrequency = 3;
    const changed = core.refreshConversion(original);
    assert.notStrictEqual(changed, original);
    assert.strictEqual(core.refreshConversion(changed), changed);
    sheet.updateConfig.updateFrequency = 8;
    const again = core.refreshConversion(changed);
    assert.strictEqual(firstSheet(again.template).updateConfig.updateFrequency, 8);
    assert.ok(again.files.find(f => f.kind === 'template').data.includes('"updateFrequency": 8'));
});

test('产物刷新：合并新增表保留 MVU 布局并更新全部模板标记', () => {
    const card = input(), original = core.convert(card);
    const external = { sheet_extra: { uid: 'sheet_extra', name: '外部表', content: [['row_id', '值'], [1, '外部']] } };
    const merged = core.mergeTemplates(original.template, external, ['sheet_extra']).template;
    const refreshed = core.refreshConversion(original, { template: merged });
    const full = core.convert(card, { template: clone(merged) });
    assert.strictEqual(normalizedCard(refreshed), normalizedCard(full));
    assert.strictEqual(marker(refreshed).layout, marker(original).layout);
    assert.ok(marker(refreshed).templateUid.includes('sheet_extra'));
    assert.strictEqual(refreshed.meta.tableCount, original.meta.tableCount + 1);
});

test('产物刷新：转换规则变化回退完整分析，保留源角色身份', () => {
    const card = input(), original = core.convert(card);
    original.meta.sourceCharacter = { avatar: 'source.png' };
    const refreshed = core.refreshConversion(original, { nameSuffix: '_新后缀' });
    const full = core.convert(card, { template: clone(original.template), nameSuffix: '_新后缀' });
    assert.notStrictEqual(refreshed.schema, original.schema);
    assert.strictEqual(normalizedCard(refreshed), normalizedCard(full));
    assert.strictEqual(refreshed.meta.sourceCharacter.avatar, 'source.png');
});

test('产物刷新：切换 PNG 导出只重建文件，PNG 输入仍保留原格式', () => {
    const original = core.convert(input());
    const pngResult = core.refreshConversion(original, { asPng: true });
    assert.strictEqual(pngResult.card, original.card, '仅切换文件格式不应重新处理卡片');
    assert.strictEqual(pngResult.schema, original.schema);
    assert.strictEqual(pngResult.meta.isPngInput, false);
    assert.strictEqual(pngResult.meta.asPng, true);
    const bytes = pngResult.files.find(f => f.kind === 'card').data;
    assert.deepStrictEqual(core.parseCard(bytes), pngResult.card);
    const fromPng = core.convert(core.writeCardPng(bytes, input()));
    firstSheet(fromPng.template).updateConfig.updateFrequency = 9;
    const refreshed = core.refreshConversion(fromPng);
    assert.strictEqual(refreshed.meta.isPngInput, true);
    assert.strictEqual(refreshed.files.find(f => f.kind === 'card').mime, 'image/png');
    assert.deepStrictEqual(core.parseCard(refreshed.files.find(f => f.kind === 'card').data), refreshed.card);
});

test('产物刷新：保留配置摘要，重复刷新不增加报告内容', () => {
    const original = core.convert(input());
    original.reportText += '\n\n## 配置应用摘要\n\n频率已更新';
    firstSheet(original.template).updateConfig.updateFrequency = 4;
    const refreshed = core.refreshConversion(original);
    assert.strictEqual(refreshed.reportText, original.reportText);
    assert.strictEqual(refreshed.files.find(f => f.kind === 'report').data, refreshed.reportText);
    assert.strictEqual(core.refreshConversion(refreshed), refreshed);
});

test('产物刷新：已迁移的提示词不重复包裹，新表仍迁移', () => {
    const card = input();
    card.extensions.regex_scripts.push({ scriptName: '提示处理', findRegex: 'hello', replaceString: 'world', promptOnly: true, placement: [5] });
    const original = core.convert(card);
    const template = clone(original.template), sheet = firstSheet(template);
    sheet.sourceData.note = 'hello';
    const migrated = core.refreshConversion(original, { template });
    const prompt = firstSheet(migrated.template).sourceData.note;
    assert.ok(prompt.includes('mvu2shujukuApplyWorldInfoRegex'));
    firstSheet(migrated.template).updateConfig.updateFrequency = 6;
    const again = core.refreshConversion(migrated);
    assert.strictEqual(firstSheet(again.template).sourceData.note, prompt);
    assert.strictEqual(again.reportText, migrated.reportText);
});

test('产物刷新：规则变化使用首次输入快照，不读取被外部修改的原对象', () => {
    const card = input(), original = core.convert(card);
    card.name = '已被外部改名';
    card.character_book.entries = [];
    const refreshed = core.refreshConversion(original, { nameSuffix: '_另存' });
    assert.strictEqual((refreshed.card.data || refreshed.card).name, '产物刷新测试_另存');
});
