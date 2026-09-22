'use strict';
const { test } = require('./runner');
const { core, assert, applyingApi } = require('./helpers');

function convert(declaration, extra = {}, mutate = () => {}) {
    const stat = { 状态: { 金币: 1, 附属: {
        左: { 数值: 1, 标记: '甲', 开启: true, $隐藏: '左私有', _维护: '脚本左' },
        右: { 数值: 22, 标记: '丙', 开启: false, $隐藏: '右私有', _维护: '脚本右' },
    }, ...extra } };
    mutate(stat);
    const card = { name: '固定附属对象', first_mes: '',
        character_book: { entries: [{ comment: '[InitVar]', content: JSON.stringify(stat) }] },
        extensions: { tavern_helper: { scripts: declaration ? [{ name: '结构', content: `const S = z.object({状态:z.object({金币:z.number(),附属:${declaration}})});registerMvuSchema(S);` }] : [] } },
    };
    const result = core.convert(card);
    return { ...result, stat, layout: JSON.parse((result.card.data || result.card).extensions.mvu2shujuku.layout) };
}
const fixed = `z.object({
    左:z.object({_维护:z.string().describe('只由脚本维护'),数值:z.number().transform(v=>_.clamp(v,0,10)),标记:z.enum(['甲','乙']),开启:z.boolean(),$隐藏:z.string()}),
    右:z.object({_维护:z.string().describe('只由脚本维护'),数值:z.number().transform(v=>_.clamp(v,20,30)),标记:z.enum(['丙','丁']),开启:z.boolean(),$隐藏:z.string()})
})`;

test('附属子表合并：明确固定对象回到父表，独立范围枚举、隐藏列与嵌套读写保留', async () => {
    const r = convert(fixed);
    assert.strictEqual(r.schema.length, 1, '不再为固定左右两侧单独建立行表');
    const group = r.schema[0], sheet = Object.values(r.template).find(s => s.name === group.tableName);
    for (const [side, range, options] of [['左', [0, 10], ['甲', '乙']], ['右', [20, 30], ['丙', '丁']]]) {
        const number = group.columns.find(c => c.zh === `附属_${side}_数值`);
        const label = group.columns.find(c => c.zh === `附属_${side}_标记`);
        const secret = group.columns.find(c => c.zh === `附属_${side}_$隐藏`);
        assert.deepStrictEqual(number.range, range);
        assert.deepStrictEqual(label.enum, options);
        assert.ok(sheet.sourceData.ddl.includes(`CHECK(${number.ident} BETWEEN ${range[0]} AND ${range[1]})`));
        assert.ok(sheet.sourceData.hiddenPhysicalColumns.includes(secret.ident));
    }
    assert.match(sheet.sourceData.note, /只读字段「附属_左_维护」说明：只由脚本维护/);
    assert.match(sheet.sourceData.note, /只读字段「附属_右_维护」说明：只由脚本维护/);
    assert.match(sheet.sourceData.note, /只读状态/);
    const readonly = group.columns.find(c => c.path.join('.') === '状态.附属.左._维护');
    assert.ok(readonly && sheet.content[0].includes(readonly.zh), '脚本只读状态保留原逻辑路径和物理列');
    assert.ok(sheet.sourceData.note.includes(`只读列：「${readonly.zh}」`), '展平后的实际表头必须明确标为只读，不能只靠原路径的下划线');
    assert.doesNotMatch(sheet.sourceData.note, /\$隐藏/, '只读范围不暴露私有列名');
    assert.ok(!sheet.sourceData.hiddenPhysicalColumns.includes(readonly.ident), '脚本只读状态仍作为业务列展示');
    assert.deepStrictEqual(core.statDataFromTables(r.layout, r.template).stat_data, r.stat);
    const next = structuredClone(r.stat);
    next.状态.附属.左.数值 = 9; next.状态.附属.右.标记 = '丁';
    next.状态.附属.左.开启 = false; next.状态.附属.右.$隐藏 = '更新私有';
    next.状态.附属.左._维护 = '脚本更新';
    await core.writeStatDiffToDb(applyingApi(r.template), r.layout, r.stat, next);
    assert.strictEqual(core.lastStatWriteFailed, false);
    assert.deepStrictEqual(core.statDataFromTables(r.layout, r.template).stat_data, next);
});

test('附属子表合并：明确动态字典及仅凭样本猜测的条目字典保留子表', () => {
    for (const declaration of ['', 'z.record(z.string(),z.object({数值:z.number(),标记:z.string(),开启:z.boolean(),$隐藏:z.string()}))']) {
        const r = convert(declaration);
        assert.ok(r.schema.some(g => g.tableName === '状态_附属表' && g.kind === 'rows'));
        assert.deepStrictEqual(core.statDataFromTables(r.layout, r.template).stat_data, r.stat);
    }
});

test('附属子表合并：固定对象内的数组后代仍单独存储，不丢顺序与重复值', async () => {
    const declaration = fixed.replace('左:z.object({', '左:z.object({日志:z.array(z.string()),');
    const r = convert(declaration, {}, stat => { stat.状态.附属.左.日志 = ['甲', '甲', '乙']; });
    assert.ok(r.schema.some(g => g.kind === 'pathArray' || g.kind === 'array'));
    assert.deepStrictEqual(core.statDataFromTables(r.layout, r.template).stat_data, r.stat);
    const next = structuredClone(r.stat);
    next.状态.附属.左.日志 = ['甲', '乙', '丙'];
    next.状态.附属.右.数值 = 25;
    await core.writeStatDiffToDb(applyingApi(r.template), r.layout, r.stat, next);
    assert.strictEqual(core.lastStatWriteFailed, false);
    assert.deepStrictEqual(core.statDataFromTables(r.layout, r.template).stat_data, next);
});
