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
    function seed(source, { character, aliases = {}, token }) {
        const header = clone(source.header), metadata = cleanObject(header.chat_metadata);
        metadata.integrity = token;
        if (object(metadata.variables)) metadata.variables = cleanObject(metadata.variables, true);
        if (typeof metadata.world_info === 'string' && Object.prototype.hasOwnProperty.call(aliases, metadata.world_info)) metadata.world_info = aliases[metadata.world_info];
        else delete metadata.world_info; // Unmapped old bindings must not override the new card's worldbook.
        metadata.mvu2shujuku_chat_transfer = { version: 1, token, status: 'preparing', history: 'latest-only' };
        header.character_name = character;
        header.chat_metadata = metadata;
        const messages = source.messages.map(row => {
            const swipe = Number(row.swipe_id || 0);
            if (!Number.isInteger(swipe) || swipe < 0) throw new Error('聊天含无效的选中分支');
            const count = Math.max(swipe + 1, Array.isArray(row.swipes) ? row.swipes.length : 1);
            return { name: row.name || character, is_user: row.is_user, is_system: row.is_system === true,
                mes: '[迁移准备中]', send_date: row.send_date, swipe_id: swipe,
                ...(Array.isArray(row.swipes) ? { swipes: Array(count).fill('[迁移准备中]'), swipe_info: clone(row.swipe_info || []) } : {}),
                variables: Array.from({ length: count }, () => ({})) };
        });
        return { header, messages };
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
    function summary(plan) {
        return { partial: !!plan.fields?.partial,
            imported: plan.fields?.imported || null, skipped: plan.fields?.skipped || [], retained: plan.fields?.retained || [],
            extras: (plan.extras?.matches || []).map(item => item.name), extraSkipped: plan.extras?.skipped || [] };
    }
    function sameSummary(a, b) { return JSON.stringify(summary(a)) === JSON.stringify(summary(b)); }
    return { parse, stringify, nativeMvu, selected, seed, finish, summary, sameSummary };
}
module.exports = createChatTransfer;
