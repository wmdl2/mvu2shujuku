'use strict';

// 转换配置与外部表合并的数据规划。宿主读取、确认和结果提交由运行时负责。
function createConversionProfiles(deps) {
    'use strict';
    const { core, resultView, readTemplateSource, listSheets } = deps || {};

    function sheetFingerprint(sheet) {
        return core && typeof core.stableHash === 'function' ? core.stableHash(sheet) : JSON.stringify(sheet || {});
    }

    function captureProfile({ name, result, appliedRefs, updatedAt }) {
        const tableConfigs = {};
        for (const { sheet } of listSheets(result || { template: {} })) {
            tableConfigs[String(sheet.name || '')] = resultView.captureConfig(sheet);
        }
        return {
            format: 'mvu2shujuku-conversion-profile',
            version: 1,
            name,
            tableConfigs,
            externalTables: JSON.parse(JSON.stringify(appliedRefs || [])),
            updatedAt,
        };
    }

    function upsertRef(refs, ref) {
        const same = refs.findIndex(x => x && x.source && x.source.value === ref.source.value && x.name === ref.name);
        if (same >= 0) refs[same] = ref;
        else refs.push(ref);
    }

    function refFromSheet(sourceValue, uid, sheet) {
        return { source: { value: sourceValue }, uid, name: String(sheet.name || uid), fingerprint: sheetFingerprint(sheet) };
    }

    async function planProfile({ template, profile, name }) {
        const baseTemplate = JSON.parse(JSON.stringify(template || {}));
        let next = JSON.parse(JSON.stringify(baseTemplate));
        const notes = [];
        const configs = profile.tableConfigs || {};
        const configNames = Object.keys(configs).filter(Boolean);
        const newTableNames = Object.keys(next).filter(k => k.startsWith('sheet_')).map(k => String(next[k] && next[k].name || '')).filter(Boolean);
        const matchedConfigNames = configNames.filter(tableName => newTableNames.indexOf(tableName) >= 0);
        const missingConfigNames = configNames.filter(tableName => newTableNames.indexOf(tableName) < 0);
        const addedTableNames = newTableNames.filter(tableName => configNames.indexOf(tableName) < 0);
        for (const key of Object.keys(next).filter(k => k.startsWith('sheet_'))) {
            const sheet = next[key];
            const cfg = sheet && configs[String(sheet.name || '')];
            if (!cfg) continue;
            resultView.applyConfig(sheet, cfg);
        }
        const refs = [];
        const refsBySource = new Map();
        for (const ref of Array.isArray(profile.externalTables) ? profile.externalTables : []) {
            const value = String(ref && ref.source && ref.source.value || '');
            if (!value) continue;
            if (!refsBySource.has(value)) refsBySource.set(value, []);
            refsBySource.get(value).push(ref);
        }
        let externalRequested = 0;
        let externalAdded = 0;
        let externalProblems = 0;
        for (const [sourceValue, sourceRefs] of refsBySource) {
            externalRequested += sourceRefs.length;
            let sourceTemplate = null;
            try { sourceTemplate = await readTemplateSource(sourceValue); } catch (e) {}
            if (!sourceTemplate) { notes.push('来源不可用：' + sourceValue); externalProblems += sourceRefs.length; continue; }
            const selected = [];
            const resolvedRefs = [];
            for (const ref of sourceRefs) {
                let uid = String(ref.uid || '');
                let sheet = uid && sourceTemplate[uid];
                if (!sheet || String(sheet.name || '') !== String(ref.name || '')) {
                    const matches = Object.keys(sourceTemplate).filter(k => k.startsWith('sheet_') && sourceTemplate[k] && String(sourceTemplate[k].name || '') === String(ref.name || ''));
                    if (matches.length !== 1) { notes.push('未找到外部表：' + ref.name); externalProblems++; continue; }
                    uid = matches[0];
                    sheet = sourceTemplate[uid];
                }
                selected.push(uid);
                const latest = refFromSheet(sourceValue, uid, sheet);
                resolvedRefs.push(latest);
                if (ref.fingerprint && ref.fingerprint !== latest.fingerprint) notes.push('来源已更新：' + latest.name);
            }
            if (selected.length) {
                const merged = core.mergeTemplates(next, sourceTemplate, selected);
                next = merged.template;
                for (const ref of resolvedRefs) {
                    if (merged.added.indexOf(ref.name) >= 0) { refs.push(ref); externalAdded++; }
                    else { notes.push('同名冲突已跳过：' + ref.name + '（' + sourceValue + '）'); externalProblems++; }
                }
            }
        }
        // 合表后覆盖一次设置，保持外部表的配置应用顺序。
        for (const key of Object.keys(next).filter(k => k.startsWith('sheet_'))) {
            const sheet = next[key];
            const cfg = sheet && configs[String(sheet.name || '')];
            if (!cfg) continue;
            resultView.applyConfig(sheet, cfg);
        }
        const summaryLines = [
            '配置：' + name,
            '表格设置匹配：' + matchedConfigNames.length + '/' + configNames.length + ' 张表',
            '配置中本次不存在：' + (missingConfigNames.length ? missingConfigNames.join('、') : '无'),
            '本次新表：' + (addedTableNames.length ? addedTableNames.join('、') : '无'),
            '外部表：成功 ' + externalAdded + '/' + externalRequested + (externalProblems ? '，异常 ' + externalProblems : ''),
        ];
        const mostlyMissing = configNames.length > 0 && matchedConfigNames.length / configNames.length < 0.5;
        const emptyProfile = configNames.length === 0 && externalRequested === 0;
        return {
            template: next, baseTemplate, notes, refs,
            summary: summaryLines.join('\n'),
            needsConfirm: emptyProfile || mostlyMissing || externalProblems > 0,
            stats: { matchedConfigNames, missingConfigNames, addedTableNames, externalRequested, externalAdded, externalProblems },
        };
    }

    function planManualMerge({ template, sourceTemplate, selected, source, priorRefs }) {
        const merged = core.mergeTemplates(template, sourceTemplate, selected);
        const refs = Array.isArray(priorRefs) ? priorRefs.slice() : [];
        for (const uid of selected) {
            const sheet = sourceTemplate[uid];
            if (!sheet || merged.added.indexOf(String(sheet.name || uid)) === -1) continue;
            upsertRef(refs, refFromSheet(source, uid, sheet));
        }
        return { merged, refs };
    }

    return { sheetFingerprint, captureProfile, planProfile, planManualMerge };
}

module.exports = createConversionProfiles;
