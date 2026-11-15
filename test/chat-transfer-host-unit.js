'use strict';
const { test } = require('./runner');
const { assert } = require('./helpers');
const state = require('../src/state-transfer')();
const tools = require('../src/chat-transfer')();
const createHost = require('../src/chat-transfer-host');
const runner = require('../src/chat-transfer-runner')(tools);
const clone = value => JSON.parse(JSON.stringify(value));
function harness(options = {}) {
    const characters = [{ avatar: 'old.png', name: '旧名字' }, { avatar: 'new.png', name: '新名字' }];
    const source = value => ({ header: { user_name: '用户', character_name: '旧名字', chat_metadata: { integrity: 'source', keep: true } }, messages: [
        { name: '用户', is_user: true, mes: '用户正文' },
        { name: '旧名字', is_user: false, mes: '当前正文' + value, swipe_id: 1,
            swipes: ['旧候选', '当前正文' + value], variables: [{ stat_data: { 生命: 1 } }, { stat_data: { 生命: value }, schema: { type: 'any' }, aux: '辅助值' }] },
    ] });
    const files = { 'old.png': { 'A.jsonl': source(37), 'B.jsonl': source(81) }, 'new.png': {} };
    const original = clone(files['old.png']), calls = [], runtime = new Map();
    let characterId = 0, name = 'A', serial = 0;
    const key = () => characters[characterId].avatar + '/' + name + '.jsonl';
    const current = () => files[characters[characterId].avatar][name + '.jsonl'] || { header: { chat_metadata: {} }, messages: [] };
    const result = { meta: { savedAvatar: 'new.png' }, card: { data: { extensions: { mvu2shujuku: { convertedAt: 'new' } } } } };
    const readContext = () => ({ characters, characterId, chatId: name, chat: current().messages, chatMetadata: current().header.chat_metadata,
        name1: '用户', getRequestHeaders: () => ({}),
        async selectCharacterById(index) { characterId = index; name = (Object.keys(files[characters[index].avatar])[0] || '').replace(/\.jsonl$/, ''); },
        async openCharacterChat(next) { name = next; },
    });
    const response = data => ({ ok: true, status: 200, json: async () => data });
    const win = { FormData, Blob, setTimeout, crypto: { randomUUID: () => 'token-' + ++serial },
        async fetch(url, request) {
            const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
            calls.push({ url, avatar: body.avatar_url });
            if (url === '/api/characters/chats') return response(Object.keys(files[body.avatar_url]).map(file_name => ({ file_name })));
            if (url === '/api/chats/export') {
                const chat = files[body.avatar_url][body.file];
                if (options.switchOnRead) characterId = 1;
                return response(chat ? { result: tools.stringify(chat) } : { error: true });
            }
            if (url === '/api/chats/import') {
                assert(body.has('avatar'), '酒馆原生聊天上传使用 avatar 字段');
                assert.strictEqual(characterId, 1, '先通过正常选卡确保新目标聊天目录可用');
                const avatar = body.get('avatar_url'), seed = tools.parse(await body.get('avatar').text());
                const filename = 'copy-' + serial + '.jsonl'; files[avatar][filename] = seed;
                runtime.set(avatar + '/' + filename, { 生命: 100, 魔力: 30 });
                return response({ res: true, fileNames: [filename] });
            }
            if (url === '/api/chats/save') {
                assert.strictEqual(body.avatar_url, 'new.png', '禁止写来源聊天');
                if (!options.falseSaveAck) files[body.avatar_url][body.file_name + '.jsonl'] = { header: clone(body.chat[0]), messages: clone(body.chat.slice(1)) };
                return response({ ok: true });
            }
            if (url === '/api/chats/delete') { assert.strictEqual(body.avatar_url, 'new.png'); delete files[body.avatar_url][body.chatfile]; return response({ ok: true }); }
            throw Error('Unexpected endpoint ' + url);
        } };
    async function captureSnapshot() {
        const chat = current(), row = chat.messages.at(-1), swipe = Number(row.swipe_id || 0);
        const stat = characterId === 0 ? row.variables[swipe].stat_data : runtime.get(key());
        return { source: { character: characters[characterId].name, chat: name }, mvu: { stat_data: clone(stat), schema: { type: 'any' } },
            chat: clone(chat.messages), index: chat.messages.length - 1, tables: {}, layout: [] };
    }
    const host = createHost({ window: win, readContext, readCharacter: () => characters[characterId], tools, runner, stateTransfer: state,
        readFullCharacter: async () => ({ data: { name: '新名字', extensions: { mvu2shujuku: { convertedAt: 'new', worldbookAliases: {} } } } }),
        assertIdle() {}, captureSnapshot,
        async prepareImport(archive) {
            const fields = await state.compatibleFields(archive.stat_data, clone(runtime.get(key())), { schema: { type: 'object', properties: { 生命: { type: 'number' }, 魔力: { type: 'number' } } } });
            return { snapshot: { index: current().messages.length - 1 }, fields, importedStat: fields.stat_data, extras: { matches: [], skipped: [] } };
        },
        async commitImport(plan) {
            const row = current().messages.at(-1); runtime.set(key(), clone(plan.importedStat));
            row.TavernDB_ACU_IsolatedData = { opaque: clone(plan.importedStat) };
            row.variables[0] = { stat_data: {}, schema: { type: 'any' } };
        },
        async confirm() {
            if (options.editBeforeCancel) { current().messages.at(-1).mes = '用户修改'; return false; }
            return options.confirm !== false;
        },
    });
    const operation = { update() {}, review: fn => fn(), setCancel() {} };
    const selection = { source: { avatar: 'old.png', name: '旧名字' }, chats: [{ file_name: 'A.jsonl' }, { file_name: 'B.jsonl' }] };
    return { run: () => host.run(result, selection, operation), files, original, calls };
}
test('聊天迁移宿主：多聊天通过正式导入/保存路径写新文件，源文件不变', async () => {
    const h = harness(); const outcome = await h.run();
    assert.strictEqual(outcome.completed.length, 2);
    assert.deepStrictEqual(h.files['old.png'], h.original);
    const copies = Object.values(h.files['new.png']); assert.strictEqual(copies.length, 2);
    assert.deepStrictEqual(copies.map(chat => chat.messages.at(-1).TavernDB_ACU_IsolatedData.opaque.生命), [37, 81]);
    assert(copies.every(chat => chat.messages.at(-1).TavernDB_ACU_IsolatedData.opaque.魔力 === 30));
    assert(copies.every(chat => chat.messages.at(-1).variables[0].aux === '辅助值' && chat.messages.at(-1).swipes.length === 1));
});
test('聊天迁移宿主：保存假成功必须由文件读回拦下，不计为迁移成功', async () => {
    const h = harness({ falseSaveAck: true }); const outcome = await h.run();
    assert.strictEqual(outcome.completed.length, 0);
    assert(outcome.rows.every(row => /读回不一致/.test(row.error)));
    assert.deepStrictEqual(h.files['old.png'], h.original);
});
test('聊天迁移宿主：取消时不删除已被用户改动的准备聊天', async () => {
    const h = harness({ editBeforeCancel: true });
    await assert.rejects(h.run(), /已包含正文或其他修改/);
    assert(Object.values(h.files['new.png']).some(chat => chat.messages.at(-1).mes === '用户修改'));
    assert.deepStrictEqual(h.files['old.png'], h.original);
});
test('聊天迁移宿主：读取期间切换角色立即中止，不能写入新聊天', async () => {
    const h = harness({ switchOnRead: true });
    await assert.rejects(h.run(), /当前角色或聊天已切换/);
    assert(!h.calls.some(call => /\/api\/chats\/(?:import|save|delete)$/.test(call.url)));
    assert.deepStrictEqual(h.files['old.png'], h.original);
});
