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
        const target = { avatar, name: data.name, aliases: data.extensions.mvu2shujuku.worldbookAliases || {},
            template: deps.readTargetTemplate ? await deps.readTargetTemplate(data) : null };
        let owned = location(), cancelled = false, reader = null;
        const created = new Set();
        operation.setCancel?.(() => { cancelled = true; });
        function abort(message) { const error = new Error(message); error.chatTransferAbort = true; return error; }
        function isOwned() {
            const current = location();
            return current.avatar === owned.avatar && current.name === owned.name;
        }
        function assertOwned() {
            if (!isOwned()) throw abort('当前角色或聊天已切换，已停止后续迁移');
        }
        function isOpen(prepared) {
            const current = location();
            return current.avatar === prepared.avatar && stem(current.name) === stem(prepared.name);
        }
        function onlyPlaceholders(messages, text) {
            return messages.every(row => row.mes === text && (!Array.isArray(row.swipes) || row.swipes.every(swipe => swipe === text)));
        }
        function assertPrepared(prepared, metadata, messages) {
            const marker = metadata?.mvu2shujuku_chat_transfer;
            if (marker?.token !== prepared.token || marker.status !== 'preparing' || messages.length !== prepared.length || !onlyPlaceholders(messages, '[迁移准备中]'))
                throw new Error('新聊天已包含正文或其他修改，保留供检查');
        }
        async function refreshCharacters(avatars = [], cleaning = false) {
            const required = [...new Set([target.avatar, owned.avatar, ...avatars].filter(Boolean))];
            const removed = cleaning && reader?.deleted ? reader.avatar : null;
            const deadline = Date.now() + (deps.characterListWaitMs ?? 30000);
            let missing = required, hasRemoved = false;
            for (;;) {
                assertOwned();
                if (cancelled && !cleaning) throw abort('已取消聊天迁移');
                // Do not hand an empty/stale response to native getCharacters: it
                // clears the live list before checking whether its data is ready.
                const rows = await jsonPost('/api/characters/all', {});
                assertOwned();
                if (cancelled && !cleaning) throw abort('已取消聊天迁移');
                if (!Array.isArray(rows)) throw new Error('角色列表接口未返回有效列表，未切换聊天');
                missing = required.filter(avatar => !rows.some(character => character?.avatar === avatar));
                hasRemoved = !!removed && rows.some(character => character?.avatar === removed);
                if (!missing.length && !hasRemoved) {
                    await readContext().getCharacters(); assertOwned();
                    missing = required.filter(avatar => !readContext().characters.some(character => character?.avatar === avatar));
                    hasRemoved = !!removed && readContext().characters.some(character => character?.avatar === removed);
                    if (!missing.length && !hasRemoved) return;
                }
                if (Date.now() >= deadline) throw new Error('角色列表尚未就绪：' + (missing.length ? '仍缺少 ' + missing.join('、') : '仍包含已删除的临时读取角色 ' + removed));
                await new Promise(resolve => win.setTimeout(resolve, 250));
            }
        }
        async function findCharacter(avatar) {
            let context = readContext();
            if (!context.characters.some(character => character.avatar === avatar) && typeof context.getCharacters === 'function') {
                await refreshCharacters([avatar]);
                context = readContext();
            }
            const index = context.characters.findIndex(character => character.avatar === avatar);
            if (index < 0) throw new Error((avatar === reader?.avatar ? '找不到临时读取角色（列表刷新后仍不可用）：' : '找不到角色卡：') + avatar);
            return { context, index };
        }
        async function select(avatar, name) {
            assertOwned(); deps.assertIdle();
            let context = readContext();
            if (context.groupId) throw new Error('聊天迁移当前仅支持单角色聊天，请先退出群聊');
            if (typeof context.selectCharacterById !== 'function' || typeof context.openCharacterChat !== 'function') throw new Error('宿主缺少公开的角色/聊天切换接口');
            let index;
            ({ context, index } = await findCharacter(avatar));
            assertOwned();
            if (owned.avatar !== avatar) {
                if (!name) throw new Error('切卡前必须指定本次创建的副本');
                if (context.characters[index].shallow) {
                    if (typeof context.getOneCharacter !== 'function') throw new Error('宿主缺少完整角色读取接口');
                    await context.getOneCharacter(avatar); assertOwned();
                    ({ context, index } = await findCharacter(avatar));
                    assertOwned();
                }
                // Native select loads the card's last chat. Point it at our copy first.
                context.characters[index].chat = stem(name);
                await context.selectCharacterById(index);
                if (location().avatar !== avatar) throw abort('选卡期间角色已改变');
                owned = location();
            }
        }
        async function open(avatar, name) {
            await select(avatar, name);
            await readContext().openCharacterChat(stem(name));
            if (location().avatar !== avatar || stem(location().name) !== stem(name)) throw abort('聊天打开后身份不一致');
            owned = location();
        }
        function newToken() { return win.crypto?.randomUUID?.() || (Date.now() + '-' + Math.random().toString(36).slice(2)); }
        async function createChat(avatar, copy, token, title) {
            assertOwned();
            const name = String(title || '迁移').replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').slice(0, 45) + '-' + token + '.jsonl';
            const existing = await listChats({ avatar }); assertOwned();
            if (existing.some(row => row.file_name === name)) throw new Error('新副本文件名已存在，未覆盖');
            const saved = await jsonPost('/api/chats/save', { avatar_url: avatar, file_name: stem(name), chat: [copy.header, ...copy.messages], force: false });
            if (!saved.ok) throw new Error('宿主未确认副本创建完成');
            // The caller records the saved identity before checking the active chat again.
            return name;
        }
        async function ensureReader(source) {
            if (reader) {
                if (!reader.ready) { await refreshCharacters([reader.avatar]); reader.ready = true; }
                return reader;
            }
            const token = newToken(), form = new win.FormData();
            // No author scripts, worldbook or meaningful greeting can execute on this card.
            const card = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: source.name,
                first_mes: '[迁移读取副本]', description: '', personality: '', scenario: '', mes_example: '',
                extensions: { mvu2shujukuReader: token, tavern_helper: { scripts: [] } } } };
            form.append('avatar', new win.Blob([JSON.stringify(card)], { type: 'application/json' }), 'reader.json');
            form.append('file_type', 'json');
            const response = await win.fetch('/api/characters/import', { method: 'POST', headers: readContext().getRequestHeaders({ omitContentType: true }), body: form });
            if (!response.ok) throw new Error('临时读取角色创建失败');
            const saved = await response.json();
            if (typeof saved.file_name !== 'string' || !saved.file_name || /[/\\]/.test(saved.file_name)) throw new Error('临时读取角色身份无效');
            const readerAvatar = saved.file_name + '.png';
            if (readerAvatar === source.avatar || readerAvatar === target.avatar) throw new Error('临时读取角色身份冲突');
            reader = { avatar: readerAvatar, token, files: new Set() };
            assertOwned();
            if (typeof readContext().getCharacters !== 'function') throw new Error('宿主缺少角色列表刷新接口');
            await refreshCharacters([reader.avatar]);
            reader.ready = true;
            return reader;
        }
        async function closeOwnedChat() {
            assertOwned();
            if (!deps.closeChat || await deps.closeChat() !== true) throw new Error('无法安全关闭副本，已保留');
            owned = location();
        }
        async function cleanupReader() {
            if (!reader) return;
            const full = await deps.readFullCharacter({ avatar: reader.avatar });
            if ((full?.data || full)?.extensions?.mvu2shujukuReader !== reader.token) throw new Error('临时读取角色身份变化，已保留');
            if (location().avatar === reader.avatar) await closeOwnedChat();
            const files = await listChats(reader);
            if (files.some(file => !reader.files.has(file.file_name))) throw new Error('临时读取角色出现其他聊天，已保留');
            for (const file of files) {
                const copy = await exportChat(reader.avatar, file.file_name);
                if (copy.header.chat_metadata.mvu2shujuku_transfer_reader !== reader.token || !onlyPlaceholders(copy.messages, '[迁移读取副本]'))
                    throw new Error('临时读取副本已被修改，已保留');
            }
            if (location().avatar === reader.avatar) throw new Error('临时读取角色已重新打开，已保留');
            const response = await win.fetch('/api/characters/delete', { method: 'POST', headers: readContext().getRequestHeaders(),
                body: JSON.stringify({ avatar_url: reader.avatar, delete_chats: true }) });
            if (!response.ok) throw new Error('临时读取角色清理失败');
            reader.deleted = true;
            if (isOwned()) await refreshCharacters([], true);
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
                if (before.header.chat_metadata._acu_zero_layer_v1 || before.messages.some(row => row._acu_zero_layer_v1))
                    throw new Error('来源含数据库零层逻辑存档，当前聊天复制尚未适配；原聊天未打开或改动');
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
                const sourceCard = await deps.readFullCharacter({ avatar: source.avatar }); assertOwned();
                const isolated = await ensureReader(source);
                const copy = tools.readerCopy(before, isolated.token);
                const copyName = await createChat(isolated.avatar, copy, newToken(), '迁移读取');
                isolated.files.add(copyName);
                await open(isolated.avatar, copyName);
                operation.update('正在从隔离副本还原状态：' + chat.file_name);
                if (!deps.readSourceCopy) throw new Error('宿主缺少隔离来源读取适配');
                const snapshot = await ready(() => deps.readSourceCopy(sourceCard, before, source, chat)); assertOwned();
                const after = await exportChat(source.avatar, chat.file_name); assertOwned();
                if (!state.equal(before, after)) throw new Error('来源聊天在读取期间发生变化，请保存后重新迁移');
                return { source: tools.selected(after), archive: state.archive(snapshot), name: chat.file_name,
                    database: tools.databasePlan(snapshot.tables, target.template, snapshot.isolationKey) };
            },
            async prepareChat(item) {
                assertOwned(); deps.assertIdle();
                const token = newToken();
                const seed = tools.seed(item.source, { character: target.name, aliases: target.aliases, token, database: item.database });
                operation.update('正在创建目标聊天：' + item.name);
                const name = await createChat(target.avatar, seed, token, stem(item.name));
                const prepared = { avatar: target.avatar, name, token, length: seed.messages.length };
                created.add(prepared);
                try {
                    await open(prepared.avatar, name);
                    if (deps.prepareTarget) await ready(() => deps.prepareTarget(item.database));
                    const snapshot = await ready(deps.captureSnapshot);
                    const metadata = readContext().chatMetadata || readContext().chat_metadata || {};
                    assertPrepared(prepared, metadata, snapshot.chat);
                    return prepared;
                } catch (error) {
                    try { await host.discard(prepared); }
                    catch (_) { error.message += '；新准备聊天已保留：' + prepared.name; }
                    throw error;
                }
            },
            async openPrepared(prepared) {
                assertOwned();
                if (!isOpen(prepared)) await open(prepared.avatar, prepared.name);
                assertOwned();
                const context = readContext();
                assertPrepared(prepared, context.chatMetadata || context.chat_metadata, context.chat);
            },
            prepareImport: archive => ready(() => deps.prepareImport(archive)),
            async confirm(rows) {
                assertOwned();
                const sameName = selection.source.name === target.name;
                const label = character => character.name + (sameName ? '（' + character.avatar + '）' : '');
                const text = ['来源角色：' + label(selection.source), '目标角色：' + label(target),
                    '将复制每楼当前选中的正文并迁入各自最新状态。其他重 roll 候选留在原聊天；旧楼状态栏不逐楼转换。'];
                for (const row of rows) {
                    text.push('\n' + row.name);
                    if (row.error) { text.push('跳过：' + row.error); continue; }
                    const summary = row.preview;
                    if (row.item.database?.reason) text.push(row.item.database.reason);
                    for (const warning of summary.coverageWarnings || []) text.push('进度提醒：' + warning);
                    text.push(summary.partial ? 'MVU 状态部分兼容，将仅导入相容字段。' : 'MVU 状态可完整导入。');
                    for (const entry of summary.defaults) text.push('按目标默认值补齐　' + entry);
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
            coverImportedTables: (chat, plan) => deps.coverImportedTables ? deps.coverImportedTables(chat, plan) : chat,
            async exportPrepared(prepared, plan) {
                assertOwned();
                const readback = plan?.persistedReadback, context = readContext();
                if (readback && state.equal(readback.chat, context.chat) && state.equal(readback.metadata, context.chatMetadata || context.chat_metadata || {}))
                    return tools.parse(readback.jsonl);
                return exportChat(prepared.avatar, prepared.name);
            },
            async replaceChat(prepared, final) {
                assertOwned();
                const response = await jsonPost('/api/chats/save', { avatar_url: prepared.avatar, file_name: stem(prepared.name), chat: [final.header, ...final.messages], force: false });
                assertOwned();
                if (!response.ok) throw new Error('酒馆未确认正文保存完成');
                const actual = await exportChat(prepared.avatar, prepared.name); assertOwned();
                if (!state.equal(actual, final)) throw new Error('新聊天保存后读回不一致');
            },
            async verify(prepared, expected, final) {
                let started = Date.now();
                await open(prepared.avatar, prepared.name);
                timings.push({ stage: 'verifyOpen', durationMs: Date.now() - started });
                started = Date.now();
                await ready(async () => {
                    const snapshot = await deps.captureSnapshot(); assertOwned();
                    if (!sameTranscript(snapshot.chat, final.messages)) throw new Error('新聊天重开后的正文与迁移结果不一致');
                    if (!(deps.equalStat || state.equal)(state.stat(snapshot.mvu.stat_data), expected)) throw new Error('新聊天重开后的数据库状态尚未与迁移结果一致');
                });
                timings.push({ stage: 'verifyRead', durationMs: Date.now() - started });
            },
            async discard(prepared) {
                if (!created.has(prepared)) throw new Error('没有权限删除非本次创建的聊天');
                const actual = await exportChat(prepared.avatar, prepared.name);
                assertPrepared(prepared, actual.header.chat_metadata, actual.messages);
                if (isOpen(prepared)) {
                    if (!sameTranscript(readContext().chat, actual.messages)) throw new Error('准备聊天已有未保存的修改，保留供检查');
                    await closeOwnedChat();
                }
                if (isOpen(prepared)) throw new Error('准备聊天已重新打开，保留供检查');
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
        const timings = [];
        for (const method of ['collect', 'prepareChat', 'prepareImport', 'commit', 'exportPrepared', 'replaceChat', 'verify']) {
            const original = host[method];
            host[method] = async function (...args) {
                const started = Date.now();
                try { return await original.apply(host, args); }
                finally { timings.push({ stage: method, durationMs: Date.now() - started }); }
            };
        }
        let outcome, failure;
        try { outcome = await runner.run(selection, target, host); outcome.timings = timings; return outcome; }
        catch (error) { failure = error; throw error; }
        finally {
            try { await cleanupReader(); }
            catch (error) {
                const message = (reader?.deleted ? '临时读取角色已清理，列表刷新未完成：' : '临时读取副本已保留：') + (reader?.avatar || '') + '；' + error.message;
                if (failure) failure.message += '；' + message;
                else if (outcome) (outcome.warnings ||= []).push(message);
            }
        }
    }
    return { listChats, run };
}
module.exports = createChatTransferHost;
