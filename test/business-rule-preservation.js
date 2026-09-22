'use strict';
const { test } = require('./runner');
const { core, assert } = require('./helpers');

function convert(rules, mode = 'both') {
    return core.convert({ name: '业务限制保真', first_mes: '', character_book: { entries: [
        { comment: '[InitVar]', content: '状态: {授权: 未授权}' },
        { comment: '变量更新规则', content: '变量更新规则:\n  状态:\n    授权:\n      check:\n' + rules.map(r => '        - ' + JSON.stringify(r)).join('\n') },
    ] } }, { mode });
}
const noteOf = result => Object.values(result.template).find(s => s.name === '状态表').sourceData.note;

test('业务规则保真：指令、英文名称、路径及括号条件均不因关键词被删除', () => {
    const rules = [
        '不要在没有收到管理员指令时修改授权状态',
        '权限为冻结时保持原值（收到解除指令后才可修改）',
        '【注意】角色说出指令不代表系统授权已经改变',
        '不要把 delta 阵营当成默认所属阵营',
        '【警告】patch 是物品名称，未经交易不能取得',
        '仅更新授权状态（只能修改 /状态/授权，禁止修改 /角色/姓名）',
        '调用参数（op: delta, value: -1；仅管理员确认后生效）不能直接照抄',
        '维护目录（写 /home/user/settings）需要管理员许可',
        '不完整参数（op: delta, value: 1e999）需核对',
    ];
    for (const mode of ['native', 'both', 'sqlite']) {
        const note = noteOf(convert(rules, mode));
        for (const rule of rules) assert.ok(note.includes(rule), mode + ' 丢失业务规则: ' + rule);
    }
});

test('业务规则保真：已识别 op 参数保留增量和新值，不保留旧命令语法', () => {
    const note = noteOf(convert([
        '按经过的回合递减（op: delta, value: -1）',
        '重新授权时设置为初始状态(op: replace, value: "已授权")',
        '不应越界（勿用delta导致超限）',
    ]));
    assert.match(note, /按经过的回合递减（增量：-1）/);
    assert.match(note, /重新授权时设置为初始状态（新值："已授权"）/);
    assert.match(note, /不应越界（增量更新不得导致超限）/);
    assert.doesNotMatch(note, /op:|\bdelta\b|\breplace\b/);
});

test('业务规则保真：容器机制守卫保留含义，混合业务限制不整行删除', () => {
    const mixed = '严禁对整个对象使用 replace 或 delta；管理员确认后仍须保留审计记录';
    const note = noteOf(convert([
        '【防崩警告】更新时必须精确到子字段（如 /状态/授权），严禁直接对整个对象使用 replace 或 delta！',
        mixed,
        '经验满100时必须分两条指令更新：一条replace等级提升，另一条replace经验为0（勿用delta导致超限）',
    ]));
    assert.match(note, /更新时只修改发生变化的字段或元素，保留其他内容/);
    assert.ok(note.includes(mixed));
    assert.match(note, /经验满100时，必须同时完成：等级提升；经验为0（增量更新不得导致超限）/);
});

test('业务规则保真：JSON 数组删除写法改写时保留括号中的业务限制', () => {
    const result = convert([]);
    const g = result.schema[0], column = g.columns.find(c => c.zh === '授权');
    column.isObject = true; column.jsonKind = 'array'; column.value = '[]';
    g.rows[0][g.columns.indexOf(column) + 1] = '[]';
    column.check = ['清除记录时，必须使用remove操作并指定精确索引（只能删除已过期记录）。需先读取数组内容确认索引，避免误删。'];
    const note = Object.values(core.generateTemplate([g])).find(s => s.sourceData).sourceData.note;
    assert.match(note, /只能删除已过期记录/);
    assert.match(note, /必须先读取现有数组并确认目标元素/);
    assert.match(note, /移除后保留其他记录，避免误删/);
    assert.doesNotMatch(note, /使用remove操作/);
});
