'use strict';
const syntheticCard = require('./synthetic-card');

// 相同物品/效果名属于不同来源；日志的来源内索引与整表行号不同。
module.exports = function promptGuidanceCard() {
    const card = syntheticCard();
    card.data.name = '特殊操作提示验收';
    const record = name => ({ 好感: 1, 背包: { 药: { 数量: 2, 效果: { 疗愈: { 描述: name + '效果' } } } },
        日志: [name + '日志0', name + '日志1', name + '日志2'] });
    const stat = { 状态: { 生命: 100, 金币: 10 }, 背包: ['钥匙', 0, false, null], 关系: { 甲: record('甲'), 乙: record('乙') } };
    card.data.first_mes = '<initvar>' + JSON.stringify(stat) + '</initvar>公开测试开场。';
    card.data.alternate_greetings = [];
    card.data.character_book.entries[0].content = JSON.stringify(stat);
    card.data.character_book.entries.push({ id: 3, comment: '变量更新规则', enabled: true, constant: true, keys: [], insertion_order: 102,
        content: '变量更新规则:\n  关系:\n    type: |-\n      { [名称: string]: { 好感: number; 背包: { [物品: string]: { 数量: number; 效果: { [效果: string]: { 描述: string; } }; } }; 日志: string[]; } }' });
    return card;
};
