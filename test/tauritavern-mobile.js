#!/usr/bin/env node
'use strict';

// Component audit, not Android/WebView acceptance. Uses the actual TT composition,
// TanStack adapter and helper participant; substitutes DB, formatting and Vue mount.
const fs = require('fs'), path = require('path'), http = require('http'), assert = require('assert');
const root = path.resolve(__dirname, '..');
const refs = process.env.MVU_REFERENCE_ROOT || path.resolve(root, '../参考资料');
const helper = process.env.MVU_HELPER_ROOT || path.join(refs, 'JS-Slash-Runner');
const virtualRoot = process.env.MVU_TAURI_VIRTUAL_CORE_ROOT || path.join(refs, 'TauriTavern/node_modules/@tanstack/virtual-core');
const out = process.env.MVU_TAURI_AUDIT_OUTPUT || path.join(root, '.tools/tauritavern-mobile');
fs.mkdirSync(out, { recursive: true });
const ts = require(path.join(refs, 'SillyTavern/node_modules/typescript'));
const core = require('../src/mvu2shujuku');
const { applyingApi } = require('./helpers');
const sourceCard = require('./synthetic-card')();
sourceCard.data.extensions.regex_scripts.push({ scriptName: 'placeholder', findRegex: '<StatusPlaceHolderImpl/>', replaceString: '', disabled: false });
const converted = core.convert(sourceCard, { installMvuShim: true });
converted.card.data.avatar = 'mobile-public.png';
const inputs = {};
function read(file) { const source = fs.readFileSync(file, 'utf8'); inputs[file] = source; return source; }
function functions(file, names) {
    const source = read(file), tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    return ts.transpileModule(names.map(name => {
        const node = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
        assert.ok(node, 'Missing actual reference function: ' + name);
        return node.getText(tree).replace(/^export /, '');
    }).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}
const script = path.join(refs, 'TauriTavern/src/script.js');
const sendSource = functions(script, ['sendMessageAsUser', 'addOneMessage', 'scrollChatToBottom', 'withChatSurfaceStructureMutation', 'syncChatSurfaceProjectionHold', 'reconcileMountedChatSurface', 'redisplayChat']);
const installSource = functions(path.join(refs, 'TauriTavern/src/tauri/main/services/chat-surface/install.js'), ['installChatSurfaceRuntime']);
const helperRefresh = functions(path.join(helper, 'src/function/chat_message.ts'), ['refreshMessages', 'setChatMessages']);
const helperGlobals = functions(path.join(helper, 'src/function/global.ts'), ['hasMvuData', 'waitMvu', '_waitGlobalInitialized', '_initializeGlobal', 'waitGlobalInitialized', 'initializeGlobal'])
    + functions(path.join(helper, 'src/function/variables.ts'), ['_getAllVariables']);
const helperParticipant = ts.transpileModule(read(path.join(helper, 'src/tauritavern_chat_surface.ts')).replace(/^import .*;?\r?\n/gm, '').replaceAll('export ', '').replace("await import('@sillytavern/script')", '({ redisplayChat: window.redisplayChat })'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const bundle = read(path.join(root, 'index.js'));
const jquery = read(path.join(refs, 'SillyTavern/public/lib/jquery-3.5.1.min.js'));
const lodash = read(path.join(refs, 'SillyTavern/node_modules/lodash/lodash.js'));
const predefine = read(path.join(helper, 'src/iframe/predefine.js'));
const adjustHeight = read(path.join(helper, 'src/iframe/adjust_iframe_height.js'));
const hostStyle = read(path.join(refs, 'TauriTavern/src/style.css'));
const boundedStyleStart = hostStyle.indexOf('#chat[data-tt-chat-surface="bounded"] {');
const boundedStyleEnd = hostStyle.indexOf('\n.mes {', boundedStyleStart);
assert.ok(boundedStyleStart >= 0 && boundedStyleEnd > boundedStyleStart, 'Actual bounded chat CSS missing');
const boundedStyle = hostStyle.slice(boundedStyleStart, boundedStyleEnd);
assert.ok(boundedStyle.includes('flex: 0 0 auto;'), 'Virtual spacers must not shrink in the flex chat root');
assert.equal(JSON.parse(read(path.join(virtualRoot, 'package.json'))).version, '3.17.7', 'Use TT 2.3.0 pinned virtualizer');
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(refs, '测试工具/browsers');
const { chromium } = require(path.join(refs, '测试工具/node_modules/playwright'));
const report = { scope: 'Mobile Chromium component; actual TT composition/controller/virtualizer and helper participant/send; substitute DB, format, Vue mount and UI decorators. No Android IME/native WebView.', cases: [], errors: [] };
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Content-Type', 'text/javascript');
    if (url.pathname === '/') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;height:100%;overflow:hidden}#chat{height:calc(100dvh - 60px);overflow:auto;display:flex;flex-direction:column;gap:0;padding:0}#chat>.mes{flex-shrink:0;margin:0;padding:0}.mes_text{margin:0}iframe{display:block;width:100%;border:0}pre{margin:0}#chat>.mes:not(.last_mes){content-visibility:auto;contain-intrinsic-block-size:auto 200px}' + boundedStyle + '</style><div id="chat"></div><textarea id="send_textarea"></textarea>'); return;
    }
    const resources = { '/jquery.js': jquery, '/predefine.js': predefine, '/height.js': adjustHeight };
    if (resources[url.pathname]) { res.end(resources[url.pathname]); return; }
    const prefix = url.pathname.startsWith('/tt/') ? '/tt/' : url.pathname.startsWith('/virtual/') ? '/virtual/' : null;
    if (prefix) {
        const base = prefix === '/tt/' ? path.join(refs, 'TauriTavern') : path.join(virtualRoot, 'dist/esm');
        const file = path.resolve(base, url.pathname.slice(prefix.length));
        if (!file.startsWith(base + path.sep)) { res.writeHead(403); res.end(); return; }
        try { const value = fs.readFileSync(file, 'utf8'); inputs[file] = value; res.end(value); } catch (_) { res.writeHead(404); res.end(); }
        return;
    }
    res.writeHead(404); res.end();
});

async function fixture(browser, base, managed, plugin) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
        userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36' });
    page.on('pageerror', error => report.errors.push(error.message));
    try {
        await page.goto(base); await page.addScriptTag({ content: lodash }); await page.addScriptTag({ content: jquery });
        await page.evaluate(({ card, tables, apiSource, managed, plugin }) => {
            window.audit = { faults: [], mounts: 0, unmounts: 0, saves: 0, tableBefore: JSON.stringify(tables) };
            window.auditTables = tables;
            const events = {}, es = { on(n, f) { (events[n] ||= []).push(f); }, once(n, f) { const cb = (...a) => { es.removeListener(n, cb); return f(...a); }; es.on(n, cb); }, removeListener(n, f) { events[n] = (events[n] || []).filter(x => x !== f); }, async emit(n, ...a) { for (const f of (events[n] || []).slice()) await f(...a); } };
            window.ctx = { characters: [card.data], characterId: 0, chatId: 'mobile-A',
                chat: Array.from({ length: 70 }, (_, i) => ({ name: 'test', is_user: i % 2 === 1, is_system: false, mes: 'message-' + i + '\n<StatusPlaceHolderImpl/>', runtime: i === 68 })),
                extensionSettings: { mvu2shujuku: {} }, eventSource: es, event_types: { CHAT_CHANGED: 'chat_id_changed', MESSAGE_SENT: 'message_sent', MESSAGE_RECEIVED: 'message_received', CHARACTER_MESSAGE_RENDERED: 'character_message_rendered', USER_MESSAGE_RENDERED: 'user_message_rendered' },
                saveSettingsDebounced() {}, async saveChat() {}, async saveChatConditional() {}, generating: false };
            ctx.chat[0].TavernDB_ACU_IsolatedData = { test: { storageFrame: { version: 2, checkpoint: { kind: 'full', data: tables }, logEntries: [] } } };
            window.SillyTavern = { getContext: () => ctx }; window.AutoCardUpdaterAPI = eval('(' + apiSource + ')')(tables);
            Object.assign(window, { chat: ctx.chat, characters: ctx.characters, this_chid: 0, eventSource: es, event_types: ctx.event_types, chatElement: $('#chat'), chatSurfaceStructureMutationDepth: 0, this_edit_mes_id: null, name1: 'user', user_avatar: 'avatar', chat_metadata: {}, requestId: null,
                power_user: { auto_scroll_chat_to_bottom: true, waifuMode: false, message_token_count_enabled: false, personas: {} }, CHAT_COMMIT_REASON: { MUTATION: 'mutation' },
                getRegexedString: x => x, regex_placement: { USER_INPUT: 1 }, substituteParams: x => x, getMessageTimeStamp: () => 'now', populateFileAttachment: async () => {}, statMesProcess() {}, saveChatConditional: async () => { audit.saves++; }, saveChatConditionalDebounced: () => { audit.saves++; },
                getThumbnailUrl: () => 'avatar', applyCharacterTagsToMessageDivs() {}, updateEditArrowClasses() {}, refreshActiveSwipeButtons() {}, refreshSwipeButtons() {}, applyStylePins() {},
                getChatScrollHeight: () => chatSurface.scroll.height(), getChatScrollTop: () => chatSurface.scroll.top(), setChatScrollTop: top => chatSurface.scroll.setTop(top),
                finalizeMessageContent: async (id, type) => { await chatSurface.finishContent(id, type); },
                normalizeMessageId: id => id, formatGenerationTimer: () => ({}), waitUntil: async fn => { const until = Date.now() + 2000; while (!fn()) { if (Date.now() >= until) throw new Error('wait timeout'); await new Promise(r => setTimeout(r, 10)); } },
                errorCatched: fn => fn, eventClearAll() {}, getVariables: () => ({}), getChatMessages: () => chat.map((m, i) => ({ message_id: i, message: m.mes })), _th_impl: { writeExtensionField() {} },
                _getIframeName() { return this.frameElement?.id || this.name; }, _getCurrentMessageId() { return Number(this.frameElement?.closest('.mes')?.getAttribute('mesid')); }, _getScriptId: () => '',
                _eventEmit: (n, ...a) => es.emit(n, ...a), _eventOnce: (n, f) => es.once(n, f), get_variables_without_clone: () => ({}), klona: x => JSON.parse(JSON.stringify(x)),
                // TT's bundle replaces this constant at build time; the raw ESM needs the equivalent.
                process: { env: { NODE_ENV: 'production' } }, version: '1.16.0', compare: (a, b, op) => op === '<' && a.localeCompare(b, undefined, { numeric: true }) < 0,
                useGlobalSettingsStore: () => ({ settings: { macro: { enabled: false }, render: { enabled: true, allow_streaming: false, depth: 0, depth_ignore_hidden: false, use_blob_url: false, collapse_code_block: 'none' } } }),
                isFrontend: text => text.includes('<html>'), Iframe: {}, h: (component, props) => ({ component, props }),
                collapseCodeBlocksInContent() {}, CHAT_LAYOUT_CHANGED_EVENT: 'sillytavern:chat-layout-changed', DYNAMIC_THEME_CHANGED_EVENT: 'audit-theme-change' });
            window.frontendHtml = '<html><head><style>html,body{margin:0}#status{height:160px}</style></head><body><div id="status"><input id="local" value="initial"></div><script src="/jquery.js"></script><script src="/predefine.js"></script><script>window._=parent._;window.boot=waitGlobalInitialized("Mvu").then(()=>window.frontReady=true);</script><script src="/height.js"></script></body></html>';
            window.render = (vnode, container) => {
                if (!vnode) { container.querySelector('iframe')?.remove(); audit.unmounts++; return; }
                const pre = container.querySelector('pre'); pre.style.display = 'none';
                const frame = document.createElement('iframe'); frame.id = 'TH-message--' + vnode.props.id; frame.srcdoc = pre.textContent;
                container.append(frame); audit.mounts++;
            };
            window.materializeMessage = ({ message, messageId }) => {
                const mes = document.createElement('div'); mes.className = 'mes'; mes.setAttribute('mesid', messageId);
                const content = document.createElement('div'); content.className = 'mes_text';
                const span = document.createElement('div'); span.style.height = '100px'; span.textContent = message.mes; content.append(span);
                if (message.runtime) { const pre = document.createElement('pre'); pre.textContent = frontendHtml; content.append(pre); }
                mes.append(content); return mes;
            };
            window.messageFormatting = text => '<p>' + text.replace('<StatusPlaceHolderImpl/>', '') + '</p>';
            ctx.messageFormatting = messageFormatting;
            window.managedMode = managed; window.pluginEnabled = plugin;
            if (!plugin) window.Mvu = { nativePublicationSubstitute: true };
        }, { card: converted.card, tables: converted.template, apiSource: applyingApi.toString(), managed, plugin });
        await page.addScriptTag({ content: helperGlobals });
        await page.evaluate(() => { window.TavernHelper = { initializeGlobal, waitGlobalInitialized, getVariables, getChatMessages, eventClearAll, errorCatched,
            _bind: { _waitGlobalInitialized, _initializeGlobal, _getAllVariables } }; });
        await page.evaluate(async () => {
            const base = '/tt/src/tauri/main/';
            const modules = await Promise.all([
                import(base + 'adapters/chat-surface/chat-dom-adapter.js'), import(base + 'adapters/chat-surface/chat-scroll-adapter.js'),
                import(base + 'adapters/chat-surface/frontend-source-handoff.js'), import(base + 'adapters/chat-surface/tanstack-virtual-adapter.js'),
                import(base + 'services/chat-surface/bounded-chat-surface.js'), import(base + 'services/chat-surface/chat-surface-controller.js'),
                import(base + 'services/chat-surface/content-preparation.js'), import(base + 'services/chat-surface/runtime.js'),
                import(base + 'services/chat-surface/chat-virtualization-state.js'), import('/virtual/index.js'),
            ]);
            for (const mod of modules.slice(0, 9)) Object.assign(window, mod);
            Object.assign(window, await import('/tt/src/scripts/constants.js'));
            window.libs = modules[9]; initializeChatVirtualization({ chat_virtualization_enabled: managedMode });
            window.__TAURITAVERN__ = { api: { chatSurface: { protocolVersion: 1, isManagedOwnershipRequired: isManagedChatSurfaceOwnershipRequired, registerParticipant: participant => getChatSurfaceParticipantRegistry().register(participant) } } };
        });
        await page.addScriptTag({ content: installSource + sendSource + helperParticipant + helperRefresh });
        await page.evaluate(async () => {
            if (managedMode) activateTauriTavernChatSurface();
            else getChatSurfaceParticipantRegistry().register({ id: 'static-fixture-mount', protocolVersion: 1, prepareContent({ content, mesid }, claims) {
                for (const pre of content.querySelectorAll('pre')) {
                    const container = runtimeContainer(pre);
                    claims.claim(pre, () => { render(h(Iframe, { id: mesid + '--0' }), container); return () => render(null, container); });
                }
            } });
            window.chatSurface = installChatSurfaceRuntime({ root: document.getElementById('chat'), getMessages: () => chat,
                prepareMaterializeOptions: async () => new Map(), materializeMessage,
                formatMessageContent: message => messageFormatting(message.mes),
                prepareContentTransaction(element, html) { const content = document.createElement('div'); content.className = 'mes_text'; content.innerHTML = html; return { content, commit() { element.querySelector('.mes_text').replaceWith(content); } }; },
                emitEvent: (event, ...args) => eventSource.emit(event, ...args),
                syncMountedViewState() { for (const mes of document.querySelectorAll('#chat>.mes')) mes.classList.toggle('last_mes', Number(mes.getAttribute('mesid')) === chat.length - 1); },
                onFault: error => audit.faults.push(error.stack) });
            await chatSurface.render({ startIndex: 0 }); chatSurface.enableMutationGuard(); scrollChatToBottom({ waitForFrame: true });
        });
        if (plugin) { await page.addScriptTag({ content: bundle }); await page.waitForFunction(() => typeof Mvu?.replaceMvuData === 'function'); }
        await page.waitForFunction(() => document.querySelector('#chat iframe')?.contentWindow?.frontReady === true);
        await page.waitForTimeout(350);
        return page;
    } catch (error) {
        const diagnostics = await page.evaluate(() => ({ managed: window.managedMode, plugin: window.pluginEnabled,
            audit: window.audit, mounted: window.chatSurface?.getMountedMessageIds(),
            top: document.getElementById('chat')?.scrollTop, html: document.getElementById('chat')?.innerHTML.slice(-5000),
            frames: [...document.querySelectorAll('iframe')].map(frame => ({ id: frame.id, ready: frame.contentWindow?.frontReady, text: frame.contentDocument?.body?.innerHTML.slice(0, 600) })) })).catch(() => null);
        fs.writeFileSync(path.join(out, 'fixture-failure-' + Date.now() + '.json'), JSON.stringify(diagnostics, null, 2));
        await page.close(); throw error;
    }
}

async function geometry(page) {
    return page.evaluate(() => {
        const chatRoot = document.getElementById('chat'), rect = chatRoot.getBoundingClientRect();
        return { top: chatRoot.scrollTop, height: chatRoot.scrollHeight, viewport: chatRoot.clientHeight,
            gap: chatRoot.scrollHeight - chatRoot.clientHeight - chatRoot.scrollTop,
            visible: [...chatRoot.querySelectorAll(':scope>.mes')].filter(m => { const r = m.getBoundingClientRect(); return r.bottom > rect.top && r.top < rect.bottom; }).map(m => Number(m.getAttribute('mesid'))),
            mounted: chatSurface.getMountedMessageIds(), count: chat.length, faults: audit.faults.slice() };
    });
}
async function auditPromptOwnership(browser, base) {
    const prompt = path.join(refs, 'ST-Prompt-Template');
    const handler = functions(path.join(prompt, 'src/modules/handler.ts'), ['handleMessageRender']);
    const utilities = functions(path.join(prompt, 'src/utils/prompts.ts'), ['escapeForTemplateLiteral', 'escapePreContent',
        'splitNested', 'unescapeHtmlEntities', 'wrapEscapeBlocks', 'escapeReasoningBlocks']);
    const engine = read(path.join(prompt, 'src/3rdparty/ejs.js'));
    const configs = [{ codeBlocks: false, renderEnabled: true }, { codeBlocks: true, renderEnabled: true }, { codeBlocks: false, renderEnabled: false }];
    for (const plugin of [false, true]) for (const { codeBlocks, renderEnabled } of configs) {
        const page = await fixture(browser, base, true, plugin);
        try {
            await page.addScriptTag({ content: engine });
            // Run the actual render handler/escape functions and vendored EJS engine.
            // Worldbook/env/regex/UI are substituted, permanent raw-message evaluation
            // is disabled to isolate the displayed-content branch.
            await page.addScriptTag({ content: 'window.createPromptRender = function(settings) { let isFakeRun=false, runID=0; const STATE={};'
                + 'const prepareContext=async()=>({}), getEnabledWorldInfoEntries=async()=>[], evaluateWIEntities=async()=>"";'
                + 'const evalTemplateHandler=async(content,env,where,opt)=>ejs.render(content,env,{...opt.options,async:true});'
                + 'const applyRegex=(env,text)=>text, getCurrentChatId=()=>ctx.chatId;'
                + 'const updateReasoningUI=()=>{}, addCopyToCodeBlocks=()=>{}, appendMediaToMessage=()=>{}, checkAndSave=()=>{}, updateTokens=()=>{};'
                + utilities + handler + ';return handleMessageRender;};' });
            const observation = await page.evaluate(async ({ plugin, codeBlocks, renderEnabled }) => {
                const content = document.querySelector('.mes[mesid="68"] .mes_text');
                const source = content.querySelector('pre'), originalHtml = content.innerHTML;
                const fullCount = chat.length, savedTables = JSON.stringify(auditTables);
                const renderMessage = createPromptRender({ enabled: true, render_enabled: renderEnabled, depth_limit: -1,
                    code_blocks_enabled: codeBlocks, raw_message_evaluation_enabled: false, render_loader_enabled: false, sandbox: false, cache_enabled: 0 });
                await renderMessage('68', 'history-render', false);
                const after = { sourceConnected: source.isConnected, sameSource: source === content.querySelector('pre'), htmlEqual: originalHtml === content.innerHTML };
                let error = null;
                try { chatSurface.reconcileMounted(); } catch (failure) { error = failure.message; }
                return { plugin, codeBlocks, renderEnabled, ...after, error, fullCount, countAfter: chat.length, tablesEqual: savedTables === JSON.stringify(auditTables) };
            }, { plugin, codeBlocks, renderEnabled });
            assert.equal(observation.fullCount, observation.countAfter); assert.equal(observation.tablesEqual, true);
            assert.equal(observation.htmlEqual, true, 'Even identical display can replace source nodes');
            if (codeBlocks || !renderEnabled) { assert.equal(observation.sameSource, true); assert.equal(observation.error, null); }
            else { assert.equal(observation.sourceConnected, false); assert.equal(observation.sameSource, false);
                assert.equal(observation.error, 'ChatSurface message 68 runtime source ownership diverged'); }
            report.cases.push({ name: 'actual prompt-template render versus virtual runtime ownership', ...observation });
        } finally { await page.close(); }
    }
    report.promptTemplate = JSON.parse(read(path.join(prompt, 'manifest.json'))).version;
}
async function main() {
    let browser;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = 'http://127.0.0.1:' + server.address().port;
    try {
        browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
        if (process.env.MVU_TAURI_OWNERSHIP) {
            await auditPromptOwnership(browser, base);
        }
        if (process.env.MVU_TAURI_OWNERSHIP !== '1') {
        for (const managed of [false, true]) for (const plugin of [false, true]) {
            if (process.env.MVU_TAURI_MODES === 'virtual' && !managed) continue;
            const page = await fixture(browser, base, managed, plugin);
            try {
                const before = await geometry(page);
                await page.evaluate(async () => { await sendMessageAsUser('new user message', ''); });
                await page.waitForTimeout(450);
                const sent = await geometry(page);
                assert.ok(sent.gap <= 6, 'Send should reach tail'); assert.equal(sent.count, 71); assert.deepEqual(sent.faults, []);
                report.cases.push({ name: 'send before AI', managed, plugin, before, sent });
                await page.evaluate(() => { document.querySelector('#chat iframe').contentDocument.getElementById('status').style.height = '460px'; });
                await page.waitForTimeout(500);
                const expanded = await geometry(page);
                report.cases.push({ name: 'status expands after send', managed, plugin, expanded });
                if (managed) assert.ok(expanded.gap <= 6, 'Managed follow tail on measured height');
                else assert.ok(Math.abs(expanded.gap - 300) <= 2, 'Static late-height gap is also observed without the plugin');
                await page.setViewportSize({ width: 390, height: 544 }); await page.waitForTimeout(450);
                const shrunk = await geometry(page);
                await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(450);
                const restored = await geometry(page);
                assert.ok(Math.abs(shrunk.gap - expanded.gap - 300) <= 2, 'Height-only viewport change is an independent host observation');
                report.cases.push({ name: 'mobile viewport height shrink/restore (IME substitute)', managed, plugin, shrunk, restored });
                if (managed && plugin) {
                    await page.evaluate(() => { chatSurface.jumpToMessage(3); }); await page.waitForTimeout(450);
                    const away = await geometry(page);
                    assert.ok(away.mounted.length < away.count); assert.ok(!away.mounted.includes(68));
                    await page.evaluate(() => { chatSurface.jumpToMessage(68); });
                    await page.waitForFunction(() => document.querySelector('#chat iframe')?.contentWindow?.frontReady === true);
                    await page.waitForTimeout(100);
                    const data = await page.evaluate(() => {
                        const frame = document.querySelector('#chat iframe');
                        return { equal: JSON.stringify(frame.contentWindow.getAllVariables().stat_data) === JSON.stringify(getAllVariables().stat_data),
                            mounts: audit.mounts, unmounts: audit.unmounts, tablesEqual: audit.tableBefore === JSON.stringify(auditTables), faults: audit.faults.slice() };
                    });
                    assert.equal(data.equal, true); assert.equal(data.tablesEqual, true); assert.ok(data.mounts >= 2); assert.deepEqual(data.faults, []);
                    report.cases.push({ name: 'virtualized unload/remount reads complete data', away, data });
                    await page.evaluate(async () => {
                        await setChatMessages([{ message_id: 68, swipes: [chat[68].mes, chat[68].mes + '\nswipe two'], swipe_id: 1 }], { refresh: 'affected' });
                    });
                    await page.waitForFunction(() => document.querySelector('#chat iframe')?.contentWindow?.frontReady === true);
                    const refreshed = await page.evaluate(() => ({ swipe: chat[68].swipe_id, text: chat[68].mes,
                        dataEqual: JSON.stringify(document.querySelector('#chat iframe').contentWindow.getAllVariables().stat_data) === JSON.stringify(getAllVariables().stat_data),
                        count: chat.length, mounted: chatSurface.getMountedMessageIds().length, tablesEqual: audit.tableBefore === JSON.stringify(auditTables), faults: audit.faults.slice() }));
                    assert.equal(refreshed.swipe, 1); assert.ok(refreshed.text.includes('swipe two')); assert.equal(refreshed.dataEqual, true);
                    assert.equal(refreshed.tablesEqual, true); assert.ok(refreshed.mounted < refreshed.count); assert.deepEqual(refreshed.faults, []);
                    report.cases.push({ name: 'actual helper managed swipe refresh', refreshed });
                    await page.evaluate(async () => {
                        const message = { name: 'test', is_user: false, is_system: false, mes: 'AI reply without placeholder', runtime: true };
                        chat.push(message); addOneMessage(message); await eventSource.emit(event_types.MESSAGE_RECEIVED, chat.length - 1);
                    });
                    await page.waitForFunction(() => chat.at(-1).mes.includes('<StatusPlaceHolderImpl/>'));
                    await page.waitForFunction(() => document.querySelector('#chat .last_mes iframe')?.contentWindow?.frontReady === true);
                    await page.waitForTimeout(200);
                    const placeholder = await page.evaluate(() => ({ text: chat.at(-1).mes,
                        dataEqual: JSON.stringify(document.querySelector('#chat .last_mes iframe').contentWindow.getAllVariables().stat_data) === JSON.stringify(getAllVariables().stat_data),
                        tablesEqual: audit.tableBefore === JSON.stringify(auditTables), faults: audit.faults.slice(), saves: audit.saves }));
                    assert.equal(placeholder.dataEqual, true); assert.equal(placeholder.tablesEqual, true); assert.deepEqual(placeholder.faults, []);
                    report.cases.push({ name: 'plugin placeholder through actual managed helper participant', placeholder });
                    const streamError = await page.evaluate(() => {
                        const original = useGlobalSettingsStore;
                        window.useGlobalSettingsStore = () => ({ settings: { render: { enabled: true, allow_streaming: true } } });
                        try { settings(); return null; } catch (error) { return error.message; } finally { window.useGlobalSettingsStore = original; }
                    });
                    assert.equal(streamError, 'JS-Slash-Runner streaming rendering is not supported by managed ChatSurface');
                    report.cases.push({ name: 'actual helper streaming renderer incompatibility guard', streamError });
                }
            } finally { await page.close(); }
        }
        }
        assert.deepEqual(report.errors, []);
        report.versions = { plugin: JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'))).version, tauri: JSON.parse(fs.readFileSync(path.join(refs, 'TauriTavern/package.json'))).version, helper: JSON.parse(fs.readFileSync(path.join(helper, 'manifest.json'))).version, virtualCore: '3.17.7' };
        read(__filename);
        report.sha256 = Object.fromEntries(Object.entries(inputs).map(([file, source]) => [file, require('crypto').createHash('sha256').update(source).digest('hex')]));
        fs.writeFileSync(path.join(out, 'browser-results.json'), JSON.stringify(report, null, 2) + '\n');
        console.log(JSON.stringify({ cases: report.cases.length, errors: report.errors.length, versions: report.versions, result: path.join(out, 'browser-results.json') }));
    } finally {
        if (browser) await browser.close(); await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { fs.writeFileSync(path.join(out, 'browser-failure-' + Date.now() + '.json'), JSON.stringify({ error: error.stack, report }, null, 2)); console.error(error.stack); process.exitCode = 1; });
