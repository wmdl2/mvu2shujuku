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

test('写入适配模块：浏览器构建使用内联工厂且保留核心写入接口', async () => {
    const coreSource = fs.readFileSync(path.join(__dirname, '../src/mvu2shujuku.js'), 'utf8');
    const index = core.assembleExtension({ coreSource })['index.js'];
    const ui = index.lastIndexOf('\n// ============================================================\n// MVU转数据库 · SillyTavern 原生扩展 UI');
    const sandbox = vm.createContext({ console });
    vm.runInContext(index.slice(0, ui), sandbox);
    const data = tables(), browserCore = sandbox.MVU2SHUJUKU_CORE;
    await browserCore.writeStatDiffToDb(applyingApi(data), layout, { 状态: { 生命: 100 } }, { 状态: { 生命: 80 } });
    assert.strictEqual(data.sheet_status.content[1][1], '80');
    assert.strictEqual(browserCore.lastStatWriteFailed, false);
});
