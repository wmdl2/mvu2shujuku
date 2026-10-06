'use strict';

// AST selects dependencies; JavaScript and the bundled Zod implement their semantics.
function createSchemaExecution({ libraries, runSync, runAsync } = {}) {
    const acorn = libraries.acorn;
    const analysisCache = new Map();
    const knownEngineUrl = url => /(?:^|\/)(?:MagicalAstrogy|NLKASHEI)\/MagVarUpdate(?:@[^/]*)?\/(?:artifact|dist)\/[^?#]*(?:bundle|index)[^/?#]*\.js(?:[?#]|$)/i.test(url)
        || /(?:^|\/)NLKASHEI\/MVU-offline(?:@[^/]*)?\/[^?#]*mvu[_-]?bundle[^/?#]*\.js(?:[?#]|$)/i.test(url);
    function pureEngineLoader(ast) {
        let found = false;
        const load = node => {
            if (node?.type === 'AwaitExpression') return load(node.argument);
            if (node?.type === 'ImportExpression' && node.source.type === 'Literal' && knownEngineUrl(node.source.value)) { found = true; return true; }
            return false;
        };
        const delay = node => {
            if (node?.type !== 'AwaitExpression') return false;
            const promise = node.argument, callback = promise.arguments?.[0];
            if (promise.type !== 'NewExpression' || promise.callee.name !== 'Promise' || promise.arguments.length !== 1
                || !['FunctionExpression', 'ArrowFunctionExpression'].includes(callback?.type) || callback.params.length !== 1 || callback.params[0].type !== 'Identifier') return false;
            const statement = callback.body.type === 'BlockStatement' && callback.body.body.length === 1 ? callback.body.body[0] : null;
            const call = statement?.type === 'ExpressionStatement' || statement?.type === 'ReturnStatement' ? statement.expression || statement.argument : callback.body;
            return call?.type === 'CallExpression' && call.callee.name === 'setTimeout' && call.arguments.length === 2
                && call.arguments[0].type === 'Identifier' && call.arguments[0].name === callback.params[0].name
                && call.arguments[1].type === 'Literal' && Number.isFinite(call.arguments[1].value) && call.arguments[1].value >= 0 && call.arguments[1].value <= 60000;
        };
        const diagnostic = (node, caught) => node?.type === 'CallExpression' && node.callee.type === 'MemberExpression'
            && node.callee.object.name === 'console' && ['log', 'warn', 'error'].includes(node.callee.property.name)
            && node.arguments.every(arg => arg.type === 'Literal' || arg.type === 'Identifier' && caught.has(arg.name));
        function statements(list, caught = new Set()) {
            return list.every(node => {
                if (node.type === 'EmptyStatement') return true;
                if (node.type === 'ImportDeclaration' && node.specifiers.length === 0 && knownEngineUrl(node.source.value)) { found = true; return true; }
                if (node.type === 'ExpressionStatement') return load(node.expression) || delay(node.expression)
                    || node.expression.type === 'Literal' && typeof node.expression.value === 'string' || caught.size > 0 && diagnostic(node.expression, caught);
                if (node.type !== 'TryStatement' || node.finalizer) return false;
                const names = new Set(caught); if (node.handler?.param?.type === 'Identifier') names.add(node.handler.param.name);
                return statements(node.block.body, caught) && (!node.handler || statements(node.handler.body.body, names));
            });
        }
        return statements(ast.body) && found;
    }
    function prepare(source, analysisOnly = false) {
        const ast = acorn.parse(String(source), { ecmaVersion: 'latest', sourceType: 'module' });
        const parents = new WeakMap(), scopeOf = new WeakMap(), bindingIds = new WeakSet();
        const root = { parent: null, kind: 'function', bindings: new Map() }, bindings = [], imports = new Map();
        const names = new Set(['registerMvuSchema']);
        const children = node => Object.entries(node).flatMap(([key,value]) => key === 'parent' ? [] : Array.isArray(value) ? value.filter(x=>x&&typeof x.type==='string').map(x=>[key,x]) : value&&typeof value.type==='string' ? [[key,value]] : []);
        const patternNames = (node, out=[]) => {
            if (!node) return out;
            if (node.type==='Identifier') { out.push(node); bindingIds.add(node); }
            else if (node.type==='RestElement') patternNames(node.argument,out);
            else if (node.type==='AssignmentPattern') patternNames(node.left,out);
            else if (node.type==='ObjectPattern') node.properties.forEach(p=>patternNames(p.type==='RestElement'?p.argument:p.value,out));
            else if (node.type==='ArrayPattern') node.elements.forEach(p=>patternNames(p,out));
            return out;
        };
        function add(pattern, scope, node, kind) {
            const binding={node,scope,kind,names:patternNames(pattern).map(n=>n.name),assignments:[]};
            binding.names.forEach(name=>scope.bindings.set(name,binding));bindings.push(binding);return binding;
        }
        function scan(node, scope, parent, key) {
            if(parent)parents.set(node,{node:parent,key});
            let current=scope;
            if(node.type==='FunctionDeclaration') { if(node.id)add(node.id,scope,node,'function'); current={parent:scope,kind:'function',bindings:new Map()}; node.params.forEach(p=>add(p,current,p,'parameter')); }
            else if(['FunctionExpression','ArrowFunctionExpression'].includes(node.type)) { current={parent:scope,kind:'function',bindings:new Map()}; if(node.id)add(node.id,current,node,'parameter');node.params.forEach(p=>add(p,current,p,'parameter')); }
            else if(node.type==='BlockStatement')current={parent:scope,kind:'block',bindings:new Map()};
            scopeOf.set(node,current);
            if(node.type==='VariableDeclarator') {
                let target=current;const declaration=parent;
                if(declaration.kind==='var')while(target.parent&&target.kind!=='function')target=target.parent;
                add(node.id,target,node,declaration.kind);
            } else if(node.type==='ClassDeclaration'&&node.id)add(node.id,current,node,'class');
            else if(node.type==='ImportDeclaration')for(const specifier of node.specifiers){const b=add(specifier.local,current,specifier,'import');b.module=node.source.value;b.imported=specifier.imported?.name||specifier.imported?.value|| (specifier.type==='ImportNamespaceSpecifier'?'*':'default');imports.set(specifier.local.name,b);if(b.imported==='registerMvuSchema')names.add(specifier.local.name);}
            for(const [childKey,child]of children(node))scan(child,current,node,childKey);
        }
        scan(ast,root);
        const lookup=(name,scope)=>{for(let s=scope;s;s=s.parent)if(s.bindings.has(name))return s.bindings.get(name);};
        const helperBindings = new Map();
        const bindHelper = (pattern, expression, scope) => {
            const load = expression?.type === 'AwaitExpression' ? expression.argument : expression;
            if (load?.type !== 'ImportExpression' || load.source.type !== 'Literal' || typeof load.source.value !== 'string') return;
            if (pattern.type === 'ObjectPattern') for (const property of pattern.properties) {
                if (property.type !== 'Property' || property.computed && property.key.type !== 'Literal'
                    || (property.key.name || property.key.value) !== 'registerMvuSchema' || property.value.type !== 'Identifier') continue;
                const name = property.value.name, binding = lookup(name, scope);
                if (binding) { helperBindings.set(binding, name); names.add(name); }
            }
            else if (pattern.type === 'Identifier' && /mvu_zod\.js(?:[?#]|$)/.test(load.source.value)) {
                const binding = lookup(pattern.name, scope); if (binding) helperBindings.set(binding, '*');
            }
        };
        for (const binding of imports.values()) if (binding.imported === 'registerMvuSchema' || binding.imported === '*' && /mvu_zod\.js(?:[?#]|$)/.test(binding.module)) helperBindings.set(binding, binding.imported === '*' ? '*' : binding.names[0]);
        function origin(node, scope) {
            if (node.type === 'Identifier') { const binding = lookup(node.name, scope); return binding && helperBindings.get(binding) === node.name; }
            if (node.type === 'MemberExpression' && (node.computed ? node.property.value : node.property.name) === 'registerMvuSchema' && node.object.type === 'Identifier') return helperBindings.get(lookup(node.object.name, scope)) === '*';
            if (node.type === 'SequenceExpression') return origin(node.expressions[node.expressions.length - 1], scope);
            return false;
        }
        function scanHelper(node) {
            if (node.type === 'VariableDeclarator') bindHelper(node.id, node.init, scopeOf.get(node));
            if (node.type === 'AssignmentExpression') bindHelper(node.left, node.right, scopeOf.get(node));
            children(node).forEach(([, child]) => scanHelper(child));
        }
        scanHelper(ast);
        function taintHelpers(node) {
            if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') {
                const binding = lookup(node.left.name, scopeOf.get(node));
                const load = node.right.type === 'AwaitExpression' ? node.right.argument : node.right;
                if (helperBindings.has(binding) && load.type !== 'ImportExpression') helperBindings.delete(binding);
            }
            children(node).forEach(([, child]) => taintHelpers(child));
        }
        taintHelpers(ast);
        const registrations=[];
        // Bundlers can forward the imported helper through their module export
        // objects. Keep the established construction protocol for that shape;
        // runtime wiring still requires a directly proven import origin.
        const forwardedMember = node => node.type === 'SequenceExpression' ? forwardedMember(node.expressions[node.expressions.length - 1])
            : node.type === 'MemberExpression' && (node.computed ? node.property.value : node.property.name) === 'registerMvuSchema';
        let hasDirectRegistration = false;
        function findDirect(node) { if (node.type === 'CallExpression' && origin(node.callee, scopeOf.get(node))) hasDirectRegistration = true; children(node).forEach(([, child]) => findDirect(child)); }
        findDirect(ast);
        const forwarded = !analysisOnly && !hasDirectRegistration && [...imports.values()].some(binding => /mvu_zod\.js(?:[?#]|$)/.test(binding.module));
        const isRegistration=node=>node.type==='CallExpression'&&(origin(node.callee,scopeOf.get(node))||forwarded&&forwardedMember(node.callee)||node.callee.type==='Identifier'&&node.callee.name==='registerMvuSchema'&&!lookup(node.callee.name,scopeOf.get(node)));
        function visit(node,fn){fn(node);children(node).forEach(([,c])=>visit(c,fn));}
        visit(ast,node=>{
            if(isRegistration(node)&&node.arguments.length)registrations.push(node);
            if(node.type==='AssignmentExpression'){let left=node.left;while(left.type==='MemberExpression')left=left.object;const b=left.type==='Identifier'&&lookup(left.name,scopeOf.get(node));if(b&&scopeOf.get(node)===b.scope)b.assignments.push(node);}
        });
        if (analysisOnly) return { registrations: registrations.filter(call => origin(call.callee, scopeOf.get(call))).map(call => ({ start: call.callee.start, end: call.callee.end })), pureEngineLoader: pureEngineLoader(ast) };
        if(!registrations.length)throw new Error('未找到可执行的 Schema 登记调用');
        const selected = new Set(), whole = new Set(), usedBindings = new Set(), deferredBindings=new Set(), neededImports=new Set();
        function mark(node){for(let n=node;n;n=parents.get(n)?.node)selected.add(n);}
        function refs(node,deferred=false){
            if(!node)return;
            if(deferred&&['FunctionExpression','ArrowFunctionExpression','FunctionDeclaration'].includes(node.type))return;
            if(node.type==='CallExpression'&&node.callee.type==='MemberExpression'&&!node.callee.computed&&['default','prefault','transform','refine','superRefine','check','preprocess','custom'].includes(node.callee.property.name)){
                refs(node.callee);node.arguments.forEach((argument,index)=>refs(argument,index===0));return;
            }
            if(isRegistration(node)){node.arguments.forEach(refs);return;}
            if(node.type==='Identifier'&&!bindingIds.has(node)){
                const parent=parents.get(node),p=parent?.node,k=parent?.key;
                if(p&&(p.type==='MemberExpression'&&k==='property'&&!p.computed||p.type==='Property'&&k==='key'&&!p.computed||['LabeledStatement','BreakStatement','ContinueStatement'].includes(p.type)))return;
                use(lookup(node.name,scopeOf.get(node)),deferred);
            }
            children(node).forEach(([,c])=>refs(c,deferred));
        }
        function use(binding,deferred=false){
            if(!binding||binding.kind==='parameter'||usedBindings.has(binding)&&(!deferredBindings.has(binding)||deferred))return;
            usedBindings.add(binding);if(deferred)deferredBindings.add(binding);else deferredBindings.delete(binding);
            if(binding.kind==='import'){neededImports.add(binding);return;}
            mark(binding.node);whole.add(binding.node);refs(binding.node,deferred);
            for(const assignment of binding.assignments){mark(assignment);whole.add(assignment);refs(assignment.right);}
        }
        for(const call of registrations){mark(call);call.arguments.forEach(refs);}
        // A registration may live in a named startup function, invoked through
        // another function or a ready callback. Select those calls without
        // retaining unrelated business statements in the startup body.
        const entryFunctions=new Set();
        function selectEntry(node){
            for(let parent=parents.get(node)?.node;parent;parent=parents.get(parent)?.node){
                if(!['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(parent.type))continue;
                if(entryFunctions.has(parent))return;
                entryFunctions.add(parent);
                const binding=bindings.find(b=>b.node===parent||b.node.type==='VariableDeclarator'&&b.node.init===parent);
                if(binding)visit(ast,call=>{
                    if(call.type==='CallExpression'&&call.callee.type==='Identifier'&&lookup(call.callee.name,scopeOf.get(call))===binding){
                        mark(call);call.arguments.forEach(refs);selectEntry(call);
                    }
                });
                return;
            }
        }
        registrations.forEach(selectEntry);
        // Conditions enclosing a registration are part of its dependency contract.
        for(const node of [...selected])for(const key of ['test','init','update','discriminant'])if(node[key])refs(node[key]);
        const importLines=[];
        for(const b of neededImports){
            const url=b.module;let library;
            if(/mvu_zod\.js(?:[?#]|$)/.test(url))library='__helper';
            else if(/(?:^|[/@])zod(?:[/@]|$)/.test(url))library='z';
            else if(/lodash/.test(url))library='_';
            else if(/klona/.test(url))library='__clone';
            else if(/jsonrepair/.test(url))library='__jsonrepair';
            else throw new Error('Schema 依赖的导入尚无隔离实现：'+url);
            const value=b.imported==='*'||b.imported==='default'?library:library==='__clone'||library==='__jsonrepair'?library:library+'['+JSON.stringify(b.imported)+']';
            importLines.push('const '+b.names[0]+'='+value+';');
        }
        function render(node,full=false){
            if(!full&&!whole.has(node)&&node.type==='CallExpression'){
                const callbacks=[];const findCallback=arg=>{if(['FunctionExpression','ArrowFunctionExpression'].includes(arg.type)&&selected.has(arg)){callbacks.push(arg);return;}children(arg).forEach(([,child])=>findCallback(child));};node.arguments.forEach(findCallback);findCallback(node.callee);
                if(callbacks.length)return 'await Promise.all(['+callbacks.map(callback=>'('+renderCapture(callback)+')()').join(',')+'])';
            }
            if(isRegistration(node))return '__capture('+node.arguments.map(a=>render(a,true)).join(',')+')';
            if(node.type==='CallExpression'&&node.callee.type==='MemberExpression'&&!node.callee.computed&&['default','prefault'].includes(node.callee.property.name)&&node.arguments.length===1)return '__default('+render(node.callee.object,full)+','+JSON.stringify(node.callee.property.name)+',()=>('+source.slice(node.arguments[0].start,node.arguments[0].end)+'))';
            if(node.type==='Property'){
                const object=parents.get(node)?.node,call=object&&parents.get(object)?.node;
                if(object?.type==='ObjectExpression'&&call?.type==='CallExpression'&&call.callee.type==='MemberExpression'&&!call.callee.computed&&['object','strictObject','looseObject','extend','safeExtend'].includes(call.callee.property.name)&&node.kind==='init'&&node.method!==true){
                    const key=node.computed?'['+render(node.key,full)+']':source.slice(node.key.start,node.key.end);
                    return key+':__field(()=>('+render(node.value,true)+'))';
                }
            }
            if(!full&&!whole.has(node)&&node.type==='SequenceExpression'&&selected.has(node)){const entries=node.expressions.filter(expression=>selected.has(expression));return '('+entries.map(expression=>render(expression,false)).join(',')+')';}
            if(node.type==='ExpressionStatement')return render(node.expression,full)+';';
            if(node.type==='ImportDeclaration'||node.type==='ExportAllDeclaration'||node.type==='ExportNamedDeclaration'&&!node.declaration)return '';
            if(node.type==='ExportNamedDeclaration'||node.type==='ExportDefaultDeclaration')return render(node.declaration,full);
            if(node.type==='VariableDeclaration'){
                const declarations=node.declarations.filter(n=>full||selected.has(n));
                const parent=parents.get(node);const inLoop=parent&&(['ForOfStatement','ForInStatement'].includes(parent.node.type)&&parent.key==='left'||parent.node.type==='ForStatement'&&parent.key==='init');
                return declarations.length?node.kind+' '+declarations.map(n=>render(n,full)).join(',')+(inLoop?'':';'):'';
            }
            const keepAll=full||whole.has(node);
            if(node.type==='Program'||node.type==='BlockStatement'){
                const statements=node.body.filter(n=>keepAll||selected.has(n)).map(n=>render(n,keepAll)).join('\n');
                return node.type==='Program'?statements:'{\n'+statements+'\n}';
            }
            let text=source.slice(node.start,node.end),edits=[];
            for(const [,child]of children(node)){
                // A selected declaration/function must retain its ordinary runtime body.
                const childFull=keepAll;
                const replacement=render(child,childFull);
                if(replacement!==source.slice(child.start,child.end))edits.push({start:child.start-node.start,end:child.end-node.start,value:replacement});
            }
            for(const e of edits.sort((a,b)=>b.start-a.start))text=text.slice(0,e.start)+e.value+text.slice(e.end);
            return text;
        }
        function renderCapture(callback){const params=callback.params.map(p=>source.slice(p.start,p.end)).join(',');const body=callback.body.type==='BlockStatement'?render(callback.body,false):'{return '+render(callback.body,false)+';}';return 'async ('+params+')=>'+body;}
        const code=importLines.join('\n')+'\n'+render(ast);
        return { code, registrations:registrations.length };
    }
    // This factory is recreated inside the isolated realm, including all callbacks.
    async function execute(libs, program) {
        const captured=[],pending=[], fallbackFields=new WeakSet(), defaults=new WeakMap(),instrumented=new WeakSet(), namespaceCache=new WeakMap();
        const plain=v=>{if(v===undefined)return undefined;const encoded=JSON.stringify(v);if(encoded===undefined)throw new Error('默认值不是JSON值');return JSON.parse(encoded);};
        function instrument(schema){
            if(!schema?._zod||instrumented.has(schema))return schema;
            instrumented.add(schema);
            const methods=new Set();for(let p=schema;p&&p!==Object.prototype;p=Object.getPrototypeOf(p))Object.getOwnPropertyNames(p).forEach(key=>methods.add(key));
            for(const key of methods)if(typeof schema[key]==='function'&&!['constructor','parse','safeParse','parseAsync','safeParseAsync'].includes(key)){
                const original=schema[key];schema[key]=function(...args){const result=Reflect.apply(original,schema,args);if(['default','prefault'].includes(key)&&result?._zod)defaults.set(result._zod.def,typeof args[0]==='function'?{dynamic:true}:{value:plain(args[0]),kind:key});return instrument(result);};
            }
            return schema;
        }
        function namespace(object){
            if(namespaceCache.has(object))return namespaceCache.get(object);
            const proxy=new Proxy(object,{get(target,key){const value=Reflect.get(target,key);if(key==='z')return proxy;if(typeof value==='function')return new Proxy(value,{apply(fn,thisArg,args){return instrument(Reflect.apply(fn,target,args));},construct(fn,args){return instrument(Reflect.construct(fn,args));}});if(value&&typeof value==='object')return namespace(value);return value;}});
            namespaceCache.set(object,proxy);return proxy;
        }
        const __field=value=>{try{return value();}catch(error){if(error.name!=='ReferenceError'&&!/Schema.*(?:依赖|构造依赖)/.test(error.message))throw error;const fallback=libs.zod.unknown().optional();fallbackFields.add(fallback);return fallback;}};
        const __default=(schema,kind,value)=>{let argument;try{argument=value();}catch(error){argument=()=>{throw error;};}return schema[kind](argument);};
        const z=namespace(libs.zod),__capture=schema=>{if(typeof schema==='function')throw new Error('动态Schema提供函数不能固定为转换结构');if(!schema?._zod)throw new Error('登记结果不是Zod Schema');captured.push(schema);};
        const __clone=value=>plain(value),__jsonrepair=libs.jsonrepair?.jsonrepair||libs.jsonrepair;
        const $=callback=>{if(typeof callback!=='function')throw new Error('Schema 构造依赖DOM操作');const value=callback();if(value?.then)pending.push(value);return value;};
        const window={addEventListener(name,callback){if(name!=='load'&&name!=='DOMContentLoaded')throw new Error('Schema 依赖宿主事件');const result=callback();if(result?.then)pending.push(result);}};
        const env={z,_:libs.lodash,__capture,__default,__field,__helper:{registerMvuSchema:__capture},__clone,__jsonrepair,$,window,
            waitGlobalInitialized:async()=>{},registerMvuSchema:__capture,registerVariableSchema:s=>__capture(s.shape?.stat_data||s),
            errorCatched:callback=>callback,jsonrepair:__jsonrepair,klona:__clone,
            console:{log(){},info(){},warn(){},error(){}},eventOn(){throw new Error('Schema 构造依赖宿主事件');}};
        await program(env);
        for(let n=0;n<8;n++){const count=pending.length;await Promise.all(pending);await Promise.resolve();if(count===pending.length)break;}
        if(!captured.length)throw new Error('隔离执行后未登记 Schema');
        const unsupported=[],seen=new Set();let visited=0;
        function walk(schema,path=[],depth=0){
            if(fallbackFields.has(schema)){unsupported.push({path:path.join('.'),kind:'字段构造依赖环境（完整JSON，不补默认）'});return{kind:'unknown',optional:true,unresolved:true};}
            if(!schema?._zod||depth>48||seen.has(schema)||++visited>20000){unsupported.push({path:path.join('.'),kind:'递归或无法展开的结构（完整JSON）'});return{kind:'unknown',unresolved:true};}
            seen.add(schema);const def=schema._zod.def,type=def.type;let node;
            if(['optional','nullable','default','prefault','readonly','nonoptional','catch'].includes(type)){
                node=walk(def.innerType,path,depth+1);
                if(type==='optional')node.optional=true;if(type==='nullable')node.nullable=true;
                if(type==='nonoptional')delete node.optional;
                if(type==='default'||type==='prefault'){
                    const value=defaults.get(def);
                    if(!value||value.dynamic){node.dynamicDefault=true;unsupported.push({path:path.join('.'),kind:'动态默认值（不用于静态开局）'});}
                    else{node.hasDefault=true;node.defaultValue=value.value;node.defaultKind=type;}
                }
                if(type==='catch'){node.dynamicDefault=true;unsupported.push({path:path.join('.'),kind:'catch回退（运行时执行）'});}
            }else if(type==='object'){
                node={kind:'object',fields:{},dynamic:false};
                for(const [key,child]of Object.entries(def.shape))Object.defineProperty(node.fields,key,{value:walk(child,path.concat(key),depth+1),enumerable:true,writable:true,configurable:true});
                if(def.catchall&&def.catchall._zod.def.type!=='never')node.passthrough=true;
            }else if(type==='record')node={kind:'object',fields:{},dynamic:true,keySchema:walk(def.keyType,path.concat('<键>'),depth+1),value:walk(def.valueType,path.concat('<动态键>'),depth+1)};
            else if(type==='array')node={kind:'array',element:walk(def.element,path.concat('<元素>'),depth+1)};
            else if(type==='pipe'){
                node=walk(def.in,path,depth+1);
                if(def.out?._zod.def.type==='transform'){
                    unsupported.push({path:path.join('.'),kind:'业务变换（运行时执行）'});
                    if(path.length)node={kind:'unknown',optional:node.optional,nullable:node.nullable,coerce:node.coerce,...(node.hasDefault?{hasDefault:true,defaultValue:node.defaultValue,defaultKind:node.defaultKind}:{}),dynamicDefault:node.dynamicDefault};
                }else{node=walk(def.out,path,depth+1);unsupported.push({path:path.join('.'),kind:def.in?._zod.def.type==='transform'?'preprocess（运行时执行）':'pipe（运行时执行）'});}
            }else if(type==='lazy'){try{node=walk(def.getter(),path,depth+1);}catch(e){node={kind:'unknown',unresolved:true};unsupported.push({path:path.join('.'),kind:'无法展开的lazy（完整JSON）'});}}
            else if(type==='enum'){const values=[...new Set(Object.values(def.entries))];node={kind:values.every(v=>typeof v==='number')?'number':'text',enum:values};}
            else if(type==='literal'){const values=def.values;node={kind:values.every(v=>typeof v==='number')?'number':values.every(v=>typeof v==='boolean')?'boolean':values.every(v=>typeof v==='string')?'text':'unknown',enum:plain(values)};}
            else if(['string','number','boolean'].includes(type))node={kind:type==='string'?'text':type};
            else {node={kind:'unknown'};if(type==='union'){node.optional=def.options.some(s=>s._zod.def.type==='optional'||s._zod.def.type==='undefined');node.nullable=def.options.some(s=>s._zod.def.type==='nullable'||s._zod.def.type==='null');}if(!['any','unknown'].includes(type))unsupported.push({path:path.join('.'),kind:(type==='union'||type==='intersection'?'联合结构':type)+'（完整 JSON 保留）'});}
            if(def.coerce)node.coerce=true;
            // Read the actual Zod contract, never infer integer semantics from an initial value.
            if(type==='number'){
                const bag=schema._zod.bag;
                node.integer=/^(?:safeint|u?int\d*)$/.test(bag.format||'')
                    || (Number.isInteger(bag.multipleOf)&&bag.multipleOf!==0);
            }
            if(Number.isFinite(schema._zod.bag.minimum))node.min=schema._zod.bag.minimum;if(Number.isFinite(schema._zod.bag.maximum))node.max=schema._zod.bag.maximum;
            for(const check of def.checks||[]){
                const constraint=check?._zod?.def;
                if(!constraint)continue;
                const bound=['greater_than','less_than'].includes(constraint.check);
                if(bound&&constraint.inclusive!==false)continue;
                const kind=constraint.check==='custom'?'refine':constraint.format||constraint.check;
                unsupported.push({path:path.join('.'),kind:kind+'（运行时校验）'});
            }
            const description=schema.description;if(description)node.desc=description;
            seen.delete(schema);return node;
        }
        const roots=captured.map(s=>walk(s));if(roots.some(root=>root.kind!=='object'))throw new Error('根Schema不是可映射对象');
        return { roots,unsupported,engine:'javascript-zod',versions:{zod:libs.zod.core.version,acorn:libs.acorn.version} };
    }
    function program(plan){return 'async function(__env){const {z,_,__capture,__default,__field,__helper,__clone,__jsonrepair,$,window,waitGlobalInitialized,registerMvuSchema,registerVariableSchema,console,eventOn,errorCatched,jsonrepair,klona}=__env;\n'+plan.code+'\n}';}
    function job(source){const plan=prepare(source);return { execute:execute.toString(),program:program(plan) };}
    function analyzeScript(source) {
        if (!/registerMvuSchema|MagVarUpdate|MVU-offline/.test(source)) return { registrations: [], pureEngineLoader: false };
        if (analysisCache.has(source)) return analysisCache.get(source);
        let result; try { result = prepare(source, true); } catch (_) { result = { registrations: [], pureEngineLoader: false }; }
        if (source.length < 128 * 1024) { if (analysisCache.size >= 32) analysisCache.delete(analysisCache.keys().next().value); analysisCache.set(source, result); }
        return result;
    }
    return {prepare,job,analyzeScript,inspectSync:source=>runSync(job(source)),inspect:source=>runAsync(job(source))};
}
module.exports=createSchemaExecution;
