'use strict';
// 从本地 MVU 快照 schema.ts 的 generateSchema / reconcileAndApplySchema 移植。
// 仅移除 TypeScript 类型和模块导入；规则与处理顺序保留。
function createMvuSchema(lodash) {
/*
Copyright (c) 2025 MagicalAstrogy & StageDog.

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

*/
    const _ = lodash;
    const klona = value => JSON.parse(JSON.stringify(value));
    const EXTENSIBLE_MARKER = '$__META_EXTENSIBLE__$';
    const isArraySchema = value => value.type === 'array';
    const isObjectSchema = value => value.type === 'object';
function generateSchema(
    data,
    oldSchemaNode,
    parentRecursiveExtensible = false
) {
    // @ts-expect-error hack for mvu zod
    if (oldSchemaNode === '没有用别管这个') {
        return { type: 'any' };
    }

    if (Array.isArray(data)) {
        let isExtensible = false;
        let isRecursiveExtensible = parentRecursiveExtensible;
        let oldElementType;
        let template;

        // 使用类型守卫检查 oldSchemaNode 是否为 ArraySchemaNode
        if (oldSchemaNode) {
            if (isArraySchema(oldSchemaNode)) {
                isExtensible = oldSchemaNode.extensible === true;
                isRecursiveExtensible =
                    oldSchemaNode.recursiveExtensible === true || parentRecursiveExtensible;
                oldElementType = oldSchemaNode.elementType;
                template = oldSchemaNode.template;
            } else {
                console.error(
                    `Type mismatch: expected array schema but got ${oldSchemaNode.type} at path`
                );
            }
        }

        // 检查是否有只包含 $meta 的元素
        const metaElementIndex = data.findIndex(
            item =>
                _.isObject(item) &&
                !_.isDate(item) &&
                '$arrayMeta' in item &&
                '$meta' in item &&
                item['$arrayMeta'] === true
        );

        if (metaElementIndex !== -1) {
            const metaElement = data[metaElementIndex];
            // 从 $meta 中提取数组的元数据
            if (metaElement.$meta.extensible !== undefined) {
                isExtensible = metaElement.$meta.extensible;
            }
            if (metaElement.$meta.template !== undefined) {
                template = metaElement.$meta.template;
            }
            // 从数组中移除这个元数据元素
            data.splice(metaElementIndex, 1);
            console.log(`Array metadata element found and processed.`);
        }

        // 检查并处理魔法字符串
        const markerIndex = data.indexOf(EXTENSIBLE_MARKER);
        if (markerIndex > -1) {
            isExtensible = true;
            // 从数组中移除标记，以免影响后续的类型推断
            data.splice(markerIndex, 1);
            console.log(`Extensible marker found and removed from an array.`);
        }

        const schema_node = {
            type: 'array',
            extensible: isExtensible || parentRecursiveExtensible,
            recursiveExtensible: isRecursiveExtensible,
            elementType:
                data.length > 0
                    ? generateSchema(data[0], oldElementType, isRecursiveExtensible)
                    : { type: 'any' },
        };

        if (template !== undefined) {
            schema_node.template = template;
        }

        return schema_node;
    }
    if (_.isObject(data) && !_.isDate(data)) {
        const typedData = data; // 类型断言

        // 使用类型守卫检查 oldSchemaNode 是否为 ObjectSchemaNode
        let oldExtensible = false;
        let oldRecursiveExtensible = parentRecursiveExtensible;
        let oldProperties;

        if (oldSchemaNode) {
            if (isObjectSchema(oldSchemaNode)) {
                oldExtensible = oldSchemaNode.extensible === true;
                oldRecursiveExtensible =
                    oldSchemaNode.recursiveExtensible === true || parentRecursiveExtensible;
                oldProperties = oldSchemaNode.properties;
            } else {
                console.error(
                    `Type mismatch: expected object schema but got ${oldSchemaNode.type} at path`
                );
            }
        }

        const schemaNode = {
            type: 'object',
            properties: {},
            // 默认不可扩展，但检查旧 schema、$meta.extensible 或 parentRecursiveExtensible
            extensible:
                oldExtensible ||
                typedData.$meta?.extensible === true ||
                typedData.$meta?.recursiveExtensible === true ||
                parentRecursiveExtensible,
            recursiveExtensible:
                oldRecursiveExtensible || typedData.$meta?.recursiveExtensible === true,
        };

        // 处理 template
        if (typedData.$meta?.template !== undefined) {
            schemaNode.template = typedData.$meta.template;
        } else if (oldSchemaNode && isObjectSchema(oldSchemaNode) && oldSchemaNode.template) {
            schemaNode.template = oldSchemaNode.template;
        }

        // 暂存父节点的 $meta，以便在循环中使用
        const parentMeta = typedData.$meta;

        // 从 $meta 中读取信息后，将其从数据中移除，避免污染
        if (typedData.$meta) {
            delete typedData.$meta;
        }

        for (const key in data) {
            const oldChildNode = oldProperties?.[key];
            // 传递当前节点的 recursiveExtensible（如果存在）或父节点的 recursiveExtensible
            // 但如果当前节点明确设置 extensible: false, 则停止递归扩展
            const childRecursiveExtensible =
                schemaNode.extensible !== false && schemaNode.recursiveExtensible;
            const childSchema = generateSchema(
                typedData[key],
                oldChildNode,
                childRecursiveExtensible
            );

            // 一个属性是否必需？

            // 1. 默认值: 如果父节点可扩展，子节点默认为可选；否则为必需。
            let isRequired = !schemaNode.extensible;

            // 2. 覆盖规则: 检查父元数据中的 'required' 数组。
            //    如果父节点的 $meta.required 是一个数组，并且当前 key 在这个数组里，
            //    则无论默认值是什么，都强制覆盖为必需。
            if (Array.isArray(parentMeta?.required) && parentMeta.required.includes(key)) {
                isRequired = true;
            }

            // 3. 检查旧 schema 的设置，作为最后的参考
            if (oldChildNode?.required === false) {
                // 如果旧 schema 明确说这个是可选的，那么以这个为准
                isRequired = false;
            } else if (oldChildNode?.required === true) {
                isRequired = true;
            }

            schemaNode.properties[key] = {
                ...childSchema,
                required: isRequired,
            };
        }
        return schemaNode;
    }
    // 处理原始类型
    const dataType = typeof data;
    if (dataType === 'string' || dataType === 'number' || dataType === 'boolean') {
        return { type: dataType };
    }
    // 对于其他类型（function, symbol, bigint, undefined 等），默认返回 'any'
    return { type: 'any' };
}

function reconcileAndApplySchema(variables) {
    console.log('Reconciling schema with current data state...');

    // 1. 深拷贝数据，以防 generateSchema 修改原始数据（例如删除 $meta）
    const currentDataClone = klona(variables.stat_data);

    // 2. 使用改进后的 generateSchema 生成一个与当前数据完全匹配的新 Schema，
    //    并在此过程中从旧 Schema 继承元数据。
    const newSchema = generateSchema(currentDataClone, variables.schema);

    // 3. 直接用新 Schema 替换旧 Schema
    // stat_data 的根节点应该始终是对象，所以生成的 schema 也应该是 ObjectSchemaNode
    if (!isObjectSchema(newSchema)) {
        return;
    }

    // 保留 RootAdditionalProps
    const newSchemaWithProps = newSchema;
    if (variables.schema?.strictTemplate !== undefined) {
        newSchemaWithProps.strictTemplate = variables.schema.strictTemplate;
    }
    if (variables.schema?.strictSet !== undefined) {
        newSchemaWithProps.strictSet = variables.schema.strictSet;
    }
    if (variables.schema?.concatTemplateArray !== undefined) {
        newSchemaWithProps.concatTemplateArray = variables.schema.concatTemplateArray;
    }
    if (_.has(variables.stat_data, '$meta.strictTemplate'))
        newSchemaWithProps.strictTemplate = variables.stat_data['$meta']?.strictTemplate;
    if (_.has(variables.stat_data, '$meta.strictSet'))
        newSchemaWithProps.strictSet = variables.stat_data['$meta']?.strictSet;
    if (_.has(variables.stat_data, '$meta.concatTemplateArray'))
        newSchemaWithProps.concatTemplateArray = variables.stat_data['$meta']
            ?.concatTemplateArray;

    variables.schema = newSchemaWithProps;

    console.log('Schema reconciliation complete.');
}

    return { generateSchema, reconcileAndApplySchema };
}
module.exports = createMvuSchema;
