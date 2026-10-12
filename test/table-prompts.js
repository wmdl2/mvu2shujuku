'use strict';
const publishedLayoutFixture=require('./published-layout-fixture');
const legacyLayoutFixture=require('./legacy-layout-fixture');
const {test} = require('./runner');
const {core, assert} = require('./helpers');
const promptGuidanceCard = require('./prompt-guidance-card');

test("旧布局：SQL转换：默认和停用模式参数统一生成 SQLite 模板，报告说明迁移", () => {
    const card = {name: '协议测试', first_mes: '你好', character_book: {entries: [{
        comment: '[InitVar]', content: JSON.stringify({A: {x: 1, _内部: 2, y: 3}}),
    }]}};
    const converted = Object.fromEntries(['native','both','sqlite'].map(mode => [mode, publishedLayoutFixture(card, {mode})]));
    const defaultResult = publishedLayoutFixture(card);
    assert.strictEqual(defaultResult.meta.mode, 'sqlite');
    assert.strictEqual(defaultResult.card.extensions.mvu2shujuku.mode, 'sqlite');
    assert.deepStrictEqual(defaultResult.template, converted.sqlite.template);
    for (const mode of ['native', 'both']) {
        assert.strictEqual(converted[mode].meta.mode, 'sqlite');
        assert.strictEqual(converted[mode].card.extensions.mvu2shujuku.mode, 'sqlite');
        assert.match(converted[mode].reportText, /已停用.*SQLite 模板/);
    }
    assert.throws(() => core.convert(card, { mode: 'unknown' }), /不支持的转换模式/);
    for (const mode of ['native','both','sqlite']) {
        for (const sheet of Object.values(converted[mode].template).filter(s => s.content)) {
            assert.doesNotMatch(sheet.sourceData.note, /列\d+:/, '编号仅由宿主的列投影决定');
            const nodes = ['insertNode','updateNode','deleteNode'].map(kind => sheet.sourceData[kind]);
            assert.doesNotMatch(sheet.sourceData.note, /SQL 示例仅在本次输出要求 SQL 脚本时适用|不得直接照抄示例值/);
            assert.doesNotMatch(sheet.sourceData.note, /native|sqlite|row_id=1|结构化 where/);
            assert.doesNotMatch(sheet.sourceData.initNode, /row_id=1|只允许 UPDATE/);
            assert.doesNotMatch(sheet.sourceData.updateNode.split('\nSQL示例:')[0], /row_id=1|只允许 UPDATE|禁止 INSERT/);
            for (const node of nodes) {
                assert.doesNotMatch(node, /不得直接照抄示例值/);
            }
        }
    }
    const native = Object.values(converted.native.template).find(s => s.name === 'A表');
    const sql = Object.values(converted.sqlite.template).find(s => s.name === 'A表');
    assert.match(sql.sourceData.ddl, /_neibu\s+REAL/);
    assert.ok(!sql.sourceData.note.includes('如 _扩展数据'));
    assert.strictEqual(converted.sqlite.schema.find(g => g.tableName === 'A表').columns.find(c => c.zh === '_内部').aiReadonly === true, false);
    assert.strictEqual(native.sourceData.note, sql.sourceData.note);
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
            assert.strictEqual(sheet.sourceData[kind], nativeSheet.sourceData[kind], '停用参数不再生成另一种填表协议');
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
                assert.doesNotMatch(note, /native 使用|SQL 使用当前数据|row_id=1|结构化 where/);
                if (group.kind === 'nestedArray') {
                    assert.match(note, /不能把来源内的序号 1 直接当成本表行号/);
                    assert.doesNotMatch(note, /定位记录须同时匹配.*「row_id」/);
                }
            } else if (group.kind !== 'nestedRows') assert.doesNotMatch(sheet.sourceData.note, /定位示例/);
        }
    }
});

test('旧布局特殊操作提示：多层关联的示例保留所有来源字段', () => {
    const group = require('./legacy-layout-fixture')(promptGuidanceCard()).schema.find(g => g.kind === 'nestedRows');
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
