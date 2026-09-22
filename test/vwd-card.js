'use strict';
const syntheticCard = require('./synthetic-card');

// VWD 动态说明公开合成卡：单例组里两个初始说明完全相同的文本 pair 字段（验证按字段归属）、
// 一个没有初始说明的 pair 字段（验证空说明边界），以及一个数字对（本批按标量处理，不启用 VWD）。
// 另含动态记录，覆盖已有行更新与新增行的数字/布尔 pair；不使用任何私有角色卡。
module.exports = function vwdCard() {
    const card = syntheticCard();
    card.data.name = 'VWD动态说明验收';
    const stat = {
        状态: { 生命: 100, 金币: 10 },
        背包: ['钥匙', 0, false, null],
        好感系统: { 甲称呼: ['小甲', '当前称呼'], 乙称呼: ['小乙', '当前称呼'], 描述: ['暂无', ''], 数字: [3, '数字说明'] },
        配对记录: { 甲: { 数值: [1, '数值说明'], 开关: [false, '开关说明'], 称呼: ['甲', '称呼说明'] } },
    };
    card.data.first_mes = '<initvar>' + JSON.stringify(stat) + '</initvar>\nVWD 动态说明公开测试开场。';
    card.data.alternate_greetings = [];
    card.data.character_book.entries[0].content = JSON.stringify(stat);
    card.data.character_book.entries.push({
        id: 3, comment: '变量更新规则', enabled: true, constant: true, keys: [], insertion_order: 102,
        content: '变量更新规则:\n  好感系统:\n    type: |-\n      { 甲称呼: string; 乙称呼: string; 描述: string; 数字: number; }\n  配对记录:\n    type: |-\n      { [键名: string]: { 数值: number; 开关: boolean; 称呼: string; } }',
    });
    return card;
};
