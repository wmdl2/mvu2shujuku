'use strict';
const { test } = require('./runner');
const { core, assert } = require('./helpers');
const vm = require('vm');
const factory = require('../src/result-view');

test('结果设置：浏览器内联工厂自足，默认读取不改模板', () => {
    const create = vm.runInNewContext('(' + factory.toString() + ')');
    const view = create();
    const sheet = { name: '状态表' }, before = JSON.stringify(sheet);
    const config = view.captureConfig(sheet);
    assert.strictEqual(config.updateFrequency, -1);
    assert.strictEqual(config.injectIntoWorldbook, true);
    assert.strictEqual(JSON.stringify(sheet), before);
});

test('结果设置：世界书开关只改变主注入字段，保留导出方式和额外索引', () => {
    const view = factory(), sheet = { exportConfig: { enabled: true, splitByRow: true, extraIndexEnabled: true, entryName: '原名' } };
    view.setInjection(sheet, false);
    assert.deepStrictEqual(sheet.exportConfig, { enabled: true, splitByRow: true, extraIndexEnabled: true, entryName: '原名', injectIntoWorldbook: false });
    assert.strictEqual(view.captureConfig(sheet).injectIntoWorldbook, false);
    view.setInjection(sheet, true);
    assert.strictEqual(view.getInjection(sheet), true);
});

test('结果设置：旧配置不覆盖注入选项，新配置保留显式 false', () => {
    const view = factory(), sheet = { updateConfig: { groupId: 2 }, exportConfig: { injectIntoWorldbook: false } };
    view.applyConfig(sheet, { updateFrequency: 7 });
    assert.strictEqual(view.getInjection(sheet), false);
    assert.strictEqual(sheet.updateConfig.groupId, 2);
    view.applyConfig(sheet, { injectIntoWorldbook: 'true' });
    assert.strictEqual(view.getInjection(sheet), false);
    const next = { exportConfig: { entryName: '另一条目' } };
    view.applyConfig(next, view.captureConfig(sheet));
    assert.strictEqual(next.exportConfig.injectIntoWorldbook, false);
    assert.strictEqual(next.exportConfig.entryName, '另一条目');
    assert.strictEqual(next.updateConfig.updateFrequency, 7);
});

test('结果设置：只写已登记参数，空值沿用全局，零值仍可停用', () => {
    const view = factory(), sheet = {};
    view.setParam(sheet, 'updateFrequency', 0);
    assert.strictEqual(sheet.updateConfig.updateFrequency, 0);
    view.setParam(sheet, 'contextDepth', '');
    assert.strictEqual(sheet.updateConfig.contextDepth, -1);
    view.setParam(sheet, 'contextDepth', -8);
    assert.strictEqual(sheet.updateConfig.contextDepth, -1);
    view.setParam(sheet, '__proto__', { polluted: true });
    assert.strictEqual(sheet.updateConfig.polluted, undefined);
});

test('结果设置：刷新卡内模板保留多表参数与注入设置，不改变 layout 和数据', () => {
    const view = factory(), result = core.convert(require('./frontend-card')());
    const data = result.card.data || result.card;
    const layoutBefore = data.extensions.mvu2shujuku.layout;
    const keys = Object.keys(result.template).filter(key => key.startsWith('sheet_'));
    assert.ok(keys.length >= 3);
    const contentBefore = keys.map(key => JSON.stringify(result.template[key].content));
    for (const key of [keys[0], keys[2]]) view.applyConfig(result.template[key], { contextDepth: 8, injectIntoWorldbook: false });
    const untouched = JSON.stringify(result.template[keys[1]]);
    const fresh = core.refreshConversion(result, { template: result.template });
    const freshData = fresh.card.data || fresh.card;
    assert.strictEqual(freshData.extensions.mvu2shujuku.layout, layoutBefore);
    const entry = freshData.character_book.entries.find(e => e.keys && e.keys.includes('__ACU_TEMPLATE_DATA__'));
    const decoded = JSON.parse(Buffer.from(entry.content, 'base64').toString('utf8'));
    for (const key of [keys[0], keys[2]]) {
        assert.strictEqual(decoded[key].updateConfig.contextDepth, 8);
        assert.strictEqual(decoded[key].exportConfig.injectIntoWorldbook, false);
    }
    assert.strictEqual(JSON.stringify(decoded[keys[1]]), untouched);
    assert.deepStrictEqual(keys.map(key => JSON.stringify(decoded[key].content)), contentBefore);
});
