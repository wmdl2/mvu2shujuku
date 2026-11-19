'use strict';

// Hosts implement native chat I/O and the existing state-transfer transaction.
function createChatTransferRunner(tools) {
    async function run(selection, target, host) {
        const rows = [], completed = [];
        for (const chat of selection.chats) {
            if (host.cancelled()) return { rows, completed, cancelled: true };
            host.progress('读取来源聊天：' + chat.file_name);
            try { rows.push({ name: chat.file_name, item: await host.collect(selection.source, chat) }); }
            catch (error) { if (error.chatTransferAbort) throw error; rows.push({ name: chat.file_name, error: error.message }); }
        }
        if (!rows.some(row => row.item) || host.cancelled()) return { rows, completed, cancelled: host.cancelled() };
        const pending = new Map(), warnings = [], outcome = { rows, completed, warnings, cancelled: false };
        let failure;
        try {
            for (const row of rows) {
                if (host.cancelled()) break;
                if (!row.item) continue;
                try {
                    const prepared = await host.prepareChat(row.item, target);
                    pending.set(row, prepared);
                    row.preview = tools.summary(await host.prepareImport(row.item.archive, row.item.database));
                }
                catch (error) { if (error.chatTransferAbort) throw error; row.error = error.message; }
            }
            if (host.cancelled() || !await host.confirm(rows)) {
                outcome.cancelled = true;
                return outcome;
            }
            for (const row of rows) {
                if (host.cancelled()) break;
                if (row.error || !row.preview) continue;
                host.progress('迁移聊天：' + row.name);
                const current = pending.get(row);
                try {
                    await host.openPrepared(current);
                    const plan = await host.prepareImport(row.item.archive, row.item.database);
                    if (JSON.stringify(tools.summary(plan)) !== JSON.stringify(row.preview)) throw new Error('兼容检查结果在确认后发生变化，未覆盖');
                    plan.backup = false; // Only a newly-created, empty preparation chat is modified.
                    await host.commit(plan);
                    const saved = await host.exportPrepared(current, plan);
                    let final = tools.finish(row.item.source, saved, plan.snapshot.index, current.token, plan.snapshot);
                    if (host.coverImportedTables) final = await host.coverImportedTables(final, plan);
                    await host.replaceChat(current, final);
                    await host.verify(current, plan.importedStat, final);
                    row.completed = true; row.target = current.name; completed.push(current); pending.delete(row);
                } catch (error) {
                    row.error = error.message;
                    if (error.chatTransferAbort) throw error;
                }
            }
            outcome.cancelled = host.cancelled();
            return outcome;
        } catch (error) {
            failure = error;
            throw error;
        } finally {
            for (const [row, prepared] of pending) {
                try { await host.discard(prepared); }
                catch (error) {
                    row.target = prepared.name; row.retained = true;
                    warnings.push('新准备聊天已保留：' + prepared.name + '；' + error.message);
                }
            }
            if (failure && warnings.length) failure.message += '；' + warnings.join('；');
            if (!failure && completed.length) {
                try { await host.openCompleted(completed.at(-1)); }
                catch (error) { warnings.push(error.message); }
            }
        }
    }
    return { run };
}
module.exports = createChatTransferRunner;
