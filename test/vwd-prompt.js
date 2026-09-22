'use strict';
const { test } = require('./runner');
const { core, assert, applyingApi } = require('./helpers');
const factory = require('../src/extension-runtime').createCandidateBuilder;
const clone = value => JSON.parse(JSON.stringify(value));
const initial = { A: { str: ['旧值', '相同说明'], empty: ['空说明值', ''], same: ['其他值', '相同说明'] } };
function fixture(stat = initial) {
    const result = core.convert({ name: 'VWD动态提示公开样本', character_book: { entries: [
        { comment: '[InitVar]', content: JSON.stringify(stat) },
    ] } }, { vwdDescriptions: true });
    const layout = JSON.parse((result.card.data || result.card).extensions.mvu2shujuku.layout);
    return { result, layout, entry: layout.find(e => e.group === 'A'), tables: result.template,
        sheet: Object.values(result.template).find(t => t.name === 'A表') };
}
async function withRenderer(action) {
    const before = globalThis.EjsTemplate;
    const evalTemplate = function () {};
    evalTemplate.__mvu2shujukuContextBridge = true;
    globalThis.EjsTemplate = { evalTemplate };
    try { return await action(); } finally {
        if (before === undefined) delete globalThis.EjsTemplate; else globalThis.EjsTemplate = before;
    }
}

test('VWD动态提示：普通说明保持原文，特殊文本可逆且不残留模板起始符', () => {
    assert.strictEqual(core.formatVwdPromptDescription('普通中文说明🙂'), '普通中文说明🙂');
    assert.strictEqual(core.formatVwdPromptDescription(''), '');
    for (const raw of ['<%= 40 + 2 %>', '{{user}} {[sql "SELECT 1"]}', '<if true>文本</if>',
        '$random:dice $v:x <random min="1" max="2"/>', '&lt;% &amp; <user>', '多行\n引号"反斜线\\\u0000🙂',
        '\\u003c 是字面值，<% 是模板标记']) {
        const formatted = core.formatVwdPromptDescription(raw);
        assert.strictEqual(JSON.parse(formatted.slice(formatted.indexOf('）') + 1)), raw);
        assert.doesNotMatch(formatted, /[<>{}$&\u0000-\u001f\u2028\u2029]/);
    }
});

test('VWD动态提示：显式转换登记空说明插槽，不把字段身份或内部列暴露给模型', () => {
    const { entry, sheet } = fixture();
    assert.strictEqual(entry.vwd.promptVersion, 1);
    assert.strictEqual(entry.vwd.tokens.length, 3);
    assert.ok(entry.vwd.fields.every(field => field.noteSlot));
    assert.strictEqual(sheet.sourceData.note, core.buildVwdPromptNote(entry.vwd, entry.table));
    assert.deepStrictEqual(core.vwdPromptDescriptions(entry, sheet), ['相同说明', '', '相同说明']);
    assert.doesNotMatch(sheet.sourceData.note, /\u0000VWD|\$说明覆盖/);
    assert.ok(sheet.sourceData.hiddenPhysicalColumns.length > 0);
});

test('VWD动态提示：值与说明一次 updateRow 保存，原始说明读回不受提示转义影响', async () => withRenderer(async () => {
    const { layout, entry, sheet, tables } = fixture();
    const next = clone(initial); next.A.str = ['新值', '<%= 40 + 2 %>'];
    const api = applyingApi(tables), calls = [];
    const spy = { ...api, updateRow: async (...args) => { calls.push(args); return api.updateRow(...args); } };
    await core.writeStatDiffToDb(spy, layout, initial, next, tables);
    assert.strictEqual(core.lastStatWriteFailed, false);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][2].str, '新值');
    assert.ok(calls[0][2][entry.vwd.metaCol]);
    assert.deepStrictEqual(core.statDataFromTables(layout, tables).stat_data, next);
    assert.strictEqual(core.vwdPromptDescriptions(entry, sheet)[0], core.formatVwdPromptDescription(next.A.str[1]));
}));

test('VWD动态提示：初始空说明可补充，相同初始说明不串字段，显式空串和恢复默认可往返', async () => withRenderer(async () => {
    const { layout, entry, tables, sheet } = fixture();
    let before = clone(initial);
    for (const descriptions of [['新说明', '补充说明', '相同说明'], ['', '', '相同说明'], ['相同说明', '', '相同说明']]) {
        const next = clone(before);
        ['str', 'empty', 'same'].forEach((key, i) => { next.A[key][1] = descriptions[i]; });
        await core.writeStatDiffToDb(applyingApi(tables), layout, before, next, tables);
        assert.strictEqual(core.lastStatWriteFailed, false);
        assert.deepStrictEqual(core.statDataFromTables(layout, tables).stat_data, next);
        assert.deepStrictEqual(core.vwdPromptDescriptions(entry, sheet), descriptions);
        before = next;
    }
}));

test('VWD动态提示：候选工厂保留未折叠说明，序列化 VM 仍使用真实 writer', async () => withRenderer(async () => {
    const { layout, tables } = fixture();
    const next = clone(initial); next.A.str = ['新值', '新说明']; next.A.empty[1] = '补充';
    const vmFactory = require('vm').runInNewContext('(' + factory.toString() + ')');
    const candidate = await vmFactory({ core }).buildUpdatedTemplateFromStat(layout, initial, next, tables);
    assert.ok(candidate);
    assert.deepStrictEqual(core.statDataFromTables(layout, candidate).stat_data, next);
    assert.deepStrictEqual(core.statDataFromTables(layout, tables).stat_data, initial, '规划不改原表');
}));

test('VWD动态提示：缺少 EJS 桥、模板被改写或旧静态布局都在第一次写入前拒绝', async () => {
    const next = clone(initial); next.A.str = ['新值', '新说明'];
    const { layout, tables } = fixture();
    const before = JSON.stringify(tables);
    assert.strictEqual(await factory({ core }).buildUpdatedTemplateFromStat(layout, initial, next, tables), null);
    await withRenderer(async () => {
        for (const kind of ['note', 'layout']) {
            const f = fixture(), calls = [];
            if (kind === 'note') f.sheet.sourceData.note += '\n人为改写'; else delete f.entry.vwd.promptVersion;
            const api = { exportTableAsJson: () => f.tables, updateRow: () => calls.push('row'), updateCell: () => calls.push('cell') };
            await core.writeStatDiffToDb(api, f.layout, initial, next, f.tables);
            assert.strictEqual(core.lastStatWriteFailed, true);
            assert.deepStrictEqual(calls, []);
            assert.strictEqual(await factory({ core }).buildUpdatedTemplateFromStat(f.layout, initial, next, f.tables), null);
        }
    });
    assert.strictEqual(JSON.stringify(tables), before);
});

test('VWD动态提示：损坏覆盖按静态默认退化，渲染不改变原表', () => {
    const { entry, sheet } = fixture();
    const index = sheet.content[0].indexOf(entry.vwd.metaCol);
    sheet.content[1][index] = '{invalid';
    const before = JSON.stringify(sheet);
    assert.deepStrictEqual(core.vwdPromptDescriptions(entry, sheet), ['相同说明', '', '相同说明']);
    assert.strictEqual(JSON.stringify(sheet), before);
});

test('VWD动态提示：复用自有模板仍重建插槽，自定义模板不伪报支持', async () => withRenderer(async () => {
    const { result, tables } = fixture();
    const refreshed = core.refreshConversion(result, { vwdDescriptions: true, template: tables });
    const layout = JSON.parse((refreshed.card.data || refreshed.card).extensions.mvu2shujuku.layout);
    assert.strictEqual(core.canWriteVwdDescriptions(layout.find(e => e.group === 'A'), refreshed.template), true);
    const altered = clone(tables); Object.values(altered).find(t => t.name === 'A表').sourceData.note = '自定义模板';
    const custom = core.refreshConversion(result, { vwdDescriptions: true, template: altered });
    assert.match(custom.reportText, /自定义模板不含匹配的动态说明入口/);
    const withRule = clone(tables); Object.values(withRule).find(t => t.name === 'A表').sourceData.note += '\n新增业务规则';
    const updated = core.refreshConversion(result, { vwdDescriptions: true, template: withRule });
    const updatedLayout = JSON.parse((updated.card.data || updated.card).extensions.mvu2shujuku.layout);
    assert.strictEqual(core.canWriteVwdDescriptions(updatedLayout.find(e => e.group === 'A'), updated.template), true);
    assert.ok(!result.schema.find(g => g.name === 'A').vwd.noteTemplate.includes('新增业务规则'), '刷新不回改旧转换结果');
}));

test('VWD动态提示：布局宏只解析默认说明，原规则宏保留在提示管线执行', async () => withRenderer(async () => {
    const { entry, sheet } = fixture({ A: { str: ['值', '说明给 {{user}}'] } });
    entry.vwd.plan += '\n作者规则 {{user}} <%= 1+2 %>';
    sheet.sourceData.note = core.buildVwdPromptNote(entry.vwd, entry.table);
    entry.vwd.noteTemplate = sheet.sourceData.note;
    const resolved = core.resolveLayoutMacros([entry], text => text.replace(/\{\{user\}\}/g, '测试用户'))[0];
    assert.deepStrictEqual(core.vwdPromptDescriptions(resolved, sheet), ['说明给 测试用户']);
    assert.match(sheet.sourceData.note, /作者规则 \{\{user\}\} <%= 1\+2 %>/);
}));

test('VWD动态提示：同批修改另一字段说明时，纯值写入保留已有说明覆盖', async () => withRenderer(async () => {
    const { layout, tables } = fixture();
    const first = clone(initial); first.A.str[1] = '已有覆盖';
    await core.writeStatDiffToDb(applyingApi(tables), layout, initial, first, tables);
    const second = clone(first); second.A.str = '纯值修改'; second.A.same[1] = '另一说明';
    await core.writeStatDiffToDb(applyingApi(tables), layout, first, second, tables);
    assert.strictEqual(core.lastStatWriteFailed, false);
    const read = core.statDataFromTables(layout, tables).stat_data;
    assert.deepStrictEqual(read.A.str, ['纯值修改', '已有覆盖']);
    assert.deepStrictEqual(read.A.same, ['其他值', '另一说明']);
}));

test('VWD动态提示：业务 EJS 迁移后模板仍匹配，旧宿主不生成动态入口', async () => withRenderer(async () => {
    const source = { name: '宏规则', character_book: { entries: [
        { comment: '[InitVar]', content: JSON.stringify({ 状态: { 称呼: ['旧值', '说明'] } }) },
        { comment: '变量更新规则', enabled: true, constant: true, content: '状态:\n  称呼:\n    check: |\n      原规则 <%= getvar("stat_data.状态.称呼") %> {{user}}' },
    ] } };
    const result = core.convert(source, { vwdDescriptions: true });
    const layout = JSON.parse((result.card.data || result.card).extensions.mvu2shujuku.layout);
    const entry = layout.find(e => e.group === '状态');
    assert.strictEqual(core.canWriteVwdDescriptions(entry, result.template), true);
    assert.match(entry.vwd.noteTemplate, /mvu2shujukuResolveMacro\("user"\)/);
    assert.match(entry.vwd.noteTemplate, /原规则 <%= getvar\("stat_data\.状态\.称呼"\) %>/);
    const old = core.convert(source, { vwdDescriptions: true, targetSpVersion: '9.2.4' });
    const oldLayout = JSON.parse((old.card.data || old.card).extensions.mvu2shujuku.layout);
    assert.ok(oldLayout.every(e => !e.vwd));
    assert.doesNotMatch(Object.values(old.template).find(t => t.name === '状态表').sourceData.note, /mvu2shujukuVwdDescriptions/);
}));

test('VWD数字布尔：新动态布局还原 pair，物理类型和默认静态布局不变', () => {
    const stat = { A: { count: [3, '数量说明'], enabled: [false, '开关说明'] } };
    const { entry, layout, tables, sheet } = fixture(stat);
    assert.deepStrictEqual(entry.vwd.fields.map(f => f.type), ['number', 'boolean']);
    assert.deepStrictEqual(core.statDataFromTables(layout, tables).stat_data, stat);
    assert.deepStrictEqual(core.statDataFromTables(layout, {}).stat_data, stat);
    assert.deepStrictEqual(core.vwdPromptDescriptions(entry, sheet), ['数量说明', '开关说明']);
    const raw = core.convert({ name: '静态', character_book: { entries: [{ comment: '[InitVar]', content: JSON.stringify(stat) }] } });
    const oldLayout = JSON.parse((raw.card.data || raw.card).extensions.mvu2shujuku.layout);
    assert.deepStrictEqual(core.statDataFromTables(oldLayout, raw.template).stat_data, { A: { count: 3, enabled: false } });
    for (const name of ['count', 'enabled']) assert.match(sheet.sourceData.ddl, new RegExp(name + ' INTEGER'));
});
test('VWD数字布尔：值与说明同批、只改说明和清空说明，SQLite 字符串也还原类型', () => withRenderer(async () => {
    let before = { A: { count: [3, '数量说明'], enabled: [false, '开关说明'] } };
    const { entry, layout, tables, sheet } = fixture(before), api = applyingApi(tables);
    let rowCalls = 0; const update = api.updateRow;
    api.updateRow = async (...args) => { rowCalls++; for (const v of Object.values(args[2])) assert.ok(['string', 'number'].includes(typeof v)); return update(...args); };
    for (const next of [{ A: { count: [4, '新数量'], enabled: [true, '新开关'] } },
        { A: { count: [4, ''], enabled: [true, ''] } }, { A: { count: [4, '数量说明'], enabled: [true, '开关说明'] } }]) {
        const start = rowCalls;
        await core.writeStatDiffToDb(api, layout, before, next);
        assert.strictEqual(core.lastStatWriteFailed, false);
        assert.strictEqual(rowCalls - start, 1, '元数据和值同一次 updateRow');
        assert.deepStrictEqual(core.statDataFromTables(layout, tables).stat_data, next);
        assert.deepStrictEqual(core.vwdPromptDescriptions(entry, sheet), [next.A.count[1], next.A.enabled[1]]);
        const head = sheet.content[0], row = sheet.content[1];
        assert.strictEqual(typeof row[head.indexOf('count')], 'string');
        assert.strictEqual(row[head.indexOf('enabled')], '1');
        before = next;
    }
}));
test('VWD数字布尔：缺少动态提示能力时整笔拒绝，真实候选工厂保留类型与说明', async () => {
    const before = { A: { count: [3, '数量说明'], enabled: [false, '开关说明'] } };
    const next = { A: { count: [5, '新数量'], enabled: [true, '新开关'] } };
    const { layout, tables } = fixture(before), original = clone(tables);
    await core.writeStatDiffToDb(applyingApi(tables), layout, before, next);
    assert.strictEqual(core.lastStatWriteFailed, true); assert.deepStrictEqual(tables, original);
    await withRenderer(async () => {
        const create = require('vm').runInNewContext('(' + factory.toString() + ')');
        const candidate = await create({ core }).buildUpdatedTemplateFromStat(layout, before, next, tables);
        assert.ok(candidate); assert.deepStrictEqual(core.statDataFromTables(layout, candidate).stat_data, next);
        assert.deepStrictEqual(tables, original);
    });
});
