'use strict';

// Chat copies use native JSONL and opaque, host-generated database carriers.
// This module neither constructs database frames nor replays author commands.
function createChatTransfer() {
    const clone = value => JSON.parse(JSON.stringify(value));
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const databaseKey = key => /^TavernDB_ACU_/.test(key);
    const mvuKeys = ['stat_data', 'schema', 'display_data', 'delta_data', 'initialized_lorebooks'];
    function cleanObject(value, stripMvu = false) {
        const result = {};
        for (const [key, item] of Object.entries(object(value) ? value : {})) {
            if (databaseKey(key) || key === 'mvu2shujuku_chat_transfer' || stripMvu && mvuKeys.includes(key)) continue;
            Object.defineProperty(result, key, { value: clone(item), enumerable: true, configurable: true, writable: true });
        }
        return result;
    }
    function parse(jsonl) {
        const lines = String(jsonl || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
        const data = lines.map((line, i) => {
            try { return JSON.parse(line); }
            catch (_) { throw new Error('聊天 JSONL 第 ' + (i + 1) + ' 行无法解析'); }
        });
        const header = data.shift();
        if (!object(header) || !['user_name', 'name', 'chat_metadata'].some(key => Object.prototype.hasOwnProperty.call(header, key))) throw new Error('聊天缺少有效的文件头');
        if (header.chat_metadata == null) header.chat_metadata = {};
        if (!object(header.chat_metadata)) throw new Error('聊天的 chat_metadata 不是对象');
        if (!data.length || data.some(message => !object(message) || typeof message.mes !== 'string' || typeof message.is_user !== 'boolean'))
            throw new Error('聊天没有可复制的完整消息');
        return { header, messages: data };
    }
    function stringify(chat) { return [chat.header, ...chat.messages].map(row => JSON.stringify(row)).join('\n') + '\n'; }
    function nativeMvu(source) {
        let latest = -1;
        for (let index = source.messages.length - 1; index >= 0; index--) {
            const row = source.messages[index];
            if (row.is_user || row.is_system) continue;
            if (latest < 0) latest = index;
            const swipe = Number(row.swipe_id || 0), data = row.variables?.[swipe];
            if (object(data?.stat_data) && data.schema !== undefined) return { mvu: clone(data), index, swipe, scope: 'message' };
        }
        const data = source.header.chat_metadata.variables;
        if (latest >= 0 && object(data?.stat_data) && data.schema !== undefined) return { mvu: clone(data), index: latest, swipe: Number(source.messages[latest].swipe_id || 0), scope: 'chat' };
        throw new Error('来源聊天没有已保存的 MVU 状态（stat_data / schema）');
    }
    function selected(source) {
        const result = clone(source);
        result.messages = result.messages.map(row => {
            const swipe = Number(row.swipe_id || 0);
            if (!Number.isInteger(swipe) || swipe < 0) throw new Error('聊天含无效的选中分支');
            if (row.variables) row.variables = [clone(row.variables[swipe] || {})];
            if (Array.isArray(row.swipes)) row.swipes = [row.mes];
            if (Array.isArray(row.swipe_info)) row.swipe_info = [clone(row.swipe_info[swipe] || {})];
            row.swipe_id = 0;
            return row;
        });
        return result;
    }
    function databasePlan(tables, template, isolationKey) {
        const keys = Object.keys(tables || {}).filter(key => key.startsWith('sheet_'));
        if (!keys.length) return { preserve: false, reason: '' };
        const targetKeys = Object.keys(template || {}).filter(key => key.startsWith('sheet_')), bindings = new Map();
        const incompatible = keys.filter(key => {
            const from = tables[key], matches = targetKeys.filter(k => template[k]?.name === from?.name);
            const targetKey = matches.length === 1 ? matches[0] : null, to = template?.[targetKey];
            if (targetKey) bindings.set(targetKey, key);
            return from?.uid !== key || !to || to.uid !== targetKey
                || JSON.stringify(from.content?.[0]) !== JSON.stringify(to.content?.[0])
                || String(from.sourceData?.ddl || '').replace(/\r\n/g, '\n').trim() !== String(to.sourceData?.ddl || '').replace(/\r\n/g, '\n').trim();
        });
        const reboundKeys = targetKeys.map(key => bindings.get(key) || key);
        if (incompatible.length || new Set(reboundKeys).size !== reboundKeys.length || typeof isolationKey !== 'string') return { preserve: false,
            reason: '来源与目标的表身份、列结构或隔离来源无法对应；仅迁移兼容数据，不继承原数据库历史及填表进度。' };
        // The host normalizes converter template keys on import. Rebind the new
        // template to unambiguous saved identities; never rewrite opaque frames.
        const rebound = {};
        for (const [key, value] of Object.entries(template)) {
            const next = bindings.get(key) || key;
            rebound[next] = clone(value);
            if (bindings.has(key)) rebound[next].uid = next;
        }
        return { preserve: true, isolationKey, template: rebound, tables: clone(tables),
            reason: '原数据库历史及已有表的填表进度随副本保留。' };
    }
    function seed(source, { character, aliases = {}, token, database }) {
        const header = clone(source.header), metadata = cleanObject(header.chat_metadata);
        if (database?.preserve) for (const key of Object.keys(header.chat_metadata).filter(databaseKey)) metadata[key] = clone(header.chat_metadata[key]);
        metadata.integrity = token;
        if (object(metadata.variables)) metadata.variables = cleanObject(metadata.variables, true);
        if (typeof metadata.world_info === 'string' && Object.prototype.hasOwnProperty.call(aliases, metadata.world_info)) metadata.world_info = aliases[metadata.world_info];
        else delete metadata.world_info; // Unmapped old bindings must not override the new card's worldbook.
        metadata.mvu2shujuku_chat_transfer = { version: 1, token, status: 'preparing', history: 'latest-only' };
        if (database?.preserve) metadata.mvu2shujuku_chat_transfer.databaseHistory = 'preserved';
        header.character_name = character;
        header.chat_metadata = metadata;
        const messages = source.messages.map(row => {
            const swipe = Number(row.swipe_id || 0);
            if (!Number.isInteger(swipe) || swipe < 0) throw new Error('聊天含无效的选中分支');
            const count = Math.max(swipe + 1, Array.isArray(row.swipes) ? row.swipes.length : 1);
            const prepared = { name: row.name || character, is_user: row.is_user, is_system: row.is_system === true,
                mes: '[迁移准备中]', send_date: row.send_date, swipe_id: swipe,
                ...(Array.isArray(row.swipes) ? { swipes: Array(count).fill('[迁移准备中]'), swipe_info: clone(row.swipe_info || []) } : {}),
                variables: Array.from({ length: count }, () => ({})) };
            if (database?.preserve) for (const key of Object.keys(row).filter(databaseKey)) prepared[key] = clone(row[key]);
            return prepared;
        });
        return { header, messages };
    }
    function readerCopy(source, token) {
        const copy = clone(source), metadata = { integrity: token, mvu2shujuku_transfer_reader: token };
        for (const [key, value] of Object.entries(source.header.chat_metadata))
            if (databaseKey(key) || key === 'variables') metadata[key] = clone(value);
        copy.header.chat_metadata = metadata;
        copy.messages = source.messages.map(row => {
            const result = { is_user: row.is_user, is_system: !!row.is_system, name: row.name,
                mes: '[迁移读取副本]', swipe_id: Number(row.swipe_id || 0), variables: clone(row.variables || []) };
            if (Array.isArray(row.swipes)) result.swipes = row.swipes.map(() => result.mes);
            for (const key of Object.keys(row).filter(databaseKey)) result[key] = clone(row[key]);
            return result;
        });
        return copy;
    }
    function finish(source, saved, index, token) {
        if (source.messages.length !== saved.messages.length || !Number.isInteger(index) || index < 0 || index >= source.messages.length)
            throw new Error('准备聊天的楼层与原聊天不一致，未恢复正文');
        const original = source.messages[index], persisted = saved.messages[index];
        const swipe = Number(original.swipe_id || 0);
        if (original.is_user || original.is_system || Number(persisted.swipe_id || 0) !== swipe)
            throw new Error('状态来源楼层或分支已改变，未恢复正文');
        const carrierKeys = Object.keys(persisted).filter(databaseKey);
        if (!carrierKeys.length || !object(persisted.variables?.[swipe])) throw new Error('数据库未生成可核对的状态载体，未恢复正文');
        const header = clone(saved.header);
        const marker = header.chat_metadata?.mvu2shujuku_chat_transfer;
        if (marker?.token !== token || marker.status !== 'preparing') throw new Error('目标聊天不属于本次迁移');
        marker.status = 'complete'; marker.stateMessage = index;
        // The current import can depend on an earlier host-created checkpoint.
        // Keep every target carrier at its original index, without interpreting frames.
        const messages = source.messages.map((row, messageIndex) => {
            const restored = cleanObject(row);
            for (const key of Object.keys(saved.messages[messageIndex]).filter(databaseKey))
                restored[key] = clone(saved.messages[messageIndex][key]);
            return restored;
        });
        const target = messages[index];
        const variables = clone(target.variables || []);
        const data = cleanObject(variables[swipe], true);
        for (const key of mvuKeys) if (Object.prototype.hasOwnProperty.call(persisted.variables[swipe], key)) data[key] = clone(persisted.variables[swipe][key]);
        variables[swipe] = data; target.variables = variables;
        return { header, messages };
    }
    function supportsCoverage(messages, isolationKey) {
        if (!Array.isArray(messages) || typeof isolationKey !== 'string') return false;
        // Inspect the current storage carrier, not the database release number.
        // Earlier legacy carriers do not disqualify a migrated V2 history.
        for (let index = messages.length - 1; index >= 0; index--) {
            if (messages[index]?.is_user) continue;
            const tag = messages[index]?.TavernDB_ACU_IsolatedData?.[isolationKey];
            if (tag == null) continue;
            const frame = tag.storageFrame;
            if (tag._acu_storage_version !== 2 || !object(frame) || frame.version !== 2 || !Array.isArray(frame.logEntries)) return false;
            if (frame.headRevision != null && typeof frame.headRevision !== 'string') return false;
            if (frame.checkpoint !== undefined && (!object(frame.checkpoint) || frame.checkpoint.kind !== 'full' || !object(frame.checkpoint.data))) return false;
            if (frame.checkpoint?.scheduleSummary !== undefined && (!object(frame.checkpoint.scheduleSummary)
                || Object.values(frame.checkpoint.scheduleSummary).some(value => !object(value)))) return false;
            if (frame.perSheetCheckpoints !== undefined && (!object(frame.perSheetCheckpoints)
                || Object.entries(frame.perSheetCheckpoints).some(([key, value]) => !object(value) || value.kind !== 'sheet_full'
                    || value.sheetKey !== key || !object(value.data)
                    || value.scheduleSummary !== undefined && !object(value.scheduleSummary)))) return false;
            return true;
        }
        return false;
    }
    // Offline adapter for the V2 wire format. Only a new copy is
    // changed; replay, scheduling and subsequent writes remain host-owned.
    function coverImportedTables(chat, index, tables, names, isolationKey) {
        if (!supportsCoverage([chat.messages[index]], isolationKey)) throw new Error('迁移楼缺少兼容的 V2 数据载体或检查点格式');
        const copy = clone(chat), row = copy.messages[index];
        const frame = row?.TavernDB_ACU_IsolatedData?.[isolationKey]?.storageFrame;
        if (!row || row.is_user || frame?.version !== 2 || !Array.isArray(frame.logEntries)) throw new Error('迁移楼缺少有效的 V2 数据载体');
        const sequences = frame.logEntries.map(entry => entry.seq);
        if (sequences.some((seq, i) => !Number.isInteger(seq) || seq < 0 || i > 0 && seq <= sequences[i - 1])) throw new Error('迁移楼的数据库日志顺序无法安全定位');
        const keys = [...new Set(names)].map(name => {
            const matches = Object.keys(tables).filter(key => key.startsWith('sheet_') && tables[key]?.name === name);
            if (matches.length !== 1) throw new Error('无法唯一定位导入覆盖表：' + name);
            return matches[0];
        });
        const aiFloor = copy.messages.slice(0, index + 1).filter(message => !message.is_user).length;
        for (const key of keys) {
            if (frame.checkpoint?.kind === 'full' && frame.checkpoint.data?.[key]) {
                frame.checkpoint.scheduleSummary ||= {};
                frame.checkpoint.scheduleSummary[key] = { ...frame.checkpoint.scheduleSummary[key], lastImportBaselineAiFloor: aiFloor };
            } else {
                frame.perSheetCheckpoints ||= {};
                const current = frame.perSheetCheckpoints[key];
                if (current && (current.kind !== 'sheet_full' || current.sheetKey !== key || !current.data)) throw new Error('现有单表检查点无效：' + key);
                const checkpoint = current || { kind: 'sheet_full', createdAt: Date.now(), reason: 'import', sheetKey: key,
                    data: clone(tables[key]), baseRevision: frame.headRevision ?? null,
                    timeline: { kind: 'sheet_rebase', activateAtMessageIndex: index, afterSeq: sequences.at(-1) || 0 } };
                checkpoint.scheduleSummary = { ...checkpoint.scheduleSummary, lastImportBaselineAiFloor: aiFloor };
                frame.perSheetCheckpoints[key] = checkpoint;
            }
        }
        const marker = copy.header.chat_metadata.mvu2shujuku_chat_transfer;
        if (marker) marker.coverage = { version: 1, aiFloor, keys };
        return copy;
    }
    function summary(plan) {
        return { partial: !!plan.fields?.partial,
            imported: plan.fields?.imported || null, skipped: plan.fields?.skipped || [], retained: plan.fields?.retained || [],
            defaults: plan.defaults || [],
            coverageWarnings: plan.coverage?.warnings || [],
            extras: (plan.extras?.matches || []).map(item => item.name), extraSkipped: plan.extras?.skipped || [] };
    }
    function sameSummary(a, b) { return JSON.stringify(summary(a)) === JSON.stringify(summary(b)); }
    return { parse, stringify, nativeMvu, selected, databasePlan, seed, readerCopy, finish, supportsCoverage, coverImportedTables, summary, sameSummary };
}
module.exports = createChatTransfer;
