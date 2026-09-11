'use strict';

// ST 扩展运行时入口；通过 window 上的模块工厂和核心接口协作。
function installExtensionRuntime(window) {
    'use strict';
    const root = window;
    const stAdapter = window.__MVU2SHUJUKU_ST_ADAPTER_FACTORY__(window);

    const PLUGIN_ID = 'mvu2shujuku';
    const PANEL_ID = PLUGIN_ID + '-settings';
    const SETTINGS_KEY = 'mvu2shujuku';
    const state = { timer: null };

    // debug 开关：读 window.__mvu2shujukuDebug（由设置面板/加载时写入）
    function mvu2shujukuDebugOn() {
        try {
            const w = (typeof window !== 'undefined' ? window : globalThis);
            return !!(w && w.__mvu2shujukuDebug);
        } catch (e) { return false; }
    }
    function dbg() {
        if (!mvu2shujukuDebugOn()) return;
        try { console.log.apply(console, ['[mvu2shujuku][debug]'].concat(Array.prototype.slice.call(arguments))); } catch (e) {}
    }
    function dbgWarn() {
        if (!mvu2shujukuDebugOn()) return;
        try { console.warn.apply(console, ['[mvu2shujuku][debug]'].concat(Array.prototype.slice.call(arguments))); } catch (e) {}
    }

    // 开局建表核心流程（与卡内数据桥同一份逻辑：缺表时调用 SP·数据库 的 initGameSession）
    const { mvu2shujukuDecodeB64, mvu2shujukuExpectedTableNames, mvu2shujukuSheetByName, mvu2shujukuHasExtraRows, mvu2shujukuTablesSafeToAnchor, mvu2shujukuMissingTableNames, mvu2shujukuExpectedColumns, mvu2shujukuMissingColumns, mvu2shujukuMacroMark, mvu2shujukuMacroEnv, mvu2shujukuMacroCacheKey, mvu2shujukuCheckRowKeyCollision, mvu2shujukuResolveTemplateMacros, mvu2shujukuHasFullFrame, mvu2shujukuChatHasFullCheckpoint, mvu2shujukuChatIsPristineOpening, mvu2shujukuForeignRuntimeTableNames, mvu2shujukuChatHasAiFloor, mvu2shujukuRuntimeChatKey, mvu2shujukuWithTimeout, mvu2shujukuEnsureInit } = window.__MVU2SHUJUKU_SP_ADAPTER_FACTORY__(window);

    const DB_TEMPLATE_KEY = '__ACU_TEMPLATE_DATA__';
    const autoInitState = { running: false, done: '', inited: false, retries: 0, anchorChat: '', anchorTries: 0, apiRetries: 0 };
    let autoInitNoEntryRetries = 0;

    // 独有标记：本转换器产出的卡一定有 extensions.mvu2shujuku.converter === 'mvu2shujuku'。
    // SP·数据库 的 __ACU_TEMPLATE_DATA__ 世界书条目是通用模板条目（其他数据库卡也可能带），
    // 不能作为“本转换器产物”的判据；所有运行时行为都以这个独有标记为门槛，确保不碰别的卡。
    // ST 角色对象结构：extensions 在 data.extensions 下（顶层通常没有 extensions）；
    // 读取时两种位置都兼容，避免“没核实对象结构”导致标记永远判不中。
    function charExtensions(...args) { return stAdapter.charExtensions(...args); }

    // 角色世界书：顶层或 data 下（ST 完整对象的世界书在 data.character_book）
    function charWorldBook(...args) { return stAdapter.charWorldBook(...args); }

    function characterDisplayName(...args) { return stAdapter.characterDisplayName(...args); }

    function isConvertedMvuCard(character) {
        try {
            const ext = charExtensions(character);
            const mk = ext && ext.mvu2shujuku;
            return !!(mk && mk.converter === 'mvu2shujuku');
        } catch (e) { return false; }
    }
    // 取当前卡的模板：优先用已缓存，否则从当前角色世界书 __ACU_TEMPLATE_DATA__ 条目解析并缓存。
    // 缓存归属键：卡名 + 头像。完整卡加载时保留列表对象的头像身份；
    // 不能用同名兜底覆盖两个明确不同的角色。
    function cardCacheKey(ch) {
        try { return ch ? characterDisplayName(ch) + '|' + String(ch.avatar || (ch.data && ch.data.avatar) || '') : ''; } catch (e) { return ''; }
    }

    // 旧版缓存可能缺头像；只有身份缺失且名称唯一时才兼容，明确不同头像绝不互认。
    function cardCacheKeyMatches(activeKey, ch) {
        if (!activeKey || !ch) return false;
        const curKey = cardCacheKey(ch);
        if (activeKey === curKey) return true;
        const split = key => {
            const i = String(key).lastIndexOf('|');
            return { name: String(key).slice(0, i), avatar: String(key).slice(i + 1) };
        };
        const a = split(activeKey), b = split(curKey);
        if (!a.name || a.name !== b.name || (a.avatar && b.avatar)) return false;
        const context = getContextSafe();
        const matches = (Array.isArray(context.characters) ? context.characters : [])
            .filter(c => characterDisplayName(c) === b.name);
        return matches.length <= 1;
    }

    function layoutBelongsToCurrentCard(activeKey) {
        try { return cardCacheKeyMatches(activeKey, currentCharacter()); }
        catch (e) { return false; }
    }

    // 切卡隔离：插件运行时（currentJsonTableData）在聊天切换后是异步 reload 的，
    // 空窗期内 exportTableAsJson 可能仍返回上一张卡的表格。这里检查运行时表名集合：
    // 任何既不在当前布局、也不在当前卡模板里的表，都视为跨卡残留（如切到催眠APP后
    // 运行时还挂着道渊的世界表/主角表）。返回残留表名列表（空 = 无跨卡残留）。
    function runtimeForeignTableNames(api, layoutEntries) {
        try {
            if (!api || typeof api.exportTableAsJson !== 'function') return ['<api未就绪>'];
            const cur = api.exportTableAsJson() || {};
            const runtimeNames = new Set();
            for (const k in cur) {
                if (k.indexOf('sheet_') === 0 && cur[k] && cur[k].name) runtimeNames.add(String(cur[k].name));
            }
            if (!runtimeNames.size) return [];
            const expected = new Set((Array.isArray(layoutEntries) ? layoutEntries : []).map(L => String(L.table)));
            const tpl = cachedTemplateForCurrentCard();
            const tplNames = new Set();
            if (tpl && typeof tpl === 'object') {
                for (const k in tpl) {
                    if (k.indexOf('sheet_') === 0 && tpl[k] && tpl[k].name) tplNames.add(String(tpl[k].name));
                }
            }
            const foreign = [];
            for (const n of runtimeNames) {
                if (!expected.has(n) && !tplNames.has(n)) foreign.push(n);
            }
            return foreign;
        } catch (e) { return ['<校验异常>']; }
    }

    function cachedTemplateForCurrentCard() {
        try {
            const holder = (typeof window !== 'undefined' ? window : globalThis);
            // 缓存必须按卡归属：直接复用可能把上一张转换卡的模板套到当前卡上
            // （如切卡后重锚/写库误用旧模板，污染当前聊天的表格结构）。
            const ch = currentCharacter();
            if (holder && holder.__mvu2shujukuTemplateCache &&
                cardCacheKeyMatches(holder.__mvu2shujukuTemplateCacheFor, ch)) {
                return holder.__mvu2shujukuTemplateCache;
            }
        } catch (e) {}
        try {
            const ch = currentCharacter();
            if (!isConvertedMvuCard(ch)) return null;
            const cb = ch && (ch.character_book || (ch.data && ch.data.character_book));
            const entries = (cb && Array.isArray(cb.entries)) ? cb.entries : [];
            const entry = entries.find(e => Array.isArray(e.keys) && e.keys.indexOf(DB_TEMPLATE_KEY) !== -1);
            if (entry && entry.content) {
                const parsed = JSON.parse(mvu2shujukuDecodeB64(entry.content));
                try {
                    const holder = (typeof window !== 'undefined' ? window : globalThis);
                    if (holder) {
                        holder.__mvu2shujukuTemplateCache = parsed;
                        holder.__mvu2shujukuTemplateCacheFor = cardCacheKey(ch);
                        holder.__mvu2shujukuTemplateCacheForName = String(ch.name || '');
                    }
                } catch (e2) {}
                return parsed;
            }
        } catch (e) {}
        return null;
    }
    function autoInitChatId() {
        try {
            const context = getContextSafe();
            return String(context.chatId || context.chat_id || context.chatFile || context.chatFileName || 'unknown');
        } catch (e) { return 'unknown'; }
    }

    // 每次进入会话有独立代次。A → B → A 也不能复活第一次 A 的异步任务。
    // 不用聊天对象引用：首楼替换/回放可能更换数组但仍属于同一会话。
    const runtimeSessions = window.__MVU2SHUJUKU_RUNTIME_SESSION_FACTORY__(() => {
        const context = getContextSafe();
        const ch = currentCharacter();
        const avatar = ch && (ch.avatar || (ch.data && ch.data.avatar));
        const characterKey = avatar ? 'avatar:' + avatar
            : context.characterId != null ? 'id:' + context.characterId : 'name:' + characterDisplayName(ch);
        return { characterKey, groupKey: context.groupId == null ? '' : context.groupId,
            chatKey: autoInitChatId(), cardKey: cardCacheKey(ch) };
    });
    function captureRuntimeSession(validate) { return runtimeSessions.capture(validate); }
    function isRuntimeSessionCurrent(session) { return runtimeSessions.isCurrent(session); }
    function runtimeScopedChatKey(chatKey) { return runtimeSessions.scopedChatKey(chatKey); }
    function assertRuntimeSession(session) { return runtimeSessions.assertCurrent(session); }
    function runtimeApiForSession(api, session) { return runtimeSessions.apiForSession(api, session); }

    // 首楼替换修复：原版道渊“重塑仙缘”等机制用 setChatMessages 替换第零层，会把
    // TavernDB_ACU_ScopedConfig / InternalSheetGuide 从首楼消息上抹掉；插件随后读不到
    // 模板作用域，就按 legacy 迁移冻结成“旧版聊天冻结模板”（催眠APP没有首楼替换所以正常）。
    // 参考卡（道渊-开局收尾桥）在替换时快照/拷回这些字段；转换卡没有，这里在重进/切聊天/
    // 首楼更新后做幂等修复（仅转换卡）：
    //   1) 首楼缺插件字段 → 从 chat_metadata 权威副本拷回；
    //   2) 模板作用域被冻结（presetName 为旧版标签）→ 恢复为当前卡模板名（templateStr 内容不变）；
    // 注意：绝不用转换器自己的模板重建 ScopedConfig——转换器模板是紧凑拼音 key（sheet_shijiebiao），
    // 插件作用域/聊天数据是插件规范化 key（sheet_shi_jie_biao），混写会造成 V2 重放
    // “物理表名冲突”并显示“当前生效模板与预设库内容不同”。作用域缺失时交给插件自己迁移。
    function repairChatTemplateScope() {
        try {
            if (!activeLayout) return; // 只处理转换卡
            const context = getContextSafe();
            const chat = Array.isArray(context.chat) ? context.chat : [];
            if (!chat.length || !chat[0] || typeof chat[0] !== 'object') return;
            const first = chat[0];
            const metadata = (context.chat_metadata && typeof context.chat_metadata === 'object') ? context.chat_metadata : null;
            let changed = false;
            // 1) 消息级字段丢失 → 从 chat_metadata 拷回
            if (metadata) {
                for (const field of ['TavernDB_ACU_InternalSheetGuide', 'TavernDB_ACU_ScopedConfig']) {
                    if (first[field] === undefined && metadata[field] !== undefined) {
                        try { first[field] = JSON.parse(JSON.stringify(metadata[field])); changed = true; } catch (e) {}
                    }
                }
            }
            // 2) 作用域被冻结 → 恢复模板名
            let sc = first.TavernDB_ACU_ScopedConfig;
            if (typeof sc === 'string') { try { sc = JSON.parse(sc); } catch (e) { sc = null; } }
            if (sc && sc.template && typeof sc.template === 'object' && !Array.isArray(sc.template)) {
                const ch = currentCharacter();
                const cardName = characterDisplayName(ch);
                const properName = cardName ? cardName + '模板' : '';
                let nameChanged = false;
                for (const k of Object.keys(sc.template)) {
                    const st = sc.template[k];
                    if (!st || typeof st !== 'object') continue;
                    const pn = String(st.presetName || '');
                    // “模板”是早期自动建表在角色上下文尚未就绪时生成的缺名标签。
                    // 只在无歧义的缺名/旧版标签上自动更名，不触碰用户自定义模板名。
                    const missingName = pn.trim() === '模板';
                    if ((pn.indexOf('旧版') === 0 || missingName) && properName && pn !== properName) {
                        st.presetName = properName;
                        if (typeof st.source === 'string' && st.source.indexOf('legacy') === 0) st.source = 'ui';
                        st.updatedAt = Date.now();
                        nameChanged = true;
                    }
                }
                if (nameChanged) { changed = true; first.TavernDB_ACU_ScopedConfig = sc; }
            }
            // 同步 chat_metadata（插件以 metadata 为权威源），并落盘
            if (changed) {
                if (metadata) {
                    try {
                        for (const field of ['TavernDB_ACU_InternalSheetGuide', 'TavernDB_ACU_ScopedConfig']) {
                            if (first[field] !== undefined) metadata[field] = JSON.parse(JSON.stringify(first[field]));
                        }
                    } catch (e) {}
                    try {
                        const updater = (typeof context.updateChatMetadata === 'function' && context.updateChatMetadata.bind(context)) ||
                            (typeof window.updateChatMetadata === 'function' ? window.updateChatMetadata.bind(window) : null);
                        if (updater) updater({
                            TavernDB_ACU_ScopedConfig: metadata.TavernDB_ACU_ScopedConfig,
                            TavernDB_ACU_InternalSheetGuide: metadata.TavernDB_ACU_InternalSheetGuide,
                        }, false);
                    } catch (e) {}
                }
                const saveFn = (typeof context.saveChatConditional === 'function' && context.saveChatConditional.bind(context)) ||
                    (typeof context.saveChat === 'function' && context.saveChat.bind(context)) ||
                    (typeof window.saveChatConditional === 'function' ? window.saveChatConditional.bind(window) : null) ||
                    (typeof window.saveChat === 'function' ? window.saveChat.bind(window) : null);
                if (saveFn) { Promise.resolve(saveFn()); dbg(' [模板作用域修复] 已恢复首楼插件字段/模板名。'); }
            }
        } catch (e) {}
    }

    // 开场持久化连续性：有些卡会在捏人完成后删除/替换首楼，
    // 而 SP·数据库的 full checkpoint 正挂在该消息上。消息与帧一起被删后，
    // 仅修复 ScopedConfig/Guide 无法找回用户刚填的数据。这里只在“本次会话
    // 新建 checkpoint + 开场短窗口”内记住最后落定快照；若持久化载体真的
    // 消失，使用插件公开 initGameSession 在存活楼层建新锚，再经正常 CRUD 恢复。
    // 不复制 TavernDB_ACU_IsolatedData 原始帧，避免携带旧楼层序号/旧日志。
    const openingContinuityByChat = Object.create(null);
    function openingContinuityState(chatKey) {
        const key = runtimeScopedChatKey(chatKey);
        if (!openingContinuityByChat[key]) {
            openingContinuityByChat[key] = { armed: false, snapshot: null, expiresAt: 0, recovering: false, attempts: 0, recoveries: 0 };
        }
        return openingContinuityByChat[key];
    }
    function openingChatIsShort() {
        try {
            const ctx = getContextSafe();
            const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
            return chat.length > 0 && chat.length <= 3;
        } catch (e) { return false; }
    }
    function cloneOpeningStat(stat) {
        try {
            const copy = JSON.parse(JSON.stringify(stat || {}));
            if (copy && typeof copy === 'object') delete copy.$internal;
            return copy;
        } catch (e) { return null; }
    }
    function armOpeningContinuity(chatKey, stat) {
        if (!openingChatIsShort()) return;
        const snapshot = cloneOpeningStat(stat);
        if (!snapshot) return;
        const st = openingContinuityState(chatKey);
        st.armed = true;
        st.snapshot = snapshot;
        st.expiresAt = Date.now() + 30 * 60 * 1000;
        st.attempts = 0;
        st.recoveries = 0;
        dbg('[开场连续性] 已记录新建 checkpoint 的最新数据快照。');
    }
    function refreshOpeningContinuityAfterWrite(chatKey, stat) {
        const st = openingContinuityState(chatKey);
        if (!st.armed || Date.now() > st.expiresAt || !openingChatIsShort()) return;
        const snapshot = cloneOpeningStat(stat);
        if (snapshot) {
            st.snapshot = snapshot;
            st.expiresAt = Date.now() + 30 * 60 * 1000;
        }
    }
    async function recoverOpeningContinuity(reason) {
        const session = captureRuntimeSession();
        const chatKey = autoInitChatId();
        const st = openingContinuityState(chatKey);
        // 卡内桥可能先于扩展完成 initGameSession + replaceMvuData，随后原卡立刻 /cut
        // 首楼。此时扩展在 autoInitDatabase 的单次检查中还没来得及 armed，等收到
        // MESSAGE_DELETED 时 checkpoint 已经消失。恢复入口必须能够“迟到接管”桥留下的
        // fresh 标记与候选快照，不能要求 st 事先已 armed。
        try {
            const freshMark = hostWindow.__mvu2shujukuFreshOpeningCheckpoint;
            const candidate = hostWindow.__mvu2shujukuOpeningStatCandidate;
            const freshMatches = !!(freshMark && freshMark.chatKey === chatKey &&
                Date.now() - Number(freshMark.at || 0) < 30 * 60 * 1000);
            const candidateMatches = !!(candidate && candidate.chatKey === chatKey &&
                Date.now() - Number(candidate.at || 0) < 30 * 60 * 1000);
            if (!st.armed && freshMatches && candidateMatches && openingChatIsShort()) {
                const lateSnapshot = cloneOpeningStat(candidate.stat);
                if (lateSnapshot) {
                    armOpeningContinuity(chatKey, lateSnapshot);
                    hostWindow.__mvu2shujukuFreshOpeningCheckpoint = null;
                    dbg('[开场连续性] 已迟到接管卡内桥的新建 checkpoint 快照。');
                }
            }
            if (st.armed && candidate && candidate.chatKey === chatKey && Date.now() - Number(candidate.at || 0) < 30 * 60 * 1000) {
                const adopted = cloneOpeningStat(candidate.stat);
                if (adopted) st.snapshot = adopted;
            }
        } catch (e) {}
        if (!st.armed || st.recovering || !st.snapshot) return;
        if (Date.now() > st.expiresAt || !openingChatIsShort()) { st.armed = false; st.snapshot = null; return; }
        if (!activeLayout || !layoutBelongsToCurrentCard(activeLayoutCardKey)) return;
        // 仍有 full checkpoint，或持久化回放仍能重建出数据，都不应重建。
        if (mvu2shujukuChatHasFullCheckpoint()) return;
        try { if (readPersistedTableData()) return; } catch (e) {}
        const ctx = getContextSafe();
        const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
        if (!chat.some(m => m && !m.is_user)) {
            if (st.attempts++ < 8) hostWindow.setTimeout(() => recoverOpeningContinuity(reason), 350);
            return;
        }
        const api = runtimeApiForSession(getAcuApi(), session);
        const tpl = cachedTemplateForCurrentCard();
        if (!api || typeof api.initGameSession !== 'function' || !tpl) {
            if (st.attempts++ < 8) hostWindow.setTimeout(() => recoverOpeningContinuity(reason), 500);
            return;
        }
        st.recovering = true;
        st.attempts += 1;
        const snapshot = cloneOpeningStat(st.snapshot);
        try {
            dbg('[开场连续性] 检测到 checkpoint 载体消失（' + String(reason || '消息变更') + '），正在存活楼层重建。');
            const ch = currentCharacter();
            const presetName = (characterDisplayName(ch) || '角色') + '模板';
            const initOut = await Promise.resolve(api.initGameSession({}, {
                injectTemplate: true,
                loadPreset: false,
                templateData: tpl,
                templatePresetName: presetName,
            }));
            if (initOut && initOut.success === false) throw new Error(initOut.message || 'initGameSession 失败');
            const ready = await waitRuntimeTablesReady(api, activeLayout, 5000);
            assertRuntimeSession(session);
            if (!ready) throw new Error('数据库运行时未就绪');
            overlayFlushRetries = 0;
            const ok = await scheduleWindowStatOverlay(snapshot, null, false, false, chatKey, session);
            assertRuntimeSession(session);
            if (!ok) throw new Error('开场数据重写未落定');
            st.recoveries += 1;
            st.attempts = 0;
            // 开场可能先 setChatMessage 切到捏人页，最后又 /cut 掉捏人楼。
            // 因此一次恢复后继续保护，直到首次生成结束/超时；最多恢复 3 次。
            if (st.recoveries >= 3) { st.armed = false; st.snapshot = null; }
            dbg('[开场连续性] 已在存活楼层建立新 checkpoint 并恢复开场数据。');
        } catch (e) {
            if (!isRuntimeSessionCurrent(session)) return;
            dbgWarn('[开场连续性] 恢复失败，等待重试:', e && e.message ? e.message : e);
            if (st.attempts < 8) hostWindow.setTimeout(() => recoverOpeningContinuity(reason), 700);
        } finally {
            st.recovering = false;
        }
    }
    function scheduleOpeningContinuityRecovery(reason) {
        hostWindow.setTimeout(() => { recoverOpeningContinuity(reason); }, 80);
        hostWindow.setTimeout(() => { recoverOpeningContinuity(reason); }, 450);
    }
    function disarmOpeningContinuity(chatKey) {
        const st = openingContinuityState(chatKey);
        if (st.recovering) {
            hostWindow.setTimeout(() => disarmOpeningContinuity(chatKey), 1000);
            return;
        }
        st.armed = false;
        st.snapshot = null;
    }

    // 对应 MVU 的 init 时机：进入聊天/收到首条消息时，若卡内有模板且表格缺失则自动建表。
    // 只处理本转换器产出的卡（extensions.mvu2shujuku 标记 + 世界书 __ACU_TEMPLATE_DATA__ 模板），
    // 其余卡一律不动（别的数据库卡也可能带 __ACU_TEMPLATE_DATA__，但不会有我们的独有标记）。
    async function autoInitDatabase() {
        const session = captureRuntimeSession();
        const key0 = autoInitChatId();
        if (autoInitState.running) {
            dbg(' 开局自动建表跳过：上一轮仍在运行（chat=' + key0 + '）');
            return;
        }
        const api = runtimeApiForSession(getAcuApi(), session);
        if (!api) {
            dbg(' 开局自动建表跳过：未找到 SP·数据库 API（chat=' + key0 + '）');
            // 插件可能晚于聊天加载就绪：API 缺失时轮询重试，确保锚点在用户操作前建立
            if (autoInitState.apiRetries < 12) {
                autoInitState.apiRetries += 1;
                hostWindow.setTimeout(autoInitDatabase, 2000);
            }
            return;
        }
        let character = null;
        try { character = currentCharacter(); } catch (e) {}
        if (!character) {
            dbg(' 开局自动建表跳过：当前角色为空（chat=' + key0 + '）');
            return;
        }
        // “完整卡”判定：有世界书（顶层或 data 下）才算完整数据；角色列表懒加载对象
        // 只有 data.extensions{fav,world} 等元数据，不能据此跳过取完整卡。
        const charHasFullData = !!(character && (character.character_book || (character.data && character.data.character_book)));
        if (!isConvertedMvuCard(character)) {
            // 角色列表懒加载时可能只有元数据、缺 extensions：先尝试取完整卡再判断一次；
            // 仍无独有标记说明不是本转换器产物，直接跳过，不碰任何其他卡。
            // 对象已带 extensions 且无标记 = 完整卡且非转换产物，直接跳过，不再发请求。
            try {
                if (!charHasFullData) {
                    const full = await fetchFullCharacter(character, true);
                    if (!isRuntimeSessionCurrent(session)) return;
                    if (full && isConvertedMvuCard(full)) {
                        character = full;
                    } else if (full === null) {
                        // 获取完整卡失败（接口返回异常对象/网络问题），不能判定为非转换卡：
                        // 保留运行时状态并重试，避免把本转换器产物误判成普通卡而跳过建表。
                        dbg(' 开局自动建表：获取完整卡失败，稍后重试（chat=' + key0 + '）');
                        if (autoInitNoEntryRetries < 8) {
                            autoInitNoEntryRetries += 1;
                            hostWindow.setTimeout(autoInitDatabase, 3000);
                        }
                        return;
                    }
                }
                if (!isConvertedMvuCard(character)) {
                    dbg(' 开局自动建表跳过：当前卡无本转换器标记 extensions.mvu2shujuku（chat=' + key0 + '），不影响其他卡');
                    // 清掉上一张转换卡残留的运行时状态，确保切到其他卡后不再接管/广播
                    activeLayout = null;
                    activeLayoutCardKey = '';
                    activePlaceholderNeeded = false;
                    restoreWindowMvuShim();
                    restoreWindowGetAllVariables();
                    return;
                }
            } catch (e) {
                if (!isRuntimeSessionCurrent(session)) return;
                dbg(' 开局自动建表跳过：读取当前卡标记失败（chat=' + key0 + '）');
                activeLayout = null;
                activeLayoutCardKey = '';
                activePlaceholderNeeded = false;
                restoreWindowMvuShim();
                restoreWindowGetAllVariables();
                return;
            }
        }
        let hadWorldbook = true;
        const cb = charWorldBook(character);
        if (!(cb && Array.isArray(cb.entries) && cb.entries.length)) {
            hadWorldbook = false;
            dbg(' 角色列表对象缺世界书，尝试 /api/characters/get 取完整卡（chat=' + key0 + '）');
            try {
                const full = await fetchFullCharacter(character);
                if (!isRuntimeSessionCurrent(session)) return;
                if (full && full.character_book && Array.isArray(full.character_book.entries) && full.character_book.entries.length) {
                    character = full;
                    hadWorldbook = true;
                } else {
                    dbgWarn(' /api/characters/get 未能取回世界书（chat=' + key0 + '）');
                }
            } catch (e) {
                dbgWarn(' /api/characters/get 异常：' + (e && e.message ? e.message : e) + '（chat=' + key0 + '）');
            }
            // 完整卡获取失败（含接口返回异常对象）且当前对象无世界书时，稍后重试，
            // 避免“新聊天没有初始化数据/表格为空”的误判。
            if (!(character && charWorldBook(character) && Array.isArray(charWorldBook(character).entries) && charWorldBook(character).entries.length) &&
                autoInitNoEntryRetries < 8) {
                dbg(' 开局自动建表：完整卡获取失败，稍后重试（chat=' + key0 + '）');
                autoInitNoEntryRetries += 1;
                hostWindow.setTimeout(autoInitDatabase, 3000);
                return;
            }
        }
        if (!isRuntimeSessionCurrent(session)) return;
        const fullCb = charWorldBook(character);
        const entries = fullCb && Array.isArray(fullCb.entries) ? fullCb.entries : [];
        const entry = entries.find(e => Array.isArray(e.keys) && e.keys.indexOf(DB_TEMPLATE_KEY) !== -1);
        if (!entry || !entry.content) {
            dbgWarn(' 未找到 __ACU_TEMPLATE_DATA__ 世界书条目（entries=' + entries.length + '；chat=' + key0 + '）');
            if (!hadWorldbook && autoInitNoEntryRetries < 8) {
                // 懒加载角色列表可能晚于首次触发；轮询重试（4s），最多约 40s
                autoInitNoEntryRetries += 1;
                hostWindow.setTimeout(autoInitDatabase, 4000);
            }
            return;
        }
        autoInitNoEntryRetries = 0;
        // 调试：确认当前卡的 tavern_helper 里到底有没有数据桥
        try {
            const dbgExt = charExtensions(character);
            const th = dbgExt && dbgExt.tavern_helper;
            const scripts = (th && Array.isArray(th.scripts) ? th.scripts : []).map(s => s.name + '(enabled=' + s.enabled + ')');
            dbg(' 当前卡 tavern_helper.scripts =', JSON.stringify(scripts), '| 桥内容长度=' + (th && Array.isArray(th.scripts) && th.scripts.find(s => /数据桥/.test(String(s.name || ''))) ? String((th.scripts.find(s => /数据桥/.test(String(s.name || ''))).content || '')).length : 0));
        } catch (e) {
            dbgWarn(' 读取 tavern_helper 失败:', e);
        }
        // 缓存当前卡布局，供 EJS 数据读取（window.getAllVariables）
        try {
            const layoutExt = charExtensions(character);
            const mk = layoutExt && layoutExt.mvu2shujuku;
            if (mk && typeof mk.layout === 'string') {
                activeLayout = resolveRuntimeLayout(mk.layout);
                // 记录布局归属卡：用“读取时会看到的角色对象”（列表对象，带真实头像）
                let layoutChar = null;
                try { layoutChar = currentCharacter(); } catch (e) {}
                activeLayoutCardKey = cardCacheKey(layoutChar);
                dbg(' 已缓存当前卡布局，条目数=' + (Array.isArray(activeLayout) ? activeLayout.length : 0));
            }
        } catch (e) {
            dbgWarn(' 解析卡布局失败:', e);
        }
        activePlaceholderNeeded = detectPlaceholderFor(character);
        dbg('[占位符] 当前卡依赖状态栏占位符=' + activePlaceholderNeeded);
        installWindowGetAllVariables();
        const key = autoInitChatId();
        if (!isRuntimeSessionCurrent(session)) return;
        if (autoInitState.apiRetries > 0 && autoInitState.anchorChat !== key) autoInitState.apiRetries = 0;
        // 缓存卡内模板（供写路径补行与锚点重建使用）
        try {
            const holder = (typeof window !== 'undefined' ? window : globalThis);
            if (holder) holder.__mvu2shujukuTemplateCache = JSON.parse(mvu2shujukuDecodeB64(entry.content));
            // 归属键用“读取时会看到的角色对象”（列表对象）而不是完整卡 data——
            // full.data 的 avatar 为空，若用它做键，写入时 currentCharacter() 的
            // name|avatar 永远对不上，模板缓存形同虚设，所有写库都会被“无模板缓存”拦掉。
            let cacheChar = null;
            try { cacheChar = currentCharacter(); } catch (e) {}
            if (holder) holder.__mvu2shujukuTemplateCacheFor = cardCacheKey(cacheChar);
            if (holder) holder.__mvu2shujukuTemplateCacheForName = cacheChar ? String(cacheChar.name || '') : '';
        } catch (e) {}
        // 首楼替换（道渊重塑仙缘等）会把插件作用域字段从首楼抹掉，导致插件按 legacy 冻结模板；
        // 每次进入/切回聊天都做一次幂等修复（拷回/改名/重建）。
        repairChatTemplateScope();
        // 对齐参考卡：每个聊天只在“缺表”时初始化一次（下方 ensureInit），
        // 已有表格的聊天绝不重初始化，避免切聊天时误重置别的聊天。
        // 锚点/持久化由插件自己的 initGameSession 与提交管线维护，扩展不做手工锚定。
        if (autoInitState.done === key && autoInitState.doneSession === session.key) return;
        autoInitState.running = true;
        autoInitState.session = session;
        // 看门狗：即使插件 API 的 Promise 意外不返回，也强制复位 running，避免后续自动建表被永久跳过
        const initWatchdog = hostWindow.setTimeout(() => {
            if (autoInitState.running && autoInitState.session === session) {
                autoInitState.running = false;
                console.warn('[mvu2shujuku] 开局自动建表看门狗触发：超过 30s 未完成，已复位（下次触发会重试）。');
            }
        }, 30000);
        try {
            const presetName = (characterDisplayName(character) || '角色') + '模板';
            // 在 ensureInit 前记录：“本次进入前就已有存档”与“本次新建的 checkpoint”
            // 语义不同。前者只能建立分支指纹基线，不能重放开局 initvar。
            const hadFullCheckpointBeforeInit = mvu2shujukuChatHasFullCheckpoint();
            // 新聊天必须把当前开场分支的 initvar / UpdateVariable / JSONPatch 合并进
            // 首次 initGameSession。若先导入基础模板、再用第二次 initGameSession 覆盖，
            // SP 会走 reloadCurrentChatUnsafe：页面像手动刷新前端一样重载，且第二份状态
            // 可能在 SQLite 运行时重建期间丢失。
            let preparedOpening = null;
            if (!hadFullCheckpointBeforeInit) {
                try {
                    let baseTemplate = JSON.parse(mvu2shujukuDecodeB64(entry.content));
                    const macroResult = mvu2shujukuResolveTemplateMacros(baseTemplate, entry.content);
                    if (macroResult && macroResult.ok) {
                        baseTemplate = macroResult.template;
                        const core = window.MVU2SHUJUKU_CORE;
                        if (core && typeof core.statDataFromTables === 'function') {
                            const baseAll = core.statDataFromTables(activeLayout, baseTemplate);
                            const opening = await computeActiveGreetingSnapshot(baseAll);
                            if (!isRuntimeSessionCurrent(session)) return;
                            if (opening) {
                                const finalStat = opening.finalWrap && opening.finalWrap.stat_data
                                    ? opening.finalWrap.stat_data
                                    : opening.baseStat;
                                const mergedTemplate = await buildUpdatedTemplateFromStat(
                                    activeLayout,
                                    opening.baseStat,
                                    finalStat,
                                    baseTemplate,
                                );
                                if (!isRuntimeSessionCurrent(session)) return;
                                if (mergedTemplate && typeof mergedTemplate === 'object') {
                                    preparedOpening = { opening, template: mergedTemplate };
                                    dbg('[开场分支] 已将当前分支的初始化/更新块合并到首次 initGameSession。');
                                }
                            }
                        }
                    }
                } catch (e) {
                    dbgWarn(' 合并当前开场分支到首次初始化失败，将等待后续兼容路径重试:', e);
                }
            }
            if (!isRuntimeSessionCurrent(session)) return;
            const out = await mvu2shujukuEnsureInit(
                api,
                entry.content,
                presetName,
                preparedOpening ? { preparedTemplate: preparedOpening.template } : undefined,
            );
            if (!isRuntimeSessionCurrent(session)) return;
            // 新聊天里的异卡 checkpoint 虽然在调用前“存在”，但已由 ensureInit
            // 安全替换为当前卡模板；后续必须按新初始化处理，不能把首楼更新块登记成历史基线。
            const hadHistoricalCheckpointBeforeInit = hadFullCheckpointBeforeInit &&
                !(out && out.replacedFreshForeignCheckpoint);
            // 后续补行/差异写入也必须使用已解析模板，不能再从原始 base64
            // 缓存取回字面量 <user>。
            if (out && out.template) {
                try {
                    const holder = (typeof window !== 'undefined' ? window : globalThis);
                    if (holder) holder.__mvu2shujukuTemplateCache = out.template;
                } catch (e) {}
            }
            if (out.status === 'error' || out.status === 'partial') {
                console.warn('[mvu2shujuku] 开局自动建表未完全成功：' + out.message);
                autoInitState.done = '';
                // 开场白切换/重渲染可能打断插件初始化；轮询重试直到建表成功（最多约 1 分钟）。
                // 但“表结构不匹配（旧模板）”重导失败时不风暴重试，避免反复执行重型 initGameSession 卡住界面；
                // 下次进入聊天/收到消息时会再尝试一次。
                autoInitState.retries += 1;
                const structureMismatch = String(out.message).indexOf('结构不匹配') !== -1;
                if (!structureMismatch && autoInitState.retries < 15) hostWindow.setTimeout(autoInitDatabase, 4000);
            } else {
                console.log('[mvu2shujuku] 开局自动建表：' + out.message);
                autoInitState.retries = 0;
                autoInitState.done = key;
                autoInitState.doneSession = session.key;
                const greetingState = greetingInitState(key);
                greetingState.ready = true;
                if (preparedOpening && preparedOpening.opening) {
                    greetingState.appliedFp = preparedOpening.opening.fp;
                    greetingState.appliedSourceFp = preparedOpening.opening.sourceFp || '';
                    greetingState.pendingFp = '';
                    greetingState.pendingSourceFp = '';
                    greetingState.pendingAt = 0;
                }
                if (hadHistoricalCheckpointBeforeInit && !greetingState.appliedFp && !greetingState.pendingFp) {
                    greetingState.baselineNext = true;
                }
                // 旧聊天已有数据库状态时，所有现存更新块都是历史，只登记不重放；
                // 新聊天的首楼交给开场合并初始化，初始化时已经存在的其他楼层也不擅自迁移。
                baselineMessageUpdateBlocks(hadHistoricalCheckpointBeforeInit);
                installWindowGetAllVariables();
                installWindowMvuShim();
                installTableUpdateHook();
                // 只有“本次进入时尚无 full checkpoint，刚由初始化新建”才开启
                // 首楼载体连续性保护。重进旧聊天绝不武断恢复开场快照。
                let freshCheckpointFromBridge = false;
                try {
                    const freshMark = hostWindow.__mvu2shujukuFreshOpeningCheckpoint;
                    freshCheckpointFromBridge = !!(freshMark && freshMark.chatKey === key && Date.now() - Number(freshMark.at || 0) < 120000);
                } catch (e) {}
                if ((!hadHistoricalCheckpointBeforeInit || freshCheckpointFromBridge) && mvu2shujukuChatHasFullCheckpoint() && openingChatIsShort()) {
                    try {
                        const initAll = window.getAllVariables ? window.getAllVariables() : { stat_data: {} };
                        armOpeningContinuity(key, initAll && initAll.stat_data ? initAll.stat_data : {});
                        if (freshCheckpointFromBridge) hostWindow.__mvu2shujukuFreshOpeningCheckpoint = null;
                    } catch (e) {}
                }
                // 建表/初始化成功（或聊天已有 checkpoint 跳过）≈ MVU 的 VARIABLE_INITIALIZED 时机。
                // 不能立刻广播：插件回放/物化可能尚未完成，此刻 getAllVariables 可能返回空/旧值，
                // 前端收到后重读会显示默认值并写回。等 stat_data 非空后再派发（见 scheduleDataReadyNotify）。
                scheduleDataReadyNotify();
                // 多分支开场：表格就绪后按当前激活分支注入其 <initvar>（MVU 按分支替换语义）
                hostWindow.setTimeout(applyActiveGreetingInitvar, 300);
                hostWindow.setTimeout(applyPendingMessageUpdateBlocks, 900);
                startGreetingInitvarPoll();
            }
        } catch (e) {
            if (!isRuntimeSessionCurrent(session)) return;
            console.warn('[mvu2shujuku] 开局自动建表异常：' + (e && e.message ? e.message : e));
            autoInitState.done = '';
            autoInitState.retries += 1;
            if (autoInitState.retries < 15) hostWindow.setTimeout(autoInitDatabase, 4000);
        } finally {
            hostWindow.clearTimeout(initWatchdog);
            if (autoInitState.session === session) autoInitState.running = false;
        }
    }

    // 判断角色卡正则是否依赖 <StatusPlaceHolderImpl/>（前端注入占位符）
    function detectPlaceholderFor(character) {
        try {
            // 只有本转换器产物的卡才维护状态栏占位符，其他卡即使正则里碰巧含同名串也不处理
            if (!isConvertedMvuCard(character)) return false;
            const phExt = charExtensions(character);
            const rx = phExt && phExt.regex_scripts;
            if (!Array.isArray(rx)) return false;
            return rx.some(r => String(r.findRegex || '').indexOf('StatusPlaceHolderImpl') !== -1);
        } catch (e) { return false; }
    }

    // 扩展本体复刻 MVU 的占位符维护：AI 回复后若缺少占位符则追加，前端注入正则才能命中每条消息
    let lastPlaceholderMsgKey = '';
    let lastPlaceholderAt = 0;
    let placeholderRetryTimer = null;
    let placeholderRetryCount = 0;
    function findSetChatMessages() {
        try { const context = getContextSafe(); if (context && typeof context.setChatMessages === 'function') return context.setChatMessages.bind(context); } catch (e) {}
        try { if (typeof window.setChatMessages === 'function') return window.setChatMessages; } catch (e) {}
        for (const r of [window, hostWindow]) {
            try { if (r.TavernHelper && typeof r.TavernHelper.setChatMessages === 'function') return r.TavernHelper.setChatMessages.bind(r.TavernHelper); } catch (e) {}
            try { if (typeof r.setChatMessages === 'function') return r.setChatMessages; } catch (e) {}
        }
        return null;
    }
    function ensureWindowStatusPlaceholder() {
        if (!activePlaceholderNeeded) return;
        try {
            const context = getContextSafe();
            if (!context || !Array.isArray(context.chat) || !context.chat.length) {
                return;
            }
            // 生成/流式过程中不追加，避免每次流更新都把占位符覆盖后再补（反复注入）；
            // 若事件触发时 generating 仍为 true 导致错过，1 秒后补一次（最多 10 次），保证收尾必补（MVU 同款语义）
            if (context.generating === true || context.isStreaming === true) {
                if (!placeholderRetryTimer && placeholderRetryCount < 10) {
                    placeholderRetryTimer = hostWindow.setTimeout(() => {
                        placeholderRetryTimer = null;
                        placeholderRetryCount += 1;
                        ensureWindowStatusPlaceholder();
                    }, 1000);
                }
                return;
            }
            placeholderRetryCount = 0;
            const msg = context.chat[context.chat.length - 1];
            if (!msg) return;
            if (msg.is_user || String(msg.name || '') === 'System') return;
            const text = String(msg.mes != null ? msg.mes : (msg.message || ''));
            if (text.indexOf('<StatusPlaceHolderImpl/>') !== -1) return;
            const msgKey = (msg.message_id != null ? msg.message_id : (context.chat.length - 1)) + ':' + text.length;
            const now = Date.now();
            if (msgKey === lastPlaceholderMsgKey && now - lastPlaceholderAt < 5000) return;
            const next = text + '\n\n<StatusPlaceHolderImpl/>';
            const setter = findSetChatMessages();
            if (setter) {
                setter([{ message_id: msg.message_id != null ? msg.message_id : (context.chat.length - 1), message: next, mes: next }], { refresh: 'affected' });
                dbg('[占位符] 已追加到消息 id=' + (msg.message_id != null ? msg.message_id : (context.chat.length - 1)));
            } else {
                // 找不到 setChatMessages：只改内存，不调 saveChat（避免每次保存超时形成风暴）；
                // 落盘依赖酒馆自身保存，显示刷新依赖酒馆重渲染
                msg.mes = next; if (msg.message !== undefined) msg.message = next;
                if (!window.__mvu2shujukuPlaceholderFallbackWarned) {
                    window.__mvu2shujukuPlaceholderFallbackWarned = true;
                    dbgWarn('[占位符] 未找到 setChatMessages，已直接写入内存消息（依赖酒馆下次保存落盘；若前端未刷新请升级酒馆）');
                }
            }
            lastPlaceholderMsgKey = msgKey;
            lastPlaceholderAt = now;
        } catch (e) {
            dbgWarn('[占位符] 追加失败:', e);
        }
    }

    // 数据就绪通知：刷新/重进/切聊天后，前端（尤其整页注入式常驻前端）在插件异步回放完成前
    // 可能已读旧/空数据，而插件加载完成不主动通知前端。这里在 stat_data 非空后分三次广播：
    //   - VARIABLE_INITIALIZED：HypnosisAPP5 等前端在收到它时才会重读 userData 并重渲染；
    //   - VARIABLE_UPDATE_ENDED：刷新主页时钟/成就列表。
    // 用 stat_data 指纹去重：同一份数据只广播一次，数据变化（如回放完成）后再广播。
    function scheduleDataReadyNotify() {
        const dispatch = async () => {
            try {
                if (!activeLayout) return;
                const allR = window.getAllVariables ? window.getAllVariables() : { stat_data: {} };
                const sdR = allR.stat_data || {};
                // “有真实数据”判定：必须存在至少一个非空叶子值。
                // 空壳快照（回放窗口里行表全 {}、单例缺字段）顶层组也有键，
                // 若按“组有键”判定会把它当就绪广播 → 前端反复重读成“暂无/默认值”，
                // 与随后全量快照来回横跳（用户反馈“一直刷然后读不到”）。
                const hasMeaningfulData = (v) => {
                    if (v === undefined || v === null) return false;
                    if (typeof v === 'string') return v !== '';
                    if (typeof v === 'number') return v !== 0;
                    if (typeof v === 'boolean') return v !== false;
                    if (Array.isArray(v)) return v.length > 0;
                    if (typeof v === 'object') {
                        for (const k in v) { if (hasMeaningfulData(v[k])) return true; }
                        return false;
                    }
                    return false;
                };
                let hasData = false;
                for (const g in sdR) {
                    if (hasMeaningfulData(sdR[g])) { hasData = true; break; }
                }
                if (!hasData) return; // 空 stat_data 不广播（避免前端读到空显示默认值）
                // 指纹带聊天标识：进新聊天必广播一次，同聊天内同一份数据不重复广播。
                // 不再在每次调用时重置指纹——CHAT_CHANGED + 建表成功会连续多次调用
                // scheduleDataReadyNotify，旧实现导致同一份数据被反复广播、前端反复重置。
                let chatKey = '';
                try { chatKey = autoInitChatId(); } catch (e) {}
                // 指纹统一用键序无关的 canonical 序列化：写侧广播载荷与 SP 回调反投影
                // 快照的键序不保证一致，原生 stringify 会让同一逻辑状态得到两个不同
                // 指纹而漏拦回声（前端反复刷新）。
                const fp = chatKey + '|' + canonicalJsonForSync(sdR);
                if (fp === reentryNotifyFingerprint) return; // 数据未变化，不重复广播
                reentryNotifyFingerprint = fp;
                dbg('[重读通知] 就绪后 stat_data 快照: ' + JSON.stringify(sdR).slice(0, 160));
                let swipeId = 0;
                try {
                    const cx = getContextSafe();
                    const cc = cx && Array.isArray(cx.chat) ? cx.chat : [];
                    for (let si = cc.length - 1; si >= 0; si--) { if (cc[si] && !cc[si].is_user) { swipeId = Number(cc[si].swipe_id || 0); break; } }
                } catch (e) {}
                emitMvuEvent('mag_variable_initialized', allR, swipeId);
                dispatchVariableUpdateEnded();
                dbg('[重读通知] 已派发 VARIABLE_INITIALIZED + VARIABLE_UPDATE_ENDED 让前端重读最新 stat_data');
            } catch (e) {}
        };
        hostWindow.setTimeout(() => { dispatch(); }, 1500);
        hostWindow.setTimeout(() => { dispatch(); }, 3500);
        hostWindow.setTimeout(() => { dispatch(); }, 6000);
    }

    // 开场白多分支按所选分支注入初始化（MVU 语义：每个 swipe 的 <initvar> 独立替换初始状态）。
    // 转换时只以首个分支为模板基准，这里在开局/换 swipe 时把“当前激活分支”的 <initvar>
    // 写入数据库（覆盖模板初始行），避免多分支状态被合并。
    // 按聊天记录分支初始化状态：大型卡一次差异写入可能超过 2s，
    // 若只在写完后设指纹，2s 轮询会在途中重复提交，使旧回调失效并形成
    // manual_crud → persist → v2-replay 循环。pendingFp 是在途去重，appliedFp 是已落定去重。
    const greetingInitStateByChat = Object.create(null);
    function greetingInitState(chatKey) {
        const key = runtimeScopedChatKey(chatKey);
        if (!greetingInitStateByChat[key]) {
            greetingInitStateByChat[key] = {
                ready: false,
                baselineNext: false,
                appliedFp: '',
                appliedSourceFp: '',
                pendingFp: '',
                pendingSourceFp: '',
                pendingAt: 0,
            };
        }
        pruneChatKeyedObject(greetingInitStateByChat);
        return greetingInitStateByChat[key];
    }
    const greetingMacroCache = Object.create(null);
    function greetingDynamicKeyPaths(layoutEntries) {
        const out = [];
        const add = (p) => {
            if (!Array.isArray(p) || !p.length) return;
            const key = p.join('\u0001');
            if (!out.some(x => x.join('\u0001') === key)) out.push(p.slice());
        };
        for (const L of (Array.isArray(layoutEntries) ? layoutEntries : [])) {
            if (!L) continue;
            if (L.kind === 'rows') {
                for (const p of (Array.isArray(L.writePaths) ? L.writePaths : [])) add(p);
            } else if (L.kind === 'nestedRows') {
                const pp = Array.isArray(L.parentPath) ? L.parentPath : [];
                add(pp);
                add(pp.concat('*', L.childKey || ''));
            }
        }
        return out;
    }
    function messageUpdateBlocks(text) {
        return (String(text || '').match(/<(?:UpdateVariable|JSON_?Patch)\b[^>]*>[\s\S]*?<\/(?:UpdateVariable|JSON_?Patch)>/gi) || []).join('\n');
    }
    // 2s 轮询热点缓存：首楼对象与文本引用未变（编辑/换分支会生成新字符串或新对象）
    // 时直接复用上次快照，避免每 2 秒对长首楼重跑 <initvar>/UpdateVariable 正则。
    let greetingSourceSnapCache = null;
    function activeGreetingSourceSnapshot() {
        const ctx = getContextSafe();
        const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
        const first = chat[0];
        if (!first || first.is_user) return null;
        const text = String(first.mes != null ? first.mes : (first.message || ''));
        let swipeId = '';
        try { swipeId = String(first.swipe_id == null ? 0 : first.swipe_id); } catch (e) {}
        const hit = greetingSourceSnapCache;
        if (hit && hit.first === first && hit.text === text && hit.swipeId === swipeId) return hit.snap;
        const m = text.match(/<initvar>\s*\n?([\s\S]*?)\n?\s*<\/initvar>/i);
        const updateSource = messageUpdateBlocks(text);
        if (!m && !updateSource) {
            // 无 initvar/更新块的首楼也缓存，避免常见卡每 2s 重跑正则后返回 null。
            greetingSourceSnapCache = { first, text, swipeId, snap: null };
            return null;
        }
        const sourceText = (m ? String(m[1]) : 'no-initvar') + '\n' + String(updateSource || '');
        const core = window.MVU2SHUJUKU_CORE;
        const sourceFp = core && typeof core.stableHash === 'function' ? core.stableHash(sourceText) : sourceText;
        const snap = { first, text, m, updateSource, sourceFp: String(sourceFp || '') };
        greetingSourceSnapCache = { first, text, swipeId, snap };
        return snap;
    }
    async function computeActiveGreetingSnapshot(baseAll, sourceSnapshot) {
        const source = sourceSnapshot || activeGreetingSourceSnapshot();
        if (!source) return null;
        const { first, text, m, updateSource, sourceFp } = source;
        const ctx = getContextSafe();
        const core = window.MVU2SHUJUKU_CORE;
        if (!core || (m && typeof core.parseInitVar !== 'function')) return null;
        const currentAll = baseAll && typeof baseAll === 'object'
            ? baseAll
            : (window.getAllVariables ? window.getAllVariables() : { stat_data: {}, display_data: {}, delta_data: {} });
        let parsed = m ? core.parseInitVar(m[1]) : JSON.parse(JSON.stringify(currentAll.stat_data || {}));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        if (m && typeof core.analyzeMvuInitMetadata === 'function') {
            parsed = core.analyzeMvuInitMetadata(parsed).data;
        }
        const macroSource = m ? String(m[1]) : '';
        const macroKey = autoInitChatId() + '|' + (typeof core.stableHash === 'function' ? core.stableHash(macroSource) : macroSource);
        if (m && greetingMacroCache[macroKey]) {
            parsed = JSON.parse(JSON.stringify(greetingMacroCache[macroKey]));
        } else if (/<(?:USER|BOT|CHAR|CHARIFNOTGROUP|GROUP)>/i.test(macroSource) || /\{\{[\s\S]*?\}\}/.test(macroSource)) {
            if (typeof ctx.substituteParams !== 'function' || typeof core.resolveInitDataMacros !== 'function') {
                dbgWarn(' 开场分支含宏，但 SillyTavern substituteParams 尚未就绪，等待重试。');
                return null;
            }
            parsed = core.resolveInitDataMacros(parsed, ctx.substituteParams.bind(ctx), greetingDynamicKeyPaths(activeLayout));
            greetingMacroCache[macroKey] = JSON.parse(JSON.stringify(parsed));
            pruneChatKeyedObject(greetingMacroCache, 128);
        }
        let fp = '';
        try {
            const updateFp = updateSource && typeof core.stableHash === 'function' ? core.stableHash(updateSource) : updateSource;
            fp = (m ? JSON.stringify(parsed) : 'no-initvar') + '|' + String(updateFp || '');
        } catch (e) { fp = ''; }
        let finalWrap = {
            stat_data: parsed,
            display_data: JSON.parse(JSON.stringify(currentAll.display_data || {})),
            delta_data: JSON.parse(JSON.stringify(currentAll.delta_data || {})),
        };
        if (updateSource) {
            finalWrap = await runMvuUpdateCycle(text, finalWrap);
            const updateContext = { variables: finalWrap, message_content: text };
            await emitMvuEvent('mag_before_message_update', updateContext);
            finalWrap = updateContext.variables || finalWrap;
        }
        return { first, text, hasInitvar: !!m, updateSource, sourceFp, fp, baseStat: currentAll.stat_data || {}, finalWrap };
    }

    async function applyActiveGreetingInitvar() {
        const session = captureRuntimeSession();
        let activePendingState = null;
        let activePendingFp = '';
        try {
            const chatKey = autoInitChatId();
            const greetingState = greetingInitState(chatKey);
            if (!greetingState.ready) return;
            // 轮询只负责发现首楼来源是否变化。必须在 runMvuUpdateCycle /
            // mag_before_message_update 之前去重；否则即使最终快照指纹相同，
            // 每 2 秒仍会执行卡脚本并保存聊天，恰好会打断 SP 的自动填表窗口。
            const sourceSnapshot = activeGreetingSourceSnapshot();
            if (!sourceSnapshot) return;
            const sourceFp = sourceSnapshot.sourceFp;
            if (sourceFp && sourceFp === greetingState.appliedSourceFp) return;
            if (sourceFp && sourceFp === greetingState.pendingSourceFp && Date.now() - greetingState.pendingAt < 60000) return;
            greetingState.pendingSourceFp = sourceFp;
            greetingState.pendingAt = Date.now();
            activePendingState = greetingState;
            const prepared = await computeActiveGreetingSnapshot(undefined, sourceSnapshot);
            if (!isRuntimeSessionCurrent(session)) {
                greetingState.pendingSourceFp = '';
                greetingState.pendingAt = 0;
                return;
            }
            if (!prepared) {
                greetingState.pendingSourceFp = '';
                greetingState.pendingAt = 0;
                return;
            }
            const fp = prepared.fp;
            if (greetingState.baselineNext) {
                greetingState.baselineNext = false;
                greetingState.appliedFp = fp;
                greetingState.appliedSourceFp = sourceFp;
                greetingState.pendingFp = '';
                greetingState.pendingSourceFp = '';
                greetingState.pendingAt = 0;
                dbg('[开场分支] 已有 checkpoint，仅建立当前分支指纹基线，不重写存档。');
                return;
            }
            if (fp && fp === greetingState.appliedFp) {
                greetingState.appliedSourceFp = sourceFp;
                greetingState.pendingSourceFp = '';
                greetingState.pendingAt = 0;
                return;
            }
            greetingState.pendingFp = fp;
            activePendingFp = fp;
            const finalStat = (prepared.finalWrap && prepared.finalWrap.stat_data) || prepared.baseStat;
            dbg('[开场分支] 按当前分支注入' + (prepared.hasInitvar ? ' <initvar>' : '') + (prepared.updateSource ? ' <UpdateVariable/JSONPatch>' : '') + '（swipe=' + String(prepared.first.swipe_id == null ? 0 : prepared.first.swipe_id) + '，顶层组 ' + Object.keys(finalStat).join('、') + '）。');
            scheduleWindowStatOverlay(finalStat, (ok) => {
                if (greetingState.pendingFp !== fp) return;
                greetingState.pendingFp = '';
                greetingState.pendingSourceFp = '';
                greetingState.pendingAt = 0;
                if (ok) {
                    greetingState.appliedFp = fp;
                    greetingState.appliedSourceFp = sourceFp;
                }
                else dbgWarn(' 开场分支初始化/更新块注入未落定（写入被丢弃或失败），保留指纹待轮询重试。');
            }, false, true, chatKey, session);
        } catch (e) {
            if (activePendingState && activePendingState.pendingFp === activePendingFp) {
                activePendingState.pendingFp = '';
                activePendingState.pendingSourceFp = '';
                activePendingState.pendingAt = 0;
            }
            dbgWarn(' 开场分支初始化/更新块注入失败:', e);
        }
    }

    // 扩展成为唯一 runtime owner 后，卡内薄桥不再扫描消息更新块；这里接管首楼之后
    // 的 UpdateVariable/JSONPatch。已有 checkpoint 只建立基线，绝不重放历史消息。
    const messageUpdateStateByChat = Object.create(null);
    // 会话级 per-chat 状态随访问聊天数单调增长；按插入序保留最近若干条，被淘汰的
    // 聊天重进时按“新聊天”语义重建基线/指纹（与首次进入一致，无重放风险）。
    const CHAT_STATE_KEEP = 40;
    function pruneChatKeyedObject(store, keep) {
        try {
            const keys = Object.keys(store);
            const limit = keep || CHAT_STATE_KEEP;
            if (keys.length <= limit) return;
            for (let i = 0; i < keys.length - limit; i++) delete store[keys[i]];
        } catch (e) {}
    }
    function pruneOrderedCollection(coll, keep) {
        try {
            const limit = keep || CHAT_STATE_KEEP;
            if (coll instanceof Map || coll instanceof Set) {
                const excess = coll.size - limit;
                if (excess > 0) {
                    const it = coll.keys();
                    for (let i = 0; i < excess; i++) coll.delete(it.next().value);
                }
            }
        } catch (e) {}
    }
    function messageUpdateState(chatKey) {
        const key = runtimeScopedChatKey(chatKey);
        if (!messageUpdateStateByChat[key]) messageUpdateStateByChat[key] = { baselined: false, running: false, processed: new Set(), pending: new Set() };
        pruneChatKeyedObject(messageUpdateStateByChat);
        return messageUpdateStateByChat[key];
    }
    // 指纹缓存：applyPendingMessageUpdateBlocks 被 6 个事件入口反复调度，每次都会
    // 对全部楼层重跑消息正则。楼层对象与其 mes 字符串引用在未编辑/未换 swipe 时不变
    // （编辑会生成新字符串），引用一致即可直接复用上次指纹，把每次事件的开销从
    // O(N×正则) 降为 O(N) 引用比较。WeakMap 随消息对象被丢弃自动回收。
    const messageUpdateFpCache = new WeakMap();
    let messageUpdateObjectSeq = 0;
    function messageUpdateFingerprint(message, index) {
        const text = String(message && (message.mes != null ? message.mes : message.message) || '');
        const swipe = String(message && message.swipe_id == null ? 0 : message.swipe_id);
        let cached = null;
        try { cached = messageUpdateFpCache.get(message); } catch (e) {}
        if (cached && cached.text === text && cached.swipe === swipe && cached.index === index) return cached.fp;
        const blocks = messageUpdateBlocks(text);
        if (!blocks) return '';
        const core = window.MVU2SHUJUKU_CORE;
        const hash = core && typeof core.stableHash === 'function' ? core.stableHash(blocks) : blocks;
        // 同楼重生成可产生完全相同的更新块，但新回复仍需执行；删去前面的楼层
        // 只改变索引，不能使已有回复再次执行。用消息对象身份区分这两种情况。
        const objectId = cached ? cached.objectId : ++messageUpdateObjectSeq;
        const fp = String(objectId) + '|' + swipe + '|' + String(hash);
        try { messageUpdateFpCache.set(message, { text, swipe, index, fp, objectId }); } catch (e) {}
        return fp;
    }
    function baselineMessageUpdateBlocks(includeGreeting) {
        try {
            const chatKey = autoInitChatId();
            const st = messageUpdateState(chatKey);
            const ctx = getContextSafe();
            const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
            for (let i = includeGreeting ? 0 : 1; i < chat.length; i++) {
                if (!chat[i] || chat[i].is_user) continue;
                const fp = messageUpdateFingerprint(chat[i], i);
                if (fp) st.processed.add(fp);
            }
            st.baselined = true;
        } catch (e) {}
    }
    async function applyPendingMessageUpdateBlocks() {
        const session = captureRuntimeSession();
        const chatKey = autoInitChatId();
        const greetingState = greetingInitState(chatKey);
        const st = messageUpdateState(chatKey);
        if (!greetingState.ready || !st.baselined || st.running) return;
        st.running = true;
        try {
            const ctx = getContextSafe();
            const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
            // 首楼由 applyActiveGreetingInitvar 合并为一次初始化；这里只处理后续楼层。
            for (let i = 1; i < chat.length; i++) {
                if (!isRuntimeSessionCurrent(session)) break;
                const message = chat[i];
                if (!message || message.is_user) continue;
                const fp = messageUpdateFingerprint(message, i);
                if (!fp || st.processed.has(fp) || st.pending.has(fp)) continue;
                // 任务不能只绑定聊天：删除、编辑或切换来源消息后，旧更新块也必须失效。
                // 同一守卫贯穿事件 await、合并窗口、重试以及每次实际数据库调用。
                const messageSession = captureRuntimeSession(() => {
                    const currentChat = getContextSafe().chat;
                    return Array.isArray(currentChat) && currentChat[i] === message &&
                        messageUpdateFingerprint(message, i) === fp;
                });
                messageSession.messageUpdate = true;
                const text = String(message.mes != null ? message.mes : (message.message || ''));
                st.pending.add(fp);
                let settled = false;
                try {
                    const current = window.getAllVariables ? window.getAllVariables() : { stat_data: {}, display_data: {}, delta_data: {} };
                    const nextWrap = await runMvuUpdateCycle(text, current);
                    assertRuntimeSession(messageSession);
                    const updateContext = { variables: nextWrap, message_content: text };
                    await emitMvuEvent('mag_before_message_update', updateContext);
                    assertRuntimeSession(messageSession);
                    const finalWrap = updateContext.variables || nextWrap;
                    const beforeJson = JSON.stringify(current.stat_data || {});
                    const afterJson = JSON.stringify((finalWrap && finalWrap.stat_data) || {});
                    if (beforeJson === afterJson) {
                        settled = true;
                    } else {
                        settled = await new Promise((resolve) => {
                            scheduleWindowStatOverlay(finalWrap.stat_data || {}, (ok) => resolve(!!ok), false, false, chatKey, messageSession);
                        });
                    }
                } catch (e) {
                    dbgWarn('[消息更新块] 第 ' + i + ' 楼执行失败:', e);
                }
                st.pending.delete(fp);
                if (settled) st.processed.add(fp);
                else break; // 数据库尚未落定，保留后续顺序并等待下次事件重试
            }
        } finally {
            st.running = false;
        }
    }

    // 前端开场白用 setChatMessages/setChatMessage 切换分支时，可能不触发 MESSAGE_SWIPED。
    // 包一层这两个接口：首楼内容变化后自动按新分支注入初始化（applyActiveGreetingInitvar
    // 用内容指纹去重，重复触发无副作用）。
    let greetingWatcherInstalled = false;
    function installGreetingSwipeWatcher() {
        if (greetingWatcherInstalled) return;
        greetingWatcherInstalled = true;
        const wrap = (orig, host, key) => {
            if (typeof orig !== 'function') return orig;
            if (orig.__mvu2shujukuWrapped) return orig;
            const wrapped = async function (...args) {
                try { return await orig.apply(host || this, args); }
                finally {
                    hostWindow.setTimeout(applyActiveGreetingInitvar, 250);
                    hostWindow.setTimeout(applyPendingMessageUpdateBlocks, 500);
                }
            };
            try { wrapped.__mvu2shujukuWrapped = true; } catch (e) {}
            return wrapped;
        };
        try {
            const ctx = getContextSafe();
            if (ctx && typeof ctx.setChatMessages === 'function') {
                ctx.setChatMessages = wrap(ctx.setChatMessages, ctx, 'setChatMessages');
            }
        } catch (e) {}
        try {
            const ctx = getContextSafe();
            if (ctx && typeof ctx.setChatMessage === 'function') {
                ctx.setChatMessage = wrap(ctx.setChatMessage, ctx, 'setChatMessage');
            }
        } catch (e) {}
        for (const w of [window, hostWindow]) {
            try {
                if (w && typeof w.setChatMessages === 'function') w.setChatMessages = wrap(w.setChatMessages, w, 'setChatMessages');
            } catch (e) {}
            try {
                if (w && typeof w.setChatMessage === 'function') w.setChatMessage = wrap(w.setChatMessage, w, 'setChatMessage');
            } catch (e) {}
        }
    }

    // 兜底：前端开场白可能在任何 iframe/窗口里改写首楼（不一定走我们包装的 setChatMessages）。
    // 轻量轮询首楼 <initvar> 内容指纹，变化即重新注入（applyActiveGreetingInitvar 幂等）。
    let greetingPollTimer = null;
    function startGreetingInitvarPoll() {
        if (greetingPollTimer) return;
        greetingPollTimer = hostWindow.setInterval(() => {
            try {
                if (!activeLayout) return;
                applyActiveGreetingInitvar();
            } catch (e) {}
        }, 2000);
    }

    function bindAutoInit(context) {
        installGreetingSwipeWatcher();
        const es = context && (context.eventSource || context.event_source);
        const et = context && (context.event_types || context.eventTypes);
        if (!es || !et || typeof es.on !== 'function') return;
        try {
            if (!autoInitState.inited) {
                es.on(et.CHAT_CHANGED, () => {
                    const session = captureRuntimeSession();
                    if (autoInitState.session && !isRuntimeSessionCurrent(autoInitState.session)) {
                        autoInitState.running = false;
                        autoInitState.session = null;
                    }
                    cancelChatMutationFrontendSync();
                    autoInitState.retries = 0;
                    // 上一聊天的待写快照不允许落入新聊天：重试链携带原始 key 会被归属
                    // 守卫丢弃，但 150ms 合并窗口内的 pending 状态与挂起的 flush Promise
                    // 也要一并作废，前端 getMvuData 不再读到旧聊天快照。
                    try {
                        if (pendingStatWriteSession && !isRuntimeSessionCurrent(pendingStatWriteSession)) {
                            discardPendingStatWrite();
                        }
                    } catch (e) {}
                    hostWindow.setTimeout(autoInitDatabase, 600);
                    // 刷新/重进/切聊天后：前端可能已读旧数据，而插件加载完成不主动通知前端；
                    // 等数据就绪后派发 VARIABLE_INITIALIZED（前端会重读 userData）+
                    // VARIABLE_UPDATE_ENDED（刷新时钟），覆盖插件异步加载时序。
                    // 每次进入/切换聊天重置指纹：状态栏 iframe 会重建并先读一次（可能赶上
                    // 插件回放窗口读到空），若数据与上次进入相同且指纹不清零，这次进入将
                    // 不再广播、前端永远停在空读。重置后本进入内首次真实数据必广播一次，
                    // 同一次进入内的多次 scheduleDataReadyNotify 调用仍靠指纹去重（不刷屏）。
                    // 防抖：同一聊天 5 秒内的重复 CHAT_CHANGED（第三方/卡脚本误触发假切换）
                    // 不再重置指纹——否则每次假切换都重发重读通知 → 状态栏反复重渲染（一直刷）。
                    let chatIdNow2 = '';
                    try { chatIdNow2 = autoInitChatId(); } catch (e) {}
                    const chatChangedAt = Date.now();
                    if (lastNotifyResetChat !== chatIdNow2 || chatChangedAt - lastNotifyResetAt > 5000) {
                        reentryNotifyFingerprint = '';
                        lastNotifyResetChat = chatIdNow2;
                        lastNotifyResetAt = chatChangedAt;
                    }
                    scheduleDataReadyNotify();
                    // 切卡后按新卡同步运行时：转换卡接管，其他卡撤销，确保不影响别的卡
                    syncRuntimeForCurrentCard();
                    activePlaceholderNeeded = detectPlaceholderFor(currentCharacter());
                    hostWindow.setTimeout(ensureWindowStatusPlaceholder, 1200);
                    const p = hostDocument.getElementById(PANEL_ID);
                    if (p) populateMergeSource(p);
                });
                es.on(et.MESSAGE_RECEIVED, () => {
                    hostWindow.setTimeout(autoInitDatabase, 600);
                    hostWindow.setTimeout(applyPendingMessageUpdateBlocks, 900);
                    scheduleOpeningContinuityRecovery('MESSAGE_RECEIVED');
                    scheduleChatMutationFrontendSync(et.MESSAGE_RECEIVED);
                    // 复刻 MVU：AI 回复后追加状态栏占位符。稍后执行，让卡内
                    // MESSAGE_RECEIVED 动态正则先完成注册/重载；否则此处 setChatMessages
                    // 会与 Ticket/<ellia> 等首次显示正则竞争，把原始标签重新渲染出来。
                    hostWindow.setTimeout(ensureWindowStatusPlaceholder, 1200);
                });
                if (et.MESSAGE_SENT && typeof et.MESSAGE_SENT === 'string') {
                    es.on(et.MESSAGE_SENT, () => {
                        // 用户楼也可能承载插件持久化帧，或触发卡内脚本改表；普通 API
                        // 回调仍是主通道，这里只负责回调缺失时的前后快照兜底。
                        scheduleChatMutationFrontendSync(et.MESSAGE_SENT);
                    });
                }
                // 开场白切换/首楼换 swipe：只补建表/占位符（锚点由插件自身管理）
                for (const evName of [et.MESSAGE_SWIPED, et.MESSAGE_UPDATED, et.MESSAGE_EDITED]) {
                    if (evName && typeof evName === 'string') {
                        es.on(evName, () => {
                            hostWindow.setTimeout(autoInitDatabase, 300);
                            hostWindow.setTimeout(applyActiveGreetingInitvar, 1200);
                            hostWindow.setTimeout(applyPendingMessageUpdateBlocks, 1500);
                            scheduleOpeningContinuityRecovery(evName);
                            scheduleChatMutationFrontendSync(evName, evName === et.MESSAGE_SWIPED);
                        });
                    }
                }
                if (et.MESSAGE_DELETED && typeof et.MESSAGE_DELETED === 'string') {
                    es.on(et.MESSAGE_DELETED, () => {
                        // 删楼会改变写入基线与承载楼，旧合并窗口中的写入全部取消。
                        if (pendingStatWriteSession) discardPendingStatWrite();
                        scheduleOpeningContinuityRecovery(et.MESSAGE_DELETED);
                        // 删楼不是普通 CRUD，而是 SP 按剩余聊天历史异步回放表格。
                        // 部分 SP 版本/重载时序不会把这次变化可靠送到外部回调，独立等待
                        // 回放后的完整快照并补发，不能在删除事件到达时读取旧运行时。
                        scheduleChatMutationFrontendSync(et.MESSAGE_DELETED, true);
                    });
                }
                if (et.GENERATION_ENDED) {
                    es.on(et.GENERATION_ENDED, () => {
                        hostWindow.setTimeout(ensureWindowStatusPlaceholder, 1200);
                        hostWindow.setTimeout(autoInitDatabase, 100);
                        hostWindow.setTimeout(applyPendingMessageUpdateBlocks, 300);
                        // 某些卡的 /cut 与生成启动紧邻，删除事件的恢复任务可能仍在排队。
                        // 先做最后一次连续性检查，待恢复进入执行阶段后再解除保护。
                        const endingChatKey = autoInitChatId();
                        scheduleOpeningContinuityRecovery('GENERATION_ENDED');
                        scheduleChatMutationFrontendSync(et.GENERATION_ENDED);
                        hostWindow.setTimeout(() => {
                            try {
                                const endingState = openingContinuityState(endingChatKey);
                                if (endingState.recovering) {
                                    hostWindow.setTimeout(() => disarmOpeningContinuity(endingChatKey), 1200);
                                } else {
                                    disarmOpeningContinuity(endingChatKey);
                                }
                            } catch (e) {}
                        }, 1200);
                    });
                }
                autoInitState.inited = true;
            }
        } catch (e) {}
    }

    function getHostWindow(...args) { return stAdapter.getHostWindow(...args); }
    const hostWindow = getHostWindow();
    const hostDocument = hostWindow.document || document;
    // 扩展是唯一运行时 owner。新卡内桥只把卡级模板/layout 注册到这里，
    // 不再自行安装第二套 Mvu、事件和写库状态机。
    const runtimeRegistry = (() => {
        let existing = null;
        try { existing = hostWindow.__mvu2shujukuRuntime; } catch (e) {}
        const pending = existing && Array.isArray(existing.pending) ? existing.pending.slice() : [];
        const reg = {
            owner: 'extension',
            version: (window.MVU2SHUJUKU_CORE && window.MVU2SHUJUKU_CORE.VERSION) || 'unknown',
            pending,
            _handler: null,
            registerCard(payload) {
                if (!payload || typeof payload !== 'object') return false;
                if (typeof reg._handler === 'function') return !!reg._handler(payload);
                const sig = String(payload.cardName || '') + '|' + String(payload.cardAvatar || '') + '|' + String(payload.bridgeVersion || '');
                if (!reg.pending.some(p => p && p.__sig === sig)) {
                    try { Object.defineProperty(payload, '__sig', { value: sig, enumerable: false }); } catch (e) { payload.__sig = sig; }
                    reg.pending.push(payload);
                }
                return true;
            },
        };
        try { hostWindow.__mvu2shujukuRuntime = reg; } catch (e) {}
        try { window.__mvu2shujukuRuntime = reg; } catch (e) {}
        // 先同步封住旧桥的新调用、撤销旧全局，再等待已发出的宿主调用结束。
        // 在等待期间新薄桥仍可排队，但扩展尚不安装自己的事件和写入入口。
        const bridges = Array.isArray(hostWindow.__mvu2shujukuLegacyBridges)
            ? hostWindow.__mvu2shujukuLegacyBridges.splice(0) : [];
        const draining = [];
        for (const bridge of bridges) {
            if (!bridge || typeof bridge.stop !== 'function') continue;
            try {
                draining.push(Promise.resolve(bridge.stop()));
                reg.registerCard(bridge.payload);
            } catch (error) { draining.push(Promise.reject(error)); }
        }
        reg.ready = draining.length ? Promise.all(draining) : null;
        return reg;
    })();

    function getContextSafe(...args) { return stAdapter.getContextSafe(...args); }

    function resolveRuntimeLayout(rawLayout) {
        const parsed = typeof rawLayout === 'string'
            ? JSON.parse(rawLayout)
            : JSON.parse(JSON.stringify(Array.isArray(rawLayout) ? rawLayout : []));
        const core = window.MVU2SHUJUKU_CORE;
        try {
            const context = getContextSafe();
            if (core && typeof core.resolveLayoutMacros === 'function' && context && typeof context.substituteParams === 'function') {
                return core.resolveLayoutMacros(parsed, context.substituteParams.bind(context));
            }
        } catch (e) {
            dbgWarn(' 解析 layout 运行时宏失败，暂用原逻辑路径:', e && e.message ? e.message : e);
        }
        return parsed;
    }

    // 查找 SP·数据库 插件暴露的 window.AutoCardUpdaterAPI（兼容 iframe/顶层窗口）
    function getAcuApi() {
        const roots = [];
        const add = (r) => { try { if (r && roots.indexOf(r) === -1) roots.push(r); } catch (e) {} };
        add(window);
        try { add(window.parent); } catch (e) {}
        try { add(window.top); } catch (e) {}
        for (const r of roots) {
            try {
                const a = r.AutoCardUpdaterAPI;
                if (a && typeof a.importTemplateFromData === 'function') return a;
            } catch (e) {}
        }
        return null;
    }

    function getSettings() {
        const context = getContextSafe();
        if (!context.extensionSettings) context.extensionSettings = {};
        if (!context.extensionSettings[SETTINGS_KEY]) {
            context.extensionSettings[SETTINGS_KEY] = {
                mode: 'both',
                installMvuShim: 'auto',
                appendPlaceholder: true,
                asPng: 'auto',
                ddlIncludeCheck: true,
                translateSimpleEjs: false,
                debug: false,
            };
        }
        const settings = context.extensionSettings[SETTINGS_KEY];
        if (!settings.conversionProfiles || typeof settings.conversionProfiles !== 'object' || Array.isArray(settings.conversionProfiles)) {
            settings.conversionProfiles = {};
        }
        return settings;
    }

    function saveSettings() {
        try {
            const context = getContextSafe();
            if (typeof context.saveSettingsDebounced === 'function') context.saveSettingsDebounced();
            else if (typeof context.saveSettings === 'function') context.saveSettings();
        } catch (e) {}
    }

    function toast(message, type) {
        try {
            if (hostWindow.toastr && typeof hostWindow.toastr[type || 'info'] === 'function') {
                hostWindow.toastr[type || 'info'](message, 'MVU转数据库');
                return;
            }
        } catch (e) {}
        console.log('[mvu2shujuku][' + (type || 'info') + ']', message);
    }

    function download(name, mime, data) {
        let blob;
        if (typeof data === 'string') blob = new Blob([data], { type: mime });
        else blob = new Blob([data], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = hostDocument.createElement('a');
        a.href = url;
        a.download = name;
        hostDocument.body.appendChild(a);
        a.click();
        hostDocument.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    function currentCharacter(...args) { return stAdapter.currentCharacter(...args); }

    function characterOptionKey(ch) {
        if (!ch) return '';
        return String(ch.avatar || (ch.data && ch.data.avatar) || '') + '|' + characterDisplayName(ch);
    }

    function currentCharacterListFingerprint(context) {
        const chars = context && Array.isArray(context.characters) ? context.characters : [];
        return chars.map(characterOptionKey).join('\n');
    }

    function populateCharacterSelect(panel) {
        const sel = panel.querySelector('#mvu2shujuku-char-select');
        if (!sel) return;
        const context = getContextSafe();
        const chars = Array.isArray(context.characters) ? context.characters : [];
        const currentIdx = context.characterId != null ? context.characterId : -1;
        const prevValue = sel.value;
        const previousChars = Array.isArray(panel.__mvu2shujukuChars) ? panel.__mvu2shujukuChars : [];
        const previousCharacter = prevValue !== '' && prevValue !== '-1' ? previousChars[Number(prevValue)] : null;
        const previousKey = characterOptionKey(previousCharacter);
        panel.__mvu2shujukuChars = chars;
        panel.__mvu2shujukuCurrentIdx = currentIdx;
        characterListFingerprint = currentCharacterListFingerprint(context);
        const searchBox = panel.querySelector('#mvu2shujuku-char-search');
        const keyword = searchBox ? String(searchBox.value || '').trim().toLowerCase() : '';
        sel.innerHTML = '';
        const filtered = keyword
            ? chars.map((ch, i) => ({ ch, i })).filter(({ ch }) => String(ch && ch.name || '').toLowerCase().includes(keyword))
            : chars.map((ch, i) => ({ ch, i }));
        if (!filtered.length) {
            const opt = hostDocument.createElement('option');
            opt.value = '-1';
            opt.textContent = keyword ? '（无匹配角色）' : '（角色列表为空）';
            sel.appendChild(opt);
            return;
        }
        filtered.forEach(({ ch, i }) => {
            const opt = hostDocument.createElement('option');
            opt.value = String(i);
            opt.textContent = (ch && ch.name) ? ch.name : ('角色 ' + i);
            sel.appendChild(opt);
        });
        // 列表增删会改变数组下标：按 avatar+名称保留原选择，不按旧下标误选其他卡。
        const same = previousKey ? filtered.find(f => characterOptionKey(f.ch) === previousKey) : null;
        if (same) sel.value = String(same.i);
        else if (currentIdx >= 0 && filtered.some(f => f.i === currentIdx)) sel.value = String(currentIdx);
        else if (filtered.length) sel.value = String(filtered[0].i);
    }

    function startCharacterListRefresh(panel) {
        if (characterRefreshTimer) return;
        const tick = () => {
            characterRefreshTimer = null;
            try {
                if (!hostDocument.getElementById(PANEL_ID)) return;
                const context = getContextSafe();
                const next = currentCharacterListFingerprint(context);
                if (next !== characterListFingerprint) populateCharacterSelect(panel);
            } catch (e) {}
            characterRefreshTimer = hostWindow.setTimeout(tick, 2500);
        };
        characterRefreshTimer = hostWindow.setTimeout(tick, 2500);
    }

    function selectedCharacter(panel) {
        const sel = panel && panel.querySelector('#mvu2shujuku-char-select');
        if (sel && sel.value !== '' && sel.value !== '-1') {
            const idx = Number(sel.value);
            const context = getContextSafe();
            if (context.characters && context.characters[idx]) return context.characters[idx];
        }
        return currentCharacter();
    }

    // 酒馆开启 lazyLoadCharacters 时，角色列表对象只有元数据（无世界书）。
    // 通过 /api/characters/get 按头像取完整卡数据。
    async function fetchFullCharacter(character) {
        if (!character) return null;
        const cb = charWorldBook(character);
        // 非强制时：角色对象已有世界书即视为完整，避免无谓请求
        if (!arguments[1] && cb && Array.isArray(cb.entries) && cb.entries.length) return character;
        dbg('按完整卡校验转换标记' + (arguments[1] ? '（角色列表对象缺 extensions）' : '（缺世界书）') + '，尝试 /api/characters/get 取完整卡。avatar=', character.avatar, 'name=', character && character.name);
        try {
            const context = getContextSafe();
            const headers = typeof context.getRequestHeaders === 'function' ? context.getRequestHeaders() : {};
            const res = await fetch('/api/characters/get', {
                method: 'POST',
                headers,
                body: JSON.stringify({ avatar_url: character.avatar }),
            });
                dbg('/api/characters/get 状态:', res.status);
            if (res.ok) {
                const full = await res.json();
                const target = full && full.data && typeof full.data.name === 'string' ? full.data : full;
                dbg('完整卡对象 keys:', Object.keys(full || {}).join(','), '| character_book.entries=', target && target.character_book && Array.isArray(target.character_book.entries) ? target.character_book.entries.length : 'N/A');
                // 世界书为空不代表卡不完整：初始化可能全部位于问候语。同时保留列表
                // 对象的身份，不能把 full.data 缺 avatar 转化为全局“按同名匹配”。
                if (target && typeof target.name === 'string' &&
                    (typeof target.first_mes === 'string' || (target.character_book && Array.isArray(target.character_book.entries) && target.character_book.entries.length))) {
                    return Object.assign({}, target, { avatar: character.avatar || (full && full.avatar) || target.avatar || '' });
                }
                // 接口返回了异常对象（如 {mode,baseHash,nextHash,ops} 哈希差异、空对象等），
                // 不能当作“完整卡”，否则会把本转换器产物误判为非转换卡而跳过建表。
                // 返回 null 让调用方区分“获取失败（可重试）”与“确实非转换卡”。
                dbgWarn('/api/characters/get 响应缺少角色卡结构（keys=' + Object.keys(full || {}).join(',') + '），本次视为获取失败，稍后可重试。');
                return null;
            }
        } catch (e) {}
        // 请求失败也返回 null：调用方需要明确“没拿到完整卡”，不能把它当非转换卡处理
        return null;
    }

    function readFileAsBytes(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(new Uint8Array(reader.result));
            reader.onerror = reject;
            reader.readAsArrayBuffer(file);
        });
    }

    let lastResult = null;
    let lastInput = null;
    const mergeState = { sourceTemplate: null, source: '', appliedRefs: [] };
    let activeProfileName = '';
    let activeProfileAppliedToLastResult = false;
    let characterListFingerprint = '';
    let characterRefreshTimer = null;
    let activeLayout = null;
    // activeLayout 归属的卡（卡名|头像）：切卡空窗期用旧卡布局读新卡表格会产生错形状数据，
    // 读路径与写路径都以它为门槛，布局未就绪时返回空/重试
    let activeLayoutCardKey = '';
    // 当前卡是否依赖 <StatusPlaceHolderImpl/>（前端注入正则）；由扩展本体维护占位符，
    // 不依赖 tavern_helper 桥是否运行
    let activePlaceholderNeeded = false;

    function conversionProfiles() {
        return getSettings().conversionProfiles;
    }

    function originalResultName(result) {
        try {
            const d = result && result.card && (result.card.data || result.card);
            const marker = d && d.extensions && d.extensions.mvu2shujuku;
            return String(marker && marker.originalName || d && d.name || '角色').replace(/_数据库$/, '').trim() || '角色';
        } catch (e) { return '角色'; }
    }

    function populateProfileSelect(panel) {
        const sel = panel && panel.querySelector('#mvu2shujuku-profile-select');
        if (!sel) return;
        const profiles = conversionProfiles();
        const wanted = activeProfileName || sel.value || '';
        sel.innerHTML = '';
        const none = hostDocument.createElement('option');
        none.value = '';
        none.textContent = '（不使用已有配置）';
        sel.appendChild(none);
        Object.keys(profiles).sort((a, b) => a.localeCompare(b, 'zh-CN')).forEach(name => {
            const opt = hostDocument.createElement('option');
            opt.value = name;
            opt.textContent = name;
            sel.appendChild(opt);
        });
        sel.value = Object.prototype.hasOwnProperty.call(profiles, wanted) ? wanted : '';
        activeProfileName = sel.value;
        const del = panel.querySelector('#mvu2shujuku-profile-delete');
        if (del) del.disabled = !activeProfileName;
    }

    function sheetFingerprint(sheet) {
        const core = window.MVU2SHUJUKU_CORE;
        return core && typeof core.stableHash === 'function' ? core.stableHash(sheet) : JSON.stringify(sheet || {});
    }

    async function readTemplateSource(source) {
        const sourceValue = typeof source === 'string' ? source : String(source && source.value || '');
        const api = getAcuApi();
        if (!api || typeof api.getTableTemplate !== 'function') return null;
        if (sourceValue === 'default') {
            try {
                const res = await fetch('/TavernDB_template_默认模板.json');
                if (res.ok) {
                    const tpl = await res.json();
                    return tpl && typeof tpl === 'object' ? tpl : null;
                }
            } catch (e) {}
            return null;
        }
        let scope = sourceValue === 'chat' ? 'chat' : 'global';
        let presetName = '';
        if (sourceValue.indexOf('preset:') === 0) presetName = sourceValue.slice(7);
        try { return api.getTableTemplate({ scope, presetName }) || null; } catch (e) { return null; }
    }

    function captureConversionProfile(name) {
        const tableConfigs = {};
        for (const { sheet } of updateParamSheetRows(lastResult || { template: {} })) {
            const cfg = {};
            for (const option of UPDATE_PARAM_OPTIONS) cfg[option.key] = getUpdateParam(sheet, option.key);
            tableConfigs[String(sheet.name || '')] = cfg;
        }
        return {
            format: 'mvu2shujuku-conversion-profile',
            version: 1,
            name,
            tableConfigs,
            externalTables: JSON.parse(JSON.stringify(mergeState.appliedRefs || [])),
            updatedAt: new Date().toISOString(),
        };
    }

    async function autoSaveConversionProfile() {
        if (!lastResult) return false;
        const profiles = conversionProfiles();
        // 选中了配置但本次匹配校验被用户拒绝时，绝不覆盖该配置。
        let name = activeProfileAppliedToLastResult ? activeProfileName : '';
        if (!name) {
            name = originalResultName(lastResult);
            if (Object.prototype.hasOwnProperty.call(profiles, name)) {
                const replace = hostWindow.confirm('已存在同名转换配置「' + name + '」。\n\n确定：替换已有配置\n取消：重命名后保存');
                if (!replace) {
                    let suggested = name + ' (2)';
                    let n = 2;
                    while (Object.prototype.hasOwnProperty.call(profiles, suggested)) suggested = name + ' (' + (++n) + ')';
                    const renamed = hostWindow.prompt('请输入新的配置名称：', suggested);
                    if (renamed === null) return false;
                    name = String(renamed || '').trim();
                    if (!name) return false;
                    if (Object.prototype.hasOwnProperty.call(profiles, name)) {
                        toast('配置名称仍已存在，本次未保存配置', 'error');
                        return false;
                    }
                }
            }
        }
        const nextProfile = captureConversionProfile(name);
        const previous = profiles[name];
        const unchanged = previous && JSON.stringify({
            tableConfigs: previous.tableConfigs || {},
            externalTables: previous.externalTables || [],
        }) === JSON.stringify({
            tableConfigs: nextProfile.tableConfigs,
            externalTables: nextProfile.externalTables,
        });
        if (unchanged) {
            activeProfileName = name;
            activeProfileAppliedToLastResult = true;
            populateProfileSelect(hostDocument.getElementById(PANEL_ID));
            return true;
        }
        profiles[name] = nextProfile;
        activeProfileName = name;
        activeProfileAppliedToLastResult = true;
        saveSettings();
        populateProfileSelect(hostDocument.getElementById(PANEL_ID));
        toast('已自动保存转换配置：' + name, 'success');
        return true;
    }

    async function applySelectedProfile(template) {
        if (!activeProfileName) return { template, notes: [], applied: false, summary: '' };
        const profile = conversionProfiles()[activeProfileName];
        if (!profile) return { template, notes: [], applied: false, summary: '' };
        const baseTemplate = JSON.parse(JSON.stringify(template || {}));
        let next = JSON.parse(JSON.stringify(baseTemplate));
        const notes = [];
        const configs = profile.tableConfigs || {};
        const configNames = Object.keys(configs).filter(Boolean);
        const newTableNames = Object.keys(next).filter(k => k.startsWith('sheet_')).map(k => String(next[k] && next[k].name || '')).filter(Boolean);
        const matchedConfigNames = configNames.filter(name => newTableNames.indexOf(name) >= 0);
        const missingConfigNames = configNames.filter(name => newTableNames.indexOf(name) < 0);
        const addedTableNames = newTableNames.filter(name => configNames.indexOf(name) < 0);
        for (const key of Object.keys(next).filter(k => k.startsWith('sheet_'))) {
            const sheet = next[key];
            const cfg = sheet && configs[String(sheet.name || '')];
            if (!cfg) continue;
            for (const option of UPDATE_PARAM_OPTIONS) {
                if (Object.prototype.hasOwnProperty.call(cfg, option.key)) setUpdateParam(sheet, option.key, cfg[option.key]);
            }
        }
        mergeState.appliedRefs = [];
        const refsBySource = new Map();
        for (const ref of Array.isArray(profile.externalTables) ? profile.externalTables : []) {
            const value = String(ref && ref.source && ref.source.value || '');
            if (!value) continue;
            if (!refsBySource.has(value)) refsBySource.set(value, []);
            refsBySource.get(value).push(ref);
        }
        const core = window.MVU2SHUJUKU_CORE;
        let externalRequested = 0;
        let externalAdded = 0;
        let externalProblems = 0;
        for (const [sourceValue, refs] of refsBySource) {
            externalRequested += refs.length;
            const sourceTemplate = await readTemplateSource(sourceValue);
            if (!sourceTemplate) { notes.push('来源不可用：' + sourceValue); externalProblems += refs.length; continue; }
            const selected = [];
            const resolvedRefs = [];
            for (const ref of refs) {
                let uid = String(ref.uid || '');
                let sheet = uid && sourceTemplate[uid];
                if (!sheet || String(sheet.name || '') !== String(ref.name || '')) {
                    const matches = Object.keys(sourceTemplate).filter(k => k.startsWith('sheet_') && sourceTemplate[k] && String(sourceTemplate[k].name || '') === String(ref.name || ''));
                    if (matches.length !== 1) { notes.push('未找到外部表：' + ref.name); externalProblems++; continue; }
                    uid = matches[0];
                    sheet = sourceTemplate[uid];
                }
                selected.push(uid);
                const latest = { source: { value: sourceValue }, uid, name: String(sheet.name || uid), fingerprint: sheetFingerprint(sheet) };
                resolvedRefs.push(latest);
                if (ref.fingerprint && ref.fingerprint !== latest.fingerprint) notes.push('来源已更新：' + latest.name);
            }
            if (selected.length) {
                const merged = core.mergeTemplates(next, sourceTemplate, selected);
                next = merged.template;
                for (const ref of resolvedRefs) {
                    if (merged.added.indexOf(ref.name) >= 0) { mergeState.appliedRefs.push(ref); externalAdded++; }
                    else { notes.push('同名冲突已跳过：' + ref.name + '（' + sourceValue + '）'); externalProblems++; }
                }
            }
        }
        // 外部表并入后再应用一次参数，保留用户对已合并表做的自动化调整。
        for (const key of Object.keys(next).filter(k => k.startsWith('sheet_'))) {
            const sheet = next[key];
            const cfg = sheet && configs[String(sheet.name || '')];
            if (!cfg) continue;
            for (const option of UPDATE_PARAM_OPTIONS) {
                if (Object.prototype.hasOwnProperty.call(cfg, option.key)) setUpdateParam(sheet, option.key, cfg[option.key]);
            }
        }
        const summaryLines = [
            '配置：' + activeProfileName,
            '自动化参数匹配：' + matchedConfigNames.length + '/' + configNames.length + ' 张表',
            '配置中本次不存在：' + (missingConfigNames.length ? missingConfigNames.join('、') : '无'),
            '本次新表：' + (addedTableNames.length ? addedTableNames.join('、') : '无'),
            '外部表：成功 ' + externalAdded + '/' + externalRequested + (externalProblems ? '，异常 ' + externalProblems : ''),
        ];
        const mostlyMissing = configNames.length > 0 && matchedConfigNames.length / configNames.length < 0.5;
        const emptyProfile = configNames.length === 0 && externalRequested === 0;
        const needsConfirm = emptyProfile || mostlyMissing || externalProblems > 0;
        if (needsConfirm) {
            const accepted = hostWindow.confirm(
                '所选转换配置与本次结果可能不完全匹配：\n\n' +
                summaryLines.join('\n') +
                (notes.length ? '\n\n' + notes.join('\n') : '') +
                '\n\n确定：仍应用可匹配部分\n取消：本次不使用该配置'
            );
            if (!accepted) {
                mergeState.appliedRefs = [];
                return { template: baseTemplate, notes: ['用户已取消应用所选配置。'], applied: false, summary: summaryLines.join('\n') };
            }
        }
        return { template: next, notes, applied: true, summary: summaryLines.join('\n') };
    }
    function acceptBridgeRegistration(payload) {
        try {
            if (!payload || typeof payload !== 'object') return false;
            const ch = currentCharacter();
            if (!ch || !isConvertedMvuCard(ch)) return false;
            const ext = charExtensions(ch) || {};
            const marker = ext.mvu2shujuku || {};
            const currentName = String(ch.name || (ch.data && ch.data.name) || '');
            const payloadName = String(payload.cardName || '');
            const originalName = String(marker.originalName || '');
            if (!payloadName || (payloadName !== currentName && payloadName !== originalName)) {
                dbgWarn('[运行时注册] 忽略非当前卡桥 payload：' + payloadName + '（当前=' + currentName + '）');
                return false;
            }
            const parseLayout = value => typeof value === 'string' ? JSON.parse(value) : value;
            const payloadLayout = parseLayout(payload.layout);
            const currentLayout = parseLayout(marker.layout);
            if (!Array.isArray(payloadLayout) || !Array.isArray(currentLayout)) return false;
            // 注册只验证当前卡自己的数据，不允许旧 iframe 把任意布局绑定为当前卡。
            if (JSON.stringify(payloadLayout) !== JSON.stringify(currentLayout)) return false;
            if (payload.convertedAt && String(payload.convertedAt) !== String(marker.convertedAt || '')) return false;
            const cb = charWorldBook(ch);
            const templateEntry = cb && Array.isArray(cb.entries) && cb.entries.find(e => Array.isArray(e.keys) && e.keys.indexOf(DB_TEMPLATE_KEY) >= 0);
            if (templateEntry && String(templateEntry.content || '') !== String(payload.templateBase64 || '')) return false;
            // 旧桥没有转换标识，必须由当前卡的模板数据佐证；仅名字相同不足以接管。
            if (!payload.convertedAt && !templateEntry) return false;
            activeLayout = resolveRuntimeLayout(currentLayout);
            activeLayoutCardKey = cardCacheKey(ch);
            activePlaceholderNeeded = !!payload.statusPlaceholderNeeded;
            if (payload.templateBase64) {
                const holder = (typeof window !== 'undefined' ? window : globalThis);
                holder.__mvu2shujukuTemplateCache = JSON.parse(mvu2shujukuDecodeB64(String(payload.templateBase64)));
                holder.__mvu2shujukuTemplateCacheFor = activeLayoutCardKey;
                holder.__mvu2shujukuTemplateCacheForName = currentName;
            }
            installWindowGetAllVariables();
            installWindowMvuShim();
            ensureTemplateDefine();
            hostWindow.setTimeout(autoInitDatabase, 0);
            dbg('[运行时注册] 已接收薄桥 payload，扩展成为唯一 owner：' + currentName);
            return true;
        } catch (e) {
            dbgWarn('[运行时注册] 接收桥 payload 失败:', e && e.message ? e.message : e);
            return false;
        }
    }
    function activateRuntimeRegistry() {
        runtimeRegistry._handler = acceptBridgeRegistration;
        const queued = runtimeRegistry.pending.splice(0, runtimeRegistry.pending.length);
        for (const payload of queued) acceptBridgeRegistration(payload);
    }
    // 重读通知去重：同一份运行时数据只广播一次（数据变化后再次广播）
    let reentryNotifyFingerprint = '';
    // 重读通知指纹重置的防抖记录：同一聊天短时间内的重复 CHAT_CHANGED
    // （第三方扩展/卡内脚本误触发“假切换”）不再重置指纹重发通知，避免状态栏反复重渲染。
    let lastNotifyResetChat = '';
    let lastNotifyResetAt = 0;
    // 最近一次数据库写入时间：写入后 ~1.5s 内运行时可能领先持久化帧，读侧优先信任运行时；
    // 之后若运行时与持久化帧不一致，视为插件回放未完成/旧值，读侧以持久化帧（数据库真相）为准。
    let lastDbWriteAt = 0;
    // Mvu.replaceMvuData 合并写入：MVU 卡开局初始化常连续多次调用（每次只改一个字段），
    // 每次都触发插件整表持久化；合并为一次后只持久化一次。
    let pendingStatWrite = null;
    let pendingStatWriteSession = null;
    // 写批次串行执行；新快照在防抖窗口合并，不能与仍在 await CRUD 的旧批次并行。
    let statWriteInFlight = Promise.resolve();
    let statWriteTimer = null;
    let statWriteFlushResolve = null;
    let statWriteFlushPromise = null;
    let statWriteOverlayGen = 0;
    let pendingStatWriteIsInitialization = false;
    // 当前待写快照所属的聊天 key：切聊天时据此作废 pending 写入与挂起的 flush Promise。
    let pendingStatWriteOriginKey = '';
    // 模板缓存未就绪时写库重试次数（每次新写入在调度入口重置，避免重试自身把
    // 计数清零导致无限循环的同时，也不会让一次失败耗尽后续所有写入的预算）
    let overlayFlushRetries = 0;
    // 跨卡残留前端写库丢弃的限频标记（按聊天去重，避免刷屏）
    let lastForeignWriteDropChat = '';

    // 每聊天首次写库已通过 initGameSession 完成“合并注入数据建表”的标记：
    // 之后该聊天的写库走快照/增量提交，不再重复 initGameSession（避免反复重置表格）。
    const openingWriteSettledChats = new Set();
    // 新开局整表初始化快速路径：参考卡（人工重写的 sqlite 版）不会逐格 CRUD，
    // 而是把所选开局直接构造为完整模板，再调一次 initGameSession 原子建表。
    // 该路径只在“短聊天 + 首个完整多组写入”时启用，避免覆盖玩家已有进度。
    const openingBulkUsedChats = new Map();
    const openingBulkClosedChats = new Set();
    const OPENING_BULK_MAX_SNAPSHOTS = 4;

    // CHAT_CHANGED 可能晚于新会话第一次调用。入口和事件共用完整清理，
    // 确保旧调用只得到失败，新调用有独立 Promise，读侧也不残留旧快照。
    function discardPendingStatWrite() {
        const resolve = statWriteFlushResolve;
        pendingStatWrite = null;
        pendingStatWriteSession = null;
        pendingStatWriteOriginKey = '';
        pendingStatWriteIsInitialization = false;
        statWriteFlushResolve = null;
        statWriteFlushPromise = null;
        statWriteOverlayGen += 1;
        if (statWriteTimer) hostWindow.clearTimeout(statWriteTimer);
        statWriteTimer = null;
        const holder = typeof window !== 'undefined' ? window : root;
        if (holder) holder.__mvu2shujukuPendingStat = null;
        invalidateStatProjectionCache();
        if (resolve) resolve(false);
    }

    function normalizeCellForSync(v) {
        if (v === null || v === undefined) return '';
        if (typeof v === 'boolean') return v ? 1 : 0;
        if (typeof v === 'number') return v;
        if (typeof v === 'string') return v;
        try { return JSON.stringify(v); } catch (e) { return String(v); }
    }

    // 旧 MVU/VWD 在 message stat_data 中可能仍保留 [值, 描述] 叶子。
    // 开场分支快照合并发生在建表前；若直接把这个数组交给数据库，
    // TEXT 列会得到 [值,描述] JSON 字符串，并与枚举 CHECK 冲突。
    // 仅依 layout 中明确的 pair 列拆包，真实 array/object 字段保持不变。
    function collapseLegacyPairLeaves(stat, layoutEntries) {
        const out = JSON.parse(JSON.stringify(stat && typeof stat === 'object' ? stat : {}));
        const getParent = (parts) => {
            let cur = out;
            for (let i = 0; i < parts.length - 1; i++) {
                if (!cur || typeof cur !== 'object') return null;
                cur = cur[parts[i]];
            }
            return cur && typeof cur === 'object' ? cur : null;
        };
        for (const L of (Array.isArray(layoutEntries) ? layoutEntries : [])) {
            for (const col of (L && Array.isArray(L.cols) ? L.cols : [])) {
                if (!Array.isArray(col) || col[1] !== 'pair' || !Array.isArray(col[3]) || !col[3].length) continue;
                const parts = col[3].map(String);
                const parent = getParent(parts);
                const key = parts[parts.length - 1];
                const value = parent && parent[key];
                if (Array.isArray(value) && value.length === 2 && typeof value[1] === 'string') {
                    parent[key] = value[0];
                }
            }
        }
        return out;
    }

    // MVU 的原始对象允许省略字段，而数据库会按列类型补齐默认值；两者不能直接
    // JSON.stringify 比较。整表提交的预期值和实际值必须先经过同一 layout 的
    // 表格→stat_data 投影，再做键序无关的确定性比较。
    function canonicalJsonForSync(value) {
        const walk = (v) => {
            if (Array.isArray(v)) return v.map(walk);
            if (!v || typeof v !== 'object') return v;
            const out = {};
            for (const key of Object.keys(v).filter(k => k !== '$internal').sort()) out[key] = walk(v[key]);
            return out;
        };
        try { return JSON.stringify(walk(value)); } catch (e) { return ''; }
    }

    function buildUpdatedTemplateFromStat(layoutEntries, prevStat, nextStat, baseTemplate) {
        const coreNow = window.MVU2SHUJUKU_CORE;
        if (!coreNow || typeof coreNow.writeStatDiffToDb !== 'function' || typeof coreNow.statDataFromTables !== 'function') return null;
        const tables = JSON.parse(JSON.stringify(baseTemplate || {}));
        const normalizedPrevStat = collapseLegacyPairLeaves(prevStat, layoutEntries);
        const normalizedNextStat = collapseLegacyPairLeaves(nextStat, layoutEntries);
        const fakeApi = {
            exportTableAsJson: () => tables,
            importTableAsJson: async json => {
                const candidate = JSON.parse(json);
                for (const key of Object.keys(tables)) delete tables[key];
                Object.assign(tables, candidate);
                return true;
            },
            updateCell: async (tableName, rowIndex, col, value) => {
                const s = Object.values(tables).find(x => x && x.name === tableName);
                if (!s || !s.content[rowIndex]) return false;
                const ci = s.content[0].indexOf(col);
                if (ci === -1) return false;
                s.content[rowIndex][ci] = normalizeCellForSync(value);
                return true;
            },
            updateRow: async (tableName, rowIndex, payload) => {
                const s = Object.values(tables).find(x => x && x.name === tableName);
                if (!s || !s.content[rowIndex] || !payload || typeof payload !== 'object') return false;
                for (const col of Object.keys(payload)) {
                    const ci = s.content[0].indexOf(col);
                    if (ci >= 0) s.content[rowIndex][ci] = normalizeCellForSync(payload[col]);
                }
                return true;
            },
            insertRow: async (tableName, obj) => {
                const s = Object.values(tables).find(x => x && x.name === tableName);
                if (!s) return 0;
                const row = s.content[0].map(h => '');
                for (const k of Object.keys(obj || {})) {
                    const ci = s.content[0].indexOf(k);
                    if (ci >= 0) row[ci] = normalizeCellForSync(obj[k]);
                }
                // 行号取现有最大行号 +1：deleteRow 发生后 content.length 会与已有
                // 行号重复（row[0] 是主键列），重复主键会让整表导入被拒或产生重复行。
                let maxRowId = 0;
                for (let ri = 1; ri < s.content.length; ri++) {
                    const rn = Number(s.content[ri] && s.content[ri][0]);
                    if (Number.isFinite(rn) && rn > maxRowId) maxRowId = rn;
                }
                row[0] = maxRowId + 1;
                s.content.push(row);
                return row[0];
            },
            deleteRow: async (tableName, rowIndex) => {
                const s = Object.values(tables).find(x => x && x.name === tableName);
                if (!s || !s.content[rowIndex]) return false;
                s.content.splice(rowIndex, 1);
                return true;
            },
        };
        // 内存模板必须先追平当前数据库状态，再应用 prev→next。本次调用可能只带
        // 某组的部分字段；若直接从原始模板应用差异，未变化字段会停留在模板默认值，
        // 随后的整表 initGameSession 会把已有进度回滚。
        const baseWrap = coreNow.statDataFromTables(layoutEntries, tables);
        const baseStat = baseWrap && baseWrap.stat_data && typeof baseWrap.stat_data === 'object'
            ? baseWrap.stat_data
            : {};
        return Promise.resolve(coreNow.writeStatDiffToDb(fakeApi, layoutEntries, baseStat, normalizedPrevStat, tables))
            .then(() => {
                if (coreNow.lastStatWriteFailed) throw new Error('构建开场模板失败：无法追平当前数据库快照');
                return coreNow.writeStatDiffToDb(fakeApi, layoutEntries, normalizedPrevStat, normalizedNextStat, tables);
            })
            .then(() => {
                if (coreNow.lastStatWriteFailed) throw new Error('构建开场模板失败：无法应用当前开场快照');
                return tables;
            });
    }

    // 已有聊天再做整表 import 时，必须沿用 SP 已分配的 sheet key。
    // 转换器内嵌模板用紧凑拼音 key（sheet_shijiebiao），SP 初始化
    // 后通常是分音节 key（sheet_shi_jie_biao）。若 data_replace 直接带回
    // 前者，V2 会对同一显示表名保留两个身份，下次 SQL 回放必然冲突。
    function rebindTemplateSheetKeysToRuntime(candidate, runtimeTables) {
        const src = candidate && typeof candidate === 'object' ? candidate : {};
        const runtime = runtimeTables && typeof runtimeTables === 'object' ? runtimeTables : {};
        const runtimeKeyByName = new Map();
        const duplicateRuntimeNames = new Set();
        for (const key of Object.keys(runtime)) {
            if (key.indexOf('sheet_') !== 0 || !runtime[key] || !runtime[key].name) continue;
            const name = String(runtime[key].name);
            if (runtimeKeyByName.has(name) && runtimeKeyByName.get(name) !== key) duplicateRuntimeNames.add(name);
            else runtimeKeyByName.set(name, key);
        }
        const out = {};
        for (const key of Object.keys(src)) {
            if (key.indexOf('sheet_') !== 0 || !src[key] || !src[key].name) {
                out[key] = JSON.parse(JSON.stringify(src[key]));
                continue;
            }
            const name = String(src[key].name);
            const rebound = !duplicateRuntimeNames.has(name) && runtimeKeyByName.has(name)
                ? runtimeKeyByName.get(name)
                : key;
            if (out[rebound] !== undefined) throw new Error('整表导入 key 归并冲突：' + name + ' → ' + rebound);
            out[rebound] = JSON.parse(JSON.stringify(src[key]));
        }
        return out;
    }

    async function commitMessageUpdateSnapshot(api, prevStat, nextStat, session) {
        if (canonicalJsonForSync(prevStat) === canonicalJsonForSync(nextStat)) return false;
        // SP 9.2.5 的手动 CRUD 追加到最近已有表帧的 AI 楼，可能仍是首楼。
        // 消息更新必须落在当前回复：整表导入由 SP 选择最新 AI 楼并严格保存，
        // 删除/重生成该回复时，宿主才能连同其更新一起回放撤销。
        if (typeof api.importTableAsJson !== 'function') throw new Error('消息更新需要数据库整表导入能力');
        const before = api.exportTableAsJson();
        const beforeJson = JSON.stringify(before);
        const candidate = await buildUpdatedTemplateFromStat(activeLayout, prevStat, nextStat, before);
        assertRuntimeSession(session);
        if (!candidate) throw new Error('消息更新快照构造失败');
        if (JSON.stringify(api.exportTableAsJson()) !== beforeJson) throw new Error('消息更新期间数据库已变化，等待重新规划');
        const imported = await api.importTableAsJson(JSON.stringify(candidate));
        assertRuntimeSession(session);
        if (imported !== true && !(imported && imported.success === true)) throw new Error('消息更新快照未提交成功');
        return true;
    }

    async function tryOpeningBulkInit(api, prevStat, nextStat, chatKey, explicitInitialization, originSession) {
        const session = originSession || captureRuntimeSession();
        const stateKey = runtimeScopedChatKey(chatKey);
        try {
            assertRuntimeSession(session);
            api = runtimeApiForSession(api, session);
            // 归属守卫：调用方捕获的 chatKey 与当前聊天不一致时直接放弃（不重试）。
            // 整表 importTableAsJson/initGameSession 一旦落入切换后的新聊天，会直接
            // 覆盖其进度；稳定期校验也会因读到新聊天数据而误判失败。
            try { if (String(chatKey) !== autoInitChatId()) { dbg(' [开局快速路径] 跳过: 聊天已切换'); return false; } } catch (e) {}
            if (!openingChatIsShort()) {
                // 切换开场分支时，其他脚本可能正在重载消息，ctx.chat 会短暂呈现
                // 为旧聊天/过渡态。明确的 initvar 不应因此退回逐格 CRUD；等聊天
                // 稳定后重试，仍由短聊天门禁防止覆盖已有进度。
                if (explicitInitialization) {
                    dbg(' [开局快速路径] 等待: chat_not_short（初始化分支加载过渡态）');
                    return 'retry';
                }
                openingBulkClosedChats.add(stateKey);
                pruneOrderedCollection(openingBulkClosedChats, 80);
                dbg(' [开局快速路径] 跳过: chat_not_short');
                return false;
            }
            if (!explicitInitialization && openingBulkClosedChats.has(stateKey)) {
                dbg(' [开局快速路径] 跳过: init_phase_closed');
                return false;
            }
            const bulkState = openingBulkUsedChats.get(stateKey);
            if (!explicitInitialization && bulkState && bulkState.count >= OPENING_BULK_MAX_SNAPSHOTS) {
                openingBulkClosedChats.add(stateKey);
                pruneOrderedCollection(openingBulkClosedChats, 80);
                dbg(' [开局快速路径] 跳过: snapshot_limit');
                return false;
            }
            let nextHash = '';
            try { nextHash = JSON.stringify(nextStat || {}); } catch (e) {}
            if (bulkState && nextHash && bulkState.lastHash === nextHash) {
                dbg(' [开局快速路径] 跳过: duplicate_snapshot');
                return false;
            }
            // 标准 <initvar> 由调用方显式标记为初始化；卡作者自行调用 replaceMvuData
            // 时，仅对整页注入式开局前端启用兜底识别，避免运行期全量替换误重建数据库。
            const frontendLoaded = !!(typeof window !== 'undefined' && window.__mvu2shujukuFrontendLoaded) ||
                !!(hostWindow && hostWindow.__mvu2shujukuFrontendLoaded) ||
                !!(typeof window !== 'undefined' && window.parent && window.parent.__mvu2shujukuFrontendLoaded) ||
                !!(typeof window !== 'undefined' && window.top && window.top.__mvu2shujukuFrontendLoaded);
            dbg(' [开局快速路径] 检查: chatShort=' + openingChatIsShort() +
                ' | explicitInit=' + !!explicitInitialization +
                ' | phaseCount=' + (bulkState ? bulkState.count : 0) +
                ' | frontendLoaded=' + frontendLoaded +
                ' | groups=' + Object.keys(nextStat || {}).filter(k => k !== '$internal').length);
            if (!explicitInitialization && !frontendLoaded) return false;
            const groups = Object.keys(nextStat || {}).filter(k => k !== '$internal');
            if (!explicitInitialization && groups.length < 2) return false;
            const tpl = cachedTemplateForCurrentCard();
            const coreNow = window.MVU2SHUJUKU_CORE;
            if (!tpl || !coreNow || typeof coreNow.writeStatDiffToDb !== 'function') return false;
            const mergedTemplate = await buildUpdatedTemplateFromStat(activeLayout, prevStat, nextStat, tpl);
            assertRuntimeSession(session);
            if (!mergedTemplate) return false;
            const ch = currentCharacter();
            const presetName = (characterDisplayName(ch) || '角色') + '模板';
            // 新聊天缺表才需要 initGameSession。若基础表已经存在（最常见于用户进入聊天后
            // 再切换开场 swipe），再次 initGameSession 会 reloadCurrentChatUnsafe；保存尚未
            // 落定时旧 checkpoint 会在重载后覆盖新快照。SP 的 importTableAsJson 默认走
            // 持久化 data_replace 提交并原子替换运行时，正适合已有会话的完整快照更新。
            let runtimeHasAllTables = false;
            let currentRuntimeTables = null;
            try {
                currentRuntimeTables = api.exportTableAsJson() || {};
                const runtimeNames = new Set(Object.keys(currentRuntimeTables)
                    .filter(k => k.indexOf('sheet_') === 0 && currentRuntimeTables[k] && currentRuntimeTables[k].name)
                    .map(k => String(currentRuntimeTables[k].name)));
                const expectedNames = new Set((activeLayout || []).map(L => String(L.table || '')).filter(Boolean));
                runtimeHasAllTables = expectedNames.size > 0 && [...expectedNames].every(name => runtimeNames.has(name));
            } catch (e) {}
            let committedTemplate = mergedTemplate;
            if (runtimeHasAllTables && typeof api.importTableAsJson === 'function') {
                committedTemplate = rebindTemplateSheetKeysToRuntime(mergedTemplate, currentRuntimeTables);
                const imported = await Promise.resolve(api.importTableAsJson(JSON.stringify(committedTemplate)));
                if (imported === false || (imported && imported.success === false)) {
                    throw new Error((imported && imported.error) || 'importTableAsJson 持久化替换失败');
                }
                dbg(' [开局快速路径] 已有表格，使用 importTableAsJson 原子持久化当前分支（不重载聊天）。');
            } else {
                const out = await Promise.resolve(api.initGameSession({}, {
                    injectTemplate: true,
                    loadPreset: false,
                    templateData: mergedTemplate,
                    templatePresetName: presetName,
                }));
                if (out && out.success === false) throw new Error(out.message || 'initGameSession 失败');
            }
            const ready = await waitRuntimeTablesReady(api, activeLayout, 5000);
            assertRuntimeSession(session);
            if (!ready) throw new Error('数据库运行时未就绪');
            // importTableAsJson 的 API 成功只表示提交管线没有报错。再从当前
            // 运行时反向读取 stat_data，防止旧 checkpoint/外部重载立即覆盖后
            // 仍误报“初始化完成”并向前端广播默认值。
            const expectedWrap = coreNow.statDataFromTables(activeLayout, committedTemplate);
            const expectedStat = expectedWrap && expectedWrap.stat_data;
            const expectedHash = canonicalJsonForSync(expectedStat || {});
            // importTableAsJson 返回成功后，卡内前端可能紧接着触发
            // reloadCurrentChatUnsafe。只做一次即时读回会在“新运行时已换上、
            // 旧聊天即将重载”的窗口误报成功。在短稳定期内同时核对
            // 运行时与 V2 持久化帧；任一边回退都整份快照重试。
            const verifyCandidate = function () {
                const runtimeTables = api.exportTableAsJson() || {};
                const actualWrap = coreNow.statDataFromTables(activeLayout, runtimeTables);
                const actualStat = actualWrap && actualWrap.stat_data;
                const actualHash = canonicalJsonForSync(actualStat || {});
                let persistedHash = '';
                try {
                    // 持久化帧可能在保存/重载中以相同字节长度被替换，
                    // 校验时必须绕过只读缓存重建当前聊天真值。
                    persistedReadCache = { key: '', data: null };
                    const persistedTables = readPersistedTableData();
                    if (persistedTables) {
                        const persistedWrap = coreNow.statDataFromTables(activeLayout, persistedTables);
                        persistedHash = canonicalJsonForSync((persistedWrap && persistedWrap.stat_data) || {});
                    }
                } catch (e) {}
                return {
                    ok: !!expectedHash && actualHash === expectedHash && (!persistedHash || persistedHash === expectedHash),
                    actualBytes: actualHash.length,
                    persistedBytes: persistedHash.length,
                };
            };
            let verification = verifyCandidate();
            if (verification.ok) {
                const stableDeadline = Date.now() + 1200;
                while (Date.now() < stableDeadline) {
                    await new Promise(resolve => hostWindow.setTimeout(resolve, 300));
                    assertRuntimeSession(session);
                    verification = verifyCandidate();
                    if (!verification.ok) break;
                }
            }
            if (!verification.ok) {
                dbgWarn(' [开局快速路径] 提交后运行时/持久化快照未稳定达到候选值，等待整体重试（expectedBytes=' + expectedHash.length + ', actualBytes=' + verification.actualBytes + ', persistedBytes=' + verification.persistedBytes + '）。');
                return 'retry';
            }
            try { if (String(chatKey) !== autoInitChatId()) { dbg(' [开局快速路径] 提交后聊天已切换，丢弃本次结果（不记账、不广播）。'); return false; } } catch (e) {}
            openingBulkUsedChats.set(stateKey, {
                count: (bulkState ? bulkState.count : 0) + 1,
                lastAt: Date.now(),
                lastHash: nextHash,
            });
            pruneOrderedCollection(openingBulkUsedChats, 80);
            return true;
        } catch (e) {
            if (!isRuntimeSessionCurrent(session)) return false;
            dbgWarn(' 开局整表初始化快速路径未落定，延后重试：' + (e && e.message ? e.message : e));
            return explicitInitialization ? 'retry' : false;
        }
    }

    // 对齐参考卡 waitForOpeningDatabase：等待插件把运行时表格就绪（initGameSession/回放
    // 后的异步物化）。就绪 = 布局内所有表都已出现在 exportTableAsJson（插件已加载结构），
    // 且每张单例/JSON 表存在数据行（与读侧规格一致：半物化状态下以空 prev 为基线 diff，
    // 会把整组默认值当差异写进数据库）；模板本身无数据行的表不参与行校验。
    // 超时未就绪返回 false，调用方延后重试写入。不做任何手工物化。
    async function waitRuntimeTablesReady(api, layoutEntries, timeoutMs) {
        const session = captureRuntimeSession();
        const expected = new Set((Array.isArray(layoutEntries) ? layoutEntries : []).map(L => L.table));
        if (!expected.size) return true;
        // 读侧规格（单例/JSON 表必须有数据行，tableSnapshotCoversLayout）在写侧只能作为
        // 限时快速路径的加强条件：运行时会长期处于“仅表头 + seedRows/持久化帧待物化”
        // 状态（新聊天 native 初始化、切换开场分支的重载窗口），写路径自身的补行与
        // 持久化对账守卫才是这种状态下正确性的保障——硬性阻塞行校验会把 initvar 注入
        // 永久挡在门外（v0.3.1 回归）。行未齐时最多再等 1.5s，超时后退回仅表名校验。
        const needRows = new Set();
        for (const L of (Array.isArray(layoutEntries) ? layoutEntries : [])) {
            if ((L.kind === 'singleton' || L.kind === 'json') && L.table) needRows.add(String(L.table));
        }
        try {
            const tpl = cachedTemplateForCurrentCard();
            if (tpl) {
                for (const s of Object.values(tpl)) {
                    if (s && s.name && (!Array.isArray(s.content) || s.content.length <= 1)) needRows.delete(String(s.name));
                }
            }
        } catch (e) {}
        const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
        const rowDeadline = Date.now() + 1500;
        let missingNames = null;
        let missingRows = null;
        while (Date.now() < deadline) {
            if (!isRuntimeSessionCurrent(session)) return false;
            try {
                const cur = api.exportTableAsJson() || {};
                const byName = {};
                for (const k in cur) {
                    if (k.indexOf('sheet_') === 0 && cur[k] && cur[k].name) byName[String(cur[k].name)] = cur[k];
                }
                missingNames = [];
                for (const n of expected) { if (!byName[n]) missingNames.push(n); }
                if (missingNames.length) {
                    await new Promise(res => hostWindow.setTimeout(res, 150));
                    continue;
                }
                if (Date.now() >= rowDeadline) return true; // 表名齐全：行等待窗口已过，交由写路径守卫
                missingRows = [];
                for (const n of needRows) {
                    const sheet = byName[n];
                    if (sheet && (!Array.isArray(sheet.content) || sheet.content.length <= 1)) missingRows.push(n);
                }
                if (missingRows.length) {
                    await new Promise(res => hostWindow.setTimeout(res, 150));
                    continue;
                }
                return true;
            } catch (e) {
                await new Promise(res => hostWindow.setTimeout(res, 150));
            }
        }
        if (missingNames && !missingNames.length) {
            dbg('[流程] 运行时表名齐全但单例/JSON 表缺数据行（' + (missingRows || []).slice(0, 6).join('、') + '），按仅表名就绪放行写路径（由补行/对账守卫兜底）。');
            return true;
        }
        dbg('[流程] 运行时就绪等待超时：缺表=' + (Array.from(missingNames || expected).slice(0, 6).join('、') || '?'));
        return false;
    }

    // 合并写入：前端一次操作常连续触发多次 replaceMvuData（如同步资源+追加操作日志），
    // 短窗口内合并为一次持久化；读路径直接返回待写快照保证写后立即读一致。
    function scheduleWindowStatOverlay(next, onSettled, isRetry, explicitInitialization, originChatKey, originSession) {
        // 重试必须携带首次调度时的聊天 key：重试间隔内切换聊天（尤其同卡不同聊天，
        // 布局归属校验拦不住）后重新捕获新 key，会让旧聊天的快照通过归属守卫写进新聊天。
        let writeChatKey = '';
        const requestedSession = originSession || captureRuntimeSession();
        const writeSession = pendingStatWriteSession && isRuntimeSessionCurrent(pendingStatWriteSession) && pendingStatWriteSession.messageUpdate
            ? { ...requestedSession, messageUpdate: true } : requestedSession;
        if (typeof originChatKey === 'string' && originChatKey) {
            writeChatKey = originChatKey;
        } else {
            try { writeChatKey = autoInitChatId(); } catch (e) {}
        }
        if (pendingStatWriteSession && !isRuntimeSessionCurrent(pendingStatWriteSession)) {
            discardPendingStatWrite();
        }
        if (!isRuntimeSessionCurrent(writeSession) || writeChatKey !== autoInitChatId()) {
            if (typeof onSettled === 'function') onSettled(false);
            return Promise.resolve(false);
        }
        if (!isRetry) {
            // 每次新写入都有独立的就绪重试预算：此前预算只在 replaceMvuData 入口清零，
            // <UpdateVariable> 楼层处理等非 Mvu 入口一旦耗尽预算，同聊天后续写入会被永久放弃。
            overlayFlushRetries = 0;
        }
        pendingStatWriteOriginKey = writeChatKey;
        pendingStatWriteSession = writeSession;
        invalidateStatProjectionCache();
        // 合并窗口内的所有 replaceMvuData 共用一个落定 Promise。
        // 这样卡内脚本的 await Mvu.replaceMvuData(...) 不再只等到“排队”，
        // 而是等到 CRUD、持久化与 saveChat 真正完成。
        if (!statWriteFlushPromise) {
            statWriteFlushPromise = new Promise(resolve => { statWriteFlushResolve = resolve; });
        }
        const flushPromise = statWriteFlushPromise;
        if (!isRetry && typeof onSettled === 'function') {
            flushPromise.then(ok => { try { onSettled(ok); } catch (e) {} });
        }
        statWriteOverlayGen += 1;
        pendingStatWrite = next;
        pendingStatWriteIsInitialization = pendingStatWriteIsInitialization || !!explicitInitialization;
        // 共享给卡内桥/其他窗口的“最新待写状态”：连续 读-改-写 都基于它累积，
        // 避免 150ms 合并窗口内后写读旧运行时把前写覆盖（成就标记丢失）。
        try {
            const ph = (typeof window !== 'undefined' ? window : root);
            if (ph) ph.__mvu2shujukuPendingStat = next;
        } catch (e) {}
        if (statWriteTimer) hostWindow.clearTimeout(statWriteTimer);
        const scheduledGen = statWriteOverlayGen;
        const runFlush = async () => {
            // 排队期间可能被较新的防抖快照或切聊天取消。
            if (scheduledGen !== statWriteOverlayGen || flushPromise !== statWriteFlushPromise) return;
            statWriteTimer = null;
            const target = pendingStatWrite;
            if (target === null || target === undefined) {
                pendingStatWriteIsInitialization = false;
                if (statWriteFlushResolve) {
                    const resolveFlush = statWriteFlushResolve;
                    statWriteFlushResolve = null;
                    statWriteFlushPromise = null;
                    resolveFlush(false);
                }
                return;
            }
            const gen = statWriteOverlayGen;
            const isInitializationWrite = pendingStatWriteIsInitialization;
            // 标志只描述“当前待写快照”：捕获后立即清零，防止初始化写进入重试链后
            // 泄漏到后续普通写（显式初始化分支会绕过开局整表的全部保险门禁）。
            // 重试路径通过 explicitInitialization 参数重新置位。
            pendingStatWriteIsInitialization = false;
            const chatKeyNow = autoInitChatId();
            // settledOk：本次写入是否真正落定（成功或与目标一致）；retryScheduled：
            // 是否已安排重试（重试会携带同一回调，最终落定时才通知调用方）。
            let settledOk = false;
            let retryScheduled = false;
            let writeUnsettled = false;
            try {
                // 归属校验：150ms 合并窗口内若已切换聊天/角色，丢弃本次待写，
                // 避免把上一张卡/上一个聊天的数据写进当前会话。
                let nowChatKey = '';
                try { nowChatKey = autoInitChatId(); } catch (e) {}
                if (writeChatKey !== nowChatKey || !isRuntimeSessionCurrent(writeSession)) {
                    dbgWarn(' Mvu 合并写库被跳过：聊天已切换（' + writeChatKey + ' → ' + nowChatKey + '），丢弃待写快照。');
                    return;
                }
                const api = runtimeApiForSession(getAcuApi(), writeSession);
                if (api && activeLayout) {
                    // 插件自己的事务管线负责 checkpoint/落盘；这里只做运行时就绪等待与差异写入。
                    // 不再手工锚定：initGameSession/插件提交管线自动建立并维护 checkpoint。
                    
                    const tplCached = cachedTemplateForCurrentCard();
                    // 布局归属校验：切卡空窗期 activeLayout 仍是上一张卡的，写库会按错布局落表；
                    // 与模板缓存一起作为“自动建表就绪”门槛，未就绪时延后重试。
                    let layoutOk = false;
                    try { layoutOk = layoutBelongsToCurrentCard(activeLayoutCardKey); } catch (e) {}
                    if (!tplCached || !layoutOk) {
                        // 自动建表可能在途（角色列表懒加载需要先取完整卡再缓存模板/布局）：
                        // 延后重试，避免开局/开场白注入在就绪前被直接丢弃或按旧布局写错。
                        if (overlayFlushRetries < 6) {
                            overlayFlushRetries += 1;
                            dbg('[流程] 模板缓存/布局未就绪' + (tplCached ? '（布局未匹配）' : '') + '，延后重试写库（#' + overlayFlushRetries + '）。');
                            hostWindow.setTimeout(() => {
                                // 仅当期间没有更新的写入时才重试，避免旧快照覆盖新状态
                                if (statWriteOverlayGen === gen) scheduleWindowStatOverlay(target, null, true, isInitializationWrite, writeChatKey, writeSession);
                            }, 500);
                            retryScheduled = true;
                            return;
                        }
                        dbgWarn('[流程] 写库前模板缓存/布局未就绪且重试次数用尽，放弃本次写入（等待自动建表）。');
                        if (statWriteOverlayGen === gen) pendingStatWrite = null;
                        return;
                    }
                    // 切卡隔离：插件运行时（currentJsonTableData）可能在聊天切换后还挂着上一张卡
                    // 的表格。若此时按旧卡数据写库，diff 识别不了布局外的组 → 回退快照 → 把跨卡
                    // 数据写进当前聊天 checkpoint（日志表现：target 混入上一张卡的组、checkpoint 膨胀）。
                    // 检测到跨卡残留表时直接丢弃本次写入（不重试，等插件完成切换后由后续写入接手）。
                    try {
                        const foreign = runtimeForeignTableNames(api, activeLayout);
                        if (foreign.length) {
                            dbgWarn('[流程] 写库前检测到跨卡残留表：' + foreign.join('、') + '，丢弃本次写入（等待插件完成聊天切换）。');
                            if (statWriteOverlayGen === gen) pendingStatWrite = null;
                            return;
                        }
                    } catch (e) {}
                    // 对齐参考卡：不做手工锚定/物化，等待插件把运行时表格就绪
                    // （initGameSession/回放后的异步物化）。就绪后直接用运行时作基线 diff。
                    const rtReady = await waitRuntimeTablesReady(api, activeLayout, 5000);
                    assertRuntimeSession(writeSession);
                    if (!rtReady) {
                        // 插件运行时尚未就绪（刷新后回放/开局建表异步）：延后重试，不手工物化
                        if (overlayFlushRetries < 6) {
                            overlayFlushRetries += 1;
                            dbg('[流程] 插件运行时未就绪，延后重试写库（#' + overlayFlushRetries + '）。');
                            hostWindow.setTimeout(() => {
                                if (statWriteOverlayGen === gen) scheduleWindowStatOverlay(target, null, true, isInitializationWrite, writeChatKey, writeSession);
                            }, 800);
                            retryScheduled = true;
                            return;
                        }
                        dbgWarn('[流程] 插件运行时迟迟未就绪，放弃本次写入。');
                        if (statWriteOverlayGen === gen) pendingStatWrite = null;
                        return;
                    }
                    // SQL 读取能力不代表 CRUD 就绪：SP 9.2.5 在 native 模式下始终
                    // 隐藏 querySql/executeSqlQuery。SQLite CRUD 自身会等待 provider
                    // 发布，并在 commit 内核验 readiness/revision；此处只检查实际表格，
                    // 保留来源会话守卫和写入失败重试，不以 SQL getter 拦截原生写入。
                    // 诊断：写库前运行时与持久化重建的行数对比，定位“回放窗口/填表窗口”竞争
                    try {
                        if (mvu2shujukuDebugOn()) {
                            const cur2 = api.exportTableAsJson() || {};
                            const rtRows = [];
                            const pRows = [];
                            let pData = null;
                            try { pData = readPersistedTableData(); } catch (e) {}
                            for (const L of (Array.isArray(activeLayout) ? activeLayout : [])) {
                                let rc = 0;
                                for (const k in cur2) {
                                    if (k.indexOf('sheet_') === 0 && cur2[k] && cur2[k].name === L.table && Array.isArray(cur2[k].content)) { rc = cur2[k].content.length - 1; break; }
                                }
                                rtRows.push(L.table + ':' + rc);
                                if (pData) {
                                    const ps = Object.values(pData).find(s => s && s.name === L.table);
                                    pRows.push(L.table + ':' + (ps && Array.isArray(ps.content) ? ps.content.length - 1 : 0));
                                }
                            }
                            dbg('[写库时序] gen=' + gen + ' 重试=' + overlayFlushRetries +
                                ' | 运行时行数: ' + rtRows.join(',') +
                                (pRows.length ? ' | 持久化行数: ' + pRows.join(',') : ' | 持久化重建: 无'));
                        }
                    } catch (eDiag) {}
                    // 写基线用运行时（插件已就绪，运行时即最新已提交状态）而不是持久化重建，
                    // 避免与持久化帧的提交时序产生差异；持久化优先只服务前端读侧。
                    let prev = {};
                    try {
                        const rtAll = window.MVU2SHUJUKU_CORE.statDataFromTables(activeLayout, api.exportTableAsJson());
                        if (rtAll && rtAll.stat_data && typeof rtAll.stat_data === 'object') prev = rtAll.stat_data;
                    } catch (eP) {}
                    // 调用方归属校验：target 顶层组混入当前布局外的组（如切到催眠APP后，
                    // 上一张道渊的前端 iframe 仍在运行、定时 replaceMvuData）→ 调用方是
                    // 跨卡残留的旧前端，整笔丢弃，不再剥离后继续写。否则每 150ms 一次
                    // 无意义写库+保存刷屏，还会在原生填表窗口制造“第二写者”竞争。
                    const rawGroups2 = Object.keys(target || {}).filter(g => g !== '$internal');
                    const layoutGroupSet2 = new Set((Array.isArray(activeLayout) ? activeLayout : []).map(L => L.group));
                    let hasForeignGroup2 = false;
                    for (const g of rawGroups2) {
                        if (!layoutGroupSet2.has(g)) { hasForeignGroup2 = true; break; }
                    }
                    if (hasForeignGroup2 && rawGroups2.length) {
                        if (lastForeignWriteDropChat !== chatKeyNow) {
                            lastForeignWriteDropChat = chatKeyNow;
                            dbgWarn('[切卡隔离] 检测到跨卡残留前端写库（target 混入布局外组：' + rawGroups2.join('、') + '），整笔丢弃，后续同类写入静默跳过。');
                        }
                        if (statWriteOverlayGen === gen) pendingStatWrite = null;
                        return;
                    }
                    // 前端/脚本传来的 target 可能不完整：开场读取时布局未就绪，只拿到部分组
                    // （如只有 系统.本轮APP操作，缺 主角 等）。把 target 叠到当前表状态（prev）上，
                    // 缺失的顶层组用现有数据补齐——否则快照/合并模板会把已有组清空，
                    // 最终 importTableAsJson 还可能存旧 checkpoint，导致“写入未保存”。
                    const effectiveTarget = (() => {
                        if (!target || typeof target !== 'object') return prev || {};
                        const out = JSON.parse(JSON.stringify(prev || {}));
                        // 切卡隔离：前端可能缓存上一张卡的 stat_data（target 混入当前布局外的组）。
                        // 只接受当前布局内的顶层组，布局外的组一律丢弃，避免串卡数据写进当前聊天。
                        const allowedGroups = new Set((Array.isArray(activeLayout) ? activeLayout : []).map(L => L.group));
                        for (const k of Object.keys(target)) {
                            if (k === '$internal') continue;
                            if (allowedGroups.has(k)) {
                                const tv = target[k];
                                const pv = out[k];
                                // 空组保护（行表 rows 与关系子表集合 nestedRows）：前端 target
                                // 该组为空对象而当前（prev）有数据时保留 prev——MVU 前端常分批/按需
                                // 发 stat_data，行表/关系子表空组可能是“数据未加载”而非“删除所有行”
                                // （DELETE-only 会丢行）。JSON 表显式置空 = 清空内容（前端取消任务等
                                // 真实操作，如 任务={}），单例表空对象无键自然无操作——两者都不需要保护。
                                const isEmptyObj = tv && typeof tv === 'object' && !Array.isArray(tv) && Object.keys(tv).length === 0;
                                const prevNonEmpty = pv && typeof pv === 'object' && !Array.isArray(pv) && Object.keys(pv).length > 0;
                                const grpLayout = (Array.isArray(activeLayout) ? activeLayout : []).find(L => L.group === k);
                                if (isEmptyObj && prevNonEmpty && grpLayout && (grpLayout.kind === 'rows' || grpLayout.kind === 'nestedRows')) {
                                    dbg(' [空组保护] target.' + k + ' 为空对象而 prev 有数据，保留 prev（不视为删除）。');
                                    continue;
                                }
                                out[k] = tv;
                            }
                            else if (target[k] !== undefined && target[k] !== null && typeof target[k] === 'object') {
                                dbg(' [切卡隔离] target 剥离布局外组：' + k);
                            }
                        }
                        return out;
                    })();
                    // 诊断：打印实际到达写路径的 系统._hypnoos（成就/购买等内部状态），
                    // 判断前端是否把标记放进写回、以及我们是否丢值。
                    try {
                        if (mvu2shujukuDebugOn() && target && target.系统 && typeof target.系统 === 'object') {
                            const h0 = target.系统._hypnoos;
                            if (h0 !== undefined) {
                                dbg('[写库诊断] target 系统._hypnoos = ' + JSON.stringify(h0).slice(0, 500));
                            }
                        }
                    } catch (eH) {}
                    // 写回守卫：单例组“整组写回”若把多个字段同时重置成模板初始值，而当前运行时是
                    // 非默认值，判定为前端“空读/旧读 → schema 默认值 → 写回”，恢复运行时值（保留数据库真值）。
                    // 通用实现：用卡自己的模板初始行做基准，任何转换卡都适用；只拦“回退到模板默认”的写回。
                    try {
                        const tplGuard = cachedTemplateForCurrentCard();
                        if (tplGuard && effectiveTarget && typeof effectiveTarget === 'object') {
                            for (const L of (Array.isArray(activeLayout) ? activeLayout : [])) {
                                if (L.kind !== 'singleton') continue;
                                const tplSheet = Object.values(tplGuard).find(function (s) { return s && s.name === L.table; });
                                if (!tplSheet || !Array.isArray(tplSheet.content) || tplSheet.content.length < 2) continue;
                                const tplHdr = tplSheet.content[0];
                                const tplRow = tplSheet.content[1];
                                const tgt = effectiveTarget[L.group];
                                const base = prev[L.group];
                                if (!tgt || typeof tgt !== 'object' || Array.isArray(tgt)) continue;
                                if (!base || typeof base !== 'object' || Array.isArray(base)) continue;
                                const str = function (v) { return String(v == null ? '' : v); };
                                let resetCount = 0;
                                let changedCount = 0;
                                const cols = [];
                                for (let ci = 1; ci < tplHdr.length; ci++) {
                                    const col = tplHdr[ci];
                                    if (col === '_扩展数据') continue;
                                    if (!(col in tgt) || !(col in base)) continue;
                                    const tv = str(tplRow[ci]);
                                    const gv = str(tgt[col]);
                                    const bv = str(base[col]);
                                    if (gv === tv && bv !== tv) { resetCount += 1; changedCount += 1; cols.push(col); }
                                    else if (gv !== bv) changedCount += 1;
                                }
                                // 只拦“整组的全部变化都是回到模板默认值”的空读写回：真实游戏
                                // 操作（重开一局、重置技能、商店刷新）通常伴随非默认值变化，
                                // 不应被守卫吞掉。
                                if (resetCount >= 2 && changedCount === resetCount) {
                                    for (const col of cols) tgt[col] = base[col];
                                    dbg(' [写回守卫] 单例组「' + L.group + '」检测到默认值写回（' + cols.join('、') + '），保留数据库真值。');
                                }
                            }
                        }
                    } catch (eG) {}
                    // 参考卡原生路径：写库 = 差异写入（updateCell/insertRow/deleteRow 原生 CRUD）。
                    // 运行时/checkpoint/落盘全部由插件自己的事务管线维护，与原生数据库卡一致；
                    // 不做整表快照导入、不做手动物化/锚定/单例补行（转换器只翻译，不参与运行时）。
                    let n = 0;
                    let bulkInit = false;
                    try {
                        // 诊断（保留）：布局组、target/prev 含组、首个非空写入、checkpoint 是否含注入
                        try {
                            const diagGroups = (Array.isArray(activeLayout) ? activeLayout : []).map(L => L.group);
                            const targetGroups = Object.keys(effectiveTarget || {}).filter(g => effectiveTarget[g] && typeof effectiveTarget[g] === 'object');
                            const prevGroups = Object.keys(prev || {}).filter(g => prev[g] && typeof prev[g] === 'object');
                            const firstWriteField = (() => {
                                for (const g of targetGroups) {
                                    const v = effectiveTarget[g];
                                    if (!v || typeof v !== 'object') continue;
                                    for (const k of Object.keys(v)) {
                                        const vv = v[k];
                                        if (vv !== undefined && vv !== null && vv !== '') return g + '.' + k + '=' + String(vv).slice(0, 40);
                                    }
                                }
                                return '';
                            })();
                            dbg('[注入合并] 本扩展会话首次兼容写库=' + !openingWriteSettledChats.has(chatKeyNow) +
                                ' | 布局组=' + diagGroups.join('、') +
                                ' | target含组=' + targetGroups.join('、') +
                                ' | prev含组=' + prevGroups.join('、') +
                                ' | 首个非空写入=' + (firstWriteField || '无') +
                                ' | 空组保护=启用');
                            // 诊断：每张行/JSON 表的 prev/target 键集合与 writePaths，定位“DELETE-only 误删”
                            try {
                                const isObj2 = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
                                const groupDiags = [];
                                for (const L of (Array.isArray(activeLayout) ? activeLayout : [])) {
                                    const wp = (L.writePaths || [])[0] || [L.group];
                                    const dictAt = (obj) => {
                                        let c = obj;
                                        for (const p of wp) { if (c === null || c === undefined || typeof c !== 'object') return undefined; c = c[p]; }
                                        return c;
                                    };
                                    const pv = dictAt(prev);
                                    const tv = dictAt(effectiveTarget);
                                    const pKeys = isObj2(pv) ? Object.keys(pv) : [];
                                    const tKeys = isObj2(tv) ? Object.keys(tv) : [];
                                    if (L.kind === 'rows' || L.kind === 'json') {
                                        groupDiags.push(L.group + '{' + L.kind + ',wp=' + wp.join('.') + ',prev=[' + pKeys.slice(0, 8).join(',') + '](' + pKeys.length + '),target=[' + tKeys.slice(0, 8).join(',') + '](' + tKeys.length + ')}');
                                    } else if (L.kind === 'singleton') {
                                        groupDiags.push(L.group + '{singleton,wp=' + wp.join('.') + ',prev=' + (isObj2(pv) ? JSON.stringify(pv).slice(0, 80) : 'none') + ',target=' + (isObj2(tv) ? JSON.stringify(tv).slice(0, 80) : 'none') + '}');
                                    }
                                }
                                dbg('[注入合并] 分组诊断: ' + (groupDiags.length ? groupDiags.join(' | ') : '无'));
                            } catch (eGrp) {}
                        } catch (e) {}
                        // 把持久化重建结果传给核心写路径：运行时仅表头但 checkpoint/日志已有该表
                        // 数据行时，核心补行必须跳过（否则造重复行 → “手动追平完整性校验失败”）。
                        let persistedForWrite = null;
                        try { persistedForWrite = readPersistedTableData(); } catch (e) {}
                        let tableBroadcastSuppressed = false;
                        try {
                            // 一次 replaceMvuData 可能翻译成多个 CRUD。插件每个
                            // CRUD 都会触发表更新回调；若逐格转发 MVU 事件，
                            // 前端会在中间态重读/重渲染数十次。整批期间抑制，
                            // 待全部落库后由下方统一广播一次。
                            sharedStateWindow.__mvu2shujukuSuppressTableMvuEnded = (Number(sharedStateWindow.__mvu2shujukuSuppressTableMvuEnded) || 0) + 1;
                            tableBroadcastSuppressed = true;
                            bulkInit = writeSession.messageUpdate
                                ? await commitMessageUpdateSnapshot(api, prev, effectiveTarget, writeSession)
                                : await tryOpeningBulkInit(api, prev, effectiveTarget, chatKeyNow, isInitializationWrite, writeSession);
                        } catch (e) {
                            if (writeSession.messageUpdate) bulkInit = 'retry';
                            dbgWarn(' 开局整表初始化快速路径异常：' + (e && e.message ? e.message : e));
                        }
                        try {
                            assertRuntimeSession(writeSession);
                            if (bulkInit === 'retry') {
                                writeUnsettled = true;
                                if (overlayFlushRetries < 6) {
                                    overlayFlushRetries += 1;
                                    dbg(' 开局整表初始化尚未落定，延后重试（#' + overlayFlushRetries + '）。');
                                    hostWindow.setTimeout(() => {
                                        if (statWriteOverlayGen === gen) scheduleWindowStatOverlay(target, null, true, isInitializationWrite, writeChatKey, writeSession);
                                    }, 1000);
                                    retryScheduled = true;
                                }
                                n = 0;
                            } else if (bulkInit) {
                                n = 1;
                                dbg(writeSession.messageUpdate ? ' 消息更新快照已提交到最新回复。' : ' 开局整表初始化快速路径完成（一次整表原子提交，跳过逐格 CRUD）。');
                            } else {
                                // 差异明细诊断：包一层 API 代理记录每个 CRUD 的表/行/列与前后值。
                                // 用于排查“duplicate_snapshot 已判定快照相同、diff 却产生多条操作”的
                                // 读回形状偏差（历史案例：圣樱学院-RE 开场最终快照 19 条逐格补写）。
                                let diffApi = api;
                                if (mvu2shujukuDebugOn() && api && typeof api.updateCell === 'function') {
                                    const clip = (v) => { try { const s = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v); return s.length > 60 ? s.slice(0, 60) + '…' : s; } catch (e) { return String(v); } };
                                    const cellNow = (t, ri, col) => {
                                        try {
                                            const all = api.exportTableAsJson() || {};
                                            const s = Object.values(all).find(x => x && x.name === t);
                                            const row = s && Array.isArray(s.content) ? s.content[ri] : null;
                                            const hdr = s && s.content ? s.content[0] : [];
                                            const ci = hdr.indexOf(col);
                                            return row && ci >= 0 ? clip(row[ci]) : '(定位失败)';
                                        } catch (e) { return '(读取失败)'; }
                                    };
                                    diffApi = Object.assign({}, api, {
                                        updateCell: async (t, ri, col, v) => {
                                            dbg('[差异明细] updateCell ' + t + '[' + ri + '].' + col + ' : ' + cellNow(t, ri, col) + ' → ' + clip(v));
                                            return api.updateCell(t, ri, col, v);
                                        },
                                        updateRow: async (t, ri, p) => {
                                            dbg('[差异明细] updateRow ' + t + '[' + ri + '] {' + Object.keys(p || {}).join('、') + '}');
                                            return api.updateRow(t, ri, p);
                                        },
                                        insertRow: async (t, o) => {
                                            dbg('[差异明细] insertRow ' + t + ' {' + Object.keys(o || {}).join('、') + '}');
                                            return api.insertRow(t, o);
                                        },
                                        deleteRow: async (t, ri) => {
                                            dbg('[差异明细] deleteRow ' + t + '[' + ri + ']');
                                            return api.deleteRow(t, ri);
                                        },
                                    });
                                }
                                n = await window.MVU2SHUJUKU_CORE.writeStatDiffToDb(diffApi, activeLayout, prev, effectiveTarget, persistedForWrite);
                                assertRuntimeSession(writeSession);
                            }
                        } finally {
                            if (tableBroadcastSuppressed) {
                                sharedStateWindow.__mvu2shujukuSuppressTableMvuEnded = Math.max(0, (Number(sharedStateWindow.__mvu2shujukuSuppressTableMvuEnded) || 1) - 1);
                            }
                        }
                        if (n > 0) {
                            openingWriteSettledChats.add(chatKeyNow);
                            pruneOrderedCollection(openingWriteSettledChats, 80);
                            lastDbWriteAt = Date.now();
                            dbg(bulkInit === true ? ' Mvu 写入完成：一次整表提交，插件自行持久化。' : ' Mvu 写入完成：差异 ' + n + ' 条（原生 CRUD，插件自行持久化）');
                        } else {
                            dbg(' 差异写入无操作（运行时与目标一致），跳过。');
                        }
                        // 写入出现失败（首楼替换/插件回放会清空运行时，导致 updateCell 越界等）：
                        // 不能当场补行——原行稍后会被重放恢复，补出来的行会变成重复行。
                        // 改为延迟重跑整次合并：waitRuntimeTablesReady 会等到插件重放完成，
                        // 原行回来就直接写、不重复；行真没了才由 seedNeeded 补。
                        try {
                            const coreNow = window.MVU2SHUJUKU_CORE;
                            if (bulkInit !== true && coreNow && coreNow.lastStatWriteFailed) {
                                writeUnsettled = true;
                                if (overlayFlushRetries < 4) {
                                overlayFlushRetries += 1;
                                dbg(' 写入存在失败（运行时被清空/行缺失），稍后重试合并（#' + overlayFlushRetries + '）。');
                                hostWindow.setTimeout(() => {
                                    if (statWriteOverlayGen === gen) scheduleWindowStatOverlay(target, null, true, isInitializationWrite, writeChatKey, writeSession);
                                }, 1500);
                                retryScheduled = true;
                                }
                            }
                        } catch (eR) {}
                    } catch (e) {
                        writeUnsettled = true;
                        dbgWarn(' 差异写入异常:', e && e.message ? e.message : e);
                    }
                    assertRuntimeSession(writeSession);
                    // 确保本次写入的持久化帧已落盘：插件保存可能防抖/异步，切聊天前不落盘会丢最后写入，
                    // 回放旧状态 → 前端读旧 → 写回默认值（“切换后还原”的直接来源）。只等待，不手工构造保存内容。
                    try {
                        const ctx2 = getContextSafe();
                        const saveFn2 = (typeof ctx2.saveChatConditional === 'function' && ctx2.saveChatConditional.bind(ctx2)) ||
                            (typeof ctx2.saveChat === 'function' && ctx2.saveChat.bind(ctx2)) ||
                            (typeof window.saveChatConditional === 'function' ? window.saveChatConditional.bind(window) : null) ||
                            (typeof window.saveChat === 'function' ? window.saveChat.bind(window) : null);
                        // 整表快速路径内的 importTableAsJson/initGameSession 已由插件以
                        // strictSave 提交；此处再保存一次会与卡内重载争用宿主保存锁。
                        // 仅逐格 CRUD 路径需要这层等待。
                        if (n > 0 && saveFn2 && bulkInit !== true) {
                            await Promise.resolve(saveFn2());
                            assertRuntimeSession(writeSession);
                            dbg('[保存] 写库后已等待酒馆保存完成。');
                        }
                    } catch (eS) { writeUnsettled = true; }
                    assertRuntimeSession(writeSession);
                    // 只有真正写了差异（n>0）才广播 VARIABLE_UPDATE_ENDED：
                    // 无差异回声写（前端把整份 stat_data 原样写回）此前也会触发广播 →
                    // 前端收到后重渲染 → 再回声 → 再广播，形成“一直刷”循环。
                    // 与官方语义一致：状态没变就不发更新事件。
                    if (n > 0 && !writeUnsettled) {
                        // 与官方 updateVariables 一致：VARIABLE_UPDATE_ENDED 期间 stat_data.$internal
                        // 临时携带 display_data/delta_data（事件后移除），供前端在事件回调里读取
                        const afterMvu = { stat_data: effectiveTarget, display_data: effectiveTarget, delta_data: {}, initialized_lorebooks: {} };
                        let hadInternal = false;
                        try { if (effectiveTarget && typeof effectiveTarget === 'object' && effectiveTarget.$internal === undefined) { effectiveTarget.$internal = { display_data: afterMvu.display_data, delta_data: afterMvu.delta_data }; hadInternal = true; } } catch (e) {}
                        if (bulkInit) emitMvuEvent('mag_variable_initialized', afterMvu, 0);
                        dispatchVariableUpdateEnded(afterMvu, { stat_data: prev, display_data: prev, delta_data: {}, initialized_lorebooks: {} });
                        try { if (hadInternal) delete effectiveTarget.$internal; } catch (e) {}
                    }
                    // 写入已落定（含“差异无操作”）：调用方（如开场分支注入）可在此时提交指纹
                    settledOk = !writeUnsettled;
                } else {
                    dbgWarn(' Mvu 合并写库被跳过：api=' + !!api + ' activeLayout=' + (activeLayout ? '有' : '空'));
                }
            } catch (e) {
                dbgWarn(' Mvu 合并写入异常:', e);
            } finally {
                if (statWriteOverlayGen === gen) {
                    pendingStatWrite = null;
                    if (!retryScheduled) pendingStatWriteIsInitialization = false;
                    invalidateStatProjectionCache();
                    try {
                        const ph = (typeof window !== 'undefined' ? window : root);
                        if (ph && ph.__mvu2shujukuPendingStat === target) ph.__mvu2shujukuPendingStat = null;
                    } catch (e) {}
                    // 已安排重试时保持 Promise pending，由最终重试结算。
                    if (!retryScheduled && statWriteFlushResolve) {
                        const resolveFlush = statWriteFlushResolve;
                        statWriteFlushResolve = null;
                        statWriteFlushPromise = null;
                        resolveFlush(settledOk);
                    }
                }
            }
        };
        statWriteTimer = hostWindow.setTimeout(() => {
            const task = statWriteInFlight.then(runFlush);
            statWriteInFlight = task.catch(e => { dbgWarn(' Mvu 写队列异常:', e); });
            return task;
        }, 150);
        return flushPromise;
    }

    // 扩展侧提供 window.getAllVariables：用卡内布局 + 插件表格实时重建 stat_data（惰性，零冗余）。
    // 只在当前卡是本转换器产物时安装；切到其他卡时恢复原函数（或删除），不污染其他卡。
    let installedGetAllVariables = false;
    let originalGetAllVariables = undefined;
    // 只读：运行时为空/插件异步回放中/切卡残留时，从当前聊天持久化帧（V2 storageFrame）重建表格数据。
    // 仅用于读侧兜底，防止前端“空读 → schema 默认值 → 写回”把数据库重置成默认值；不写运行时。
    // 基底取最后一个 full checkpoint 或 data_replace 完整后态；随后按 logEntries 顺序应用
    // row_upsert / row_delete（本转换器原生 CRUD 持久化的确定性补丁），即“数据库原始真相”。
    let persistedReadCache = { key: '', data: null };
    function persistedFrameFingerprint(value) {
        let source = '';
        try { source = typeof value === 'string' ? value : JSON.stringify(value); } catch (e) { source = String(value || ''); }
        // FNV-1a：避免“新旧 storageFrame JSON 恰好等长”时误用旧缓存。
        let hash = 2166136261;
        for (let i = 0; i < source.length; i++) {
            hash ^= source.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return source.length + ':' + (hash >>> 0).toString(16);
    }
    // SP 表更新回调的参数是事务已提交的新快照，但紧接着的
    // exportTableAsJson() 可能仍处在 replay/物化窗口而返回旧值。
    // 状态栏在更新回调后立即重读时，必须看到与回调事件同一份 after；
    // 只保留很短的读窗口，超时后仍回归插件运行时/持久化重建。
    let frontendCommittedMvuRead = null;
    function stageFrontendCommittedMvuRead(after) {
        try {
            frontendCommittedMvuRead = {
                chatKey: autoInitChatId(),
                cardKey: cardCacheKey(currentCharacter()),
                expiresAt: Date.now() + 5000,
                value: JSON.parse(JSON.stringify(after)),
            };
        } catch (e) { frontendCommittedMvuRead = null; }
    }
    function readFrontendCommittedMvuRead() {
        try {
            const item = frontendCommittedMvuRead;
            if (!item) return null;
            if (item.chatKey !== autoInitChatId() || item.cardKey !== cardCacheKey(currentCharacter()) || Date.now() > item.expiresAt) {
                frontendCommittedMvuRead = null;
                return null;
            }
            return JSON.parse(JSON.stringify(item.value));
        } catch (e) { return null; }
    }
    // 只读：从当前聊天持久化帧（V2 storageFrame）重建表格数据——“数据库真相”。
    // 基底取最后一个 full checkpoint 或 data_replace 完整后态；只应用其后 logEntries 的
    // row_upsert / row_delete（本转换器原生 CRUD 持久化的确定性补丁）。
    // 用于读侧兜底：运行时只是缓存（异步回放中可能为空/旧值），持久化帧才是最新真相，
    // 防止前端“空读/旧读 → schema 默认值 → 写回”把数据库重置成默认值。不写运行时。
    // 带按聊天缓存（key = 各消息 storage 帧长度和），写库/切聊天后自动失效。
    function readPersistedTableData() {
        try {
            const ctx = getContextSafe();
            const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
            let key = chat.length + ':';
            for (let mi = 0; mi < chat.length; mi++) {
                const msg = chat[mi];
                if (!msg || typeof msg !== 'object') continue;
                const iso = msg.TavernDB_ACU_IsolatedData;
                key += persistedFrameFingerprint(iso) + ',';
            }
            if (persistedReadCache.key === key) return persistedReadCache.data;
            let base = null;
            const ops = [];
            for (let mi = 0; mi < chat.length; mi++) {
                const msg = chat[mi];
                if (!msg || typeof msg !== 'object') continue;
                let iso = msg.TavernDB_ACU_IsolatedData;
                if (typeof iso === 'string') { try { iso = JSON.parse(iso); } catch (e) { continue; } }
                if (!iso || typeof iso !== 'object' || Array.isArray(iso)) continue;
                for (const tagKey of Object.keys(iso)) {
                    const tag = iso[tagKey];
                    if (!tag || typeof tag !== 'object' || Array.isArray(tag)) continue;
                    const sf = tag.storageFrame;
                    if (!sf || typeof sf !== 'object' || sf.version !== 2 || !Array.isArray(sf.logEntries)) continue;
                    const cp = sf.checkpoint;
                    if (cp && cp.kind === 'full' && cp.data && typeof cp.data === 'object') {
                        base = JSON.parse(JSON.stringify(cp.data));
                        ops.length = 0; // 该 checkpoint 已包含此前所有操作
                    }
                    for (const en of sf.logEntries) {
                        const eops = Array.isArray(en && en.operations) ? en.operations : [];
                        for (const op of eops) {
                            if (!op || typeof op !== 'object') continue;
                            if (op.kind === 'data_replace' && op.data && typeof op.data === 'object') {
                                base = JSON.parse(JSON.stringify(op.data));
                                ops.length = 0;
                            } else if (op.kind === 'row_upsert' || op.kind === 'row_delete' || op.kind === 'sql_sheet_batch') {
                                ops.push(op);
                            }
                        }
                    }
                }
            }
            let result = null;
            if (base) {
                for (const op of ops) {
                    const sheet = base[op.sheetKey];
                    if (!sheet || !Array.isArray(sheet.content)) continue;
                    if (op.kind === 'row_delete') {
                        const rid = String(op.rowId == null ? '' : op.rowId);
                        sheet.content = sheet.content.filter(function (row, idx) {
                            return idx === 0 || !Array.isArray(row) || String(row[0] == null ? '' : row[0]).trim() !== rid;
                        });
                    } else if (op.kind === 'row_upsert' && Array.isArray(op.cells)) {
                        const rid = String(op.rowId == null ? '' : op.rowId);
                        const cells = JSON.parse(JSON.stringify(op.cells));
                        const idx = sheet.content.findIndex(function (row, i2) {
                            return i2 > 0 && Array.isArray(row) && String(row[0] == null ? '' : row[0]).trim() === rid;
                        });
                        if (idx >= 0) sheet.content[idx] = cells;
                        else sheet.content.push(cells);
                    } else if (op.kind === 'sql_sheet_batch') {
                        // SQLite 模式的原生 CRUD（updateCell/insertRow/deleteRow）持久化为
                        // sql_sheet_batch（逐条 UPDATE/INSERT/DELETE 语句）。此前重建只认
                        // row_upsert/row_delete，会漏掉这些写入，导致“运行时为空”窗口内读到
                        // 陈旧 checkpoint（如充值后前端读到旧值并写回）。这里按语句回放。
                        replaySqlBatchIntoSheet(sheet, op);
                    }
                }
                result = base;
            }
            persistedReadCache = { key, data: result };
            return result;
        } catch (e) { return null; }
    }

    // 把插件 SQLite 模式持久化的 sql_sheet_batch（statements + params 数组）按序回放到
    // 重建的 sheet 上。支持三种语句形状（与插件 createTableCrudApi 一致）：
    //   UPDATE tbl SET col = ? WHERE row_id = ?;
    //   INSERT INTO tbl (c1, ...) VALUES (?, ...);
    //   DELETE FROM tbl WHERE row_id = ?;
    // 物理列名是中文表头的拼音 slug（toPinyinSlug），与扩展/插件命名一致。
    function replaySqlBatchIntoSheet(sheet, op) {
        try {
            const stmts = Array.isArray(op.statements) ? op.statements : [];
            const paramsList = Array.isArray(op.params) ? op.params : [];
            if (!Array.isArray(sheet.content) || !sheet.content.length) return;
            const header = sheet.content[0] || [];
            // 拼音 slug 助手：UI 运行副本（extensionIndexUi）的作用域里没有 toPinyinSlug，
            // 但同文件核心副本把它导出在 MVU2SHUJUKU_CORE 上（转换器/核心共享同一字典）。
            const slugOf = function (zh) {
                try {
                    if (typeof toPinyinSlug === 'function') return toPinyinSlug(String(zh));
                } catch (e) {}
                try {
                    const holder = (typeof window !== 'undefined' ? window : root);
                    if (holder && holder.MVU2SHUJUKU_CORE && typeof holder.MVU2SHUJUKU_CORE.toPinyinSlug === 'function') {
                        return holder.MVU2SHUJUKU_CORE.toPinyinSlug(String(zh));
                    }
                } catch (e) {}
                return '';
            };
            const colIndexBySlug = {};
            for (let hi = 0; hi < header.length; hi++) {
                const slug = slugOf(String(header[hi]));
                if (slug && colIndexBySlug[slug] === undefined) colIndexBySlug[slug] = hi;
            }
            const findRow = (rid) => {
                const s = String(rid == null ? '' : rid).trim();
                if (!s) return -1;
                for (let ri = 1; ri < sheet.content.length; ri++) {
                    const r = sheet.content[ri];
                    if (Array.isArray(r) && String(r[0] == null ? '' : r[0]).trim() === s) return ri;
                }
                return -1;
            };
            for (let si = 0; si < stmts.length; si++) {
                const sql = String(stmts[si] || '');
                const params = Array.isArray(paramsList[si]) ? paramsList[si] : [];
                const up = /UPDATE\s+\`?[A-Za-z0-9_]+\`?\s+SET\s+\`?([A-Za-z0-9_]+)\`?\s*=\s*\?\s*WHERE\s+\`?row_id\`?\s*=\s*\?/i.exec(sql);
                if (up) {
                    const ci = colIndexBySlug[String(up[1]).toLowerCase()];
                    if (ci === undefined) continue;
                    const ri = findRow(params[1]);
                    if (ri < 0) continue;
                    sheet.content[ri][ci] = params[0];
                    continue;
                }
                const del = /DELETE\s+FROM\s+\`?[A-Za-z0-9_]+\`?\s+WHERE\s+\`?row_id\`?\s*=\s*\?/i.exec(sql);
                if (del) {
                    const rid = String(params[0] == null ? '' : params[0]).trim();
                    if (rid) {
                        sheet.content = sheet.content.filter(function (row, idx) {
                            return idx === 0 || !Array.isArray(row) || String(row[0] == null ? '' : row[0]).trim() !== rid;
                        });
                    }
                    continue;
                }
                const ins = /INSERT\s+INTO\s+\`?[A-Za-z0-9_]+\`?\s*(?:\(([^)]*)\))?\s*(?:VALUES\s*\(([^)]*)\))?/i.exec(sql);
                if (ins) {
                    const colPart = String(ins[1] || '');
                    const colNames = colPart.split(',').map(function (s) { return String(s).replace(/[\`\s]/g, '').toLowerCase(); }).filter(Boolean);
                    const row = header.map(function () { return ''; });
                    let hasRowId = false;
                    let nameVal = null;
                    let nameIdx = -1;
                    for (let ci2 = 0; ci2 < colNames.length; ci2++) {
                        const cn = colNames[ci2];
                        let hIdx = -1;
                        if (cn === 'row_id') hIdx = 0;
                        else if (colIndexBySlug[cn] !== undefined) hIdx = colIndexBySlug[cn];
                        if (hIdx >= 0) {
                            if (hIdx === 0) hasRowId = true;
                            if (hIdx > 0 && String(header[hIdx]) === '名称') { nameIdx = hIdx; nameVal = params[ci2]; }
                            if (params[ci2] !== undefined) row[hIdx] = params[ci2];
                        }
                    }
                    let targetRi = -1;
                    if (nameIdx >= 0 && nameVal !== null && nameVal !== undefined) {
                        for (let ri2 = 1; ri2 < sheet.content.length; ri2++) {
                            const r2 = sheet.content[ri2];
                            if (Array.isArray(r2) && String(r2[nameIdx] == null ? '' : r2[nameIdx]) === String(nameVal)) { targetRi = ri2; break; }
                        }
                    }
                    if (targetRi >= 0) {
                        for (let ci3 = 0; ci3 < row.length; ci3++) {
                            if (row[ci3] !== '' && row[ci3] !== null && row[ci3] !== undefined) sheet.content[targetRi][ci3] = row[ci3];
                        }
                    } else {
                        if (!hasRowId || row[0] === '' || row[0] === null || row[0] === undefined) {
                            let maxId = 0;
                            for (let ri3 = 1; ri3 < sheet.content.length; ri3++) {
                                const r3 = sheet.content[ri3];
                                if (Array.isArray(r3) && r3[0] !== undefined && r3[0] !== null && !isNaN(Number(r3[0]))) maxId = Math.max(maxId, Number(r3[0]));
                            }
                            row[0] = String(maxId + 1);
                        }
                        sheet.content.push(row);
                    }
                }
            }
        } catch (e) {}
    }

    // EJS 会在 CHAT_CHANGED 的同步提示词构建阶段执行，比 autoInitDatabase
    // 的延时完整卡加载更早。这里直接从当前角色扩展标记同步恢复布局，
    // 否则 getAllVariables 的早期读取会因 activeLayout 未就绪返回空 stat_data。
    function ensureActiveLayoutLazy() {
        try {
            if (activeLayout && layoutBelongsToCurrentCard(activeLayoutCardKey)) return true;
            const ch = currentCharacter();
            if (!ch || !isConvertedMvuCard(ch)) return false;
            const ext = charExtensions(ch);
            const mk = ext && ext.mvu2shujuku;
            if (!mk || !mk.layout) return false;
            const parsed = typeof mk.layout === 'string' ? JSON.parse(mk.layout) : mk.layout;
            if (!Array.isArray(parsed) || !parsed.length) return false;
            activeLayout = resolveRuntimeLayout(parsed);
            activeLayoutCardKey = cardCacheKey(ch);
            activePlaceholderNeeded = detectPlaceholderFor(ch);
            // 同步解码卡内模板作为回放未就绪时的结构/初值兜底。
            try { cachedTemplateForCurrentCard(); } catch (e) {}
            dbg(' EJS 早期读取：已从当前卡标记惰性恢复布局（' + parsed.length + ' 项）。');
            return true;
        } catch (e) { return false; }
    }

    function ejsVariablesSafe() {
        let current = null;
        try { if (typeof window.getAllVariables === 'function') current = window.getAllVariables(); } catch (e) {}
        try {
            if (!ensureActiveLayoutLazy()) return current && current.stat_data ? current : { stat_data: {}, display_data: {} };
            const core = window.MVU2SHUJUKU_CORE;
            if (!core || typeof core.statDataFromTables !== 'function') return current || { stat_data: {}, display_data: {} };
            // 世界书 EJS 与状态栏必须共享同一读优先级：
            // 待写快照 > SP 已提交回调 > 完整运行时表 > 持久化帧 > 结构骨架。
            // 旧逻辑无条件优先 checkpoint，当 checkpoint 仍是开局快照而当前表已更新时，
            // format_message_variable/getvar 会偶发读到默认初始值。
            if (pendingStatWrite && typeof pendingStatWrite === 'object') {
                return { stat_data: pendingStatWrite, display_data: {}, delta_data: {}, initialized_lorebooks: {} };
            }
            const committed = readFrontendCommittedMvuRead();
            if (committed && committed.stat_data) return committed;
            try {
                const api = getAcuApi();
                const runtime = api && typeof api.exportTableAsJson === 'function' ? (api.exportTableAsJson() || {}) : null;
                if (runtime && tableSnapshotCoversLayout(runtime, activeLayout)) {
                    return statDataFromTablesCached(activeLayout, runtime);
                }
            } catch (e) {}
            // 运行时表尚未完整回放时，checkpoint/log 才是更可靠的当前聊天真相。
            try {
                const persisted = readPersistedTableData();
                if (persisted && tableSnapshotCoversLayout(persisted, activeLayout)) {
                    return statDataFromTablesCached(activeLayout, persisted);
                }
            } catch (e) {}
            // 先用空表+布局构造“必定存在的结构骨架”，再用实际读取覆盖。
            // 这只防 undefined 链式访问，不触发任何数据库写入。
            const base = core.statDataFromTables(activeLayout, {});
            const merge = (dst, src) => {
                if (!src || typeof src !== 'object' || Array.isArray(src)) return dst;
                for (const k of Object.keys(src)) {
                    const sv = src[k];
                    if (sv && typeof sv === 'object' && !Array.isArray(sv) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) merge(dst[k], sv);
                    else dst[k] = sv;
                }
                return dst;
            };
            if (current && current.stat_data && typeof current.stat_data === 'object') merge(base.stat_data, current.stat_data);
            if (current && current.display_data && typeof current.display_data === 'object') base.display_data = current.display_data;
            return base;
        } catch (e) { return current || { stat_data: {}, display_data: {} }; }
    }

    // 读路径投影缓存：statDataFromTables 是 O(整个 stat_data) 的全量反投影，状态栏
    // 刷新、EJS 渲染、宏替换每次读都会触发。SP 的 exportTableAsJson() 返回
    // currentJsonTableData 的稳定引用（数据更新时整体换新对象），据此缓存：
    // 引用 + 聊天 + 布局一致且未越过短 TTL 时直接复用上次投影（与
    // stageFrontendCommittedMvuRead 一样把同一对象交给调用方——MVU 原版 getMvuData
    // 也返回内部对象引用）。写入、SP 提交回调、切聊天都会主动失效；TTL 兜底覆盖
    // 未被引用替换捕获的原地变更。
    let statProjectionCache = null;
    function invalidateStatProjectionCache() { statProjectionCache = null; }
    function statDataFromTablesCached(layout, tables) {
        const core = window.MVU2SHUJUKU_CORE;
        if (!core || typeof core.statDataFromTables !== 'function') return null;
        let chatKey = '';
        try { chatKey = autoInitChatId(); } catch (e) {}
        const now = Date.now();
        const hit = statProjectionCache;
        if (hit && hit.chatKey === chatKey && hit.layout === layout && hit.tables === tables && (now - hit.at) < 1500) return hit.wrap;
        const wrap = core.statDataFromTables(layout, tables);
        statProjectionCache = { chatKey, layout, tables, wrap, at: now };
        return wrap;
    }

    function installWindowGetAllVariables() {
        const core = window.MVU2SHUJUKU_CORE;
        if (!core || typeof core.statDataFromTables !== 'function') return;
        if (!installedGetAllVariables) {
            // 覆盖前登记真原始值（可能是真 MVU 的函数或桥版；还原时从共享注册表取回）
            noteGlobalOriginals(window);
            originalGetAllVariables = window.getAllVariables;
            installedGetAllVariables = true;
        }
        window.getAllVariables = function () {
            try {
                // 布局归属校验：切卡空窗期 activeLayout 还是上一张卡的。
                // 未就绪时先从当前角色即时解析布局（挂载期 autoInit 可能还没跑完），
                // 仍拿不到才返回空——否则前端空读→schema 默认值→写回会重置数据库。
                if (!layoutBelongsToCurrentCard(activeLayoutCardKey)) {
                    if (!ensureActiveLayoutLazy()) {
                        return { stat_data: {}, display_data: {} };
                    }
                }
                // SP 已提交回调后的前端刷新窗口：回调 after 比尚未物化完成的
                // exportTableAsJson() 更新，也是本次 VARIABLE_UPDATE_ENDED 的权威载荷。
                const committedRead = readFrontendCommittedMvuRead();
                if (committedRead && committedRead.stat_data) return committedRead;
                const api = getAcuApi();
                if (!api || typeof api.exportTableAsJson !== 'function' || !activeLayout) {
                    try {
                        const persisted0 = readPersistedTableData();
                        if (persisted0) return statDataFromTablesCached(activeLayout || [], persisted0);
                    } catch (e) {}
                    return core.statDataFromTables(activeLayout || [], {});
                }
                // 运行时优先：插件就绪后运行时即插件完整回放的权威状态（含全部表与溢出字段）。
                // 持久化重建只是空/跨卡窗口的兜底。“就绪”必须满足当前 layout 的全部表，
                // 且每张单例/JSON 表都有数据行；只看“任意表有行”会把 V2 replay
                // 中已物化一部分的半成品当成完整快照。此时若按运行时读，
                // 单例表会退化成布局默认值（如 当前MC点=0/零花钱=6000），前端读到后既显示又写回；
                // 必须先等 content 有行，或改用持久化重建（checkpoint + row_upsert/sql_sheet_batch）。
                const cur = api.exportTableAsJson() || {};
                // 切卡隔离必须早于“运行时不完整 → 持久化兜底”：切卡空窗内
                // 运行时和聊天帧都可能还属于上一张卡，不得用新 layout 投影旧卡快照。
                try {
                    const foreign = runtimeForeignTableNames(api, activeLayout);
                    if (foreign.length) {
                        const persisted2 = readPersistedTableData();
                        if (persisted2 && tableSnapshotCoversLayout(persisted2, activeLayout)) {
                            dbg(' [切卡隔离] 运行时含跨卡残留表：' + foreign.join('、') + '，改用当前卡持久化帧。');
                            return statDataFromTablesCached(activeLayout, persisted2);
                        }
                        dbg(' [切卡隔离] 运行时/持久化帧仍属于旧卡，读取返回空。');
                        return { stat_data: {}, display_data: {} };
                    }
                } catch (e) {}
                if (!tableSnapshotCoversLayout(cur, activeLayout)) {
                    const persisted = readPersistedTableData();
                    if (persisted) return statDataFromTablesCached(activeLayout, persisted);
                    // 无持久化帧（全新聊天、插件尚未建锚/物化）：退回按运行时表重建。
                    // 只有表头时单例表回到布局默认值（= 卡模板初始行，与旧行为一致），
                    // 避免前端拿到空对象后按它自己的默认值（如 25/6000）写回。
                    return statDataFromTablesCached(activeLayout, cur);
                }
                return statDataFromTablesCached(activeLayout, cur);
            } catch (e) {
                return { stat_data: {}, display_data: {} };
            }
        };
        window.getAllVariables.__mvu2shujuku = true;
        dbg(' 扩展侧已定义 window.getAllVariables（读插件表格重建 stat_data）');
    }
    function restoreWindowGetAllVariables() {
        if (!installedGetAllVariables) return;
        invalidateStatProjectionCache();
        try {
            if (window.getAllVariables && window.getAllVariables.__mvu2shujuku === true) {
                // 从共享注册表还原真原始值（绝不把桥版/我们自己顶替回去）
                const reg = sharedStateWindow.__mvu2shujukuGlobalState;
                let rec = null;
                if (reg && Array.isArray(reg.list)) rec = reg.list.find(r => r.w === window);
                if (rec && rec.hasGav) window.getAllVariables = rec.gav;
                else delete window.getAllVariables;
            }
        } catch (e) {}
        installedGetAllVariables = false;
        originalGetAllVariables = undefined;
    }

    // 表格更新广播：与 MVU 原版一致，数据库一有变动就广播 VARIABLE_UPDATE_ENDED，
    // 携带更新前后的完整变量。部分 MVU 卡的 Zod/结算监听器会直接读取
    // before.stat_data，因此即使插件只提供 after，也不能把 before 留空。
    // 只在本转换器产物的卡上广播（activeLayout 仅对转换卡缓存），其他数据库卡即使触发表格更新也不发 MVU 事件。
    let lastVariableUpdateSnapshot = null;
    let lastVariableUpdateChatKey = '';
    // 历史回放兜底用它区分“当前回退快照以前碰巧广播过”与“本次聊天变更后
    // 已经由 SP 回调广播过”。只比较 stat_data 指纹无法区分 A→B→A。
    let variableUpdateDispatchSeq = 0;
    let pendingLateFrontendUpdate = null;
    function armLateFrontendUpdate(after, before) {
        try {
            pendingLateFrontendUpdate = {
                chatKey: autoInitChatId(),
                expiresAt: Date.now() + 10000,
                after: JSON.parse(JSON.stringify(after)),
                before: JSON.parse(JSON.stringify(before)),
            };
        } catch (e) { pendingLateFrontendUpdate = null; }
    }
    function dispatchVariableUpdateEnded(after, before) {
        try {
            if (!activeLayout) return;
            if (after === undefined || after === null) {
                try { if (typeof window.getAllVariables === 'function') after = window.getAllVariables(); } catch (e) {}
            }
            const safeAfter = after || { stat_data: {}, display_data: {}, delta_data: {} };
            const chatKey = autoInitChatId();
            if (lastVariableUpdateChatKey !== chatKey) {
                lastVariableUpdateChatKey = chatKey;
                lastVariableUpdateSnapshot = null;
            }
            const safeBefore = before && typeof before === 'object'
                ? before
                : (lastVariableUpdateSnapshot || safeAfter);
            emitMvuEvent('mag_variable_update_ended', safeAfter, safeBefore);
            // 数据库原生前端常用的兼容事件。转换卡前端可能只监听其中一种，
            // 同一份权威快照同时广播；事件监听型前端仍由各自的事件名自行去重。
            emitMvuEvent('shujuku-table-updated', null);
            variableUpdateDispatchSeq += 1;
            // 重生成会先删除旧 AI 消息及其状态栏 iframe。变量更新可能在
            // 新 iframe 挂载前已广播；保留一份 10s 的一次性载荷，新 iframe
            // 出现后定向时序补发。无 iframe 变化时不会多发事件。
            armLateFrontendUpdate(safeAfter, safeBefore);
            try { reentryNotifyFingerprint = chatKey + '|' + canonicalJsonForSync(safeAfter.stat_data || {}); } catch (e) {}
            try { lastVariableUpdateSnapshot = JSON.parse(JSON.stringify(safeAfter)); }
            catch (e) { lastVariableUpdateSnapshot = safeAfter; }
        } catch (e) {}
    }

    // 事件广播：与 MVU 原版一致，优先走 TH 事件总线（eventEmit，前端 eventOn 监听的就是它）；
    // 另发同名 CustomEvent + ST eventSource，覆盖 window/parent/top/同源 iframe；
    // 缺少 ST 事件总线的窗口（如消息 iframe）补一个绑定到同名 CustomEvent 的 eventOn/eventOff 兜底。
    function installEarlyEventOnFallback() {
        try {
            for (const w of [window, hostWindow]) {
                if (!w || typeof w.addEventListener !== 'function' || typeof w.eventOn === 'function') continue;
                w.eventOn = (evName, handler) => {
                    const wrapped = (e) => {
                        try {
                            const d = e && e.detail;
                            if (d && Object.prototype.hasOwnProperty.call(d, 'after')) handler(d.after, d.before);
                            else handler(d);
                        } catch (err) {}
                    };
                    w.addEventListener(evName, wrapped);
                    return { stop: () => { try { w.removeEventListener(evName, wrapped); } catch (e2) {} } };
                };
                w.eventOff = (evName, handler) => { try { w.removeEventListener(evName, handler); } catch (e2) {} };
                w.eventOn.__mvu2shujukuFallback = true;
                w.eventOff.__mvu2shujukuFallback = true;
            }
        } catch (e) {}
    }
    async function emitMvuEvent(name, ...args) {
        // 广播前先把 shim/getAllVariables 同步到当前所有 iframe：
        // 即使新 iframe 恰好在 2s 复查和 MutationObserver 之间创建，
        // 前端在事件回调里读 window.Mvu/getAllVariables 也一定能拿到。
        if (activeLayout) { try { applyWindowMvuShim(); } catch (e) {} }
        const targets = [];
        const add = (t) => { try { if (t && typeof t.dispatchEvent === 'function' && targets.indexOf(t) === -1) targets.push(t); } catch (e) {} };
        add(window);
        add(hostWindow);
        try { add(window.parent); } catch (e) {}
        try { add(window.top); } catch (e) {}
        for (const r of [window, hostWindow]) {
            try {
                const frames = r.document ? r.document.querySelectorAll('iframe') : [];
                for (const f of frames) { try { add(f.contentWindow); } catch (e) {} }
            } catch (e) {}
        }
        const pending = [];
        const emitted = [];
        const invoke = (fn, owner) => {
            if (typeof fn !== 'function' || emitted.indexOf(fn) !== -1) return false;
            emitted.push(fn);
            try { pending.push(Promise.resolve(fn.apply(owner, [name, ...args]))); } catch (e) {}
            return true;
        };
        for (const t of targets) {
            try { const EC = t.CustomEvent || CustomEvent; t.dispatchEvent(new EC(name, { detail: { args, after: args[0], before: args[1] } })); } catch (e) {}
        }
        // TH 注入到主窗口和各 iframe 的 eventEmit 虽然包装函数不同，
        // 却通常连到同一条全局总线。对每个 target 逐一调用会把
        // 一次更新放大成数十次；只选一个总线入口。
        let busEmitted = false;
        try { busEmitted = invoke(hostWindow.eventEmit, hostWindow) || busEmitted; } catch (e) {}
        try { if (!busEmitted) busEmitted = invoke(window.eventEmit, window) || busEmitted; } catch (e) {}
        if (!busEmitted) {
            for (const t of targets) {
                try { if (invoke(t.eventEmit, t)) { busEmitted = true; break; } } catch (e) {}
            }
        }
        // 没有 TavernHelper eventEmit 时才回退到 ST eventSource，避免同链双发。
        if (!busEmitted) {
            for (const t of targets) {
                try { if (t.eventSource && invoke(t.eventSource.emit, t.eventSource)) break; } catch (e) {}
            }
        }
        for (const t of targets) {
            try {
                if (t && typeof t.eventOn !== 'function' && typeof t.addEventListener === 'function') {
                    t.eventOn = (evName, handler) => {
                        const wrapped = (e) => {
                            try {
                                const d = e && e.detail;
                                if (d && Array.isArray(d.args)) handler(...d.args);
                                else if (d && Object.prototype.hasOwnProperty.call(d, 'after')) handler(d.after, d.before);
                                else handler(d);
                            } catch (err) {}
                        };
                        t.addEventListener(evName, wrapped);
                        return { stop: () => { try { t.removeEventListener(evName, wrapped); } catch (e) {} } };
                    };
                    t.eventOff = (evName, handler) => { try { t.removeEventListener(evName, handler); } catch (e) {} };
                    t.eventOn.__mvu2shujukuFallback = true;
                    t.eventOff.__mvu2shujukuFallback = true;
                }
            } catch (e) {}
        }
        if (pending.length) await Promise.allSettled(pending);
    }

    let tableUpdateHookApi = null;
    let tableUpdateHookTimer = null;
    let tableUpdateHookPendingData = null;
    let tableUpdateHookSession = null;
    let tableUpdateHookRetryCount = 0;
    function tableSnapshotHasSheets(data) {
        if (!data || typeof data !== 'object') return false;
        for (const k in data) {
            if (k.indexOf('sheet_') === 0 && data[k] && data[k].name) return true;
        }
        return false;
    }
    function tableSnapshotCoversLayout(data, layout) {
        if (!tableSnapshotHasSheets(data) || !Array.isArray(layout) || !layout.length) return false;
        const byName = {};
        for (const k in data) {
            const sheet = data[k];
            if (k.indexOf('sheet_') === 0 && sheet && sheet.name) byName[String(sheet.name)] = sheet;
        }
        const requirements = {};
        for (const L of layout) {
            if (!L || !L.table) continue;
            const name = String(L.table);
            requirements[name] = requirements[name] || { row: false };
            if (L.kind === 'singleton' || L.kind === 'json') requirements[name].row = true;
        }
        for (const name of Object.keys(requirements)) {
            const sheet = byName[name];
            if (!sheet) return false;
            if (requirements[name].row && (!Array.isArray(sheet.content) || sheet.content.length <= 1)) return false;
        }
        return true;
    }

    function mvuDataFromCompleteTableSnapshot(data) {
        try {
            if (!activeLayout || !tableSnapshotCoversLayout(data, activeLayout)) return null;
            const core = window.MVU2SHUJUKU_CORE;
            if (!core || typeof core.statDataFromTables !== 'function') return null;
            const after = core.statDataFromTables(activeLayout, data);
            return after && after.stat_data ? after : null;
        } catch (e) { return null; }
    }

    // 所有表格变化共用同一个前端出口：SP 的提交回调、聊天历史回放兜底都必须
    // 先暂存同一份权威 after，再驱动事件、无副作用的直接重读入口和明确刷新控件。
    // 整页 body.load/iframe reload 只允许手动执行，避免普通改单元格清空前端局部状态。
    function publishCommittedTableSnapshot(data, source, force) {
        const after = mvuDataFromCompleteTableSnapshot(data);
        if (!after) return false;
        try {
            const fp = autoInitChatId() + '|' + canonicalJsonForSync(after.stat_data);
            if (!force && fp === reentryNotifyFingerprint) {
                dbg('[' + source + '] 快照未变，已去重。');
                return false;
            }
            reentryNotifyFingerprint = fp;
            stageFrontendCommittedMvuRead(after);
            const result = refreshCurrentCardFrontends({
                after,
                allowHardReload: false,
            });
            dbg('[' + source + '] 已同步前端：直接 ' + result.direct +
                '、事件 ' + result.event + '、控件 ' + result.control + '。');
            return true;
        } catch (e) {
            dbgWarn(' ' + source + ' 转换/广播快照失败:', e && e.message ? e.message : e);
            return false;
        }
    }

    // 删楼、切 swipe、编辑消息改变的不是某一次 CRUD，而是“剩余聊天历史回放后的
    // 整体表状态”。SP v8.9.2 会在约 1.2s 后通知回调，但旧版、重载窗口或回调
    // 容器竞争可能漏掉。记录事件前运行时指纹，随后只接受完整且确实变化的快照；
    // 回调已经成功广播时用 dispatchSeq 消重，保证 A→B→A 也不会被历史指纹误拦。
    let chatMutationFrontendSyncGeneration = 0;
    let chatMutationFrontendSyncState = null;
    function cancelChatMutationFrontendSync() {
        chatMutationFrontendSyncGeneration += 1;
        const state = chatMutationFrontendSyncState;
        chatMutationFrontendSyncState = null;
        if (!state || !Array.isArray(state.timers)) return;
        for (const timer of state.timers) {
            try { hostWindow.clearTimeout(timer); } catch (e) {}
        }
    }
    function captureCompleteRuntimeTableSnapshot() {
        try {
            const api = getAcuApi();
            if (!api || typeof api.exportTableAsJson !== 'function') return null;
            const data = api.exportTableAsJson() || {};
            const after = mvuDataFromCompleteTableSnapshot(data);
            if (!after) return null;
            return {
                data,
                fingerprint: autoInitChatId() + '|' + canonicalJsonForSync(after.stat_data),
            };
        } catch (e) { return null; }
    }
    function scheduleChatMutationFrontendSync(reason, forceUnknownBaseline) {
        let chatKey = '';
        let cardKey = '';
        try {
            chatKey = autoInitChatId();
            cardKey = cardCacheKey(currentCharacter());
        } catch (e) {}
        const now = Date.now();
        const existing = chatMutationFrontendSyncState;
        const canMerge = !!(existing && existing.chatKey === chatKey && existing.cardKey === cardKey && existing.expiresAt > now);
        const captured = canMerge ? null : captureCompleteRuntimeTableSnapshot();
        let baselineFingerprint = canMerge ? existing.baselineFingerprint : (captured && captured.fingerprint) || '';
        if (!baselineFingerprint && String(reentryNotifyFingerprint || '').indexOf(chatKey + '|') === 0) {
            baselineFingerprint = reentryNotifyFingerprint;
        }
        const dispatchSeqAtStart = canMerge ? existing.dispatchSeqAtStart : variableUpdateDispatchSeq;
        const forceUnknown = !!forceUnknownBaseline || !!(canMerge && existing.forceUnknownBaseline);

        cancelChatMutationFrontendSync();
        const generation = chatMutationFrontendSyncGeneration;
        const state = {
            generation,
            chatKey,
            cardKey,
            reason: String(reason || 'chat_mutation'),
            baselineFingerprint,
            dispatchSeqAtStart,
            forceUnknownBaseline: forceUnknown,
            expiresAt: now + 13000,
            timers: [],
        };
        chatMutationFrontendSyncState = state;
        const delays = [1600, 3000, 5200, 8000, 12000];
        const finish = () => {
            if (chatMutationFrontendSyncState !== state) return;
            for (const timer of state.timers) {
                try { hostWindow.clearTimeout(timer); } catch (e) {}
            }
            chatMutationFrontendSyncState = null;
        };
        delays.forEach((delay, index) => {
            const timer = hostWindow.setTimeout(() => {
                if (chatMutationFrontendSyncState !== state || state.generation !== chatMutationFrontendSyncGeneration) return;
                try {
                    if (autoInitChatId() !== state.chatKey || cardCacheKey(currentCharacter()) !== state.cardKey) {
                        finish();
                        return;
                    }
                } catch (e) { finish(); return; }
                const current = captureCompleteRuntimeTableSnapshot();
                if (!current) return;
                const changedFromBaseline = !!state.baselineFingerprint && current.fingerprint !== state.baselineFingerprint;
                const finalUnknownFallback = !state.baselineFingerprint && state.forceUnknownBaseline && index === delays.length - 1;
                if (!changedFromBaseline && !finalUnknownFallback) return;
                // 本次聊天事件之后若已经广播了同一 post-replay 快照，说明 SP 主回调成功，
                // 这里只结束轮询；否则强制发送，允许状态从 B 回到更早广播过的 A。
                const alreadyDelivered = variableUpdateDispatchSeq > state.dispatchSeqAtStart &&
                    reentryNotifyFingerprint === current.fingerprint;
                if (!alreadyDelivered) publishCommittedTableSnapshot(current.data, '聊天回放兜底/' + state.reason, true);
                else dbg('[聊天回放兜底/' + state.reason + '] SP 回调已同步同一快照。');
                finish();
            }, delay);
            state.timers.push(timer);
        });
    }

    // 有些旧式状态栏不监听 VARIABLE_UPDATE_ENDED，只在挂载时或点击自带的
    // “刷新数据”控件时重读 message 变量。SP 自动填表发生在楼层挂载之后，
    // 因此仅在已提交的表更新回调后触发这些明确声明的刷新控件。
    // 不按文本模糊匹配，也不重载 iframe/楼层，避免重置前端局部状态。
    function refreshExplicitFrontendDataControls(skipWindows) {
        const skipped = skipWindows || [];
        const windows = [];
        const documents = [];
        const documentOwners = [];
        const controls = [];
        const visit = (w) => {
            try {
                if (!w || windows.indexOf(w) !== -1) return;
                windows.push(w);
                const doc = w.document;
                if (!doc) return;
                if (documents.indexOf(doc) === -1) {
                    documents.push(doc);
                    documentOwners.push(w);
                }
                const frames = typeof doc.querySelectorAll === 'function' ? doc.querySelectorAll('iframe') : [];
                for (const frame of frames) { try { visit(frame.contentWindow); } catch (e) {} }
            } catch (e) {}
        };
        visit(window); visit(hostWindow);
        try { visit(window.parent); } catch (e) {}
        try { visit(window.top); } catch (e) {}
        const selector = [
            'button[title="刷新数据"]',
            '[role="button"][title="刷新数据"]',
            'button[aria-label="刷新数据"]',
            'button[title="Refresh data"]',
            '[role="button"][title="Refresh data"]',
            'button[aria-label="Refresh data"]',
            '[data-mvu-refresh]',
        ].join(',');
        for (let di = 0; di < documents.length; di++) {
            const doc = documents[di];
            const owner = documentOwners[di];
            try {
                const found = typeof doc.querySelectorAll === 'function' ? doc.querySelectorAll(selector) : [];
                for (const control of found) {
                    if (control && !controls.some(rec => rec.control === control)) controls.push({ control, owner });
                }
            } catch (e) {}
        }
        let count = 0;
        for (const rec of controls) {
            try {
                const control = rec.control;
                const owner = rec.owner;
                if (skipped.indexOf(owner) !== -1) continue;
                if (control.disabled || typeof control.click !== 'function') continue;
                control.click();
                count += 1;
            } catch (e) {}
        }
        if (count) dbg('[前端刷新] 已触发 ' + count + ' 个显式“刷新数据”控件。');
        return count;
    }

    function readCardFrontendMode(w) {
        try {
            const globalMode = w && w.__mvu2shujukuFrontendMode;
            if (/^(?:event|direct|control|reload)$/.test(String(globalMode || ''))) return String(globalMode);
            const doc = w && w.document;
            const nodes = [doc && doc.documentElement, doc && doc.body];
            for (const node of nodes) {
                const mode = node && node.getAttribute && node.getAttribute('data-mvu2shujuku-frontend');
                if (mode) return String(mode);
            }
            const scripts = doc && doc.querySelectorAll ? doc.querySelectorAll('script') : [];
            for (const script of scripts) {
                if (script.getAttribute && script.getAttribute('src')) continue;
                const m = String(script.textContent || script.innerHTML || '').match(/__mvu2shujukuFrontendMode\s*=\s*["'](event|direct|control|reload)["']/);
                if (m) return m[1];
            }
        } catch (e) {}
        return '';
    }

    function flushTableUpdateHook() {
        tableUpdateHookTimer = null;
        if (!isRuntimeSessionCurrent(tableUpdateHookSession)) {
            tableUpdateHookPendingData = null;
            tableUpdateHookSession = null;
            return;
        }
        if (!activeLayout) return;
        try {
            if (Number(sharedStateWindow.__mvu2shujukuSuppressTableMvuEnded) > 0) {
                // 批量 MVU 写入会暂时抑制每个内部 CRUD 的回调。过去这里直接 return，
                // 恰好重叠的外部表变化也会永久丢通知；保留 pending 快照并等批次结束。
                if (tableUpdateHookRetryCount < 8) {
                    tableUpdateHookRetryCount += 1;
                    tableUpdateHookTimer = hostWindow.setTimeout(flushTableUpdateHook, Math.min(1200, 150 * tableUpdateHookRetryCount));
                }
                return;
            }
        } catch (e0) {}
        let data = tableUpdateHookPendingData;
        tableUpdateHookPendingData = null;
        try {
            const currentApi = getAcuApi();
            // SP 回调参数就是本次提交后的 currentJsonTableData。优先使用它：
            // 持久化后紧接着的 replay/物化窗口内，exportTableAsJson() 可能短暂
            // 为空或仍是旧快照，会把有效的前端刷新丢掉。
            if (!tableSnapshotCoversLayout(data, activeLayout) && currentApi && typeof currentApi.exportTableAsJson === 'function') {
                data = currentApi.exportTableAsJson() || {};
            }
        } catch (e2) { data = data || {}; }
        // 切换聊天时 SP 会先通知“运行时已清空”。不广播空数据，
        // 但给后续物化留一个有限重试窗口。
        if (!tableSnapshotCoversLayout(data, activeLayout)) {
            if (tableUpdateHookRetryCount < 8) {
                tableUpdateHookRetryCount += 1;
                tableUpdateHookTimer = hostWindow.setTimeout(flushTableUpdateHook, Math.min(1200, 300 * tableUpdateHookRetryCount));
            }
            return;
        }
        tableUpdateHookRetryCount = 0;
        publishCommittedTableSnapshot(data, '表格更新回调', false);
    }
    const tableUpdateHookCallback = (latestTableData) => {
        if (!activeLayout) return;
        tableUpdateHookSession = captureRuntimeSession();
        // SP 每次事务提交都代表运行时数据已变化（含被抑制广播的批量 CRUD），
        // 投影缓存必须立即失效。
        invalidateStatProjectionCache();
        if (tableSnapshotHasSheets(latestTableData)) tableUpdateHookPendingData = latestTableData;
        tableUpdateHookRetryCount = 0;
        if (tableUpdateHookTimer) hostWindow.clearTimeout(tableUpdateHookTimer);
        // 同一填表任务可包含多个内部通知，短防抖只发最后快照。
        tableUpdateHookTimer = hostWindow.setTimeout(flushTableUpdateHook, 120);
    };
    function installTableUpdateHook() {
        const api = getAcuApi();
        if (!api || typeof api.registerTableUpdateCallback !== 'function') return false;
        try {
            if (tableUpdateHookApi && tableUpdateHookApi !== api && typeof tableUpdateHookApi.unregisterTableUpdateCallback === 'function') {
                try { tableUpdateHookApi.unregisterTableUpdateCallback(tableUpdateHookCallback); } catch (e0) {}
            }
            // registerTableUpdateCallback 会按函数引用去重；每次都重申注册，
            // 可覆盖 SP 在聊天/模板重载时 API 对象未变但内部回调容器已重建的情况。
            api.registerTableUpdateCallback(tableUpdateHookCallback);
            tableUpdateHookApi = api;
            return true;
        } catch (e) { return false; }
    }

    function uninstallTableUpdateHook() {
        if (tableUpdateHookApi && typeof tableUpdateHookApi.unregisterTableUpdateCallback === 'function') {
            try { tableUpdateHookApi.unregisterTableUpdateCallback(tableUpdateHookCallback); } catch (e) {}
        }
        if (tableUpdateHookTimer) hostWindow.clearTimeout(tableUpdateHookTimer);
        tableUpdateHookTimer = null;
        tableUpdateHookPendingData = null;
        tableUpdateHookRetryCount = 0;
        tableUpdateHookSession = null;
        tableUpdateHookApi = null;
    }

    function refreshCurrentCardFrontends(options) {
        const opts = options || {};
        const allowHardReload = opts.allowHardReload !== false;
        const targets = [];
        const seen = [];
        const visit = (w) => {
            try {
                if (!w || seen.indexOf(w) !== -1) return;
                seen.push(w);
                targets.push(w);
                const frames = w.document ? w.document.querySelectorAll('iframe') : [];
                for (const frame of frames) { try { visit(frame.contentWindow); } catch (e) {} }
            } catch (e) {}
        };
        visit(window); visit(hostWindow);
        try { visit(window.parent); } catch (e) {}
        try { visit(window.top); } catch (e) {}
        const result = { direct: 0, event: 0, control: 0, reload: 0 };
        const occupied = [];
        const reloadTargets = [];
        for (const target of targets) {
            try {
                const mode = readCardFrontendMode(target);
                // 已确认只重读数据的内联初始化函数可以安全用于每次表格更新。
                // body.load 重挂载会清掉页面局部状态，只允许用户手动刷新时调用。
                if (typeof target.__mvu2shujukuRefreshInlineFrontend === 'function') {
                    target.__mvu2shujukuRefreshInlineFrontend();
                    result.direct++;
                    occupied.push(target);
                    continue;
                }
                if (allowHardReload && typeof target.__mvu2shujukuReloadFrontend === 'function') {
                    target.__mvu2shujukuReloadFrontend();
                    result.direct++;
                    occupied.push(target);
                    continue;
                }
                if (mode === 'event') result.event++;
                if (mode === 'event') occupied.push(target);
                else if (allowHardReload && mode === 'reload' && target !== window && target !== hostWindow && target.location && typeof target.location.reload === 'function') reloadTargets.push(target);
            } catch (e) {}
        }
        // 普通状态栏应通过 MVU 原生更新事件刷新；这里也补发一次，
        // 手动按钮因此同时适用于监听式前端和旧式 body.load 整页前端。
        dispatchVariableUpdateEnded(opts.after, opts.before);
        result.control += refreshExplicitFrontendDataControls(occupied.concat(reloadTargets));
        for (const target of reloadTargets) {
            try { target.location.reload(); result.reload++; } catch (e) {}
        }
        return result;
    }

    // =================================================================
    // 扩展侧 Mvu 兼容层：按 MVU 官方全局 API（createMvu）完整实现，
    // 覆盖式接管运行环境里残留的真 MVU（避免双轨冲突），桥不在主窗口时也能读写数据库。
    // =================================================================
    function parseMvuCmdValue(raw) {
        const t = String(raw == null ? '' : raw).trim();
        if (t === 'true') return true;
        if (t === 'false') return false;
        if (t === 'null') return null;
        if (t === 'undefined') return undefined;
        try { return JSON.parse(t); } catch (e) {}
        if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
        return t.replace(/^['"]|['"]$/g, '');
    }
    function splitMvuCmdArgs(argsStr) {
        const out = [];
        let cur = '', depth = 0, inStr = null;
        for (let i = 0; i < argsStr.length; i++) {
            const ch = argsStr[i];
            if (inStr) { cur += ch; if (ch === '\\') { cur += argsStr[i + 1] || ''; i++; continue; } if (ch === inStr) inStr = null; continue; }
            if (ch === "'" || ch === '"') { inStr = ch; cur += ch; continue; }
            if (ch === '(' || ch === '[' || ch === '{') depth++;
            if (ch === ')' || ch === ']' || ch === '}') depth--;
            if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
            cur += ch;
        }
        if (cur.trim()) out.push(cur.trim());
        return out;
    }
    // 与卡内桥同一套通用命令规则：解析 <UpdateVariable>/<json_patch> 中的 _.set/_.add/_.remove 等指令
    function parseMvuCommands(text) {
        const cmds = [];
        const blockRe = /<(updatevariable|json_?patch)>[\s\S]*?(?:\/\1>)/gi;
        let m;
        while ((m = blockRe.exec(String(text || '')))) {
            let inner = m[0].replace(/<[^>]+>/g, '').replace(/\x60\x60\x60[^\x60]*\x60\x60\x60/g, '').trim();
            let isJsonBlock = m[1].toLowerCase().indexOf('json') === 0;
            // 标准写法 <UpdateVariable><Analysis>…</Analysis><JSONPatch>…</JSONPatch></UpdateVariable>：
            // 外层是 updatevariable 时，若内部含 json_patch 子块，则整块按 JSONPatch 解析
            const sub = m[0].match(/<(json_?patch)>[\s\S]*?(?:\/\1>)/i);
            if (sub) { inner = sub[0].replace(/<[^>]+>/g, '').trim(); isJsonBlock = true; }
            if (isJsonBlock) {
                try {
                    let patch = null;
                    try { patch = JSON.parse(inner); } catch (e) {
                        try {
                            const libs = getMvuYamlLibs();
                            patch = JSON.parse((libs && typeof libs.jsonrepair === 'function') ? libs.jsonrepair(inner) : inner);
                        } catch (e2) { patch = null; }
                    }
                    if (Array.isArray(patch)) {
                        for (const op of patch) {
                            if (!op || (!op.path && !op.to)) continue;
                            const jt = op.op === 'delta' ? 'add' : (op.op === 'remove' ? 'delete' : ((op.op === 'insert' || op.op === 'add') ? 'insert' : op.op || 'set'));
                            const jp = String(op.path || op.to || '').replace(/^\//, '').replace(/\//g, '.');
                            const jpParts = jp.split('.');
                            const jpKey = jpParts.pop();
                            const jpParent = jpParts.join('.');
                            const rawArgs = jt === 'move' ? [String(op.from || '').replace(/^\//, '').replace(/\//g, '.'), jp]
                                : jt === 'delete' ? [jp]
                                : jt === 'insert' || op.op === 'add' ? [jpParent, jpKey, JSON.stringify(op.value)]
                                : [jp, JSON.stringify(op.value)];
                            cmds.push({ type: jt, path: (jt === 'insert' || op.op === 'add') ? jpParent : jp, keyOrIndex: (jt === 'insert' || op.op === 'add') ? parseMvuCmdValue(jpKey) : undefined, value: op.value, from: op.from, rawArgs, full_match: JSON.stringify(op), reason: 'json_patch' });
                        }
                    }
                } catch (e) {}
                continue;
            }
            const cmdRe = /\.(set|assign|insert|remove|unset|delete|add)\(/g;
            let cm;
            while ((cm = cmdRe.exec(inner))) {
                const open = inner.indexOf('(', cm.index + cm[0].length - 1);
                if (open === -1) continue;
                let depth = 1, end = -1, inS = null;
                for (let k = open + 1; k < inner.length; k++) {
                    const c = inner[k];
                    if (inS) { if (c === '\\') { k++; continue; } if (c === inS) inS = null; continue; }
                    if (c === "'" || c === '"') { inS = c; continue; }
                    if (c === '(') depth++;
                    else if (c === ')') { depth--; if (depth === 0) { end = k; break; } }
                }
                if (end === -1) break;
                const args = splitMvuCmdArgs(inner.slice(open + 1, end));
                const after = inner.slice(end + 1).replace(/^\s*;\s*/, '');
                let reason = '';
                const rm = after.match(/^\/\/\s*([^\n]*)/);
                if (rm) reason = rm[1].trim();
                const type = cm[1];
                const path = String(args[0] || '').replace(/^['"]|['"]$/g, '').replace(/^\//, '').replace(/\//g, '.');
                const full_match = inner.slice(cm.index, end + 1);
                if (type === 'remove' || type === 'unset' || type === 'delete') cmds.push({ type: 'delete', path, keyOrIndex: args[1] !== undefined ? parseMvuCmdValue(args[1]) : undefined, rawArgs: args, full_match, reason });
                else if (type === 'insert' || type === 'assign') cmds.push({ type: 'insert', path, keyOrIndex: args[2] !== undefined ? parseMvuCmdValue(args[1]) : null, value: args[2] !== undefined ? parseMvuCmdValue(args[2]) : parseMvuCmdValue(args[1]), rawArgs: args, full_match, reason });
                else if (type === 'add') cmds.push({ type: 'add', path, value: args[1] !== undefined ? parseMvuCmdValue(args[1]) : undefined, rawArgs: args, full_match, reason });
                else cmds.push({ type: 'set', path, expected: args[2] !== undefined ? parseMvuCmdValue(args[1]) : undefined, value: args[2] !== undefined ? parseMvuCmdValue(args[2]) : (args[1] !== undefined ? parseMvuCmdValue(args[1]) : undefined), rawArgs: args, full_match, reason });
                cmdRe.lastIndex = end + 1;
            }
        }
        if (!cmds.length && /\.(set|assign|insert|remove|unset|delete|add)\(/.test(String(text || '')) && !/<(updatevariable|json_?patch)>/i.test(String(text || ''))) {
            return parseMvuCommands('<UpdateVariable>' + String(text || '') + '</UpdateVariable>');
        }
        return cmds;
    }
    function mvuCommandInfoFromInternal(cmd) {
        let type = cmd.type;
        if (type === 'assign') type = 'insert';
        if (type === 'remove' || type === 'unset') type = 'delete';
        let args = Array.isArray(cmd.rawArgs) ? cmd.rawArgs.slice() : null;
        if (!args) {
            if (type === 'move') args = [String(cmd.from || ''), String(cmd.path || '')];
            else if (type === 'delete') args = cmd.keyOrIndex === undefined ? [String(cmd.path || '')] : [String(cmd.path || ''), cmd.keyOrIndex];
            else if (type === 'insert') args = cmd.keyOrIndex === null || cmd.keyOrIndex === undefined ? [String(cmd.path || ''), cmd.value] : [String(cmd.path || ''), cmd.keyOrIndex, cmd.value];
            else if (type === 'set' && cmd.expected !== undefined) args = [String(cmd.path || ''), cmd.expected, cmd.value];
            else args = [String(cmd.path || ''), cmd.value];
        }
        return { type, full_match: cmd.full_match || '', args, reason: cmd.reason || '' };
    }
    function mvuInternalFromCommandInfo(info) {
        if (!info || !Array.isArray(info.args) || !info.args.length) return null;
        let type = String(info.type || 'set').toLowerCase();
        if (type === 'assign') type = 'insert';
        if (type === 'remove' || type === 'unset') type = 'delete';
        const args = info.args;
        const cleanPath = (v) => String(v == null ? '' : v).replace(/^['"]|['"]$/g, '').replace(/^\//, '').replace(/\//g, '.');
        if (type === 'move') return { type, from: cleanPath(args[0]), path: cleanPath(args[1]), full_match: info.full_match || '', reason: info.reason || '' };
        const path = cleanPath(args[0]);
        if (type === 'delete') return { type, path, keyOrIndex: args.length > 1 ? parseMvuCmdValue(args[1]) : undefined, full_match: info.full_match || '', reason: info.reason || '' };
        if (type === 'insert') return { type, path, keyOrIndex: args.length > 2 ? parseMvuCmdValue(args[1]) : null, value: parseMvuCmdValue(args[args.length - 1]), full_match: info.full_match || '', reason: info.reason || '' };
        if (type === 'add') return { type, path, value: parseMvuCmdValue(args[1]), full_match: info.full_match || '', reason: info.reason || '' };
        return { type: 'set', path, expected: args.length > 2 ? parseMvuCmdValue(args[1]) : undefined, value: parseMvuCmdValue(args[args.length - 1]), full_match: info.full_match || '', reason: info.reason || '' };
    }
    function applyMvuCommands(stat, cmds, display) {
        const setPathArr = (obj, parts, value) => {
            let cur = obj;
            for (let i = 0; i < parts.length - 1; i++) {
                if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object' || Array.isArray(cur[parts[i]])) cur[parts[i]] = {};
                cur = cur[parts[i]];
            }
            cur[parts[parts.length - 1]] = value;
        };
        const note = (path, oldV, newV, reason) => {
            if (!display) return;
            const r = reason ? ' (' + reason + ')' : '';
            display[path] = String(oldV) + '->' + String(newV) + r;
        };
        for (const cmd of cmds) {
            if (!cmd.path) continue;
            const parts = String(cmd.path).split('.').filter((p) => p !== '');
            if (parts.some((p) => p.charAt(0) === '_')) continue;
            if (cmd.type === 'move') {
                const mf = String(cmd.from || '').replace(/^\//, '').replace(/\//g, '.').split('.').filter((p) => p !== '');
                if (mf.some((p) => p.charAt(0) === '_')) continue;
                let mv;
                let mc = stat, mok = true;
                for (let i = 0; i < mf.length - 1; i++) { mc = mc ? mc[mf[i]] : null; if (!mc) { mok = false; break; } }
                if (mok && mc) {
                    const mkey = mf[mf.length - 1];
                    if (Array.isArray(mc) && /^\d+$/.test(String(mkey))) { mv = mc[Number(mkey)]; mc.splice(Number(mkey), 1); }
                    else { mv = mc[mkey]; try { delete mc[mkey]; } catch (e) {} }
                }
                if (mv !== undefined) {
                    setPathArr(stat, parts, mv);
                    note(cmd.path, '(移动)', mv, cmd.reason);
                }
                continue;
            }
            if (cmd.type === 'delete') {
                let oldDel = null;
                if (cmd.keyOrIndex !== undefined) {
                    let collection = stat;
                    for (const p of parts) collection = collection == null ? undefined : collection[p];
                    oldDel = collection;
                    if (Array.isArray(collection)) {
                        const ri = typeof cmd.keyOrIndex === 'number' ? cmd.keyOrIndex : collection.findIndex(v => JSON.stringify(v) === JSON.stringify(cmd.keyOrIndex));
                        if (ri >= 0 && ri < collection.length) collection.splice(ri, 1);
                    } else if (collection && typeof collection === 'object') {
                        const dk = typeof cmd.keyOrIndex === 'number' ? Object.keys(collection)[cmd.keyOrIndex] : String(cmd.keyOrIndex);
                        if (dk !== undefined) delete collection[dk];
                    }
                } else {
                    let cur = stat, ok = true;
                    for (let d = 0; d < parts.length - 1; d++) { cur = cur ? cur[parts[d]] : null; if (!cur) { ok = false; break; } }
                    if (ok && cur) {
                        const dk = parts[parts.length - 1];
                        oldDel = cur[dk];
                        if (Array.isArray(cur) && /^\d+$/.test(String(dk))) cur.splice(Number(dk), 1); else try { delete cur[dk]; } catch (e) {}
                    }
                }
                if (Array.isArray(oldDel) && oldDel.length === 2) oldDel = oldDel[0];
                note(cmd.path, oldDel, '(移除)', cmd.reason);
                continue;
            }
            if (cmd.type === 'insert') {
                let container = stat;
                for (const p of parts) container = container == null ? undefined : container[p];
                if (container == null || (typeof container !== 'object' && !Array.isArray(container))) continue;
                const key = cmd.keyOrIndex;
                if (key === null || key === undefined) {
                    if (Array.isArray(container)) container.push(cmd.value);
                    else if (cmd.value && typeof cmd.value === 'object' && !Array.isArray(cmd.value)) Object.assign(container, cmd.value);
                } else if (Array.isArray(container) && (key === '-' || /^-?\d+$/.test(String(key)))) {
                    const idx = key === '-' || Number(key) === -1 ? container.length : Number(key);
                    container.splice(idx, 0, cmd.value);
                } else if (container && typeof container === 'object') container[String(key)] = cmd.value;
                note(cmd.path, '(新增)', cmd.value, cmd.reason);
                continue;
            }
            if (cmd.type === 'assign' && cmd.keyOrIndex !== undefined) {
                let acont = stat, aok = true;
                for (let d5 = 0; d5 < parts.length - 1; d5++) { acont = acont ? acont[parts[d5]] : null; if (!acont) { aok = false; break; } }
                if (aok && acont && typeof acont === 'object') {
                    const akey = cmd.keyOrIndex;
                    if (akey === '-' && Array.isArray(acont)) acont.push(cmd.value);
                    else if (Array.isArray(acont) && /^\d+$/.test(String(akey))) acont.splice(Number(akey), 0, cmd.value);
                    else if (acont && typeof acont === 'object') acont[akey] = cmd.value;
                    note(cmd.path, '(变更)', cmd.value, cmd.reason);
                }
                continue;
            }
            if (cmd.type === 'assign' && cmd.value && typeof cmd.value === 'object' && !Array.isArray(cmd.value)) {
                let tgt = stat, ok3 = true;
                for (let d3 = 0; d3 < parts.length - 1; d3++) { tgt = tgt ? tgt[parts[d3]] : null; if (!tgt) { ok3 = false; break; } }
                if (ok3 && tgt && typeof tgt === 'object') { Object.keys(cmd.value).forEach((kk) => { tgt[kk] = cmd.value[kk]; }); note(cmd.path, '(变更)', cmd.value, cmd.reason); }
                continue;
            }
            if (cmd.type === 'add') {
                // delta：数值相加 / 日期加毫秒 / 数组追加 / 否则整体替换（与 MVU 语义一致）
                const oldV = (() => { let c = stat; for (const p of parts) { c = c ? c[p] : undefined; } return c; })();
                const base = Array.isArray(oldV) && oldV.length ? oldV[0] : oldV;
                const delta = parseFloat(cmd.value);
                let dateVal = null;
                if (typeof base === 'string') { const dtest = new Date(base); if (!isNaN(dtest.getTime()) && isNaN(Number(base))) dateVal = dtest; }
                if (dateVal && !isNaN(delta)) {
                    const nd = new Date(dateVal.getTime() + delta);
                    setPathArr(stat, parts, nd.toISOString());
                    note(cmd.path, base, nd.toISOString(), cmd.reason);
                } else {
                    const num = parseFloat(base);
                    if (!isNaN(num) && !isNaN(delta)) {
                        const nv2 = parseFloat((num + delta).toPrecision(12));
                        setPathArr(stat, parts, nv2);
                        note(cmd.path, base, nv2, cmd.reason);
                    } else if (Array.isArray(oldV)) {
                        const arr = oldV.slice();
                        if (Array.isArray(cmd.value)) cmd.value.forEach((vv) => arr.push(vv)); else arr.push(cmd.value);
                        setPathArr(stat, parts, arr);
                        note(cmd.path, '(数组追加)', cmd.value, cmd.reason);
                    } else {
                        setPathArr(stat, parts, cmd.value);
                        note(cmd.path, base, cmd.value, cmd.reason);
                    }
                }
                continue;
            }
            // 官方 set 语义：路径必须已存在（缺失则跳过，不自动创建）；VWD 成对数组更新 [0]；数字强转
            let cur = stat, okSet = true;
            for (let i = 0; i < parts.length - 1; i++) {
                cur = cur ? cur[parts[i]] : undefined;
                if (cur === undefined || cur === null || typeof cur !== 'object' || Array.isArray(cur)) { okSet = false; break; }
            }
            if (!okSet || cur === undefined || cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, parts[parts.length - 1])) continue;
            const oldV = cur[parts[parts.length - 1]];
            let newV = cmd.value;
            if (newV instanceof Date) newV = newV.toISOString();
            if (Array.isArray(oldV) && oldV.length === 2 && typeof oldV[1] === 'string' && !Array.isArray(oldV[0])) {
                const oc = JSON.parse(JSON.stringify(oldV[0]));
                oldV[0] = (typeof oc === 'number' && newV !== null) ? Number(newV) : newV;
                note(cmd.path, oc, newV, cmd.reason);
            } else {
                if (typeof oldV === 'number' && newV !== null && !isNaN(Number(newV))) newV = Number(newV);
                cur[parts[parts.length - 1]] = newV;
                note(cmd.path, oldV, newV, cmd.reason);
            }
        }
    }

    async function applyMvuCommandsWithEvents(stat, cmds, display) {
        const at = (path) => {
            let cur = stat;
            for (const p of String(path || '').split('.').filter(Boolean)) cur = cur == null ? undefined : cur[p];
            try { return JSON.parse(JSON.stringify(cur)); } catch (e) { return cur; }
        };
        for (const cmd of cmds) {
            const oldValue = at(cmd.path);
            applyMvuCommands(stat, [cmd], display);
            const newValue = at(cmd.path);
            try {
                if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
                    await emitMvuEvent('mag_variable_updated', stat, cmd.path, oldValue, newValue);
                }
            } catch (e) {}
        }
    }

    async function runMvuUpdateCycle(message, oldData) {
        try { openingBulkClosedChats.add(runtimeScopedChatKey(autoInitChatId())); pruneOrderedCollection(openingBulkClosedChats, 80); } catch (e) {}
        const out = JSON.parse(JSON.stringify(oldData || {}));
        if (!out.stat_data || typeof out.stat_data !== 'object') out.stat_data = {};
        if (!out.display_data || typeof out.display_data !== 'object') out.display_data = {};
        if (!out.delta_data || typeof out.delta_data !== 'object') out.delta_data = {};
        const before = JSON.parse(JSON.stringify(out));
        out.stat_data.$internal = { display_data: out.display_data, delta_data: out.delta_data };
        await emitMvuEvent('mag_variable_update_started', out);
        const originalMessage = String(message || '');
        let processedMessage = originalMessage;
        try {
            const macroFn = (typeof window.substitudeMacros === 'function' && window.substitudeMacros) || (typeof hostWindow.substitudeMacros === 'function' && hostWindow.substitudeMacros);
            if (macroFn) processedMessage = String(macroFn(originalMessage));
        } catch (e) {}
        const infos = parseMvuCommands(processedMessage).map(mvuCommandInfoFromInternal);
        await emitMvuEvent('mag_command_parsed', out, infos, originalMessage);
        // 数据库 Schema 已接管类型、CHECK 与行约束。仍按 MVU 顺序
        // 通知旧 Zod 监听器（保留事件兼容），但对隔离快照执行：
        // 转换后遗留的外部 Schema 不能再删改真正将要落库的命令。
        const zodOut = JSON.parse(JSON.stringify(out));
        const zodInfos = JSON.parse(JSON.stringify(infos));
        await emitMvuEvent('mag_command_parsed_for_zod', zodOut, zodInfos, originalMessage);
        await emitMvuEvent('mag_command_parsed_ended_for_zod', zodOut, zodInfos, originalMessage);
        const commands = infos.map(mvuInternalFromCommandInfo).filter(Boolean);
        if (commands.length) await applyMvuCommandsWithEvents(out.stat_data, commands, out.display_data);
        out.delta_data = JSON.parse(JSON.stringify(out.display_data || {}));
        if (out.stat_data.$internal) out.stat_data.$internal.delta_data = out.delta_data;
        await emitMvuEvent('mag_variable_update_ended', out, before);
        delete out.stat_data.$internal;
        const zodEnded = JSON.parse(JSON.stringify(out));
        const zodBefore = JSON.parse(JSON.stringify(before));
        await emitMvuEvent('mag_variable_update_ended_for_zod', zodEnded, zodBefore);
        return out;
    }

    let windowMvuShimTimer = null;
    let windowMvuIframeObserver = null;
    let windowMvuFake = null;
    let windowMvuFakeSession = null;
    let windowMvuExportedEventStops = [];
    let windowMvuGlobalAnnounced = false;
    let windowMvuInitializedFunctions = [];
    // 与卡内桥共用的“真原始值”注册表：先接管者（桥或扩展）记录各窗口的原始函数，
    // 切到其他卡（尤其真 MVU 卡）时都从这里还原——避免把桥/扩展自己的接管函数
    // 当成“原始值”保存/恢复（这是切卡后函数不还原、真 MVU 卡被污染的根因）。
    const sharedStateWindow = (() => {
        try { if (window.top && window.top.document) return window.top; } catch (e) {}
        try { if (hostWindow && hostWindow.document) return hostWindow; } catch (e) {}
        return window;
    })();
    function isOursShimFn(fn) {
        return !!(fn && typeof fn === 'function' && (fn.__mvu2shujuku || fn.__mvu2shujukuBridge));
    }
    function noteGlobalOriginals(w) {
        try {
            const reg = sharedStateWindow.__mvu2shujukuGlobalState || (sharedStateWindow.__mvu2shujukuGlobalState = { list: [] });
            let rec = reg.list.find(r => r.w === w);
            if (!rec) {
                rec = { w, get: undefined, hasGet: false, upd: undefined, hasUpd: false, rep: undefined, hasRep: false, ins: undefined, hasIns: false, mvu: undefined, hasMvu: false, gav: undefined, hasGav: false, wait: undefined, hasWait: false, msg: undefined, hasMsg: false };
                reg.list.push(rec);
            }
            if (!rec.hasGet && typeof w.getVariables === 'function' && !isOursShimFn(w.getVariables)) { rec.get = w.getVariables; rec.hasGet = true; }
            if (!rec.hasUpd && typeof w.updateVariablesWith === 'function' && !isOursShimFn(w.updateVariablesWith)) { rec.upd = w.updateVariablesWith; rec.hasUpd = true; }
            if (!rec.hasRep && typeof w.replaceVariables === 'function' && !isOursShimFn(w.replaceVariables)) { rec.rep = w.replaceVariables; rec.hasRep = true; }
            if (!rec.hasIns && typeof w.insertOrAssignVariables === 'function' && !isOursShimFn(w.insertOrAssignVariables)) { rec.ins = w.insertOrAssignVariables; rec.hasIns = true; }
            if (!rec.hasMvu && w.Mvu && !isOursShimFn(w.Mvu) && !w.Mvu.__mvu2shujukuBridgeFake && !w.Mvu.__mvu2shujukuFake) { rec.mvu = w.Mvu; rec.hasMvu = true; }
            if (!rec.hasGav && typeof w.getAllVariables === 'function' && !isOursShimFn(w.getAllVariables)) { rec.gav = w.getAllVariables; rec.hasGav = true; }
            if (!rec.hasWait && typeof w.waitGlobalInitialized === 'function' && !isOursShimFn(w.waitGlobalInitialized)) { rec.wait = w.waitGlobalInitialized; rec.hasWait = true; }
            if (!rec.hasMsg && typeof w.getChatMessages === 'function' && !isOursShimFn(w.getChatMessages)) { rec.msg = w.getChatMessages; rec.hasMsg = true; }
            return rec;
        } catch (e) { return null; }
    }
    function restoreGlobalOriginals() {
        try {
            const reg = sharedStateWindow.__mvu2shujukuGlobalState;
            if (!reg || !Array.isArray(reg.list)) return;
            for (const rec of reg.list) {
                const w = rec.w;
                if (!w) continue;
                try {
                    if (isOursShimFn(w.getVariables)) { if (rec.hasGet) w.getVariables = rec.get; else delete w.getVariables; }
                    if (isOursShimFn(w.updateVariablesWith)) { if (rec.hasUpd) w.updateVariablesWith = rec.upd; else delete w.updateVariablesWith; }
                    if (isOursShimFn(w.replaceVariables)) { if (rec.hasRep) w.replaceVariables = rec.rep; else delete w.replaceVariables; }
                    if (isOursShimFn(w.insertOrAssignVariables)) { if (rec.hasIns) w.insertOrAssignVariables = rec.ins; else delete w.insertOrAssignVariables; }
                    if (w.getAllVariables && isOursShimFn(w.getAllVariables)) { if (rec.hasGav) w.getAllVariables = rec.gav; else delete w.getAllVariables; }
                    if (w.Mvu && (w.Mvu === windowMvuFake || w.Mvu.__mvu2shujukuFake || w.Mvu.__mvu2shujukuBridgeFake)) { if (rec.hasMvu) w.Mvu = rec.mvu; else delete w.Mvu; }
                    if (isOursShimFn(w.waitGlobalInitialized)) { if (rec.hasWait) w.waitGlobalInitialized = rec.wait; else delete w.waitGlobalInitialized; }
                    if (isOursShimFn(w.getChatMessages)) { if (rec.hasMsg) w.getChatMessages = rec.msg; else delete w.getChatMessages; }
                } catch (e) {}
            }
        } catch (e) {}
    }
    function applyWindowMvuShim() {
        const shimSession = captureRuntimeSession();
        const core = window.MVU2SHUJUKU_CORE;
        if (!core || typeof core.writeStatDiffToDb !== 'function') return;
        // 只接管本转换器产物的卡。大卡的 TavernHelper 外部 import 可能让
        // 薄桥/layout 注册晚于开场页的 3s MVU 检测，因此只要当前卡有转换标记就先
        // 发布 Mvu 外观；真正读写仍由 replaceMvuData 等待 activeLayout/API 就绪。
        // 其他卡（含真 MVU 卡）绝不覆盖 window.Mvu。避免依赖 currentCharacter()，
        // 否则角色懒加载缺 extensions 时会把转换卡误判为非转换卡而撤销接管。
        let currentMarkedConverted = false;
        try { currentMarkedConverted = isConvertedMvuCard(currentCharacter()); } catch (e) {}
        if (!activeLayout && !currentMarkedConverted) {
            restoreWindowMvuShim();
            return;
        }
        if (!windowMvuFake || !isRuntimeSessionCurrent(windowMvuFakeSession)) {
            windowMvuFake = {};
            windowMvuFakeSession = shimSession;
            windowMvuGlobalAnnounced = false;
            windowMvuInitializedFunctions = [];
            const sessionMvu = windowMvuFake;
            windowMvuFake.__mvu2shujukuFake = true;
            windowMvuFake.events = {
                VARIABLE_INITIALIZED: 'mag_variable_initialized',
                VARIABLE_UPDATE_STARTED: 'mag_variable_update_started',
                COMMAND_PARSED: 'mag_command_parsed',
                VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended',
                BEFORE_MESSAGE_UPDATE: 'mag_before_message_update',
                SINGLE_VARIABLE_UPDATED: 'mag_variable_updated',
            };
            windowMvuFake.getMvuData = function () {
                if (!isRuntimeSessionCurrent(shimSession)) return { stat_data: {}, display_data: {}, delta_data: {}, initialized_lorebooks: {} };
                // 有待写快照时直接返回，保证 写→读 一致（持久化由合并定时器落库）
                if (pendingStatWrite) {
                    return { stat_data: pendingStatWrite, display_data: {}, delta_data: {}, initialized_lorebooks: {} };
                }
                const all = window.getAllVariables ? window.getAllVariables() : { stat_data: {} };
                return { stat_data: all.stat_data || {}, display_data: all.display_data || {}, delta_data: {}, initialized_lorebooks: {} };
            };
            windowMvuFake.getMvuVariable = function (mvu_data, path, opts) {
                try {
                    opts = opts || {};
                    const cat = opts.category || 'stat';
                    const data = cat === 'display' ? (mvu_data && mvu_data.display_data) : cat === 'delta' ? (mvu_data && mvu_data.delta_data) : (mvu_data && mvu_data.stat_data);
                    const parts = String(path || '').split('.').filter((p) => p !== '');
                    let cur = data;
                    for (const p of parts) { if (cur == null) break; cur = cur[p]; }
                    const v = cur === undefined ? opts.default_value : cur;
                    return (Array.isArray(v) && v.length === 2) ? v[0] : v;
                } catch (e) { return opts && opts.default_value !== undefined ? opts.default_value : undefined; }
            };
            windowMvuFake.getRecordFromMvuData = function (mvu_data, category) {
                if (!mvu_data) return undefined;
                if (category === 'display') return mvu_data.display_data;
                if (category === 'delta') return mvu_data.delta_data;
                return mvu_data.stat_data;
            };
            windowMvuFake.setMvuVariable = async function (mvu_data, path, new_value, opts) {
                try {
                    opts = opts || {};
                    if (!mvu_data || typeof mvu_data !== 'object') return false;
                    if (!mvu_data.stat_data || typeof mvu_data.stat_data !== 'object') mvu_data.stat_data = {};
                    const parts = String(path || '').split('.').filter((p) => p !== '');
                    if (!parts.length) return false;
                    const hasObjPath = (obj, arr) => { let c = obj; for (const p of arr) { if (c == null || typeof c !== 'object') return false; c = c[p]; } return c !== undefined; };
                    const setObjPath = (obj, arr, v) => { let c = obj; for (let i = 0; i < arr.length - 1; i++) { if (c[arr[i]] == null || typeof c[arr[i]] !== 'object') c[arr[i]] = {}; c = c[arr[i]]; } c[arr[arr.length - 1]] = v; };
                    // 与官方 updateVariable 一致：路径不存在时不写（返回 false），不自动创建
                    if (!hasObjPath(mvu_data.stat_data, parts)) return false;
                    const display_data = mvu_data.stat_data.$internal && mvu_data.stat_data.$internal.display_data;
                    const delta_data = mvu_data.stat_data.$internal && mvu_data.stat_data.$internal.delta_data;
                    const curPath = (() => { let c = mvu_data.stat_data; for (let i = 0; i < parts.length - 1; i++) { c = c[parts[i]]; } return c; })();
                    const lastKey = parts[parts.length - 1];
                    let oldVal = curPath[lastKey];
                    const isVWD = Array.isArray(oldVal) && oldVal.length === 2 && typeof oldVal[1] === 'string' && !Array.isArray(oldVal[0]);
                    let finalValue = new_value;
                    if (new_value instanceof Date) finalValue = new_value.toISOString();
                    if (isVWD) {
                        oldVal = JSON.parse(JSON.stringify(oldVal[0]));
                        finalValue = (typeof oldVal === 'number' && finalValue !== null) ? Number(finalValue) : finalValue;
                        curPath[lastKey] = [finalValue, curPath[lastKey][1]];
                    } else {
                        if (typeof oldVal === 'number' && finalValue !== null && !isNaN(Number(finalValue))) finalValue = Number(finalValue);
                        curPath[lastKey] = finalValue;
                    }
                    const reason = opts.reason || '';
                    const ds = String(oldVal) + '->' + JSON.stringify(finalValue) + (reason ? ' (' + reason + ')' : '');
                    if (display_data) { try { setObjPath(display_data, parts, ds); } catch (e) {} }
                    if (delta_data) { try { setObjPath(delta_data, parts, ds); } catch (e) {} }
                    dbg(' Mvu.setMvuVariable:', path, '=', String(new_value) + (reason ? ' (' + reason + ')' : ''));
                    if (opts.is_recursive) {
                        emitMvuEvent('mag_variable_updated', mvu_data.stat_data, path, oldVal, finalValue);
                    }
                    return true;
                } catch (e) {
                    dbgWarn(' Mvu.setMvuVariable 异常:', e);
                    return false;
                }
            };
            const waitForRuntimeBasics = async (timeoutMs) => {
                const start = Date.now();
                let originKey = '';
                try { originKey = autoInitChatId(); } catch (e) {}
                while (Date.now() - start < timeoutMs) {
                    try {
                        // 等待期间聊天被切换：目标快照属于旧聊天，立即放弃，
                        // 避免就绪判定命中的是新卡 API 后把旧卡数据交给写路径。
                        if (!isRuntimeSessionCurrent(shimSession) || (originKey && autoInitChatId() !== originKey)) return false;
                        const apiNow = getAcuApi();
                        if (apiNow && activeLayout && layoutBelongsToCurrentCard(activeLayoutCardKey)) return true;
                    } catch (e) {}
                    await new Promise(r => hostWindow.setTimeout(r, 250));
                }
                return false;
            };
            windowMvuFake.replaceMvuData = async function (data) {
                try {
                    assertRuntimeSession(shimSession);
                    let api = getAcuApi();
                    if (!api || !activeLayout) {
                        // 外部 UI/开场脚本可能在自动建表完成前就调用写库：不要直接失败，
                        // 等待布局/API 就绪后再继续（最长约 10 秒，避免 UI 永久卡住）。
                        const ready = await waitForRuntimeBasics(10000);
                        assertRuntimeSession(shimSession);
                        if (!ready) {
                            dbgWarn(' Mvu.replaceMvuData 被跳过：等待 10s 后 API/布局仍未就绪（api=' + !!api + ' activeLayout=' + (activeLayout ? '有' : '空') + '，自动建表尚未缓存布局，或当前卡不是转换产物）');
                            return false;
                        }
                        api = getAcuApi();
                        if (!api) return false;
                    }
                    overlayFlushRetries = 0;
                    if (mvu2shujukuDebugOn()) {
                        // 诊断：记录 replaceMvuData 的调用来源（前端 iframe/桥/卡内脚本），
                        // 用于区分“用户操作写库”与“前端渲染/填表窗口自动写库”。
                        let caller = '';
                        try {
                            const st = new Error().stack || '';
                            const lines2 = String(st).split('\n').filter(l => l.indexOf('mvu2shujuku') === -1 && l.indexOf('scheduleWindowStatOverlay') === -1);
                            if (lines2.length) caller = String(lines2[0]).trim();
                        } catch (e) {}
                        const g0 = data && data.stat_data ? Object.keys(data.stat_data).filter(k => k !== '$internal') : [];
                        dbg(' Mvu.replaceMvuData 调用来源=' + (caller || '未知') + ' | 顶层组=' + g0.join(','));
                    }
                    const nextStat = (data && data.stat_data) || {};
                    const writeChatKey = autoInitChatId();
                    const ok = await scheduleWindowStatOverlay(nextStat, null, false, false, writeChatKey, shimSession);
                    if (ok && isRuntimeSessionCurrent(shimSession)) refreshOpeningContinuityAfterWrite(writeChatKey, nextStat);
                    return !!ok;
                } catch (e) {
                    dbgWarn(' Mvu.replaceMvuData 异常:', e);
                    return false;
                }
            };
            windowMvuFake.parseMessage = async function (message, old_data) {
                try {
                    assertRuntimeSession(shimSession);
                    return await runMvuUpdateCycle(message, old_data);
                } catch (e) {
                    dbgWarn(' Mvu.parseMessage 异常:', e);
                    return undefined;
                }
            };
            windowMvuFake.reloadInitVar = async function (mvu_data) {
                try {
                    assertRuntimeSession(shimSession);
                    const core = window.MVU2SHUJUKU_CORE;
                    const tpl = cachedTemplateForCurrentCard();
                    if (!mvu_data || !core || typeof core.statDataFromTables !== 'function' || !activeLayout || !tpl) return false;
                    const initial = core.statDataFromTables(activeLayout, tpl) || {};
                    mvu_data.stat_data = JSON.parse(JSON.stringify(initial.stat_data || {}));
                    mvu_data.display_data = JSON.parse(JSON.stringify(initial.display_data || initial.stat_data || {}));
                    mvu_data.delta_data = {};
                    mvu_data.initialized_lorebooks = mvu_data.initialized_lorebooks || {};
                    return true;
                } catch (e) { return false; }
            };
            windowMvuFake.getCurrentMvuData = function () { return sessionMvu.getMvuData({ type: 'message', message_id: 'latest' }); };
            windowMvuFake.replaceCurrentMvuData = async function (mvu_data) { return sessionMvu.replaceMvuData(mvu_data, { type: 'message', message_id: 'latest' }); };
            windowMvuFake.isDuringExtraAnalysis = function () { return false; };
        }
        const targets = [];
        const addTarget = (t) => { try { if (t && targets.indexOf(t) === -1) targets.push(t); } catch (e) {} };
        addTarget(window);
        addTarget(hostWindow);
        try { addTarget(window.parent); } catch (e) {}
        try { addTarget(window.top); } catch (e) {}
        for (const r of [window, hostWindow]) {
            try {
                const frames = r.document ? r.document.querySelectorAll('iframe') : [];
                for (const f of frames) { try { addTarget(f.contentWindow); } catch (e) {} }
            } catch (e) {}
        }
        for (const w of targets) {
            try {
                // 覆盖前先登记真原始值（Mvu/getAllVariables/三个全局函数），
                // 切卡还原时从共享注册表取回，绝不把桥/扩展自己的接管当原始值。
                const originalRec = noteGlobalOriginals(w);
                // 旧 MVU 状态栏常直接读 getChatMessages(id)[0].data.stat_data，
                // 而数据库不再把当前状态物理存入消息 data。只在读取结果的
                // 浅副本上投影 stat_data，不污染真实聊天消息，并兼容同步/异步 TH API。
                if (originalRec && originalRec.hasMsg && !isOursShimFn(w.getChatMessages)) {
                    const messageReadDefine = function () {
                        const result = originalRec.msg.apply(this, arguments);
                        const decorate = (list) => {
                            if (!Array.isArray(list)) return list;
                            const all = window.getAllVariables ? window.getAllVariables() : { stat_data: {} };
                            const stat = pendingStatWrite && typeof pendingStatWrite === 'object'
                                ? pendingStatWrite
                                : ((all && all.stat_data) || {});
                            return list.map((item) => {
                                if (!item || typeof item !== 'object') return item;
                                // 旧 MVU 状态栏常用 display_data || stat_data。数据库只持久化
                                // 当前状态，因此消息副本中两个视图都投影同一份实时快照；
                                // 否则原消息残留的空 display_data（空对象也是 truthy）会遮住 stat_data。
                                return Object.assign({}, item, { data: Object.assign({}, item.data || {}, { stat_data: stat, display_data: stat }) });
                            });
                        };
                        return result && typeof result.then === 'function' ? result.then(decorate) : decorate(result);
                    };
                    messageReadDefine.__mvu2shujuku = true;
                    w.getChatMessages = messageReadDefine;
                }
                const oldM = w.Mvu;
                if (oldM && typeof oldM === 'object' && oldM !== windowMvuFake) {
                    const SKIP = { getMvuData: 1, replaceMvuData: 1, setMvuVariable: 1, getMvuVariable: 1, getRecordFromMvuData: 1, parseMessage: 1, reloadInitVar: 1, getCurrentMvuData: 1, replaceCurrentMvuData: 1, isDuringExtraAnalysis: 1, events: 1 };
                    for (const pk in oldM) {
                        if (!Object.prototype.hasOwnProperty.call(oldM, pk)) continue;
                        if (SKIP[pk]) continue;
                        if (windowMvuFake[pk] === undefined) windowMvuFake[pk] = oldM[pk];
                    }
                }
                w.Mvu = windowMvuFake;
                // 精确对齐 TavernHelper 的共享全局协议：转换卡的 Mvu 已在此时可用，
                // 因此只让 waitGlobalInitialized('Mvu') 立即完成。其他全局名称仍调原函数，
                // 切到非转换卡时也会恢复，避免广泛更改宿主初始化语义。
                if (originalRec && originalRec.hasWait) {
                    const waitFn = function (name) {
                        if (String(name) === 'Mvu') {
                            try { w.Mvu = windowMvuFake; } catch (e) {}
                            return Promise.resolve(windowMvuFake);
                        }
                        return originalRec.wait.apply(w, arguments);
                    };
                    waitFn.__mvu2shujuku = true;
                    w.waitGlobalInitialized = waitFn;
                }
                // 前端状态栏直接调 window.getAllVariables()：把扩展侧读取函数同步到
                // 消息 iframe/子窗口，否则 iframe 里没有该函数，前端永远读不到数据。
                if (typeof window.getAllVariables === 'function' && w.getAllVariables !== window.getAllVariables) {
                    w.getAllVariables = window.getAllVariables;
                }
                // 与 MVU/TH 生态一致：接管裸全局 getVariables / updateVariablesWith /
                // replaceVariables / insertOrAssignVariables（游戏逻辑脚本常直接调用，如 人妻公寓 的
                // updateVariablesWith(t => …)）。必须是“接管式”而不是“缺省才补”：
                // 若宿主（旧酒馆助手 TH）已定义这些全局，卡脚本直接调用会走 TH 自己的
                // 变量存储，读写不到数据库，前端自然读不到数据/两边不同步。
                // 只接管默认/消息作用域中的 stat_data。chat / character / global /
                // preset / script / extension 是 TavernHelper 自身的独立存储，必须原样委派。
                // 消息作用域中的其他辅助键也与数据库视图合并，供动态正则/卡内 UI 使用。
                const isDbVariableScope = (opts) => !opts || !opts.type || String(opts.type) === 'message';
                const cloneRecord = (value) => {
                    try { return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : {}; }
                    catch (e) { return value && typeof value === 'object' ? Object.assign({}, value) : {}; }
                };
                const stripDbVariableKeys = (value) => {
                    const out = cloneRecord(value);
                    delete out.stat_data;
                    delete out.display_data;
                    delete out.delta_data;
                    delete out.initialized_lorebooks;
                    return out;
                };
                const readOriginalVariables = (opts) => {
                    try {
                        return originalRec && originalRec.hasGet
                            ? (originalRec.get.call(w, opts) || {})
                            : {};
                    } catch (e) { return {}; }
                };
                const makeGetVariables = (opts) => {
                    try {
                        if (!isDbVariableScope(opts)) {
                            return originalRec && originalRec.hasGet
                                ? originalRec.get.call(w, opts)
                                : {};
                        }
                        const auxiliary = readOriginalVariables(opts);
                        // 与 getMvuData 一致：有待写快照时优先返回待写快照，
                        // 保证前端连续“读-改-写”（如成就领取 updateResources + updateStoreWith）
                        // 在 150ms 合并窗口内基于同一状态累积，不会互相覆盖丢标记。
                        // MVU/TH 的 getVariables 返回的是 { stat_data, ... }，不能只返回裸 stat_data，
                        // 否则 getVariables(...).stat_data 会拿不到数据，前端会回退默认值并反复写回。
                        if (pendingStatWrite && typeof pendingStatWrite === 'object') {
                            return Object.assign({}, auxiliary, { stat_data: pendingStatWrite, display_data: {}, delta_data: {}, initialized_lorebooks: {} });
                        }
                        const all = window.getAllVariables ? window.getAllVariables() : { stat_data: {} };
                        const dbView = all && typeof all === 'object' ? all : { stat_data: all || {} };
                        return Object.assign({}, auxiliary, dbView);
                    } catch (e) { return { stat_data: {} }; }
                };
                const gvFn = function (opts) { return makeGetVariables(opts); };
                gvFn.__mvu2shujuku = true;
                w.getVariables = gvFn;
                const deepEqualCanon = (a, b) => {
                    if (a === b) return true;
                    if (typeof a !== typeof b) return false;
                    if (a === null || b === null) return a === b;
                    if (Array.isArray(a) || Array.isArray(b)) {
                        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
                        for (let i = 0; i < a.length; i++) if (!deepEqualCanon(a[i], b[i])) return false;
                        return true;
                    }
                    if (typeof a === 'object') {
                        const ka = Object.keys(a).sort();
                        const kb = Object.keys(b).sort();
                        if (ka.length !== kb.length) return false;
                        for (let i = 0; i < ka.length; i++) {
                            if (ka[i] !== kb[i]) return false;
                            if (!deepEqualCanon(a[ka[i]], b[kb[i]])) return false;
                        }
                        return true;
                    }
                    return a === b;
                };
                const updFn = async function (updater, opts) {
                    try {
                        if (typeof updater !== 'function') return false;
                        if (!isDbVariableScope(opts)) {
                            return originalRec && originalRec.hasUpd
                                ? await originalRec.upd.call(w, updater, opts)
                                : false;
                        }
                        assertRuntimeSession(shimSession);
                        const all = window.getAllVariables ? window.getAllVariables() : { stat_data: {} };
                        const base = (pendingStatWrite && typeof pendingStatWrite === 'object')
                            ? pendingStatWrite
                            : (all.stat_data || {});
                        const next = JSON.parse(JSON.stringify(base));
                        const wrapper = Object.assign({}, readOriginalVariables(opts), {
                            stat_data: next,
                            display_data: all.display_data || {},
                            delta_data: all.delta_data || {},
                            initialized_lorebooks: all.initialized_lorebooks || {},
                        });
                        const result = await Promise.resolve(updater(wrapper)) || wrapper;
                        assertRuntimeSession(shimSession);
                        const nextStat = result.stat_data || wrapper.stat_data || {};
                        const oldAux = stripDbVariableKeys(readOriginalVariables(opts));
                        const nextAux = stripDbVariableKeys(result);
                        if (!deepEqualCanon(nextAux, oldAux) && originalRec && originalRec.hasRep) {
                            await Promise.resolve(originalRec.rep.call(w, nextAux, opts));
                            assertRuntimeSession(shimSession);
                        }
                        // 无变化不写库、不发事件：外部 UI 的自动清理/回写 effect 经常重复写相同数据，
                        // 如果每次都落库会触发 VARIABLE_UPDATE_ENDED → 前端刷新 → 再写 → 死循环。
                        if (!deepEqualCanon(nextStat, base)) {
                            const saved = await windowMvuFake.replaceMvuData({
                                stat_data: nextStat,
                                display_data: result.display_data || all.display_data || {},
                                delta_data: result.delta_data || all.delta_data || {},
                                initialized_lorebooks: result.initialized_lorebooks || all.initialized_lorebooks || {},
                            }, opts);
                            if (!saved) return false;
                        }
                        return result;
                    } catch (e) {
                        dbgWarn(' updateVariablesWith 异常:', e);
                        return false;
                    }
                };
                updFn.__mvu2shujuku = true;
                w.updateVariablesWith = updFn;
                const repFn = async function (variables, opts) {
                    try {
                        if (!isDbVariableScope(opts)) {
                            return originalRec && originalRec.hasRep
                                ? await Promise.resolve(originalRec.rep.call(w, variables, opts))
                                : false;
                        }
                        assertRuntimeSession(shimSession);
                        const input = variables && typeof variables === 'object' ? variables : {};
                        if (originalRec && originalRec.hasRep) {
                            await Promise.resolve(originalRec.rep.call(w, stripDbVariableKeys(input), opts));
                            assertRuntimeSession(shimSession);
                        }
                        if (Object.prototype.hasOwnProperty.call(input, 'stat_data')) {
                            if (!await windowMvuFake.replaceMvuData(input, opts)) return false;
                        }
                        return input;
                    } catch (e) {
                        dbgWarn(' replaceVariables 异常:', e);
                        return false;
                    }
                };
                repFn.__mvu2shujuku = true;
                w.replaceVariables = repFn;
                const insFn = async function (variables, opts) {
                    try {
                        if (!isDbVariableScope(opts)) {
                            return originalRec && originalRec.hasIns
                                ? await Promise.resolve(originalRec.ins.call(w, variables, opts))
                                : false;
                        }
                        assertRuntimeSession(shimSession);
                        const input = variables && typeof variables === 'object' ? variables : {};
                        const auxiliary = stripDbVariableKeys(input);
                        if (Object.keys(auxiliary).length && originalRec && originalRec.hasIns) {
                            await Promise.resolve(originalRec.ins.call(w, auxiliary, opts));
                            assertRuntimeSession(shimSession);
                        }
                        if (Object.prototype.hasOwnProperty.call(input, 'stat_data')) {
                            const all = makeGetVariables(opts);
                            const saved = await windowMvuFake.replaceMvuData({
                                stat_data: input.stat_data || {},
                                display_data: all.display_data || {},
                                delta_data: all.delta_data || {},
                                initialized_lorebooks: all.initialized_lorebooks || {},
                            }, opts);
                            if (!saved) return false;
                        }
                        return makeGetVariables(opts);
                    } catch (e) {
                        dbgWarn(' insertOrAssignVariables 异常:', e);
                        return false;
                    }
                };
                insFn.__mvu2shujuku = true;
                w.insertOrAssignVariables = insFn;
                // 前端状态栏在消息 iframe 里用 eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, ...) 监听刷新。
                // 若 iframe 没有 TH 注入的 eventOn，就补一个绑定到 CustomEvent 的兜底，
                // 这样 emitMvuEvent 的 dispatchEvent 一定能触发前端刷新（不会因事件源不一致而收不到）。
                if (typeof w.addEventListener === 'function' && typeof w.eventOn !== 'function') {
                    w.eventOn = (evName, handler) => {
                        const wrapped = (e) => {
                            try {
                                const d = e && e.detail;
                                if (d && Object.prototype.hasOwnProperty.call(d, 'after')) handler(d.after, d.before);
                                else handler(d);
                            } catch (err) {}
                        };
                        w.addEventListener(evName, wrapped);
                        return { stop: () => { try { w.removeEventListener(evName, wrapped); } catch (e2) {} } };
                    };
                    w.eventOff = (evName, handler) => { try { w.removeEventListener(evName, handler); } catch (e2) {} };
                    w.eventOn.__mvu2shujukuFallback = true;
                    w.eventOff.__mvu2shujukuFallback = true;
                }
            } catch (e) {}
        }
        // waitGlobalInitialized('Mvu') 不只检查 window.Mvu：酒馆助手的正式共享协议
        // 需要 initializeGlobal，MVU 原版同时发送 global_Mvu_initialized。
        // 两步都补齐；函数引用去重，避免多个 iframe 包装指向同一总线时重复注册。
        for (const w of targets) {
            try {
                const init = w && w.initializeGlobal;
                if (typeof init === 'function' && windowMvuInitializedFunctions.indexOf(init) === -1) {
                    windowMvuInitializedFunctions.push(init);
                    init.call(w, 'Mvu', windowMvuFake);
                }
            } catch (e) {}
        }
        if (!windowMvuGlobalAnnounced) {
            windowMvuGlobalAnnounced = true;
            for (const w of targets) {
                try {
                    if (typeof w.dispatchEvent === 'function') {
                        const EC = w.CustomEvent || CustomEvent;
                        w.dispatchEvent(new EC('global_Mvu_initialized', { detail: { args: [] } }));
                    }
                } catch (e) {}
            }
            let announcedOnBus = false;
            for (const w of targets) {
                try {
                    if (!announcedOnBus && typeof w.eventEmit === 'function') {
                        w.eventEmit('global_Mvu_initialized');
                        announcedOnBus = true;
                    }
                } catch (e) {}
            }
        }
    }
    // 撤销 Mvu 接管：恢复各窗口原 window.Mvu，停止周期复查，切回转换卡时再接管。
    function restoreWindowMvuShim() {
        pendingLateFrontendUpdate = null;
        if (windowMvuShimTimer) {
            hostWindow.clearInterval(windowMvuShimTimer);
            windowMvuShimTimer = null;
        }
        if (windowMvuIframeObserver) {
            try { windowMvuIframeObserver.disconnect(); } catch (e) {}
            windowMvuIframeObserver = null;
        }
        for (const stop of windowMvuExportedEventStops.splice(0, windowMvuExportedEventStops.length)) {
            try { if (typeof stop === 'function') stop(); else if (stop && typeof stop.stop === 'function') stop.stop(); } catch (e) {}
        }
        // 统一从共享注册表还原“真原始值”（只动我们自己的接管，不碰真 MVU 新挂的函数）。
        restoreGlobalOriginals();
        windowMvuGlobalAnnounced = false;
        windowMvuInitializedFunctions = [];
    }
    function installMvuExportedEventHandlers() {
        if (windowMvuExportedEventStops.length || !windowMvuFake) return;
        let on = null;
        try { if (typeof hostWindow.eventOn === 'function') on = hostWindow.eventOn.bind(hostWindow); } catch (e) {}
        try { if (!on && typeof window.eventOn === 'function') on = window.eventOn.bind(window); } catch (e) {}
        if (!on) return;
        try {
            // MagVarUpdate/src/function/exported_events.ts: handleVariablesInCallback
            const invokeHandle = on('mag_invoke_mvu', async (messageContent, variableInfo) => {
                if (!variableInfo || variableInfo.old_variables === undefined) return undefined;
                const next = await runMvuUpdateCycle(String(messageContent || ''), variableInfo.old_variables);
                variableInfo.new_variables = next;
                return next;
            });
            if (invokeHandle) windowMvuExportedEventStops.push(invokeHandle);
            // 对外 UPDATE_VARIABLE 的参数就是 updateVariable(stat_data,path,value,reason,is_recursive)。
            const updateHandle = on('mag_update_variable', async (statData, path, newValue, reason, isRecursive) => {
                if (!statData || typeof statData !== 'object') return false;
                return await windowMvuFake.setMvuVariable(
                    { stat_data: statData, display_data: {}, delta_data: {}, initialized_lorebooks: {} },
                    path,
                    newValue,
                    { reason: reason || '', is_recursive: !!isRecursive }
                );
            });
            if (updateHandle) windowMvuExportedEventStops.push(updateHandle);
        } catch (e) {
            dbgWarn(' MVU 对外事件接口安装失败:', e && e.message ? e.message : e);
        }
    }
    function installWindowMvuShim() {
        applyWindowMvuShim();
        installMvuExportedEventHandlers();
        installTableUpdateHook();
        if (!windowMvuShimTimer) {
            // 真 MVU 可能异步 import 后重新挂载 window.Mvu；周期复查接管（2s），并监听其初始化事件立即接管
            windowMvuShimTimer = hostWindow.setInterval(() => {
                try { applyWindowMvuShim(); } catch (e) {}
                // SP 可能比本扩展晚加载，或在聊天切换时重建回调容器。
                // 用同一函数引用重申注册，API 自身去重，不会放大事件。
                try { installTableUpdateHook(); } catch (e) {}
            }, 2000);
            try { if (typeof hostWindow.eventOn === 'function') hostWindow.eventOn('global_Mvu_initialized', () => { try { applyWindowMvuShim(); } catch (e) {} }); } catch (e) {}
        }
        if (!windowMvuIframeObserver) {
            // 新消息楼层 iframe 是渲染时才创建的，仅靠 2s 复查会在“前端 iframe 加载瞬间
            // 同步读 window.Mvu/getAllVariables”时漏掉，导致前端报 undefined/读不到数据。
            // 监听 iframe 新增：一出现新 iframe 就立即把 shim/getAllVariables/事件兜底同步过去。
            try {
                const doc = hostDocument;
                const MO = (typeof MutationObserver !== 'undefined' ? MutationObserver : (hostWindow && hostWindow.MutationObserver)) || null;
                if (doc && MO && doc.body) {
                    windowMvuIframeObserver = new MO((muts) => {
                        let hasIframe = false;
                        for (const m of muts || []) {
                            const nodes = (m && m.addedNodes) || [];
                            for (const n of nodes) {
                                if (!n || !n.tagName) continue;
                                if (n.tagName === 'IFRAME') { hasIframe = true; break; }
                                try { if (n.querySelectorAll && n.querySelectorAll('iframe').length) { hasIframe = true; break; } } catch (e) {}
                            }
                            if (hasIframe) break;
                        }
                        if (hasIframe) {
                            try { applyWindowMvuShim(); } catch (e) {}
                            // 重生成时旧状态栏先随消息删除，数据写入事件可能早于
                            // 新 iframe 的 eventOn 注册。新 iframe 出现后只补发最近一次载荷；
                            // 先清除 pending 再广播，避免前端重渲染再新建 iframe 时形成循环。
                            const pendingUpdate = pendingLateFrontendUpdate;
                            if (pendingUpdate && pendingUpdate.expiresAt >= Date.now() && pendingUpdate.chatKey === autoInitChatId()) {
                                pendingLateFrontendUpdate = null;
                                const session = captureRuntimeSession();
                                hostWindow.setTimeout(() => {
                                    try {
                                        if (!isRuntimeSessionCurrent(session)) return;
                                        applyWindowMvuShim();
                                        emitMvuEvent('mag_variable_update_ended', pendingUpdate.after, pendingUpdate.before);
                                        dbg('[前端迟到挂载] 新 iframe 已就绪，补发最近一次 VARIABLE_UPDATE_ENDED。');
                                    } catch (e) {}
                                }, 120);
                            } else if (pendingUpdate && pendingUpdate.expiresAt < Date.now()) {
                                pendingLateFrontendUpdate = null;
                            }
                        }
                    });
                    windowMvuIframeObserver.observe(doc.body, { childList: true, subtree: true });
                }
            } catch (e) {}
        }
        dbg(' 扩展侧已安装完整 Mvu shim（接管式）');
    }
    // 按当前卡同步运行时：转换卡 → 接管 Mvu/定义 getAllVariables/注册表格广播；
    // 其他卡 → 全部撤销，确保扩展不影响任何非转换卡。
    async function syncRuntimeForCurrentCard() {
        const session = captureRuntimeSession();
        let ch = null;
        try { ch = currentCharacter(); } catch (e) {}
        if (!ch) return;
        // 角色对象带完整世界书且无标记 = 完整卡且非转换产物，直接撤销，不用发请求；
        // 缺完整数据（角色列表懒加载元数据）才强制取完整卡确认。
        const hasFullData = !!(ch && (ch.character_book || (ch.data && ch.data.character_book)));
        if (!isConvertedMvuCard(ch) && !hasFullData) {
            try {
                // 强制取完整卡：角色列表对象可能只有元数据（缺 extensions），
                // 不能只凭当前对象判断是否本转换器产物。
                const full = await fetchFullCharacter(ch, true);
                if (!isRuntimeSessionCurrent(session)) return;
                if (full && isConvertedMvuCard(full)) ch = full;
                else if (full === null) {
                    // 获取完整卡失败（宿主扩展可能劫持了 fetch 返回 diff 对象）：
                    // 不能据此撤销运行时，保留现状等 autoInitDatabase 重试。
                    dbg(' 同步运行时：获取完整卡失败，暂不撤销（等自动建表重试）');
                    return;
                }
            } catch (e) {}
        }
        if (isConvertedMvuCard(ch)) {
            // 转换卡：直接从角色标记取 layout 并提前发布 Mvu。这一步不等
            // SP·数据库 API、世界书解码或卡内外部 import，与 MVU initGlobals()“先发布
            // 全局对象，后初始化聊天级模块”的可观测语义一致。
            try {
                const ext = charExtensions(ch) || {};
                const marker = ext.mvu2shujuku || {};
                if (typeof marker.layout === 'string' || Array.isArray(marker.layout)) activeLayout = resolveRuntimeLayout(marker.layout);
                if (activeLayout) activeLayoutCardKey = cardCacheKey(currentCharacter() || ch);
            } catch (e) {
                dbgWarn(' 同步运行时：提前解析 layout 失败，等自动建表流程重试:', e && e.message ? e.message : e);
            }
            installWindowGetAllVariables();
            installWindowMvuShim();
            installTableUpdateHook();
        } else {
            activeLayout = null;
            activeLayoutCardKey = '';
            activePlaceholderNeeded = false;
            restoreWindowMvuShim();
            restoreWindowGetAllVariables();
            uninstallTableUpdateHook();
        }
    }

    async function doConvert(inputBytes, sourceIsPng, sourceCharacter) {
        const settings = getSettings();
        const core = window.MVU2SHUJUKU_CORE;
        if (!core || typeof core.convert !== 'function') {
            throw new Error('转换核心未加载（MVU2SHUJUKU_CORE 不可用）');
        }
        // AI 实际输出 insertRow DSL 还是 SQL 由 SP·数据库 插件自身的填表模式决定，
        // 模板本身对三种模式产出完全一致（测试断言过），因此转换统一按双模式输出。
        const mode = 'both';
        const opts = {
            mode,
            asPng: settings.asPng === 'auto' ? sourceIsPng : settings.asPng === 'png',
            appendPlaceholder: settings.appendPlaceholder !== false,
            ddlIncludeCheck: settings.ddlIncludeCheck !== false,
            translateSimpleEjs: !!settings.translateSimpleEjs,
        };
        if (settings.installMvuShim !== 'auto') {
            opts.installMvuShim = settings.installMvuShim === 'yes';
        }
        let result = core.convert(inputBytes, opts);
        mergeState.appliedRefs = [];
        activeProfileAppliedToLastResult = false;
        if (activeProfileName) {
            const applied = await applySelectedProfile(result.template);
            if (applied.applied) {
                opts.template = applied.template;
                result = core.refreshConversion(result, opts);
                activeProfileAppliedToLastResult = true;
            }
            result.reportText += '\n\n## 配置应用摘要\n\n' + applied.summary;
            if (applied.notes.length) result.reportText += '\n\n- ' + applied.notes.join('\n- ');
        }
        lastInput = inputBytes;
        if (result.meta.isPngInput) {
            result.meta.avatarBytes = inputBytes;
            result.meta.avatarMime = 'image/png';
        }
        result.meta.sourceCharacter = sourceCharacter ? { name: characterDisplayName(sourceCharacter), avatar: sourceCharacter.avatar || '' } : null;
        lastResult = result;
        renderResult(result);
        return result;
    }

    // 合并数据库插件现有模板：选择来源 → 列出表 → 勾选 → 并入转换结果
    let mergeSourceTimer = null;
    async function populateMergeSource(panel) {
        const sel = panel.querySelector('#mvu2shujuku-merge-source');
        if (!sel) return;
        const prev = sel.value;
        sel.innerHTML = '';
        const opt = (v, label) => {
            const o = hostDocument.createElement('option');
            o.value = v;
            o.textContent = label;
            sel.appendChild(o);
        };
        opt('', '（选择模板来源）');
        opt('chat', '当前聊天模板');
        opt('global', '全局模板（当前选中）');
        const api = getAcuApi();
        let presetCount = 0;
        let presetOk = false;
        if (api && typeof api.getTemplatePresetNames === 'function') {
            try {
                const names = api.getTemplatePresetNames() || [];
                for (const n of names) opt('preset:' + n, '预设：' + n);
                presetCount = names.length;
                presetOk = true;
            } catch (e) {
                dbgWarn(' getTemplatePresetNames 异常:', e);
            }
        }
        dbg(
            'populateMergeSource: api=' + !!api +
            ' | 有 getTemplatePresetNames=' + !!(api && typeof api.getTemplatePresetNames === 'function') +
            ' | 预设数=' + presetCount + ' | 可读=' + presetOk
        );
        // 插件未就绪或预设尚未读到：持续重试（每 2.5 秒），直到成功读到一次预设列表
        if (!presetOk) {
            if (!mergeSourceTimer) {
                mergeSourceTimer = hostWindow.setTimeout(() => {
                    mergeSourceTimer = null;
                    const p = hostDocument.getElementById(PANEL_ID);
                    if (p) populateMergeSource(p);
                }, 2500);
            }
        } else if (mergeSourceTimer) {
            hostWindow.clearTimeout(mergeSourceTimer);
            mergeSourceTimer = null;
        }
        if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
    }

    function createColumnsToggle(sheet) {
        const details = hostDocument.createElement('details');
        details.className = 'mvu2shujuku-cols-toggle';
        details.style.margin = '2px 0 4px 0';
        const summary = hostDocument.createElement('summary');
        summary.textContent = '列名';
        summary.style.cursor = 'pointer';
        summary.style.fontSize = '12px';
        summary.style.opacity = '0.8';
        const body = hostDocument.createElement('div');
        body.style.padding = '4px 6px';
        body.style.fontSize = '12px';
        body.style.wordBreak = 'break-all';
        const hdr = Array.isArray(sheet && sheet.content && sheet.content[0]) ? sheet.content[0] : [];
        const cols = hdr.filter(h => h !== 'row_id');
        if (!cols.length) {
            body.textContent = '（无列）';
        } else {
            body.appendChild(hostDocument.createTextNode('列名：'));
            cols.forEach((c, i) => {
                if (i) body.appendChild(hostDocument.createTextNode('、'));
                const span = hostDocument.createElement('span');
                span.textContent = c;
                if (c === '_扩展数据') {
                    span.style.opacity = '0.55';
                    span.title = '内部列';
                }
                body.appendChild(span);
            });
        }
        details.appendChild(summary);
        details.appendChild(body);
        return details;
    }

    async function loadMergeTables(panel) {
        const sel = panel.querySelector('#mvu2shujuku-merge-source');
        const box = panel.querySelector('#mvu2shujuku-merge-tables');
        const status = panel.querySelector('#mvu2shujuku-merge-status');
        if (!sel || !box) return;
        // 每次点击都重新拉取来源列表（预设可能刚导入）
        await populateMergeSource(panel);
        // 重渲染后下拉可能暂时为空：回退到上次加载成功的来源（合并后的自动刷新不会误报）
        const v = sel.value || mergeState.source || '';
        if (!v) { toast('请先选择模板来源', 'error'); return; }
        mergeState.source = v;
        const api = getAcuApi();
        dbg(' loadMergeTables: 来源=' + v + ' | api=' + !!api + ' | 有 getTableTemplate=' + !!(api && typeof api.getTableTemplate === 'function'));
        if (!api || typeof api.getTableTemplate !== 'function') {
            toast('未找到 SP·数据库 插件 API', 'error');
            return;
        }
        const tpl = await readTemplateSource(v);
        dbg(' loadMergeTables: source=' + v + ' | 读到的模板=' + !!tpl + ' | sheet 数=' + (tpl ? Object.keys(tpl).filter(k => k.indexOf('sheet_') === 0).length : 0));
        if (!tpl || typeof tpl !== 'object') {
            toast(v === 'default' ? 'SP·数据库默认模板不可用（不会回退为全局模板）' : '未读取到模板（该来源为空或插件未就绪）', 'error');
            return;
        }
        mergeState.sourceTemplate = tpl;
        const sheets = Object.keys(tpl).filter(k => k.startsWith('sheet_') && tpl[k] && typeof tpl[k] === 'object' && !Array.isArray(tpl[k]));
        dbg(' loadMergeTables: 有效表=' + sheets.length + ' | 表名=' + sheets.map(k => tpl[k].name).join('、'));
        if (!sheets.length) {
            box.innerHTML = '';
            toast('该模板没有表格', 'error');
            return;
        }
        const existing = new Set();
        if (lastResult && lastResult.template) {
            for (const k of Object.keys(lastResult.template).filter(k => k.startsWith('sheet_'))) {
                const s = lastResult.template[k];
                if (s && typeof s.name === 'string') existing.add(String(s.name).trim());
            }
        }
        box.innerHTML = '';
        for (const uid of sheets) {
            const s = tpl[uid];
            const dup = existing.has(String(s.name || '').trim());
            const label = hostDocument.createElement('label');
            label.style.display = 'block';
            const cb = hostDocument.createElement('input');
            cb.type = 'checkbox';
            cb.value = uid;
            cb.checked = false;
            label.appendChild(cb);
            label.appendChild(hostDocument.createTextNode(
                ' ' + (s.name || uid) +
                (dup ? '（已存在于转换结果，合并将跳过）' : '')
            ));
            if (dup) cb.disabled = true;
            const row = hostDocument.createElement('div');
            row.style.margin = '2px 0';
            row.appendChild(label);
            row.appendChild(createColumnsToggle(s));
            box.appendChild(row);
        }
        const applyBtn = panel.querySelector('#mvu2shujuku-merge-apply');
        if (applyBtn) applyBtn.style.display = lastResult ? '' : 'none';
        if (status) status.textContent = '';
        toast('已列出 ' + sheets.length + ' 张表，勾选后点击「合并到转换结果」', 'info');
    }

    async function applyMergeTables(panel) {
        if (!lastResult || !lastInput) { toast('请先转换角色卡', 'error'); return; }
        if (!mergeState.sourceTemplate) { toast('请先选择模板来源并点「加载表列表」，再勾选要并入的表', 'error'); return; }
        const box = panel.querySelector('#mvu2shujuku-merge-tables');
        const status = panel.querySelector('#mvu2shujuku-merge-status');
        const checked = box ? [...box.querySelectorAll('input[type=checkbox]:checked')].map(cb => cb.value) : [];
        if (!checked.length) { toast('请至少勾选一张要并入的表', 'error'); return; }
        const core = window.MVU2SHUJUKU_CORE;
        if (!core || typeof core.mergeTemplates !== 'function' || typeof core.refreshConversion !== 'function') {
            toast('转换核心不可用', 'error');
            return;
        }
        const merged = core.mergeTemplates(lastResult.template, mergeState.sourceTemplate, checked);
        dbg(' applyMergeTables: 勾选=' + checked.join('、') + ' | 新增=' + merged.added.join('、') + ' | 跳过=' + merged.skipped.join('、') + ' | 合并后表数=' + Object.keys(merged.template).filter(k => k.startsWith('sheet_')).length);
        if (!merged.added.length) { toast('没有可并入的表（全部重名或无效）', 'error'); return; }
        const settings = getSettings();
        const mode = 'both';
        const opts = {
            mode,
            template: merged.template,
            asPng: settings.asPng === 'auto' ? !!lastResult.meta.isPngInput : settings.asPng === 'png',
            appendPlaceholder: settings.appendPlaceholder !== false,
            ddlIncludeCheck: settings.ddlIncludeCheck !== false,
            translateSimpleEjs: !!settings.translateSimpleEjs,
        };
        if (settings.installMvuShim !== 'auto') opts.installMvuShim = settings.installMvuShim === 'yes';
        toast('正在合并表格…');
        try {
            const priorRefs = Array.isArray(mergeState.appliedRefs) ? mergeState.appliedRefs.slice() : [];
            for (const uid of checked) {
                const sheet = mergeState.sourceTemplate[uid];
                if (!sheet || merged.added.indexOf(String(sheet.name || uid)) === -1) continue;
                const ref = { source: { value: mergeState.source }, uid, name: String(sheet.name || uid), fingerprint: sheetFingerprint(sheet) };
                const same = priorRefs.findIndex(x => x && x.source && x.source.value === ref.source.value && x.name === ref.name);
                if (same >= 0) priorRefs[same] = ref; else priorRefs.push(ref);
            }
            const result = core.refreshConversion(lastResult, opts);
            result.meta.sourceCharacter = lastResult.meta.sourceCharacter || null;
            if (result.meta.isPngInput) {
                result.meta.avatarBytes = lastInput;
                result.meta.avatarMime = 'image/png';
            }
            lastResult = result;
            mergeState.appliedRefs = priorRefs;
            renderResult(result);
            dbg(' applyMergeTables 产物更新完成: meta.tableCount=' + result.meta.tableCount + ' | tableNames=' + result.meta.tableNames.join('、'));
            const msg = '合并完成：新增 ' + merged.added.length + ' 张表' + (merged.skipped.length ? '，跳过重名：' + merged.skipped.join('、') : '');
            if (status) status.textContent = msg;
            toast(msg, 'info');
            // 刷新勾选列表：已并入的表标记为“已存在”
            try { await loadMergeTables(panel); } catch (e) {}
        } catch (e) {
            toast('合并失败：' + (e && e.message ? e.message : e), 'error');
        }
    }

    async function fetchAvatarBlob(character) {
        const context = getContextSafe();
        const ch = character || currentCharacter();
        if (!ch || !ch.avatar) return null;
        try {
            const headers = typeof context.getRequestHeaders === 'function' ? context.getRequestHeaders() : {};
            const res = await fetch('/characters/' + encodeURIComponent(ch.avatar), { headers });
            if (!res.ok) return null;
            return await res.blob();
        } catch (e) {
            return null;
        }
    }

    async function saveCardToSillyTavern() {
        if (!lastResult) {
            toast('请先转换', 'error');
            return false;
        }
        // 参数有实时改动时，先按当前模板重新生成角色卡（内嵌 base64 模板），再保存
        if (updateParamsDirty) {
            try {
                refreshConvertedResult();
            } catch (e) {
                toast('保存前刷新参数失败：' + (e && e.message ? e.message : e), 'error');
                return false;
            }
        }
        const result = lastResult;
        const panel = hostDocument.getElementById(PANEL_ID);
        const context = getContextSafe();
        const log = [];
        const displayName = String((result.card && (result.card.data || result.card).name) || '').trim() || '角色';
        try {
            // 统一成 chara_card_v3 包装（服务端按 json_data 整体导入，保留世界书等全部内容）
            let cardData = result.card;
            if (cardData && !cardData.data && cardData.name) {
                cardData = { spec: 'chara_card_v3', spec_version: '3.0', data: cardData };
            }
            let avatarBlob = null;
            if (result.meta && result.meta.avatarBytes) {
                avatarBlob = new Blob([result.meta.avatarBytes], { type: result.meta.avatarMime || 'application/json' });
            } else {
                avatarBlob = result.meta && result.meta.sourceCharacter
                    ? await fetchAvatarBlob(result.meta.sourceCharacter) : null;
            }

            // 优先用新版 API；老版本 createCharacterData 是表单状态对象时走直接接口
            let saved = false;
            let savedAvatar = '';
            if (typeof context.createCharacterData === 'function') {
                const created = await context.createCharacterData(undefined, avatarBlob || new Blob(), cardData, false);
                savedAvatar = typeof created === 'string'
                    ? created.trim()
                    : String(created && (created.avatar || created.avatarId || created.fileName) || '').trim();
                saved = true;
            } else {
                // 直接走 /api/characters/create：必须把角色卡所有字段都放进表单，
                // 服务端 charaFormatData 会用表单字段覆盖卡内同名字段，缺字段会被清空。
                const d = cardData.data || cardData;
                const ex = d.extensions || {};
                const dp = ex.depth_prompt || {};
                const appendStr = (key, value) => {
                    if (value !== undefined && value !== null) formData.append(key, String(value));
                };
                const formData = new FormData();
                formData.append('ch_name', displayName);
                formData.append('json_data', JSON.stringify(cardData));
                appendStr('description', d.description);
                appendStr('personality', d.personality);
                appendStr('scenario', d.scenario);
                appendStr('first_mes', d.first_mes);
                appendStr('mes_example', d.mes_example);
                appendStr('creator_notes', d.creator_notes);
                appendStr('system_prompt', d.system_prompt);
                appendStr('post_history_instructions', d.post_history_instructions);
                appendStr('creator', d.creator);
                appendStr('character_version', d.character_version);
                appendStr('talkativeness', d.talkativeness !== undefined ? d.talkativeness : ex.talkativeness);
                appendStr('fav', ex.fav === true);
                appendStr('world', ex.world);
                appendStr('depth_prompt_prompt', dp.prompt);
                appendStr('depth_prompt_depth', dp.depth);
                appendStr('depth_prompt_role', dp.role);
                const tags = Array.isArray(d.tags) ? d.tags.join(',') : d.tags;
                appendStr('tags', tags);
                const greetings = Array.isArray(d.alternate_greetings) ? d.alternate_greetings : (d.alternate_greetings ? [d.alternate_greetings] : []);
                for (const g of greetings) formData.append('alternate_greetings', g);
                formData.append('extensions', JSON.stringify(ex));
                if (avatarBlob) formData.append('avatar', avatarBlob, 'avatar.png');
                const headers = typeof context.getRequestHeaders === 'function'
                    ? context.getRequestHeaders({ omitContentType: true })
                    : {};
                const res = await fetch('/api/characters/create', {
                    method: 'POST',
                    headers,
                    body: formData,
                });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                // ST create 接口返回刚创建卡的唯一头像文件名。同名卡
                // 可能并存，不能只按显示名反查。
                savedAvatar = String(await res.text() || '').trim();
                saved = true;
            }
            if (!saved) throw new Error('角色卡保存失败（未知原因）');
            log.push('✓ 角色卡已保存：' + displayName);
            if (typeof context.getCharacters === 'function') {
                try {
                    const refreshedCharacters = await context.getCharacters();
                    // 酒馆助手会在角色创建/切换事件后同步其脚本面板状态。
                    // 若当前面板仍是原卡，这个延后同步可能把已转换卡的
                    // tavern_helper.scripts 覆盖回“禁用的旧 mvu”，同时擦掉数据库桥。
                    // 创建完成并刷新列表后，通过 ST 官方 writeExtensionField
                    // 对转换标记精确命中的新卡重申最终脚本字段。
                    const expectedData = cardData && (cardData.data || cardData);
                    const expectedExt = expectedData && expectedData.extensions;
                    const expectedMarker = expectedExt && expectedExt.mvu2shujuku;
                    const refreshedContext = getContextSafe();
                    const charsNow = Array.isArray(refreshedCharacters)
                        ? refreshedCharacters
                        : (Array.isArray(refreshedContext.characters) ? refreshedContext.characters : (Array.isArray(context.characters) ? context.characters : []));
                    const coreApi = window.MVU2SHUJUKU_CORE;
                    const savedIndex = coreApi && typeof coreApi.findConvertedCharacterIndex === 'function'
                        ? await coreApi.findConvertedCharacterIndex(charsNow, {
                            displayName,
                            avatar: savedAvatar,
                            convertedAt: expectedMarker && expectedMarker.convertedAt,
                        }, ch => fetchFullCharacter(ch, true))
                        : -1;
                    const writeExtensionField = (refreshedContext && refreshedContext.writeExtensionField) || context.writeExtensionField;
                    if (savedIndex >= 0 && expectedExt && typeof writeExtensionField === 'function') {
                        const tavernHelperCopy = JSON.parse(JSON.stringify(expectedExt.tavern_helper || { scripts: [] }));
                        await writeExtensionField(savedIndex, 'tavern_helper', tavernHelperCopy);
                        log.push('✓ 已核对并固化转换卡的酒馆助手脚本（旧 MVU 已移除）');
                    } else if (expectedExt && expectedExt.tavern_helper) {
                        log.push('⚠ 角色卡已保存，但未能使用 ST 官方字段接口复核酒馆助手脚本；若面板仍显示旧 MVU，请用下载 PNG 导入。');
                    }
                    if (panel) populateCharacterSelect(panel);
                } catch (e) {
                    log.push('⚠ 复核酒馆助手脚本失败：' + (e && e.message ? e.message : e));
                }
            }
        } catch (e) {
            const msg = (e && e.message ? e.message : e);
            toast('保存失败，已回退到下载：' + msg, 'error');
            for (const f of result.files) {
                if (f.kind === 'card') download(f.name, f.mime, f.data);
            }
            if (lastResult === result) await autoSaveConversionProfile();
            showInfoPopup('保存失败', '角色卡保存失败，已回退到下载。\n\n' + msg + '\n\n如需排查请把此日志发给开发者。');
            return false;
        }

        // 第二步：把表格模板存为插件的“全局模板预设”（失败不阻断角色卡保存）
        let presetName = '';
        const acu = getAcuApi();
        if (acu && result.template) {
            presetName = displayName + '模板';
            try {
                const presetResult = await acu.importTemplateFromData(result.template, { scope: 'global', presetName });
                if (presetResult && presetResult.success === false) {
                    log.push('✗ 表格模板导入插件失败：' + (presetResult.message || '未知原因'));
                } else {
                    log.push('✓ 表格模板已保存为插件预设：' + presetName);
                }
            } catch (e) {
                log.push('✗ 表格模板导入插件异常：' + (e && e.message ? e.message : e));
            }
        } else {
            log.push('⚠ 未找到 SP·数据库 插件 API，模板未导入（可下载“表格模板 JSON”手动导入插件）。');
        }

        // 第三步：弹窗汇总
        const hasError = log.some(line => line.startsWith('✗'));
        const body = log.join('\n') + (hasError
            ? '\n\n有失败项，请把上方日志发给开发者排查。'
            : (presetName
                ? '\n\n进入新聊天且表格为空时会自动建表，无需手动切换；模板已存为插件预设「' + presetName + '」备用，也可在插件模板面板手动切换。'
                : ''));
        showInfoPopup(hasError ? '保存完成（有失败项）' : '保存完成', body);
        if (lastResult === result) await autoSaveConversionProfile();
        return !hasError;
    }

    // 弹窗：优先用酒馆通用弹窗，失败退回 toast
    function showInfoPopup(title, body) {
        const context = getContextSafe();
        const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        try {
            if (context.callGenericPopup && context.POPUP_TYPE) {
                const html = '<h3>' + esc(title) + '</h3><pre style="white-space:pre-wrap;text-align:left;max-height:50vh;overflow:auto;">' + esc(body) + '</pre>';
                context.callGenericPopup(html, context.POPUP_TYPE.TEXT, '', { okButton: '知道了' });
                return;
            }
        } catch (e) {}
        try {
            if (hostWindow.alert) hostWindow.alert(title + '\n\n' + body);
        } catch (e2) {}
        toast(title + '：' + body, 'info');
    }

    // 表格“自动化更新参数”快速编辑器（只改转换结果模板 JSON，不走插件 API）
    // 字段与 SP·数据库 插件「自动化更新参数」面板一一对应；缺省 -1 = 沿用插件全局设置。
    const UPDATE_PARAM_OPTIONS = [
        { key: 'updateFrequency', label: '更新频率', hint: '-1=沿用全局；0=停用该表自动更新' },
        { key: 'groupId', label: '分组编号', hint: '-1=沿用全局' },
        { key: 'contextDepth', label: '上下文层数', hint: '-1=沿用全局' },
        { key: 'batchSize', label: '批处理大小', hint: '-1=沿用全局' },
        { key: 'skipFloors', label: '跳过楼层', hint: '-1=沿用全局' },
        { key: 'sendLatestRows', label: '发送最新行数', hint: '-1=沿用全局' },
    ];
    // 每行当前选择的参数（uid -> key），重渲染后保持下拉选择不变
    const updateParamState = {};
    // 参数是否有未落盘的改动：下载/保存时据此重新生成转换结果（模板 JSON 改动本身是实时的）
    let updateParamsDirty = false;

    function refreshConvertedResult() {
        // 模板参数编辑仅刷新产物；转换规则变化时核心自动退回完整转换。
        if (!lastInput || !lastResult) return null;
        const settings = getSettings();
        const core = window.MVU2SHUJUKU_CORE;
        if (!core || typeof core.refreshConversion !== 'function') throw new Error('转换核心不可用');
        const opts = {
            mode: 'both',
            template: lastResult.template,
            asPng: settings.asPng === 'auto' ? !!lastResult.meta.isPngInput : settings.asPng === 'png',
            appendPlaceholder: settings.appendPlaceholder !== false,
            ddlIncludeCheck: settings.ddlIncludeCheck !== false,
            translateSimpleEjs: !!settings.translateSimpleEjs,
        };
        if (settings.installMvuShim !== 'auto') opts.installMvuShim = settings.installMvuShim === 'yes';
        const result = core.refreshConversion(lastResult, opts);
        result.meta.sourceCharacter = lastResult.meta.sourceCharacter || null;
        if (result.meta.isPngInput) {
            result.meta.avatarBytes = lastInput;
            result.meta.avatarMime = 'image/png';
        }
        lastResult = result;
        updateParamsDirty = false;
        return result;
    }

    function updateConfigOf(sheet) {
        if (!sheet || typeof sheet !== 'object') return {};
        if (!sheet.updateConfig || typeof sheet.updateConfig !== 'object') sheet.updateConfig = {};
        return sheet.updateConfig;
    }

    function getUpdateParam(sheet, key) {
        const v = updateConfigOf(sheet)[key];
        return Number.isFinite(Number(v)) ? Number(v) : -1;
    }

    function normalizeUpdateParamValue(value) {
        const raw = String(value == null ? '' : value).trim();
        const n = raw === '' ? -1 : Math.trunc(Number(raw));
        return Number.isFinite(n) ? n : -1;
    }

    function setUpdateParam(sheet, key, value) {
        const cfg = updateConfigOf(sheet);
        cfg.uiSentinel = -1; // 与插件 UI 一致：标记已由用户显式设置
        cfg[key] = normalizeUpdateParamValue(value);
        return cfg[key];
    }

    function updateParamSheetRows(result) {
        return Object.keys(result.template || {})
            .filter(k => k.startsWith('sheet_'))
            .map(k => ({ uid: k, sheet: result.template[k] }))
            .filter(x => x.sheet && typeof x.sheet === 'object' && !Array.isArray(x.sheet))
            .sort((a, b) => {
                const ao = Number.isFinite(a.sheet.orderNo) ? a.sheet.orderNo : 999999;
                const bo = Number.isFinite(b.sheet.orderNo) ? b.sheet.orderNo : 999999;
                return ao - bo || String(a.sheet.name || a.uid).localeCompare(String(b.sheet.name || b.uid), 'zh-CN');
            });
    }

    function paramOptionHtml(selectedKey) {
        return UPDATE_PARAM_OPTIONS.map(o =>
            '<option value="' + o.key + '"' + (o.key === selectedKey ? ' selected' : '') + '>' + o.label + '</option>'
        ).join('');
    }

    function renderUpdateConfigEditor(box, result) {
        const rows = updateParamSheetRows(result);
        if (!rows.length) return;
        const wrap = hostDocument.createElement('div');
        wrap.className = 'mvu2shujuku-param-editor';
        const head = hostDocument.createElement('div');
        head.className = 'mvu2shujuku-row';
        head.innerHTML = '<b>表格自动化更新参数</b>';
        wrap.appendChild(head);
        const help = hostDocument.createElement('div');
        help.className = 'mvu2shujuku-help';
        help.innerHTML = '直接修改转换结果模板 JSON，改动实时写入（下载/保存时自动带上，无需再点确定）。' +
            '参数 -1 = 沿用插件全局设置；更新频率 0 = 停用该表自动更新。' +
            '已创建聊天中的表格不会自动变更（聊天作用域持有自己的模板副本），如需同步请重新导入模板或在新聊天中建表。';
        wrap.appendChild(help);

        // 整体编辑：一个参数+数值应用到全部表格（始终可用，不另设开关）
        const bulk = hostDocument.createElement('div');
        bulk.className = 'mvu2shujuku-row mvu2shujuku-param-bulk';
        const bulkLabel = hostDocument.createElement('span');
        bulkLabel.className = 'mvu2shujuku-label';
        bulkLabel.textContent = '整体编辑';
        const bulkSel = hostDocument.createElement('select');
        bulkSel.className = 'mvu2shujuku-param-select';
        bulkSel.innerHTML = paramOptionHtml('updateFrequency');
        const bulkInput = hostDocument.createElement('input');
        bulkInput.type = 'number';
        bulkInput.min = '-1';
        bulkInput.step = '1';
        bulkInput.value = '-1';
        bulkInput.className = 'mvu2shujuku-param-value';
        const bulkBtn = hostDocument.createElement('button');
        bulkBtn.className = 'menu_button';
        bulkBtn.textContent = '应用到全部表格';
        bulkBtn.addEventListener('click', () => {
            const key = bulkSel.value;
            const v = normalizeUpdateParamValue(bulkInput.value);
            let count = 0;
            for (const r of rowEls) {
                setUpdateParam(r.sheet, key, v);
                updateParamState[r.uid] = key;
                r.sel.value = key;
                r.sel.title = (UPDATE_PARAM_OPTIONS.find(o => o.key === key) || {}).hint || '';
                r.input.value = String(v);
                r.input.title = r.sel.title;
                count++;
            }
            updateParamsDirty = true;
            const label = (UPDATE_PARAM_OPTIONS.find(o => o.key === key) || {}).label || key;
            toast('已把「' + label + '」设为 ' + v + '，应用到全部 ' + count + ' 张表', 'info');
            dbg(' 整体应用: ' + key + ' = ' + v + ' → ' + count + ' 张表');
        });
        bulk.appendChild(bulkLabel);
        bulk.appendChild(bulkSel);
        bulk.appendChild(bulkInput);
        bulk.appendChild(bulkBtn);
        wrap.appendChild(bulk);

        // 逐表编辑：表名 | 参数 | 数值（实时写入模板 JSON）
        const grid = hostDocument.createElement('div');
        grid.className = 'mvu2shujuku-param-grid';
        const mkCell = (cls, text) => {
            const cell = hostDocument.createElement('div');
            cell.className = cls;
            cell.textContent = text;
            return cell;
        };
        grid.appendChild(mkCell('mvu2shujuku-param-head', '表名'));
        grid.appendChild(mkCell('mvu2shujuku-param-head', '参数'));
        grid.appendChild(mkCell('mvu2shujuku-param-head', '数值'));
        const rowEls = [];
        for (const { uid, sheet } of rows) {
            const key = updateParamState[uid] && UPDATE_PARAM_OPTIONS.some(o => o.key === updateParamState[uid])
                ? updateParamState[uid]
                : 'updateFrequency';
            const nameEl = mkCell('mvu2shujuku-param-name', String(sheet.name || uid));
            const sel = hostDocument.createElement('select');
            sel.className = 'mvu2shujuku-param-select';
            sel.innerHTML = paramOptionHtml(key);
            sel.title = (UPDATE_PARAM_OPTIONS.find(o => o.key === key) || {}).hint || '';
            const input = hostDocument.createElement('input');
            input.type = 'number';
            input.min = '-1';
            input.step = '1';
            input.className = 'mvu2shujuku-param-value';
            input.value = String(getUpdateParam(sheet, key));
            input.title = (UPDATE_PARAM_OPTIONS.find(o => o.key === key) || {}).hint || '';
            sel.addEventListener('change', () => {
                updateParamState[uid] = sel.value;
                input.value = String(getUpdateParam(sheet, sel.value));
                input.title = (UPDATE_PARAM_OPTIONS.find(o => o.key === sel.value) || {}).hint || '';
                sel.title = input.title;
                dbg(' 参数行切换: ' + String(sheet.name || uid) + ' → ' + sel.value + ' = ' + input.value);
            });
            input.addEventListener('input', () => {
                const v = setUpdateParam(sheet, sel.value, input.value);
                input.value = String(v);
                updateParamsDirty = true;
                dbg(' 参数行修改: ' + String(sheet.name || uid) + '.' + sel.value + ' = ' + v);
            });
            const cellSel = hostDocument.createElement('div');
            cellSel.className = 'mvu2shujuku-param-cell';
            cellSel.appendChild(sel);
            const cellVal = hostDocument.createElement('div');
            cellVal.className = 'mvu2shujuku-param-cell';
            cellVal.appendChild(input);
            grid.appendChild(nameEl);
            grid.appendChild(cellSel);
            grid.appendChild(cellVal);
            const colDetails = createColumnsToggle(sheet);
            colDetails.style.gridColumn = '1 / -1';
            grid.appendChild(colDetails);
            rowEls.push({ uid, sheet, sel, input });
        }
        wrap.appendChild(grid);
        box.appendChild(wrap);
    }

    // 合并数据库插件现有模板区块：放在参数编辑器与转换报告之间，转换后边改边并更方便
    function renderMergeSection(box, panel) {
        const sec = hostDocument.createElement('div');
        sec.className = 'mvu2shujuku-merge-section';
        sec.innerHTML =
            '<div class="mvu2shujuku-row">' +
            '  <label class="mvu2shujuku-label" for="mvu2shujuku-merge-source">合并数据库现有表格模板（转换完成后可用）</label>' +
            '  <select id="mvu2shujuku-merge-source" title="选择模板来源：当前聊天模板 / 全局模板 / 全局预设"></select>' +
            '  <button id="mvu2shujuku-merge-load" class="menu_button">加载表列表</button>' +
            '</div>' +
            '<div id="mvu2shujuku-merge-tables" class="mvu2shujuku-hint">选择来源后点「加载表列表」，勾选要并入转换结果（角色卡模板）的表；重名表会自动跳过。</div>' +
            '<div class="mvu2shujuku-row">' +
            '  <button id="mvu2shujuku-merge-apply" class="menu_button" style="display:none">合并到转换结果</button>' +
            '  <span id="mvu2shujuku-merge-status" class="mvu2shujuku-hint"></span>' +
            '</div>';
        box.appendChild(sec);
        const loadBtn = sec.querySelector('#mvu2shujuku-merge-load');
        if (loadBtn && loadBtn.dataset.bound !== 'true') {
            loadBtn.dataset.bound = 'true';
            loadBtn.addEventListener('click', () => loadMergeTables(panel));
        }
        const applyBtn = sec.querySelector('#mvu2shujuku-merge-apply');
        if (applyBtn && applyBtn.dataset.bound !== 'true') {
            applyBtn.dataset.bound = 'true';
            applyBtn.addEventListener('click', () => applyMergeTables(panel));
        }
        // 恢复上次加载成功的来源（首次默认「全局模板」），减少一次手选；
        // 加载成功后「合并到转换结果」按钮才会出现
        const srcSel = sec.querySelector('#mvu2shujuku-merge-source');
        if (srcSel) srcSel.value = mergeState.source || 'global';
        // 每次渲染都刷新来源下拉（预设可能刚导入）；内部有 2.5s 未就绪重试
        populateMergeSource(panel);
    }

    function renderResult(result) {
        const panel = hostDocument.getElementById(PANEL_ID);
        if (!panel) return;
        const box = panel.querySelector('.mvu2shujuku-result');
        if (!box) return;
        box.innerHTML = '';
        // 每次渲染出的转换结果都是最新状态（含刚合并/刚改完参数），重置“待刷新”标记
        updateParamsDirty = false;
        const head = hostDocument.createElement('div');
        head.className = 'mvu2shujuku-row';
        head.innerHTML = '<b>转换完成</b>：' + result.meta.tableCount + ' 张表';
        box.appendChild(head);
        // 自动化更新参数快速编辑器（只改转换结果模板 JSON）
        renderUpdateConfigEditor(box, result);
        // 合并数据库现有表格（参数编辑器与报告之间）
        renderMergeSection(box, panel);
        // 第一步：先看报告
        const report = hostDocument.createElement('textarea');
        report.className = 'mvu2shujuku-report';
        report.value = result.reportText;
        report.readOnly = true;
        box.appendChild(report);
        // 最后一步：下载与保存到酒馆（放在合并模板区块之后）
        const downloadsBox = panel.querySelector('#mvu2shujuku-downloads');
        if (downloadsBox) {
            downloadsBox.innerHTML = '';
            for (const f of result.files) {
                const btn = hostDocument.createElement('button');
                btn.className = 'menu_button';
                btn.textContent = f.kind === 'bridge' ? '下载数据桥源码（仅供调试）' : ('下载 ' + f.name);
                if (f.kind === 'bridge') {
                    btn.title = '该 .js 是已内嵌进转换后角色卡的纯源码备份，无需再导入；它不是酒馆助手要求的 .json 导入包。';
                }
                btn.addEventListener('click', async () => {
                    // 下载时用最新模板重新生成，保证参数改动一定带进文件
                    try {
                        if (f.kind === 'template') {
                            download(f.name, f.mime, JSON.stringify(lastResult.template, null, 2));
                            await autoSaveConversionProfile();
                        } else if (f.kind === 'card') {
                            refreshConvertedResult();
                            const fresh = (lastResult.files || []).find(x => x.kind === 'card');
                            if (!fresh) throw new Error('重新生成的角色卡文件缺失');
                            download(fresh.name, fresh.mime, fresh.data);
                            await autoSaveConversionProfile();
                        } else if (f.kind === 'bridge') {
                            if (updateParamsDirty) refreshConvertedResult();
                            const fresh = (lastResult.files || []).find(x => x.kind === 'bridge');
                            if (!fresh) throw new Error('重新生成的数据桥文件缺失');
                            download(fresh.name, fresh.mime, fresh.data);
                        } else {
                            download(f.name, f.mime, lastResult.reportText || f.data);
                        }
                    } catch (e) {
                        toast('下载内容刷新失败，已使用转换时的版本：' + (e && e.message ? e.message : e), 'error');
                        download(f.name, f.mime, f.data);
                    }
                });
                downloadsBox.appendChild(btn);
            }
        }
        const saveBtn = panel.querySelector('#mvu2shujuku-save-card');
        if (saveBtn) saveBtn.style.display = '';
        toast('转换完成，共 ' + result.meta.tableCount + ' 张表');
    }

    function findSettingsMount() {
        const selectors = [
            '#extensions_settings2',
            '#extensions_settings',
            '#third_party_extension_settings',
            '.extensions_settings',
        ];
        for (const selector of selectors) {
            const node = hostDocument.querySelector(selector);
            if (node) return node;
        }
        return null;
    }

    function renderSettingsPanel(panel) { panel.innerHTML = window.__MVU2SHUJUKU_SETTINGS_VIEW__(getSettings()); }

    function bindSettingsPanel(panel, context) {
        const bind = (id, fn) => {
            const el = panel.querySelector(id);
            if (el && el.dataset.bound !== 'true') {
                el.dataset.bound = 'true';
                el.addEventListener('click', fn);
            }
        };
        populateCharacterSelect(panel);
        startCharacterListRefresh(panel);
        populateProfileSelect(panel);
        populateMergeSource(panel);
        const searchBox = panel.querySelector('#mvu2shujuku-char-search');
        if (searchBox && searchBox.dataset.bound !== 'true') {
            searchBox.dataset.bound = 'true';
            searchBox.addEventListener('input', () => populateCharacterSelect(panel));
        }
        bind('#mvu2shujuku-char-refresh', async () => {
            try {
                const latest = getContextSafe();
                if (typeof latest.getCharacters === 'function') await latest.getCharacters();
                populateCharacterSelect(panel);
                const count = Array.isArray(getContextSafe().characters) ? getContextSafe().characters.length : 0;
                toast('角色列表已刷新，共 ' + count + ' 张', 'success');
            } catch (e) { toast('刷新角色列表失败：' + (e && e.message ? e.message : e), 'error'); }
        });
        const profileSel = panel.querySelector('#mvu2shujuku-profile-select');
        if (profileSel && profileSel.dataset.bound !== 'true') {
            profileSel.dataset.bound = 'true';
            profileSel.addEventListener('change', () => {
                activeProfileName = profileSel.value || '';
                // 转换完后又切到另一配置，不能把旧结果覆盖进新选配置。
                activeProfileAppliedToLastResult = false;
                const del = panel.querySelector('#mvu2shujuku-profile-delete');
                if (del) del.disabled = !activeProfileName;
            });
        }
        bind('#mvu2shujuku-profile-delete', () => {
            if (!activeProfileName) return;
            if (!hostWindow.confirm('确定删除转换配置「' + activeProfileName + '」？\n不会删除角色卡或数据库预设。')) return;
            delete conversionProfiles()[activeProfileName];
            activeProfileName = '';
            activeProfileAppliedToLastResult = false;
            saveSettings();
            populateProfileSelect(panel);
            toast('转换配置已删除', 'success');
        });
        // 输入来源二选一：切换时只显示对应来源区域，并启用对应的转换按钮
        const applySource = (value) => {
            const isChar = value === 'character';
            const charArea = panel.querySelector('#mvu2shujuku-char-area');
            const fileArea = panel.querySelector('#mvu2shujuku-file-area');
            const btnCurrent = panel.querySelector('#mvu2shujuku-convert-current');
            const btnFile = panel.querySelector('#mvu2shujuku-convert-file');
            if (charArea) charArea.style.display = isChar ? '' : 'none';
            if (fileArea) fileArea.style.display = isChar ? 'none' : '';
            // 二选一：只显示当前来源对应的转换按钮
            if (btnCurrent) { btnCurrent.style.display = isChar ? '' : 'none'; btnCurrent.disabled = !isChar; }
            if (btnFile) { btnFile.style.display = isChar ? 'none' : ''; btnFile.disabled = isChar; }
        };
        const sourceRadios = panel.querySelectorAll('input[name="mvu2shujuku-source"]');
        sourceRadios.forEach((radio) => {
            if (radio.dataset.bound !== 'true') {
                radio.dataset.bound = 'true';
                radio.addEventListener('change', () => { if (radio.checked) applySource(radio.value); });
            }
        });
        const checkedSource = panel.querySelector('input[name="mvu2shujuku-source"]:checked');
        applySource(checkedSource ? checkedSource.value : 'character');
        bind('#mvu2shujuku-convert-current', async () => {
            const ch = selectedCharacter(panel);
            if (!ch) { toast('请先在角色卡下拉栏中选择角色', 'error'); return; }
            toast('正在转换…');
            try {
                const full = await fetchFullCharacter(ch);
                if (!full) {
                    toast('获取角色卡完整数据失败（接口可能被其他扩展改写），请重试', 'error');
                    return;
                }
                console.log('[mvu2shujuku] 待转换对象：name=', full && full.name, '| keys=', Object.keys(full || {}).join(','), '| character_book.entries=', full && full.character_book ? full.character_book.entries.length : 'N/A');
                await doConvert(full, false, ch);
            } catch (e) {
                toast('转换失败：' + (e && e.message ? e.message : e), 'error');
            }
        });
        bind('#mvu2shujuku-pick-file', () => {
            const input = panel.querySelector('#mvu2shujuku-file');
            if (input) input.click();
        });
        const fileInput = panel.querySelector('#mvu2shujuku-file');
        if (fileInput && fileInput.dataset.bound !== 'true') {
            fileInput.dataset.bound = 'true';
            fileInput.addEventListener('change', () => {
                const nameEl = panel.querySelector('#mvu2shujuku-file-name');
                if (nameEl) nameEl.textContent = fileInput.files && fileInput.files.length ? '已选择：' + fileInput.files[0].name : '';
            });
        }
        bind('#mvu2shujuku-convert-file', async () => {
            const input = panel.querySelector('#mvu2shujuku-file');
            if (!input || !input.files || !input.files.length) { toast('请先选择文件', 'error'); return; }
            const file = input.files[0];
            toast('正在转换 ' + file.name + ' …');
            try {
                const bytes = await readFileAsBytes(file);
                const isPng = /\.png$/i.test(file.name) || (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50);
                await doConvert(bytes, isPng);
            } catch (e) {
                toast('转换失败：' + (e && e.message ? e.message : e), 'error');
            }
        });
        bind('#mvu2shujuku-clear', () => {
            lastResult = null;
            const box = panel.querySelector('.mvu2shujuku-result');
            if (box) box.innerHTML = '';
            const saveBtn = panel.querySelector('#mvu2shujuku-save-card');
            if (saveBtn) saveBtn.style.display = 'none';
            const downloadsBox = panel.querySelector('#mvu2shujuku-downloads');
            if (downloadsBox) downloadsBox.innerHTML = '';
            mergeState.sourceTemplate = null;
            const tablesBox = panel.querySelector('#mvu2shujuku-merge-tables');
            if (tablesBox) tablesBox.innerHTML = '选择来源后点「加载表列表」，勾选要并入转换结果（角色卡模板）的表；重名表会自动跳过。';
            const applyBtn = panel.querySelector('#mvu2shujuku-merge-apply');
            if (applyBtn) applyBtn.style.display = 'none';
            const statusEl = panel.querySelector('#mvu2shujuku-merge-status');
            if (statusEl) statusEl.textContent = '';
        });
        bind('#mvu2shujuku-save-card', async () => {
            await saveCardToSillyTavern();
        });
        const shimSel = panel.querySelector('#mvu2shujuku-shim');
        if (shimSel && shimSel.dataset.bound !== 'true') {
            shimSel.dataset.bound = 'true';
            shimSel.addEventListener('change', () => {
                getSettings().installMvuShim = shimSel.value;
                saveSettings();
            });
        }
        const ph = panel.querySelector('#mvu2shujuku-placeholder');
        if (ph && ph.dataset.bound !== 'true') {
            ph.dataset.bound = 'true';
            ph.addEventListener('change', () => {
                getSettings().appendPlaceholder = ph.checked;
                saveSettings();
            });
        }
        const debugBox = panel.querySelector('#mvu2shujuku-debug');
        if (debugBox && debugBox.dataset.bound !== 'true') {
            debugBox.dataset.bound = 'true';
            debugBox.addEventListener('change', () => {
                getSettings().debug = debugBox.checked;
                try {
                    if (typeof window !== 'undefined') window.__mvu2shujukuDebug = debugBox.checked;
                } catch (e) {}
                saveSettings();
            });
        }
        const ddlCheckBox = panel.querySelector('#mvu2shujuku-ddl-check');
        if (ddlCheckBox && ddlCheckBox.dataset.bound !== 'true') {
            ddlCheckBox.dataset.bound = 'true';
            ddlCheckBox.addEventListener('change', () => {
                getSettings().ddlIncludeCheck = ddlCheckBox.checked;
                saveSettings();
                if (lastResult) {
                    toast('DDL CHECK 开关已保存；重新转换后生效（现有转换结果不变）', 'info');
                }
            });
        }
        const ejsTranslateBox = panel.querySelector('#mvu2shujuku-ejs-translate');
        if (ejsTranslateBox && ejsTranslateBox.dataset.bound !== 'true') {
            ejsTranslateBox.dataset.bound = 'true';
            ejsTranslateBox.addEventListener('change', () => {
                getSettings().translateSimpleEjs = ejsTranslateBox.checked;
                saveSettings();
            });
        }
        const pngSel = panel.querySelector('#mvu2shujuku-png');
        if (pngSel && pngSel.dataset.bound !== 'true') {
            pngSel.dataset.bound = 'true';
            pngSel.addEventListener('change', () => {
                getSettings().asPng = pngSel.value;
                saveSettings();
            });
        }
    }

    function ensureSettingsPanel(context) {
        const mount = findSettingsMount();
        if (!mount) {
            hostWindow.clearTimeout(state.timer);
            state.timer = hostWindow.setTimeout(() => ensureSettingsPanel(context), 1500);
            return;
        }
        let panel = hostDocument.getElementById(PANEL_ID);
        if (!panel) {
            panel = hostDocument.createElement('section');
            panel.id = PANEL_ID;
            panel.className = PLUGIN_ID + '-settings';
            renderSettingsPanel(panel);
            mount.appendChild(panel);
        }
        bindSettingsPanel(panel, context);
    }

    // 调试钩子：确认 st-prompt-template 每次构建的 EJS 上下文是否包含我们的函数
    let defineTimer = null;
    function resolvePromptMacroRuntime(body) {
        const raw = '{{' + String(body == null ? '' : body) + '}}';
        try {
            const context = getContextSafe();
            if (context && typeof context.substituteParams === 'function') return String(context.substituteParams(raw));
        } catch (e) {}
        for (const root of [window, hostWindow]) {
            try { if (root && typeof root.substituteParams === 'function') return String(root.substituteParams(raw)); } catch (e) {}
        }
        return raw;
    }
    function applyWorldInfoRegexRuntime(scriptName, encodedOriginal, encodedReplacement, initiallyEnabled) {
        let enabled = !!initiallyEnabled;
        let original = '';
        try {
            original = mvu2shujukuDecodeB64(String(encodedOriginal || ''));
            const ch = currentCharacter();
            const ext = charExtensions(ch);
            const scripts = ext && Array.isArray(ext.regex_scripts) ? ext.regex_scripts : [];
            const found = scripts.find(r => String(r && r.scriptName || '') === String(scriptName || ''));
            if (found) enabled = !found.disabled;
            if (!enabled) return original;
            const replacement = mvu2shujukuDecodeB64(String(encodedReplacement || ''));
            const context = getContextSafe();
            if (context && typeof context.substituteParams === 'function') return String(context.substituteParams(replacement));
            if (!/\{\{[\s\S]*?\}\}/.test(replacement)) return replacement;
        } catch (e) {}
        return original;
    }
    function templateDatabaseDefines() {
        const safeDefine = function () { return ejsVariablesSafe(); };
        const getMessageDefine = function (path, options) {
                    const defaultValue = options && typeof options === 'object' && Object.prototype.hasOwnProperty.call(options, 'defaults')
                        ? options.defaults
                        : options;
                    try {
                        const parts = String(path || '').split('.').filter(Boolean);
                        let cur = ejsVariablesSafe();
                        for (const p of parts) { if (cur == null) return defaultValue; cur = cur[p]; }
                        return cur === undefined ? defaultValue : cur;
                    } catch (e) { return defaultValue; }
        };
        const formatMessageDefine = function (path) {
                    const coreNow = window.MVU2SHUJUKU_CORE;
                    return coreNow && typeof coreNow.formatMessageVariableValue === 'function'
                        ? coreNow.formatMessageVariableValue(getMessageDefine(path))
                        : '';
        };
        const setMessageDefine = function (path, value) {
                    try {
                        const parts = String(path || '').split('.').filter(Boolean);
                        if (parts[0] !== 'stat_data' || parts.length < 2) return value;
                        const all = ejsVariablesSafe();
                        const next = JSON.parse(JSON.stringify((all && all.stat_data) || {}));
                        let cur = next;
                        for (let i = 1; i < parts.length - 1; i++) {
                            if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object' || Array.isArray(cur[parts[i]])) cur[parts[i]] = {};
                            cur = cur[parts[i]];
                        }
                        cur[parts[parts.length - 1]] = value;
                        scheduleWindowStatOverlay(next);
                        return value;
                    } catch (e) { return value; }
        };
        const resolveMacroDefine = function (body) { return resolvePromptMacroRuntime(body); };
        const applyWorldInfoRegexDefine = function (name, original, encodedReplacement, initiallyEnabled) {
            return applyWorldInfoRegexRuntime(name, original, encodedReplacement, initiallyEnabled);
        };
        const defines = {
            mvu2shujukuGetAllVariables: safeDefine,
            mvu2shujukuGetMessageVar: getMessageDefine,
            mvu2shujukuFormatMessageVariable: formatMessageDefine,
            mvu2shujukuSetMessageVar: setMessageDefine,
            mvu2shujukuResolveMacro: resolveMacroDefine,
            mvu2shujukuApplyWorldInfoRegex: applyWorldInfoRegexDefine,
        };
        for (const fn of Object.values(defines)) fn.__mvu2shujuku = true;
        return defines;
    }
    function ensureEjsEvalContextBridge(ejs) {
        try {
            if (!ejs || typeof ejs.evalTemplate !== 'function') return false;
            if (ejs.evalTemplate.__mvu2shujukuContextBridge) return true;
            const originalEvalTemplate = ejs.evalTemplate;
            const wrappedEvalTemplate = async function (code, context, options) {
                // 只介入包含本转换器 helper 的模板，其他卡/模板完全走原调用。
                if (!/\bmvu2shujuku(?:GetAllVariables|GetMessageVar|FormatMessageVariable|SetMessageVar|ResolveMacro|ApplyWorldInfoRegex)\b/.test(String(code || ''))) {
                    return originalEvalTemplate.apply(this, arguments);
                }
                const defines = templateDatabaseDefines();
                let actualContext = context;
                if (!actualContext || typeof actualContext !== 'object') {
                    // SP·数据库 v8.9.2 直接 evalTemplate(finalContent)，不传 context。
                    // 显式 prepare 才能保证本次执行环境拿到 helper，不依赖
                    // defines 何时被复制，也不依赖 prompt_template_prepare 事件是否对外发布。
                    actualContext = typeof ejs.prepareContext === 'function'
                        ? await ejs.prepareContext(defines)
                        : defines;
                } else {
                    Object.assign(actualContext, defines);
                }
                if (actualContext && typeof actualContext === 'object') Object.assign(actualContext, defines);
                return originalEvalTemplate.call(this, code, actualContext, options);
            };
            wrappedEvalTemplate.__mvu2shujuku = true;
            wrappedEvalTemplate.__mvu2shujukuContextBridge = true;
            wrappedEvalTemplate.__mvu2shujukuOriginal = originalEvalTemplate;
            ejs.evalTemplate = wrappedEvalTemplate;
            return true;
        } catch (e) { return false; }
    }
    function ensureTemplateDefine() {
        try {
            const roots = [];
            const addRoot = (w) => { try { if (w && roots.indexOf(w) === -1) roots.push(w); } catch (e) {} };
            addRoot(window); addRoot(hostWindow);
            try { addRoot(window.parent); } catch (e) {}
            try { addRoot(window.top); } catch (e) {}
            let installed = false;
            for (const w of roots) {
                const ejs = w && w.EjsTemplate;
                if (!ejs) continue;
                if (ejs.defines && typeof ejs.defines === 'object') Object.assign(ejs.defines, templateDatabaseDefines());
                if (ensureEjsEvalContextBridge(ejs) || (ejs.defines && typeof ejs.defines === 'object')) installed = true;
            }
            if (installed) {
                dbg(' 扩展侧注册 EJS 数据库读写函数完成');
                defineTimer = null;
            } else if (!defineTimer) {
                defineTimer = hostWindow.setTimeout(() => { defineTimer = null; ensureTemplateDefine(); }, 2000);
            }
        } catch (e) {
            dbgWarn(' 扩展侧注册异常:', e);
        }
    }
    function installFrontendEjsLiteralGuard(prepared) {
        if (!prepared || prepared.runType !== 'render' || typeof prepared.activateRegex !== 'function') return;
        const character = currentCharacter();
        if (!character || !isConvertedMvuCard(character)) return;
        const core = window.MVU2SHUJUKU_CORE;
        if (!core || typeof core.protectFrontendEjsLiterals !== 'function') return;
        const chatKey = autoInitChatId(), cardKey = cardCacheKey(character);
        // 使用提示词模板公开的临时 HTML 正则阶段，不改楼层原文、全局设置或远端资源。
        prepared.activateRegex(/[\s\S]+/g, text => {
            const current = currentCharacter();
            if (!current || !isConvertedMvuCard(current) || autoInitChatId() !== chatKey || cardCacheKey(current) !== cardKey) return text;
            return core.protectFrontendEjsLiterals(text);
        }, { uuid: 'mvu2shujuku-frontend-ejs-literals', basic: false, message: true, generate: false,
            before: false, after: false, html: true, order: 100000, sticky: 0 });
    }

    function bindDebugHooks(context) {
        const es = context && (context.eventSource || context.event_source);
        if (!es || typeof es.on !== 'function') return;
        try {
            // 只在首次 prepare 时打一行确认，避免每次生成都刷屏
            let firstPreparedLogged = false;
            es.on('prompt_template_prepare', (prepared) => {
                // defines 是插件级默认上下文；填表插件会自行调用
                // evalTemplate(finalContent)，不同窗口/缓存时它可能不带当前 defines。
                // prepare 事件上再直接注入实际执行上下文，避免任意一个 helper
                // ReferenceError 使 SP 整份提示退回未处理原文。
                if (prepared && typeof prepared === 'object') Object.assign(prepared, templateDatabaseDefines());
                installFrontendEjsLiteralGuard(prepared);
                if (firstPreparedLogged) return;
                firstPreparedLogged = true;
                const pageEjs = (typeof window !== 'undefined' && window.EjsTemplate) || null;
                dbg(
                    'prompt_template_prepare 首次上下文: 键数=' + (prepared ? Object.keys(prepared).length : 0) +
                    ' | getvar=' + typeof (prepared && prepared.getvar) +
                    ' | mvu2shujukuGetAllVariables=' + typeof (prepared && prepared.mvu2shujukuGetAllVariables) +
                    ' | getAllVariables=' + typeof (prepared && prepared.getAllVariables) +
                    ' | 页面EjsTemplate=' + !!pageEjs +
                    ' | 页面defines注册函数=' + typeof (pageEjs && pageEjs.defines && pageEjs.defines.mvu2shujukuGetAllVariables)
                );
            });
            dbg(' 已监听 prompt_template_prepare 事件（仅首次打印上下文）');
        } catch (e) {
            dbgWarn(' 监听 prompt_template_prepare 失败:', e);
        }
    }

    function registerMagicWandRefreshButton(retry) {
        const attempt = Number(retry) || 0;
        try {
            const doc = hostDocument || document;
            const menu = doc && (doc.getElementById('extensionsMenu') || doc.getElementById('extensions_menu'));
            if (!menu) {
                if (attempt < 30) hostWindow.setTimeout(() => registerMagicWandRefreshButton(attempt + 1), 2000);
                return;
            }
            const id = 'mvu2shujuku-refresh-frontend-menu-item';
            let button = doc.getElementById(id);
            if (!button) {
                button = doc.createElement('div');
                button.id = id;
                button.className = 'list-group-item flex-container flexGap5 interactable';
                button.setAttribute('role', 'listitem');
                button.setAttribute('tabindex', '0');
                button.setAttribute('title', '重读当前转换卡的状态栏/整页前端');
                button.innerHTML = '<div class="fa-fw fa-solid fa-rotate extensionsMenuExtensionButton"></div><span>刷新转换卡前端</span>';
                menu.appendChild(button);
            }
            if (button.dataset.mvu2shujukuBound === 'true') return;
            button.dataset.mvu2shujukuBound = 'true';
            button.addEventListener('click', (event) => {
                try { event.stopPropagation(); } catch (e) {}
                let converted = !!activeLayout;
                try { converted = converted || isConvertedMvuCard(currentCharacter()); } catch (e) {}
                if (!converted) {
                    toast('当前角色卡不是 MVU转数据库 的转换产物', 'warning');
                    return;
                }
                // 先重申运行时兼容对象，再让前端读取，也能修复晚创建 iframe 的 Mvu 等待。
                try { applyWindowMvuShim(); } catch (e) {}
                const result = refreshCurrentCardFrontends();
                const count = result.direct + result.event + result.control + result.reload;
                if (count > 0) toast('已刷新转换卡前端（直接 ' + result.direct + '、事件 ' + result.event + '、控件 ' + result.control + '、重载 ' + result.reload + '）', 'success');
                else toast('已广播 MVU 刷新事件；当前前端未声明可确认的重读入口', 'info');
            });
        } catch (e) {
            if (attempt < 10) hostWindow.setTimeout(() => registerMagicWandRefreshButton(attempt + 1), 1000);
        }
    }

    function main() {
        if (runtimeRegistry.ready) {
            const ready = runtimeRegistry.ready;
            // 保留 barrier 到结算为止，避免等待中二次启动绕过在途调用。
            if (!runtimeRegistry.starting) {
                runtimeRegistry.starting = true;
                ready.then(() => { runtimeRegistry.ready = null; main(); })
                    .catch(error => console.error('[mvu2shujuku] 旧桥退出或接管初始化失败:', error));
            }
            return;
        }
        const context = getContextSafe();
        // 按设置初始化 debug 全局标记（dbg/dbgWarn 都读它）
        try {
            const s = getSettings();
            if (typeof window !== 'undefined') window.__mvu2shujukuDebug = !!s.debug;
        } catch (e) {}
        installEarlyEventOnFallback();
        activateRuntimeRegistry();
        ensureSettingsPanel(context);
        registerMagicWandRefreshButton(0);
        bindDebugHooks(context);
        ensureTemplateDefine();
        // 卡内桥在 TH 沙箱中可能被隔离，运行时由扩展兜底（仅对本转换器产物生效）：
        // - 建表：只在当前聊天缺表时 initGameSession（每聊天 done 去重一次，绝不重建/重置已有表格）；
        // - Mvu 兼容：把前端 MVU API 调用翻译成数据库操作；
        // - 占位符：消息收尾补 <StatusPlaceHolderImpl/> 供前端正则注入。
        // 不做锚点重建、不做切聊天时的表管理；Mvu 接管/getAllVariables/表格广播都只对带
        // extensions.mvu2shujuku 独有标记的卡生效，切到其他卡时全部撤销。
        syncRuntimeForCurrentCard();
        bindAutoInit(context);
        hostWindow.setTimeout(autoInitDatabase, 1500);
        const ejs = (typeof window !== 'undefined' && window.EjsTemplate) || null;
        dbg(
            '加载时 EjsTemplate=' + !!ejs +
            ' | defines=' + !!(ejs && ejs.defines) +
            ' | 已注册 mvu2shujukuGetAllVariables=' + typeof (ejs && ejs.defines && ejs.defines.mvu2shujukuGetAllVariables)
        );
        console.log('[mvu2shujuku] 扩展已加载（' + (window.MVU2SHUJUKU_CORE ? window.MVU2SHUJUKU_CORE.VERSION : '核心缺失') +
            ' | 写路径=CRUD 差量 / 原子快照 | 持久化由数据库插件负责）');
    }

    try {
        main();
    } catch (error) {
        console.error('[mvu2shujuku] 初始化失败:', error);
        try {
            if (hostWindow.toastr && typeof hostWindow.toastr.error === 'function') {
                hostWindow.toastr.error(error && error.message ? error.message : String(error), 'MVU转数据库');
            }
        } catch (e) {}
    }
}

module.exports = installExtensionRuntime;
