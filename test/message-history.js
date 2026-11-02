'use strict';
const vm = require('vm');
const { test } = require('./runner');
const { assert, core } = require('./helpers');
const factory = require('../src/message-history');
function harness(create = factory, extra = {}) {
    const chat = [{ swipe_id: 0, TavernDB_ACU_IsolatedData: '{"revision":1}' }, { swipe_id: 0 }];
    let session = 'chat-A', layout = 'layout-A', runtime = {}, calls = [], respond;
    const api = { exportTableAsJson: () => runtime, exportTableSnapshotsAtMessages: async indices => {
        calls.push([...indices]);
        if (respond) return respond(indices);
        return { success: true, snapshots: indices.map(messageIndex => ({ messageIndex, data: { value: messageIndex + 10 } })) };
    } };
    const reader = create({ readApi: () => api, readChat: () => chat, readSessionKey: () => session,
        readLayoutKey: () => layout, project: data => data && { stat_data: { value: data.value } },
        readFallback: index => ({ stat_data: { legacy: index } }), onError: () => {}, ...extra });
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
test('历史接口适配：多个等待者在前批结束后仍共享下一批相同楼层', async () => {
    for (const create of [factory, vm.runInNewContext('(' + factory.toString() + ')')]) {
        const h = harness(create), requests = [];
        h.respond(indices => new Promise(resolve => requests.push({ indices, resolve })));
        const first = h.reader.prepare([0]);
        const second = h.reader.prepare([1]), third = h.reader.prepare([1]);
        requests[0].resolve({ success: true,
            snapshots: [{ messageIndex: 0, data: { value: 10 } }] });
        await first;
        // Flush queued promise continuations while the next host batch stays pending.
        await new Promise(resolve => setImmediate(resolve));
        const calls = h.calls.map(indices => [...indices]);
        for (const request of requests.slice(1)) request.resolve({ success: true,
            snapshots: request.indices.map(messageIndex => ({ messageIndex, data: { value: 11 } })) });
        await Promise.all([second, third]);
        assert.deepStrictEqual(calls, [[0], [1]], '排队唤醒后必须复核新产生的在途批次，不能重复回放同一楼层');
        assert.equal(h.reader.read(1).stat_data.value, 11);
    }
});
test('历史接口适配：等待后已就绪的楼层不被另一批冷回放继续阻塞', async () => {
    const h = harness(), requests = [];
    h.respond(indices => new Promise(resolve => requests.push({ indices, resolve })));
    const first = h.reader.prepare([0]), cold = h.reader.prepare([1]);
    let ready = false;
    const shared = h.reader.prepare([0]).then(() => { ready = true; });
    requests[0].resolve({ success: true, snapshots: [{ messageIndex: 0, data: { value: 10 } }] });
    await first;
    await new Promise(resolve => setImmediate(resolve));
    const readyBeforeCold = ready;
    requests[1].resolve({ success: true, snapshots: [{ messageIndex: 1, data: { value: 11 } }] });
    await Promise.all([cold, shared]);
    assert.equal(readyBeforeCold, true, '等待的目标楼层已就绪后应立即返回');
    assert.deepStrictEqual(h.calls, [[0], [1]]);
});
test('历史缓存优化：命中读取不再序列化宿主数据帧，深层等长修改仍失效', async () => {
    let storageSerializations = 0;
    const create = vm.runInNewContext('(' + factory.toString() + ')', { JSON: {
        parse: JSON.parse, stringify(value) {
            if (value && value.storageFrame) storageSerializations++;
            return JSON.stringify(value);
        },
    } });
    const h = harness(create);
    const frame = { storageFrame: { version: 2, logEntries: [{ sql: 'value=1' }] } };
    h.chat[0].TavernDB_ACU_IsolatedData = frame;
    await h.reader.prepare([0]); const before = storageSerializations;
    for (let index = 0; index < 100; index++) assert.equal(h.reader.read(0).stat_data.value, 10);
    assert.equal(storageSerializations, before); assert.equal(h.calls.length, 1);
    frame.storageFrame.logEntries[0].sql = 'value=2';
    await h.reader.prepare([0]); assert.equal(h.calls.length, 2);
});
test('历史缓存优化：数组变更、同长换位和深层字段增删均使缓存失效', async () => {
    for (const change of [frame => { frame.rows.reverse(); }, frame => { frame.rows[0].value = 'new'; },
        frame => { delete frame.rows[0].value; }, frame => { frame.rows[0].other = 'added'; },
        frame => { frame.rows.push({ value: 'third' }); }]) {
        const h = harness(), frame = { rows: [{ value: 'one' }, { value: 'two' }] };
        h.chat[0].TavernDB_ACU_IsolatedData = frame; await h.reader.prepare([0]);
        change(frame); await h.reader.prepare([0]); assert.equal(h.calls.length, 2);
    }
});
test('历史缓存优化：布局对象原位修改也拒绝旧历史缓存', async () => {
    const h = harness(), layout = [{ table: 'one', columns: ['value'] }];
    h.layout(layout); await h.reader.prepare([0]); layout[0].columns[0] = 'other';
    await h.reader.prepare([0]); assert.equal(h.calls.length, 2);
});
test('历史缓存优化：准备期间让出主线程，修订变化拒绝发布半批结果', async () => {
    const create = vm.runInNewContext('(' + factory.toString() + ')', { Date: { now: (() => { let time = 0; return () => time += 9; })() } });
    let h, yields = 0;
    h = harness(create, { yieldToHost: async () => { yields++; h.chat[0].swipe_id = 1; } });
    await assert.rejects(h.reader.prepare([0, 1]), { code: 'MVU_HISTORY_CONTEXT_CHANGED' });
    assert.equal(yields, 1);
    await h.reader.prepare([0, 1]); assert.equal(h.reader.read(0).stat_data.value, 10);
});
test('历史缓存优化：索引保持宿主重复快照的首次命中语义', async () => {
    const h = harness(); h.respond(() => ({ success: true, snapshots: [
        { messageIndex: 0, data: { value: 10 } }, { messageIndex: 0, data: { value: 99 } },
    ] }));
    await h.reader.prepare([0]); assert.equal(h.reader.read(0).stat_data.value, 10);
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
test('历史缓存优化：无变化的连续回调保留已准备缓存，不重读全历史', async () => {
    const { nativeRuntime } = require('./runtime-native');
    const h = await nativeRuntime(undefined, ({ win, context }) => {
        context.chat.push({ is_user: true }, { is_user: false });
        win.EjsTemplate = { defines: {}, evalTemplate: async (_code, context) => context.getvar('stat_data.状态.金币') };
    });
    let calls = 0;
    h.api.exportTableSnapshotsAtMessages = async indices => { calls++; return { success: true,
        snapshots: indices.map(messageIndex => ({ messageIndex, data: h.tables })) }; };
    await h.win.EjsTemplate.evalTemplate('<%= getvar("stat_data.状态.金币") %>', { message_id: 0 });
    assert.equal(calls, 1);
    for (let round = 0; round < 3; round++) {
        for (const callback of h.tableCallbacks) callback(h.tables, { persisted: false });
    }
    await h.advance(120);
    assert.equal(calls, 1, '通知本身没有改变历史输入，不能丢弃已准备结果');
    assert.equal(typeof h.win.Mvu.getMvuData({ message_id: 0 }).stat_data.状态.金币, 'number');
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


test('历史缓存性能：尾部追加只补新楼层，删除尾部保留已准备前缀', async () => {
    const h = harness();
    await h.reader.prepare([0, 1]);
    h.chat.push({ swipe_id: 0 });
    await h.reader.prepare([0, 1, 2]);
    assert.deepStrictEqual(h.calls, [[0, 1], [2]]);
    h.chat.pop();
    await h.reader.prepare([0, 1]);
    assert.equal(h.calls.length, 2);
    h.chat.push({ swipe_id: 0 });
    await h.reader.prepare([2]);
    assert.deepStrictEqual(h.calls[2], [2], '删除后的旧尾部不能因索引复用而复活');
});

test('历史缓存性能：旧层原地变更只失效该层及之后，前缀仍可读取', async () => {
    const h = harness();
    h.chat.push({ swipe_id: 0 });
    h.chat[1].TavernDB_ACU_IsolatedData = { storageFrame: { rows: [{ value: 1 }] } };
    await h.reader.prepare([0, 1, 2]);
    h.chat[1].TavernDB_ACU_IsolatedData.storageFrame.rows[0].value = 2;
    await h.reader.prepare([0, 1, 2]);
    assert.deepStrictEqual(h.calls, [[0, 1, 2], [1, 2]]);
    assert.equal(h.reader.read(0).stat_data.value, 10);
});

test('历史缓存性能：中间插入或替换存储帧会失效受影响后缀', async () => {
    for (const change of [chat => chat.splice(1, 0, { swipe_id: 0 }),
        chat => { chat[1] = { swipe_id: 0, TavernDB_ACU_IsolatedData: '{"revision":3}' }; }]) {
        const h = harness(); h.chat[1].TavernDB_ACU_IsolatedData = '{"revision":2}';
        await h.reader.prepare([0, 1]);
        change(h.chat);
        await h.reader.prepare(h.chat.map((_, index) => index));
        assert.deepStrictEqual(h.calls[1], h.chat.map((_, index) => index).slice(1));
    }
});

test('历史缓存性能：只替换正文对象且数据库输入未变，不重放历史', async () => {
    const h = harness(); await h.reader.prepare([0, 1]);
    h.chat[1] = { ...h.chat[1], mes: '编辑后的正文' };
    await h.reader.prepare([0, 1]);
    assert.equal(h.calls.length, 1);
});

test('历史缓存性能：共享帧原位变更从最早引用层开始失效', async () => {
    const h = harness(), frame = { rows: [{ value: 1 }] };
    h.chat.push({ swipe_id: 0, TavernDB_ACU_IsolatedData: frame });
    h.chat[0].TavernDB_ACU_IsolatedData = frame;
    await h.reader.prepare([0, 1, 2]);
    frame.rows[0].value = 2;
    await h.reader.prepare([0, 1, 2]);
    assert.deepStrictEqual(h.calls, [[0, 1, 2], [0, 1, 2]]);
});

test('历史缓存性能：缓存命中不等待其他冷楼层的在途回放', async () => {
    const h = harness(); await h.reader.prepare([0]);
    let release;
    h.respond(indices => new Promise(resolve => { release = () => resolve({ success: true,
        snapshots: indices.map(messageIndex => ({ messageIndex, data: { value: 20 } })) }); }));
    const cold = h.reader.prepare([1]);
    let ready = false;
    const cached = h.reader.prepare([0]).then(() => { ready = true; });
    try {
        await Promise.resolve(); await Promise.resolve();
        assert.equal(ready, true, '已准备楼层不能被无关的慢回放串行阻塞');
    } finally { release(); await Promise.all([cold, cached]); }
});

test('历史缓存性能：追加消息期间的在途结果仍拒绝发布，已完成前缀保留', async () => {
    const h = harness(); await h.reader.prepare([0]);
    let release;
    h.respond(indices => new Promise(resolve => { release = () => resolve({ success: true,
        snapshots: indices.map(messageIndex => ({ messageIndex, data: { value: 20 } })) }); }));
    const pending = h.reader.prepare([1]);
    h.chat.push({ swipe_id: 0 }); release();
    await assert.rejects(pending, { code: 'MVU_HISTORY_CONTEXT_CHANGED' });
    assert.equal(h.reader.read(0).stat_data.value, 10);
    assert.throws(() => h.reader.read(1), { code: 'MVU_HISTORY_NOT_READY' });
    release(); await Promise.resolve();
});

test('历史缓存性能：相同有效布局复用引用，宏变化与原位修改仍更新布局', () => {
    const fs = require('fs'), source = fs.readFileSync(require.resolve('../src/extension-runtime'), 'utf8');
    const start = source.indexOf('    function resolveRuntimeLayout(');
    const end = source.indexOf('    // 查找 SP', start);
    let user = '甲';
    const context = { activeLayout: null, window: { MVU2SHUJUKU_CORE: core },
        getContextSafe: () => ({ substituteParams: text => String(text).replace(/\{\{user\}\}/g, user) }), dbgWarn() {} };
    vm.createContext(context); vm.runInContext(source.slice(start, end), context);
    const raw = [{ table: '角色表', group: '{{user}}', path: ['{{user}}'], cols: [] }];
    const first = context.resolveRuntimeLayout(raw); context.activeLayout = first;
    assert.strictEqual(context.resolveRuntimeLayout(JSON.stringify(raw)), first);
    user = '乙'; const second = context.resolveRuntimeLayout(raw);
    assert.notStrictEqual(second, first); assert.equal(first[0].group, '甲'); assert.equal(second[0].group, '乙');
    context.activeLayout = second; second[0].group = '原位改动';
    assert.notStrictEqual(context.resolveRuntimeLayout(raw), second);
});


test('历史准备范围：单层渲染只读该层，分页只读挂载范围，聊天加载保留全量预热', async () => {
    const { nativeRuntime } = require('./runtime-native'), first = new Map(), calls = [];
    const h = await nativeRuntime(undefined, ({ win, context, api, tables }) => {
        for (let index = 1; index <= 20; index++) context.chat.push({ is_user: index % 2 === 1, swipe_id: 0 });
        context.event_types = { CHAT_LOADED: 'load', CHARACTER_MESSAGE_RENDERED: 'render', MORE_MESSAGES_LOADED: 'more' };
        context.eventSource.makeFirst = (name, callback) => first.set(name, callback);
        api.exportTableSnapshotsAtMessages = async indices => { calls.push([...indices]); return { success: true,
            snapshots: indices.map(messageIndex => ({ messageIndex, data: tables })) }; };
    });
    let revision = 0;
    const changed = () => { h.context.chat[0].TavernDB_ACU_IsolatedData.test.revision = ++revision; calls.length = 0; };
    changed(); await first.get('render')(4);
    assert.deepStrictEqual(calls, [[4]]);
    h.win.document.querySelectorAll = selector => selector === '#chat .mes[mesid]'
        ? [8, 10].map(index => ({ getAttribute: () => String(index) })) : [];
    changed(); await first.get('more')();
    assert.deepStrictEqual(calls, [[8, 10]]);
    changed(); await first.get('load')({ detail: { id: 'chat-name-is-not-a-floor' } });
    assert.deepStrictEqual(calls, [h.context.chat.map((_, index) => index)]);
});

// A small optional host contract supplies source identity without replaying
// history. Existing hosts must keep their conservative runtime boundary.
for (const [name, create] of [['module', factory], ['isolated', vm.runInNewContext('(' + factory.toString() + ')')]]) {
    test('历史来源性能 ' + name + '：公开来源稳定时普通运行时发布不丢旧楼缓存', async () => {
        const h = harness(create);
        h.api.getTableHistoryContext = () => ({ version: 1, chatId: 'chat-A', characterId: 0, groupId: null, isolationKey: '' });
        await h.reader.prepare([0]);
        for (let n = 0; n < 5; n++) { h.slot(); await h.reader.prepare([0]); }
        assert.equal(h.calls.length, 1);
        h.chat.push({ swipe_id: 0, TavernDB_ACU_IsolatedData: { revision: 2 } }); h.slot();
        await h.reader.prepare([0, 2]); assert.deepStrictEqual(h.calls, [[0], [2]]);
        h.chat[0].TavernDB_ACU_IsolatedData = '{"revision":2}';
        await h.reader.prepare([0, 2]); assert.deepStrictEqual(h.calls.at(-1), [0, 2]);
    });
    test('历史来源保护 ' + name + '：隔离槽和宿主身份变化使全部缓存失效', async () => {
        for (const field of ['chatId', 'characterId', 'groupId', 'isolationKey']) {
            const h = harness(create);
            const source = { version: 1, chatId: 'chat-A', characterId: 0, groupId: null, isolationKey: '' };
            h.api.getTableHistoryContext = () => ({ ...source });
            await h.reader.prepare([0]); source[field] = 'other'; await h.reader.prepare([0]);
            assert.equal(h.calls.length, 2, field);
        }
    });
    test('历史来源保护 ' + name + '：接口缺失异常或契约无效时仍使用运行时失效保护', async () => {
        for (const read of [() => null, () => { throw Error('not ready'); }, () => ({ version: 2 }),
            () => ({ version: 1, chatId: 'chat-A', isolationKey: null }),
            () => ({ version: 1, chatId: '', isolationKey: '' })]) {
            const h = harness(create); h.api.getTableHistoryContext = read;
            await h.reader.prepare([0]); h.slot(); await h.reader.prepare([0]); assert.equal(h.calls.length, 2);
        }
    });
    test('历史来源保护 ' + name + '：在途读取切换隔离槽不得发布旧结果', async () => {
        const h = harness(create); let isolationKey = '', release;
        h.api.getTableHistoryContext = () => ({ version: 1, chatId: 'chat-A', isolationKey });
        h.respond(indices => new Promise(resolve => { release = () => resolve({ success: true,
            snapshots: indices.map(messageIndex => ({ messageIndex, data: { value: 12 } })) }); }));
        const pending = h.reader.prepare([0]); isolationKey = 'other'; release();
        await assert.rejects(pending, { code: 'MVU_HISTORY_CONTEXT_CHANGED' });
        h.respond(null); await h.reader.prepare([0]); assert.equal(h.calls.length, 2);
    });
}

test('历史读取复制：内部延迟复制仍由真实变量API隔离，普通读取保持独立副本', async () => {
    const h = harness(); await h.reader.prepare([0]);
    const variables = require('../src/variable-api')({ lodash: require('../src/vendor/schema-engine-libs').lodash,
        readDatabase: () => h.reader.read(0, { copy: false }), replaceDatabase() {}, assertCurrent() {}, assertWritable() {} });
    const native = { getVariables: () => ({ auxiliary: { count: 1 } }) };
    const api = variables.bind(native, {});
    const first = api.getVariables({ type: 'message', message_id: 0 });
    first.stat_data.value = 99; first.auxiliary.count = 2;
    assert.equal(h.reader.read(0).stat_data.value, 10);
    assert.equal(api.getVariables({ type: 'message', message_id: 0 }).stat_data.value, 10);
    const ordinary = h.reader.read(0, 1); ordinary.stat_data.value = 77;
    assert.equal(h.reader.read(0).stat_data.value, 10, 'EJS swipe argument must not defer cloning');
});

test('历史准备扫描：无帧和延后首帧均线性扫描，并保留无帧楼的继承与请求顺序', async () => {
    const source = require('fs').readFileSync(require.resolve('../src/extension-runtime'), 'utf8');
    const part = (start, end) => { const a = source.indexOf(start), b = source.indexOf(end, a); assert(a >= 0 && b > a); return source.slice(a, b); };
    let reads = 0, firstFrame = -1; const calls = [];
    const chat = Array.from({ length: 1500 }, (_, index) => ({ get TavernDB_ACU_IsolatedData() {
        reads++; return index === firstFrame ? '{"default":{"storageFrame":{"version":2}}}' : index === 300 ? '{broken' : undefined;
    } }));
    const context = { getContextSafe: () => ({ chat }), currentCharacter: () => ({}), isConvertedMvuCard: () => true,
        ensureActiveLayoutLazy: () => true, ejsEvalBridge: { selectMessage: () => ({ index: 1499, current: true }) },
        databaseMessageHistory: { prepare: async indices => calls.push(Array.from(indices)) }, dbgWarn() {} };
    vm.createContext(context);
    vm.runInContext(part('    function hasDatabaseMessageData(', '    function readDatabaseMessageHistory(')
        + part('    async function prepareDatabaseHistory(', '    function scheduleDatabaseHistoryPreparation('), context);
    await context.prepareDatabaseHistory(); assert.equal(reads, 1500); assert.equal(calls.length, 0);
    reads = 0; firstFrame = 900;
    await context.prepareDatabaseHistory(undefined, false, [2, 1400, 1000, 1499]);
    assert.deepStrictEqual(calls, [[1400, 1000]]); assert.equal(reads, 901);
});
