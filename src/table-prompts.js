'use strict';

// 表格 note、初始化说明与操作示例。构建时以内联工厂复用同一份实现。
function createTablePrompts(deps) {
    'use strict';
    const { describeGroup, isRelationshipKeyColumn, isDollarPrivateColumn,
        isUnderscoreReadonlyColumn, isAiPromptColumn, sqlQuote, schemaExample, vwdToken } = deps;

    function aiJsonColumns(group) {
        if (group.scalarType === 'number') return [];
        if (group.kind === 'json') {
            return (group.wildcardRules || []).length || (group.groupChecks || []).length
                ? (group.columns || []).filter(c => c.zh === '内容') : [];
        }
        return (group.columns || []).filter(c => isAiPromptColumn(group, c)
            && !isRelationshipKeyColumn(group, c) && (c.isObject || c.logicalType === 'jsonObjectOptional'));
    }

    function jsonUpdateGuide(group, mode) {
        const cols = aiJsonColumns(group);
        if (!cols.length) return '';
        const label = group.kind === 'json' ? '内容列' : cols.map(c => `「${c.zh}」`).join('、');
        if (mode === 'native') return `${label}以 JSON 存储；更新单元格时提供完整的新 JSON，保留未改动的字段和元素。`;
        return `${label}以 JSON 存储。SQL 模式优先用 json_set(列, '$."键"', 新值)、json_replace 或 json_remove 局部更新，仅操作规则允许的路径；对象/数组/布尔/null 新值用 json('...')，字符串用 SQL 字符串。数组从 0 索引，末尾追加用 [#]，中间插入/移动需重建受影响数组。空单元格或 JSON null 容器先按规则初始化，保留未改字段；json_patch 的 null 会删键，不作路径更新替代。`
            + (mode === 'both' ? ' native 模式仍提供完整的新单元格 JSON，保留未改内容。' : '');
    }

    function buildNote(group, opts = {}) {
        const mode = opts.mode || 'both';
        const L = [];
        if (group.scalarType === 'number') {
            const scriptReadonly = /^[_$]/.test(String(group.name || ''));
            const rules = [...(group.groupChecks || []), ...(group.wildcardRules || []).flatMap(r => r.checks || [])];
            L.push('数值表（row_id=1，全表固定一行）：「内容」直接保存一个数字，可含小数；禁止写入对象、数组、布尔值或带引号的 JSON 字符串。禁止新增/删除行。');
            if (rules.length) {
                L.push('【更新规则】', ...rules.map(rule => '- ' + sanitizeCheckRule(rule, { group })).filter(s => s !== '- '));
                if (!scriptReadonly) L.push('只在本轮发生相应变化时更新数值；未发生变化则保持原值。');
            } else if (scriptReadonly) L.push('本数值由脚本/前端维护，AI 不应直接修改本表。');
            else L.push('根据正文、设定与本表规则，数值发生明确变化时按需更新；未发生变化则保持原值。');
            if (scriptReadonly && rules.length) L.push('本数值由脚本/前端维护，AI 不应直接修改本表。');
            return L.join('\n');
        }
        const aiCols = group.kind === 'json' ? [] : group.columns.filter(c => isAiPromptColumn(group, c));
        if (group.kind === 'singleton' && group.valueCol && aiCols.length) {
            L.push(`「${group.valueCol}」直接保存整个「${group.name}」变量；空单元格表示该变量不存在，JSON null 表示空值，{} / [] 表示相应空容器。状态切换也只更新此单元格，不能删除身份行。JSON 路径从内容内部开始，不再重复外层组名；内部以 _ 开头的字段由脚本维护，不主动修改。`);
        }
        if (group.scalarValueCol && group.containerSchema && aiCols.length) {
            L.push(`「${group.scalarValueCol}」保存当前键名对应的完整记录；JSON null 表示该记录为空值，{} / [] 表示空容器，删除行表示该键不存在（空单元格读回也视为缺失）。JSON 路径从记录内部开始，不重复键名或关联列。修改内部字段须保留其他字段；内部以 _ 开头的字段由脚本维护。`);
        }
        // 所有下划线前缀列都是只读状态；内部溢出列 _扩展数据虽不进列定义/写入示例，
        // 但 AI 仍能在真实表头/DDL 里看到，因此同样要触发现有只读提示。
        const userReadonlyCols = (group.columns || []).filter(c => isUnderscoreReadonlyColumn(group, c));
        const hasUserReadonly = userReadonlyCols.length > 0;
        const allReadonly = hasUserReadonly && aiCols.length === 0;
        if (group.kind === 'json') {
            const wr = group.wildcardRules || [];
            const gc = group.groupChecks || [];
            if (wr.length || gc.length) {
                // 规则声明了 AI 可写路径（如 户.<门牌>.妻.好感值）：JSON 表不再一刀切只读，
                // 而是列出可写路径与约束；SQL 可在单元格内按路径更新。
                L.push('整组 JSON 存储表（row_id=1，全表固定一行）：本表以 JSON 保存动态结构。AI 可更新「内容」列，只改变【可写路径与约束】中列出的路径，其余字段保持原样；禁止新增/删除行。');
                L.push('【可写路径与约束】');
                for (const r of wr) {
                    const parts = [];
                    if (r.range) parts.push(`数值范围 ${r.range[0]}~${r.range[1]}`);
                    parts.push(...(r.checks || []).map(rule => sanitizeCheckRule(rule, { group, jsonContainer: true })).filter(Boolean));
                    if (parts.length) L.push(`- ${r.path}（${parts.join('；')}）`);
                }
                for (const rule of gc.map(rule => sanitizeCheckRule(rule, { group, jsonContainer: true })).filter(Boolean)) L.push(`- ${rule}`);
                L.push('【更新守卫】');
                // 不给 AI 加“<> 是什么”的说明：MVU 原版就是把规则原文交给 AI 理解，
                // 且不是所有卡都用 <>（也有纯点分路径）。规则原文已在上方【可写路径与约束】保留。
                // 守卫统一放宽：只限制“未声明路径”，不堵死“规则声明可 insert/初始化/新增”
                // 的路径（否则空 JSON 表永远无法初始化，如大荒 宗门表）。不做关键词检测。
                L.push('- 只更新【可写路径与约束】中列出的路径；未列出的字段一律只读（它们仍存在于同一 JSON 中，由脚本/系统维护，AI 不得改动）。规则要求 insert/初始化/新增 的路径允许创建对应字段、对象或记录；严禁新增未声明的字段、对象或记录');
                L.push('- 只更新本轮剧情中明确出现并被影响到的对象；其余对象的数据保持原样');
                L.push('- 更新后必须保留 JSON 中其余全部字段及其原有类型');
            } else {
                L.push(`整组 JSON 存储表（row_id=1，全表固定一行）。本表整组数据由脚本/前端读写，AI 不应直接修改本表，也不要新增或删除行。`);
            }
        } else if (group.kind === 'singleton') {
            // 单例表不重复描述（“全表固定一条记录”等），直接给出开局记录说明；
            // 全只读单例（全部为 _ 字段）不写“只允许 UPDATE”，避免与“AI 无需填表”冲突
            if (aiCols.length) {
                L.push(`本表唯一记录已由开局模板初始化（row_id=1）；填表时禁止 INSERT / DELETE，只允许按需 UPDATE。`);
            } else {
                // 纯容器单例（如 行囊 只有子表 背包、自身无 AI 字段）：提示数据在子表，
                // 避免“AI 无需填表”让人以为整组数据都不存在。
                const childNames = (group.childTables || []).map(ct => ct.tableName || (ct.key + '表'));
                L.push(childNames.length
                    ? `本表为容器（row_id=1 占位），数据保存在「${childNames.join('、')}」中；本表自身无 AI 可填字段，全部字段由脚本/系统维护，AI 无需填表。`
                    : `本表唯一记录已由开局模板初始化（row_id=1）；全部字段由脚本/系统维护，AI 无需填表。`);
            }
        } else {
            // 与插件默认模板一致：note 不重复表名（插件会在表头显示表名），直接给表类型说明
            L.push(describeGroup(group));
        }
        if (group.kind === 'nestedRows' || group.kind === 'nestedArray') {
            const ancestors = (group.ancestorKeyCols && group.ancestorKeyCols.length)
                ? group.ancestorKeyCols : [{ col: group.parentKeyCol, parentTable: group.parentTable }];
            const fields = ancestors.filter(a => a && a.col);
            if (fields.length) {
                const origins = fields.map(a => a.parentTable && a.parentKeyCol
                    ? `「${a.col}」对应「${a.parentTable}.${a.parentKeyCol}」` : `「${a.col}」用于确定所属记录`);
                L.push(`关联字段：${origins.join('；')}。`);
                const locator = [...new Set([...fields.map(a => a.col), ...(group.kind === 'nestedRows' ? [group.keyCol] : [])])].filter(Boolean);
                if (group.kind === 'nestedRows') {
                    L.push(`定位记录须同时匹配${locator.map(k => `「${k}」`).join('、')}；不得只匹配其中一个字段。`);
                    const example = locator.map((key, i) => `「${key}」=“示例值${i + 1}”`).join('、');
                    L.push(`定位示例（值仅为占位，须换成当前表格的实际值）：${example}。只更新或删除完整组合匹配的记录，其他来源下的同名条目保持不变。`);
                } else {
                    L.push(`先核对${locator.map(k => `「${k}」`).join('、')}确认所属记录，再定位要操作的数组元素。`);
                    L.push('定位示例：不同来源各有第 2 个元素时，先确认来源，再取目标元素在本表中的行标识；不能把来源内的序号 1 直接当成本表行号。');
                }
            }
            const knownParent = ancestors.some(a => a && a.parentTable);
            if (knownParent) L.push('关联来源记录删除时，一并删除本表对应记录；来源标识值变更时，同步修改本表对应的关联字段。请在本次填表中完成这些操作。');
        }
        if (['array', 'pathArray', 'nestedArray'].includes(group.kind)) {
            const nativeLocator = 'native 使用本表提示中方括号里的行号（从 0 开始），不填 SQL row_id';
            const sqlLocator = 'SQL 使用当前数据中的 row_id，不按显示顺序推算';
            L.push(mode === 'native' ? nativeLocator + '。' : mode === 'sqlite' ? sqlLocator + '。' : nativeLocator + '；' + sqlLocator + '。');
        }
        if (Array.isArray(group.childTables) && group.childTables.length) {
            const childNames = group.childTables.map(ct => ct.tableName || (ct.key + '表')).filter(Boolean);
            if (childNames.length) L.push(`相关数据保存在「${childNames.join('、')}」；删除本表记录时，一并删除其中对应记录；本表标识值变更时，同步修改其中对应的关联字段。请在本次填表中完成这些操作。`);
        }
        // JSON 表整组由脚本/前端管理：完全不展示列定义与约束；其余表隐藏内部列（_扩展数据）
        // 下划线开头字段 = 脚本维护的只读状态：不进填表规则（AI 仍能在数据表里看到值，
        // 但没有更新规则），只在表级用一行说明约束，避免逐列占提示词。
        if (hasUserReadonly && !allReadonly) {
            // 三种模式共用逻辑字段例子；SQL 列名以实际 DDL 和操作示例为准。
            // 注意：只声明“不列入填表字段/严禁更新”，不要声称“更新会被回滚”——
            // 转换器没有回滚机制（下划线字段只是不进填表规则，AI 若硬写 SQL 不会被回滚）。
            L.push('下划线开头字段（如 _扩展数据）为脚本/系统维护的只读状态，不列入填表字段：AI 只能读取、严禁更新。');
            // 展平后表头可能丢失开头的下划线，必须用实际列名说明只读范围。
            const flattenedReadonly = userReadonlyCols.filter(c => !String(c.zh || '').startsWith('_') && !isDollarPrivateColumn(group, c));
            if (flattenedReadonly.length) L.push(`只读列：${flattenedReadonly.map(c => `「${c.zh}」`).join('、')}；AI 只能读取、严禁更新。`);
            for (const c of userReadonlyCols) {
                if (c.zh !== '_扩展数据' && !isDollarPrivateColumn(group, c) && c.desc) {
                    L.push(`只读字段「${c.zh}」说明：${String(c.desc).trim().replace(/\n/g, '\n  ')}`);
                }
            }
        }
        if (aiCols.length) {
            const rulesStart = L.length;
            L.push('【字段说明与规则】');
            const nullableCols = aiCols.filter(c => (c.logicalType === 'jsonScalarOptional' || c.logicalType === 'jsonPairOptional'));
            if (nullableCols.length) L.push(`- ${nullableCols.map(c => c.zh).join('、')}：按 JSON 标量填值；null 表示空值，字符串保留 JSON 双引号（空字符串为 ""），空单元格表示缺失字段。`);
            const encodedCols = aiCols.filter(c => c.logicalType === 'jsonScalar');
            if (encodedCols.length) L.push(`- ${encodedCols.map(c => `「${c.zh}」`).join('、')}：单元格保存完整 JSON 值，遵守原字段/数组元素的类型；字符串保留 JSON 双引号（如 \"文字\"），数字、布尔、null 不加 JSON 引号，对象/数组保存完整 JSON。SQL 字符串外围的单引号只是 SQL 写法，不属于单元格内容。`);
            const nullableContainers = aiCols.filter(c => c.logicalType === 'jsonObjectOptional');
            if (nullableContainers.length) L.push(`- ${nullableContainers.map(c => c.zh).join('、')}：保存 JSON 对象/数组；JSON null 表示空值，空单元格表示缺失字段。`);
            if (group.kind === 'nestedRows') {
                const entity = group.relationEntity || String(group.parentKeyCol || '').replace(/_键名$/, '') || '关联记录';
                L.push(`- 维护本表时，同时遵循对应${entity}记录中与「${group.childKey || group.name}」相关的整体规则`);
            }
            const columnRuleView = (c) => {
                const parts = [];
                if (c.range) parts.push(`数值范围 ${c.range[0]}~${c.range[1]}`);
                if (c.enum) parts.push(`可选值：${c.enum.join(' / ')}`);
                if (c.format) parts.push(`格式要求：${String(c.format).replace(/\n/g, ' ')}`);
                if (c.isObject) parts.push('对象以 JSON 存储，读取时还原');
                const checks = (c.check || []).map(rule => sanitizeCheckRule(rule, { group, column: c })).filter(Boolean);
                return { parts, checks };
            };
            const emitColumnRules = (label, items) => {
                const rules = [...new Set(items.map(x => String(x == null ? '' : x).trim()).filter(Boolean))];
                if (!rules.length) return;
                if (rules.length === 1) {
                    L.push(`- ${label}：${rules[0].replace(/\n/g, '\n  ')}`);
                    return;
                }
                L.push(`- ${label}：`);
                for (const rule of rules) L.push(`  - ${rule.replace(/\n/g, '\n    ')}`);
            };
            // 字段含义比篇幅更重要：逐列展示实际名称，不把不同字段的说明
            // 或业务条件折叠成模板标签。只在同一字段内部去掉逐字相同的项目。
            // VWD 字段的静态说明在这里换成唯一插槽：运行期只替换“该字段”的当前说明，
            // 不靠 replace(旧说明, 新说明) 猜位置（两个字段说明相同也能正确归属）。
            const vwdPlan = opts.vwdSlotPlan && typeof opts.vwdSlotPlan === 'object' ? opts.vwdSlotPlan : null;
            const vwdByCol = new Map();
            if (vwdPlan && Array.isArray(vwdPlan.fields)) {
                for (const field of vwdPlan.fields) {
                    if (field && field.col && !vwdByCol.has(String(field.col))) vwdByCol.set(String(field.col), field);
                }
            }
            const slotDesc = (c, desc) => {
                const field = vwdByCol.get(String(c.zh));
                if (!field || !vwdPlan) return desc;
                if (!field.noteSlot) {
                    field.noteSlot = vwdToken(vwdPlan.tokens.length);
                    vwdPlan.tokens.push(field.id);
                }
                return field.noteSlot;
            };
            for (const c of aiCols) {
                const view = columnRuleView(c);
                const desc = c.desc ? String(c.desc).trim() : '';
                const generic = desc === '唯一标识' || desc === '对象（JSON 存储，读取时还原）';
                const generatedRelation = (group.ancestorKeyCols || []).some(a => c.zh === a.col
                    && desc === `关联「${a.parentTable}.${a.parentKeyCol}」`);
                const dynamicDescription = vwdPlan && vwdPlan.promptVersion === 1 && vwdByCol.has(String(c.zh));
                const items = [...(dynamicDescription ? [slotDesc(c, desc)] : (!generic && !generatedRelation ? [desc] : [])), ...view.parts, ...view.checks]
                    .map(x => (!dynamicDescription && x && vwdByCol.has(String(c.zh)) && String(x) === desc ? slotDesc(c, desc) : x));
                emitColumnRules(c.zh, items);
            }
            // 子表/动态字典的组级规则（如 世界.动向 的“最多维持2个大事件”）：以表级约束列出
            // 注意：这些行已位于本表自己的 note 内，不再重复表名前缀（避免“道侣表：性别：…”式噪音）
            for (const rule of (group.groupChecks || []).map(rule => sanitizeCheckRule(rule, { group })).filter(Boolean)) L.push(`- ${rule}`);
            // 通配路径规则（如 人物.角色名.亲密）：动态键无法静态展开，作为表格级提示保留，
            // AI 对照快照中的具体键套用（范围/条件仍可见）
            for (const wr of (group.wildcardRules || [])) {
                // 关系表的字段路径规则已在对应列下展示；这里只展示止于整个集合的规则。
                if (wr._relationFieldRule) continue;
                // 已安全展开成固定列的通配字段，其规则已经列在该列下；不要再以
                // MVU 原路径重复一份，否则既浪费提示词，又会让旧 Patch 术语漏过列级清洗。
                const wrParts = String(wr.path || '').split('.').filter(Boolean);
                const wrTail = wrParts[wrParts.length - 1];
                // 只对“${动态行键}.固定字段”这种已直接落列的两段路径去重；
                // 更深层通配路径仍包含动态容器语义，不能因末段恰好同名就丢掉。
                if (wrParts.length === 2 && wrTail && aiCols.some(c => String(c.zh) === wrTail)) continue;
                const parts = [];
                if (wr.range) parts.push(`数值范围 ${wr.range[0]}~${wr.range[1]}`);
                if (wr.format) parts.push(`格式：${wr.format}`);
                parts.push(...(wr.checks || []).map(rule => sanitizeCheckRule(rule, { group })).filter(Boolean));
                if (parts.length) L.push(`- ${wr.path}（${parts.join('；')}）`);
            }
            if ((group.reminders || []).length) {
                L.push('强制更新提醒（按各项触发条件执行）：');
                (group.reminders || []).forEach(r => L.push(`- ${r}`));
            }
            if (L.length === rulesStart + 1) L.pop();
        }
        if (allReadonly && group.kind !== 'json') {
            L.push('本表全部字段均为脚本/系统维护的只读状态：AI 无需填表，仅供读取。');
        }
        if (group.kind !== 'json' && aiCols.length) {
            // 通用约束：以正文和规则为共同依据——既防虚构数据，也不与
            // “每次回复必须更新/replace 整个对象”这类每轮强制规则冲突。
            L.push('更新以正文和规则为依据，不得为凑表而虚构数据。');
        }
        const jsonGuide = jsonUpdateGuide(group, mode);
        if (jsonGuide) L.push(jsonGuide);
        return L.join('\n');
    }

    function buildInitNode(group) {
        if (group.scalarType === 'number') {
            if (/^[_$]/.test(String(group.name || ''))) return '开局已初始化唯一数值记录（row_id=1）；不得再次初始化或新增/删除行，后续由脚本/前端维护，自动填表阶段不修改本表。';
            return '开局已初始化唯一数值记录（row_id=1）；不得再次初始化或新增/删除行，后续根据正文、设定与 note 按需更新。';
        }
        if (group.kind === 'json') {
            return ((group.wildcardRules || []).length || (group.groupChecks || []).length)
                ? `开局模板已初始化整组数据（row_id=1）；自动填表阶段仅按 note 中「可写路径与约束」更新「内容」列，其余由脚本/前端维护。`
                : `开局模板已初始化整组数据（row_id=1）；此后整组 JSON 由脚本/前端写入，自动填表阶段禁止修改本表。`;
        }
        if (group.kind === 'singleton') {
            const aiCols = (group.columns || []).filter(c => isAiPromptColumn(group, c));
            return aiCols.length
                ? `开局模板已初始化唯一记录（row_id=1）；自动填表阶段禁止再次初始化，只允许按需 UPDATE。`
                : `开局模板已初始化唯一记录（row_id=1）；全部字段由脚本/系统维护，自动填表阶段不修改本表。`;
        }
        if (group.kind === 'array' || group.kind === 'pathArray' || group.kind === 'nestedArray') {
            return group.rows.length
                ? `开局模板已初始化 ${group.rows.length} 个元素；此后按剧情和规则新增、移除或更新对应元素。`
                : '开局为空表；出现符合本表定义的新元素时，新增一行完整记录。';
        }
        if (group.rows.length) {
            // 不写死具体记录名：多开场白按分支注入初始值（applyActiveGreetingInitvar），
            // 实际初始记录随所选分支变化，把首个分支的名字写进提示词会在切分支后误导 AI。
            return `开局模板已初始化 ${group.rows.length} 条记录；出现符合本表定义且尚不存在的新记录时，新增一行完整记录。`;
        }
        return '开局为空表；出现符合本表定义的新记录时，新增一行完整记录。';
    }

    // INSERT 延续初始行值 → 默认值的策略；没有值时按列约束选择有效的
    // 类型示例，不把字段名占位符写进枚举/数值/JSON。标识和业务值均需按本轮替换。
    function exampleCellValue(col, rowValue) {
        const value = rowValue === undefined ? col.value : rowValue;
        const quote = v => `'${sqlQuote(v)}'`;
        if (['jsonScalarOptional', 'jsonPairOptional'].includes(col.logicalType)) {
            return quote(value === undefined ? '' : JSON.stringify(value));
        }
        if (col.logicalType === 'jsonObjectOptional') {
            return quote(value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value));
        }
        if (col.logicalType === 'jsonScalar') {
            try { JSON.parse(value); return quote(value); } catch (_) { return quote('null'); }
        }
        if (col.isObject) {
            if (value !== undefined && value !== null && value !== '') return quote(typeof value === 'string' ? value : JSON.stringify(value));
            return quote(JSON.stringify(col.objectSchema ? schemaExample(col.objectSchema) : col.jsonKind === 'array' ? [] : {}));
        }
        if (col.logicalType === 'boolean' || typeof value === 'boolean') return value === true || value === 1 || value === 'true' || value === '1' ? '1' : '0';
        if (value !== undefined && value !== null && value !== '') {
            return typeof value === 'number' ? String(value) : quote(value);
        }
        if (col.enum && col.enum.length) {
            const selected = col.enum[0];
            return typeof selected === 'number' ? String(selected) : quote(selected);
        }
        if (col.type === 'INTEGER' || col.type === 'REAL') return String(col.range ? col.range[0] : 0);
        return quote(`${col.zh || '字段'}示例`);
    }

    // 示例只演示语法，不定义业务变化。选择符合已知类型/范围/枚举的值，
    // 不把通用“新值”写进数字、布尔或 JSON 编码列。
    function exampleScalarValue(col, current) {
        const allowed = value => (!col.range || (typeof value === 'number' && value >= col.range[0] && value <= col.range[1]));
        if (Array.isArray(col.enum) && col.enum.length) {
            const values = col.enum.filter(v => (v === null || ['string', 'number', 'boolean'].includes(typeof v)) && allowed(v));
            const different = values.find(v => v !== current);
            return different !== undefined ? different : values.length ? values[0] : current;
        }
        if (col.logicalType === 'boolean' || typeof current === 'boolean') return !current;
        if (col.range || col.logicalType === 'number' || col.type === 'INTEGER' || col.type === 'REAL' || typeof current === 'number') {
            const number = Number(current);
            const candidates = [number + 1, number - 1, ...(col.range || []), 1, 0];
            return candidates.find(v => Number.isFinite(v) && allowed(v) && v !== current)
                ?? candidates.find(v => Number.isFinite(v) && allowed(v)) ?? current;
        }
        if (current === null || current === undefined) {
            // 可空列没有非空类型证据时，不猜测原作者希望数字还是文本。
            if (['jsonScalarOptional', 'jsonPairOptional', 'jsonScalar'].includes(col.logicalType)) return null;
        }
        return '新值';
    }

    function exampleUpdateValue(col, group) {
        const index = group ? group.columns.indexOf(col) + 1 : 0;
        const raw = [...(group && group.rows || []).map(row => row[index]), col.value];
        const candidates = col.logicalType === 'jsonScalar'
            ? raw.map(value => { try { return JSON.parse(value); } catch (_) { return undefined; } }) : raw;
        let current = candidates.find(value => value !== null && value !== undefined && value !== '');
        if (current === undefined) current = candidates.find(value => value !== undefined);
        if (current === undefined) current = col.value;
        // jsonScalar 也能承载数组/对象元素，不用字符串示例替换它们。
        if (col.logicalType === 'jsonScalar' && current && typeof current === 'object') return null;
        const value = exampleScalarValue(col, current);
        if (['jsonScalar', 'jsonScalarOptional', 'jsonPairOptional'].includes(col.logicalType)) return `'${sqlQuote(JSON.stringify(value))}'`;
        if (typeof value === 'boolean') return value ? '1' : '0';
        return typeof value === 'number' && Number.isFinite(value) ? String(value) : `'${sqlQuote(value)}'`;
    }

    // SQL 专用模板的示例从实际 JSON 单元格选一条已有公开路径，避免教模型
    // 用残缺对象覆盖整格。整组 JSON 的可写范围另由规则决定，不猜示例路径。
    function exampleUpdateAssignment(group, col) {
        if (!aiJsonColumns(group).includes(col) || group.kind === 'json') {
            const value = exampleUpdateValue(col, group);
            return value === null ? null : `${col.ident} = ${value}`;
        }
        const index = group.columns.indexOf(col) + 1;
        const values = [...(group.rows || []).map(row => row[index]), col.value];
        const findLeaf = (value, path, depth = 0) => {
            if (depth > 12) return null;
            if (value === null || typeof value !== 'object') return path === '$' ? null : { path, value };
            for (const key of Object.keys(value)) {
                // 引号/反斜线等键的 SQLite 路径兼容性因引擎版本而异，示例不猜转义。
                if (/^[_$]|["\\\x00-\x1f]/.test(key)) continue;
                const next = Array.isArray(value) ? `${path}[${key}]` : `${path}."${key}"`;
                const leaf = findLeaf(value[key], next, depth + 1);
                if (leaf) return leaf;
            }
            return null;
        };
        for (const cell of values) {
            let value;
            try { value = typeof cell === 'string' ? JSON.parse(cell) : cell; } catch (_) { continue; }
            if (!value || typeof value !== 'object') continue;
            const leaf = findLeaf(value, '$');
            if (!leaf) continue;
            const newValue = typeof leaf.value === 'string' ? "'新值'"
                : typeof leaf.value === 'number' && Number.isFinite(leaf.value) ? String(leaf.value)
                    : `json('${leaf.value === null ? 'null' : JSON.stringify(leaf.value)}')`;
            return `${col.ident} = json_replace(${col.ident}, '${sqlQuote(leaf.path)}', ${newValue})`;
        }
        // 缺失、null、空对象或仅含私有字段时没有可证明的局部路径，不编造键。
        return null;
    }

    // 仅改写能完整识别的 MVU 机制语句。业务中的“指令”、英文名称、路径或
    // 括号条件不能作为删除依据；无法确定时保留原文，不以清洁/精简牺牲含义。
    function sanitizeCheckRule(line, context) {
        let s = String(line || '').trim();
        if (!s) return s;
        const ctx = context || {};
        const col = ctx.column || null;
        const jsonArray = !!(ctx.jsonContainer || (col && col.isObject && col.jsonKind === 'array'));
        const containerOnly = /^(?:【[^】]*(?:警告|防崩|注意)[^】]*】\s*)?(?:更新时必须精确到子字段(?:（如[^（）]*）|\(如[^()]*\))?\s*[，,]\s*)?(?:严禁|不要|避免|请勿|勿)(?:直接)?对整个(?:对象|数组)使用\s*["'“”]?(?:replace|delta)["'“”]?(?:\s*(?:或|和|\/)\s*["'“”]?(?:replace|delta)["'“”]?)?\s*[。！!]?$/i;
        if (containerOnly.test(s)) return '更新时只修改发生变化的字段或元素，保留其他内容。';

        // 先把 JSON Patch 的“怎么发指令”还原为业务/存储语义。不能机械地把
        // add/remove 替换成 INSERT/DELETE：JSON 数组列在两种数据库模式下都仍是
        // 一个单元格，增删元素应修改列内内容，而不是增删表格行。
        if (jsonArray) {
            s = s.replace(/更改(.+?)内容时[，,]?\s*(?:必须)?(?:使用|用|采用)\s*["'“”]?replace["'“”]?\s*(?:操作|指令)?将整个数组重新输出更新/gi,
                '更改$1内容时，更新目标元素并保留未改动的元素');
            s = s.replace(/清除(.+?)时[，,]?\s*(?:必须)?(?:使用|用|采用)\s*["'“”]?remove["'“”]?\s*(?:操作|指令)?并指定精确索引((?:（[^）]*）|\([^)]*\))?)[。；;]?\s*需先读取数组内容确认索引[，,]?避免误删[。]?/gi,
                (_, target, condition) => `移除${target}中的记录前${condition || ''}，必须先读取现有数组并确认目标元素；移除后保留其他记录，避免误删`);
        }
        // 动态对象在 MVU 中修改一个 value 时，部分规则会要求
        // remove 旧键 + insert 新键；拆成数据库行后可直接更新该记录的值。
        // 只改写完整的结构化措辞，避免误伤普通英文说明中的同名单词。
        s = s.replace(/通过\s*remove\s*旧键\s*\+\s*insert\s*新键\s*修改对应([^，,。；;]+?)的\s*value\s*描述/gi,
            '直接更新对应$1记录的描述');
        const opVerb = { add: '新增对应内容', replace: '更新对应内容', remove: '移除对应内容' };
        s = s.replace(/(?:使用|用|采用)\s*["'“”]?(add|replace|remove)["'“”]?\s*(?:操作|指令)/gi,
            (m, op) => opVerb[String(op).toLowerCase()] || '执行对应变更');
        s = s.replace(/(?:并)?指定精确索引/gi, '并准确定位目标元素');
        // 只转换整个括号都是 op/value 标量参数的情形；参数里的数值也是
        // 更新规则的一部分，不能因为去掉旧语法而丢掉增量、重置值或例外条件。
        s = s.replace(/（([^（）]*)）|\(([^()]*)\)/g, (whole, chinese, english) => {
            const body = chinese === undefined ? english : chinese;
            const op = body.trim().match(/^op\s*[:：]\s*(delta|replace)\s*[,，]\s*value\s*[:：]\s*(.+)$/i);
            if (op) {
                try {
                    const value = JSON.parse(op[2]);
                    const numeric = typeof value === 'number' && Number.isFinite(value);
                    const representable = op[1].toLowerCase() === 'delta' ? numeric : numeric || value === null || ['boolean', 'string'].includes(typeof value);
                    if (representable) {
                        const meaning = op[1].toLowerCase() === 'delta' ? '增量' : '新值';
                        return `（${meaning}：${JSON.stringify(value)}）`;
                    }
                } catch (_) { /* 混合业务、表达式或不完整参数均保留，不猜测。 */ }
            }
            if (/^(?:勿用|不要使用)\s*delta\s*导致超限[。！!]?$/i.test(body.trim())) return '（增量更新不得导致超限）';
            return whole;
        });
        // 3) “必须分N条指令更新：一条replaceA，另一条replaceB” → 保留前半句 + “A；B”
        const dm = s.match(/([\s\S]*?)分\s*(?:\d+|[一二三四五六七八九十两])\s*条指令更新[：:]\s*一条(?:replace\s*)?([^，,。]+?)，另一条(?:replace\s*)?([^，,。]+?)(（[^）]*）|\([^)]*\))?\s*$/);
        if (dm) {
            const prefix = String(dm[1] || '').trim().replace(/[，,。;；\s]+$/, '').replace(/必须$/, '');
            const a = String(dm[2]).trim();
            const b = String(dm[3]).trim();
            s = (prefix ? prefix + '，' : '') + '必须同时完成：' + a + '；' + b + (dm[4] || '');
        }
        return s.trim();
    }

    function buildNodeProse(group, kind) {
        if (group.scalarType === 'number') {
            if (kind !== 'update') return '禁止。';
            if (/^[_$]/.test(String(group.name || ''))) return '本数值由脚本/前端维护，AI 不应直接修改。';
            const col = group.columns[0];
            const hasRules = (group.groupChecks || []).length || (group.wildcardRules || []).length;
            const basis = hasRules ? '根据 note 中的更新规则' : '根据正文、设定与本表规则';
            return `${basis}修改数值，只允许 UPDATE，禁止 INSERT / DELETE。\nSQL示例: UPDATE ${group.ident} SET ${exampleUpdateAssignment(group, col)} WHERE row_id=1;`;
        }
        if (group.kind === 'json') {
            if (kind === 'update') {
                if ((group.wildcardRules || []).length || (group.groupChecks || []).length) {
                    return '只允许 UPDATE（整组 JSON 固定 row_id=1，禁止 INSERT / DELETE）；正文明确造成字段变化时，按 note 中【可写路径与约束】维护允许的路径（未列出字段一律只读），保留其余字段。';
                }
                return '整组 JSON 由脚本/前端整体写入，AI 不应直接修改本表。';
            }
            return '禁止。';
        }
        if (group.kind === 'singleton') {
            if (kind === 'update') {
                // 用首个可写业务列给出具体示例（有初始值用真实值，否则“列名示例”）；
                // 全只读单例（全部为 _ 字段）不生成可执行的 UPDATE 示例，避免教 AI 写只读字段
                const col = (group.columns || []).find(c => isAiPromptColumn(group, c));
                if (!col) return '本表全部字段均为脚本/系统维护的只读状态，AI 不应修改本表。';
                const assignment = exampleUpdateAssignment(group, col);
                return '只允许 UPDATE（单例固定 row_id=1，禁止 INSERT / DELETE）；根据正文、设定与本表规则，已有字段的值发生变化时更新。'
                    + (assignment ? `\nSQL示例: UPDATE ${group.ident} SET ${assignment} WHERE row_id=1;` : ' JSON 操作遵循 note，仅在规则要求时初始化容器。');
            }
            return '禁止。';
        }
        if (group.kind === 'array' || group.kind === 'pathArray' || group.kind === 'nestedArray') {
            const col = (group.columns || []).find(c => c.zh === '内容') || group.columns[0];
            const ancestors = group.kind === 'nestedArray'
                ? (group.ancestorKeyCols && group.ancestorKeyCols.length ? group.ancestorKeyCols
                    : [{ col: group.parentKeyCol, parentTable: group.parentTable }]) : [];
            const parents = ancestors.map(a => group.columns.find(c => c.zh === a.col)).filter(Boolean);
            const parentValues = parents.map(c => {
                const index = group.columns.indexOf(c) + 1;
                const value = group.rows && group.rows[0] && group.rows[0][index];
                return `'${sqlQuote(value === undefined ? '所属记录标识' : value)}'`;
            });
            const where = [...parents.map((c, i) => `${c.ident} = ${parentValues[i]}`), 'row_id = 1'].join(' AND ');
            const value = exampleUpdateValue(col, group);
            if (kind === 'update') {
                return '根据正文、设定与本表规则，已有数组元素的内容发生变化时更新该行。'
                    + (value === null ? ' 按 note 的编码规则提供完整的新元素，保留其他行。'
                        : `\nSQL示例: UPDATE ${group.ident} SET ${col.ident} = ${value} WHERE ${where};`);
            }
            if (kind === 'insert') {
                const association = parents.length
                    ? ` 必须填写所有关联字段${parents.map(c => `「${c.zh}」`).join('、')}，取值对应 note 列出的来源记录。` : '';
                return '根据正文、设定与本表规则，数组出现本表尚未记录的新元素时添加（行号自动分配，行序即数组顺序）。' + association
                    + (value === null ? ' 按 note 的编码规则填写完整的新元素。'
                        : `\nSQL示例: INSERT INTO ${group.ident} (${[...parents, col].map(c => c.ident).join(', ')}) VALUES (${[...parentValues, value].join(', ')});`);
            }
            return `根据正文、设定与本表规则，已有数组元素不再属于当前数组时删除对应行。\nSQL示例: DELETE FROM ${group.ident} WHERE ${where};`;
        }
        if (group.kind === 'nestedRows') {
            const ancestorDefs = (group.ancestorKeyCols && group.ancestorKeyCols.length)
                ? group.ancestorKeyCols : [{ col: group.parentKeyCol, entity: group.relationEntity, parentTable: group.parentTable, parentKeyCol: group.keyCol }];
            const parents = ancestorDefs.map(a => group.columns.find(c => c.zh === a.col)).filter(Boolean);
            const key = group.columns.find(c => c.zh === group.keyCol) || group.columns[1];
            const ancestorNames = new Set(ancestorDefs.map(a => a.col));
            const valueCols = group.columns.filter(c => !ancestorNames.has(c.zh) && c.zh !== group.keyCol && isAiPromptColumn(group, c));
            const value = valueCols[0];
            const entity = group.relationEntity || String(group.parentKeyCol || '').replace(/_键名$/, '') || '关联';
            const whereParts = parents.map((p, i) => `${p.ident} = '${ancestorDefs[i].entity || String(ancestorDefs[i].col).replace(/_键名$/, '')}键名'`);
            whereParts.push(`${key.ident} = '键名'`);
            const where = whereParts.join(' AND ');
            const keyNames = [...ancestorDefs.map(a => `「${a.col}」`), `「${group.keyCol}」`].join('、');
            if (kind === 'update') {
                if (!value) return '本表无 AI 可更新的业务列。';
                const assignment = exampleUpdateAssignment(group, value);
                return `根据正文、设定与本表规则，对应${entity}记录中已有${group.childKey || group.name}数据的字段值发生变化时更新；WHERE 必须同时带${keyNames}。`
                    + (assignment ? `\nSQL示例: UPDATE ${group.ident} SET ${assignment} WHERE ${where};` : ' JSON 操作遵循 note，仅在规则要求时初始化容器。');
            }
            if (kind === 'insert') {
                const cols = [...parents, key, ...valueCols];
                const vals = [
                    ...parents.map((p, i) => `'${ancestorDefs[i].entity || String(ancestorDefs[i].col).replace(/_键名$/, '')}键名'`),
                    "'键名'", ...valueCols.map(c => exampleCellValue(c, c.value) || "'值'"),
                ];
                return `根据正文、设定与本表规则，对应${entity}记录中出现本表尚未记录的新${group.childKey || group.name}时添加；必须填写所有定位字段 ${keyNames}。\nSQL示例: INSERT INTO ${group.ident} (${cols.map(c => c.ident).join(', ')}) VALUES (${vals.join(', ')});`;
            }
            return `根据正文、设定与本表规则，对应${entity}记录中已有${group.childKey || group.name}不再属于其「${group.childKey || group.name}」数据时删除；WHERE 必须同时带${keyNames}。\nSQL示例: DELETE FROM ${group.ident} WHERE ${where};`;
        }
        const keyIdent = group.columns[0] ? group.columns[0].ident : 'key';
        // 示例优先取卡内真实初始数据；没有初始值则用 DDL 默认值；TEXT 无默认值才退回“列名示例”
        const sampleRow = group.rows && group.rows[0] ? group.rows[0] : null;
        const sampleValue = (idx, fallback) => {
            const col = group.columns[idx - 1];
            const rowV = sampleRow ? sampleRow[idx] : undefined;
            const v = exampleCellValue(col, rowV);
            return v !== '' ? v : fallback;
        };
        const keyValue = (sampleRow && sampleRow[1] !== undefined && String(sampleRow[1]) !== '')
            ? `'${sqlQuote(sampleRow[1])}'`
            : "'键名'";
        // 示例列排除内部溢出列（_扩展数据）与下划线只读字段：AI 不应直接修改
        const exampleCols = group.columns.filter(c => isAiPromptColumn(group, c));
        const allIdents = exampleCols.map(c => c.ident);
        if (kind === 'update') {
            const updCol = exampleCols.find(c => !isRelationshipKeyColumn(group, c));
            if (!updCol) return '本表无 AI 可更新的业务列。';
            const assignment = exampleUpdateAssignment(group, updCol);
            return '根据正文、设定与本表规则，已有记录的字段值发生变化时更新。'
                + (assignment ? `\nSQL示例: UPDATE ${group.ident} SET ${assignment} WHERE ${keyIdent} = ${keyValue};` : ' JSON 操作遵循 note，仅在规则要求时初始化容器。');
        }
        if (kind === 'insert') {
            // 完整列示例：全部列都列出，列数与 VALUES 一一对应；
            // 不写 row_id——新版数据库（SQLite 模式）内置自增，省略即可，AI 无需手算。
            const cols = allIdents;
            const vals = exampleCols.map((c, i) => {
                if (i === 0) return keyValue;
                const colIdx = group.columns.indexOf(c);
                return sampleValue(colIdx + 1, `'值${i}'`);
            });
            return `根据正文、设定与本表规则，出现本表尚未记录的新${group.keyCol}时添加完整记录。\nSQL示例: INSERT INTO ${group.ident} (${cols.join(', ')}) VALUES (${vals.join(', ')});`;
        }
        return `根据正文、设定与本表规则，已有记录所对应的对象不再属于本表记录范围时删除。\nSQL示例: DELETE FROM ${group.ident} WHERE ${keyIdent} = ${keyValue};`;
    }

    return { buildNote, buildInitNode, buildNodeProse };
}

module.exports = createTablePrompts;
