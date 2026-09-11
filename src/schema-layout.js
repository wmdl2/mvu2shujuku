'use strict';

// 结构推导与布局生成；解析库、命名及词法服务由调用方注入。
function createSchemaLayout(dependencies) {
    const { getMvuYamlLibs, splitJsTopLevelArgs, parseInitVar, analyzeMvuInitMetadata, isPlainObject, toIdent, pinyinOf } = dependencies;
    function leafInfo(v) {
            if (Array.isArray(v)) {
                return { value: v.length > 0 ? v[0] : '', desc: v.length > 1 ? String(v[1]) : '' };
            }
            return { value: v, desc: '' };
        }
    
    const STATUS_SOURCE_NAMES = ['状态栏', 'status', '数据桥', '面板'];
    
    function maskYamlBlockScalarBodies(text) {
            const lines = String(text || '').split('\n');
            let blockIndent = -1;
            const out = lines.map((line) => {
                if (blockIndent !== -1) {
                    const m = line.match(/^ */);
                    if (m && m[0].length > blockIndent) return line.replace(/[^\n]/g, ' ');
                    blockIndent = -1;
                }
                const km = line.match(/^([ \t]*)(?:type|format|check|enum|range)\s*:\s*[|>]-?\s*$/);
                if (km) blockIndent = km[1].length;
                return line;
            });
            return out.join('\n');
        }
    
    function yamlStripQuotes(s) {
            let t = String(s == null ? '' : s).trim();
            if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) t = t.slice(1, -1).trim();
            return t;
        }
    
    function parseInlineEnumValues(value) {
            const sv = String(value == null ? '' : value).trim();
            if (!sv || sv.indexOf('\n') !== -1 || sv.length > 60 || !/[/|]/.test(sv)) return null;
            // EJS/TavernHelper 在运行时渲染的 YAML 值不是静态类型声明。例如
            // `阶段: <%- lilyData.阶段 || '未唤醒' %>` 中的 `||` 过去会被当成
            // 联合枚举分隔符，最后把本地 JS 变量名写进表格 note，填表时再次
            // 交给 st-prompt-template 执行就会 ReferenceError。所有动态模板标量
            // 都只属于原世界书的渲染阶段，不参与 DDL/提示词结构推导。
            if (/<%[\s\S]*?%>|\{\{[\s\S]*?\}\}/.test(sv)) return null;
            // 分号/括号是类型或结构声明的强信号；裸 string/number 等即使没写分号也不是枚举值。
            if (/[;{}\[\]]/.test(sv)) return null;
            const vals = yamlStripQuotes(sv).split(/[/|]/).map(yamlStripQuotes).filter(Boolean);
            if (vals.length < 2 || vals.length > 12) return null;
            if (vals.some(v => /^(?:string|number|boolean|object|unknown|any|never|void|null|undefined)$/i.test(v))) return null;
            return vals;
        }
    
    function yamlCheckItems(v) {
            const list = Array.isArray(v) ? v : (v === undefined || v === null ? [] : [v]);
            return list.map(x => {
                // check 项里含 “冒号+空格”（如 减1（op: delta, value: -1））时，YAML 会把整项
                // 解析成嵌套映射（plain scalar 规则）。递归还原成原始文本，保持字符串语义。
                if (x && typeof x === 'object' && !Array.isArray(x)) {
                    const lines = [];
                    const rec = (o, prefix) => {
                        for (const k of Object.keys(o)) {
                            const kv = o[k];
                            const p = prefix ? prefix + ': ' + k : k;
                            if (kv && typeof kv === 'object' && !Array.isArray(kv)) rec(kv, p);
                            else if (Array.isArray(kv)) lines.push(p + ': ' + kv.map(yamlStripQuotes).join(', '));
                            else lines.push(p + (kv === undefined || kv === null ? '' : ': ' + yamlStripQuotes(kv)));
                        }
                    };
                    rec(x, '');
                    return lines.join('，');
                }
                return yamlStripQuotes(x);
            }).filter(Boolean);
        }
    
    function yamlExpandTemplateKeys(s) {
            return String(s).replace(/\$\{([^}]+)\}/g, (m, inner) => (
                inner.includes('|') ? inner.split('|').map(p => p.trim()).filter(Boolean).join('/') : m
            ));
        }
    
    function expandYamlTemplateFieldKey(key, limit = 64) {
            const source = String(key == null ? '' : key).trim();
            if (!source.includes('${')) return null;
            const tokenRe = /\$\{([^{}]+)\}/g;
            const tokens = [];
            let last = 0;
            let m;
            while ((m = tokenRe.exec(source))) {
                tokens.push(source.slice(last, m.index));
                const choices = m[1].split(/[|/]/).map(x => x.trim()).filter(Boolean);
                if (choices.length < 2 || choices.some(x => !/^[\u4e00-\u9fffA-Za-z_$][\u4e00-\u9fffA-Za-z0-9_$-]{0,31}$/.test(x))) return null;
                tokens.push(choices);
                last = m.index + m[0].length;
            }
            if (!tokens.some(Array.isArray) || source.slice(last).includes('${')) return null;
            tokens.push(source.slice(last));
            let out = [''];
            for (const token of tokens) {
                const choices = Array.isArray(token) ? token : [token];
                if (out.length * choices.length > limit) return null;
                out = out.flatMap(prefix => choices.map(choice => prefix + choice));
            }
            return [...new Set(out.filter(x => /^[\u4e00-\u9fffA-Za-z_$][\u4e00-\u9fffA-Za-z0-9_$-]{0,63}$/.test(x)))];
        }
    
    function protectYamlTemplateScalarValues(content) {
            return String(content || '').replace(
                /(^[ \t]*[^\n:#][^\n:]*:[ \t]*)(\{\{[^\n]*\}\}|<%[^\n]*%>)[ \t]*$/gm,
                (_m, prefix, macro) => prefix + JSON.stringify(macro)
            );
        }
    
    function yamlCollectCheckRanges(allCheckItems, ranges, numericFields) {
            for (const line of allCheckItems) {
                const rm = String(line || '').match(/([\u4e00-\u9fff]{1,8})\((\d+)~(\d+)\)/);
                if (rm && !ranges[rm[1]]) {
                    ranges[rm[1]] = [Number(rm[2]), Number(rm[3])];
                    numericFields.add(rm[1]);
                }
            }
        }
    
    function collectRulesFromYaml(content, acc) {
            try {
                const libs = getMvuYamlLibs();
                const doc = libs.YAML.parseDocument(protectYamlTemplateScalarValues(content), { merge: true });
                // 作者自由发挥常产生非法 YAML（如 format: '稀薄'|'普通'|'浓郁'|'极浓' 的裸 |），
                // parseDocument 不抛错但会在 errors 里记录，toJS() 返回残缺树——用残缺树会
                // 丢整组规则。只要有 error 就回退正则（正则对这类怪癖更宽容）。
                if (doc.errors && doc.errors.length) return false;
                const v = doc.toJS();
                if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
                let rules = null;
                const wrapper = ['变量更新规则', 'variables_update_rules'].find(k => v[k] && typeof v[k] === 'object' && !Array.isArray(v[k]));
                if (wrapper) {
                    rules = v[wrapper];
                } else if (Object.keys(v).some(k => /^[\u4e00-\u9fff$]{1,12}$/.test(k) && v[k] && typeof v[k] === 'object' && !Array.isArray(v[k]))) {
                    rules = v; // 没有 变量更新规则 壳，直接是顶层组
                }
                if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return false;
    
                // pathArr：从顶层组名往下拼的变量树路径（组.容器…字段）。规则分组与
                // initvar 结构不一致（如规则把 修为 写在根目录、initvar 在 主角.修为）
                // 时，靠完整路径才能在转换时把 check/range/format 附着到正确的列/表。
                const walkGroup = (group, node, pathArr) => {
                    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
                    // 组级 type 声明（道渊式：道侣: type: "{ [角色名]: {...} }"）：
                    // 顶层组按条目行表转换（dynamicGroups），字段进 shapes/objects。
                    if (node.type !== undefined) {
                        const gts = String(node.type).trim();
                        if (/[\[{]/.test(gts)) {
                            const gparsed = parseShapeString(gts);
                            if (gparsed) {
                                acc.shapes[group] = acc.shapes[group] || [];
                                const gFields = (gparsed.topFields && gparsed.topFields.length) ? gparsed.topFields : gparsed.fields;
                                for (const f2 of gFields) if (!acc.shapes[group].includes(f2)) acc.shapes[group].push(f2);
                                const groupObjects = (gparsed.topObjects && gparsed.topObjects.length) ? gparsed.topObjects : gparsed.objects;
                                if (groupObjects.length) {
                                    acc.objects[group] = acc.objects[group] || {};
                                    for (const obj of groupObjects) acc.objects[group][obj] = true;
                                }
                                mergeShapeMetadata(group, gparsed, acc.fieldTypes, acc.objectSchemas, acc.enumPaths, pathArr);
                                if (gparsed.dynamicTop) acc.dynamicGroups.add(group);
                            }
                        }
                    }
                    // 组级 check（整表规则）：组节点直接带 check（YAML 里等价于 4 空格 check:）
                    if (node.check !== undefined) {
                        const items = yamlCheckItems(node.check);
                        acc.allCheckItems.push(...items);
                        if (items.length) acc.groupChecks[group] = [...new Set([...(acc.groupChecks[group] || []), ...items])];
                    }
                    // MVU 规则卡也会用 note 表达整个组的补充规则（常内嵌
                    // {{getvar::...}}）。它与组级 check 同属表级约束，不应当成字段。
                    if (node.note !== undefined) {
                        const items = yamlCheckItems(node.note);
                        acc.allCheckItems.push(...items);
                        if (items.length) acc.groupChecks[group] = [...new Set([...(acc.groupChecks[group] || []), ...items])];
                    }
                    for (const key of Object.keys(node)) {
                        if (key === 'check' || key === 'note' || key === 'type' || key === 'format' || key === 'range' || key === 'enum') continue;
                        const val = node[key];
                        // _强制更新提醒
                        if (/^_?强制更新/.test(key)) {
                            const items = yamlCheckItems(Array.isArray(val) ? val : (typeof val === 'string' ? val.split('\n') : [val])).map(yamlExpandTemplateKeys);
                            if (items.length) {
                                acc.reminders[group] = acc.reminders[group] || [];
                                acc.reminders[group].push(...items);
                            }
                            continue;
                        }
                        // 通配/点路径（户.<门牌>.妻.好感值、人物.角色名.亲密）
                        if (isMvuRulePathKey(key)) {
                            registerYamlWildcard(key, val, acc, group);
                            continue;
                        }
                        // MVU 模板键：官方规则常用 ${A|B}，部分卡用等价的 ${A/B}。
                        // YAML 能正确读出这种键，但它不满足普通中文字段名校验；旧逻辑会
                        // 整个跳过，连同其 type/check 一起丢失。这里按声明值展开为实际逻辑
                        // 路径，后续仍由 initvar/完整路径决定落在哪张表，不按业务词猜测。
                        const expandedTemplateKeys = expandYamlTemplateFieldKey(key);
                        if (expandedTemplateKeys && expandedTemplateKeys.length) {
                            const expandedKeys = expandedTemplateKeys;
                            for (const actualKey of [...new Set(expandedKeys)]) {
                                if (typeof val === 'string') {
                                    const vals = parseInlineEnumValues(val);
                                    if (vals) acc.enums[actualKey] = vals;
                                } else if (val && typeof val === 'object' && !Array.isArray(val)) {
                                    const isDef = ['type', 'check', 'format', 'range', 'enum'].some(k => Object.prototype.hasOwnProperty.call(val, k));
                                    if (isDef) registerYamlField(group, actualKey, val, acc, [...(pathArr || [group]), actualKey]);
                                    else walkGroup(group, val, [...(pathArr || [group]), actualKey]);
                                }
                            }
                            continue;
                        }
                        if (!/^[\u4e00-\u9fff$]{1,12}$/.test(key)) continue; // rule/format 等 ASCII 键跳过
                        if (typeof val === 'string') {
                            // 叶子字段的行内值：枚举 a/b/c。块标量/长文本（如 [mvu_plot]
                            // 战斗系统.说明: |- 一整段战斗判定）不是行内枚举——按 /| 切开会
                            // 把长文切碎成伪枚举，塞进列 CHECK 导致 DDL 校验失败。
                            const vals = parseInlineEnumValues(val);
                            if (vals) acc.enums[key] = vals;
                            continue;
                        }
                        if (val && typeof val === 'object' && !Array.isArray(val)) {
                            const isDef = ['type', 'check', 'format', 'range', 'enum'].some(k => Object.prototype.hasOwnProperty.call(val, k));
                            if (isDef) {
                                registerYamlField(group, key, val, acc, [...(pathArr || [group]), key]);
                            } else {
                                walkGroup(group, val, [...(pathArr || [group]), key]); // 容器（修为:{进度百分比:{…}}）→ 拍平递归
                            }
                        }
                    }
                };
                for (const group of Object.keys(rules)) {
                    // 顶层 _强制更新提醒：按 “组.字段” 前缀归属组（正则同款语义）
                    if (/^_?强制更新/.test(group)) {
                        const items = yamlCheckItems(Array.isArray(rules[group]) ? rules[group] : [rules[group]]).map(yamlExpandTemplateKeys);
                        for (const it of items) {
                            const m = String(it).match(/^([\u4e00-\u9fff$]{1,12})\./);
                            const g0 = m ? m[1] : group.replace(/^_?/, '');
                            acc.reminders[g0] = acc.reminders[g0] || [];
                            acc.reminders[g0].push(it);
                        }
                        continue;
                    }
                    // 顶层通配路径（变量更新规则 下直接写 户.<门牌>.妻.好感值:）
                    if (isMvuRulePathKey(group)) {
                        registerYamlWildcard(group, rules[group], acc);
                        continue;
                    }
                    if (!/^[\u4e00-\u9fff$]{1,12}$/.test(group)) continue;
                    walkGroup(group, rules[group], [group]);
                }
                return true;
            } catch (e) {
                return false; // YAML 失败 → 回退正则
            }
        }
    
    function yamlParseRange(v) {
            if (Array.isArray(v) && v.length >= 2) {
                const out = [Number(v[0]), Number(v[1])];
                return out.every(Number.isFinite) ? out : null;
            }
            const text = String(v);
            const num = '-?(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
            // 优先处理无歧义的 ~ / ～ / 至；再兼容 0-100 式旧写法。
            // 数值本身必须允许负号，否则 -1000~1000 会被误读为 1000~1000。
            let m = text.match(new RegExp(`(${num})\\s*(?:~|～|至)\\s*(${num})`));
            if (!m) m = text.match(new RegExp(`(${num})\\s*-\\s*(${num})`));
            if (!m) return null;
            const out = [Number(m[1]), Number(m[2])];
            return out.every(Number.isFinite) ? out : null;
        }
    
    function isMvuRulePathKey(key) {
            const parts = String(key == null ? '' : key).trim().split('.');
            if (parts.length < 2) return false;
            return parts.every(part => {
                const p = part.trim();
                return /^[\u4e00-\u9fffA-Za-z_$][\u4e00-\u9fffA-Za-z0-9_$]*$/.test(p) ||
                    /^<[^<>.\s]+>$/.test(p) || /^\$\{[^{}.\n]+\}$/.test(p) || p === '*';
            });
        }
    
    function registerYamlWildcard(key, val, acc, enclosingGroup) {
            acc.wildcardFields.add(key);
            const group0 = String(key).split('.')[0].trim();
            const rec = { path: key };
            if (val && typeof val === 'object' && !Array.isArray(val)) {
                if (val.type !== undefined) {
                    rec.type = String(val.type).trim();
                    registerWildcardTypeShape(key, val.type, acc, enclosingGroup);
                }
                if (val.range !== undefined) {
                    const r = yamlParseRange(val.range);
                    if (r) rec.range = r;
                }
                if (val.check !== undefined) rec.checks = yamlCheckItems(val.check);
                if (val.format !== undefined) {
                    const fv = String(val.format);
                    rec.format = fv.indexOf('\n') !== -1 ? fv.replace(/\s+/g, ' ').trim() : fv.trim();
                }
            }
            // ${角色}.xxx 这类模板键首段也属于某个动态行表组（角色），
            // 规则要挂到该组而不是丢弃，便于后续把静态通配字段提升为列。
            const templateKeyMatch = /^\$\{([^}]+)\}$/.exec(group0);
            const effectiveGroup = templateKeyMatch ? templateKeyMatch[1].trim() : group0;
            if (effectiveGroup && /^[\u4e00-\u9fff$]{1,12}$/.test(effectiveGroup)) {
                acc.wildcardRules[effectiveGroup] = acc.wildcardRules[effectiveGroup] || [];
                acc.wildcardRules[effectiveGroup].push(rec);
            }
            // 与正则路径一致：组内子字段通配同时挂到所在组
            if (enclosingGroup && enclosingGroup !== group0) {
                acc.wildcardRules[enclosingGroup] = acc.wildcardRules[enclosingGroup] || [];
                acc.wildcardRules[enclosingGroup].push(rec);
            }
        }
    
    function registerWildcardTypeShape(key, typeValue, acc, enclosingGroup) {
            const ts = String(typeValue == null ? '' : typeValue).trim();
            if (!ts || !/[\[{]/.test(ts)) return;
            const parsed = parseShapeString(ts);
            if (!parsed) return;
            const rawParts = String(key).split('.').map(s => s.trim()).filter(Boolean);
            if (!rawParts.length) return;
            const lastIsTemplateKey = /^\$\{[^}]+\}$|^<[^>]+>$/.test(rawParts[rawParts.length - 1]);
            const tableParts = lastIsTemplateKey ? rawParts.slice(0, -1) : rawParts.slice();
            if (!tableParts.length) return;
            // 正则回退会把标准外壳「变量更新规则:」也扫描成 group；其下的
            // 世界.当前对手 / 主角.物品栏 已是绝对路径，不得再冠上外壳名。
            const effectiveGroup = enclosingGroup === '变量更新规则' ? '' : enclosingGroup;
            const fullParts = effectiveGroup && tableParts[0] !== effectiveGroup
                ? [effectiveGroup, ...tableParts]
                : tableParts;
            const tableKey = tableParts[tableParts.length - 1];
            if (!/^[\u4e00-\u9fff$]{1,12}$/.test(tableKey)) return;
            acc.shapes[tableKey] = acc.shapes[tableKey] || [];
            for (const f of parsed.fields || []) if (!acc.shapes[tableKey].includes(f)) acc.shapes[tableKey].push(f);
            if (parsed.objects && parsed.objects.length) {
                acc.objects[tableKey] = acc.objects[tableKey] || {};
                for (const f of parsed.objects) acc.objects[tableKey][f] = true;
            }
            mergeShapeMetadata(tableKey, parsed, acc.fieldTypes, acc.objectSchemas, acc.enumPaths, tableParts);
            // ${槽位} 本身就是条目键；dynamicTop 则是显式 [动态键] 字典。
            if (lastIsTemplateKey || parsed.dynamicTop) acc.dynamicPaths.add(fullParts.join('.'));
        }
    
    function registerYamlField(group, field, def, acc, fieldPath) {
            let rangeVal = null;
            let formatVal = '';
            // type 含 { / [ 的对象/字典声明：check 描述的是整块结构（容器/子表/JSON 列），
            // 不是某个标量列，路径化附着时跳过列级匹配（表级规则仍经 groupChecks 保留）。
            const tableLevel = def.type !== undefined && /[\[{]/.test(String(def.type).trim());
            if (def.type !== undefined) {
                const ts = String(def.type).trim();
                // 只有字段自身声明为 number 才能标成数值。对象 type 内部通常包含若干
                // `子字段: number`；按 substring 判断会把整个对象列误标成 INTEGER，JSON
                // 读回随即退化成字符串（收益明细/粮秣流水等均会中招）。
                if (/^(?:number|integer)\s*;?$/i.test(ts)) acc.numericFields.add(field);
                if (/[\[{]/.test(ts)) {
                    const parsed = parseShapeString(ts);
                    if (parsed) {
                        const t0 = String(ts).trim();
                        const isDyn = /^\[.*?\]\s*:/.test(t0) || /^\{[^}]*:\s*\{/.test(t0);
                        const target = isDyn ? field : group;
                        acc.shapes[target] = acc.shapes[target] || [];
                        const targetFields = (target === group && parsed.topFields && parsed.topFields.length) ? parsed.topFields : parsed.fields;
                        for (const f2 of targetFields) if (!acc.shapes[target].includes(f2)) acc.shapes[target].push(f2);
                        const targetObjects = (target === group && parsed.topObjects && parsed.topObjects.length) ? parsed.topObjects : parsed.objects;
                        if (targetObjects.length) {
                            acc.objects[target] = acc.objects[target] || {};
                            for (const obj of targetObjects) acc.objects[target][obj] = true;
                        }
                        mergeShapeMetadata(target, parsed, acc.fieldTypes, acc.objectSchemas, acc.enumPaths, fieldPath);
                        if (parsed.dynamicTop || (parsed.dynamic && parsed.dynamic.length)) {
                            acc.dynamicDicts[group] = acc.dynamicDicts[group] || {};
                            if (parsed.dynamicTop) acc.dynamicDicts[group][field] = true;
                            for (const df of parsed.dynamic || []) acc.dynamicDicts[group][df] = true;
                        }
                    }
                }
            }
            if (def.range !== undefined) {
                const r = yamlParseRange(def.range);
                if (r) {
                    rangeVal = r;
                    acc.ranges[field] = r;
                    acc.numericFields.add(field);
                } else if (Array.isArray(def.range)) {
                    // 教程用 range 同时表达数值区间和可选值集。非数值数组应作为
                    // 枚举，不能因 yamlParseRange 失败就静默丢弃。
                    const vals = def.range.map(yamlStripQuotes).filter(Boolean);
                    if (vals.length >= 2 && vals.length <= 32) acc.enums[field] = vals;
                }
            }
            if (def.format !== undefined) {
                const fv = String(def.format);
                formatVal = fv.indexOf('\n') !== -1 ? fv.replace(/\s+/g, ' ').trim() : fv.trim();
                acc.formats[group] = acc.formats[group] || {};
                acc.formats[group][field] = formatVal;
            }
            if (def.check !== undefined) {
                const items = yamlCheckItems(def.check);
                if (items.length) {
                    acc.checks[group] = acc.checks[group] || {};
                    acc.checks[group][field] = [...new Set([...(acc.checks[group][field] || []), ...items])];
                    acc.allCheckItems.push(...items);
                    // 路径化附着：记录规则书写时的完整路径（组.容器…字段），供
                    // attachFieldRules 在规则分组与 initvar 结构不一致时按路径匹配列。
                    acc.checkPaths.push({
                        path: fieldPath || [group, field],
                        list: items,
                        range: rangeVal,
                        format: formatVal,
                        tableLevel,
                    });
                }
            }
            if (def.enum !== undefined) {
                if (/<%[\s\S]*?%>|\{\{[\s\S]*?\}\}/.test(String(def.enum))) return;
                const ev = Array.isArray(def.enum) ? def.enum : String(def.enum).replace(/^["']|["']$/g, '').split(/[/|]/);
                const vals = ev.map(yamlStripQuotes).filter(Boolean);
                if (vals.length >= 2 && vals.length <= 12) acc.enums[field] = vals;
            }
        }
    
    function parseMvuShapes(card, report) {
            const d = card.data || card;
            const entries = (d.character_book && d.character_book.entries) || [];
            const shapes = {};
            const objects = {};
            const fieldTypes = {};
            const objectSchemas = {};
            const ranges = {};
            const enums = {};
            const enumPaths = [];
            const formats = {};
            const checks = {};
            const reminders = {};
            const groupChecks = {};
            const zodDescs = {};
            let zodSchemaRoot = null;
            const wildcardFields = new Set();
            const wildcardRules = {};
            const numericFields = new Set();
            // 动态键字典（来自 [mvu_update] type 声明的 { [键: type]: value }，如
            // 修仙秘闻 / 个人背包 / 修仙八卦论坛）：这类字段的条目键是运行期内容，
            // 转换时拆成子行表，不能展平成固定列（不同分支的键完全不同，固定列会丢数据）。
            const dynamicDicts = {};
            const dynamicPaths = new Set();
            const dynamicGroups = new Set();
            const dynamicKeyNames = {};
            // registerMvuSchema 常放在酒馆助手脚本里，且可能被压缩并通过对象 spread 复用。
            // 当同名字段在整份 Zod schema 中始终只有一种基础类型时，可作为规则 YAML
            // 缺失字段类型的安全兜底（如所有「标签」都是 z.array）。类型有冲突则不猜。
            const globalFieldKindSets = {};
            const allContents = [];
            const allCheckItems = [];
            // 记录每条字段级 check 的完整规则路径（组.容器…字段），供“initvar 优先”的
            // 路径化附着：规则分组与 initvar 结构不一致、但路径能对上时也能挂到对应列/表。
            const checkPaths = [];
            for (const e of entries) {
                const comment = String(e.comment || '');
                const content = String(e.content || '');
                // 只解析规则条目：明确 [mvu_update]/变量更新规则/变量输出格式，或注释含 mvu 的
                // 兜底写法；[mvu_plot] 是剧情条目（AI 提示词，保留给角色），绝不能当规则解析——
                // 否则其正文 YAML（如 战斗系统.说明: |- 一整段战斗判定）会被误当行内枚举/规则。
                if (/\[mvu[ _-]?plot\]|\[mvuplot\]/i.test(comment)) continue;
                if (!/\[mvu[ _-]?update\]|\[mvuupdate\]/i.test(comment) && !/变量更新规则|变量输出格式/.test(comment) && !/mvu/i.test(comment)) continue;
                allContents.push(content);
                scanDynamicKeyNamesFromRules(content, dynamicKeyNames);
                // YAML 优先：规则是作者自定义 YAML，真 YAML 树能覆盖正则盲区
                // （flow 写法、引号键、深层嵌套）；失败或结构是字符串（zod/散文）回退正则。
                if (collectRulesFromYaml(content, {
                    shapes, objects, fieldTypes, objectSchemas, ranges, enums, formats, checks, reminders, groupChecks, zodDescs,
                    wildcardFields, wildcardRules, numericFields, dynamicDicts, dynamicPaths, dynamicGroups,
                    allCheckItems, checkPaths, enumPaths,
                })) continue;
                // YAML 失败回退正则：注明原因，便于发现“回退后个别声明丢失”（如大荒组级 type）。
                if (report && (/\[mvu[ _-]?update\]|\[mvuupdate\]/i.test(comment) || /变量更新规则|变量输出格式/.test(comment))) {
                    report.warn(
                        `规则条目「${String(comment).slice(0, 30)}」的 YAML 解析失败（非法语法/多文档），` +
                        `已回退正则路径；组级与深层声明按缩进正则提取，若解析异常请人工核对。`,
                        'schema'
                    );
                }
                // 顶层组：缩进 ≤2 的中文/含$组名
                // 注意：结尾必须用 (?=\n) 前瞻而不是消费 \n——否则紧跟上一组行的组会被跳过
                // （如 “变量更新规则:\n  世界:” 中 世界: 前面的换行已被上一组匹配吃掉）。
                const groupRe = /(?:^|\n)( {0,2})([\u4e00-\u9fff$]{1,12})[ \t]*:[ \t]*(?=\n)/g;
                const matches = [];
                let gm;
                while ((gm = groupRe.exec(content))) {
                    matches.push({ name: gm[2], index: gm.index + gm[0].length });
                }
                for (let mi = 0; mi < matches.length; mi++) {
                    const group = matches[mi].name;
                    const start = matches[mi].index;
                    const end = mi + 1 < matches.length ? matches[mi + 1].index - 1 : content.length;
                    const section = content.slice(start, end);
    
                    // 字段级规则：缩进 4 的 key 行开始，直到下一个同级 key。
                    // 先屏蔽块标量（type:/format:/check: 等 |- 块）的内容体，再扫描字段——
                    // 否则块内容里更深缩进的中文键行（如 标签: "热" | ...、描述: string;）
                    // 会被当成“下一个字段”，截断父字段的 block，导致父字段 type 块之后的
                    // check: 整组丢失（苍玄界 V4.1 的 个人背包/修仙八卦论坛/今日运势/
                    // 最新传讯 等全中招），顺带把 标签/分类 这类 TS 联合类型误当行内枚举解析坏。
                    // 屏蔽法不依赖具体缩进档位：任意深度的合法字段仍会命中，块内容一律排除
                    // （比“只认 4/6 空格”更通用，也不会漏掉更深层的合法子字段）。
                    const maskedSection = maskYamlBlockScalarBodies(section);
                    // 缩进 4~6 空格都算字段行：6 空格是 3 层嵌套子字段（修为:{ 进度百分比:… }），
                    // 记录 indent 供路径化附着拼出 组.容器.子字段 完整路径（展平列需要）。
                    const fieldRe = /(?:^|\n)( {4,6})([^\n:]{1,24}?)[ \t]*:[ \t]*([^\n]*)$/gm;
                    const fieldStarts = [];
                    let fm;
                    while ((fm = fieldRe.exec(maskedSection))) {
                        const field = fm[2].trim().replace(/^["']|["']$/g, '');
                        if (!/^[\u4e00-\u9fff$]{1,12}$/.test(field) && !/^\$\{[^}]+\}$/.test(field)) continue;
                        fieldStarts.push({ field, indent: fm[1].length, fieldPath: [group, field], index: fm.index + fm[0].length, inline: fm[3].trim(), at: fm.index });
                    }
                    // 通配路径字段（如 户.<门牌>.妻.好感值 / 人物.角色名.亲密）：字段名含 <…> 或 .，
                    // 不是静态列，无法逐字段迁移；识别出来并在转换报告中显式警告，避免静默丢弃。
                    // 通配路径可出现在 2 空格（顶层，如 人妻公寓 的 户.<门牌>…）或 4 空格（组内）缩进
                    const wildRe = /(?:^|\n)( {0,4})([^\n:]{1,40}?)[ \t]*:[ \t]*([^\n]*)$/gm;
                    const wildKeys = [];
                    let wm;
                    while ((wm = wildRe.exec(maskedSection))) {
                        const k = wm[2].trim().replace(/^["']|["']$/g, '');
                        if (!k) continue;
                        if (isMvuRulePathKey(k)) {
                            wildKeys.push({ key: k, indent: wm[1].length, at: wm.index, end: wm.index + wm[0].length });
                            wildcardFields.add(k);
                        }
                    }
                    // 普通字段和点/通配路径互为 block 边界。旧逻辑只让“普通字段”彼此截断、
                    // “通配路径”彼此截断，导致 外貌 的 block 吞进后续 装备.* type，进而把
                    // 内层「已装备」误登记成 主角.已装备 动态字典；最后凭空生成 已装备表。
                    const ruleStarts = [...fieldStarts.map(x => x.at), ...wildKeys.map(x => x.at)].sort((a, b) => a - b);
                    const nextRuleStart = at => {
                        const n = ruleStarts.find(x => x > at);
                        return n === undefined ? section.length : n;
                    };
                    for (let wi = 0; wi < wildKeys.length; wi++) {
                        const wk0 = wildKeys[wi];
                        const nextAt = nextRuleStart(wk0.at);
                        const block = section.slice(wk0.end, nextAt);
                        const group0 = String(wk0.key).split('.')[0].trim();
                        // 首段可能是 ${A|B} 模板键（如 ${小宅仙|小御仙}.当前阶段）：不满足纯组名
                        // 时不能 continue 丢弃，应挂到所在组（天道娘面板）——否则这些规则全丢。
                        const isPlainGroup0 = /^[\u4e00-\u9fff$]{1,12}$/.test(group0);
                        const rangeLine = block.match(/range\s*:\s*([^\n]+)/);
                        const rangeValue = rangeLine ? yamlParseRange(rangeLine[1]) : null;
                        const checkM = block.match(/check\s*:\s*("?[\s\S]*?)(?=\n {4}[^ \n-][^\n:]{0,23}?:\s*|\n {2}\S|$)/);
                        const fmtM = block.match(/format\s*:\s*([^\n]+)$/m);
                        let checks = [];
                        if (checkM) {
                            let raw = String(checkM[1]).trim();
                            if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1).trim();
                            checks = extractListItems(raw).map(stripRuleQuotes);
                        }
                        const rec = { path: wk0.key, checks };
                        const wildTypeBlock = extractYamlBlockScalar(block, 'type');
                        const wildTypeQuoted = block.match(/type\s*:\s*["']([\s\S]*?)["']\s*$/m);
                        const wildType = wildTypeBlock !== null ? wildTypeBlock : (wildTypeQuoted ? wildTypeQuoted[1] : '');
                        if (wildType) {
                            registerWildcardTypeShape(wk0.key, wildType, {
                                shapes, objects, fieldTypes, objectSchemas, dynamicPaths,
                            }, wk0.indent <= 2 ? undefined : group);
                        }
                        if (rangeValue) rec.range = rangeValue;
                        if (fmtM) rec.format = String(fmtM[1]).trim().replace(/^["']|["']$/g, '');
                        if (isPlainGroup0) {
                            wildcardRules[group0] = wildcardRules[group0] || [];
                            wildcardRules[group0].push(rec);
                        }
                        // 组内子字段通配（首段不是组名，如 主角 下的 生理.欲望槽 / 技艺.${…}）
                        // 或首段是模板键（${小宅仙|小御仙}.当前阶段）：挂到所在组，避免规则孤儿。
                        if (wk0.indent > 2 && group && (!isPlainGroup0 || group !== group0)) {
                            wildcardRules[group] = wildcardRules[group] || [];
                            wildcardRules[group].push(rec);
                        }
                    }
                    for (let fi = 0; fi < fieldStarts.length; fi++) {
                        const { field, indent, index, inline } = fieldStarts[fi];
                        const next = nextRuleStart(fieldStarts[fi].at);
                        const block = section.slice(index, next);
                        if (field === '_强制更新提醒' || field === '_强制更新') {
                            // 展开 ${生命|精血|灵力|神识} 这类模板键，提示词里更易读
                            const expandKeys = (s) => String(s).replace(/\$\{([^}]+)\}/g, (m, inner) => (
                                inner.includes('|') ? inner.split('|').map(p => p.trim()).filter(Boolean).join('/') : m
                            ));
                            reminders[group] = extractListItems(block).map(expandKeys);
                            continue;
                        }
                        // 展开 ${A|B|C} 多字段模板键
                        const fieldNames = [];
                        if (field.includes('|')) {
                            for (const part of field.replace(/^\$\{/, '').replace(/\}$/, '').split('|')) {
                                const p = part.trim();
                                if (/^[\u4e00-\u9fff]{1,12}$/.test(p)) fieldNames.push(p);
                            }
                        }
                        if (!fieldNames.length) fieldNames.push(field);
                        const rangeLine = block.match(/range\s*:\s*([^\n]+)/);
                        const rangeValue = rangeLine ? yamlParseRange(rangeLine[1]) : null;
                        for (const fn of fieldNames) {
                            if (rangeValue) ranges[fn] = rangeValue;
                            // 只匹配该字段直属的标量 type 行；对象/数组 type 内部出现 number
                            // 不代表外层字段是数字。
                            if (/(?:^|\n)[ \t]*type\s*:\s*(?:number|integer)\s*;?[ \t]*(?:\n|$)/i.test(block)) numericFields.add(fn);
                            if (rangeValue) numericFields.add(fn);
                        }
                        const typeLine = block.match(/type\s*:\s*"([\s\S]*?)"\s*$/m);
                        const typeBlockRaw = extractYamlBlockScalar(block, 'type');
                        const typeBlock = typeBlockRaw === null ? null : { 1: typeBlockRaw };
                        // type 含 { / [ 的对象/字典声明：check 描述整块结构（容器/子表/JSON 列），
                        // 路径化附着时跳过列级匹配（表级规则仍经 groupChecks/parentList 保留）。
                        const fieldTypeRaw = typeLine ? typeLine[1] : (typeBlock ? typeBlock[1] : '');
                        const fieldTableLevel = /[\[{]/.test(String(fieldTypeRaw).trim());
                        if (typeLine) {
                            const parsed = parseShapeString(typeLine[1]);
                            if (parsed) {
                                const t0 = String(typeLine[1]).trim();
                                const target = /^\[.*?\]\s*:/.test(t0) || /^\{[^}]*:\s*\{/.test(t0) ? field : group;
                                shapes[target] = shapes[target] || [];
                                const targetFields = (target === group && parsed.topFields && parsed.topFields.length) ? parsed.topFields : parsed.fields;
                                for (const f2 of targetFields) if (!shapes[target].includes(f2)) shapes[target].push(f2);
                                const targetObjects = (target === group && parsed.topObjects && parsed.topObjects.length) ? parsed.topObjects : parsed.objects;
                                if (targetObjects.length) {
                                    objects[target] = objects[target] || {};
                                    for (const obj of targetObjects) objects[target][obj] = true;
                                }
                                mergeShapeMetadata(target, parsed, fieldTypes, objectSchemas, enumPaths, [group, field]);
                                if (target === group) {
                                    if (!shapes[group].includes(field)) shapes[group].push(field);
                                    objects[group] = objects[group] || {};
                                    objects[group][field] = true;
                                }
                                // 动态键字典声明（{ [键: type]: value }）：记录 组→字段，
                                // 供 buildSchema/collectColumns 把该字段拆成子行表。
                                if (parsed.dynamicTop || (parsed.dynamic && parsed.dynamic.length)) {
                                    dynamicDicts[group] = dynamicDicts[group] || {};
                                    if (parsed.dynamicTop) dynamicDicts[group][field] = true;
                                    for (const df of parsed.dynamic || []) dynamicDicts[group][df] = true;
                                }
                            }
                        } else if (typeBlock) {
                            const parsed = parseShapeString(typeBlock[1]);
                            if (parsed) {
                                const t0 = String(typeBlock[1]).trim();
                                const target = /^\{[^}]*:\s*\{/.test(t0) || /^\[.*?\]\s*:/.test(t0) ? field : group;
                                shapes[target] = shapes[target] || [];
                                const targetFields = (target === group && parsed.topFields && parsed.topFields.length) ? parsed.topFields : parsed.fields;
                                for (const f2 of targetFields) if (!shapes[target].includes(f2)) shapes[target].push(f2);
                                const targetObjects = (target === group && parsed.topObjects && parsed.topObjects.length) ? parsed.topObjects : parsed.objects;
                                if (targetObjects.length) {
                                    objects[target] = objects[target] || {};
                                    for (const obj of targetObjects) objects[target][obj] = true;
                                }
                                mergeShapeMetadata(target, parsed, fieldTypes, objectSchemas, enumPaths, [group, field]);
                                if (parsed.dynamicTop || (parsed.dynamic && parsed.dynamic.length)) {
                                    dynamicDicts[group] = dynamicDicts[group] || {};
                                    if (parsed.dynamicTop) dynamicDicts[group][field] = true;
                                    for (const df of parsed.dynamic || []) dynamicDicts[group][df] = true;
                                }
                            }
                        }
                        // format 支持三种写法：块标量（|-）、引号单行、无引号单行
                        // （官方参考里有无引号写法，如 format: YYYY年MM月DD日 星期X HH:MM）
                        const formatValue = (() => {
                            const fmtRaw = extractYamlBlockScalar(block, 'format');
                            const blk = fmtRaw === null ? null : { 1: fmtRaw };
                            if (blk) {
                                const lines = String(blk[1]).split('\n');
                                const ind = lines.filter(l => l.trim()).reduce((min, l) => {
                                    const n = (l.match(/^ */) || [''])[0].length;
                                    return Math.min(min, n);
                                }, Infinity);
                                return lines.map(l => l.slice(Math.min(ind, l.length))).join(' ').replace(/\s+/g, ' ').trim();
                            }
                            const q = block.match(/format\s*:\s*["']([\s\S]*?)["']\s*$/m);
                            if (q) return q[1].trim();
                            const u = block.match(/format\s*:\s*([^\n]+)$/m);
                            if (u) return u[1].trim();
                            return '';
                        })();
                        if (formatValue) {
                            formats[group] = formats[group] || {};
                            for (const fn of fieldNames) formats[group][fn] = formatValue;
                        }
                        // 注意：可选引号必须写成 "?"（零或一个引号）。"\"\"?" 在正则里是“一个或两个引号”，
                        // check 列表以 - 开头没有引号时永远匹配失败，导致所有 check 规则静默丢失（道渊实测）。
                        // 字段行以中文/名字开头，bullet 行在 4 空格后是空格或 -：用 [^ \n-] 挡住 bullet，
                        // 避免条目里的 ASCII 冒号（如 op: delta）被当成“下一个字段”截断。
                        const checkM = block.match(/check\s*:\s*("?[\s\S]*?)(?=\n {4}[^ \n-][^\n:]{0,23}?:\s*|\n {2}\S|$)/);
                        if (checkM) {
                            let raw = String(checkM[1]).trim();
                            // 行内引号形式（check: "单行说明"）：去掉首尾引号
                            if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1).trim();
                            // 列表项也可能整体带引号（如 - "四境：凡心(0~25)…"），逐项剥掉
                            const stripQuotes = (s) => {
                                let t = String(s).trim();
                                if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) t = t.slice(1, -1).trim();
                                return t;
                            };
                            const items = extractListItems(raw).map(stripQuotes);
                            const list = items.length ? items : (raw ? [raw] : []);
                            if (list.length) {
                                checks[group] = checks[group] || {};
                                for (const fn of fieldNames) {
                                    checks[group][fn] = [...new Set([...(checks[group][fn] || []), ...list])];
                                    // 路径化附着：记录 4 空格（2 层）字段的书写路径（组.字段）。
                                    checkPaths.push({
                                        path: [group, fn],
                                        list,
                                        range: rangeValue,
                                        format: formatValue || '',
                                        tableLevel: fieldTableLevel,
                                    });
                                    // 6 空格（3 层）嵌套子字段（修为: { 进度百分比: check: … }）：
                                    // 上面的 2 层路径会丢容器层，补记 组.父字段.子字段 完整路径，
                                    // 供展平列（修为进度百分比，path=[主角,修为,进度百分比]）精确附着。
                                    if (indent === 6 && fieldNames.length === 1) {
                                        let parentField = '';
                                        for (let j = fi - 1; j >= 0; j--) {
                                            if (fieldStarts[j].indent === 4) {
                                                parentField = fieldStarts[j].field;
                                                break;
                                            }
                                        }
                                        if (parentField) {
                                            checkPaths.push({
                                                path: [group, parentField, fn],
                                                list,
                                                range: rangeValue,
                                                format: formatValue || '',
                                                tableLevel: false,
                                            });
                                        }
                                    }
                                }
                            }
                        }
                        // 行内枚举值（危机程度: "无/低/中/高/致命"）
                        if (inline && !block.includes('type') && !block.includes('range') && !block.includes('format') && !block.includes('check')) {
                            const vals = parseInlineEnumValues(inline);
                            if (vals) {
                                for (const fn of fieldNames) enums[fn] = vals;
                            }
                        }
                    }
                    // 组级 type 声明（形如 组名: type: "{...}"）
                    const groupCheckM = section.match(/\n {4}check\s*:\s*\n([\s\S]*?)(?=\n {4}[^ \n-][^\n:]{0,23}?[ \t]*:|\n {2}\S|$)/);
                    if (groupCheckM) {
                        // 组级 check（道侣/灵宠/人物/绝色榜/玉简/机遇 等整表规则）：
                        // 除提取范围外，条目必须保留为表格级规则，不能只喂给 allCheckItems 后丢弃。
                        const gItems = extractListItems(groupCheckM[1]).map(stripRuleQuotes);
                        allCheckItems.push(...gItems);
                        if (gItems.length) groupChecks[group] = gItems;
                    }
                    // 非法 YAML 回退路径也要保留组级 note；典型写法是
                    // `note: {{getvar::...}}`，其后的字段 type 可能含裸 `|` 使整条 YAML 失效。
                    const groupNoteM = section.match(/(?:^|\n) {4}note\s*:\s*([^\n]+)$/m);
                    if (groupNoteM) {
                        const noteText = stripRuleQuotes(groupNoteM[1]);
                        if (noteText) {
                            allCheckItems.push(noteText);
                            groupChecks[group] = [...new Set([...(groupChecks[group] || []), noteText])];
                        }
                    }
                    let shapeStr = null;
                    if (!/^\s*type\s*:/.test(section)) continue; // 该组没有直接 type 声明（字段由 initvar 提供）
                    const q = section.match(/type\s*:\s*"([\s\S]*?)"\s*$/m);
                    // 组级 type 块标量必须用 extractYamlBlockScalar：旧正则的 lookahead
                    // `(?=\n\s*\S)` 会在块内容第一行（如 `{`）就终止，把整个结构截断成空，
                    // 导致 宗门/灵兽栏/寻缘蝶 这类 `type: |- { [键: string]: {...} }` 的
                    // 动态键字典声明全部丢失 → 组退化成整组 JSON 表 → AI 写入平铺数据，
                    // 与前端 EJS 期望的嵌套结构（{宗门名: {主角职务,…}}）对不上而“不显示”。
                    const b = extractYamlBlockScalar(section, 'type');
                    if (q) shapeStr = q[1];
                    else if (b !== null) shapeStr = b;
                    if (!shapeStr) continue;
                    const parsed = parseShapeString(shapeStr);
                    if (parsed) {
                        shapes[group] = shapes[group] || [];
                        const groupTypeFields = (parsed.topFields && parsed.topFields.length) ? parsed.topFields : parsed.fields;
                        for (const f2 of groupTypeFields) if (!shapes[group].includes(f2)) shapes[group].push(f2);
                        const groupObjects = (parsed.topObjects && parsed.topObjects.length) ? parsed.topObjects : parsed.objects;
                        if (groupObjects.length) objects[group] = objects[group] || {};
                        for (const objField of groupObjects) objects[group][objField] = true;
                        mergeShapeMetadata(group, parsed, fieldTypes, objectSchemas, enumPaths);
                        // 组本身声明为动态键字典（组 type: { [键: type]: {...} }）：
                        // 顶层组按条目行表转换，不能当单例/固定字段表。
                        if (parsed.dynamicTop) dynamicGroups.add(group);
                    }
                }
            }
            // 从 check 文本提取 “字段(0~100)” 式范围（如 亲密(0~100)）
            for (const group of Object.keys(checks)) {
                for (const field of Object.keys(checks[group])) {
                    allCheckItems.push(...checks[group][field]);
                }
            }
            for (const line of allCheckItems) {
                const rm = line.match(/([\u4e00-\u9fff]{1,8})\((\d+)~(\d+)\)/);
                if (rm && !ranges[rm[1]]) {
                    ranges[rm[1]] = [Number(rm[2]), Number(rm[3])];
                    numericFields.add(rm[1]);
                }
            }
            // 全局 _强制更新提醒（通常在 变量更新规则 顶层，缩进 2）：按 “组.字段” 前缀归属组
            const rmRe = /_强制更新提醒\s*:\s*\n([\s\S]*?)(?=\n\s{0,2}[\u4e00-\u9fff$]{1,12}:[ \t]*\n|\n\s{4}[\u4e00-\u9fff$]{1,12}:[ \t]*\n|$)/;
            const rmM = allContents.join('\n').match(rmRe);
            if (rmM) {
                // 展开 ${生命|精血|灵力|神识} 这类模板键，提示词里更易读
                const expandKeys = (s) => String(s).replace(/\$\{([^}]+)\}/g, (m, inner) => (
                    inner.includes('|') ? inner.split('|').map(p => p.trim()).filter(Boolean).join('/') : m
                ));
                for (const item of extractListItems(rmM[1]).map(expandKeys)) {
                    const prefix = item.match(/^([\u4e00-\u9fff$]{1,12})\./);
                    const target = prefix ? prefix[1] : String(item).split(/[ —:：-]/)[0].trim();
                    if (/^[\u4e00-\u9fff$]{1,12}$/.test(target)) {
                        reminders[target] = reminders[target] || [];
                        if (!reminders[target].includes(item)) reminders[target].push(item);
                    }
                }
            }
            // zod/TS 替代写法：type 直接放 zod 代码 + /** check: … */ 注释（官方文档 3.2 替代写法）。
            // 与 YAML 标准写法互补：字段名并入 shapes，check 注释并入 checks。
            for (const content of allContents) {
                const zod = parseZodStyleRules(content);
                if (!zod) continue;
                for (const group of Object.keys(zod)) {
                    const g = zod[group];
                    if (Array.isArray(g.fields) && g.fields.length) {
                        shapes[group] = shapes[group] || [];
                        for (const f of g.fields) {
                            if (!shapes[group].includes(f)) shapes[group].push(f);
                        }
                    }
                    for (const f of Object.keys(g.checks)) {
                        checks[group] = checks[group] || {};
                        checks[group][f] = [...new Set([...(checks[group][f] || []), ...g.checks[f]])];
                    }
                    for (const rec of (g.pathRules || [])) {
                        checkPaths.push({
                            path: rec.path.slice(),
                            list: rec.list.slice(),
                            range: null,
                            format: '',
                            tableLevel: !!rec.tableLevel,
                        });
                    }
                    for (const f of Object.keys(g.ranges || {})) {
                        const rr = g.ranges[f];
                        if (Array.isArray(rr) && rr.length === 2) ranges[f] = [rr[0], rr[1]];
                        numericFields.add(f);
                    }
                    for (const f of Object.keys(g.enums || {})) enums[f] = g.enums[f];
                    for (const f of Object.keys(g.descs || {})) {
                        // 组名+字段名双键存描述，避免跨组同名字段互相覆盖
                        zodDescs[group] = zodDescs[group] || {};
                        zodDescs[group][f] = g.descs[f];
                    }
                }
            }
            for (const source of allContents) {
                const tsr = /([\u4e00-\u9fffA-Za-z_$][\u4e00-\u9fffA-Za-z0-9_$]*)\s*:\s*(string|number|boolean)\s*(\[\])?/g;
                let tm;
                while ((tm = tsr.exec(source))) {
                    const kind = tm[3] ? 'array' : tm[2];
                    (globalFieldKindSets[tm[1]] || (globalFieldKindSets[tm[1]] = new Set())).add(kind);
                }
            }
            const thScripts = d.extensions && d.extensions.tavern_helper && Array.isArray(d.extensions.tavern_helper.scripts)
                ? d.extensions.tavern_helper.scripts : [];
            for (const script of thScripts) {
                const source = String(script && (script.content || script.code || script.script) || '');
                if (!/registerMvuSchema|\.z\.(?:object|record|array)\s*\(/.test(source)) continue;
                const zr = /([\u4e00-\u9fffA-Za-z_$][\u4e00-\u9fffA-Za-z0-9_$]*)\s*:\s*(?:[A-Za-z_$][\w$]*\.)?z\.(array|record|object|boolean|number|string)\s*\(/g;
                let zm;
                while ((zm = zr.exec(source))) {
                    const rawKind = zm[2];
                    const kind = rawKind === 'record' || rawKind === 'object' ? 'object' : rawKind;
                    (globalFieldKindSets[zm[1]] || (globalFieldKindSets[zm[1]] = new Set())).add(kind);
                }
                const parsedSchema = parseRegisteredZodSchema(source);
                if (parsedSchema && parsedSchema.root && parsedSchema.root.kind === 'object') {
                    zodSchemaRoot = mergeZodSchemaNodes(zodSchemaRoot, parsedSchema.root);
                    mergeRegisteredZodIntoShapeInfo(parsedSchema.root, {
                        shapes, fieldTypes, objectSchemas, ranges, enums, zodDescs,
                        numericFields, dynamicDicts, dynamicPaths, dynamicGroups, dynamicKeyNames,
                    });
                    if (report) report.note(`已从酒馆助手脚本「${String(script.name || '未命名 Schema')}」提取 Zod 结构与声明式约束。`);
                    const clampCount = countZodSchemaFlag(parsedSchema.root, 'clampTransform');
                    if (clampCount && report) {
                        report.note(`Zod Schema 中 ${clampCount} 处 _.clamp 已迁移为范围提示与可选数据库 CHECK；数据库越界时由 SP 原有失败/重填流程处理，不模拟 Zod 自动钳制。`);
                    }
                } else if (/registerMvuSchema/.test(source) && report) {
                    report.manual(`酒馆助手脚本「${String(script.name || '未命名 Schema')}」调用了 registerMvuSchema，但未能静态解析注册对象；转换会继续，InitVar 数据仍可建表，但该脚本中的结构与约束可能降级。`);
                }
                if (parsedSchema && parsedSchema.unsupported && parsedSchema.unsupported.length && report) {
                    const uniqueUnsupported = [];
                    const unsupportedSeen = new Set();
                    for (const item of parsedSchema.unsupported) {
                        const sig = `${item.path}\u0000${item.kind}\u0000${item.expression}`;
                        if (!unsupportedSeen.has(sig)) { unsupportedSeen.add(sig); uniqueUnsupported.push(item); }
                    }
                    // `.catch(fallback)` 在手写卡里通常大量重复；它影响非法输入的修复方式，
                    // 但不决定字段结构。集中报告，避免二十条 catch 淹没真正无法识别的 Schema。
                    const catchItems = uniqueUnsupported.filter(item => item.kind === 'catch');
                    const detailed = uniqueUnsupported.filter(item => item.kind !== 'catch');
                    if (catchItems.length) {
                        const samples = catchItems.slice(0, 6).map(item => item.path || '未知路径').join('、');
                        report.manual(`Zod Schema 有 ${catchItems.length} 处 .catch(fallback) 非法输入回退未模拟（如 ${samples}${catchItems.length > 6 ? ' 等' : ''}）；字段结构、prefault/default 与可声明约束仍已迁移，非法数据库值由 CHECK/填表重试处理。`);
                    }
                    for (const item of detailed.slice(0, 20)) {
                        report.manual(`Zod 字段「${item.path || '未知路径'}」含无法静态等价迁移的 ${item.kind}：${item.expression}。数据库结构与读写仍保留，但该自定义校验/转换不会执行。`);
                    }
                    if (detailed.length > 20) {
                        report.manual(`另有 ${detailed.length - 20} 条 Zod 自定义语义未逐条列出，请检查原 Schema 脚本。`);
                    }
                }
            }
            const globalFieldTypes = {};
            for (const [field, kinds] of Object.entries(globalFieldKindSets)) {
                if (kinds.size === 1) globalFieldTypes[field] = [...kinds][0];
            }
            return { shapes, objects, fieldTypes, globalFieldTypes, objectSchemas, ranges, enums, enumPaths, formats, checks, reminders, groupChecks, zodDescs, zodSchemaRoot, wildcardFields, wildcardRules, numericFields, dynamicDicts, dynamicPaths, dynamicGroups, dynamicKeyNames, checkPaths };
        }
    
    function parseRegisteredZodSchema(source) {
            const text = String(source || '');
            if (!/registerMvuSchema/.test(text)) return null;
            const definitions = {};
            const unsupported = [];
            const readBalancedEnd = (s, open, openCh, closeCh) => {
                let depth = 0, quote = '', lineComment = false, blockComment = false;
                for (let i = open; i < s.length; i++) {
                    const ch = s[i], nx = s[i + 1];
                    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
                    if (blockComment) { if (ch === '*' && nx === '/') { blockComment = false; i++; } continue; }
                    if (quote) { if (ch === '\\') { i++; continue; } if (ch === quote) quote = ''; continue; }
                    if (ch === '/' && nx === '/') { lineComment = true; i++; continue; }
                    if (ch === '/' && nx === '*') { blockComment = true; i++; continue; }
                    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
                    if (ch === openCh) depth++;
                    else if (ch === closeCh && --depth === 0) return i;
                }
                return -1;
            };
            const readInitializerEnd = (s, start) => {
                let quote = '', lineComment = false, blockComment = false;
                const stack = [];
                const pairs = { '(': ')', '[': ']', '{': '}' };
                for (let i = start; i < s.length; i++) {
                    const ch = s[i], nx = s[i + 1];
                    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
                    if (blockComment) { if (ch === '*' && nx === '/') { blockComment = false; i++; } continue; }
                    if (quote) { if (ch === '\\') { i++; continue; } if (ch === quote) quote = ''; continue; }
                    if (ch === '/' && nx === '/') { lineComment = true; i++; continue; }
                    if (ch === '/' && nx === '*') { blockComment = true; i++; continue; }
                    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
                    if (pairs[ch]) stack.push(pairs[ch]);
                    else if (stack.length && ch === stack[stack.length - 1]) stack.pop();
                    else if (!stack.length && ch === ';') return i;
                }
                return s.length;
            };
            const defRe = /\b(?:const|let|var)\s+([A-Za-z_$\u3400-\u9fff][\w$\u3400-\u9fff]*)\s*(?:\:[^=;]+)?=/g;
            let dm;
            while ((dm = defRe.exec(text))) {
                const start = defRe.lastIndex;
                const end = readInitializerEnd(text, start);
                definitions[dm[1]] = text.slice(start, end).trim();
                defRe.lastIndex = Math.max(defRe.lastIndex, end + 1);
            }
            const stripOuter = raw => {
                let s = String(raw || '').trim().replace(/\s+(?:as\s+const|satisfies\s+[\s\S]+)$/g, '').trim();
                while (s[0] === '(') {
                    const end = readBalancedEnd(s, 0, '(', ')');
                    if (end !== s.length - 1) break;
                    s = s.slice(1, -1).trim();
                }
                return s;
            };
            const literal = raw => {
                const s = stripOuter(raw);
                if (s === 'undefined') return undefined;
                try { return getMvuYamlLibs().JSON5.parse(s); } catch (e) {}
                if (/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(s)) return Number(s);
                if (s === 'true') return true;
                if (s === 'false') return false;
                if (s === 'null') return null;
                const q = s.match(/^(?:"([\s\S]*)"|'([\s\S]*)')$/);
                return q ? (q[1] !== undefined ? q[1] : q[2]) : undefined;
            };
            const topColon = s => {
                let quote = '', depth = 0;
                for (let i = 0; i < s.length; i++) {
                    const ch = s[i];
                    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
                    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
                    if (ch === '(' || ch === '[' || ch === '{') depth++;
                    else if (ch === ')' || ch === ']' || ch === '}') depth--;
                    else if (ch === ':' && depth === 0) return i;
                }
                return -1;
            };
            const cloneNode = node => node ? JSON.parse(JSON.stringify(node)) : node;
            const parseExpr = (raw, path, resolving) => {
                let s = stripOuter(raw).replace(/^\s*\/\*[\s\S]*?\*\//, '').trim();
                const ref = s.match(/^([A-Za-z_$\u3400-\u9fff][\w$\u3400-\u9fff]*)(?:\.shape)?\s*$/);
                if (ref && definitions[ref[1]] && !(resolving || new Set()).has(ref[1])) {
                    const next = new Set(resolving || []); next.add(ref[1]);
                    const node = parseExpr(definitions[ref[1]], path, next);
                    return cloneNode(node);
                }
                const lazy = s.match(/^(?:[A-Za-z_$][\w$]*\.)?z\.lazy\s*\(\s*\(\s*\)\s*=>\s*([A-Za-z_$\u3400-\u9fff][\w$\u3400-\u9fff]*)\s*\)/);
                if (lazy && definitions[lazy[1]] && !(resolving || new Set()).has(lazy[1])) {
                    const next = new Set(resolving || []); next.add(lazy[1]);
                    return parseExpr(definitions[lazy[1]], path, next);
                }
                const preprocess = s.match(/^(?:[A-Za-z_$][\w$]*\.)?z\.preprocess\s*\(/);
                if (preprocess) {
                    const preOpen = s.indexOf('(', preprocess[0].length - 1);
                    const preClose = readBalancedEnd(s, preOpen, '(', ')');
                    if (preClose >= 0) {
                        const preArgs = splitJsTopLevelArgs(s.slice(preOpen + 1, preClose));
                        unsupported.push({ path: path.join('.'), kind: 'preprocess', expression: String(preArgs[0] || '').trim().slice(0, 160) });
                        if (preArgs.length >= 2) return parseExpr(preArgs[preArgs.length - 1] + s.slice(preClose + 1), path, resolving);
                    }
                }
                const call = s.match(/^(?:(?:[A-Za-z_$][\w$]*\.)?z\.)?(coerce\.)?(object|record|array|string|number|boolean|enum|literal|any|unknown)\s*\(/);
                if (!call) return null;
                const open = s.indexOf('(', call.index + call[0].length - 1);
                const close = readBalancedEnd(s, open, '(', ')');
                if (close < 0) return null;
                const args = splitJsTopLevelArgs(s.slice(open + 1, close));
                const kind0 = call[2];
                let node;
                if (kind0 === 'object') {
                    node = { kind: 'object', fields: {}, dynamic: false };
                    const body = String(args[0] || '').trim();
                    if (body[0] === '{' && body[body.length - 1] === '}') {
                        for (const rawPart of splitJsTopLevelArgs(body.slice(1, -1))) {
                            const part = String(rawPart || '').replace(/^\s*(?:\/\*[\s\S]*?\*\/\s*)+/, '').trim();
                            if (!part) continue;
                            if (part.startsWith('...')) {
                                const spreadRaw = part.slice(3).trim().replace(/\.shape$/, '');
                                const spread = parseExpr(spreadRaw, path, resolving);
                                if (spread && spread.kind === 'object') Object.assign(node.fields, cloneNode(spread.fields));
                                else unsupported.push({ path: path.join('.'), kind: '对象展开', expression: part.slice(0, 160) });
                                continue;
                            }
                            const ci = topColon(part);
                            if (ci < 0) continue;
                            const key = part.slice(0, ci).trim().replace(/^['"]|['"]$/g, '');
                            const childRaw = part.slice(ci + 1);
                            const child = parseExpr(childRaw, [...path, key], resolving);
                            if (key && child) node.fields[key] = child;
                            else if (key && /\bz\s*\.|\.z\s*\./.test(childRaw)) unsupported.push({ path: [...path, key].join('.'), kind: 'Schema 表达式', expression: childRaw.trim().slice(0, 160) });
                        }
                    }
                } else if (kind0 === 'record') {
                    const valueArg = args.length > 1 ? args[1] : args[0];
                    const keyNode = args.length > 1 ? parseExpr(args[0], [...path, '<键>'], resolving) : null;
                    const valuePath = [...path, '<动态键>'];
                    const valueNode = parseExpr(valueArg, valuePath, resolving);
                    if (!valueNode && /\bz\s*\.|\.z\s*\./.test(String(valueArg || ''))) unsupported.push({ path: valuePath.join('.'), kind: 'Schema 表达式', expression: String(valueArg).trim().slice(0, 160) });
                    node = { kind: 'object', fields: {}, dynamic: true, keySchema: keyNode, value: valueNode || { kind: 'text' } };
                } else if (kind0 === 'array') {
                    const elementPath = [...path, '<元素>'];
                    const elementNode = parseExpr(args[0], elementPath, resolving);
                    if (!elementNode && /\bz\s*\.|\.z\s*\./.test(String(args[0] || ''))) unsupported.push({ path: elementPath.join('.'), kind: 'Schema 表达式', expression: String(args[0]).trim().slice(0, 160) });
                    node = { kind: 'array', element: elementNode || { kind: 'text' } };
                } else if (kind0 === 'enum') {
                    const vals = literal(args[0]);
                    node = { kind: 'text', enum: Array.isArray(vals) ? vals : [] };
                } else if (kind0 === 'literal') {
                    const v = literal(args[0]);
                    node = { kind: typeof v === 'number' ? 'number' : (typeof v === 'boolean' ? 'boolean' : 'text'), enum: [v] };
                } else {
                    node = { kind: kind0 === 'string' ? 'text' : (kind0 === 'any' || kind0 === 'unknown' ? 'text' : kind0) };
                    if (call[1]) node.coerce = true;
                }
                let tail = s.slice(close + 1).trim();
                while (tail.startsWith('.')) {
                    const mm = tail.match(/^\.([A-Za-z_$][\w$]*)\s*\(/);
                    if (!mm) break;
                    const opOpen = tail.indexOf('(', mm[0].length - 1);
                    const opClose = readBalancedEnd(tail, opOpen, '(', ')');
                    if (opClose < 0) break;
                    const op = mm[1], opRaw = tail.slice(opOpen + 1, opClose), opArgs = splitJsTopLevelArgs(opRaw);
                    if (op === 'min') node.min = Number(literal(opArgs[0]));
                    else if (op === 'max') node.max = Number(literal(opArgs[0]));
                    else if (op === 'describe') node.desc = String(literal(opArgs[0]) ?? '');
                    else if (op === 'default' || op === 'prefault') {
                        const v = literal(opArgs[0]);
                        if (v !== undefined) { node.hasDefault = true; node.defaultValue = v; node.defaultKind = op; }
                        else unsupported.push({ path: path.join('.'), kind: op, expression: opRaw.slice(0, 160) });
                    } else if (op === 'transform') {
                        const clamp = opRaw.match(/_\.clamp\s*\([^,]+,\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\s*,\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\s*\)/);
                        if (clamp) { node.min = Number(clamp[1]); node.max = Number(clamp[2]); node.clampTransform = true; }
                        else unsupported.push({ path: path.join('.'), kind: 'transform', expression: opRaw.slice(0, 160) });
                    } else if (op === 'refine' || op === 'superRefine' || op === 'preprocess' || op === 'pipe') {
                        unsupported.push({ path: path.join('.'), kind: op, expression: opRaw.slice(0, 160) });
                    } else if (op === 'extend' && node.kind === 'object') {
                        const ext = parseExpr('z.object(' + String(opArgs[0] || '{}') + ')', path, resolving);
                        if (ext) Object.assign(node.fields, ext.fields || {});
                    } else if (op === 'merge' && node.kind === 'object') {
                        const ext = parseExpr(opArgs[0], path, resolving);
                        if (ext && ext.kind === 'object') Object.assign(node.fields, cloneNode(ext.fields));
                    } else {
                        unsupported.push({ path: path.join('.'), kind: op, expression: opRaw.slice(0, 160) });
                    }
                    tail = tail.slice(opClose + 1).trim();
                }
                return node;
            };
            const aliases = ['registerMvuSchema'];
            const aliasM = text.match(/registerMvuSchema\s+as\s+([A-Za-z_$][\w$]*)/);
            if (aliasM) aliases.push(aliasM[1]);
            let root = null;
            for (const name of aliases) {
                const re = new RegExp('\\b' + name.replace(/[$]/g, '\\$&') + '\\s*\\(', 'g');
                let m;
                while ((m = re.exec(text))) {
                    const open = text.indexOf('(', m.index);
                    const close = readBalancedEnd(text, open, '(', ')');
                    if (close < 0) continue;
                    const args = splitJsTopLevelArgs(text.slice(open + 1, close));
                    const candidate = parseExpr(args[0], [], new Set());
                    if (candidate && candidate.kind === 'object') root = mergeZodSchemaNodes(root, candidate);
                }
            }
            return root ? { root, unsupported } : null;
        }
    
    function mergeZodSchemaNodes(base, incoming) {
            if (!base) return incoming ? JSON.parse(JSON.stringify(incoming)) : null;
            if (!incoming || base.kind !== incoming.kind) return base;
            const out = JSON.parse(JSON.stringify(base));
            if (out.kind === 'object') {
                out.dynamic = !!(out.dynamic || incoming.dynamic);
                out.fields = out.fields || {};
                for (const [key, child] of Object.entries(incoming.fields || {})) out.fields[key] = mergeZodSchemaNodes(out.fields[key], child) || child;
                if (incoming.value) out.value = mergeZodSchemaNodes(out.value, incoming.value) || incoming.value;
                if (incoming.keySchema) out.keySchema = mergeZodSchemaNodes(out.keySchema, incoming.keySchema) || incoming.keySchema;
            }
            for (const key of ['min', 'max', 'enum', 'desc', 'hasDefault', 'defaultValue', 'defaultKind', 'coerce', 'clampTransform']) {
                if (incoming[key] !== undefined) out[key] = incoming[key];
            }
            return out;
        }
    
    function countZodSchemaFlag(root, flag) {
            let count = 0;
            const seen = new Set();
            const walk = node => {
                if (!node || typeof node !== 'object' || seen.has(node)) return;
                seen.add(node);
                if (node[flag]) count++;
                for (const child of Object.values(node.fields || {})) walk(child);
                walk(node.keySchema);
                walk(node.value);
                walk(node.element);
            };
            walk(root);
            return count;
        }
    
    function mergeRegisteredZodIntoShapeInfo(root, acc) {
            const addNodeFields = (target, node) => {
                const row = node && node.dynamic && node.value && node.value.kind === 'object' ? node.value : node;
                if (!row || row.kind !== 'object') return;
                acc.shapes[target] = acc.shapes[target] || [];
                acc.fieldTypes[target] = acc.fieldTypes[target] || {};
                acc.objectSchemas[target] = acc.objectSchemas[target] || {};
                for (const [field, child] of Object.entries(row.fields || {})) {
                    if (!acc.shapes[target].includes(field)) acc.shapes[target].push(field);
                    acc.fieldTypes[target][field] = child.kind;
                    if (child.kind === 'object' || child.kind === 'array') acc.objectSchemas[target][field] = child;
                    if (child.kind === 'number') acc.numericFields.add(field);
                    if (Number.isFinite(child.min) && Number.isFinite(child.max)) acc.ranges[field] = [child.min, child.max];
                    if (Array.isArray(child.enum) && child.enum.length >= 2) acc.enums[field] = child.enum.slice();
                    if (child.desc) { acc.zodDescs[target] = acc.zodDescs[target] || {}; acc.zodDescs[target][field] = child.desc; }
                    if (child.kind === 'object' && child.dynamic) {
                        acc.dynamicDicts[target] = acc.dynamicDicts[target] || {};
                        acc.dynamicDicts[target][field] = true;
                        const dynamicPath = [target, field].join('.');
                        acc.dynamicPaths.add(dynamicPath);
                        if (child.keySchema && child.keySchema.desc && isSchemaFieldName(child.keySchema.desc)) acc.dynamicKeyNames[dynamicPath] = child.keySchema.desc;
                        addNodeFields(field, child);
                    }
                }
            };
            for (const [group, node] of Object.entries(root.fields || {})) {
                if (!node) continue;
                if (node.kind === 'object' && node.dynamic) {
                    acc.dynamicGroups.add(group);
                    acc.dynamicPaths.add(group);
                    if (node.keySchema && node.keySchema.desc && isSchemaFieldName(node.keySchema.desc)) acc.dynamicKeyNames[group] = node.keySchema.desc;
                }
                addNodeFields(group, node);
            }
        }
    
    function applyRegisteredZodDefaults(data, root) {
            let count = 0;
            const clone = value => {
                try { return JSON.parse(JSON.stringify(value)); } catch (e) { return value; }
            };
            const walk = (value, node) => {
                if (!node) return value;
                if (value === undefined && node.hasDefault) { value = clone(node.defaultValue); count++; }
                if (node.kind === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
                    if (node.dynamic && node.value) {
                        for (const key of Object.keys(value)) value[key] = walk(value[key], node.value);
                    } else {
                        for (const [key, child] of Object.entries(node.fields || {})) {
                            const next = walk(value[key], child);
                            if (next !== undefined) value[key] = next;
                        }
                    }
                } else if (node.kind === 'array' && Array.isArray(value) && node.element) {
                    for (let i = 0; i < value.length; i++) value[i] = walk(value[i], node.element);
                }
                return value;
            };
            walk(data, root);
            return count;
        }
    
    function scanGreetingShapeVariation(data, extraBranchSources = []) {
            const dynamicPaths = new Set();
            const dynamicGroups = new Set();
            // 动态键路径 → 第一个非空样本值（供“首个分支为空字典、其他分支才有条目”的
            // 动态字典做结构/标量类型推断，例如 仓库 首分支为 {} 但次分支为 {物品: 数量}）。
            const samples = new Map();
            const sources = [
                data.first_mes,
                ...(Array.isArray(data.alternate_greetings) ? data.alternate_greetings : []),
                ...extraBranchSources,
            ];
            const parsedList = [];
            for (const g of sources) {
                const m = String(g || '').match(/<initvar>\s*\n?([\s\S]*?)\n?\s*<\/initvar>/i);
                if (!m) continue;
                try {
                    const p = parseInitVar(m[1]);
                    if (p && typeof p === 'object' && !Array.isArray(p)) parsedList.push(analyzeMvuInitMetadata(p).data);
                } catch (e) {}
            }
            if (parsedList.length < 2) return { dynamicPaths, dynamicGroups, samples };
            const keySets = new Map(); // path -> Map<keySetStr, count>
            const walk = (obj, path) => {
                for (const k of Object.keys(obj)) {
                    const v = obj[k];
                    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
                    const p = path.concat([k]);
                    const keyStr = Object.keys(v).sort().join('\u0000');
                    const pStr = p.join('.');
                    if (Object.keys(v).length > 0 && !samples.has(pStr)) samples.set(pStr, v);
                    if (!keySets.has(pStr)) keySets.set(pStr, new Map());
                    const m2 = keySets.get(pStr);
                    m2.set(keyStr, (m2.get(keyStr) || 0) + 1);
                    walk(v, p);
                }
            };
            for (const p of parsedList) walk(p, []);
            for (const [pStr, m2] of keySets) {
                if (m2.size > 1) {
                    // 只标记嵌套路径（深度≥2）为动态键字典：顶层组的键集差异更可能是
                    // “可选字段”（如 主角.{修为, 灵石?} 分支间字段略不同），而不是条目字典，
                    // 误判成行表会破坏单例结构。顶层动态组由 [mvu_update] 的 { [键]: value }
                    // 声明负责（见 parseMvuShapes 的 dynamicGroups）。
                    if (pStr.indexOf('.') >= 0) dynamicPaths.add(pStr);
                }
            }
            return { dynamicPaths, dynamicGroups, samples };
        }
    
    function extractListItems(text) {
            const items = [];
            const re = /(?:^|\n)\s*-\s+([^\n]+)/g;
            let m;
            while ((m = re.exec(text))) items.push(m[1].trim());
            return items;
        }
    
    function stripRuleQuotes(s) {
            let t = String(s || '').trim();
            if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
                t = t.slice(1, -1).trim();
            }
            return t;
        }
    
    function scanDynamicKeyNamesFromRules(content, target) {
            const out = target || {};
            const lines = String(content || '').split('\n');
            const stack = [];
            const reserved = new Set(['type', 'check', 'format', 'range', 'enum', 'note', 'description', 'unit']);
            const cleanKey = raw => String(raw || '').trim().replace(/^['"]|['"]$/g, '');
            const pathStack = () => stack.map(x => x.key).filter(k => k !== '变量更新规则' && k !== '变量输出格式');
            const directType = (at, indent) => {
                for (let j = at + 1; j < lines.length; j++) {
                    if (!lines[j].trim()) continue;
                    const im = lines[j].match(/^(\s*)/);
                    const ji = im ? im[1].length : 0;
                    if (ji <= indent) break;
                    const tm = lines[j].match(/^(\s*)type\s*:\s*(.*)$/);
                    if (!tm || tm[1].length !== indent + 2) continue;
                    const tail = String(tm[2] || '').trim();
                    if (!/^[|>]-?$/.test(tail)) return tail;
                    const body = [];
                    for (let k = j + 1; k < lines.length; k++) {
                        const km = lines[k].match(/^(\s*)/);
                        const ki = km ? km[1].length : 0;
                        if (lines[k].trim() && ki <= tm[1].length) break;
                        body.push(lines[k]);
                    }
                    return body.join('\n');
                }
                return '';
            };
            for (let i = 0; i < lines.length; i++) {
                const m = lines[i].match(/^(\s*)(?!-\s)([^:#\n][^:\n]*?)\s*:\s*(.*)$/);
                if (!m) continue;
                const indent = m[1].length;
                const key = cleanKey(m[2]);
                while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
                if (!key || reserved.has(key)) continue;
                const prefix = pathStack();
                const typeText = directType(i, indent);
                const indexSig = typeText.match(/\[\s*([^:\]\n]+?)\s*:\s*[^\]\n]+\]\s*:/);
                if (indexSig) {
                    const keyName = cleanKey(indexSig[1]);
                    if (/^[\u3400-\u9fffA-Za-z_$][\u3400-\u9fffA-Za-z0-9_$]{0,31}$/.test(keyName)) {
                        const template = key.match(/^\$\{([^}]+)\}$/);
                        const keys = template
                            ? template[1].split(/[|/]/).map(cleanKey).filter(k => /^[\u3400-\u9fffA-Za-z0-9_$-]{1,32}$/.test(k))
                            : [key];
                        for (const actualKey of keys) out[[...prefix, actualKey].join('.')] = keyName;
                    }
                }
                stack.push({ indent, key });
            }
            return out;
        }
    
    function parseZodStyleRules(content) {
            const root = String(content || '').indexOf('z.object({');
            if (root === -1) return null;
            const out = {};
            // 越过 'z.object(' 到达根 '{'
            let pos = root + 'z.object('.length;
            const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
            const skipWs = () => { while (pos < content.length && isWs(content[pos])) pos++; };
            const skipComment = () => {
                if (content.startsWith('/**', pos) || content.startsWith('/*', pos)) {
                    const end = content.indexOf('*/', pos + 2);
                    if (end === -1) return '';
                    const c = content.slice(pos, end + 2);
                    pos = end + 2;
                    return c;
                }
                if (content.startsWith('//', pos)) {
                    const end = content.indexOf('\n', pos);
                    if (end === -1) return '';
                    const c = content.slice(pos, end);
                    pos = end;
                    return c;
                }
                return '';
            };
            const readKey = () => {
                skipWs();
                let key = '';
                while (pos < content.length && !isWs(content[pos]) &&
                    content[pos] !== ':' && content[pos] !== '}' && content[pos] !== ',' && content[pos] !== '(') {
                    key += content[pos];
                    pos++;
                }
                return key.replace(/^["']|["']$/g, '').trim();
            };
            const checksFromComment = (comment) => {
                const lines = String(comment).split('\n')
                    .map(l => l.replace(/\*\/\s*$/, '').replace(/^\s*\/\*+/, '').replace(/^\s*\*/, '').trim())
                    .filter(Boolean);
                const items = [];
                let inCheck = false;
                for (const l of lines) {
                    if (/^check\s*:/.test(l)) { inCheck = true; continue; }
                    if (!inCheck) continue;
                    const m = l.match(/^-\s+(.+)$/);
                    if (m) items.push(m[1].trim());
                    else if (l) items.push(l);
                }
                return items;
            };
            const parseObject = () => {
                const obj = {};
                while (pos < content.length) {
                    skipWs();
                    const pre = skipComment();
                    skipWs();
                    if (content[pos] === '}') { pos++; break; }
                    if (content[pos] === ',') { pos++; continue; }
                    const key = readKey();
                    skipWs();
                    if (content[pos] !== ':') { pos++; continue; }
                    pos++;
                    skipWs();
                    const pre2 = skipComment();
                    skipWs();
                    if (content.startsWith('z.object({', pos)) {
                        pos += 'z.object('.length;
                        skipWs();
                        if (content[pos] === '{') {
                            pos++;
                            const child = parseObject();
                            obj[key] = { checks: checksFromComment(pre || pre2), object: child };
                        }
                    } else {
                        const leafStart = pos;
                        let depth = 0;
                        while (pos < content.length) {
                            const ch = content[pos];
                            if (ch === '(' || ch === '{' || ch === '[') depth++;
                            else if (ch === ')' || ch === '}' || ch === ']') { if (depth === 0) break; depth--; }
                            else if ((ch === ',' || ch === ';') && depth === 0) break;
                            pos++;
                        }
                        // zod/TS 数值约束：z.number().min(0).max(100) → 提取范围，供 DDL CHECK / note
                        const leafText = content.slice(leafStart, pos);
                        const minM = leafText.match(/\.min\(\s*(-?[\d.]+)\s*\)/);
                        const maxM = leafText.match(/\.max\(\s*(-?[\d.]+)\s*\)/);
                        const enumM = leafText.match(/z\.enum\(\s*\[([\s\S]*?)\]\s*\)/);
                        const describeM = leafText.match(/\.describe\(\s*["']([\s\S]*?)["']\s*\)/);
                        obj[key] = {
                            checks: checksFromComment(pre || pre2),
                            object: null,
                            min: minM ? Number(minM[1]) : null,
                            max: maxM ? Number(maxM[1]) : null,
                            enum: enumM ? String(enumM[1]).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : null,
                            desc: describeM ? describeM[1].trim() : '',
                        };
                    }
                }
                return obj;
            };
            skipWs();
            if (content[pos] === '{') pos++;
            const tree = parseObject();
            for (const g of Object.keys(tree)) {
                const gv = tree[g];
                if (!gv || !gv.object) continue;
                const fields = [];
                const gChecks = {};
                const gRanges = {};
                const gEnums = {};
                const gDescs = {};
                const pathRules = [];
                const collectPathRules = (node, prefix) => {
                    for (const key of Object.keys(node || {})) {
                        const fv = node[key];
                        const path = [g, ...(prefix || []), key];
                        if (fv && fv.checks && fv.checks.length) {
                            pathRules.push({ path, list: fv.checks.slice(), tableLevel: !!fv.object });
                        }
                        if (fv && fv.object) collectPathRules(fv.object, [...(prefix || []), key]);
                    }
                };
                collectPathRules(gv.object, []);
                for (const f of Object.keys(gv.object)) {
                    fields.push(f);
                    const fv = gv.object[f];
                    if (fv && fv.checks && fv.checks.length) gChecks[f] = fv.checks;
                    if (fv && fv.min !== null && fv.max !== null) gRanges[f] = [fv.min, fv.max];
                    if (fv && fv.enum && fv.enum.length) gEnums[f] = fv.enum;
                    if (fv && fv.desc) gDescs[f] = fv.desc;
                }
                if (fields.length || Object.keys(gChecks).length || Object.keys(gRanges).length || Object.keys(gEnums).length || Object.keys(gDescs).length) {
                    out[g] = { fields: [...new Set(fields)], checks: gChecks, ranges: gRanges, enums: gEnums, descs: gDescs, pathRules };
                }
            }
            return out;
        }
    
    function isSchemaFieldName(name) {
            return /^[\u3400-\u9fffA-Za-z_$][\u3400-\u9fffA-Za-z0-9_$]{0,31}$/.test(String(name || ''));
        }
    
    function mergeShapeMetadata(target, parsed, fieldTypes, objectSchemas, enumPaths, basePath) {
            if (!target || !parsed) return;
            fieldTypes[target] = fieldTypes[target] || {};
            objectSchemas[target] = objectSchemas[target] || {};
            for (const [field, kind] of Object.entries(parsed.fieldTypes || {})) fieldTypes[target][field] = kind;
            for (const [field, schema] of Object.entries(parsed.objectSchemas || {})) objectSchemas[target][field] = schema;
            // TS type 块中的字面量联合属于字段约束，按完整逻辑路径保留，避免同名列串表。
            if (Array.isArray(enumPaths)) {
                const walk = (node, path) => {
                    if (!node) return;
                    if (node.enum) enumPaths.push({ path, enum: node.enum.slice() });
                    if (node.kind === 'object') {
                        if (node.dynamic) walk(node.value, path);
                        for (const [field, child] of Object.entries(node.fields || {})) walk(child, [...path, field]);
                    }
                };
                walk(parsed.schema, basePath && basePath.length ? basePath : [target]);
            }
        }
    
    function parseTypeSchema(shapeStr) {
            const s = String(shapeStr || '')
                .replace(/\/\*[\s\S]*?\*\//g, ' ')
                .replace(/\/\/[^\n]*/g, ' ')
                .replace(/\n\s*(?=[\u3400-\u9fffA-Za-z_$][\u3400-\u9fffA-Za-z0-9_$]{0,31}\s*:)/g, ';');
            let i = 0;
            const skip = () => { while (i < s.length && /\s/.test(s[i])) i++; };
            const scalarNode = raw => {
                const t = String(raw || '').trim().replace(/[;,]+$/, '').trim();
                if (/^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')(?:\s*\|\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))+$/.test(t)) {
                    const values = t.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g).map(token => getMvuYamlLibs().JSON5.parse(token));
                    return { kind: 'text', raw: t, enum: [...new Set(values)] };
                }
                if (/^(?:number|integer)\b/i.test(t)) return { kind: 'number', raw: t };
                if (/^boolean\b/i.test(t)) return { kind: 'boolean', raw: t };
                // MVU/Zod 规则既会写具体结构 `{...}` / `T[]`，也常直接写宽类型
                // `object` / `array`。裸宽类型仍必须作为 JSON 列保存；误判为 text 会让
                // JSONPatch 写入的对象在读回时变成字符串，继而触发卡内 schema 校验失败。
                if (/^object\b/i.test(t)) return { kind: 'object', raw: t };
                if (/^array\b/i.test(t) || /\[\]\s*$/.test(t) || /^Array\s*</i.test(t)) return { kind: 'array', raw: t };
                return { kind: 'text', raw: t };
            };
            const parseValue = () => {
                skip();
                if (s[i] === '{') return parseObject();
                const start = i;
                let angle = 0;
                let quote = '';
                while (i < s.length) {
                    const ch = s[i];
                    if (quote) {
                        if (ch === '\\') { i += 2; continue; }
                        if (ch === quote) quote = '';
                        i++;
                        continue;
                    }
                    if (ch === '"' || ch === "'") { quote = ch; i++; continue; }
                    if (ch === '<') angle++;
                    else if (ch === '>' && angle) angle--;
                    if (angle === 0 && (ch === ';' || ch === ',' || ch === '}')) break;
                    i++;
                }
                return scalarNode(s.slice(start, i));
            };
            const parseObject = () => {
                if (s[i] !== '{') return null;
                i++;
                const node = { kind: 'object', fields: {}, dynamic: false, value: null };
                while (i < s.length) {
                    skip();
                    while (s[i] === ';' || s[i] === ',') { i++; skip(); }
                    if (s[i] === '}') { i++; break; }
                    if (s[i] === '[') {
                        let depth = 1;
                        i++;
                        while (i < s.length && depth) {
                            if (s[i] === '[') depth++;
                            else if (s[i] === ']') depth--;
                            i++;
                        }
                        skip();
                        if (s[i] === ':') i++;
                        node.dynamic = true;
                        node.value = parseValue();
                    } else {
                        const start = i;
                        let quote = '';
                        while (i < s.length) {
                            const ch = s[i];
                            if (quote) {
                                if (ch === '\\') { i += 2; continue; }
                                if (ch === quote) quote = '';
                                i++;
                                continue;
                            }
                            if (ch === '"' || ch === "'") { quote = ch; i++; continue; }
                            if (ch === ':' || ch === '}' || ch === ';' || ch === ',') break;
                            i++;
                        }
                        let key = s.slice(start, i).trim().replace(/^['"]|['"]$/g, '').replace(/\?$/, '').trim();
                        if (s[i] !== ':') {
                            if (s[i] === '}') { i++; break; }
                            i++;
                            continue;
                        }
                        i++;
                        const value = parseValue();
                        if (isSchemaFieldName(key)) node.fields[key] = value;
                    }
                    skip();
                    if (s[i] === ';' || s[i] === ',') i++;
                }
                return node;
            };
            skip();
            try { return s[i] === '{' ? parseObject() : null; } catch (e) { return null; }
        }
    
    function parseShapeString(shapeStr) {
            let s = String(shapeStr || '').trim();
            if (!/^\{/.test(s)) return null;
            // TS 结构声明常在每个字段后写 `// 说明`。这些注释若留在字符流里会与下一个
            // 字段一起进入 buf，使「品质/描述/作用/已装备」等字段名全部解析失败。
            s = s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
            // 联合类型行有时不写分号，下一字段直接换行开始；把这种字段边界补成分隔符。
            s = s.replace(/\n\s*(?=[\u4e00-\u9fff]{1,12}\s*:)/g, ';');
            let depth = 0;
            const fields = [];
            const objects = [];
            const dynamic = [];
            let i = 0;
            let buf = '';
            let inBracket = false;
            let hasDynamicKey = false;
            // 当前正在解析其值对象的 depth-1 字段（如 世界系统 类型里的 修仙秘闻）；
            // 若该值对象内部以动态键 [xxx: type] 开头，则该字段本身是动态键字典，
            // 不能展平成固定列，应由 collectColumns 拆成子行表。
            let pendingField = null;
            let pendingFieldDynamic = false;
            const collectDepth = () => (hasDynamicKey ? 2 : 1);
            const RESERVED_SCHEMA_TYPE_NAMES = new Set([
                'string', 'number', 'boolean', 'object', 'array', 'any', 'unknown',
                'never', 'void', 'null', 'undefined', 'integer', 'bigint', 'symbol',
            ]);
            function flushField() {
                const t = buf.trim();
                buf = '';
                if (!t) return;
                // 缓冲可能含多个字段（TS 声明用 ; 或 , 分隔，如 宗门: string; 境界: string;）：
                // 逐段提取，不能只取第一段（否则对象值动态字典的条目字段只建出第一列）。
                const segments = String(t).split(/[;,]/).map(s => s.trim()).filter(Boolean);
                for (const seg of segments) {
                    // `[货币名: string]: number` / `[物品名: string]: {...}` 是动态字典声明，
                    // 值类型 number/string 不是字段名，不能收进 shapes。
                    if (/^\[.*?\]\s*:/.test(seg)) continue;
                    let name = seg.replace(/^\[.*?\]\s*:\s*/, '').trim();
                    name = name.split(':')[0].replace(/^["']|["']$/g, '').trim();
                    if (RESERVED_SCHEMA_TYPE_NAMES.has(name)) continue;
                    if (name && isSchemaFieldName(name) && !fields.includes(name)) fields.push(name);
                }
            }
            for (; i < s.length; i++) {
                const ch = s[i];
                if (ch === '{') {
                    if (depth > 0) {
                        // 只在“行对象本层”提取字段。更深层对象（如
                        // 人物.生命值.上限）中的 当前/基础/额外 属于嵌套路径，不能进入
                        // 人物父表的根字段集合。无类型简写 `{ 性别, 境界, ... }` 仍由
                        // 本层 legacy 扫描补齐，作为 parseTypeSchema 的兼容兜底。
                        if (depth !== collectDepth()) {
                            buf = '';
                            depth++;
                            continue;
                        }
                        // 嵌套对象字段：buf 末尾的 key 记为对象字段
                        const rawKey = buf.trim();
                        // 先提取 buf 里累积的多个标量字段（如 名称: string; 等级: number; …），
                        // 旧实现只取 split(':')[0] 的第一个 key，其余字段全部丢失
                        // （大荒 宗门 type：等级/阵营/宗旨/声望/风气/通缉 全丢，只剩 名称）。
                        flushField();
                        // 嵌套键名取“最后一段”（如 …通缉: number; 资源: 的 资源）：
                        // 旧实现取第一个冒号前（名称），把标量字段名误当嵌套对象键。
                        const rawSegs = rawKey.split(/[;,]/).map(s => s.trim()).filter(Boolean);
                        const lastSeg = rawSegs.length ? rawSegs[rawSegs.length - 1] : rawKey;
                        const key = lastSeg.replace(/^["']|["']$/g, '').split(':')[0].trim();
                        if (depth === 1 && (/^\[.*\]$/.test(key) || /^\[.*?\]\s*:/.test(rawKey))) {
                            // { [动态键]: { ... } }：对象值动态字典。旧实现只在顶层 } 用残留
                            // 缓冲区判断，但对象值字典的残留是条目字段（宗门/描述…）而不是
                            // [键] 前缀 → dynamicTop 恒 false → dynamicDicts 漏标 → 无初始数据
                            // 的组（路遇道友录）不建表、规则孤儿。这里在进入值对象时用原始键
                            // 提前判定动态键（兼容 key 被 split(':') 截断的问题）。
                            hasDynamicKey = true;
                        } else if (key && isSchemaFieldName(key) && depth === collectDepth()) {
                            if (!fields.includes(key)) fields.push(key);
                            if (!objects.includes(key)) objects.push(key);
                            if (depth === 1) {
                                pendingField = key;
                                pendingFieldDynamic = false;
                            }
                        }
                        buf = '';
                    } else {
                        pendingField = null;
                        pendingFieldDynamic = false;
                    }
                    depth++;
                    continue;
                }
                if (ch === '}') {
                    const inner = buf.trim();
                    if (depth === collectDepth()) flushField();
                    else if (depth > collectDepth()) buf = ''; // 嵌套子对象内部字段不提取为列，清空避免串扰下一入口
                    // 离开某个值对象时判定它是否为动态键字典（{ [键: type]: value }）：
                    //  - depth 2：字段的值对象内部（如 修仙秘闻: { [秘闻简述: string]: string; }）
                    //  - depth 1：整个 shape 字符串顶层（如 组 type: { [道具名: string]: {...} }）
                    if (depth === 2) {
                        if (/^\[.*?\]\s*:/.test(inner)) pendingFieldDynamic = true;
                    } else if (depth === 1) {
                        if (pendingField && pendingFieldDynamic && !dynamic.includes(pendingField)) dynamic.push(pendingField);
                        pendingField = null;
                        pendingFieldDynamic = false;
                        if (!hasDynamicKey && /^\[.*?\]\s*:/.test(inner)) hasDynamicKey = true;
                    }
                    depth = Math.max(0, depth - 1);
                    if (depth === 0) {
                        break;
                    }
                    continue;
                }
                if (ch === '[') { inBracket = true; buf += ch; continue; }
                if (ch === ']') { inBracket = false; buf += ch; continue; }
                if (inBracket) { buf += ch; continue; }
                if (ch === ',') {
                    if (depth === collectDepth()) flushField();
                    continue;
                }
                buf += ch;
            }
            if (depth === collectDepth()) flushField();
            const schema = parseTypeSchema(s);
            const rowSchema = schema && schema.dynamic && schema.value && schema.value.kind === 'object' ? schema.value : schema;
            const fieldTypes = {};
            const objectSchemas = {};
            if (rowSchema && rowSchema.kind === 'object') {
                for (const name of Object.keys(rowSchema.fields || {})) {
                    const child = rowSchema.fields[name];
                    if (!fields.includes(name)) fields.push(name);
                    fieldTypes[name] = child && child.kind ? child.kind : 'text';
                    if (child && (child.kind === 'object' || child.kind === 'array')) {
                        if (!objects.includes(name)) objects.push(name);
                        objectSchemas[name] = child;
                    }
                    if (child && child.kind === 'object' && child.dynamic && !dynamic.includes(name)) dynamic.push(name);
                }
            }
            if (schema && schema.dynamic) hasDynamicKey = true;
            // 对动态字典 `{ [角色]: { ...人物字段 } }`，物理行对应的是 value 对象，
            // 因此“本层字段”必须取 rowSchema，而不是外层 schema（外层没有固定字段）。
            // 旧逻辑在 topFields 为空时回退 legacy fields；legacy 扫描器会同时收集
            // 背包/装备/技能等嵌套对象的叶子，导致「品质、数量、效果」被误提升到人物父表。
            // legacy 扫描保留作者声明顺序；结构化 schema 随后只补它能解析、但 legacy
            // 未识别的本层字段。
            const topFields = fields.slice();
            if (rowSchema && rowSchema.kind === 'object') {
                for (const name of Object.keys(rowSchema.fields || {})) {
                    if (!topFields.includes(name)) topFields.push(name);
                }
            }
            // TS 风格允许省略叶子类型（`{ 性别, 境界, 关系 }`），结构化解析器会
            // 忽略这类成员；经上方深度约束后的 legacy fields 仅含本层字段，可安全合并。
            const topObjects = topFields.filter(name => objects.includes(name));
            return { fields, objects, dynamic, dynamicTop: hasDynamicKey, fieldTypes, objectSchemas, schema, topFields, topObjects };
        }
    
    function extractYamlBlockScalar(text, key) {
            const re = new RegExp('(?:^|\\n)([ \\t]*)' + String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*[|>]-?\\s*\\n');
            const m = re.exec(String(text || ''));
            if (!m) return null;
            const indent = m[1].length;
            const rest = String(text).slice(m.index + m[0].length);
            const lines = rest.split('\n');
            const out = [];
            for (const ln of lines) {
                const km = ln.match(/^([ \t]*)([^\s:][^\n:]*)\s*:/);
                if (km && km[1].length <= indent) break;
                out.push(ln);
            }
            return out.join('\n');
        }
    
    function cardTextBlobs(card) {
            const blobs = [];
            const d = card.data || card;
            const push = (label, text) => { if (text) blobs.push({ label, text: String(text) }); };
            const ext = d.extensions || {};
            (ext.regex_scripts || []).forEach((r, i) => {
                push(`regex:${r.scriptName || i}`, (r.replaceString || '') + '\n' + (r.findRegex || ''));
            });
            const th = ext.tavern_helper || {};
            (th.scripts || []).forEach((s, i) => push(`script:${s.name || i}`, s.content || ''));
            push('first_mes', d.first_mes);
            (d.alternate_greetings || []).forEach((g, i) => push(`greeting:${i}`, g));
            (d.character_book?.entries || []).forEach((e, i) => push(`lore:${e.comment || i}`, e.content || ''));
            return blobs;
        }
    
    function scanStatusUsage(card, groupNames) {
            const usage = {};
            const usageTypes = {};
            Object.defineProperty(usage, '__types', { value: usageTypes, enumerable: false });
            const addField = (group, field, kind) => {
                if (!field || !isSchemaFieldName(field)) return;
                if (!usage[group]) usage[group] = [];
                if (!usage[group].includes(field)) usage[group].push(field);
                if (kind) {
                    usageTypes[group] = usageTypes[group] || {};
                    usageTypes[group][field] = kind;
                }
            };
    
            // 已知组名来自 initvar 顶层键（扫描只针对这些组做归属）
            const knownGroups = new Set(Array.isArray(groupNames) ? groupNames : []);
    
            const blobs = cardTextBlobs(card);
            const varToGroup = {};
            // 嵌套对象变量：var → { group, field }，表示 var 是 group[field] 的对象值
            const nestedVar = {};
            // entries 数组变量：var = Object.entries(组变量)
            const entriesArrayVars = new Set();
    
            // 阶段1：直接 stat 映射（只跑一轮即可稳定）
            for (const { text } of blobs) {
                // EJS 条件里的 getvar('stat_data.组.条目.字段') / getvar('stat_data.组.字段')
                const reGetvar = /getvar\s*\(\s*['"]stat_data\.([\u4e00-\u9fff]+)(?:\.([\u4e00-\u9fff]+)(?:\.([\u4e00-\u9fff]+))?)?['"]/g;
                let gm;
                while ((gm = reGetvar.exec(text))) {
                    const group = gm[1];
                    if (!knownGroups.has(group)) continue;
                    // 三段式 组.条目.字段 → 条目行表的列；两段式 组.字段 → 单例列（若 initvar 已含则跳过重复）
                    const field = gm[3] || gm[2];
                    if (field) addField(group, field);
                }
                // const X = ...stat_data.组[键].字段...  → 嵌套对象；只到组 → 组变量
                const re1 = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:all_variables|getAllVariables\(\))?[^;\n]*?\bstat_data\s*\.\s*([\u4e00-\u9fff]+)((?:\[[^\]]*\])*)((?:\s*\.\s*[\u4e00-\u9fff]+)*)/g;
                let m;
                while ((m = re1.exec(text))) {
                    const v = m[1], g = m[2];
                    if (!knownGroups.has(g)) continue;
                    const tail = (m[4] || '').trim();
                    if (tail === '') varToGroup[v] = g;
                    else nestedVar[v] = { group: g, field: tail.replace(/^\s*\.\s*/, '') };
                }
                // const X = stat.组 / const X = (stat.组 || {})[键] / const X = stat.组[键]
                const re1b = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\(?\s*stat\s*\.\s*([\u4e00-\u9fff]+)\s*\)?|stat\s*\.\s*([\u4e00-\u9fff]+))\s*(?:\|\|\s*\{\}\s*)?(\[[^\]]*\])?((?:\s*\.\s*[\u4e00-\u9fff]+)*)/g;
                while ((m = re1b.exec(text))) {
                    const g = m[2] || m[3];
                    if (!knownGroups.has(g)) continue;
                    const tail = (m[5] || '').trim();
                    if (tail === '') varToGroup[m[1]] = g;
                    else nestedVar[m[1]] = { group: g, field: tail.replace(/^\s*\.\s*/, '') };
                }
                // const X = <已映射>.子表名
                const re1c = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\.\s*([\u4e00-\u9fff]+)/g;
                while ((m = re1c.exec(text))) {
                    const parentGroup = varToGroup[m[2]];
                    if (parentGroup) varToGroup[m[1]] = m[3];
                }
                // const X = Object.entries(Y)（如 sortedBeauties）
                const re1d = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*Object\s*\.\s*entries\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
                while ((m = re1d.exec(text))) {
                    const srcGroup = varToGroup[m[2]];
                    if (srcGroup && knownGroups.has(srcGroup)) {
                        varToGroup[m[1]] = srcGroup;
                        entriesArrayVars.add(m[1]);
                    }
                }
            }
    
            // Tavern Helper/EJS 前端常用 get/list/val 封装而不直接读 stat_data：
            //   rootSect=get(d,'宗门'); s=rootSect[key]; val(s,'师尊')
            // 旧扫描只认 stat.组.字段，因而漏掉这些真正被前端消费的列。
            // 按每个前端 render 方法建立局部别名图，避免同一大段 HTML 里
            // sect/social/inventory 都用 item/s/n 时串组。
            for (const { text } of blobs) {
                const scopes = String(text).split(/(?=\b[A-Za-z_$][\w$]*\s*:\s*function\s*\(\s*d\s*\))/);
                for (const scopeText of scopes) {
                  const aliases = {};
                  let m;
                  const rootRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:get|list)\s*\(\s*d\s*,\s*['"]([^'"]+)['"]/g;
                  while ((m = rootRe.exec(scopeText))) {
                    const path = m[2].split(/[.]/).filter(Boolean);
                    const group = path[path.length - 1];
                    if (knownGroups.has(group)) aliases[m[1]] = { group, level: 0 };
                  }
                  let changed = true;
                  let rounds = 0;
                  while (changed && rounds++ < 6) {
                    changed = false;
                    const aliasRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g;
                    while ((m = aliasRe.exec(scopeText))) {
                        if (aliases[m[1]]) continue;
                        const rhs = m[2];
                        for (const [src, info] of Object.entries(aliases)) {
                            const escaped = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                            const indexed = new RegExp('\\b' + escaped + '\\b\\s*\\[[^\\]]+\\]').test(rhs);
                            const copied = new RegExp('\\b' + escaped + '\\b\\s*\\.(?:slice|filter|map)\\s*\\(').test(rhs);
                            if (indexed || copied) {
                                aliases[m[1]] = { group: info.group, level: indexed ? info.level + 1 : info.level };
                                changed = true;
                                break;
                            }
                        }
                    }
                    for (const [src, info] of Object.entries({ ...aliases })) {
                        const escaped = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        const callbackRe = new RegExp('\\b' + escaped + '\\s*\\.(?:forEach|map|filter|find|some|every)\\s*\\(\\s*(?:function\\s*\\(\\s*|\\(?\\s*)([A-Za-z_$][\\w$]*)', 'g');
                        let cm;
                        while ((cm = callbackRe.exec(scopeText))) {
                            if (!aliases[cm[1]]) { aliases[cm[1]] = { group: info.group, level: info.level + 1 }; changed = true; }
                        }
                    }
                  }
                  for (const [alias, info] of Object.entries(aliases)) {
                    if (info.level > 1) continue; // 如 s['人口'] 的 pop：其键属于 JSON 对象内部，不是宗门表列
                    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const valRe = new RegExp('val\\s*\\(\\s*' + escaped + '\\s*,\\s*[\'"]([^\'"]+)[\'"]', 'g');
                    let vm;
                    while ((vm = valRe.exec(scopeText))) {
                        const before = scopeText.slice(Math.max(0, vm.index - 24), vm.index);
                        const after = scopeText.slice(vm.index + vm[0].length, vm.index + vm[0].length + 32);
                        const numeric = /parseInt\s*\(\s*$|Number\s*\(\s*$/.test(before) || /^\s*,\s*-?\d+(?:\.\d+)?\s*\)/.test(after);
                        addField(info.group, vm[1], numeric ? 'number' : '');
                    }
                  }
                }
            }
    
            // 阶段2：多轮解析 forEach 条目（用于推导 itemVar 字段与嵌套变量）
            const forEachBlocks = [];
            for (const { text } of blobs) {
                const re4 = /Object\.entries\(\s*([A-Za-z_$][\w$]*)\s*\)(?:\s*\.\s*[A-Za-z_$][\w$]*\s*\((?:[^()]|\([^()]*\))*\))*\s*\.(?:forEach|map)\(\s*\(\s*\[[^,\]]+,\s*([A-Za-z_$][\w$]*)\]\)\s*=>\s*\{?([\s\S]{0,4000}?)\n\s*\}\);/g;
                let m;
                while ((m = re4.exec(text))) {
                    forEachBlocks.push({ srcVar: m[1], itemVar: m[2], body: m[3] });
                }
                // 已映射的 entries 数组变量直接 .forEach（如 sortedBeauties.forEach）
                const re4b = /([A-Za-z_$][\w$]*)\.(?:forEach|map)\(\s*\(\s*\[[^,\]]+,\s*([A-Za-z_$][\w$]*)\]\)\s*=>\s*\{?([\s\S]{0,4000}?)\n\s*\}\);/g;
                while ((m = re4b.exec(text))) {
                    if (entriesArrayVars.has(m[1])) {
                        forEachBlocks.push({ srcVar: m[1], itemVar: m[2], body: m[3] });
                    }
                }
            }
            let changed = true;
            let round = 0;
            while (changed && round++ < 5) {
                changed = false;
                for (const block of forEachBlocks) {
                    const group = varToGroup[block.srcVar];
                    if (nestedVar[block.srcVar]) continue; // 嵌套对象不归组
                    if (!group) continue;
                    // 推导嵌套变量：const Y = itemVar.字段（如 const history = data.历史记录）
                    const nestedRe = new RegExp('(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:' + block.itemVar + '|data)\\.([\\u4e00-\\u9fff]{1,12})', 'g');
                    let nm;
                    while ((nm = nestedRe.exec(block.body))) {
                        if (!nestedVar[nm[1]]) {
                            nestedVar[nm[1]] = { group, field: nm[2] };
                            changed = true;
                        }
                    }
                }
            }
    
            // 阶段3：成员访问收集（跳过嵌套对象变量）
            for (const { text } of blobs) {
                const re2 = /([A-Za-z_$][\w$]*)\.([\u4e00-\u9fff]{1,12})/g;
                let m;
                while ((m = re2.exec(text))) {
                    const v = m[1], field = m[2];
                    if (nestedVar[v]) continue; // 嵌套对象内部字段（如 record.发送者）不作为顶层列
                    const group = varToGroup[v];
                    if (group) addField(group, field);
                    else if (knownGroups.has(v)) addField(v, field);
                }
            }
    
            // 阶段4：forEach 条目字段（data.数量 之类），嵌套对象变量跳过
            for (const block of forEachBlocks) {
                const group = varToGroup[block.srcVar];
                if (!group || nestedVar[block.srcVar]) continue;
                const reItem = new RegExp('(?:' + block.itemVar + '|data)\\.([\\u4e00-\\u9fff]{1,12})', 'g');
                let im;
                while ((im = reItem.exec(block.body))) {
                    if (nestedVar[im[0].split('.')[0]]) continue;
                    addField(group, im[1]);
                }
            }
    
            // 阶段4：直接赋值给组/组变量的对象字面量键
            // 形如：stat.组[键] = { 字段: ... }
            for (const { text } of blobs) {
                const assignRe = /stat_data\s*\.\s*([\u4e00-\u9fff]+)(?:\s*\[[^\]]*\])*(?:\s*\.\s*[\u4e00-\u9fff]+)?\s*=\s*\{([^{}]*)\}/g;
                let m;
                while ((m = assignRe.exec(text))) {
                    const g = m[1];
                    if (!knownGroups.has(g)) continue;
                    const literal = m[2];
                    const keyRe = /["']?([\u4e00-\u9fff]{1,12})["']?\s*:/g;
                    let km;
                    while ((km = keyRe.exec(literal))) {
                        if (!knownGroups.has(km[1])) addField(g, km[1]);
                    }
                }
            }
    
            // 清理：去掉明显不是字段的词
            const stop = new Set(['length', 'forEach', 'map', 'filter', 'reduce', 'keys', 'values', 'entries', 'push', 'indexOf', 'includes', 'slice', 'join', 'split', 'trim', 'replace', 'toLowerCase', 'toUpperCase', 'some', 'every', 'find', 'string', 'number', 'boolean']);
            for (const g of Object.keys(usage)) {
                usage[g] = usage[g].filter(f => !stop.has(f) && !usage[g].includes(f) ? true : !stop.has(f));
                usage[g] = [...new Set(usage[g])];
            }
            return usage;
        }
    
    function isPairLeaf(v) {
            return Array.isArray(v) && v.length === 2 && typeof v[1] === 'string';
        }
    
    function isLeaf(v) {
            return v === null || typeof v !== 'object' || isPairLeaf(v);
        }
    
    function collectColumns(obj, prefixPath, report, opts = {}) {
            const cols = [];
            const usedIdents = new Set(['row_id']);
            for (const key of Object.keys(obj)) {
                const v = obj[key];
                const li = leafInfo(v);
                const path = [...prefixPath, key];
                // 普通数组是明确的值形状（日志/勋章列表等），优先按 JSON 单元格保留；
                // 不能被宽泛的动态字典规则改造成行对象。二元 [value, desc] 仍走叶子分支。
                if (Array.isArray(v) && (!isPairLeaf(v) || (opts.isArrayPath && opts.isArrayPath(path)))) {
                    if (!String(key).startsWith('_') && opts.childTables) {
                        opts.childTables.push({ key, value: v, path, array: true });
                    } else {
                        const jcol = jsonColumnFromObject(key, v, path, usedIdents);
                        if (jcol) cols.push(jcol);
                    }
                    continue;
                }
                // 规则明确声明的动态字典优先于 InitVar 当前值。动态容器常以 null/空值
                // 占位；若先走叶子判断，就会固化成 TEXT 列，运行期新增条目无处写入。
                const dyn = opts.isDynamicPath ? opts.isDynamicPath(path) : false;
                if (dyn) {
                    if (String(key).startsWith('_')) {
                        const jcol = jsonColumnFromObject(key, isPlainObject(v) || Array.isArray(v) ? v : {}, path, usedIdents);
                        if (jcol) cols.push(jcol);
                    } else if (opts.childTables) {
                        opts.childTables.push({
                            key,
                            value: isPlainObject(v) ? v : {},
                            path,
                            dynamic: true,
                            // null 常用作“尚未产生任何动态条目”的初始占位；空表读回时
                            // 保持 null，出现首条记录后自然变为对象字典。
                            emptyValue: v === null ? null : undefined,
                        });
                    } else {
                        report.warn(`发现动态键字典「${key}」，需拆分为子行表（当前未启用子表提取）`, 'schema');
                    }
                    continue;
                }
                if (isLeaf(v)) {
                    cols.push({
                        zh: key,
                        path,
                        value: li.value,
                        desc: li.desc || '',
                        type: inferType(li.value),
                        range: null,
                        ident: toIdent(key, usedIdents, 'column'),
                        isPair: Array.isArray(v),
                    });
                    continue;
                }
                // 对象：判断是固定子对象还是条目字典
                const values = Object.values(v);
                const allLeaf = values.length > 0 && values.every(x => isLeaf(x));
                const allObject = values.length > 0 && values.every(x => isPlainObject(x));
                // 动态键字典（[mvu_update] 声明 { [键]: value }，或跨分支键集不同）：
                // 条目键是运行期内容，不能展平成固定列（如 世界系统.修仙秘闻 每分支键完全不同，
                // 固定列会在按分支注入时丢数据）→ 子行表，读回时保持 {键: 值} 原形。
                // 纯容器本身不是条目表；若其后代路径被规则明确声明为动态字典，继续向下找
                // 真正的子表。例如 主角.装备 只是容器，实际子表是
                // 主角.装备.固定部位 与 主角.装备.饰品。
                const hasDynamicDescendant = opts.hasDynamicDescendant ? opts.hasDynamicDescendant(path) : false;
                if (hasDynamicDescendant) {
                    const nested = collectColumns(v, path, report, opts);
                    // 容器内若还混有静态叶子，仍展平成父表列并保留完整 path；动态子表本身
                    // 已经由共享 childTables 收集，不会出现在 nested 中。
                    for (const c of nested) {
                        c.zh = `${key}_${c.zh}`;
                        c.ident = toIdent(c.zh, usedIdents, 'column');
                        cols.push(c);
                    }
                    continue;
                }
                // 固定对象树与「动态条目字典」的区分不能只看子值是否为对象。
                // 多个子对象共享条目字段（例如每个道侣都有亲密/种族）才像字典；
                // 异构分支（例如修炼体系/战斗与能力/资源与物品）是固定 schema，应递归展开。
                let sharedChildFields = null;
                if (allObject) {
                    for (const child of values) {
                        const ks = new Set(Object.keys(child));
                        if (sharedChildFields === null) sharedChildFields = ks;
                        else for (const k of [...sharedChildFields]) if (!ks.has(k)) sharedChildFields.delete(k);
                    }
                }
                const looksLikeEntryDict = allObject && sharedChildFields && sharedChildFields.size > 0;
                if (fixedObjectFromValue(v) && !looksLikeEntryDict) {
                    const fixedCols = flattenFixedObjectColumns(key, v, null, { rootPath: prefixPath, relativeRoot: [key] });
                    for (const c of fixedCols) {
                        c.ident = toIdent(c.zh, usedIdents, 'column');
                        cols.push(c);
                    }
                    continue;
                }
                if (allObject && !looksLikeEntryDict) {
                    const nested = collectColumns(v, path, report, opts);
                    for (const c of nested) {
                        c.zh = `${key}_${c.zh}`;
                        c.ident = toIdent(c.zh, usedIdents, 'column');
                        cols.push(c);
                    }
                    continue;
                }
                if (allLeaf) {
                    // 固定子对象 → 展平：key_子键（与其它展平列命名一致）
                    for (const subKey of Object.keys(v)) {
                        const sv = v[subKey];
                        const sli = leafInfo(sv);
                        const flatZh = `${key}_${subKey}`;
                        cols.push({
                            zh: flatZh,
                            path: [...path, subKey],
                            value: sli.value,
                            desc: sli.desc || '',
                            type: inferType(sli.value),
                            range: null,
                            ident: toIdent(flatZh, usedIdents, 'column'),
                        });
                    }
                } else if (values.length === 0 || allObject) {
                    // 条目字典（如 道侣.{林若悠:{...}}）与空字典（如 主角.储物袋，
                    // 初始为空、运行期由脚本/AI 按条目填充）→ 子行表，每个条目一行。
                    // 例外：_ 前缀 = 脚本维护的只读状态（如 系统._摄像头布设），不拆表，
                    // 整对象存 JSON 列（AI 见不到、脚本整体读写）。
                    if (String(key).startsWith('_')) {
                        const jcol = jsonColumnFromObject(key, v, path, usedIdents);
                        if (jcol) cols.push(jcol);
                    } else if (opts.childTables) {
                        opts.childTables.push({ key, value: v, path });
                    } else {
                        report.warn(`发现嵌套对象「${key}」，需拆分为子行表（当前未启用子表提取）`, 'schema');
                    }
                } else {
                    // 混合结构仍是可以递归建模的固定对象：标量变列，数组/动态字典进子表。
                    // 只有下划线前缀的脚本私有状态保留 JSON 逃生舱。
                    if (String(key).startsWith('_')) {
                        const jcol = jsonColumnFromObject(key, v, path, usedIdents);
                        if (jcol) cols.push(jcol);
                    } else {
                        const nested = collectColumns(v, path, report, opts);
                        for (const c of nested) {
                            c.zh = `${key}_${c.zh}`;
                            c.ident = toIdent(c.zh, usedIdents, 'column');
                            cols.push(c);
                        }
                        if (!nested.length) {
                            const jcol = jsonColumnFromObject(key, v, path, usedIdents);
                            if (jcol) cols.push(jcol);
                        }
                    }
                }
            }
            return cols;
        }
    
    function inferType(value) {
            if (typeof value === 'number') return 'INTEGER';
            if (typeof value === 'boolean') return 'INTEGER';
            return 'TEXT';
        }
    
    function jsonColumnFromObject(key, obj, path, usedIdents) {
            let value = obj;
            let desc = '';
            if (isPairLeaf(obj)) {
                const li = leafInfo(obj);
                value = li.value;
                desc = li.desc || '';
                if (typeof value === 'object' && value !== null) {
                    try { value = JSON.stringify(value); } catch (e) { value = String(value); }
                }
                return {
                    zh: key,
                    path,
                    value,
                    desc,
                    type: 'TEXT',
                    range: null,
                    ident: toIdent(key, usedIdents, 'column'),
                    isObject: false,
                    isPair: true,
                };
            }
            try {
                value = JSON.stringify(obj);
            } catch (e) {
                value = String(obj);
            }
            return {
                zh: key,
                path,
                value,
                desc: desc || '对象（JSON 存储，读取时还原）',
                type: 'TEXT',
                range: null,
                ident: toIdent(key, usedIdents, 'column'),
                isObject: true,
                jsonKind: Array.isArray(obj) ? 'array' : 'object',
            };
        }
    
    function schemaTypeLabel(node) {
            if (!node) return '文本';
            return ({ number: '数字', boolean: '布尔值', array: '数组', object: '对象', text: '文本' })[node.kind] || '文本';
        }
    
    function schemaExample(node, depth = 0) {
            if (!node || depth > 3) return '';
            if (node.kind === 'number') return 0;
            if (node.kind === 'boolean') return false;
            if (node.kind === 'array') return [];
            if (node.kind !== 'object') return '';
            const out = {};
            for (const [key, child] of Object.entries(node.fields || {})) out[key] = schemaExample(child, depth + 1);
            return out;
        }
    
    function describeObjectSchema(node) {
            if (!node) return '';
            if (node.kind === 'array') return 'JSON 数组；示例：[]';
            if (node.kind !== 'object') return '';
            const fields = Object.entries(node.fields || {});
            const allowed = fields.map(([key, child]) => `${key}(${schemaTypeLabel(child)})`).join('、');
            const parts = ['JSON 对象'];
            if (allowed) parts.push(`允许键：${allowed}`);
            if (node.dynamic) parts.push('可使用运行期动态键');
            if (fields.length) parts.push(`示例：${JSON.stringify(schemaExample(node))}`);
            return parts.join('；');
        }
    
    function fixedObjectFromValue(value) {
            if (!isPlainObject(value) || Object.keys(value).length === 0) return false;
            for (const child of Object.values(value)) {
                if (Array.isArray(child)) return false;
                if (isPlainObject(child) && !fixedObjectFromValue(child)) return false;
            }
            return true;
        }
    
    function fixedObjectSchema(node) {
            return !!(node && node.kind === 'object' && node.dynamic !== true && Object.keys(node.fields || {}).length > 0);
        }
    
    function flattenFixedObjectColumns(rootName, value, schema, opts = {}) {
            const out = [];
            const rootPath = Array.isArray(opts.rootPath) ? opts.rootPath : [];
            const relativeRoot = Array.isArray(opts.relativeRoot) ? opts.relativeRoot : [rootName];
            const walk = (displayParts, pathParts, relativeParts, currentValue, currentSchema) => {
                const schemaFields = fixedObjectSchema(currentSchema) ? currentSchema.fields : null;
                const valueFields = fixedObjectFromValue(currentValue) ? currentValue : null;
                const keys = schemaFields ? Object.keys(schemaFields) : (valueFields ? Object.keys(valueFields) : []);
                for (const key of keys) {
                    const childSchema = schemaFields ? schemaFields[key] : null;
                    const childValue = valueFields && Object.prototype.hasOwnProperty.call(valueFields, key) ? valueFields[key] : undefined;
                    const childFixed = fixedObjectSchema(childSchema) || (!childSchema && fixedObjectFromValue(childValue));
                    if (childFixed) {
                        walk([...displayParts, key], [...pathParts, key], [...relativeParts, key], childValue, childSchema);
                        continue;
                    }
                    // 动态字典/数组/结构未知的子节点不伪装成固定列；
                    // 它们仍作为类型明确的 JSON 逃生口，后续可升级为父子关系表。
                    const kind = childSchema && childSchema.kind;
                    const isJson = kind === 'object' || kind === 'array' || Array.isArray(childValue) || isPlainObject(childValue);
                    let v = childValue;
                    if (v === undefined && childSchema && childSchema.hasDefault) v = childSchema.defaultValue;
                    if (v === undefined) v = kind === 'array' ? [] : (kind === 'object' ? {} : (kind === 'number' || kind === 'boolean' ? 0 : ''));
                    if (isJson) {
                        try { v = JSON.stringify(v); } catch (e) { v = kind === 'array' ? '[]' : '{}'; }
                    }
                    out.push({
                        zh: [...displayParts, key].join('_'),
                        path: [...pathParts, key],
                        itemPath: [...relativeParts, key],
                        value: v,
                        desc: isJson ? (describeObjectSchema(childSchema) || '动态/未知结构（JSON 存储）') : '',
                        type: kind === 'number' || kind === 'boolean' || typeof childValue === 'number' || typeof childValue === 'boolean' ? 'INTEGER' : 'TEXT',
                        logicalType: kind || (typeof childValue === 'boolean' ? 'boolean' : (typeof childValue === 'number' ? 'number' : '')),
                        range: null,
                        isObject: isJson,
                        jsonKind: kind === 'array' || Array.isArray(childValue) ? 'array' : (isJson ? 'object' : undefined),
                        objectSchema: isJson ? (childSchema || null) : null,
                    });
                }
            };
            walk([rootName], [...rootPath, rootName], relativeRoot, value, schema);
            return out;
        }
    
    function buildSchema(initvar, usage, report, shapeInfo) {
            const groups = [];
            const seenTables = new Set();
            const reportedStructuralMacros = new Set();
            const usedTableIdents = new Set();
            const shapes = (shapeInfo && shapeInfo.shapes) || {};
            const shapeObjects = (shapeInfo && shapeInfo.objects) || {};
            const shapeFieldTypes = (shapeInfo && shapeInfo.fieldTypes) || {};
            const globalShapeFieldTypes = (shapeInfo && shapeInfo.globalFieldTypes) || {};
            const shapeObjectSchemas = (shapeInfo && shapeInfo.objectSchemas) || {};
            const ruleRanges = (shapeInfo && shapeInfo.ranges) || {};
            const ruleEnums = (shapeInfo && shapeInfo.enums) || {};
            const ruleFormats = (shapeInfo && shapeInfo.formats) || {};
            const ruleChecks = (shapeInfo && shapeInfo.checks) || {};
            const ruleReminders = (shapeInfo && shapeInfo.reminders) || {};
            const ruleNumeric = (shapeInfo && shapeInfo.numericFields) || new Set();
            const usageTypes = (usage && usage.__types) || {};
            // 动态键字典：来自 [mvu_update] 的 { [键: type]: value } 声明（dynamicDicts），
            // 或跨分支 <initvar> 键集变化（dynamicPaths/dynamicGroups）。
            const dynamicDicts = (shapeInfo && shapeInfo.dynamicDicts) || {};
            const dynamicPaths = (shapeInfo && shapeInfo.dynamicPaths) || new Set();
            const dynamicGroups = (shapeInfo && shapeInfo.dynamicGroups) || new Set();
            const dynamicKeyNames = (shapeInfo && shapeInfo.dynamicKeyNames) || {};
            const dynamicPathSamples = (shapeInfo && shapeInfo.dynamicPathSamples) || new Map();
            const zodSchemaRoot = shapeInfo && shapeInfo.zodSchemaRoot;
            const isDynamicPath = (pathArr) => {
                if (!Array.isArray(pathArr) || !pathArr.length) return false;
                if (dynamicPaths.has(pathArr.join('.'))) return true;
                if (pathArr.length >= 2 && dynamicDicts[pathArr[0]] && dynamicDicts[pathArr[0]][pathArr[1]]) return true;
                if (pathArr.length >= 2) {
                    const declared = (shapeObjectSchemas[pathArr[0]] || {})[pathArr[1]];
                    if (declared && declared.kind === 'object' && declared.dynamic) return true;
                }
                return false;
            };
            const hasDynamicDescendant = (pathArr) => {
                if (!Array.isArray(pathArr) || !pathArr.length) return false;
                const prefix = pathArr.join('.') + '.';
                for (const p of dynamicPaths) if (String(p).startsWith(prefix)) return true;
                return false;
            };
            const isArrayPath = (pathArr) => {
                if (!Array.isArray(pathArr) || pathArr.length < 2) return false;
                return ((shapeFieldTypes[pathArr[0]] || {})[pathArr[1]] === 'array');
            };
            const groupNameSet = new Set(Object.keys(initvar));
    
            // 通用表种类推导：
            //  - 组自身有直接标量字段 → 单例（嵌套对象是子对象字段，如 主角.炼丹.阶级）
            //  - 无直接标量字段且全部为对象 → 条目字典 → 行表（如 道侣.{林若悠:{亲密:88}}）
            //  - 空字典 / 数组 → 行表 / 数组表
            //  - 动态键字典（声明的 { [键]: value } 或跨分支键集不同）→ 行表：条目键是
            //    运行期内容，固定列会丢数据（如 修仙秘闻 每分支键完全不同）。
            function deriveKind(groupName, raw) {
                if (dynamicGroups.has(groupName) || isDynamicPath([groupName])) {
                    report.note(`顶层组「${groupName}」为动态键字典（键是运行期条目），按条目行表转换。`);
                    return 'rows';
                }
                const values = Object.values(raw);
                if (values.length === 0) {
                    // 状态栏/规则扫描到字段 → 仍可按字段建行表；完全无字段信息 → 整组 JSON（任意形状还原）
                    const knownFields = [...(usage[groupName] || []), ...(shapes[groupName] || [])]
                        .filter(f => f !== '名称' && f !== '描述' && f !== '数值' && f !== '内容');
                    if (knownFields.length === 0) {
                        report.note(`顶层组「${groupName}」初始为空字典且无字段线索，运行期结构未知，按整组 JSON 存储（任意形状均还原）。`);
                        return 'json';
                    }
                    report.note(`顶层组「${groupName}」初始为空字典，已按状态栏/规则扫描到的字段建行表。`);
                    return 'rows';
                }
                const leaves = values.filter(v => isLeaf(v)).length;
                if (leaves > 0) return 'singleton';
                if (values.every(v => isPlainObject(v))) {
                    // 全对象：区分“条目字典”（行表）与“固定子对象”（单例嵌套字段）。
                    // 条目字典：各条目共享至少一个字段（如 道侣.{林若悠:{亲密,种族},
                    // 苏媚:{…}}；条目字段可有可选缺省，如 林若悠 只有亲密）；
                    // 固定子对象：各子对象字段完全不同（如 主角状态.{修为:{…},
                    // 灵石钱包:{…}}——修为/灵石钱包应是单例的嵌套字段列，而不是行条目）。
                    let common = null;
                    for (const v of values) {
                        const ks = new Set(Object.keys(v));
                        if (common === null) common = new Set(ks);
                        else { for (const k of [...common]) if (!ks.has(k)) common.delete(k); }
                    }
                    // 含动态键字典子对象（如 天下地图.地区态势 = {地区: 态势}，跨分支键集
                    // 不同）时，子对象会被拆成子行表；组本身不应再判成“条目字典行表”把
                    // 子对象键展平成列（否则与子表重复、还会把 山西/陕西 这类拼音相同的
                    // 地区名变成列，插件导入校验按表头 slug 判冲突而拒绝）。
                    const declaredNestedDynamic = Object.keys(dynamicDicts[groupName] || {}).some(k => dynamicDicts[groupName][k]) ||
                        Object.values(shapeObjectSchemas[groupName] || {}).some(node => node && node.kind === 'object' && node.dynamic);
                    if (declaredNestedDynamic || Object.keys(raw).some(k => isDynamicPath([groupName, k]))) {
                        report.note(`顶层组「${groupName}」含动态键字典子对象，按单例处理（子对象拆子表，不展平为行条目）。`);
                        return 'singleton';
                    }
                    if (common !== null && common.size > 0) return 'rows';
                    report.note(`顶层组「${groupName}」为多个不同结构的子对象，按单例处理（子对象展平/拆子表，修为/灵石钱包类字段不再变成行）。`);
                    return 'singleton';
                }
                return 'singleton';
            }
    
            function fieldRange(field) {
                return ruleRanges[field] || null;
            }
    
            function fieldIsNumeric(field, value, group) {
                if (group && usageTypes[group] && usageTypes[group][field] === 'number') return true;
                if (ruleNumeric.has(field)) return true;
                return typeof value === 'number';
            }
    
            function declaredFieldKind(group, field) {
                return (shapeFieldTypes[group] || {})[field] || globalShapeFieldTypes[field] || '';
            }
    
            function declaredZodField(group, field) {
                const groupNode = zodSchemaRoot && zodSchemaRoot.fields && zodSchemaRoot.fields[group];
                if (!groupNode) return null;
                const rowNode = groupNode.dynamic && groupNode.value && groupNode.value.kind === 'object'
                    ? groupNode.value : groupNode;
                return rowNode && rowNode.fields ? rowNode.fields[field] : null;
            }
    
            function applyDeclaredShape(column, group, field) {
                const kind = declaredFieldKind(group, field);
                const schema = (shapeObjectSchemas[group] || {})[field];
                const zodField = declaredZodField(group, field);
                if ((column.value === '' || column.value === undefined) && zodField && zodField.hasDefault) {
                    const dv = zodField.defaultValue;
                    column.value = (dv && typeof dv === 'object') ? JSON.stringify(dv) : dv;
                }
                if (kind === 'number' || kind === 'boolean') {
                    column.type = 'INTEGER';
                    column.logicalType = kind;
                }
                if (kind === 'object' || kind === 'array') {
                    column.type = 'TEXT';
                    column.isObject = true;
                    column.jsonKind = kind;
                    column.objectSchema = schema || null;
                    const schemaDesc = describeObjectSchema(schema);
                    if (schemaDesc) column.desc = schemaDesc;
                }
                return column;
            }
    
            function normalizeStructuralMacroName(value) {
                const original = String(value == null ? '' : value);
                let changed = false;
                const normalizeBody = (body) => {
                    const normalized = String(body == null ? '' : body)
                        .trim()
                        .replace(/::+/g, '_')
                        .replace(/[^A-Za-z0-9_\u3400-\u9fff]+/g, '_')
                        .replace(/_+/g, '_')
                        .replace(/^_+|_+$/g, '');
                    return normalized || 'macro';
                };
                let normalized = original.replace(/\{\{([\s\S]*?)\}\}/g, (_match, body) => {
                    changed = true;
                    return normalizeBody(body);
                });
                normalized = normalized.replace(/<(USER|BOT|CHAR|CHARIFNOTGROUP|GROUP)>/gi, (_match, body) => {
                    changed = true;
                    return normalizeBody(body.toLowerCase());
                });
                if (changed && !reportedStructuralMacros.has(original)) {
                    reportedStructuralMacros.add(original);
                    report.note(`表名宏「${original}」已静态规范化为「${normalized}」；该结构名不再运行时求值，MVU 逻辑路径仍保留原名。`);
                }
                return normalized;
            }
    
            function makeGroupTableName(groupName) {
                return `${normalizeStructuralMacroName(groupName)}表`;
            }
    
            function claimTopLevelTableName(groupName) {
                const preferred = makeGroupTableName(groupName);
                let tableName = preferred;
                if (seenTables.has(tableName)) {
                    const stem = tableName.endsWith('表') ? tableName.slice(0, -1) : tableName;
                    let n = 2;
                    while (seenTables.has(`${stem}${n}表`)) n++;
                    tableName = `${stem}${n}表`;
                    report.note(`表名「${preferred}」静态规范化后重名（组「${groupName}」），使用「${tableName}」。`);
                }
                seenTables.add(tableName);
                return tableName;
            }
    
            // 从嵌套路径派生的表统一保留完整来源路径。除了避免同名子表碰撞，
            // 「寻缘蝶_功法表」也比只写「功法表」更直接地表达数据归属。
            function makePathTableName(path, fallback) {
                const parts = (Array.isArray(path) ? path : [])
                    .map(x => String(x == null ? '' : x).trim())
                    .filter(Boolean);
                return makeGroupTableName(parts.length ? parts.join('_') : fallback);
            }
    
            for (const groupName of Object.keys(initvar)) {
                if (groupName === '$meta') {
                    report.note(`已跳过 MVU 保留元数据组「$meta」（strictTemplate 等），不生成表格。`);
                    continue;
                }
                const raw = initvar[groupName];
                const tableName = claimTopLevelTableName(groupName);
                if (!isPlainObject(raw)) {
                    // 顶层非对象（数组/标量/null）：数组按数组表，其余按单行 JSON 表。
                    // null 是合法状态值，不能当“无数据”跳过。
                    const keyCol = '键名';
                    const isArray = Array.isArray(raw);
                    if (isArray) {
                            // 数组表的值列用 JSON 标量编码。数组元素可合法为 null、布尔、
                            // 数字、对象或嵌套数组；不能用 String()，否则类型和对象结构会丢失。
                            const valueZh = '内容';
                            const cols = [{
                                zh: valueZh, path: [groupName, valueZh], value: '',
                                desc: '数组元素（JSON 标量编码，读取时保留原始类型）', type: 'TEXT',
                                logicalType: 'jsonScalar', ident: toIdent(valueZh, new Set(['row_id']), 'column'),
                            }];
                            const rows = raw.map((item, i) => {
                                let encoded;
                                try { encoded = JSON.stringify(item); } catch (e) { encoded = 'null'; }
                                return [i + 1, encoded === undefined ? 'null' : encoded];
                            });
                            groups.push({
                                name: groupName,
                                tableName,
                                ident: toIdent(tableName, usedTableIdents, 'table'),
                                kind: 'array',
                                keyCol,
                                keyValue: '',
                                columns: cols,
                                rows,
                                childTables: [],
                                source: 'top-level-array',
                            });
                        continue;
                    }
                    // 有限数字使用数值列；其他标量（含 null）保留 JSON 编码。
                    // 仍复用单行整组投影，不把 stat_data.点数 变成 { 内容: 点数 }。
                    const numericScalar = typeof raw === 'number' && Number.isFinite(raw);
                    const usedScalar = new Set(['row_id']);
                    const scalarColumns = [
                            {
                                zh: '内容',
                                path: [groupName, '内容'],
                                value: numericScalar ? raw : '',
                                desc: numericScalar ? '顶层数值（直接存储数字，读取时还原原变量）' : '顶层标量（JSON 存储，读取时原样还原；内部数据，AI 不应直接修改）',
                                type: numericScalar ? 'REAL' : 'TEXT',
                                ident: toIdent('内容', usedScalar, 'column'),
                                isObject: !numericScalar,
                            },
                        ];
                    let scalarInit;
                    try { scalarInit = JSON.stringify(raw); } catch (e) { scalarInit = String(raw); }
                    groups.push({
                            name: groupName,
                            tableName,
                            ident: toIdent(tableName, usedTableIdents, 'table'),
                            kind: 'json',
                            keyCol: '',
                            keyValue: '',
                            columns: scalarColumns,
                            rows: [[1, scalarInit]],
                            childTables: [],
                            source: 'top-level-scalar',
                            scalarType: numericScalar ? 'number' : undefined,
                            reminders: ruleReminders[groupName] || [],
                        });
                    continue;
                }
    
                const kind = deriveKind(groupName, raw);
    
                // 键列名统一为「键名」（键列存的是 stat_data 对象字典里的键，
                // 如 技能1/西园寺爱丽莎；标量/JSON 表存的是组名）。
                // 不再用「名称」：条目自身也常带「名称」字段
                // （如 技能1: { 名称: 未获得 }），键列若叫「名称」会与字段重名导致表头重复。
                const keyCol = '键名';
                let rowsKeyCol = dynamicKeyNames[groupName] || '键名';
                if (Object.values(raw).some(v => isPlainObject(v) && Object.prototype.hasOwnProperty.call(v, rowsKeyCol))) {
                    rowsKeyCol += '_键名';
                }
                const childTables = [];
                const prefixPath = [groupName];
                if (kind === 'json') {
                    // 空字典组：运行期可能是“字典→对象 / 字典→标量 / 组本身是标量”等任意形状，
                    // 统一存成单行 JSON（内容列，无需键列——整组只有一个身份行），读取时原样还原；不猜列名。
                    const usedJson = new Set(['row_id']);
                    const columns = [
                        {
                            zh: '内容',
                            path: [groupName, '内容'],
                            value: '',
                            desc: '整组数据（JSON 存储，读取时还原任意形状；内部数据，AI 不应直接修改）',
                            type: 'TEXT',
                            ident: toIdent('内容', usedJson, 'column'),
                            isObject: true,
                        },
                    ];
                    let initial;
                    try { initial = JSON.stringify(raw); } catch (e) { initial = '{}'; }
                    groups.push({
                        name: groupName,
                        tableName,
                        ident: toIdent(tableName, usedTableIdents, 'table'),
                        kind: 'json',
                        keyCol: '',
                        keyValue: '',
                        columns,
                        rows: [[1, initial]],
                        childTables: [],
                        source: 'initvar',
                        reminders: ruleReminders[groupName] || [],
                    });
                    continue;
                }
                // 行表的列由下方 rows 分支从条目字段构造（嵌套对象统一转 JSON 列）；
                // 不从顶层收集子表，避免“每角色一张字段相同的重复表”。
                const columns = kind === 'rows'
                    ? []
                    : collectColumns(raw, prefixPath, report, { childTables, isDynamicPath, hasDynamicDescendant, isArrayPath });
                if (kind !== 'rows') {
                    const expanded = [];
                    for (const c of columns) {
                        const declaredSchema = (shapeObjectSchemas[groupName] || {})[c.zh];
                        let actual;
                        if (c.isObject && typeof c.value === 'string') {
                            try { actual = JSON.parse(c.value); } catch (e) { actual = undefined; }
                        }
                        if (c.isObject && (fixedObjectSchema(declaredSchema) || ((!declaredSchema || !declaredSchema.dynamic) && fixedObjectFromValue(actual)))) {
                            const flatCols = flattenFixedObjectColumns(c.zh, actual, declaredSchema, {
                                rootPath: [groupName],
                                relativeRoot: [c.zh],
                            });
                            if (flatCols.length) { expanded.push(...flatCols); continue; }
                        }
                        expanded.push(c);
                    }
                    columns.length = 0;
                    const rebuiltUsed = new Set(['row_id']);
                    for (const c of expanded) {
                        c.ident = toIdent(c.zh, rebuiltUsed, 'column');
                        columns.push(applyDeclaredShape(c, groupName, c.zh));
                    }
                }
    
                let rows = [];
                // 标量条目（如 修仙秘闻: { 标题: 内容 }）的行表标记：读回时还原为 {键: 标量}，
                // 写入时标量落在「描述/数值」列而不是被当成列名查找。
                let rowsScalarValueCol = '';
                if (kind === 'rows') {
                    // 条目字典 → 每条目一行
                    const fieldOrder = [];
                    const entryRows = [];
                    const objFields = new Set();
                    const pairFields = new Set();
                    const fieldDescs = {};
                    const flattenedRoots = new Set();
                    const flattenedDefs = {};
                    // 行表条目内的动态字典（如 寻缘蝶.<蝶名>.功法）需要
                    // 关系表不能退化成 JSON 单元格。使用「具体实体_键名 + 键名」
                    // 唯一定位记录，以后新增任意所属实体记录也不需要改 schema。
                    const rowChildByKey = new Map();
                    let sawScalarEntries = false;
                    let scalarIsNumber = false;
                    for (const entryName of Object.keys(raw)) {
                        const entry = raw[entryName];
                        if (!isPlainObject(entry)) {
                            sawScalarEntries = true;
                            scalarIsNumber = scalarIsNumber || typeof entry === 'number';
                            entryRows.push({ [rowsKeyCol]: entryName, value: entry, __scalar: true });
                            continue;
                        }
                        const entryCols = [];
                        const entryUsed = new Set(['row_id']);
                        for (const subKey of Object.keys(entry)) {
                            const sv = entry[subKey];
                            const spath = [...prefixPath, entryName, subKey];
                            if (Array.isArray(sv) && (!isPairLeaf(sv) || declaredFieldKind(groupName, subKey) === 'array') && !String(subKey).startsWith('_')) {
                                let ct = rowChildByKey.get(subKey);
                                if (!ct) {
                                    ct = { key: subKey, value: {}, path: [groupName, subKey], array: true, parentRows: true, parentKeyCol: rowsKeyCol };
                                    rowChildByKey.set(subKey, ct);
                                    childTables.push(ct);
                                }
                                ct.value[entryName] = sv;
                                continue;
                            }
                            if (isDynamicPath([groupName, subKey])) {
                                let ct = rowChildByKey.get(subKey);
                                if (!ct) {
                                    ct = {
                                        key: subKey,
                                        value: {},
                                        path: [groupName, subKey],
                                        dynamic: true,
                                        parentRows: true,
                                        parentKeyCol: rowsKeyCol,
                                    };
                                    rowChildByKey.set(subKey, ct);
                                    childTables.push(ct);
                                }
                                ct.value[entryName] = isPlainObject(sv) ? sv : {};
                                continue;
                            }
                            const declaredObjectSchema = (shapeObjectSchemas[groupName] || {})[subKey];
                            if (fixedObjectSchema(declaredObjectSchema) || ((!declaredObjectSchema || !declaredObjectSchema.dynamic) && fixedObjectFromValue(sv))) {
                                const flatCols = flattenFixedObjectColumns(subKey, sv, declaredObjectSchema, {
                                    rootPath: [groupName],
                                    relativeRoot: [subKey],
                                });
                                if (flatCols.length) {
                                    flattenedRoots.add(subKey);
                                    for (const fc of flatCols) {
                                        fc.ident = toIdent(fc.zh, entryUsed, 'column');
                                        entryCols.push(fc);
                                        flattenedDefs[fc.zh] = flattenedDefs[fc.zh] || fc;
                                    }
                                    continue;
                                }
                            }
                            if (isLeaf(sv)) {
                                const li = leafInfo(sv);
                                if (Array.isArray(sv)) pairFields.add(subKey);
                                if (li.desc && !fieldDescs[subKey]) fieldDescs[subKey] = li.desc;
                                entryCols.push({
                                    zh: subKey,
                                    path: spath,
                                    value: li.value,
                                    desc: li.desc || '',
                                    type: inferType(li.value),
                                    range: null,
                                    ident: toIdent(subKey, entryUsed, 'column'),
                                    isObject: false,
                                    isPair: Array.isArray(sv),
                                });
                            } else {
                                entryCols.push(jsonColumnFromObject(subKey, sv, spath, entryUsed));
                                objFields.add(subKey);
                                if (!fieldDescs[subKey]) fieldDescs[subKey] = '对象（JSON 存储，读取时还原）';
                            }
                        }
                        for (const c of entryCols) {
                            if (!fieldOrder.includes(c.zh)) fieldOrder.push(c.zh);
                        }
                        const row = { [rowsKeyCol]: entryName };
                        for (const c of entryCols) row[c.zh] = c.value;
                        entryRows.push(row);
                    }
                    // 同一行表的固定对象字段可能只在部分行有样本，其他行为空。
                    // 逐行判定会先把它标成 JSON；这里按整列非空样本再审核一次并展开。
                    const objectRootCandidates = new Set(objFields);
                    for (const f of fieldOrder) {
                        if (entryRows.some(r => isPlainObject(r[f]))) objectRootCandidates.add(f);
                    }
                    for (const rootField of objectRootCandidates) {
                        const declared = (shapeObjectSchemas[groupName] || {})[rootField];
                        if (declared && declared.dynamic) continue;
                        const samples = [];
                        for (const r of entryRows) {
                            let v = r[rootField];
                            if (typeof v === 'string' && v) { try { v = JSON.parse(v); } catch (e) { v = undefined; } }
                            if (isPlainObject(v) && Object.keys(v).length) samples.push(v);
                        }
                        const fixedSamples = samples.filter(fixedObjectFromValue);
                        if (!fixedSamples.length) continue;
                        const flatCols = flattenFixedObjectColumns(rootField, fixedSamples[0], declared, { rootPath: [groupName], relativeRoot: [rootField] });
                        if (!flatCols.length) continue;
                        flattenedRoots.add(rootField);
                        objFields.delete(rootField);
                        const oldPos = fieldOrder.indexOf(rootField);
                        if (oldPos >= 0) fieldOrder.splice(oldPos, 1);
                        for (const fc of flatCols) {
                            if (!fieldOrder.includes(fc.zh)) fieldOrder.push(fc.zh);
                            flattenedDefs[fc.zh] = flattenedDefs[fc.zh] || fc;
                        }
                        for (const r of entryRows) {
                            let obj = r[rootField];
                            if (typeof obj === 'string' && obj) { try { obj = JSON.parse(obj); } catch (e) { obj = null; } }
                            for (const fc of flatCols) {
                                let cur = obj;
                                for (const seg of (fc.itemPath || []).slice(1)) { if (cur === null || cur === undefined || typeof cur !== 'object') { cur = undefined; break; } cur = cur[seg]; }
                                if (cur !== undefined) r[fc.zh] = isPairLeaf(cur) ? leafInfo(cur).value : cur;
                            }
                            delete r[rootField];
                        }
                    }
                    // 类型声明可以在 InitVar 仍为空表时定义行内动态字典。
                    // 预先建空关系子表，让 AI/前端在首个父条目出现时就有可写位置。
                    const declaredRowDyn = dynamicDicts[groupName] || {};
                    const declaredRowDynKeys = new Set(Object.keys(declaredRowDyn).filter(k => declaredRowDyn[k]));
                    for (const [k, node] of Object.entries(shapeObjectSchemas[groupName] || {})) {
                        if (node && node.kind === 'object' && node.dynamic) declaredRowDynKeys.add(k);
                    }
                    for (const subKey of declaredRowDynKeys) {
                        if (rowChildByKey.has(subKey)) continue;
                        const ct = {
                            key: subKey,
                            value: {},
                            path: [groupName, subKey],
                            dynamic: true,
                            declaredOnly: true,
                            parentRows: true,
                            parentKeyCol: rowsKeyCol,
                        };
                        rowChildByKey.set(subKey, ct);
                        childTables.push(ct);
                    }
                    // 空动态行表（大荒宗门/寻缘蝶）没有 InitVar 样本行，
                    // 固定嵌套结构必须直接从 type schema 生成展平列。
                    for (const [rootField, rootSchema] of Object.entries(shapeObjectSchemas[groupName] || {})) {
                        if (!fixedObjectSchema(rootSchema) || flattenedRoots.has(rootField)) continue;
                        const flatCols = flattenFixedObjectColumns(rootField, undefined, rootSchema, {
                            rootPath: [groupName],
                            relativeRoot: [rootField],
                        });
                        if (!flatCols.length) continue;
                        flattenedRoots.add(rootField);
                        for (const fc of flatCols) {
                            if (!fieldOrder.includes(fc.zh)) fieldOrder.push(fc.zh);
                            flattenedDefs[fc.zh] = flattenedDefs[fc.zh] || fc;
                        }
                    }
                    // 字段顺序：先 usage 里出现的，再条目里出现的
                    const usageFields = (usage[groupName] || []).filter(f => f !== rowsKeyCol && !rowChildByKey.has(f));
                    const shapeFields = (shapes[groupName] || []).filter(f => f !== rowsKeyCol && !flattenedRoots.has(f) && !rowChildByKey.has(f));
                    const allFields = [...new Set([...shapeFields, ...usageFields, ...fieldOrder])].filter(f => !rowChildByKey.has(f));
                    columns.length = 0;
                    columns.push({ zh: rowsKeyCol, path: [groupName], value: '', desc: '', type: 'TEXT', ident: toIdent(rowsKeyCol, new Set(['row_id']), 'column') });
                    const used = new Set(['row_id', columns[0].ident.toLowerCase()]);
                    for (const f of allFields) {
                        const flatDef = flattenedDefs[f];
                        if (flatDef) {
                            columns.push({
                                ...flatDef,
                                value: rowFirstValue(entryRows, f),
                                ident: toIdent(f, used, 'column'),
                            });
                            continue;
                        }
                        const declaredKind = declaredFieldKind(groupName, f);
                        const isObjectField = objFields.has(f) || declaredKind === 'object' || declaredKind === 'array';
                        const firstValue = rowFirstValue(entryRows, f);
                        const column = {
                            zh: f,
                            path: [groupName, f],
                            value: '',
                            desc: fieldDescs[f] || '',
                            type: isObjectField ? 'TEXT' : (fieldIsNumeric(f, firstValue, groupName) ? 'INTEGER' : inferType(firstValue)),
                            logicalType: declaredKind || (typeof firstValue === 'boolean' ? 'boolean' : ''),
                            range: isObjectField ? null : fieldRange(f),
                            ident: toIdent(f, used, 'column'),
                            isObject: isObjectField,
                            isPair: pairFields.has(f),
                            jsonKind: isObjectField ? (
                                declaredKind === 'array' ? 'array'
                                : declaredKind === 'object' ? 'object'
                                : String(firstValue == null ? '' : firstValue).trim().startsWith('[') ? 'array'
                                : 'object'
                            ) : undefined,
                        };
                        columns.push(applyDeclaredShape(column, groupName, f));
                    }
                    if (sawScalarEntries) {
                        const scalarZh = scalarIsNumber ? '数值' : '描述';
                        rowsScalarValueCol = scalarZh;
                        // 标量条目的值补进「描述/数值」列（此前 r.value 只挂在内存里，
                        // 建行时取 r[列名] 取不到，值会静默丢失）。
                        for (const r of entryRows) {
                            if (r.__scalar) r[scalarZh] = r.value;
                        }
                        if (!columns.some(c => c.zh === scalarZh)) {
                            columns.push({
                                zh: scalarZh,
                                path: [groupName, scalarZh],
                                value: '',
                                desc: scalarIsNumber ? '条目数值' : '条目描述',
                                type: scalarIsNumber ? 'INTEGER' : 'TEXT',
                                range: null,
                                ident: toIdent(scalarZh, used, 'column'),
                            });
                        }
                        report.warn(`组「${groupName}」存在非对象条目（标量），已归入「${scalarZh}」列，请人工核对`, 'schema');
                    }
                    // 保守通配列展开：动态行表 `${角色}.静态字段` 这类规则可以安全提升为真实列，
                    // 避免大量字段全部塞进 _扩展数据；含动态段（${部位} 等）的路径不展开。
                    if (shapeInfo && shapeInfo.wildcardFields) {
                        const wildcardFieldsArr = Array.isArray(shapeInfo.wildcardFields) ? shapeInfo.wildcardFields : [...shapeInfo.wildcardFields];
                        const wildcardRulesMap = {};
                        for (const rules of Object.values(shapeInfo.wildcardRules || {})) {
                            for (const r of rules || []) wildcardRulesMap[r.path] = r;
                        }
                        // 把“动态占位符 + 有限枚举”安全展开成固定列。
                        // 这不是根据某张卡硬编码字段：仅当规则自身明确写出
                        // “X包括：A、B…”或 `${A|B}` 时展开；无法确定有限集时仍走
                        // _扩展数据，避免把真正的动态键误建成列。
                        const expandFiniteWildcardPath = (rest, rule) => {
                            const dyn = [];
                            for (let i = 0; i < rest.length; i++) {
                                const m = /^\$\{([^}]+)\}$/.exec(rest[i]);
                                if (m) dyn.push({ index: i, name: m[1].trim() });
                            }
                            if (!dyn.length) return [rest];
                            const cleanToken = raw => String(raw || '')
                                .replace(/\*\*/g, '').replace(/^[\s"'“”]+|[\s"'“”]+$/g, '')
                                .replace(/[\uff08(][\s\S]*$/, '').trim();
                            const validToken = s => /^[\u3400-\u9fffA-Za-z0-9_$-]{1,16}$/.test(s);
                            let tuples = null;
                            // 占位符自带管道枚举：${主手|副手}。
                            if (dyn.every(d => d.name.includes('|'))) {
                                tuples = [[]];
                                for (const d of dyn) {
                                    const vals = d.name.split('|').map(cleanToken).filter(validToken);
                                    if (!vals.length) return [];
                                    const nextTuples = [];
                                    for (const base of tuples) for (const v of vals) nextTuples.push([...base, v]);
                                    tuples = nextTuples;
                                }
                            } else {
                                const checks0 = rule && Array.isArray(rule.checks) ? rule.checks : [];
                                for (const check of checks0) {
                                    const cm = String(check).match(/^[^:：]{0,16}包括\s*[:：]\s*(.+)$/);
                                    if (!cm) continue;
                                    const vals = cm[1].split(/[、，,;；|]/).map(cleanToken).filter(Boolean);
                                    if (dyn.length === 1) {
                                        const one = vals.filter(validToken).map(v => [v]);
                                        if (one.length >= 2 && one.length <= 16) { tuples = one; break; }
                                    } else {
                                        const many = vals.map(v => v.split('.').map(cleanToken))
                                            .filter(parts => parts.length === dyn.length && parts.every(validToken));
                                        if (many.length >= 2 && many.length <= 32) { tuples = many; break; }
                                    }
                                }
                            }
                            if (!tuples || !tuples.length || tuples.length > 64) return [];
                            return tuples.map(tuple => {
                                const out = rest.slice();
                                for (let i = 0; i < dyn.length; i++) out[dyn[i].index] = tuple[i];
                                return out;
                            });
                        };
                        for (const rawPath of wildcardFieldsArr) {
                            const parts = String(rawPath || '').split('.').map(s => s.trim()).filter(Boolean);
                            if (!parts.length) continue;
                            const first = parts[0];
                            const inner = first.startsWith('${') && first.endsWith('}') ? first.slice(2, -1).trim() : '';
                            if (!inner || inner !== groupName) continue;
                            const rest = parts.slice(1);
                            if (!rest.length) continue;
                            const rule = wildcardRulesMap[rawPath] || wildcardRulesMap[parts.join('.')];
                            // <动态键>/[动态键] 仍不展开；${...} 只在能从规则提取
                            // 有限枚举时展开。
                            if (rest.some(seg => /[<>\[\]]/.test(seg))) continue;
                            const expandedPaths = rest.some(seg => /\$\{[^}]+\}/.test(seg))
                                ? expandFiniteWildcardPath(rest, rule)
                                : [rest];
                            if (!expandedPaths.length) continue;
                            const ruleType = rule && rule.type ? String(rule.type).trim() : '';
                            // MVU/Zod 替代规则常同时出现 array、T[]、Array<T>、[...]。
                            // 旧判断只认 array/左方括号，会把 object[] 误判成 object，进而
                            // 生成 DEFAULT '{}' + json_type='object'，实际写入 [] 时 CHECK 失败。
                            const isArrayType = /^array\b/i.test(ruleType) ||
                                /^Array\s*</i.test(ruleType) ||
                                /\[\]\s*;?$/.test(ruleType) ||
                                ruleType.startsWith('[');
                            const isObjectType = !!ruleType && /\{/.test(ruleType) && !isArrayType;
                            const isNumberType = !!ruleType && /^(?:number|integer)\b/i.test(ruleType) || !!(rule && rule.range);
                            const isBooleanType = !!ruleType && /^boolean\b/i.test(ruleType);
                            for (const expandedRest of expandedPaths) {
                                const zh = expandedRest.join('_');
                                if (columns.some(c => c.zh === zh)) continue;
                                columns.push({
                                    zh,
                                    path: [groupName, ...expandedRest],
                                    value: '',
                                    desc: '',
                                    type: isNumberType ? 'INTEGER' : 'TEXT',
                                    logicalType: isBooleanType ? 'boolean' : (isNumberType ? 'number' : ''),
                                    range: rule && rule.range ? rule.range : null,
                                    ident: toIdent(zh, used, 'column'),
                                    isObject: isObjectType || isArrayType,
                                    isPair: false,
                                    jsonKind: isArrayType ? 'array' : (isObjectType ? 'object' : undefined),
                                });
                            }
                        }
                    }
                    // 通用溢出列：运行期脚本/前端可能写入模板未声明的动态字段，统一存 JSON，读取时自动还原
                    if (!columns.some(c => c.zh === '_扩展数据')) {
                        columns.push({
                            zh: '_扩展数据',
                            path: [groupName, '_扩展数据'],
                            value: '',
                            desc: '本表未在模板声明的动态字段（JSON 存储，读取时自动还原；内部数据，AI 不应直接修改）',
                            type: 'TEXT',
                            range: null,
                            ident: toIdent('_扩展数据', used, 'column'),
                            isObject: true,
                            jsonKind: 'object',
                        });
                    }
                    rows = entryRows.map(r => {
                        const rowArr = [r.__rowId || (columns.length + 1), r[rowsKeyCol]];
                        for (const c of columns.slice(1)) {
                            let v = r[c.zh];
                            if (v === undefined || v === null) v = '';
                            if (c.isObject && typeof v === 'object') {
                                try { v = JSON.stringify(v); } catch (e) { v = String(v); }
                            }
                            rowArr.push(v);
                        }
                        return rowArr;
                    });
                } else {
                    // 单例表：不加业务键列（整表固定一行，row_id=1 即身份；名称列已去掉，避免 stat_data 多出 系统.名称 这类冗余字段）
                    const keyValue = groupName;
                    const used = new Set(['row_id']);
                    for (const c of columns) {
                        if (c.ident) used.add(c.ident.toLowerCase());
                    }
                    // 单例组：跳过子表容器名与固定子对象内部键（如 炼丹.阶级 已展平为 炼丹阶级 列）
                    const nestedSubKeys = new Set();
                    // usage/规则扫描的旧格式只有“组 + 叶字段名”，没有完整逻辑路径。
                    // 只要该字段已存在于 InitVar 的任意嵌套层，就不能再补成组级同名列；
                    // 真正的顶层同名字段已经由 collectColumns 自身建列，不受此过滤影响。
                    const collectNestedKeys = (node, depth) => {
                        if (!isPlainObject(node)) return;
                        for (const [k, v] of Object.entries(node)) {
                            if (depth > 0) nestedSubKeys.add(k);
                            if (isPlainObject(v)) collectNestedKeys(v, depth + 1);
                        }
                    };
                    collectNestedKeys(raw, 0);
                    // 容器字段（如 主角.资产/主角.状态）已经由展平列（资产_场币、状态_生命值百分比）
                    // 或子表（资产.仓库、状态.BUFF列表）表示时，不得再按 usage/shape 补一个
                    // 值为空的「容器列」。否则 statDataFromTables 读回时会把已重建好的嵌套对象
                    // 覆盖成空字符串，资产.场币/状态.生命值百分比 等标量字段全部丢失。
                    const representedContainerFields = new Set();
                    for (const c of columns) {
                        if (c.path && c.path.length > 1 && c.path[0] === groupName) representedContainerFields.add(c.path[1]);
                    }
                    for (const ct of childTables) {
                        if (ct.path && ct.path.length > 1 && ct.path[0] === groupName) representedContainerFields.add(ct.path[1]);
                    }
                    const usageFields = (usage[groupName] || []).filter(f => (
                        f !== keyCol &&
                        !groupNameSet.has(f) &&
                        !childTables.some(ct => ct.key === f) &&
                        !representedContainerFields.has(f) &&
                        !nestedSubKeys.has(f) &&
                        !(isPlainObject(raw[f]) && Object.values(raw[f]).every(x => isLeaf(x)))
                    ));
                    for (const f of usageFields) {
                        if (columns.some(c => c.zh === f)) continue;
                        columns.push(applyDeclaredShape({
                            zh: f,
                            path: [groupName, f],
                            value: '',
                            desc: '',
                            type: fieldIsNumeric(f, '', groupName) ? 'INTEGER' : 'TEXT',
                            range: fieldRange(f),
                            ident: toIdent(f, used, 'column'),
                        }, groupName, f));
                    }
                    // mvu_update/zod 声明的字段：initvar 里没有也要补成列（与行表行为对齐），
                    // 否则单例表的声明字段（如 zod 卡 白娅.着装/称谓）会静默丢失。
                    const shapeFieldsForSingleton = (shapes[groupName] || []).filter(f => (
                        f !== keyCol &&
                        !columns.some(c => c.zh === f) &&
                        !childTables.some(ct => ct.key === f) &&
                        !representedContainerFields.has(f) &&
                        !nestedSubKeys.has(f)
                    ));
                    for (const f of shapeFieldsForSingleton) {
                        columns.push(applyDeclaredShape({
                            zh: f,
                            path: [groupName, f],
                            value: '',
                            desc: '',
                            type: fieldIsNumeric(f, '', groupName) ? 'INTEGER' : 'TEXT',
                            range: fieldRange(f),
                            ident: toIdent(f, used, 'column'),
                        }, groupName, f));
                    }
                    // usage 扫描可能先补了一个空列，之后 type schema 才证明它是固定对象。
                    // 在所有补列完成后再做一次统一展开，避免空 InitVar 的对象滞留为 JSON。
                    const finalSingletonCols = [];
                    for (const c of columns) {
                        const rootField = c.path && c.path.length >= 2 ? c.path[1] : c.zh;
                        const declaredSchema = (shapeObjectSchemas[groupName] || {})[rootField];
                        if (c.isObject && fixedObjectSchema(declaredSchema)) {
                            const flat = flattenFixedObjectColumns(rootField, undefined, declaredSchema, {
                                rootPath: [groupName], relativeRoot: [rootField],
                            });
                            if (flat.length) { finalSingletonCols.push(...flat); continue; }
                        }
                        finalSingletonCols.push(c);
                    }
                    columns.length = 0;
                    const finalSingletonUsed = new Set(['row_id']);
                    for (const c of finalSingletonCols) {
                        c.ident = toIdent(c.zh, finalSingletonUsed, 'column');
                        columns.push(c);
                    }
                    // 通用溢出列：运行期脚本/前端可能写入模板未声明的动态字段，统一存 JSON，读取时自动还原
                    if (!columns.some(c => c.zh === '_扩展数据')) {
                        columns.push({
                            zh: '_扩展数据',
                            path: [groupName, '_扩展数据'],
                            value: '',
                            desc: '本表未在模板声明的动态字段（JSON 存储，读取时自动还原；内部数据，AI 不应直接修改）',
                            type: 'TEXT',
                            range: null,
                            ident: toIdent('_扩展数据', used, 'column'),
                            isObject: true,
                            jsonKind: 'object',
                        });
                    }
                    const rowArr = [1];
                    for (const c of columns) rowArr.push(c.value === undefined ? '' : c.value);
                    rows = [rowArr];
                }
    
                groups.push({
                    name: groupName,
                    tableName,
                    ident: toIdent(tableName, usedTableIdents, 'table'),
                    kind,
                    keyCol: kind === 'rows' ? rowsKeyCol : keyCol,
                    keyValue: kind === 'singleton' ? groupName : '',
                    columns,
                    rows,
                    childTables,
                    source: 'initvar',
                    reminders: ruleReminders[groupName] || [],
                    scalarValueCol: kind === 'rows' ? rowsScalarValueCol : '',
                });
            }
    
            // 处理单例/行表内部的嵌套字典 → 派生行表。派生表始终使用完整路径命名，
            // 因此无需再预扫同名子字段；行囊.背包 与 宗门.背包 会自然得到不同名称。
            for (const g of groups) {
                // 规则声明了动态键字典但 initvar 无数据（如 路遇道友录）：不给表的话
                // AI 写入无处落、整组 check 规则孤儿。补一个空子表，列由 type 声明字段
                // （shapes[字段]）构造；已有子表/列的不重复添加。
                const declaredDyn = (shapeInfo && shapeInfo.dynamicDicts && shapeInfo.dynamicDicts[g.name]) || {};
                for (const f of Object.keys(declaredDyn)) {
                    if (!declaredDyn[f]) continue;
                    const alreadyChild = g.childTables.some(ct => ct.key === f);
                    const alreadyColumn = Array.isArray(g.columns) && g.columns.some(c => c.zh === f);
                    if (!alreadyChild && !alreadyColumn) {
                        g.childTables.push({ key: f, value: {}, path: [g.name, f], dynamic: true, declaredOnly: true });
                        report.note(`动态键字典「${g.name}.${f}」初始无数据，按规则声明建空子表（键名/字段列来自 type 声明）。`);
                    }
                }
                for (const ct of g.childTables) {
                    let tableName = makePathTableName(ct.path, ct.key);
                    if (seenTables.has(tableName)) {
                        // 完整路径仍可能因源数据本身重名，保留稳定编号作为最后兜底。
                        const stem = tableName.endsWith('表') ? tableName.slice(0, -1) : tableName;
                        let n = 2;
                        while (seenTables.has(`${stem}${n}表`)) n++;
                        const alt = `${stem}${n}表`;
                        report.note(`派生表路径「${(ct.path || [g.name, ct.key]).join('.')}」与其他表重名，使用表名「${alt}」。`);
                        tableName = alt;
                    }
                    seenTables.add(tableName);
                    if (ct.array) {
                        const arrayRows = [];
                        const values = [];
                        if (ct.parentRows) {
                            for (const parentKey of Object.keys(ct.value || {})) {
                                const arr = Array.isArray(ct.value[parentKey]) ? ct.value[parentKey] : [];
                                for (const item of arr) { arrayRows.push({ parentKey, item }); values.push(item); }
                            }
                        } else {
                            const arr = Array.isArray(ct.value) ? ct.value : [];
                            for (const item of arr) { arrayRows.push({ parentKey: '', item }); values.push(item); }
                        }
                        const objectItems = values.some(v => v !== null && typeof v === 'object');
                        const arrayItems = objectItems && values.every(v => Array.isArray(v));
                        const au = new Set(['row_id']);
                        const acols = [];
                        const relationEntity = ct.parentRows ? String(g.name || '上级记录') : '';
                        const relationKeyCol = ct.parentRows ? `${relationEntity}_${g.keyCol || '键名'}` : '';
                        if (ct.parentRows) acols.push({ zh: relationKeyCol, path: [g.name], value: '', desc: `关联「${g.tableName}.${g.keyCol}」`, type: 'TEXT', ident: toIdent(relationKeyCol, au, 'column') });
                        acols.push({
                            zh: '内容', path: [...ct.path], value: '', desc: objectItems ? '数组元素（结构未固定，JSON 存储）' : '数组元素',
                            type: objectItems ? 'TEXT' : (values.some(v => typeof v === 'number') ? 'INTEGER' : 'TEXT'),
                            ident: toIdent('内容', au, 'column'), isObject: objectItems, jsonKind: arrayItems ? 'array' : (objectItems ? 'object' : undefined),
                        });
                        const arows = arrayRows.map((r, i) => {
                            let v = r.item;
                            if (objectItems) { try { v = JSON.stringify(v); } catch (e) { v = arrayItems ? '[]' : '{}'; } }
                            return ct.parentRows ? [i + 1, r.parentKey, v] : [i + 1, v];
                        });
                        ct.tableName = tableName;
                        groups.push({
                            name: ct.key, tableName, ident: toIdent(tableName, usedTableIdents, 'table'),
                            kind: ct.parentRows ? 'nestedArray' : 'pathArray',
                            keyCol: '', keyValue: '', columns: acols, rows: arows, childTables: [],
                            source: 'child-array', parentGroup: g.name, parentTable: ct.parentRows ? g.tableName : '',
                            parentKeyCol: relationKeyCol, relationEntity, arrayPath: [...ct.path],
                            reminders: ruleReminders[ct.key] || [],
                        });
                        continue;
                    }
                    const dynamicKeyPath = (ct.path || []).join('.');
                    let rowsKeyCol = dynamicKeyNames[dynamicKeyPath] || '键名';
                    const childSamples = [];
                    if (isPlainObject(ct.value)) {
                        for (const v of Object.values(ct.value)) {
                            if (isPlainObject(v)) childSamples.push(v);
                        }
                    }
                    if (childSamples.some(v => Object.prototype.hasOwnProperty.call(v, rowsKeyCol))) rowsKeyCol += '_键名';
                    const relationEntity = ct.parentRows ? String(g.name || '上级记录') : '';
                    const parentKeyCol = ct.parentRows ? `${relationEntity}_${g.keyCol || '键名'}` : '';
                    // 多层动态关系必须携带完整祖先键链。例如
                    // 关系列表.NPC.背包.物品.效果 需要「关系列表_键名 + 背包_键名」，
                    // 不能只凭物品名归属，否则不同 NPC 的同名物品会串行。
                    const ancestorKeyCols = ct.parentRows
                        ? (Array.isArray(ct.ancestorKeyCols) && ct.ancestorKeyCols.length
                            ? ct.ancestorKeyCols.map(x => ({ ...x }))
                            : [{ col: parentKeyCol, entity: relationEntity, parentTable: g.tableName, parentKeyCol: g.keyCol }])
                        : [];
                    const usageFields = (usage[ct.key] || []).filter(f => f !== rowsKeyCol);
                    const relationSchema = ct.parentRows ? ((shapeObjectSchemas[g.name] || {})[ct.key] || null) : null;
                    const relationValueSchema = relationSchema && relationSchema.dynamic ? relationSchema.value : null;
                    const relationShapeFields = relationValueSchema && relationValueSchema.kind === 'object' && relationValueSchema.fields
                        ? Object.keys(relationValueSchema.fields) : [];
                    const shapeFields = [...new Set([...(shapes[ct.key] || []), ...relationShapeFields])].filter(f => f !== rowsKeyCol);
                    const initialUsed = new Set(['row_id']);
                    const columns = [];
                    if (ct.parentRows) {
                        for (const ancestor of ancestorKeyCols) {
                            columns.push({ zh: ancestor.col, path: [], itemPath: [], value: '', desc: `关联「${ancestor.parentTable || g.tableName}.${ancestor.parentKeyCol || g.keyCol}」`, type: 'TEXT', ident: toIdent(ancestor.col, initialUsed, 'column') });
                        }
                    }
                    columns.push({ zh: rowsKeyCol, path: [...ct.path], itemPath: [], value: '', desc: '', type: 'TEXT', ident: toIdent(rowsKeyCol, initialUsed, 'column') });
                    const used = new Set(['row_id', ...columns.map(c => c.ident.toLowerCase())]);
                    const fieldOrder = [];
                    const entryRows = [];
                    const relationChildByKey = new Map();
                    const objectFields = new Set();
                    const pairFields = new Set();
                    const fieldDescs = {};
                    let sawScalarEntries = false;
                    let sawObjectEntries = false;
                    // 标量条目字典的值类型：number -> 数值列（INTEGER）；boolean -> 数值列
                    // （INTEGER，logicalType=boolean，读回 true/false）；string/mixed -> 描述列
                    // （TEXT）。mixed 时数值会按文本读回，形状保持 {键: 值} 且不丢“装备名”这类文本。
                    let scalarKind = '';
                    if (relationValueSchema && relationValueSchema.kind !== 'object') {
                        sawScalarEntries = true;
                        scalarKind = relationValueSchema.kind === 'number' || relationValueSchema.kind === 'boolean' ? relationValueSchema.kind : 'text';
                    }
                    // 标量条目（如 世界系统.修仙秘闻: { 标题: 内容 }）的行表标记：
                    // 读回时还原为 {键: 标量}，写入时标量落在「描述/数值」列。
                    let ctScalarValueCol = '';
                    let inferOnly = false;
                    if (isPlainObject(ct.value)) {
                        // 动态字典的首分支可能为空（如 仓库: {}），但其它分支有 {物品: 数量}。
                        // 用非空样本推断标量/对象列和值类型；实际模板行仍保持首分支为空。
                        let valueForInference = ct.value;
                        if (ct.dynamic && Object.keys(ct.value).length === 0) {
                            const samplePath = (ct.path || []).join('.');
                            const sample = dynamicPathSamples.get(samplePath);
                            if (sample && isPlainObject(sample) && Object.keys(sample).length > 0) {
                                valueForInference = sample;
                                inferOnly = true;
                            }
                        }
                        const sourceEntries = [];
                        if (ct.parentRows && Array.isArray(ct.ancestorEntries)) {
                            for (const ae of ct.ancestorEntries) {
                                const childDict = ae && ae.value;
                                if (!isPlainObject(childDict)) continue;
                                for (const entryName of Object.keys(childDict)) {
                                    sourceEntries.push({ parents: (ae.parents || []).slice(), parentKey: (ae.parents || []).slice(-1)[0] || '', entryName, entry: childDict[entryName] });
                                }
                            }
                        } else if (ct.parentRows) {
                            for (const parentKey of Object.keys(valueForInference)) {
                                const childDict = valueForInference[parentKey];
                                if (!isPlainObject(childDict)) continue;
                                for (const entryName of Object.keys(childDict)) {
                                    sourceEntries.push({ parents: [parentKey], parentKey, entryName, entry: childDict[entryName] });
                                }
                            }
                        } else {
                            for (const entryName of Object.keys(valueForInference)) sourceEntries.push({ parentKey: '', entryName, entry: valueForInference[entryName] });
                        }
                        for (const sourceEntry of sourceEntries) {
                            const { parentKey, entryName, entry } = sourceEntry;
                            const parentValues = Array.isArray(sourceEntry.parents) && sourceEntry.parents.length ? sourceEntry.parents : [parentKey];
                            if (!isPlainObject(entry)) {
                                sawScalarEntries = true;
                                const scalarRow = { [rowsKeyCol]: entryName, value: entry, __scalar: true };
                                ancestorKeyCols.forEach((a, i) => { scalarRow[a.col] = parentValues[i] == null ? '' : parentValues[i]; });
                                entryRows.push(scalarRow);
                                continue;
                            }
                            sawObjectEntries = true;
                            for (const subKey of Object.keys(entry)) {
                                const nestedSchema = (shapeObjectSchemas[ct.key] || {})[subKey];
                                const nestedDynamic = !!((dynamicDicts[ct.key] || {})[subKey] || (nestedSchema && nestedSchema.kind === 'object' && nestedSchema.dynamic));
                                if (nestedDynamic) {
                                    let nct = relationChildByKey.get(subKey);
                                    if (!nct) {
                                        nct = {
                                            key: subKey, value: {}, path: [...ct.path, subKey], dynamic: true, parentRows: true, parentKeyCol: rowsKeyCol,
                                            ancestorKeyCols: [
                                                ...ancestorKeyCols.map(a => ({ ...a })),
                                                { col: `${ct.key}_键名`, entity: ct.key, parentTable: tableName, parentKeyCol: rowsKeyCol },
                                            ],
                                            ancestorEntries: [],
                                        };
                                        relationChildByKey.set(subKey, nct);
                                    }
                                    nct.ancestorEntries.push({ parents: [...parentValues, entryName], value: isPlainObject(entry[subKey]) ? entry[subKey] : {} });
                                    continue;
                                }
                                if (!fieldOrder.includes(subKey)) fieldOrder.push(subKey);
                            }
                            const row = { [rowsKeyCol]: entryName };
                            ancestorKeyCols.forEach((a, i) => { row[a.col] = parentValues[i] == null ? '' : parentValues[i]; });
                            for (const subKey of Object.keys(entry)) {
                                if (relationChildByKey.has(subKey)) continue;
                                const sv = entry[subKey];
                                if (isPairLeaf(sv)) {
                                    pairFields.add(subKey);
                                    const pairInfo = leafInfo(sv);
                                    if (pairInfo.desc && !fieldDescs[subKey]) fieldDescs[subKey] = pairInfo.desc;
                                }
                                row[subKey] = isLeaf(sv) ? leafInfo(sv).value : JSON.stringify(sv);
                                if (!isLeaf(sv) && !columns.some(c => c.zh === subKey)) {
                                    objectFields.add(subKey);
                                    fieldOrder.push(subKey);
                                }
                            }
                            entryRows.push(row);
                        }
                        if (sawScalarEntries && !sawObjectEntries) {
                            const scalarValues = entryRows.filter(r => r.__scalar).map(r => r.value).filter(v => v !== null && v !== undefined && v !== '');
                            if (scalarValues.length) {
                                scalarKind = scalarValues.every(v => typeof v === 'number') ? 'number'
                                    : scalarValues.every(v => typeof v === 'boolean') ? 'boolean'
                                    : scalarValues.every(v => typeof v === 'string') ? 'string' : 'mixed';
                            }
                        }
                    }
                    for (const [subKey, node] of Object.entries(shapeObjectSchemas[ct.key] || {})) {
                        if (!node || node.kind !== 'object' || !node.dynamic || relationChildByKey.has(subKey)) continue;
                        relationChildByKey.set(subKey, {
                            key: subKey, value: {}, path: [...ct.path, subKey], dynamic: true, declaredOnly: true, parentRows: true, parentKeyCol: rowsKeyCol,
                            ancestorKeyCols: [
                                ...ancestorKeyCols.map(a => ({ ...a })),
                                { col: `${ct.key}_键名`, entity: ct.key, parentTable: tableName, parentKeyCol: rowsKeyCol },
                            ],
                            ancestorEntries: [],
                        });
                    }
                    // { 动态键: 标量值 } 的规则路径叶子表示“条目键”，不是值对象的字段。
                    // 例如 五维.${能力属性} 不能生成“武力/统率”等空列；值统一落到
                    // scalarValueCol。混合字典仍保留对象条目实际出现的字段。
                    const declaredFields = (sawScalarEntries && !sawObjectEntries) ? [] : [...shapeFields, ...usageFields];
                    const allFields = [...new Set([...declaredFields, ...fieldOrder])].filter(f => !relationChildByKey.has(f));
                    for (const f of allFields) {
                        const relationFieldSchema = relationValueSchema && relationValueSchema.kind === 'object' && relationValueSchema.fields
                            ? relationValueSchema.fields[f] : null;
                        const declaredKind = (relationFieldSchema && relationFieldSchema.kind) || declaredFieldKind(ct.key, f);
                        const isObjectField = objectFields.has(f) || declaredKind === 'object' || declaredKind === 'array';
                        const firstValue = rowFirstValue(entryRows, f);
                        const column = {
                            zh: f,
                            path: [...ct.path, f],
                            itemPath: [f],
                            value: '',
                            desc: fieldDescs[f] || '',
                            type: isObjectField ? 'TEXT' : (fieldIsNumeric(f, firstValue, ct.key) ? 'INTEGER' : inferType(firstValue)),
                            logicalType: declaredKind || (typeof firstValue === 'boolean' ? 'boolean' : ''),
                            range: fieldRange(f),
                            ident: toIdent(f, used, 'column'),
                            // 规则 type 可能省略或解析失败；InitVar 的实际对象/普通数组同样
                            // 是可靠类型来源，不能仅依赖 shapeObjects，否则 JSON 会按 TEXT 读回。
                            isObject: isObjectField,
                            isPair: pairFields.has(f),
                            jsonKind: isObjectField ? (
                                declaredKind === 'array' ? 'array'
                                : declaredKind === 'object' ? 'object'
                                : String(firstValue == null ? '' : firstValue).trim().startsWith('[') ? 'array'
                                : 'object'
                            ) : undefined,
                        };
                        const applied = applyDeclaredShape(column, ct.key, f);
                        if (declaredKind === 'number' || declaredKind === 'boolean') applied.type = 'INTEGER';
                        columns.push(applied);
                    }
                    if (!sawScalarEntries && columns.length === (ct.parentRows ? 2 : 1)) columns.push({
                        zh: '描述', path: [...ct.path, '描述'], itemPath: ['描述'], value: '', desc: '条目描述', type: 'TEXT',
                        ident: toIdent('描述', used, 'column'),
                    });
                    if (sawScalarEntries) {
                        const scalarZh = scalarKind === 'mixed' ? '内容' : ((scalarKind === 'number' || scalarKind === 'boolean') ? '数值' : '描述');
                        ctScalarValueCol = scalarZh;
                        // 标量条目的值补进「描述/数值」列（此前只挂在 r.value 上，
                        // 建行时取 r[列名] 取不到，值会静默丢失）。
                        for (const r of entryRows) {
                            if (r.__scalar) r[scalarZh] = scalarKind === 'mixed' ? JSON.stringify(r.value) : r.value;
                        }
                        if (!columns.some(c => c.zh === scalarZh)) {
                            columns.push({
                                zh: scalarZh,
                                path: [...ct.path, scalarZh],
                                itemPath: [scalarZh],
                                value: '',
                                desc: scalarKind === 'number' ? '条目数值' : scalarKind === 'boolean' ? '条目布尔值（1=true，0=false）' : scalarKind === 'mixed' ? '条目值（JSON 标量，保留字符串/数字/布尔/null 类型）' : '条目描述',
                                type: (scalarKind === 'number' || scalarKind === 'boolean') ? 'INTEGER' : 'TEXT',
                                logicalType: scalarKind === 'boolean' ? 'boolean' : (scalarKind === 'mixed' ? 'jsonScalar' : ''),
                                range: null,
                                ident: toIdent(scalarZh, used, 'column'),
                            });
                        }
                        report.warn(`子表「${ct.key}」存在非对象条目（标量），已归入「${scalarZh}」列，请人工核对`, 'schema');
                    }
                    if (!columns.some(c => c.zh === '_扩展数据')) {
                        columns.push({
                            zh: '_扩展数据',
                            path: [...ct.path, '_扩展数据'],
                            itemPath: ['_扩展数据'],
                            value: '',
                            desc: '本表未在模板声明的动态字段（JSON 存储，读取时自动还原；内部数据，AI 不应直接修改）',
                            type: 'TEXT',
                            range: null,
                            ident: toIdent('_扩展数据', used, 'column'),
                            isObject: true,
                            jsonKind: 'object',
                        });
                    }
                    if (inferOnly) entryRows.length = 0;
                    const rows = entryRows.map(r => {
                        const rowArr = [r.__rowId || (columns.length + 1)];
                        for (const c of columns) {
                            let v = r[c.zh];
                            if (v === undefined || v === null) v = '';
                            if (c.isObject && typeof v === 'object') {
                                try { v = JSON.stringify(v); } catch (e) { v = String(v); }
                            }
                            rowArr.push(v);
                        }
                        return rowArr;
                    });
                    ct.tableName = tableName; // 供父组 note 提示子表用（含重命名后的表名）
                    const parentBasePath = Array.isArray(g.writePaths) && g.writePaths.length && Array.isArray(g.writePaths[0])
                        ? g.writePaths[0].slice() : [g.name];
                    groups.push({
                        name: ct.key,
                        tableName,
                        ident: toIdent(tableName, usedTableIdents, 'table'),
                        kind: ct.parentRows ? 'nestedRows' : 'rows',
                        keyCol: rowsKeyCol,
                        parentKeyCol,
                        ancestorKeyCols,
                        parentTable: ct.parentRows ? g.tableName : '',
                        relationEntity,
                        parentPath: ct.parentRows ? parentBasePath : [],
                        childKey: ct.parentRows ? ct.key : '',
                        keyValue: '',
                        columns,
                        rows,
                        childTables: [...relationChildByKey.values()],
                        source: 'child-table',
                        parentGroup: g.name,
                        writePaths: ct.parentRows ? [[...parentBasePath, '*', ct.key]] : [[...ct.path]],
                        emptyValue: Object.prototype.hasOwnProperty.call(ct, 'emptyValue') ? ct.emptyValue : undefined,
                        reminders: ruleReminders[ct.key] || [],
                        scalarValueCol: ctScalarValueCol,
                    });
                }
            }
            const attached = attachFieldRules(groups, shapeInfo, report);
            disambiguateColumnSlugs(attached, report);
            return attached;
        }
    
    function rowFirstValue(entryRows, field) {
            for (const r of entryRows) {
                if (r[field] !== undefined && r[field] !== '') return r[field];
            }
            return '';
        }
    
    function attachFieldRules(groups, shapeInfo, report) {
            const ruleEnums = (shapeInfo && shapeInfo.enums) || {};
            const ruleFormats = (shapeInfo && shapeInfo.formats) || {};
            const ruleChecks = (shapeInfo && shapeInfo.checks) || {};
            const ruleRanges = (shapeInfo && shapeInfo.ranges) || {};
            const ruleNumeric = (shapeInfo && shapeInfo.numericFields) || new Set();
            const ruleGroupChecks = (shapeInfo && shapeInfo.groupChecks) || {};
            const ruleZodDescs = (shapeInfo && shapeInfo.zodDescs) || {};
            const ruleWildcardRules = (shapeInfo && shapeInfo.wildcardRules) || {};
            const ruleCheckPaths = (shapeInfo && shapeInfo.checkPaths) || [];
            const ruleEnumPaths = (shapeInfo && shapeInfo.enumPaths) || [];
            const ruleReminders = (shapeInfo && shapeInfo.reminders) || {};
    
            // 规则中的 <角色名> / ${条目名} 是动态字典键，而关系表的列路径只保存
            // 固定结构段。比较路径时去掉这些动态占位段；带 | 的 ${A|B} 是固定候选键，
            // 仍按原有候选匹配处理。
            function normalizedRulePath(rulePath) {
                return (Array.isArray(rulePath)
                    ? rulePath
                    : String(rulePath == null ? '' : rulePath).split('.'))
                    .map(s => String(s).trim())
                    .filter(Boolean)
                    .filter(seg => !/^<[^>]+>$/.test(seg) && !/^\$\{[^|}]+\}$/.test(seg) && !/^\[[^\]]+\]$/.test(seg));
            }
    
            // 路径化附着（initvar 优先）：规则分组与 initvar 结构不一致（如规则把 修为
            // 写在根目录、initvar 在 主角.修为）时，按变量树路径匹配列：
            //  - 展平列（修为进度百分比，path=[主角,修为,进度百分比]）↔ 规则路径 修为.进度百分比
            //  - 通配路径（生理.欲望槽）↔ 列路径 主角.生理.欲望槽
            // 规则路径取列路径的后缀（从叶子往回逐段相等）；模板段 ${A|B} 展开后匹配任一候选项。
            function rulePathMatch(rulePath, columnPath) {
                const rp = normalizedRulePath(rulePath);
                if (!Array.isArray(columnPath) || !rp.length) return null;
                if (rp.length > columnPath.length) return null;
                for (let i = 0; i < rp.length; i++) {
                    const seg = String(rp[rp.length - 1 - i]);
                    const col = columnPath[columnPath.length - 1 - i];
                    const segVals = seg.startsWith('${') && seg.endsWith('}')
                        ? seg.slice(2, -1).split('|').map(s => s.trim())
                        : [seg];
                    if (!segVals.includes(String(col))) return null;
                }
                return {
                    exact: rp.length === columnPath.length,
                    sameRoot: String(rp[0]) === String(columnPath[0]),
                    len: rp.length,
                };
            }
            function matchingPathRules(columnPath, entries, pickList) {
                const matches = [];
                for (let i = 0; i < entries.length; i++) {
                    const e = entries[i];
                    const list = pickList(e);
                    if (!list || !list.length) continue;
                    const m = rulePathMatch(e.path, columnPath);
                    if (!m) continue;
                    // 完整路径 > 后缀；更长后缀 > 更短；同顶层组加分；先声明者优先（稳定）
                    const score = (m.exact ? 100000 : 0) + m.len * 100 + (m.sameRoot ? 1000 : 0) - i;
                    matches.push({ rule: e, score, list });
                }
                return matches.sort((a, b) => b.score - a.score);
            }
            const allWildcardRules = [];
            const wildcardSeen = new Set();
            const allReminderRules = [];
            const reminderSeen = new Set();
            for (const list of Object.values(ruleWildcardRules)) {
                for (const rec of (list || [])) {
                    const sig = JSON.stringify([rec.path, rec.range, rec.format, rec.checks]);
                    if (!wildcardSeen.has(sig)) { wildcardSeen.add(sig); allWildcardRules.push(rec); }
                }
            }
            for (const [owner, list] of Object.entries(ruleReminders)) {
                for (const text of (list || [])) {
                    const sig = `${owner}\u0000${text}`;
                    if (!reminderSeen.has(sig)) {
                        reminderSeen.add(sig);
                        allReminderRules.push({ owner, text: String(text) });
                    }
                }
            }
            function explicitReminderPath(text) {
                const head = String(text || '').trim().split(/[\s—–：:]+/, 1)[0].replace(/[，,；;。]+$/, '');
                return head.includes('.') ? head : '';
            }
            function relationRuleMatch(g, rulePath) {
                if (g.kind !== 'nestedRows' && g.kind !== 'nestedArray') return false;
                const rp = normalizedRulePath(rulePath);
                const target = [...(g.parentPath || [g.parentGroup]).map(String), String(g.childKey || g.name)];
                if (!rp.length || !target.length) return false;
                // 允许规则省略最外层组名，但必须覆盖关系字段本身，避免同名叶子误挂。
                const exactPrefix = target.every((seg, i) => String(rp[i]) === seg);
                const suffixTarget = target.length > 1 && target.slice(1).every((seg, i) => String(rp[i]) === seg);
                if (!rp.includes(String(g.childKey || g.name))) return false;
                if (exactPrefix) return { field: rp.length > target.length };
                if (suffixTarget) return { field: rp.length > target.length - 1 };
                return false;
            }
            function relationRuleMatches(g, rulePath) {
                return !!relationRuleMatch(g, rulePath);
            }
            for (const g of groups) {
                // 通配路径规则（如 户.<门牌>.妻.好感值）与组级 check 都按组归到本表（含 JSON 表），
                // 供 buildNote/buildNodeProse 决定“AI 可写”还是“AI 不应修改”
                g.wildcardRules = ruleWildcardRules[g.name] || [];
                if (g.kind === 'nestedRows' || g.kind === 'nestedArray') {
                    // 路径止于集合本身（寻缘蝶.${NPC_ID}.功法）是关系表整体规则；
                    // 继续指向集合内字段的规则是列规则。两者都归关系表，且只保留一份。
                    g.wildcardRules = allWildcardRules
                        .map(r => ({ source: r, match: relationRuleMatch(g, r.path) }))
                        .filter(x => x.match)
                        .map(x => ({ ...x.source, _relationFieldRule: !!x.match.field }));
                    // 自由提醒只有在开头明确给出完整关系路径时才迁移；其余文本不按关键词猜测。
                    g.reminders = [...new Set(allReminderRules
                        .filter(r => {
                            const p = explicitReminderPath(r.text);
                            return p && relationRuleMatches(g, p);
                        })
                        .map(r => r.text))];
                    const ambiguous = (ruleReminders[g.parentGroup] || []).filter(text => {
                        const p = explicitReminderPath(text);
                        return !p && String(text).includes(String(g.childKey || g.name));
                    });
                    if (ambiguous.length && report && typeof report.note === 'function') {
                        report.note(`关系表「${g.tableName}」有 ${ambiguous.length} 条相关自由提醒未写完整路径，已保留在来源表「${g.parentTable}」，未按关键词猜测迁移。`);
                    }
                } else {
                    // 路径已明确属于关系集合的规则全部放入对应关系表，来源实体表不再重复展示。
                    const ownedRelations = groups.filter(rel => (rel.kind === 'nestedRows' || rel.kind === 'nestedArray') && rel.parentTable === g.tableName);
                    if (ownedRelations.length) {
                        g.wildcardRules = g.wildcardRules.filter(r => !ownedRelations.some(rel => relationRuleMatches(rel, r.path)));
                        g.reminders = (g.reminders || []).filter(text => {
                            const p = explicitReminderPath(text);
                            return !p || !ownedRelations.some(rel => relationRuleMatches(rel, p));
                        });
                    }
                }
                const parentList = g.parentGroup ? (ruleChecks[g.parentGroup] || {})[g.name] || [] : [];
                const relationTableChecks = (g.kind === 'nestedRows' || g.kind === 'nestedArray')
                    ? ruleCheckPaths.filter(e => e.tableLevel && relationRuleMatches(g, e.path)).flatMap(e => e.list || [])
                    : [];
                // 固定容器下的动态子表也要继承容器级 check。例如规则写在
                // 主角.服装状态，而真正承载数据的是 主角.服装状态.上装/下装 等行表。
                // 仅按完整逻辑路径前缀传播，不按表名/关键词猜测。
                const groupWritePaths = Array.isArray(g.writePaths) && g.writePaths.length
                    ? g.writePaths : ((g.kind === 'rows' || g.kind === 'singleton') ? [[g.name]] : []);
                const ancestorTableChecks = ruleCheckPaths.filter(e => {
                    if (!e.tableLevel) return false;
                    const rp = normalizedRulePath(e.path);
                    if (!rp.length) return false;
                    return groupWritePaths.some(wp => Array.isArray(wp) && rp.length <= wp.length && rp.every((seg, i) => String(wp[i]) === String(seg)));
                }).flatMap(e => e.list || []);
                if (g.kind === 'nestedRows' || g.kind === 'nestedArray') {
                    const wholeRules = [...new Set([...parentList, ...relationTableChecks, ...ancestorTableChecks])];
                    g.groupChecks = wholeRules;
                } else {
                    g.groupChecks = [...new Set([...parentList, ...(ruleGroupChecks[g.name] || []), ...ancestorTableChecks])];
                }
                // 整组 JSON 表：不套用 [mvu_update] 按字段名的规则（避免误命中同名列），
                // 但组级 check/通配规则已挂上，供“可写判定”使用
                if (g.kind === 'json') continue;
                const gFormats = ruleFormats[g.name] || {};
                const gChecks = ruleChecks[g.name] || {};
                // 表级规则：
                //  - 组级 check（道侣/灵宠/人物/绝色榜/玉简/机遇 等整表规则）→ groupChecks[组名]
                //  - 子表/动态字典（如 世界.动向）：规则声明在父组的字段上（checks[父组][字段]）
                for (const c of g.columns) {
                    // 内部溢出列：不接受按字段名的规则
                    if (c.zh === '_扩展数据') continue;
                    // 关系标识列只负责定位所属实体与子记录。集合级 check（例如“最多三门功法”）
                    // 不能因为路径末段同名而误挂成“键名：最多三门功法”；整体规则留在来源实体表。
                    if (((g.kind === 'rows' || g.kind === 'nestedRows') && c.zh === g.keyCol)
                        || ((g.kind === 'nestedRows' || g.kind === 'nestedArray') && (c.zh === g.parentKeyCol || (g.ancestorKeyCols || []).some(a => a.col === c.zh)))) {
                        // 行表的键列只负责标识动态条目。通配路径末段表示的是键下面的值，
                        // 不能把值的 number/range/check 套到键名本身。
                        c.type = 'TEXT';
                        c.enum = null;
                        c.format = '';
                        c.check = [];
                        c.range = null;
                        continue;
                    }
                    const last = c.path && c.path.length ? c.path[c.path.length - 1] : c.zh;
                    c.enum = !c.isObject ? (ruleEnums[c.zh] || ruleEnums[last] || null) : null;
                    c.format = gFormats[c.zh] || gFormats[last] || '';
                    c.check = gChecks[c.zh] || gChecks[last] || [];
                    if (!c.desc) {
                        const zd = (ruleZodDescs[g.name] || {})[c.zh] || (ruleZodDescs[g.name] || {})[last];
                        if (zd) c.desc = zd;
                    }
                    if (!c.isObject && !c.range && (ruleRanges[c.zh] || ruleRanges[last])) c.range = ruleRanges[c.zh] || ruleRanges[last];
                    if (!c.isObject && c.type !== 'INTEGER' && (ruleNumeric.has(c.zh) || ruleNumeric.has(last))) c.type = 'INTEGER';
                    // 按完整书写路径合并所有同字段规则。多个 [mvu_update] 条目或 YAML+Zod
                    // 可以同时补充 check/range/format，不能只取其中“最佳一条”而覆盖其余。
                    const colPath = c.path || [g.name, c.zh];
                    const enumMatches = !c.isObject ? matchingPathRules(colPath, ruleEnumPaths, e => e.enum) : [];
                    if (enumMatches.length) c.enum = enumMatches[0].list.slice();
                    const matches = [
                        ...matchingPathRules(colPath, ruleCheckPaths.filter(e => !e.tableLevel), e => e.list),
                        ...matchingPathRules(colPath, g.wildcardRules || [], e => e.checks),
                    ].sort((a, b) => b.score - a.score);
                    if (matches.length) {
                        c.check = [...new Set([...(c.check || []), ...matches.flatMap(x => x.list || [])])];
                        const rangeRule = matches.find(x => x.rule && x.rule.range);
                        const formatRule = matches.find(x => x.rule && x.rule.format);
                        if (!c.range && rangeRule) {
                            c.range = rangeRule.rule.range;
                            if (!c.isObject && c.type !== 'INTEGER') c.type = 'INTEGER';
                        }
                        if (!c.format && formatRule) c.format = formatRule.rule.format;
                    }
                }
            }
            return groups;
        }
    
    function sanitizeMacroColumnZh(zh) {
            // 兜底：即使 initvar/规则解析后仍有宏进入列名，也必须在生成模板前清洗，
            // 否则自动初始化会被“固定列名不支持运行时宏”拦截。
            const orig = String(zh == null ? '' : zh);
            let cleaned = orig
                .replace(/<[^>]*>/g, '')
                .replace(/\{\{[\s\S]*?\}\}/g, '')
                .replace(/[:\s]+/g, '_')
                .replace(/_+/g, '_')
                .replace(/^_+|_+$/g, '') || '字段';
            // 保留 _ 前缀内部状态列（_扩展数据 等），不能被清洗成普通列名。
            if (orig.startsWith('_') && !cleaned.startsWith('_')) cleaned = '_' + cleaned;
            return cleaned;
        }
    
    function disambiguateColumnSlugs(groups, report) {
            const pluginSlug = (zh) => {
                let out = '';
                for (const ch of String(zh == null ? '' : zh)) {
                    const code = ch.codePointAt(0);
                    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) {
                        if (out && !out.endsWith('_')) out += '_';
                        out += pinyinOf(ch);
                    } else {
                        out += ch;
                    }
                }
                return out.normalize('NFKD')
                    .replace(/[\u0300-\u036f]/g, '')
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '_')
                    .replace(/^_+|_+$/g, '')
                    .replace(/_+$/g, '');
            };
            for (const g of groups) {
                const used = new Set(['row_id']);
                for (const c of g.columns || []) {
                    let zh = sanitizeMacroColumnZh(c.zh);
                    if (!zh) { c.zh = '列'; zh = '列'; }
                    if (zh !== String(c.zh == null ? '' : c.zh)) c.zh = zh;
                    const slug = pluginSlug(zh);
                    if (!used.has(slug)) {
                        used.add(slug);
                        continue;
                    }
                    let n = 2;
                    let next = `${zh}${n}`;
                    while (used.has(pluginSlug(next))) { n += 1; next = `${zh}${n}`; }
                    report.warn(
                        `表「${g.tableName || g.name}」列「${zh}」与同表其他列映射为相同物理列名候选「${slug}」` +
                        `（如 山西/陕西 拼音相同），已把该列名改为「${next}」；` +
                        `读取路径与 stat_data 形状不变，AI 填表与桥按新列名流转。`,
                        'schema'
                    );
                    c.zh = next;
                    used.add(pluginSlug(next));
                }
            }
        }
    
    function columnLayoutType(c) {
            // stat_data 的结构类型优先于 SQL 物理类型；对象/数组列即使受到同名数值
            // 规则污染，也必须按 JSON 解析，不能退化成 number/text。
            if (c.logicalType === 'jsonScalar') return 'jsonScalar';
            if (c.isObject) return 'object';
            // SQLite 用 INTEGER 0/1 存布尔值，但 stat_data 必须恢复为真正的
            // boolean；否则卡内 Zod 结构校验会拒绝数字。
            if (c.logicalType === 'boolean' || typeof c.value === 'boolean') return 'boolean';
            if (c.type === 'INTEGER' || c.type === 'REAL') return 'number';
            if (c.isPair) return 'pair';
            return 'text';
        }
    
    function buildLayout(schema) {
            const entries = [];
            const pathIndex = new Map();
            const tableByName = {};
    
            for (const g of schema) {
                tableByName[g.tableName] = g;
                if (g.kind === 'json') {
                    const entry = {
                        kind: 'json',
                        scalarType: g.scalarType,
                        group: g.name,
                        table: g.tableName,
                        keyCol: g.keyCol,
                        keyValue: g.keyValue,
                        cols: g.columns.map(c => ({
                            zh: c.zh,
                            type: columnLayoutType(c),
                            fallback: c.value === undefined || c.value === null ? '' : c.value,
                            path: c.path || [g.name, c.zh],
                            isPair: !!c.isPair,
                            desc: c.desc || '',
                        })),
                        writePaths: [[g.name]],
                    };
                    entries.push(entry);
                    pathIndex.set(g.name, { table: g.tableName, json: true });
                    continue;
                }
                if (g.kind === 'array') {
                    const valueCol = g.columns.find(c => c.zh === '内容') || g.columns[0];
                    const entry = {
                        kind: 'array',
                        group: g.name,
                        table: g.tableName,
                        keyCol: g.keyCol,
                        mirrors: [],
                        valueCol: valueCol ? valueCol.zh : '内容',
                        cols: g.columns.map(c => ({
                            zh: c.zh,
                            type: columnLayoutType(c),
                            fallback: c.value === undefined || c.value === null ? '' : c.value,
                            path: c.path || [g.name, c.zh],
                            isPair: !!c.isPair,
                            desc: c.desc || '',
                        })),
                    };
                    entries.push(entry);
                    pathIndex.set(g.name, { table: g.tableName, kind: 'array' });
                    continue;
                }
                if (g.kind === 'singleton') {
                    const entry = {
                        kind: 'singleton',
                        group: g.name,
                        table: g.tableName,
                        keyCol: g.keyCol,
                        keyValue: g.keyValue,
                        cols: g.columns.map(c => ({
                            zh: c.zh,
                            type: columnLayoutType(c),
                            fallback: c.value === undefined || c.value === null ? '' : c.value,
                            path: c.path || [g.name, c.zh],
                            isPair: !!c.isPair,
                            desc: c.desc || '',
                        })),
                    };
                    entries.push(entry);
                    for (const c of g.columns) {
                        pathIndex.set([g.name, c.zh].join('.'), { table: g.tableName, col: c.zh, rowKey: g.keyValue });
                    }
                    continue;
                }
                if (g.kind === 'pathArray' || g.kind === 'nestedArray') {
                    const valueCol = g.columns.find(c => c.zh === '内容') || g.columns[g.columns.length - 1];
                    const entry = {
                        kind: g.kind,
                        group: g.parentGroup || g.name,
                        table: g.tableName,
                        path: g.arrayPath || [g.parentGroup, g.name],
                        parentKeyCol: g.parentKeyCol || '',
                        parentTable: g.parentTable || '',
                        cols: g.columns.map(c => ({
                            zh: c.zh, type: columnLayoutType(c),
                            fallback: c.isObject ? (c.jsonKind === 'array' ? '[]' : '{}') : (c.value === undefined || c.value === null ? '' : c.value),
                            path: [], isPair: false, desc: c.desc || '',
                        })),
                        valueCol: valueCol ? valueCol.zh : '内容',
                    };
                    entries.push(entry);
                    pathIndex.set((g.arrayPath || [g.parentGroup, g.name]).join('.'), { table: g.tableName, kind: g.kind });
                    continue;
                }
                if (g.kind === 'nestedRows') {
                    const parentPath = Array.isArray(g.parentPath) && g.parentPath.length ? g.parentPath.slice() : [g.parentGroup];
                    const entry = {
                        kind: 'nestedRows',
                        group: parentPath[0],
                        parentPath,
                        childKey: g.childKey || g.name,
                        table: g.tableName,
                        keyCol: g.keyCol,
                        parentKeyCol: g.parentKeyCol || `${g.relationEntity || '关联'}_键名`,
                        ancestorKeyCols: Array.isArray(g.ancestorKeyCols) && g.ancestorKeyCols.length
                            ? g.ancestorKeyCols.map(a => a.col)
                            : [g.parentKeyCol || `${g.relationEntity || '关联'}_键名`],
                        parentTable: g.parentTable || '',
                        cols: g.columns.map(c => ({
                            zh: c.zh,
                            type: columnLayoutType(c),
                            fallback: c.isObject ? (c.jsonKind === 'array' ? '[]' : '{}') : (c.value === undefined || c.value === null ? '' : c.value),
                            path: c.itemPath || ((c.zh === g.keyCol || (Array.isArray(g.ancestorKeyCols) && g.ancestorKeyCols.some(a => a.col === c.zh)) || c.zh === g.parentKeyCol) ? [] : [c.zh]),
                            isPair: !!c.isPair,
                            desc: c.desc || '',
                        })),
                        writePaths: [[...parentPath, '*', g.childKey || g.name]],
                        scalarValueCol: g.scalarValueCol || '',
                    };
                    entries.push(entry);
                    pathIndex.set([...parentPath, '*', g.childKey || g.name, '*'].join('.'), {
                        table: g.tableName, rows: true, nestedRows: true,
                        parentKeyCol: entry.parentKeyCol, keyCol: entry.keyCol,
                    });
                    continue;
                }
                // rows（含子表）
                const writePaths = Array.isArray(g.writePaths) && g.writePaths.length
                    ? g.writePaths.map(p => Array.isArray(p) ? p.slice() : [String(p)])
                    : (g.parentGroup ? [[g.parentGroup, g.name]] : [[g.name]]);
                const entry = {
                    kind: 'rows',
                    group: g.name,
                    table: g.tableName,
                    keyCol: g.keyCol,
                    cols: g.columns.map(c => ({
                        zh: c.zh,
                        type: columnLayoutType(c),
                        fallback: c.isObject ? (c.jsonKind === 'array' ? '[]' : '{}') : (c.value === undefined || c.value === null ? '' : c.value),
                        path: c.itemPath || (c.zh === g.keyCol ? [] : (
                            Array.isArray(c.path) && writePaths[0] && c.path.length > writePaths[0].length
                                ? c.path.slice(writePaths[0].length)
                                : [c.zh]
                        )),
                        isPair: !!c.isPair,
                        desc: c.desc || '',
                    })),
                    writePaths,
                    scalarValueCol: g.scalarValueCol || '',
                    emptyValue: Object.prototype.hasOwnProperty.call(g, 'emptyValue') ? g.emptyValue : undefined,
                };
                entries.push(entry);
                const colNames = g.columns.map(c => c.zh);
                for (const wp of writePaths) {
                    for (const c of g.columns) {
                        const suffix = c.itemPath || (c.zh === g.keyCol ? [] : (
                            Array.isArray(c.path) && wp && c.path.length > wp.length ? c.path.slice(wp.length) : [c.zh]
                        ));
                        pathIndex.set([...wp, '*', ...suffix].join('.'), { table: g.tableName, col: c.zh, rows: true, keyCol: g.keyCol });
                    }
                }
            }
            return { entries, pathIndex, tableByName };
        }
    
    function buildLayoutJson(layout) {
            const safe = layout.entries.map(e => ({
                kind: e.kind,
                group: e.group,
                table: e.table,
                keyCol: e.keyCol || '',
                keyValue: e.keyValue || '',
                childKey: e.childKey || '',
                parentKeyCol: e.parentKeyCol || '',
                ancestorKeyCols: e.ancestorKeyCols || (e.parentKeyCol ? [e.parentKeyCol] : []),
                parentTable: e.parentTable || '',
                parentPath: e.parentPath || [],
                path: e.path || [],
                valueCol: e.valueCol || '',
                scalarValueCol: e.scalarValueCol || '',
                scalarType: e.scalarType,
                emptyValue: Object.prototype.hasOwnProperty.call(e, 'emptyValue') ? e.emptyValue : undefined,
                cols: (e.cols || []).map(c => e.kind === 'singleton'
                    ? [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, c.path || [], !!c.isPair, c.desc || '']
                    : [c.zh, c.type, c.fallback === undefined ? '' : c.fallback, c.path || [], !!c.isPair, c.desc || '']),
                writePaths: e.writePaths || [],
                mirrors: e.mirrors || [],
            }));
            return JSON.stringify(safe);
        }
    
    function resolveLayoutMacros(layoutEntries, substituteParams) {
            const entries = JSON.parse(JSON.stringify(Array.isArray(layoutEntries) ? layoutEntries : []));
            if (typeof substituteParams !== 'function') return entries;
            const hasMacro = (value) => typeof value === 'string' && /(?:<(?:user|bot|char|charifnotgroup|group)>|\{\{[^{}]+\}\})/i.test(value);
            const resolveValue = (value) => hasMacro(value) ? String(substituteParams(value)) : value;
            const resolvePath = (path) => Array.isArray(path) ? path.map(resolveValue) : path;
            for (const entry of entries) {
                if (!entry || typeof entry !== 'object') continue;
                entry.group = resolveValue(entry.group);
                entry.keyValue = resolveValue(entry.keyValue);
                entry.childKey = resolveValue(entry.childKey);
                entry.parentPath = resolvePath(entry.parentPath);
                entry.path = resolvePath(entry.path);
                if (Array.isArray(entry.writePaths)) entry.writePaths = entry.writePaths.map(resolvePath);
                if (Array.isArray(entry.cols)) {
                    entry.cols = entry.cols.map(col => {
                        if (!Array.isArray(col)) return col;
                        col[3] = resolvePath(col[3]);
                        return col;
                    });
                }
                if (Array.isArray(entry.mirrors)) {
                    entry.mirrors = entry.mirrors.map(mirror => {
                        if (mirror && typeof mirror === 'object') mirror.path = resolvePath(mirror.path);
                        return mirror;
                    });
                }
            }
            return entries;
        }
    return { leafInfo, maskYamlBlockScalarBodies, yamlStripQuotes, parseInlineEnumValues, yamlCheckItems, yamlExpandTemplateKeys, expandYamlTemplateFieldKey, protectYamlTemplateScalarValues, yamlCollectCheckRanges, collectRulesFromYaml, yamlParseRange, isMvuRulePathKey, registerYamlWildcard, registerWildcardTypeShape, registerYamlField, parseMvuShapes, parseRegisteredZodSchema, mergeZodSchemaNodes, countZodSchemaFlag, mergeRegisteredZodIntoShapeInfo, applyRegisteredZodDefaults, scanGreetingShapeVariation, extractListItems, stripRuleQuotes, scanDynamicKeyNamesFromRules, parseZodStyleRules, isSchemaFieldName, mergeShapeMetadata, parseTypeSchema, parseShapeString, extractYamlBlockScalar, cardTextBlobs, scanStatusUsage, isPairLeaf, isLeaf, collectColumns, inferType, jsonColumnFromObject, schemaTypeLabel, schemaExample, describeObjectSchema, fixedObjectFromValue, fixedObjectSchema, flattenFixedObjectColumns, buildSchema, rowFirstValue, attachFieldRules, sanitizeMacroColumnZh, disambiguateColumnSlugs, columnLayoutType, buildLayout, buildLayoutJson, resolveLayoutMacros };
}

module.exports = createSchemaLayout;
