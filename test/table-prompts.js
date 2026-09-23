'use strict';
const {test} = require('./runner');
const {core, assert} = require('./helpers');
const promptGuidanceCard = require('./prompt-guidance-card');

test('表格协议：双模式与 SQLite 保留 SQL 示例，每表说明一次，native 专用不混入示例', () => {
    const card = {name: '协议测试', first_mes: '你好', character_book: {entries: [{
        comment: '[InitVar]', content: JSON.stringify({A: {x: 1, _内部: 2, y: 3, bag: [1,2,3]}}),
    }]}};
    const converted = Object.fromEntries(['native','both','sqlite'].map(mode => [mode, core.convert(card, {mode})]));
    const withoutNotice = text => text.replace(/\nSQL 示例仅演示写法[^\n]*$/, '');
    for (const mode of ['native','both','sqlite']) {
        for (const sheet of Object.values(converted[mode].template).filter(s => s.content)) {
            assert.doesNotMatch(sheet.sourceData.note, /列\d+:/, '编号仅由宿主的列投影决定');
            const nodes = ['insertNode','updateNode','deleteNode'].map(kind => sheet.sourceData[kind]);
            const hasSql = nodes.some(text => text.includes('SQL示例:'));
            assert.strictEqual(sheet.sourceData.note.split('SQL 示例仅演示写法').length - 1, hasSql ? 1 : 0);
            if (hasSql) {
                assert.match(sheet.sourceData.note, /不得直接照抄示例值/);
                if (mode === 'both') assert.match(sheet.sourceData.note, /native 模式请忽略，按宿主要求的原生格式填表/);
            }
            for (const node of nodes) {
                if (mode === 'native') assert.doesNotMatch(node, /SQL示例:|INSERT INTO|DELETE FROM| SET /);
                assert.doesNotMatch(node, /不得直接照抄示例值/, '共用说明只在 note 中出现一次');
            }
        }
    }
    const native = Object.values(converted.native.template).find(s => s.name === 'A表');
    const sql = Object.values(converted.sqlite.template).find(s => s.name === 'A表');
    assert.strictEqual(native.sourceData.note, withoutNotice(sql.sourceData.note));
    assert.doesNotMatch(native.sourceData.note, /- x x|- y y/, '宿主表头/DDL 已提供字段映射');
    assert.deepStrictEqual(native.content[0].slice(1, 4), ['x', '_内部', 'y']);
    assert.doesNotMatch(native.sourceData.note, /- _内部/);
    assert.match(native.sourceData.updateNode, /已有字段的值发生变化时更新/);
    assert.match(sql.sourceData.updateNode, /SQL示例: UPDATE/);
    for (const sheet of Object.values(converted.both.template).filter(s => s.content)) {
        const sqlSheet = Object.values(converted.sqlite.template).find(s => s.name === sheet.name);
        const nativeSheet = Object.values(converted.native.template).find(s => s.name === sheet.name);
        assert.deepStrictEqual(sheet.content, nativeSheet.content);
        assert.strictEqual(sheet.sourceData.ddl, nativeSheet.sourceData.ddl);
        for (const kind of ['insertNode', 'updateNode', 'deleteNode']) {
            assert.strictEqual(sheet.sourceData[kind], sqlSheet.sourceData[kind], '双模式沿用已验证的 SQL 示例');
            assert.strictEqual(sheet.sourceData[kind].split('\nSQL示例:')[0], nativeSheet.sourceData[kind], '业务触发条件不因示例变化');
        }
    }
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

test('强制更新提醒：多项共用标题并保留各自条件，空列表不输出标题', () => {
    const card = {name: '提醒测试', first_mes: '你好', character_book: {entries: [{
        comment: '[InitVar]', content: JSON.stringify({A: {x: 1, y: 2}}),
    }]}};
    const group = core.convert(card).schema.find(g => g.tableName === 'A表');
    assert.ok(group);
    const reminders = ['仅当 A.x 变化时更新 A.x', '当 A.y 缺失时新增 A.y；否则保留原值'];
    group.reminders = reminders;
    const note = Object.values(core.generateTemplate([group])).find(s => s.sourceData).sourceData.note;
    const lines = note.split('\n');
    assert.strictEqual(lines.filter(line => line === '强制更新提醒（按各项触发条件执行）：').length, 1);
    for (const reminder of reminders) assert.ok(lines.includes(`- ${reminder}`));
    assert.doesNotMatch(note, /每次回复必须维护：/);

    group.reminders = [];
    const emptyNote = Object.values(core.generateTemplate([group])).find(s => s.sourceData).sourceData.note;
    assert.doesNotMatch(emptyNote, /强制更新提醒（按各项触发条件执行）：/);
});
