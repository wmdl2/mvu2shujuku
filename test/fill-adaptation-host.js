'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const core = require('../src/mvu2shujuku');
const oldFormat = '<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>';
function fixture() {
    const card = require('./synthetic-card')();
    card.data.name = '统一填表适配公开验收';
    card.data.character_book.name = '统一填表适配公开规则';
    card.data.character_book.entries.push(
        { id: 99, keys: [], enabled: true, constant: true, comment: '[mvu_update]结算要求', insertion_order: 102,
            content: '<% globalThis.__m2sjkFillExecutions=(globalThis.__m2sjkFillExecutions||0)+1; const roll=Math.random(); %>\nFILL_REQUIREMENT_CANARY\n用JSONPatch将当前金币改为42，冻结时禁止修改；保留当前其他状态。\n随机检定：<%= roll %>' },
        { id: 100, keys: [], enabled: true, constant: true, comment: '[mvu_update]变量输出格式', insertion_order: 103,
            content: '<Format>\n变量输出格式:\n  hint: FORMAT_BUSINESS_CANARY 冻结时不能修改金币\n  format: |-\n    ' + oldFormat + '\n</Format>' },
        { id: 101, keys: [], enabled: true, constant: true, comment: '公开场景', insertion_order: 104, content: 'BODY_REQUIREMENT_CANARY 继续公开测试剧情。' },
        { id: 102, keys: [], enabled: true, constant: true, comment: '[mvu_update]格式槽中的业务', insertion_order: 105,
            content: '变量输出格式:\n  format: |-\n    <UpdateVariable><Analysis>ANALYSIS_BUSINESS_CANARY 冻结时保留金币原值与阈值。</Analysis><JSONPatch>[{"op":"replace","path":"${/path/to/variable}","value":"${new_value}"}]</JSONPatch></UpdateVariable>' },
    );
    return card;
}
function preflight() {
    const source = fixture(), result = core.convert(source), d = result.card.data;
    assert.deepStrictEqual(core.statDataFromTables(JSON.parse(d.extensions.mvu2shujuku.layout), result.template).stat_data,
        { 状态: { 生命: 100, 金币: 10 }, 背包: ['钥匙', 0, false, null] });
    for (const id of [99, 100, 101, 102]) assert.strictEqual(d.character_book.entries.find(e => e.id === id).content, source.data.character_book.entries.find(e => e.id === id).content);
    const prompt = d.character_book.entries.filter(e => e.enabled !== false).map(e => e.content).join('\n\n');
    const view = core.prepareFillPrompt(prompt, result.card);
    assert(view.adapted && !view.text.includes(oldFormat));
    assert(view.text.includes('FORMAT_BUSINESS_CANARY'));
    assert.strictEqual(view.text.split(core.fillAdaptationGuidance()).length - 1, 1);
    return { source, result };
}
module.exports = async function fillAdaptationHost({ page, runtimeTest, setStorageMode, assertStorageMode, openState, waitCommittedGold, record, work }) {
    const { source } = preflight();
    const saved = path.join(work, 'state.json');
    const state = process.env.MVU_FILL_ADAPTATION_REUSE_STATE === '1' ? JSON.parse(fs.readFileSync(saved)) : await runtimeTest(page, source);
    assert(state.avatar.startsWith('统一填表适配公开验收_数据库'), '复用的夹具身份须匹配');
    await openState(page, state);
    const bookProof = await page.evaluate(async () => {
        const ctx = SillyTavern.getContext(), card = ctx.characters[ctx.characterId];
        const bindingBefore = TavernHelper.getCharWorldbookNames('current');
        await TavernHelper.rebindCharWorldbooks('current', { primary: card.data.character_book.name, additional: [] });
        const world = await import('/scripts/world-info.js'), raw = await world.loadWorldInfo(card.data.character_book.name);
        return { world: card.data.character_book.name, bindingBefore, bindingAfter: TavernHelper.getCharWorldbookNames('current'), entries: Object.values(raw.entries).map(e => ({ uid: e.uid, content: e.content, comment: e.comment, enabled: !e.disable })) };
    });
    assert.strictEqual(bookProof.bindingAfter.primary, bookProof.world);
    assert(bookProof.entries.some(e => e.content.includes(oldFormat)), '宿主保存的源书保持原格式');
    assert(bookProof.entries.some(e => e.comment === '[M2SJK]填表适配说明' && e.enabled));
    fs.writeFileSync(path.join(work, 'fill-adaptation-worldbook.json'), JSON.stringify(bookProof, null, 2));
    const requests = []; let routeFailure = null, kind = 'body', mode = 'native';
    const pattern = '**/api/backends/chat-completions/generate';
    await page.route(pattern, async route => {
        try {
            const request = route.request().postDataJSON(), text = request.messages.map(m => String(m.content || '')).join('\n');
            const requestKind = text.includes(core.fillAdaptationGuidance()) ? 'fill' : 'body';
            requests.push({ kind: requestKind, mode, request });
            fs.writeFileSync(path.join(work, 'fill-adaptation-requests.json'), JSON.stringify(requests, null, 2));
            let content = '公开测试正文。金币需要改为42。';
            if (requestKind === 'fill') {
                assert(text.includes('FILL_REQUIREMENT_CANARY'));
                assert(text.includes('FORMAT_BUSINESS_CANARY'));
                assert(text.includes('ANALYSIS_BUSINESS_CANARY 冻结时保留金币原值与阈值。'));
                assert(!text.includes('<Analysis>ANALYSIS_BUSINESS_CANARY'));
                assert(text.includes('用JSONPatch将当前金币改为42，冻结时禁止修改'));
                assert(!text.includes(oldFormat));
                assert.strictEqual(text.split(core.fillAdaptationGuidance()).length - 1, 1);
                assert(!text.includes('mvu2shujuku:fill-adaptation:v1'));
                assert(!text.includes('<%'));
                let command;
                if (mode === 'sqlite') {
                    const gold = text.match(/^\s*(\w+)\s+[^\n]*-- 金币/m); assert(gold);
                    const names = [...text.slice(0, gold.index).matchAll(/CREATE TABLE\s+([^\s(]+)/g)]; assert(names.length);
                    command = 'UPDATE ' + names.at(-1)[1] + ' SET ' + gold[1] + ' = 42 WHERE row_id = 1;';
                } else {
                    const table = text.match(/\[(\d+):状态表\][\s\S]*?Columns:\s*([^\n]+)/);
                    const gold = table && table[2].match(/\[(\d+):金币\]/); assert(gold);
                    command = 'updateRow(' + table[1] + ',0,' + JSON.stringify({ [gold[1]]: 42 }) + ');';
                }
                content = '<thought>' + '公开固定响应，按宿主协议更新金币，不改变其他字段。'.repeat(40) + '</thought><content><tableEdit>\n' + command + '\n</tableEdit></content>';
            }
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'fill-adaptation-fixture', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }) });
        } catch (error) { routeFailure = error; await route.abort(); }
    });
    try {
        for (mode of ['native', 'sqlite']) {
            await setStorageMode(page, mode); await require('./host-auto-update')(page, false); await assertStorageMode(page, mode); await openState(page, state);
            await page.evaluate(async () => {
                const st = await import('/script.js'), oa = await import('/scripts/openai.js'), ctx = SillyTavern.getContext();
                oa.oai_settings.chat_completion_source = 'custom'; oa.oai_settings.custom_url = location.origin + '/fixture';
                oa.oai_settings.custom_model = 'isolated-fixture'; oa.oai_settings.stream_openai = false;
                st.changeMainAPI('openai'); st.setOnlineStatus('isolated-fixture');
                const ns = ctx.extensionSettings.__userscripts.shujuku_v120__userscript_settings_v1, key = 'shujuku_v120_globalMeta_v1';
                const meta = JSON.parse(ns[key]); meta.plotEnabledGlobal = false; ns[key] = JSON.stringify(meta); await st.saveSettings();
                globalThis.__m2sjkFillExecutions = 0;
            });
            const close = page.locator('#acu-app-v2 .acu-v2-app__close');
            if (await close.isVisible()) await close.click();
            await page.evaluate(() => AutoCardUpdaterAPI.setUpdateConfigParams({
                autoUpdateThreshold: 3, autoUpdateFrequency: 1, updateBatchSize: 10, autoUpdateTokenThreshold: 0,
            }));
            const initialStat = await page.evaluate(() => Mvu.getMvuData().stat_data);
            await page.evaluate(() => {
                globalThis.__m2sjkFillExecutions = 0;
                globalThis.__m2sjkEvalAudit = [];
                const original = EjsTemplate.evalTemplate;
                const audit = async function (...args) {
                    const ctx = SillyTavern.getContext(), ch = ctx.characters[ctx.characterId], data = ch.data || ch;
                    const marker = 'mvu2shujuku:fill-adaptation:v1', code = String(args[0] || ''), index = code.indexOf(marker);
                    const view = MVU2SHUJUKU_CORE.prepareFillPrompt(code, ch);
                    const record = { marker: index >= 0, adapted: view.adapted, bridge: !!original.__mvu2shujukuContextBridge, version: data.extensions?.mvu2shujuku?.fillAdapterVersion,
                        context: args[1] == null ? 'absent' : typeof args[1], viewClean: !view.text.includes('<Analysis>ANALYSIS_BUSINESS_CANARY') };
                    globalThis.__m2sjkEvalAudit.push(record);
                    try { return await original.apply(this, args); } catch (error) { record.error = String(error.stack || error).slice(0, 500); throw error; }
                };
                Object.assign(audit, original); EjsTemplate.evalTemplate = audit;
            });
            await require('./host-auto-update')(page, true);
            kind = 'body'; const before = requests.length;
            await page.locator('#send_textarea').fill('请继续公开测试剧情。');
            const sent = page.waitForRequest(pattern); await page.locator('#send_but').click(); await sent;
            await page.waitForFunction(() => SillyTavern.getContext().chat.some(m => m.mes === '公开测试正文。金币需要改为42。'), {}, { timeout: 60000 });
            if (routeFailure) throw routeFailure;
            const body = requests.slice(before).find(r => r.kind === 'body'); assert(body);
            const bodyText = body.request.messages.map(m => m.content || '').join('\n');
            assert(bodyText.includes('BODY_REQUIREMENT_CANARY'));
            assert(!bodyText.includes('FILL_REQUIREMENT_CANARY') && !bodyText.includes('FORMAT_BUSINESS_CANARY'));
            assert(!bodyText.includes(core.fillAdaptationGuidance()));
            record('fill-adaptation-body', { mode, noUpdateExecution: true, noGuide: true });
            kind = 'fill';
            await waitCommittedGold(page, 42);
            fs.writeFileSync(path.join(work, 'fill-adaptation-ejs-audit.json'), JSON.stringify(await page.evaluate(() => globalThis.__m2sjkEvalAudit), null, 2));
            if (routeFailure) throw routeFailure;
            assert.strictEqual(await page.evaluate(() => globalThis.__m2sjkFillExecutions || 0), 1);
            const expectedStat = structuredClone(initialStat); expectedStat.状态.金币 = 42;
            assert.deepStrictEqual(await page.evaluate(() => Mvu.getMvuData().stat_data), expectedStat,
                '增量填表仅改变目标字段，保留背包与其他字段');
            record('fill-adaptation-request-write', { mode, guideCount: 1, oldFormatExcluded: true, sourcePreserved: true, executions: result.executions, gold: 42 });
            await page.reload({ waitUntil: 'domcontentloaded' }); await openState(page, state); await waitCommittedGold(page, 42);
            await assertStorageMode(page, mode, '适配写入重载');
            assert.deepStrictEqual(await page.evaluate(() => Mvu.getMvuData().stat_data), expectedStat,
                '刷新后完整状态保持一致');
            record('fill-adaptation-reload', { mode, gold: 42, fullStatePreserved: true });
            await require('./host-auto-update')(page, false);
            await verifyVariables(page, waitCommittedGold, record, mode);
        }
    } finally { await page.unroute(pattern); await setStorageMode(page, 'native'); }
};
module.exports.preflight = preflight;

async function verifyVariables(page, waitCommittedGold, record, mode) {
    const variableResult = await page.evaluate(async () => {
                const render = text => EjsTemplate.evalTemplate(text);
                const path = 'stat_data.状态.金币';
                const roleResults = JSON.parse(await render(`<%
                    const chat = SillyTavern.chat;
                    const marker = '__mvu2shujuku_role_probe';
                    const roleResults = [];
                    try {
                        for (let i=0;i<chat.length;i++) setMessageVar(marker,i,{withMsg:{id:i}});
                        for (const role of ['user','assistant','system','any']) roleResults.push({
                            role, id:getMessageVar(marker,{withMsg:{role}}),
                            actual:getMessageVar('stat_data.状态.金币',{withMsg:{role}})
                        });
                    } finally {
                        for (let i=0;i<chat.length;i++) setMessageVar(marker,undefined,{withMsg:{id:i}});
                    }
                %><%= JSON.stringify(roleResults) %>`));
                const roleParity = roleResults.every(({id,actual}) => {
                    const expected = id == null ? undefined : Mvu.getMvuData({type:'message',message_id:id}).stat_data?.状态?.金币;
                    return actual === undefined ? expected === undefined : Number(actual)===Number(expected);
                });
                if (!roleParity) throw new Error('消息角色对照失败：'+JSON.stringify({roleResults,chat:SillyTavern.getContext().chat.map(m=>({user:m.is_user,system:m.is_system,frames:Object.keys(m.TavernDB_ACU_IsolatedData||{})}))}));
                const dynamic = Number(await render('<% const field="金币"; setMessageVar("stat_data.状态."+field,43); %><%= getvar("stat_data.状态."+field) %>'));
                const old = Number(await render('<%= setvar("stat_data.状态.金币",44,{results:"old"}) %>'));
                const gated = await render('<%= typeof setvar("stat_data.状态.金币",99,{flags:"nx"}) %>');
                const variablesView = Number(await render('<% const root="stat_"+"data"; %><%= variables[root].状态.金币 %>'));
                const history = Number(await render('<%= getMessageVar("stat_data.状态.金币",{withMsg:{id:0},defaults:-1}) %>'));
                const historyMvu = Number(Mvu.getMvuData({type:'message',message_id:0}).stat_data.状态.金币);
                const rejected = await render('<% let result=""; try { setMessageVar("stat_data.状态.金币",49,{withMsg:{id:0}}); } catch(e) { result=e.code; } %><%= result %>');
                const cached = Number(await render('<% setvar("stat_data.状态.金币",88,{scope:"cache"}); setMessageVar("stat_data.状态.生命",99); %><%= getvar("stat_data.状态.金币") %>'));
                const savedView = Mvu.getMvuData().stat_data.状态;
                const cacheIsolation = savedView.金币 === 44 && savedView.生命 === 99;
                await render('<% setMessageVar("stat_data.状态.生命",100); %>');
                const current = Number(await render('<%= getMessageVar("stat_data.状态.金币",{noCache:true}) %>'));
                const increment = Number(await render('<%= incMessageVar("stat_data.状态.金币",1,{max:45}) %>'));
                await render('<% setvar("stat_data.状态.金币",42); %>');
                return {dynamic,old,gated,variablesView,history,historyMvu,rejected,cached,current,increment,roleParity,cacheIsolation};
            });
            assert.deepStrictEqual(variableResult, {dynamic:43,old:43,gated:'undefined',variablesView:44,history:10,historyMvu:10,
                rejected:'MVU_HISTORY_WRITE_UNSUPPORTED',cached:88,current:44,increment:45,roleParity:true,cacheIsolation:true});
            await waitCommittedGold(page,42);
            record('runtime-variable-adapter', {mode,...variableResult});
}
module.exports.verifyVariables = verifyVariables;
