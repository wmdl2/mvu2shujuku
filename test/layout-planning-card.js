'use strict';
const core = require('../src/mvu2shujuku');
module.exports = function layoutPlanningCard() {
    const source = require('./synthetic-card')();
    const initial = core.parseInitVar(source.data.character_book.entries[0].content);
    initial.平台 = { 甲: { 昵称: '甲', 数量: 1.5, 评论: { 同名: '甲评' } },
        乙: { 昵称: '乙', 数量: 2.5, 评论: { 同名: '乙评' } },
        丙: { 昵称: '丙', 数量: 3.5, 评论: { 同名: '丙评' } } };
    initial.角色 = { 甲: { 姓名: '同名', 属性: { 数值: 1.5, 复杂: null }, 数组: ['甲', '甲'], 字典: { 同键: { 数量: 1.5, $缓存: '甲私有' } } },
        乙: { 姓名: '同名', 属性: { 数值: 2.5, 复杂: null }, 数组: ['乙'], 字典: { 同键: { 数量: 2.5, $缓存: '乙私有' } } } };
    const platform = 'z.object({昵称:z.string(),数量:z.number(),评论:z.record(z.string(),z.string())})';
    const role = 'z.record(z.string(),z.object({姓名:z.string(),属性:z.object({数值:z.number(),复杂:z.object({数量:z.number()}).nullable()}),数组:z.array(z.string()),字典:z.record(z.string(),z.object({数量:z.number(),$缓存:z.string()}))}))';
    const fields = Object.keys(initial).map(key => JSON.stringify(key) + ':' + (key === '平台'
        ? 'z.object({甲:' + platform + ',乙:' + platform + ',丙:' + platform + '})' : key === '角色' ? role : 'z.any()'));
    source.data.name = '公开布局规划验收';
    source.data.character_book.entries[0].content = JSON.stringify(initial);
    source.data.first_mes = '<initvar>' + JSON.stringify(initial) + '</initvar>公开测试。';
    source.data.alternate_greetings = [];
    source.data.extensions.tavern_helper.scripts.push({ name: '结构', enabled: true,
        content: 'const S=z.object({' + fields.join(',') + '});registerMvuSchema(S);' });
    return source;
};
