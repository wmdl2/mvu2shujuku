'use strict';
const { test } = require('./runner');
const { assert } = require('./helpers');
const vm = require('vm');
const create = require('../src/database-write-api');
const { nativeRuntime } = require('./runtime-native');

test('数据库公开写入：旧宿主保留原对象与位置参数', () => {
    const api = { updateCell(...args) { assert.deepStrictEqual(args, ['表', 1, '值', 3]); return 7; } };
    assert.strictEqual(create(api), api);
    assert.equal(create(api).updateCell('表', 1, '值', 3), 7);
    assert.equal(create(null), null);
});

for (const [name, args, expected] of [
    ['updateCell', ['表', 1, '值', '$.x'], { tableName: '表', rowIndex: 1, colIdentifier: '值', value: '$.x' }],
    ['updateRow', ['表', 2, { 内容: { n: 1 } }], { tableName: '表', rowIndex: 2, data: { 内容: { n: 1 } } }],
    ['insertRow', ['表', { 姓名: '甲' }], { tableName: '表', data: { 姓名: '甲' } }],
    ['deleteRow', ['表', 2], { tableName: '表', rowIndex: 2 }],
]) test('数据库公开写入：' + name + '按正式对象协议跳过额外等待', async () => {
    const api = { getTableHistoryContext() { throw Error('写入不需要额外读取来源'); },
        [name](...actual) { assert.strictEqual(this, api); assert.deepStrictEqual(actual, [{ ...expected, awaitFrontendReadback: false }]); return Promise.resolve(true); } };
    assert.equal(await create(api)[name](...args), true);
});

test('数据库公开写入：对象选项保持原样，不修改调用方及公开接口', () => {
    const input = { table: '表', row: 1, data: { n: 2 }, skipChatSave: false, skipNotify: false };
    const api = { getTableHistoryContext() {}, updateRow(options) {
        assert.deepStrictEqual(options, { ...input, awaitFrontendReadback: false }); return false;
    } };
    const original = api.updateRow;
    assert.equal(create(api).updateRow(input), false);
    assert(!Object.hasOwn(input, 'awaitFrontendReadback')); assert.strictEqual(api.updateRow, original);
});

test('数据库公开写入：导入保留持久化和失败完成契约', async () => {
    let resolve;
    const pending = new Promise(r => { resolve = r; });
    const api = { getTableHistoryContext() {}, importTableAsJson(json, options) {
        assert.strictEqual(this, api); assert.equal(json, '{}');
        assert.deepStrictEqual(options, { persist: true, awaitFrontendReadback: false }); return pending;
    } };
    const result = create(api).importTableAsJson('{}', { persist: true });
    assert.strictEqual(result, pending); resolve(false); assert.equal(await result, false);
});

test('数据库公开写入：非适配方法、receiver及同步异常不改变', () => {
    const api = { getTableHistoryContext() { assert.strictEqual(this, api); return { version: 1 }; },
        initGameSession(...args) { assert.strictEqual(this, api); assert.deepStrictEqual(args, [{}, { injectTemplate: false }]); throw Error('host failure'); } };
    assert.throws(() => create(api).initGameSession({}, { injectTemplate: false }), /host failure/);
    assert.deepStrictEqual(create(api).getTableHistoryContext(), { version: 1 });
    const factory = vm.runInNewContext('(' + create.toString() + ')');
    assert.equal(typeof factory(api).initGameSession, 'function');
});

test('数据库公开写入实装：会话写入透传新选项，仍等待宿主持久完成', async () => {
    let submitted = false, finish;
    const pending = new Promise(r => { finish = r; });
    const h = await nativeRuntime(undefined, ({ api }) => {
        api.getTableHistoryContext = () => ({ version: 1, chatId: 'public', isolationKey: '' });
        const update = api.updateCell;
        api.updateCell = async function (options) {
            assert.equal(options.awaitFrontendReadback, false); assert.strictEqual(this, api); submitted = true;
            await pending;
            return update.call(this, options.tableName, options.rowIndex, options.colIdentifier, options.value);
        };
    });
    const value = h.win.Mvu.getMvuData(); value.stat_data.状态.金币 = 73;
    let done = false;
    const saved = h.win.Mvu.replaceMvuData(value).then(result => { done = true; return result; });
    await h.advance(5000);
    assert.equal(submitted, true); assert.equal(done, false); finish(); await h.advance(0);
    assert.equal(await saved, true); assert.equal(h.win.Mvu.getMvuData().stat_data.状态.金币, 73);
});
