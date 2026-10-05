#!/usr/bin/env node
'use strict';
// Upstream component audit, not Android/WebView or full database acceptance.
// Executes reference implementations; assertions document both controls and risks.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const crypto = require('crypto');
const root = path.resolve(__dirname, '..');
const refs = path.resolve(root, '../参考资料');
const ts = require(path.join(refs, 'SillyTavern/node_modules/typescript'));
const lodash = require(path.join(refs, 'SillyTavern/node_modules/lodash'));
const inputs = {}, observations = [];
const clone = x => JSON.parse(JSON.stringify(x));
function source(file) {
    const text = fs.readFileSync(file, 'utf8');
    inputs[path.relative(refs, file)] = crypto.createHash('sha256').update(text).digest('hex');
    return text;
}
function load(relative, dependencies, globals = {}) {
    const file = path.join(refs, relative);
    const compiled = ts.transpileModule(source(file), { compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    }}).outputText;
    const module = { exports: {} };
    vm.runInNewContext(compiled, { module, exports: module.exports,
        require(name) {
            if (!Object.hasOwn(dependencies, name)) throw new Error('Unspecified fixture dependency: ' + name);
            return dependencies[name];
        }, console, ...globals }, { filename: file });
    return module.exports;
}
function clock() {
    let now = 100000, id = 0;
    const timers = new Map();
    const drain = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
    return {
        Date: class extends Date { static now() { return now; } },
        setTimeout(fn, delay = 0) { timers.set(++id, { fn, at: now + delay }); return id; },
        clearTimeout(key) { timers.delete(key); },
        async advance(ms) {
            const end = now + ms;
            await drain();
            for (;;) {
                const next = [...timers].filter(([, x]) => x.at <= end).sort((a,b) => a[1].at - b[1].at)[0];
                if (!next) break;
                now = next[1].at; timers.delete(next[0]); next[1].fn(); await drain();
            }
            now = end; await drain();
        }, drain,
    };
}
const quiet = { logDebug_ACU() {}, logWarn_ACU() {}, logError_ACU() {} };
function guard(chat, { failSave = false } = {}) {
    const listeners = [];
    let saves = 0;
    const api = load('shujuku/src/service/chat/checkpoint-delete-guard.ts', {
        '../../data/gateways/chat-gateway': {
            getChatArray_ACU: () => chat,
            registerPostChatSaveListener_ACU: fn => listeners.push(fn),
            saveChatToHostStrict_ACU: async () => {
                if (failSave) throw new Error('fixture save failure');
                saves++; listeners.forEach(fn => fn());
            },
        },
        '../../data/repositories/chat-message-data-repo': {
            readIsolatedDataContainer_ACU: m => m?.TavernDB_ACU_IsolatedData || null,
            readIsolatedTagData_ACU: (m,k) => m?.TavernDB_ACU_IsolatedData?.[k] || null,
        },
        '../table/storage-strategy-resolver': { isV2TagData_ACU: t => t?.storageFrame?.version === 2 && Array.isArray(t.storageFrame.logEntries) },
        '../table/storage-frame-v2-persist': { assertSingleActiveFullCheckpointV2_ACU: (rows,k) =>
            rows.filter(m => m?.TavernDB_ACU_IsolatedData?.[k]?.storageFrame?.checkpoint?.kind === 'full').length > 1 ? 'multiple roots' : null },
        './material-checkpoint-sync': {
            captureMaterialCheckpointRecovery_ACU: () => null,
            snapshotMaterialCheckpointFields_ACU: () => [], restoreMaterialCheckpointFields_ACU() {},
            assertMaterialContinuationCheckpoint_ACU: () => null, assertMaterialSimulationCheckpoint_ACU: () => null,
            graftMaterialContinuationCheckpoint_ACU: () => false, graftMaterialSimulationCheckpoint_ACU: () => false,
        },
        '../table/table-write-transaction': { runTableWriteTransaction_ACU: async (_, task) => task() },
        '../runtime/state-manager': { currentChatFileIdentifier_ACU: 'audit', getCurrentIsolationKey_ACU: () => '' },
        '../../shared/utils': quiet,
    });
    api.installCheckpointDeleteGuard_ACU();
    api.captureCheckpointVaultForCurrentChat_ACU();
    return { api, postSave: () => listeners.forEach(fn => fn()), saves: () => saves };
}
const checkpoint = value => ({ kind: 'full', createdAt: 1000, reason: 'compaction',
    data: { sheet_0: { name: '物品表', content: [['row_id','物品名'],['1',value]] } } });
const ai = (mes, cp, logs = [], key = '') => ({ is_user: false, mes,
    TavernDB_ACU_IsolatedData: { [key]: { _acu_storage_version: 2,
        storageFrame: { version: 2, ...(cp ? { checkpoint: cp } : {}), logEntries: logs } } } });
const frame = (m,key = '') => m.TavernDB_ACU_IsolatedData[key].storageFrame;
function scheduler(options = {}) {
    const time = options.time || clock(), calls = [];
    const state = { chatMutationDebounceTimer_ACU: null, currentChatFileIdentifier_ACU: 'audit',
        getCurrentIsolationKey_ACU: () => '', _set_chatMutationDebounceTimer_ACU: value => { state.chatMutationDebounceTimer_ACU = value; } };
    const api = load('shujuku/src/presentation/bootstrap/chat-mutation-scheduler.ts', {
        '../../service/runtime/state-manager': state,
        '../../service/chat/checkpoint-delete-guard': { recoverLostCheckpointsAfterMessageDeletion_ACU: async () => { calls.push('recover'); return options.recover?.(); } },
        '../../service/table/table-storage-strategy': { reloadStorageProvider: async () => { calls.push('reload'); if (options.failReload) throw new Error('fixture reload failure'); } },
        '../../service/table/storage-mode': { isSqliteMode: () => !!options.sqlite },
        '../components/pipeline-ui-helpers': { refreshMergedDataAndNotifyWithUI_ACU: async () => { calls.push('refresh'); return options.refresh?.(); } },
        '../../service/vector/summary-vector-index-archive-service': { findSummaryTable_ACU: () => null, buildSummaryVectorIndexArchiveScopeKey_ACU() {} },
        '../../service/vector/summary-vector-index-realign-state': { markSummaryVectorIndexDirtyForRealign_ACU() {} },
        '../../service/vector/summary-vector-index-flush-queue': { enqueueSummaryVectorIndexFlush_ACU() {} },
        '../../service/vector/summary-vector-mirror-rebuild': { chatHasSummaryVectorMirror_ACU: () => false },
        '../../service/vector/summary-vector-index-chat-deletion-gc': { runScopedRetentionGcAfterFlush_ACU() {} },
        '../../service/chat/chat-service': { getChatArray_ACU: () => [] },
        '../../data/storage/chat-history': { getActiveChatStorageIdentity_ACU: () => null },
        '../../service/continuation/agent/agent-run-cache': { clearAgentRunState_ACU() {} },
        '../../service/simulation/agent/agent-run-cache': { clearWorldSimulationRunState_ACU() {} },
        '../../service/fill-mode/fill-mode-gate': { isVectorPipelineEnabledForCurrentChat_ACU: () => false },
        '../../shared/utils': quiet,
    }, time);
    return { api, time, calls };
}
async function check(name, task) { const detail = await task(); observations.push({ name, ...detail }); }
async function convertedRuntime() {
    // Reuse the public runtime fixture; it assembles and executes the product bundle.
    const file=path.join(root,'test/runtime-native.js'),text=source(file);
    const ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    const declaration=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='nativeRuntime');
    assert.ok(declaration);
    const {core,applyingApi}=require('./helpers');
    const requireFromTest=require('module').createRequire(file);
    const fn=vm.runInNewContext(`(${declaration.getText(ast)})`,{
        require:requireFromTest,core,applyingApi,clone,vm,fs,assert,console,
        TextDecoder,TextEncoder,Uint8Array,Blob,Buffer,
    });
    return fn(undefined,({context})=>{context.event_types={MESSAGE_DELETED:'deleted'};});
}
async function auditExternalReroll() {
    const file=process.env.MVU_REROLL_SCRIPT_JSON;
    if(!file)return;
    const bytes=fs.readFileSync(file),text=JSON.parse(bytes.toString('utf8')).content;
    inputs['external-reroll-script-json']=crypto.createHash('sha256').update(bytes).digest('hex');
    const ast=ts.createSourceFile('external-reroll.js',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    const names=['determineOperationMode','waitForChatLength','doNativeRegenerate','doCustomReroll'],functions={};
    function visit(node){if(ts.isFunctionDeclaration(node)&&names.includes(node.name?.text))functions[node.name.text]=node.getText(ast);ts.forEachChild(node,visit);}
    visit(ast);for(const name of names)assert.ok(functions[name],name);
    const hostFile=path.join(refs,'TauriTavern/src/script.js'),hostText=source(hostFile);
    const hostAst=ts.createSourceFile(hostFile,hostText,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    const hostDelete=hostAst.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='deleteMessage').getText(hostAst).replace(/^export /,'');
    function fixture({tailUser=false,nativeButton=true,slowReplay=false}={}){
        const time=clock(),chat=[ai('root',checkpoint('剑')),{is_user:true,mes:'重新推进'}];
        if(!tailUser)chat.push(ai('reply',null));
        const events=[],actions=[];let input='',replayDone=false;
        const s=scheduler({time,refresh:async()=>{
            if(slowReplay)await new Promise(resolve=>time.setTimeout(resolve,1400));
            replayDone=true;
        }});
        function $(selector){
            const element={length:selector==='#option_regenerate'&&!nativeButton?0:1,0:{scrollHeight:32},
                val(value){if(value===undefined)return input;input=value;return this;},css(){return this;},blur(){return this;},
                first(){return this;},find(){return this;},filter(){this.length=0;return this;},text(){return '';},
                trigger(name){if(selector==='#send_but')actions.push({action:name,at:time.Date.now(),replayDone});return this;},
                click(){actions.push({action:selector==='#option_regenerate'?'native-button':'send',at:time.Date.now(),replayDone});return this;}};
            return element;
        }
        const host={chat,generate:type=>actions.push({action:'api-'+type}),deleteLastMessage:async()=>context.deleteMessage(chat.length-1)};
        const win={$,SillyTavern:{getContext:()=>host},toastr:null};win.parent=win;
        const context=vm.createContext({window:win,...time,chat,chat_metadata:{},this_edit_mes_id:undefined,
            BUTTON_ID:'reroll',isBusy:false,globalSettings:{showToasts:false,planIntercept:false},
            currentCache:{index:1,text:'重新推进'},log(){},warn(){},unlockUI(){},setBusyState(){},triggerShake(){},
            isUserEditing:()=>false,isAiGenerating:()=>false,loadCache(){},
            deleteItemizedPromptForMessage(){},updateViewMessageIds(){},saveChatDebounced(){},cleanupDeletedMessageStates(){},refreshActiveSwipeButtons(){},
            event_types:{MESSAGE_DELETED:'deleted'},eventSource:{emit:async(name,length)=>{
                events.push([name,length]);s.api.scheduleChatMutationRefresh_ACU('chat_modified_deleted');
            }}});
        vm.runInContext(hostDelete+'\n'+names.map(name=>functions[name]).join('\n'),context);
        return {context,time,chat,events,actions,input:()=>input,replayDone:()=>replayDone};
    }
    for(const nativeButton of [true,false])await check(`external script: native mode delegates via ${nativeButton?'host button':'host generate API'}`,async()=>{
        const h=fixture({nativeButton});h.context.doNativeRegenerate();
        assert.equal(h.actions[0].action,nativeButton?'native-button':'api-regenerate');assert.equal(h.events.length,0);
        return { delegatedVia:h.actions[0].action,scriptDirectDeletes:0 };
    });
    for(const tailUser of [true,false])await check(`external script: full mode deletes ${tailUser?1:2} floors and sends after 1300ms`,async()=>{
        const h=fixture({tailUser});await h.context.doCustomReroll(true);assert.equal(h.chat.length,1);
        assert.equal(h.events.length,tailUser?1:2);assert.equal(h.input(),'重新推进');
        await h.time.advance(1299);assert.equal(h.actions.length,0);await h.time.advance(1);
        assert.equal(h.actions.at(-1).action,'send');assert.equal(h.replayDone(),true);
        return {deleteEvents:h.events.length,sendDelayMs:1300,replayDoneAtSend:true};
    });
    await check('external script: edit mode deletes two floors and leaves input unsent',async()=>{
        const h=fixture();await h.context.doCustomReroll(false);await h.time.advance(4000);
        assert.equal(h.chat.length,1);assert.equal(h.events.length,2);assert.equal(h.actions.length,0);assert.equal(h.input(),'重新推进');
        return {deleteEvents:2,automaticSend:false};
    });
    await check('external script risk: 1300ms auto-send is not a replay completion barrier',async()=>{
        const h=fixture({slowReplay:true});await h.context.doCustomReroll(true);await h.time.advance(1300);
        assert.equal(h.actions.at(-1).action,'send');assert.equal(h.actions.at(-1).replayDone,false);
        await h.time.advance(1400);assert.equal(h.replayDone(),true);
        return {sendBeforeReplayComplete:true,mockedRefreshDurationMs:1400};
    });
}
async function main() {
    await check('control: deleting log-only reply retains earlier root without recovery', async () => {
        const chat = [ai('root',checkpoint('剑')), ai('reply',null,[{seq:1,operations:[]}])], h = guard(chat);
        chat.pop(); const out = await h.api.recoverLostCheckpointsAfterMessageDeletion_ACU();
        assert.equal(out.recovered,false); assert.equal(h.saves(),0); assert.equal(frame(chat[0]).checkpoint.data.sheet_0.content[1][1],'剑');
        return { recovered: false };
    });
    await check('control: deleted root is grafted to surviving successor', async () => {
        const chat = [ai('root',checkpoint('剑')), ai('later',null,[{seq:1,operations:[]}])], h = guard(chat);
        chat.shift(); const out = await h.api.recoverLostCheckpointsAfterMessageDeletion_ACU();
        assert.equal(out.recovered,true); assert.equal(frame(chat[0]).logEntries.length,1); assert.equal(h.saves(),1);
        return { recovered: true };
    });
    await check('risk: deleted final full checkpoint moves backwards and keeps its data', async () => {
        const chat = [ai('earlier',null,[{seq:1,operations:[]}]),ai('root',checkpoint('新剑'))], h = guard(chat);
        chat.pop(); const out = await h.api.recoverLostCheckpointsAfterMessageDeletion_ACU();
        assert.equal(out.recovered,true); assert.equal(frame(chat[0]).logEntries.length,0);
        assert.equal(frame(chat[0]).checkpoint.data.sheet_0.content[1][1],'新剑');
        return { preservedDeletedCheckpointValue: '新剑', earlierLogsCleared: true };
    });
    await check('risk: save during deletion debounce replaces vault before root recovery', async () => {
        const chat = [ai('root',checkpoint('剑')),ai('later',null)], h = guard(chat);
        chat.shift(); const s = scheduler({recover: () => h.api.recoverLostCheckpointsAfterMessageDeletion_ACU()});
        s.api.scheduleChatMutationRefresh_ACU('chat_modified_deleted');
        await s.time.advance(300); h.postSave(); await s.time.advance(1000);
        assert.ok(s.calls.includes('recover')); assert.equal(frame(chat[0]).checkpoint,undefined); assert.equal(h.saves(),0);
        return { rootRecoverySkippedAfterPostSave: true };
    });
    await check('control: failed graft save restores survivor fields', async () => {
        const chat = [ai('root',checkpoint('剑')),ai('later',null)], h = guard(chat,{failSave:true});
        chat.shift(); const before = JSON.stringify(chat); const out = await h.api.recoverLostCheckpointsAfterMessageDeletion_ACU();
        assert.equal(out.recovered,false); assert.ok(out.error); assert.equal(JSON.stringify(chat),before);
        return { rollbackOfFailedRecovery: true };
    });
    await check('control: isolation keys are recovered independently', async () => {
        const rootMessage = ai('root',checkpoint('剑'));
        rootMessage.TavernDB_ACU_IsolatedData.other = ai('other',checkpoint('盾'),[],'other').TavernDB_ACU_IsolatedData.other;
        const chat = [rootMessage,ai('later',null)], h = guard(chat);
        chat.shift(); await h.api.recoverLostCheckpointsAfterMessageDeletion_ACU();
        assert.equal(frame(chat[0]).checkpoint.data.sheet_0.content[1][1],'剑');
        assert.equal(frame(chat[0],'other').checkpoint.data.sheet_0.content[1][1],'盾');
        return { isolationKeys: 2 };
    });
    await check('control: deletion replay waits 1200 milliseconds', async () => {
        const s=scheduler(); s.api.scheduleChatMutationRefresh_ACU('chat_modified_deleted');
        await s.time.advance(1199); assert.equal(s.calls.length,0); await s.time.advance(1);
        assert.deepEqual(s.calls,['recover','refresh']); return { delayMs:1200 };
    });
    await check('control: repeated deletes coalesce into one replay round', async () => {
        const s=scheduler(); for(let i=0;i<5;i++){s.api.scheduleChatMutationRefresh_ACU('chat_modified_deleted');await s.time.advance(100);}
        await s.time.advance(1200); assert.deepEqual(s.calls,['recover','refresh']); return { replayRounds:1 };
    });
    await check('risk: swipe after deletion overwrites root recovery reason', async () => {
        const s=scheduler(); s.api.scheduleChatMutationRefresh_ACU('chat_modified_deleted');await s.time.advance(100);
        s.api.scheduleChatMutationRefresh_ACU('chat_modified_swiped');await s.time.advance(1200);
        assert.deepEqual(s.calls,['refresh']); return { recoveryCalls:0, refreshCalls:1 };
    });
    await check('control: deletion after swipe invokes root recovery', async () => {
        const s=scheduler(); s.api.scheduleChatMutationRefresh_ACU('chat_modified_swiped');await s.time.advance(100);
        s.api.scheduleChatMutationRefresh_ACU('chat_modified_deleted');await s.time.advance(1200);
        assert.deepEqual(s.calls,['recover','refresh']); return { recoveryCalls:1 };
    });
    await check('control: chat change cancels queued round', async () => {
        const s=scheduler();s.api.scheduleChatMutationRefresh_ACU('chat_modified_deleted');s.api.cancelPendingChatMutationRefresh_ACU();
        await s.time.advance(4000);assert.equal(s.calls.length,0);return { queuedRoundCancelled:true };
    });
    await check('observation: failed SQLite rebuild does not prevent UI refresh attempt', async () => {
        const s=scheduler({sqlite:true,failReload:true});s.api.scheduleChatMutationRefresh_ACU('chat_modified_deleted');await s.time.advance(1200);
        assert.deepEqual(s.calls,['recover','reload','refresh']);return { refreshAttemptAfterReloadFailure:true };
    });
    for (const [managed,refresh] of [[false,'none'],[false,'affected'],[true,'affected']]) {
        await check(`risk: helper deleteChatMessages managed=${managed} refresh=${refresh} emits no delete event`, async () => {
            const chat=[ai('root',checkpoint('剑')),ai('reply',null)],events=[],calls=[];
            const $=()=>({first(){return this;},last(){return this;},attr(){return '0';},remove(){return this;},removeClass(){return this;},addClass(){return this;}});
            const host={chat,event_types:{MESSAGE_DELETED:'deleted',USER_MESSAGE_RENDERED:'user_rendered',CHARACTER_MESSAGE_RENDERED:'ai_rendered'},
                eventSource:{emit:async (...args)=>events.push(args)},saveChatConditional:async()=>calls.push('save'),reloadCurrentChat:async()=>calls.push('reload')};
            const audit=load('JS-Slash-Runner/src/panel/optimize/better_message_to_load/index.ts',{
                '@sillytavern/script':host,'@sillytavern/scripts/power-user':{power_user:{chat_truncation:0}},
            },{_:lodash,$});
            const helper=load('JS-Slash-Runner/src/function/chat_message.ts',{
                '@/function/displayed_message':{refreshOneMessage:async()=>calls.push('render')},
                '@/panel/optimize/better_message_to_load':audit,
                '@/util/message':{inUnnormalizedMessageRange:id=>id>=0&&id<chat.length,normalizeMessageId:id=>id},
                '@/util/tavern':{saveChatConditionalDebounced:()=>calls.push('save_debounced')},
                '@/tauritavern_chat_surface':{usesManagedChatSurface:managed,refreshManagedChatSurface:async()=>calls.push('redisplay')},
                '@sillytavern/script':host,
            },{_:lodash,$,document:{querySelector:()=>null}});
            await helper.deleteChatMessages([1],{refresh});assert.equal(chat.length,1);assert.equal(events.length,0);
            return { deleteEvents:0, calls };
        });
    }
    await check('control: TT host deleteMessage emits deletion after splice',async()=>{
        const file=path.join(refs,'TauriTavern/src/script.js'),text=source(file),ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
        const declaration=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='deleteMessage');
        assert.ok(declaration);const body=declaration.getText(ast).replace(/^export /,'');
        const chat=[ai('root',checkpoint('剑')),ai('reply',null)],events=[];
        const fn=vm.runInNewContext(`(${body})`,{chat,chat_metadata:{},this_edit_mes_id:undefined,
            deleteItemizedPromptForMessage(){},updateViewMessageIds(){},saveChatDebounced(){},cleanupDeletedMessageStates(){},refreshActiveSwipeButtons(){},
            event_types:{MESSAGE_DELETED:'deleted'},eventSource:{emit:async(name,length)=>events.push([name,length,chat.length])}});
        await fn(1);assert.deepEqual(events,[['deleted',1,1]]);return { deleteEvents:1, remainingMessages:1 };
    });
    await check('regeneration: TT delete branch returns before delayed database replay',async()=>{
        const file=path.join(refs,'TauriTavern/src/script.js'),text=source(file),ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
        const generate=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='GenerateInternal');
        const deletionBranch=generate.body.statements.find(n=>ts.isIfStatement(n)&&n.getText(ast).includes('await deleteMessage(lastMessageId)'));
        const deleteFn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='deleteMessage');
        assert.ok(deletionBranch);assert.ok(deleteFn);
        const h=await convertedRuntime(),before=h.win.Mvu.getMvuData();
        const originalGold=before.stat_data.状态.金币;
        const {core}=require('./helpers');
        const layout=JSON.parse(h.context.characters[0].extensions.mvu2shujuku.layout);
        const old=clone(before.stat_data);old.状态.金币=42;
        await core.writeStatDiffToDb(h.api,layout,before.stat_data,old);
        for(const callback of h.tableCallbacks)await callback(clone(h.tables),{persisted:true});
        assert.equal(h.win.Mvu.getMvuData().stat_data.状态.金币,42,'fixture old reply must already be published');
        h.context.chat.push({is_user:true,mes:'user'},{is_user:false,mes:'old AI'});
        let readAfterRefresh;
        const s=scheduler({refresh:async()=>{
            const current=h.win.Mvu.getMvuData().stat_data;
            const rolledBack=clone(current);rolledBack.状态.金币=originalGold;
            await core.writeStatDiffToDb(h.api,layout,current,rolledBack);
            for(const callback of h.tableCallbacks)await callback(clone(h.tables),{persisted:true});
            readAfterRefresh=h.win.Mvu.getMvuData().stat_data.状态.金币;
        }});
        const globals={chat:h.context.chat,chat_metadata:{},type:'regenerate',isImpersonate:false,dryRun:false,depth:0,
            lastMessage:h.context.chat.at(-1),lastMessageId:h.context.chat.length-1,textareaText:'',
            this_edit_mes_id:undefined,hideMessageBeforeRemoval:async()=>{},
            deleteItemizedPromptForMessage(){},updateViewMessageIds(){},saveChatDebounced(){},cleanupDeletedMessageStates(){},refreshActiveSwipeButtons(){},
            event_types:{MESSAGE_DELETED:'deleted'},eventSource:{emit:async(name,length)=>{
                await h.context.eventSource.emit(name,length);s.api.scheduleChatMutationRefresh_ACU('chat_modified_deleted');
            }}};
        const context=vm.createContext(globals);
        vm.runInContext(deleteFn.getText(ast).replace(/^export /,''),context);
        await vm.runInContext(`(async()=>{${deletionBranch.getText(ast)}})()`,context);
        assert.equal(h.context.chat.length,2);assert.equal(s.calls.length,0);
        const immediate=h.win.Mvu.getMvuData().stat_data.状态.金币;
        assert.equal(immediate,42);
        await s.time.advance(1200);assert.equal(readAfterRefresh,originalGold);
        return { deletedAI:true,readBeforeReplay:immediate,readAfterMockedRefresh:readAfterRefresh,delayMs:1200,
            limitation:'production TT branch + scheduler + converted runtime read; replay/data IO is substituted' };
    });
    await auditExternalReroll();
    for(const name of ['src/extension-runtime.js','src/runtime-session.js','src/card-bridge.js','index.js'])source(path.join(root,name));
    const output=path.resolve(process.env.MVU_ROLLBACK_AUDIT_OUTPUT || path.join(root,'.tools/tauritavern-rollback-2026-10-05/results.json'));
    fs.mkdirSync(path.dirname(output),{recursive:true});
    fs.writeFileSync(output,JSON.stringify({ scope:'upstream component controls and risk observations; mocked IO/UI/transactions, no WebView/full replay acceptance',
        inputs,scriptSha256:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),observations },null,2));
    console.log(JSON.stringify({observations:observations.length,failedAssertions:0,output}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
