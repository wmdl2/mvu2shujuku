'use strict';
const { test } = require('./runner');
const { core, assert, applyingApi } = require('./helpers');
const clone = x => JSON.parse(JSON.stringify(x));
function card(init, source, enabled = true) {
    source = 'import { registerMvuSchema } from "https://example.test/fixture-schema.js";\n' + source;
    return { name: '社区卡契约公开样本', character_book: { entries: [
        { comment: '[InitVar]', content: init === undefined ? '' : JSON.stringify(init), enabled: false },
    ] }, extensions: { tavern_helper: { scripts: [{ name: '结构', enabled, content: source }] } } };
}
function read(result, tables = result.template) {
    return core.statDataFromTables(JSON.parse(result.card.extensions.mvu2shujuku.layout), tables).stat_data;
}
async function writeRoundTrip(input, before, after) {
    const result = core.convert(input), tables = clone(result.template);
    assert.deepStrictEqual(read(result, tables), before);
    const layout = JSON.parse(result.card.extensions.mvu2shujuku.layout);
    assert.strictEqual((await core.writeStatDiffToDbResult(applyingApi(tables), layout, before, after, tables)).ok, true);
    assert.deepStrictEqual(read(result, tables), after);
    assert.strictEqual((await core.writeStatDiffToDbResult(applyingApi(tables), layout, after, before, tables)).ok, true);
    assert.deepStrictEqual(read(result, tables), before);
}
test('社区卡契约：多行成员调用与注释保留字面量、类型、默认和范围', () => {
    const source = `const Schema = z /* source comment */
        .object({组: z
            .object({数值: z . coerce . number().min(0).max(9).prefault(3),
                文本: z.string().prefault('z \\n .number() // literal')})
            .prefault({})}); registerMvuSchema(Schema);`;
    const parsed = core.parseRegisteredZodSchema(source);
    assert.strictEqual(parsed.root.fields.组.fields.数值.kind, 'number');
    assert.strictEqual(parsed.root.fields.组.fields.数值.max, 9);
    assert.strictEqual(parsed.root.fields.组.fields.文本.defaultValue, 'z \n .number() // literal');
    const r = core.convert(card(undefined, source));
    assert.deepStrictEqual(read(r), {组:{数值:3, 文本:'z \n .number() // literal'}});
});
test('社区卡契约：Schema 默认独立初始化，禁用、动态、不完整默认拒绝', () => {
    const valid = 'const S=z.object({组:z.object({值:z.number().prefault(7),开关:z.boolean().default(false)}).prefault({}),记录:z.record(z.string(),z.string()).prefault({})});registerMvuSchema(S);';
    assert.deepStrictEqual(read(core.convert(card(undefined, valid))), {组:{值:7,开关:false},记录:{}});
    for (const [source, enabled] of [
        [valid, false],
        ['const S=z.object({组:z.object({值:z.number()}).prefault({})});registerMvuSchema(S);', true],
        ['const S=z.object({值:z.number().default(()=>Math.random()),已知:z.number().default(1)});registerMvuSchema(S);', true],
        ['const S=z.object({值:externalSchema,已知:z.number().default(1)});registerMvuSchema(S);', true],
    ]) assert.throws(() => core.convert(card(undefined, source, enabled)), /未找到可用/);
});
test('社区卡契约：同名文本与数值按完整路径写读，关系表数字字符串保持数值', async () => {
    const source = 'const S=z.object({建筑:z.object({房间:z.record(z.string(),z.object({位置:z.string().prefault("1-2")}))}),游戏:z.object({位置:z.coerce.number().prefault(0)})});registerMvuSchema(S);';
    await writeRoundTrip(card({建筑:{房间:{甲:{位置:'1-3'},乙:{位置:'outdoor-left'}}},游戏:{位置:0}}, source),
        {建筑:{房间:{甲:{位置:'1-3'},乙:{位置:'outdoor-left'}}},游戏:{位置:0}},
        {建筑:{房间:{甲:{位置:'9-10'},乙:{位置:'outdoor-right'}}},游戏:{位置:3}});
});
test('社区卡契约：or 联合在标量、对象与数组间完整写读和恢复', async () => {
    const source = 'const S=z.object({列表:z.record(z.string(),z.object({值:z.number()}).or(z.literal("等待"))),项:z.array(z.string()).or(z.literal("空"))});registerMvuSchema(S);';
    await writeRoundTrip(card({列表:{甲:'等待',乙:{值:1}},项:'空'}, source),
        {列表:{甲:'等待',乙:{值:1}},项:'空'}, {列表:{甲:{值:2},乙:'等待'},项:['一','二']});
});
test('社区卡契约：Schema 删除未声明原字段后不复活初始值', async () => {
    const source = 'const S=z.object({组:z.object({值:z.number(),详情:z.object({值:z.number()})}),其他:z.object({旧值:z.object({值:z.number()})})});registerMvuSchema(S);';
    const before = {组:{值:1,旧值:5,空容器:{},详情:{值:2,旧值:'嵌套'}},其他:{旧值:{值:3}}}, after = {组:{值:1,详情:{值:2}},其他:{旧值:{值:3}}};
    await writeRoundTrip(card(before, source), before, after);
});
test('社区卡契约：passthrough 保留未声明原字段', async () => {
    const source = 'const S=z.object({组:z.object({值:z.number()}).passthrough()});registerMvuSchema(S);';
    const before = {组:{值:1,额外:'初始'}}, after = {组:{值:2,额外:'更新'}};
    await writeRoundTrip(card(before, source), before, after);
});

test('社区卡契约：行表字段联合字符串与未声明只读字段初始化和删除', async () => {
    for (const nested of [false, true]) {
        const type = 'z.record(z.string(),z.object({值:z.string().or(z.boolean())}))';
        const source = 'const S=z.object({' + (nested ? '组:z.object({列表:' + type + '})' : '列表:' + type) + '});registerMvuSchema(S);';
        const wrap = value => nested ? {组:{列表:value}} : {列表:value};
        const before = wrap({甲:{值:'原文',_旧值:'隐藏'},乙:{值:false,_旧值:5}}), after = wrap({甲:{值:true},乙:{值:'新文'}});
        await writeRoundTrip(card(before, source), before, after);
    }
});

test('社区卡契约：无声明混合字典保留数字布尔数组对象与分支初值', async () => {
    for (const nested of [false, true]) {
        const values = {数字:33,开关:false,文本:'原文',数组:[],对象:{值:1}};
        const wrap = value => nested ? {组:{记录:value}} : {记录:value};
        const source = {name:'混合记录公开样本', extensions:{tavern_helper:{scripts:[]}},
            character_book:{entries:[{comment:'[InitVar]',content:JSON.stringify(wrap({$meta:{extensible:true},...values}))}]}};
        await writeRoundTrip(source, wrap(values), wrap({数字:44,开关:true,文本:'更新',数组:[1,2],对象:{值:2}}));
    }
});
