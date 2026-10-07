'use strict';

// 浏览器直接内联此工厂；所有依赖由保存入口提供。
module.exports = function createWorldbookSave(deps) {
    const clone = value => JSON.parse(JSON.stringify(value));
    function canonical(value) {
        function ordered(v) {
            if (Array.isArray(v)) return v.map(ordered);
            if (!v || typeof v !== 'object') return v;
            const out = Object.create(null);
            for (const key of Object.keys(v).sort()) out[key] = ordered(v[key]);
            return out;
        }
        return JSON.stringify(ordered(value));
    }
    function promptConflict({ name }) {
        const doc = deps.document;
        return new Promise(resolve => {
            const overlay = doc.createElement('div');
            overlay.className = 'mvu2shujuku-operation-overlay mvu2shujuku-worldbook-conflict';
            // 与进度层同为 CSS 最大层级，后插入的冲突层必须能接收鼠标。
            overlay.style.zIndex = '2147483647';
            overlay.setAttribute('role', 'dialog');
            overlay.setAttribute('aria-modal', 'true');
            overlay.setAttribute('aria-label', '世界书同名冲突');
            overlay.tabIndex = -1;
            overlay.innerHTML = '<div class="mvu2shujuku-operation-box"><h3></h3><p>更新会替换此世界书的条目，并影响其他绑定它的角色。另存会保留原书，并将新卡绑定到新书。</p><label class="mvu2shujuku-worldbook-backup"><input type="checkbox" data-worldbook-backup><span>覆盖前下载旧世界书 JSON 备份</span></label><div class="mvu2shujuku-worldbook-actions"><button type="button" class="menu_button" data-worldbook-action="update">更新原世界书</button><button type="button" class="menu_button" data-worldbook-action="copy">另存新世界书</button><button type="button" class="menu_button" data-worldbook-action="cancel">取消保存</button></div></div>';
            overlay.querySelector('h3').textContent = '世界书「' + name + '」已存在，内容与本次转换不同';
            const finish = action => {
                const backup = action === 'update' && overlay.querySelector('[data-worldbook-backup]').checked;
                overlay.remove(); resolve({ action, backup });
            };
            for (const button of overlay.querySelectorAll('[data-worldbook-action]')) {
                button.addEventListener('click', () => finish(button.dataset.worldbookAction));
            }
            overlay.addEventListener('keydown', event => {
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish('cancel'); }
                if (event.key === 'Tab') {
                    const nodes = [...overlay.querySelectorAll('input,button')];
                    const index = nodes.indexOf(doc.activeElement);
                    if (event.shiftKey && index <= 0) { event.preventDefault(); nodes[nodes.length - 1].focus(); }
                    else if (!event.shiftKey && (index < 0 || index === nodes.length - 1)) { event.preventDefault(); nodes[0].focus(); }
                }
            });
            doc.body.appendChild(overlay); overlay.focus();
        });
    }
    async function readCurrent(name, names) {
        return names.includes(name) ? clone(await deps.read(name)) : null;
    }
    async function prepare(card) {
        const preparedCard = clone(card), data = preparedCard.data || preparedCard;
        const book = data.character_book;
        if (!book || !Array.isArray(book.entries) || !book.entries.length) return { card: preparedCard, action: 'skip' };
        if (data.extensions?.mvu2shujuku?.converter !== 'mvu2shujuku') throw new Error('不能同步未标记为转换产物的世界书');
        const name = String(book.name || data.extensions.world || (data.name + '世界书')).trim();
        if (!name || /[\\/:*?"<>|\x00-\x1f]/.test(name) || /[. ]$/.test(name)) throw new Error('转换世界书名称为空或含文件名不支持的字符');
        book.name = name;
        data.extensions.world = name;
        let desired = clone(await deps.convertBook(book));
        const names = await deps.listNames();
        const before = await readCurrent(name, names);
        if (before && canonical(before) === canonical(desired)) {
            return { card: preparedCard, name, action: 'reuse', before, desired };
        }
        let action = 'create', backup = false, target = name;
        if (before) {
            const choice = await (deps.chooseConflict || promptConflict)({ name });
            if (!choice || choice.action === 'cancel') return { cancelled: true };
            if (!['update', 'copy'].includes(choice.action)) throw new Error('世界书冲突选择无效');
            action = choice.action; backup = action === 'update' && choice.backup === true;
            if (action === 'copy') {
                let index = 1;
                do { target = name + ' (' + index++ + ')'; } while (names.includes(target));
                book.name = target; data.extensions.world = target;
                desired = clone(await deps.convertBook(book));
            }
        }
        return { card: preparedCard, name: target, action, backup,
            before: action === 'copy' ? null : before, desired };
    }
    async function commit(plan) {
        if (plan.cancelled || plan.action === 'skip') return plan;
        const current = await readCurrent(plan.name, await deps.listNames());
        if (canonical(current) !== canonical(plan.before)) {
            throw new Error('世界书在确认期间发生变化，请重新保存');
        }
        if (plan.action === 'reuse') {
            await deps.refresh(plan.name, current);
            return plan;
        }
        if (plan.backup) await deps.backup(plan.name, clone(current));
        plan.writeAttempted = true;
        await deps.write(plan.name, clone(plan.desired));
        plan.written = true;
        const persisted = await deps.read(plan.name);
        if (canonical(persisted) !== canonical(plan.desired)) throw new Error('世界书写入后的内容复核失败');
        await deps.refresh(plan.name, clone(persisted));
        return plan;
    }
    return { prepare, commit, canonical, promptConflict };
};
