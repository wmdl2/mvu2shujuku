'use strict';
const { test } = require('./runner');
const { core, assert, applyingApi } = require('./helpers');

function card() {
    return { name: '内部列隐藏测试', first_mes: '开场', character_book: { entries: [
        { comment: '[InitVar]', content: JSON.stringify({ obj: { visible: 1, _state: 2, $secret: 3 }, '$private': { value: 4 } }) },
    ] } };
}
function sheet(result, name) { return Object.values(result.template).find(t => t.name === name); }

test('模板存储：声明$保留写入、内部$随记录，扩展列只过滤发送内容', () => {
    const results = Object.fromEntries(['native', 'both', 'sqlite'].map(mode => [mode, core.convert(card(), { mode })]));
    for (const mode of Object.keys(results)) {
        const obj = sheet(results[mode], 'obj表');
        assert.deepStrictEqual(obj.content[0], ['row_id', 'visible', '_state', '扩展数据']);
        assert.deepStrictEqual(obj.sourceData.hiddenPhysicalColumns, undefined);
        assert.doesNotMatch(obj.sourceData.note, /visible visible/);
        assert.match(obj.sourceData.ddl, /_state\s+REAL/);
        assert.match(obj.sourceData.ddl, /kuozhanshuju/);
        assert(obj.updateConfig.sendRowsSqlTemplate);
        assert.doesNotMatch(obj.sourceData.note, /下划线开头字段.*只读/);
        assert.doesNotMatch(obj.sourceData.note, /_xxx/);
        assert.doesNotMatch(obj.sourceData.note, /_扩展数据/);
        assert.doesNotMatch(obj.sourceData.note, /\$secret|secret/);
        assert.doesNotMatch(obj.sourceData.updateNode, /secret/);
        assert.doesNotMatch(obj.sourceData.insertNode, /secret/);
        assert.deepStrictEqual(results[mode].card.extensions.mvu2shujuku.statStorage.initial, {});
        const layout = JSON.parse(results[mode].card.extensions.mvu2shujuku.layout);
        assert.equal(core.statDataFromTables(layout, results[mode].template).stat_data.obj.$secret, 3);
        assert.deepStrictEqual(core.statDataFromTables(layout, results[mode].template).stat_data.$private, { value: 4 });
        const privateSheet = sheet(results[mode], '$private表');
        assert(privateSheet);
        assert(!privateSheet.sourceData.hiddenPhysicalColumns?.length);
        assert(privateSheet.updateConfig.sendRowsSqlTemplate.includes('WHERE 0'));
    }
    const native = sheet(results.native, 'obj表');
    const both = sheet(results.both, 'obj表');
    const sqlite = sheet(results.sqlite, 'obj表');
    assert.deepStrictEqual(native.sourceData.hiddenPhysicalColumns, both.sourceData.hiddenPhysicalColumns);
    assert.deepStrictEqual(both.sourceData.hiddenPhysicalColumns, sqlite.sourceData.hiddenPhysicalColumns);
    assert.strictEqual(native.sourceData.note, sqlite.sourceData.note);
    assert.strictEqual(native.sourceData.ddl, sqlite.sourceData.ddl);
});

test('模板内部列：8.5 起生成隐藏字段，接受两至四段版本', () => {
    for (const targetSpVersion of ['8.5', '8.5.0', 'v8.5.1', '8.6', '9.0', '9.2.4', '9.2.5.1']) {
        const result = core.convert(card(), { targetSpVersion });
        assert.deepStrictEqual(sheet(result, 'obj表').sourceData.hiddenPhysicalColumns, undefined);
        assert.doesNotMatch(result.reportText, /停用.*隐藏/);
    }
});

test('模板内部列：旧版或未知 SP 版本不生成隐藏字段并给出降级警告', () => {
    for (const targetSpVersion of ['8.4', '8.4.9', 'unknown']) {
        const result = core.convert(card(), { mode: 'both', targetSpVersion });
        const obj = sheet(result, 'obj表');
        assert.strictEqual(obj.sourceData.hiddenPhysicalColumns, undefined);
        assert.doesNotMatch(result.reportText, /不支持可靠隐藏内部物理列/, '原$数据不依赖宿主隐藏列能力');
        assert.doesNotMatch(result.reportText, /不支持可靠隐藏内部物理列/);
        assert.deepStrictEqual(obj.content[0], ['row_id', 'visible', '_state', '扩展数据']);
    }
});

test('模板内部列：混合JSON使用递归发送投影，不误报成整列泄漏', () => {
    const result = core.convert({ name: 'JSON边界', first_mes: '开场', character_book: { entries: [
        { comment: '[InitVar]', content: JSON.stringify({ blob: {} }) },
    ] } }, { mode: 'sqlite' });
    const blobSchema = result.schema.find(group => group.name === 'blob');
    blobSchema.rows[0][1] = JSON.stringify({ nested: { $private: 1 } });
    const report = { warnings: [], warn(message, tag) { this.warnings.push({ message, tag }); }, note() {} };
    const template = core.generateTemplate(result.schema, { mode: 'sqlite', report });
    assert(!report.warnings.some(w => /此列仍会整体进入提示词/.test(w.message)));
    assert(sheet({ template }, 'blob表').updateConfig.sendRowsSqlTemplate);
    const layout = JSON.parse(core.buildLayoutJson(core.buildLayout(result.schema)));
    assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data.blob, { nested: { $private: 1 } });
});


test('新模板下划线列：中文拼音、普通列和大小写不敏感消歧', async () => {
    const input = { name: '列名测试', first_mes: '开场', character_book: { entries: [
        { comment: '[InitVar]', content: JSON.stringify({
            obj: { visible: 1, _状态: 3, _ZHUANGTAI: 4 }, plain: { 状态: 2 },
        }) },
    ] } };
    for (const mode of ['native', 'both', 'sqlite']) {
        const result = core.convert(input, { mode });
        const group = result.schema.find(g => g.tableName === 'obj表');
        const obj = sheet(result, 'obj表');
        const byName = Object.fromEntries(group.columns.map(c => [c.zh, c.ident]));
        assert.strictEqual(group.ident, 'objbiao');
        assert.strictEqual(byName.visible, 'visible');
        assert.strictEqual(result.schema.find(g => g.tableName === 'plain表').columns.find(c => c.zh === '状态').ident, 'zhuangtai');
        assert.strictEqual(byName._状态, '_zhuangtai');
        assert.strictEqual(byName._ZHUANGTAI, '_zhuangtai_2');
        assert.strictEqual(byName._扩展数据, undefined);
        assert.deepStrictEqual(obj.content[0], ['row_id', 'visible', '_状态', '_ZHUANGTAI', '扩展数据']);
        assert.match(obj.sourceData.ddl, /_zhuangtai\s+REAL/);
        assert.match(obj.sourceData.ddl, /_zhuangtai_2\s+REAL/);
        assert.deepStrictEqual(obj.sourceData.hiddenPhysicalColumns || [], []);
        assert.strictEqual(obj.content[1][2], 3);
        assert.strictEqual(obj.content[1][3], 4);
        assert.ok(!obj.sourceData.note.includes('如 _扩展数据'));
        assert.ok(!group.columns.find(c => c.zh === '_状态').aiReadonly);
        assert.ok(!group.columns.find(c => c.zh === '_ZHUANGTAI').aiReadonly);
        assert.doesNotMatch(obj.sourceData.insertNode + obj.sourceData.updateNode, /_kuozhanshuju/);
        const layout = JSON.parse((result.card.data || result.card).extensions.mvu2shujuku.layout);
        const original = core.statDataFromTables(layout, result.template).stat_data;
        assert.strictEqual(original.obj._状态, 3);
        assert.strictEqual(original.obj._ZHUANGTAI, 4);
        const next = JSON.parse(JSON.stringify(original));
        next.obj._状态 = 5;
        next.obj._ZHUANGTAI = 6;
        const write = await core.writeStatDiffToDbResult(applyingApi(result.template), layout, original, next);
        assert.ok(write.ok);
        assert.deepStrictEqual(core.statDataFromTables(layout, result.template).stat_data, next);
    }
});

test('旧冻结模板的 kuozhanshuju 继续按原 DDL 与布局读写', async () => {
    const old = require('./vwd-static-before.json').conversion;
    const layout = old.layout;
    const tables = JSON.parse(JSON.stringify(old.template));
    const obj = sheet({ template: tables }, 'A表');
    const originalDdl = obj.sourceData.ddl;
    assert.match(originalDdl, /kuozhanshuju\s+TEXT/);
    assert.doesNotMatch(originalDdl, /_kuozhanshuju/);
    assert.deepStrictEqual(obj.sourceData.hiddenPhysicalColumns, ['kuozhanshuju']);
    const before = core.statDataFromTables(layout, tables).stat_data;
    assert.strictEqual(before.A.str[0], '初始');
    const after = JSON.parse(JSON.stringify(before));
    after.A.newField = '保留';
    const calls = [];
    const api = applyingApi(tables);
    const original = api.updateCell;
    api.updateCell = async (...args) => { calls.push(args); return original(...args); };
    assert.ok(await core.writeStatDiffToDb(api, layout, before, after) > 0);
    assert.deepStrictEqual(calls, [['A表', 1, '_扩展数据', '{"newField":"保留"}']]);
    assert.deepStrictEqual(core.statDataFromTables(layout, tables).stat_data, after);
    assert.strictEqual(obj.sourceData.ddl, originalDdl);
    assert.deepStrictEqual(obj.sourceData.hiddenPhysicalColumns, ['kuozhanshuju']);
});
