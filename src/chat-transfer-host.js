'use strict';

function createChatTransferHost(deps) {
    const { window: win, readContext, readCharacter, stateTransfer: state, tools, runner } = deps;
    const stem = name => String(name).replace(/\.jsonl$/i, '');
    const location = () => ({ avatar: String(readCharacter()?.avatar || ''), name: String(readContext().chatId || '') });
    async function jsonPost(url, body) {
        const response = await win.fetch(url, { method: 'POST', headers: readContext().getRequestHeaders(), body: JSON.stringify(body) });
        if (!response.ok) throw new Error(url + '：HTTP ' + response.status);
        return response.json();
    }
    async function listChats(source) {
        const data = await jsonPost('/api/characters/chats', { avatar_url: source.avatar, simple: true });
        if (data?.error) return [];
        const rows = Array.isArray(data) ? data : Object.values(data || {});
        return rows.filter(row => typeof row?.file_name === 'string' && row.file_name.endsWith('.jsonl'))
            .map(row => ({ file_name: row.file_name })).sort((a, b) => b.file_name.localeCompare(a.file_name));
    }
    async function exportChat(avatar, name) {
        const data = await jsonPost('/api/chats/export', { avatar_url: avatar, is_group: false,
            file: stem(name) + '.jsonl', exportfilename: stem(name) + '.jsonl', format: 'jsonl' });
        if (typeof data.result !== 'string') throw new Error('酒馆未返回聊天 JSONL');
        return tools.parse(data.result);
    }
    function sameTranscript(a, b) {
        const signature = rows => rows.map(row => [row.mes, row.is_user, !!row.is_system,
            row.swipes?.length ? row.swipes : [row.mes], Number(row.swipe_id || 0)]);
        return state.equal(signature(a), signature(b));
    }
    async function run(result, selection, operation) {
        const avatar = result.meta?.savedAvatar;
        if (!avatar) throw new Error('请先保存并核对目标角色卡');
        const persisted = await deps.readFullCharacter({ avatar });
        const data = persisted?.data || persisted;
        if (data?.extensions?.mvu2shujuku?.convertedAt !== (result.card.data || result.card).extensions?.mvu2shujuku?.convertedAt)
            throw new Error('目标角色卡与本次转换不一致，请重新保存');
        const target = { avatar, name: data.name, aliases: data.extensions.mvu2shujuku.worldbookAliases || {} };
        let owned = location(), lastSource = null, cancelled = false;
        const initial = { ...owned }, created = new Set();
        operation.setCancel?.(() => { cancelled = true; });
        function abort(message) { const error = new Error(message); error.chatTransferAbort = true; return error; }
        function assertOwned() {
            const current = location();
            if (current.avatar !== owned.avatar || current.name !== owned.name) throw abort('当前角色或聊天已切换，已停止后续迁移');
        }
        async function select(avatar) {
            assertOwned(); deps.assertIdle();
            const context = readContext();
            if (context.groupId) throw new Error('聊天迁移当前仅支持单角色聊天，请先退出群聊');
            if (typeof context.selectCharacterById !== 'function' || typeof context.openCharacterChat !== 'function') throw new Error('宿主缺少公开的角色/聊天切换接口');
            const index = context.characters.findIndex(character => character.avatar === avatar);
            if (index < 0) throw new Error('找不到角色卡：' + avatar);
            if (owned.avatar !== avatar) {
                await context.selectCharacterById(index);
                if (location().avatar !== avatar) throw abort('选卡期间角色已改变');
                owned = location();
            }
        }
        async function open(avatar, name) {
            await select(avatar);
            await readContext().openCharacterChat(stem(name));
            if (location().avatar !== avatar || stem(location().name) !== stem(name)) throw abort('聊天打开后身份不一致');
            owned = location();
        }
        async function ready(task) {
            let deadline = Date.now() + 15000;
            const dialogOpen = () => !!win.document?.querySelector('dialog[open]');
            for (;;) {
                assertOwned();
                while (dialogOpen()) {
                    await new Promise(resolve => win.setTimeout(resolve, 250));
                    assertOwned(); deadline = Date.now() + 15000;
                }
                try { return await task(); }
                catch (error) {
                    assertOwned();
                    if (dialogOpen()) continue;
                    if (Date.now() >= deadline || !/尚未|仍在更新|未就绪/.test(error.message)) throw error;
                    await new Promise(resolve => win.setTimeout(resolve, 100));
                }
            }
        }
        const host = {
            cancelled: () => cancelled, progress: text => operation.update(text),
            async collect(source, chat) {
                assertOwned(); deps.assertIdle();
                const before = await exportChat(source.avatar, chat.file_name); assertOwned();
                const card = readContext().characters.find(character => character.avatar === source.avatar);
                const ext = card?.extensions || card?.data?.extensions || {};
                const hasDatabase = !!ext.mvu2shujuku || Object.keys(before.header.chat_metadata).some(key => /^TavernDB_ACU_/.test(key)) ||
                    before.messages.some(row => Object.keys(row).some(key => /^TavernDB_ACU_/.test(key)));
                if (!hasDatabase) {
                    const native = tools.nativeMvu(before);
                    if (owned.avatar === source.avatar && stem(owned.name) === stem(chat.file_name)) {
                        const context = readContext();
                        const live = tools.nativeMvu({ header: { chat_metadata: context.chatMetadata || context.chat_metadata || {} }, messages: context.chat });
                        if (!sameTranscript(before.messages, context.chat) || !state.equal(native.mvu.stat_data, live.mvu.stat_data))
                            throw new Error('来源聊天有未保存的修改，请保存后再迁移');
                    }
                    const archive = state.archive({ mvu: native.mvu, tables: {}, layout: [], source: {
                        character: source.name, chat: stem(chat.file_name), backend: 'mvu', message: native.index, swipe: native.swipe, scope: native.scope } });
                    return { source: tools.selected(before), archive, name: chat.file_name };
                }
                await open(source.avatar, chat.file_name); lastSource = { ...owned };
                const snapshot = await ready(deps.captureSnapshot); assertOwned();
                const after = await exportChat(source.avatar, chat.file_name); assertOwned();
                if (!state.equal(before, after) || !sameTranscript(after.messages, snapshot.chat)) throw new Error('来源聊天在读取期间发生变化，请保存后重新迁移');
                return { source: tools.selected(after), archive: state.archive(snapshot), name: chat.file_name };
            },
            async prepareChat(item) {
                assertOwned(); deps.assertIdle();
                // Native selection creates the card's chat directory when it has no chats yet.
                await select(target.avatar);
                const token = win.crypto?.randomUUID?.() || (Date.now() + '-' + Math.random().toString(36).slice(2));
                const seed = tools.seed(item.source, { character: target.name, aliases: target.aliases, token });
                const form = new win.FormData();
                form.append('avatar', new win.Blob([tools.stringify(seed)], { type: 'application/jsonl' }), 'chat.jsonl');
                form.append('file_type', 'jsonl'); form.append('avatar_url', target.avatar);
                form.append('character_name', '迁移 ' + token + ' ' + stem(item.name).slice(0, 48));
                form.append('user_name', String(readContext().name1 || seed.header.user_name || 'User'));
                const response = await win.fetch('/api/chats/import', { method: 'POST', headers: readContext().getRequestHeaders({ omitContentType: true }), body: form });
                assertOwned();
                if (!response.ok) throw new Error('新聊天创建失败：HTTP ' + response.status);
                const imported = await response.json();
                const name = imported?.fileNames?.length === 1 ? imported.fileNames[0] : '';
                if (!imported.res || typeof name !== 'string' || !/^[^/\\]+\.jsonl$/i.test(name)) throw new Error('酒馆没有返回唯一的新聊天文件名');
                const prepared = { avatar: target.avatar, name, token, length: seed.messages.length };
                created.add(prepared);
                try {
                    await open(prepared.avatar, name);
                    if (deps.prepareTarget) await ready(() => deps.prepareTarget());
                    const snapshot = await ready(deps.captureSnapshot);
                    const metadata = readContext().chatMetadata || readContext().chat_metadata || {};
                    if (snapshot.chat.length !== prepared.length || metadata.mvu2shujuku_chat_transfer?.token !== token)
                        throw new Error('准备聊天的消息或身份被其他操作改变');
                    return prepared;
                } catch (error) {
                    try { await host.discard(prepared); }
                    catch (_) { error.message += '；新准备聊天已保留：' + prepared.name; }
                    throw error;
                }
            },
            prepareImport: archive => ready(() => deps.prepareImport(archive)),
            async confirm(rows) {
                assertOwned();
                const text = ['来源角色：' + selection.source.name, '目标角色：' + target.name,
                    '将复制每楼当前选中的正文并迁入各自最新状态。其他重 roll 候选留在原聊天；旧楼状态栏不逐楼转换。'];
                for (const row of rows) {
                    text.push('\n' + row.name);
                    if (row.error) { text.push('跳过：' + row.error); continue; }
                    const summary = row.preview;
                    text.push(summary.partial ? '部分兼容，将仅导入相容字段。' : '当前状态可完整导入。');
                    if (summary.partial) {
                        text.push('导入：' + (summary.imported?.join('、') || '无'));
                        for (const skip of summary.skipped) text.push('跳过 ' + skip.path + '：' + skip.reason);
                        if (summary.retained.length) text.push('沿用目标初始值：' + summary.retained.join('、'));
                    }
                    text.push('额外表格：' + (summary.extras.join('、') || '无'));
                    for (const skip of summary.extraSkipped) text.push('跳过额外表 ' + skip.name + '：' + skip.reason);
                }
                return operation.review(() => deps.confirm('批量聊天迁移预检', text.join('\n'), '迁移兼容聊天'));
            },
            async commit(plan) { assertOwned(); await deps.commitImport(plan); assertOwned(); },
            async exportPrepared(prepared) { assertOwned(); return exportChat(prepared.avatar, prepared.name); },
            async replaceChat(prepared, final) {
                assertOwned();
                const response = await jsonPost('/api/chats/save', { avatar_url: prepared.avatar, file_name: stem(prepared.name), chat: [final.header, ...final.messages], force: false });
                assertOwned();
                if (!response.ok) throw new Error('酒馆未确认正文保存完成');
                const actual = await exportChat(prepared.avatar, prepared.name); assertOwned();
                if (!state.equal(actual, final)) throw new Error('新聊天保存后读回不一致');
            },
            async verify(prepared, expected, final) {
                await open(prepared.avatar, prepared.name);
                await ready(async () => {
                    const snapshot = await deps.captureSnapshot(); assertOwned();
                    if (!sameTranscript(snapshot.chat, final.messages)) throw new Error('新聊天重开后的正文与迁移结果不一致');
                    if (!state.equal(state.stat(snapshot.mvu.stat_data), expected)) throw new Error('新聊天重开后的数据库状态尚未与迁移结果一致');
                });
            },
            async discard(prepared) {
                if (!created.has(prepared)) throw new Error('没有权限删除非本次创建的聊天');
                assertOwned();
                const actual = await exportChat(prepared.avatar, prepared.name); assertOwned();
                if (actual.header.chat_metadata?.mvu2shujuku_chat_transfer?.token !== prepared.token ||
                    actual.messages.length !== prepared.length || actual.messages.some(row => row.mes !== '[迁移准备中]'))
                    throw new Error('新聊天已包含正文或其他修改，保留供检查');
                if (owned.avatar === prepared.avatar && stem(owned.name) === stem(prepared.name)) {
                    if (!sameTranscript(readContext().chat, actual.messages)) throw new Error('准备聊天已有未保存的修改，保留供检查');
                    const restore = initial.avatar && initial.name ? initial : lastSource;
                    if (!restore) throw new Error('无法安全关闭准备聊天');
                    await open(restore.avatar, restore.name);
                }
                const response = await win.fetch('/api/chats/delete', { method: 'POST', headers: readContext().getRequestHeaders(),
                    body: JSON.stringify({ avatar_url: prepared.avatar, chatfile: prepared.name }) });
                if (!response.ok) throw new Error('准备聊天清理失败');
                created.delete(prepared);
            },
            async openCompleted(prepared) {
                assertOwned();
                if (owned.avatar !== prepared.avatar || stem(owned.name) !== stem(prepared.name)) await open(prepared.avatar, prepared.name);
            },
        };
        return runner.run(selection, target, host);
    }
    return { listChats, run };
}
module.exports = createChatTransferHost;
