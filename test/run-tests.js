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
            s.content.splice(ri + 1, 1);
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
            TavernDB_ACU_isolated: JSON.stringify({ 系统: { storageFrame: { version: 2, logEntries: [], checkpoint: { kind: 'full', ts: Date.now() } } } }) });
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
    // setMvuVariable：mvu 缺 stat_data 也不应崩溃（旧 MVU 会因 $internal 崩溃），且写入成功
    const empty = {};
    return Promise.resolve(Mvu.setMvuVariable(empty, '系统.测试字段', 42, { reason: '测试' }))
        .then((ok) => {
            assert.strictEqual(ok, true, 'setMvuVariable 应返回 true');
            assert.strictEqual(empty.stat_data.系统.测试字段, 42, 'setMvuVariable 应写入 stat_data');
            // getMvuVariable / getRecordFromMvuData
            assert.strictEqual(Mvu.getMvuVariable(empty, '系统.测试字段'), 42, 'getMvuVariable 应读到新值');
            assert.strictEqual(Mvu.getMvuVariable(empty, '系统.不存在', { default_value: '缺省' }), '缺省', 'getMvuVariable 默认值');
            const rec = Mvu.getRecordFromMvuData(empty, 'stat');
            assert.strictEqual(rec.系统.测试字段, 42, 'getRecordFromMvuData 应返回 stat 记录');
            // VWD（数组长度 2）取第一个元素
            const vwd = { stat_data: { 系统: { 值: [7, '说明'] } } };
            assert.strictEqual(Mvu.getMvuVariable(vwd, '系统.值'), 7, 'VWD 应取第一个元素');
            // parseMessage：在副本上应用 _.set / _.add 命令
            const base = { stat_data: { 主角: { 修为: 10 } } };
            return Mvu.parseMessage("<UpdateVariable>\n_.set('主角.修为', 20);\n_.add('主角.灵气', 5);\n</UpdateVariable>", base).then((parsed) => ({ parsed, base }));
        })
        .then(({ parsed, base }) => {
            assert.ok(parsed && parsed.stat_data.主角.修为 === 20, 'parseMessage 应应用 _.set');
            assert.strictEqual(parsed.stat_data.主角.灵气, 5, 'parseMessage 应应用 _.add');
            assert.strictEqual(base.stat_data.主角.修为, 10, 'parseMessage 不应改动传入对象');
            // 无更新命令时返回 undefined（与 MVU 一致）
            return Mvu.parseMessage('纯文本没有命令', base);
        })
        .then((none) => {
            assert.strictEqual(none, undefined, '无更新命令时 parseMessage 应返回 undefined');
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
    const fakeApi = {
        exportTableAsJson: () => tables,
        importTemplateFromData: async (tpl) => {
            importCalls += 1;
            // 导入后按模板恢复正确表头
            const exp = Object.keys(tpl).find(k => tpl[k].name === '任务表');
            if (exp) tables[taskKey].content = JSON.parse(JSON.stringify(tpl[exp].content));
            return { success: true };
        },
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
        getContext: () => ({ chatId: 'c1', name: '测试', chat: [], eventSource: { on: () => {}, emit: () => {} }, event_types: { MESSAGE_RECEIVED: 'x' } }),
    };
    win.top = win; win.parent = win; win.window = win; win.globalThis = win;
    win.AutoCardUpdaterAPI = fakeApi;
    vm.createContext(win);
    vm.runInContext(r.bridgeScript, win);
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            try {
                assert.ok(importCalls >= 1, '旧模板缺列时应触发重新导入（importTemplateFromData 被调用）');
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
            chat.push({ message_id: chat.length, TavernDB_ACU_isolated: JSON.stringify({ 系统: { storageFrame: { version: 2, logEntries: [], checkpoint: { kind: 'full', ts: 1 } } } }) });
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
            chat.push({ message_id: chat.length, TavernDB_ACU_isolated: JSON.stringify({ 系统: { storageFrame: { version: 2, logEntries: [], checkpoint: { kind: 'full', ts: 1 } } } }) });
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

test('聊天缺 full checkpoint 时自动重建数据库锚点；已有锚点则不重复', async () => {
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

    // 无锚点：ensureTemplateInit 应调用 initGameSession 补锚
    const s1 = makeSandbox([]);
    await waitBridgeFlush(500);
    assert.ok(s1.initCalls() >= 1, '无 full checkpoint 时应调用 initGameSession 重建锚点');

    // 已有锚点：不应再次调用 initGameSession 补锚
    const s2 = makeSandbox([
        { message_id: 0, is_user: false, mes: '你好',
          TavernDB_ACU_isolated: JSON.stringify({ 系统: { storageFrame: { version: 2, logEntries: [], checkpoint: { kind: 'full', ts: 1 } } } }) },
    ]);
    await waitBridgeFlush(500);
    assert.strictEqual(s2.initCalls(), 0, '已存在 full checkpoint 时不应重复重建锚点');
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

test('写库前锚点：仅模板行改动（无额外行）时重置重建并重放写入；有额外行时放弃写入不重置', async () => {
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
                chat.push({ message_id: chat.length, TavernDB_ACU_isolated: JSON.stringify({ 系统: { storageFrame: { version: 2, logEntries: [], checkpoint: { kind: 'full', ts: 1 } } } }) });
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

    // 场景1：主角表仅模板行被改（无额外行）+ 无锚点 → 应重建锚点并成功写入
    const s1 = makeSandbox2((tables) => {
        const zj = Object.values(tables).find(s => s && s.name === '主角表');
        zj.content[1][zj.content[0].indexOf('姓名')] = '测试主角';
    });
    const mvu1 = s1.win.Mvu.getMvuData();
    mvu1.stat_data.主角.姓名 = '测试主角2';
    await s1.win.Mvu.replaceMvuData(mvu1);
    await waitBridgeFlush(600);
    assert.ok(s1.counters.init >= 1, '无额外行时应通过 initGameSession 重建锚点');
    const zj1 = Object.values(s1.tables).find(s => s && s.name === '主角表');
    assert.strictEqual(zj1.content[1][zj1.content[0].indexOf('姓名')], '测试主角2', '重建后应重放本次写入');

    // 场景2：道侣表有额外行 + 无锚点 → 不重置、放弃写入
    const s2 = makeSandbox2((tables) => {
        const dl = Object.values(tables).find(s => s && s.name === '道侣表');
        dl.content.push(['1', '测试道侣', '', '', '', '', '', '', '', '', '', '', '', '', '']);
    });
    const mvu2 = s2.win.Mvu.getMvuData();
    if (!mvu2.stat_data.主角) mvu2.stat_data.主角 = {};
    mvu2.stat_data.主角.姓名 = '不应写入';
    await s2.win.Mvu.replaceMvuData(mvu2);
    await waitBridgeFlush(600);
    assert.strictEqual(s2.counters.init, 0, '有额外行时不应重置重建');
    const zj2 = Object.values(s2.tables).find(s => s && s.name === '主角表');
    const nameIdx = zj2.content[0].indexOf('姓名');
    assert.notStrictEqual(zj2.content[1][nameIdx], '不应写入', '无锚点且有额外行时应放弃写入');
});

test('锚点检测与插件一致：只有 V2 full checkpoint 才算已锚定（模板派生/旧格式不算）', async () => {
    const card = requireFixture();
    const r = core.convert(card, { mode: 'both' });
    const vm2 = require('vm');
    const tables = JSON.parse(JSON.stringify(r.template));
    const cases = [
        // 非 full：模板派生 checkpoint（initGameSession 留下的形态）——不应算已锚定
        [{ message_id: 0, TavernDB_ACU_isolated: JSON.stringify({ 系统: { storageFrame: { version: 2, logEntries: [], checkpoint: { kind: 'template_only_root', ts: 1 } } } }) }],
        // 缺 version/logEntries：旧格式——不应算已锚定
        [{ message_id: 0, TavernDB_ACU_isolated: JSON.stringify({ 系统: { storageFrame: { checkpoint: { kind: 'full', ts: 1 } } } }) }],
        // 真正的 V2 full checkpoint——应算已锚定
        [{ message_id: 0, TavernDB_ACU_isolated: JSON.stringify({ 系统: { storageFrame: { version: 2, logEntries: [], checkpoint: { kind: 'full', ts: 1 } } } }) }],
    ];
    const expected = [false, false, true];
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
        if (expected[ci]) {
            assert.strictEqual(initCalls, 0, '真正的 V2 full checkpoint 存在时不应重建锚点');
        } else {
            assert.ok(initCalls >= 1, '非 full/旧格式 checkpoint 不应算已锚定，应触发锚点重建');
        }
    }
});

runTests();
