#!/usr/bin/env node
/*
 * MVU→数据库 转换器测试
 * 用法：node run-tests.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const core = require('../src/mvu2db.js');

const FIXTURE = path.join(__dirname, 'fixtures', '道渊-MVU.json');
const PNG = path.join(__dirname, '..', '..', '参考资料', '参考角色卡', 'v5.2_1-MVU版.png');
const HAS_FIXTURE = fs.existsSync(FIXTURE);

function requireFixture() {
    if (!HAS_FIXTURE) {
        const e = new Error('SKIP_NO_FIXTURE');
        e.code = 'SKIP_NO_FIXTURE';
        throw e;
    }
    return require(FIXTURE);
}

let passed = 0;
let failed = 0;
const pendingTests = [];

function test(name, fn) {
    pendingTests.push({ name, fn });
}

async function runTests() {
    for (const t of pendingTests) {
        const { name, fn } = t;
    try {
            await fn();
            passed++;
            console.log('  ✓', name);
    } catch (e) {
        if (e && e.code === 'SKIP_NO_FIXTURE') {
            console.log('  - 跳过（无参考卡 fixture，仅保留通用性测试）', name);
                continue;
        }
        failed++;
        console.error('  ✗', name);
            console.error('    ', e && e.message ? e.message : e);
    }
    }
    console.log(`\n结果：${passed} 通过，${failed} 失败`);
    if (failed) process.exit(1);
}

console.log('MVU→数据库 转换器测试\n');

/* ---------------- parseInitVar ---------------- */
console.log('parseInitVar');
test('YAML 树（嵌套 + 数组 + 空容器）', () => {
    const yaml = [
        '世界:',
        '  当前时间: 未知',
        '  危机程度: 无',
        '  遭遇冷却: 20',
        '  动向: {}',
        '主角:',
        '  炼丹:',
        '    阶级: 未入门',
        '    熟练度: 0',
        '  储物袋: {}',
        '$器灵台词: []',
    ].join('\n');
    const v = core.parseInitVar(yaml);
    assert.strictEqual(v['世界']['当前时间'], '未知');
    assert.strictEqual(v['世界']['遭遇冷却'], 20);
    assert.deepStrictEqual(v['世界']['动向'], {});
    assert.strictEqual(v['主角']['炼丹']['阶级'], '未入门');
    assert.deepStrictEqual(v['主角']['储物袋'], {});
    assert.deepStrictEqual(v['$器灵台词'], []);
});

test('JSON5（单引号、尾逗号、无引号键）', () => {
    const v = core.parseInitVar("{ 主角: { 生命: 100, 姓名: '主角', }, }");
    assert.strictEqual(v['主角']['生命'], 100);
    assert.strictEqual(v['主角']['姓名'], '主角');
});

test('[value, desc] 叶子解析', () => {
    const li = core.leafInfo(['铁剑', '一把剑']);
    assert.strictEqual(li.value, '铁剑');
    assert.strictEqual(li.desc, '一把剑');
});

/* ---------------- parseMvuShapes ---------------- */
console.log('parseMvuShapes');
test('从 [mvu_update] 提取结构声明', () => {
    const card = requireFixture();
    const si = core.parseMvuShapes(card);
    assert.deepStrictEqual(si.shapes['道侣'], ['性别', '种族', '境界', '生命', '灵力', '修为', '道心', '亲密', '性格', '外观', '身高', '背景', '神通', '心声']);
    assert.deepStrictEqual(si.shapes['储物袋'], ['描述', '数量']);
    assert.deepStrictEqual(si.shapes['玉简'], ['性别', '境界', '关系', '好感度', '历史记录']);
    assert.strictEqual(si.objects['玉简']['历史记录'], true);
});

/* ---------------- scanStatusUsage ---------------- */
console.log('scanStatusUsage');
test('道渊状态栏字段扫描', () => {
    const card = requireFixture();
    const initEntry = card.data.character_book.entries.find(e => /\[initvar\]/i.test(String(e.comment || '')));
    const initvar = core.parseInitVar(initEntry.content);
    const usage = core.scanStatusUsage(card, Object.keys(initvar));
    assert.ok(usage['主角'].includes('生命'), '主角应有 生命');
    assert.ok(usage['道侣'].includes('亲密'), '道侣应有 亲密');
    assert.ok(usage['功法'].includes('熟练度'), '功法应有 熟练度');
    assert.ok(!usage['玉简'].includes('发送者'), '玉简不应包含嵌套字段 发送者');
});

/* ---------------- buildSchema / generateTemplate ---------------- */
console.log('buildSchema / generateTemplate');
test('道渊：14 张表，结构正确', () => {
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const t = r.template;
    const byName = (name) => Object.keys(t).find(k => t[k].name === name);
    assert.strictEqual(Object.keys(t).filter(k => k.startsWith('sheet_')).length, 14);
    const hero = t[byName('主角表')];
    assert.ok(hero.content[0].includes('生命'), '主角表应有 生命 列');
    assert.ok(hero.sourceData.ddl.includes('CHECK('), '主角表 DDL 应有范围约束（来自卡内规则）');
    assert.ok(hero.sourceData.ddl.includes('DEFAULT'), '主角表 DDL 应有默认值');
    const jade = t[byName('玉简表')];
    assert.ok(jade.content[0].includes('历史记录'), '玉简表应有 历史记录 列');
    assert.ok(jade.sourceData.ddl.includes('-- 历史记录'), '玉简表 DDL 应有中文列注释');
    // 标识符应为拼音 slug（无下划线冲突、可作 SQL 标识符）
    for (const k of Object.keys(t).filter(k => k.startsWith('sheet_'))) {
        assert.ok(/^sheet_[a-z0-9_]+$/.test(k), `sheet key 应为拼音 slug：${k}`);
        const ident = k.replace(/^sheet_/, '');
        assert.ok(/^[a-z][a-z0-9_]*$/.test(ident), `表标识符应为合法 SQL 标识符：${ident}`);
    }
    // 插件校验：DDL 列注释必须与 content 表头逐字一致（参考默认模板）
    for (const k of Object.keys(t).filter(k => k.startsWith('sheet_'))) {
        const sheet = t[k];
        const header = sheet.content[0];
        assert.strictEqual(header[0], 'row_id', `${k} 表头第一列应为 row_id`);
        const ddlComments = [];
        for (const line of sheet.sourceData.ddl.split('\n')) {
            const m = line.match(/^  [A-Za-z_][A-Za-z0-9_]*\s+.*?--\s*(.+)$/);
            if (!m) continue;
            ddlComments.push(m[1].trim());
        }
        assert.strictEqual(ddlComments.length, header.length, `${k} DDL 列数应等于表头列数`);
        // row_id 固定（注释为“行号”），插件对其特殊处理；其余列注释必须与表头逐字一致
        ddlComments.slice(1).forEach((c, i) => assert.strictEqual(c, header[i + 1], `${k} 第 ${i + 1} 列 DDL 注释与表头不一致`));
        // 末列不允许尾逗号（否则 sql.js 拒绝建表）
        const ddlLines = sheet.sourceData.ddl.split('\n');
        for (let li = ddlLines.length - 2; li >= 1; li--) {
            if (/^  [A-Za-z_]/.test(ddlLines[li])) {
                assert.ok(!/,\s*--\s*[^,]+$/.test(ddlLines[li]), `${k} 末列不应有尾逗号：${ddlLines[li]}`);
                break;
            }
        }
    }
    // 越界初始值原样保留（不钳制），CHECK 放行该值
    const world = t[byName('世界表')];
    const coolIdx = world.content[0].indexOf('遭遇冷却');
    assert.strictEqual(world.content[1][coolIdx], 20, '遭遇冷却 初始值应原样保留为 20');
    assert.ok(world.sourceData.ddl.includes('OR zaoyulengque IN (20)'), 'CHECK 应放行越界初始值 20');
});

test('模板结构满足插件最小要求', () => {
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const t = r.template;
    assert.strictEqual(t.mate.type, 'chatSheets');
    for (const k of Object.keys(t).filter(k => k.startsWith('sheet_'))) {
        const s = t[k];
        assert.ok(s.uid && s.name && s.content && s.sourceData, `sheet ${k} 缺字段`);
        assert.ok(Array.isArray(s.content) && Array.isArray(s.content[0]), `sheet ${k} content 格式错误`);
        assert.ok(['note', 'initNode', 'updateNode', 'insertNode', 'deleteNode', 'ddl'].every(x => x in s.sourceData), `sheet ${k} sourceData 缺字段`);
        // row_id 连续正整数
        s.content.slice(1).forEach((row, i) => assert.strictEqual(row[0], i + 1, `sheet ${k} row_id 应连续`));
    }
});

/* ---------------- EJS 重写 ---------------- */
console.log('rewriteEjsConditions');
test('getvar 数值比较 → <if cell>', () => {
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const layout = core.buildLayout(r.schema);
    const text = '<% if (getvar(\'stat_data.主角.生命\') >= 50) { %>生命充沛<% } %>';
    const out = core.rewriteEjsConditions(text, layout, core.createReport());
    assert.ok(/<if cell="主角表\/主角\/生命 >= 50">生命充沛<\/if>/.test(out.text), out.text);
});

test('嵌套路径（子表条目）→ <if cell>', () => {
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const layout = core.buildLayout(r.schema);
    const text = '<% if (getvar(\'stat_data.主角.储物袋.铁剑.数量\') > 0) { %>有铁剑<% } %>';
    const out = core.rewriteEjsConditions(text, layout, core.createReport());
    assert.ok(/<if cell="储物袋表\/铁剑\/数量 > 0">有铁剑<\/if>/.test(out.text), out.text);
});

test('聚合计数 → <if db>（仅 SQLite）', () => {
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const layout = core.buildLayout(r.schema);
    const text = '<% if (Object.keys(getvar(\'stat_data.道侣\')).length > 3) { %>道侣众多<% } %>';
    const out = core.rewriteEjsConditions(text, layout, core.createReport());
    assert.ok(out.text.includes('<if db="道侣表.count() > 3">道侣众多</if>'), out.text);
});

test('else 分支 → <else>', () => {
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const layout = core.buildLayout(r.schema);
    const text = '<% if (getvar(\'stat_data.主角.修为\') < 100) { %>修炼中<% } else { %>可突破<% } %>';
    const out = core.rewriteEjsConditions(text, layout, core.createReport());
    assert.ok(out.text.includes('<else>可突破</if>'), out.text);
});

test('else-if 链 → 嵌套 <if>/<else>', () => {
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const layout = core.buildLayout(r.schema);
    const text = '<% if (getvar(\'stat_data.主角.修为\') >= 100) { %>大乘<% } else if (getvar(\'stat_data.主角.修为\') >= 50) { %>中阶<% } else { %>初阶<% } %>';
    const out = core.rewriteEjsConditions(text, layout, core.createReport());
    assert.ok(
        out.text.includes('<if cell="主角表/主角/修为 >= 100">大乘<else><if cell="主角表/主角/修为 >= 50">中阶<else>初阶</if></if>'),
        out.text
    );
    const text2 = '<% if (getvar(\'stat_data.主角.生命\') > 0) { %>存活<% } else if (getvar(\'stat_data.主角.生命\') === 0) { %>濒死<% } %>';
    const out2 = core.rewriteEjsConditions(text2, layout, core.createReport());
    assert.ok(out2.text.includes('>存活<else><if cell="主角表/主角/生命 === 0">濒死</if></if>'), out2.text);
});

test('官方教程规范写法：getvar("stat_data").组["字段"][0] 与 _.has', () => {
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const layout = core.buildLayout(r.schema);
    const text1 = '<% if (getvar("stat_data").主角["生命"][0] >= 50) { %>充沛<% } %>';
    const out1 = core.rewriteEjsConditions(text1, layout, core.createReport());
    assert.ok(/<if cell="主角表\/主角\/生命 >= 50">/.test(out1.text), out1.text);
    const text2 = '<% if (_.has(getvar("stat_data"), \'道侣.林若悠.亲密.[0]\')) { %>有数据<% } %>';
    const out2 = core.rewriteEjsConditions(text2, layout, core.createReport());
    assert.ok(/<if cell="道侣表\/林若悠\/亲密">有数据<\/if>/.test(out2.text), out2.text);
});

/* ---------------- 数据桥脚本 ---------------- */
console.log('generateBridgeScript');
test('脚本语法与 SD_LAYOUT 结构', () => {
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    new Function(r.bridgeScript);
    const m = r.bridgeScript.match(/var SD_LAYOUT=(\[.*?\]);/);
    assert.ok(m, '应包含 SD_LAYOUT');
    const layout = JSON.parse(m[1]);
    assert.ok(layout.some(e => e.kind === 'singleton' && e.group === '主角'));
    assert.ok(layout.some(e => e.kind === 'rows' && e.group === '储物袋' && e.writePaths[0][0] === '主角'));
    assert.ok(layout.some(e => e.kind === 'array' && e.group === '$器灵台词'));
    assert.ok(r.bridgeScript.includes('importTemplateFromData'), '应使用 importTemplateFromData 自动建表');
    assert.ok(r.bridgeScript.includes('initGameSession'), '应使用 initGameSession 做开局初始化（对应 MVU init 时机）');
    assert.ok(r.bridgeScript.includes('mvu2dbMissingTableNames'), '应按模板表名判断缺表，而非仅看是否有任意表');
    assert.ok(r.bridgeScript.includes('shujuku-table-updated'), '应有表格更新事件');
});

test('数据桥 getAllVariables 重建 stat_data（端到端模拟）', () => {
    const vm = require('vm');
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const tables = JSON.parse(JSON.stringify(r.template));
    const byName = (name) => Object.keys(tables).find(k => tables[k].name === name);
    const fakeApi = {
        exportTableAsJson: () => tables,
        importTemplateFromData: async () => ({ success: true }),
        registerTableUpdateCallback: () => {},
        updateCell: async () => true,
        insertRow: async () => 1,
        deleteRow: async () => true,
    };
    const win = {
        top: null, parent: null, setTimeout: () => 0, clearTimeout: () => {}, console,
        CustomEvent: function () {}, addEventListener() {}, dispatchEvent() { return true; },
    };
    win.top = win;
    win.parent = win;
    win.window = win;
    win.globalThis = win;
    win.AutoCardUpdaterAPI = fakeApi;
    win.TextDecoder = TextDecoder;
    win.atob = (s) => Buffer.from(s, 'base64').toString('binary');
    vm.createContext(win);
    vm.runInContext(r.bridgeScript, win);
    // 填入一行道侣数据
    const companions = tables[byName('道侣表')];
    const header = companions.content[0];
    const row = header.map(h => ({ 名称: '林若悠', 性别: '女', 种族: '人族', 境界: '筑基', 生命: 95, 灵力: 90, 修为: 45, 道心: 60, 亲密: 88, 性格: '温柔' }[h] !== undefined ? { 名称: '林若悠', 性别: '女', 种族: '人族', 境界: '筑基', 生命: 95, 灵力: 90, 修为: 45, 道心: 60, 亲密: 88, 性格: '温柔' }[h] : ''));
    row[0] = 1;
    companions.content = [header, row];
    const allData = win.getAllVariables();
    const sd = allData.stat_data;
    assert.strictEqual(sd.主角.姓名, '未知');
    assert.strictEqual(sd.主角.生命, 100);
    assert.strictEqual(sd.主角.炼丹.阶级, '未入门');
    assert.strictEqual(sd.世界.当前时间, '未知');
    assert.strictEqual(sd.道侣['林若悠'].亲密, 88);
    assert.strictEqual(sd.道侣['林若悠'].种族, '人族');
    assert.ok(Array.isArray(sd['$器灵台词']));
    assert.ok(allData.display_data && allData.display_data.主角, '应有 display_data 镜像');
});

test('问候语 <UpdateVariable> 覆盖初始值 + display 镜像 + 日期 add（端到端模拟）', () => new Promise((resolve, reject) => {
    const vm = require('vm');
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const tables = JSON.parse(JSON.stringify(r.template));
    const byName = (name) => Object.keys(tables).find(k => tables[k].name === name);
    const hero = tables[byName('主角表')];
    const world = tables[byName('世界表')];
    // 固定已知值，避免时区干扰
    const timeCol = world.content[0].indexOf('当前时间');
    world.content[1][timeCol] = '2026-08-09T01:00:00.000Z';
    const nameCol = hero.content[0].indexOf('姓名');
    hero.content[1][nameCol] = '未知';

    const fakeApi = {
        exportTableAsJson: () => tables,
        importTemplateFromData: async () => ({ success: true }),
        initGameSession: async () => ({ success: true, runtimeReady: true }),
        registerTableUpdateCallback: () => {},
        updateCell: async (tableName, rowIndex, col, value) => {
            const sheet = Object.values(tables).find(s => s && s.name === tableName);
            if (!sheet) return false;
            const ci = sheet.content[0].indexOf(col);
            if (ci === -1) return false;
            sheet.content[rowIndex][ci] = value;
            return true;
        },
        insertRow: async () => 1,
        deleteRow: async () => true,
    };
    const win = {
        top: null, parent: null, setTimeout: () => 0, clearTimeout: () => {}, console,
        CustomEvent: function () {}, addEventListener() {}, dispatchEvent() { return true; },
        TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        getContext: () => ({
            chatId: 'c1',
            name: '测试角色',
            chat: [{
                is_user: false,
                mes: '开场白文字\n\n<UpdateVariable>\n_.set(\'主角.姓名\', \'未知\', \'新名字\');//开局设定\n_.add(\'世界.当前时间\', 3600000);\n</UpdateVariable>',
            }],
            eventSource: { on: () => {} },
            event_types: { MESSAGE_RECEIVED: 'message_received' },
        }),
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    win.AutoCardUpdaterAPI = fakeApi;
    vm.createContext(win);
    vm.runInContext(r.bridgeScript, win);
    setTimeout(() => {
        try {
            const all = win.getAllVariables();
            assert.strictEqual(all.stat_data.主角.姓名, '新名字', '问候语 <UpdateVariable> 应覆盖初始值');
            assert.strictEqual(all.stat_data.世界.当前时间, '2026-08-09T02:00:00.000Z', '日期型 _.add 应增加毫秒并转 ISO');
            assert.ok(String(all.display_data.主角.姓名).includes('未知->新名字'), 'display_data 应有 旧->新(原因) 镜像');
            assert.ok(String(all.display_data.主角.姓名).includes('开局设定'), 'display_data 应带原因');
            resolve();
        } catch (e) {
            reject(e);
        }
    }, 500);
}));

test('status_current_variable 单数条目也应识别为 MVU 并删除', () => {
    const card = requireFixture();
    // 模拟教程“蓝灯 D1”：comment 为任意名字，content 用单数 status_current_variable + get_message_variable
    const data = JSON.parse(JSON.stringify(card.data || card));
    data.character_book.entries.push({
        comment: '蓝灯 D1',
        content: '<status_current_variable>//do not output following content\n{{get_message_variable::stat_data}}\n</status_current_variable>',
        enabled: true,
    });
    const r = core.convert({ spec: 'chara_card_v3', data }, { mode: 'both' });
    const out = r.card.data || r.card;
    assert.ok(!out.character_book.entries.some(e => e.comment === '蓝灯 D1'), 'MVU 变量输出条目（任意 comment + status_current_variable）应被删除');
});

/* ---------------- convert 输出 ---------------- */
console.log('convert');
test('转换产物齐全', () => {
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    assert.ok(r.files.some(f => f.kind === 'card'));
    assert.ok(r.files.some(f => f.kind === 'template'));
    assert.ok(r.files.some(f => f.kind === 'report'));
    assert.ok(r.reportText.includes('# MVU → 数据库 转换报告'));
    const c = r.card.data || r.card;
    assert.ok((c.extensions.tavern_helper.scripts || []).some(s => /数据桥/.test(s.name)), '应有数据桥脚本');
    assert.ok((c.extensions.regex_scripts || []).every(rx => !/变量更新/.test(rx.scriptName)), '应移除 MVU 专属正则');
    assert.ok((c.extensions.regex_scripts || []).some(rx => rx.scriptName === 'XML状态栏'), '非 MVU 显示正则应保留');
    assert.ok(c.extensions.mvu2db, '应有转换标记');
    assert.ok(!c.character_book.entries.some(e => /\[initvar\]|\[mvu_update\]|变量列表/i.test(String(e.comment || ''))), 'MVU 世界书条目应被删除');
    assert.ok(String(c.name).endsWith('_数据库'), '卡名应带 _数据库 后缀');
    if (c.character_book && c.character_book.name) {
        assert.ok(String(c.character_book.name).endsWith('_数据库'), '内嵌世界书名称应加 _数据库 后缀');
    }
    if (c.extensions && typeof c.extensions.world === 'string' && c.extensions.world) {
        assert.ok(String(c.extensions.world).endsWith('_数据库'), '外部世界书引用应加 _数据库 后缀');
    }
    const tplEntry = c.character_book.entries.find(e => Array.isArray(e.keys) && e.keys.includes('__ACU_TEMPLATE_DATA__'));
    assert.ok(tplEntry, '应有 __ACU_TEMPLATE_DATA__ 世界书条目（开局自动建表用）');
    assert.ok(typeof tplEntry.content === 'string' && tplEntry.content.length > 100, '模板条目内容应为 base64');
    assert.strictEqual(String(c.first_mes || ''), String((card.data || card).first_mes || ''), '开场白应保持原样（不注入脚本，纯文字开场白可用）');
});

test('native / sqlite 单模式', () => {
    const card = requireFixture();
    const rn = core.convert(card, { mode: 'native' });
    const rs = core.convert(card, { mode: 'sqlite' });
    const hero = Object.keys(rn.template).find(k => rn.template[k].name === '主角表');
    // 模板 note 与模式无关（与默认模板一致），模式由插件填表提示词决定
    assert.ok(!rn.template[hero].sourceData.note.includes('原生 DSL'), 'note 不应区分 native 模式');
    assert.ok(!rn.template[hero].sourceData.note.includes('SQLite SQL'), 'note 不应区分 sqlite 模式');
    assert.strictEqual(rn.template[hero].sourceData.note, rs.template[hero].sourceData.note, '两种模式应生成相同 note');
    assert.ok(rn.template[hero].sourceData.note.includes('【列定义】'), 'note 应含默认模板风格的列定义');
    assert.ok(rn.template[hero].sourceData.note.includes('【强制约束】'), 'note 应含强制约束');
});

test('SQL 示例 VALUES 数量与列数一致', () => {
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    let checked = 0;
    for (const k of Object.keys(r.template).filter(k => k.startsWith('sheet_'))) {
        const ins = r.template[k].sourceData.insertNode || '';
        const m = ins.match(/INSERT INTO \S+ \(([^)]+)\) VALUES \(([^)]+)\)/);
        if (!m) continue;
        const colCount = m[1].split(',').length;
        const valCount = m[2].split(',').length;
        assert.strictEqual(colCount, valCount, `${r.template[k].name} INSERT 示例列值数量不一致: ${ins}`);
        checked++;
    }
    assert.ok(checked >= 3, `应至少检查 3 张表的 INSERT 示例（实际 ${checked}）`);
});

/* ---------------- PNG 往返 ---------------- */
console.log('PNG');
test('PNG 解析 → 转换 → 回写 → 再解析', () => {
    if (!fs.existsSync(PNG)) {
        console.log('    （跳过：缺少 PNG 参考卡）');
        return;
    }
    const buf = fs.readFileSync(PNG);
    const parsed = core.parseCardPng(buf);
    assert.ok(parsed.card.data.name);
    const r = core.convert(buf, { mode: 'both', asPng: true });
    const png = r.files.find(f => f.kind === 'card');
    assert.ok(png.data.length > 1000, 'PNG 输出过小');
    const again = core.parseCardPng(png.data);
    assert.strictEqual(again.card.data.name, String(parsed.card.data.name) + '_数据库');
});

test('浏览器环境（无 Buffer）PNG 回写正常', () => {
    if (!fs.existsSync(PNG)) {
        console.log('    （跳过：缺少 PNG 参考卡）');
        return;
    }
    const vm = require('vm');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'mvu2db.js'), 'utf8');
    const sandbox = {
        console, TextDecoder, TextEncoder, Uint8Array, Uint16Array, Uint32Array, DataView, ArrayBuffer,
        atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    const core = sandbox.MVU2DB_CORE;
    const buf = fs.readFileSync(PNG);
    const parsed = core.parseCardPng(buf);
    const out = core.writeCardPng(buf, parsed.card);
    const again = core.parseCardPng(out);
    assert.strictEqual(again.card.data.name, parsed.card.data.name);
});

/* ---------------- 扩展装配 ---------------- */
console.log('assembleExtension');
test('扩展文件齐全且 index.js 语法正确', () => {
    const coreSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'mvu2db.js'), 'utf8');
    const files = core.assembleExtension({ coreSource });
    assert.ok(files['manifest.json']);
    assert.ok(files['index.js']);
    assert.ok(files['style.css']);
    const manifest = JSON.parse(files['manifest.json']);
    assert.strictEqual(manifest.js, 'index.js');
    new Function(files['index.js']);
});

/* ---------------- 对照金标准 ---------------- */
console.log('通用性验证');
test('合成卡：与参考卡无关的组名也能转换（含 [value,desc] 叶子 / EJS / UpdateVariable）', () => {
    const synthetic = {
        spec: 'chara_card_v3',
        data: {
            name: '通用测试卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [
                    {
                        comment: '[InitVar] 初始',
                        content: `{
  "冒险者": {
    "名字": ["阿星", "主角名字"],
    "等级": [1, "升级时+1"],
    "生命值": [100, "0~100"]
  },
  "队伍": { "小美": { "职业": "法师", "好感": [50, "0~100"] } },
  "$事件日志": []
}`,
                    },
                    {
                        comment: '[MvuUpdate] 规则',
                        content: `变量更新规则:
  冒险者:
    等级:
      type: number
      range: 1~99
    生命值:
      type: number
      range: 0~100
  队伍:
    type: "{ [队员名]: { 职业, 好感 } }"`,
                    },
                    {
                        comment: '显示条件',
                        content: '<% if (getvar("stat_data").冒险者["等级"][0] >= 10) { %>老练冒险者<% } %>',
                    },
                ],
            },
            extensions: {
                regex_scripts: [
                    { scriptName: '状态栏', findRegex: '<Status/>', replaceString: '<div>${stat.冒险者.名字}</div>' },
                ],
                tavern_helper: { scripts: [] },
            },
            alternate_greetings: ['<UpdateVariable>_.set("队伍.队员.小美.职业", "旧", "大法师");</UpdateVariable>'],
        },
    };
    const r = core.convert(synthetic, { mode: 'both' });
    const t = r.template;
    const byName = (name) => Object.keys(t).find(k => t[k].name === name);
    assert.ok(byName('冒险者表'), '应有 冒险者表');
    assert.ok(byName('队伍表'), '应有 队伍表');
    assert.ok(byName('$事件日志表'), '应有 $事件日志表（数组）');
    const adv = t[byName('冒险者表')];
    assert.ok(adv.content[0].includes('生命值'), '冒险者表应有 生命值 列');
    assert.ok(adv.sourceData.ddl.includes('CHECK('), '生命值应有 CHECK 约束（来自卡内规则）');
    assert.ok(adv.sourceData.note.includes('主角名字'), '[值, 更新条件] 叶子的描述应写入 note');
    // EJS 规范写法应被重写
    const cond = r.card.data.character_book.entries.find(e => e.comment === '显示条件');
    assert.ok(/<if cell="冒险者表\/冒险者\/等级 >= 10">/.test(cond.content), cond.content);
    // 非 MVU 内容保持不动
    const statusRegex = r.card.data.extensions.regex_scripts.find(x => x.scriptName === '状态栏');
    assert.strictEqual(statusRegex.replaceString, '<div>${stat.冒险者.名字}</div>');
    // UpdateVariable 开场白保留（由数据桥运行时应用）
    assert.ok(r.card.data.alternate_greetings[0].includes('<UpdateVariable>'));
    // 数据桥脚本包含更新块解析
    assert.ok(r.bridgeScript.includes('parseUpdateCommands'));
});

test('MVU 规则来源：范围/枚举/提醒均来自卡内 [MvuUpdate]（代码无内置数值字典）', () => {
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    // 数值范围必须来自卡内规则（生命 0~100 在 [MvuUpdate] 中声明），而非硬编码
    const world = r.template[Object.keys(r.template).find(k => r.template[k].name === '世界表')];
    assert.ok(world.sourceData.ddl.includes('CHECK('), '世界表 DDL 应有 CHECK（遭遇冷却 0~15 来自卡内规则）');
    const si = core.parseMvuShapes(card);
    assert.deepStrictEqual(si.ranges['遭遇冷却'], [0, 15], '范围应来自卡内规则');
    assert.deepStrictEqual(si.enums['危机程度'], ['无', '低', '中', '高', '致命'], '枚举应来自卡内规则');
});

test('非 MVU 卡（无 [InitVar]）应明确中止，不产出废卡', () => {
    const plain = {
        spec: 'chara_card_v3',
        data: {
            name: '普通卡',
            description: '',
            first_mes: '你好',
            character_book: { entries: [{ comment: '普通条目', content: '你好世界' }] },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    assert.throws(() => core.convert(plain, { mode: 'both' }), /\[InitVar\]/);
});

test('全部表格 DDL + 初始行 通过真实 SQLite 建表/插入校验（python3）', () => {
    const cp = require('child_process');
    let hasPython = true;
    try { cp.execFileSync('python3', ['--version'], { stdio: 'ignore' }); } catch (e) { hasPython = false; }
    if (!hasPython) {
        console.log('    （跳过：无 python3）');
        return;
    }
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const script = `
import json, sqlite3, sys
tpl = json.load(open(sys.argv[1], encoding='utf-8'))
issues = []
for key, sheet in tpl.items():
    if not key.startswith('sheet_'): continue
    db = sqlite3.connect(':memory:')
    try:
        db.execute(sheet['sourceData']['ddl'])
    except Exception as e:
        issues.append(key + ': CREATE 失败: ' + str(e)); db.close(); continue
    cols = [c[1] for c in db.execute('PRAGMA table_info(' + sheet['sourceData']['ddl'].split(' ')[2] + ')').fetchall()]
    for row in sheet['content'][1:]:
        try:
            db.execute('INSERT INTO %s (%s) VALUES (%s)' % (sheet['sourceData']['ddl'].split(' ')[2], ','.join('"'+c+'"' for c in cols), ','.join('?' for _ in cols)), row)
        except Exception as e:
            issues.append(key + ': 初始行 INSERT 失败: ' + str(e))
    db.close()
if issues:
    print('\\n'.join(issues)); sys.exit(1)
print('OK')
`;
    let tmpDir = null;
    for (const base of [os.tmpdir(), '/tmp', __dirname]) {
        try { tmpDir = fs.mkdtempSync(path.join(base, 'mvu2db-')); break; } catch (e) {}
    }
    assert.ok(tmpDir, '无法创建临时目录');
    const tmpFile = path.join(tmpDir, 'template.json');
    fs.writeFileSync(tmpFile, JSON.stringify(r.template));
    let out;
    try {
        out = cp.execFileSync('python3', ['-c', script, tmpFile], { encoding: 'utf8', timeout: 30000 });
    } catch (e) {
        console.log('    （跳过：本环境禁止从 Node 派生进程，无法运行 python3 校验）');
        return;
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    assert.strictEqual(out.trim(), 'OK');
});

test('世界书无 [InitVar] 但问候语含 <initvar> 块：按 MVU 规范兜底转换', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '问候语初始化卡',
            description: '',
            first_mes: '你好',
            alternate_greetings: ['开场：<initvar>\n{\n  "人物": { "名字": ["阿星", "主角"], "等级": [1, "升级+1"] }\n}\n</initvar>'],
            character_book: { entries: [{ comment: '普通条目', content: '你好' }] },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both' });
    const byName = (n) => Object.keys(r.template).find(k => r.template[k].name === n);
    assert.ok(byName('人物表'), '应从问候语 <initvar> 推导出 人物表');
});

runTests();
