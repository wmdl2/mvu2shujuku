'use strict';
const vm = require('vm');
const { test } = require('./runner');
const { core, assert } = require('./helpers');
const createTablePrompts = require('../src/table-prompts');

function inlinePrompts() {
    const inlineFactory = vm.runInNewContext('(' + createTablePrompts.toString() + ')');
    return inlineFactory({
        describeGroup: () => '行表说明',
        isRelationshipKeyColumn: () => false,
        isDollarPrivateColumn: () => false,
        isUnderscoreReadonlyColumn: () => false,
        isAiPromptColumn: () => true,
        sqlQuote: value => String(value == null ? '' : value).replace(/'/g, "''"),
        schemaExample: () => ({}),
        vwdToken: index => `SLOT_${index}`,
    });
}

test('表格提示工厂：浏览器内联后无 Node 外部作用域，数值表说明与示例可生成', () => {
    const prompts = inlinePrompts();
    const group = {
        scalarType: 'number', name: '金币', ident: 'gold', kind: 'singleton',
        columns: [{ zh: '内容', ident: 'value', type: 'INTEGER', logicalType: 'number', value: 10 }],
        rows: [[1, 10]], groupChecks: [], wildcardRules: [],
    };
    assert.ok(prompts.buildNote(group).includes('数值表（row_id=1，全表固定一行）'));
    assert.ok(prompts.buildInitNode(group).includes('开局已初始化唯一数值记录'));
    assert.ok(prompts.buildNodeProse(group, 'update').includes('SQL示例: UPDATE gold SET value = '));
});

test('表格提示工厂：相同静态说明仍分配不同 VWD 插槽', () => {
    const prompts = inlinePrompts();
    const group = {
        kind: 'singleton', name: '状态', columns: [
            { zh: '状态', desc: '相同说明' }, { zh: '心情', desc: '相同说明' },
        ], groupChecks: [], wildcardRules: [], rows: [],
    };
    const plan = { promptVersion: 1, tokens: [], fields: [
        { col: '状态', id: 'a' }, { col: '心情', id: 'b' },
    ] };
    const note = prompts.buildNote(group, { mode: 'both', vwdSlotPlan: plan });
    assert.deepStrictEqual(Array.from(plan.tokens), ['a', 'b']);
    assert.ok(note.includes('SLOT_0'));
    assert.ok(note.includes('SLOT_1'));
});

test('表格提示工厂：真实转换入口调用新模块生成 note 与操作说明', () => {
    const card = require('./synthetic-card')();
    const converted = core.convert(card, { mode: 'both' });
    const sheets = Object.keys(converted.template).filter(key => key.startsWith('sheet_'));
    assert.ok(sheets.length > 0);
    for (const key of sheets) {
        const source = converted.template[key].sourceData;
        assert.strictEqual(typeof source.note, 'string');
        assert.strictEqual(typeof source.initNode, 'string');
        assert.strictEqual(typeof source.updateNode, 'string');
    }
});
