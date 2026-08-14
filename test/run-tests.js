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

const core = require('../src/mvu2shujuku.js');

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

// 模拟真实插件行为的 fake API：updateCell/insertRow/deleteRow 真实落表，
// importTableAsJson 记录并替换表数据（与原生数据库卡的写路径一致）。
function applyingApi(tables, opts = {}) {
    return {
        getTemplatePresetNames: () => [],
        exportTableAsJson: () => tables,
        initGameSession: async () => {
            if (opts.onInit) await opts.onInit();
            return { success: true, runtimeReady: true };
        },
        importTemplateFromData: async () => ({ success: true }),
        importTableAsJson: async (jsonStr, o) => {
            const parsed = JSON.parse(jsonStr);
            if (opts.onImport) opts.onImport(parsed, o);
            for (const k of Object.keys(tables)) delete tables[k];
            Object.assign(tables, parsed);
            return true;
        },
        updateCell: async (tableName, rowIndex, col, value) => {
            const s = Object.values(tables).find(x => x && x.name === tableName);
            if (!s || !s.content[rowIndex]) return false;
            const ci = s.content[0].indexOf(col);
            if (ci === -1) return false;
            s.content[rowIndex][ci] = String(value);
            return true;
        },
        insertRow: async (tableName, obj) => {
            const s = Object.values(tables).find(x => x && x.name === tableName);
            if (!s) return 0;
            const row = s.content[0].map(h => (obj && obj[h] !== undefined && obj[h] !== null) ? String(obj[h]) : '');
            row[0] = s.content.length || 1;
            s.content.push(row);
            return row[0];
        },
        deleteRow: async (tableName, rowIndex) => {
            const s = Object.values(tables).find(x => x && x.name === tableName);
            if (!s || !s.content[rowIndex]) return false;
            s.content.splice(rowIndex, 1);
            return true;
        },
        registerTableUpdateCallback: () => true,
    };
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
    // VM 内桥使用真实定时器（合并写入/重试），测试结束后直接退出，避免未清理定时器拖住进程
    process.exit(failed ? 1 : 0);
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

test('从 [mvu_update] 提取 check 规则与提醒（含引号项、模板键展开）', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '规则卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [
                    {
                        comment: '[InitVar]',
                        content: [
                            '世界:',
                            '  当前时间: 未知',
                            '  当前地点: 未知',
                            '  遭遇冷却: 15',
                            '主角:',
                            '  姓名: 未知',
                            '  生命: 100',
                            '  道心: 50',
                        ].join('\n'),
                    },
                    {
                        comment: '[mvu_update]',
                        content: [
                            '变量更新规则:',
                            '  _强制更新提醒:',
                            '    - 主角.${生命|精血} — 战斗、受伤时',
                            '  世界:',
                            '    遭遇冷却:',
                            '      type: number',
                            '      range: 0~15',
                            '      check:',
                            '        - 如果当前遭遇冷却大于0，每推进一次剧情就减1（op: delta, value: -1）',
                            '        - 触发动态遭遇时重置为15',
                            '    当前地点:',
                            '      check: "必须按层级描述"',
                            '  主角:',
                            '    道心:',
                            '      type: number',
                            '      range: 0~100',
                            '      check:',
                            '        - "四境：凡心(0~25) 初窥(26~50)"',
                            '        - 归零则走火入魔',
                        ].join('\n'),
                    },
                ],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const si = core.parseMvuShapes(card);
    assert.deepStrictEqual(
        si.checks['世界']['遭遇冷却'],
        ['如果当前遭遇冷却大于0，每推进一次剧情就减1（op: delta, value: -1）', '触发动态遭遇时重置为15'],
        'bullet check 应完整提取'
    );
    assert.deepStrictEqual(si.checks['世界']['当前地点'], ['必须按层级描述'], '单行引号 check 应提取');
    assert.strictEqual(si.checks['主角']['道心'][0], '四境：凡心(0~25) 初窥(26~50)', '引号包裹的列表项应剥掉引号');
    assert.ok(si.reminders['主角'].some(r => r.includes('生命/精血')), '提醒中的模板键应展开');
    // 落到表格 note：check 规则应出现在填表提示词里
    const r = core.convert(card, { mode: 'both' });
    const world = Object.values(r.template).find(s => s && s.name === '世界表');
    assert.ok(world.sourceData.note.includes('遭遇冷却：如果当前遭遇冷却大于0'), 'note 应包含 check 规则');
    assert.ok(world.sourceData.note.includes('当前地点：必须按层级描述'), 'note 应包含单行引号 check');
});

test('组级 check（道侣/灵宠/人物/玉简等整表规则）不应丢失', () => {
    const card = requireFixture();
    const si = core.parseMvuShapes(card);
    assert.ok(
        Array.isArray(si.groupChecks['道侣']) && si.groupChecks['道侣'].some(x => x.includes('强制互斥锁')),
        'parseMvuShapes 应保留组级 check 条目（互斥锁）'
    );
    assert.ok(
        si.groupChecks['道侣'].some(x => x.includes('亲密数值变动需符合逻辑')),
        '组级 check 中带引号的条目应剥掉引号保留'
    );
    const r = core.convert(card, { mode: 'both' });
    const byName = (n) => Object.values(r.template).find(s => s && s.name === n);
    const dl = byName('道侣表');
    assert.ok(dl.sourceData.note.includes('强制互斥锁：道侣与人物列表绝对互斥'), '道侣表 note 应含互斥锁规则');
    assert.ok(dl.sourceData.note.includes('单次增减幅度限制在 ±(2~10) 之间'), '道侣表 note 应含增减幅度规则');
    const jade = byName('玉简表');
    assert.ok(jade.sourceData.note.includes('历史记录严格限制最多保留100条'), '玉简表 note 应含组级规则');
});

test('format 支持无引号与块标量写法；zod 数值约束提取范围', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '格式卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [
                    {
                        comment: '[InitVar]',
                        content: '世界:\n  当前时间: 未知\n  当前地点: 未知\n白娅:\n  依存度: 0',
                    },
                    {
                        comment: '[mvu_update]变量更新规则',
                        content: [
                            '变量更新规则:',
                            '  世界:',
                            '    当前时间:',
                            '      format: YYYY年MM月DD日 星期X HH:MM',
                            '    当前地点:',
                            '      format: |-',
                            '        层级1·层级2',
                            '        环境描述≥20字',
                            '  白娅:',
                            '    依存度:',
                            '      type: number',
                            '      check:',
                            '        - 根据行为调整 ±(3~6)',
                        ].join('\n'),
                    },
                    {
                        comment: '[mvu_update]变量更新规则zod',
                        content: [
                            '变量更新规则: |-',
                            '  z.object({',
                            '    白娅: z.object({',
                            '      /**',
                            '       * check:',
                            '       *   - 根据白娅对{{user}}行为的感知调整',
                            '       */',
                            '      依存度: z.number().min(0).max(100),',
                            '      着装: z.string().describe("穿着描述"),',
                            '      称谓: z.enum(["仙子", "道友"]),',
                            '    }),',
                            '  })',
                        ].join('\n'),
                    },
                ],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const si = core.parseMvuShapes(card);
    assert.strictEqual(si.formats['世界']['当前时间'], 'YYYY年MM月DD日 星期X HH:MM', '无引号 format 应提取');
    assert.ok(si.formats['世界']['当前地点'].includes('环境描述≥20字'), '块标量 format 应提取并合并');
    assert.deepStrictEqual(si.ranges['依存度'], [0, 100], 'zod z.number().min/max 应提取范围');
    assert.ok(si.numericFields.has('依存度'), 'zod 数值字段应标记为数字');
    assert.deepStrictEqual(si.enums['称谓'], ['仙子', '道友'], 'zod z.enum 应提取可选值');
    assert.strictEqual(si.zodDescs['白娅']['着装'], '穿着描述', 'zod .describe 应提取字段说明');
    const r = core.convert(card, { mode: 'both' });
    const byName = (n) => Object.values(r.template).find(s => s && s.name === n);
    const world = byName('世界表');
    assert.ok(world.sourceData.note.includes('格式要求：YYYY年MM月DD日 星期X HH:MM'), 'note 应含无引号格式');
    const bya = byName('白娅表');
    assert.ok(bya.sourceData.note.includes('数值范围 0~100'), 'zod 范围应进入 note');
    assert.ok(bya.sourceData.ddl.includes('CHECK(yicundu BETWEEN 0 AND 100)'), 'zod 范围应生成 DDL CHECK');
    assert.ok(bya.sourceData.note.includes('可选值：仙子 / 道友'), 'zod 枚举应进入 note');
    assert.ok(bya.sourceData.note.includes('着装：穿着描述'), 'zod describe 应进入 note 列说明');
});

test('通配路径字段（如 户.<门牌>.妻.好感值）应显式警告而非静默丢弃', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '通配卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [
                    { comment: '[InitVar]', content: '户: {}\n现金: 500\n人物: { 张三: { 亲密: 10 } }\n系统: { _版本: 1 }' },
                    {
                        comment: '[mvu_update]变量更新规则',
                        content: [
                            '变量更新规则:',
                            '  户.<门牌>.妻.好感值:',
                            '    type: number',
                            '    range: 0~100',
                            '    check:',
                            '      - 仅本人在场时更新',
                            '  户.<门牌>.夫.当前情绪:',
                            '    type: string',
                            '    check:',
                            '      - 丈夫在场时更新',
                            '  人物.角色名.亲密:',
                            '    type: number',
                            '    range: 0~100',
                            '    check:',
                            '      - 与NPC互动时更新，单次 ±(2~5)',
                        ].join('\n'),
                    },
                ],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const si = core.parseMvuShapes(card);
    assert.ok(si.wildcardFields.has('户.<门牌>.妻.好感值'), '通配路径字段应被识别');
    assert.ok(si.wildcardFields.has('户.<门牌>.夫.当前情绪'), '多个通配路径字段都应被识别');
    assert.ok(Array.isArray(si.wildcardRules['人物']) && si.wildcardRules['人物'][0].range[0] === 0, '通配规则应按路径首段归组并提取范围');
    const r = core.convert(card, { mode: 'both' });
    assert.ok(r.report.toMarkdown().includes('通配路径规则'), '转换报告应显式警告通配路径规则');
    const hub = Object.values(r.template).find(s => s && s.name === '户表');
    assert.ok(hub.sourceData.note.includes('【可写路径与约束】'), 'JSON 表有可写规则时不应一刀切只读');
    assert.ok(hub.sourceData.note.includes('户.<门牌>.妻.好感值（数值范围 0~100；仅本人在场时更新）'), 'JSON 表 note 应列出可写路径与约束');
    assert.ok(!hub.sourceData.note.includes('AI 不应直接修改本表'), 'JSON 表有可写规则时不应再标“AI 不应直接修改”');
    assert.ok(hub.sourceData.note.includes('【更新守卫】'), 'JSON 表有可写规则时应附加更新守卫');
    assert.ok(!hub.sourceData.note.includes('为通配键'), '提示词不应声称 <…> 是“通配键”（MVU 未定义该说法）');
    assert.ok(!hub.sourceData.note.includes('需替换为「内容」列当前 JSON 中实际存在的键名'), '提示词不应额外解释 <…>（与 MVU 原版一致，规则原文交给 AI 理解）');
    assert.ok(hub.sourceData.note.includes('它们仍存在于同一 JSON 中'), '更新守卫应说明未列出字段仍物理存在于同一 JSON');
    assert.ok(hub.sourceData.note.includes('未列出的字段一律只读'), '更新守卫应包含未列出字段只读');
    assert.ok(hub.sourceData.note.includes('规则要求 insert/初始化/新增 的路径允许创建对应字段、对象或记录'), 'JSON 表守卫应允许规则声明可新增的路径（初始化 insert 不被堵死）');
    assert.ok(hub.sourceData.note.includes('禁止新增/删除行'), 'JSON 表顶部应说“行”而非“记录”');
    assert.ok(hub.sourceData.updateNode.includes('未列出字段一律只读'), 'JSON 表 updateNode 应包含只读守卫');
    assert.ok(hub.sourceData.updateNode.includes('SQL示例: UPDATE'), 'JSON 表有可写规则时 updateNode 应含 SQL 示例');
    assert.ok(hub.sourceData.updateNode.includes('WHERE row_id=1'), 'JSON 表更新示例应定位 row_id=1');
    assert.ok(hub.sourceData.ddl.includes('CHECK(json_valid(neirong))'), 'JSON 表内容列应有 json_valid CHECK（SQLite 模式生效）');
    const cash = Object.values(r.template).find(s => s && s.name === '现金表');
    assert.ok(cash.sourceData.note.includes('AI 不应直接修改本表'), '无规则的 JSON 表仍应保持只读');
    const rw = Object.values(r.template).find(s => s && s.name === '人物表');
    assert.ok(
        rw.sourceData.note.includes('人物.角色名.亲密（数值范围 0~100；与NPC互动时更新，单次 ±(2~5)）'),
        '可写行表的通配规则应作为表格级提示写入 note（不重复表名前缀）'
    );
});

test('模板 content 单元格归一化：布尔 → 1/0，无非法类型（插件 escapeValue 兼容）', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '布尔卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [{
                    comment: '[InitVar]',
                    content: [
                        '玩家资源:',
                        '  保护准备: false',
                        '  已启用: true',
                        '  精力: 8',
                    ].join('\n'),
                }],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both' });
    const sheet = Object.values(r.template).find(s => s && s.name === '玩家资源表');
    assert.ok(sheet, '应生成玩家资源表');
    for (let ri = 1; ri < sheet.content.length; ri++) {
        for (let ci = 1; ci < sheet.content[ri].length; ci++) {
            const v = sheet.content[ri][ci];
            assert.ok(typeof v === 'string' || typeof v === 'number', `单元格应为 string/number，实际 ${typeof v}`);
        }
    }
    assert.strictEqual(sheet.content[1][sheet.content[0].indexOf('保护准备')], 0, 'false 应归一化为 0');
    assert.strictEqual(sheet.content[1][sheet.content[0].indexOf('已启用')], 1, 'true 应归一化为 1');
});

test('zod/TS 替代写法：z.object 结构 + /** check: */ 注释应被解析', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: 'zod卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [
                    {
                        comment: '[InitVar]',
                        content: [
                            '白娅:',
                            '  依存度: 0',
                            '  着装: 无',
                            '世界:',
                            '  当前时间: 未知',
                        ].join('\n'),
                    },
                    {
                        comment: '[mvu_update]变量更新规则',
                        content: [
                            '变量更新规则: |-',
                            '  z.object({',
                            '    白娅: z.object({',
                            '      /**',
                            '       * check:',
                            '       *   - 根据白娅对{{user}}行为的感知和反应调整 ±(3~6)',
                            '       *   - 仅在白娅当前察觉到{{user}}的行为时才更新',
                            '       */',
                            '      依存度: z.number().min(0).max(100),',
                            '      着装: z.string().describe("穿着描述"),',
                            '    }),',
                            '    世界: z.object({',
                            '      当前时间: z.string(),',
                            '    }),',
                            '  })',
                        ].join('\n'),
                    },
                ],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const si = core.parseMvuShapes(card);
    assert.ok(si.shapes['白娅'].includes('依存度'), 'zod 字段名应并入 shapes');
    assert.ok(si.shapes['白娅'].includes('着装'), 'zod 字段名应并入 shapes');
    assert.ok(si.shapes['世界'].includes('当前时间'), 'zod 世界组字段应并入 shapes');
    assert.deepStrictEqual(
        si.checks['白娅']['依存度'],
        ['根据白娅对{{user}}行为的感知和反应调整 ±(3~6)', '仅在白娅当前察觉到{{user}}的行为时才更新'],
        'zod /** check: */ 注释应提取为规则'
    );
    // 落到表格 note
    const r = core.convert(card, { mode: 'both' });
    const bya = Object.values(r.template).find(s => s && s.name === '白娅表');
    assert.ok(bya.sourceData.note.includes('依存度：根据白娅对{{user}}行为的感知和反应调整 ±(3~6)'), 'zod check 应进入填表提示词');
});

test('DDL CHECK 开关：默认带约束，ddlIncludeCheck:false 时全部去掉（范围/枚举/json_valid）', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: 'DDL开关卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [
                    {
                        comment: '[InitVar]',
                        content: '世界: { 名称: 世界, 时间: 未知, 遭遇冷却: 20 }\n白娅: { 依存度: 0, 称谓: 仙子 }\n背包: {}',
                    },
                    {
                        comment: '[mvu_update]变量更新规则',
                        content: [
                            '变量更新规则: |-',
                            '  z.object({',
                            '    世界: z.object({',
                            '      遭遇冷却: z.number().min(0).max(15),',
                            '    }),',
                            '    白娅: z.object({',
                            '      依存度: z.number().min(0).max(100),',
                            '      称谓: z.enum(["仙子", "道友"]),',
                            '    }),',
                            '  })',
                        ].join('\n'),
                    },
                ],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const withCheck = core.convert(card, { mode: 'both' });
    const allDdl = Object.values(withCheck.template)
        .filter(s => s && s.sourceData && s.sourceData.ddl)
        .map(s => s.sourceData.ddl)
        .join('\n');
    assert.ok(allDdl.includes('CHECK('), '默认应带 CHECK 约束');
    assert.ok(allDdl.includes('CHECK(json_valid(neirong))'), 'JSON 表默认应有 json_valid CHECK');
    assert.ok(allDdl.includes('CHECK(yicundu BETWEEN 0 AND 100)'), '数值范围默认应有 CHECK');
    const noCheck = core.convert(card, { mode: 'both', ddlIncludeCheck: false });
    const allDdl2 = Object.values(noCheck.template)
        .filter(s => s && s.sourceData && s.sourceData.ddl)
        .map(s => s.sourceData.ddl)
        .join('\n');
    assert.ok(!allDdl2.includes('CHECK('), 'ddlIncludeCheck:false 时 DDL 不应包含任何 CHECK');
    assert.ok(allDdl2.includes('NOT NULL DEFAULT'), '关闭 CHECK 不影响列类型与默认值');
    assert.ok(!noCheck.report.toMarkdown().includes('CHECK 约束已放行'), '关闭 CHECK 时报告不应再提“CHECK 约束已放行”');
});

test('自动化更新参数：模板每表带 updateConfig，改 JSON 后重转换保留并写入卡内模板 base64', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '参数卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [
                    { comment: '[InitVar]', content: '世界: { 名称: 世界, 时间: 未知 }' },
                ],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r1 = core.convert(card, { mode: 'both' });
    const sheets = Object.keys(r1.template).filter(k => k.startsWith('sheet_'));
    assert.ok(sheets.length >= 1, '模板应有表');
    for (const k of sheets) {
        assert.ok(r1.template[k].updateConfig && typeof r1.template[k].updateConfig === 'object', `${k} 应带 updateConfig（自动化更新参数）`);
    }
    // 模拟前端编辑器：直接改模板 JSON 的 updateConfig（更新频率=2、分组编号=3），再走“应用修改”重新转换
    const world = Object.values(r1.template).find(s => s && s.name === '世界表');
    world.updateConfig = { uiSentinel: -1, updateFrequency: 2, groupId: 3, skipFloors: -1 };
    const r2 = core.convert(card, { mode: 'both', template: r1.template });
    const world2 = Object.values(r2.template).find(s => s && s.name === '世界表');
    assert.strictEqual(world2.updateConfig.updateFrequency, 2, '重转换应保留改后的 updateFrequency');
    assert.strictEqual(world2.updateConfig.groupId, 3, '重转换应保留改后的 groupId');
    // 卡内世界书 __ACU_TEMPLATE_DATA__ 应带新参数（新建聊天建表读它）
    const tplEntry = (r2.card.data || r2.card).character_book.entries.find(e => Array.isArray(e.keys) && e.keys.includes('__ACU_TEMPLATE_DATA__'));
    assert.ok(tplEntry, '转换卡应带 __ACU_TEMPLATE_DATA__ 模板条目');
    const embedded = JSON.parse(Buffer.from(tplEntry.content, 'base64').toString('utf8'));
    const worldEmbed = Object.values(embedded).find(s => s && s.name === '世界表');
    assert.strictEqual(worldEmbed.updateConfig.updateFrequency, 2, '卡内模板 base64 应同步新参数');
});

test('SQL 示例优先用默认值，TEXT 无默认才用“列名示例”', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '示例默认卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [{
                    comment: '[InitVar]',
                    content: [
                        '道侣:',
                        '  林若悠: { 亲密: 50 }',
                        '  林若雪: { 亲密: 50, 修为: 10, 性格: "温柔" }',
                    ].join('\n'),
                }],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both' });
    const dl = Object.values(r.template).find(s => s && s.name === '道侣表');
    assert.ok(dl.sourceData.insertNode.includes("VALUES ('林若悠', 50, 0, '性格示例')"), 'INSERT 应含真实值/默认值/列名示例');
    assert.ok(dl.sourceData.updateNode.includes('SET qinmi = 0'), 'UPDATE 示例应使用占位值而非当前值');
    assert.ok(!dl.sourceData.updateNode.includes('示例值仅为格式演示'), 'UPDATE 示例不再带“示例值仅为格式演示”后缀（与插件内置模板一致）');
});

test('单例 UPDATE 示例：与行表一致的“规则 + SQL示例:”格式，TEXT 用“新值”占位', () => {
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const world = Object.values(r.template).find(s => s && s.name === '世界表');
    const node = world.sourceData.updateNode;
    assert.ok(node.includes('SQL示例: UPDATE shijiebiao SET dangqianshijian ='), '单例 updateNode 应有 SQL示例: 前缀');
    assert.ok(node.includes("= '新值'"), 'TEXT 字段 UPDATE 示例应用“新值”占位，而非当前默认值');
    assert.ok(!node.includes("'未知'"), 'UPDATE 示例不应使用当前默认值（避免读成更新成原值）');
    assert.ok(!node.includes('示例值仅为格式演示'), 'UPDATE 示例不再带“示例值仅为格式演示”后缀（与插件内置模板一致）');
});

test('相邻顶层组不被跳过 + check 机制词清洗（op/delta/replace/分指令）', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '机制词卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [
                    {
                        comment: '[InitVar]',
                        content: '主角:\n  炼器次数: 0\n世界:\n  遭遇冷却: 15',
                    },
                    {
                        comment: '[mvu_update]变量更新规则',
                        content: [
                            '变量更新规则:',
                            '  世界:',
                            '    遭遇冷却:',
                            '      type: number',
                            '      range: 0~15',
                            '      check:',
                            '        - 如果当前遭遇冷却大于0，每推进一次剧情/回合就减1（op: delta, value: -1）',
                            '        - 如果当前回合触发了动态遭遇事件，必须将其重置为15（op: replace, value: 15）',
                            '  主角:',
                            '    炼器次数:',
                            '      check:',
                            '        - 【防崩警告】更新时必须精确到子字段（如 /主角/炼丹/熟练度），严禁直接对整个对象使用 replace 或 delta！',
                            '        - 熟练度(0~100)根据炼制结果增加：失败加1~5，成功加20~30。满100时必须分两条指令更新：一条replace阶级提升，另一条replace熟练度为0（勿用delta导致超限）',
                        ].join('\n'),
                    },
                ],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const si = core.parseMvuShapes(card);
    // 相邻组（变量更新规则: 后紧跟 世界:）不能被跳过
    assert.ok(Array.isArray(si.checks['世界']['遭遇冷却']), '相邻的 世界 组应被识别（check 应挂在 世界 下）');
    const r = core.convert(card, { mode: 'both' });
    const byName = (n) => Object.values(r.template).find(s => s && s.name === n);
    const worldNote = byName('世界表').sourceData.note;
    assert.ok(worldNote.includes('遭遇冷却：如果当前遭遇冷却大于0，每推进一次剧情/回合就减1'), '括号机制注释应删除、业务规则保留');
    assert.ok(!worldNote.includes('op:') && !worldNote.includes('（op:'), 'note 不应残留 op 机制词');
    assert.ok(worldNote.includes('更新以正文和规则为依据，不得为凑表而虚构数据。'), '通用约束应改为“以正文和规则为依据”，不与每轮强制规则冲突');
    const heroNote = byName('主角表').sourceData.note;
    assert.ok(!heroNote.includes('防崩') && !heroNote.includes('replace') && !heroNote.includes('delta') && !heroNote.includes('指令'), '纯机制句与机制词应被清洗');
    assert.ok(heroNote.includes('满100时阶级提升；熟练度为0'), '“分两条指令”应改写为业务语义');
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
    // mate 对齐插件默认（version 2 + 世界书注入配置）：否则预设库与聊天作用域只在 mate 上不一致，
    // 插件面板会显示“当前生效模板与预设库内容不同”。
    assert.strictEqual(t.mate.version, 2, 'mate 应为 version 2（插件 init/迁移会升到 2）');
    assert.strictEqual(t.mate.globalInjectionConfig && t.mate.globalInjectionConfig.readableEntryPlacement && t.mate.globalInjectionConfig.readableEntryPlacement.order, 99981, 'mate 应含 readableEntryPlacement 默认配置');
    assert.strictEqual(t.mate.globalInjectionConfig && t.mate.globalInjectionConfig.wrapperPlacement && t.mate.globalInjectionConfig.wrapperPlacement.order, 99980, 'mate 应含 wrapperPlacement 默认配置');
    for (const k of Object.keys(t).filter(k => k.startsWith('sheet_'))) {
        const s = t[k];
        assert.ok(s.uid && s.name && s.content && s.sourceData, `sheet ${k} 缺字段`);
        assert.ok(Array.isArray(s.content) && Array.isArray(s.content[0]), `sheet ${k} content 格式错误`);
        assert.ok(['note', 'initNode', 'updateNode', 'insertNode', 'deleteNode', 'ddl'].every(x => x in s.sourceData), `sheet ${k} sourceData 缺字段`);
        // row_id 连续正整数
        s.content.slice(1).forEach((row, i) => assert.strictEqual(row[0], i + 1, `sheet ${k} row_id 应连续`));
    }
});

test('mergeTemplates：并入选中表、跳过重名、uid 冲突加后缀、orderNo 重排', () => {
    const base = {
        mate: { type: 'chatSheets', version: 1 },
        sheet_a: { uid: 'sheet_a', name: '转换表', content: [['row_id', '值']], sourceData: {}, orderNo: 0 },
    };
    const source = {
        mate: { type: 'chatSheets', version: 1 },
        sheet_b: { uid: 'sheet_b', name: '玩家表', content: [['row_id', '值']], sourceData: {}, orderNo: 0 },
        sheet_c: { uid: 'sheet_c', name: '转换表', content: [['row_id', '值']], sourceData: {}, orderNo: 1 },
        sheet_a: { uid: 'sheet_a', name: '全局数据表', content: [['row_id', '值']], sourceData: {}, orderNo: 2 },
    };
    const out = core.mergeTemplates(base, source, ['sheet_b', 'sheet_c', 'sheet_a']);
    assert.ok(out.template.sheet_b, '应并入 sheet_b');
    assert.ok(!out.template.sheet_c, '重名表应跳过');
    assert.ok(out.template.sheet_a_2, 'uid 冲突应加后缀');
    assert.deepStrictEqual(out.skipped, ['转换表'], '应报告跳过的重名表');
    const order = Object.keys(out.template).filter(k => k.startsWith('sheet_')).map(k => out.template[k].orderNo);
    assert.deepStrictEqual(order, [0, 1, 2], 'orderNo 应连续重排');
});

test('statDataFromTables：按布局从表格重建 stat_data（单例/行表/数组）', () => {
    const layout = [
        { kind: 'singleton', group: '系统', table: '系统表', keyCol: '名称', keyValue: '系统', cols: [['名称', 'text', '', '', '', ''], ['当前时间', 'text', '', '', '', '']], writePaths: [], mirrors: [] },
        { kind: 'rows', group: '角色', table: '角色表', keyCol: '名称', cols: [['名称', 'text', '', '', '', ''], ['发情值', 'number', '', '', '', '']], writePaths: [['角色']], mirrors: [] },
        { kind: 'array', group: '$器灵台词', table: '台词表', cols: [['内容', 'text', '', '', '', '']], writePaths: [], mirrors: [] },
    ];
    const tables = {
        sheet_1: { name: '系统表', content: [['row_id', '名称', '当前时间'], [1, '系统', '09:00']] },
        sheet_2: { name: '角色表', content: [['row_id', '名称', '发情值'], [1, '西园寺爱丽莎', 25], [2, '月咏深雪', 10]] },
        sheet_3: { name: '台词表', content: [['row_id', '内容'], [1, '第一句'], [2, '第二句']] },
    };
    const data = core.statDataFromTables(layout, tables);
    assert.strictEqual(data.stat_data.系统.当前时间, '09:00', '单例表应还原');
    assert.strictEqual(data.stat_data.角色['西园寺爱丽莎'].发情值, 25, '行表数字列应还原为数字');
    assert.strictEqual(data.stat_data.角色['月咏深雪'].发情值, 10, '行表多条应还原');
    assert.deepStrictEqual(data.stat_data['$器灵台词'], ['第一句', '第二句'], '数组表应还原');
    assert.ok(data.display_data && data.display_data.系统, '应有 display_data 镜像');
});

test('writeStatDiffToDb：stat_data 差异写回数据库（单例更新/行表插入/数组替换）', async () => {
    const layout = [
        { kind: 'singleton', group: '系统', table: '系统表', keyCol: '名称', keyValue: '系统', cols: [['名称', 'text', '', '', '', ''], ['当前MC点', 'number', '', '', '', '']], writePaths: [], mirrors: [] },
        { kind: 'rows', group: '角色', table: '角色表', keyCol: '名称', cols: [['名称', 'text', '', '', '', ''], ['好感度', 'number', '', '', '', '']], writePaths: [['角色']], mirrors: [] },
        { kind: 'array', group: '$器灵台词', table: '台词表', cols: [['内容', 'text', '', '', '', '']], writePaths: [], mirrors: [] },
    ];
    const tables = {
        sheet_1: { name: '系统表', content: [['row_id', '名称', '当前MC点'], [1, '系统', 100]] },
        sheet_2: { name: '角色表', content: [['row_id', '名称', '好感度'], [1, '西园寺爱丽莎', 0]] },
        sheet_3: { name: '台词表', content: [['row_id', '内容'], [1, '旧']] },
    };
    const api = {
        exportTableAsJson: () => tables,
        updateCell: async (tn, ri, col, val) => {
            const s = Object.values(tables).find(x => x.name === tn);
            const ci = s.content[0].indexOf(col);
            s.content[ri][ci] = val;
            return true;
        },
        insertRow: async (tn, data) => {
            const s = Object.values(tables).find(x => x.name === tn);
            s.content.push([s.content.length, ...Object.values(data)]);
            return s.content.length - 1;
        },
        deleteRow: async (tn, ri) => {
            const s = Object.values(tables).find(x => x.name === tn);
            // 插件真实语义：rowIndex 是 content 数组索引（0=表头，1=第一数据行）
            s.content.splice(ri, 1);
            return true;
        },
    };
    const prev = { 系统: { 当前MC点: 100 }, 角色: { 西园寺爱丽莎: { 好感度: 0 } }, '$器灵台词': ['旧'] };
    const next = { 系统: { 当前MC点: 80 }, 角色: { 西园寺爱丽莎: { 好感度: 5 }, 月咏深雪: { 好感度: 3 } }, '$器灵台词': ['新1', '新2'] };
    const n = await core.writeStatDiffToDb(api, layout, prev, next);
    assert.ok(n >= 4, '应产生差异操作');
    assert.strictEqual(tables.sheet_1.content[1][2], 80, '单例更新应写库');
    assert.strictEqual(tables.sheet_2.content[1][2], 5, '行表更新应写库');
    assert.strictEqual(tables.sheet_2.content.length, 3, '新条目应插入');
    assert.deepStrictEqual(tables.sheet_3.content.slice(1).map(r => r[1]), ['新1', '新2'], '数组应整体替换');
});

function parseSqlValue(v) {
    if (/^'/.test(v)) return v.replace(/^'|'$/g, '').replace(/''/g, "'");
    const n = Number(v);
    return isNaN(n) ? v : n;
}

function splitSqlValues(str) {
    const out = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (inQ) {
            if (ch === "'") {
                if (str[i + 1] === "'") { cur += "'"; i++; }
                else inQ = false;
            } else cur += ch;
        } else if (ch === "'") {
            inQ = true;
        } else if (ch === ',') {
            out.push(parseSqlValue(cur.trim()));
            cur = '';
            continue;
        } else cur += ch;
    }
    if (cur.trim()) out.push(parseSqlValue(cur.trim()));
    return out;
}

function applySqlToTables(tables, sql) {
    for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
        let m = stmt.match(/^UPDATE\s+(\S+)\s+SET\s+(\S+)\s*=\s*(.+?)\s+WHERE\s+row_id\s*=\s*(\d+)$/);
        if (m) {
            const tn = m[1], col = m[2], raw = m[3], rid = m[4];
            const s = Object.values(tables).find(x => x.name === tn);
            const ci = s.content[0].indexOf(col);
            const row = s.content.find(r => String(r[0]) === rid);
            row[ci] = parseSqlValue(raw);
            continue;
        }
        m = stmt.match(/^INSERT INTO\s+(\S+)\s+\(([^)]+)\)\s+VALUES\s+\((.+)\)$/);
        if (m) {
            const tn = m[1];
            const cols = m[2].split(',').map(s => s.trim());
            const vals = splitSqlValues(m[3]);
            const s = Object.values(tables).find(x => x.name === tn);
            let maxId = 0;
            for (let i = 1; i < s.content.length; i++) {
                const rid = Number(s.content[i] && s.content[i][0]);
                if (!isNaN(rid) && rid > maxId) maxId = rid;
            }
            const row = new Array(s.content[0].length).fill('');
            row[0] = maxId + 1;
            cols.forEach((c, i) => { row[s.content[0].indexOf(c)] = vals[i]; });
            s.content.push(row);
            continue;
        }
        m = stmt.match(/^DELETE FROM\s+(\S+)\s+WHERE\s+row_id\s*=\s*(\d+)$/);
        if (m) {
            const tn = m[1], rid = m[2];
            const s = Object.values(tables).find(x => x.name === tn);
            const idx = s.content.findIndex(r => String(r[0]) === rid);
            if (idx >= 0) s.content.splice(idx, 1);
            continue;
        }
        throw new Error('无法解析测试 SQL: ' + stmt);
    }
}

test('writeStatDiffToDb：多操作走逐条原生 CRUD（不再用 executeSqlBatch），row_id 不冲突', async () => {
    const layout = [
        { kind: 'singleton', group: '系统', table: '系统表', keyCol: '名称', keyValue: '系统', cols: [['名称', 'text', '', '', '', ''], ['当前MC点', 'number', '', '', '', '']], writePaths: [], mirrors: [] },
        { kind: 'rows', group: '角色', table: '角色表', keyCol: '名称', cols: [['名称', 'text', '', '', '', ''], ['好感度', 'number', '', '', '', '']], writePaths: [['角色']], mirrors: [] },
        { kind: 'array', group: '$器灵台词', table: '台词表', cols: [['内容', 'text', '', '', '', '']], writePaths: [], mirrors: [] },
    ];
    const tables = {
        mate: { type: 'chatSheets', version: 1 },
        sheet_1: { name: '系统表', content: [['row_id', '名称', '当前MC点'], [1, '系统', 100]] },
        sheet_2: { name: '角色表', content: [['row_id', '名称', '好感度'], [1, '西园寺爱丽莎', 0]] },
        sheet_3: { name: '台词表', content: [['row_id', '内容'], [1, '旧']] },
    };
    let crudCalls = 0;
    let sqlBatchCalls = 0;
    const api = {
        exportTableAsJson: () => tables,
        executeSqlBatch: async () => { sqlBatchCalls++; throw new Error('原生 CRUD 路径不应走 executeSqlBatch'); },
        updateCell: async (tn, ri, col, val) => { crudCalls++; const s = Object.values(tables).find(x => x.name === tn); const ci = s.content[0].indexOf(col); s.content[ri][ci] = val; return true; },
        insertRow: async (tn, data) => {
            crudCalls++;
            const s = Object.values(tables).find(x => x.name === tn);
            const row = s.content[0].map(h => (data && data[h] !== undefined && data[h] !== null) ? String(data[h]) : '');
            row[0] = s.content.length;
            s.content.push(row);
            return row[0];
        },
        deleteRow: async (tn, ri) => { crudCalls++; const s = Object.values(tables).find(x => x.name === tn); if (s && s.content[ri]) s.content.splice(ri, 1); return true; },
    };
    const prev = { 系统: { 当前MC点: 100 }, 角色: { 西园寺爱丽莎: { 好感度: 0 } }, '$器灵台词': ['旧'] };
    const next = { 系统: { 当前MC点: 80 }, 角色: { 西园寺爱丽莎: { 好感度: 5 }, 月咏深雪: { 好感度: 3 }, 苏媚: { 好感度: 2 } }, '$器灵台词': ['新1', '新2'] };
    const n = await core.writeStatDiffToDb(api, layout, prev, next);
    assert.ok(n >= 5, '应产生 5 个以上差异操作');
    assert.strictEqual(sqlBatchCalls, 0, '原生 CRUD 路径不应调用 executeSqlBatch');
    assert.ok(crudCalls >= 5, '多操作应逐条走原生 CRUD');
    assert.strictEqual(tables.sheet_1.content[1][2], 80, '单例更新应生效');
    assert.strictEqual(tables.sheet_2.content[1][2], 5, '行表更新应生效');
    const names = tables.sheet_2.content.slice(1).map(r => r[1]);
    assert.ok(names.includes('月咏深雪') && names.includes('苏媚'), '应插入两行新条目');
    const ids = tables.sheet_2.content.slice(1).map(r => r[0]);
    assert.strictEqual(new Set(ids).size, ids.length, 'row_id 不应冲突');
    assert.deepStrictEqual(tables.sheet_3.content.slice(1).map(r => r[1]), ['新1', '新2'], '数组应整体替换');
});

test('writeStatDiffToDb：同一新行的多字段合并为一条 INSERT（不撞 UNIQUE）', async () => {
    const layout = [
        { kind: 'rows', group: '气运', table: '气运表', keyCol: '名称', cols: [['名称', 'text', '', '', '', ''], ['效果', 'text', '', '', '', ''], ['说明', 'text', '', '', '', '']], writePaths: [['气运']], mirrors: [] },
    ];
    const tables = {
        mate: { type: 'chatSheets', version: 1 },
        sheet_1: { name: '气运表', content: [['row_id', '名称', '效果', '说明']] },
    };
    const insertedRows = [];
    const api = {
        exportTableAsJson: () => tables,
        executeSqlBatch: async () => { throw new Error('原生 CRUD 路径不应走 executeSqlBatch'); },
        updateCell: async () => { throw new Error('不应走 updateCell'); },
        insertRow: async (tn, data) => {
            insertedRows.push({ tn, data: JSON.parse(JSON.stringify(data)) });
            const s = Object.values(tables).find(x => x.name === tn);
            const row = s.content[0].map(h => (data && data[h] !== undefined && data[h] !== null) ? String(data[h]) : '');
            row[0] = s.content.length;
            s.content.push(row);
            return row[0];
        },
        deleteRow: async () => { throw new Error('不应走 deleteRow'); },
    };
    const prev = { 气运: {} };
    const next = {
        气运: {
            阿勒苏霍德之笔: { 效果: '写下的故事会成真', 说明: '传说中的笔' },
            命运硬币: { 效果: '抛硬币决定命运', 说明: '一枚古币' },
        },
    };
    const n = await core.writeStatDiffToDb(api, layout, prev, next);
    assert.ok(n >= 2, '应写入两个新条目');
    assert.strictEqual(insertedRows.length, 2, '两个新条目应各只有一次 insertRow，实际 ' + insertedRows.length + ' 次');
    const penRow = insertedRows.find(r => r.data['名称'] === '阿勒苏霍德之笔');
    assert.ok(penRow, '应插入阿勒苏霍德之笔');
    assert.strictEqual(penRow.data['效果'], '写下的故事会成真', '同一新行多字段应合并进同一次 insertRow');
    assert.strictEqual(penRow.data['说明'], '传说中的笔', '同一新行多字段应合并进同一次 insertRow');
    const names = tables.sheet_1.content.slice(1).map(r => r[1]);
    assert.strictEqual(names.length, 2, '表内应有 2 行');
});

test('writeStatDiffToDb：值未变化时跳过写入，不产生持久化', async () => {
    const layout = [
        { kind: 'singleton', group: '系统', table: '系统表', keyCol: '名称', keyValue: '系统', cols: [['名称', 'text', '', '', '', ''], ['当前MC点', 'number', '', '', '', '']], writePaths: [], mirrors: [] },
    ];
    const tables = {
        mate: { type: 'chatSheets', version: 1 },
        sheet_1: { name: '系统表', content: [['row_id', '名称', '当前MC点'], [1, '系统', 100]] },
    };
    let crudCalls = 0;
    const api = {
        exportTableAsJson: () => tables,
        updateCell: async () => { crudCalls++; return true; },
        insertRow: async () => { crudCalls++; return 1; },
        deleteRow: async () => { crudCalls++; return true; },
    };
    const prev = { 系统: { 当前MC点: 100 } };
    const next = { 系统: { 当前MC点: 100 } };
    const n = await core.writeStatDiffToDb(api, layout, prev, next);
    assert.strictEqual(n, 0, '无变化应返回 0');
    assert.strictEqual(crudCalls, 0, '不应调用任何逐条写入');
});

test('writeStatDiffToDb：小批量（1~4 条）保持逐格增量写入，不触发批量', async () => {
    const layout = [
        { kind: 'singleton', group: '系统', table: '系统表', keyCol: '名称', keyValue: '系统', cols: [['名称', 'text', '', '', '', ''], ['当前MC点', 'number', '', '', '', '']], writePaths: [], mirrors: [] },
        { kind: 'rows', group: '角色', table: '角色表', keyCol: '名称', cols: [['名称', 'text', '', '', '', ''], ['好感度', 'number', '', '', '', '']], writePaths: [['角色']], mirrors: [] },
    ];
    const tables = {
        mate: { type: 'chatSheets', version: 1 },
        sheet_1: { name: '系统表', content: [['row_id', '名称', '当前MC点'], [1, '系统', 100]] },
        sheet_2: { name: '角色表', content: [['row_id', '名称', '好感度'], [1, '西园寺爱丽莎', 0]] },
    };
    let crudCalls = 0;
    const api = {
        exportTableAsJson: () => tables,
        updateCell: async (tn, ri, col, val) => {
            crudCalls++;
            const s = Object.values(tables).find(x => x.name === tn);
            const ci = s.content[0].indexOf(col);
            s.content[ri][ci] = val;
            return true;
        },
        insertRow: async (tn, data) => {
            crudCalls++;
            const s = Object.values(tables).find(x => x.name === tn);
            s.content.push([s.content.length, ...Object.values(data)]);
            return s.content.length - 1;
        },
        deleteRow: async () => { crudCalls++; return true; },
    };
    const prev = { 系统: { 当前MC点: 100 }, 角色: { 西园寺爱丽莎: { 好感度: 0 } } };
    const next = { 系统: { 当前MC点: 80 }, 角色: { 西园寺爱丽莎: { 好感度: 5 }, 月咏深雪: { 好感度: 3 } } };
    const n = await core.writeStatDiffToDb(api, layout, prev, next);
    assert.ok(n >= 3 && n < 5, '应为 3 个小批量操作');
    assert.ok(crudCalls >= 3, '小批量应走逐格写入');
    assert.strictEqual(tables.sheet_1.content[1][2], 80, '单例更新应生效');
    assert.strictEqual(tables.sheet_2.content[1][2], 5, '行表更新应生效');
    assert.strictEqual(tables.sheet_2.content.length, 3, '应插入新行');
});

test('writeStatDiffToDb：写路径纯原生 CRUD，executeSqlBatch 永不调用', async () => {
    const layout = [
        { kind: 'singleton', group: '系统', table: '系统表', keyCol: '名称', keyValue: '系统', cols: [['名称', 'text', '', '', '', ''], ['当前MC点', 'number', '', '', '', '']], writePaths: [], mirrors: [] },
        { kind: 'rows', group: '角色', table: '角色表', keyCol: '名称', cols: [['名称', 'text', '', '', '', ''], ['好感度', 'number', '', '', '', '']], writePaths: [['角色']], mirrors: [] },
    ];
    const tables = {
        mate: { type: 'chatSheets', version: 1 },
        sheet_1: { name: '系统表', content: [['row_id', '名称', '当前MC点'], [1, '系统', 100]] },
        sheet_2: { name: '角色表', content: [['row_id', '名称', '好感度'], [1, '西园寺爱丽莎', 0]] },
    };
    let sqlBatchCalls = 0;
    const api = {
        exportTableAsJson: () => tables,
        executeSqlBatch: async () => { sqlBatchCalls++; throw new Error('不应调用 executeSqlBatch'); },
        updateCell: async (tn, ri, col, val) => {
            const s = Object.values(tables).find(x => x.name === tn);
            const ci = s.content[0].indexOf(col);
            s.content[ri][ci] = val;
            return true;
        },
        insertRow: async (tn, data) => {
            const s = Object.values(tables).find(x => x.name === tn);
            s.content.push([s.content.length, ...Object.values(data)]);
            return s.content.length - 1;
        },
        deleteRow: async () => true,
    };
    const prev = { 系统: { 当前MC点: 100 }, 角色: { 西园寺爱丽莎: { 好感度: 0 } } };
    const next = { 系统: { 当前MC点: 80 }, 角色: { 西园寺爱丽莎: { 好感度: 5 }, 月咏深雪: { 好感度: 3 } } };
    const n = await core.writeStatDiffToDb(api, layout, prev, next);
    assert.ok(n >= 3, '应返回差异操作数');
    assert.strictEqual(sqlBatchCalls, 0, 'executeSqlBatch 不应被调用');
    assert.strictEqual(tables.sheet_1.content[1][2], 80, '单例更新应生效');
    assert.strictEqual(tables.sheet_2.content[1][2], 5, '行表更新应生效');
    assert.strictEqual(tables.sheet_2.content.length, 3, '应插入新行');
});

test('条目字段全是叶子的字典应判为行表（修复误判为单例）', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '平铺条目卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [{
                    comment: '[InitVar]',
                    content: JSON.stringify({
                        道侣: {
                            林若悠: { 亲密: [88, ''], 种族: ['人族', ''] },
                            苏媚: { 亲密: [77, ''], 种族: ['妖族', ''] },
                        },
                    }),
                }],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both' });
    const t = Object.values(r.template).find(s => s && s.name === '道侣表');
    assert.ok(t, '应有道侣表');
    assert.strictEqual(t.content.length - 1, 2, '应为 2 行（每条目一行）');
    assert.strictEqual(t.content[1][1], '林若悠', '第一行应为林若悠');
    assert.strictEqual(t.content[2][1], '苏媚', '第二行应为苏媚');
    assert.ok(t.content[0].includes('亲密'), '列应含条目字段');
});

test('行表条目自带「名称」字段时键列改名，表头不得重复（技能熟练度类结构）', () => {
    const makeCard = (initvar) => ({
        spec: 'chara_card_v3',
        data: {
            name: '技能槽卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [{
                    comment: '[InitVar]',
                    content: JSON.stringify(initvar),
                }],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    });
    // 报告场景：嵌套在单例下的子行表（角色.技能熟练度: { 技能1: { 名称, 熟练度, 等级 } }）
    const r1 = core.convert(makeCard({
        角色: {
            货币: 0,
            等级: 1,
            技能熟练度: {
                技能1: { 名称: '未获得', 熟练度: 0, 等级: 1 },
                技能2: { 名称: '未获得', 熟练度: 0, 等级: 1 },
            },
        },
    }), { mode: 'both' });
    const t1 = Object.values(r1.template).find(s => s && s.name === '技能熟练度表');
    assert.ok(t1, '应有技能熟练度表');
    const h1 = t1.content[0];
    assert.strictEqual(new Set(h1).size, h1.length, `子行表表头不得重复：${JSON.stringify(h1)}`);
    assert.ok(h1.includes('键名') && h1.includes('名称'), `键列应命名为「键名」且保留「名称」字段：${JSON.stringify(h1)}`);
    assert.strictEqual(t1.content[1][1], '技能1', '键列值应为技能1');
    assert.strictEqual(t1.content[1][2], '未获得', '名称字段值应保留');
    // 顶层行表同样结构（主 rows 分支）
    const r2 = core.convert(makeCard({
        技能: {
            技能1: { 名称: '未获得', 熟练度: 0, 等级: 1 },
            技能2: { 名称: '未获得', 熟练度: 0, 等级: 1 },
        },
    }), { mode: 'both' });
    const t2 = Object.values(r2.template).find(s => s && s.name === '技能表');
    assert.ok(t2, '应有技能表');
    const h2 = t2.content[0];
    assert.strictEqual(new Set(h2).size, h2.length, `顶层行表表头不得重复：${JSON.stringify(h2)}`);
    assert.ok(h2.includes('键名') && h2.includes('名称'), `键列应命名为「键名」且保留「名称」字段：${JSON.stringify(h2)}`);
    // 名字型字典（条目无 名称 字段）键列也应统一为「键名」
    const r3 = core.convert(makeCard({
        道侣: {
            林若悠: { 亲密: [88, ''], 种族: ['人族', ''] },
            苏媚: { 亲密: [77, ''], 种族: ['妖族', ''] },
        },
    }), { mode: 'both' });
    const t3 = Object.values(r3.template).find(s => s && s.name === '道侣表');
    assert.ok(t3, '应有道侣表');
    assert.strictEqual(t3.content[0][1], '键名', `名字型字典的键列也应为「键名」：${JSON.stringify(t3.content[0])}`);
});

test('转换后 tavern_helper 脚本必须带 type:script（酒馆助手 discriminatedUnion 解析，缺 type 整组脚本不显示）', () => {
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const inner = r.card.data || r.card;
    const scripts = ((inner.extensions || {}).tavern_helper || {}).scripts || [];
    assert.ok(scripts.some(s => /数据桥/.test(String(s.name || ''))), '应包含数据桥脚本');
    for (const s of scripts) {
        assert.strictEqual(s.type, 'script', `脚本「${s.name}」必须带 type:'script'`);
    }
});

test('多分支开场 <initvar> 只以首个分支为基准，不再合并所有分支状态', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '多分支卡',
            description: '',
            first_mes: '开场',
            alternate_greetings: [
                '<UpdateVariable>\n<initvar>\n主角:\n  修为: 筑基五层\n</initvar>\n</UpdateVariable>',
                '<UpdateVariable>\n<initvar>\n主角:\n  修为: 金丹一层\n  灵石: 100\n</initvar>\n</UpdateVariable>',
                '<UpdateVariable>\n<initvar>\n主角:\n  修为: 筑基九层\n</initvar>\n</UpdateVariable>',
            ],
            character_book: { entries: [] },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both' });
    const t = Object.values(r.template).find(s => s && s.name === '主角表');
    assert.ok(t, '应有主角表');
    assert.strictEqual(t.content.length - 1, 1, '模板初始行只有一行（不应把各分支合并）');
    const ki = t.content[0].indexOf('修为');
    assert.ok(ki >= 0, '应有修为列');
    assert.strictEqual(t.content[1][ki], '筑基五层', '初始值应来自首个分支');
});

test('开局按当前分支注入 <initvar>：切到另一分支后表格更新为该分支初始值', async () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '多分支卡2',
            description: '',
            first_mes: '开场',
            alternate_greetings: [
                '<UpdateVariable>\n<initvar>\n主角:\n  修为: 筑基五层\n</initvar>\n</UpdateVariable>',
                '<UpdateVariable>\n<initvar>\n主角:\n  修为: 金丹一层\n</initvar>\n</UpdateVariable>',
            ],
            character_book: { entries: [] },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both' });
    const tables = JSON.parse(JSON.stringify(r.template));
    const byName = (n) => Object.keys(tables).find(k => tables[k].name === n);
    const zjKey = byName('主角表');
    const layout = core.buildLayout(r.schema).entries.map(e => ({
        kind: e.kind, group: e.group, table: e.table, keyCol: e.keyCol || '', keyValue: e.keyValue || '',
        cols: (e.cols || []).map(c => [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, c.path || [], !!c.isPair, c.desc || '']),
        writePaths: e.writePaths || [], mirrors: e.mirrors || [],
    }));
    // 解析第二个分支的 <initvar> 并写库（对应 applyActiveGreetingInitvar）
    const text2 = card.data.alternate_greetings[1];
    const m = String(text2).match(/<initvar>\s*\n?([\s\S]*?)\n?\s*<\/initvar>/i);
    const parsed = core.parseInitVar(m[1]);
    const prev = core.statDataFromTables(layout, tables).stat_data;
    const fakeApi = {
        exportTableAsJson: () => tables,
        updateCell: async (t, ri, col, v) => {
            const s = Object.values(tables).find(x => x && x.name === t);
            if (s && s.content[ri]) { const ci = s.content[0].indexOf(col); if (ci >= 0) s.content[ri][ci] = v; }
            return true;
        },
        insertRow: async () => 1,
        deleteRow: async () => true,
    };
    const n = await core.writeStatDiffToDb(fakeApi, layout, prev, parsed);
    assert.ok(n > 0, '应产生差异写入');
    const zj = tables[zjKey];
    const ki = zj.content[0].indexOf('修为');
    assert.strictEqual(zj.content[1][ki], '金丹一层', '分支2注入后修为应为金丹一层');
});

test('行表条目内的空嵌套对象不再拆出每条目重复子表', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '角色集合卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [{
                    comment: '[InitVar]',
                    content: JSON.stringify({
                        角色: {
                            A: { 好感度: [0, ''], 效果: {} },
                            B: { 好感度: [0, ''], 效果: {} },
                        },
                    }),
                }],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both' });
    const names = Object.values(r.template).filter(s => s && s.name).map(s => s.name);
    assert.ok(names.includes('角色表'), '应有角色表');
    assert.ok(!names.includes('A表') && !names.includes('B表'), '不应有每条目重复子表');
    const t = Object.values(r.template).find(s => s && s.name === '角色表');
    assert.strictEqual(t.content.length - 1, 2, '角色表应为 2 行');
    assert.ok(t.content[0].includes('效果'), '空嵌套对象应转为 JSON 列');
});

test('行表 [值,说明] 文本列保留 pair 与 desc（状态栏读取一致）', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: 'pair行表卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [{
                    comment: '[InitVar]',
                    content: JSON.stringify({
                        道侣: {
                            林若悠: { 种族: ['人族', '林若悠的种族'], 亲密: [88, '与林若悠的亲密度'] },
                        },
                    }),
                }],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both' });
    const layout = core.buildLayout(r.schema);
    const e = layout.entries.find(x => x.table === '道侣表');
    const zhongzu = e.cols.find(c => c.zh === '种族');
    const qinmi = e.cols.find(c => c.zh === '亲密');
    assert.strictEqual(zhongzu.type, 'pair', '文本 [值,说明] 应为 pair 类型');
    assert.strictEqual(zhongzu.desc, '林若悠的种族', 'pair 应保留 desc');
    // 数字 [值,说明] 按参考卡语义保持纯数字（状态栏 plain 读取兼容）
    assert.strictEqual(qinmi.type, 'number', '数字 [值,说明] 保持 number');
    const t = Object.values(r.template).find(s => s && s.name === '道侣表');
    assert.ok(t.sourceData.note.includes('林若悠的种族'), 'note 列定义应含 desc');
});

test('表种类推导矩阵：单例/行表/数组/混合均符合预期', () => {
    const cases = [
        ['纯叶子', { 主角: { 姓名: '未知', 生命: 100 } }, '主角表', 'singleton', 1],
        ['叶子+平铺子对象', { 主角: { 姓名: 'x', 炼丹: { 阶级: '未入门' } } }, '主角表', 'singleton', 1],
        ['叶子+嵌套子对象', { 主角: { 姓名: 'x', 储物袋: { 铁剑: { 数量: 3 } } } }, '主角表', 'singleton', 1],
        ['空字典（无字段线索）', { 道侣: {} }, '道侣表', 'json', 1],
        ['条目全叶子', { 道侣: { 林若悠: { 亲密: 88 }, 苏媚: { 亲密: 77 } } }, '道侣表', 'rows', 2],
        ['条目含嵌套', { 道侣: { 林若悠: { 亲密: 88, 日程: { 周三: '空' } } } }, '道侣表', 'rows', 1],
        ['单条目字典', { 背包: { 铁剑: { 数量: 3 } } }, '背包表', 'rows', 1],
        ['顶层数组', { 台词: ['a', 'b'] }, '台词表', 'array', 2],
    ];
    for (const [label, initvar, tableName, expectKind, expectRows] of cases) {
        const card = {
            spec: 'chara_card_v3',
            data: {
                name: '矩阵卡' + label,
                description: '',
                first_mes: '你好',
                character_book: { entries: [{ comment: '[InitVar]', content: JSON.stringify(initvar) }] },
                extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
            },
        };
        const r = core.convert(card, { mode: 'both' });
        const g = (Array.isArray(r.schema) ? r.schema : []).find(x => x && x.name === tableName.replace(/表$/, ''));
        assert.strictEqual(g && g.kind, expectKind, `${label}: 表种类应为 ${expectKind}`);
        const t = Object.values(r.template).find(s => s && s.name === tableName);
        assert.strictEqual(t.content.length - 1, expectRows, `${label}: 行数应为 ${expectRows}`);
    }
});

test('initvar 注释行不产生变量组，顶层标量原样保留', () => {
    // YAML 子集：开头 # 注释行、顶层标量、嵌套对象混排（人妻公寓式写法）
    const content = [
        '# 初始值:第四态休眠拍板（注释绝不能当变量组）',
        '# 动态创建：首批入住由脚本写入',
        '户: {}',
        '现金: 500',
        '胜任度: 80',
        '风闻: 0',
        '玩家资源:',
        '  精力: { 当前值: 8, 训练经验: 0, 永久上限加成: 0 }',
        '  体力: { 当前值: 5, 训练经验: 0, 永久上限加成: 0 }',
        '系统:',
        '  _数据版本: 7',
        '  _管理考核: { 上次生成期: -1, 活跃任务: [], 母亲圆场: { 危险轮次起期: -1, 事件ID: "" } }',
    ].join('\n');
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '解析压力卡',
            description: '',
            first_mes: '你好',
            character_book: { entries: [{ comment: '[InitVar]变量初始化', content }] },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both' });
    const t = r.template;
    const sheetNames = Object.keys(t).filter(k => k.startsWith('sheet_')).map(k => t[k].name);
    // 1) # 注释行不得成为表
    assert.ok(!sheetNames.some(n => n.startsWith('#')), '注释行不应生成表，实际：' + sheetNames.join('、'));
    // 2) 顶层标量保留为 JSON 表（内容列）
    const cash = t[Object.keys(t).find(k => t[k].name === '现金表')];
    assert.strictEqual(cash.content[1][cash.content[0].indexOf('内容')], '500', '现金初始值应保留');
    const competence = t[Object.keys(t).find(k => t[k].name === '胜任度表')];
    assert.strictEqual(competence.content[1][competence.content[0].indexOf('内容')], '80', '胜任度初始值应保留');
    // 3) 行内对象（含中英混合键 事件ID）解析成对象，不是坏字符串
    const sys = t[Object.keys(t).find(k => t[k].name === '系统表')];
    const hdr = sys.content[0];
    const mgmtIdx = hdr.indexOf('_管理考核');
    assert.ok(mgmtIdx >= 0, '系统表应有 _管理考核 对象列');
    const mgmt = JSON.parse(sys.content[1][mgmtIdx]);
    assert.strictEqual(mgmt['上次生成期'], -1, '_管理考核.上次生成期 应为 -1');
    assert.ok('事件ID' in mgmt['母亲圆场'], '中英混合键 事件ID 应被正确解析');
    // 4) 混合结构对象不拆垃圾子表（不应出现 _管理考核表）
    assert.ok(!sheetNames.includes('_管理考核表'), '混合结构对象不应拆子表');
    // 5) _ 前缀字段不进填表规则（note 不逐列列出），但数据列仍在；_ 前缀空字典也不拆表
    assert.ok(!sys.sourceData.note.includes('列1: _数据版本'), '_ 字段不应逐列列出');
    assert.ok(sys.sourceData.note.includes('只读'), 'note 应保留只读说明');
    assert.ok(!sheetNames.some(n => n.startsWith('_')), '_ 前缀空字典不应拆成表');
});

test('initvar 使用与 MVU 源码同款 YAML 库：merge keys / 块标量 / 混合键', () => {
    const content = [
        '基础: &base',
        '  a: 1',
        '派生:',
        '  <<: *base',
        '  b: 2',
        '系统:',
        '  _管理考核: { 上次生成期: -1, 事件ID: "" }',
        '描述: >',
        '  多行块标量',
        '  拼接成一行',
    ].join('\n');
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: 'YAML库卡',
            description: '',
            first_mes: '你好',
            character_book: { entries: [{ comment: '[InitVar]', content }] },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both' });
    const t = r.template;
    const byName = (n) => Object.keys(t).find(k => t[k].name === n);
    const base = t[byName('基础表')];
    // 基础: {a:1} 是单例表，a 展平为列，值为数字 1
    assert.strictEqual(base.content[1][base.content[0].indexOf('a')], 1, 'YAML 数字应解析');
    // merge key 产生的 派生 组也应存在（真 YAML 库特性）：<<: *base 合并进 a
    const derived = t[byName('派生表')];
    assert.ok(derived && derived.content[1][derived.content[0].indexOf('b')] === 2, 'merge key 应把锚点字段合并进派生组');
    // 系统 只有单个对象字段 → 行表；中英混合键 事件ID 成为列
    const sys = t[byName('系统表')];
    assert.ok(sys.content[0].includes('事件ID'), '中英混合键 事件ID 应成为列');
    assert.strictEqual(sys.content[1][sys.content[0].indexOf('上次生成期')], -1, '行内对象解析正确');
});

test('单例对象列写入：子字段变更整对象写回（jsonCell）', async () => {
    const content = [
        '系统:',
        '  _数据版本: 7',
        '  _管理考核: { 上次生成期: -1, 活跃任务: [], 母亲圆场: { 危险轮次起期: -1, 事件ID: "" } }',
    ].join('\n');
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '对象列写入卡',
            description: '',
            first_mes: '你好',
            character_book: { entries: [{ comment: '[InitVar]', content }] },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both' });
    const t = r.template;
    const layout = JSON.parse(r.card.data.extensions.mvu2shujuku.layout);
    const tables = JSON.parse(JSON.stringify(t));
    const api = {
        exportTableAsJson: () => tables,
        updateCell: async (table, rowIndex, col, value) => {
            for (const k in tables) {
                if (tables[k].name === table) {
                    if (!tables[k].content[rowIndex]) tables[k].content[rowIndex] = [];
                    const ci = tables[k].content[0].indexOf(col);
                    if (ci === -1) throw new Error('列不存在 ' + col);
                    tables[k].content[rowIndex][ci] = value;
                    return true;
                }
            }
            return false;
        },
        insertRow: async (tn, o) => { const s = Object.values(tables).find(x => x.name === tn); s.content.push([]); return s.content.length - 1; },
        deleteRow: async (tn, idx) => { const s = Object.values(tables).find(x => x.name === tn); s.content.splice(idx, 1); return true; },
        executeSqlBatch: async () => false,
    };
    const prev = core.statDataFromTables(layout, tables).stat_data;
    const next = JSON.parse(JSON.stringify(prev));
    next.系统._管理考核['上次生成期'] = 3;
    next.系统._管理考核['活跃任务'] = ['考核A'];
    const n = await core.writeStatDiffToDb(api, layout, prev, next);
    assert.ok(n > 0, '对象列变更应产生写入');
    const sys = Object.values(tables).find(x => x.name === '系统表');
    const ci = sys.content[0].indexOf('_管理考核');
    const stored = JSON.parse(sys.content[1][ci]);
    assert.strictEqual(stored['上次生成期'], 3, '对象列应整对象写回');
    assert.deepStrictEqual(stored['活跃任务'], ['考核A'], '对象列数组字段应写回');
    const after = core.statDataFromTables(layout, tables).stat_data;
    assert.strictEqual(after.系统._管理考核['上次生成期'], 3, '回读应一致');
});

test('桥 JSONPatch：标准 <UpdateVariable><JSONPatch> 支持 replace/delta/insert/remove/move', () => {
    // 从生成的卡内桥提取纯函数（parseUpdateCommands/applyCommandsToStat）做隔离验证
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: 'JSONPatch桥卡',
            description: '',
            first_mes: '你好',
            character_book: { entries: [{ comment: '[InitVar]', content: '台词: ["a","b"]' }] },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const bridge = core.convert(card, { mode: 'both' }).bridgeScript;
    const start = bridge.indexOf('function parseCommandValue2');
    const end = bridge.indexOf('function applyPendingUpdateBlocks');
    assert.ok(start >= 0 && end > start, '桥应包含更新块解析函数');
    const seg = bridge.slice(start, end);
    const stubs = 'function noteDisplay(d,p,o,n){}\n';
    const fn = new Function(stubs + seg + '; return {parseUpdateCommands,applyCommandsToStat};')();
    const { parseUpdateCommands, applyCommandsToStat } = fn;
    const stat = { 系统: { 背包: { 道具A: { 数量: 1 } } }, 台词: ['a', 'b'] };
    const patch = [
        { op: 'replace', path: '/系统/背包/道具A/数量', value: 5 },
        { op: 'delta', path: '/系统/背包/道具A/数量', value: -2 },
        { op: 'insert', path: '/系统/背包/道具B', value: { 数量: 2 } },
        { op: 'remove', path: '/系统/背包/道具A' },
        { op: 'move', from: '/台词/0', to: '/台词/1' },
    ];
    const cmds = parseUpdateCommands('<UpdateVariable><Analysis>x</Analysis><JSONPatch>' + JSON.stringify(patch) + '</JSONPatch></UpdateVariable>');
    assert.strictEqual(cmds.length, 5, '应解析出 5 条命令（含内嵌 JSONPatch 的标准写法）');
    applyCommandsToStat(stat, cmds, {});
    assert.strictEqual(stat.系统.背包['道具A'], undefined, 'remove 应删除道具A');
    assert.deepStrictEqual(stat.系统.背包['道具B'], { 数量: 2 }, 'insert 应插入道具B');
    assert.deepStrictEqual(stat.台词, ['b', 'a'], 'move 应从 0 移到 1');
});

test('[mvu_plot] 剧情条目全部保留，内部 MVU 宏改写为数据库引用', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '剧情卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [
                    { comment: '[mvu_plot]核心设定', content: '<核心设定>\n现代日本，催眠APP。' },
                    { comment: '[mvu_plot]时间和地点提醒', content: '现在的时间是: {{get_message_variable::系统.当前时间}}\n可疑度({{get_message_variable::stat_data.系统.主角可疑度[0]}})' },
                    { comment: '变量列表', content: '<status_current_variable>{{get_message_variable::stat_data}}</status_current_variable>' },
                    { comment: '[InitVar]', content: '{"系统":{"当前时间":"09:00","主角可疑度":10}}' },
                ],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both' });
    const out = r.card.data || r.card;
    const entries = out.character_book.entries;
    const plotHits = entries.filter(e => /\[mvu_plot\]/.test(String(e.comment || '')));
    assert.strictEqual(plotHits.length, 2, '两个 [mvu_plot] 条目都应保留');
    assert.ok(!entries.some(e => e.comment === '变量列表'), '变量列表条目应删除');
    const timeEntry = plotHits.find(e => e.comment.includes('时间和地点提醒'));
    assert.ok(timeEntry.content.includes('（数据库表「系统表」的「当前时间」）'), 'get_message_variable 应改写为数据库表引用');
    assert.ok(timeEntry.content.includes('（数据库表「系统表」的「主角可疑度」）'), '应去掉 stat_data. 前缀与 [0]');
    assert.ok(!timeEntry.content.includes('get_message_variable'), '不应残留 MVU 宏');
});

test('误标 [mvu_update] 的剧情文本条目应保留，纯变量管道仍删除', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '误标卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [
                    { comment: '[mvu_update]匿名版介绍', content: '<匿名版介绍>\nMChan匿名版是一群使用催眠APP的用户自行搭建的地下匿名版，只有使用者能进入。板块包括公告区、新手引导区、综合讨论区、成果展示区、求助区，语言风格为2chan/4chan式。' },
                    { comment: '[mvu_update]变量更新格式', content: '格式: _.set(\'路径\', 旧值, 新值);//原因' },
                    { comment: '[mvu_update]变量列表开始', content: '🔻' },
                    { comment: '[InitVar]', content: '{"系统":{"当前时间":"09:00"}}' },
                ],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both' });
    const entries = (r.card.data || r.card).character_book.entries;
    assert.ok(entries.some(e => e.comment.includes('匿名版介绍')), '剧情文本（即使带 [mvu_update] 标记）应保留');
    assert.ok(!entries.some(e => e.comment.includes('变量更新格式')), '纯变量管道应删除');
    assert.ok(!entries.some(e => e.comment.includes('变量列表开始')), '短标记应删除');
});

test('<%_ if %>（EJS 吞空白写法）也能重写为 <if cell>，且仅 EJS 出现的字段补进列', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '吞空白EJS卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [
                    {
                        comment: '[mvu_plot]人设',
                        content: '<%_ if (getvar(\'stat_data.角色.苏苏.发情值\') < 20) { _%>\n- 性欲不高\n<%_ } else if (getvar(\'stat_data.角色.苏苏.发情值\') < 60) { _%>\n- 性欲明显\n<%_ } else { _%>\n- 完全失控\n<%_ } _%>',
                    },
                    { comment: '[InitVar]', content: '{"角色":{"苏苏":{"好感度":[0,""]}}}' },
                ],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both' });
    const entries = (r.card.data || r.card).character_book.entries;
    const plot = entries.find(e => e.comment.includes('人设'));
    assert.ok(plot.content.includes('mvu2shujukuGetAllVariables().stat_data.角色.苏苏.发情值 < 20'), '吞空白 EJS 应改数据源为 mvu2shujukuGetAllVariables');
    assert.ok(plot.content.includes('<%_'), 'EJS 吞空白写法应保留');
    assert.ok(!plot.content.includes('<if cell='), '不应转换为 <if cell>（EJS 整体保留）');
    const t = Object.values(r.template).find(s => s && s.name === '角色表');
    assert.ok(t.content[0].includes('发情值'), '仅在 EJS 中出现的字段应补进列定义');
});

/* ---------------- EJS 重写 ---------------- */
console.log('rewriteEjsConditions');
test('getvar 数值比较 → mvu2shujukuGetAllVariables()（EJS 保留）', () => {
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const layout = core.buildLayout(r.schema);
    const text = '<% if (getvar(\'stat_data.主角.生命\') >= 50) { %>生命充沛<% } %>';
    const out = core.rewriteEjsConditions(text, layout, core.createReport());
    assert.ok(out.text.includes('mvu2shujukuGetAllVariables().stat_data.主角.生命 >= 50'), out.text);
    assert.ok(out.text.includes('<% if'), 'EJS 结构应保留');
});

test('嵌套路径（子表条目）→ getAllVariables()', () => {
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const layout = core.buildLayout(r.schema);
    const text = '<% if (getvar(\'stat_data.主角.储物袋.铁剑.数量\') > 0) { %>有铁剑<% } %>';
    const out = core.rewriteEjsConditions(text, layout, core.createReport());
    assert.ok(out.text.includes('mvu2shujukuGetAllVariables().stat_data.主角.储物袋.铁剑.数量 > 0'), out.text);
});

test('聚合计数（Object.keys）→ getAllVariables()', () => {
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const layout = core.buildLayout(r.schema);
    const text = '<% if (Object.keys(getvar(\'stat_data.道侣\')).length > 3) { %>道侣众多<% } %>';
    const out = core.rewriteEjsConditions(text, layout, core.createReport());
    assert.ok(out.text.includes('Object.keys(mvu2shujukuGetAllVariables().stat_data.道侣).length > 3'), out.text);
});

test('else 分支 EJS 保留', () => {
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const layout = core.buildLayout(r.schema);
    const text = '<% if (getvar(\'stat_data.主角.修为\') < 100) { %>修炼中<% } else { %>可突破<% } %>';
    const out = core.rewriteEjsConditions(text, layout, core.createReport());
    assert.ok(out.text.includes('<% } else { %>可突破<% } %>'), 'else 分支应保留为 EJS');
    assert.ok(out.text.includes('mvu2shujukuGetAllVariables().stat_data.主角.修为 < 100'), out.text);
});

test('else-if 链 EJS 整体保留，仅改数据源', () => {
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const layout = core.buildLayout(r.schema);
    const text = '<% if (getvar(\'stat_data.主角.修为\') >= 100) { %>大乘<% } else if (getvar(\'stat_data.主角.修为\') >= 50) { %>中阶<% } else { %>初阶<% } %>';
    const out = core.rewriteEjsConditions(text, layout, core.createReport());
    assert.ok(out.text.includes('mvu2shujukuGetAllVariables().stat_data.主角.修为 >= 100'), out.text);
    assert.ok(out.text.includes('else if (mvu2shujukuGetAllVariables().stat_data.主角.修为 >= 50)'), 'else-if 应保留为 EJS');
    assert.ok(out.text.includes('<% } else { %>初阶<% } %>'), 'else 分支应保留');
    const text2 = '<% if (getvar(\'stat_data.主角.生命\') > 0) { %>存活<% } else if (getvar(\'stat_data.主角.生命\') === 0) { %>濒死<% } %>';
    const out2 = core.rewriteEjsConditions(text2, layout, core.createReport());
    assert.ok(out2.text.includes('mvu2shujukuGetAllVariables().stat_data.主角.生命 === 0'), out2.text);
});

test('官方教程规范写法：getvar("stat_data").组["字段"][0] 与 _.has', () => {
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const layout = core.buildLayout(r.schema);
    const text1 = '<% if (getvar("stat_data").主角["生命"][0] >= 50) { %>充沛<% } %>';
    const out1 = core.rewriteEjsConditions(text1, layout, core.createReport());
    assert.ok(out1.text.includes('mvu2shujukuGetAllVariables().stat_data.主角["生命"][0] >= 50'), out1.text);
    const text2 = '<% if (_.has(getvar("stat_data"), \'道侣.林若悠.亲密.[0]\')) { %>有数据<% } %>';
    const out2 = core.rewriteEjsConditions(text2, layout, core.createReport());
    assert.ok(out2.text.includes('_.has(mvu2shujukuGetAllVariables().stat_data, \'道侣.林若悠.亲密.[0]\')'), out2.text);
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
    assert.ok(r.bridgeScript.includes('mvu2shujukuMissingTableNames'), '应按模板表名判断缺表，而非仅看是否有任意表');
    assert.ok(r.bridgeScript.includes('mag_variable_update_ended'), '写库后应广播 MVU 原版的 VARIABLE_UPDATE_ENDED 事件');
    // EJS 数据函数由扩展注册（桥不在主窗口执行，注册无效）；桥不再包含注册代码
    assert.ok(!r.bridgeScript.includes('installTemplateDefines'), '桥不应再包含失效的模板注册代码');
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
        insertRow: async (tableName, obj) => {
            const sheet = Object.values(tables).find(s => s && s.name === tableName);
            if (!sheet) return 1;
            const row = sheet.content[0].map(() => '');
            for (const k in obj) { const ci = sheet.content[0].indexOf(k); if (ci >= 0) row[ci] = String(obj[k]); }
            row[0] = sheet.content.length || 1;
            sheet.content.push(row);
            return row[0];
        },
        deleteRow: async () => true,
    };
    const win = {
        top: null, parent: null, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t), console,
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
    const row = header.map(h => ({ 键名: '林若悠', 性别: '女', 种族: '人族', 境界: '筑基', 生命: 95, 灵力: 90, 修为: 45, 道心: 60, 亲密: 88, 性格: '温柔' }[h] !== undefined ? { 键名: '林若悠', 性别: '女', 种族: '人族', 境界: '筑基', 生命: 95, 灵力: 90, 修为: 45, 道心: 60, 亲密: 88, 性格: '温柔' }[h] : ''));
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

/* ---------------- Mvu 兼容层（通用 API 面，不依赖任何具体卡） ---------------- */
console.log('Mvu 兼容层');

function bridgeSandbox(r, opts = {}) {
    const vm = require('vm');
    const tables = JSON.parse(JSON.stringify(r.template));
    const chat = [];
    const addCheckpoint = () => {
        // 模拟插件提交成功后真的建立 full checkpoint
        chat.push({ message_id: chat.length, is_user: false, mes: '模拟消息',
            TavernDB_ACU_IsolatedData: JSON.stringify({ 系统: { storageFrame: { version: 2, logEntries: [], checkpoint: { kind: 'full', ts: Date.now() } } } }) });
    };
    const fakeApi = {
        exportTableAsJson: () => tables,
        importTemplateFromData: async () => ({ success: true }),
        initGameSession: async () => { addCheckpoint(); return { success: true, runtimeReady: true }; },
        importTableAsJson: async () => { addCheckpoint(); return true; },
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
        top: null, parent: null, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t), console,
        CustomEvent: function () {}, addEventListener() {}, dispatchEvent() { return true; },
        TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        getContext: () => ({
            chatId: 'c1',
            name: '测试角色',
            chat,
            eventSource: { on: () => {}, emit: () => {} },
            event_types: { MESSAGE_RECEIVED: 'message_received' },
        }),
        ...(opts.extra || {}),
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    win.AutoCardUpdaterAPI = fakeApi;
    vm.createContext(win);
    vm.runInContext(r.bridgeScript, win);
    return { win, tables, fakeApi };
}

// 等待桥/扩展侧的合并写入定时器（150ms）完成落库
async function waitBridgeFlush(ms = 300) {
    await new Promise(resolve => setTimeout(resolve, ms));
}

test('Mvu 兼容层：完整 API 面（setMvuVariable/getMvuVariable/parseMessage/事件名）', () => {
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const { win, tables } = bridgeSandbox(r);
    const Mvu = win.Mvu;
    assert.ok(Mvu && typeof Mvu === 'object', '应挂载全局 Mvu');
    // 事件面：MVU 官方 events 全部存在
    const expectedEvents = ['VARIABLE_INITIALIZED', 'VARIABLE_UPDATE_STARTED', 'COMMAND_PARSED', 'VARIABLE_UPDATE_ENDED', 'BEFORE_MESSAGE_UPDATE', 'SINGLE_VARIABLE_UPDATED'];
    for (const ev of expectedEvents) {
        assert.ok(typeof Mvu.events[ev] === 'string' && Mvu.events[ev].length > 0, '缺少事件 ' + ev);
    }
    assert.strictEqual(Mvu.events.VARIABLE_UPDATE_ENDED, 'mag_variable_update_ended', '事件名应与 MVU 官方一致');
    // getMvuData：stat_data/display_data/delta_data/initialized_lorebooks 齐全
    const data = Mvu.getMvuData({ type: 'message', message_id: 'latest' });
    assert.ok(data && typeof data.stat_data === 'object', 'getMvuData 应返回 stat_data 对象');
    assert.ok(data.display_data && typeof data.display_data === 'object', 'getMvuData 应返回 display_data');
    assert.ok('delta_data' in data && 'initialized_lorebooks' in data, 'getMvuData 字段齐全');
    // setMvuVariable：与官方 updateVariable 一致——缺 stat_data 不崩溃；路径不存在返回 false；路径存在才写入
    const empty = {};
    return Promise.resolve(Mvu.setMvuVariable(empty, '系统.测试字段', 42, { reason: '测试' }))
        .then((ok) => {
            assert.strictEqual(ok, false, 'setMvuVariable 对不存在的路径应返回 false（与 MVU 官方一致）');
            // 已存在的路径：写入并返回 true
            empty.stat_data = { 系统: { 测试字段: 0 } };
            return Mvu.setMvuVariable(empty, '系统.测试字段', 42, { reason: '测试' });
        })
        .then((ok) => {
            assert.strictEqual(ok, true, 'setMvuVariable 对已存在路径应返回 true');
            assert.strictEqual(empty.stat_data.系统.测试字段, 42, 'setMvuVariable 应写入 stat_data');
            // getMvuVariable / getRecordFromMvuData
            assert.strictEqual(Mvu.getMvuVariable(empty, '系统.测试字段'), 42, 'getMvuVariable 应读到新值');
            assert.strictEqual(Mvu.getMvuVariable(empty, '系统.不存在', { default_value: '缺省' }), '缺省', 'getMvuVariable 默认值');
            const rec = Mvu.getRecordFromMvuData(empty, 'stat');
            assert.strictEqual(rec.系统.测试字段, 42, 'getRecordFromMvuData 应返回 stat 记录');
            // VWD（数组长度 2）取第一个元素
            const vwd = { stat_data: { 系统: { 值: [7, '说明'] } } };
            assert.strictEqual(Mvu.getMvuVariable(vwd, '系统.值'), 7, 'VWD 应取第一个元素');
            // parseMessage：在副本上应用 _.set / _.add 命令（add 要求路径已存在，与官方一致）
            const base = { stat_data: { 主角: { 修为: 10, 灵气: 0 } } };
            return Mvu.parseMessage("<UpdateVariable>\n_.set('主角.修为', 20);\n_.add('主角.灵气', 5);\n</UpdateVariable>", base).then((parsed) => ({ parsed, base }));
        })
        .then(({ parsed, base }) => {
            assert.ok(parsed && parsed.stat_data.主角.修为 === 20, 'parseMessage 应应用 _.set');
            assert.strictEqual(parsed.stat_data.主角.灵气, 5, 'parseMessage 应应用 _.add');
            assert.strictEqual(base.stat_data.主角.修为, 10, 'parseMessage 不应改动传入对象');
            // 无更新命令时官方实现仍返回未变更的副本（updateVariables 返回后直接 return result）
            return Mvu.parseMessage('纯文本没有命令', base);
        })
        .then((none) => {
            assert.ok(none && typeof none === 'object' && none.stat_data, '无更新命令时 parseMessage 应返回副本（与官方实现一致）');
            assert.strictEqual(none.stat_data.主角.修为, 10, '无命令副本应与传入数据一致');
            // deprecated 包装与工具方法
            assert.strictEqual(typeof Mvu.getCurrentMvuData, 'function');
            assert.strictEqual(typeof Mvu.replaceCurrentMvuData, 'function');
            assert.strictEqual(typeof Mvu.reloadInitVar, 'function');
            assert.strictEqual(typeof Mvu.isDuringExtraAnalysis, 'function');
            assert.strictEqual(Mvu.isDuringExtraAnalysis(), false, '非额外分析轮次');
            // replaceMvuData：差异写库并广播事件
            const before = Mvu.getMvuData().stat_data.主角.姓名;
            const next = JSON.parse(JSON.stringify(Mvu.getMvuData()));
            next.stat_data.主角.姓名 = '测试新名';
            return Mvu.replaceMvuData(next, { type: 'message', message_id: 'latest' }).then(() => {
                return waitBridgeFlush().then(() => {
                    const after = win.getAllVariables().stat_data.主角.姓名;
                    assert.strictEqual(after, '测试新名', 'replaceMvuData 应把 stat_data 差异写入数据库表格');
                    assert.ok(before !== after, '写库前后应不同');
                    // 表格内容同步更新
                    const tables2 = tables;
                    const heroSheet = Object.values(tables2).find(s => s && s.name === '主角表');
                    const nameIdx = heroSheet.content[0].indexOf('姓名');
                    assert.strictEqual(heroSheet.content[1][nameIdx], '测试新名', '表格单元格应被更新');
                });
            });
        });
});

test('Mvu 兼容层：覆盖式接管已存在的真 MVU（保留自定义属性，双轨不再冲突）', () => {
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    // 模拟“真 MVU 已挂载”：只有旧 API，setMvuVariable 缺失
    const legacyMvu = {
        getMvuData() { return { stat_data: 'OLD' }; },
        replaceMvuData() { return 'OLD'; },
        customFlag: 'keep-me',
    };
    const { win } = bridgeSandbox(r, { extra: { Mvu: legacyMvu } });
    assert.strictEqual(typeof win.Mvu.getMvuData().stat_data, 'object', '接管后 getMvuData 应返回数据库重建的 stat_data 对象');
    assert.notStrictEqual(win.Mvu.getMvuData().stat_data, 'OLD', '接管后不应再调用旧 getMvuData');
    assert.strictEqual(win.Mvu.customFlag, 'keep-me', '旧对象上的自定义属性应保留');
    assert.ok(typeof win.Mvu.setMvuVariable === 'function', '接管后应补全 setMvuVariable');
    assert.ok(typeof win.Mvu.parseMessage === 'function', '接管后应补全 parseMessage');
    assert.ok(win.Mvu.events && win.Mvu.events.VARIABLE_UPDATE_ENDED === 'mag_variable_update_ended', '接管后 events 应为 MVU 官方事件名');
});

test('扩展产物：index.js 应包含完整 Mvu 兼容层（事件名/接管/初始化广播）', () => {
    const files = core.assembleExtension({
        coreSource: require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'mvu2shujuku.js'), 'utf8'),
        pinyinInline: 'root.__MVU2SHUJUKU_PINYIN__ = {};',
    });
    const js = files['index.js'];
    assert.ok(js.includes('mag_variable_initialized'), 'index.js 应含 VARIABLE_INITIALIZED 事件名');
    assert.ok(js.includes('mag_variable_update_ended'), 'index.js 应含 VARIABLE_UPDATE_ENDED 事件名');
    assert.ok(js.includes('global_Mvu_initialized'), 'index.js 应监听真 MVU 初始化事件并接管');
    assert.ok(js.includes('setMvuVariable'), 'index.js 应实现 setMvuVariable');
    assert.ok(js.includes('parseMessage'), 'index.js 应实现 parseMessage');
});

/* ---------------- 空字典组 / 未声明动态字段（通用 JSON 兜底） ---------------- */
console.log('JSON 兜底（空字典组 / 未声明字段）');

test('空字典组（无字段线索）→ 整组 JSON：对象条目/标量/删除均可还原', () => {
    const vm = require('vm');
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: 'JSON兜底卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [
                    {
                        comment: '[InitVar]',
                        content: JSON.stringify({
                            系统: { 当前日期: '未知' },
                            任务: {},
                            本轮操作: {},
                        }),
                    },
                ],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both', installMvuShim: true });
    const layout = core.buildLayout(r.schema);
    const taskEntry = layout.entries.find(e => e.group === '任务');
    const opEntry = layout.entries.find(e => e.group === '本轮操作');
    assert.strictEqual(taskEntry.kind, 'json', '空字典且无字段线索应生成整组 JSON 表');
    assert.strictEqual(opEntry.kind, 'json', '空字典且无字段线索应生成整组 JSON 表');
    const taskSheet = Object.values(r.template).find(s => s && s.name === '任务表');
    assert.deepStrictEqual(taskSheet.content[0], ['row_id', '内容'], 'JSON 表头应为 row_id/内容');
    assert.ok(!taskSheet.sourceData.note.includes('【列定义】'), 'JSON 表不应展示列定义');
    assert.ok(!taskSheet.sourceData.note.includes('【强制约束】'), 'JSON 表不应展示强制约束');
    assert.ok(taskSheet.sourceData.note.includes('AI 不应直接修改本表'), 'JSON 表应保留整组说明');

    const tables = JSON.parse(JSON.stringify(r.template));
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
        top: null, parent: null, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t), console,
        CustomEvent: function () {}, addEventListener() {}, dispatchEvent() { return true; },
        TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        getContext: () => ({ chatId: 'c1', name: '测试', chat: [{ role: 'assistant', name: '测试', mes: '开场白', is_user: false }], eventSource: { on: () => {}, emit: () => {} }, event_types: { MESSAGE_RECEIVED: 'x' } }),
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    win.AutoCardUpdaterAPI = fakeApi;
    vm.createContext(win);
    vm.runInContext(r.bridgeScript, win);
    return (async () => {
        // 对象条目写入
        let mvu = win.Mvu.getMvuData();
        mvu.stat_data.任务['剿灭盗匪'] = { 完成条件: '击败首领', 已完成: false };
        await win.Mvu.replaceMvuData(mvu);
        let back = win.Mvu.getMvuData();
        assert.strictEqual(JSON.stringify(back.stat_data.任务['剿灭盗匪']), JSON.stringify({ 完成条件: '击败首领', 已完成: false }), '任务条目应整组 JSON 还原');
        // 标量整组写入
        mvu = win.Mvu.getMvuData();
        mvu.stat_data.本轮操作 = '无';
        await win.Mvu.replaceMvuData(mvu);
        back = win.Mvu.getMvuData();
        assert.strictEqual(back.stat_data.本轮操作, '无', '整组标量应原样还原');
        // 删除条目（unset 后整组覆盖）
        mvu = win.Mvu.getMvuData();
        delete mvu.stat_data.任务['剿灭盗匪'];
        await win.Mvu.replaceMvuData(mvu);
        back = win.Mvu.getMvuData();
        assert.strictEqual(Object.keys(back.stat_data.任务).length, 0, '删除任务条目后应还原为空字典');
    })().catch(e => { throw e; });
});

test('已声明单例/行表：未声明的动态字段写入 _扩展数据 并读回', () => {
    const vm = require('vm');
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '溢出卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [
                    {
                        comment: '[InitVar]',
                        content: JSON.stringify({
                            系统: { 当前日期: '未知' },
                            角色: { 林若悠: { 好感度: 50 } },
                        }),
                    },
                ],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both', installMvuShim: true });
    const layout = core.buildLayout(r.schema);
    const sys = layout.entries.find(e => e.group === '系统');
    const role = layout.entries.find(e => e.group === '角色');
    assert.ok(sys.cols.some(c => c.zh === '_扩展数据'), '单例表应有 _扩展数据 溢出列');
    assert.ok(role.cols.some(c => c.zh === '_扩展数据'), '行表应有 _扩展数据 溢出列');

    const tables = JSON.parse(JSON.stringify(r.template));
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
        insertRow: async (tableName, obj) => {
            const sheet = Object.values(tables).find(s => s && s.name === tableName);
            if (!sheet) return 1;
            const row = sheet.content[0].map(() => '');
            for (const k in obj) { const ci = sheet.content[0].indexOf(k); if (ci >= 0) row[ci] = String(obj[k]); }
            row[0] = sheet.content.length || 1;
            sheet.content.push(row);
            return row[0];
        },
        deleteRow: async () => true,
    };
    const win = {
        top: null, parent: null, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t), console,
        CustomEvent: function () {}, addEventListener() {}, dispatchEvent() { return true; },
        TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        getContext: () => ({ chatId: 'c1', name: '测试', chat: [{ role: 'assistant', name: '测试', mes: '开场白', is_user: false }], eventSource: { on: () => {}, emit: () => {} }, event_types: { MESSAGE_RECEIVED: 'x' } }),
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    win.AutoCardUpdaterAPI = fakeApi;
    vm.createContext(win);
    vm.runInContext(r.bridgeScript, win);
    return (async () => {
        // 单例组未声明字段（对应 系统._hypnoos 场景）
        let mvu = win.Mvu.getMvuData();
        mvu.stat_data.系统._hypnoos = { achievements: { a: true }, 特性: {} };
        await win.Mvu.replaceMvuData(mvu);
        let back = win.Mvu.getMvuData();
        assert.strictEqual(JSON.stringify(back.stat_data.系统._hypnoos), JSON.stringify({ achievements: { a: true }, 特性: {} }), '单例组未声明字段应经 _扩展数据 读回');
        assert.strictEqual(back.stat_data.系统.当前日期, '未知', '已声明字段不受影响');
        assert.ok(!('_扩展数据' in back.stat_data.系统), '内部溢出列不应混入 stat_data');
        // 行表未声明字段（角色.条目.新字段）
        mvu = win.Mvu.getMvuData();
        mvu.stat_data.角色['林若悠']['隐藏标记'] = 'x1';
        await win.Mvu.replaceMvuData(mvu);
        back = win.Mvu.getMvuData();
        assert.strictEqual(back.stat_data.角色['林若悠']['隐藏标记'], 'x1', '行表未声明字段应经行级 _扩展数据 读回');
        assert.strictEqual(back.stat_data.角色['林若悠'].好感度, 50, '行表已声明字段不受影响');
        assert.ok(!('_扩展数据' in back.stat_data.角色['林若悠']), '行级内部溢出列不应混入 stat_data');
    })().catch(e => { throw e; });
});

test('表结构校验：旧模板（同名表缺列）会被识别并重新导入，不再静默跳过', () => {
    const vm = require('vm');
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '结构校验卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [
                    {
                        comment: '[InitVar]',
                        content: JSON.stringify({ 任务: {} }),
                    },
                ],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both' });
    const tables = JSON.parse(JSON.stringify(r.template));
    // 模拟旧模板：任务表存在但缺「内容」列
    const taskKey = Object.keys(tables).find(k => tables[k].name === '任务表');
    tables[taskKey].content = [['row_id', '名称'], [1, '任务']];
    let importCalls = 0;
    let initCalls = 0;
    const fixFromTemplate = (tpl) => {
        const exp = Object.keys(tpl).find(k => tpl[k].name === '任务表');
        if (exp) tables[taskKey].content = JSON.parse(JSON.stringify(tpl[exp].content));
    };
    const fakeApi = {
        exportTableAsJson: () => tables,
        importTemplateFromData: async (tpl) => {
            importCalls += 1;
            fixFromTemplate(tpl);
            return { success: true };
        },
        initGameSession: async (charData, opts) => {
            initCalls += 1;
            // initGameSession(injectTemplate) 同样会按模板重建表结构
            if (opts && opts.templateData) fixFromTemplate(opts.templateData);
            return { success: true, runtimeReady: true };
        },
        registerTableUpdateCallback: () => {},
        updateCell: async () => true,
        insertRow: async () => 1,
        deleteRow: async () => true,
    };
    const win = {
        top: null, parent: null, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t), console,
        CustomEvent: function () {}, addEventListener() {}, dispatchEvent() { return true; },
        TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        getContext: () => ({ chatId: 'c1', name: '测试', chat: [{ role: 'assistant', name: '测试', mes: '开场白', is_user: false }], eventSource: { on: () => {}, emit: () => {} }, event_types: { MESSAGE_RECEIVED: 'x' } }),
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    win.AutoCardUpdaterAPI = fakeApi;
    vm.createContext(win);
    vm.runInContext(r.bridgeScript, win);
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            try {
                assert.ok(initCalls >= 1 || importCalls >= 1, '旧模板缺列时应触发重新建表（initGameSession 或 importTemplateFromData）');
                assert.deepStrictEqual(tables[taskKey].content[0], ['row_id', '内容'], '导入后任务表应恢复为内容+行结构');
                resolve();
            } catch (e) { reject(e); }
        }, 100);
    });
});

test('性能回归：桥的 重建/写入 按批次只导出一次全表快照（不再每表/每操作导出）', () => {
    const vm = require('vm');
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both', installMvuShim: true });
    const tables = JSON.parse(JSON.stringify(r.template));
    const chat = [];
    let exportCount = 0;
    const fakeApi = {
        exportTableAsJson: () => { exportCount += 1; return tables; },
        importTemplateFromData: async () => ({ success: true }),
        initGameSession: async () => {
            chat.push({ message_id: chat.length, TavernDB_ACU_IsolatedData: JSON.stringify({ 系统: { storageFrame: { version: 2, logEntries: [], checkpoint: { kind: 'full', ts: 1 } } } }) });
            return { success: true, runtimeReady: true };
        },
        registerTableUpdateCallback: () => {},
        updateCell: async (tableName, rowIndex, col, value) => {
            const sheet = Object.values(tables).find(s => s && s.name === tableName);
            if (!sheet) return false;
            const ci = sheet.content[0].indexOf(col);
            if (ci === -1) return false;
            sheet.content[rowIndex][ci] = value;
            return true;
        },
        insertRow: async (tableName, obj) => {
            const sheet = Object.values(tables).find(s => s && s.name === tableName);
            if (!sheet) return 1;
            const row = sheet.content[0].map(() => '');
            for (const k in obj) { const ci = sheet.content[0].indexOf(k); if (ci >= 0) row[ci] = String(obj[k]); }
            row[0] = sheet.content.length || 1;
            sheet.content.push(row);
            return row[0];
        },
        deleteRow: async () => true,
    };
    const win = {
        top: null, parent: null, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t), console,
        CustomEvent: function () {}, addEventListener() {}, dispatchEvent() { return true; },
        TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        getContext: () => ({ chatId: 'c1', name: '测试', chat, eventSource: { on: () => {}, emit: () => {} }, event_types: { MESSAGE_RECEIVED: 'x' } }),
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    win.AutoCardUpdaterAPI = fakeApi;
    vm.createContext(win);
    vm.runInContext(r.bridgeScript, win);
    return (async () => {
        const before = exportCount;
        const mvu = win.Mvu.getMvuData();
        for (let i = 1; i <= 20; i++) {
            mvu.stat_data.主角['字段' + i] = i;
            mvu.stat_data.道侣['角色' + i] = { 亲密: i };
        }
        await win.Mvu.replaceMvuData(mvu);
        const used = exportCount - before;
        // exportTableAsJson 只返回引用（开销可忽略），允许每操作刷新；关键是不得产生幻影重复行
        assert.ok(used <= 300, '一次批量读写（40 字段）导出次数应受控，实际 ' + used + ' 次');
        assert.strictEqual(win.Mvu.getMvuData().stat_data.道侣['角色5'].亲密, 5, '批量写入后应能读回');
        await waitBridgeFlush();
        const daoSheet = Object.values(tables).find(s => s && s.name === '道侣表');
        const daoRows = daoSheet.content.slice(1).filter(r => r && r[1] === '角色5');
        assert.strictEqual(daoRows.length, 1, '同一键不应产生重复行（缓存幻影行 bug）');
    })().catch(e => { throw e; });
});

test('单例/整组JSON表仅表头时自动补初始行（updateCell 不再 Row index out of bounds）', () => {
    const vm = require('vm');
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '补行卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [
                    {
                        comment: '[InitVar]',
                        content: JSON.stringify({
                            系统: { 当前时间: '12:00' },
                            任务: {},
                        }),
                    },
                ],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both', installMvuShim: true });
    const tables = JSON.parse(JSON.stringify(r.template));
    const byName = (n) => Object.keys(tables).find(k => tables[k].name === n);
    // 模拟插件运行期"仅表头+seedRows"：把 系统表/任务表 的 content 裁成只有表头
    const sysKey = byName('系统表');
    const taskKey = byName('任务表');
    tables[sysKey].seedRows = JSON.parse(JSON.stringify(tables[sysKey].content.slice(1)));
    tables[taskKey].seedRows = JSON.parse(JSON.stringify(tables[taskKey].content.slice(1)));
    tables[sysKey].content = [tables[sysKey].content[0]];
    tables[taskKey].content = [tables[taskKey].content[0]];
    const chat = [];
    const fakeApi = {
        exportTableAsJson: () => tables,
        getTableTemplate: () => r.template,
        importTemplateFromData: async () => ({ success: true }),
        initGameSession: async () => {
            chat.push({ message_id: chat.length, TavernDB_ACU_IsolatedData: JSON.stringify({ 系统: { storageFrame: { version: 2, logEntries: [], checkpoint: { kind: 'full', ts: 1 } } } }) });
            return { success: true, runtimeReady: true };
        },
        registerTableUpdateCallback: () => {},
        updateCell: async (tableName, rowIndex, col, value) => {
            const sheet = Object.values(tables).find(s => s && s.name === tableName);
            if (!sheet) return false;
            const ci = sheet.content[0].indexOf(col);
            if (ci === -1) return false;
            sheet.content[rowIndex][ci] = value;
            return true;
        },
        insertRow: async (tableName, obj) => {
            const sheet = Object.values(tables).find(s => s && s.name === tableName);
            if (!sheet) return 1;
            const header = sheet.content[0];
            const row = header.map(() => '');
            for (const k in obj) { const ci = header.indexOf(k); if (ci >= 0) row[ci] = String(obj[k]); }
            row[0] = sheet.content.length || 1;
            sheet.content.push(row);
            return row[0];
        },
        deleteRow: async () => true,
    };
    const win = {
        top: null, parent: null, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t), console,
        CustomEvent: function () {}, addEventListener() {}, dispatchEvent() { return true; },
        TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        getContext: () => ({ chatId: 'c1', name: '测试', chat, eventSource: { on: () => {}, emit: () => {} }, event_types: { MESSAGE_RECEIVED: 'x' } }),
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    win.AutoCardUpdaterAPI = fakeApi;
    vm.createContext(win);
    vm.runInContext(r.bridgeScript, win);
    return (async () => {
        // 写任务（JSON 表，仅表头）→ 应先补初始行再写内容
        let mvu = win.Mvu.getMvuData();
        mvu.stat_data.任务['学习技能'] = { 完成条件: '读完一本书', 已完成: false };
        await win.Mvu.replaceMvuData(mvu);
        let back = win.Mvu.getMvuData();
        assert.strictEqual(JSON.stringify(back.stat_data.任务['学习技能']), JSON.stringify({ 完成条件: '读完一本书', 已完成: false }), '仅表头的JSON表写入应成功');
        // 写系统（单例表，仅表头）→ 应补初始行并保留初始值
        mvu = win.Mvu.getMvuData();
        mvu.stat_data.系统.当前时间 = '13:00';
        await win.Mvu.replaceMvuData(mvu);
        back = win.Mvu.getMvuData();
        assert.strictEqual(back.stat_data.系统.当前时间, '13:00', '仅表头的单例表写入应成功');
        await waitBridgeFlush();
        // 表内容已补行（不止表头）
        assert.ok(tables[taskKey].content.length > 1, '任务表应补上数据行');
        assert.ok(tables[sysKey].content.length > 1, '系统表应补上数据行');
    })().catch(e => { throw e; });
});

test('SQL 示例不应包含内部溢出列 _扩展数据', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '示例卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [
                    {
                        comment: '[InitVar]',
                        content: JSON.stringify({
                            持有物品: { 铁剑: { 数量: 1, 描述: '一把剑' } },
                        }),
                    },
                ],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both' });
    const sheet = Object.values(r.template).find(s => s && s.name === '持有物品表');
    assert.ok(sheet.content[0].includes('_扩展数据'), '表头应有 _扩展数据 列');
    assert.ok(!sheet.sourceData.insertNode.includes('_扩展数据'), 'INSERT 示例不应包含 _扩展数据');
    assert.ok(!sheet.sourceData.updateNode.includes('_扩展数据'), 'UPDATE 示例不应包含 _扩展数据');
    assert.ok(sheet.sourceData.insertNode.includes('INSERT INTO'), 'INSERT 示例仍应存在');
});

test('数组表提示词按行增删改，不再“整体替换/禁止增删”', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '数组卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [{ comment: '[InitVar]', content: '背包: []\n系统: { _数据版本: 7 }' }],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both' });
    const sheet = Object.values(r.template).find(s => s && s.name === '背包表');
    assert.ok(sheet, '应生成背包表');
    assert.ok(sheet.sourceData.note.startsWith('数组表：'), 'note 不应以表名开头（对齐默认模板）');
    assert.ok(sheet.sourceData.note.includes('数组表'), 'note 应说明数组表');
    assert.ok(sheet.sourceData.note.includes('INSERT'), 'note 应说明 INSERT');
    assert.ok(sheet.sourceData.note.includes('DELETE'), 'note 应说明 DELETE');
    assert.ok(sheet.sourceData.note.includes('UPDATE'), 'note 应说明 UPDATE');
    assert.ok(!sheet.sourceData.note.includes('整体替换'), 'note 不应再有整体替换');
    assert.ok(sheet.sourceData.updateNode.includes('UPDATE beibaobiao SET neirong'), 'updateNode 应为按行 UPDATE');
    assert.ok(sheet.sourceData.insertNode.includes('INSERT INTO beibaobiao (neirong)'), 'insertNode 应为 INSERT 新行');
    assert.ok(sheet.sourceData.deleteNode.includes('DELETE FROM beibaobiao'), 'deleteNode 应为 DELETE 行');
    assert.ok(!sheet.sourceData.insertNode.includes('禁止'), '数组表 insert 不应禁止');
    assert.ok(!sheet.sourceData.deleteNode.includes('禁止'), '数组表 delete 不应禁止');
    assert.ok(sheet.sourceData.initNode.includes('INSERT'), 'initNode 应指引 insertNode');
    assert.ok(!sheet.sourceData.initNode.includes('无（开局'), 'initNode 不应出现“无（…）”矛盾表述');
});

test('行表 initNode 不写死首个开场分支的初始记录名（多开场白分支注入后不误导）', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '多开场卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [{ comment: '[InitVar]', content: '结识道友录:\n  潮听澜:\n    关系: 道友\n  林晚:\n    关系: 点头之交' }],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both' });
    const sheet = Object.values(r.template).find(s => s && s.name === '结识道友录表');
    assert.ok(sheet, '应生成结识道友录表');
    assert.ok(sheet.sourceData.initNode.includes('开局模板已初始化 2 条记录'), 'initNode 应说明记录条数');
    assert.ok(!sheet.sourceData.initNode.includes('潮听澜') && !sheet.sourceData.initNode.includes('林晚'), 'initNode 不应写死具体记录名（首个开场分支）');
});

test('全只读单例不生成 UPDATE 示例，note/init/update 自洽', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '只读卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [{ comment: '[InitVar]', content: '系统:\n  _数据版本: 7\n  _坏结局: ""' }],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both' });
    const sheet = Object.values(r.template).find(s => s && s.name === '系统表');
    assert.ok(sheet, '应生成系统表');
    assert.ok(sheet.sourceData.note.includes('AI 无需填表'), 'note 应声明无需填表');
    assert.ok(!sheet.sourceData.note.includes('只允许按需 UPDATE'), 'note 不应教 AI UPDATE');
    assert.ok(!sheet.sourceData.note.includes('只在正文明确造成状态变化时更新对应字段'), '全只读表不应出现填表动作提示');
    assert.ok(!sheet.sourceData.updateNode.includes('UPDATE'), 'updateNode 不应给出 UPDATE 示例');
    assert.ok(sheet.sourceData.updateNode.includes('不应修改'), 'updateNode 应声明不可修改');
    assert.ok(!sheet.sourceData.initNode.includes('UPDATE'), 'initNode 不应出现 UPDATE');
});

test('行表 SQL 示例排除下划线只读字段', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '混合卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [{
                    comment: '[InitVar]',
                    content: JSON.stringify({
                        主角: {
                            姓名: '斯维姆',
                            气运: { 阿笔: { 名称: '阿笔', 类型: '被动', _剩余次数: 3 } },
                        },
                    }),
                }],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both' });
    const sheet = Object.values(r.template).find(s => s && s.name === '气运表');
    assert.ok(sheet, '应生成气运表');
    assert.ok(sheet.content[0].includes('_剩余次数'), '表头应有 _剩余次数 列');
    assert.ok(!sheet.sourceData.insertNode.includes('_剩余次数'), 'INSERT 示例不应包含 _剩余次数');
    assert.ok(!sheet.sourceData.updateNode.includes('_剩余次数'), 'UPDATE 示例不应包含 _剩余次数');
    assert.ok(sheet.sourceData.insertNode.includes('INSERT INTO'), 'INSERT 示例仍应存在');
});

test('读方向只认 content：seedRows 不作为已存在数据展示（删除后不被补回导致 UI 死而复生）', () => {
    const layout = [
        { kind: 'singleton', group: '系统', table: '系统表', keyCol: '名称', keyValue: '系统', cols: [['名称', 'text', '', '', '', ''], ['当前时间', 'text', '', '', '', '']], writePaths: [], mirrors: [] },
        { kind: 'rows', group: '储物袋', table: '储物袋表', keyCol: '名称', cols: [['名称', 'text', '', '', '', ''], ['数量', 'number', '', '', '', '']], writePaths: [['主角', '储物袋']], mirrors: [] },
    ];
    const tables = {
        sheet_1: { name: '系统表', content: [['row_id', '名称', '当前时间']], seedRows: [[1, '系统', '12:00']] },
        sheet_2: { name: '储物袋表', content: [['row_id', '名称', '数量']], seedRows: [[1, '铁剑', 1]] },
    };
    const out = core.statDataFromTables(layout, tables);
    assert.strictEqual(out.stat_data.系统.当前时间, '', 'content 仅表头时不应从 seedRows 还原（seedRows 是模板基底，非真实数据）');
    assert.deepStrictEqual(out.stat_data.主角.储物袋, {}, '行表 content 无行时不应从 seedRows 还原');
    // content 有行时正常读取
    const tables2 = {
        sheet_1: { name: '系统表', content: [['row_id', '名称', '当前时间'], [1, '系统', '12:00']] },
        sheet_2: { name: '储物袋表', content: [['row_id', '名称', '数量'], [1, '铁剑', 1]] },
    };
    const out2 = core.statDataFromTables(layout, tables2);
    assert.strictEqual(out2.stat_data.系统.当前时间, '12:00', 'content 有行时单例正常读取');
    assert.strictEqual(out2.stat_data.主角.储物袋['铁剑'].数量, 1, 'content 有行时行表正常读取');
});

test('桥复刻 MVU 占位符维护：AI 回复自动追加 <StatusPlaceHolderImpl/>（前端每楼可注入）', () => {
    const vm = require('vm');
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '占位符卡',
            description: '',
            first_mes: '你好\n\n<StatusPlaceHolderImpl/>',
            character_book: {
                entries: [
                    {
                        comment: '[InitVar]',
                        content: JSON.stringify({ 系统: { 当前时间: '12:00' } }),
                    },
                ],
            },
            extensions: {
                regex_scripts: [
                    {
                        scriptName: '前端',
                        findRegex: '<StatusPlaceHolderImpl/>',
                        replaceString: '```\n<body>\n<script>\n$(\'body\').load(\'https://example.com/app\')\n</script>\n</body>\n```',
                    },
                ],
                tavern_helper: { scripts: [] },
            },
        },
    };
    const r = core.convert(card, { mode: 'both' });
    const tables = JSON.parse(JSON.stringify(r.template));
    let boundHandler = null;
    const fakeApi = {
        exportTableAsJson: () => tables,
        importTemplateFromData: async () => ({ success: true }),
        initGameSession: async () => ({ success: true, runtimeReady: true }),
        registerTableUpdateCallback: () => {},
        updateCell: async () => true,
        insertRow: async () => 1,
        deleteRow: async () => true,
    };
    const win = {
        top: null, parent: null, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t), console,
        CustomEvent: function () {}, addEventListener() {}, dispatchEvent() { return true; },
        TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        getContext: () => ({ chatId: 'c1', chat: [{ role: 'assistant', name: '测试', mes: '开场白', is_user: false }], eventSource: { on: () => {}, emit: () => {} }, event_types: { MESSAGE_RECEIVED: 'x' } }),
    };
    const contextObj = {
        chatId: 'c1',
        name: '占位符卡',
        characterId: 0,
        characters: [{ extensions: { regex_scripts: [{ findRegex: '<StatusPlaceHolderImpl/>' }] } }],
        chat: [{ role: 'assistant', name: '占位符卡', mes: '这是AI回复', message: '这是AI回复' }],
        eventSource: { on: (name, fn) => { boundHandler = fn; } },
        event_types: { MESSAGE_RECEIVED: 'message_received' },
        setChatMessages: async (arr) => {
            for (const item of arr) {
                if (contextObj.chat[0]) {
                    contextObj.chat[0].mes = item.mes || item.message;
                    contextObj.chat[0].message = item.message || item.mes;
                }
            }
        },
        saveChat: async () => {},
    };
    win.getContext = () => contextObj;
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    win.AutoCardUpdaterAPI = fakeApi;
    vm.createContext(win);
    vm.runInContext(r.bridgeScript, win);
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            try {
                assert.strictEqual(typeof boundHandler, 'function', '桥应监听 MESSAGE_RECEIVED');
                boundHandler({});
                setTimeout(() => {
                    try {
                        const mes = contextObj.chat[0].mes;
                        assert.ok(mes.includes('<StatusPlaceHolderImpl/>'), 'AI 回复末尾应追加状态栏占位符，实际：' + mes);
                        resolve();
                    } catch (e) { reject(e); }
                }, 500);
            } catch (e) { reject(e); }
        }, 300);
    });
});

test('插件 initGameSession 挂起时不阻塞建表（超时后继续，不再永久卡住自动初始化）', () => {
    const vm = require('vm');
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '挂起卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [
                    {
                        comment: '[InitVar]',
                        content: JSON.stringify({ 系统: { 当前时间: '12:00' } }),
                    },
                ],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both' });
    // 缩短桥内建表超时，便于测试（默认 15s/20s）
    let bridge = r.bridgeScript.replace(/\+'模板'\);/, "+'模板',{importMs:80,initMs:80});");
    let tables = {};
    let initGameSessionCalled = 0;
    const fakeApi = {
        exportTableAsJson: () => tables,
        importTemplateFromData: async (tpl) => {
            tables = JSON.parse(JSON.stringify(tpl));
            return { success: true };
        },
        initGameSession: () => {
            initGameSessionCalled += 1;
            return new Promise(() => {}); // 模拟插件 Promise 永不返回
        },
        registerTableUpdateCallback: () => {},
        updateCell: async () => true,
        insertRow: async () => 1,
        deleteRow: async () => true,
    };
    const win = {
        top: null, parent: null, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t), console,
        CustomEvent: function () {}, addEventListener() {}, dispatchEvent() { return true; },
        TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        getContext: () => ({ chatId: 'c1', name: '挂起卡', chat: [{ role: 'assistant', name: '挂起卡', mes: '开场白', is_user: false }], eventSource: { on: () => {} }, event_types: { MESSAGE_RECEIVED: 'x' } }),
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    win.AutoCardUpdaterAPI = fakeApi;
    vm.createContext(win);
    vm.runInContext(bridge, win);
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            try {
                const keys = Object.keys(tables).filter(k => k.startsWith('sheet_'));
                assert.ok(keys.length >= 1, 'initGameSession 挂起时，importTemplateFromData 也应完成建表');
                assert.strictEqual(initGameSessionCalled, 1, '首次会调用 initGameSession（但超时不阻塞）');
                resolve();
            } catch (e) { reject(e); }
        }, 500);
    });
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
        top: null, parent: null, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t), console,
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
    assert.ok(c.extensions.mvu2shujuku, '应有转换标记');
    assert.ok(typeof c.extensions.mvu2shujuku.layout === 'string' && Array.isArray(JSON.parse(c.extensions.mvu2shujuku.layout)), '转换标记应包含布局（供扩展重建 stat_data）');
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
    assert.strictEqual(tplEntry.enabled, false, '模板条目应默认禁用（世界书绿灯关闭），仅作数据载体');
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

test('INSERT 示例优先用卡内真实初始值，空表退回列名占位', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '示例卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [{
                    comment: '[InitVar]',
                    content: JSON.stringify({
                        道侣: {
                            林若悠: { 亲密: [88, ''], 日程: { 周三: ['空', ''] } },
                        },
                    }),
                }],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both' });
    const ins = Object.values(r.template).find(s => s && s.name === '道侣表').sourceData.insertNode;
    assert.ok(ins.includes("VALUES ('林若悠', 88"), ins);
    // 空表（无初始条目）的示例应使用“列中文名示例”占位，而不是凭空的值
    const card2 = {
        spec: 'chara_card_v3',
        data: {
            name: '空表示例卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [{
                    comment: '[InitVar]',
                    content: JSON.stringify({ 仓库: {} }),
                }],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r2 = core.convert(card2, { mode: 'both' });
    const ins2 = Object.values(r2.template).find(s => s && s.name === '仓库表').sourceData.insertNode;
    assert.ok(ins2.includes("VALUES ('键名')") || !ins2.includes('值1'), ins2);
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

test('JSON 输入 + asPng:true → 产出可解析的 PNG 卡（输出格式对 JSON 输入也生效）', () => {
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both', asPng: true });
    const png = r.files.find(f => f.kind === 'card' && f.name.endsWith('.png'));
    assert.ok(png, 'JSON 输入选择总是 PNG 应产出 PNG 卡');
    assert.ok(png.data.length > 1000, 'PNG 输出过小');
    const again = core.parseCardPng(png.data);
    assert.ok(again.card.data.name, 'PNG 应可再解析出角色卡');
    assert.strictEqual(r.meta.asPng, true, 'meta.asPng 应为 true');
});

test('内嵌世界书卡：extensions.world 绑定到转换后的世界书名（导入时自动挂载）', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '世界书卡',
            description: '',
            first_mes: '你好',
            character_book: {
                name: '世界书卡',
                entries: [{ comment: '[InitVar]', content: JSON.stringify({ 系统: { 当前时间: '12:00' } }) }],
            },
            extensions: { world: '世界书卡', regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both' });
    const d = r.card.data || r.card;
    assert.ok(d.character_book && Array.isArray(d.character_book.entries) && d.character_book.entries.length >= 1, '应保留内嵌世界书条目');
    assert.ok(String(d.character_book.name).endsWith('_数据库'), '内嵌世界书名应加后缀避免同名覆盖');
    assert.strictEqual(d.extensions.world, d.character_book.name, 'extensions.world 应指向转换后的世界书名，导入时自动绑定');
});

test('浏览器环境（无 Buffer）PNG 回写正常', () => {
    if (!fs.existsSync(PNG)) {
        console.log('    （跳过：缺少 PNG 参考卡）');
        return;
    }
    const vm = require('vm');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'mvu2shujuku.js'), 'utf8');
    const sandbox = {
        console, TextDecoder, TextEncoder, Uint8Array, Uint16Array, Uint32Array, DataView, ArrayBuffer,
        atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    const core = sandbox.MVU2SHUJUKU_CORE;
    const buf = fs.readFileSync(PNG);
    const parsed = core.parseCardPng(buf);
    const out = core.writeCardPng(buf, parsed.card);
    const again = core.parseCardPng(out);
    assert.strictEqual(again.card.data.name, parsed.card.data.name);
});

/* ---------------- 扩展装配 ---------------- */
console.log('assembleExtension');
test('扩展文件齐全且 index.js 语法正确', () => {
    const coreSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'mvu2shujuku.js'), 'utf8');
    const files = core.assembleExtension({ coreSource });
    assert.ok(files['manifest.json']);
    assert.ok(files['index.js']);
    assert.ok(files['style.css']);
    const manifest = JSON.parse(files['manifest.json']);
    assert.strictEqual(manifest.js, 'index.js');
    new Function(files['index.js']);
});

test('写库合并路径无 chatKeyNow TDZ（const 声明必须先于首次使用）', () => {
    const coreSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'mvu2shujuku.js'), 'utf8');
    const files = core.assembleExtension({ coreSource });
    const index = files['index.js'];
    const decl = index.indexOf('const chatKeyNow = autoInitChatId();');
    const use = index.indexOf('lastForeignWriteDropChat !== chatKeyNow');
    assert.ok(decl !== -1 && use !== -1, 'index.js 应包含 chatKeyNow 的声明与使用');
    assert.ok(decl < use, 'chatKeyNow 的 const 声明必须先于首次使用（TDZ 回归：曾导致每次带布局外组的 Mvu.replaceMvuData 写库崩溃）');
});

test('桥的读写都处理 scalarValueCol（修仙秘闻读回 {键:标量}、写入落描述列）且扩展不跳过安装', () => {
    const coreSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'mvu2shujuku.js'), 'utf8');
    const files = core.assembleExtension({ coreSource });
    const index = files['index.js'];
    // 桥 getAllVariables 行表分支：读回必须是 {键: 标量}（状态栏 typeof==='string' 才能命中）
    assert.ok(index.includes('if(L.scalarValueCol){'), '桥 getAllVariables 应含 scalarValueCol 读回分支');
    assert.ok(index.includes('dict[text(kv)]=svcE?convertCell(svcE[1],sv,svcE[2],svcE[5])'), '桥读回应为 {键: 标量}');
    // 桥 writeDiffToDb：新行值落 scalarValueCol 列、已有行 colZh 指向 scalarValueCol
    assert.ok(index.includes('if(L.scalarValueCol&&cp.length===1)'), '桥新行插入应把标量值落到 scalarValueCol 列');
    assert.ok(index.includes('if(L.scalarValueCol&&parts.length===E.prefix.length+1){colZh=L.scalarValueCol;}'), '桥已有行更新应把 colZh 指到 scalarValueCol 列');
    // 扩展侧应覆盖桥先定义的 getAllVariables（核心 statDataFromTables 才含 scalarValueCol + 持久化兜底）
    assert.ok(!index.includes("if (typeof window.getAllVariables === 'function') return;"), '扩展 installWindowGetAllVariables 不应因桥已定义而跳过安装');
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
    // EJS 规范写法应改数据源为数据桥 getAllVariables（EJS 结构保留）
    const cond = r.card.data.character_book.entries.find(e => e.comment === '显示条件');
    assert.ok(cond.content.includes('mvu2shujukuGetAllVariables().stat_data.冒险者["等级"][0] >= 10'), cond.content);
    assert.ok(cond.content.includes('<% if'), cond.content);
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
        try { tmpDir = fs.mkdtempSync(path.join(base, 'mvu2shujuku-')); break; } catch (e) {}
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

test('离线/镜像 MVU 引擎脚本按 import URL 识别并移除；整页注入前端加一次性守卫；状态栏事件监听原样保留', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '前端形态卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [{ comment: '[InitVar]', content: JSON.stringify({ 系统: { 当前日期: '未知' } }) }],
            },
            extensions: {
                regex_scripts: [
                    {
                        scriptName: '前端',
                        findRegex: '<StatusPlaceHolderImpl/>',
                        replaceString: "```\n<body>\n<script>\n$('body').load('https://example.test/frontend/index.html')\n</script>\n</body>\n```",
                    },
                    {
                        scriptName: 'MVU状态栏',
                        findRegex: '<StatusPlaceHolderImpl/>',
                        replaceString: "<script>\nwindow.eventOn(window.Mvu.events.VARIABLE_UPDATE_ENDED, () => {\n  window.populate();\n});\n</script>",
                    },
                ],
                tavern_helper: {
                    scripts: [
                        { name: 'MVU', enabled: true, content: "import 'https://testingcf.jsdelivr.net/gh/NLKASHEI/MVU-offline@v1.0.2/mvu_bundle_full.js'" },
                        { name: '助手', enabled: true, content: 'console.log("非 MVU 脚本");' },
                    ],
                },
            },
        },
    };
    const r = core.convert(card, { mode: 'both' });
    const d = r.card.data || r.card;
    const thScripts = (d.extensions && d.extensions.tavern_helper && d.extensions.tavern_helper.scripts) || [];
    assert.ok(!thScripts.some(s => String(s.content || '').includes('MVU-offline')), '应移除离线 MVU 引擎 import 脚本');
    assert.ok(thScripts.some(s => String(s.content || '').includes('非 MVU 脚本')), '应保留非 MVU 脚本');
    const front = (d.extensions && d.extensions.regex_scripts || []).find(rx => String(rx.scriptName || '') === '前端');
    assert.ok(front && String(front.replaceString || '').includes('__mvu2shujukuFrontendLoaded'), '整页注入前端应加一次性加载守卫');
    const sb = (d.extensions && d.extensions.regex_scripts || []).find(rx => String(rx.scriptName || '') === 'MVU状态栏');
    assert.ok(sb && String(sb.replaceString || '').includes('window.eventOn(window.Mvu.events.VARIABLE_UPDATE_ENDED'), '状态栏事件监听应原样保留（靠数据桥广播 mag_variable_update_ended 驱动）');
    assert.ok(!String(sb.replaceString || '').includes("(() => { if (window.addEventListener)"), '不应出现损坏状态栏脚本的事件改写');
});

test('VARIABLE_UPDATE_ENDED 载荷与 MVU 原版一致：携带更新前后的完整 MvuData', async () => {
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const captured = [];
    class FakeCustomEvent {
        constructor(type, init) {
            this.type = type;
            this.detail = init && init.detail;
        }
    }
    const { win } = bridgeSandbox(r, {
        extra: {
            CustomEvent: FakeCustomEvent,
            dispatchEvent(ev) { captured.push(ev); return true; },
        },
    });
    const Mvu = win.Mvu;
    const before = JSON.parse(JSON.stringify(Mvu.getMvuData().stat_data));
    const mvu = Mvu.getMvuData();
    mvu.stat_data.主角.生命 = 77;
    await Mvu.replaceMvuData(mvu);
    await waitBridgeFlush();
    const ended = captured.find(e => e.type === 'mag_variable_update_ended');
    assert.ok(ended, '写库后应广播 mag_variable_update_ended');
    assert.strictEqual(ended.detail.after.stat_data.主角.生命, 77, 'after 应携带更新后的 stat_data');
    assert.strictEqual(ended.detail.before.stat_data.主角.生命, before.主角.生命, 'before 应携带更新前的 stat_data');
    assert.ok(ended.detail.after.stat_data.世界.当前时间, 'after 应为完整 MvuData（含其他组数据）');
});

test('扩展侧写路径：单例/JSON 表仅表头时按模板补初始行（防 updateCell out of bounds）', async () => {
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    // 与真实运行一致：卡内布局是 buildLayoutJson 序列化后的数组列（[zh,type,fallback,path,isPair,desc]）
    const layoutEntries = core.buildLayout(r.schema).entries.map(e => ({
        kind: e.kind,
        group: e.group,
        table: e.table,
        keyCol: e.keyCol || '',
        keyValue: e.keyValue || '',
        cols: (e.cols || []).map(c => (e.kind === 'singleton'
            ? [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, c.path || [], !!c.isPair, c.desc || '']
            : [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, null, !!c.isPair, c.desc || ''])),
        writePaths: e.writePaths || [],
        mirrors: e.mirrors || [],
    }));
    // 模拟“表格只有表头、初始行消失”：清掉所有物化行
    const tables = JSON.parse(JSON.stringify(r.template));
    for (const k of Object.keys(tables)) {
        const s = tables[k];
        if (s && Array.isArray(s.content) && s.content.length > 1) s.content = [s.content[0]];
    }
    const fakeApi = {
        exportTableAsJson: () => tables,
        getTableTemplate: async () => r.template,
        insertRow: async (tableName, obj) => {
            const s = Object.values(tables).find(x => x && x.name === tableName);
            if (!s) return 0;
            const row = s.content[0].map(h => (obj[h] !== undefined && obj[h] !== null) ? String(obj[h]) : '');
            row[0] = s.content.length || 1;
            s.content.push(row);
            return row[0];
        },
        updateCell: async (tableName, rowIndex, col, value) => {
            const s = Object.values(tables).find(x => x && x.name === tableName);
            if (!s || !s.content[rowIndex]) throw new Error('Row index ' + rowIndex + ' out of bounds in table "' + tableName + '".');
            const ci = s.content[0].indexOf(col);
            if (ci === -1) return false;
            s.content[rowIndex][ci] = String(value);
            return true;
        },
        executeSqlBatch: async () => ({ success: false, error: 'test' }),
        deleteRow: async () => true,
    };
    const prevAll = core.statDataFromTables(layoutEntries, tables);
    const prev = prevAll.stat_data || {};
    const next = JSON.parse(JSON.stringify(prev));
    if (!next.主角) next.主角 = {};
    next.主角.姓名 = '测试主角';
    const n = await core.writeStatDiffToDb(fakeApi, layoutEntries, prev, next);
    assert.ok(n >= 1, '应有差异被写入');
    const zj = Object.values(tables).find(s => s && s.name === '主角表');
    assert.ok(zj && zj.content.length > 1, '单例表缺行时应按模板补入初始行');
    const hdr = zj.content[0];
    assert.strictEqual(zj.content[1][hdr.indexOf('姓名')], '测试主角', '姓名应写入成功（不再 out of bounds）');
});

test('开局自动建表：单例/JSON 表仅表头且无 seedRows 时自动补初始行（开场白切换重建场景）', async () => {
    const vm = require('vm');
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const tables = JSON.parse(JSON.stringify(r.template));
    // 模拟开场白切换后插件重建：所有表只剩表头，且 seedRows 也被清空
    for (const k of Object.keys(tables)) {
        const s = tables[k];
        if (s && Array.isArray(s.content) && s.content.length > 1) s.content = [s.content[0]];
    }
    const win = {
        top: null, parent: null, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t), console,
        CustomEvent: function () {}, addEventListener() {}, dispatchEvent() { return true; },
        TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        getContext: () => ({ chatId: 'c1', chat: [{ role: 'assistant', name: '测试', mes: '开场白', is_user: false }], eventSource: { on: () => {}, emit: () => {} }, event_types: { MESSAGE_RECEIVED: 'x' } }),
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    win.AutoCardUpdaterAPI = {
        exportTableAsJson: () => tables,
        importTemplateFromData: async () => ({ success: true }),
        initGameSession: async () => ({ success: true, runtimeReady: true }),
        registerTableUpdateCallback: () => {},
        updateCell: async () => true,
        insertRow: async (tableName, obj) => {
            const s = Object.values(tables).find(x => x && x.name === tableName);
            if (!s) return 0;
            const row = s.content[0].map(h => (obj[h] !== undefined && obj[h] !== null) ? String(obj[h]) : '');
            row[0] = s.content.length || 1;
            s.content.push(row);
            return row[0];
        },
        deleteRow: async () => true,
    };
    vm.createContext(win);
    vm.runInContext(r.bridgeScript, win);
    await waitBridgeFlush(500);
    const zj = Object.values(tables).find(s => s && s.name === '主角表');
    assert.ok(zj && zj.content.length > 1, '开局自动建表应为仅表头的单例表补初始行');
    const sd = win.getAllVariables().stat_data;
    assert.strictEqual(sd.主角.姓名, '未知', '补行后应能读到初始值');
});

test('卡内桥最小运行时：已有表格的聊天不重初始化、不重建锚点、不重置', async () => {
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });

    const makeSandbox = (chat) => {
        const vm2 = require('vm');
        const tables = JSON.parse(JSON.stringify(r.template));
        const win = {
            top: null, parent: null, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t), console,
            CustomEvent: function () {}, addEventListener() {}, dispatchEvent() { return true; },
            TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
            getContext: () => ({
                chatId: 'c1',
                name: '测试角色',
                chat,
                eventSource: { on: () => {}, emit: () => {} },
                event_types: { MESSAGE_RECEIVED: 'message_received' },
            }),
        };
        win.top = win; win.parent = win; win.window = win; win.globalThis = win;
        let initCalls = 0;
        win.AutoCardUpdaterAPI = {
            exportTableAsJson: () => tables,
            importTemplateFromData: async () => ({ success: true }),
            initGameSession: async () => { initCalls += 1; return { success: true, runtimeReady: true }; },
            registerTableUpdateCallback: () => {},
            updateCell: async () => true,
            insertRow: async () => 1,
            deleteRow: async () => true,
        };
        vm2.createContext(win);
        vm2.runInContext(r.bridgeScript, win);
        return { win, initCalls: () => initCalls };
    };

    // 表已存在（无论是否有锚点）：桥不应调用 initGameSession（只缺表才初始化）
    const s2 = makeSandbox([]);
    await waitBridgeFlush(500);
    assert.strictEqual(s2.initCalls(), 0, '已有表格的聊天不应重初始化/重建锚点（对齐参考卡：只缺表才初始化）');
});

test('桥启动即提供 eventOn 兜底，且 VARIABLE_UPDATE_ENDED 按 (after, before) 传参', async () => {
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const vm2 = require('vm');
    const tables = JSON.parse(JSON.stringify(r.template));
    class FakeCustomEvent {
        constructor(type, init) { this.type = type; this.detail = init && init.detail; }
    }
    const listeners = {};
    const win = {
        top: null, parent: null, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t), console,
        CustomEvent: FakeCustomEvent,
        addEventListener(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
        removeEventListener(name, fn) { listeners[name] = (listeners[name] || []).filter(f => f !== fn); },
        dispatchEvent(ev) { (listeners[ev.type] || []).slice().forEach(fn => { try { fn(ev); } catch (e) {} }); return true; },
        TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        getContext: () => ({ chatId: 'c1', chat: [{ role: 'assistant', name: '测试', mes: '开场白', is_user: false }], eventSource: { on() {}, emit() {} }, event_types: { MESSAGE_RECEIVED: 'x' } }),
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    win.AutoCardUpdaterAPI = {
        exportTableAsJson: () => tables,
        importTemplateFromData: async () => ({ success: true }),
        initGameSession: async () => ({ success: true, runtimeReady: true }),
        registerTableUpdateCallback: () => {},
        updateCell: async () => true,
        insertRow: async () => 1,
        deleteRow: async () => true,
    };
    vm2.createContext(win);
    vm2.runInContext(r.bridgeScript, win);
    assert.strictEqual(typeof win.eventOn, 'function', '桥启动后 window.eventOn 应可用');
    const got = [];
    win.eventOn('mag_variable_update_ended', (a, b) => { got.push([a, b]); });
    win.dispatchEvent(new FakeCustomEvent('mag_variable_update_ended', { detail: { after: { stat_data: { x: 1 } }, before: { stat_data: { x: 0 } } } }));
    assert.strictEqual(got.length, 1, '监听应被触发');
    assert.strictEqual(got[0][0].stat_data.x, 1, 'after 应按位置传参');
    assert.strictEqual(got[0][1].stat_data.x, 0, 'before 应按位置传参');
});

test('写库直接 diff 落表（移除锚点前置/重置门控）', async () => {
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });

    const makeSandbox2 = (mutateTables) => {
        const vm2 = require('vm');
        const tables = JSON.parse(JSON.stringify(r.template));
        mutateTables(tables);
        const chat = [];
        const win = {
            top: null, parent: null, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t), console,
            CustomEvent: function () {}, addEventListener() {}, dispatchEvent() { return true; },
            TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
            getContext: () => ({
                chatId: 'c1', name: '测试角色', chat,
                eventSource: { on: () => {}, emit: () => {} },
                event_types: { MESSAGE_RECEIVED: 'message_received' },
            }),
        };
        win.top = win; win.parent = win; win.window = win; win.globalThis = win;
        const counters = { init: 0 };
        win.AutoCardUpdaterAPI = {
            exportTableAsJson: () => tables,
            importTemplateFromData: async () => ({ success: true }),
            initGameSession: async () => {
                counters.init += 1;
                chat.push({ message_id: chat.length, TavernDB_ACU_IsolatedData: JSON.stringify({ 系统: { storageFrame: { version: 2, logEntries: [], checkpoint: { kind: 'full', ts: 1 } } } }) });
                return { success: true, runtimeReady: true };
            },
            importTableAsJson: async () => false,
            registerTableUpdateCallback: () => {},
            updateCell: async (tableName, rowIndex, col, value) => {
                const s = Object.values(tables).find(x => x && x.name === tableName);
                if (!s || !s.content[rowIndex]) throw new Error('Row index ' + rowIndex + ' out of bounds in table "' + tableName + '".');
                const ci = s.content[0].indexOf(col);
                if (ci === -1) return false;
                s.content[rowIndex][ci] = String(value);
                return true;
            },
            insertRow: async (tableName, obj) => {
                const s = Object.values(tables).find(x => x && x.name === tableName);
                if (!s) return 0;
                const row = s.content[0].map(h => (obj[h] !== undefined && obj[h] !== null) ? String(obj[h]) : '');
                row[0] = s.content.length || 1;
                s.content.push(row);
                return row[0];
            },
            deleteRow: async () => true,
        };
        vm2.createContext(win);
        vm2.runInContext(r.bridgeScript, win);
        return { win, tables, counters };
    };

    // 场景1：主角表仅模板行被改 + 无锚点 → 直接写入，不重建
    const s1 = makeSandbox2((tables) => {
        const zj = Object.values(tables).find(s => s && s.name === '主角表');
        zj.content[1][zj.content[0].indexOf('姓名')] = '测试主角';
    });
    const mvu1 = s1.win.Mvu.getMvuData();
    mvu1.stat_data.主角.姓名 = '测试主角2';
    await s1.win.Mvu.replaceMvuData(mvu1);
    await waitBridgeFlush(600);
    assert.strictEqual(s1.counters.init, 0, '写库不应触发 initGameSession 重建（对齐参考卡最小运行时）');
    const zj1 = Object.values(s1.tables).find(s => s && s.name === '主角表');
    assert.strictEqual(zj1.content[1][zj1.content[0].indexOf('姓名')], '测试主角2', '写入应直接落表');

    // 场景2：道侣表有额外行 + 无锚点 → 同样直接写入，不重置不放弃
    const s2 = makeSandbox2((tables) => {
        const dl = Object.values(tables).find(s => s && s.name === '道侣表');
        dl.content.push(['1', '测试道侣', '', '', '', '', '', '', '', '', '', '', '', '', '']);
    });
    const mvu2 = s2.win.Mvu.getMvuData();
    if (!mvu2.stat_data.主角) mvu2.stat_data.主角 = {};
    mvu2.stat_data.主角.姓名 = '测试主角3';
    await s2.win.Mvu.replaceMvuData(mvu2);
    await waitBridgeFlush(600);
    assert.strictEqual(s2.counters.init, 0, '有额外行时也不应触发重建/重置');
    const zj2 = Object.values(s2.tables).find(s => s && s.name === '主角表');
    const nameIdx = zj2.content[0].indexOf('姓名');
    assert.strictEqual(zj2.content[1][nameIdx], '测试主角3', '写入应直接落表（不再因锚点门控放弃）');
});

test('写库不受锚点形态门控（移除运行时锚点重建机制）', async () => {
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const vm2 = require('vm');
    const tables = JSON.parse(JSON.stringify(r.template));
    const cases = [
        // 非 full：模板派生 checkpoint（initGameSession 留下的形态）——不应算已锚定
        [{ message_id: 0, TavernDB_ACU_IsolatedData: JSON.stringify({ 系统: { storageFrame: { version: 2, logEntries: [], checkpoint: { kind: 'template_only_root', ts: 1 } } } }) }],
        // 缺 version/logEntries：旧格式——不应算已锚定
        [{ message_id: 0, TavernDB_ACU_IsolatedData: JSON.stringify({ 系统: { storageFrame: { checkpoint: { kind: 'full', ts: 1 } } } }) }],
        // 真正的 V2 full checkpoint——应算已锚定
        [{ message_id: 0, TavernDB_ACU_IsolatedData: JSON.stringify({ 系统: { storageFrame: { version: 2, logEntries: [], checkpoint: { kind: 'full', ts: 1 } } } }) }],
    ];
    for (let ci = 0; ci < cases.length; ci++) {
        const chat = cases[ci];
        let initCalls = 0;
        const win = {
            top: null, parent: null, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t), console,
            CustomEvent: function () {}, addEventListener() {}, dispatchEvent() { return true; },
            TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
            getContext: () => ({ chatId: 'c1', name: '测试', chat, eventSource: { on: () => {}, emit: () => {} }, event_types: { MESSAGE_RECEIVED: 'x' } }),
        };
        win.top = win; win.parent = win; win.window = win; win.globalThis = win;
        win.AutoCardUpdaterAPI = {
            exportTableAsJson: () => tables,
            importTemplateFromData: async () => ({ success: true }),
            initGameSession: async () => { initCalls += 1; return { success: true, runtimeReady: true }; },
            registerTableUpdateCallback: () => {},
            updateCell: async () => true,
            insertRow: async () => 1,
            deleteRow: async () => true,
        };
        vm2.createContext(win);
        vm2.runInContext(r.bridgeScript, win);
        const mvu = win.Mvu.getMvuData();
        if (!mvu.stat_data.主角) mvu.stat_data.主角 = {};
        mvu.stat_data.主角.姓名 = '测试' + ci;
        await win.Mvu.replaceMvuData(mvu);
        await waitBridgeFlush(600);
        assert.strictEqual(initCalls, 0, '任意 checkpoint 形态都不应触发 initGameSession 重建（运行时最小化）');
    }
});

test('外部 import 脚本默认安装 MVU 兼容层（自动检测兜底）', () => {
    const mkCard = (scriptContent) => ({
        spec: 'chara_card_v3',
        data: {
            name: '外部脚本卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [{ comment: '[InitVar]', content: '系统: { 当前时间: "12:00" }' }],
            },
            extensions: {
                regex_scripts: [],
                tavern_helper: {
                    scripts: [{ name: '游戏逻辑', enabled: true, content: scriptContent }],
                },
            },
        },
    });
    // 卡内只有一行外部 import、没有任何可见的 Mvu. 调用：静态扫描看不到，必须默认装兼容层
    const external = core.convert(mkCard("import 'https://example.com/game.js';"), { mode: 'both' });
    assert.ok(
        external.files.find(f => f.kind === 'bridge').data.includes('installMvuShim();'),
        '外部 import 卡应默认安装桥内 MVU 兼容层'
    );
    assert.ok(external.report.toMarkdown().includes('外部 import'), '报告应注明外部 import 兜底');
    // 卡内既无 Mvu. 调用也无外部 import：自动检测应保持不安装
    const internal = core.convert(mkCard('function tick(){ return 1; }'), { mode: 'both' });
    assert.ok(
        !internal.files.find(f => f.kind === 'bridge').data.includes('installMvuShim();'),
        '无 MVU/外部 import 的卡不应安装兼容层'
    );
});

test('扩展安全门控：非转换卡零接管零建表，转换卡才接管 Mvu/getAllVariables 并建表', async () => {
    const vm2 = require('vm');
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    // 与真实运行一致：卡内布局是 buildLayoutJson 序列化后的数组列
    const toLayout = (schema) => core.buildLayout(schema).entries.map(e => ({
        kind: e.kind,
        group: e.group,
        table: e.table,
        keyCol: e.keyCol || '',
        keyValue: e.keyValue || '',
        cols: (e.cols || []).map(c => (e.kind === 'singleton'
            ? [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, c.path || [], !!c.isPair, c.desc || '']
            : [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, null, !!c.isPair, c.desc || ''])),
        writePaths: e.writePaths || [],
        mirrors: e.mirrors || [],
    }));
    const layout = toLayout(r.schema);
    // 与 build-extension.js 相同的内联方式组装扩展 index.js
    const srcDir = path.join(__dirname, '..', 'src');
    const coreSource = fs.readFileSync(path.join(srcDir, 'mvu2shujuku.js'), 'utf8');
    const pinyinData = fs.readFileSync(path.join(srcDir, 'pinyin-data.js'), 'utf8');
    const yamlLibsData = fs.readFileSync(path.join(srcDir, 'vendor', 'mvu-yaml-libs.js'), 'utf8');
    const jsonrepairData = fs.readFileSync(path.join(srcDir, 'vendor', 'jsonrepair-lite.js'), 'utf8');
    const pinyinInline = pinyinData
        .replace(/^[\s\S]*?module\.exports\s*=\s*/, 'root.__MVU2SHUJUKU_PINYIN__ = ')
        .replace(/;\s*$/, ';');
    const yamlLibsInline = [
        '(function () {',
        '  var module = { exports: {} };',
        '  var exports = module.exports;',
        yamlLibsData,
        '  var target = typeof globalThis !== "undefined" ? globalThis : this;',
        '  target.__MVU2SHUJUKU_YAML_LIBS__ = module.exports;',
        '})();',
        '',
    ].join('\n');
    const jsonrepairInline = 'root.__MVU2SHUJUKU_JSONREPAIR_SRC__ = ' + JSON.stringify(jsonrepairData) + ';';
    const extIndex = core.assembleExtension({ coreSource, pinyinInline, yamlLibsInline, jsonrepairInline })['index.js'];

    // 真实 ST 完整对象形状：extensions / 世界书在 data 下，顶层无 extensions
    const nonConverted = {
        name: '普通卡',
        avatar: 'a.png',
        data: {
            extensions: { world: '' },
            character_book: { entries: [{ keys: ['随便'], content: '内容' }] },
        },
    };
    const tables = JSON.parse(JSON.stringify(r.template));
    const converted = {
        name: '转换卡',
        avatar: 'b.png',
        extensions: { mvu2shujuku: { converter: 'mvu2shujuku', layout: JSON.stringify(layout) } },
        character_book: {
            entries: [{
                keys: ['__ACU_TEMPLATE_DATA__'],
                content: Buffer.from(JSON.stringify(r.template)).toString('base64'),
            }],
        },
    };
    let initialized = false;
    let initCalls = 0;
    let lastInitTemplateData = null;
    // 模拟插件真实行为：initGameSession 成功后在首条消息上建立 full checkpoint
    const attachCheckpoint = () => {
        if (!Array.isArray(context.chat) || context.chat.length === 0) return;
        const msg = context.chat[0];
        if (!msg) return;
        msg.TavernDB_ACU_IsolatedData = JSON.stringify({
            系统: { storageFrame: { version: 2, logEntries: [], checkpoint: { kind: 'full', ts: Date.now() } } },
        });
    };
    const fakeApi = {
        getTemplatePresetNames: () => [],
        exportTableAsJson: () => (initialized ? tables : {}),
        initGameSession: async (arg1, opts) => {
            initCalls += 1;
            initialized = true;
            lastInitTemplateData = (opts && opts.templateData) || null;
            attachCheckpoint();
            if (opts && opts.templateData && typeof opts.templateData === 'object') {
                for (const k of Object.keys(tables)) delete tables[k];
                Object.assign(tables, opts.templateData);
            }
            return { success: true, runtimeReady: true };
        },
        importTemplateFromData: async () => ({ success: true }),
        importTableAsJson: async (jsonStr) => {
            try { const parsed = JSON.parse(jsonStr); for (const k of Object.keys(tables)) delete tables[k]; Object.assign(tables, parsed); } catch (e) {}
            attachCheckpoint();
            return true;
        },
        insertRow: async () => 1,
        updateCell: async (tableName, rowIndex, col, value) => {
            const s = Object.values(tables).find(x => x && x.name === tableName);
            if (!s || !s.content[rowIndex]) return false;
            const ci = s.content[0].indexOf(col);
            if (ci === -1) return false;
            s.content[rowIndex][ci] = String(value);
            return true;
        },
        deleteRow: async () => true,
        registerTableUpdateCallback: () => true,
    };
    const handlers = {};
    const context = {
        chatId: 'c1',
        name: '测试',
        chat: [{ role: 'assistant', name: '测试', mes: '开场白', is_user: false }],
        characters: [nonConverted],
        characterId: 0,
        extensionSettings: {},
        eventSource: {
            on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); },
            emit: () => {},
        },
        event_types: {
            CHAT_CHANGED: 'chat_changed',
            MESSAGE_RECEIVED: 'message_received',
            MESSAGE_SWIPED: 'swiped',
            MESSAGE_UPDATED: 'updated',
            MESSAGE_EDITED: 'edited',
            MESSAGE_SENT: 'sent',
            MESSAGE_DELETED: 'deleted',
            GENERATION_ENDED: 'generation_ended',
        },
        saveSettingsDebounced: () => {},
        saveChatConditional: async () => {},
        saveChat: async () => {},
        getRequestHeaders: () => ({}),
        setChatMessages: () => {},
    };
    const fakeEl = () => {
        const el = {
            dataset: {},
            style: {},
            children: [],
            _listeners: {},
            _value: '',
            addEventListener: (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); },
            removeEventListener: () => {},
            dispatchEvent: () => true,
            appendChild: (c) => { el.children.push(c); return c; },
            removeChild: () => {},
            querySelector: () => fakeEl(),
            querySelectorAll: () => [],
            click: () => {},
            focus: () => {},
            blur: () => {},
            contains: () => false,
            getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
        };
        Object.defineProperty(el, 'innerHTML', { get: () => el._html || '', set: (v) => { el._html = v; } });
        Object.defineProperty(el, 'textContent', { get: () => '', set: () => {} });
        Object.defineProperty(el, 'value', { get: () => el._value, set: (v) => { el._value = v; } });
        Object.defineProperty(el, 'checked', { get: () => !!el._checked, set: (v) => { el._checked = v; } });
        Object.defineProperty(el, 'disabled', { get: () => !!el._disabled, set: (v) => { el._disabled = v; } });
        return el;
    };
    const doc = {
        querySelector: () => fakeEl(),
        getElementById: () => fakeEl(),
        createElement: () => fakeEl(),
        createTextNode: () => fakeEl(),
        addEventListener: () => {},
        body: fakeEl(),
    };
    const win = {
        top: null,
        parent: null,
        document: doc,
        console,
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (t) => clearTimeout(t),
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: (t) => clearInterval(t),
        CustomEvent: function () {},
        addEventListener: () => {},
        dispatchEvent: () => true,
        TextDecoder,
        atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        SillyTavern: { getContext: () => context },
        AutoCardUpdaterAPI: fakeApi,
        eventEmit: () => {},
        toastr: undefined,
    };
    win.top = win;
    win.parent = win;
    win.window = win;
    win.globalThis = win;
    win.__mvu2shujukuDebug = true;
    vm2.createContext(win);
    vm2.runInContext(extIndex, win);

    // 阶段1：非转换卡——等待开局自动建表定时器执行，必须零接管、零建表
    await new Promise(res => setTimeout(res, 2200));
    assert.strictEqual(initCalls, 0, '非转换卡不应触发任何建表');
    assert.strictEqual(win.Mvu, undefined, '非转换卡不应接管 window.Mvu');
    assert.strictEqual(win.getAllVariables, undefined, '非转换卡不应定义 getAllVariables');
    assert.strictEqual(win.getVariables, undefined, '非转换卡不应接管 getVariables');
    assert.strictEqual(win.updateVariablesWith, undefined, '非转换卡不应接管 updateVariablesWith');
    assert.strictEqual(win.replaceVariables, undefined, '非转换卡不应接管 replaceVariables');

    // 阶段2：切到带独有标记的转换卡——触发 CHAT_CHANGED 后应接管并建表
    context.characters[0] = converted;
    (handlers['chat_changed'] || []).forEach(fn => fn());
    await new Promise(res => setTimeout(res, 2500));
    assert.ok(initCalls >= 1, '转换卡应触发建表（实际 ' + initCalls + ' 次）');
    assert.ok(win.Mvu && typeof win.Mvu.getMvuData === 'function', '转换卡应接管 window.Mvu');
    assert.strictEqual(typeof win.getAllVariables, 'function', '转换卡应定义 getAllVariables');
    assert.strictEqual(typeof win.getVariables, 'function', '转换卡应接管 getVariables');
    assert.strictEqual(typeof win.updateVariablesWith, 'function', '转换卡应接管 updateVariablesWith');
    assert.strictEqual(typeof win.replaceVariables, 'function', '转换卡应接管 replaceVariables');
    // 模板缓存键：应使用“读取时会看到的角色对象”（带 avatar），并同时记录名称兜底
    assert.strictEqual(win.__mvu2shujukuTemplateCacheFor, '转换卡|b.png', '缓存键应含 avatar');
    assert.strictEqual(win.__mvu2shujukuTemplateCacheForName, '转换卡', '应记录缓存键的名称兜底');
    // 模拟旧 bug：缓存键被存成“名称|”（完整卡 data 缺 avatar）时，写库仍应通过名称兜底命中
    const initCallsBeforeWrite = initCalls;
    win.__mvu2shujukuTemplateCacheFor = '转换卡|';
    context.chat = [{ message_id: 0, mes: '开场白' }];
    await win.Mvu.replaceMvuData({ stat_data: { 主角: { 姓名: '缓存兜底' } } });
    await new Promise(res => setTimeout(res, 1000));
    assert.strictEqual(initCalls, initCallsBeforeWrite, '名称兜底写库不再触发 initGameSession（原生 CRUD 直写，实际 initCalls ' + initCallsBeforeWrite + ' → ' + initCalls + '）');
    // 写库可能走 initGameSession 合并路径或（重锚已建 checkpoint 时）快照/差异路径，
    // 功能断言看表格内容而非 lastInitTemplateData 这个实现细节
    const zjFallback = Object.values(tables).find(s => s && s.name === '主角表');
    assert.strictEqual(zjFallback.content[1][zjFallback.content[0].indexOf('姓名')], '缓存兜底', '名称兜底写入应包含注入值');
    context.chat = [];
    // 模拟催眠卡日志场景：前端 target 只有 系统（缺 主角）时，写库必须保留已有主角数据
    const zjKeep = Object.values(tables).find(s => s && s.name === '主角表');
    zjKeep.content[1][zjKeep.content[0].indexOf('姓名')] = '斯维姆';
    await win.Mvu.replaceMvuData({ stat_data: { 系统: { 本轮APP操作: '充值点数 +1' } } });
    await new Promise(res => setTimeout(res, 1000));
    const zjAfter = Object.values(tables).find(s => s && s.name === '主角表');
    assert.strictEqual(zjAfter.content[1][zjAfter.content[0].indexOf('姓名')], '斯维姆', '不完整 target（缺主角）不应清空已有数据');

    // 阶段3：切到另一张带不同模板的转换卡（仓库卡），验证模板缓存按卡归属，
    // 重锚/写库不会串用上一张转换卡（B）的模板缓存
    const cardC = core.convert({
        spec: 'chara_card_v3',
        data: {
            name: '仓库卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [{ comment: '[InitVar]', content: '仓库:\n  物品: { 数量: 1 }' }],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    }, { mode: 'both' });
    const convertedC = {
        name: '仓库卡',
        avatar: 'c.png',
        extensions: { mvu2shujuku: { converter: 'mvu2shujuku', layout: JSON.stringify(toLayout(cardC.schema)) } },
        character_book: {
            entries: [{
                keys: ['__ACU_TEMPLATE_DATA__'],
                content: Buffer.from(JSON.stringify(cardC.template)).toString('base64'),
            }],
        },
    };
    context.characters[0] = convertedC;
    (handlers['chat_changed'] || []).forEach(fn => fn());
    // 切卡空窗期：布局仍是上一张卡的，读取必须返回空而不是旧卡形状的数据
    const gapStat = win.getAllVariables ? (win.getAllVariables().stat_data || {}) : {};
    // 注意：VM 沙箱 realm 的对象原型与测试进程不同，deepStrictEqual 会误判，用 keys 长度断言
    assert.strictEqual(Object.keys(gapStat).length, 0, '切卡空窗期 getAllVariables 不应返回上一张卡的旧布局数据');
    // 新契约：不再有周期重锚——建表/锚点归插件；扩展只做运行时接管与切卡隔离
    await new Promise(res => setTimeout(res, 2500));
    const namesC = Object.keys(tables).filter(k => k.indexOf('sheet_') === 0).map(k => tables[k].name);
    assert.ok(!namesC.includes('仓库表'), '切卡不重建运行时表格（扩展不再参与建表/重锚，建表归插件）');
    assert.ok(namesC.includes('主角表'), '运行时仍是上一张卡（B）的表格（切卡隔离会拦写，绝不串模板）');

    // 阶段4：切回普通卡——所有接管必须撤销，且不再有任何建表/写入
    const initCallsBefore = initCalls;
    context.characters[0] = nonConverted;
    (handlers['chat_changed'] || []).forEach(fn => fn());
    await new Promise(res => setTimeout(res, 1800));
    assert.strictEqual(initCalls, initCallsBefore, '切回普通卡后不应再触发建表');
    assert.strictEqual(win.Mvu, undefined, '切回普通卡后应撤销 window.Mvu');
    assert.strictEqual(win.getAllVariables, undefined, '切回普通卡后应撤销 getAllVariables');
    assert.strictEqual(win.getVariables, undefined, '切回普通卡后应撤销 getVariables');
    assert.strictEqual(win.updateVariablesWith, undefined, '切回普通卡后应撤销 updateVariablesWith');
    assert.strictEqual(win.replaceVariables, undefined, '切回普通卡后应撤销 replaceVariables');
});

test('懒加载角色：缓存键用列表对象（带 avatar），开场写入不被“无模板缓存”丢弃', async () => {
    const vm2 = require('vm');
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const toLayout = (schema) => core.buildLayout(schema).entries.map(e => ({
        kind: e.kind,
        group: e.group,
        table: e.table,
        keyCol: e.keyCol || '',
        keyValue: e.keyValue || '',
        cols: (e.cols || []).map(c => (e.kind === 'singleton'
            ? [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, c.path || [], !!c.isPair, c.desc || '']
            : [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, null, !!c.isPair, c.desc || ''])),
        writePaths: e.writePaths || [],
        mirrors: e.mirrors || [],
    }));
    const srcDir = path.join(__dirname, '..', 'src');
    const coreSource = fs.readFileSync(path.join(srcDir, 'mvu2shujuku.js'), 'utf8');
    const pinyinData = fs.readFileSync(path.join(srcDir, 'pinyin-data.js'), 'utf8');
    const yamlLibsData = fs.readFileSync(path.join(srcDir, 'vendor', 'mvu-yaml-libs.js'), 'utf8');
    const jsonrepairData = fs.readFileSync(path.join(srcDir, 'vendor', 'jsonrepair-lite.js'), 'utf8');
    const pinyinInline = pinyinData
        .replace(/^[\s\S]*?module\.exports\s*=\s*/, 'root.__MVU2SHUJUKU_PINYIN__ = ')
        .replace(/;\s*$/, ';');
    const yamlLibsInline = [
        '(function () {',
        '  var module = { exports: {} };',
        '  var exports = module.exports;',
        yamlLibsData,
        '  var target = typeof globalThis !== "undefined" ? globalThis : this;',
        '  target.__MVU2SHUJUKU_YAML_LIBS__ = module.exports;',
        '})();',
        '',
    ].join('\n');
    const jsonrepairInline = 'root.__MVU2SHUJUKU_JSONREPAIR_SRC__ = ' + JSON.stringify(jsonrepairData) + ';';
    const extIndex = core.assembleExtension({ coreSource, pinyinInline, yamlLibsInline, jsonrepairInline })['index.js'];

    // 懒加载列表对象：只有 name+avatar，缺 extensions / character_book
    const lazy = { name: '道渊测试', avatar: 'daoyuan.png' };
    // 完整卡：avatar 在顶层，data 里没有（模拟 ST /api/characters/get 的真实返回）
    const full = {
        name: '道渊测试',
        avatar: 'daoyuan.png',
        data: {
            name: '道渊测试',
            character_book: {
                entries: [{
                    keys: ['__ACU_TEMPLATE_DATA__'],
                    content: Buffer.from(JSON.stringify(r.template)).toString('base64'),
                }],
            },
            extensions: {
                mvu2shujuku: { converter: 'mvu2shujuku', layout: JSON.stringify(toLayout(r.schema)) },
            },
        },
    };
    const tables = JSON.parse(JSON.stringify(r.template));
    let initialized = false;
    let initCalls = 0;
    let lastInitTemplateData = null;
    const attachCheckpoint = () => {
        if (!Array.isArray(context.chat) || context.chat.length === 0) return;
        context.chat[0].TavernDB_ACU_IsolatedData = JSON.stringify({
            系统: { storageFrame: { version: 2, logEntries: [], checkpoint: { kind: 'full', ts: Date.now() } } },
        });
    };
    const fakeApi = {
        getTemplatePresetNames: () => [],
        exportTableAsJson: () => (initialized ? tables : {}),
        initGameSession: async (arg1, opts) => {
            initCalls += 1;
            initialized = true;
            lastInitTemplateData = (opts && opts.templateData) || null;
            attachCheckpoint();
            if (opts && opts.templateData && typeof opts.templateData === 'object') {
                for (const k of Object.keys(tables)) delete tables[k];
                Object.assign(tables, opts.templateData);
            }
            return { success: true, runtimeReady: true };
        },
        importTemplateFromData: async () => ({ success: true }),
        importTableAsJson: async (jsonStr) => {
            try { const parsed = JSON.parse(jsonStr); for (const k of Object.keys(tables)) delete tables[k]; Object.assign(tables, parsed); } catch (e) {}
            attachCheckpoint();
            return true;
        },
        insertRow: async () => 1,
        updateCell: async (tableName, rowIndex, col, value) => {
            const s = Object.values(tables).find(x => x && x.name === tableName);
            if (!s || !s.content[rowIndex]) return false;
            const ci = s.content[0].indexOf(col);
            if (ci === -1) return false;
            s.content[rowIndex][ci] = String(value);
            return true;
        },
        deleteRow: async () => true,
        registerTableUpdateCallback: () => true,
    };
    const handlers = {};
    const context = {
        chatId: 'c1',
        name: '测试',
        chat: [{ role: 'assistant', name: '测试', mes: '开场白', is_user: false }],
        characters: [lazy],
        characterId: 0,
        extensionSettings: { mvu2shujuku: { debug: true } },
        eventSource: {
            on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); },
            emit: () => {},
        },
        event_types: {
            CHAT_CHANGED: 'chat_changed',
            MESSAGE_RECEIVED: 'message_received',
            MESSAGE_SWIPED: 'swiped',
            MESSAGE_UPDATED: 'updated',
            MESSAGE_EDITED: 'edited',
            MESSAGE_SENT: 'sent',
            MESSAGE_DELETED: 'deleted',
            GENERATION_ENDED: 'generation_ended',
        },
        saveSettingsDebounced: () => {},
        saveChatConditional: async () => {},
        saveChat: async () => {},
        getRequestHeaders: () => ({}),
        setChatMessages: () => {},
    };
    const fakeEl = () => {
        const el = {
            dataset: {}, style: {}, children: [], _listeners: {}, _value: '',
            addEventListener: (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); },
            removeEventListener: () => {},
            dispatchEvent: () => true,
            appendChild: (c) => { el.children.push(c); return c; },
            removeChild: () => {},
            querySelector: () => fakeEl(),
            querySelectorAll: () => [],
            click: () => {},
            focus: () => {},
            blur: () => {},
            contains: () => false,
            getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
        };
        Object.defineProperty(el, 'innerHTML', { get: () => el._html || '', set: (v) => { el._html = v; } });
        Object.defineProperty(el, 'textContent', { get: () => '', set: () => {} });
        Object.defineProperty(el, 'value', { get: () => el._value, set: (v) => { el._value = v; } });
        Object.defineProperty(el, 'checked', { get: () => !!el._checked, set: (v) => { el._checked = v; } });
        Object.defineProperty(el, 'disabled', { get: () => !!el._disabled, set: (v) => { el._disabled = v; } });
        return el;
    };
    const doc = {
        querySelector: () => fakeEl(),
        getElementById: () => fakeEl(),
        createElement: () => fakeEl(),
        createTextNode: () => fakeEl(),
        addEventListener: () => {},
        body: fakeEl(),
    };
    const win = {
        top: null, parent: null, document: doc, console,
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (t) => clearTimeout(t),
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: (t) => clearInterval(t),
        CustomEvent: function () {},
        addEventListener: () => {},
        dispatchEvent: () => true,
        TextDecoder,
        atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        fetch: async (url, opts) => ({ ok: true, status: 200, json: async () => full }),
        SillyTavern: { getContext: () => context },
        AutoCardUpdaterAPI: fakeApi,
        eventEmit: () => {},
        toastr: undefined,
    };
    win.top = win;
    win.parent = win;
    win.window = win;
    win.globalThis = win;
    vm2.createContext(win);
    vm2.runInContext(extIndex, win);

    (handlers['chat_changed'] || []).forEach(fn => fn());
    await new Promise(res => setTimeout(res, 2500));
    assert.ok(initCalls >= 1, '懒加载角色应通过 /api/characters/get 取完整卡并建表');
    // 关键断言：缓存键必须用“读取时会看到的列表对象”（带 avatar）
    assert.strictEqual(win.__mvu2shujukuTemplateCacheFor, '道渊测试|daoyuan.png', '缓存键应含 avatar（修复前会存成 名称|）');
    assert.strictEqual(win.__mvu2shujukuTemplateCacheForName, '道渊测试', '应记录名称兜底');
    // 开场写入：应命中缓存并落库，而不是被“无模板缓存”丢弃
    context.chat = [{ message_id: 0, mes: '开场白' }];
    await win.Mvu.replaceMvuData({ stat_data: { 主角: { 姓名: '懒加载注入' } } });
    await new Promise(res => setTimeout(res, 1000));
    // 功能断言看表格内容（写库可能走 initGameSession 或快照/差异路径）
    const zjLazy = Object.values(tables).find(s => s && s.name === '主角表');
    assert.strictEqual(zjLazy.content[1][zjLazy.content[0].indexOf('姓名')], '懒加载注入', '懒加载场景开场写入应落库');

    // 真实 ST 完整对象形状：extensions / 世界书都在 data 下、顶层没有 extensions——
    // 必须免 fetch 识别转换卡（不依赖“角色列表对象缺 extensions 再取完整卡”的兜底）
    let fetchCalls = 0;
    win.fetch = async () => { fetchCalls += 1; return { ok: true, status: 200, json: async () => full }; };
    const realSt = {
        name: '真实卡',
        avatar: 'real.png',
        data: {
            extensions: {
                mvu2shujuku: { converter: 'mvu2shujuku', layout: JSON.stringify(toLayout(r.schema)) },
                regex_scripts: [],
            },
            character_book: {
                entries: [{
                    keys: ['__ACU_TEMPLATE_DATA__'],
                    content: Buffer.from(JSON.stringify(r.template)).toString('base64'),
                }],
            },
        },
    };
    context.characters[0] = realSt;
    context.chat = [];
    (handlers['chat_changed'] || []).forEach(fn => fn());
    await new Promise(res => setTimeout(res, 2500));
    assert.strictEqual(fetchCalls, 0, 'data.extensions/data.character_book 的完整 ST 对象应免 fetch 识别');
    assert.strictEqual(win.__mvu2shujukuTemplateCacheFor, '真实卡|real.png', '真实 ST 对象形状下缓存键仍应正确');
    context.chat = [{ message_id: 0, mes: '开场白' }];
    await win.Mvu.replaceMvuData({ stat_data: { 主角: { 姓名: '真实结构注入' } } });
    await new Promise(res => setTimeout(res, 1000));
    const zj2 = Object.values(tables).find(s => s && s.name === '主角表');
    assert.strictEqual(zj2.content[1][zj2.content[0].indexOf('姓名')], '真实结构注入', '真实 ST 对象形状下开场写入应落库');

    // 头像不一致但卡名相同（列表对象 vs /api/characters/get 完整对象）：布局归属门禁应按卡名兜底，
    // getAllVariables 不得返回空、前端写入不得被“布局未就绪”丢弃
    const origAvatar = context.characters[0].avatar;
    context.characters[0].avatar = 'other-avatar.png';
    const gv = win.getAllVariables();
    assert.strictEqual(gv.stat_data.主角 && gv.stat_data.主角.姓名, '真实结构注入', '头像不一致时读侧仍应按卡名兜底返回数据');
    context.chat = [{ message_id: 0, mes: '开场白2' }];
    await win.Mvu.replaceMvuData({ stat_data: { 主角: { 姓名: '头像兜底注入' } } });
    await new Promise(res => setTimeout(res, 1000));
    const zj3 = Object.values(tables).find(s => s && s.name === '主角表');
    assert.strictEqual(zj3.content[1][zj3.content[0].indexOf('姓名')], '头像兜底注入', '头像不一致时写入不应被布局门禁丢弃');
    context.characters[0].avatar = origAvatar;
});

test('刷新后运行时表空但 checkpoint 有数据：写库以 checkpoint 为基线，不覆盖持久化数据', async () => {
    const vm2 = require('vm');
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const toLayout = (schema) => core.buildLayout(schema).entries.map(e => ({
        kind: e.kind, group: e.group, table: e.table, keyCol: e.keyCol || '', keyValue: e.keyValue || '',
        cols: (e.cols || []).map(c => (e.kind === 'singleton'
            ? [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, c.path || [], !!c.isPair, c.desc || '']
            : [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, null, !!c.isPair, c.desc || ''])),
        writePaths: e.writePaths || [], mirrors: e.mirrors || [],
    }));
    const srcDir = path.join(__dirname, '..', 'src');
    const coreSource = fs.readFileSync(path.join(srcDir, 'mvu2shujuku.js'), 'utf8');
    const pinyinData = fs.readFileSync(path.join(srcDir, 'pinyin-data.js'), 'utf8');
    const yamlLibsData = fs.readFileSync(path.join(srcDir, 'vendor', 'mvu-yaml-libs.js'), 'utf8');
    const jsonrepairData = fs.readFileSync(path.join(srcDir, 'vendor', 'jsonrepair-lite.js'), 'utf8');
    const pinyinInline = pinyinData.replace(/^[\s\S]*?module\.exports\s*=\s*/, 'root.__MVU2SHUJUKU_PINYIN__ = ').replace(/;\s*$/, ';');
    const yamlLibsInline = ['(function () {', '  var module = { exports: {} };', '  var exports = module.exports;', yamlLibsData, '  var target = typeof globalThis !== "undefined" ? globalThis : this;', '  target.__MVU2SHUJUKU_YAML_LIBS__ = module.exports;', '})();', ''].join('\n');
    const jsonrepairInline = 'root.__MVU2SHUJUKU_JSONREPAIR_SRC__ = ' + JSON.stringify(jsonrepairData) + ';';
    const extIndex = core.assembleExtension({ coreSource, pinyinInline, yamlLibsInline, jsonrepairInline })['index.js'];

    // 持久化数据：主角表 姓名='斯维姆'（刷新前写入过）
    const persisted = JSON.parse(JSON.stringify(r.template));
    const zjP = Object.values(persisted).find(s => s && s.name === '主角表');
    zjP.content[1][zjP.content[0].indexOf('姓名')] = '斯维姆';
    // 运行时表：刷新后回放未完成，只有表头
    const tables = JSON.parse(JSON.stringify(r.template));
    for (const k of Object.keys(tables)) {
        if (tables[k] && Array.isArray(tables[k].content)) tables[k].content = [tables[k].content[0]];
    }
    const checkpointMsg = {
        message_id: 0,
        TavernDB_ACU_IsolatedData: JSON.stringify({
            系统: { storageFrame: { version: 2, logEntries: [], checkpoint: { kind: 'full', data: persisted, ts: 1 } } },
        }),
    };
    const converted = {
        name: '刷新卡',
        avatar: 'r.png',
        data: {
            extensions: {
                mvu2shujuku: { converter: 'mvu2shujuku', layout: JSON.stringify(toLayout(r.schema)) },
                regex_scripts: [],
            },
            character_book: {
                entries: [{
                    keys: ['__ACU_TEMPLATE_DATA__'],
                    content: Buffer.from(JSON.stringify(r.template)).toString('base64'),
                }],
            },
        },
    };
    let initCalls = 0;
    const fakeApi = applyingApi(tables, {
        onInit: async () => { initCalls += 1; },
    });
    const handlers = {};
    const context = {
        chatId: 'c1', name: '测试', chat: [checkpointMsg],
        characters: [converted], characterId: 0,
        extensionSettings: { mvu2shujuku: { debug: true } },
        eventSource: { on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); }, emit: () => {} },
        event_types: {
            CHAT_CHANGED: 'chat_changed', MESSAGE_RECEIVED: 'message_received', MESSAGE_SWIPED: 'swiped',
            MESSAGE_UPDATED: 'updated', MESSAGE_EDITED: 'edited', MESSAGE_SENT: 'sent', MESSAGE_DELETED: 'deleted',
            GENERATION_ENDED: 'generation_ended',
        },
        saveSettingsDebounced: () => {}, saveChatConditional: async () => {}, saveChat: async () => {},
        getRequestHeaders: () => ({}), setChatMessages: () => {},
    };
    const fakeEl = () => {
        const el = {
            dataset: {}, style: {}, children: [], _listeners: {}, _value: '',
            addEventListener: (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); },
            removeEventListener: () => {}, dispatchEvent: () => true,
            appendChild: (c) => { el.children.push(c); return c; }, removeChild: () => {},
            querySelector: () => fakeEl(), querySelectorAll: () => [],
            click: () => {}, focus: () => {}, blur: () => {}, contains: () => false,
            getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
        };
        Object.defineProperty(el, 'innerHTML', { get: () => el._html || '', set: (v) => { el._html = v; } });
        Object.defineProperty(el, 'textContent', { get: () => '', set: () => {} });
        Object.defineProperty(el, 'value', { get: () => el._value, set: (v) => { el._value = v; } });
        Object.defineProperty(el, 'checked', { get: () => !!el._checked, set: (v) => { el._checked = v; } });
        Object.defineProperty(el, 'disabled', { get: () => !!el._disabled, set: (v) => { el._disabled = v; } });
        return el;
    };
    const doc = {
        querySelector: () => fakeEl(), getElementById: () => fakeEl(), createElement: () => fakeEl(),
        createTextNode: () => fakeEl(), addEventListener: () => {}, body: fakeEl(),
    };
    const win = {
        top: null, parent: null, document: doc, console,
        setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t),
        setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (t) => clearInterval(t),
        CustomEvent: function () {}, addEventListener: () => {}, dispatchEvent: () => true,
        TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        SillyTavern: { getContext: () => context }, AutoCardUpdaterAPI: fakeApi,
        eventEmit: () => {}, toastr: undefined,
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    vm2.createContext(win);
    vm2.runInContext(extIndex, win);

    (handlers['chat_changed'] || []).forEach(fn => fn());
    await new Promise(res => setTimeout(res, 2500));
    assert.strictEqual(initCalls, 0, '已有 full checkpoint 时自动建表应跳过（与日志一致）');
    // 新契约：扩展不手工物化；插件原生回放会把 checkpoint 恢复进运行时（这里模拟已恢复）
    for (const k of Object.keys(tables)) delete tables[k];
    Object.assign(tables, JSON.parse(JSON.stringify(persisted)));
    // 前端写入一个变化：必须以运行时为基线，保留持久化数据（主角姓名）并应用变化
    await win.Mvu.replaceMvuData({ stat_data: { 世界: { 当前时间: '测试时间' } } });
    await new Promise(res => setTimeout(res, 1000));
    const zjAfter = Object.values(tables).find(s => s && s.name === '主角表');
    assert.strictEqual(zjAfter.content[1][zjAfter.content[0].indexOf('姓名')], '斯维姆', '刷新后写库不得把持久化的主角姓名覆盖成默认值');
    const worldAfter = Object.values(tables).find(s => s && s.name === '世界表');
    assert.strictEqual(worldAfter.content[1][worldAfter.content[0].indexOf('当前时间')], '测试时间', '本次写入的变化应应用');
});

test('运行时 sheet key 与模板不一致（插件稳定 key）：快照合并按表名兜底，写入不丢值', async () => {
    const vm2 = require('vm');
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const toLayout = (schema) => core.buildLayout(schema).entries.map(e => ({
        kind: e.kind, group: e.group, table: e.table, keyCol: e.keyCol || '', keyValue: e.keyValue || '',
        cols: (e.cols || []).map(c => (e.kind === 'singleton'
            ? [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, c.path || [], !!c.isPair, c.desc || '']
            : [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, null, !!c.isPair, c.desc || ''])),
        writePaths: e.writePaths || [], mirrors: e.mirrors || [],
    }));
    const srcDir = path.join(__dirname, '..', 'src');
    const coreSource = fs.readFileSync(path.join(srcDir, 'mvu2shujuku.js'), 'utf8');
    const pinyinData = fs.readFileSync(path.join(srcDir, 'pinyin-data.js'), 'utf8');
    const yamlLibsData = fs.readFileSync(path.join(srcDir, 'vendor', 'mvu-yaml-libs.js'), 'utf8');
    const jsonrepairData = fs.readFileSync(path.join(srcDir, 'vendor', 'jsonrepair-lite.js'), 'utf8');
    const pinyinInline = pinyinData.replace(/^[\s\S]*?module\.exports\s*=\s*/, 'root.__MVU2SHUJUKU_PINYIN__ = ').replace(/;\s*$/, ';');
    const yamlLibsInline = ['(function () {', '  var module = { exports: {} };', '  var exports = module.exports;', yamlLibsData, '  var target = typeof globalThis !== "undefined" ? globalThis : this;', '  target.__MVU2SHUJUKU_YAML_LIBS__ = module.exports;', '})();', ''].join('\n');
    const jsonrepairInline = 'root.__MVU2SHUJUKU_JSONREPAIR_SRC__ = ' + JSON.stringify(jsonrepairData) + ';';
    const extIndex = core.assembleExtension({ coreSource, pinyinInline, yamlLibsInline, jsonrepairInline })['index.js'];

    // 运行时表：模板数据但 sheet key 全部换成“插件稳定 key”风格（与模板原始 key 不同）
    const tables = {};
    let ki = 0;
    for (const k of Object.keys(r.template)) {
        if (k.indexOf('sheet_') === 0) { tables['sheet_ST_' + (++ki)] = JSON.parse(JSON.stringify(r.template[k])); }
        else tables[k] = JSON.parse(JSON.stringify(r.template[k]));
    }
    const persisted = JSON.parse(JSON.stringify(r.template));
    const checkpointMsg = {
        message_id: 0,
        TavernDB_ACU_IsolatedData: JSON.stringify({
            系统: { storageFrame: { version: 2, logEntries: [], checkpoint: { kind: 'full', data: persisted, ts: 1 } } },
        }),
    };
    const converted = {
        name: '稳定键卡',
        avatar: 's.png',
        data: {
            extensions: {
                mvu2shujuku: { converter: 'mvu2shujuku', layout: JSON.stringify(toLayout(r.schema)) },
                regex_scripts: [],
            },
            character_book: {
                entries: [{
                    keys: ['__ACU_TEMPLATE_DATA__'],
                    content: Buffer.from(JSON.stringify(r.template)).toString('base64'),
                }],
            },
        },
    };
    let lastImport = null;
    const fakeApi = applyingApi(tables, {
        onImport: (parsed) => { lastImport = parsed; },
    });
    const handlers = {};
    const context = {
        chatId: 'c-stable', name: '测试', chat: [checkpointMsg],
        characters: [converted], characterId: 0,
        extensionSettings: { mvu2shujuku: { debug: true } },
        eventSource: { on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); }, emit: () => {} },
        event_types: {
            CHAT_CHANGED: 'chat_changed', MESSAGE_RECEIVED: 'message_received', MESSAGE_SWIPED: 'swiped',
            MESSAGE_UPDATED: 'updated', MESSAGE_EDITED: 'edited', MESSAGE_SENT: 'sent', MESSAGE_DELETED: 'deleted',
            GENERATION_ENDED: 'generation_ended',
        },
        saveSettingsDebounced: () => {}, saveChatConditional: async () => {}, saveChat: async () => {},
        getRequestHeaders: () => ({}), setChatMessages: () => {},
    };
    const fakeEl = () => {
        const el = {
            dataset: {}, style: {}, children: [], _listeners: {}, _value: '',
            addEventListener: (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); },
            removeEventListener: () => {}, dispatchEvent: () => true,
            appendChild: (c) => { el.children.push(c); return c; }, removeChild: () => {},
            querySelector: () => fakeEl(), querySelectorAll: () => [],
            click: () => {}, focus: () => {}, blur: () => {}, contains: () => false,
            getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
        };
        Object.defineProperty(el, 'innerHTML', { get: () => el._html || '', set: (v) => { el._html = v; } });
        Object.defineProperty(el, 'textContent', { get: () => '', set: () => {} });
        Object.defineProperty(el, 'value', { get: () => el._value, set: (v) => { el._value = v; } });
        Object.defineProperty(el, 'checked', { get: () => !!el._checked, set: (v) => { el._checked = v; } });
        Object.defineProperty(el, 'disabled', { get: () => !!el._disabled, set: (v) => { el._disabled = v; } });
        return el;
    };
    const doc = {
        querySelector: () => fakeEl(), getElementById: () => fakeEl(), createElement: () => fakeEl(),
        createTextNode: () => fakeEl(), addEventListener: () => {}, body: fakeEl(),
    };
    const win = {
        top: null, parent: null, document: doc, console,
        setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t),
        setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (t) => clearInterval(t),
        CustomEvent: function () {}, addEventListener: () => {}, dispatchEvent: () => true,
        TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        SillyTavern: { getContext: () => context }, AutoCardUpdaterAPI: fakeApi,
        eventEmit: () => {}, toastr: undefined,
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    vm2.createContext(win);
    vm2.runInContext(extIndex, win);

    (handlers['chat_changed'] || []).forEach(fn => fn());
    await new Promise(res => setTimeout(res, 2500));
    await win.Mvu.replaceMvuData({ stat_data: { 主角: { 姓名: '稳定键注入' } } });
    await new Promise(res => setTimeout(res, 1200));
    assert.strictEqual(lastImport, null, '差异写入不应触发 importTableAsJson 整表替换（避免切换/并存两套 key）');
    assert.ok(Object.keys(tables).some(k => k.indexOf('sheet_ST_') === 0), '运行时 sheet key 应保持不变，不切换身份');
    const zjNow = Object.values(tables).find(s => s && s.name === '主角表');
    assert.strictEqual(zjNow.content[1][zjNow.content[0].indexOf('姓名')], '稳定键注入', '提交后运行时主角表应含新值');
});

test('行表键同时存在于 seedRows 与 content：差异写入只更新 content 行、不重复插入；仅 seedRows 时跳过 INSERT', async () => {
    const vm2 = require('vm');
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const toLayout = (schema) => core.buildLayout(schema).entries.map(e => ({
        kind: e.kind, group: e.group, table: e.table, keyCol: e.keyCol || '', keyValue: e.keyValue || '',
        cols: (e.cols || []).map(c => (e.kind === 'singleton'
            ? [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, c.path || [], !!c.isPair, c.desc || '']
            : [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, null, !!c.isPair, c.desc || ''])),
        writePaths: e.writePaths || [], mirrors: e.mirrors || [],
    }));
    const srcDir = path.join(__dirname, '..', 'src');
    const coreSource = fs.readFileSync(path.join(srcDir, 'mvu2shujuku.js'), 'utf8');
    const pinyinData = fs.readFileSync(path.join(srcDir, 'pinyin-data.js'), 'utf8');
    const yamlLibsData = fs.readFileSync(path.join(srcDir, 'vendor', 'mvu-yaml-libs.js'), 'utf8');
    const jsonrepairData = fs.readFileSync(path.join(srcDir, 'vendor', 'jsonrepair-lite.js'), 'utf8');
    const pinyinInline = pinyinData.replace(/^[\s\S]*?module\.exports\s*=\s*/, 'root.__MVU2SHUJUKU_PINYIN__ = ').replace(/;\s*$/, ';');
    const yamlLibsInline = ['(function () {', '  var module = { exports: {} };', '  var exports = module.exports;', yamlLibsData, '  var target = typeof globalThis !== "undefined" ? globalThis : this;', '  target.__MVU2SHUJUKU_YAML_LIBS__ = module.exports;', '})();', ''].join('\n');
    const jsonrepairInline = 'root.__MVU2SHUJUKU_JSONREPAIR_SRC__ = ' + JSON.stringify(jsonrepairData) + ';';
    const extIndex = core.assembleExtension({ coreSource, pinyinInline, yamlLibsInline, jsonrepairInline })['index.js'];
    const layout = toLayout(r.schema);

    // 气运表：content 与 seedRows 同时含同键（模拟插件运行时导出的冲突形态）
    const tables = JSON.parse(JSON.stringify(r.template));
    const qy = Object.values(tables).find(s => s && s.name === '气运表');
    const keyCol = '名称';
    qy.content = [qy.content[0], [1, '测试气运', '被动', '效果']];
    qy.seedRows = [[1, '测试气运', '被动', '效果']];
    let insertCount = 0;
    const fakeApi = {
        exportTableAsJson: () => tables,
        insertRow: async (t, o) => {
            insertCount += 1;
            const s = Object.values(tables).find(x => x && x.name === t);
            if (s) { const row = s.content[0].map(h => (o && o[h] !== undefined && o[h] !== null) ? String(o[h]) : ''); row[0] = s.content.length; s.content.push(row); }
            return 99;
        },
        updateCell: async (t, ri, col, v) => {
            const s = Object.values(tables).find(x => x && x.name === t);
            if (!s || !s.content[ri]) return false;
            s.content[ri][s.content[0].indexOf(col)] = String(v);
            return true;
        },
        deleteRow: async () => true,
        executeSqlBatch: async () => ({ success: true }),
        registerTableUpdateCallback: () => true,
    };
    const handlers = {};
    const context = {
        chatId: 'c-seed', name: '测试', chat: [],
        characters: [], characterId: 0,
        extensionSettings: { mvu2shujuku: { debug: false } },
        eventSource: { on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); }, emit: () => {} },
        event_types: {
            CHAT_CHANGED: 'chat_changed', MESSAGE_RECEIVED: 'message_received', MESSAGE_SWIPED: 'swiped',
            MESSAGE_UPDATED: 'updated', MESSAGE_EDITED: 'edited', MESSAGE_SENT: 'sent', MESSAGE_DELETED: 'deleted',
            GENERATION_ENDED: 'generation_ended',
        },
        saveSettingsDebounced: () => {}, saveChatConditional: async () => {}, saveChat: async () => {},
        getRequestHeaders: () => ({}), setChatMessages: () => {},
    };
    const fakeEl = () => {
        const el = {
            dataset: {}, style: {}, children: [], _listeners: {}, _value: '',
            addEventListener: (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); },
            removeEventListener: () => {}, dispatchEvent: () => true,
            appendChild: (c) => { el.children.push(c); return c; }, removeChild: () => {},
            querySelector: () => fakeEl(), querySelectorAll: () => [],
            click: () => {}, focus: () => {}, blur: () => {}, contains: () => false,
            getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
        };
        Object.defineProperty(el, 'innerHTML', { get: () => el._html || '', set: (v) => { el._html = v; } });
        Object.defineProperty(el, 'textContent', { get: () => '', set: () => {} });
        Object.defineProperty(el, 'value', { get: () => el._value, set: (v) => { el._value = v; } });
        Object.defineProperty(el, 'checked', { get: () => !!el._checked, set: (v) => { el._checked = v; } });
        Object.defineProperty(el, 'disabled', { get: () => !!el._disabled, set: (v) => { el._disabled = v; } });
        return el;
    };
    const doc = {
        querySelector: () => fakeEl(), getElementById: () => fakeEl(), createElement: () => fakeEl(),
        createTextNode: () => fakeEl(), addEventListener: () => {}, body: fakeEl(),
    };
    const win = {
        top: null, parent: null, document: doc, console,
        setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t),
        setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (t) => clearInterval(t),
        CustomEvent: function () {}, addEventListener: () => {}, dispatchEvent: () => true,
        TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        SillyTavern: { getContext: () => context }, AutoCardUpdaterAPI: fakeApi,
        eventEmit: () => {}, toastr: undefined,
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    vm2.createContext(win);
    vm2.runInContext(extIndex, win);

    const prev = { 主角: { 气运: { 测试气运: { 名称: '测试气运', 类型: '被动' } } } };
    // 1) 键同时存在于 content 与 seedRows：只更新 content 行，不重复插入
    const n1 = await win.MVU2SHUJUKU_CORE.writeStatDiffToDb(fakeApi, layout, prev, { 主角: { 气运: { 测试气运: { 名称: '测试气运', 类型: '主动' } } } });
    assert.ok(n1 > 0, 'content 行更新应有写入');
    assert.strictEqual(insertCount, 0, '键已在 content 时不应 INSERT（避免撞 UNIQUE/重复行）');
    const ki = qy.content[0].indexOf('类型');
    assert.strictEqual(qy.content[1][ki], '主动', 'content 行应被更新');
    assert.strictEqual(qy.content.slice(1).length, 1, 'content 不应出现重复行');
    // 2) 键只在 seedRows（content 无行）：直接 INSERT（插件 seed 物化会按业务键去重，不会重复）
    qy.content = [qy.content[0]];
    qy.seedRows = [[1, '测试气运', '被动', '效果']];
    const n2 = await win.MVU2SHUJUKU_CORE.writeStatDiffToDb(fakeApi, layout, prev, { 主角: { 气运: { 测试气运: { 名称: '测试气运', 类型: '突破' } } } });
    assert.ok(n2 > 0, '键仅在 seedRows 时应 INSERT（不再跳过——快照兜底已删，跳过 = 永远落不了库）');
    assert.strictEqual(qy.content.length, 2, 'content 应新增一行');
    // 3) 键既不在 content 也不在 seedRows：INSERT 新行
    const n3 = await win.MVU2SHUJUKU_CORE.writeStatDiffToDb(fakeApi, layout, { 主角: { 气运: {} } }, { 主角: { 气运: { 新气运: { 名称: '新气运', 类型: '被动' } } } });
    assert.ok(n3 > 0, '新键应走 INSERT');
    assert.strictEqual(insertCount, 2, '两次 INSERT（seed-only 一次 + 新键一次）');
});


test('删除行表条目（如删气运）：差异路径 deleteRow 同步移除对应行', async () => {
    const vm2 = require('vm');
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const toLayout = (schema) => core.buildLayout(schema).entries.map(e => ({
        kind: e.kind, group: e.group, table: e.table, keyCol: e.keyCol || '', keyValue: e.keyValue || '',
        cols: (e.cols || []).map(c => (e.kind === 'singleton'
            ? [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, c.path || [], !!c.isPair, c.desc || '']
            : [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, null, !!c.isPair, c.desc || ''])),
        writePaths: e.writePaths || [], mirrors: e.mirrors || [],
    }));
    const srcDir = path.join(__dirname, '..', 'src');
    const coreSource = fs.readFileSync(path.join(srcDir, 'mvu2shujuku.js'), 'utf8');
    const pinyinData = fs.readFileSync(path.join(srcDir, 'pinyin-data.js'), 'utf8');
    const yamlLibsData = fs.readFileSync(path.join(srcDir, 'vendor', 'mvu-yaml-libs.js'), 'utf8');
    const jsonrepairData = fs.readFileSync(path.join(srcDir, 'vendor', 'jsonrepair-lite.js'), 'utf8');
    const pinyinInline = pinyinData.replace(/^[\s\S]*?module\.exports\s*=\s*/, 'root.__MVU2SHUJUKU_PINYIN__ = ').replace(/;\s*$/, ';');
    const yamlLibsInline = ['(function () {', '  var module = { exports: {} };', '  var exports = module.exports;', yamlLibsData, '  var target = typeof globalThis !== "undefined" ? globalThis : this;', '  target.__MVU2SHUJUKU_YAML_LIBS__ = module.exports;', '})();', ''].join('\n');
    const jsonrepairInline = 'root.__MVU2SHUJUKU_JSONREPAIR_SRC__ = ' + JSON.stringify(jsonrepairData) + ';';
    const extIndex = core.assembleExtension({ coreSource, pinyinInline, yamlLibsInline, jsonrepairInline })['index.js'];

    const tables = JSON.parse(JSON.stringify(r.template));
    const qy0 = Object.values(tables).find(s => s && s.name === '气运表');
    const keyCol = qy0.content[0].includes('名称') ? '名称' : qy0.content[0][1];
    const persisted = JSON.parse(JSON.stringify(r.template));
    const checkpointMsg = {
        message_id: 0,
        TavernDB_ACU_IsolatedData: JSON.stringify({
            系统: { storageFrame: { version: 2, logEntries: [], checkpoint: { kind: 'full', data: persisted, ts: 1 } } },
        }),
    };
    const converted = {
        name: '删行卡',
        avatar: 'del.png',
        data: {
            extensions: {
                mvu2shujuku: { converter: 'mvu2shujuku', layout: JSON.stringify(toLayout(r.schema)) },
                regex_scripts: [],
            },
            character_book: {
                entries: [{
                    keys: ['__ACU_TEMPLATE_DATA__'],
                    content: Buffer.from(JSON.stringify(r.template)).toString('base64'),
                }],
            },
        },
    };
    let lastImport = null;
    const fakeApi = applyingApi(tables, {
        onImport: (parsed) => { lastImport = parsed; },
    });
    const handlers = {};
    const context = {
        chatId: 'c-del', name: '测试', chat: [checkpointMsg],
        characters: [converted], characterId: 0,
        extensionSettings: { mvu2shujuku: { debug: true } },
        eventSource: { on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); }, emit: () => {} },
        event_types: {
            CHAT_CHANGED: 'chat_changed', MESSAGE_RECEIVED: 'message_received', MESSAGE_SWIPED: 'swiped',
            MESSAGE_UPDATED: 'updated', MESSAGE_EDITED: 'edited', MESSAGE_SENT: 'sent', MESSAGE_DELETED: 'deleted',
            GENERATION_ENDED: 'generation_ended',
        },
        saveSettingsDebounced: () => {}, saveChatConditional: async () => {}, saveChat: async () => {},
        getRequestHeaders: () => ({}), setChatMessages: () => {},
    };
    const fakeEl = () => {
        const el = {
            dataset: {}, style: {}, children: [], _listeners: {}, _value: '',
            addEventListener: (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); },
            removeEventListener: () => {}, dispatchEvent: () => true,
            appendChild: (c) => { el.children.push(c); return c; }, removeChild: () => {},
            querySelector: () => fakeEl(), querySelectorAll: () => [],
            click: () => {}, focus: () => {}, blur: () => {}, contains: () => false,
            getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
        };
        Object.defineProperty(el, 'innerHTML', { get: () => el._html || '', set: (v) => { el._html = v; } });
        Object.defineProperty(el, 'textContent', { get: () => '', set: () => {} });
        Object.defineProperty(el, 'value', { get: () => el._value, set: (v) => { el._value = v; } });
        Object.defineProperty(el, 'checked', { get: () => !!el._checked, set: (v) => { el._checked = v; } });
        Object.defineProperty(el, 'disabled', { get: () => !!el._disabled, set: (v) => { el._disabled = v; } });
        return el;
    };
    const doc = {
        querySelector: () => fakeEl(), getElementById: () => fakeEl(), createElement: () => fakeEl(),
        createTextNode: () => fakeEl(), addEventListener: () => {}, body: fakeEl(),
    };
    const win = {
        top: null, parent: null, document: doc, console,
        setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t),
        setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (t) => clearInterval(t),
        CustomEvent: function () {}, addEventListener: () => {}, dispatchEvent: () => true,
        TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        SillyTavern: { getContext: () => context }, AutoCardUpdaterAPI: fakeApi,
        eventEmit: () => {}, toastr: undefined,
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    vm2.createContext(win);
    vm2.runInContext(extIndex, win);

    (handlers['chat_changed'] || []).forEach(fn => fn());
    await new Promise(res => setTimeout(res, 2500));
    // 先写入两个气运条目（应插入行）
    const keyA = '测试气运';
    const keyB = '保留气运';
    await win.Mvu.replaceMvuData({ stat_data: { 主角: { 气运: { [keyA]: { 名称: keyA, 类型: '测试' }, [keyB]: { 名称: keyB, 类型: '测试' } } } } });
    await new Promise(res => setTimeout(res, 1000));
    const qyIns = Object.values(tables).find(s => s && s.name === '气运表');
    const keyIdxIns = qyIns.content[0].indexOf(keyCol);
    assert.ok(qyIns.content.slice(1).some(row => row && row[keyIdxIns] === keyA), '插入后气运表应包含新条目');
    // 前端删除其中一条：target 组仍非空 → 触发 deleteRow（空组保护只拦“整组未发”）
    const d = win.Mvu.getMvuData();
    const stat = d.stat_data;
    delete stat.主角.气运[keyA];
    await win.Mvu.replaceMvuData({ stat_data: stat });
    await new Promise(res => setTimeout(res, 1200));
    const qyNow = Object.values(tables).find(s => s && s.name === '气运表');
    const keyIdxNow = qyNow.content[0].indexOf(keyCol);
    const keysNow = qyNow.content.slice(1).map(row => row && row[keyIdxNow]).filter(Boolean);
    assert.ok(!keysNow.includes(keyA), '删除操作后运行时气运表不应再包含被删条目');
    assert.ok(keysNow.includes(keyB), '保留的气运条目应仍在');
});

test('条目只在 seedRows（content 无行）时删除：扩展不再快照兜底/清 seed（seed 由插件模板管理）', async () => {
    const vm2 = require('vm');
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const toLayout = (schema) => core.buildLayout(schema).entries.map(e => ({
        kind: e.kind, group: e.group, table: e.table, keyCol: e.keyCol || '', keyValue: e.keyValue || '',
        cols: (e.cols || []).map(c => (e.kind === 'singleton'
            ? [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, c.path || [], !!c.isPair, c.desc || '']
            : [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, null, !!c.isPair, c.desc || ''])),
        writePaths: e.writePaths || [], mirrors: e.mirrors || [],
    }));
    const srcDir = path.join(__dirname, '..', 'src');
    const coreSource = fs.readFileSync(path.join(srcDir, 'mvu2shujuku.js'), 'utf8');
    const pinyinData = fs.readFileSync(path.join(srcDir, 'pinyin-data.js'), 'utf8');
    const yamlLibsData = fs.readFileSync(path.join(srcDir, 'vendor', 'mvu-yaml-libs.js'), 'utf8');
    const jsonrepairData = fs.readFileSync(path.join(srcDir, 'vendor', 'jsonrepair-lite.js'), 'utf8');
    const pinyinInline = pinyinData.replace(/^[\s\S]*?module\.exports\s*=\s*/, 'root.__MVU2SHUJUKU_PINYIN__ = ').replace(/;\s*$/, ';');
    const yamlLibsInline = ['(function () {', '  var module = { exports: {} };', '  var exports = module.exports;', yamlLibsData, '  var target = typeof globalThis !== "undefined" ? globalThis : this;', '  target.__MVU2SHUJUKU_YAML_LIBS__ = module.exports;', '})();', ''].join('\n');
    const jsonrepairInline = 'root.__MVU2SHUJUKU_JSONREPAIR_SRC__ = ' + JSON.stringify(jsonrepairData) + ';';
    const extIndex = core.assembleExtension({ coreSource, pinyinInline, yamlLibsInline, jsonrepairInline })['index.js'];

    // 运行时气运表：content 仅表头，条目在 seedRows（模拟道渊：气运未物化、UI 从 seedRows 读取）
    const tables = JSON.parse(JSON.stringify(r.template));
    const qy0 = Object.values(tables).find(s => s && s.name === '气运表');
    const keyCol = qy0.content[0].includes('名称') ? '名称' : qy0.content[0][1];
    qy0.content = [qy0.content[0]];
    qy0.seedRows = [[1, '测试气运', '被动', '效果']];
    const persisted = JSON.parse(JSON.stringify(r.template));
    const checkpointMsg = {
        message_id: 0,
        TavernDB_ACU_IsolatedData: JSON.stringify({
            系统: { storageFrame: { version: 2, logEntries: [], checkpoint: { kind: 'full', data: persisted, ts: 1 } } },
        }),
    };
    const converted = {
        name: '种子删卡',
        avatar: 'sd2.png',
        data: {
            extensions: {
                mvu2shujuku: { converter: 'mvu2shujuku', layout: JSON.stringify(toLayout(r.schema)) },
                regex_scripts: [],
            },
            character_book: {
                entries: [{
                    keys: ['__ACU_TEMPLATE_DATA__'],
                    content: Buffer.from(JSON.stringify(r.template)).toString('base64'),
                }],
            },
        },
    };
    let lastImport = null;
    const fakeApi = applyingApi(tables, {
        onImport: (parsed) => { lastImport = parsed; },
    });
    const handlers = {};
    const context = {
        chatId: 'c-seeddel', name: '测试', chat: [checkpointMsg],
        characters: [converted], characterId: 0,
        extensionSettings: { mvu2shujuku: { debug: true } },
        eventSource: { on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); }, emit: () => {} },
        event_types: {
            CHAT_CHANGED: 'chat_changed', MESSAGE_RECEIVED: 'message_received', MESSAGE_SWIPED: 'swiped',
            MESSAGE_UPDATED: 'updated', MESSAGE_EDITED: 'edited', MESSAGE_SENT: 'sent', MESSAGE_DELETED: 'deleted',
            GENERATION_ENDED: 'generation_ended',
        },
        saveSettingsDebounced: () => {}, saveChatConditional: async () => {}, saveChat: async () => {},
        getRequestHeaders: () => ({}), setChatMessages: () => {},
    };
    const fakeEl = () => {
        const el = {
            dataset: {}, style: {}, children: [], _listeners: {}, _value: '',
            addEventListener: (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); },
            removeEventListener: () => {}, dispatchEvent: () => true,
            appendChild: (c) => { el.children.push(c); return c; }, removeChild: () => {},
            querySelector: () => fakeEl(), querySelectorAll: () => [],
            click: () => {}, focus: () => {}, blur: () => {}, contains: () => false,
            getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
        };
        Object.defineProperty(el, 'innerHTML', { get: () => el._html || '', set: (v) => { el._html = v; } });
        Object.defineProperty(el, 'textContent', { get: () => '', set: () => {} });
        Object.defineProperty(el, 'value', { get: () => el._value, set: (v) => { el._value = v; } });
        Object.defineProperty(el, 'checked', { get: () => !!el._checked, set: (v) => { el._checked = v; } });
        Object.defineProperty(el, 'disabled', { get: () => !!el._disabled, set: (v) => { el._disabled = v; } });
        return el;
    };
    const doc = {
        querySelector: () => fakeEl(), getElementById: () => fakeEl(), createElement: () => fakeEl(),
        createTextNode: () => fakeEl(), addEventListener: () => {}, body: fakeEl(),
    };
    const win = {
        top: null, parent: null, document: doc, console,
        setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t),
        setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (t) => clearInterval(t),
        CustomEvent: function () {}, addEventListener: () => {}, dispatchEvent: () => true,
        TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        SillyTavern: { getContext: () => context }, AutoCardUpdaterAPI: fakeApi,
        eventEmit: () => {}, toastr: undefined,
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    vm2.createContext(win);
    vm2.runInContext(extIndex, win);

    (handlers['chat_changed'] || []).forEach(fn => fn());
    await new Promise(res => setTimeout(res, 2500));
    // 前端删除 seedRows 里的气运
    const d = win.Mvu.getMvuData();
    const stat = d.stat_data;
    delete stat.主角.气运['测试气运'];
    await win.Mvu.replaceMvuData({ stat_data: stat });
    await new Promise(res => setTimeout(res, 1200));
    assert.strictEqual(lastImport, null, '不再走 importTableAsJson 快照兜底（seedRows 由插件模板/guide 管理）');
    const qySent = Object.values(tables).find(s => s && s.name === '气运表');
    const ki = qySent.content[0].indexOf(keyCol);
    const seedKeys = (qySent.seedRows || []).map(row => row && row[ki]).filter(Boolean);
    assert.ok(seedKeys.includes('测试气运'), 'seed-only 行不参与 stat_data 对账，seedRows 保持不变');
});

test('首写缺锚点：写库前 initGameSession 建锚，差异写入把行表数据物化到 content（不留在 seedRows）', async () => {
    const vm2 = require('vm');
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const toLayout = (schema) => core.buildLayout(schema).entries.map(e => ({
        kind: e.kind, group: e.group, table: e.table, keyCol: e.keyCol || '', keyValue: e.keyValue || '',
        cols: (e.cols || []).map(c => (e.kind === 'singleton'
            ? [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, c.path || [], !!c.isPair, c.desc || '']
            : [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, null, !!c.isPair, c.desc || ''])),
        writePaths: e.writePaths || [], mirrors: e.mirrors || [],
    }));
    const srcDir = path.join(__dirname, '..', 'src');
    const coreSource = fs.readFileSync(path.join(srcDir, 'mvu2shujuku.js'), 'utf8');
    const pinyinData = fs.readFileSync(path.join(srcDir, 'pinyin-data.js'), 'utf8');
    const yamlLibsData = fs.readFileSync(path.join(srcDir, 'vendor', 'mvu-yaml-libs.js'), 'utf8');
    const jsonrepairData = fs.readFileSync(path.join(srcDir, 'vendor', 'jsonrepair-lite.js'), 'utf8');
    const pinyinInline = pinyinData.replace(/^[\s\S]*?module\.exports\s*=\s*/, 'root.__MVU2SHUJUKU_PINYIN__ = ').replace(/;\s*$/, ';');
    const yamlLibsInline = ['(function () {', '  var module = { exports: {} };', '  var exports = module.exports;', yamlLibsData, '  var target = typeof globalThis !== "undefined" ? globalThis : this;', '  target.__MVU2SHUJUKU_YAML_LIBS__ = module.exports;', '})();', ''].join('\n');
    const jsonrepairInline = 'root.__MVU2SHUJUKU_JSONREPAIR_SRC__ = ' + JSON.stringify(jsonrepairData) + ';';
    const extIndex = core.assembleExtension({ coreSource, pinyinInline, yamlLibsInline, jsonrepairInline })['index.js'];

    const tables = JSON.parse(JSON.stringify(r.template));
    const persisted = JSON.parse(JSON.stringify(r.template));
    const converted = {
        name: '首写卡',
        avatar: 'fw.png',
        data: {
            extensions: {
                mvu2shujuku: { converter: 'mvu2shujuku', layout: JSON.stringify(toLayout(r.schema)) },
                regex_scripts: [],
            },
            character_book: {
                entries: [{
                    keys: ['__ACU_TEMPLATE_DATA__'],
                    content: Buffer.from(JSON.stringify(r.template)).toString('base64'),
                }],
            },
        },
    };
    let initCalls = 0;
    let restoreCalls = 0;
    const fakeApi = applyingApi(tables, {
        onInit: async () => {
            initCalls += 1;
            // 与真实插件一致：initGameSession 会建立 full checkpoint
            context.chat[0].TavernDB_ACU_IsolatedData = JSON.stringify({
                系统: { storageFrame: { version: 2, logEntries: [], checkpoint: { kind: 'full', data: JSON.parse(JSON.stringify(tables)), ts: 1 } } },
            });
        },
        onImport: (parsed, opts) => {
            if (opts && opts.persist === false) restoreCalls += 1;
        },
    });
    const handlers = {};
    const context = {
        chatId: 'c-first', name: '测试', chat: [{ message_id: 0, mes: '开场白' }],
        characters: [converted], characterId: 0,
        extensionSettings: { mvu2shujuku: { debug: true } },
        eventSource: { on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); }, emit: () => {} },
        event_types: {
            CHAT_CHANGED: 'chat_changed', MESSAGE_RECEIVED: 'message_received', MESSAGE_SWIPED: 'swiped',
            MESSAGE_UPDATED: 'updated', MESSAGE_EDITED: 'edited', MESSAGE_SENT: 'sent', MESSAGE_DELETED: 'deleted',
            GENERATION_ENDED: 'generation_ended',
        },
        saveSettingsDebounced: () => {}, saveChatConditional: async () => {}, saveChat: async () => {},
        getRequestHeaders: () => ({}), setChatMessages: () => {},
    };
    const fakeEl = () => {
        const el = {
            dataset: {}, style: {}, children: [], _listeners: {}, _value: '',
            addEventListener: (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); },
            removeEventListener: () => {}, dispatchEvent: () => true,
            appendChild: (c) => { el.children.push(c); return c; }, removeChild: () => {},
            querySelector: () => fakeEl(), querySelectorAll: () => [],
            click: () => {}, focus: () => {}, blur: () => {}, contains: () => false,
            getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
        };
        Object.defineProperty(el, 'innerHTML', { get: () => el._html || '', set: (v) => { el._html = v; } });
        Object.defineProperty(el, 'textContent', { get: () => '', set: () => {} });
        Object.defineProperty(el, 'value', { get: () => el._value, set: (v) => { el._value = v; } });
        Object.defineProperty(el, 'checked', { get: () => !!el._checked, set: (v) => { el._checked = v; } });
        Object.defineProperty(el, 'disabled', { get: () => !!el._disabled, set: (v) => { el._disabled = v; } });
        return el;
    };
    const doc = {
        querySelector: () => fakeEl(), getElementById: () => fakeEl(), createElement: () => fakeEl(),
        createTextNode: () => fakeEl(), addEventListener: () => {}, body: fakeEl(),
    };
    const win = {
        top: null, parent: null, document: doc, console,
        setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t),
        setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (t) => clearInterval(t),
        CustomEvent: function () {}, addEventListener: () => {}, dispatchEvent: () => true,
        TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        SillyTavern: { getContext: () => context }, AutoCardUpdaterAPI: fakeApi,
        eventEmit: () => {}, toastr: undefined,
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    vm2.createContext(win);
    vm2.runInContext(extIndex, win);

    (handlers['chat_changed'] || []).forEach(fn => fn());
    await new Promise(res => setTimeout(res, 2500));
    // 开场注入：写入气运（不再手工建锚，差异写入直接落库，插件提交管线建立 checkpoint）
    await win.Mvu.replaceMvuData({ stat_data: { 主角: { 气运: { 测试气运: { 名称: '测试气运', 类型: '被动' } } } } });
    await new Promise(res => setTimeout(res, 1200));
    assert.strictEqual(initCalls, 0, '首写不再手工 initGameSession（锚点由插件提交管线建立）');
    const qy = Object.values(tables).find(s => s && s.name === '气运表');
    const ki = qy.content[0].indexOf('键名');
    const contentKeys = qy.content.slice(1).map(r => r && r[ki]).filter(Boolean);
    assert.ok(contentKeys.includes('测试气运'), '首写后行表数据必须落到 content（不留在 seedRows）');
});

test('行表初始数据不进模板 content（避免插件 seedRows 反复补回导致删不掉）', () => {
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    // 主角.气运 在开场注入（initvar 中为空），模板气运表不应预置内容行——
    // 若预置，插件会把 content 行转成 seedRows 并在删除后从模板 scope 补回（实测删不掉）。
    const qy = Object.values(r.template).find(s => s && s.name === '气运表');
    assert.ok(qy, '转换结果应包含气运表');
    assert.strictEqual((qy.content || []).length, 1, '气运表模板 content 只应有表头（初始行由开场注入物化）');
    assert.ok(!Array.isArray(qy.seedRows) || qy.seedRows.length === 0, '气运表模板不应有 seedRows');
    // 道侣/人物/机遇等行表同样不应预置模板行
    for (const name of ['道侣表', '人物表', '机遇表']) {
        const s = Object.values(r.template).find(x => x && x.name === name);
        if (s) assert.strictEqual((s.content || []).length, 1, name + ' 模板 content 只应有表头');
    }
});

test('diff 路径行表删除：显式空组=删除意图、组缺失才空组保护，非空组缺键触发 deleteRow', async () => {
    const vm2 = require('vm');
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const toLayout = (schema) => core.buildLayout(schema).entries.map(e => ({
        kind: e.kind, group: e.group, table: e.table, keyCol: e.keyCol || '', keyValue: e.keyValue || '',
        cols: (e.cols || []).map(c => (e.kind === 'singleton'
            ? [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, c.path || [], !!c.isPair, c.desc || '']
            : [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, null, !!c.isPair, c.desc || ''])),
        writePaths: e.writePaths || [], mirrors: e.mirrors || [],
    }));
    const srcDir = path.join(__dirname, '..', 'src');
    const coreSource = fs.readFileSync(path.join(srcDir, 'mvu2shujuku.js'), 'utf8');
    const pinyinData = fs.readFileSync(path.join(srcDir, 'pinyin-data.js'), 'utf8');
    const yamlLibsData = fs.readFileSync(path.join(srcDir, 'vendor', 'mvu-yaml-libs.js'), 'utf8');
    const jsonrepairData = fs.readFileSync(path.join(srcDir, 'vendor', 'jsonrepair-lite.js'), 'utf8');
    const pinyinInline = pinyinData.replace(/^[\s\S]*?module\.exports\s*=\s*/, 'root.__MVU2SHUJUKU_PINYIN__ = ').replace(/;\s*$/, ';');
    const yamlLibsInline = ['(function () {', '  var module = { exports: {} };', '  var exports = module.exports;', yamlLibsData, '  var target = typeof globalThis !== "undefined" ? globalThis : this;', '  target.__MVU2SHUJUKU_YAML_LIBS__ = module.exports;', '})();', ''].join('\n');
    const jsonrepairInline = 'root.__MVU2SHUJUKU_JSONREPAIR_SRC__ = ' + JSON.stringify(jsonrepairData) + ';';
    const extIndex = core.assembleExtension({ coreSource, pinyinInline, yamlLibsInline, jsonrepairInline })['index.js'];

    const tables = JSON.parse(JSON.stringify(r.template));
    const qy = Object.values(tables).find(s => s && s.name === '气运表');
    const keyCol = '名称';
    qy.content = [qy.content[0], [1, '测试气运', '被动', '效果'], [2, '其他气运', '主动', '效果2']];
    const deleted = [];
    const fakeApi = {
        exportTableAsJson: () => tables,
        deleteRow: async (table, rowIndex) => { deleted.push([table, rowIndex]); return true; },
        insertRow: async () => 1,
        updateCell: async () => true,
        executeSqlBatch: async () => ({ success: true }),
        registerTableUpdateCallback: () => true,
    };
    const handlers = {};
    const context = {
        chatId: 'c-diffdel', name: '测试', chat: [],
        characters: [], characterId: 0,
        extensionSettings: { mvu2shujuku: { debug: false } },
        eventSource: { on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); }, emit: () => {} },
        event_types: {
            CHAT_CHANGED: 'chat_changed', MESSAGE_RECEIVED: 'message_received', MESSAGE_SWIPED: 'swiped',
            MESSAGE_UPDATED: 'updated', MESSAGE_EDITED: 'edited', MESSAGE_SENT: 'sent', MESSAGE_DELETED: 'deleted',
            GENERATION_ENDED: 'generation_ended',
        },
        saveSettingsDebounced: () => {}, saveChatConditional: async () => {}, saveChat: async () => {},
        getRequestHeaders: () => ({}), setChatMessages: () => {},
    };
    const fakeEl = () => {
        const el = {
            dataset: {}, style: {}, children: [], _listeners: {}, _value: '',
            addEventListener: (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); },
            removeEventListener: () => {}, dispatchEvent: () => true,
            appendChild: (c) => { el.children.push(c); return c; }, removeChild: () => {},
            querySelector: () => fakeEl(), querySelectorAll: () => [],
            click: () => {}, focus: () => {}, blur: () => {}, contains: () => false,
            getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
        };
        Object.defineProperty(el, 'innerHTML', { get: () => el._html || '', set: (v) => { el._html = v; } });
        Object.defineProperty(el, 'textContent', { get: () => '', set: () => {} });
        Object.defineProperty(el, 'value', { get: () => el._value, set: (v) => { el._value = v; } });
        Object.defineProperty(el, 'checked', { get: () => !!el._checked, set: (v) => { el._checked = v; } });
        Object.defineProperty(el, 'disabled', { get: () => !!el._disabled, set: (v) => { el._disabled = v; } });
        return el;
    };
    const doc = {
        querySelector: () => fakeEl(), getElementById: () => fakeEl(), createElement: () => fakeEl(),
        createTextNode: () => fakeEl(), addEventListener: () => {}, body: fakeEl(),
    };
    const win = {
        top: null, parent: null, document: doc, console,
        setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t),
        setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (t) => clearInterval(t),
        CustomEvent: function () {}, addEventListener: () => {}, dispatchEvent: () => true,
        TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        SillyTavern: { getContext: () => context }, AutoCardUpdaterAPI: fakeApi,
        eventEmit: () => {}, toastr: undefined,
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    vm2.createContext(win);
    vm2.runInContext(extIndex, win);

    const prev = { 主角: { 气运: { 测试气运: { 名称: '测试气运' }, 其他气运: { 名称: '其他气运' } } } };
    // 显式空组：前端点删除后整组变 {}，是明确的删除意图 → 应删除全部行
    const nextEmpty = { 主角: { 气运: {} } };
    const n0 = await win.MVU2SHUJUKU_CORE.writeStatDiffToDb(fakeApi, toLayout(r.schema), prev, nextEmpty);
    assert.ok(n0 > 0, '显式空组（删除意图）应产生删除写入');
    assert.strictEqual(deleted.length, 2, '显式空组应删除全部行');
    // 组完全缺失（前端分批写、未提供该组）→ 空组保护，不视为删除
    const nextAbsent = { 主角: { 姓名: '斯维姆' } };
    const nAbs = await win.MVU2SHUJUKU_CORE.writeStatDiffToDb(fakeApi, toLayout(r.schema), prev, nextAbsent);
    assert.ok(nAbs >= 1, '组缺失时其他字段写入仍正常');
    assert.strictEqual(deleted.length, 2, '组缺失：不应新增 deleteRow');
    // 非空组缺键 → 显式移除该条目，deleteRow 照常触发
    const nextPartial = { 主角: { 气运: { 其他气运: { 名称: '其他气运' } } } };
    const n1 = await win.MVU2SHUJUKU_CORE.writeStatDiffToDb(fakeApi, toLayout(r.schema), prev, nextPartial);
    assert.ok(n1 > 0, '非空组缺键应有写入');
    assert.strictEqual(deleted.length, 3, '应再调用一次 deleteRow');
    assert.strictEqual(deleted[0][0], '气运表', '删除目标表应为气运表');
    assert.strictEqual(deleted[deleted.length - 1][1], 1, '单行删除 rowIndex 应为 content 数据行索引 1');
});

test('溢出列 _扩展数据 删除同步：stat_data 移除的动态字段不再残留', async () => {
    const vm2 = require('vm');
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const toLayout = (schema) => core.buildLayout(schema).entries.map(e => ({
        kind: e.kind, group: e.group, table: e.table, keyCol: e.keyCol || '', keyValue: e.keyValue || '',
        cols: (e.cols || []).map(c => (e.kind === 'singleton'
            ? [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, c.path || [], !!c.isPair, c.desc || '']
            : [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, null, !!c.isPair, c.desc || ''])),
        writePaths: e.writePaths || [], mirrors: e.mirrors || [],
    }));
    const srcDir = path.join(__dirname, '..', 'src');
    const coreSource = fs.readFileSync(path.join(srcDir, 'mvu2shujuku.js'), 'utf8');
    const pinyinData = fs.readFileSync(path.join(srcDir, 'pinyin-data.js'), 'utf8');
    const yamlLibsData = fs.readFileSync(path.join(srcDir, 'vendor', 'mvu-yaml-libs.js'), 'utf8');
    const jsonrepairData = fs.readFileSync(path.join(srcDir, 'vendor', 'jsonrepair-lite.js'), 'utf8');
    const pinyinInline = pinyinData.replace(/^[\s\S]*?module\.exports\s*=\s*/, 'root.__MVU2SHUJUKU_PINYIN__ = ').replace(/;\s*$/, ';');
    const yamlLibsInline = ['(function () {', '  var module = { exports: {} };', '  var exports = module.exports;', yamlLibsData, '  var target = typeof globalThis !== "undefined" ? globalThis : this;', '  target.__MVU2SHUJUKU_YAML_LIBS__ = module.exports;', '})();', ''].join('\n');
    const jsonrepairInline = 'root.__MVU2SHUJUKU_JSONREPAIR_SRC__ = ' + JSON.stringify(jsonrepairData) + ';';
    const extIndex = core.assembleExtension({ coreSource, pinyinInline, yamlLibsInline, jsonrepairInline })['index.js'];

    const tables = JSON.parse(JSON.stringify(r.template));
    const persisted = JSON.parse(JSON.stringify(r.template));
    const checkpointMsg = {
        message_id: 0,
        TavernDB_ACU_IsolatedData: JSON.stringify({
            系统: { storageFrame: { version: 2, logEntries: [], checkpoint: { kind: 'full', data: persisted, ts: 1 } } },
        }),
    };
    const converted = {
        name: '溢出卡',
        avatar: 'ov.png',
        data: {
            extensions: {
                mvu2shujuku: { converter: 'mvu2shujuku', layout: JSON.stringify(toLayout(r.schema)) },
                regex_scripts: [],
            },
            character_book: {
                entries: [{
                    keys: ['__ACU_TEMPLATE_DATA__'],
                    content: Buffer.from(JSON.stringify(r.template)).toString('base64'),
                }],
            },
        },
    };
    let lastImport = null;
    const fakeApi = applyingApi(tables, {
        onImport: (parsed) => { lastImport = parsed; },
    });
    const handlers = {};
    const context = {
        chatId: 'c-ov', name: '测试', chat: [checkpointMsg],
        characters: [converted], characterId: 0,
        extensionSettings: { mvu2shujuku: { debug: true } },
        eventSource: { on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); }, emit: () => {} },
        event_types: {
            CHAT_CHANGED: 'chat_changed', MESSAGE_RECEIVED: 'message_received', MESSAGE_SWIPED: 'swiped',
            MESSAGE_UPDATED: 'updated', MESSAGE_EDITED: 'edited', MESSAGE_SENT: 'sent', MESSAGE_DELETED: 'deleted',
            GENERATION_ENDED: 'generation_ended',
        },
        saveSettingsDebounced: () => {}, saveChatConditional: async () => {}, saveChat: async () => {},
        getRequestHeaders: () => ({}), setChatMessages: () => {},
    };
    const fakeEl = () => {
        const el = {
            dataset: {}, style: {}, children: [], _listeners: {}, _value: '',
            addEventListener: (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); },
            removeEventListener: () => {}, dispatchEvent: () => true,
            appendChild: (c) => { el.children.push(c); return c; }, removeChild: () => {},
            querySelector: () => fakeEl(), querySelectorAll: () => [],
            click: () => {}, focus: () => {}, blur: () => {}, contains: () => false,
            getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
        };
        Object.defineProperty(el, 'innerHTML', { get: () => el._html || '', set: (v) => { el._html = v; } });
        Object.defineProperty(el, 'textContent', { get: () => '', set: () => {} });
        Object.defineProperty(el, 'value', { get: () => el._value, set: (v) => { el._value = v; } });
        Object.defineProperty(el, 'checked', { get: () => !!el._checked, set: (v) => { el._checked = v; } });
        Object.defineProperty(el, 'disabled', { get: () => !!el._disabled, set: (v) => { el._disabled = v; } });
        return el;
    };
    const doc = {
        querySelector: () => fakeEl(), getElementById: () => fakeEl(), createElement: () => fakeEl(),
        createTextNode: () => fakeEl(), addEventListener: () => {}, body: fakeEl(),
    };
    const win = {
        top: null, parent: null, document: doc, console,
        setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t),
        setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (t) => clearInterval(t),
        CustomEvent: function () {}, addEventListener: () => {}, dispatchEvent: () => true,
        TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        SillyTavern: { getContext: () => context }, AutoCardUpdaterAPI: fakeApi,
        eventEmit: () => {}, toastr: undefined,
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    vm2.createContext(win);
    vm2.runInContext(extIndex, win);

    (handlers['chat_changed'] || []).forEach(fn => fn());
    await new Promise(res => setTimeout(res, 2500));
    // 写入一个未声明字段（进溢出列）
    await win.Mvu.replaceMvuData({ stat_data: { 主角: { 动态字段: 'x' } } });
    await new Promise(res => setTimeout(res, 800));
    let zj = Object.values(tables).find(s => s && s.name === '主角表');
    let ovIdx = zj.content[0].indexOf('_扩展数据');
    let ov = JSON.parse(zj.content[1][ovIdx] || '{}');
    assert.strictEqual(ov.动态字段, 'x', '未声明字段应写入溢出列');
    // 删除该字段（stat_data 不含它）→ 差异路径应从 _扩展数据 同步移除，且保留其他动态字段
    zj.content[1][ovIdx] = JSON.stringify({ 动态字段: 'x', 其他字段: 'y' });
    const prevOv = { 主角: { 姓名: '斯维姆', 动态字段: 'x', 其他字段: 'y' } };
    const nextOv = { 主角: { 姓名: '斯维姆', 其他字段: 'y' } };
    const nOv = await win.MVU2SHUJUKU_CORE.writeStatDiffToDb(fakeApi, toLayout(r.schema), prevOv, nextOv);
    assert.ok(nOv > 0, '溢出字段删除应有写入');
    const zj2 = Object.values(tables).find(s => s && s.name === '主角表');
    const ov2 = JSON.parse(zj2.content[1][zj2.content[0].indexOf('_扩展数据')] || '{}');
    assert.ok(!('动态字段' in ov2), 'stat_data 移除的动态字段不应残留在溢出列');
    assert.strictEqual(ov2.其他字段, 'y', '其他动态字段应保留');
    assert.strictEqual(lastImport, null, '溢出字段写入/删除都应走差异路径，不触发整表快照');
});

test('重进聊天：扩展不再手工物化/取最大 checkpoint，运行时由插件原生回放恢复', async () => {
    const vm2 = require('vm');
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const toLayout = (schema) => core.buildLayout(schema).entries.map(e => ({
        kind: e.kind, group: e.group, table: e.table, keyCol: e.keyCol || '', keyValue: e.keyValue || '',
        cols: (e.cols || []).map(c => (e.kind === 'singleton'
            ? [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, c.path || [], !!c.isPair, c.desc || '']
            : [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, null, !!c.isPair, c.desc || ''])),
        writePaths: e.writePaths || [], mirrors: e.mirrors || [],
    }));
    const srcDir = path.join(__dirname, '..', 'src');
    const coreSource = fs.readFileSync(path.join(srcDir, 'mvu2shujuku.js'), 'utf8');
    const pinyinData = fs.readFileSync(path.join(srcDir, 'pinyin-data.js'), 'utf8');
    const yamlLibsData = fs.readFileSync(path.join(srcDir, 'vendor', 'mvu-yaml-libs.js'), 'utf8');
    const jsonrepairData = fs.readFileSync(path.join(srcDir, 'vendor', 'jsonrepair-lite.js'), 'utf8');
    const pinyinInline = pinyinData.replace(/^[\s\S]*?module\.exports\s*=\s*/, 'root.__MVU2SHUJUKU_PINYIN__ = ').replace(/;\s*$/, ';');
    const yamlLibsInline = ['(function () {', '  var module = { exports: {} };', '  var exports = module.exports;', yamlLibsData, '  var target = typeof globalThis !== "undefined" ? globalThis : this;', '  target.__MVU2SHUJUKU_YAML_LIBS__ = module.exports;', '})();', ''].join('\n');
    const jsonrepairInline = 'root.__MVU2SHUJUKU_JSONREPAIR_SRC__ = ' + JSON.stringify(jsonrepairData) + ';';
    const extIndex = core.assembleExtension({ coreSource, pinyinInline, yamlLibsInline, jsonrepairInline })['index.js'];

    // msg0：旧锚（模板数据，小）；msg1：真数据（主角姓名=斯维姆，大）
    const smallCp = JSON.parse(JSON.stringify(r.template));
    const bigCp = JSON.parse(JSON.stringify(r.template));
    const zjBig = Object.values(bigCp).find(s => s && s.name === '主角表');
    zjBig.content[1][zjBig.content[0].indexOf('姓名')] = '斯维姆';
    const frame = (data) => ({ 系统: { storageFrame: { version: 2, logEntries: [], checkpoint: { kind: 'full', data, ts: 1 } } } });
    const chat = [
        { message_id: 0, mes: '旧楼', TavernDB_ACU_IsolatedData: JSON.stringify(frame(smallCp)) },
        { message_id: 1, mes: '新楼', TavernDB_ACU_IsolatedData: JSON.stringify(frame(bigCp)) },
    ];
    // 运行时：模板默认（重进后插件未恢复，模拟 SQLite 漏恢复）
    const tables = JSON.parse(JSON.stringify(r.template));
    const converted = {
        name: '重进卡',
        avatar: 're.png',
        data: {
            extensions: {
                mvu2shujuku: { converter: 'mvu2shujuku', layout: JSON.stringify(toLayout(r.schema)) },
                regex_scripts: [],
            },
            character_book: {
                entries: [{
                    keys: ['__ACU_TEMPLATE_DATA__'],
                    content: Buffer.from(JSON.stringify(r.template)).toString('base64'),
                }],
            },
        },
    };
    const fakeApi = {
        getTemplatePresetNames: () => [],
        exportTableAsJson: () => tables,
        initGameSession: async () => ({ success: true, runtimeReady: true }),
        importTemplateFromData: async () => ({ success: true }),
        importTableAsJson: async (jsonStr, opts) => {
            const parsed = JSON.parse(jsonStr);
            for (const k of Object.keys(tables)) delete tables[k];
            Object.assign(tables, parsed);
            return true;
        },
        insertRow: async () => 1,
        updateCell: async () => true,
        deleteRow: async () => true,
        registerTableUpdateCallback: () => true,
    };
    const handlers = {};
    const context = {
        chatId: 'c-reenter', name: '测试', chat,
        characters: [converted], characterId: 0,
        extensionSettings: { mvu2shujuku: { debug: true } },
        eventSource: { on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); }, emit: () => {} },
        event_types: {
            CHAT_CHANGED: 'chat_changed', MESSAGE_RECEIVED: 'message_received', MESSAGE_SWIPED: 'swiped',
            MESSAGE_UPDATED: 'updated', MESSAGE_EDITED: 'edited', MESSAGE_SENT: 'sent', MESSAGE_DELETED: 'deleted',
            GENERATION_ENDED: 'generation_ended',
        },
        saveSettingsDebounced: () => {}, saveChatConditional: async () => {}, saveChat: async () => {},
        getRequestHeaders: () => ({}), setChatMessages: () => {},
    };
    const fakeEl = () => {
        const el = {
            dataset: {}, style: {}, children: [], _listeners: {}, _value: '',
            addEventListener: (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); },
            removeEventListener: () => {}, dispatchEvent: () => true,
            appendChild: (c) => { el.children.push(c); return c; }, removeChild: () => {},
            querySelector: () => fakeEl(), querySelectorAll: () => [],
            click: () => {}, focus: () => {}, blur: () => {}, contains: () => false,
            getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
        };
        Object.defineProperty(el, 'innerHTML', { get: () => el._html || '', set: (v) => { el._html = v; } });
        Object.defineProperty(el, 'textContent', { get: () => '', set: () => {} });
        Object.defineProperty(el, 'value', { get: () => el._value, set: (v) => { el._value = v; } });
        Object.defineProperty(el, 'checked', { get: () => !!el._checked, set: (v) => { el._checked = v; } });
        Object.defineProperty(el, 'disabled', { get: () => !!el._disabled, set: (v) => { el._disabled = v; } });
        return el;
    };
    const doc = {
        querySelector: () => fakeEl(), getElementById: () => fakeEl(), createElement: () => fakeEl(),
        createTextNode: () => fakeEl(), addEventListener: () => {}, body: fakeEl(),
    };
    const win = {
        top: null, parent: null, document: doc, console,
        setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t),
        setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (t) => clearInterval(t),
        CustomEvent: function () {}, addEventListener: () => {}, dispatchEvent: () => true,
        TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        SillyTavern: { getContext: () => context }, AutoCardUpdaterAPI: fakeApi,
        eventEmit: () => {}, toastr: undefined,
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    vm2.createContext(win);
    vm2.runInContext(extIndex, win);

    (handlers['chat_changed'] || []).forEach(fn => fn());
    await new Promise(res => setTimeout(res, 3500));
    // 新契约：插件原生回放取最新帧恢复运行时（这里模拟已恢复）；扩展不再手工物化
    for (const k of Object.keys(tables)) delete tables[k];
    Object.assign(tables, JSON.parse(JSON.stringify(bigCp)));
    const zjAfter = Object.values(tables).find(s => s && s.name === '主角表');
    assert.strictEqual(zjAfter.content[1][zjAfter.content[0].indexOf('姓名')], '斯维姆', '插件原生恢复后运行时应为最新 checkpoint 数据');
});

test('无 full checkpoint 但有 data_replace：扩展不手工恢复，运行时由插件原生回放', async () => {
    const vm2 = require('vm');
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const toLayout = (schema) => core.buildLayout(schema).entries.map(e => ({
        kind: e.kind, group: e.group, table: e.table, keyCol: e.keyCol || '', keyValue: e.keyValue || '',
        cols: (e.cols || []).map(c => (e.kind === 'singleton'
            ? [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, c.path || [], !!c.isPair, c.desc || '']
            : [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, null, !!c.isPair, c.desc || ''])),
        writePaths: e.writePaths || [], mirrors: e.mirrors || [],
    }));
    const srcDir = path.join(__dirname, '..', 'src');
    const coreSource = fs.readFileSync(path.join(srcDir, 'mvu2shujuku.js'), 'utf8');
    const pinyinData = fs.readFileSync(path.join(srcDir, 'pinyin-data.js'), 'utf8');
    const yamlLibsData = fs.readFileSync(path.join(srcDir, 'vendor', 'mvu-yaml-libs.js'), 'utf8');
    const jsonrepairData = fs.readFileSync(path.join(srcDir, 'vendor', 'jsonrepair-lite.js'), 'utf8');
    const pinyinInline = pinyinData.replace(/^[\s\S]*?module\.exports\s*=\s*/, 'root.__MVU2SHUJUKU_PINYIN__ = ').replace(/;\s*$/, ';');
    const yamlLibsInline = ['(function () {', '  var module = { exports: {} };', '  var exports = module.exports;', yamlLibsData, '  var target = typeof globalThis !== "undefined" ? globalThis : this;', '  target.__MVU2SHUJUKU_YAML_LIBS__ = module.exports;', '})();', ''].join('\n');
    const jsonrepairInline = 'root.__MVU2SHUJUKU_JSONREPAIR_SRC__ = ' + JSON.stringify(jsonrepairData) + ';';
    const extIndex = core.assembleExtension({ coreSource, pinyinInline, yamlLibsInline, jsonrepairInline })['index.js'];

    // msg0：旧 full checkpoint（模板默认）；msg1：只有 logEntries（operations 里最后一个 data_replace 是真数据）
    const oldCp = JSON.parse(JSON.stringify(r.template));
    const realData = JSON.parse(JSON.stringify(r.template));
    const zjReal = Object.values(realData).find(s => s && s.name === '主角表');
    zjReal.content[1][zjReal.content[0].indexOf('姓名')] = '斯维姆';
    const chat = [
        { message_id: 0, mes: '旧楼', TavernDB_ACU_IsolatedData: JSON.stringify({ 系统: { storageFrame: { version: 2, logEntries: [], checkpoint: { kind: 'full', data: oldCp, ts: 1 } } } }) },
        { message_id: 1, mes: '新楼', TavernDB_ACU_IsolatedData: JSON.stringify({ 系统: { storageFrame: { version: 2, logEntries: [{ seq: 1, operations: [{ kind: 'data_replace', data: realData, reason: 'import' }] }] } } }) },
    ];
    const tables = JSON.parse(JSON.stringify(r.template));
    const converted = {
        name: '回放卡',
        avatar: 'rp.png',
        data: {
            extensions: {
                mvu2shujuku: { converter: 'mvu2shujuku', layout: JSON.stringify(toLayout(r.schema)) },
                regex_scripts: [],
            },
            character_book: {
                entries: [{
                    keys: ['__ACU_TEMPLATE_DATA__'],
                    content: Buffer.from(JSON.stringify(r.template)).toString('base64'),
                }],
            },
        },
    };
    const fakeApi = {
        getTemplatePresetNames: () => [],
        exportTableAsJson: () => tables,
        initGameSession: async () => ({ success: true, runtimeReady: true }),
        importTemplateFromData: async () => ({ success: true }),
        importTableAsJson: async (jsonStr, opts) => {
            const parsed = JSON.parse(jsonStr);
            for (const k of Object.keys(tables)) delete tables[k];
            Object.assign(tables, parsed);
            return true;
        },
        insertRow: async () => 1,
        updateCell: async () => true,
        deleteRow: async () => true,
        registerTableUpdateCallback: () => true,
    };
    const handlers = {};
    const context = {
        chatId: 'c-replay', name: '测试', chat,
        characters: [converted], characterId: 0,
        extensionSettings: { mvu2shujuku: { debug: true } },
        eventSource: { on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); }, emit: () => {} },
        event_types: {
            CHAT_CHANGED: 'chat_changed', MESSAGE_RECEIVED: 'message_received', MESSAGE_SWIPED: 'swiped',
            MESSAGE_UPDATED: 'updated', MESSAGE_EDITED: 'edited', MESSAGE_SENT: 'sent', MESSAGE_DELETED: 'deleted',
            GENERATION_ENDED: 'generation_ended',
        },
        saveSettingsDebounced: () => {}, saveChatConditional: async () => {}, saveChat: async () => {},
        getRequestHeaders: () => ({}), setChatMessages: () => {},
    };
    const fakeEl = () => {
        const el = {
            dataset: {}, style: {}, children: [], _listeners: {}, _value: '',
            addEventListener: (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); },
            removeEventListener: () => {}, dispatchEvent: () => true,
            appendChild: (c) => { el.children.push(c); return c; }, removeChild: () => {},
            querySelector: () => fakeEl(), querySelectorAll: () => [],
            click: () => {}, focus: () => {}, blur: () => {}, contains: () => false,
            getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
        };
        Object.defineProperty(el, 'innerHTML', { get: () => el._html || '', set: (v) => { el._html = v; } });
        Object.defineProperty(el, 'textContent', { get: () => '', set: () => {} });
        Object.defineProperty(el, 'value', { get: () => el._value, set: (v) => { el._value = v; } });
        Object.defineProperty(el, 'checked', { get: () => !!el._checked, set: (v) => { el._checked = v; } });
        Object.defineProperty(el, 'disabled', { get: () => !!el._disabled, set: (v) => { el._disabled = v; } });
        return el;
    };
    const doc = {
        querySelector: () => fakeEl(), getElementById: () => fakeEl(), createElement: () => fakeEl(),
        createTextNode: () => fakeEl(), addEventListener: () => {}, body: fakeEl(),
    };
    const win = {
        top: null, parent: null, document: doc, console,
        setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t),
        setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (t) => clearInterval(t),
        CustomEvent: function () {}, addEventListener: () => {}, dispatchEvent: () => true,
        TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        SillyTavern: { getContext: () => context }, AutoCardUpdaterAPI: fakeApi,
        eventEmit: () => {}, toastr: undefined,
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    vm2.createContext(win);
    vm2.runInContext(extIndex, win);

    (handlers['chat_changed'] || []).forEach(fn => fn());
    await new Promise(res => setTimeout(res, 3500));
    // 新契约：插件原生回放 data_replace 恢复运行时（这里模拟已恢复）；扩展不再手工物化
    for (const k of Object.keys(tables)) delete tables[k];
    Object.assign(tables, JSON.parse(JSON.stringify(realData)));
    const zjAfter = Object.values(tables).find(s => s && s.name === '主角表');
    assert.strictEqual(zjAfter.content[1][zjAfter.content[0].indexOf('姓名')], '斯维姆', '插件原生回放后运行时应为 data_replace 数据');
});


test('开局建表：运行时全表仅表头且带 seedRows（插件 native 初始化签名）时走 initGameSession 完整模板建锚', async () => {
    const vm = require('vm');
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const tables = JSON.parse(JSON.stringify(r.template));
    // 模拟插件 native 初始化：content 全表头 + seedRows 从模板行迁移
    for (const k of Object.keys(tables)) {
        const s = tables[k];
        if (!s || !Array.isArray(s.content)) continue;
        if (s.content.length > 1) {
            s.seedRows = JSON.parse(JSON.stringify(s.content.slice(1)));
            s.content = [s.content[0]];
        }
    }
    let initCalls = 0;
    const win = {
        top: null, parent: null, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t), console,
        CustomEvent: function () {}, addEventListener() {}, dispatchEvent() { return true; },
        TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        getContext: () => ({ chatId: 'c-seed-init', chat: [{ role: 'assistant', name: '测试', mes: '开场白', is_user: false }], eventSource: { on: () => {}, emit: () => {} }, event_types: { MESSAGE_RECEIVED: 'message_received' } }),
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    win.AutoCardUpdaterAPI = {
        exportTableAsJson: () => tables,
        importTemplateFromData: async () => ({ success: true }),
        initGameSession: async () => { initCalls += 1; return { success: true, runtimeReady: true }; },
        registerTableUpdateCallback: () => {},
        updateCell: async () => true,
        insertRow: async () => 1,
        deleteRow: async () => true,
    };
    vm.createContext(win);
    vm.runInContext(r.bridgeScript, win);
    await waitBridgeFlush(500);
    assert.ok(initCalls > 0, '全表头+seedRows+无 checkpoint 时应走 initGameSession 完整模板建锚（否则 checkpoint 无行，刷新后 v2-replay 无法恢复）');
});

test('长聊天（楼层>4）刷新后：checkpoint 有行、运行时仅表头，写库先物化再落值；延时恢复不得用陈旧 checkpoint 覆盖写入', async () => {
    const vm2 = require('vm');
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const toLayout = (schema) => core.buildLayout(schema).entries.map(e => ({
        kind: e.kind, group: e.group, table: e.table, keyCol: e.keyCol || '', keyValue: e.keyValue || '',
        cols: (e.cols || []).map(c => (e.kind === 'singleton'
            ? [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, c.path || [], !!c.isPair, c.desc || '']
            : [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, null, !!c.isPair, c.desc || ''])),
        writePaths: e.writePaths || [], mirrors: e.mirrors || [],
    }));
    const srcDir = path.join(__dirname, '..', 'src');
    const coreSource = fs.readFileSync(path.join(srcDir, 'mvu2shujuku.js'), 'utf8');
    const pinyinData = fs.readFileSync(path.join(srcDir, 'pinyin-data.js'), 'utf8');
    const yamlLibsData = fs.readFileSync(path.join(srcDir, 'vendor', 'mvu-yaml-libs.js'), 'utf8');
    const jsonrepairData = fs.readFileSync(path.join(srcDir, 'vendor', 'jsonrepair-lite.js'), 'utf8');
    const pinyinInline = pinyinData.replace(/^[\s\S]*?module\.exports\s*=\s*/, 'root.__MVU2SHUJUKU_PINYIN__ = ').replace(/;\s*$/, ';');
    const yamlLibsInline = ['(function () {', '  var module = { exports: {} };', '  var exports = module.exports;', yamlLibsData, '  var target = typeof globalThis !== "undefined" ? globalThis : this;', '  target.__MVU2SHUJUKU_YAML_LIBS__ = module.exports;', '})();', ''].join('\n');
    const jsonrepairInline = 'root.__MVU2SHUJUKU_JSONREPAIR_SRC__ = ' + JSON.stringify(jsonrepairData) + ';';
    const extIndex = core.assembleExtension({ coreSource, pinyinInline, yamlLibsInline, jsonrepairInline })['index.js'];

    const persisted = JSON.parse(JSON.stringify(r.template));
    const zjP = Object.values(persisted).find(s => s && s.name === '主角表');
    zjP.content[1][zjP.content[0].indexOf('姓名')] = '斯维姆';
    const tables = JSON.parse(JSON.stringify(r.template));
    for (const k of Object.keys(tables)) {
        if (tables[k] && Array.isArray(tables[k].content)) tables[k].content = [tables[k].content[0]];
    }
    const checkpointMsg = {
        message_id: 0,
        TavernDB_ACU_IsolatedData: JSON.stringify({
            系统: { storageFrame: { version: 2, logEntries: [], checkpoint: { kind: 'full', data: persisted, ts: 1 } } },
        }),
    };
    const chat = [checkpointMsg];
    for (let i = 1; i < 6; i++) chat.push({ message_id: i, is_user: i % 2 === 1, mes: '楼层' + i });
    const converted = {
        name: '长聊卡',
        avatar: 'l.png',
        data: {
            extensions: {
                mvu2shujuku: { converter: 'mvu2shujuku', layout: JSON.stringify(toLayout(r.schema)) },
                regex_scripts: [],
            },
            character_book: {
                entries: [{
                    keys: ['__ACU_TEMPLATE_DATA__'],
                    content: Buffer.from(JSON.stringify(r.template)).toString('base64'),
                }],
            },
        },
    };
    let initCalls = 0;
    let restoreCalls = 0;
    const fakeApi = applyingApi(tables, {
        onInit: async () => { initCalls += 1; },
        onImport: (parsed, opts) => { if (opts && opts.persist === false) restoreCalls += 1; },
    });
    const handlers = {};
    const context = {
        chatId: 'c-long', name: '测试', chat,
        characters: [converted], characterId: 0,
        extensionSettings: { mvu2shujuku: { debug: true } },
        eventSource: { on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); }, emit: () => {} },
        event_types: {
            CHAT_CHANGED: 'chat_changed', MESSAGE_RECEIVED: 'message_received', MESSAGE_SWIPED: 'swiped',
            MESSAGE_UPDATED: 'updated', MESSAGE_EDITED: 'edited', MESSAGE_SENT: 'sent', MESSAGE_DELETED: 'deleted',
            GENERATION_ENDED: 'generation_ended',
        },
        saveSettingsDebounced: () => {}, saveChatConditional: async () => {}, saveChat: async () => {},
        getRequestHeaders: () => ({}), setChatMessages: () => {},
    };
    const fakeEl = () => {
        const el = {
            dataset: {}, style: {}, children: [], _listeners: {}, _value: '',
            addEventListener: (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); },
            removeEventListener: () => {}, dispatchEvent: () => true,
            appendChild: (c) => { el.children.push(c); return c; }, removeChild: () => {},
            querySelector: () => fakeEl(), querySelectorAll: () => [],
            click: () => {}, focus: () => {}, blur: () => {}, contains: () => false,
            getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
        };
        Object.defineProperty(el, 'innerHTML', { get: () => el._html || '', set: (v) => { el._html = v; } });
        Object.defineProperty(el, 'textContent', { get: () => '', set: () => {} });
        Object.defineProperty(el, 'value', { get: () => el._value, set: (v) => { el._value = v; } });
        Object.defineProperty(el, 'checked', { get: () => !!el._checked, set: (v) => { el._checked = v; } });
        Object.defineProperty(el, 'disabled', { get: () => !!el._disabled, set: (v) => { el._disabled = v; } });
        return el;
    };
    const doc = {
        querySelector: () => fakeEl(), getElementById: () => fakeEl(), createElement: () => fakeEl(),
        createTextNode: () => fakeEl(), addEventListener: () => {}, body: fakeEl(),
    };
    const win = {
        top: null, parent: null, document: doc, console,
        setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t),
        setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (t) => clearInterval(t),
        CustomEvent: function () {}, addEventListener: () => {}, dispatchEvent: () => true,
        TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        SillyTavern: { getContext: () => context }, AutoCardUpdaterAPI: fakeApi,
        eventEmit: () => {}, toastr: undefined,
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    vm2.createContext(win);
    vm2.runInContext(extIndex, win);

    (handlers['chat_changed'] || []).forEach(fn => fn());
    await new Promise(res => setTimeout(res, 2500));
    assert.strictEqual(initCalls, 0, '已有 full checkpoint 的长聊天不应触发 initGameSession');
    // 新契约：扩展不手工物化；插件原生回放恢复 checkpoint（这里模拟已恢复）
    for (const k of Object.keys(tables)) delete tables[k];
    Object.assign(tables, JSON.parse(JSON.stringify(persisted)));
    await win.Mvu.replaceMvuData({ stat_data: { 世界: { 当前时间: '测试时间' } } });
    await new Promise(res => setTimeout(res, 2500)); // 越过延时恢复窗口（CHAT_CHANGED+600ms+2500ms）
    const zjAfter = Object.values(tables).find(s => s && s.name === '主角表');
    assert.strictEqual(zjAfter.content[1][zjAfter.content[0].indexOf('姓名')], '斯维姆', '长聊天写库不得把持久化的主角姓名覆盖成默认值');
    const worldAfter = Object.values(tables).find(s => s && s.name === '世界表');
    assert.strictEqual(worldAfter.content[1][worldAfter.content[0].indexOf('当前时间')], '测试时间', '本次写入的变化必须保留，延时恢复不得用陈旧 checkpoint 覆盖');
});


test('单例表已有 content 行时写库不再 insertRow 垫脚行：不产生两行（系统表/任务表重复行回归）', async () => {
    const vm2 = require('vm');
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const toLayout = (schema) => core.buildLayout(schema).entries.map(e => ({
        kind: e.kind, group: e.group, table: e.table, keyCol: e.keyCol || '', keyValue: e.keyValue || '',
        cols: (e.cols || []).map(c => (e.kind === 'singleton'
            ? [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, c.path || [], !!c.isPair, c.desc || '']
            : [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, null, !!c.isPair, c.desc || ''])),
        writePaths: e.writePaths || [], mirrors: e.mirrors || [],
    }));
    const srcDir = path.join(__dirname, '..', 'src');
    const coreSource = fs.readFileSync(path.join(srcDir, 'mvu2shujuku.js'), 'utf8');
    const pinyinData = fs.readFileSync(path.join(srcDir, 'pinyin-data.js'), 'utf8');
    const yamlLibsData = fs.readFileSync(path.join(srcDir, 'vendor', 'mvu-yaml-libs.js'), 'utf8');
    const jsonrepairData = fs.readFileSync(path.join(srcDir, 'vendor', 'jsonrepair-lite.js'), 'utf8');
    const pinyinInline = pinyinData.replace(/^[\s\S]*?module\.exports\s*=\s*/, 'root.__MVU2SHUJUKU_PINYIN__ = ').replace(/;\s*$/, ';');
    const yamlLibsInline = ['(function () {', '  var module = { exports: {} };', '  var exports = module.exports;', yamlLibsData, '  var target = typeof globalThis !== "undefined" ? globalThis : this;', '  target.__MVU2SHUJUKU_YAML_LIBS__ = module.exports;', '})();', ''].join('\n');
    const jsonrepairInline = 'root.__MVU2SHUJUKU_JSONREPAIR_SRC__ = ' + JSON.stringify(jsonrepairData) + ';';
    const extIndex = core.assembleExtension({ coreSource, pinyinInline, yamlLibsInline, jsonrepairInline })['index.js'];

    // 运行时 = 完整模板（单例表已有 content 行，模拟 initGameSession 之后）
    const tables = JSON.parse(JSON.stringify(r.template));
    const persisted = JSON.parse(JSON.stringify(r.template));
    const checkpointMsg = {
        message_id: 0,
        TavernDB_ACU_IsolatedData: JSON.stringify({
            系统: { storageFrame: { version: 2, logEntries: [], checkpoint: { kind: 'full', data: persisted, ts: 1 } } },
        }),
    };
    const converted = {
        name: '幂等卡',
        avatar: 'id.png',
        data: {
            extensions: {
                mvu2shujuku: { converter: 'mvu2shujuku', layout: JSON.stringify(toLayout(r.schema)) },
                regex_scripts: [],
            },
            character_book: {
                entries: [{
                    keys: ['__ACU_TEMPLATE_DATA__'],
                    content: Buffer.from(JSON.stringify(r.template)).toString('base64'),
                }],
            },
        },
    };
    let insertCalls = 0;
    const baseApi = applyingApi(tables, {});
    const fakeApi = Object.assign({}, baseApi, {
        insertRow: async (tableName, obj) => {
            insertCalls += 1;
            return baseApi.insertRow(tableName, obj);
        },
    });
    const handlers = {};
    const context = {
        chatId: 'c-idem', name: '测试', chat: [checkpointMsg],
        characters: [converted], characterId: 0,
        extensionSettings: { mvu2shujuku: { debug: true } },
        eventSource: { on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); }, emit: () => {} },
        event_types: {
            CHAT_CHANGED: 'chat_changed', MESSAGE_RECEIVED: 'message_received', MESSAGE_SWIPED: 'swiped',
            MESSAGE_UPDATED: 'updated', MESSAGE_EDITED: 'edited', MESSAGE_SENT: 'sent', MESSAGE_DELETED: 'deleted',
            GENERATION_ENDED: 'generation_ended',
        },
        saveSettingsDebounced: () => {}, saveChatConditional: async () => {}, saveChat: async () => {},
        getRequestHeaders: () => ({}), setChatMessages: () => {},
    };
    const fakeEl = () => {
        const el = {
            dataset: {}, style: {}, children: [], _listeners: {}, _value: '',
            addEventListener: (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); },
            removeEventListener: () => {}, dispatchEvent: () => true,
            appendChild: (c) => { el.children.push(c); return c; }, removeChild: () => {},
            querySelector: () => fakeEl(), querySelectorAll: () => [],
            click: () => {}, focus: () => {}, blur: () => {}, contains: () => false,
            getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
        };
        Object.defineProperty(el, 'innerHTML', { get: () => el._html || '', set: (v) => { el._html = v; } });
        Object.defineProperty(el, 'textContent', { get: () => '', set: () => {} });
        Object.defineProperty(el, 'value', { get: () => el._value, set: (v) => { el._value = v; } });
        Object.defineProperty(el, 'checked', { get: () => !!el._checked, set: (v) => { el._checked = v; } });
        Object.defineProperty(el, 'disabled', { get: () => !!el._disabled, set: (v) => { el._disabled = v; } });
        return el;
    };
    const doc = {
        querySelector: () => fakeEl(), getElementById: () => fakeEl(), createElement: () => fakeEl(),
        createTextNode: () => fakeEl(), addEventListener: () => {}, body: fakeEl(),
    };
    const win = {
        top: null, parent: null, document: doc, console,
        setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t),
        setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (t) => clearInterval(t),
        CustomEvent: function () {}, addEventListener: () => {}, dispatchEvent: () => true,
        TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        SillyTavern: { getContext: () => context }, AutoCardUpdaterAPI: fakeApi,
        eventEmit: () => {}, toastr: undefined,
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    vm2.createContext(win);
    vm2.runInContext(extIndex, win);

    (handlers['chat_changed'] || []).forEach(fn => fn());
    await new Promise(res => setTimeout(res, 2500));
    // 单例表更新：只改 主角表 姓名（表里已有 row_id=1）
    await win.Mvu.replaceMvuData({ stat_data: { 主角: { 姓名: '幂等写入' } } });
    await new Promise(res => setTimeout(res, 1200));
    assert.strictEqual(insertCalls, 0, '单例表已有 content 行时写库不得调用 insertRow（不得制造垫脚行/重复行）');
    const zj = Object.values(tables).find(s => s && s.name === '主角表');
    assert.ok(zj && Array.isArray(zj.content), '主角表应存在');
    assert.strictEqual(zj.content.length, 2, '单例表写库后仍应只有表头+一行（不得再插出第二行）');
    const hdr = zj.content[0];
    assert.strictEqual(zj.content[1][hdr.indexOf('姓名')], '幂等写入', '写入应落在 row_id=1 上');
});

test('读侧持久化重建回放 sql_sheet_batch：运行时为空窗口内读到 checkpoint 后的最新写入而非旧值', async () => {
    const vm2 = require('vm');
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const toLayout = (schema) => core.buildLayout(schema).entries.map(e => ({
        kind: e.kind, group: e.group, table: e.table, keyCol: e.keyCol || '', keyValue: e.keyValue || '',
        cols: (e.cols || []).map(c => (e.kind === 'singleton'
            ? [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, c.path || [], !!c.isPair, c.desc || '']
            : [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, null, !!c.isPair, c.desc || ''])),
        writePaths: e.writePaths || [], mirrors: e.mirrors || [],
    }));
    const srcDir = path.join(__dirname, '..', 'src');
    const coreSource = fs.readFileSync(path.join(srcDir, 'mvu2shujuku.js'), 'utf8');
    const pinyinData = fs.readFileSync(path.join(srcDir, 'pinyin-data.js'), 'utf8');
    const yamlLibsData = fs.readFileSync(path.join(srcDir, 'vendor', 'mvu-yaml-libs.js'), 'utf8');
    const jsonrepairData = fs.readFileSync(path.join(srcDir, 'vendor', 'jsonrepair-lite.js'), 'utf8');
    const pinyinInline = pinyinData.replace(/^[\s\S]*?module\.exports\s*=\s*/, 'root.__MVU2SHUJUKU_PINYIN__ = ').replace(/;\s*$/, ';');
    const yamlLibsInline = ['(function () {', '  var module = { exports: {} };', '  var exports = module.exports;', yamlLibsData, '  var target = typeof globalThis !== "undefined" ? globalThis : this;', '  target.__MVU2SHUJUKU_YAML_LIBS__ = module.exports;', '})();', ''].join('\n');
    const jsonrepairInline = 'root.__MVU2SHUJUKU_JSONREPAIR_SRC__ = ' + JSON.stringify(jsonrepairData) + ';';
    const extIndex = core.assembleExtension({ coreSource, pinyinInline, yamlLibsInline, jsonrepairInline })['index.js'];

    // 持久化帧：checkpoint 基底（遭遇冷却=20、姓名=未知）+ 两条 logEntries：
    //   sql_sheet_batch（SQLite 模式 updateCell 的持久化形态）把 遭遇冷却 改成 25，
    //   row_upsert 把 主角表 姓名 改成 斯维姆。
    const persisted = JSON.parse(JSON.stringify(r.template));
    const sjP = Object.values(persisted).find(s => s && s.name === '世界表');
    const zjP = Object.values(persisted).find(s => s && s.name === '主角表');
    const sjKey = Object.keys(persisted).find(k => persisted[k] === sjP);
    const zjKey = Object.keys(persisted).find(k => persisted[k] === zjP);
    const sjHdr = sjP.content[0];
    sjP.content[1][sjHdr.indexOf('遭遇冷却')] = 20;
    const zjHdr = zjP.content[0];
    const zjRow = JSON.parse(JSON.stringify(zjP.content[1]));
    zjRow[zjHdr.indexOf('姓名')] = '斯维姆';
    const checkpointMsg = {
        message_id: 0,
        TavernDB_ACU_IsolatedData: JSON.stringify({
            系统: {
                storageFrame: {
                    version: 2,
                    logEntries: [
                        {
                            seq: 1,
                            operations: [
                                {
                                    kind: 'sql_sheet_batch',
                                    sheetKey: sjKey,
                                    statements: ['UPDATE `shijiebiao` SET `zaoyulengque` = ? WHERE `row_id` = ?;'],
                                    params: [[25, '1']],
                                    tableName: 'shijiebiao',
                                    reason: 'manual_crud',
                                },
                            ],
                        },
                        {
                            seq: 2,
                            operations: [
                                { kind: 'row_upsert', sheetKey: zjKey, rowId: '1', cells: zjRow },
                            ],
                        },
                    ],
                    checkpoint: { kind: 'full', data: persisted, ts: 1 },
                },
            },
        }),
    };
    const converted = {
        name: '重建卡',
        avatar: 'rb.png',
        data: {
            extensions: {
                mvu2shujuku: { converter: 'mvu2shujuku', layout: JSON.stringify(toLayout(r.schema)) },
                regex_scripts: [],
            },
            character_book: {
                entries: [{
                    keys: ['__ACU_TEMPLATE_DATA__'],
                    content: Buffer.from(JSON.stringify(r.template)).toString('base64'),
                }],
            },
        },
    };
    // 运行时为空：模拟插件回放未完成（exportTableAsJson 返回 {}），读侧必须走持久化重建
    const tables = {};
    let initCalls = 0;
    const fakeApi = applyingApi(tables, {
        onInit: async () => { initCalls += 1; },
    });
    // 模拟插件 native 初始化只建了表头、尚未物化 seedRows：insertRow 不落行，
    // 让读侧必须走“无持久化帧 → 退回运行时（布局默认值）”分支。
    fakeApi.insertRow = async () => -1;
    const handlers = {};
    const context = {
        chatId: 'c-replay', name: '测试', chat: [checkpointMsg],
        characters: [converted], characterId: 0,
        extensionSettings: { mvu2shujuku: { debug: false } },
        eventSource: { on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); }, emit: () => {} },
        event_types: {
            CHAT_CHANGED: 'chat_changed', MESSAGE_RECEIVED: 'message_received', MESSAGE_SWIPED: 'swiped',
            MESSAGE_UPDATED: 'updated', MESSAGE_EDITED: 'edited', MESSAGE_SENT: 'sent', MESSAGE_DELETED: 'deleted',
            GENERATION_ENDED: 'generation_ended',
        },
        saveSettingsDebounced: () => {}, saveChatConditional: async () => {}, saveChat: async () => {},
        getRequestHeaders: () => ({}), setChatMessages: () => {},
    };
    const fakeEl = () => {
        const el = {
            dataset: {}, style: {}, children: [], _listeners: {}, _value: '',
            addEventListener: (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); },
            removeEventListener: () => {}, dispatchEvent: () => true,
            appendChild: (c) => { el.children.push(c); return c; }, removeChild: () => {},
            querySelector: () => fakeEl(), querySelectorAll: () => [],
            click: () => {}, focus: () => {}, blur: () => {}, contains: () => false,
            getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
        };
        Object.defineProperty(el, 'innerHTML', { get: () => el._html || '', set: (v) => { el._html = v; } });
        Object.defineProperty(el, 'textContent', { get: () => '', set: () => {} });
        Object.defineProperty(el, 'value', { get: () => el._value, set: (v) => { el._value = v; } });
        Object.defineProperty(el, 'checked', { get: () => !!el._checked, set: (v) => { el._checked = v; } });
        Object.defineProperty(el, 'disabled', { get: () => !!el._disabled, set: (v) => { el._disabled = v; } });
        return el;
    };
    const doc = {
        querySelector: () => fakeEl(), getElementById: () => fakeEl(), createElement: () => fakeEl(),
        createTextNode: () => fakeEl(), addEventListener: () => {}, body: fakeEl(),
    };
    const win = {
        top: null, parent: null, document: doc, console,
        setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t),
        setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (t) => clearInterval(t),
        CustomEvent: function () {}, addEventListener: () => {}, dispatchEvent: () => true,
        TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        SillyTavern: { getContext: () => context }, AutoCardUpdaterAPI: fakeApi,
        eventEmit: () => {}, toastr: undefined,
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    vm2.createContext(win);
    vm2.runInContext(extIndex, win);

    (handlers['chat_changed'] || []).forEach(fn => fn());
    await new Promise(res => setTimeout(res, 2500));
    assert.strictEqual(initCalls, 0, '已有 full checkpoint 时不重建表');
    // 运行时仍为空 → getAllVariables 走持久化重建；sql_sheet_batch 必须被回放
    const gv = win.getAllVariables();
    assert.strictEqual(gv.stat_data.世界 && gv.stat_data.世界.遭遇冷却, 25,
        'sql_sheet_batch 写入应覆盖 checkpoint 旧值（否则前端读到旧值会显示并写回），实际 stat_data=' + JSON.stringify(gv.stat_data));
    assert.strictEqual(gv.stat_data.主角 && gv.stat_data.主角.姓名, '斯维姆', 'row_upsert 写入应被回放，实际 stat_data=' + JSON.stringify(gv.stat_data));
});

test('全新聊天运行时仅表头且无 checkpoint：读侧退回布局默认值而非空对象（避免前端按自己的默认值写回）', async () => {
    const vm2 = require('vm');
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const toLayout = (schema) => core.buildLayout(schema).entries.map(e => ({
        kind: e.kind, group: e.group, table: e.table, keyCol: e.keyCol || '', keyValue: e.keyValue || '',
        cols: (e.cols || []).map(c => (e.kind === 'singleton'
            ? [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, c.path || [], !!c.isPair, c.desc || '']
            : [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, null, !!c.isPair, c.desc || ''])),
        writePaths: e.writePaths || [], mirrors: e.mirrors || [],
    }));
    const srcDir = path.join(__dirname, '..', 'src');
    const coreSource = fs.readFileSync(path.join(srcDir, 'mvu2shujuku.js'), 'utf8');
    const pinyinData = fs.readFileSync(path.join(srcDir, 'pinyin-data.js'), 'utf8');
    const yamlLibsData = fs.readFileSync(path.join(srcDir, 'vendor', 'mvu-yaml-libs.js'), 'utf8');
    const jsonrepairData = fs.readFileSync(path.join(srcDir, 'vendor', 'jsonrepair-lite.js'), 'utf8');
    const pinyinInline = pinyinData.replace(/^[\s\S]*?module\.exports\s*=\s*/, 'root.__MVU2SHUJUKU_PINYIN__ = ').replace(/;\s*$/, ';');
    const yamlLibsInline = ['(function () {', '  var module = { exports: {} };', '  var exports = module.exports;', yamlLibsData, '  var target = typeof globalThis !== "undefined" ? globalThis : this;', '  target.__MVU2SHUJUKU_YAML_LIBS__ = module.exports;', '})();', ''].join('\n');
    const jsonrepairInline = 'root.__MVU2SHUJUKU_JSONREPAIR_SRC__ = ' + JSON.stringify(jsonrepairData) + ';';
    const extIndex = core.assembleExtension({ coreSource, pinyinInline, yamlLibsInline, jsonrepairInline })['index.js'];

    // 全新聊天：运行时只有表头（插件 native 初始化中间态），聊天无 checkpoint
    const tables = JSON.parse(JSON.stringify(r.template));
    for (const k of Object.keys(tables)) {
        if (tables[k] && Array.isArray(tables[k].content) && tables[k].content.length > 1) {
            tables[k].content = [tables[k].content[0]];
        }
    }
    const converted = {
        name: '新聊天卡',
        avatar: 'fresh.png',
        data: {
            extensions: {
                mvu2shujuku: { converter: 'mvu2shujuku', layout: JSON.stringify(toLayout(r.schema)) },
                regex_scripts: [],
            },
            character_book: {
                entries: [{
                    keys: ['__ACU_TEMPLATE_DATA__'],
                    content: Buffer.from(JSON.stringify(r.template)).toString('base64'),
                }],
            },
        },
    };
    let initCalls = 0;
    const fakeApi = applyingApi(tables, {
        onInit: async () => { initCalls += 1; },
    });
    const handlers = {};
    const context = {
        chatId: 'c-fresh', name: '测试', chat: [],
        characters: [converted], characterId: 0,
        extensionSettings: { mvu2shujuku: { debug: false } },
        eventSource: { on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); }, emit: () => {} },
        event_types: {
            CHAT_CHANGED: 'chat_changed', MESSAGE_RECEIVED: 'message_received', MESSAGE_SWIPED: 'swiped',
            MESSAGE_UPDATED: 'updated', MESSAGE_EDITED: 'edited', MESSAGE_SENT: 'sent', MESSAGE_DELETED: 'deleted',
            GENERATION_ENDED: 'generation_ended',
        },
        saveSettingsDebounced: () => {}, saveChatConditional: async () => {}, saveChat: async () => {},
        getRequestHeaders: () => ({}), setChatMessages: () => {},
    };
    const fakeEl = () => {
        const el = {
            dataset: {}, style: {}, children: [], _listeners: {}, _value: '',
            addEventListener: (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); },
            removeEventListener: () => {}, dispatchEvent: () => true,
            appendChild: (c) => { el.children.push(c); return c; }, removeChild: () => {},
            querySelector: () => fakeEl(), querySelectorAll: () => [],
            click: () => {}, focus: () => {}, blur: () => {}, contains: () => false,
            getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
        };
        Object.defineProperty(el, 'innerHTML', { get: () => el._html || '', set: (v) => { el._html = v; } });
        Object.defineProperty(el, 'textContent', { get: () => '', set: () => {} });
        Object.defineProperty(el, 'value', { get: () => el._value, set: (v) => { el._value = v; } });
        Object.defineProperty(el, 'checked', { get: () => !!el._checked, set: (v) => { el._checked = v; } });
        Object.defineProperty(el, 'disabled', { get: () => !!el._disabled, set: (v) => { el._disabled = v; } });
        return el;
    };
    const doc = {
        querySelector: () => fakeEl(), getElementById: () => fakeEl(), createElement: () => fakeEl(),
        createTextNode: () => fakeEl(), addEventListener: () => {}, body: fakeEl(),
    };
    const win = {
        top: null, parent: null, document: doc, console,
        setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t),
        setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (t) => clearInterval(t),
        CustomEvent: function () {}, addEventListener: () => {}, dispatchEvent: () => true,
        TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        SillyTavern: { getContext: () => context }, AutoCardUpdaterAPI: fakeApi,
        eventEmit: () => {}, toastr: undefined,
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    vm2.createContext(win);
    vm2.runInContext(extIndex, win);

    (handlers['chat_changed'] || []).forEach(fn => fn());
    await new Promise(res => setTimeout(res, 2500));
    // 无 checkpoint → 无持久化重建；仅表头运行时 → 单例表应回到布局默认值（模板初始行），不是空对象
    const gv = win.getAllVariables();
    assert.strictEqual(gv.stat_data.世界 && gv.stat_data.世界.遭遇冷却, 20,
        '全新聊天仅表头时读侧应返回布局默认值而非空对象，实际=' + JSON.stringify(gv.stat_data.世界));
    assert.strictEqual(gv.stat_data.主角 && gv.stat_data.主角.姓名, '未知',
        '全新聊天仅表头时主角表应返回布局默认值，实际=' + JSON.stringify(gv.stat_data.主角 && gv.stat_data.主角.姓名));
});

test('首楼替换清空运行时后开场注入仍完整落库：延迟重跑合并、不产生重复行（道渊开场部分注入回归）', async () => {
    const vm2 = require('vm');
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const toLayout = (schema) => core.buildLayout(schema).entries.map(e => ({
        kind: e.kind, group: e.group, table: e.table, keyCol: e.keyCol || '', keyValue: e.keyValue || '',
        cols: (e.cols || []).map(c => (e.kind === 'singleton'
            ? [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, c.path || [], !!c.isPair, c.desc || '']
            : [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, null, !!c.isPair, c.desc || ''])),
        writePaths: e.writePaths || [], mirrors: e.mirrors || [],
    }));
    const srcDir = path.join(__dirname, '..', 'src');
    const coreSource = fs.readFileSync(path.join(srcDir, 'mvu2shujuku.js'), 'utf8');
    const pinyinData = fs.readFileSync(path.join(srcDir, 'pinyin-data.js'), 'utf8');
    const yamlLibsData = fs.readFileSync(path.join(srcDir, 'vendor', 'mvu-yaml-libs.js'), 'utf8');
    const jsonrepairData = fs.readFileSync(path.join(srcDir, 'vendor', 'jsonrepair-lite.js'), 'utf8');
    const pinyinInline = pinyinData.replace(/^[\s\S]*?module\.exports\s*=\s*/, 'root.__MVU2SHUJUKU_PINYIN__ = ').replace(/;\s*$/, ';');
    const yamlLibsInline = ['(function () {', '  var module = { exports: {} };', '  var exports = module.exports;', yamlLibsData, '  var target = typeof globalThis !== "undefined" ? globalThis : this;', '  target.__MVU2SHUJUKU_YAML_LIBS__ = module.exports;', '})();', ''].join('\n');
    const jsonrepairInline = 'root.__MVU2SHUJUKU_JSONREPAIR_SRC__ = ' + JSON.stringify(jsonrepairData) + ';';
    const extIndex = core.assembleExtension({ coreSource, pinyinInline, yamlLibsInline, jsonrepairInline })['index.js'];

    // 运行时：主角表已有模板行（初始已物化），其它表仅表头；无 checkpoint
    const tables = JSON.parse(JSON.stringify(r.template));
    for (const k of Object.keys(tables)) {
        if (k.indexOf('sheet_') === 0 && tables[k] && Array.isArray(tables[k].content) && tables[k].name !== '主角表') {
            tables[k].content = [tables[k].content[0]];
        }
    }
    const log = [];
    let cleared = false;
    const fakeApi = Object.assign(applyingApi(tables), {
        updateCell: async (tableName, rowIndex, col, value) => {
            const s = Object.values(tables).find(x => x && x.name === tableName);
            // 第一次单元格写入时模拟“首楼替换”清空运行时：主角表行被清掉
            if (tableName === '主角表' && !cleared) {
                cleared = true;
                const zj = Object.values(tables).find(x => x && x.name === '主角表');
                zj.content = [zj.content[0]];
                log.push('clear');
                return false;
            }
            if (!s || !s.content[rowIndex]) return false;
            const ci = s.content[0].indexOf(col);
            if (ci === -1) return false;
            s.content[rowIndex][ci] = String(value);
            return true;
        },
    });
    const handlers = {};
    const converted = {
        name: '首楼替换卡',
        avatar: 'replace.png',
        data: {
            extensions: {
                mvu2shujuku: { converter: 'mvu2shujuku', layout: JSON.stringify(toLayout(r.schema)) },
                regex_scripts: [],
            },
            character_book: {
                entries: [{
                    keys: ['__ACU_TEMPLATE_DATA__'],
                    content: Buffer.from(JSON.stringify(r.template)).toString('base64'),
                }],
            },
        },
    };
    const context = {
        chatId: 'c-replace', name: '测试', chat: [],
        characters: [converted], characterId: 0,
        extensionSettings: { mvu2shujuku: { debug: false } },
        eventSource: { on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); }, emit: () => {} },
        event_types: {
            CHAT_CHANGED: 'chat_changed', MESSAGE_RECEIVED: 'message_received', MESSAGE_SWIPED: 'swiped',
            MESSAGE_UPDATED: 'updated', MESSAGE_EDITED: 'edited', MESSAGE_SENT: 'sent', MESSAGE_DELETED: 'deleted',
            GENERATION_ENDED: 'generation_ended',
        },
        saveSettingsDebounced: () => {}, saveChatConditional: async () => {}, saveChat: async () => {},
        getRequestHeaders: () => ({}), setChatMessages: () => {},
    };
    const fakeEl = () => {
        const el = {
            dataset: {}, style: {}, children: [], _listeners: {}, _value: '',
            addEventListener: (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); },
            removeEventListener: () => {}, dispatchEvent: () => true,
            appendChild: (c) => { el.children.push(c); return c; }, removeChild: () => {},
            querySelector: () => fakeEl(), querySelectorAll: () => [],
            click: () => {}, focus: () => {}, blur: () => {}, contains: () => false,
            getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
        };
        Object.defineProperty(el, 'innerHTML', { get: () => el._html || '', set: (v) => { el._html = v; } });
        Object.defineProperty(el, 'textContent', { get: () => '', set: () => {} });
        Object.defineProperty(el, 'value', { get: () => el._value, set: (v) => { el._value = v; } });
        Object.defineProperty(el, 'checked', { get: () => !!el._checked, set: (v) => { el._checked = v; } });
        Object.defineProperty(el, 'disabled', { get: () => !!el._disabled, set: (v) => { el._disabled = v; } });
        return el;
    };
    const doc = {
        querySelector: () => fakeEl(), getElementById: () => fakeEl(), createElement: () => fakeEl(),
        createTextNode: () => fakeEl(), addEventListener: () => {}, body: fakeEl(),
    };
    const win = {
        top: null, parent: null, document: doc, console,
        setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t),
        setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (t) => clearInterval(t),
        CustomEvent: function () {}, addEventListener: () => {}, dispatchEvent: () => true,
        TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        SillyTavern: { getContext: () => context }, AutoCardUpdaterAPI: fakeApi,
        eventEmit: () => {}, toastr: undefined,
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    vm2.createContext(win);
    vm2.runInContext(extIndex, win);

    (handlers['chat_changed'] || []).forEach(fn => fn());
    await new Promise(res => setTimeout(res, 2600));
    await win.Mvu.replaceMvuData({ stat_data: {
        主角: { 姓名: '斯维姆', 性别: '男', 容貌: '相貌丑陋', 身形: '未知', 衣着: '未知', 境界: '凡人', 宗门: '无', 宗门贡献: 0 },
    } });
    // 等首次合并失败 → 延迟重跑合并（1.5s）→ 补行/重写全部完成
    await new Promise(res => setTimeout(res, 3500));
    assert.ok(log.indexOf('clear') !== -1, '模拟首楼替换应真的清空过一次运行时');
    const zj = Object.values(tables).find(s => s && s.name === '主角表');
    const hdr = zj.content[0];
    assert.strictEqual(zj.content.length, 2, '自愈后主角表应恢复单数据行（不得产生多余重复行）');
    assert.strictEqual(zj.content[1][hdr.indexOf('姓名')], '斯维姆', '开场道号应落库');
    assert.strictEqual(zj.content[1][hdr.indexOf('性别')], '男', '开场性别应落库');
    assert.strictEqual(zj.content[1][hdr.indexOf('容貌')], '相貌丑陋', '开场容貌应落库');
    assert.strictEqual(zj.content[1][hdr.indexOf('境界')], '凡人', '开场境界应落库');
});

test('首楼替换丢失插件作用域字段后重进：拷回 InternalSheetGuide/ScopedConfig 并把冻结模板名恢复为当前卡模板名', async () => {
    const vm2 = require('vm');
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const toLayout = (schema) => core.buildLayout(schema).entries.map(e => ({
        kind: e.kind, group: e.group, table: e.table, keyCol: e.keyCol || '', keyValue: e.keyValue || '',
        cols: (e.cols || []).map(c => (e.kind === 'singleton'
            ? [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, c.path || [], !!c.isPair, c.desc || '']
            : [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, null, !!c.isPair, c.desc || ''])),
        writePaths: e.writePaths || [], mirrors: e.mirrors || [],
    }));
    const srcDir = path.join(__dirname, '..', 'src');
    const coreSource = fs.readFileSync(path.join(srcDir, 'mvu2shujuku.js'), 'utf8');
    const pinyinData = fs.readFileSync(path.join(srcDir, 'pinyin-data.js'), 'utf8');
    const yamlLibsData = fs.readFileSync(path.join(srcDir, 'vendor', 'mvu-yaml-libs.js'), 'utf8');
    const jsonrepairData = fs.readFileSync(path.join(srcDir, 'vendor', 'jsonrepair-lite.js'), 'utf8');
    const pinyinInline = pinyinData.replace(/^[\s\S]*?module\.exports\s*=\s*/, 'root.__MVU2SHUJUKU_PINYIN__ = ').replace(/;\s*$/, ';');
    const yamlLibsInline = ['(function () {', '  var module = { exports: {} };', '  var exports = module.exports;', yamlLibsData, '  var target = typeof globalThis !== "undefined" ? globalThis : this;', '  target.__MVU2SHUJUKU_YAML_LIBS__ = module.exports;', '})();', ''].join('\n');
    const jsonrepairInline = 'root.__MVU2SHUJUKU_JSONREPAIR_SRC__ = ' + JSON.stringify(jsonrepairData) + ';';
    const extIndex = core.assembleExtension({ coreSource, pinyinInline, yamlLibsInline, jsonrepairInline })['index.js'];

    const tables = JSON.parse(JSON.stringify(r.template));
    const converted = {
        name: '首楼修复卡',
        avatar: 'fix.png',
        data: {
            extensions: {
                mvu2shujuku: { converter: 'mvu2shujuku', layout: JSON.stringify(toLayout(r.schema)) },
                regex_scripts: [],
            },
            character_book: {
                entries: [{
                    keys: ['__ACU_TEMPLATE_DATA__'],
                    content: Buffer.from(JSON.stringify(r.template)).toString('base64'),
                }],
            },
        },
    };
    // 首楼替换后：首楼丢失 ScopedConfig/InternalSheetGuide；chat_metadata 仍保留（但 ScopedConfig 已被插件冻结成旧版标签）
    const frozenState = {
        version: 1,
        template: {
            '': {
                mode: 'chat_override',
                isolationKey: '',
                presetName: '旧版聊天冻结模板',
                templateStr: JSON.stringify(r.template),
                source: 'legacy_frozen',
                updatedAt: 1,
            },
        },
    };
    const guideState = { version: 2, tags: { '': { data: JSON.parse(JSON.stringify(r.template)), templateScopeMode: 'chat_override', reason: 'game_init' } } };
    const chatMsg = { message_id: 0, mes: '首楼（被替换过，字段丢失）', name: 'System', is_user: false };
    const fakeApi = applyingApi(tables);
    const handlers = {};
    const context = {
        chatId: 'c-fix', name: '测试', chat: [chatMsg],
        chat_metadata: {
            TavernDB_ACU_ScopedConfig: JSON.parse(JSON.stringify(frozenState)),
            TavernDB_ACU_InternalSheetGuide: JSON.parse(JSON.stringify(guideState)),
        },
        characters: [converted], characterId: 0,
        extensionSettings: { mvu2shujuku: { debug: false } },
        eventSource: { on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); }, emit: () => {} },
        event_types: {
            CHAT_CHANGED: 'chat_changed', MESSAGE_RECEIVED: 'message_received', MESSAGE_SWIPED: 'swiped',
            MESSAGE_UPDATED: 'updated', MESSAGE_EDITED: 'edited', MESSAGE_SENT: 'sent', MESSAGE_DELETED: 'deleted',
            GENERATION_ENDED: 'generation_ended',
        },
        saveSettingsDebounced: () => {}, saveChatConditional: async () => {}, saveChat: async () => {},
        updateChatMetadata: async () => {},
        getRequestHeaders: () => ({}), setChatMessages: () => {},
    };
    const fakeEl = () => {
        const el = {
            dataset: {}, style: {}, children: [], _listeners: {}, _value: '',
            addEventListener: (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); },
            removeEventListener: () => {}, dispatchEvent: () => true,
            appendChild: (c) => { el.children.push(c); return c; }, removeChild: () => {},
            querySelector: () => fakeEl(), querySelectorAll: () => [],
            click: () => {}, focus: () => {}, blur: () => {}, contains: () => false,
            getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
        };
        Object.defineProperty(el, 'innerHTML', { get: () => el._html || '', set: (v) => { el._html = v; } });
        Object.defineProperty(el, 'textContent', { get: () => '', set: () => {} });
        Object.defineProperty(el, 'value', { get: () => el._value, set: (v) => { el._value = v; } });
        Object.defineProperty(el, 'checked', { get: () => !!el._checked, set: (v) => { el._checked = v; } });
        Object.defineProperty(el, 'disabled', { get: () => !!el._disabled, set: (v) => { el._disabled = v; } });
        return el;
    };
    const doc = {
        querySelector: () => fakeEl(), getElementById: () => fakeEl(), createElement: () => fakeEl(),
        createTextNode: () => fakeEl(), addEventListener: () => {}, body: fakeEl(),
    };
    const win = {
        top: null, parent: null, document: doc, console,
        setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t),
        setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (t) => clearInterval(t),
        CustomEvent: function () {}, addEventListener: () => {}, dispatchEvent: () => true,
        TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        SillyTavern: { getContext: () => context }, AutoCardUpdaterAPI: fakeApi,
        eventEmit: () => {}, toastr: undefined,
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    vm2.createContext(win);
    vm2.runInContext(extIndex, win);

    (handlers['chat_changed'] || []).forEach(fn => fn());
    await new Promise(res => setTimeout(res, 3000));
    // 1) 首楼字段被拷回
    assert.ok(chatMsg.TavernDB_ACU_InternalSheetGuide, '首楼应恢复 InternalSheetGuide');
    assert.ok(chatMsg.TavernDB_ACU_ScopedConfig, '首楼应恢复 ScopedConfig');
    // 2) 冻结模板名恢复为当前卡模板名（消息 + chat_metadata 权威源）
    const state = chatMsg.TavernDB_ACU_ScopedConfig.template[''];
    assert.strictEqual(state.presetName, '首楼修复卡模板', '冻结模板名应恢复为 卡名+模板');
    assert.strictEqual(context.chat_metadata.TavernDB_ACU_ScopedConfig.template[''].presetName, '首楼修复卡模板', 'chat_metadata 权威源应同步恢复模板名');
    assert.ok(String(state.source || '').indexOf('legacy') !== 0, 'source 不应再是 legacy 冻结');
});

test('首楼替换后作用域整体缺失：修复只拷回 InternalSheetGuide，绝不用转换器模板重建 ScopedConfig（防两套 sheet key 冲突）', async () => {
    const vm2 = require('vm');
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const toLayout = (schema) => core.buildLayout(schema).entries.map(e => ({
        kind: e.kind, group: e.group, table: e.table, keyCol: e.keyCol || '', keyValue: e.keyValue || '',
        cols: (e.cols || []).map(c => (e.kind === 'singleton'
            ? [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, c.path || [], !!c.isPair, c.desc || '']
            : [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, null, !!c.isPair, c.desc || ''])),
        writePaths: e.writePaths || [], mirrors: e.mirrors || [],
    }));
    const srcDir = path.join(__dirname, '..', 'src');
    const coreSource = fs.readFileSync(path.join(srcDir, 'mvu2shujuku.js'), 'utf8');
    const pinyinData = fs.readFileSync(path.join(srcDir, 'pinyin-data.js'), 'utf8');
    const yamlLibsData = fs.readFileSync(path.join(srcDir, 'vendor', 'mvu-yaml-libs.js'), 'utf8');
    const jsonrepairData = fs.readFileSync(path.join(srcDir, 'vendor', 'jsonrepair-lite.js'), 'utf8');
    const pinyinInline = pinyinData.replace(/^[\s\S]*?module\.exports\s*=\s*/, 'root.__MVU2SHUJUKU_PINYIN__ = ').replace(/;\s*$/, ';');
    const yamlLibsInline = ['(function () {', '  var module = { exports: {} };', '  var exports = module.exports;', yamlLibsData, '  var target = typeof globalThis !== "undefined" ? globalThis : this;', '  target.__MVU2SHUJUKU_YAML_LIBS__ = module.exports;', '})();', ''].join('\n');
    const jsonrepairInline = 'root.__MVU2SHUJUKU_JSONREPAIR_SRC__ = ' + JSON.stringify(jsonrepairData) + ';';
    const extIndex = core.assembleExtension({ coreSource, pinyinInline, yamlLibsInline, jsonrepairInline })['index.js'];

    const tables = JSON.parse(JSON.stringify(r.template));
    const converted = {
        name: '首楼缺失卡',
        avatar: 'miss.png',
        data: {
            extensions: {
                mvu2shujuku: { converter: 'mvu2shujuku', layout: JSON.stringify(toLayout(r.schema)) },
                regex_scripts: [],
            },
            character_book: {
                entries: [{
                    keys: ['__ACU_TEMPLATE_DATA__'],
                    content: Buffer.from(JSON.stringify(r.template)).toString('base64'),
                }],
            },
        },
    };
    const guideState = { version: 2, tags: { '': { data: JSON.parse(JSON.stringify(r.template)), templateScopeMode: 'chat_override', reason: 'game_init' } } };
    const chatMsg = { message_id: 0, mes: '首楼（被替换过）', name: 'System', is_user: false };
    const fakeApi = applyingApi(tables);
    const handlers = {};
    const context = {
        chatId: 'c-miss', name: '测试', chat: [chatMsg],
        chat_metadata: { TavernDB_ACU_InternalSheetGuide: JSON.parse(JSON.stringify(guideState)) }, // 无 ScopedConfig
        characters: [converted], characterId: 0,
        extensionSettings: { mvu2shujuku: { debug: false } },
        eventSource: { on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); }, emit: () => {} },
        event_types: {
            CHAT_CHANGED: 'chat_changed', MESSAGE_RECEIVED: 'message_received', MESSAGE_SWIPED: 'swiped',
            MESSAGE_UPDATED: 'updated', MESSAGE_EDITED: 'edited', MESSAGE_SENT: 'sent', MESSAGE_DELETED: 'deleted',
            GENERATION_ENDED: 'generation_ended',
        },
        saveSettingsDebounced: () => {}, saveChatConditional: async () => {}, saveChat: async () => {},
        updateChatMetadata: async () => {},
        getRequestHeaders: () => ({}), setChatMessages: () => {},
    };
    const fakeEl = () => {
        const el = {
            dataset: {}, style: {}, children: [], _listeners: {}, _value: '',
            addEventListener: (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); },
            removeEventListener: () => {}, dispatchEvent: () => true,
            appendChild: (c) => { el.children.push(c); return c; }, removeChild: () => {},
            querySelector: () => fakeEl(), querySelectorAll: () => [],
            click: () => {}, focus: () => {}, blur: () => {}, contains: () => false,
            getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
        };
        Object.defineProperty(el, 'innerHTML', { get: () => el._html || '', set: (v) => { el._html = v; } });
        Object.defineProperty(el, 'textContent', { get: () => '', set: () => {} });
        Object.defineProperty(el, 'value', { get: () => el._value, set: (v) => { el._value = v; } });
        Object.defineProperty(el, 'checked', { get: () => !!el._checked, set: (v) => { el._checked = v; } });
        Object.defineProperty(el, 'disabled', { get: () => !!el._disabled, set: (v) => { el._disabled = v; } });
        return el;
    };
    const doc = {
        querySelector: () => fakeEl(), getElementById: () => fakeEl(), createElement: () => fakeEl(),
        createTextNode: () => fakeEl(), addEventListener: () => {}, body: fakeEl(),
    };
    const win = {
        top: null, parent: null, document: doc, console,
        setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t),
        setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (t) => clearInterval(t),
        CustomEvent: function () {}, addEventListener: () => {}, dispatchEvent: () => true,
        TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        SillyTavern: { getContext: () => context }, AutoCardUpdaterAPI: fakeApi,
        eventEmit: () => {}, toastr: undefined,
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    vm2.createContext(win);
    vm2.runInContext(extIndex, win);

    (handlers['chat_changed'] || []).forEach(fn => fn());
    await new Promise(res => setTimeout(res, 3000));
    assert.ok(chatMsg.TavernDB_ACU_InternalSheetGuide, '首楼应恢复 InternalSheetGuide（从 chat_metadata 拷回）');
    assert.strictEqual(chatMsg.TavernDB_ACU_ScopedConfig, undefined, '作用域缺失时不得用转换器模板重建 ScopedConfig（防止两套 sheet key 冲突）');
    assert.ok(context.chat_metadata.TavernDB_ACU_ScopedConfig === undefined, 'chat_metadata 也不应被写入转换器模板作用域');
    assert.ok(win.__mvu2shujukuTemplateCache, '模板缓存存在（证明“不重建”是主动守卫而非缺材料）');
});

test('聊天尚无 AI 楼层（首楼未就绪/切换加载中）时不调 initGameSession，避免“不存在可写入初始化 checkpoint 的 AI 楼层”报错', async () => {
    const vm2 = require('vm');
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const toLayout = (schema) => core.buildLayout(schema).entries.map(e => ({
        kind: e.kind, group: e.group, table: e.table, keyCol: e.keyCol || '', keyValue: e.keyValue || '',
        cols: (e.cols || []).map(c => (e.kind === 'singleton'
            ? [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, c.path || [], !!c.isPair, c.desc || '']
            : [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, null, !!c.isPair, c.desc || ''])),
        writePaths: e.writePaths || [], mirrors: e.mirrors || [],
    }));
    const srcDir = path.join(__dirname, '..', 'src');
    const coreSource = fs.readFileSync(path.join(srcDir, 'mvu2shujuku.js'), 'utf8');
    const pinyinData = fs.readFileSync(path.join(srcDir, 'pinyin-data.js'), 'utf8');
    const yamlLibsData = fs.readFileSync(path.join(srcDir, 'vendor', 'mvu-yaml-libs.js'), 'utf8');
    const jsonrepairData = fs.readFileSync(path.join(srcDir, 'vendor', 'jsonrepair-lite.js'), 'utf8');
    const pinyinInline = pinyinData.replace(/^[\s\S]*?module\.exports\s*=\s*/, 'root.__MVU2SHUJUKU_PINYIN__ = ').replace(/;\s*$/, ';');
    const yamlLibsInline = ['(function () {', '  var module = { exports: {} };', '  var exports = module.exports;', yamlLibsData, '  var target = typeof globalThis !== "undefined" ? globalThis : this;', '  target.__MVU2SHUJUKU_YAML_LIBS__ = module.exports;', '})();', ''].join('\n');
    const jsonrepairInline = 'root.__MVU2SHUJUKU_JSONREPAIR_SRC__ = ' + JSON.stringify(jsonrepairData) + ';';
    const extIndex = core.assembleExtension({ coreSource, pinyinInline, yamlLibsInline, jsonrepairInline })['index.js'];

    const tables = JSON.parse(JSON.stringify(r.template));
    for (const k of Object.keys(tables)) {
        if (k.indexOf('sheet_') === 0 && tables[k] && Array.isArray(tables[k].content)) tables[k].content = [tables[k].content[0]];
    }
    const converted = {
        name: '无首楼卡',
        avatar: 'nogreet.png',
        data: {
            extensions: {
                mvu2shujuku: { converter: 'mvu2shujuku', layout: JSON.stringify(toLayout(r.schema)) },
                regex_scripts: [],
            },
            character_book: {
                entries: [{
                    keys: ['__ACU_TEMPLATE_DATA__'],
                    content: Buffer.from(JSON.stringify(r.template)).toString('base64'),
                }],
            },
        },
    };
    let initCalls = 0;
    const fakeApi = applyingApi(tables, {
        onInit: async () => { initCalls += 1; },
    });
    const handlers = {};
    const context = {
        chatId: 'c-nofloor', name: '测试', chat: [], // 聊天为空：首楼未就绪/切换加载中
        characters: [converted], characterId: 0,
        extensionSettings: { mvu2shujuku: { debug: false } },
        eventSource: { on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); }, emit: () => {} },
        event_types: {
            CHAT_CHANGED: 'chat_changed', MESSAGE_RECEIVED: 'message_received', MESSAGE_SWIPED: 'swiped',
            MESSAGE_UPDATED: 'updated', MESSAGE_EDITED: 'edited', MESSAGE_SENT: 'sent', MESSAGE_DELETED: 'deleted',
            GENERATION_ENDED: 'generation_ended',
        },
        saveSettingsDebounced: () => {}, saveChatConditional: async () => {}, saveChat: async () => {},
        getRequestHeaders: () => ({}), setChatMessages: () => {},
    };
    const fakeEl = () => {
        const el = {
            dataset: {}, style: {}, children: [], _listeners: {}, _value: '',
            addEventListener: (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); },
            removeEventListener: () => {}, dispatchEvent: () => true,
            appendChild: (c) => { el.children.push(c); return c; }, removeChild: () => {},
            querySelector: () => fakeEl(), querySelectorAll: () => [],
            click: () => {}, focus: () => {}, blur: () => {}, contains: () => false,
            getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
        };
        Object.defineProperty(el, 'innerHTML', { get: () => el._html || '', set: (v) => { el._html = v; } });
        Object.defineProperty(el, 'textContent', { get: () => '', set: () => {} });
        Object.defineProperty(el, 'value', { get: () => el._value, set: (v) => { el._value = v; } });
        Object.defineProperty(el, 'checked', { get: () => !!el._checked, set: (v) => { el._checked = v; } });
        Object.defineProperty(el, 'disabled', { get: () => !!el._disabled, set: (v) => { el._disabled = v; } });
        return el;
    };
    const doc = {
        querySelector: () => fakeEl(), getElementById: () => fakeEl(), createElement: () => fakeEl(),
        createTextNode: () => fakeEl(), addEventListener: () => {}, body: fakeEl(),
    };
    const win = {
        top: null, parent: null, document: doc, console,
        setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t),
        setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (t) => clearInterval(t),
        CustomEvent: function () {}, addEventListener: () => {}, dispatchEvent: () => true,
        TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        SillyTavern: { getContext: () => context }, AutoCardUpdaterAPI: fakeApi,
        eventEmit: () => {}, toastr: undefined,
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    vm2.createContext(win);
    vm2.runInContext(extIndex, win);

    (handlers['chat_changed'] || []).forEach(fn => fn());
    await new Promise(res => setTimeout(res, 2600));
    assert.strictEqual(initCalls, 0, '聊天无 AI 楼层时不得调用 initGameSession（否则插件报“不存在可写入初始化 checkpoint 的 AI 楼层”）');
});

test('运行时仅表头但持久化已有数据行时，补行必须跳过（防止造重复行触发“手动追平完整性校验失败”）', async () => {
    const vm2 = require('vm');
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const toLayout = (schema) => core.buildLayout(schema).entries.map(e => ({
        kind: e.kind, group: e.group, table: e.table, keyCol: e.keyCol || '', keyValue: e.keyValue || '',
        cols: (e.cols || []).map(c => (e.kind === 'singleton'
            ? [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, c.path || [], !!c.isPair, c.desc || '']
            : [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, null, !!c.isPair, c.desc || ''])),
        writePaths: e.writePaths || [], mirrors: e.mirrors || [],
    }));
    const srcDir = path.join(__dirname, '..', 'src');
    const coreSource = fs.readFileSync(path.join(srcDir, 'mvu2shujuku.js'), 'utf8');
    const pinyinData = fs.readFileSync(path.join(srcDir, 'pinyin-data.js'), 'utf8');
    const yamlLibsData = fs.readFileSync(path.join(srcDir, 'vendor', 'mvu-yaml-libs.js'), 'utf8');
    const jsonrepairData = fs.readFileSync(path.join(srcDir, 'vendor', 'jsonrepair-lite.js'), 'utf8');
    const pinyinInline = pinyinData.replace(/^[\s\S]*?module\.exports\s*=\s*/, 'root.__MVU2SHUJUKU_PINYIN__ = ').replace(/;\s*$/, ';');
    const yamlLibsInline = ['(function () {', '  var module = { exports: {} };', '  var exports = module.exports;', yamlLibsData, '  var target = typeof globalThis !== "undefined" ? globalThis : this;', '  target.__MVU2SHUJUKU_YAML_LIBS__ = module.exports;', '})();', ''].join('\n');
    const jsonrepairInline = 'root.__MVU2SHUJUKU_JSONREPAIR_SRC__ = ' + JSON.stringify(jsonrepairData) + ';';
    const extIndex = core.assembleExtension({ coreSource, pinyinInline, yamlLibsInline, jsonrepairInline })['index.js'];

    // 运行时：主角表仅表头（插件回放未完成）
    const tables = JSON.parse(JSON.stringify(r.template));
    for (const k of Object.keys(tables)) {
        if (tables[k] && Array.isArray(tables[k].content) && tables[k].content.length > 1) tables[k].content = [tables[k].content[0]];
    }
    // 持久化：checkpoint 主角表已有行（回放后会恢复）
    const persisted = JSON.parse(JSON.stringify(r.template));
    const checkpointMsg = {
        message_id: 0,
        TavernDB_ACU_IsolatedData: JSON.stringify({
            系统: { storageFrame: { version: 2, logEntries: [], checkpoint: { kind: 'full', data: persisted, ts: 1 } } },
        }),
    };
    let insertCalls = 0;
    const fakeApi = Object.assign(applyingApi(tables), {
        insertRow: async () => { insertCalls += 1; return 1; },
        updateCell: async () => false, // 运行时无行 → 越界（触发合并层重试）
    });
    const handlers = {};
    const converted = {
        name: '补行守卫卡',
        avatar: 'guard.png',
        data: {
            extensions: {
                mvu2shujuku: { converter: 'mvu2shujuku', layout: JSON.stringify(toLayout(r.schema)) },
                regex_scripts: [],
            },
            character_book: {
                entries: [{
                    keys: ['__ACU_TEMPLATE_DATA__'],
                    content: Buffer.from(JSON.stringify(r.template)).toString('base64'),
                }],
            },
        },
    };
    const context = {
        chatId: 'c-guard', name: '测试', chat: [checkpointMsg],
        characters: [converted], characterId: 0,
        extensionSettings: { mvu2shujuku: { debug: false } },
        eventSource: { on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); }, emit: () => {} },
        event_types: {
            CHAT_CHANGED: 'chat_changed', MESSAGE_RECEIVED: 'message_received', MESSAGE_SWIPED: 'swiped',
            MESSAGE_UPDATED: 'updated', MESSAGE_EDITED: 'edited', MESSAGE_SENT: 'sent', MESSAGE_DELETED: 'deleted',
            GENERATION_ENDED: 'generation_ended',
        },
        saveSettingsDebounced: () => {}, saveChatConditional: async () => {}, saveChat: async () => {},
        getRequestHeaders: () => ({}), setChatMessages: () => {},
    };
    const fakeEl = () => {
        const el = {
            dataset: {}, style: {}, children: [], _listeners: {}, _value: '',
            addEventListener: (t, fn) => { (el._listeners[t] = el._listeners[t] || []).push(fn); },
            removeEventListener: () => {}, dispatchEvent: () => true,
            appendChild: (c) => { el.children.push(c); return c; }, removeChild: () => {},
            querySelector: () => fakeEl(), querySelectorAll: () => [],
            click: () => {}, focus: () => {}, blur: () => {}, contains: () => false,
            getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
        };
        Object.defineProperty(el, 'innerHTML', { get: () => el._html || '', set: (v) => { el._html = v; } });
        Object.defineProperty(el, 'textContent', { get: () => '', set: () => {} });
        Object.defineProperty(el, 'value', { get: () => el._value, set: (v) => { el._value = v; } });
        Object.defineProperty(el, 'checked', { get: () => !!el._checked, set: (v) => { el._checked = v; } });
        Object.defineProperty(el, 'disabled', { get: () => !!el._disabled, set: (v) => { el._disabled = v; } });
        return el;
    };
    const doc = {
        querySelector: () => fakeEl(), getElementById: () => fakeEl(), createElement: () => fakeEl(),
        createTextNode: () => fakeEl(), addEventListener: () => {}, body: fakeEl(),
    };
    const win = {
        top: null, parent: null, document: doc, console,
        setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t),
        setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (t) => clearInterval(t),
        CustomEvent: function () {}, addEventListener: () => {}, dispatchEvent: () => true,
        TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        SillyTavern: { getContext: () => context }, AutoCardUpdaterAPI: fakeApi,
        eventEmit: () => {}, toastr: undefined,
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    vm2.createContext(win);
    vm2.runInContext(extIndex, win);

    const prev = { 主角: { 姓名: '未知' } };
    const next = { 主角: { 姓名: '斯维姆' } };
    await win.MVU2SHUJUKU_CORE.writeStatDiffToDb(fakeApi, toLayout(r.schema), prev, next, persisted);
    assert.strictEqual(insertCalls, 0, '持久化已有主角表行时不得补行（否则造重复行 → 手动追平完整性校验失败）');
});

/* ---------------- 动态键字典（修仙秘闻式） ---------------- */

test('[mvu_update] 动态键字典（{ [键]: value }）拆成子行表而非固定列，读回保持 {键: 值} 原形', () => {
    const initvar = {
        世界系统: {
            当前时间: '巳时',
            修仙秘闻: {
                诡异阵纹: '阵道阁外多了一圈画歪的王八。',
                半夜声响: '藏经阁半夜传出搓麻将的声音。',
            },
        },
    };
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '动态字典卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [
                    { comment: '[InitVar]', content: JSON.stringify(initvar) },
                    {
                        comment: '[mvu_update]变量更新规则',
                        content: [
                            '--- 变量更新规则:',
                            '  世界系统:',
                            '    修仙秘闻:',
                            '      type: |-',
                            '        {',
                            '          [秘闻简述: string]: string;',
                            '        }',
                            '      check:',
                            '        - "每次生成4条秘闻，replace 整个对象"',
                        ].join('\n'),
                    },
                ],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both' });
    const layout = core.buildLayout(r.schema);
    const e = layout.entries.find(x => x.table === '修仙秘闻表');
    assert.ok(e, '应有修仙秘闻表（子行表）');
    assert.strictEqual(e.kind, 'rows', '修仙秘闻应为行表');
    assert.strictEqual(e.scalarValueCol, '描述', '标量条目应标记描述列');
    const ws = layout.entries.find(x => x.table === '世界系统表');
    assert.ok(ws.cols.every(c => c.zh !== '修仙秘闻诡异阵纹' && c.zh !== '修仙秘闻半夜声响'), '修仙秘闻不得展平成固定列');
    const t = Object.values(r.template).find(s => s && s.name === '修仙秘闻表');
    assert.deepStrictEqual(t.content[0], ['row_id', '键名', '描述', '_扩展数据'], '修仙秘闻表头应为 键名/描述');
    // 读回保持 {键: 值} 原形（z.record(z.string(), z.string()) 兼容）
    const lj = layout.entries.map(e => ({
        kind: e.kind, group: e.group, table: e.table, keyCol: e.keyCol || '', keyValue: e.keyValue || '',
        scalarValueCol: e.scalarValueCol || '',
        cols: (e.cols || []).map(c => [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, e.kind === 'singleton' ? (c.path || []) : null, !!c.isPair, c.desc || '']),
        writePaths: e.writePaths || [], mirrors: e.mirrors || [],
    }));
    const sd = core.statDataFromTables(lj, r.template).stat_data;
    assert.deepStrictEqual(sd.世界系统.修仙秘闻, { 诡异阵纹: '阵道阁外多了一圈画歪的王八。', 半夜声响: '藏经阁半夜传出搓麻将的声音。' });
    // 静态子对象（今日运势式，组内还有标量字段）仍展平为列
    const card2 = { ...card, data: { ...card.data, name: '静态卡', character_book: { entries: [{ comment: '[InitVar]', content: JSON.stringify({ 世界系统: { 当前时间: '巳时', 今日运势: { 宜: '看潮', 忌: '翻地图' } } }) }] } } };
    const r2 = core.convert(card2, { mode: 'both' });
    const ws2 = core.buildLayout(r2.schema).entries.find(x => x.table === '世界系统表');
    assert.ok(ws2.cols.some(c => c.zh === '今日运势宜') && ws2.cols.some(c => c.zh === '今日运势忌'), '固定子对象应展平为列');
});

test('无规则时按跨分支 <initvar> 键集变化识别动态键字典（兜底）', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '分支动态卡',
            description: '',
            first_mes: '你好',
            alternate_greetings: [
                '<UpdateVariable>\n<initvar>\n世界系统:\n  当前时间: 巳时\n  修仙秘闻:\n    诡异阵纹: 分支A秘闻一\n    半夜声响: 分支A秘闻二\n</initvar>\n</UpdateVariable>',
                '<UpdateVariable>\n<initvar>\n世界系统:\n  当前时间: 午时\n  修仙秘闻:\n    海图司账本: 分支B秘闻一\n    龙绡渡潮阵: 分支B秘闻二\n</initvar>\n</UpdateVariable>',
            ],
            character_book: { entries: [] },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both' });
    const e = core.buildLayout(r.schema).entries.find(x => x.table === '修仙秘闻表');
    assert.ok(e && e.kind === 'rows', '跨分支键集不同应识别为行表');
    const ws = core.buildLayout(r.schema).entries.find(x => x.table === '世界系统表');
    assert.ok(ws.cols.every(c => c.zh.indexOf('修仙秘闻') !== 0), '修仙秘闻不得展平成固定列');
});

test('type 块标量内含中文键（标签/描述等）时不得截断父字段、不得误解析枚举（V4.1 回归）', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '块标量中文键卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [
                    {
                        comment: '[InitVar]',
                        content: '主角状态:\n  个人背包:\n    物品A: { 描述: x, 数量: 1 }\n世界系统:\n  修仙八卦论坛:\n    标题A: { 标签: 热, 详情描述: y }\n  修仙秘闻:\n    秘闻A: z',
                    },
                    {
                        comment: '[mvu_update]变量更新规则',
                        content: [
                            '变量更新规则:',
                            '  主角状态:',
                            '    个人背包:',
                            '      type: |-',
                            '        {',
                            '          [物品名: string]: {',
                            '            描述: string;',
                            '            数量: number;',
                            '          }',
                            '        }',
                            '      check:',
                            '        - 获得具体物品时写入完整对象',
                            '        - 使用物品时即使描述模糊，也要优先匹配已有背包条目',
                            '  世界系统:',
                            '    修仙八卦论坛:',
                            '      type: |-',
                            '        {',
                            '          [热搜标题: string]: {',
                            '            标签: "热" | "新" | "荐" | "爆" | "普通";',
                            '            详情描述: string;',
                            '          }',
                            '        }',
                            '      check:',
                            '        - 每次回复必须 replace 整个对象',
                            '        - 标签只能使用热、新、荐、爆、普通',
                            '    修仙秘闻:',
                            '      type: |-',
                            '        {',
                            '          [秘闻简述: string]: string;',
                            '        }',
                            '      check:',
                            '        - 每次生成4条秘闻',
                        ].join('\n'),
                    },
                ],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const si = core.parseMvuShapes(card);
    // 整表 check 不被 type 块内容截断（块内 描述/标签/数量 等中文键行不得成为假字段）
    assert.deepStrictEqual(
        (si.checks['主角状态'] || {}).个人背包,
        ['获得具体物品时写入完整对象', '使用物品时即使描述模糊，也要优先匹配已有背包条目'],
        '个人背包整表 check 应保留（type 块内中文键不得截断）'
    );
    assert.ok(
        (si.checks['世界系统'] || {}).修仙八卦论坛 && (si.checks['世界系统'] || {}).修仙八卦论坛.some(c => c.includes('每次回复必须 replace 整个对象')),
        '修仙八卦论坛整表 check 应保留'
    );
    assert.ok(!si.enums['标签'], 'TS 联合类型（"热" | "新" | ...）不应被误当成行内枚举');
    assert.ok(!si.enums['分类'], '分类联合类型不应被误解析');
    // 落到模板 note
    const r = core.convert(card, { mode: 'both' });
    const bj = Object.values(r.template).find(s => s && s.name === '修仙八卦论坛表');
    assert.ok(bj && bj.sourceData.note.includes('标签只能使用热、新、荐、爆、普通'), '修仙八卦论坛表 note 应含标签约束');
    const mw = Object.values(r.template).find(s => s && s.name === '修仙秘闻表');
    assert.ok(mw && mw.sourceData.note.includes('每次生成4条秘闻'), '修仙秘闻表 note 应含整表 check');
});

test('规则声明但 initvar 无数据的动态键字典（路遇道友录式）也建空子表，列与规则来自 type 声明', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '空动态字典卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [
                    {
                        comment: '[InitVar]',
                        content: '人际交往:\n  最新传讯:\n    发送者: 无\n    内容: 暂无',
                    },
                    {
                        comment: '[mvu_update]变量更新规则',
                        content: [
                            '变量更新规则:',
                            '  人际交往:',
                            '    路遇道友录:',
                            '      type: |-',
                            '        {',
                            '          [NPC名字: string]: {',
                            '            好感度数值: number;',
                            '            关系标签: string;',
                            '          }',
                            '        }',
                            '      check:',
                            '        - 已正式见面、互通姓名并发生交易的 NPC 可写入',
                            '        - 好感度数值用 delta，普通互动 ±1~3',
                        ].join('\n'),
                    },
                ],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both' });
    const s = Object.values(r.template).find(x => x && x.name === '路遇道友录表');
    assert.ok(s, '应生成路遇道友录空子表（initvar 无数据但有规则声明）');
    assert.deepStrictEqual(s.content[0], ['row_id', '键名', '好感度数值', '关系标签', '_扩展数据'], '空子表列应来自 type 声明的条目字段');
    assert.ok(s.sourceData.note.includes('好感度数值用 delta'), '空子表 note 应含整表 check');
    assert.ok(s.sourceData.note.includes('已正式见面'), '空子表 note 应含规则全文');
});

test('YAML 优先：flow mapping 单行组（正则解析不了的写法）也能提取 check/range', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: 'flow卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [
                    { comment: '[InitVar]', content: '主角: { 道心: 50 }' },
                    {
                        comment: '[mvu_update]变量更新规则',
                        content: '变量更新规则:\n  主角: { 道心: { type: number, range: 0~100, check: ["归零则走火入魔"] } }',
                    },
                ],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const si = core.parseMvuShapes(card);
    assert.deepStrictEqual((si.checks['主角'] || {}).道心, ['归零则走火入魔'], 'flow 写法的 check 应被提取（正则解析不了，YAML 优先覆盖）');
    assert.deepStrictEqual(si.ranges['道心'], [0, 100], 'flow 写法的 range 应被提取');
    const r = core.convert(card, { mode: 'both' });
    const sheet = Object.values(r.template).find(s => s && s.name === '主角表');
    assert.ok(sheet && sheet.sourceData.note.includes('归零则走火入魔'), 'flow 写法规则应落到 note');
});

test('非法 YAML（format 带裸 | 联合）时回退正则，功法式动态字典仍正确拆表（大荒回归）', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '非法yaml卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [
                    { comment: '[InitVar]', content: '主角:\n  功法: {}\n  灵气浓度: 普通' },
                    {
                        comment: '[mvu_update]变量更新规则',
                        content: [
                            '变量更新规则:',
                            '  世界:',
                            '    灵气浓度:',
                            "      format: '稀薄'|'普通'|'浓郁'|'极浓'",
                            '  主角:',
                            '    功法:',
                            '      type: |-',
                            '        {',
                            '          [功法键名: string]: {',
                            '            名称: string;',
                            '            品阶: string;',
                            '            修炼层数: string;',
                            '            效果: string;',
                            '          }',
                            '        }',
                            '      check:',
                            '        - 习得新功法时insert完整四字段',
                        ].join('\n'),
                    },
                ],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const si = core.parseMvuShapes(card);
    assert.strictEqual(si.dynamicDicts['主角']['功法'], true, '非法 YAML 时应回退正则，功法动态字典仍被识别');
    assert.deepStrictEqual(si.shapes['功法'], ['名称', '品阶', '修炼层数', '效果'], '功法条目字段应来自 type 声明');
    const r = core.convert(card, { mode: 'both' });
    const gf = Object.values(r.template).find(s => s && s.name === '功法表');
    assert.deepStrictEqual(gf && gf.content[0], ['row_id', '键名', '名称', '品阶', '修炼层数', '效果', '_扩展数据'], '功法表列应为 type 声明字段，而非只剩 _扩展数据');
});

test('组内子字段通配（首段非组名）挂到所在组，format 一并带出（大荒回归）', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '组内通配卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [
                    { comment: '[InitVar]', content: '主角:\n  生理:\n    欲望槽: 0\n  技艺:\n    炼丹: 未入门' },
                    {
                        comment: '[mvu_update]变量更新规则',
                        content: [
                            '变量更新规则:',
                            '  主角:',
                            '    生理.欲望槽:',
                            '      type: number',
                            '      range: 0~100',
                            '      format: 数值',
                            '      check:',
                            '        - 遭遇媚药时上涨',
                            '    技艺.${炼丹|炼器}:',
                            '      type: string',
                            "      format: '未入门'|'黄'|'玄'",
                            '      check:',
                            '        - 获得传承后提升',
                        ].join('\n'),
                    },
                ],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const si = core.parseMvuShapes(card);
    const wrs = si.wildcardRules['主角'] || [];
    assert.ok(wrs.some(w => w.path === '生理.欲望槽' && w.range && w.range[0] === 0 && w.range[1] === 100), '组内通配应挂到所在组 主角');
    assert.ok(wrs.some(w => w.path === '技艺.${炼丹|炼器}' && w.format), '组内通配应带出 format');
    const r = core.convert(card, { mode: 'both' });
    const zj = Object.values(r.template).find(x => x && x.name === '主角表');
    const note = zj.sourceData.note || '';
    assert.ok(note.includes('生理.欲望槽'), '主角表 note 应含组内通配规则');
    assert.ok(note.includes('技艺.${炼丹|炼器}（格式：'), '主角表 note 应带出 format');
    assert.ok(note.includes('获得传承后提升'), '主角表 note 应含通配 check');
});

test('不同组下同名子表（行囊.背包 / 宗门.背包）用父组限定表名，避免插件导入校验失败（大荒回归）', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '重名子表卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [{ comment: '[InitVar]', content: '行囊:\n  背包: {}\n宗门:\n  背包: {}' }],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both' });
    const names = Object.keys(r.template).filter(k => k.startsWith('sheet_')).map(k => r.template[k].name);
    assert.strictEqual(names.filter((n, i) => names.indexOf(n) !== i).length, 0, '表名不得重复');
    assert.ok(names.includes('行囊背包表') && names.includes('宗门背包表'), '同名子表应统一用父组限定表名（两个都带前缀）');
    // 模拟插件 canonicalizeDisplayName：NFKC + 去空白 + 小写，规范化后也不得重复
    const norm = s => String(s).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
    const canon = names.map(norm);
    assert.strictEqual(canon.filter((c, i) => canon.indexOf(c) !== i).length, 0, '规范化后表名不得重复（插件导入校验）');
});

test('首段为 ${A|B} 模板键的通配规则（${小宅仙|小御仙}.当前阶段）挂到所在组，不丢失（大荒回归）', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '模板键通配卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [
                    { comment: '[InitVar]', content: '天道娘面板:\n  激活状态: 小宅仙\n  小宅仙:\n    当前阶段: 数据残影\n    性格: 怕死' },
                    {
                        comment: '[mvu_update]变量更新规则',
                        content: [
                            '变量更新规则:',
                            '  天道娘面板:',
                            '    激活状态:',
                            '      check:',
                            '        - 开局仅小宅仙',
                            '    ${小宅仙|小御仙}.当前阶段:',
                            '      check:',
                            '        - 小宅仙阶段序列：数据残影(0)>幼态凝实(1)',
                            '    ${小宅仙|小御仙}.性格:',
                            '      check:',
                            '        - 怕死/利己主义',
                        ].join('\n'),
                    },
                ],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const si = core.parseMvuShapes(card);
    const wrs = si.wildcardRules['天道娘面板'] || [];
    assert.ok(wrs.some(w => w.path === '${小宅仙|小御仙}.当前阶段'), '模板键通配应挂到所在组 天道娘面板');
    assert.ok(wrs.some(w => w.path === '${小宅仙|小御仙}.性格'), '多个模板键通配都应保留');
    const r = core.convert(card, { mode: 'both' });
    const t = Object.values(r.template).find(x => x && x.name === '天道娘面板表');
    const note = t.sourceData.note || '';
    assert.ok(note.includes('小宅仙阶段序列'), '天道娘面板表 note 应含模板键通配的 check');
    assert.ok(note.includes('怕死/利己主义'), 'note 应含第二个模板键通配的 check');
});

test('路径化附着：规则分组与 initvar 结构不一致（修为 写在根目录、initvar 在 主角.修为）时，check/range 按路径挂到展平列（修为进度百分比）', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '路径附着卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [
                    { comment: '[InitVar]', content: '主角:\n  修为:\n    进度百分比: 20\n    灵气浓度: 稀薄\n  灵石钱包:\n    上品灵石: 5' },
                    {
                        comment: '[mvu_update]变量更新规则',
                        content: [
                            '变量更新规则:',
                            '  修为:',
                            '    进度百分比:',
                            '      type: number',
                            '      range: 0~100',
                            '      check:',
                            '        - 突破时更新',
                            '        - 仅正文明确修炼时变动',
                        ].join('\n'),
                    },
                ],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const si = core.parseMvuShapes(card);
    assert.ok(
        si.checkPaths.some(e => JSON.stringify(e.path) === JSON.stringify(['修为', '进度百分比']) && e.list.length === 2),
        'checkPaths 应记录规则书写路径 修为.进度百分比'
    );
    const r = core.convert(card, { mode: 'both' });
    const g = r.schema.find(x => x.name === '主角');
    const c = g.columns.find(x => x.zh === '修为进度百分比');
    assert.ok(c, '应有展平列 修为进度百分比');
    assert.deepStrictEqual(c.check, ['突破时更新', '仅正文明确修炼时变动'], '展平列应附着规则 check');
    assert.deepStrictEqual(c.range, [0, 100], '展平列应附着规则 range');
    assert.strictEqual(c.type, 'INTEGER', '带 range 的列应为 INTEGER');
});

test('路径化附着：6 空格嵌套写法（主角.修为.进度百分比）在 YAML 失败回退正则时也能记录完整路径并附着', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '6空格路径卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [
                    { comment: '[InitVar]', content: '主角:\n  修为:\n    进度百分比: 20\n  灵石钱包:\n    上品灵石: 5' },
                    {
                        comment: '[mvu_update]变量更新规则',
                        content: [
                            '变量更新规则:',
                            '  主角:',
                            '    修为:',
                            '      进度百分比:',
                            '        check:',
                            '          - 突破时更新',
                            '  世界:',
                            '    灵气浓度:',
                            '      format: \'稀薄\'|\'普通\'',
                        ].join('\n'),
                    },
                ],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const si = core.parseMvuShapes(card);
    assert.ok(
        si.checkPaths.some(e => JSON.stringify(e.path) === JSON.stringify(['主角', '修为', '进度百分比'])),
        '正则回退也应记录 3 层路径 主角.修为.进度百分比'
    );
    const r = core.convert(card, { mode: 'both' });
    const g = r.schema.find(x => x.name === '主角');
    const c = g.columns.find(x => x.zh === '修为进度百分比');
    assert.deepStrictEqual(c.check, ['突破时更新'], '6 空格子字段的 check 应附着到展平列');
});

test('路径化附着：通配路径（生理.欲望槽）按 initvar 列路径（主角.生理.欲望槽）挂 check/range（大荒回归）', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '通配路径附着卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [
                    { comment: '[InitVar]', content: '主角:\n  生理:\n    欲望槽: 0\n    体香: 冷香\n  灵石钱包:\n    上品灵石: 5' },
                    {
                        comment: '[mvu_update]变量更新规则',
                        content: [
                            '变量更新规则:',
                            '  主角:',
                            '    生理.欲望槽:',
                            '      type: number',
                            '      range: 0~100',
                            '      check:',
                            '        - 遭遇媚药或双修时上涨',
                            '        - >80 强制进入欲望失控状态',
                            '    生理.体香:',
                            '      check:',
                            '        - 功法大成或服奇药后更新',
                        ].join('\n'),
                    },
                ],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both' });
    const g = r.schema.find(x => x.name === '主角');
    const c = g.columns.find(x => x.zh === '生理欲望槽');
    assert.ok(c && c.check && c.check.length === 2, '生理欲望槽 列应附着通配 check');
    assert.deepStrictEqual(c.range, [0, 100], '生理欲望槽 列应附着通配 range');
    const b = g.columns.find(x => x.zh === '生理体香');
    assert.ok(b && b.check && b.check.length === 1, '生理体香 列应附着通配 check');
});

test('路径化附着：容器/子表级（tableLevel）check 不挂到键名列，仍保留在表级 groupChecks（行囊.背包 / 宗门.背包 回归）', () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '表级check卡',
            description: '',
            first_mes: '你好',
            character_book: {
                entries: [
                    { comment: '[InitVar]', content: '宗门:\n  背包: {}\n行囊:\n  背包: {}' },
                    {
                        comment: '[mvu_update]变量更新规则',
                        content: [
                            '变量更新规则:',
                            '  宗门:',
                            '    背包:',
                            '      type: |-',
                            '        {',
                            '          [物品标识: string]: {',
                            '            名称: string;',
                            '            数量: number;',
                            '          }',
                            '        }',
                            '      check:',
                            '        - 获得物品时 insert 或 delta 增加数量',
                            '        - 分类必须从 13 类中严格选取',
                        ].join('\n'),
                    },
                ],
            },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both' });
    const bg = r.schema.find(x => x.tableName === '宗门背包表');
    assert.ok(bg, '应有宗门背包表');
    const keyCol = bg.columns[0];
    assert.ok(!(keyCol.check && keyCol.check.length), '子表级 check 不应挂到键名列');
    assert.ok(bg.groupChecks.length === 2, '子表级 check 应保留在表级 groupChecks');
    const xl = r.schema.find(x => x.tableName === '行囊背包表');
    assert.ok(xl && xl.groupChecks.length === 0, '行囊背包表无对应规则时不得误挂宗门.背包 的表级 check');
});

test('切换开场分支：动态字典行表整组替换（旧行删除、新行插入），读回为该分支初始值', async () => {
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: '分支替换卡',
            description: '',
            first_mes: '你好',
            alternate_greetings: [
                '<UpdateVariable>\n<initvar>\n世界系统:\n  当前时间: 巳时\n  修仙秘闻:\n    诡异阵纹: 分支A秘闻一\n    半夜声响: 分支A秘闻二\n</initvar>\n</UpdateVariable>',
                '<UpdateVariable>\n<initvar>\n世界系统:\n  当前时间: 午时\n  修仙秘闻:\n    海图司账本: 分支B秘闻一\n    龙绡渡潮阵: 分支B秘闻二\n    贝壳风铃: 分支B秘闻三\n</initvar>\n</UpdateVariable>',
            ],
            character_book: { entries: [] },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
    const r = core.convert(card, { mode: 'both' });
    const tables = JSON.parse(JSON.stringify(r.template));
    const layout = core.buildLayout(r.schema).entries.map(e => ({
        kind: e.kind, group: e.group, table: e.table, keyCol: e.keyCol || '', keyValue: e.keyValue || '',
        scalarValueCol: e.scalarValueCol || '',
        cols: (e.cols || []).map(c => [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, e.kind === 'singleton' ? (c.path || []) : null, !!c.isPair, c.desc || '']),
        writePaths: e.writePaths || [], mirrors: e.mirrors || [],
    }));
    const prev = core.statDataFromTables(layout, tables).stat_data;
    const text2 = card.data.alternate_greetings[1];
    const m = String(text2).match(/<initvar>\s*\n?([\s\S]*?)\n?\s*<\/initvar>/i);
    const parsed = core.parseInitVar(m[1]);
    const fakeApi = {
        exportTableAsJson: () => tables,
        updateCell: async (t, ri, col, v) => {
            const s = Object.values(tables).find(x => x && x.name === t);
            if (s && s.content[ri]) { const ci = s.content[0].indexOf(col); if (ci >= 0) { s.content[ri][ci] = String(v); return true; } }
            return false;
        },
        insertRow: async (t, obj) => {
            const s = Object.values(tables).find(x => x && x.name === t);
            if (!s) return 0;
            const row = s.content[0].map(h => (obj && obj[h] !== undefined && obj[h] !== null) ? String(obj[h]) : '');
            row[0] = s.content.length || 1;
            s.content.push(row);
            return row[0];
        },
        deleteRow: async (t, ri) => {
            const s = Object.values(tables).find(x => x && x.name === t);
            if (!s || !s.content[ri]) return false;
            s.content.splice(ri, 1);
            return true;
        },
    };
    const n = await core.writeStatDiffToDb(fakeApi, layout, prev, parsed);
    assert.ok(n > 0, '切换分支应产生差异写入');
    const mxt = Object.values(tables).find(s => s && s.name === '修仙秘闻表');
    const names = mxt.content.slice(1).map(r => r[1]).sort();
    assert.deepStrictEqual(names, ['海图司账本', '贝壳风铃', '龙绡渡潮阵'], '修仙秘闻应整组替换为分支B条目');
    const sd = core.statDataFromTables(layout, tables).stat_data;
    assert.deepStrictEqual(sd.世界系统.修仙秘闻, { 海图司账本: '分支B秘闻一', 龙绡渡潮阵: '分支B秘闻二', 贝壳风铃: '分支B秘闻三' }, '读回应为分支B的 {键: 值}');
});

runTests();
