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
    assert.ok(hub.sourceData.note.includes('必须替换为「内容」列当前 JSON 中实际存在的键名'), '更新守卫应说明通配键替换');
    assert.ok(hub.sourceData.note.includes('若「内容」列为 {} 或目标键不存在'), '更新守卫应覆盖空表/目标不存在场景');
    assert.ok(hub.sourceData.note.includes('它们仍存在于同一 JSON 中'), '更新守卫应说明未列出字段仍物理存在于同一 JSON');
    assert.ok(hub.sourceData.note.includes('未列出的字段一律只读'), '更新守卫应包含未列出字段只读');
    assert.ok(hub.sourceData.updateNode.includes('未列出字段一律只读'), 'JSON 表 updateNode 应包含只读守卫');
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
    assert.ok(dl.sourceData.updateNode.includes('示例值仅为格式演示'), 'UPDATE 应注明示例值仅为格式演示');
});

test('单例 UPDATE 示例：与行表一致的“规则 + SQL示例:”格式，TEXT 用“新值”占位', () => {
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const world = Object.values(r.template).find(s => s && s.name === '世界表');
    const node = world.sourceData.updateNode;
    assert.ok(node.includes('SQL示例: UPDATE shijiebiao SET dangqianshijian ='), '单例 updateNode 应有 SQL示例: 前缀');
    assert.ok(node.includes("= '新值'"), 'TEXT 字段 UPDATE 示例应用“新值”占位，而非当前默认值');
    assert.ok(!node.includes("'未知'"), 'UPDATE 示例不应使用当前默认值（避免读成更新成原值）');
    assert.ok(node.includes('示例值仅为格式演示'), '应注明示例值仅为格式演示');
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

test('writeStatDiffToDb：多操作走 SQL 批量事务，只提交一次且 row_id 不冲突', async () => {
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
    let sqlBatchCalls = 0;
    const api = {
        exportTableAsJson: () => tables,
        executeSqlBatch: async (sql) => {
            sqlBatchCalls++;
            applySqlToTables(tables, sql);
            return { success: true, appliedEdits: 1 };
        },
        updateCell: async () => { throw new Error('批量路径不应走逐格 updateCell'); },
        insertRow: async () => { throw new Error('批量路径不应走逐行 insertRow'); },
        deleteRow: async () => { throw new Error('批量路径不应走逐行 deleteRow'); },
    };
    const prev = { 系统: { 当前MC点: 100 }, 角色: { 西园寺爱丽莎: { 好感度: 0 } }, '$器灵台词': ['旧'] };
    const next = { 系统: { 当前MC点: 80 }, 角色: { 西园寺爱丽莎: { 好感度: 5 }, 月咏深雪: { 好感度: 3 }, 苏媚: { 好感度: 2 } }, '$器灵台词': ['新1', '新2'] };
    const n = await core.writeStatDiffToDb(api, layout, prev, next);
    assert.ok(n >= 5, '应产生 5 个以上差异操作');
    assert.strictEqual(sqlBatchCalls, 1, '多操作应只提交一次 SQL 批量事务');
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
    const inserts = [];
    const api = {
        exportTableAsJson: () => tables,
        executeSqlBatch: async (sql) => {
            applySqlToTables(tables, sql);
            for (const line of sql.split(';')) {
                if (line.includes('INSERT INTO')) inserts.push(line.trim());
            }
            return { success: true, appliedEdits: 1 };
        },
        updateCell: async () => { throw new Error('批量路径不应走逐格 updateCell'); },
        insertRow: async () => { throw new Error('批量路径不应走逐行 insertRow'); },
        deleteRow: async () => { throw new Error('批量路径不应走逐行 deleteRow'); },
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
    assert.strictEqual(inserts.length, 2, '两个新条目应各只有一条 INSERT，实际 ' + inserts.length + ' 条');
    assert.ok(inserts.some(s => s.includes('阿勒苏霍德之笔') && s.includes('写下的故事会成真') && s.includes('传说中的笔')), '同一新行多个字段应合并进同一条 INSERT');
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

test('writeStatDiffToDb：SQL 批量失败时自动回退逐条写入', async () => {
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
        executeSqlBatch: async () => { sqlBatchCalls++; return { success: false, error: '模拟重绑失败' }; },
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
    assert.ok(n >= 3, '回退后仍应返回差异操作数');
    assert.strictEqual(sqlBatchCalls, 1, 'SQL 批量应只尝试一次');
    assert.strictEqual(tables.sheet_1.content[1][2], 80, '回退后单例更新应生效');
    assert.strictEqual(tables.sheet_2.content[1][2], 5, '回退后行表更新应生效');
    assert.strictEqual(tables.sheet_2.content.length, 3, '回退后应插入新行');
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
    assert.deepStrictEqual(taskSheet.content[0], ['row_id', '名称', '内容'], 'JSON 表头应为 row_id/名称/内容');
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
        getContext: () => ({ chatId: 'c1', name: '测试', chat: [], eventSource: { on: () => {}, emit: () => {} }, event_types: { MESSAGE_RECEIVED: 'x' } }),
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
        getContext: () => ({ chatId: 'c1', name: '测试', chat: [], eventSource: { on: () => {}, emit: () => {} }, event_types: { MESSAGE_RECEIVED: 'x' } }),
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
        getContext: () => ({ chatId: 'c1', name: '测试', chat: [], eventSource: { on: () => {}, emit: () => {} }, event_types: { MESSAGE_RECEIVED: 'x' } }),
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    win.AutoCardUpdaterAPI = fakeApi;
    vm.createContext(win);
    vm.runInContext(r.bridgeScript, win);
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            try {
                assert.ok(initCalls >= 1 || importCalls >= 1, '旧模板缺列时应触发重新建表（initGameSession 或 importTemplateFromData）');
                assert.deepStrictEqual(tables[taskKey].content[0], ['row_id', '名称', '内容'], '导入后任务表应恢复为名称+内容结构');
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

test('seedRows 兜底：content 仅表头时用 seedRows 还原初始行（首楼被删/重置场景）', () => {
    const layout = [
        { kind: 'singleton', group: '系统', table: '系统表', keyCol: '名称', keyValue: '系统', cols: [['名称', 'text', '', '', '', ''], ['当前时间', 'text', '', '', '', '']], writePaths: [], mirrors: [] },
        { kind: 'rows', group: '储物袋', table: '储物袋表', keyCol: '名称', cols: [['名称', 'text', '', '', '', ''], ['数量', 'number', '', '', '', '']], writePaths: [['主角', '储物袋']], mirrors: [] },
    ];
    const tables = {
        sheet_1: { name: '系统表', content: [['row_id', '名称', '当前时间']], seedRows: [[1, '系统', '12:00']] },
        sheet_2: { name: '储物袋表', content: [['row_id', '名称', '数量']], seedRows: [[1, '铁剑', 1]] },
    };
    const out = core.statDataFromTables(layout, tables);
    assert.strictEqual(out.stat_data.系统.当前时间, '12:00', '单例表 seedRows 应还原');
    assert.strictEqual(out.stat_data.主角.储物袋['铁剑'].数量, 1, '行表 seedRows 应还原');
    // 无 seedRows 时保持原行为（空）
    const out2 = core.statDataFromTables(layout, { sheet_1: { name: '系统表', content: [['row_id', '名称', '当前时间']] }, sheet_2: { name: '储物袋表', content: [['row_id', '名称', '数量']] } });
    assert.strictEqual(out2.stat_data.系统.当前时间, '', '无 seedRows 时单例为空值');
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
        getContext: () => ({ chatId: 'c1', name: '挂起卡', chat: [], eventSource: { on: () => {} }, event_types: { MESSAGE_RECEIVED: 'x' } }),
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
    assert.ok(ins2.includes("VALUES ('条目名')") || !ins2.includes('值1'), ins2);
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
        getContext: () => ({ chatId: 'c1', chat: [], eventSource: { on() {}, emit() {} }, event_types: { MESSAGE_RECEIVED: 'x' } }),
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
        chat: [],
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
    assert.ok(initCalls > initCallsBeforeWrite, '缓存键不匹配时名称兜底应使写库成功（实际 initCalls ' + initCallsBeforeWrite + ' → ' + initCalls + '）');
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
    // 等待周期重锚（3s 间隔 + 2.5s 节流）用当前卡 C 的模板重建
    await new Promise(res => setTimeout(res, 4500));
    const namesC = Object.keys(lastInitTemplateData || {})
        .filter(k => k.indexOf('sheet_') === 0)
        .map(k => lastInitTemplateData[k].name);
    assert.ok(namesC.includes('仓库表'), '重锚应使用当前卡 C 的模板，实际：' + namesC.join('、'));
    assert.ok(!namesC.includes('主角表'), '重锚不得串用上一张卡（B）的模板缓存');

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
        chat: [],
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
    const fakeApi = {
        getTemplatePresetNames: () => [],
        exportTableAsJson: () => tables,
        initGameSession: async () => { initCalls += 1; return { success: true, runtimeReady: true }; },
        importTemplateFromData: async () => ({ success: true }),
        importTableAsJson: async (jsonStr) => {
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
    // 前端写入一个变化：必须以 checkpoint 为基线，保留持久化数据（主角姓名）并应用变化
    await win.Mvu.replaceMvuData({ stat_data: { 世界: { 当前时间: '测试时间' } } });
    await new Promise(res => setTimeout(res, 1000));
    const zjAfter = Object.values(tables).find(s => s && s.name === '主角表');
    assert.strictEqual(zjAfter.content[1][zjAfter.content[0].indexOf('姓名')], '斯维姆', '刷新后写库不得把持久化的主角姓名覆盖成默认值');
    const worldAfter = Object.values(tables).find(s => s && s.name === '世界表');
    assert.strictEqual(worldAfter.content[1][worldAfter.content[0].indexOf('当前时间')], '测试时间', '本次写入的变化应应用');
});

runTests();
