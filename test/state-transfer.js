'use strict';
const vm = require('node:vm');
const { test } = require('./runner');
const { assert, core } = require('./helpers');
const factory = require('../src/state-transfer');
const transfer = factory();
const clone = transfer.clone;
const stat = { 人物: { 名字: '甲', 分数: 2.75, 配对值: [3, '保留说明'], $缓存: '乙', 空: null }, 列表: [{ 名字: '相同', $缓存: '甲' }, { 名字: '相同', $缓存: '乙' }], $独立: { 游标: 4 } };
const sheet = (uid = 'sheet_log', name = '日志表') => ({ uid, name, sourceData: { ddl: 'CREATE TABLE logs (row_id INTEGER, title TEXT)', note: '目标说明' },
    content: [['序号', '标题'], [1, '事件']], updateConfig: { updateFrequency: 5 } });

test('状态存档：完整数据保留隐藏值、说明对、小数、缺失和空值，排除临时 internal', () => {
    const archived = transfer.archive({ mvu: { stat_data: { ...stat, $internal: { temporary: true } }, schema: { type: 'object' }, initialized_lorebooks: { 原书: ['完成'] } }, source: { character: '测试卡' } });
    assert.deepStrictEqual(transfer.parse(JSON.stringify(archived)).stat_data, stat);
    assert.deepStrictEqual(archived.mvu.initialized_lorebooks, { 原书: ['完成'] });
    assert.deepStrictEqual(stat.$独立, { 游标: 4 });
    assert(!Object.hasOwn(archived.stat_data, '$internal'));
    assert(!Object.hasOwn(archived.stat_data.人物, '未出现'));
});
test('状态存档：接受裸 stat_data 与 MVU 变量表，拒绝未知版本和损坏数据', () => {
    assert.deepStrictEqual(transfer.parse(JSON.stringify(stat)).stat_data, stat);
    assert.deepStrictEqual(transfer.parse('\uFEFF' + JSON.stringify({ stat_data: stat, schema: {} })).stat_data, stat);
    assert.throws(() => transfer.parse({ format: transfer.format, version: 2 }), /版本/);
    assert.throws(() => transfer.parse({ format: transfer.format, version: 1, stat_data: [], extraTables: [] }), /对象/);
    assert.throws(() => transfer.parse('{broken'), SyntaxError);
    assert.throws(() => transfer.parse('{"分数":1e999}'), /非有限/);
});
test('状态存档：额外表在普通 MVU 目标同样匹配，只复制数据不改模板', () => {
    const source = { sheet_log: sheet() }, destination = { sheet_log: sheet(), sheet_other: sheet('sheet_other', '另一表') };
    destination.sheet_log.content = [['标题', '序号'], ['旧事件', 7]];
    const saved = transfer.archive({ mvu: { stat_data: stat }, tables: source, layout: [] });
    const { matches, skipped } = transfer.matchExtras(saved.extraTables, destination, []);
    assert.strictEqual(matches.length, 1); assert.strictEqual(skipped.length, 0);
    const candidate = transfer.applyExtras(destination, matches);
    assert.deepStrictEqual(candidate.sheet_log.content, [['标题', '序号'], ['事件', 1]]);
    assert.deepStrictEqual(candidate.sheet_log.sourceData, destination.sheet_log.sourceData);
    assert.deepStrictEqual(candidate.sheet_log.updateConfig, destination.sheet_log.updateConfig);
    assert.deepStrictEqual(candidate.sheet_other, destination.sheet_other);
    assert.deepStrictEqual(destination.sheet_log.content[1], ['旧事件', 7]);
});
test('状态存档：映射表不当作额外表，同名不相容、歧义及重复身份不覆盖', () => {
    const archived = transfer.archive({ mvu: { stat_data: stat }, tables: { sheet_log: sheet() }, layout: [{ table: '日志表' }] });
    assert.deepStrictEqual(archived.extraTables, []);
    const extras = transfer.archive({ mvu: { stat_data: stat }, tables: { sheet_log: sheet() } }).extraTables;
    const changed = sheet(); changed.sourceData.ddl += ' STRICT';
    assert.strictEqual(transfer.matchExtras(extras, { sheet_log: changed }, []).skipped[0].reason, '目标列结构或 DDL 不相容');
    const renamed = { sheet_new: sheet('sheet_new') };
    assert.strictEqual(transfer.matchExtras(extras, renamed, []).matches.length, 1);
    renamed.sheet_new2 = sheet('sheet_new2');
    assert.strictEqual(transfer.matchExtras(extras, renamed, []).matches.length, 0);
    assert.strictEqual(transfer.matchExtras(extras, { sheet_log: sheet() }, [{ table: '日志表' }]).matches.length, 0);
    const duplicate = { format: transfer.format, version: 1, stat_data: stat, extraTables: [...extras, ...extras] };
    assert.throws(() => transfer.parse(duplicate), /重复/);
});
test('状态存档：聊天备份核对全消息、分支及元数据，不接受旧保存文件', () => {
    const chat = [{ mes: '正文', swipe_id: 1, swipes: ['甲', '乙'], variables: [{ stat_data: { 数: 1 } }, { stat_data: stat }], TavernDB_ACU_IsolatedData: { log: { storageFrame: { version: 2, logEntries: [] } } } }];
    const metadata = { variables: { 辅助: true } };
    const file = [JSON.stringify({ chat_metadata: metadata }), ...chat.map(JSON.stringify)].join('\n') + '\n';
    assert.strictEqual(transfer.verifyBackup(file, chat, metadata), true);
    assert.throws(() => transfer.verifyBackup(file, [{ ...chat[0], swipe_id: 0 }], metadata), /不一致/);
    assert.throws(() => transfer.verifyBackup(file, chat, {}), /不一致/);
    assert.throws(() => transfer.verifyBackup('broken', chat, metadata), /JSONL/);
});
test('状态存档：分别接受 SP 与龙血玄黄的持久导入版本，未知和过旧版本不写表格', () => {
    for (const v of ['8.5', '8.5.0', '9.2.5', '9.2.5.1', 'naiv1.0.0', 'naiv1.2.5', 'naiv1.2.6', 'naiv2.0.0']) transfer.assertPersistentDbVersion(v);
    for (const v of ['unknown', '', '7.9.9', '8.4.99', 'naiv0.9.0', '9.2.5beta', '9.2.5.1.1']) assert.throws(() => transfer.assertPersistentDbVersion(v), /SP·数据库 8.5/);
});
test('状态存档：运行时附加种子不改变数据身份，真实行和模板字段变化仍不相同', () => {
    const before = { sheet_log: sheet() }, hydrated = clone(before);
    hydrated.sheet_log.seedRows = [['1', '原模板种子']];
    assert(transfer.equalRuntimeTables(before, hydrated));
    assert(!transfer.equal(before, hydrated), '完整模板比较仍保护种子定义');
    hydrated.sheet_log.content[1][1] = '真实新值';
    assert(!transfer.equalRuntimeTables(before, hydrated));
    hydrated.sheet_log.content = clone(before.sheet_log.content); hydrated.sheet_log.sourceData.ddl += ' STRICT';
    assert(!transfer.equalRuntimeTables(before, hydrated));
});
function hostFixture(fail = '') {
    const calls = []; let variables = 'old', tables = 'old', current = true;
    const host = {
        assertUnchanged() { calls.push('guard'); if (!current) throw new Error('changed'); },
        assertCurrent() { if (!current) throw new Error('changed'); },
        async backup() { calls.push('backup'); if (fail === 'backup') throw new Error('no backup'); if (fail === 'changed') current = false; },
        rollbackStage: async () => { calls.push('rollback'); variables = 'old'; },
        async stage() { calls.push('stage'); variables = 'new'; if (fail === 'stage') throw new Error('stage failed'); return host.rollbackStage; },
        async importTables() { calls.push('import'); tables = 'new'; return fail !== 'import'; },
        async restoreTables() { calls.push('restore'); tables = 'old'; },
        async save() { calls.push('save'); },
        async verify() { calls.push('verify'); if (fail === 'verify') throw new Error('verify failed'); },
    };
    return { host, calls, read: () => ({ variables, tables }) };
}
test('状态存档：备份必须先完成，过期预览或备份失败不调用任何写入', async () => {
    for (const fail of ['backup', 'changed']) {
        const f = hostFixture(fail);
        await assert.rejects(transfer.execute({ writeTables: true }, f.host));
        assert(!f.calls.includes('stage')); assert(!f.calls.includes('import'));
        assert.deepStrictEqual(f.read(), { variables: 'old', tables: 'old' });
    }
});
test('状态存档：一次候选提交，读回失败及提交后报错也尝试受守卫回退', async () => {
    const f = hostFixture(); await transfer.execute({ writeTables: true }, f.host);
    assert(f.calls.indexOf('backup') < f.calls.indexOf('stage'));
    assert.deepStrictEqual(f.calls.filter(v => ['import', 'save', 'verify'].includes(v)), ['import', 'save', 'verify']);
    for (const fail of ['stage', 'import', 'verify']) {
        const failed = hostFixture(fail);
        await assert.rejects(transfer.execute({ writeTables: true }, failed.host), /完整聊天备份/);
        assert.deepStrictEqual(failed.read(), { variables: 'old', tables: 'old' });
    }
});
test('状态存档：工厂在无 Node 外部作用域 VM 中执行，危险属性仍是普通数据', () => {
    const inlined = vm.runInNewContext('(' + factory.toString() + ')()');
    const input = '{"__proto__":{"polluted":true},"constructor":"业务键","$缓存":5}';
    const output = inlined.parse(input);
    assert(Object.hasOwn(output.stat_data, '__proto__'));
    assert.strictEqual({}.polluted, undefined);
    assert.strictEqual(JSON.stringify(output.stat_data), input);
});
test('状态存档：复用 MVU Schema 调和，继承目标开放性、模板、必需与严格规则，不改变状态', () => {
    const factory = require('../src/vendor/mvu-schema');
    const { lodash } = require('../src/vendor/schema-engine-libs');
    const schema = vm.runInNewContext('(' + factory.toString() + ')')(lodash);
    const wrap = { stat_data: { 动态: { 新人物: { 分数: 2.75 } }, $meta: { strictSet: true } }, schema: {
        type: 'object', extensible: false, strictTemplate: true, concatTemplateArray: false,
        properties: { 动态: { type: 'object', extensible: true, recursiveExtensible: true, template: { 分数: 0 }, properties: {} } },
    } };
    const before = clone(wrap.stat_data);
    schema.reconcileAndApplySchema(wrap);
    assert.deepStrictEqual(wrap.stat_data, before);
    assert.strictEqual(wrap.schema.strictSet, true);
    assert.strictEqual(wrap.schema.strictTemplate, true);
    assert.strictEqual(wrap.schema.properties.动态.extensible, true);
    assert.strictEqual(wrap.schema.properties.动态.properties.新人物.required, false);
    assert.strictEqual(wrap.schema.properties.动态.properties.新人物.recursiveExtensible, true);
    assert.deepStrictEqual(clone(wrap.schema.properties.动态.template), { 分数: 0 });
});
test('状态存档：目标完整 JSON 候选使用真实 writer / codec，跨布局保留配对值和混合隐藏数据', async () => {
    const source = require('./synthetic-card')();
    source.data.character_book.entries[0].content = JSON.stringify(stat);
    const r = core.convert(source, { jsonContainers: true });
    const layout = JSON.parse(r.card.data.extensions.mvu2shujuku.layout);
    const next = clone(stat); next.人物.分数 = 4.25; next.列表.reverse();
    const before = core.statDataFromTables(layout, r.template).stat_data;
    const writer = require('../src/extension-runtime').createCandidateBuilder({ core });
    const storage = require('../src/stat-storage')({ readLayout: () => layout, readPolicy: () => r.card.data.extensions.mvu2shujuku.statStorage });
    const candidate = await writer.buildUpdatedTemplateFromStat(layout, storage.split(before).database, storage.split(next).database, r.template);
    const actual = storage.combine(core.statDataFromTables(layout, candidate).stat_data, storage.split(next).native);
    assert.deepStrictEqual(actual, next);
});

test('状态存档：旧布局无 Schema 时以实际无损投影识别动态记录，不能以现有值充当声明', async () => {
    const source = require('./synthetic-card')();
    const initial = { 世界: { 时间: '清晨' }, 人物: {} };
    source.data.character_book.entries[0].content = JSON.stringify(initial);
    source.data.first_mes = ''; source.data.alternate_greetings = [];
    source.data.extensions.tavern_helper.scripts = [{ name: '结构', content: "registerMvuSchema(z.object({世界:z.object({时间:z.string()}),人物:z.record(z.string(),z.object({姓名:z.string(),评分:z.number()}))}));" }];
    const result = require('./legacy-layout-fixture')(source);
    // 老发行卡没有后来的全局动态兜底；只保留其固定映射和行表。
    const layout = JSON.parse(result.card.data.extensions.mvu2shujuku.layout).filter(e => !e.publicFallback);
    const before = core.statDataFromTables(layout, result.template).stat_data;
    const writer = require('../src/extension-runtime').createCandidateBuilder({ core });
    const project = async value => {
        const tables = await writer.buildUpdatedTemplateFromStat(layout, before, value, result.template);
        if (!tables || !transfer.equal(core.statDataFromTables(layout, tables).stat_data, value)) throw new Error('无法无损投影');
        return tables;
    };
    const incoming = { 世界: { 时间: '夜晚' }, 人物: { 新人物: { 姓名: '甲', 评分: 2.75 } } };
    for (const t of [transfer, vm.runInNewContext('(' + factory.toString() + ')()')]) {
        const complete = await t.prepareImport(incoming, before, { layoutOnly: true, project });
        assert.strictEqual(complete.fields, null);
        assert.deepStrictEqual(clone(complete.stat_data), incoming);
        const partial = await t.prepareImport({ ...incoming, 未映射: { 值: 1 } }, before, { layoutOnly: true, project });
        assert.deepStrictEqual(clone(partial.stat_data), incoming);
        assert(partial.fields.imported.includes('/人物/新人物'));
        assert(partial.fields.skipped.some(s => s.path === '/未映射'));
        assert.deepStrictEqual(core.statDataFromTables(layout, partial.tables).stat_data, incoming);
    }
    assert.deepStrictEqual(before, initial);
});

test('状态存档：完整候选失败后的根对象校验不构造 undefined 字段', async () => {
    const incoming = { 人物: { 分数: 3.5 } };
    let attempts = 0;
    const result = await transfer.prepareImport(incoming, { 人物: { 分数: 1 } }, {
        schema: { type: 'object', record: true },
        project: async value => { if (++attempts === 1) throw new Error('完整候选失败'); assert.deepStrictEqual(value, incoming); return { saved: value }; },
    });
    assert.deepStrictEqual(result.stat_data, incoming);
    assert.deepStrictEqual(result.tables.saved, incoming);
});


test('状态存档：部分匹配保留新增字段，跳过改名与改类型，数组整体处理', async () => {
    const target = { 主角: { 生命: 100, 魔力: 30, 金钱: 20, 备注: '新说明' }, 队伍: [{ 姓名: '乙', 数量: 1 }] };
    const source = { 主角: { 生命: 80, 金币: 12, 备注: 7 }, 队伍: [{ 姓名: '甲', 数量: 2 }, { 姓名: '丙', 数量: 3 }] };
    const result = await transfer.compatibleFields(source, target);
    assert(result.partial);
    assert.deepStrictEqual(result.stat_data, { 主角: { 生命: 80, 魔力: 30, 金钱: 20, 备注: '新说明' }, 队伍: source.队伍 });
    assert(result.retained.includes('/主角/魔力'));
    assert(result.skipped.some(s => s.path === '/主角/金币'));
    assert(result.skipped.some(s => s.path === '/主角/备注'));
    assert(result.imported.includes('/队伍'));
    assert(!result.imported.some(s => s.startsWith('/队伍/')));
    assert.strictEqual(target.主角.生命, 100);
});
test('状态存档：已声明动态记录完整替换，隐藏值随容器保留，危险键不穿透原型', async () => {
    for (const t of [transfer, vm.runInNewContext('(' + factory.toString() + ')()')]) {
        const schema = { type: 'object', properties: { 名单: { type: 'object', record: true }, '__proto__': { type: 'object' } } };
        Object.defineProperty(schema.properties, '__proto__', { value: { type: 'object', properties: { 业务: { type: 'number' } } }, enumerable: true });
        const result = await t.compatibleFields(JSON.parse('{"名单":{"甲":{"$缓存":"乙"}},"__proto__":{"业务":7}}'), { 名单: { 旧人: {} } }, { schema });
        assert.strictEqual(JSON.stringify(result.stat_data.名单), '{"甲":{"$缓存":"乙"}}');
        assert(Object.hasOwn(result.stat_data, '__proto__'));
        assert.strictEqual(result.stat_data.__proto__.业务, 7);
        assert.strictEqual({}.业务, undefined);
    }
});
test('状态存档：取消下载备份仍检查并发、提交及读回，失败提示不声称有备份', async () => {
    const f = hostFixture(); await transfer.execute({ backup: false, writeTables: true }, f.host);
    assert(!f.calls.includes('backup')); assert(f.calls.includes('verify'));
    const failed = hostFixture('verify');
    await assert.rejects(transfer.execute({ backup: false, writeTables: true }, failed.host), e => /未选择下载聊天备份/.test(e.message) && !/已下载/.test(e.message));
    assert.deepStrictEqual(failed.read(), { variables: 'old', tables: 'old' });
});
test('状态存档：复用真实 Zod 按值筛选范围整数枚举，不运行变换或动态默认', async () => {
    const { zod: z } = require('../src/vendor/schema-engine-libs');
    const createCardApi = require('../src/card-api'); let effects = 0;
    const schema = z.object({ 人物: z.object({ 分数: z.number().min(0).max(5), 整数: z.number().int(), 状态: z.enum(['甲', '乙']),
        新字段: z.number().default(() => { effects++; return 9; }), 变换: z.string().transform(v => { effects++; return v; }) }) });
    for (const f of [createCardApi, vm.runInNewContext('(' + createCardApi.toString() + ')')]) {
        const api = f({ readMetadata: () => ({ schemaKeys: ['test'] }), isCurrent: () => true }); api.registerSchema(schema, 'test');
        const rules = await api.stateImportRules();
        assert.strictEqual(await rules.accept(['人物', '分数'], 2.75), '');
        assert((await rules.accept(['人物', '分数'], 7)).includes('Schema'));
        assert(await rules.accept(['人物', '整数'], 2.75));
        assert(await rules.accept(['人物', '状态'], '丙'));
        assert(await rules.accept(['人物', '变换'], '甲'));
        assert.strictEqual(await rules.accept(['人物', '新字段'], 3), '');
        const result = await transfer.compatibleFields({ 人物: { 分数: 2.75, 整数: 2.75, 状态: '丙', 变换: '新值' } },
            { 人物: { 分数: 1, 整数: 2, 状态: '甲', 变换: '旧值', 新字段: 9 } }, rules);
        assert.deepStrictEqual(result.stat_data, { 人物: { 分数: 2.75, 整数: 2, 状态: '甲', 变换: '旧值', 新字段: 9 } });
        assert.strictEqual(await rules.validateComplete({ 人物: { 分数: 1, 整数: 2, 状态: '甲', 变换: '甲' } }), 'opaque');
        assert.strictEqual(effects, 0);
    }
});
test('状态存档：跨字段自定义校验不拆开执行，Schema provider 和包装校验不调用', async () => {
    const { zod: z } = require('../src/vendor/schema-engine-libs'); const createCardApi = require('../src/card-api');
    let effects = 0;
    for (const schema of [z.object({ 甲: z.number(), 乙: z.number() }).refine(() => { effects++; return true; }),
        z.object({ 甲: z.number() }).default({ 甲: 1 }).refine(() => { effects++; return true; }),
        () => { effects++; return z.object({ 甲: z.number() }); }]) {
        const api = createCardApi({ readMetadata: () => ({ schemaKeys: ['test'] }), isCurrent: () => true }); api.registerSchema(schema, 'test');
        const rules = await api.stateImportRules();
        assert(await rules.accept(['甲'], 2)); assert.strictEqual(effects, 0);
    }
});


test('状态存档：MVU 混合数组不按首元素类型筛掉，已声明 any 允许原类型变化', async () => {
    const result = await transfer.compatibleFields({ 背包: ['钥匙', 0, false, null], 联合: '文本' }, { 背包: [], 联合: 1 }, {
        schema: { type: 'object', properties: { 背包: { type: 'array', elementType: { type: 'string' } }, 联合: { type: 'any' } } },
    });
    assert.strictEqual(result.partial, false);
    assert.deepStrictEqual(result.stat_data, { 背包: ['钥匙', 0, false, null], 联合: '文本' });
});
test('状态存档：MVU 根 any 完整替换动态结构，不把已有字段当作声明', async () => {
    const source = { 人物: { 新人物: { 数量: 3, $缓存: '新值' } }, 新根: [false, null] };
    const target = { 人物: { 旧人物: { 数量: 1 } }, 旧根: '删除' };
    const schema = core.getMvuSchemaFactory()(require('../src/vendor/schema-engine-libs').lodash)
        .generateSchema(clone(target), '没有用别管这个');
    assert.deepStrictEqual(schema, { type: 'any' });
    const result = await transfer.compatibleFields(source, target, { schema });
    assert.strictEqual(result.partial, false);
    assert.deepStrictEqual(result.stat_data, source);
    assert.deepStrictEqual(result.imported, ['/']);
});
test('状态存档：MVU Zod 标记复用上游 any 解释，原标记不被调和改写', async () => {
    const upstream = core.getMvuSchemaFactory()(require('../src/vendor/schema-engine-libs').lodash);
    const context = vm.createContext({});
    const browser = vm.runInContext('(' + factory.toString() + ')()', context);
    for (const service of [transfer, browser]) {
        const rawSchema = '没有用别管这个';
        const schema = service.resolveImportSchema(rawSchema, upstream.generateSchema);
        assert.deepStrictEqual(clone(schema), { type: 'any' });
        assert.strictEqual(service.resolveImportSchema(undefined, upstream.generateSchema), null);
        assert.strictEqual(service.resolveImportSchema('未知标记', upstream.generateSchema), null);
        const legacy = { type: 'object', properties: { 数量: { type: 'number' } } };
        assert.strictEqual(service.resolveImportSchema(legacy, upstream.generateSchema), legacy);
        const target = { 人物: { 旧人物: { 数量: 1 } } };
        const source = { 人物: { 新人物: { 数量: 3 } }, $隐藏: ['新台词'] };
        const tables = { sheet_log: sheet() };
        const result = await service.prepareImport(source, target, { schema,
            accept: () => schema ? '' : '没有规则', project: () => tables });
        assert.deepStrictEqual(clone(result.stat_data), source);
        assert.strictEqual(result.fields, null);
        assert.deepStrictEqual(clone(result.tables), tables);
        const variables = { schema: rawSchema, stat_data: clone(result.stat_data) };
        upstream.reconcileAndApplySchema(variables);
        assert.strictEqual(variables.schema, rawSchema);
        assert.deepStrictEqual(variables.stat_data, source);
    }
});
test('状态存档：明确 optional 的缺失恢复缺失，不把旧目标可选值混入完整快照', async () => {
    const { zod: z } = require('../src/vendor/schema-engine-libs'); const api = require('../src/card-api')({ readMetadata: () => ({ schemaKeys: ['test'] }), isCurrent: () => true });
    api.registerSchema(z.object({ 数量: z.number(), 备注: z.string().optional(), 新字段: z.number().default(9) }), 'test');
    const rules = await api.stateImportRules();
    const result = await transfer.compatibleFields({ 数量: 3, 新字段: 9 }, { 数量: 1, 备注: '旧备注', 新字段: 9 }, rules);
    assert.strictEqual(result.partial, false); assert(!Object.hasOwn(result.stat_data, '备注'));
    assert.strictEqual(await rules.validateComplete({ 数量: 3, 新字段: 9 }), 'valid');
});
test('状态存档：optional 内层默认函数不被完整预检调用，登记变化使旧规则失效', async () => {
    const { zod: z } = require('../src/vendor/schema-engine-libs'); let effects = 0;
    const api = require('../src/card-api')({ readMetadata: () => ({ schemaKeys: ['test'] }), isCurrent: () => true });
    api.registerSchema(z.object({ 数量: z.number(), 可选默认: z.number().default(() => { effects++; return 7; }).optional() }), 'test');
    const rules = await api.stateImportRules();
    assert.strictEqual(await rules.validateComplete({ 数量: 1 }), 'opaque'); assert.strictEqual(effects, 0);
    api.registerSchema(z.object({ 数量: z.string() }), 'test');
    assert.throws(() => rules.assertCurrent(), /Schema 已更新/);
    await assert.rejects(rules.accept(['数量'], 1), /Schema 已更新/);
});
