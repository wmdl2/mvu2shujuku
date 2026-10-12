'use strict';
const publishedLayoutFixture=require('./published-layout-fixture');
// Retained physical layouts are tested with frozen public metadata; current conversions use layout-planning.js.
const legacyLayoutFixture = require('./legacy-layout-fixture');
const { test } = require('./runner');
const { core, assert } = require('./helpers');

function cardWithNumbers() {
    return { name: '数值写入策略测试', first_mes: '开场', character_book: { entries: [
        { comment: '[InitVar]', content: JSON.stringify({ counter: 1, obj: { counter: 2 }, _counter: 3, $counter: 4 }) },
    ] } };
}
function sheets(mode) {
    const result = publishedLayoutFixture(cardWithNumbers(), { mode });
    const byName = Object.fromEntries(Object.values(result.template).filter(t => t.content).map(t => [t.name, t]));
    return { result, byName, byGroup: Object.fromEntries(result.schema.map(g => [g.name, byName[g.tableName]])) };
}

test("旧布局：顶层数值：无规则与对象内数值默认可写，声明美元字段保留隐藏值的写入位置", () => {
    const native = sheets('native').byGroup;
    const sqlite = sheets('sqlite').byGroup;
    for (const name of ['counter', 'obj']) {
        assert.match(native[name].sourceData.updateNode, /根据正文、设定与本表规则/);
        assert.match(native[name].sourceData.updateNode, /禁止新增或删除记录/);
    }
    assert.match(native.counter.sourceData.initNode, /根据正文、设定与 note 按需更新/);
    assert.match(native._counter.sourceData.updateNode, /根据正文、设定与本表规则/);
    assert.ok(native.$counter, '展示隐藏不应删除数据库写入位置');
    assert.ok(native.$counter.updateConfig.sendRowsSqlTemplate, '当前值通过发送查询隐藏');
    assert.ok(!native.$counter.sourceData.hiddenPhysicalColumns?.includes('neirong'), 'DDL保留写入结构');
    assert.strictEqual(native.counter.sourceData.note, sqlite.counter.sourceData.note);
    assert.strictEqual(native.counter.sourceData.updateNode, sqlite.counter.sourceData.updateNode);
});

test("旧布局：顶层数值：专用规则保留且仍开放 UPDATE", () => {
    const result = publishedLayoutFixture(cardWithNumbers(), { mode: 'sqlite' });
    const counter = result.schema.find(group => group.name === 'counter');
    assert.ok(counter);
    counter.groupChecks = ['剧情变化时更新，不得为负数'];
    const template = core.generateTemplate(result.schema, { mode: 'sqlite' });
    const sheet = Object.values(template).find(t => t.name === 'counter表');
    assert.match(sheet.sourceData.note, /剧情变化时更新，不得为负数/);
    assert.match(sheet.sourceData.updateNode, /根据 note 中的更新规则/);
    assert.match(sheet.sourceData.updateNode, /SQL示例: UPDATE/);
});
