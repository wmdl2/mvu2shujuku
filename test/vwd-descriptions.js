'use strict';
/*
 * VWD 动态说明（第一版）回归。
 * 覆盖范围：layout 类型已是 pair / jsonPairOptional 的**单例**字段 —— 值列保持原类型，
 * 第二项（说明）的覆盖值存进隐藏 JSON 元数据列，note 按字段插槽替换。
 * 本文件全部使用公开合成卡，不依赖私有 fixture。
 */
const { test } = require('./runner');
const { core, assert, applyingApi } = require('./helpers');

const DEFAULT_SCHEMA = `const S = z.object({
  A: z.object({ str: z.string(), other: z.string() }),
  Rows: z.record(z.string(), z.object({ s: z.string() })),
  Arr: z.array(z.string())
}); registerMvuSchema(S);`;

const DEFAULT_STAT = {
    A: { str: ['初始', '相同说明'], other: ['x', '相同说明'] },
    Rows: { one: { s: ['v', '记录说明'] } },
    Arr: ['a', 'b'],
};

// VWD 是默认关闭的实验能力：本文件所有用例都显式打开它，普通转换保持旧结构。
function convert(stat = DEFAULT_STAT, schema = DEFAULT_SCHEMA, mode = 'both', targetSpVersion) {
    // 显式打开实验能力；用完恢复原状态，避免进程内开关泄漏到其它用例或脚本。
    const previous = core.isVwdExperimental();
    core.setVwdExperimental(true);
    try {
    const result = core.convert({
        name: 'VWD动态说明合成卡', first_mes: '',
        extensions: { tavern_helper: { scripts: [{ name: '变量结构', content: schema }] } },
        character_book: { entries: [{ comment: '[InitVar]', content: JSON.stringify(stat) }] },
    }, targetSpVersion === undefined ? { mode } : { mode, targetSpVersion });
    return {
        result,
        template: result.template,
        layout: JSON.parse((result.card.data || result.card).extensions.mvu2shujuku.layout),
    };
    } finally { core.setVwdExperimental(previous); }
}

function entryOf(layout, group) {
    return layout.find(e => e && e.group === group);
}

function sheetOf(template, name) {
    return Object.values(template).find(s => s && s.name === name);
}

function metaIndex(sheet) {
    return sheet.content[0].indexOf('$说明覆盖');
}

// 模拟“卡内脚本把某字段的说明改成新值”：MVU 的 stat_data 里第二项被改写。
function withDescription(stat, group, field, description) {
    const next = JSON.parse(JSON.stringify(stat));
    next[group][field] = [next[group][field][0], description];
    return next;
}

function currentDescription(stat, group, field) {
    return stat[group][field][1];
}

/* ---------------- A. 布局与存储 ---------------- */

test('VWD动态说明：只为合格的单例 pair 字段生成隐藏元数据列，普通结构不新增列', () => {
    const { layout, template } = convert();
    const a = entryOf(layout, 'A');
    const rows = entryOf(layout, 'Rows');
    // 合格字段登记在版本化槽位里；字段身份是登记路径数组，不是显示列名。
    assert.strictEqual(a.vwd.v, 1);
    assert.strictEqual(a.vwd.metaCol, '$说明覆盖');
    assert.deepStrictEqual(a.vwd.fields.map(f => f.col), ['str', 'other']);
    assert.deepStrictEqual(a.vwd.fields[0].path, ['A', 'str']);
    assert.strictEqual(a.vwd.fields[0].id, JSON.stringify(['A', 'str']));
    assert.strictEqual(a.vwd.fields[0].desc, '相同说明');
    // 行表/普通数组没有 VWD 槽位，也不新增隐藏列。
    assert.strictEqual(rows.vwd, undefined);
    assert.ok(!sheetOf(template, 'Rows表').content[0].includes('$说明覆盖'));
    assert.ok(!sheetOf(template, 'Arr表').content[0].includes('$说明覆盖'));
    // 既有索引 0–7 不动。
    assert.deepStrictEqual(a.cols.find(c => c[0] === 'str').slice(0, 6), ['str', 'pair', '初始', ['A', 'str'], true, '相同说明']);
    assert.deepStrictEqual(a.cols.find(c => c[0] === 'other').slice(0, 6), ['other', 'pair', 'x', ['A', 'other'], true, '相同说明']);
});

test('VWD动态说明：元数据列隐藏、不进业务投影、不进 note/DDL 更新示例', () => {
    for (const mode of ['native', 'both', 'sqlite']) {
        const { layout, template, result } = convert(DEFAULT_STAT, DEFAULT_SCHEMA, mode);
        const sheet = sheetOf(template, 'A表');
        assert.ok(sheet.content[0].includes('$说明覆盖'), mode + ' 应有内部元数据列');
        assert.ok(sheet.sourceData.hiddenPhysicalColumns.includes('shuomingfugai'), mode + ' 元数据列应被隐藏');
        assert.doesNotMatch(sheet.sourceData.note, /说明覆盖|VWD/s, mode + ' note 不应暴露内部列');
        assert.doesNotMatch(sheet.sourceData.updateNode, /说明覆盖/, mode + ' 更新示例不应暴露内部列');
        assert.doesNotMatch(sheet.sourceData.insertNode, /说明覆盖/, mode + ' 插入示例不应暴露内部列');
        assert.match(sheet.sourceData.ddl, /shuomingfugai/, mode + ' DDL 需要建列');
        // 内部元数据不是业务变量。
        const read = core.statDataFromTables(layout, template).stat_data;
        assert.deepStrictEqual(read, DEFAULT_STAT, mode + ' 业务投影不应出现内部键');
        assert.ok(!JSON.stringify(read).includes('说明覆盖'), mode + ' 投影里不应有内部列名');
        assert.ok(!result.reportText.includes('说明覆盖'), mode + ' 转换报告不应把内部列当业务字段');
    }
});

test('VWD动态说明：数字/布尔 pair 叶子仍是普通标量，不误启用 VWD', () => {
    const schema = 'const S = z.object({ N: z.object({ num: z.number(), flag: z.boolean(), str: z.string() }) }); registerMvuSchema(S);';
    const stat = { N: { num: [1, '数字说明'], flag: [true, '布尔说明'], str: ['s', '文本说明'] } };
    const { layout, template } = convert(stat, schema);
    const n = entryOf(layout, 'N');
    assert.deepStrictEqual(n.cols.find(c => c[0] === 'num').slice(0, 6), ['num', 'number', 1, ['N', 'num'], true, '数字说明']);
    assert.deepStrictEqual(n.cols.find(c => c[0] === 'flag').slice(0, 6), ['flag', 'boolean', true, ['N', 'flag'], true, '布尔说明']);
    assert.deepStrictEqual(n.vwd.fields.map(f => f.col), ['str'], '本批只强制恢复文本 pair，数字/布尔不误启用');
    // 原契约不变：数字/布尔读回是标量，不是 [值, 说明]。
    const read = core.statDataFromTables(layout, template).stat_data;
    assert.deepStrictEqual(read, { N: { num: 1, flag: true, str: ['s', '文本说明'] } });
});

test('VWD动态说明：私有/只读 pair 列不进入说明范围，越权覆盖被忽略', () => {
    const schema = 'const S = z.object({ A: z.object({ pub: z.string(), _priv: z.string(), $hidden: z.string() }) }); registerMvuSchema(S);';
    const stat = { A: { pub: ['v', '公开说明'], _priv: ['s', '私有说明'], $hidden: ['h', '隐藏说明'] } };
    const { layout, template } = convert(stat, schema);
    const a = entryOf(layout, 'A');
    assert.deepStrictEqual(a.vwd.fields.map(f => f.col), ['pub']);
    assert.doesNotMatch(sheetOf(template, 'A表').sourceData.note, /VWD/, '私有列不参与插槽');
    const api = applyingApi(template);
    // 私有列的越权说明变化不参与 VWD：既不触发拒绝，也不会改变任何说明。
    const next = JSON.parse(JSON.stringify(stat));
    next.A._priv = ['s', '越权覆盖'];
    next.A.$hidden = ['h', '越权覆盖'];
    return core.writeStatDiffToDb(api, layout, stat, next).then(() => {
        assert.strictEqual(core.lastStatWriteFailed, false, '私有列不进入 VWD，不应触发说明拒绝');
        const read = core.statDataFromTables(layout, template).stat_data;
        assert.strictEqual(currentDescription(read, 'A', '_priv'), '私有说明');
        assert.strictEqual(currentDescription(read, 'A', '$hidden'), '隐藏说明');
    });
});

test('VWD动态说明：jsonPairOptional 字段同样登记，值列类型与缺省语义不变', () => {
    const schema = 'const S = z.object({ A: z.object({ opt: z.string().nullable() }) }); registerMvuSchema(S);';
    const stat = { A: { opt: ['值', '可空说明'] } };
    const { layout, template } = convert(stat, schema);
    const a = entryOf(layout, 'A');
    assert.strictEqual(a.cols.find(c => c[0] === 'opt')[1], 'jsonPairOptional');
    assert.deepStrictEqual(a.vwd.fields.map(f => f.col), ['opt']);
    assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, stat);
    // 显式缺省仍按原语义：空单元格 = 缺失字段，不因 VWD 变成 ['', '说明']。
    const empty = JSON.parse(JSON.stringify(template));
    const sheet = sheetOf(empty, 'A表');
    sheet.content[1][sheet.content[0].indexOf('opt')] = '';
    assert.deepStrictEqual(core.statDataFromTables(layout, empty).stat_data, { A: {} });
});

/* ---------------- B. 读回：覆盖 → 默认回退 ---------------- */

test('VWD动态说明：说明覆盖只影响目标字段，未登记键与非法元数据不改变读回', () => {
    const { layout, template } = convert();
    const put = raw => {
        const t = JSON.parse(JSON.stringify(template));
        const sheet = sheetOf(t, 'A表');
        sheet.content[1][metaIndex(sheet)] = raw;
        return core.statDataFromTables(layout, t).stat_data;
    };
    // 只改 other：str 保持静态默认。
    let read = put(JSON.stringify({ v: 1, o: { [JSON.stringify(['A', 'other'])]: '只改 other' } }));
    assert.strictEqual(currentDescription(read, 'A', 'str'), '相同说明');
    assert.strictEqual(currentDescription(read, 'A', 'other'), '只改 other');
    // 显式空说明是有效覆盖。
    read = put(JSON.stringify({ v: 1, o: { [JSON.stringify(['A', 'str'])]: '' } }));
    assert.strictEqual(currentDescription(read, 'A', 'str'), '');
    assert.strictEqual(currentDescription(read, 'A', 'other'), '相同说明');
    // 多行/引号/Unicode。
    const tricky = '第一行\n第二行 "引号" \\反斜杠\\ — ✅ 中文';
    read = put(JSON.stringify({ v: 1, o: { [JSON.stringify(['A', 'str'])]: tricky } }));
    assert.strictEqual(currentDescription(read, 'A', 'str'), tricky);
    // 非法元数据：逐键回退。未登记键、非字符串值、版本不符、无效 JSON 都不生效，
    // 但同一集合里合法的字符串项照常生效（契约见 docs/data-model.md）。
    const fallback = JSON.parse(JSON.stringify(DEFAULT_STAT));
    const idStr = JSON.stringify(['A', 'str']);
    assert.deepStrictEqual(put(JSON.stringify({ v: 1, o: { '["A","nope"]': 'x' } })), fallback);
    assert.deepStrictEqual(put(JSON.stringify({ v: 1, o: { [idStr]: 42 } })), fallback);
    assert.deepStrictEqual(put(JSON.stringify({ v: 9, o: { [idStr]: 'x' } })), fallback);
    assert.deepStrictEqual(put('{ not json'), fallback);
    assert.deepStrictEqual(put('null'), fallback);
    assert.deepStrictEqual(put('[1,2]'), fallback);
    assert.deepStrictEqual(put(''), fallback);
    // 混合：合法项生效、非法项忽略，两者互不影响。
    const mixed = put(JSON.stringify({ v: 1, o: { [idStr]: '有效覆盖', '["A","other"]': 42 } }));
    assert.deepStrictEqual(mixed.A.str, ['初始', '有效覆盖']);
    assert.deepStrictEqual(mixed.A.other, ['x', '相同说明'], '非法项不得覆盖该字段');
});

test('VWD动态说明：缺表回退时也按布局重建 pair 形状，不因 VWD 造出内部键', () => {
    const { layout } = convert();
    const fallback = core.statDataFromTables(layout, {}).stat_data;
    assert.deepStrictEqual(fallback.A, DEFAULT_STAT.A);
    assert.ok(!JSON.stringify(fallback).includes('说明覆盖'));
    for (const bad of [null, {}, { sheet_x: { name: 'A表', content: [] } }]) {
        const read = core.statDataFromTables(layout, bad).stat_data;
        assert.deepStrictEqual(read.A, DEFAULT_STAT.A);
    }
});

test('VWD动态说明：无 VWD 字段的表不产生槽位，note 与旧版逐字节一致', () => {
    const schema = 'const S = z.object({ P: z.object({ plain: z.string(), other: z.string() }) }); registerMvuSchema(S);';
    const stat = { P: { plain: '文字', other: ['v', '文字说明'] } };
    const { layout, template } = convert(stat, schema, 'both');
    const p = entryOf(layout, 'P');
    // plain 是普通标量：整表仍有 VWD 槽位，但只登记真正合格的字段。
    assert.deepStrictEqual(p.vwd.fields.map(f => f.col), ['other']);
    // 无说明的普通列不产生任何提示行（与旧版一致），也不残留内部 token。
    const note = sheetOf(template, 'P表').sourceData.note;
    assert.doesNotMatch(note, /- plain/, '无说明的普通列不应产生说明行');
    assert.doesNotMatch(note, /VWD|\u0000/);
    assert.match(note, /- other：文字说明/);
});

test('VWD动态说明：整表没有合格 VWD 字段时不产生元数据列与槽位', () => {
    const schema = 'const S = z.object({ P: z.object({ plain: z.string(), num: z.number() }) }); registerMvuSchema(S);';
    const stat = { P: { plain: '文字', num: 3 } };
    const { layout, template } = convert(stat, schema, 'both');
    const p = entryOf(layout, 'P');
    assert.strictEqual(p.vwd, undefined);
    assert.ok(!sheetOf(template, 'P表').content[0].includes('$说明覆盖'));
    assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, stat);
});

/* ---------------- C. note 插槽 ---------------- */

test('VWD动态说明：两个字段初始说明相同也各自替换，不靠全局 replace 猜位置', () => {
    const { layout, template } = convert();
    const a = entryOf(layout, 'A');
    assert.strictEqual(a.vwd.tokens.length, 2, '两个字段各自一个插槽');
    assert.notStrictEqual(a.vwd.fields[0].noteSlot, a.vwd.fields[1].noteSlot);
    // 转换期写进 sourceData 的是静态说明版，不含内部 token。
    const note = sheetOf(template, 'A表').sourceData.note;
    assert.doesNotMatch(note, /\u0000VWD/);
    assert.strictEqual((note.match(/相同说明/g) || []).length, 2);
    // 只改第二个字段：第一段说明保持原样，第二段替换。
    const t = JSON.parse(JSON.stringify(template));
    const sheet = sheetOf(t, 'A表');
    sheet.content[1][metaIndex(sheet)] = JSON.stringify({ v: 1, o: { [JSON.stringify(['A', 'other'])]: '委托完成，上限提高' } });
    const rebuilt = core.resolveVwdNote(a, sheet.content[1], sheet.content[0]);
    const lines = rebuilt.split('\n').filter(l => l.startsWith('- '));
    assert.deepStrictEqual(lines, ['- str：相同说明', '- other：委托完成，上限提高']);
    assert.strictEqual(rebuilt.split('\n').length, note.split('\n').length, '替换不改变行数');
});

test('VWD动态说明：多行/引号/Unicode 与空说明在 note 中正确渲染', () => {
    const { layout, template } = convert();
    const a = entryOf(layout, 'A');
    const rebuild = raw => {
        const t = JSON.parse(JSON.stringify(template));
        const sheet = sheetOf(t, 'A表');
        sheet.content[1][metaIndex(sheet)] = raw;
        return core.resolveVwdNote(a, sheet.content[1], sheet.content[0]);
    };
    const lines = note => note.split('\n').filter(l => l.startsWith('- '));
    let out = lines(rebuild(JSON.stringify({ v: 1, o: { [JSON.stringify(['A', 'str'])]: '第一行\n第二行' } })));
    // 多行说明按原样插入该字段的说明行位置（与旧版把 desc 内的换行直接并进 note 一致）。
    assert.match(rebuild(JSON.stringify({ v: 1, o: { [JSON.stringify(['A', 'str'])]: '第一行\n第二行' } })), /- str：第一行\n第二行\n- other：相同说明/);
    assert.deepStrictEqual(out, ['- str：第一行', '- other：相同说明']);
    out = lines(rebuild(JSON.stringify({ v: 1, o: { [JSON.stringify(['A', 'str'])]: '带 "引号" 与 \\反斜杠\\ 的 ✅ 说明' } })));
    assert.deepStrictEqual(out[0], '- str：带 "引号" 与 \\反斜杠\\ 的 ✅ 说明');
    // 显式空说明：说明行保留字段名（结构一致），其余字段与表级规则不丢。
    const emptyNote = rebuild(JSON.stringify({ v: 1, o: { [JSON.stringify(['A', 'str'])]: '' } }));
    assert.deepStrictEqual(lines(emptyNote), ['- str：', '- other：相同说明']);
    assert.match(emptyNote, /禁止 INSERT \/ DELETE/, '表级规则必须保留');
    // 元数据非法时 note 退回静态版，且与 sourceData.note 一致。
    assert.strictEqual(rebuild('{ bad'), sheetOf(template, 'A表').sourceData.note);
});

test('VWD动态说明：初始没有说明的字段本批不补 note 说明行（已声明边界）', () => {
    const schema = 'const S = z.object({ A: z.object({ bare: z.string() }) }); registerMvuSchema(S);';
    const stat = { A: { bare: ['v', ''] } };
    const { layout, template } = convert(stat, schema);
    const a = entryOf(layout, 'A');
    // 字段本身合格（值列形状与静态说明缺失都按原语义），但 note 里原本没有说明行，
    // 插槽计划不凭空造行：作者没写说明的字段，本批不支持事后“补上”说明。
    assert.deepStrictEqual(a.vwd.fields.map(f => f.col), ['bare']);
    assert.strictEqual(a.vwd.fields[0].desc, '');
    assert.strictEqual(a.vwd.fields[0].noteSlot, '');
    assert.deepStrictEqual(a.vwd.tokens, []);
    assert.doesNotMatch(sheetOf(template, 'A表').sourceData.note, /- bare/, '空说明不产生空壳行');
    // 说明槽位只替换已有说明；覆盖值仍能写库与读回，只是不会新增提示行。
    const t = JSON.parse(JSON.stringify(template));
    const sheet = sheetOf(t, 'A表');
    sheet.content[1][metaIndex(sheet)] = JSON.stringify({ v: 1, o: { [JSON.stringify(['A', 'bare'])]: '新补的说明' } });
    assert.strictEqual(core.resolveVwdNote(a, sheet.content[1], sheet.content[0]), sheetOf(template, 'A表').sourceData.note);
    assert.strictEqual(currentDescription(core.statDataFromTables(layout, t).stat_data, 'A', 'bare'), '新补的说明');
});

test('VWD动态说明：插槽计划不进入模型请求，note/DDL/示例均无内部 token', () => {
    const { template, layout } = convert(DEFAULT_STAT, DEFAULT_SCHEMA, 'sqlite');
    const sheet = sheetOf(template, 'A表');
    for (const field of ['note', 'initNode', 'insertNode', 'updateNode', 'deleteNode', 'ddl']) {
        assert.doesNotMatch(String(sheet.sourceData[field] || ''), /\u0000VWD/, field + ' 不应含内部插槽');
    }
    assert.doesNotMatch(JSON.stringify(sheet.content), /\u0000VWD/, '表内容不应含内部插槽');
    // 插槽只存在于内部布局里。
    assert.match(entryOf(layout, 'A').vwd.plan, /\u0000VWD/);
});

test('VWD动态说明：说明宏与列说明同一次替换，运行期回退不会拿到未替换原文', () => {
    const schema = 'const S = z.object({ A: z.object({ who: z.string() }) }); registerMvuSchema(S);';
    const stat = { A: { who: ['v', '说明给 {{char}}'] } };
    const { layout, template } = convert(stat, schema);
    const a = entryOf(layout, 'A');
    assert.strictEqual(a.vwd.fields[0].desc, '说明给 {{char}}');
    // 布局经过 resolveLayoutMacros 后，插槽计划的回退说明与 note 模板使用同一份文本。
    const resolved = core.resolveLayoutMacros([a], text => String(text).replace('{{char}}', '测试角色'));
    const plan = resolved[0].vwd;
    assert.strictEqual(plan.fields[0].desc, '说明给 测试角色');
    const note = core.resolveVwdNote(resolved[0], sheetOf(template, 'A表').content[1], sheetOf(template, 'A表').content[0]);
    assert.match(note, /- who：说明给 测试角色/);
});

/* ---------------- D. 与旧布局共存 ---------------- */

test('VWD动态说明：旧布局（无 vwd 槽位）行为完全不变', () => {
    const { layout, template } = convert();
    const legacy = JSON.parse(JSON.stringify(layout)).map(e => {
        if (e.vwd) delete e.vwd;
        e.cols = e.cols.filter(c => c[0] !== '$说明覆盖');
        return e;
    });
    // 旧布局按静态说明读回，且不因表里多出元数据列而报错或投影出内部键。
    assert.deepStrictEqual(core.statDataFromTables(legacy, template).stat_data, DEFAULT_STAT);
    const noMeta = JSON.parse(JSON.stringify(template));
    const sheet = sheetOf(noMeta, 'A表');
    const mi = sheet.content[0].indexOf('$说明覆盖');
    sheet.content[0].splice(mi, 1);
    sheet.content[1].splice(mi, 1);
    assert.deepStrictEqual(core.statDataFromTables(legacy, noMeta).stat_data, DEFAULT_STAT);
    // 元数据列存在但布局没有登记时也不参与投影。
    assert.deepStrictEqual(core.statDataFromTables(legacy, template).stat_data, DEFAULT_STAT);
});

test('VWD动态说明：元数据列名与业务字段碰撞时统一消歧，业务列不被顶替', () => {
    const schema = 'const S = z.object({ A: z.object({ $说明覆盖: z.string(), str: z.string() }) }); registerMvuSchema(S);';
    const stat = { A: { $说明覆盖: '作者自己的字段', str: ['v', '说明'] } };
    const { layout, template } = convert(stat, schema);
    const a = entryOf(layout, 'A');
    assert.notStrictEqual(a.vwd.metaCol, '$说明覆盖', '撞名时内部列必须改名');
    const header = sheetOf(template, 'A表').content[0];
    assert.ok(header.includes('$说明覆盖'), '作者的业务列名必须保留');
    assert.ok(header.includes(a.vwd.metaCol), '内部列用消歧后的物理名');
    assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, stat);
});

test('VWD动态说明：目标 SP 版本不支持隐藏列时不新增可见内部列并给出降级警告', () => {
    for (const targetSpVersion of ['9.2.4', 'unknown']) {
        const { layout, template, result } = convert(DEFAULT_STAT, DEFAULT_SCHEMA, 'both', targetSpVersion);
        assert.match(result.reportText, /不支持可靠隐藏内部物理列/);
        assert.match(result.reportText, /动态说明（VWD）实验路径本次不登记/, '降级提示不得暗示“升级即可启用”');
        const sheet = sheetOf(template, 'A表');
        assert.strictEqual(sheet.sourceData.hiddenPhysicalColumns, undefined);
        assert.ok(!sheet.content[0].includes('$说明覆盖'), targetSpVersion + ' 不该新增可能对 AI 可见的内部列');
        assert.strictEqual(entryOf(layout, 'A').vwd, undefined);
        assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, DEFAULT_STAT);
    }
});

test('VWD动态说明：SP 无公开 note 更新接口时，说明变化在第一次写之前整体拒绝', async () => {
    const { layout, template } = convert();
    const api = applyingApi(template);
    const calls = [];
    const spy = Object.assign({}, api, {
        updateRow: async (t, r, p) => { calls.push(['updateRow', Object.keys(p).sort().join(',')]); return api.updateRow(t, r, p); },
        updateCell: async (t, r, c, v) => { calls.push(['updateCell', c]); return api.updateCell(t, r, c, v); },
    });
    const snapshot = JSON.stringify(template);
    // 只改说明：拒绝，数据与调用都保持原样。
    let next = withDescription(DEFAULT_STAT, 'A', 'str', '改说明');
    assert.strictEqual(await core.writeStatDiffToDb(spy, layout, DEFAULT_STAT, next), 0);
    assert.strictEqual(core.lastStatWriteFailed, true, '说明变化必须显式报失败，不能谎报成功');
    assert.deepStrictEqual(calls, [], '拒绝必须发生在任何写入之前');
    assert.strictEqual(JSON.stringify(template), snapshot);
    // 同时改值与说明：说明无法同步，整笔在写之前拒绝，绝不落“新值 + 旧说明”。
    calls.length = 0;
    next = withDescription(DEFAULT_STAT, 'A', 'str', '两项都改');
    next.A.str[0] = '新值';
    assert.strictEqual(await core.writeStatDiffToDb(spy, layout, DEFAULT_STAT, next), 0);
    assert.strictEqual(core.lastStatWriteFailed, true);
    assert.deepStrictEqual(calls, [], '值 + 说明的整笔必须一起被拒绝');
    assert.strictEqual(JSON.stringify(template), snapshot);
    const read = core.statDataFromTables(layout, template).stat_data;
    assert.deepStrictEqual(read, DEFAULT_STAT, '拒绝后不得留下“新值 + 旧说明”');
});

test('VWD动态说明：说明未变化的普通填表零影响（只改值不写元数据列）', async () => {
    const { layout, template } = convert();
    const written = [];
    const api = applyingApi(template);
    const spy = Object.assign({}, api, {
        updateCell: async (t, r, c, v) => { written.push(['cell', t, c]); return api.updateCell(t, r, c, v); },
        updateRow: async (t, r, p) => { written.push(['row', t, Object.keys(p).sort().join(',')]); return api.updateRow(t, r, p); },
    });
    const next = JSON.parse(JSON.stringify(DEFAULT_STAT));
    next.A.other[0] = '新值';
    await core.writeStatDiffToDb(spy, layout, DEFAULT_STAT, next);
    assert.strictEqual(core.lastStatWriteFailed, false);
    assert.ok(written.every(call => !call[2].includes('$说明覆盖')), '说明未变化时不该写元数据列');
    assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, next);
});

// 说明差量的“值 + 说明一次提交”形状只在宿主具备 note 同步能力后启用；
// 这里通过注入的能力开关固定该提交契约，避免将来启用时退化成两次可部分成功的写入。
test('VWD动态说明：宿主具备 note 同步能力时，说明差量与值走同一次提交', async () => {
    const createWriter = require('../src/table-writer');
    const writer = createWriter({ parseJson: v => { try { return JSON.parse(v); } catch (e) { return null; } }, vwdNoteSyncSupported: () => true });
    const singleton = {
        kind: 'singleton', group: 'A', table: 'A表', keyCol: '键名', keyValue: 'A', writePaths: [],
        cols: [
            ['str', 'pair', '初始', ['A', 'str'], true, '相同说明'],
            ['other', 'pair', 'x', ['A', 'other'], true, '相同说明'],
            ['_扩展数据', 'object', '', ['A', '_扩展数据'], false, ''],
            ['$说明覆盖', 'object', '', ['A', '$说明覆盖'], false, ''],
        ],
        vwd: { v: 1, metaCol: '$说明覆盖', fields: [
            { id: JSON.stringify(['A', 'str']), col: 'str', path: ['A', 'str'], type: 'pair', desc: '相同说明', noteSlot: 'slot0' },
            { id: JSON.stringify(['A', 'other']), col: 'other', path: ['A', 'other'], type: 'pair', desc: '相同说明', noteSlot: 'slot1' },
        ], tokens: [], plan: '', noteTemplate: '' },
    };
    const tables = { sheet_a: { name: 'A表', content: [['row_id', 'str', 'other', '_扩展数据', '$说明覆盖'], [1, '初始', 'x', '{}', '{}']] } };
    const id = JSON.stringify(['A', 'str']);
    const calls = [];
    const api = {
        exportTableAsJson: () => tables,
        updateRow: async (t, r, p) => { calls.push(Object.keys(p).sort()); for (const c of Object.keys(p)) tables.sheet_a.content[r][tables.sheet_a.content[0].indexOf(c)] = String(p[c]); return true; },
        updateCell: async () => { throw new Error('不应回退到 updateCell'); },
        insertRow: async () => 1, deleteRow: async () => true,
    };
    const before = { A: { str: ['初始', '相同说明'], other: ['x', '相同说明'] } };
    // 只改说明（值不变）：也必须能与值一起走一次 updateRow。
    let n = await writer.writeStatDiffToDb(api, [singleton], before, { A: { str: ['初始', '改说明'], other: ['x', '相同说明'] } });
    assert.strictEqual(writer.lastStatWriteFailed, false, '具备同步能力时说明差量应正常提交');
    assert.ok(n > 0);
    assert.deepStrictEqual(calls, [['$说明覆盖']], '只改说明时只写内部元数据列，且一次提交');
    assert.strictEqual(tables.sheet_a.content[1][1], '初始', '只改说明时值列不变');
    assert.deepStrictEqual(JSON.parse(tables.sheet_a.content[1][4]), { v: 1, o: { [id]: '改说明' } });

    // 值与说明同时变化：同样一次 updateRow，不能拆成两个可部分成功的调用。
    calls.length = 0;
    const after = { A: { str: ['新值', '再改说明'], other: ['x', '相同说明'] } };
    n = await writer.writeStatDiffToDb(api, [singleton], { A: { str: ['初始', '改说明'], other: ['x', '相同说明'] } }, after);
    assert.strictEqual(writer.lastStatWriteFailed, false);
    assert.ok(n > 0);
    assert.deepStrictEqual(calls, [['$说明覆盖', 'str']], '值 + 说明必须一次 updateRow 提交');
    assert.strictEqual(tables.sheet_a.content[1][1], '新值');
    assert.deepStrictEqual(JSON.parse(tables.sheet_a.content[1][4]), { v: 1, o: { [id]: '再改说明' } });
});

test('VWD动态说明：宿主不具备 note 同步能力时，说明差量在写库前整体拒绝', async () => {
    const createWriter = require('../src/table-writer');
    const writer = createWriter({ parseJson: v => { try { return JSON.parse(v); } catch (e) { return null; } }, vwdNoteSyncSupported: () => false });
    const { layout, template } = convert();
    const api = applyingApi(template);
    const calls = [];
    const spy = Object.assign({}, api, {
        updateRow: async (t, r, p) => { calls.push(['updateRow']); return api.updateRow(t, r, p); },
        updateCell: async (t, r, c, v) => { calls.push(['updateCell']); return api.updateCell(t, r, c, v); },
    });
    const snapshot = JSON.stringify(template);
    const n = await writer.writeStatDiffToDb(spy, layout, DEFAULT_STAT, withDescription(DEFAULT_STAT, 'A', 'str', '改说明'));
    assert.strictEqual(n, 0);
    assert.strictEqual(writer.lastStatWriteFailed, true);
    assert.deepStrictEqual(calls, [], '拒绝必须发生在任何写入之前');
    assert.strictEqual(JSON.stringify(template), snapshot, '拒绝后数据库内容不得变化');
});

/* ---------------- E. 默认关闭（R2） ----------------
 * VWD 是默认关闭的实验能力：普通转换必须与交接前的冻结基线逐字节一致。
 */

const DEFAULT_OFF_SCHEMA = `const S = z.object({
  A: z.object({ str: z.string(), other: z.string(), num: z.number().nullable() }),
  Rows: z.record(z.string(), z.object({ s: z.string() })),
  Arr: z.array(z.string())
}); registerMvuSchema(S);`;

const DEFAULT_OFF_STAT = {
    A: { str: ['初始', '静态说明'], other: ['x', '另一说明'], num: 3 },
    Rows: { one: { s: ['v', '记录说明'] } },
    Arr: ['a', 'b'],
};

function convertWithFlag(stat, schema, vwd) {
    const previous = core.isVwdExperimental();
    core.setVwdExperimental(vwd);
    try {
        const result = core.convert({
            name: 'VWD默认关闭对照', first_mes: '',
            extensions: { tavern_helper: { scripts: [{ name: '变量结构', content: schema }] } },
            character_book: { entries: [{ comment: '[InitVar]', content: JSON.stringify(stat) }] },
        }, { mode: 'both' });
        return { result, template: result.template, layout: JSON.parse((result.card.data || result.card).extensions.mvu2shujuku.layout) };
    } finally { core.setVwdExperimental(previous); }
}

test('VWD动态说明：默认关闭时不新增元数据列、vwd 布局或说明拒绝', async () => {
    const { layout, template, result } = convertWithFlag(DEFAULT_OFF_STAT, DEFAULT_OFF_SCHEMA, false);
    // 结构：没有内部列，也没有可选槽位。
    for (const sheet of Object.values(template)) {
        if (!sheet || !Array.isArray(sheet.content)) continue;
        assert.ok(!sheet.content[0].includes('$说明覆盖'), sheet.name + ' 默认不应出现内部说明列');
    }
    assert.strictEqual(layout.find(e => e.group === 'A').vwd, undefined);
    assert.strictEqual(layout.find(e => e.group === 'Rows').vwd, undefined);
    assert.ok(!result.reportText.includes('说明覆盖'), '转换报告不应提到内部列');
    assert.ok(!result.reportText.includes('动态说明（VWD）'), '默认不应出现 VWD 降级或启用提示');
    // 读回：仍是静态说明，且没有内部键。
    const sheet = sheetOf(template, 'A表');
    assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, DEFAULT_OFF_STAT);
    // 行为：默认关闭时不引入新的说明拒绝策略。旧式 pair 写入修复后，pair 叶子在写库
    // 边界只写当前值，因此不再等于“整段数组落库”的旧冻结数据；这里对照重新冻结的
    // test/vwd-static-pair-fixed.json，并断言读回恢复出 [值, 静态说明]。
    const runWrite = async (mod) => {
        const tpl = JSON.parse(JSON.stringify(template));
        const api = applyingApi(tpl);
        const next = JSON.parse(JSON.stringify(DEFAULT_OFF_STAT));
        next.A.str = ['新值', '新说明'];
        const n = await mod.writeStatDiffToDb(api, layout, DEFAULT_OFF_STAT, next);
        return { n, failed: mod.lastStatWriteFailed, sheet: sheetOf(tpl, 'A表') };
    };
    const baseline = require('./vwd-static-pair-fixed.json');
    const now = await runWrite(core);
    const base = baseline.defaultWrite;
    assert.strictEqual(now.failed, false, '默认关闭时不应出现 VWD 说明拒绝');
    assert.strictEqual(now.failed, base.failed);
    // 旧冻结 n=3 含两个未变化 pair 的重复写入；内容仍与冻结一致，实际只需一次修改。
    assert.strictEqual(now.n, 1);
    assert.deepStrictEqual(now.sheet.content, base.sheet.content, '默认关闭时的表格内容应与重新冻结结果一致');
    const strIdx = now.sheet.content[0].indexOf('str');
    assert.strictEqual(now.sheet.content[1][strIdx], '新值', 'pair 列只应写入当前值，不得是整段数组的拼接文本');
    const read = core.statDataFromTables(layout, { sheet_test: now.sheet }).stat_data;
    assert.deepStrictEqual(read.A.str, ['新值', '静态说明'], '读回应恢复值 + 静态说明，说明未被数组文本污染');
});

test('VWD动态说明：默认关闭模板保留冻结基线，仅允许后续新增的 SQL 示例及说明', () => {
    const baseline = require('./vwd-static-before.json');
    const base = baseline.conversion;
    const now = convertWithFlag(DEFAULT_OFF_STAT, DEFAULT_OFF_SCHEMA, false);
    const baseLayout = base.layout;
    // 2026-09-23 双模式恢复 SQL 参考，这是独立的提示改动；保留原冻结数据，
    // 只排除明确新增的示例及说明，表数据、DDL、原 note 和业务触发原文仍逐字节对照。
    const comparable = JSON.parse(JSON.stringify(now.template));
    for (const sheet of Object.values(comparable)) {
        if (!sheet.sourceData) continue;
        sheet.sourceData.note = sheet.sourceData.note.replace(/\nSQL 示例仅演示写法[^\n]*$/, '');
        for (const field of ['insertNode', 'updateNode', 'deleteNode']) {
            sheet.sourceData[field] = sheet.sourceData[field].split('\nSQL示例:')[0];
        }
    }
    assert.deepStrictEqual(comparable, base.template, '除新增 SQL 示例及说明外，默认模板应与冻结基线一致');
    assert.deepStrictEqual(now.layout, baseLayout, '默认布局应与冻结基线一致');
});

/* ---------------- F. 候选快照构造入口（R1） ----------------
 * 复用扩展运行时的**真实** buildUpdatedTemplateFromStat（不是替身预检），
 * 验证说明变化在候选被接受之前就被拒绝，不会产出“新值 + 旧说明”。
 */

const createCandidateBuilder = require('../src/extension-runtime.js').createCandidateBuilder;

function candidateOutcome(layout, prevStat, nextStat, template, warnings) {
    const builder = createCandidateBuilder({
        core,
        warn: (...args) => { if (warnings) warnings.push(args.map(String).join(' ')); },
    });
    const value = builder.buildUpdatedTemplateFromStat(layout, prevStat, nextStat, template);
    return typeof value === 'object' && value !== null && typeof value.then === 'function'
        ? value.then(v => ({ candidate: v, warnings: warnings || [] }), e => ({ candidate: null, error: e.message, warnings: warnings || [] }))
        : { candidate: value === undefined ? null : value, warnings: warnings || [] };
}

function readStr(template, layout) {
    return core.statDataFromTables(layout, template).stat_data.A.str;
}

test('VWD动态说明：候选构造对只改说明整笔拒绝，不产出“新值 + 旧说明”', async () => {
    const { layout, template } = convert();
    const next = withDescription(DEFAULT_STAT, 'A', 'str', '新说明');
    const warnings = [];
    const { candidate, error } = await candidateOutcome(layout, DEFAULT_STAT, next, template, warnings);
    assert.strictEqual(candidate, null, '说明变化必须让候选构造失败');
    assert.match(warnings.join('\n'), /说明变化无法同步进提示词/, '应给出可读的拒绝原因');
    // 模板本身没被改动，读回仍是旧值与旧说明。
    assert.deepStrictEqual(readStr(template, layout), ['初始', '相同说明']);
    assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, DEFAULT_STAT);
});

test('VWD动态说明：候选构造对同时改值与说明整笔拒绝', async () => {
    const { layout, template } = convert();
    const next = withDescription(DEFAULT_STAT, 'A', 'str', '两项都改');
    next.A.str[0] = '新值';
    const { candidate } = await candidateOutcome(layout, DEFAULT_STAT, next, template);
    assert.strictEqual(candidate, null, '值 + 说明必须一起被拒绝，不能只落值');
    assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, DEFAULT_STAT);
});

test('VWD动态说明：候选构造对只改值放行并保留静态说明', async () => {
    const { layout, template } = convert();
    const next = JSON.parse(JSON.stringify(DEFAULT_STAT));
    next.A.str[0] = '只改值';
    next.A.other[0] = '其他也改';
    const { candidate } = await candidateOutcome(layout, DEFAULT_STAT, next, template);
    assert.ok(candidate && typeof candidate === 'object', '只改值不应被拒绝');
    const read = core.statDataFromTables(layout, candidate).stat_data;
    assert.strictEqual(read.A.str[0], '只改值');
    assert.strictEqual(read.A.str[1], '相同说明', '说明应保持静态默认');
    assert.strictEqual(read.A.other[0], '其他也改');
});

test('VWD动态说明：初始为空说明的字段改说明也被拒绝，不写入永不呈现的说明', async () => {
    const schema = 'const S = z.object({ A: z.object({ str: z.string().nullable() }) }); registerMvuSchema(S);';
    const stat = { A: { str: ['初始', ''] } };
    // 初始说明为空字符串：字段仍是合格的 pair 列，但没有可用的 note 说明行。
    const { layout, template } = convert(stat, schema);
    const before = core.statDataFromTables(layout, template).stat_data;
    const next = JSON.parse(JSON.stringify(before));
    next.A.str = ['新值', '首次增加说明'];
    // 直接 writer：拒绝。
    await core.writeStatDiffToDb(applyingApi(template), layout, before, next);
    assert.strictEqual(core.lastStatWriteFailed, true, '无插槽字段的说明变化也必须拒绝');
    // 候选构造：同样拒绝。
    const { candidate } = await candidateOutcome(layout, before, next, template);
    assert.strictEqual(candidate, null, '候选构造也必须拒绝无插槽字段的说明变化');
    assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, before);
});

test('VWD动态说明：候选构造对字段缺失/说明缺失不误判为说明变化', async () => {
    const { layout, template } = convert();
    // 整个可选字段从 stat 中消失：不是说明变化。
    const removed = { A: { other: DEFAULT_STAT.A.other } };
    const { candidate } = await candidateOutcome(layout, DEFAULT_STAT, removed, template);
    assert.ok(candidate && typeof candidate === 'object', '字段缺失不应被当成说明变化');
    // 说明缺失（值本身是标量）：也不是说明变化。
    const scalar = { A: { str: '裸标量', other: DEFAULT_STAT.A.other } };
    const { candidate: candidate2 } = await candidateOutcome(layout, DEFAULT_STAT, scalar, template);
    assert.ok(candidate2 && typeof candidate2 === 'object', '非 pair 形状不应被当成说明变化');
});

test('VWD动态说明：说明变化在候选路径也不产生任何宿主写入', async () => {
    const { layout, template } = convert();
    const calls = [];
    const api = applyingApi(template);
    const spy = Object.assign({}, api, {
        updateRow: async (t, r, p) => { calls.push(['updateRow']); return api.updateRow(t, r, p); },
        updateCell: async (t, r, c, v) => { calls.push(['updateCell']); return api.updateCell(t, r, c, v); },
        insertRow: async (t, o) => { calls.push(['insertRow']); return api.insertRow(t, o); },
        deleteRow: async (t, r) => { calls.push(['deleteRow']); return api.deleteRow(t, r); },
    });
    // 候选路径用的是内部 fakeApi；这里确认 writer 入口在拒绝时不触碰真实 API。
    const rejected = await core.writeStatDiffToDb(spy, layout, DEFAULT_STAT, withDescription(DEFAULT_STAT, 'A', 'str', '改说明'));
    assert.strictEqual(rejected, 0);
    assert.deepStrictEqual(calls, [], '拒绝路径不得产生任何 CRUD');
    const { candidate } = await candidateOutcome(layout, DEFAULT_STAT, withDescription(DEFAULT_STAT, 'A', 'str', '改说明'), template);
    assert.strictEqual(candidate, null, '候选构造应拒绝说明变化');
    assert.deepStrictEqual(calls, [], '候选拒绝同样不得产生 CRUD');
});

test('VWD动态说明：默认关闭时 pair 写入只落当前值（重新冻结对照，R2.3）', async () => {
    const baseline = require('./vwd-static-pair-fixed.json');
    const card = () => ({
        name: 'pair写入对照', first_mes: '',
        character_book: { entries: [
            { comment: '[InitVar]', content: 'R:\n  甲:\n    好感: [1, "好感说明"]\n    名称: ["甲", "名"]\n其他: "x"' },
            { comment: '[mvu_update]', content: '变量更新规则:\n  R:\n    type: "{ [名称: string]: { 好感: number; 名称: string; } }"' },
        ] },
    });
    const runOnce = async (mod, enableExperimental) => {
        const previous = core.isVwdExperimental();
        if (mod === core) core.setVwdExperimental(!!enableExperimental);
        try {
            const result = mod.convert(card(), { mode: 'both' });
            const layout = JSON.parse((result.card.data || result.card).extensions.mvu2shujuku.layout);
            const template = JSON.parse(JSON.stringify(result.template));
            const calls = [];
            const api = applyingApi(template);
            const spy = Object.assign({}, api, {
                updateRow: async (t, r, p) => { calls.push(['updateRow', JSON.stringify(p)]); return api.updateRow(t, r, p); },
                updateCell: async (t, r, c, v) => { calls.push(['updateCell', c, JSON.stringify(v)]); return api.updateCell(t, r, c, v); },
                insertRow: async (t, o) => { calls.push(['insertRow', JSON.stringify(o)]); return api.insertRow(t, o); },
            });
            const prev = { R: { 甲: { 好感: [1, '好感说明'], 名称: ['甲', '名'] } }, 其他: 'x' };
            const next = { R: { 甲: { 好感: [2, '好感说明'], 名称: ['乙', '名'] } }, 其他: 'x' };
            const n = await mod.writeStatDiffToDb(spy, layout, prev, next);
            return { n, failed: mod.lastStatWriteFailed, calls, row: Object.values(template).find(s => s && s.name === 'R表').content[1] };
        } finally { if (mod === core) core.setVwdExperimental(previous); }
    };
    const base = baseline.rowWrite;
    const now = await runOnce(core, false);
    assert.deepStrictEqual(now.calls, base.calls, '写入调用应与重新冻结结果一致');
    assert.deepStrictEqual(now.row, base.row, '表格内容应与重新冻结结果一致');
    assert.strictEqual(now.failed, base.failed);
    assert.deepStrictEqual(now.row, [1, '甲', '2', '乙', '{}'], '数字 pair 与文本 pair 都只写当前值');
    assert.deepStrictEqual(base.read.甲, { 好感: 2, 名称: ['乙', '名'] }, '读回应恢复数字 2 与 pair 形状');
});

test('VWD动态说明：默认关闭时整段 pair 写入只落当前值（含先改说明再改值）', async () => {
    const baseline = require('./vwd-static-pair-fixed.json');
    const card = () => ({
        name: 'pair序列对照', first_mes: '',
        character_book: { entries: [
            { comment: '[InitVar]', content: 'A:\n  str: ["初始", "旧说明"]\n  other: ["x", "其他说明"]' },
            { comment: '[mvu_update]', content: '变量更新规则:\n  A:\n    type: "{ str: string; other: string; }"' },
        ] },
    });
    // 复刻实机序列：先整段改说明，再整段改值。旧契约会把整段数组落成一列，
    // 这条用例固定“默认关闭时与冻结基线逐字节一致”，避免本次实验改动旧卡行为。
    const runSequence = async (mod) => {
        const result = mod.convert(card(), { mode: 'both' });
        const layout = JSON.parse((result.card.data || result.card).extensions.mvu2shujuku.layout);
        const template = JSON.parse(JSON.stringify(result.template));
        const api = applyingApi(template);
        const prev = { A: { str: ['初始', '旧说明'], other: ['x', '其他说明'] } };
        await mod.writeStatDiffToDb(api, layout, prev, prev);
        const described = { A: { str: ['初始', '已完成委托'], other: ['x', '其他说明'] } };
        await mod.writeStatDiffToDb(api, layout, prev, described);
        const afterDesc = mod.statDataFromTables(layout, template).stat_data;
        await mod.writeStatDiffToDb(api, layout, afterDesc, { A: { str: ['小乙二', '当前称呼'], other: ['x', '其他说明'] } });
        const afterValue = mod.statDataFromTables(layout, template).stat_data;
        return {
            afterDesc: afterDesc.A,
            afterValue: afterValue.A,
            row: Object.values(template).find(s => s && s.name === 'A表').content[1],
        };
    };
    const previous = core.isVwdExperimental();
    core.setVwdExperimental(false);
    try {
        const base = baseline.pairSequence;
        const now = await runSequence(core);
        assert.deepStrictEqual(now.row, base.row, '表格内容应与重新冻结结果一致');
        assert.deepStrictEqual(now.afterDesc, base.afterDesc, '改说明后的读回应与重新冻结结果一致');
        assert.deepStrictEqual(now.afterValue, base.afterValue, '改值后的读回应与重新冻结结果一致');
        // 修复后的正确语义：值列是标量文本，读回恢复 [值, 说明]；不再出现数组拼接文本。
        assert.deepStrictEqual(now.row, [1, '小乙二', 'x', '{}']);
        assert.deepStrictEqual(now.afterValue.str, ['小乙二', '旧说明']);
        assert.deepStrictEqual(now.afterValue.other, ['x', '其他说明']);
    } finally { core.setVwdExperimental(previous); }
});

/* ---------------- G. 旧式 pair 写入边界（写库只落当前值） ----------------
 * 宿主单元格只接受字符串/数字；SP 的 SyncBridge 收到数组会在 SQLite hydrate 阶段抛
 * `val.replace is not a function` 并回退 native。这里用一个只接受字符串/数字的严格
 * 宿主替身复现该约束，验证写库边界按 layout 声明取出“当前值”。
 */

function strictHost(tables) {
    const seen = [];
    const sheetOf = name => Object.values(tables).find(s => s && s.name === name);
    const record = (where, value) => {
        seen.push({ where, type: Array.isArray(value) ? 'array' : typeof value, value });
    };
    return {
        seen,
        api: {
            exportTableAsJson: () => tables,
            // 模板缺失时按布局默认值补初始行（与真实 SP 的 getTableTemplate 语义一致）。
            getTableTemplate: async () => null,
            // 数组多步变更需要一次原子整表导入。
            importTableAsJson: async json => { const parsed = JSON.parse(json); for (const k of Object.keys(tables)) delete tables[k]; Object.assign(tables, parsed); return true; },
            updateCell: async (t, ri, col, v) => { record('updateCell.' + t + '.' + col, v); const s = sheetOf(t); if (!s || !s.content[ri]) return false; const ci = s.content[0].indexOf(col); if (ci < 0) return false; s.content[ri][ci] = v; return true; },
            updateRow: async (t, ri, p) => {
                const s = sheetOf(t);
                if (!s || !s.content[ri]) return false;
                for (const k of Object.keys(p)) record('updateRow.' + t + '.' + k, p[k]);
                for (const k of Object.keys(p)) { const ci = s.content[0].indexOf(k); if (ci >= 0) s.content[ri][ci] = p[k]; }
                return true;
            },
            insertRow: async (t, o) => {
                const s = sheetOf(t);
                if (!s) return 0;
                for (const k of Object.keys(o)) record('insertRow.' + t + '.' + k, o[k]);
                const row = s.content[0].map(h => (h in o ? o[h] : ''));
                row[0] = s.content.length;
                s.content.push(row);
                return row[0];
            },
            deleteRow: async () => true,
        },
    };
}

const PAIR_BOUNDARY_SCHEMA = 'const S = z.object({ A: z.object({ str: z.string(), other: z.string(), num: z.number() }) }); registerMvuSchema(S);';
const PAIR_BOUNDARY_STAT = { A: { str: ['初始', '旧说明'], other: ['x', '其他说明'], num: 3 } };

// 旧式 pair 写入缺陷发生在**默认关闭**的普通布局上：这里用与 R2 相同的默认转换，
// 不打开 VWD 实验能力（打开后说明变化会被拒绝，无法覆盖本缺陷的写入路径）。
function convertDefault(stat, schema) {
    const previous = core.isVwdExperimental();
    core.setVwdExperimental(false);
    try {
        const result = core.convert({
            name: 'pair写入边界', first_mes: '',
            extensions: { tavern_helper: { scripts: [{ name: '变量结构', content: schema }] } },
            character_book: { entries: [{ comment: '[InitVar]', content: JSON.stringify(stat) }] },
        }, { mode: 'both' });
        return { result, template: result.template, layout: JSON.parse((result.card.data || result.card).extensions.mvu2shujuku.layout) };
    } finally { core.setVwdExperimental(previous); }
}

test('旧式 pair 写入：单例整段写入只把当前值交给宿主，读回恢复 pair 形状', async () => {
    const { layout, template } = convertDefault(PAIR_BOUNDARY_STAT, PAIR_BOUNDARY_SCHEMA);
    const host = strictHost(template);
    await core.writeStatDiffToDb(host.api, layout, PAIR_BOUNDARY_STAT, { A: { str: ['初始', '已完成委托'], other: ['x', '其他说明'], num: 3 } });
    assert.strictEqual(core.lastStatWriteFailed, false);
    assert.deepStrictEqual(host.seen, [], '静态说明变化不需要重复写入未改变的值');
    const next = { A: { str: ['新值', '已完成委托'], other: ['x', '其他说明'], num: 3 } };
    await core.writeStatDiffToDb(host.api, layout, PAIR_BOUNDARY_STAT, next);
    assert.strictEqual(core.lastStatWriteFailed, false);
    assert.ok(host.seen.length > 0, '当前值变化必须实际经过写库边界');
    for (const call of host.seen) {
        assert.ok(call.type === 'string' || call.type === 'number',
            call.where + ' 收到 ' + call.type + '，宿主只接受字符串/数字：' + JSON.stringify(call.value));
    }
    const sheet = sheetOf(template, 'A表');
    assert.strictEqual(sheet.content[1][sheet.content[0].indexOf('str')], '新值', '值列应是当前值，不是数组拼接文本');
    const read = core.statDataFromTables(layout, template).stat_data;
    // 默认关闭时不写说明（说明由 VWD 承载、当前未启用），读回是 layout 静态说明。
    assert.deepStrictEqual(read.A.str, ['新值', '旧说明'], '读回恢复 [当前值, 静态说明]');
    assert.strictEqual(read.A.str[0], '新值', '值不得被说明文本污染');
});

test('旧式 pair 写入：数字 pair 与文本 pair 在行表都只落当前值', async () => {
    const schema = 'const S = z.object({ R: z.record(z.string(), z.object({ 好感: z.number(), 名称: z.string() })) }); registerMvuSchema(S);';
    const stat = { R: { 甲: { 好感: [1, '好感说明'], 名称: ['甲', '名'] } } };
    const { layout, template } = convertDefault(stat, schema);
    const host = strictHost(template);
    await core.writeStatDiffToDb(host.api, layout, stat, { R: { 甲: { 好感: [2, '好感说明'], 名称: ['乙', '名'] } } });
    assert.strictEqual(core.lastStatWriteFailed, false);
    for (const call of host.seen) {
        assert.ok(call.type === 'string' || call.type === 'number',
            call.where + ' 收到 ' + call.type + '：' + JSON.stringify(call.value));
    }
    const read = core.statDataFromTables(layout, template).stat_data;
    assert.strictEqual(read.R.甲.好感, 2, '数字 pair 的当前值应是数字 2');
    assert.deepStrictEqual(read.R.甲.名称, ['乙', '名'], '文本 pair 读回值 + 静态说明');
});

test('旧式 pair 写入：普通数组列与 JSON 列不被误拆', async () => {
    const schema = 'const S = z.object({ Arr: z.array(z.number()), Obj: z.object({ x: z.number(), y: z.number() }) }); registerMvuSchema(S);';
    const stat = { Arr: [1, 2], Obj: { x: 1, y: 2 } };
    const { layout, template } = convertDefault(stat, schema);
    const host = strictHost(template);
    // 真实数组仍是数组（不得被当成 pair 取第一项）。
    await core.writeStatDiffToDb(host.api, layout, stat, { Arr: [3, 4], Obj: { x: 1, y: 5 } });
    assert.strictEqual(core.lastStatWriteFailed, false);
    const read = core.statDataFromTables(layout, template).stat_data;
    assert.deepStrictEqual(read.Arr, [3, 4], '普通数组必须完整保留，不能被拆成第一项');
    assert.deepStrictEqual(read.Obj, { x: 1, y: 5 }, 'JSON 对象按键更新，不得被拆包');
});

test('旧式 pair 写入：显式 null 与缺失仍按现有语义处理', async () => {
    const schema = 'const S = z.object({ A: z.object({ opt: z.string().nullable() }) }); registerMvuSchema(S);';
    const stat = { A: { opt: ['值', '说明'] } };
    const { layout, template } = convertDefault(stat, schema);
    const host = strictHost(template);
    // 可空 pair 仍按 JSON 编码保留显式 null，不回退初始文本。
    await core.writeStatDiffToDb(host.api, layout, stat, { A: { opt: [null, '说明'] } });
    assert.strictEqual(core.lastStatWriteFailed, false);
    assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data.A.opt, [null, '说明'], '可空值必须保留 null，不能恢复初始文本');
    for (const call of host.seen) {
        assert.ok(call.type === 'string' || call.type === 'number',
            call.where + ' 收到 ' + call.type + '：' + JSON.stringify(call.value));
    }
    // 整段缺失（键被删除）走原有缺失语义，不产生数组写入。
    host.seen.length = 0;
    await core.writeStatDiffToDb(host.api, layout, { A: { opt: [null, '说明'] } }, { A: {} });
    assert.strictEqual(core.lastStatWriteFailed, false);
    assert.ok(!Object.prototype.hasOwnProperty.call(core.statDataFromTables(layout, template).stat_data.A, 'opt'), '删除后必须保持缺失，不能恢复默认值');
    for (const call of host.seen) {
        assert.ok(call.type === 'string' || call.type === 'number',
            call.where + ' 收到 ' + call.type + '：' + JSON.stringify(call.value));
    }
});

test('旧式 pair 写入：新增记录的数字和布尔 pair 也编码为物理标量', async () => {
    const schema = 'const S = z.object({ R: z.record(z.string(), z.object({ n: z.number(), flag: z.boolean(), label: z.string() })) }); registerMvuSchema(S);';
    const stat = { R: { one: { n: [1, '数值'], flag: [false, '开关'], label: ['甲', '名称'] } } };
    const { layout, template } = convertDefault(stat, schema);
    const host = strictHost(template);
    const next = JSON.parse(JSON.stringify(stat));
    next.R.two = { n: [2, '数值'], flag: [true, '开关'], label: ['乙', '名称'] };
    await core.writeStatDiffToDb(host.api, layout, stat, next);
    assert.strictEqual(core.lastStatWriteFailed, false);
    assert.ok(host.seen.some(c => c.where.startsWith('insertRow.')), '必须实际经过新增记录路径');
    assert.deepStrictEqual(host.seen.filter(c => !['string', 'number'].includes(c.type)), [], '新增行不能把数组或布尔值直接存入物理单元格');
    assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data.R.two, { n: 2, flag: true, label: ['乙', '名称'] });
});

test('旧式 pair 写入：布尔 pair 更新与 updateCell 回退均不遗留布尔物理值', async () => {
    const schema = 'const S = z.object({ A: z.object({ flag: z.boolean(), count: z.number() }) }); registerMvuSchema(S);';
    const stat = { A: { flag: [false, '开关'], count: 0 } };
    for (const useRow of [true, false]) {
        const { layout, template } = convertDefault(stat, schema);
        const host = strictHost(template);
        if (!useRow) delete host.api.updateRow;
        await core.writeStatDiffToDb(host.api, layout, stat, { A: { flag: [true, '开关'], count: 1 } });
        assert.strictEqual(core.lastStatWriteFailed, false);
        assert.ok(host.seen.some(c => c.where.startsWith(useRow ? 'updateRow.' : 'updateCell.')));
        assert.deepStrictEqual(host.seen.filter(c => !['string', 'number'].includes(c.type)), []);
        assert.strictEqual(core.statDataFromTables(layout, template).stat_data.A.flag, true);
    }
});

test('旧式 pair 写入：无变化的 pair 不随其它字段重复写入', async () => {
    const schema = 'const S = z.object({ A: z.object({ gold: z.number(), name: z.string() }), R: z.record(z.string(), z.object({ text: z.string(), flag: z.boolean() })) }); registerMvuSchema(S);';
    const { layout, template } = convertDefault({ A: { gold: 10, name: ['甲', '称呼'] }, R: { one: { text: ['记录', '说明'], flag: [false, '开关'] } } }, schema);
    // 模拟 SQLite 的实际导出：数字物理单元格返回字符串，包括布尔列的 "0"。
    for (const sheet of Object.values(template)) {
        if (sheet && Array.isArray(sheet.content)) sheet.content = sheet.content.map((row, i) => i === 0 ? row : row.map(value => typeof value === 'number' ? String(value) : value));
    }
    const host = strictHost(template), before = core.statDataFromTables(layout, template).stat_data;
    const next = JSON.parse(JSON.stringify(before)); next.A.gold = 11;
    await core.writeStatDiffToDb(host.api, layout, before, next);
    assert.strictEqual(core.lastStatWriteFailed, false);
    assert.strictEqual(host.seen.length, 1, '只修改金币，不重复写入未变化的单例/行表 pair');
    assert.ok(host.seen[0].where.endsWith('.gold'));
    assert.deepStrictEqual(core.statDataFromTables(layout, template).stat_data, next);
    host.seen.length = 0;
    await core.writeStatDiffToDb(host.api, layout, next, JSON.parse(JSON.stringify(next)));
    assert.deepStrictEqual(host.seen, [], '完整快照原样写回不产生 pair CRUD');
    const changed = JSON.parse(JSON.stringify(next)); changed.R.one.flag = true;
    await core.writeStatDiffToDb(host.api, layout, next, changed);
    assert.strictEqual(core.lastStatWriteFailed, false);
    assert.strictEqual(host.seen.length, 1);
    assert.strictEqual(host.seen[0].value, 1, '已标量化的布尔 pair 变化仍写物理数值');
    assert.strictEqual(core.statDataFromTables(layout, template).stat_data.R.one.flag, true);
});
