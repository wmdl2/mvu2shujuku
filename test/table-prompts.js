'use strict';
const {test} = require('./runner');
const {core, assert} = require('./helpers');
const promptGuidanceCard = require('./prompt-guidance-card');

test('表格协议：共享 note 不编号，native/双模式不混入生成的 SQL 示例', () => {
    const card = {name: '协议测试', first_mes: '你好', character_book: {entries: [{
        comment: '[InitVar]', content: JSON.stringify({A: {x: 1, _内部: 2, y: 3, bag: [1,2,3]}}),
    }]}};
    const converted = Object.fromEntries(['native','both','sqlite'].map(mode => [mode, core.convert(card, {mode})]));
    for (const mode of ['native','both','sqlite']) {
        for (const sheet of Object.values(converted[mode].template).filter(s => s.content)) {
            assert.doesNotMatch(sheet.sourceData.note, /列\d+:/, '编号仅由宿主的列投影决定');
            for (const kind of ['insertNode','updateNode','deleteNode']) {
                if (mode !== 'sqlite') assert.doesNotMatch(sheet.sourceData[kind], /SQL示例:|INSERT INTO|DELETE FROM| SET /);
            }
        }
    }
    const native = Object.values(converted.native.template).find(s => s.name === 'A表');
    const sql = Object.values(converted.sqlite.template).find(s => s.name === 'A表');
    assert.strictEqual(native.sourceData.note, sql.sourceData.note);
    assert.doesNotMatch(native.sourceData.note, /- x x|- y y/, '宿主表头/DDL 已提供字段映射');
    assert.deepStrictEqual(native.content[0].slice(1, 4), ['x', '_内部', 'y']);
    assert.doesNotMatch(native.sourceData.note, /- _内部/);
    assert.match(native.sourceData.updateNode, /已有字段的值发生变化时更新/);
    assert.match(sql.sourceData.updateNode, /SQL示例: UPDATE/);
    assert.strictEqual(native.sourceData.ddl, sql.sourceData.ddl, '精简协议示例不改变 DDL');
});

test('特殊操作提示：完整关联组合与数组定位示例按两种模式解释，数据布局不变', () => {
    const results = Object.fromEntries(['native', 'both', 'sqlite'].map(mode => [mode, core.convert(promptGuidanceCard(), {mode})]));
    for (const mode of Object.keys(results)) {
        const result = results[mode];
        assert.strictEqual((result.card.data || result.card).extensions.mvu2shujuku.layout,
            (results.both.card.data || results.both.card).extensions.mvu2shujuku.layout);
        for (const group of result.schema) {
            const sheet = Object.values(result.template).find(s => s.name === group.tableName);
            const base = Object.values(results.both.template).find(s => s.name === group.tableName);
            assert.deepStrictEqual(sheet.content, base.content);
            assert.strictEqual(sheet.sourceData.ddl, base.sourceData.ddl);
            if (group.kind === 'nestedRows') {
                const example = sheet.sourceData.note.split('\n').find(line => line.startsWith('定位示例'));
                for (const key of [...group.ancestorKeyCols.map(a => a.col), group.keyCol]) assert.ok(example.includes(`「${key}」`));
                assert.match(example, /仅为占位.*实际值/);
                assert.match(example, /其他来源下的同名条目保持不变/);
                assert.doesNotMatch(example, /UPDATE |DELETE |updateRow\(/);
            }
            if (['array', 'pathArray', 'nestedArray'].includes(group.kind)) {
                const note = sheet.sourceData.note;
                if (mode !== 'sqlite') assert.match(note, /native 使用本表提示中方括号里的行号（从 0 开始）/);
                if (mode !== 'native') assert.match(note, /SQL 使用当前数据中的 row_id，不按显示顺序推算/);
                if (mode === 'native') assert.doesNotMatch(note, /SQL 使用当前数据/);
                if (mode === 'sqlite') assert.doesNotMatch(note, /native 使用/);
                if (group.kind === 'nestedArray') {
                    assert.match(note, /不能把来源内的序号 1 直接当成本表行号/);
                    assert.doesNotMatch(note, /定位记录须同时匹配.*「row_id」/);
                }
            } else if (group.kind !== 'nestedRows') assert.doesNotMatch(sheet.sourceData.note, /定位示例/);
        }
    }
});

test('特殊操作提示：多层关联的示例保留所有来源字段', () => {
    const group = core.convert(promptGuidanceCard()).schema.find(g => g.kind === 'nestedRows');
    group.ancestorKeyCols.push({ col: '区域', parentTable: '区域表', parentKeyCol: '名称' });
    const sheet = Object.values(core.generateTemplate([group])).find(s => s.sourceData);
    const example = sheet.sourceData.note.split('\n').find(line => line.startsWith('定位示例'));
    for (const key of [...group.ancestorKeyCols.map(a => a.col), group.keyCol]) assert.ok(example.includes(`「${key}」`));
});
