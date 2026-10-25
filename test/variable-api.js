'use strict';
const vm = require('vm');
const { test } = require('./runner');
const { assert } = require('./helpers');
const lodash = require('../src/vendor/schema-engine-libs').lodash;
const createVariableApi = require('../src/variable-api');

function harness() {
    let state = { count: 3, nested: { left: 1, right: 2 }, list: [{ id: 'a', $cache: 7 }] };
    let auxiliary = { helper: 4 }, active = true, fail = false;
    const writes = [], delegated = [], receiver = {};
    const native = {};
    for (const name of ['getVariables', 'replaceVariables', 'updateVariablesWith', 'insertOrAssignVariables', 'insertVariables', 'deleteVariable']) {
        native[name] = function (...args) {
            delegated.push({ name, args, receiver: this });
            if (args.at(-1)?.type === 'message') {
                if (name === 'getVariables') return lodash.cloneDeep(auxiliary);
                if (name === 'replaceVariables') { auxiliary = args[0]; return; }
            }
            return 'native:' + name;
        };
    }
    const factory = vm.runInNewContext('(' + createVariableApi.toString() + ')');
    const adapter = factory({ lodash,
        readDatabase: opts => ({ stat_data: opts.message_id === 0 ? { count: 1 } : lodash.cloneDeep(state) }),
        replaceDatabase: async (next, opts) => { if (fail) return false; writes.push({ next, opts }); state = lodash.cloneDeep(next.stat_data); return true; },
        nativeState: () => ({ $root: { kept: true } }),
        assertCurrent: () => { if (!active) throw Error('session changed'); },
        assertWritable: opts => { if (opts.message_id === 0) throw Error('history readonly'); },
    });
    return { api: adapter.bind(native, receiver), adapter, native, receiver, writes, delegated,
        state: () => state, auxiliary: () => auxiliary,
        expire: () => { active = false; }, fail: () => { fail = true; } };
}
const message = { type: 'message' };
const plain = value => JSON.parse(JSON.stringify(value));

test('TH变量接口：全局与命名空间共用完整入口，非消息默认与receiver原样委派', () => {
    const h = harness();
    assert.deepStrictEqual(Array.from(h.adapter.names).sort(), ['deleteVariable', 'getVariables', 'insertOrAssignVariables', 'insertVariables', 'replaceVariables', 'updateVariablesWith']);
    for (const name of h.adapter.names) {
        for (const opts of [undefined, { type: 'chat' }, { type: 'global' }, { type: 'character' }, { type: 'preset' }, { type: 'script', script_id: 'id' }, { type: 'extension', extension_id: 'ext' }]) {
            const args = name === 'getVariables' ? [opts] : [() => {}, opts];
            assert.strictEqual(h.api[name](...args), 'native:' + name);
            assert.strictEqual(h.delegated.at(-1).receiver, h.receiver);
            assert.deepStrictEqual(h.delegated.at(-1).args, args);
        }
    }
});

test('TH变量接口：消息读取含辅助变量、指定历史并返回独立副本', () => {
    const h = harness(), value = h.api.getVariables(message);
    assert.strictEqual(value.helper, 4); assert.strictEqual(value.stat_data.count, 3);
    value.stat_data.nested.left = 999;
    assert.strictEqual(h.state().nested.left, 1);
    assert.strictEqual(h.api.getVariables({ type: 'message', message_id: 0 }).stat_data.count, 1);
});

test('TH变量接口：同步和异步updater保留结构、原生根与返回值，无变更不写库', async () => {
    const h = harness();
    const next = await h.api.updateVariablesWith(v => { v.stat_data.count = 8; v.helper = 5; return v; }, message);
    assert.strictEqual(next.stat_data.count, 8); assert.strictEqual(h.state().count, 8);
    assert.deepStrictEqual(plain(h.auxiliary()), { helper: 5, stat_data: { $root: { kept: true } } });
    await h.api.updateVariablesWith(async v => v, message);
    assert.strictEqual(h.writes.length, 1);
    const replacement = { stat_data: { count: 9 }, helper: 6 };
    assert.strictEqual(await h.api.replaceVariables(replacement, message), undefined);
    assert.deepStrictEqual(plain(h.state()), { count: 9 });
});

test('TH变量接口：insertOrAssign按对象合并且整数组替换，不抹掉无关字段', async () => {
    const h = harness();
    const value = await h.api.insertOrAssignVariables({ stat_data: { nested: { left: 6 }, list: [{ id: 'b' }] } }, message);
    assert.deepStrictEqual(plain(value.stat_data), { count: 3, nested: { left: 6, right: 2 }, list: [{ id: 'b' }] });
    assert.strictEqual(value.helper, 4);
});

test('TH变量接口：insert只补缺失字段，已有值及数组优先', async () => {
    const h = harness();
    const value = await h.api.insertVariables({ stat_data: { count: 99, nested: { added: false }, list: ['wrong'], extra: null } }, message);
    assert.strictEqual(value.stat_data.count, 3);
    assert.deepStrictEqual(plain(value.stat_data.nested), { added: false, left: 1, right: 2 });
    assert.deepStrictEqual(plain(value.stat_data.list), [{ id: 'a', $cache: 7 }]);
    assert.strictEqual(value.stat_data.extra, null);
});

test('TH变量接口：delete使用Lodash路径并保留上游delete_occurred形状', async () => {
    const h = harness();
    const value = await h.api.deleteVariable('stat_data.nested.left', message);
    assert.strictEqual(value.delete_occurred, true);
    assert.deepStrictEqual(plain(value.variables.stat_data.nested), { right: 2 });
    assert.strictEqual((await h.api.deleteVariable('stat_data.missing', message)).delete_occurred, true);
});

test('TH变量接口：历史拒写、数据库失败及异步切卡不发布辅助变量', async () => {
    const h = harness();
    await assert.rejects(h.api.updateVariablesWith(v => v, { type: 'message', message_id: 0 }), /history readonly/);
    h.fail();
    await assert.rejects(h.api.replaceVariables({ stat_data: { count: 9 }, helper: 99 }, message), /未能保存/);
    assert.strictEqual(h.auxiliary().helper, 4); assert.strictEqual(h.state().count, 3);
    await assert.rejects(h.api.updateVariablesWith(async v => { h.expire(); v.helper = 99; return v; }, message), /session changed/);
    assert.strictEqual(h.auxiliary().helper, 4);
});

test('TH变量接口：无返回值的updater不猜成旧快照，失败保留数据库', async () => {
    const h = harness();
    await assert.rejects(h.api.updateVariablesWith(() => {}, message), /变量表必须是对象/);
    assert.strictEqual(h.writes.length, 0);
});

test('TH变量接口：助手实际bind注入立即接入数据库，保留原生绑定供还原', async () => {
    const h = harness();
    const frame = { id: 'frame' };
    const originals = { _getVariables: function (opts) { assert.strictEqual(this, frame); return h.native.getVariables.call(this, opts); },
        _updateVariablesWith: h.native.updateVariablesWith, _eventOn: () => 'event' };
    const adapted = h.adapter.bindIframe(originals);
    const injected = Object.fromEntries(Object.entries(adapted).map(([key, fn]) => [key.slice(1), fn.bind(frame)]));
    assert.strictEqual(injected.getVariables.__mvu2shujuku, true);
    assert.strictEqual(injected.getVariables(message).stat_data.count, 3);
    await injected.updateVariablesWith(v => { v.stat_data.count = 7; return v; }, message);
    assert.strictEqual(h.state().count, 7);
    assert.strictEqual(injected.getVariables.__mvu2shujukuNative({ type: 'chat' }), 'native:getVariables');
    assert.strictEqual(injected.eventOn(), 'event');
    assert.strictEqual(originals._getVariables.__mvu2shujuku, undefined);
});

test('TH变量接口：作者显式元数据可更新，不触发无关数据库写入', async () => {
    const h = harness();
    await h.api.updateVariablesWith(v => { v.delta_data = { count: 2 }; v.initialized_lorebooks = { book: true }; return v; }, message);
    const next = h.api.getVariables(message);
    assert.deepStrictEqual(plain(next.delta_data), { count: 2 });
    assert.deepStrictEqual(plain(next.initialized_lorebooks), { book: true });
    assert.strictEqual(h.writes.length, 0);
});

test('TH变量接口：getAll合并原辅助变量与指定数据库视图，保留显式元数据', () => {
    const h = harness();
    const factory = vm.runInNewContext('(' + createVariableApi.toString() + ')');
    const frame = { id: 0 };
    const adapter = factory({ lodash, assertCurrent() {}, readAll: receiver => ({ stat_data: { id: receiver.id }, display_data: { derived: true } }) });
    const api = adapter.bind({ getAllVariables() { return { local: 7, stat_data: { stale: true }, display_data: { custom: true } }; } }, frame);
    assert.deepStrictEqual(plain(api.getAllVariables()), { local: 7, stat_data: { id: 0 }, display_data: { custom: true } });
    assert.strictEqual(h.writes.length, 0);
});

test('TH变量接口：消息读取的同步与Promise形态走同一投影，保留原对象', async () => {
    const factory = vm.runInNewContext('(' + createVariableApi.toString() + ')');
    let prepared = 0;
    const adapter = factory({ lodash, assertCurrent() {}, prepareMessages: async () => { prepared++; },
        projectMessages: list => list.map(item => ({ ...item, data: { ...item.data, stat_data: { count: item.message_id } } })) });
    const list = [{ message_id: 0, data: { aux: 1 } }];
    for (const asyncRead of [false, true]) {
        const api = adapter.bind({ getChatMessages: () => asyncRead ? Promise.resolve(list) : list }, {});
        const result = api.getChatMessages('0');
        assert.strictEqual(!!result.then, asyncRead);
        assert.deepStrictEqual(plain(await result), [{ message_id: 0, data: { aux: 1, stat_data: { count: 0 } } }]);
    }
    assert.strictEqual(prepared, 1); assert.deepStrictEqual(list, [{ message_id: 0, data: { aux: 1 } }]);
});

test('TH变量接口：setChatMessages复用变量提交，转交原消息字段并避免复制映射状态', async () => {
    const h = harness(); let received;
    h.native.setChatMessages = (messages, opts) => { received = { messages, opts }; };
    const api = h.adapter.bind(h.native, h.receiver);
    const messages = [{ message_id: 2, message: 'text', data: { helper: 8, stat_data: { count: 10 } } }];
    await api.setChatMessages(messages, { refresh: 'none' });
    assert.strictEqual(h.state().count, 10);
    assert.deepStrictEqual(plain(received.messages[0].data.stat_data), { $root: { kept: true } });
    assert.strictEqual(received.messages[0].message, 'text');
    assert.deepStrictEqual(received.opts, { refresh: 'none' });
    assert.strictEqual(messages[0].data.stat_data.count, 10);
    const before = h.writes.length;
    await assert.rejects(api.setChatMessages([{ message_id: 0, data: { stat_data: {} } }]), /history readonly/);
    await assert.rejects(api.setChatMessages([{ data: { stat_data: {} } }]), /整数/);
    await assert.rejects(api.setChatMessages([{ message_id: 2, swipes_data: [{ stat_data: {} }] }]), /swipes_data/);
    assert.strictEqual(h.writes.length, before);
});

test('TH变量接口：reloadInitVar沿原浅合并和书级去重，不重置已有组及展示数据', () => {
    const h = harness(), display = { custom: true };
    const data = { stat_data: { existing: { value: 7 }, script: true }, display_data: display, initialized_lorebooks: [] };
    const initial = { existing: { value: 1, another: 2 }, added: { value: 3 } };
    assert.strictEqual(h.adapter.reloadInitial(data, initial, 'converted-book'), true);
    assert.deepStrictEqual(plain(data.stat_data), { existing: { value: 7 }, script: true, added: { value: 3 } });
    assert.strictEqual(data.display_data, display);
    assert.deepStrictEqual(plain(data.initialized_lorebooks), { 'converted-book': [] });
    delete data.stat_data.added;
    assert.strictEqual(h.adapter.reloadInitial(data, initial, 'converted-book'), false);
    assert.strictEqual(data.stat_data.added, undefined);
});

test('TH变量接口：真实predefine共享namespace时不自递归，切卡还原原生namespace', () => {
    const h = harness();
    const cardApi = require('../src/card-api')({ readMetadata: () => ({}), isCurrent: () => true, readMvu: () => ({}) });
    const shared = { list: [] }, globals = require('../src/runtime-globals')({ readSharedState: () => shared,
        isOursShimFn: fn => !!fn?.__mvu2shujuku, readFake: () => null });
    const parent = { document: {}, TavernHelper: h.native }, frame = { document: {} };
    const facade = cardApi.facade(h.native);
    globals.patch(parent, 'TavernHelper', facade);
    lodash.merge(frame, { TavernHelper: parent.TavernHelper });
    assert.strictEqual(frame.TavernHelper, parent.TavernHelper, 'source predefine shares a custom-prototype facade');
    const original = globals.original(frame, 'TavernHelper');
    assert.strictEqual(original, h.native);
    const api = h.adapter.bind(original, original);
    Object.defineProperty(facade, 'getVariables', { value: api.getVariables, configurable: true, writable: true });
    assert.strictEqual(frame.TavernHelper.getVariables(message).stat_data.count, 3);
    globals.patch(frame, 'TavernHelper', facade);
    globals.restoreAll();
    assert.strictEqual(parent.TavernHelper, h.native);
    assert.strictEqual(frame.TavernHelper, h.native);
});

test('TH变量接口：全局脚本没有所属消息号，读取及等待使用latest而不调用getMessageId', () => {
    const h = harness();
    const script = { __TH_IFRAME_ID: 'TH-script--test--id', getCurrentMessageId() { throw Error('not a message iframe'); } };
    assert.strictEqual(h.adapter.messageIdForWindow(script), 'latest');
    assert.strictEqual(h.adapter.messageIdForWindow({ __TH_IFRAME_ID: 'TH-message--0--1', getCurrentMessageId: () => 0 }), 0);
    assert.strictEqual(h.adapter.messageIdForWindow({}), 'latest');
});

test('TH变量接口：未初始化的getAll保留原生只读数据并标记，不能随后当完整快照提交', async () => {
    const h = harness();
    const adapter = createVariableApi({ lodash, assertCurrent() {}, assertWritable() {},
        readAll: () => { throw Object.assign(new Error('not ready'), { code: 'MVU_DATA_NOT_READY' }); } });
    const value = adapter.bind({ getAllVariables: () => ({ setting: true }) }, {}).getAllVariables();
    assert.deepStrictEqual(Object.keys(value), ['setting']);
    assert.strictEqual(value.__mvu2shujukuReadUnavailable, true);
    await assert.rejects(h.api.replaceVariables(value, message), error => error.code === 'MVU_DATA_NOT_READY');
    assert.strictEqual(h.writes.length, 0);
});
