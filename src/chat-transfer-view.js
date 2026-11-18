'use strict';

function createChatTransferView({ document: doc, listCharacters, listChats, onRun, notify, standalone = false, currentAvatar = () => '', onSelectionChange = () => {} }) {
    let root, result, key, source = null, chats = [], selected = new Set(), loading = 0, busy = false;
    const el = (tag, text) => { const node = doc.createElement(tag); if (text != null) node.textContent = text; return node; };
    function selection() {
        if (!root || !standalone && !root.querySelector('[data-chat-enable]')?.checked) return null;
        if (!source || !selected.size) throw new Error('请先选择来源角色卡和至少一条聊天');
        const target = standalone ? listCharacters().find(character => character.avatar === root.querySelector('[data-chat-target]').value) : null;
        if (standalone && !target) throw new Error('请选择已保存的目标转换卡');
        return { source: { ...source }, ...(target ? { target: { avatar: target.avatar } } : {}), chats: chats.filter(chat => selected.has(chat.file_name)).map(chat => ({ ...chat })) };
    }
    function update() {
        if (!root) return;
        const enabled = standalone || root.querySelector('[data-chat-enable]').checked;
        root.querySelector('[data-chat-options]').hidden = !enabled;
        for (const node of root.querySelectorAll('button,input,select')) node.disabled = busy;
        const run = root.querySelector('[data-chat-run]');
        run.hidden = !standalone;
        run.disabled = busy || !enabled || !selected.size;
        root.querySelector('[data-chat-count]').textContent = '已选 ' + selected.size + ' / ' + chats.length + ' 条';
        onSelectionChange();
    }
    function renderChats(message = '') {
        const box = root.querySelector('[data-chat-list]'); box.innerHTML = '';
        if (message) box.appendChild(el('p', message));
        for (const chat of chats) {
            const label = el('label'); label.className = 'mvu2shujuku-chat-row';
            const check = el('input'); check.type = 'checkbox'; check.checked = selected.has(chat.file_name);
            check.setAttribute('aria-label', chat.file_name);
            check.addEventListener('change', () => { if (check.checked) selected.add(chat.file_name); else selected.delete(chat.file_name); update(); });
            label.appendChild(check); label.appendChild(el('span', chat.file_name.replace(/\.jsonl$/i, ''))); box.appendChild(label);
        }
        update();
    }
    async function load() {
        const generation = ++loading;
        selected = new Set(); chats = [];
        const avatar = root.querySelector('[data-chat-source]').value;
        const item = listCharacters().find(character => character.avatar === avatar);
        source = item ? { avatar: item.avatar, name: item.name || item.data?.name || item.avatar } : null;
        renderChats(source ? '正在读取聊天列表…' : '请选择来源角色卡');
        if (!source) return;
        try {
            const rows = await listChats(source);
            if (generation !== loading) return;
            chats = rows; renderChats(rows.length ? '' : '这张卡没有可迁移的聊天');
        } catch (error) { if (generation === loading) renderChats('读取失败：' + error.message); }
    }
    function populate() {
        const select = root.querySelector('[data-chat-source]'), previous = source?.avatar;
        select.innerHTML = '';
        const empty = el('option', '选择聊天来源角色卡…'); empty.value = ''; select.appendChild(empty);
        for (const character of listCharacters()) {
            if (!character?.avatar) continue;
            const option = el('option', (character.name || character.data?.name || character.avatar) + ' [' + character.avatar + ']');
            option.value = character.avatar; select.appendChild(option);
        }
        select.value = previous || result?.meta?.sourceCharacter?.avatar || (standalone ? currentAvatar() : '') || '';
        if (!select.value) select.value = '';
        if (standalone) {
            const target = root.querySelector('[data-chat-target]'), previousTarget = target.value;
            target.innerHTML = '';
            const emptyTarget = el('option', '选择已保存的目标转换卡…'); emptyTarget.value = ''; target.appendChild(emptyTarget);
            for (const character of listCharacters()) {
                if (!character?.avatar) continue;
                const option = el('option', (character.name || character.data?.name || character.avatar) + ' [' + character.avatar + ']');
                option.value = character.avatar; target.appendChild(option);
            }
            target.value = previousTarget || currentAvatar() || '';
        }
    }
    function mount(node) {
        if (!node) return;
        if (root === node) return;
        root = node;
        root.innerHTML = '<details><summary>' + (standalone ? '迁移聊天' : '同时迁移聊天（可选）') + '</summary>' +
            (standalone ? '' : '<label class="mvu2shujuku-chat-row"><input type="checkbox" data-chat-enable>保存后迁移所选聊天</label>') +
            '<div data-chat-options hidden><p class="mvu2shujuku-help">复制每楼当前选中的正文及最新状态，其他重 roll 候选留在原聊天；旧楼状态栏不逐楼转换。可从名称不同的旧卡选择聊天。</p>' +
            (standalone ? '<label>目标转换卡<select data-chat-target aria-label="目标转换卡"></select></label>' : '') +
            '<label>聊天来源角色卡<select data-chat-source aria-label="聊天来源角色卡"></select></label>' +
            '<div class="mvu2shujuku-actions"><button type="button" class="menu_button" data-chat-refresh>刷新列表</button>' +
            '<button type="button" class="menu_button" data-chat-all>全选</button><button type="button" class="menu_button" data-chat-none>全不选</button>' +
            '<span data-chat-count aria-live="polite"></span></div><div class="mvu2shujuku-chat-list" data-chat-list></div>' +
            '<button type="button" class="menu_button" data-chat-run hidden>迁移所选聊天</button></div></details>';
        if (!standalone) root.querySelector('[data-chat-enable]').addEventListener('change', () => { if (!chats.length) { populate(); load(); } update(); });
        root.querySelector('[data-chat-source]').addEventListener('change', load);
        if (standalone) root.querySelector('[data-chat-target]').addEventListener('change', update);
        root.querySelector('[data-chat-refresh]').addEventListener('click', () => { populate(); load(); });
        root.querySelector('[data-chat-all]').addEventListener('click', () => { selected = new Set(chats.map(chat => chat.file_name)); renderChats(); });
        root.querySelector('[data-chat-none]').addEventListener('click', () => { selected.clear(); renderChats(); });
        root.querySelector('[data-chat-run]').addEventListener('click', async () => {
            try { const chosen = selection(); if (chosen) await onRun(result, chosen); }
            catch (error) { notify(error.message); }
        });
        populate(); renderChats('请选择来源角色卡');
        if (standalone) root.querySelector('details').addEventListener('toggle', () => {
            if (root.querySelector('details').open && !chats.length) load();
        });
    }
    function setResult(value) {
        result = value;
        const nextKey = (value?.card?.data || value?.card)?.extensions?.mvu2shujuku?.convertedAt;
        if (!standalone && key !== nextKey) {
            key = nextKey; source = null; chats = []; selected.clear(); loading++;
            if (root) { root.querySelector('[data-chat-enable]').checked = false; populate(); renderChats('请选择来源角色卡'); }
        }
        update();
    }
    return { mount, setResult, selection,
        enabled: () => standalone || !!root?.querySelector('[data-chat-enable]')?.checked,
        complete(names) { for (const name of names) selected.delete(name); if (root) renderChats(); },
        setBusy(value) { busy = value; update(); } };
}
module.exports = createChatTransferView;
