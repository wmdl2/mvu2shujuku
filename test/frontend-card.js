'use strict';
// 两张选中表与一张对照表；与普通两表运行时夹具分开。
module.exports = function frontendCard() {
    const card = require('./synthetic-card')();
    const initial = { 状态: { 生命: 100, 金币: 10 }, 背包: ['钥匙', 0, false, null], 行程: { 日期: '第1天', 地点: '起点' } };
    card.data.name += '_界面';
    card.data.first_mes = '<initvar>' + JSON.stringify(initial) + '</initvar>\n测试开场。';
    card.data.alternate_greetings = [];
    card.data.character_book.entries[0].content = JSON.stringify(initial);
    return card;
};
