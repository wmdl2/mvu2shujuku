'use strict';
const vm = require('vm');
const { test } = require('./runner');
const { assert, core } = require('./helpers');
const factory = require('../src/message-history');
function harness(create = factory) {
    const chat = [{ swipe_id: 0, TavernDB_ACU_IsolatedData: '{"revision":1}' }, { swipe_id: 0 }];
    let session = 'chat-A', layout = 'layout-A', runtime = {}, calls = [], respond;
    const api = { exportTableAsJson: () => runtime, exportTableSnapshotsAtMessages: async indices => {
        calls.push([...indices]);
        if (respond) return respond(indices);
        return { success: true, snapshots: indices.map(messageIndex => ({ messageIndex, data: { value: messageIndex + 10 } })) };
    } };
    const reader = create({ readApi: () => api, readChat: () => chat, readSessionKey: () => session,
        readLayoutKey: () => layout, project: data => data && { stat_data: { value: data.value } },
        readFallback: index => ({ stat_data: { legacy: index } }), onError: () => {} });
    return { reader, api, chat, calls, session: value => { session = value; }, layout: value => { layout = value; },
        slot: () => { runtime = {}; }, respond: value => { respond = value; } };
}
test('历史接口适配：指定楼层批量读取、缓存复用和副本隔离', async () => {
    const h = harness(); await h.reader.prepare([0, 1, 0]);
    assert.deepStrictEqual(h.calls, [[0, 1]]);
    assert.equal(h.reader.read(0).stat_data.value, 10);
    h.reader.read(0).stat_data.value = 99;
    await h.reader.prepare([0, 1]);
    assert.equal(h.reader.read(0).stat_data.value, 10); assert.equal(h.calls.length, 1);
});
test('历史接口适配：同一修订的并发准备共享宿主回放', async () => {
    const h = harness(); let resolve;
    h.respond(indices => new Promise(done => { resolve = () => done({ success: true,
        snapshots: indices.map(messageIndex => ({ messageIndex, data: { value: 1 } })) }); }));
    const first = h.reader.prepare([0]), second = h.reader.prepare([0]);
    assert.equal(h.calls.length, 1); resolve(); await Promise.all([first, second]);
    assert.equal(h.calls.length, 1);
});
test('历史接口适配：聊天、布局、swipe、等长字符串帧和已发布隔离运行时变化使缓存失效', async () => {
    for (const change of [h => h.session('chat-B'), h => h.layout('layout-B'),
        h => { h.chat[0].swipe_id = 1; }, h => { h.chat[0].TavernDB_ACU_IsolatedData = '{"revision":2}'; },
        h => h.slot(), h => h.reader.invalidate()]) {
        const h = harness(); await h.reader.prepare([0]); change(h); await h.reader.prepare([0]);
        assert.equal(h.calls.length, 2);
    }
});
test('历史接口适配：异步读取期间修订变化拒绝过期结果', async () => {
    const h = harness(); let resolve;
    h.respond(() => new Promise(done => { resolve = done; }));
    const task = h.reader.prepare([0]); h.chat[0].swipe_id = 1;
    resolve({ success: true, snapshots: [{ messageIndex: 0, data: { value: 123 } }] });
    await assert.rejects(task, { code: 'MVU_HISTORY_CONTEXT_CHANGED' });
});
test('历史接口适配：失败保留宿主定位、不发布半批结果，稍后可重新准备', async () => {
    const h = harness();
    h.respond(() => ({ success: false, code: 'replay_failed', error: 'bad SQL', failurePoint: { messageIndex: 1 } }));
    await assert.rejects(h.reader.prepare([0, 1]), e => e.historyCode === 'replay_failed' && e.failurePoint.messageIndex === 1);
    h.respond(() => ({ success: true, snapshots: [{ messageIndex: 0, data: { value: 3 } }] }));
    await assert.rejects(h.reader.prepare([0, 1]), { code: 'MVU_HISTORY_UNAVAILABLE' });
    h.respond(undefined); await h.reader.prepare([0, 1]); assert.equal(h.reader.read(1).stat_data.value, 11);
});
test('历史接口适配：新接口未准备时显式拒绝，不返回空对象或当前值', async () => {
    const h = harness(); assert.throws(() => h.reader.read(0), { code: 'MVU_HISTORY_NOT_READY' });
    await h.reader.prepare([0]); assert.equal(h.reader.read(0).stat_data.value, 10);
});
test('历史接口适配：旧宿主只使用原快照备用读取，按接口能力判断', async () => {
    const h = harness(); delete h.api.exportTableSnapshotsAtMessages;
    assert.equal(await h.reader.prepare([0]), false);
    assert.deepStrictEqual(h.reader.read(0), { stat_data: { legacy: 0 } }); assert.equal(h.calls.length, 0);
});
test('历史接口适配：产品工厂实际内联，脱离Node作用域仍可读取', async () => {
    const create = vm.runInNewContext('(' + core.getMessageHistoryFactory().toString() + ')');
    const h = harness(create); await h.reader.prepare([0]); assert.equal(h.reader.read(0).stat_data.value, 10);
});

test('历史接口接入：真实运行时在EJS执行前准备，TH与Mvu同步读取对应楼层', async () => {
    const { nativeRuntime } = require('./runtime-native');
    const h = await nativeRuntime(undefined, ({ win, context }) => {
        win._ = require('../src/vendor/schema-engine-libs').lodash;
        context.chat.push({ is_user: true, mes: 'user' }, { is_user: false, mes: 'latest' });
        win.EjsTemplate = { defines: {}, evalTemplate: async (_code, context) => context.getMessageVar('stat_data.状态.金币') };
    });
    const layout = JSON.parse(h.context.characters[0].extensions.mvu2shujuku.layout);
    const tables = structuredClone(h.tables), before = core.statDataFromTables(layout, tables).stat_data;
    const { applyingApi } = require('./helpers');
    await core.writeStatDiffToDbResult(applyingApi(tables), layout, before,
        { ...before, 状态: { ...before.状态, 金币: 19 } });
    let calls = 0;
    h.api.exportTableSnapshotsAtMessages = async indices => { calls++; return { success: true,
        snapshots: indices.map(messageIndex => ({ messageIndex, data: tables })) }; };
    const code = '<%= getMessageVar("stat_data.状态.金币") %>';
    assert.equal(await h.win.EjsTemplate.evalTemplate(code, { message_id: 0 }), 19);
    const count = calls;
    assert.equal(await h.win.EjsTemplate.evalTemplate(code, { message_id: 0 }), 19);
    assert.equal(calls, count);
    assert.equal(h.win.getVariables({ type: 'message', message_id: 0 }).stat_data.状态.金币, 19);
    assert.equal(h.win.Mvu.getMvuData({ type: 'message', message_id: 0 }).stat_data.状态.金币, 19);
    assert.equal(h.win.Mvu.getMvuData().stat_data.状态.金币, before.状态.金币);
    h.context.chat[0].swipe_id = 1;
    await h.win.EjsTemplate.evalTemplate(code, { message_id: 0 });
    assert(calls > count);
});
test('历史接口接入：历史回放失败不冒充当前数据，当前读取仍可用', async () => {
    const { nativeRuntime } = require('./runtime-native');
    const h = await nativeRuntime(undefined, ({ win, context }) => {
        win._ = require('../src/vendor/schema-engine-libs').lodash;
        context.chat.push({ is_user: true }, { is_user: false });
        win.EjsTemplate = { defines: {}, evalTemplate: async (_code, context) => context.getvar('stat_data.状态.金币') };
    });
    h.api.exportTableSnapshotsAtMessages = async () => ({ success: false, code: 'replay_failed', error: 'bad SQL' });
    await assert.rejects(h.win.EjsTemplate.evalTemplate('<%= getvar("stat_data") %>', { message_id: 0 }),
        e => e.code === 'MVU_HISTORY_UNAVAILABLE' && e.historyCode === 'replay_failed');
    const latest = h.win.Mvu.getMvuData().stat_data.状态.金币;
    assert.equal(await h.win.EjsTemplate.evalTemplate('<%= getvar("stat_data") %>', {}), latest);
    assert.throws(() => h.win.getVariables({ type: 'message', message_id: 0 }), e => e.code === 'MVU_HISTORY_NOT_READY');
});

test('历史接口接入：原消息脚本数据实时合并，删除后不从数据库缓存复活', async () => {
    const { nativeRuntime } = require('./runtime-native');
    const h = await nativeRuntime(undefined, ({ win, context }) => {
        win._ = require('../src/vendor/schema-engine-libs').lodash;
        context.chat.push({ is_user: true }, { is_user: false });
        win.EjsTemplate = { defines: {}, evalTemplate: async (_code, context) => context.getvar('stat_data') };
    });
    h.context.chat[0].variables = [{ stat_data: { '$历史脚本': '甲' } }];
    let calls = 0;
    h.api.exportTableSnapshotsAtMessages = async indices => { calls++; return { success: true,
        snapshots: indices.map(messageIndex => ({ messageIndex, data: h.tables })) }; };
    await h.win.EjsTemplate.evalTemplate('<%= getvar("stat_data") %>', { message_id: 0 });
    assert.equal(h.win.Mvu.getMvuData({ message_id: 0 }).stat_data['$历史脚本'], '甲');
    const count = calls;
    h.context.chat[0].variables[0].stat_data = {};
    assert.equal(h.win.Mvu.getMvuData({ message_id: 0 }).stat_data['$历史脚本'], undefined);
    assert.equal(calls, count);
});

test('历史接口接入：getChatMessages各楼投影，保留正文/辅助数据及原同步或异步形式', async () => {
    const { nativeRuntime } = require('./runtime-native');
    for (const asynchronous of [false, true]) {
        const h = await nativeRuntime(undefined, ({ win, context }) => {
            win._ = require('../src/vendor/schema-engine-libs').lodash;
            context.chat.push({ is_user: true }, { is_user: false });
            win.EjsTemplate = { defines: {}, evalTemplate: async (_code, context) => context.getvar('stat_data') };
            const list = [{ message_id: 0, data: { auxiliary: 'keep' }, message: 'old' },
                { message_id: 2, data: { auxiliary: 'current' }, message: 'new' }];
            win.getChatMessages = () => asynchronous ? Promise.resolve(list) : list;
        });
        const layout = JSON.parse(h.context.characters[0].extensions.mvu2shujuku.layout);
        const tables = structuredClone(h.tables), before = core.statDataFromTables(layout, tables).stat_data;
        await core.writeStatDiffToDbResult(require('./helpers').applyingApi(tables), layout, before,
            { ...before, 状态: { ...before.状态, 金币: 19 } });
        h.api.exportTableSnapshotsAtMessages = async indices => ({ success: true,
            snapshots: indices.map(messageIndex => ({ messageIndex, data: tables })) });
        if (!asynchronous) await h.win.EjsTemplate.evalTemplate('<%= getvar("stat_data") %>', { message_id: 0 });
        const result = h.win.getChatMessages('0-2');
        assert.equal(typeof result?.then === 'function', asynchronous);
        const list = await result;
        assert.equal(list[0].data.stat_data.状态.金币, 19);
        assert.equal(list[1].data.stat_data.状态.金币, before.状态.金币);
        assert.equal(list[0].data.auxiliary, 'keep'); assert.equal(list[0].message, 'old');
    }
});
