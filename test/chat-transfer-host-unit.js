'use strict';
const { test } = require('./runner');
const { assert } = require('./helpers');
const state = require('../src/state-transfer')();
const tools = require('../src/chat-transfer')();
const createHost = require('../src/chat-transfer-host');
const runner = require('../src/chat-transfer-runner')(tools);
const clone = value => JSON.parse(JSON.stringify(value));
function harness(options = {}) {
    const sourceTables = { sheet_a: { uid: 'sheet_a', name: '纪要', content: [['row_id', '内容'], [1, '来源内容']] } };
    const characters = [{ avatar: 'old.png', name: '旧名字' }, { avatar: 'new.png', name: '新名字' }];
    if (options.sameNames) characters[1].name = characters[0].name;
    const readerAvatar = options.sameNames ? '旧名字2.png' : 'reader.png';
    const source = value => ({ header: { user_name: '用户', character_name: '旧名字', chat_metadata: { integrity: 'source', keep: true } }, messages: [
        { name: '用户', is_user: true, mes: '用户正文' },
        { name: '旧名字', is_user: false, mes: '当前正文' + value, swipe_id: 1,
            swipes: ['旧候选', '当前正文' + value], variables: [{ stat_data: { 生命: 1 } }, { stat_data: { 生命: value }, schema: { type: 'any' }, aux: '辅助值' }] },
    ] });
    const files = { 'old.png': { 'A.jsonl': source(37), 'B.jsonl': source(81) }, 'new.png': {} };
    if (options.databaseSource) for (const chat of Object.values(files['old.png'])) chat.messages[1].TavernDB_ACU_IsolatedData = { opaque: '原数据库载体' };
    if (options.logicalSource) for (const chat of Object.values(files['old.png'])) chat.messages[0]._acu_zero_layer_v1 = { version: 1 };
    let readerData, persistedReader, pendingReader, readerRefreshes = 0, listReads = 0, removedReads = 0, cancel;
    const original = clone(files['old.png']), calls = [], runtime = new Map();
    let characterId = 0, name = 'A', serial = 0;
    const key = () => characters[characterId]?.avatar + '/' + name + '.jsonl';
    const current = () => files[characters[characterId]?.avatar]?.[name + '.jsonl'] || { header: { chat_metadata: {} }, messages: [] };
    const result = { meta: { savedAvatar: 'new.png' }, card: { data: { extensions: { mvu2shujuku: { convertedAt: 'new' } } } } };
    const readContext = () => ({ characters, characterId, chatId: name, chat: current().messages, chatMetadata: current().header.chat_metadata,
        name1: '用户', getRequestHeaders: () => ({}),
        async getCharacters() {
            calls.push({ url: 'native-getCharacters' });
            if (files[readerAvatar] && (options.emptyListReads || options.staleListReads))
                assert(listReads > (options.emptyListReads || 0) + (options.staleListReads || 0), '未就绪列表不得交给宿主清空前端');
            if (pendingReader && ++readerRefreshes > (options.delayedReaderList ? 1 : 0) && !options.readerNeverListed) {
                characters.push(pendingReader); pendingReader = null;
            }
            if (!files[readerAvatar]) {
                const previous = characters[characterId]?.avatar, index = characters.findIndex(card => card.avatar === readerAvatar);
                if (index >= 0) characters.splice(index, 1);
                if (previous) characterId = characters.findIndex(card => card.avatar === previous);
                pendingReader = null;
            }
        },
        async getOneCharacter(avatar) {
            const index = characters.findIndex(card => card.avatar === avatar);
            const full = { ...characters[index], shallow: false };
            // Hydration yields to native requests, which may reorder the list.
            characters.splice(index, 1); characters.splice(1, 0, full);
        },
        async selectCharacterById(index) { characterId = index; name = (characters[index].chat || Object.keys(files[characters[index].avatar])[0] || '').replace(/\.jsonl$/, ''); },
        async openCharacterChat(next) { assert.notEqual(characters[characterId].avatar, 'old.png', '不能打开原聊天'); name = next; },
    });
    const response = data => ({ ok: true, status: 200, json: async () => data });
    const win = { FormData, Blob, setTimeout, crypto: { randomUUID: () => 'token-' + ++serial },
        async fetch(url, request) {
            const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
            calls.push({ url, avatar: body.avatar_url });
            if (url === '/api/characters/import') {
                readerData = JSON.parse(await body.get('avatar').text()).data;
                assert.equal(readerData.extensions.tavern_helper.scripts.length, 0);
                const card = { avatar: readerAvatar, ...readerData, shallow: !!options.reorderOnHydrate };
                persistedReader = card;
                if (options.delayedReaderList || options.readerNeverListed || options.emptyListReads || options.staleListReads) pendingReader = card;
                else characters.push(card);
                files[readerAvatar] = {};
                if (options.switchOnReaderImport) { characterId = 1; name = '外部聊天'; }
                return response({ file_name: readerAvatar.replace(/\.png$/, '') });
            }
            if (url === '/api/characters/all') {
                const base = characters.filter(card => card.avatar !== readerAvatar);
                if (files[readerAvatar]) {
                    listReads++;
                    if (options.switchDuringRefresh) characterId = 1;
                    if (options.cancelDuringList) cancel();
                    if (options.invalidCharacterList) return response({ error: true });
                    if (listReads <= (options.emptyListReads || 0)) return response([]);
                    if (options.readerNeverListed || listReads <= (options.emptyListReads || 0) + (options.staleListReads || 0)) return response(base);
                    return response([...base, persistedReader]);
                }
                if (++removedReads <= (options.deletedListReads || 0)) return response([...base, persistedReader]);
                return response(base);
            }
            if (url === '/api/characters/delete') { assert.equal(body.avatar_url, readerAvatar); delete files[readerAvatar]; return response({ ok: true }); }
            if (url === '/api/characters/chats') return response(Object.keys(files[body.avatar_url]).map(file_name => ({ file_name })));
            if (url === '/api/chats/export') {
                const chat = files[body.avatar_url][body.file];
                if (options.switchOnRead) characterId = 1;
                return response(chat ? { result: tools.stringify(chat) } : { error: true });
            }
            if (url === '/api/chats/import') {
                assert(body.has('avatar'), '酒馆原生聊天上传使用 avatar 字段');
                assert.strictEqual(characters[characterId].avatar, 'new.png', '先通过正常选卡确保新目标聊天目录可用');
                const avatar = body.get('avatar_url'), seed = tools.parse(await body.get('avatar').text());
                const filename = 'copy-' + serial + '.jsonl'; files[avatar][filename] = seed;
                runtime.set(avatar + '/' + filename, { 生命: 100, 魔力: 30 });
                return response({ res: true, fileNames: [filename] });
            }
            if (url === '/api/chats/save') {
                assert.notEqual(body.avatar_url, 'old.png', '禁止写来源聊天');
                const filename = body.file_name + '.jsonl', fresh = !files[body.avatar_url][filename];
                if (fresh) runtime.set(body.avatar_url + '/' + filename, {
                    生命: 100, ...(options.distinctBaselines && filename.startsWith('B-') ? {} : { 魔力: 30 }),
                });
                if (fresh || !options.falseSaveAck) files[body.avatar_url][filename] = { header: clone(body.chat[0]), messages: clone(body.chat.slice(1)) };
                if (fresh && options.switchOnPlaceholderSave) { characterId = 1; name = '外部聊天'; }
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
        characterListWaitMs: options.readerNeverListed ? 0 : undefined,
        readTargetTemplate: () => options.preserveHistory ? sourceTables : null,
        readFullCharacter: async ({ avatar }) => avatar === readerAvatar ? { data: readerData } : { data: { name: characters.find(card => card.avatar === 'new.png').name, extensions: { mvu2shujuku: { convertedAt: 'new', worldbookAliases: {} } } } },
        async closeChat() { characterId = -1; name = ''; return true; },
        async readSourceCopy(_card, saved) {
            assert.equal(characters[characterId].avatar, readerAvatar);
            assert(current().messages.every(row => row.mes === '[迁移读取副本]'));
            return { mvu: tools.nativeMvu(saved).mvu, tables: options.preserveHistory ? sourceTables : {}, layout: [], isolationKey: '' };
        },
        async prepareTarget(database) {
            if (options.preserveHistory) {
                assert.equal(database.preserve, true);
                assert.deepStrictEqual(current().messages[1].TavernDB_ACU_IsolatedData, { opaque: '原数据库载体' });
                calls.push({ url: 'preserved-history' });
            }
        },
        assertIdle() {}, captureSnapshot,
        async prepareImport(archive) {
            const fields = await state.compatibleFields(archive.stat_data, clone(runtime.get(key())), { schema: { type: 'object', properties: { 生命: { type: 'number' }, 魔力: { type: 'number' } } } });
            return { snapshot: { index: current().messages.length - 1 }, fields, importedStat: fields.stat_data, extras: { matches: [], skipped: [] } };
        },
        async commitImport(plan) {
            const row = current().messages.at(-1); runtime.set(key(), clone(plan.importedStat));
            row.TavernDB_ACU_IsolatedData = { opaque: clone(plan.importedStat) };
            row.variables[0] = { stat_data: {}, schema: { type: 'any' } };
            if (options.persistedReadback) plan.persistedReadback = { jsonl: tools.stringify(current()), chat: clone(current().messages), metadata: clone(current().header.chat_metadata) };
            if (options.callbackAfterReadback) current().header.chat_metadata.after_notify = true;
        },
        async confirm() {
            if (options.editBeforeCancel) { current().messages.at(-1).swipes.push('用户修改'); return false; }
            return options.confirm !== false;
        },
    });
    const operation = { update() {}, review: fn => fn(), setCancel(fn) { cancel = fn; } };
    const selection = { source: { avatar: 'old.png', name: '旧名字' }, chats: [{ file_name: 'A.jsonl' }, { file_name: 'B.jsonl' }] };
    return { run: () => host.run(result, selection, operation), files, original, calls, activeChat: () => name };
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
test('聊天迁移宿主：各目标副本初始字段不同时分别预检与导入', async () => {
    const h = harness({ distinctBaselines: true }); const outcome = await h.run();
    assert.equal(outcome.completed.length, 2);
    assert.deepStrictEqual(outcome.rows.map(row => row.preview.retained), [['/魔力'], []]);
    assert.deepStrictEqual(outcome.rows.map(row => row.preview.partial), [true, false]);
    assert.deepStrictEqual(Object.values(h.files['new.png']).map(chat => chat.messages.at(-1).TavernDB_ACU_IsolatedData.opaque), [
        { 生命: 37, 魔力: 30 }, { 生命: 81 },
    ]);
    assert.deepStrictEqual(h.files['old.png'], h.original);
});
test('聊天迁移宿主：取消时不删除已被用户改动的准备聊天', async () => {
    const h = harness({ editBeforeCancel: true });
    const outcome = await h.run();
    assert(outcome.cancelled);
    assert.equal(outcome.completed.length, 0);
    assert.equal(outcome.rows.filter(row => row.retained).length, 1);
    assert(outcome.warnings.some(message => /已包含正文或其他修改/.test(message)));
    const copies = Object.values(h.files['new.png']);
    assert.equal(copies.length, 1);
    assert(copies[0].messages.at(-1).swipes.includes('用户修改'));
    assert.deepStrictEqual(h.files['old.png'], h.original);
});
test('聊天迁移宿主：占位保存返回时已切换聊天，只清理本次占位文件', async () => {
    const h = harness({ switchOnPlaceholderSave: true });
    await assert.rejects(h.run(), /当前角色或聊天已切换/);
    assert.equal(h.activeChat(), '外部聊天');
    assert.equal(h.calls.filter(call => call.url === '/api/chats/delete').length, 1);
    assert.equal(Object.keys(h.files['new.png']).length, 0);
    assert.deepStrictEqual(h.files['old.png'], h.original);
});
test('聊天迁移宿主：读取角色导入返回时已切换聊天，只清理本次读取角色', async () => {
    const h = harness({ databaseSource: true, switchOnReaderImport: true });
    await assert.rejects(h.run(), /当前角色或聊天已切换/);
    assert.equal(h.activeChat(), '外部聊天');
    assert(h.calls.some(call => call.url === '/api/characters/delete'));
    assert(!h.calls.some(call => call.url === 'native-getCharacters'));
    assert(!h.files['reader.png']);
    assert.deepStrictEqual(h.files['old.png'], h.original);
});
test('聊天迁移宿主：读取期间切换角色立即中止，不能写入新聊天', async () => {
    const h = harness({ switchOnRead: true });
    await assert.rejects(h.run(), /当前角色或聊天已切换/);
    assert(!h.calls.some(call => /\/api\/chats\/(?:import|save|delete)$/.test(call.url)));
    assert.deepStrictEqual(h.files['old.png'], h.original);
});
test('聊天迁移宿主：数据库来源只打开无作者脚本的副本，清理不返回原聊天', async () => {
    const h = harness({ databaseSource: true }); const outcome = await h.run();
    assert.equal(outcome.completed.length, 2);
    assert.deepStrictEqual(h.files['old.png'], h.original);
    assert(!h.files['reader.png']);
    assert(!h.calls.some(call => /\/api\/chats\/(save|delete)$/.test(call.url) && call.avatar === 'old.png'));
});
test('聊天迁移宿主：同名角色的临时后缀身份在列表补刷新后恢复，浅加载重排不误选', async () => {
    const h = harness({ databaseSource: true, sameNames: true, delayedReaderList: true, reorderOnHydrate: true });
    const outcome = await h.run();
    assert.equal(outcome.completed.length, 2);
    assert.deepStrictEqual(h.files['old.png'], h.original);
    assert(!h.files['旧名字2.png']);
});
test('聊天迁移宿主：列表补刷新仍缺少临时角色时明确停止，不按同名代选', async () => {
    const h = harness({ databaseSource: true, sameNames: true, readerNeverListed: true });
    const outcome = await h.run();
    assert.equal(outcome.completed.length, 0);
    assert(outcome.rows.every(row => /角色列表尚未就绪/.test(row.error)));
    assert.deepStrictEqual(h.files['old.png'], h.original);
    assert.equal(Object.keys(h.files['new.png']).length, 0);
});
test('聊天迁移宿主：补刷新期间用户切换角色仍中止，不能继续导入', async () => {
    const h = harness({ databaseSource: true, readerNeverListed: true, switchDuringRefresh: true });
    await assert.rejects(h.run(), /当前角色或聊天已切换/);
    assert.deepStrictEqual(h.files['old.png'], h.original);
    assert.equal(Object.keys(h.files['new.png']).length, 0);
});
test('聊天迁移宿主：空占位与旧列表就绪后才交给原生刷新，不识别加速插件', async () => {
    const h = harness({ databaseSource: true, emptyListReads: 1, staleListReads: 1 });
    const outcome = await h.run();
    assert.equal(outcome.completed.length, 2);
    assert.deepStrictEqual(h.files['old.png'], h.original);
    assert(h.calls.filter(call => call.url === '/api/characters/all').length >= 4);
});
test('聊天迁移宿主：清理后旧列表仍含临时角色时等待真实删除生效', async () => {
    const h = harness({ databaseSource: true, deletedListReads: 2 });
    const outcome = await h.run();
    assert.equal(outcome.completed.length, 2);
    assert(!outcome.warnings?.length);
    assert(!h.files['reader.png']);
    assert.deepStrictEqual(h.files['old.png'], h.original);
});
test('聊天迁移宿主：列表协议错误直接拒绝，不清空当前列表或写目标聊天', async () => {
    const h = harness({ databaseSource: true, invalidCharacterList: true });
    const outcome = await h.run();
    assert.equal(outcome.completed.length, 0);
    assert(outcome.rows.every(row => /未返回有效列表/.test(row.error)));
    assert.deepStrictEqual(h.files['old.png'], h.original);
    assert.equal(Object.keys(h.files['new.png']).length, 0);
});
test('聊天迁移宿主：等待列表期间取消仍清理本次角色，不写新目标', async () => {
    const h = harness({ databaseSource: true, emptyListReads: 2, cancelDuringList: true });
    await assert.rejects(h.run(), /已取消聊天迁移/);
    assert(!h.files['reader.png']);
    assert.deepStrictEqual(h.files['old.png'], h.original);
    assert.equal(Object.keys(h.files['new.png']).length, 0);
});
test('聊天迁移宿主：相容来源在准备目标前已复制原载体，不依赖新进度接口', async () => {
    const h = harness({ databaseSource: true, preserveHistory: true });
    const outcome = await h.run();
    assert.equal(outcome.completed.length, 2);
    assert.equal(h.calls.filter(call => call.url === 'preserved-history').length, 2);
    assert.deepStrictEqual(h.files['old.png'], h.original);
});
test('聊天迁移宿主：未适配的逻辑楼层存档在创建副本前拒绝，不猜物理楼号', async () => {
    const h = harness({ logicalSource: true }), outcome = await h.run();
    assert.equal(outcome.completed.length, 0);
    assert(outcome.rows.every(row => /零层/.test(row.error)));
    assert.deepStrictEqual(h.files['old.png'], h.original);
    assert(!h.calls.some(call => /\/api\/chats\/(save|delete)$/.test(call.url)));
});
test('聊天迁移宿主：复用已确认落盘读回，回调改变状态后必须重新读取', async () => {
    const baseline = harness(); await baseline.run();
    const cached = harness({ persistedReadback: true }); await cached.run();
    const count = h => h.calls.filter(call => call.url === '/api/chats/export').length;
    assert.equal(count(baseline) - count(cached), 2, '每条聊天减少一次完整导出');
    const changed = harness({ persistedReadback: true, callbackAfterReadback: true });
    const outcome = await changed.run(); assert.equal(outcome.completed.length, 2);
    assert.equal(count(changed), count(baseline));
    assert(Object.values(changed.files['new.png']).every(chat => chat.header.chat_metadata.after_notify));
});
