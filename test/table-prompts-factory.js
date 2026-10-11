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
        sqlTextLiteral: value => "'" + String(value == null ? '' : value).replace(/'/g, "''") + "'",
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
    assert.ok(prompts.buildNote(group).includes('数值表（全表固定一行）'));
    assert.ok(prompts.buildInitNode(group).includes('开局已初始化唯一数值记录'));
    assert.ok(prompts.buildNodeProse(group, 'update').includes('SQL示例: UPDATE gold SET value = '));
});

test('表格提示工厂：未知变换输出的 JSON 数值不误称对象，浏览器内联遵守相同契约', () => {
    const card = { name: '变换值说明', first_mes: '', character_book: { entries: [{ comment: '[InitVar]',
        content: JSON.stringify({ 状态: { 分数: 1.5, 附件: null } }) }] },
        extensions: { tavern_helper: { scripts: [{ name: '结构', content:
            "import {registerMvuSchema} from 'https://example.test/mvu_zod.js';\nconst S=z.object({状态:z.object({分数:z.number().transform(v=>Math.max(0,v)),附件:z.object({说明:z.string()}).nullable()})});registerMvuSchema(S);" }] } } };
    const result = core.convert(card);
    const group = result.schema.find(g => g.tableName === '状态表');
    const column = group.columns.find(c => c.zh === '分数');
    assert.strictEqual(column.jsonKind, 'any');
    assert.match(column.desc, /完整 JSON 值/);
    assert.doesNotMatch(column.desc, /可空对象\/数组/);
    const sheet = Object.values(result.template).find(s => s.name === '状态表');
    assert.strictEqual(sheet.content[1][sheet.content[0].indexOf('分数')], '1.5');
    for (const note of [sheet.sourceData.note, inlinePrompts().buildNote(group)]) {
        assert.match(note, /分数：保存完整 JSON 值，类型遵循原字段规则/);
        assert.match(note, /附件：保存 JSON 对象\/数组/);
        assert.match(note, /标量按原类型整体更新/);
        assert.doesNotMatch(note, /分数：保存 JSON 对象\/数组|本次要求 SQL 脚本时/);
    }
});

test('JSON 字段业务规则：根表保留原文，普通列每段只标一次位置', () => {
    const prompts = inlinePrompts();
    const texts = ['/主角/姓名 readonly(前端管理)', '/主角/姓名 正文确定称呼时遵循原限制'];
    const group = { kind: 'json', name: '根状态', rootContainer: true,
        columns: [{ zh: '内容', type: 'TEXT', logicalType: 'json', isObject: true }],
        rows: [], groupChecks: [], wildcardRules: [],
        pathSpecifications: texts.map(text => ({ text, path: ['主角', '姓名'], jsonPath: true,
            label: '「内容」内部路径 /主角/姓名', jsonBindingLabel: '「内容」', jsonRelativePath: ['主角', '姓名'] })),
    };
    const rootNote = prompts.buildNote(group);
    for (const text of texts) assert(rootNote.includes(text));
    assert.doesNotMatch(rootNote, /内部路径|「内容」内/);
    const note = prompts.buildNote({ ...group, rootContainer: false });
    for (const text of texts) assert(note.includes(text));
    assert.strictEqual(note.split('「内容」内 /主角/姓名：').length - 1, 1);
    const emptyPath = prompts.buildNote({ ...group, rootContainer: false,
        pathSpecifications: group.pathSpecifications.map(s => ({ ...s, jsonRelativePath: [] })) });
    assert.doesNotMatch(emptyPath, /「内容」内 \/|内部路径/);
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
