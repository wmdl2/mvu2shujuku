'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const libraries=require('./vendor/schema-engine-libs');
const createFactory=require('./schema-execution');
const runtimeSource=fs.readFileSync(path.join(__dirname,'vendor/schema-engine-libs.js'),'utf8');
const cache=new Map();
function runSync(job){
    const key=crypto.createHash('sha256').update(job.program).digest('hex');if(cache.has(key))return JSON.parse(cache.get(key));
    const {Worker}=require('worker_threads'),shared=new SharedArrayBuffer(4*1024*1024+8),state=new Int32Array(shared,0,2);
    const worker=new Worker(`
        const {workerData}=require('worker_threads'),vm=require('vm');
        const state=new Int32Array(workerData.shared,0,2),bytes=new Uint8Array(workerData.shared,8);
        const done=value=>{const result=Buffer.from(JSON.stringify(value));if(result.length>bytes.length){done({error:'Schema结构超过大小限制'});return;}bytes.set(result);Atomics.store(state,1,result.length);Atomics.store(state,0,1);Atomics.notify(state,0);};
        const context=vm.createContext({}, {codeGeneration:{strings:false,wasm:false}});
        try {
            vm.runInContext('var module={exports:{}};var exports=module.exports;'+workerData.runtimeSource,context,{timeout:3000});
            vm.runInContext('Math.random=()=>{throw new Error("Schema构造依赖随机值")};const OriginalDate=Date;Date=new Proxy(OriginalDate,{construct(t,args){if(!args.length)throw new Error("Schema构造依赖当前时间");return Reflect.construct(t,args);},apply(){throw new Error("Schema构造依赖当前时间")},get(t,k){if(k==="now")return()=>{throw new Error("Schema构造依赖当前时间")};return Reflect.get(t,k);}});',context,{timeout:1000});
            const promise=vm.runInContext('('+workerData.job.execute+')(module.exports,('+workerData.job.program+'))',context,{timeout:3000});
            Promise.resolve(promise).then(result=>done({result}),error=>done({error:error.message,stack:error.stack}));
        }catch(error){done({error:error.message,stack:error.stack});}
    `,{eval:true,workerData:{shared,job,runtimeSource},resourceLimits:{maxOldGenerationSizeMb:96}});
    worker.on('error',()=>{});worker.unref();
    const wait=Atomics.wait(state,0,0,6000);worker.terminate();
    if(wait==='timed-out')throw new Error('Schema隔离执行超时');
    const data=JSON.parse(Buffer.from(new Uint8Array(shared,8,Atomics.load(state,1))).toString('utf8'));
    if(data.error){const error=new Error(data.error);error.executionStack=data.stack;throw error;}
    if(cache.size>=64)cache.delete(cache.keys().next().value);cache.set(key,JSON.stringify(data.result));return data.result;
}
module.exports=createFactory({libraries,runSync,runAsync:async job=>runSync(job)});
