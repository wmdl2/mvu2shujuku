'use strict';
const { test } = require('./runner');
const assert = require('assert'), vm = require('vm');
const create = require('../src/worldbook-save');
const storageFactory = require('../src/worldbook-storage');
const clone = value => JSON.parse(JSON.stringify(value));
function card() { return { data: { name: '公开卡', extensions: {
    mvu2shujuku: { converter: 'mvu2shujuku' }, world: '公开书',
}, character_book: { name: '公开书', entries: [{ id: 0, content: '新内容', enabled: true }] } } }; }
const convertBook = book => ({ entries: Object.fromEntries(book.entries.map(e => [e.id, { content: e.content, disable: !e.enabled }])), originalData: clone(book) });
function fixture(choice, initial = {}) {
    const books = clone(initial), calls = [];
    const deps = {
        convertBook, listNames: async () => Object.keys(books), read: async name => clone(books[name]),
        write: async (name, data) => { calls.push(['write', name]); books[name] = clone(data); },
        refresh: async name => { calls.push(['refresh', name]); },
        backup: async (name, data) => { calls.push(['backup', name, clone(data)]); },
        chooseConflict: async () => { calls.push(['prompt']); return choice; },
    };
    return { deps, books, calls, saver: create(deps) };
}
const old = { entries: { 0: { content: '旧内容', disable: true } }, extensions: { scan_depth: 9 }, originalData: { name: '旧版' } };
test('世界书保存：新建并绑定，转换结果不被改写', async () => {
    const f = fixture(), input = card(), before = clone(input);
    const plan = await f.saver.prepare(input); await f.saver.commit(plan);
    assert.strictEqual(plan.action, 'create'); assert.deepStrictEqual(input, before);
    assert.deepStrictEqual(f.books['公开书'], convertBook(input.data.character_book));
    assert.deepStrictEqual(f.calls, [['write', '公开书'], ['refresh', '公开书']]);
});
test('世界书保存：内容相同复用，对象键顺序不触发覆盖', async () => {
    const desired = convertBook(card().data.character_book);
    const f = fixture(null, { '公开书': { originalData: desired.originalData, entries: desired.entries } });
    const plan = await f.saver.prepare(card()); await f.saver.commit(plan);
    assert.strictEqual(plan.action, 'reuse'); assert.deepStrictEqual(f.calls, [['refresh', '公开书']]);
});
test('世界书保存：更新默认不备份，勾选后先下载完整原书', async () => {
    for (const backup of [false, true]) {
        const f = fixture({ action: 'update', backup }, { '公开书': old });
        const plan = await f.saver.prepare(card()); await f.saver.commit(plan);
        const savedBackups = f.calls.filter(c => c[0] === 'backup');
        assert.strictEqual(savedBackups.length, backup ? 1 : 0);
        if (backup) {
            assert.deepStrictEqual(savedBackups[0][2], old);
            assert.strictEqual(f.calls[1][0], 'backup'); assert.strictEqual(f.calls[2][0], 'write');
        }
        assert.strictEqual(f.books['公开书'].entries[0].content, '新内容');
    }
});
test('世界书保存：另存唯一名称，同时改内嵌书与绑定，不备份不覆盖', async () => {
    const f = fixture({ action: 'copy', backup: true }, { '公开书': old, '公开书 (1)': old });
    const input = card(), plan = await f.saver.prepare(input); await f.saver.commit(plan);
    assert.strictEqual(plan.name, '公开书 (2)'); assert.strictEqual(plan.card.data.extensions.world, plan.name);
    assert.strictEqual(plan.card.data.character_book.name, plan.name);
    assert.strictEqual(input.data.extensions.world, '公开书'); assert.deepStrictEqual(f.books['公开书'], old);
    assert.strictEqual(f.calls.some(c => c[0] === 'backup'), false);
});
test('世界书保存：取消及无内嵌书不产生写入', async () => {
    const f = fixture({ action: 'cancel' }, { '公开书': old });
    const plan = await f.saver.prepare(card()); await f.saver.commit(plan);
    assert.strictEqual(plan.cancelled, true); assert.deepStrictEqual(f.calls, [['prompt']]);
    const empty = card(); empty.data.character_book.entries = [];
    const skipped = await f.saver.prepare(empty); await f.saver.commit(skipped);
    assert.strictEqual(skipped.action, 'skip'); assert.deepStrictEqual(f.calls, [['prompt']]);
});
test('世界书保存：确认期间旧书变化或另存目标被占用必须中止', async () => {
    for (const action of ['update', 'copy', 'reuse']) {
        const existing = action === 'reuse' ? convertBook(card().data.character_book) : old;
        const f = fixture({ action }, { '公开书': existing }), plan = await f.saver.prepare(card());
        f.books[plan.name] = { entries: { changed: {} } };
        await assert.rejects(f.saver.commit(plan), /确认期间发生变化/);
        assert.strictEqual(f.calls.some(c => c[0] === 'write'), false);
    }
});
test('世界书保存：备份失败不写入，写入失败或读回不一致不能报成功', async () => {
    const f = fixture({ action: 'update', backup: true }, { '公开书': old });
    f.deps.backup = async () => { throw new Error('下载失败'); };
    await assert.rejects(f.saver.commit(await f.saver.prepare(card())), /下载失败/);
    assert.deepStrictEqual(f.books['公开书'], old);
    f.deps.backup = async () => {}; f.deps.write = async () => { throw new Error('拒绝写入'); };
    const rejected = await f.saver.prepare(card()); await assert.rejects(f.saver.commit(rejected), /拒绝写入/);
    assert.strictEqual(rejected.writeAttempted, true); assert.strictEqual(rejected.written, undefined);
    f.deps.write = async () => {};
    const mismatch = await f.saver.prepare(card()); await assert.rejects(f.saver.commit(mismatch), /复核失败/);
    assert.strictEqual(mismatch.written, true);
});
test('世界书保存：缓存刷新失败保留实际写入状态，拒绝未标记卡和不安全名称', async () => {
    const f = fixture(); f.deps.refresh = async () => { throw new Error('刷新失败'); };
    const plan = await f.saver.prepare(card()); await assert.rejects(f.saver.commit(plan), /刷新失败/);
    assert.strictEqual(plan.written, true);
    const unmarked = card(); delete unmarked.data.extensions.mvu2shujuku;
    await assert.rejects(f.saver.prepare(unmarked), /未标记/);
    const unsafe = card(); unsafe.data.character_book.name = '../旧书';
    await assert.rejects(f.saver.prepare(unsafe), /不支持/);
});
test('世界书保存：实际内联工厂在无 Node 外部作用域中可运行', async () => {
    const factory = vm.runInNewContext('(' + create.toString() + ')');
    const f = fixture(), saver = factory(f.deps), plan = await saver.prepare(card());
    await saver.commit(plan); assert.strictEqual(f.books['公开书'].entries[0].content, '新内容');
    assert.notStrictEqual(saver.canonical(JSON.parse('{"__proto__":{"x":1}}')), saver.canonical({}));
});
test('世界书存储：检查 HTTP 状态，绕过旧缓存并同步宿主缓存事件', async () => {
    const calls = [], cache = new Map([['公开书', old]]);
    let status = 200;
    const mod = { convertCharacterBook: convertBook, worldInfoCache: cache, updateWorldInfoList: async () => calls.push('list-refresh') };
    const deps = {
        loadModule: async () => mod, getHeaders: async () => ({ 'Content-Type': 'application/json' }),
        getContext: () => ({ event_types: { WORLDINFO_UPDATED: 'updated' }, eventSource: { emit: async (...args) => calls.push(args) } }),
        download: (...args) => calls.push(args),
        fetch: async (url, request) => {
            assert.strictEqual(request.headers['Content-Type'], 'application/json'); calls.push(url);
            return { ok: status === 200, status, json: async () => url === '/api/settings/get' ? { world_names: ['公开书'] } : { entries: { 0: { content: '磁盘值' } } } };
        },
    };
    const factory = vm.runInNewContext('(' + storageFactory.toString() + ')'), storage = factory(deps);
    assert.deepStrictEqual(clone(await storage.listNames()), ['公开书']);
    const current = await storage.read('公开书'); assert.strictEqual(current.entries[0].content, '磁盘值');
    await storage.write('公开书', current); await storage.refresh('公开书', current);
    assert.strictEqual(cache.get('公开书').entries[0].content, '磁盘值');
    assert.ok(calls.some(c => Array.isArray(c) && c[0] === 'updated'));
    await storage.backup('公开书', old);
    const downloaded = calls.find(c => Array.isArray(c) && c[1] === 'application/json');
    assert.deepStrictEqual(JSON.parse(downloaded[2]), old);
    status = 503; await assert.rejects(storage.write('公开书', current), /HTTP 503/);
    await assert.rejects(storage.read('公开书'), /HTTP 503/); await assert.rejects(storage.listNames(), /HTTP 503/);
});
