'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..'),refs=process.env.MVU_REFERENCE_ROOT||path.resolve(root,'../参考资料');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(refs,'测试工具/browsers');
const {chromium}=require(path.join(refs,'测试工具/node_modules/playwright'));
async function main(){
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage();let requests=0;const errors=[];
  await page.route('https://schema-execution.invalid/**',async route=>{requests++;await route.abort();});page.on('pageerror',error=>errors.push(error.message));
  await page.goto('about:blank');
  const source=fs.readFileSync(path.join(root,'index.js'),'utf8'),boot='window.__MVU2SHUJUKU_EXTENSION_RUNTIME_INSTALLER__(window);',position=source.lastIndexOf(boot);
  assert(position>=0);await page.addScriptTag({content:source.slice(0,position)+';'+source.slice(position+boot.length)});
  const result=await page.evaluate(async()=>{
   const core=window.MVU2SHUJUKU_CORE;
   const card=content=>({name:'浏览器真实Schema样本',character_book:{entries:[{comment:'[InitVar]',content:'',enabled:false}]},extensions:{tavern_helper:{scripts:[{enabled:true,name:'结构',content:"import {registerMvuSchema} from 'https://schema-execution.invalid/mvu_zod.js';"+content}]}}});
   const outputs=[];
   for(const content of [String.raw`const S=z.object({"\u72b6\u6001":z.number().default(1)});registerMvuSchema(S);`,'const key="状态";const S=z.object({[key]:z.number().default(1)});registerMvuSchema(S);','const 状态=z.number().default(1);const S=z.object({状态});$(errorCatched(async()=>{registerMvuSchema(S),document.write("不应执行");})());']){
    const r=await core.convertWithRemoteSchemas(card(content));outputs.push(core.statDataFromTables(JSON.parse(r.card.extensions.mvu2shujuku.layout),r.template).stat_data);
   }
   let fetchError,timeoutError;
   const typedCard=card('const S=z.object({组:z.object({小数:z.number(),整数:z.int(),布尔:z.boolean(),评分:z.number().transform(v=>_.clamp(v,0,5))})});registerMvuSchema(S);');
   typedCard.character_book.entries[0].content=JSON.stringify({组:{小数:0,整数:2,布尔:false,评分:0}});
   const typed=await core.convertWithRemoteSchemas(typedCard);
   const columns=typed.schema.find(g=>g.name==='组').columns.filter(c=>['小数','整数','布尔','评分'].includes(c.zh)).map(c=>[c.zh,c.type]);
   try{await core.convertWithRemoteSchemas(card('const x=await fetch("https://schema-execution.invalid/blocked");const S=z.object({[x]:z.number()});registerMvuSchema(S);'));}catch(e){fetchError=e.message;}
   try{await core.convertWithRemoteSchemas(card('const S=(()=>{while(true){}})();registerMvuSchema(S);'));}catch(e){timeoutError=e.message;}
   return {outputs,columns,fetchError,timeoutError,frames:document.querySelectorAll('[data-mvu-schema-evaluator]').length};
  });
  assert.deepStrictEqual(result.outputs,[{状态:1},{状态:1},{状态:1}]);assert.match(result.fetchError,/fetch|Failed|Content Security/i);assert.match(result.timeoutError,/超时/);assert.strictEqual(result.frames,0);assert.strictEqual(requests,0);assert.deepStrictEqual(errors,[]);
  assert.deepStrictEqual(Object.fromEntries(result.columns),{小数:'REAL',整数:'INTEGER',布尔:'INTEGER',评分:'TEXT'});
  console.log(JSON.stringify({cases:6,requests,frames:result.frames,errors,columns:result.columns}));
 }finally{await browser.close();}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
