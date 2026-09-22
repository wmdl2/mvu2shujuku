'use strict';
const { test } = require('./runner');
const { core, assert } = require('./helpers');

function card() {
    return { name: '内部列隐藏测试', first_mes: '开场', character_book: { entries: [
        { comment: '[InitVar]', content: JSON.stringify({ obj: { visible: 1, _state: 2, $secret: 3 }, '$private': { value: 4 } }) },
    ] } };
}
function sheet(result, name) { return Object.values(result.template).find(t => t.name === name); }

test('模板内部列：9.2.5 默认隐藏 $ 列与 _扩展数据，_ 业务列可见但只读', () => {
    const results = Object.fromEntries(['native', 'both', 'sqlite'].map(mode => [mode, core.convert(card(), { mode })]));
    for (const mode of Object.keys(results)) {
        const obj = sheet(results[mode], 'obj表');
        assert.deepStrictEqual(obj.content[0], ['row_id', 'visible', '_state', '$secret', '_扩展数据']);
        assert.deepStrictEqual(obj.sourceData.hiddenPhysicalColumns, ['secret', 'kuozhanshuju']);
        assert.doesNotMatch(obj.sourceData.note, /visible visible/);
        assert.match(obj.sourceData.note, /下划线开头字段.*只读/);
        assert.doesNotMatch(obj.sourceData.note, /\$secret|secret/);
        assert.doesNotMatch(obj.sourceData.updateNode, /secret|kuozhanshuju/);
        assert.doesNotMatch(obj.sourceData.insertNode, /secret|kuozhanshuju/);
        assert.strictEqual(obj.content[1][3], 3);
    }
    const native = sheet(results.native, 'obj表');
    const both = sheet(results.both, 'obj表');
    const sqlite = sheet(results.sqlite, 'obj表');
    assert.deepStrictEqual(native.sourceData.hiddenPhysicalColumns, both.sourceData.hiddenPhysicalColumns);
    assert.deepStrictEqual(both.sourceData.hiddenPhysicalColumns, sqlite.sourceData.hiddenPhysicalColumns);
    assert.strictEqual(native.sourceData.note, sqlite.sourceData.note);
    assert.strictEqual(native.sourceData.ddl, sqlite.sourceData.ddl);
});

test('模板内部列：旧版或未知 SP 版本不生成隐藏字段并给出降级警告', () => {
    for (const targetSpVersion of ['9.2.4', 'unknown']) {
        const result = core.convert(card(), { mode: 'both', targetSpVersion });
        const obj = sheet(result, 'obj表');
        assert.strictEqual(obj.sourceData.hiddenPhysicalColumns, undefined);
        assert.match(result.reportText, /不支持可靠隐藏内部物理列/);
        assert.deepStrictEqual(obj.content[0], ['row_id', 'visible', '_state', '$secret', '_扩展数据']);
    }
});

test('模板内部列：混合 JSON 的深层 $ 键报告物理隐藏边界', () => {
    const result = core.convert({ name: 'JSON边界', first_mes: '开场', character_book: { entries: [
        { comment: '[InitVar]', content: JSON.stringify({ blob: {} }) },
    ] } }, { mode: 'sqlite' });
    const blobSchema = result.schema.find(group => group.name === 'blob');
    blobSchema.rows[0][1] = JSON.stringify({ nested: { $private: 1 } });
    const report = { warnings: [], warn(message, tag) { this.warnings.push({ message, tag }); }, note() {} };
    core.generateTemplate(result.schema, { mode: 'sqlite', report });
    assert.ok(report.warnings.some(w => /深层 \$ 私有键/.test(w.message)), 'JSON 深层 $ 键边界应被检测');
});
