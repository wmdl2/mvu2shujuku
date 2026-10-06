'use strict';
const vm = require('vm');
const { test } = require('./runner');
const { core, assert } = require('./helpers');
const createResultView = require('../src/result-view');
const factory = require('../src/conversion-profiles');

const sheets = result => Object.keys(result.template || {}).filter(key => key.startsWith('sheet_'))
    .map(key => ({ uid: key, sheet: result.template[key] })).filter(row => row.sheet && typeof row.sheet === 'object');
const baseTemplate = () => ({
    mate: { type: 'chatSheets', version: 2 },
    sheet_base: { uid: 'sheet_base', name: '状态表', content: [['row_id', '值'], [1, 1]],
        updateConfig: { updateFrequency: 1 }, exportConfig: { injectIntoWorldbook: false } },
});
const ref = (source, uid, name, fingerprint = '') => ({ source: { value: source }, uid, name, fingerprint });
const tools = readTemplateSource => factory({ core, resultView: createResultView(), readTemplateSource, listSheets: sheets });

test('配置预设：用户指定频率优先于新生成只读表的默认零频率', async () => {
    const result = core.convert({ name: '只读配置', character_book: { entries: [
        { comment: '[InitVar]', content: '{"_版本":1}', enabled: false },
    ] } });
    const row = sheets(result).find(row => row.sheet.name === '_版本表');
    assert.strictEqual(row.sheet.updateConfig.updateFrequency, 0);
    const plan = await tools(async () => null).planProfile({ template: result.template,
        profile: { tableConfigs: { _版本表: { updateFrequency: 7 } }, externalTables: [] }, name: '用户配置' });
    assert.strictEqual(plan.template[row.uid].updateConfig.updateFrequency, 7);
    assert.strictEqual(row.sheet.updateConfig.updateFrequency, 0, '应用配置不修改默认模板');
});

test('转换配置：保存沿用版本 1 字段、真实视图设置与来源副本', () => {
    const data = baseTemplate();
    const refs = [ref('global', 'sheet_ext', '外部表')];
    const before = JSON.stringify(data);
    const profile = tools(async () => null).captureProfile({ name: '测试配置', result: { template: data }, appliedRefs: refs, updatedAt: '2026-09-26T00:00:00.000Z' });
    assert.strictEqual(profile.format, 'mvu2shujuku-conversion-profile');
    assert.strictEqual(profile.version, 1);
    assert.strictEqual(profile.tableConfigs.状态表.updateFrequency, 1);
    assert.strictEqual(profile.tableConfigs.状态表.injectIntoWorldbook, false);
    assert.strictEqual(profile.updatedAt, '2026-09-26T00:00:00.000Z');
    refs[0].name = '已改名';
    assert.strictEqual(profile.externalTables[0].name, '外部表');
    assert.strictEqual(JSON.stringify(data), before);
});

test('转换配置：按来源读取最新版、唯一同名回退，冲突与缺失要求确认且不改输入', async () => {
    const sourceA = {
        sheet_new_a: { uid: 'sheet_new_a', name: '外部甲', content: [['row_id', '内容'], [1, '甲']] },
        sheet_b: { uid: 'sheet_b', name: '外部乙', content: [['row_id', '内容'], [1, '乙']] },
    };
    const sourceB = { sheet_other: { uid: 'sheet_other', name: '外部甲' } };
    const ambiguous = { sheet_1: { name: '重名' }, sheet_2: { name: '重名' } };
    const sources = { global: sourceA, chat: sourceB, ambig: ambiguous };
    const reads = [];
    const helper = tools(async value => { reads.push(value); if (value === 'broken') throw Error('不可用'); return sources[value] || null; });
    const template = baseTemplate();
    const profile = {
        tableConfigs: { 状态表: { contextDepth: 4 }, 外部甲: { updateFrequency: 7, injectIntoWorldbook: false } },
        externalTables: [
            ref('global', 'sheet_old_a', '外部甲', '旧指纹'), ref('global', 'sheet_b', '外部乙'),
            ref('chat', 'sheet_other', '外部甲'), ref('ambig', 'sheet_old', '重名'), ref('broken', 'sheet_x', '失效表'),
        ],
    };
    const beforeTemplate = JSON.stringify(template), beforeProfile = JSON.stringify(profile), beforeA = JSON.stringify(sourceA);
    const plan = await helper.planProfile({ template, profile, name: '测试配置' });
    assert.deepStrictEqual(reads, ['global', 'chat', 'ambig', 'broken'], '同一来源只读取一次');
    assert.deepStrictEqual(plan.refs.map(item => [item.source.value, item.name, item.uid]),
        [['global', '外部甲', 'sheet_new_a'], ['global', '外部乙', 'sheet_b']]);
    assert.strictEqual(plan.stats.externalRequested, 5);
    assert.strictEqual(plan.stats.externalAdded, 2);
    assert.strictEqual(plan.stats.externalProblems, 3);
    assert.strictEqual(plan.needsConfirm, true);
    assert.ok(plan.notes.includes('来源已更新：外部甲'));
    assert.ok(plan.notes.includes('同名冲突已跳过：外部甲（chat）'));
    assert.ok(plan.notes.includes('未找到外部表：重名'));
    assert.ok(plan.notes.includes('来源不可用：broken'));
    assert.strictEqual(plan.template.sheet_base.updateConfig.contextDepth, 4);
    assert.strictEqual(plan.template.sheet_new_a.updateConfig.updateFrequency, 7, '外部表合并后应用配置');
    assert.strictEqual(plan.template.sheet_new_a.exportConfig.injectIntoWorldbook, false);
    assert.strictEqual(JSON.stringify(template), beforeTemplate);
    assert.strictEqual(JSON.stringify(profile), beforeProfile);
    assert.strictEqual(JSON.stringify(sourceA), beforeA);
});

test('转换配置：旧配置不覆盖注入选项，空配置与半数以下匹配触发原确认阈值', async () => {
    const helper = tools(async () => null);
    const old = await helper.planProfile({ template: baseTemplate(), profile: { tableConfigs: { 状态表: { updateFrequency: 8 } } }, name: '旧配置' });
    assert.strictEqual(old.template.sheet_base.exportConfig.injectIntoWorldbook, false);
    assert.strictEqual(old.template.sheet_base.updateConfig.updateFrequency, 8);
    assert.strictEqual(old.needsConfirm, false);
    const empty = await helper.planProfile({ template: baseTemplate(), profile: { tableConfigs: {}, externalTables: [] }, name: '空配置' });
    assert.strictEqual(empty.needsConfirm, true);
    const half = await helper.planProfile({ template: baseTemplate(), profile: { tableConfigs: { 状态表: {}, 不存在: {} } }, name: '半数' });
    assert.strictEqual(half.needsConfirm, false);
    const mostlyMissing = await helper.planProfile({ template: baseTemplate(), profile: { tableConfigs: { 状态表: {}, 不存在: {}, 另一张: {} } }, name: '不匹配' });
    assert.strictEqual(mostlyMissing.needsConfirm, true);
    assert.strictEqual(mostlyMissing.summary, '配置：不匹配\n表格设置匹配：1/3 张表\n配置中本次不存在：不存在、另一张\n本次新表：无\n外部表：成功 0/0');
});

test('转换配置：重复来源引用沿用逐条匹配统计，不改变确认条件', async () => {
    const source = { sheet_a: { uid: 'sheet_a', name: '外部甲' } };
    const helper = tools(async () => source);
    const profile = { tableConfigs: {}, externalTables: [
        ref('global', 'sheet_a', '外部甲'), ref('global', 'sheet_a', '外部甲'),
    ] };
    const plan = await helper.planProfile({ template: baseTemplate(), profile, name: '重复来源' });
    assert.strictEqual(plan.refs.length, 2);
    assert.strictEqual(plan.stats.externalRequested, 2);
    assert.strictEqual(plan.stats.externalAdded, 2);
    assert.strictEqual(plan.stats.externalProblems, 0);
    assert.strictEqual(plan.needsConfirm, false);
    assert.deepStrictEqual(plan.notes, []);
});

test('手动合表：引用按来源和名称去重，仅返回待提交候选', () => {
    const helper = tools(async () => null);
    const template = baseTemplate();
    const sourceTemplate = { sheet_a: { uid: 'sheet_a', name: '外部甲', content: [['row_id', '内容'], [1, '新']] } };
    const priorRefs = [ref('global', 'old', '外部甲'), ref('chat', 'other', '外部甲')];
    const beforeTemplate = JSON.stringify(template), beforeSource = JSON.stringify(sourceTemplate), beforeRefs = JSON.stringify(priorRefs);
    const plan = helper.planManualMerge({ template, sourceTemplate, selected: ['sheet_a'], source: 'global', priorRefs });
    assert.deepStrictEqual(plan.merged.added, ['外部甲']);
    assert.strictEqual(plan.refs.length, 2);
    assert.strictEqual(plan.refs[0].uid, 'sheet_a');
    assert.strictEqual(plan.refs[1].source.value, 'chat');
    assert.strictEqual(plan.refs[1].uid, 'other');
    assert.strictEqual(JSON.stringify(template), beforeTemplate);
    assert.strictEqual(JSON.stringify(sourceTemplate), beforeSource);
    assert.strictEqual(JSON.stringify(priorRefs), beforeRefs, '确认成功前外部状态仍是原值');
});

test('转换配置：浏览器内联工厂无 Node 外部作用域', async () => {
    const inline = vm.runInNewContext('(' + factory.toString() + ')');
    const helper = inline({ core, resultView: createResultView(), readTemplateSource: async () => null, listSheets: sheets });
    const plan = await helper.planProfile({ template: baseTemplate(), profile: { tableConfigs: { 状态表: { updateFrequency: 6 } } }, name: 'VM' });
    assert.strictEqual(plan.template.sheet_base.updateConfig.updateFrequency, 6);
});
