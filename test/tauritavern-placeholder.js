'use strict';

// Browser component test: actual helper functions and Tauri update/transaction,
// with substituted formatting, frontend renderer, database and UI decorators.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

module.exports = async function auditPlaceholder(options) {
    const { browser, base, refs, helper, bundle, core, applyingApi, jquery, lodash, out } = options;
    const ts = require(path.join(refs, 'SillyTavern/node_modules/typescript'));
    function functions(file, names) {
        const source = fs.readFileSync(file, 'utf8');
        const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
        const declarations = names.map(name => {
            const node = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
            assert.ok(node, 'Reference function missing: ' + name);
            return node.getText(tree).replace(/^export /, '');
        });
        return ts.transpileModule(declarations.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    }
    const helperSource = functions(path.join(helper, 'src/function/chat_message.ts'), ['refreshMessages', 'setChatMessages'])
        + functions(path.join(helper, 'src/function/displayed_message.ts'), ['refreshOneMessage']);
    const hostSource = functions(path.join(refs, 'TauriTavern/src/script.js'), ['updateMessageBlock']);
    const source = require('./synthetic-card')();
    source.data.extensions.regex_scripts.push({ scriptName: 'placeholder', findRegex: '<StatusPlaceHolderImpl/>', replaceString: '', disabled: false });
    const converted = core.convert(source);
    converted.card.data.avatar = 'placeholder-public.png';
    const cases = [], errors = [];
    for (const mode of ['st', 'static-identical', 'static-changed']) {
        const page = await browser.newPage();
        page.on('pageerror', error => errors.push(error.message));
        try {
            await page.goto(base);
            await page.addScriptTag({ content: lodash });
            await page.addScriptTag({ content: jquery });
            await page.evaluate(({ card, tables, apiSource, mode }) => {
                window.audit = { helperRefresh: [], hostCalls: 0, helperDraws: 0, rendered: 0, saves: 0 };
                const handlers = {};
                window.ctx = {
                    characters: [card.data], characterId: 0, chatId: 'placeholder-A',
                    chat: [{ name: 'test', is_user: false, mes: 'opening', TavernDB_ACU_IsolatedData: {
                        test: { storageFrame: { version: 2, checkpoint: { kind: 'full', data: tables }, logEntries: [] } },
                    } }], extensionSettings: { mvu2shujuku: {} },
                    eventSource: {
                        on(name, fn) { (handlers[name] ||= []).push(fn); },
                        async emit(name, ...args) { for (const fn of handlers[name] || []) await fn(...args); },
                    }, event_types: { CHAT_CHANGED: 'chat_changed', CHARACTER_MESSAGE_RENDERED: 'rendered' },
                    saveSettingsDebounced() {}, async saveChat() {}, async saveChatConditional() {},
                };
                window.SillyTavern = { getContext: () => ctx };
                window.AutoCardUpdaterAPI = eval('(' + apiSource + ')')(tables);
                window.chat = ctx.chat; window.eventSource = ctx.eventSource; window.event_types = ctx.event_types;
                window.characters = ctx.characters; window.this_chid = 0;
                window.default_avatar = window.user_avatar = window.system_avatar = 'avatar';
                window.usesManagedChatSurface = false;
                window.normalizeMessageId = id => id;
                window.saveChatConditionalDebounced = () => { audit.saves++; };
                window.saveChatConditional = async () => { audit.saves++; };
                window.reloadCurrentChat = async () => { throw new Error('Unexpected full chat reload'); };
                window.getThumbnailUrl = () => 'avatar'; window.highlight_code = window.showSwipeButtons = () => {};
                window.frontendHtml = '<html><body><input id="local" value="initial"></body></html>';
                window.messageFormatting = text => '<p>opening</p><pre><code>'
                    + frontendHtml.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
                    + '</code></pre>' + (mode === 'static-changed' && text.includes('<StatusPlaceHolderImpl/>') ? '<p>new placeholder display</p>' : '');
                ctx.messageFormatting = messageFormatting;
                window.getMessageTextHTML = msg => messageFormatting(msg.mes);
                window.chatElement = $('#chat'); window.chatSurface = { setContentTransient() {} };
                window.formatGenerationTimer = () => ({ tokenRate: 0 });
                window.updateMessageGenerationInfo = window.updateReasoningUI = window.appendMediaToMessage = () => {};
                window.mountFrontends = () => {
                    for (const pre of document.querySelectorAll('#chat pre')) {
                        if (pre.closest('.TH-render')) continue;
                        const wrapper = document.createElement('div'); wrapper.className = 'TH-render';
                        pre.replaceWith(wrapper); wrapper.append(pre); pre.style.display = 'none';
                        const frame = document.createElement('iframe'); frame.id = 'TH-message--0--0';
                        frame.srcdoc = pre.textContent; wrapper.append(frame);
                    }
                };
                ctx.eventSource.on('rendered', () => { audit.rendered++; mountFrontends(); });
                const message = document.createElement('div'); message.className = 'mes'; message.setAttribute('mesid', '0');
                message.innerHTML = '<div class="mes_text">' + messageFormatting('opening') + '</div>';
                document.getElementById('chat').append(message); mountFrontends();
                if (mode !== 'st') window.__TAURITAVERN__ = { api: { chatSurface: { isManagedOwnershipRequired: () => false } } };
            }, { card: converted.card, tables: converted.template, apiSource: applyingApi.toString(), mode });
            await page.addScriptTag({ content: helperSource + hostSource });
            await page.evaluate(async () => {
                const transaction = await import('/tt/src/tauri/main/adapters/embedded-runtime/message-render-transaction.js');
                window.replaceMesTextHtmlWithRuntimePolicy = transaction.replaceMesTextHtmlPreservingEmbeddedRuntimes;
                const helperSetter = setChatMessages, helperDraw = refreshOneMessage, hostUpdate = updateMessageBlock;
                window.setChatMessages = (...args) => { audit.helperRefresh.push(args[1].refresh); return helperSetter(...args); };
                window.refreshOneMessage = (...args) => { audit.helperDraws++; return helperDraw(...args); };
                ctx.updateMessageBlock = (...args) => { audit.hostCalls++; return hostUpdate(...args); };
                window.TavernHelper = { setChatMessages };
            });
            await page.addScriptTag({ content: bundle });
            await page.waitForFunction(() => typeof window.Mvu?.replaceMvuData === 'function'
                && document.querySelector('iframe')?.contentDocument?.getElementById('local'));
            await page.evaluate(() => {
                audit.oldWrapper = document.querySelector('.TH-render'); audit.oldFrame = document.querySelector('iframe');
                audit.oldDocument = audit.oldFrame.contentDocument;
                audit.oldDocument.getElementById('local').value = 'selected';
                audit.beforeTables = JSON.stringify(AutoCardUpdaterAPI.exportTableAsJson());
                return ctx.eventSource.emit('chat_changed');
            });
            await page.waitForFunction(() => audit.saves > 0 && ctx.chat[0].mes.includes('<StatusPlaceHolderImpl/>'));
            await page.waitForTimeout(300);
            const observed = await page.evaluate(mode => {
                const frame = document.querySelector('iframe');
                return { name: 'placeholder refresh: ' + mode, helperRefresh: audit.helperRefresh,
                    hostCalls: audit.hostCalls, helperDraws: audit.helperDraws, rendered: audit.rendered,
                    sameWrapper: document.querySelector('.TH-render') === audit.oldWrapper,
                    sameFrame: frame === audit.oldFrame, sameDocument: frame?.contentDocument === audit.oldDocument,
                    local: frame?.contentDocument?.getElementById('local')?.value,
                    tablesUnchanged: audit.beforeTables === JSON.stringify(AutoCardUpdaterAPI.exportTableAsJson()),
                    frameDataEqual: JSON.stringify(frame?.contentWindow.getAllVariables?.().stat_data) === JSON.stringify(getAllVariables().stat_data) };
            }, mode);
            cases.push(observed);
            assert.strictEqual(observed.tablesUnchanged, true);
            assert.strictEqual(observed.frameDataEqual, true);
            assert.deepStrictEqual(observed.helperRefresh, [mode === 'st' ? 'affected' : 'none']);
            assert.strictEqual(observed.helperDraws, mode === 'st' ? 1 : 0);
            assert.strictEqual(observed.hostCalls, mode === 'static-changed' ? 1 : 0);
            if (mode === 'static-identical') {
                assert.strictEqual(observed.sameDocument, true);
                assert.strictEqual(observed.local, 'selected');
            }
            if (mode === 'static-changed') assert.strictEqual(observed.sameWrapper, true);
        } catch (error) {
            fs.writeFileSync(path.join(out, 'placeholder-failure.json'), JSON.stringify({ mode, cases, errors, error: error.stack }, null, 2));
            throw error;
        } finally { await page.close(); }
    }
    assert.deepStrictEqual(errors, []);
    return cases;
};
