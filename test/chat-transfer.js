'use strict';
const { test } = require('./runner');
const { assert, core } = require('./helpers');
const vm = require('vm');
const factory = require('../src/chat-transfer');
const makeRunner = require('../src/chat-transfer-runner');
const tools = factory();
const clone = value => JSON.parse(JSON.stringify(value));
function source() {
    return { header: { user_name: '用户', character_name: '旧名字', chat_metadata: {
        integrity: 'old', world_info: '旧书', custom: '保留', variables: { stat_data: { 旧值: 1 }, other: 2 }, TavernDB_ACU_ScopedConfig: { old: true } } },
        messages: [{ name: '用户', is_user: true, mes: '继续', extra: { custom: 1 } },
            { name: '旧名字', is_user: false, mes: '当前正文<UpdateVariable>旧命令</UpdateVariable>', swipe_id: 1,
                swipes: ['未选正文', '当前正文<UpdateVariable>旧命令</UpdateVariable>'], swipe_info: [{ date: 'old' }, { date: 'selected' }],
                variables: [{ stat_data: { 生命: 1 } }, { stat_data: { 生命: 37 }, schema: { type: 'any' }, custom: '作者辅助数据' }],
                TavernDB_ACU_IsolatedData: { old: '不带入' }, extra: { keep: true }, send_date: '原日期' }] };
}
test('聊天迁移：JSONL及所选正文完整保留，其他候选只留原聊天', () => {
    const original = source(), before = clone(original);
    const parsed = tools.parse(tools.stringify(original)), selected = tools.selected(parsed);
    assert.deepStrictEqual(original, before);
    assert.deepStrictEqual(parsed, original);
    assert.strictEqual(selected.messages[1].mes, original.messages[1].mes);
    assert.deepStrictEqual(selected.messages[1].swipes, [original.messages[1].mes]);
    assert.deepStrictEqual(selected.messages[1].variables, [original.messages[1].variables[1]]);
    assert.strictEqual(selected.messages[1].swipe_id, 0);
    assert.deepStrictEqual(selected.messages[1].extra, original.messages[1].extra);
    assert.strictEqual(tools.nativeMvu(original).mvu.stat_data.生命, 37);
    const legacy = tools.parse('{"user_name":"用户"}\n{"is_user":false,"mes":"旧聊天"}\n');
    assert.deepStrictEqual(legacy.header.chat_metadata, {});
});
test('聊天迁移：准备聊天不执行历史命令，不沿用旧表或旧状态', () => {
    const selected = tools.selected(source());
    const seed = tools.seed(selected, { character: '新名字', token: 'new', aliases: { 旧书: '新书' } });
    assert(seed.messages.every(row => row.mes === '[迁移准备中]'));
    assert(!JSON.stringify(seed.messages).includes('UpdateVariable'));
    assert(!JSON.stringify(seed).includes('TavernDB_ACU_ScopedConfig'));
    assert(!JSON.stringify(seed).includes('stat_data'));
    assert.strictEqual(seed.header.chat_metadata.integrity, 'new');
    assert.strictEqual(seed.header.chat_metadata.world_info, '新书');
    assert.strictEqual(tools.seed(selected, { character: '新名字', token: 'new' }).header.chat_metadata.world_info, undefined);
    assert.strictEqual(seed.header.chat_metadata.variables.other, 2);
    assert.strictEqual(seed.messages.length, selected.messages.length);
});
test('聊天迁移：只搬运宿主生成的数据载体，恢复正文、时间和辅助变量', () => {
    const selected = tools.selected(source());
    const seed = tools.seed(selected, { character: '新名字', token: 'new' });
    const carrier = { untouched: { opaque: [1, false, null, '不解析数据库私有内容'] } };
    seed.messages[0].TavernDB_ACU_IsolatedData = { checkpoint: '宿主生成的前置基线' };
    seed.messages[1].TavernDB_ACU_IsolatedData = carrier;
    seed.messages[1].variables[0] = { stat_data: { $脚本: '隐藏' }, schema: { type: 'object' }, initialized_lorebooks: { 新书: [] } };
    const final = tools.finish(selected, seed, 1, 'new');
    assert.strictEqual(final.messages[1].mes, selected.messages[1].mes);
    assert.strictEqual(final.messages[1].send_date, '原日期');
    assert.strictEqual(final.messages[1].variables[0].custom, '作者辅助数据');
    assert.deepStrictEqual(final.messages[1].variables[0].stat_data, { $脚本: '隐藏' });
    assert.deepStrictEqual(final.messages[1].TavernDB_ACU_IsolatedData, carrier);
    assert.deepStrictEqual(final.messages[0].TavernDB_ACU_IsolatedData, seed.messages[0].TavernDB_ACU_IsolatedData);
    assert.deepStrictEqual(final.messages[0].extra, selected.messages[0].extra);
    assert.strictEqual(final.header.character_name, '新名字');
    assert.strictEqual(final.header.chat_metadata.mvu2shujuku_chat_transfer.stateMessage, 1);
});
test('聊天迁移：无持久化载体、楼层/分支/身份变化时拒绝完成', () => {
    const selected = tools.selected(source()), seed = tools.seed(selected, { character: '新名字', token: 'new' });
    assert.throws(() => tools.finish(selected, seed, 1, 'new'), /状态载体/);
    seed.messages[1].TavernDB_ACU_IsolatedData = { opaque: true };
    assert.throws(() => tools.finish(selected, seed, 1, 'other'), /本次迁移/);
    const shorter = clone(seed); shorter.messages.pop();
    assert.throws(() => tools.finish(selected, shorter, 1, 'new'), /楼层/);
    seed.messages[1].swipe_id = 2;
    assert.throws(() => tools.finish(selected, seed, 1, 'new'), /分支/);
});
function batchHost(options = {}) {
    const calls = [], original = tools.selected(source()); let current, counter = 0, committed = 0, cancelled = false;
    const host = {
        cancelled: () => cancelled, progress() {},
        async collect(_source, chat) { calls.push('read:' + chat.file_name); return { source: original, archive: { stat_data: { 生命: chat.value } }, name: chat.file_name }; },
        async prepareChat(item) { current = { name: item.name + '-new', token: 'token' + ++counter }; calls.push('new:' + item.name); return current; },
        async prepareImport(archive) { return { snapshot: { index: 1 }, importedStat: clone(archive.stat_data), fields: null, extras: { matches: [], skipped: [] } }; },
        async confirm(rows) { calls.push('confirm'); return options.confirm !== false; },
        async commit(plan) { committed++; calls.push('commit:' + plan.importedStat.生命); assert.strictEqual(plan.backup, false); },
        async exportPrepared(prepared) { const s = tools.seed(original, { character: '新名字', token: prepared.token }); s.messages[1].TavernDB_ACU_IsolatedData = { opaque: committed }; return s; },
        async replaceChat(_prepared, final) { calls.push('body'); assert.strictEqual(final.messages[1].mes, original.messages[1].mes); },
        async verify() { calls.push('verify'); if (options.cancelAfterFirst) cancelled = true; },
        async discard(prepared) { calls.push('discard:' + prepared.name); },
        async openCompleted(prepared) { calls.push('open:' + prepared.name); },
    };
    return { host, calls };
}
const selection = { source: { avatar: 'old.png', name: '旧名字' }, chats: [{ file_name: 'A', value: 37 }, { file_name: 'B', value: 81 }] };
test('聊天迁移：多选分别预检及提交，各自建立独立的新聊天', async () => {
    const h = batchHost(); const result = await makeRunner(tools).run(selection, {}, h.host);
    assert.strictEqual(result.completed.length, 2);
    assert.deepStrictEqual(h.calls.filter(call => call.startsWith('commit:')), ['commit:37', 'commit:81']);
    assert(h.calls.indexOf('confirm') < h.calls.indexOf('commit:37'));
    assert.strictEqual(h.calls.filter(call => call.startsWith('new:')).length, 2);
});
test('聊天迁移：取消预览不提交；停止后续任务不撤销已完成聊天', async () => {
    let h = batchHost({ confirm: false });
    let result = await makeRunner(tools).run(selection, {}, h.host);
    assert(result.cancelled); assert(!h.calls.some(call => call.startsWith('commit:')));
    assert(h.calls.some(call => call.startsWith('discard:')));
    h = batchHost({ cancelAfterFirst: true }); result = await makeRunner(tools).run(selection, {}, h.host);
    assert.strictEqual(result.completed.length, 1); assert(result.cancelled);
    assert.deepStrictEqual(h.calls.filter(call => call.startsWith('commit:')), ['commit:37']);
});
test('聊天迁移：确认后兼容结果改变的聊天不写入', async () => {
    const h = batchHost(); let calls = 0;
    const original = h.host.prepareImport;
    h.host.prepareImport = async archive => { const plan = await original(archive); if (++calls > 2) plan.fields = { partial: true, imported: [], skipped: [{ path: '/生命', reason: '类型变化' }], retained: [] }; return plan; };
    const result = await makeRunner(tools).run(selection, {}, h.host);
    assert.strictEqual(result.completed.length, 0);
    assert(result.rows.every(row => /兼容检查结果/.test(row.error)));
    assert(!h.calls.some(call => call.startsWith('commit:')));
});
test('聊天迁移：核心工厂无Node闭包，扩展装配包含实际宿主/界面实现', () => {
    const inline = vm.runInNewContext('(' + factory.toString() + ')')();
    assert.strictEqual(inline.parse(tools.stringify(source())).messages.length, 2);
    const bundle = core.assembleExtension({ coreSource: require('fs').readFileSync(require.resolve('../src/mvu2shujuku'), 'utf8') })['index.js'];
    for (const name of ['CHAT_TRANSFER_FACTORY', 'CHAT_TRANSFER_RUNNER_FACTORY', 'CHAT_TRANSFER_VIEW_FACTORY', 'CHAT_TRANSFER_HOST_FACTORY']) assert(bundle.includes(name));
});
