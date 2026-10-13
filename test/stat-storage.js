'use strict';
const vm = require('vm');
const { test } = require('./runner');
const { core, assert, applyingApi } = require('./helpers');
const factory = require('../src/stat-storage');
const plain = value => JSON.parse(JSON.stringify(value));
function withSqliteSheet(result, entry, change) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    const tables = plain(result.template), group = result.schema.find(g => g.tableName === entry.table);
    const sheet = Object.values(tables).find(s => s?.name === entry.table);
    const quote = value => '"' + value.replace(/"/g, '""') + '"';
    try {
        db.exec(sheet.sourceData.ddl);
        const cols = ['row_id', ...group.columns.map(c => c.ident)];
        const insert = db.prepare('INSERT INTO ' + quote(group.ident) + '(' + cols.map(quote).join(',') + ') VALUES(' + cols.map(() => '?').join(',') + ')');
        for (const row of sheet.content.slice(1)) insert.run(...row);
        change(db, group, sheet);
        sheet.content = [sheet.content[0], ...db.prepare('SELECT ' + cols.map(quote).join(',') + ' FROM ' + quote(group.ident) + ' ORDER BY row_id').all().map(row => cols.map(c => row[c]))];
        return tables;
    } finally { db.close(); }
}
function convert(stat, extras = {}) {
    const result = core.convert({ name: '状态归属公开样本', first_mes: '开场',
        character_book: { entries: [{ comment: '[InitVar]', content: JSON.stringify(stat) }, ...(extras.entries || [])] },
        extensions: extras.extensions || {}, }, { mode: 'both', ...(extras.options || {}) });
    const data = result.card.data || result.card, policy = data.extensions.mvu2shujuku.statStorage;
    return { ...result, policy, entries: JSON.parse(data.extensions.mvu2shujuku.layout) };
}
function storage(result, chat, extra = {}) {
    return factory({ readPolicy: () => result.policy, readLayout: () => result.entries,
        readChat: () => chat, assertCurrent() {}, ...extra });
}
const layout = [{ kind: 'singleton', group: '状态', cols: [['金币', 'number', 0, ['状态', '金币']]] }];
test('旧卡原布局：未启用原消息分流时不把已映射的美元字段移出数据库', () => {
    const store = factory({ enabled: () => false });
    const full = { 状态: { 金币: 10, $缓存: '甲' }, $台词: ['保留'] };
    assert.deepStrictEqual(store.split(full), { database: full, native: {} });
    assert.deepStrictEqual(store.split(full, true).database, { 状态: { 金币: 10 } });
    assert.deepStrictEqual(full.$台词, ['保留']);
    assert(Number.isNaN(store.split({ 数值: NaN }).database.数值), '交给原写入校验，不能把非法数值序列化为 null');
});
test('原字段规则：独立VM命令工厂不按下划线前缀跳过set、move和删除', () => {
    const commands = require('../src/mvu-commands');
    const isolated = vm.runInNewContext('(' + commands.toString() + ')')();
    const stat = { 状态: { _计数: 1, _旧值: 2 } };
    isolated.applyMvuCommands(stat, [{ type: 'set', path: '状态._计数', value: 3 },
        { type: 'move', from: '状态._旧值', path: '状态._新值' }]);
    assert.deepStrictEqual(stat, { 状态: { _计数: 3, _新值: 2 } });
    isolated.applyMvuCommands(stat, [{ type: 'delete', path: '状态._新值' }]);
    assert.deepStrictEqual(stat, { 状态: { _计数: 3 } });
});
for (const [name, create] of [['module', factory], ['isolated', vm.runInNewContext('(' + factory.toString() + ')')]]) {
    test('原消息状态 ' + name + '：混合字段分流、辅助变量保留、历史与swipe隔离', () => {
        const chat = [{ is_user: false, swipe_id: 0, variables: [{ 辅助: '保留' }] }];
        const store = create({ readLayout: () => layout, readPolicy: () => ({ version: 1 }), readChat: () => chat, assertCurrent() {} });
        const stat = { 状态: { 金币: 10, $设置: { 开关: true }, 未建列: '用户值' }, $图鉴: { 解锁: ['一'] } };
        assert.deepStrictEqual(plain(store.split(stat).database), { 状态: { 金币: 10, 未建列: '用户值' } });
        const change = store.stage(stat, { writeTarget: { index: 0 } });
        assert(change.changed); assert.equal(chat[0].variables[0].辅助, '保留');
        assert(!Object.prototype.hasOwnProperty.call(chat[0].variables[0].stat_data.状态, '金币'));
        assert.deepStrictEqual(plain(store.merge({ stat_data: { 状态: { 金币: 20, 未建列: '用户值' } } }).stat_data), { ...stat, 状态: { ...stat.状态, 金币: 20 } });
        chat.push({ is_user: true }, { is_user: false });
        assert.equal(store.read().$图鉴.解锁[0], '一');
        store.stage({ 状态: { 金币: 20 } }, { writeTarget: { index: 2 } });
        assert.deepStrictEqual(plain(store.read()), {}); // explicit deletion does not inherit stale values
        assert.equal(store.read(0).$图鉴.解锁[0], '一');
        chat[0].swipe_id = 1; assert.deepStrictEqual(plain(store.read(0)), {});
        chat[0].swipe_id = 0; assert.equal(store.read(0).$图鉴.解锁[0], '一');
        assert.deepStrictEqual(plain(store.read(0)), plain(create({ readLayout: () => layout, readChat: () => plain(chat) }).read(0)));
    });
    test('原消息状态 ' + name + '：失败回滚和过期来源不得写入', () => {
        const chat = [{ is_user: false, variables: [{ 辅助: 1 }] }]; let current = true;
        const store = create({ readLayout: () => layout, readChat: () => chat,
            assertCurrent() { if (!current) throw new Error('stale'); } });
        const before = plain(chat), write = store.stage({ $图鉴: 1 }, { writeTarget: { index: 0 } });
        write.rollback(); assert.deepStrictEqual(plain(chat), before);
        current = false; assert.throws(() => store.stage({ $图鉴: 2 }, { writeTarget: { index: 0 } }), /stale/);
        assert.deepStrictEqual(plain(chat), before);
    });
}
for (const removedIndex of [0, 1]) {
    test('结构操作契约：数据库删除数组第' + (removedIndex + 1) + '项，隐藏子字段随原元素删除', async () => {
        // 相同公开值不能作为身份；两个删除操作应分别留下不同的隐藏子字段。
        const initial = { 列表: [{ 名字: '相同', $缓存: '甲' }, { 名字: '相同', $缓存: '乙' }] };
        const r = convert(initial), chat = [{ is_user: false }], store = storage(r, chat);
        store.stage(initial, { writeTarget: { index: 0 } });
        const before = core.statDataFromTables(r.entries, r.template).stat_data;
        const next = plain(before);
        next.列表.splice(removedIndex, 1);
        const list = r.entries.find(e => e.group === '列表');
        assert.equal(list.kind, 'singleton');
        const tables = withSqliteSheet(r, list, (db, group) => {
            db.exec(`UPDATE "${group.ident}" SET "${group.columns[0].ident}"=json_remove("${group.columns[0].ident}",'$[${removedIndex}]')`);
        });
        const persisted = core.statDataFromTables(r.entries, tables);
        assert.deepStrictEqual(persisted.stat_data, next, '先区分数据库删除和状态重组的问题');
        const expected = plain(initial);
        expected.列表.splice(removedIndex, 1); // 原 MVU 在完整 stat_data 上执行 splice。
        assert.deepStrictEqual(store.merge(persisted).stat_data, expected);
    });
}
test('存储归属：已声明顶层美元字段映射数据库，未映射脚本状态仍保留原消息', () => {
    const stat = { 角色: { 姓名: '甲', 好感: 10, _设置: { 开关: true }, $缓存: { 游标: 2 } }, $脚本: { 解锁: ['一'] } };
    const r = convert(stat), names = Object.values(r.template).filter(sheet => sheet?.content).map(sheet => sheet.name);
    assert(names.includes('$脚本表'));
    const database = core.statDataFromTables(r.entries, r.template).stat_data;
    assert.deepStrictEqual(database.角色._设置, stat.角色._设置);
    assert.deepStrictEqual(database.角色.$缓存, stat.角色.$缓存);
    const chat = [{ is_user: false }], store = storage(r, chat);
    assert.deepStrictEqual(store.merge({ stat_data: database }).stat_data, stat);
    store.stage({ ...stat, $动态脚本: { 游标: 3 } }, { writeTarget: { index: 0 } });
    assert.deepStrictEqual(store.merge({ stat_data: {} }).stat_data, { $动态脚本: { 游标: 3 } }, '数据库清空后不能复活已映射字段');
    assert.deepStrictEqual(storage(r, plain(chat)).read(), store.read());
    assert(!JSON.stringify(r.template).includes('_扩展数据'));
});
test('存储归属：$动态业务键保存在原记录，但不泄漏到发送行、默认值或示例', async () => {
    const stat = { 角色: { $隐蔽: { 姓名: 'PRIVATE_VALUE_MARKER', 好感: 7 }, 甲: { 姓名: '甲', 好感: 10 } } };
    const r = convert(stat, { entries: [{ comment: '[mvu_update]变量更新规则',
        content: '角色.${姓名}.姓名:\n  type: string\n角色.${姓名}.好感:\n  type: number' }] });
    const entry = r.entries.find(e => e.group === '角色');
    withSqliteSheet(r, entry, (db, group, sheet) => {
        assert(!JSON.stringify(sheet.sourceData).includes('PRIVATE_VALUE_MARKER'));
        assert(!JSON.stringify(sheet.sourceData).includes('$隐蔽'));
        const outer = sheet.updateConfig.sendRowsSqlTemplate.slice('{[sql "'.length, -'"]}'.length);
        const inner = Object.values(db.prepare(outer).get())[0];
        // Exercise the actual generated template through the host's string
        // replacement boundary before SQLite executes the final macro.
        const prefix = '<当前表格数据>', suffix = '</当前表格数据>\n$8';
        const prompt = (prefix + '$0' + suffix).replace('$0', inner);
        assert.strictEqual(prompt, prefix + inner + suffix, '宿主字符串替换不得破坏 SQL 或重复后续提示');
        const renderedInner = prompt.slice(prefix.length, -suffix.length);
        const sent = db.prepare(renderedInner.slice("{[sql '".length, -"']}".length)).all();
        assert(!JSON.stringify(sent).includes('PRIVATE_VALUE_MARKER'));
        assert(!JSON.stringify(sent).includes('$隐蔽'));
    });
    const database = core.statDataFromTables(r.entries, r.template).stat_data;
    assert.deepStrictEqual(database.角色, stat.角色);
    assert.deepStrictEqual(storage(r, []).merge({ stat_data: database }).stat_data, stat);
    const tables = plain(r.template), api = applyingApi(tables);
    const next = { 角色: { ...database.角色, 乙: { 姓名: '乙', 好感: 2 } } };
    assert((await core.writeStatDiffToDbResult(api, r.entries, database, next)).ok);
    assert.deepStrictEqual(core.statDataFromTables(r.entries, tables).stat_data, next);
});

test('声明美元字段：初值和 Schema 声明均可由 SQL 更新，隐藏当前值而不隐藏写入结构', () => {
    const initial = { 主角: { 姓名: '甲' }, $台词: ['PRIVATE_VALUE_MARKER'], $游标: 7, $对象: { 值: 'PRIVATE_OBJECT_MARKER' } };
    const r = convert(initial, { entries: [{ comment: '[mvu_update]更新要求', content: '$台词 — 每次替换为新台词' }],
        extensions: { tavern_helper: { scripts: [{ enabled: true, content: 'registerMvuSchema(z.object({主角:z.object({姓名:z.string()}),$台词:z.array(z.string()),$游标:z.number(),$对象:z.object({值:z.string()}),$缺省:z.string().optional()}));' }] } } });
    assert.equal(r.policy.version, 3);
    assert.deepStrictEqual(storage(r, []).split(initial).native, {});
    assert.deepStrictEqual(core.statDataFromTables(r.entries, r.template).stat_data, initial);
    for (const root of ['$台词', '$游标', '$对象', '$缺省']) {
        const entry = r.entries.find(e => e.group === root);
        assert(entry, '不能根据展示隐藏丢弃声明：' + root);
        const tables = withSqliteSheet(r, entry, (db, group, sheet) => {
            assert(group.privateRoot);
            assert(!sheet.sourceData.hiddenPhysicalColumns?.includes(group.columns[0].ident));
            assert(!/PRIVATE_VALUE_MARKER|PRIVATE_OBJECT_MARKER/.test(JSON.stringify(sheet.sourceData)));
            assert.doesNotMatch(sheet.sourceData.note + sheet.sourceData.updateNode, /全部字段由脚本|全部字段均为脚本|AI 无需填表|AI 不应修改本表/);
            assert.match(sheet.sourceData.updateNode, /只允许更新现有记录/);
            assert.match(sheet.sourceData.note, /json_set/);
            const outer = sheet.updateConfig.sendRowsSqlTemplate.slice('{[sql "'.length, -'"]}'.length);
            const inner = Object.values(db.prepare(outer).get())[0];
            assert.deepStrictEqual(db.prepare(inner.slice("{[sql '".length, -"']}".length)).all(), [], '默认展示不发送私有值');
            const next = root === '$游标' ? 8.25 : root === '$对象' ? { 值: '新对象' } : root === '$缺省' ? '首次写入' : ['新台词'];
            db.prepare('UPDATE "' + group.ident + '" SET "' + group.columns[0].ident + '"=json(?) WHERE row_id=1').run(JSON.stringify(next));
        });
        const expected = { ...initial, [root]: root === '$游标' ? 8.25 : root === '$对象' ? { 值: '新对象' } : root === '$缺省' ? '首次写入' : ['新台词'] };
        assert.deepStrictEqual(core.statDataFromTables(r.entries, tables).stat_data, expected);
    }
});

test('旧版本存储协议：v2 独立美元数据不因插件升级被移动到数据库', () => {
    const store = factory({ readPolicy: () => ({ version: 2, rootContainer: true }) });
    const value = { 状态: { 值: 1 }, $旧缓存: { 游标: 2 } };
    assert.deepStrictEqual(store.split(value), { database: { 状态: { 值: 1 } }, native: { $旧缓存: { 游标: 2 } } });
});
test('动态业务：开放对象与动态记录保存在可写完整JSON，新增字段和记录可读回', async () => {
    const r = convert({ 状态: { $meta: { extensible: true, required: ['金币'] }, 金币: 1 }, 技能: { 剑术: { 熟练度: 10 } } }, {
        entries: [{ comment: '[mvu_update]变量更新规则', content: '技能.${名称}.熟练度:\n  type: number\n  check: 按使用情况更新' }, { comment: '[mvu_update]变量输出格式', content: '变量输出格式:\n  valid_paths: |-\n    /状态/_界面 readonly(前端维护)\n  format: |-\n    <UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>' }],
    });
    const entry = r.entries.find(e => e.group === '状态');
    assert(!r.entries.some(e => e.publicFallback));
    const sheet = Object.values(r.template).find(sheet => sheet?.name === entry.table);
    assert(sheet.content[0].includes(entry.valueCol));
    assert(!entry.overflowCol);
    assert(!(sheet.sourceData.hiddenPhysicalColumns || []).length);
    const store = storage(r, []), base = core.statDataFromTables(r.entries, r.template).stat_data;
    const next = { ...base, 状态: { 金币: 2, 新业务: 3 }, 技能: { 剑术: { 熟练度: 10 }, 炼金: { 熟练度: 1 } } };
    const tables = plain(r.template), api = applyingApi(tables);
    const result = await core.writeStatDiffToDbResult(api, r.entries, base, store.split(next).database);
    assert(result.ok);
    const read = core.statDataFromTables(r.entries, tables).stat_data;
    assert.equal(read.状态.新业务, 3);
    assert.equal(read.技能.炼金.熟练度, 1);
});
test('存储归属：readonly自然语言不改变存储位置', () => {
    const content = '变量输出格式:\n  valid_paths: |\n    /角色/姓名 readonly(人物姓名)\n    /角色/按钮 readonly(前端维护)\n  format: |\n    <UpdateVariable>\n    <Analysis>...</Analysis>\n    <JSONPatch>[]</JSONPatch>\n    </UpdateVariable>';
    const r = convert({ 角色: { 姓名: '甲', 按钮: false, 好感: 1 } }, { entries: [{ comment: '[mvu_update]变量输出格式', content }] });
    const sheet = Object.values(r.template).find(s => s?.name === '角色表');
    assert(!r.entries.find(e=>e.group==='角色').valueCol);
    assert.deepStrictEqual(core.statDataFromTables(r.entries,r.template).stat_data.角色,{姓名:'甲',按钮:false,好感:1});
    assert.deepStrictEqual(r.policy.initial, {});
    assert.match(sheet.sourceData.note, /姓名.*只读|只读.*姓名/);
});

function runtimeCard() {
    const source = require('./synthetic-card')();
    source.data.character_book.entries.push({ comment: '[mvu_update]变量输出格式',
        content: '变量输出格式:\n  valid_paths: |-\n    /界面 readonly(前端维护)\n  format: |-\n    <UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>' });
    source.data.character_book.entries.find(entry => /initvar/i.test(entry.comment)).content += '\n界面:\n  开关: true';
    source.data.character_book.entries.find(entry => /initvar/i.test(entry.comment)).content += '\n$界面缓存:\n  开关: true';
    source.data.first_mes = '公开开场。'; source.data.alternate_greetings = [];
    return source;
}
async function mutateRuntime(h, mutate) {
    const next = h.win.Mvu.getMvuData(); mutate(next.stat_data);
    let settled;
    h.win.Mvu.replaceMvuData(next).then(result => { settled = result; });
    await h.advance(15000);
    return settled;
}
test('原消息状态真实运行时：新增未知脚本根组、混合写入与完整历史读取', async () => {
    const h = await require('./runtime-native').nativeRuntime(runtimeCard());
    const before = h.win.Mvu.getMvuData().stat_data;
    assert.equal(before.界面.开关, true);
    assert.equal(await mutateRuntime(h, stat => { stat.状态.金币 = 23; stat.界面.开关 = false; stat.插图系统 = { 解锁: ['一'] }; stat.$界面缓存.开关 = false; }), true);
    const current = h.win.Mvu.getMvuData().stat_data;
    assert.equal(current.状态.金币, 23); assert.equal(current.界面.开关, false);
    assert.deepStrictEqual(plain(current.插图系统), { 解锁: ['一'] });
    const variables = h.context.chat[0].variables[0];
    assert.deepStrictEqual(plain(variables.stat_data), { 插图系统: { 解锁: ['一'] } });
    assert(!JSON.stringify(h.tables).includes('插图系统'));
    assert(JSON.stringify(h.tables).includes('$界面缓存'));
    assert.equal(current.$界面缓存.开关, false);
    assert.deepStrictEqual(plain(h.win.getVariables({ type: 'message', message_id: 0 }).stat_data), plain(current));
    assert.equal(await mutateRuntime(h, stat => { delete stat.插图系统; }), true);
    assert(!('插图系统' in h.win.Mvu.getMvuData().stat_data));
});
test('原消息状态真实运行时：消息保存失败不报告成功且回滚脚本状态', async () => {
    const h = await require('./runtime-native').nativeRuntime(runtimeCard());
    const before = JSON.stringify(h.context.chat[0].variables);
    h.context.saveChatConditional = async () => { throw new Error('公开保存失败'); };
    assert.equal(await mutateRuntime(h, stat => { stat.$脚本缓存 = { 开关: false }; }), false);
    assert.equal(JSON.stringify(h.context.chat[0].variables), before);
    assert(!('$脚本缓存' in h.win.Mvu.getMvuData().stat_data));
    assert.equal(h.win.Mvu.getMvuData().stat_data.$界面缓存.开关, true);
});
test('原消息状态Schema：完整状态交给原Schema，不擅自排除未知根', async () => {
    const z = require('../src/vendor/schema-engine-libs').zod;
    const api = require('../src/card-api')({ readMetadata: () => ({ schemaKeys: ['one'] }), isCurrent: () => true });
    api.registerSchema(z.strictObject({ 状态: z.strictObject({ 金币: z.number().min(0) }) }), 'one');
    await assert.rejects(api.validate({ 状态: { 金币: 1 }, 插图系统: { 解锁: ['一'] } }), /Schema 校验失败/);
    assert.deepStrictEqual(await api.validate({ 状态: { 金币: 1 } }), { 状态: { 金币: 1 } });
});

test('原消息状态：保存失败的回滚保留同期辅助变量和其他swipe的更新', () => {
    const chat = [{ variables: [{ 辅助: 1 }, { 辅助: 2 }] }];
    const store = factory({ readChat: () => chat, assertCurrent() {} });
    const write = store.stage({ $缓存: 3 }, { writeTarget: { index: 0 } });
    chat[0].variables[0].辅助 = 4; chat[0].variables[1] = { 辅助: 5 };
    write.rollback();
    assert.deepStrictEqual(chat[0].variables, [{ 辅助: 4 }, { 辅助: 5 }]);
});
test('原消息状态真实运行时：作者直接replace不额外运行更新结束业务事件', async () => {
    const h = await require('./runtime-native').nativeRuntime(runtimeCard());
    let calls = 0;
    h.win.eventOn('mag_variable_update_ended', () => { calls++; });
    assert.equal(await mutateRuntime(h, stat => { stat.状态.金币 = 25; stat.$界面缓存.开关 = false; }), true);
    assert.equal(calls, 0, '原replace只保存，不执行变量命令的业务结束事件');
    assert.equal(h.win.Mvu.getMvuData().stat_data.状态.金币, 25);
});

test('原消息状态真实运行时：数据库拒绝混合提交时回滚已暂存的原消息状态', async () => {
    const h = await require('./runtime-native').nativeRuntime(runtimeCard(), ({ api }) => {
        api.importTableAsJson = async () => false; api.updateRow = async () => false; api.updateCell = async () => false;
    });
    const before = JSON.stringify(h.context.chat[0].variables);
    assert.equal(await mutateRuntime(h, stat => { stat.状态.金币 = 31; stat.$界面缓存.开关 = false; }), false);
    assert.equal(JSON.stringify(h.context.chat[0].variables), before);
    assert.equal(h.win.Mvu.getMvuData().stat_data.$界面缓存.开关, true);
});
test('动态业务：完整初始JSON只在数据行出现，DDL默认值与提示示例不重复复制', () => {
    const marker = 'PUBLIC_UNMAPPED_PAYLOAD_' + '字'.repeat(4096);
    const r = convert({ 容器: { 值: 1, 未声明: marker } }, { options: { jsonContainers: ['容器'] }, extensions: { tavern_helper: { scripts: [{
        content: 'const S=z.object({容器:z.object({值:z.number()})});registerMvuSchema(S);' }] } } });
    const json = JSON.stringify(r.template);
    assert.equal(json.split(marker).length - 1, 1);
});

for (const [kind, schema, initial, next] of [
    ['record', 'z.record(z.string(),z.object({数量:z.number().min(0).max(10)}))', { 药水: { 数量: 2, $缓存: '甲' } }, { 铁剑: { 数量: 3, $缓存: '乙' } }],
    ['passthrough', 'z.object({主角:z.object({姓名:z.string()})}).passthrough()', { 主角: { 姓名: '甲' }, 新领域: { 值: 2 } }, { 主角: { 姓名: '乙' }, 又一领域: { 值: 3 } }],
]) {
    test('根对象契约：显式 ' + kind + ' 直接映射根对象，新增和删除根键不依赖兜底表', async () => {
        const r = convert(initial, { extensions: { tavern_helper: { scripts: [{ type: 'script', name: '根声明', enabled: true,
            content: 'const S=' + schema + ';registerMvuSchema(S);' }] } } });
        assert.equal(r.entries.length, 1);
        assert(r.entries[0].rootContainer);
        assert(!r.entries.some(e => e.publicFallback));
        assert.deepStrictEqual(core.statDataFromTables(r.entries, r.template).stat_data, initial);
        assert.match(r.schema[0].columns[0].desc, /完整保存原 stat_data/);
        assert.doesNotMatch(r.schema[0].columns[0].desc, /字段说明与规则|\*\/数量/);
        const tables = plain(r.template), api = applyingApi(tables);
        assert((await core.writeStatDiffToDbResult(api, r.entries, initial, next)).ok);
        assert.deepStrictEqual(core.statDataFromTables(r.entries, tables).stat_data, next);
    });
}
test('根对象契约：中文模板名称经过实际SQLite写入仍对应原根状态', () => {
    const initial = { $meta: { extensible: true }, 主角: { 姓名: '甲' } };
    const r = convert(initial);
    const entry = r.entries[0], group = r.schema[0];
    assert.equal(group.tableName, '状态归属公开样本表');
    assert.equal(group.ident, 'zhuangtaiguishugongkaiyangbenbiao');
    const tables = withSqliteSheet(r, entry, (db, g) => {
        db.prepare('UPDATE "' + g.ident + '" SET "' + g.columns[0].ident
            + '"=json_set("' + g.columns[0].ident + '", ?, ?) WHERE row_id=1')
            .run('$.主角.姓名', '乙');
    });
    assert.deepStrictEqual(core.statDataFromTables(r.entries, tables).stat_data, { 主角: { 姓名: '乙' } });
});
test('根对象契约：模板名称清理控制字符，空名回退，物理名称独立过滤', () => {
    for (const [name, options, expected] of [
        ['校园\n恋爱\u0000\u0085\u2028\u2029', {}, '校园恋爱表'],
        ['已有_数据库', {}, '已有表'],
        ['', { nameSuffix: '' }, '角色表'],
        ['9' + '汉字'.repeat(40) + '\";--', {}, '9' + '汉字'.repeat(40) + '\";--表'],
    ]) {
        const r = core.convert({ spec: 'chara_card_v2', spec_version: '2.0', data: { name, first_mes: '开场', character_book: { entries: [{ comment: '[InitVar]',
            content: '{"$meta":{"extensible":true},"主角":{"姓名":"甲"}}' }] } } }, { mode: 'both', ...options });
        const group = r.schema[0], sheet = Object.values(r.template).find(s => s?.name === expected);
        assert.equal(group.tableName, expected);
        assert(sheet);
        assert.match(group.ident, /^[a-z][a-z0-9_]*$/);
        assert(group.ident.length <= 48);
        assert.equal(require('../src/sheet-identity')().physicalName(sheet.name), group.ident);
        assert.deepStrictEqual(core.statDataFromTables(JSON.parse(r.card.data.extensions.mvu2shujuku.layout), r.template).stat_data,
            { 主角: { 姓名: '甲' } });
    }
});
for (const [kind, schema, initial] of [
    ['可空容器', 'z.object({档案:z.object({数量:z.number().min(0).max(5).describe("仅在消耗道具时调整数量"),状态:z.enum(["开","关"])}).nullable()})',
        { 档案: { 数量: 2, 状态: '开' } }],
    ['开放容器', 'z.object({档案:z.object({数量:z.number().min(0).max(5).describe("仅在消耗道具时调整数量"),状态:z.enum(["开","关"]),列表:z.array(z.string())}).passthrough()})',
        { 档案: { 数量: 2, 状态: '开', 列表: [] } }],
]) {
    test('JSON说明精简：' + kind + ' 保留原规则、SQL示例和实际范围枚举约束', () => {
        const r = convert(initial, { options: { ddlIncludeCheck: true },
            extensions: { tavern_helper: { scripts: [{ type: 'script', enabled: true,
                content: 'const S=' + schema + ';registerMvuSchema(S);' }] } }, entries: [{ comment: '[mvu_update]更新要求',
                content: '变量更新规则:\n  档案:\n    数量:\n      range: 0~5\n      check: 完成任务后才允许补充数量\n    状态:\n      enum: [开, 关]' }] });
        const entry = r.entries[0], group = r.schema[0];
        const sheet = Object.values(r.template).find(s => s?.name === entry.table);
        assert.match(sheet.sourceData.note, /仅在消耗道具时调整数量/);
        assert.match(sheet.sourceData.note, /完成任务后才允许补充数量/);
        assert.match(sheet.sourceData.updateNode, /UPDATE|INSERT/);
        assert.doesNotMatch(group.columns[0].desc, /允许键：|示例：|JSON 内部结构与约束|最小值\/长度|最大值\/长度/);
        const rules = sheet.sourceData.note + '\n' + r.card.character_book.entries.map(e => e.content).join('\n');
        assert.match(rules, /range:\s*0~5|(?:范围|range)[^\n]*0[^\n]*5/);
        assert.match(rules, /enum:\s*\[开, 关\]|开[^\n]*关/);
        const tables = withSqliteSheet(r, entry, (db, g) => {
            const statement = db.prepare('UPDATE "' + g.ident + '" SET "' + g.columns[0].ident
                + '"=json_set("' + g.columns[0].ident + '", ?, ?) WHERE row_id=1');
            assert.throws(() => statement.run('$.数量', 6), /CHECK constraint failed/);
            assert.throws(() => statement.run('$.状态', '未知'), /CHECK constraint failed/);
            statement.run('$.数量', 3);
        });
        assert.deepStrictEqual(core.statDataFromTables(r.entries, tables).stat_data,
            { 档案: { ...initial.档案, 数量: 3 } });
    });
}
test('JSON说明精简：普通对象列及开放根保留作者describe，不生成结构示例', () => {
    for (const rootOpen of [false, true]) {
        const r = convert({ 主角: { 包裹: { 数量: 2 } } }, { extensions: { tavern_helper: { scripts: [{ type: 'script', enabled: true,
            content: 'const S=z.object({主角:z.object({包裹:z.object({数量:z.number().describe("每次购买后增加数量")}).nullable().describe("只能存放剧情中获得的物品")})})'
                + (rootOpen ? '.passthrough()' : '') + ';registerMvuSchema(S);' }] } } });
        const notes = Object.values(r.template).filter(s => s?.sourceData).map(s => s.sourceData.note).join('\n');
        assert.match(notes, /只能存放剧情中获得的物品/);
        assert.match(notes, /每次购买后增加数量/);
        assert.doesNotMatch(notes, /允许键：|JSON 内部结构与约束|示例：\{/);
        assert.deepStrictEqual(core.statDataFromTables(r.entries, r.template).stat_data, { 主角: { 包裹: { 数量: 2 } } });
    }
});
test('根对象契约：禁用的开放Schema不能给新转换增加任意根写入口', () => {
    const r = convert({ 状态: { 值: 1 } }, { extensions: { tavern_helper: { scripts: [{ type: 'script', enabled: false,
        content: 'const S=z.object({}).passthrough();registerMvuSchema(S);' }] } } });
    assert(!r.entries.some(e => e.rootContainer || e.publicFallback));
});
for (const declaration of [{ extensible: true }, { recursiveExtensible: true }]) {
    test('根对象契约：MVU根元数据 ' + Object.keys(declaration)[0] + ' 映射原根对象', async () => {
        const r = convert({ $meta: declaration, 主角: { 姓名: '甲', $缓存: '原记录' }, $界面: { 开关: true } });
        assert.equal(r.entries.length, 1);
        assert(r.entries[0].rootContainer);
        assert(!r.entries.some(e => e.publicFallback));
        const initial = { 主角: { 姓名: '甲', $缓存: '原记录' }, $界面: { 开关: true } };
        assert.deepStrictEqual(core.statDataFromTables(r.entries, r.template).stat_data, initial);
        const tables = plain(r.template), api = applyingApi(tables);
        const next = { ...initial, 任务: { 进度: 1, $缓存: '任务记录' } };
        assert.deepStrictEqual(core.unmappedStatGroups(r.entries, initial, next), []);
        assert((await core.writeStatDiffToDbResult(api, r.entries, initial, next)).ok);
        assert.deepStrictEqual(core.statDataFromTables(r.entries, tables).stat_data, next);
        assert.deepStrictEqual(storage(r, []).merge({ stat_data: next }).stat_data,
            { ...next, $界面: { 开关: true } });
    });
}
test('根对象契约：关闭根或仅声明template不增加动态根入口', () => {
    for (const meta of [{ extensible: false }, { template: { 数量: 0 } }]) {
        const r = convert({ $meta: meta, 主角: { 姓名: '甲' } });
        assert(!r.entries.some(e => e.rootContainer || e.publicFallback));
    }
});
test('根对象契约：原字段规则和已确认的组标题绑定到最终根表，未知标题不猜测', () => {
    const r = convert({ $meta: { extensible: true }, 主角: { 姓名: '甲' } }, { entries: [
        { comment: '[mvu_update]更新要求', content: '通用更新规则:\n  主角:\n    - 开局保留姓名约定\n    - 场景后 replace /主角/姓名 为新称呼\n  未知标题:\n    - 不应猜测为主角约定' },
    ] });
    const sheet = Object.values(r.template).find(s => s?.name === r.entries[0].table);
    assert.match(sheet.sourceData.note, /开局保留姓名约定/);
    assert.match(sheet.sourceData.note, /「内容」内部路径 \/主角\/姓名/);
    assert.doesNotMatch(sheet.sourceData.note, /不应猜测为主角约定/);
    assert(r.card.character_book.entries.some(e => /不应猜测为主角约定/.test(e.content)));
});
for (const schema of [
    'z.object({状态:z.object({数量:z.number(),列表:z.array(z.string()),$口令:z.literal("SECRET_ENUM_MARKER")})})',
    'z.record(z.string(),z.object({数量:z.number(),列表:z.array(z.string()),$口令:z.literal("SECRET_ENUM_MARKER")}))',
]) {
    test('Schema展示契约：' + (schema.startsWith('z.record') ? '根字典' : '固定对象') + '隐藏字段不经JSON说明或DDL重新进入模型', () => {
        const initial = { 状态: { 数量: 2, 列表: ['甲'], $口令: 'SECRET_ENUM_MARKER' } };
        const r = convert(initial, { options: { ddlIncludeCheck: true }, extensions: { tavern_helper: { scripts: [{ type: 'script', enabled: true,
            content: 'const S=' + schema + ';registerMvuSchema(S);' }] } } });
        for (const sheet of Object.values(r.template).filter(s => s?.sourceData)) {
            assert(!JSON.stringify(sheet.sourceData).includes('SECRET_ENUM_MARKER'));
            assert(!JSON.stringify(sheet.sourceData).includes('$口令'));
        }
        assert.deepStrictEqual(core.statDataFromTables(r.entries, r.template).stat_data, initial);
    });
}
test('Schema展示契约：独立VM保留undefined默认值，过滤隐藏结构不改变原Schema快照', () => {
    const create = vm.runInNewContext('(' + factory.toString() + ')');
    const node = { kind: 'object', fields: { 公开: { kind: 'text' }, $口令: { kind: 'text', enum: ['秘密'] } },
        hasDefault: true, defaultValue: undefined, prefaultValue: { 公开: '甲', $口令: '秘密' } };
    const store = create({ readPolicy: () => ({ version: 2 }) }), projected = store.displaySchemaNode(node);
    assert.equal(projected.defaultValue, undefined);
    assert.deepStrictEqual(plain(projected.fields), { 公开: { kind: 'text' } });
    assert.deepStrictEqual(plain(projected.prefaultValue), { 公开: '甲' });
    assert.equal(node.fields.$口令.enum[0], '秘密');
    assert.equal(node.prefaultValue.$口令, '秘密');
});
test('Schema展示契约：完整容器统一保存公开和隐藏字段，不为隐藏子节点另建表', () => {
    const initial = { 状态: { 数量: 2, $缓存: ['甲', '乙'] } };
    const r = convert(initial, { extensions: { tavern_helper: { scripts: [{ type: 'script', enabled: true,
        content: 'const S=z.object({状态:z.object({数量:z.number(),$缓存:z.array(z.string())})});registerMvuSchema(S);' }] } } });
    const entry = r.entries.find(e => e.group === '状态');
    assert.equal(entry.valueCol, '内容');
    assert.equal(entry.cols.length,1);
    assert(!r.entries.some(e => e.table.includes('$缓存')));
    assert.deepStrictEqual(core.statDataFromTables(r.entries, r.template).stat_data, initial);
});
test('根对象契约：直接数据库写入未知根明确失败，不静默丢弃', async () => {
    const r = convert({ 状态: { 值: 1 } }), before = core.statDataFromTables(r.entries, r.template).stat_data;
    const tables = plain(r.template), api = applyingApi(tables), snapshot = plain(tables);
    const result = await core.writeStatDiffToDbResult(api, r.entries, before, { ...before, 未声明: { 值: 2 } });
    assert.equal(result.ok, false);
    assert.match(result.reason || result.failureReason, /未映射/);
    assert.deepStrictEqual(tables, snapshot);
});
test('完整说明归属：新转换将VWD值与说明保存在同一JSON，局部SQL保留当前说明', async () => {
    const initial = { 状态: { 数量: [2, '原说明'], $缓存: '甲' } };
    const r = convert(initial, { options: { vwdDescriptions: true, targetSpVersion: 'naiv1.2.6' } });
    const entry = r.entries.find(e => e.group === '状态');
    assert.equal(entry.valueCol, '内容');
    assert(!entry.vwd);
    const tables = withSqliteSheet(r, entry, (db, group, sheet) => {
        assert(!(sheet.sourceData.hiddenPhysicalColumns || []).length);
        db.exec(`UPDATE "${group.ident}" SET "${group.columns[0].ident}"=json_set("${group.columns[0].ident}",'$.数量[0]',3)`);
    });
    const previous = core.statDataFromTables(r.entries, tables).stat_data;
    assert.deepStrictEqual(previous, { 状态: { 数量: [3, '原说明'], $缓存: '甲' } });
    const next = { 状态: { 数量: [3, '新说明'], $缓存: '甲' } };
    assert((await core.writeStatDiffToDbResult(applyingApi(tables), r.entries, previous, next)).ok);
    assert.deepStrictEqual(core.statDataFromTables(r.entries, tables).stat_data, next);
});
test('SQL运行时契约：新布局在能力未发布时拒绝写入并保留原消息与表格', async () => {
    const h = await require('./runtime-native').nativeRuntime(runtimeCard(), ({ api }) => {
        Object.defineProperties(api, { querySql: { get: () => undefined }, executeSqlQuery: { get: () => undefined } });
    });
    const variables = plain(h.context.chat[0].variables ?? null), tables = plain(h.tables);
    assert.equal(await mutateRuntime(h, stat => { stat.状态.金币 = 99; stat.$界面缓存.开关 = false; }), false);
    assert.deepStrictEqual(plain(h.tables), tables);
    assert.deepStrictEqual(plain(h.context.chat[0].variables ?? null), variables);
});

// 宿主公开 replaceVariables 是整份消息变量替换，辅助写入必须避免清掉共同存放的原生状态。
function installRawMessageVariables({ win, context }) {
    win.getVariables = options => {
        if (options?.type !== 'message') return {};
        const message = context.chat.at(options.message_id == null || options.message_id === 'latest' ? -1 : options.message_id);
        return plain(message?.variables?.[Number(message.swipe_id || 0)] || {});
    };
    win.replaceVariables = (value, options) => {
        if (options?.type !== 'message') return;
        const message = context.chat.at(options.message_id == null || options.message_id === 'latest' ? -1 : options.message_id);
        message.variables ||= [{}];
        message.variables[Number(message.swipe_id || 0)] = plain(value);
    };
}
test('原消息状态变量接口：仅更新辅助变量保留同一消息的隐藏状态', async () => {
    const h = await require('./runtime-native').nativeRuntime(runtimeCard(), installRawMessageVariables);
    assert.equal(await mutateRuntime(h, stat => { stat.$脚本缓存 = { 开关: true }; }), true);
    assert.equal(h.win.Mvu.getMvuData().stat_data.$界面缓存.开关, true);
    const result = await h.win.updateVariablesWith(value => { value.辅助 = '新值'; return value; }, { type: 'message' });
    assert.ok(result);
    assert.equal(h.context.chat[0].variables[0].辅助, '新值');
    assert.equal(h.context.chat[0].variables[0].stat_data.$脚本缓存.开关, true);
    assert.equal(h.win.Mvu.getMvuData().stat_data.$界面缓存.开关, true);
});
test('原消息状态变量接口：混合替换保存失败仍保留原隐藏状态', async () => {
    const h = await require('./runtime-native').nativeRuntime(runtimeCard(), env => {
        installRawMessageVariables(env);
        env.api.importTableAsJson = async () => false; env.api.updateRow = async () => false; env.api.updateCell = async () => false;
    });
    assert.equal(await mutateRuntime(h, stat => { stat.$脚本缓存 = { 开关: true }; }), true);
    const value = h.win.getVariables({ type: 'message' });
    value.stat_data.$脚本缓存.开关 = false;
    value.stat_data.$界面缓存.开关 = false;
    value.stat_data.状态.金币 = 23;
    h.context.saveChatConditional = async () => { throw new Error('公开保存失败'); };
    let result;
    h.win.replaceVariables(value, { type: 'message' }).then(value => { result = value; });
    await h.advance(15000);
    assert.equal(result, false);
    assert.equal(h.context.chat[0].variables[0].stat_data.$脚本缓存.开关, true);
    assert.equal(h.win.Mvu.getMvuData().stat_data.$界面缓存.开关, true);
});
