'use strict';

// Only our session-scoped writers use this view. Never replace the public API
// identity used by the history cache or change the host's default write policy.
function createDatabaseWriteApi(api) {
    // This public interface was added with the modern object-form CRUD API.
    // Older hosts keep their exact positional calls. A host with the source
    // interface but without the optional wait flag simply retains its default.
    if (!api || typeof api.getTableHistoryContext !== 'function') return api;
    const fields = {
        updateCell: ['tableName', 'rowIndex', 'colIdentifier', 'value'],
        updateRow: ['tableName', 'rowIndex', 'data'],
        insertRow: ['tableName', 'data'],
        deleteRow: ['tableName', 'rowIndex'],
    };
    return new Proxy(api, {
        get(target, property) {
            const value = Reflect.get(target, property, target);
            if (typeof value !== 'function') return value;
            return function (...args) {
                if (Object.prototype.hasOwnProperty.call(fields, property)) {
                    const objectForm = args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]);
                    const options = objectForm ? { ...args[0] }
                        : Object.fromEntries(fields[property].map((key, index) => [key, args[index]]));
                    args = [{ ...options, awaitFrontendReadback: false }];
                } else if (property === 'importTableAsJson') {
                    args = [args[0], { ...args[1], awaitFrontendReadback: false }];
                }
                // The original Promise still includes the strict commit/save
                // and frontend notification. Only the extra readback wait ends.
                return value.apply(target, args);
            };
        },
    });
}

module.exports = createDatabaseWriteApi;
