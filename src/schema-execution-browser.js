'use strict';
// Opaque-origin iframe creates a terminating worker with no network or parent API.
function createSchemaExecutionBrowser({ createExecution, libraries, runtimeSource, document, timeout=6000 }) {
    function bootstrap() {
        let worker,port;
        window.addEventListener('message',event=>{
            if(event.source!==parent)return;
            if(event.data?.cancel){worker?.terminate();return;}
            if(!event.ports[0]||worker)return;
            port=event.ports[0];
            const blob=new Blob([event.data.code],{type:'text/javascript'}),url=URL.createObjectURL(blob);
            try{
                worker=new Worker(url);
                worker.onmessage=message=>{port.postMessage(message.data);worker.terminate();URL.revokeObjectURL(url);};
                worker.onerror=error=>{port.postMessage({error:error.message});worker.terminate();URL.revokeObjectURL(url);};
            }catch(error){port.postMessage({error:error.message});URL.revokeObjectURL(url);}
        });
    }
    const runAsync=job=>new Promise((resolve,reject)=>{
        const frame=document.createElement('iframe'),channel=new MessageChannel();frame.hidden=true;frame.setAttribute('sandbox','allow-scripts');frame.dataset.mvuSchemaEvaluator='true';
        let timer;
        const finish=(error,result)=>{clearTimeout(timer);frame.contentWindow?.postMessage({cancel:true},'*');channel.port1.close();frame.remove();error?reject(error):resolve(result);};
        channel.port1.onmessage=event=>event.data.error?finish(new Error(event.data.error)):finish(null,event.data.result);
        const code='var module={exports:{}};var exports=module.exports;\n'+runtimeSource+'\nMath.random=()=>{throw new Error("Schema构造依赖随机值")};const OriginalDate=Date;Date=new Proxy(OriginalDate,{construct(t,args){if(!args.length)throw new Error("Schema构造依赖当前时间");return Reflect.construct(t,args);},apply(){throw new Error("Schema构造依赖当前时间")},get(t,k){if(k==="now")return()=>{throw new Error("Schema构造依赖当前时间")};return Reflect.get(t,k);}});\nPromise.resolve(('+job.execute+')(module.exports,('+job.program+'))).then(result=>postMessage({result}),error=>postMessage({error:error.message}));';
        frame.onload=()=>frame.contentWindow.postMessage({code},'*',[channel.port2]);
        frame.srcdoc='<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; connect-src \'none\'; script-src \'unsafe-inline\' \'unsafe-eval\' blob:; worker-src blob:"><script>('+bootstrap.toString()+')();<\/script>';
        timer=setTimeout(()=>finish(new Error('Schema隔离执行超时')),timeout);document.body.appendChild(frame);
    });
    return createExecution({libraries,runAsync,runSync(){throw new Error('浏览器转换注册Schema须调用异步转换入口');}});
}
module.exports=createSchemaExecutionBrowser;
