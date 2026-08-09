#!/usr/bin/env node
/*
 * MVU→数据库 转换器测试
 * 用法：node run-tests.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
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

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('  ✓', name);
    } catch (e) {
        if (e && e.code === 'SKIP_NO_FIXTURE') {
            console.log('  - 跳过（无参考卡 fixture，仅保留通用性测试）', name);
            return;
        }
        failed++;
        console.error('  ✗', name);
        console.error('    ', e.message);
    }
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
});

test('native / sqlite 单模式', () => {
    const card = requireFixture();
    const rn = core.convert(card, { mode: 'native' });
    const rs = core.convert(card, { mode: 'sqlite' });
    const hero = Object.keys(rn.template).find(k => rn.template[k].name === '主角表');
    assert.ok(rn.template[hero].sourceData.note.includes('原生 DSL'), 'native 应有 DSL 说明');
    assert.ok(!rn.template[hero].sourceData.note.includes('SQLite SQL'), 'native 不应有 SQL 说明');
    assert.ok(rs.template[hero].sourceData.note.includes('SQLite SQL'), 'sqlite 应有 SQL 说明');
    assert.ok(!rs.template[hero].sourceData.note.includes('原生 DSL'), 'sqlite 不应有 DSL 说明');
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

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed) process.exit(1);
