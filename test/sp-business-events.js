'use strict';
const publishedLayoutFixture=require('./published-layout-fixture');
// Retained physical layouts are tested with frozen public metadata; current conversions use layout-planning.js.
const legacyLayoutFixture = require('./legacy-layout-fixture');
const vm = require('vm');
const { test } = require('./runner');
const { assert, fs, core, applyingApi } = require('./helpers');
const source = fs.readFileSync(require.resolve('../src/extension-runtime'), 'utf8');
const start = source.indexOf('    function readSpCommitEntries(');
const end = source.indexOf('    // 所有表格变化共用', start);
const plain = value => JSON.parse(JSON.stringify(value));
function message(entryId = 'one', source = 'manual_crud') {
    return { is_user: false, TavernDB_ACU_IsolatedData: { '': { storageFrame: { version: 2, logEntries: [{
        entryId, source, targetMessageIndex: 0, operations: [{ kind: 'row_upsert', sheetKey: 'sheet_a' }],
    }] } } } };
}
function harness(initial = { A: { life: 100, gold: 10 } }) {
    const result = publishedLayoutFixture({ name: '业务修正', first_mes: '开场', character_book: { entries: [
        { comment: '[InitVar]', content: JSON.stringify(initial) },
    ] } });
    const layout = JSON.parse(result.card.extensions.mvu2shujuku.layout);
    const tables = plain(result.template), state = { chat: [message()], session: true, emitted: 0, imports: 0, published: 0 };
    const api = applyingApi(tables, { onImport() { state.imports++; } });
    const context = { window: { MVU2SHUJUKU_CORE: core }, activeLayout: layout, dbgWarn() {},
        getContextSafe: () => state, getAcuApi: () => api, sharedStateWindow: {},
        nativeStatStorage: require('../src/stat-storage')({ readLayout: () => layout,
            readPolicy: () => result.card.extensions.mvu2shujuku.statStorage, readChat: () => state.chat }),
        runtimeApiForSession: value => value, isRuntimeSessionCurrent: () => state.session,
        assertRuntimeSession: () => { if (!state.session) throw new Error('session changed'); },
        canonicalJsonForSync: JSON.stringify,
        publishProjectedTableSnapshot: () => { state.published++; },
        emitMvuEvent: async (name, after) => { state.emitted++; await state.listener(after); },
        buildUpdatedTemplateFromStat: async (layouts, before, next, data) => {
            const candidate = plain(data);
            await core.writeStatDiffToDb(applyingApi(candidate), layouts, before, next);
            if (core.lastStatWriteFailed) throw new Error('invalid candidate');
            return candidate;
        },
    };
    vm.createContext(context);
    context.window.__MVU2SHUJUKU_CANDIDATE_BUILDER_FACTORY__ = vm.runInContext('(' + require('../src/extension-runtime').createCandidateBuilder.toString() + ')', context);
    const batchStart = source.indexOf('    async function commitCurrentReplyBatch(');
    const batchEnd = source.indexOf('    async function tryOpeningBulkInit(', batchStart);
    vm.runInContext(source.slice(batchStart, batchEnd) + source.slice(start, end), context);
    return { context, state, tables, layout, api };
}
test('SP 回调复查：已建立的业务基线不重复导出表格，换会话后重新建立', () => {
    const { context, api } = harness();
    const rawExport = api.exportTableAsJson;
    let exports = 0, session = {};
    const registered = [], callback = () => {};
    api.exportTableAsJson = function () { exports++; return rawExport.call(this); };
    api.registerTableUpdateCallback = value => { registered.push(value); };
    context.tableUpdateHookCallback = callback;
    context.captureRuntimeSession = () => session;
    context.isRuntimeSessionCurrent = value => value === session;
    const begin = source.indexOf('    function installTableUpdateHook()');
    const finish = source.indexOf('    function uninstallTableUpdateHook()', begin);
    vm.runInContext(source.slice(begin, finish), context);
    for (let i = 0; i < 5; i++) assert.strictEqual(context.installTableUpdateHook(), true);
    assert.strictEqual(exports, 1);
    session = {};
    assert.strictEqual(context.installTableUpdateHook(), true);
    assert.strictEqual(exports, 2);
    assert.deepStrictEqual(registered, Array(6).fill(callback));
});

test('聊天回放兜底：复用已投影的后态，实际回到旧状态仍广播', () => {
    const { context, api, tables } = harness();
    const events = [];
    const timers = new Map();
    let nextTimer = 0, projections = 0;
    const project = context.mvuDataFromCompleteTableSnapshot;
    const sheet = Object.values(tables).find(value => value?.name === 'A表');
    const column = sheet.content[0].indexOf('life');
    api.exportTableAsJson = () => tables;
    Object.assign(context, {
        autoInitChatId: () => 'fixture', currentCharacter: () => ({}), cardCacheKey: () => 'fixture-card',
        hasConvertedRuntime: () => true, variableUpdateDispatchSeq: 0,
        tableBusinessRunning: false, pendingStatWrite: null, reentryNotifyFingerprint: '',
        dbg() {}, stageFrontendCommittedMvuRead() {},
        refreshCurrentCardFrontends({ after }) {
            events.push(after.stat_data.A.life);
            return { direct: 0, event: 1, control: 0 };
        },
        hostWindow: {
            setTimeout(fn) { timers.set(++nextTimer, fn); return nextTimer; },
            clearTimeout(id) { timers.delete(id); },
        },
    });
    context.mvuDataFromCompleteTableSnapshot = function (...args) { projections++; return project(...args); };
    const begin = source.indexOf('    function publishCommittedTableSnapshot(');
    const finish = source.indexOf('    // 有些旧式状态栏', begin);
    vm.runInContext(source.slice(begin, finish), context);
    for (const value of [73, 100]) {
        context.scheduleChatMutationFrontendSync('swipe', true);
        sheet.content[1][column] = value;
        timers.values().next().value();
        assert.strictEqual(timers.size, 0);
    }
    assert.deepStrictEqual(events, [73, 100]);
    assert.strictEqual(projections, 4, '每轮只投影一次前态和一次后态');
});

test("旧布局：SP 业务来源：基线、历史回放、自身提交和非持久化回调不重算，按日志 ID 去重", () => {
    const { context } = harness(), tracker = context.createSpCommitTracker(), keys = new Set(['sheet_a']);
    tracker.seed(context.readSpCommitEntries([message('old')]));
    assert.strictEqual(tracker.consume(context.readSpCommitEntries([message('old')]), keys, true).length, 0);
    assert.strictEqual(tracker.consume(context.readSpCommitEntries([message('new')]), keys, true).length, 1);
    assert.strictEqual(tracker.consume(context.readSpCommitEntries([message('new')]), keys, true).length, 0);
    for (const origin of ['import', 'system', 'merge_summary', 'template_assistant']) {
        assert.strictEqual(tracker.consume(context.readSpCommitEntries([message(origin, origin)]), keys, true).length, 0);
    }
    assert.strictEqual(tracker.consume(context.readSpCommitEntries([message('own')]), keys, false).length, 0);
    assert.strictEqual(tracker.consume(context.readSpCommitEntries([message('own')]), keys, true).length, 0);
    assert.strictEqual(tracker.consume(context.readSpCommitEntries([message('other')]), new Set(['other']), true).length, 0);
    tracker.seed(context.readSpCommitEntries([message('reenter')]));
    assert.strictEqual(tracker.consume(context.readSpCommitEntries([message('reenter')]), keys, true).length, 0);
});
test("旧布局：SP 业务修正：等待异步监听，一次提交最终值，旧楼保留 CRUD 归属", async () => {
    for (const older of [false, true]) {
        const { context, state, tables, layout } = harness();
        if (older) state.chat.push({ is_user: false });
        state.listener = async after => { await Promise.resolve(); after.stat_data.A.life = 73; };
        const task = { entries: context.readSpCommitEntries(state.chat), before: { stat_data: { A: { life: 100, gold: 9 } } } };
        assert.strictEqual(await context.applySpBusinessCorrection(plain(tables), task, {}), true);
        assert.strictEqual(core.statDataFromTables(layout, tables).stat_data.A.life, 73);
        assert.strictEqual(state.emitted, 1);
        assert.strictEqual(state.imports, older ? 0 : 1);
        assert.strictEqual(state.published, 1);
    }
});
test("旧布局：SP 业务修正：监听期间切聊天、删除来源或新提交，取消旧修正且不重试业务", async () => {
    for (const change of ['session', 'delete', 'commit', 'database']) {
        const { context, state, tables } = harness();
        const original = JSON.stringify(tables);
        const task = { entries: context.readSpCommitEntries(state.chat) };
        state.listener = async after => {
            await Promise.resolve(); after.stat_data.A.life = 73;
            if (change === 'session') state.session = false;
            if (change === 'delete') state.chat = [];
            if (change === 'commit') state.chat[0].TavernDB_ACU_IsolatedData[''].storageFrame.logEntries.push({ entryId: 'other' });
            if (change === 'database') tables.extra = true;
        };
        await assert.rejects(context.applySpBusinessCorrection(plain(tables), task, {}));
        assert.strictEqual(state.imports, 0);
        assert.strictEqual(state.emitted, 1);
        if (change !== 'database') assert.strictEqual(JSON.stringify(tables), original);
    }
});

test("旧布局：旧楼业务原子边界：同一行两字段只提交一次，单次失败不拆分补写", async () => {
    for (const reject of [false, true]) {
        const h = harness(); h.state.chat.push({ is_user: false });
        const original = JSON.stringify(h.tables); let rowCalls = 0, cellCalls = 0;
        const update = h.api.updateRow; h.api.updateRow = async (...args) => { rowCalls++; return reject ? false : update(...args); };
        h.api.updateCell = async () => { cellCalls++; return false; };
        h.state.listener = async after => { after.stat_data.A.life = 70; after.stat_data.A.gold = 20; };
        const task = { entries: h.context.readSpCommitEntries(h.state.chat) };
        const result = h.context.applySpBusinessCorrection(plain(h.tables), task, {});
        if (reject) { await assert.rejects(result, /未提交成功/); assert.strictEqual(JSON.stringify(h.tables), original); }
        else { assert.strictEqual(await result, true); assert.deepStrictEqual(core.statDataFromTables(h.layout, h.tables).stat_data.A, { life: 70, gold: 20 }); }
        assert.strictEqual(rowCalls, 1); assert.strictEqual(cellCalls, 0); assert.strictEqual(h.state.imports, 0);
    }
});
test("旧布局：旧楼业务原子边界：跨表和数组多步修正在首次真实调用前拒绝", async () => {
    for (const array of [false, true]) {
        const h = harness({ A: { life: 100, gold: 10 }, B: { value: 1 }, Items: ['旧一', '旧二', '旧三'] });
        h.state.chat.push({ is_user: false }); const original = JSON.stringify(h.tables); let writes = 0;
        for (const name of ['updateRow', 'updateCell', 'insertRow', 'deleteRow', 'importTableAsJson']) h.api[name] = async () => { writes++; return true; };
        h.state.listener = async after => { after.stat_data.A.gold = 20; if (array) after.stat_data.Items = ['新']; else after.stat_data.B.value = 2; };
        const task = { entries: h.context.readSpCommitEntries(h.state.chat) };
        await assert.rejects(h.context.applySpBusinessCorrection(plain(h.tables), task, {}), /旧楼.*整笔修正未写入/);
        assert.strictEqual(writes, 0); assert.strictEqual(JSON.stringify(h.tables), original);
    }
});
test("旧布局：旧楼业务原子边界：规划后来源变化，单次 CRUD 也取消", async () => {
    const h = harness(); h.state.chat.push({ is_user: false }); let writes = 0, reads = 0;
    const exp = h.api.exportTableAsJson;
    h.api.exportTableAsJson = () => { if (++reads === 4) h.state.chat[0] = { is_user: false }; return exp(); };
    h.api.updateCell = async () => { writes++; return true; };
    h.state.listener = async after => { after.stat_data.A.gold = 20; };
    const task = { entries: h.context.readSpCommitEntries(h.state.chat) };
    await assert.rejects(h.context.applySpBusinessCorrection(plain(h.tables), task, {}), /来源消息已变化/);
    assert.strictEqual(writes, 0);
});
