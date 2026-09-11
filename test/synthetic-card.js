'use strict';

// 公开合成夹具，不依赖私人角色卡；同时用于 Node 回归和隔离酒馆验收。
module.exports = function syntheticCard() {
    return {
        spec: 'chara_card_v3', spec_version: '3.0',
        data: {
            name: 'MVU数据库公开验收卡', description: '转换器自动化测试用合成角色卡。',
            personality: '', scenario: '', mes_example: '', creator_notes: '',
            first_mes: '<initvar>{"状态":{"生命":100,"金币":10},"背包":["钥匙",0,false,null]}</initvar>\n测试开场。',
            alternate_greetings: ['<initvar>{"状态":{"生命":80,"金币":20},"背包":[]}</initvar>\n第二开场。'],
            character_book: { name: '公开验收规则', entries: [
                { id: 1, comment: '[InitVar]', content: '状态: {生命: 100, 金币: 10}\n背包: [钥匙, 0, false, null]', enabled: true, constant: true, keys: [], insertion_order: 100 },
                { id: 2, comment: '变量展示', content: '<%= getvar("stat_data.状态.金币") %>', enabled: true, constant: true, keys: [], insertion_order: 101 },
            ] },
            extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
        },
    };
};
