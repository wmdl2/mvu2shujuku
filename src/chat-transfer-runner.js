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
        const first = rows.find(row => row.item);
        if (!first || host.cancelled()) return { rows, completed, cancelled: host.cancelled() };
        let prepared = await host.prepareChat(first.item, target);
        let used = false;
        try {
            for (const row of rows) {
                if (host.cancelled()) break;
                if (!row.item) continue;
                try { row.preview = tools.summary(await host.prepareImport(row.item.archive)); }
                catch (error) { if (error.chatTransferAbort) throw error; row.error = error.message; }
            }
            if (host.cancelled() || !await host.confirm(rows)) return { rows, completed, cancelled: true };
            for (const row of rows) {
                if (host.cancelled()) break;
                if (row.error || !row.preview) continue;
                host.progress('迁移聊天：' + row.name);
                let current = null;
                try {
                    if (!used && row === first) { current = prepared; used = true; }
                    else current = await host.prepareChat(row.item, target);
                    const plan = await host.prepareImport(row.item.archive);
                    if (JSON.stringify(tools.summary(plan)) !== JSON.stringify(row.preview)) throw new Error('兼容检查结果在确认后发生变化，未覆盖');
                    plan.backup = false; // Only a newly-created, empty preparation chat is modified.
                    await host.commit(plan);
                    const saved = await host.exportPrepared(current);
                    const final = tools.finish(row.item.source, saved, plan.snapshot.index, current.token);
                    await host.replaceChat(current, final);
                    await host.verify(current, plan.importedStat, final);
                    row.completed = true; row.target = current.name; completed.push(current);
                } catch (error) {
                    row.error = error.message;
                    if (current) {
                        row.target = current.name;
                        try { await host.discard(current); } catch (_) { row.retained = true; }
                    }
                    if (error.chatTransferAbort) throw error;
                }
            }
            return { rows, completed, cancelled: host.cancelled() };
        } finally {
            if (!used) await host.discard(prepared);
            if (completed.length) await host.openCompleted(completed[completed.length - 1]);
        }
    }
    return { run };
}
module.exports = createChatTransferRunner;
