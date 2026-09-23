'use strict';
const { test } = require('./runner');
const { core, assert } = require('./helpers');

function cardWithNumbers() {
    return { name: '数值写入策略测试', first_mes: '开场', character_book: { entries: [
        { comment: '[InitVar]', content: JSON.stringify({ counter: 1, obj: { counter: 2 }, _counter: 3, $counter: 4 }) },
    ] } };
}
function sheets(mode) {
    const result = core.convert(cardWithNumbers(), { mode });
    return { result, byName: Object.fromEntries(Object.values(result.template).filter(t => t.content).map(t => [t.name, t])) };
}

test('顶层数值：无规则与对象内数值默认可写，私有数值只读', () => {
    const native = sheets('native').byName;
    const sqlite = sheets('sqlite').byName;
    for (const name of ['counter表', 'obj表']) {
        assert.match(native[name].sourceData.updateNode, /根据正文、设定与本表规则/);
        assert.match(native[name].sourceData.updateNode, /只允许 UPDATE/);
    }
    assert.match(native['counter表'].sourceData.initNode, /根据正文、设定与 note 按需更新/);
    for (const name of ['_counter表', '$counter表']) {
        assert.match(native[name].sourceData.updateNode, /脚本\/前端维护，AI 不应直接修改/);
        assert.doesNotMatch(native[name].sourceData.updateNode, /SQL示例/);
        assert.match(native[name].sourceData.initNode, /脚本\/前端维护，自动填表阶段不修改/);
    }
    assert.strictEqual(native['counter表'].sourceData.note, sqlite['counter表'].sourceData.note.replace(/\nSQL 示例仅演示写法[^\n]*$/, ''));
    assert.strictEqual(native['counter表'].sourceData.updateNode, sqlite['counter表'].sourceData.updateNode.split('\nSQL示例:')[0]);
});

test('顶层数值：专用规则保留且仍开放 UPDATE', () => {
    const result = core.convert(cardWithNumbers(), { mode: 'sqlite' });
    const counter = result.schema.find(group => group.name === 'counter');
    assert.ok(counter);
    counter.groupChecks = ['剧情变化时更新，不得为负数'];
    const template = core.generateTemplate(result.schema, { mode: 'sqlite' });
    const sheet = Object.values(template).find(t => t.name === 'counter表');
    assert.match(sheet.sourceData.note, /剧情变化时更新，不得为负数/);
    assert.match(sheet.sourceData.updateNode, /根据 note 中的更新规则/);
    assert.match(sheet.sourceData.updateNode, /SQL示例: UPDATE/);
});
