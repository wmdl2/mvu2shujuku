'use strict';
const vm = require('vm');
const createTableWriter = require('../src/table-writer');
const codec = require('../src/table-codec')();
const { test } = require('./runner');
const { core, assert, fs, path, applyingApi, bridgeSandbox } = require('./helpers');
const layout = [{ kind: 'singleton', group: '状态', table: '状态表', cols: [
    ['生命', 'number', 100, ['状态', '生命']], ['姓名', 'text', '未命名', ['状态', '姓名']],
] }];
function tables() {
    return { sheet_status: { name: '状态表', content: [['row_id', '生命', '姓名'], [1, 100, '甲']] } };
}

async function standaloneWrite(fail) {
    const converted = core.convert({ name: '独立写入测试', first_mes: '你好', character_book: { entries: [
        { comment: '[InitVar]', content: JSON.stringify({ 状态: { 生命: 100, 魔力: 50 } }) },
    ] } }, { installMvuShim: true });
    const timers = [];
    const { win, tables: data, fakeApi } = bridgeSandbox(converted, { extra: {
        setTimeout(fn, ms) { if (ms === 150) timers.push(fn); return 1; }, clearTimeout() {},
        MVU2SHUJUKU_CORE: { writeStatDiffToDb() { throw new Error('不得委派给共享实例'); } },
    } });
    fakeApi.initGameSession = undefined;
    let writes = 0;
    const api = applyingApi(data);
    if (fail) fakeApi.updateCell = async () => false;
    fakeApi.updateRow = async (table, row, values) => {
        writes++;
        if (fail) return false;
        for (const [col, value] of Object.entries(values)) await api.updateCell(table, row, col, value);
        return true;
    };
    const next = JSON.parse(JSON.stringify(win.Mvu.getMvuData()));
    next.stat_data.状态.生命 = 80;
    next.stat_data.状态.魔力 = 30;
    const result = win.Mvu.replaceMvuData(next);
    await Promise.resolve();
    assert.strictEqual(timers.length, 1);
    timers.shift()();
    return { ok: await result, writes, stat: win.getAllVariables().stat_data };
}

test('旧桥共用写入：独立实例将同一行多字段合并一次提交', async () => {
    const result = await standaloneWrite(false);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.writes, 1);
    assert.strictEqual(result.stat.状态.生命, 80);
    assert.strictEqual(result.stat.状态.魔力, 30);
});

test('旧桥共用写入：失败返回 false 且不重复执行兜底', async () => {
    const result = await standaloneWrite(true);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.writes, 1);
    assert.strictEqual(result.stat.状态.生命, 100);
});

test('JSON 组统一写入：核心与独立桥接受空对象到标量，重复值不提交', async () => {
    for (const value of ['无', '', 0, false, ['记录'], { 记录: '内容' }]) {
        const converted = core.convert({ name: 'JSON统一测试', first_mes: '你好', character_book: { entries: [
            { comment: '[InitVar]', content: JSON.stringify({ 日志: {} }) },
        ] } }, { installMvuShim: true });
        const entries = JSON.parse((converted.card.data || converted.card).extensions.mvu2shujuku.layout);
        const data = JSON.parse(JSON.stringify(converted.template));
        const api = applyingApi(data);
        let coreWrites = 0;
        const update = api.updateCell;
        api.updateCell = async (...args) => { coreWrites++; return update(...args); };
        await core.writeStatDiffToDb(api, entries, { 日志: {} }, { 日志: value });
        assert.strictEqual(coreWrites, 1);
        assert.deepStrictEqual(core.statDataFromTables(entries, data).stat_data.日志, value);
        await core.writeStatDiffToDb(api, entries, { 日志: value }, { 日志: value });
        assert.strictEqual(coreWrites, 1, '核心重复值不再次写入');

        const timers = [];
        const { win, fakeApi } = bridgeSandbox(converted, { extra: {
            setTimeout(fn, ms) { if (ms === 150) timers.push(fn); return 1; }, clearTimeout() {},
        } });
        fakeApi.initGameSession = undefined;
        let bridgeWrites = 0;
        const bridgeUpdate = fakeApi.updateCell;
        fakeApi.updateCell = async (...args) => { bridgeWrites++; return bridgeUpdate(...args); };
        for (let n = 0; n < 2; n++) {
            const result = win.Mvu.replaceMvuData({ stat_data: { 日志: value } });
            await Promise.resolve();
            timers.shift()();
            assert.strictEqual(await result, true);
            assert.deepStrictEqual(JSON.parse(JSON.stringify(win.getAllVariables().stat_data.日志)), value);
        }
        assert.strictEqual(bridgeWrites, 1, '独立桥重复值不再次写入');
    }
});

test('写入适配模块：工厂可隔离内联，只通过传入 API 修改表格', async () => {
    const factory = vm.runInNewContext('(' + createTableWriter.toString() + ')');
    const writer = factory({ parseJson: codec.parseObject });
    const data = tables();
    const count = await writer.writeStatDiffToDb(applyingApi(data), layout, { 状态: { 生命: 100 } }, { 状态: { 生命: 80 } });
    assert.strictEqual(count, 1);
    assert.strictEqual(data.sheet_status.content[1][1], '80');
    assert.strictEqual(data.sheet_status.content[1][2], '甲');
    assert.strictEqual(writer.lastStatWriteFailed, false);
});

test('写入适配模块：缓存模板由回调注入，不访问隐式宿主', async () => {
    const data = tables(), cached = tables();
    data.sheet_status.content = [data.sheet_status.content[0]];
    cached.sheet_status.content[1][2] = '缓存姓名';
    let reads = 0;
    const writer = createTableWriter({ parseJson: codec.parseObject, readCachedTemplate() { reads++; return cached; } });
    const api = applyingApi(data);
    api.getTableTemplate = async () => null;
    await writer.writeStatDiffToDb(api, layout, { 状态: { 生命: 100 } }, { 状态: { 生命: 80 } });
    assert.strictEqual(reads, 1);
    assert.strictEqual(data.sheet_status.content[1][1], '80');
    assert.strictEqual(data.sheet_status.content[1][2], '缓存姓名');
    assert.strictEqual(writer.lastStatWriteFailed, false);
});

test('写入适配模块：失败状态在实例间隔离，计划数量不等于成功数量', async () => {
    const first = createTableWriter({ parseJson: codec.parseObject }), second = createTableWriter({ parseJson: codec.parseObject });
    const data = tables(), api = applyingApi(data);
    api.updateCell = async () => false;
    assert.strictEqual(await first.writeStatDiffToDb(api, layout, { 状态: { 生命: 100 } }, { 状态: { 生命: 80 } }), 1);
    assert.strictEqual(first.lastStatWriteFailed, true);
    assert.strictEqual(data.sheet_status.content[1][1], 100);
    assert.strictEqual(second.lastStatWriteFailed, false);
    await second.writeStatDiffToDb(applyingApi(data), layout, { 状态: { 生命: 100 } }, { 状态: { 生命: 80 } });
    assert.strictEqual(second.lastStatWriteFailed, false);
    assert.strictEqual(first.lastStatWriteFailed, true);
});

test('写入结果：无操作、成功与宿主 false/throw 保留计划数量和首个原因', async () => {
    const writer = createTableWriter({ parseJson: codec.parseObject });
    const data = tables(), api = applyingApi(data);
    const before = { 状态: { 生命: 100 } };
    assert.deepStrictEqual(await writer.writeStatDiffToDbResult(api, layout, before, before),
        { ok: true, plannedChanges: 0, failureReason: null });
    assert.deepStrictEqual(await writer.writeStatDiffToDbResult(api, layout, before, { 状态: { 生命: 80 } }),
        { ok: true, plannedChanges: 1, failureReason: null });
    assert.strictEqual(writer.lastStatWriteFailed, false);
    for (const failure of [false, new Error('宿主断开')]) {
        const failedApi = applyingApi(tables());
        failedApi.updateCell = async () => { if (failure) throw failure; return false; };
        const result = await writer.writeStatDiffToDbResult(failedApi, layout, before, { 状态: { 生命: 70 } });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.plannedChanges, 1);
        assert.match(result.failureReason, /updateCell\(状态表\)/);
        if (failure) assert.match(result.failureReason, /宿主断开/);
        assert.strictEqual(writer.lastStatWriteFailed, false, '新接口不改变旧 getter');
    }
});

test('写入结果：规划拒绝可以失败且计划数为零', async () => {
    const writer = createTableWriter({ parseJson: codec.parseObject });
    const numberLayout = [{ kind: 'json', group: 'counter', table: 'counter表', scalarType: 'number' }];
    const result = await writer.writeStatDiffToDbResult(applyingApi({}), numberLayout,
        { counter: 1 }, { counter: '非数字' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.plannedChanges, 0);
    assert.match(result.failureReason, /只接受有限数字/);
});

test('写入结果：已成功的写入后失败仍报告完整计划，updateRow 降级成功不报失败', async () => {
    const writer = createTableWriter({ parseJson: codec.parseObject });
    const before = { 状态: { 生命: 100, 姓名: '甲' } };
    const after = { 状态: { 生命: 80, 姓名: '乙' } };
    const data = tables(), api = applyingApi(data);
    api.updateRow = undefined;
    const update = api.updateCell;
    const seen = [];
    api.updateCell = async (...args) => {
        seen.push(args[2]);
        return seen.length === 1 ? update(...args) : false;
    };
    const partial = await writer.writeStatDiffToDbResult(api, layout, before, after);
    assert.strictEqual(partial.ok, false);
    assert.strictEqual(partial.plannedChanges, 2);
    assert.ok(partial.failureReason);
    assert.strictEqual(seen.length, 2);
    assert.strictEqual(data.sheet_status.content[1][1], '80');
    assert.strictEqual(data.sheet_status.content[1][2], '甲');

    const fallbackData = tables(), fallbackApi = applyingApi(fallbackData);
    fallbackApi.updateRow = async () => false;
    const fallback = await writer.writeStatDiffToDbResult(fallbackApi, layout, before, after);
    assert.deepStrictEqual(fallback, { ok: true, plannedChanges: 2, failureReason: null });
    assert.strictEqual(fallbackData.sheet_status.content[1][1], '80');
    assert.strictEqual(fallbackData.sheet_status.content[1][2], '乙');
});

test('写入结果：同实例交错调用的失败状态独立，旧数值接口仍更新 getter', async () => {
    const writer = createTableWriter({ parseJson: codec.parseObject });
    const before = { 状态: { 生命: 100 } };
    let release, entered;
    const held = new Promise(resolve => { release = resolve; });
    const atWrite = new Promise(resolve => { entered = resolve; });
    const slowApi = applyingApi(tables());
    const slowUpdate = slowApi.updateCell;
    slowApi.updateCell = async (...args) => { entered(); await held; return slowUpdate(...args); };
    const slow = writer.writeStatDiffToDbResult(slowApi, layout, before, { 状态: { 生命: 80 } });
    await atWrite;
    const fastApi = applyingApi(tables());
    fastApi.updateCell = async () => false;
    const fast = await writer.writeStatDiffToDbResult(fastApi, layout, before, { 状态: { 生命: 70 } });
    release();
    const completed = await slow;
    assert.strictEqual(fast.ok, false);
    assert.strictEqual(fast.plannedChanges, 1);
    assert.ok(fast.failureReason);
    assert.deepStrictEqual(completed, { ok: true, plannedChanges: 1, failureReason: null });
    assert.strictEqual(writer.lastStatWriteFailed, false);
    const oldApi = applyingApi(tables());
    oldApi.updateCell = async () => false;
    assert.strictEqual(await writer.writeStatDiffToDb(oldApi, layout, before, { 状态: { 生命: 60 } }), 1);
    assert.strictEqual(writer.lastStatWriteFailed, true);
    assert.deepStrictEqual(await writer.writeStatDiffToDbResult(applyingApi(tables()), layout, before, before),
        { ok: true, plannedChanges: 0, failureReason: null });
    assert.strictEqual(writer.lastStatWriteFailed, true);
});

test('写入结果：回放跳过继续后续操作，未捕获规划异常仍抛出', async () => {
    const writer = createTableWriter({ parseJson: codec.parseObject });
    const data = tables();
    data.sheet_status.content = [data.sheet_status.content[0]];
    const persisted = tables();
    data.sheet_resource = { name: '资源表', content: [['row_id', '金币'], [1, 10]] };
    const resourceLayout = { kind: 'singleton', group: '资源', table: '资源表',
        cols: [['金币', 'number', 10, ['资源', '金币']]] };
    const api = applyingApi(data);
    const writes = [];
    const update = api.updateCell;
    api.updateCell = async (...args) => { writes.push(args[0]); return update(...args); };
    const replay = await writer.writeStatDiffToDbResult(api, [...layout, resourceLayout],
        { 状态: { 生命: 100 }, 资源: { 金币: 10 } },
        { 状态: { 生命: 80 }, 资源: { 金币: 20 } }, persisted);
    assert.strictEqual(replay.ok, false);
    assert.ok(replay.failureReason);
    assert.strictEqual(replay.plannedChanges, 2);
    assert.deepStrictEqual(writes, ['资源表'], '回放跳过后继续写其他表');
    const badLayout = [{ get kind() { throw new Error('规划错误'); } }];
    await assert.rejects(writer.writeStatDiffToDbResult(applyingApi(tables()), badLayout,
        { 状态: { 生命: 100 } }, { 状态: { 生命: 80 } }), /规划错误/);
    await assert.rejects(writer.writeStatDiffToDb(applyingApi(tables()), badLayout,
        { 状态: { 生命: 100 } }, { 状态: { 生命: 80 } }), /规划错误/);
});

test('写入适配模块：浏览器构建使用内联工厂且保留核心写入接口', async () => {
    const coreSource = fs.readFileSync(path.join(__dirname, '../src/mvu2shujuku.js'), 'utf8');
    const index = core.assembleExtension({ coreSource })['index.js'];
    const sandbox = vm.createContext({ console });
    vm.runInContext(index, sandbox);
    const data = tables(), browserCore = sandbox.MVU2SHUJUKU_CORE;
    await browserCore.writeStatDiffToDb(applyingApi(data), layout, { 状态: { 生命: 100 } }, { 状态: { 生命: 80 } });
    assert.strictEqual(data.sheet_status.content[1][1], '80');
    assert.strictEqual(browserCore.lastStatWriteFailed, false);
});
