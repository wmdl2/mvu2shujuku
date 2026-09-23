'use strict';

// 转换结果视图：只编辑本次模板，不调用宿主写库接口。工厂可直接内联到浏览器。
function createResultView({ document: doc, onChange = () => {}, notify = () => {}, createColumnsToggle = () => null, paramState = {} } = {}) {
    const options = [
        { key: 'updateFrequency', label: '更新频率', hint: '-1=沿用全局；0=停用该表自动更新' },
        { key: 'groupId', label: '分组编号', hint: '-1=沿用全局' },
        { key: 'contextDepth', label: '上下文层数', hint: '-1=沿用全局' },
        { key: 'batchSize', label: '批处理大小', hint: '-1=沿用全局' },
        { key: 'skipFloors', label: '跳过楼层', hint: '-1=沿用全局' },
        { key: 'sendLatestRows', label: '发送最新行数', hint: '-1=沿用全局' },
    ];
    const injectionKey = 'injectIntoWorldbook';
    function normalizeValue(value) {
        const raw = String(value == null ? '' : value).trim();
        const n = raw === '' ? -1 : Math.trunc(Number(raw));
        return Number.isFinite(n) ? Math.max(-1, n) : -1;
    }
    function getParam(sheet, key) {
        const value = sheet && sheet.updateConfig && sheet.updateConfig[key];
        return value == null ? -1 : normalizeValue(value);
    }
    function setParam(sheet, key, value) {
        if (!options.some(option => option.key === key)) return;
        if (!sheet.updateConfig || typeof sheet.updateConfig !== 'object') sheet.updateConfig = {};
        sheet.updateConfig.uiSentinel = -1;
        sheet.updateConfig[key] = normalizeValue(value);
    }
    function getInjection(sheet) {
        return !(sheet && sheet.exportConfig && sheet.exportConfig.injectIntoWorldbook === false);
    }
    function setInjection(sheet, value) {
        if (!sheet.exportConfig || typeof sheet.exportConfig !== 'object') sheet.exportConfig = {};
        sheet.exportConfig.injectIntoWorldbook = value === true;
    }
    function captureConfig(sheet) {
        const config = {};
        for (const option of options) config[option.key] = getParam(sheet, option.key);
        config.injectIntoWorldbook = getInjection(sheet);
        return config;
    }
    function applyConfig(sheet, config) {
        if (!config || typeof config !== 'object') return;
        for (const option of options) {
            if (Object.prototype.hasOwnProperty.call(config, option.key)) setParam(sheet, option.key, config[option.key]);
        }
        // 旧转换配置没有此字段时保留新模板原值；不把字符串 "false" 当作布尔设置。
        if (typeof config.injectIntoWorldbook === 'boolean') setInjection(sheet, config.injectIntoWorldbook);
    }
    function el(tag, cls, text) {
        const node = doc.createElement(tag);
        if (cls) node.className = cls;
        if (text != null) node.textContent = String(text);
        return node;
    }
    function input(type, cls, label) {
        const node = el('input', cls);
        node.type = type;
        node.setAttribute('aria-label', label);
        return node;
    }
    function select(cls, label, entries) {
        const node = el('select', cls);
        node.setAttribute('aria-label', label);
        for (const entry of entries) {
            const option = el('option', '', entry.label);
            option.value = entry.key;
            node.appendChild(option);
        }
        return node;
    }
    function button(text, cls, action) {
        const node = el('button', 'menu_button ' + (cls || ''), text);
        node.type = 'button';
        node.addEventListener('click', action);
        return node;
    }
    function details(parent, title, items, open, cls) {
        if (!items.length) return;
        const section = el('details', 'mvu2shujuku-detail ' + (cls || ''));
        section.open = open;
        section.appendChild(el('summary', '', title + '（' + items.length + '）'));
        const list = el('ul', 'mvu2shujuku-report-list');
        for (const text of items) list.appendChild(el('li', '', text));
        section.appendChild(list);
        parent.appendChild(section);
    }
    function renderReport(box, result) {
        const report = result.report || {};
        const manual = Array.isArray(report.manualReview) ? report.manualReview : [];
        const warnings = Array.isArray(report.warnings) ? report.warnings : [];
        const wrap = el('section', 'mvu2shujuku-report-summary');
        const head = el('div', 'mvu2shujuku-result-heading');
        head.appendChild(el('b', '', '转换完成 · ' + result.meta.tableCount + ' 张表'));
        head.appendChild(el('span', 'mvu2shujuku-hint', manual.length || warnings.length
            ? '以下为兼容提醒，不代表转换失败；部分行为可能与原卡不同，请按需核对。' : '未报告需额外核对的兼容事项；详细转换记录可在下方展开。'));
        wrap.appendChild(head);
        details(wrap, '兼容性待确认', manual, true, 'mvu2shujuku-attention');
        details(wrap, '注意事项', warnings.map(w => w && w.message != null ? w.message : String(w)), true, 'mvu2shujuku-attention');
        // 配置应用摘要追加在 Markdown 后面，不能因结构化呈现而丢失。
        const base = typeof report.toMarkdown === 'function' ? report.toMarkdown() : '';
        const extra = base && String(result.reportText || '').startsWith(base)
            ? result.reportText.slice(base.length).trim() : '';
        if (extra) details(wrap, '配置应用结果', [extra], true);
        details(wrap, '已自动转换', report.autoRewrites || [], false);
        details(wrap, '转换说明', report.notes || [], false);
        const full = el('details', 'mvu2shujuku-detail mvu2shujuku-full-report');
        full.open = !result.report;
        full.appendChild(el('summary', '', '完整报告（可复制，也可下载）'));
        const area = el('textarea', 'mvu2shujuku-report');
        area.value = result.reportText || '';
        area.readOnly = true;
        area.setAttribute('aria-label', '完整转换报告');
        full.appendChild(area);
        wrap.appendChild(full);
        box.appendChild(wrap);
    }
    function renderEditor(box, rows) {
        if (!rows.length) return;
        const wrap = el('section', 'mvu2shujuku-param-editor');
        wrap.appendChild(el('h4', '', '表格设置'));
        wrap.appendChild(el('p', 'mvu2shujuku-help', '修改会随下载或保存带入新模板，不自动更改已有聊天。数值 -1 表示沿用全局；更新频率 0 表示停用自动更新。'));
        const tools = el('div', 'mvu2shujuku-row mvu2shujuku-table-tools');
        const search = input('search', 'mvu2shujuku-table-search', '筛选表名');
        search.placeholder = '筛选表名…';
        tools.appendChild(search);
        const checkAll = input('checkbox', 'mvu2shujuku-select-visible', '全选当前列表');
        const checkLabel = el('label', 'mvu2shujuku-check-inline');
        checkLabel.appendChild(checkAll);
        checkLabel.appendChild(el('span', '', '全选当前列表'));
        tools.appendChild(checkLabel);
        const count = el('span', 'mvu2shujuku-selection-count mvu2shujuku-hint');
        count.setAttribute('aria-live', 'polite');
        tools.appendChild(count);
        wrap.appendChild(tools);
        const invertButton = button('反选当前列表', 'mvu2shujuku-invert-visible', () => {
            for (const row of rowEls) if (!row.node.hidden) row.check.checked = !row.check.checked;
            syncSelection();
        });
        tools.appendChild(invertButton);
        const bulk = el('div', 'mvu2shujuku-row mvu2shujuku-param-bulk');
        bulk.appendChild(el('span', 'mvu2shujuku-label', '批量设置'));
        const operation = select('mvu2shujuku-bulk-param', '批量设置项目', [...options, { key: injectionKey, label: '注入到世界书条目' }]);
        const value = input('number', 'mvu2shujuku-bulk-value', '批量设置数值');
        value.min = '-1'; value.step = '1'; value.value = '-1';
        const toggle = select('mvu2shujuku-bulk-injection', '批量世界书注入状态', [{ key: 'true', label: '开启' }, { key: 'false', label: '关闭' }]);
        toggle.hidden = true;
        operation.addEventListener('change', () => {
            value.hidden = operation.value === injectionKey;
            toggle.hidden = !value.hidden;
        });
        bulk.appendChild(operation); bulk.appendChild(value); bulk.appendChild(toggle);
        const rowEls = [];
        function apply() {
            const targets = rowEls.filter(row => row.check.checked);
            if (!targets.length) return;
            const key = operation.value;
            for (const row of targets) {
                if (key === injectionKey) {
                    setInjection(row.sheet, toggle.value === 'true');
                    row.injection.checked = getInjection(row.sheet);
                } else {
                    setParam(row.sheet, key, value.value);
                    paramState[row.uid] = key;
                    row.param.value = key;
                    row.syncParam();
                }
            }
            onChange();
            notify('已更新所选 ' + targets.length + ' 张表', 'info');
        }
        const selectedButton = button('应用到所选', 'mvu2shujuku-apply-selected', apply);
        bulk.appendChild(selectedButton);
        wrap.appendChild(bulk);
        const grid = el('div', 'mvu2shujuku-param-grid');
        function syncSelection() {
            const visible = rowEls.filter(row => !row.node.hidden);
            const selected = rowEls.filter(row => row.check.checked).length;
            count.textContent = '已选 ' + selected + ' / ' + rows.length + ' 张表 · 显示 ' + visible.length + ' 张';
            selectedButton.disabled = selected === 0;
            selectedButton.textContent = '应用到所选（' + selected + '）';
            checkAll.checked = visible.length > 0 && visible.every(row => row.check.checked);
            checkAll.indeterminate = !checkAll.checked && visible.some(row => row.check.checked);
            checkAll.disabled = visible.length === 0;
            invertButton.disabled = visible.length === 0;
        }
        checkAll.addEventListener('change', () => {
            for (const row of rowEls) if (!row.node.hidden) row.check.checked = checkAll.checked;
            syncSelection();
        });
        search.addEventListener('input', () => {
            const query = search.value.trim().toLocaleLowerCase();
            for (const row of rowEls) row.node.hidden = !row.name.toLocaleLowerCase().includes(query);
            syncSelection();
        });
        for (const { uid, sheet } of rows) {
            const name = String(sheet.name || uid);
            const node = el('div', 'mvu2shujuku-table-row');
            node.dataset.sheetUid = uid;
            const check = input('checkbox', 'mvu2shujuku-table-select', '选择 ' + name);
            check.addEventListener('change', syncSelection);
            const label = el('label', 'mvu2shujuku-param-name mvu2shujuku-check-inline');
            label.appendChild(check); label.appendChild(el('span', '', name));
            node.appendChild(label);
            const param = select('mvu2shujuku-param-select', name + '的更新参数', options);
            param.value = options.some(o => o.key === paramState[uid]) ? paramState[uid] : options[0].key;
            const number = input('number', 'mvu2shujuku-param-value', name + '的参数数值');
            number.min = '-1'; number.step = '1';
            const syncParam = () => {
                number.value = String(getParam(sheet, param.value));
                number.title = param.title = options.find(o => o.key === param.value).hint;
            };
            syncParam();
            param.addEventListener('change', () => { paramState[uid] = param.value; syncParam(); });
            // 输入过程中保留空串和负号，避免每个按键都格式化打断编辑；失焦再归一化。
            number.addEventListener('input', () => {
                if (number.value !== '' && Number.isFinite(Number(number.value))) {
                    setParam(sheet, param.value, number.value); onChange();
                }
            });
            number.addEventListener('change', () => { setParam(sheet, param.value, number.value); syncParam(); onChange(); });
            node.appendChild(param); node.appendChild(number);
            const injection = input('checkbox', 'mvu2shujuku-table-injection', name + '：注入到世界书条目');
            injection.checked = getInjection(sheet);
            injection.addEventListener('change', () => { setInjection(sheet, injection.checked); onChange(); });
            const injectionLabel = el('label', 'mvu2shujuku-injection-label mvu2shujuku-check-inline');
            injectionLabel.appendChild(injection); injectionLabel.appendChild(el('span', '', '注入世界书'));
            injectionLabel.title = '数据库中的“注入到世界书条目”开关；不影响自动填表';
            node.appendChild(injectionLabel);
            if (sheet.exportConfig && sheet.exportConfig.extraIndexEnabled === true) {
                node.appendChild(el('span', 'mvu2shujuku-row-note mvu2shujuku-hint', '此表另有额外索引，当前开关不关闭索引条目。'));
            }
            const columns = createColumnsToggle(sheet);
            if (columns) { columns.classList.add('mvu2shujuku-table-columns'); node.appendChild(columns); }
            grid.appendChild(node);
            rowEls.push({ uid, sheet, node, name, check, param, injection, syncParam });
        }
        wrap.appendChild(grid); box.appendChild(wrap); syncSelection();
    }
    return { options, normalizeValue, getParam, setParam, getInjection, setInjection, captureConfig, applyConfig, renderReport, renderEditor };
}

module.exports = createResultView;
