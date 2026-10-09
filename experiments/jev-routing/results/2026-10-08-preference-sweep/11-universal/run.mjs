import fs from 'node:fs/promises';
import path from 'node:path';
import { routeSubagent, loadSubagentRoutingConfig } from '/code/pi-harness/src/subagent-routing.mjs';
const key = (await fs.readFile('/dev/stdin', 'utf8')).trim();
if (!key) throw Error('Missing temporary key');
const config = loadSubagentRoutingConfig('/tmp/pi-jev-universal-check/config.json');
const output = '/tmp/pi-jev-universal-check';
await fs.mkdir(output, {recursive:true});
await fs.writeFile(path.join(output,'config.json'), JSON.stringify(config,null,2));
const sets = ['original_cases.json','omp_subagent_benchmark_cases.json','omp_english_benchmark.json','recovered_english_cases.json','omp_subagent_prompts_all.json'];
const rawCases = (await Promise.all(sets.map(async dataset => (JSON.parse(await fs.readFile('/code/pi-harness/experiments/jev-routing/'+dataset,'utf8'))).map(c=>({...c,dataset}))))).flat();
const previous = JSON.parse(await fs.readFile('/tmp/pi-current-jev-results/results.json','utf8'));
const cached = new Map(previous.map(r=>[r.dataset+'|'+r.id,r]));
const prior = JSON.parse(await fs.readFile('/tmp/pi-jev-suitability-not/results.json','utf8'));
const comparison = new Map(prior.map(r=>[r.dataset+'|'+r.id,r]));
const excluded=[];
const cases=rawCases.filter(c=>{
 const assignment=cached.get(c.dataset+'|'+c.id).calls[0].request.state.delegated_assignment;
 const chars=Array.from(assignment);
 c.chineseRatio=chars.filter(ch=>/[\u4e00-\u9fff]/u.test(ch)).length/chars.length;
 if(c.chineseRatio>=0.2){excluded.push({dataset:c.dataset,id:c.id,chineseRatio:c.chineseRatio});return false;}
 return true;
});
await fs.writeFile(path.join(output,'language-filter.json'),JSON.stringify({formula:'Han characters U+4E00..U+9FFF / all Unicode codepoints of the full delegated_assignment; exclude >= 0.2',raw:rawCases.length,valid:cases.length,excluded},null,2));
const sampleSeed = JSON.parse(await fs.readFile('/tmp/pi-current-jev-results/random-sample.json','utf8')).seed;
const native = (response,model) => ({...response,api:'typesafe-system-one',provider:model.provider,model:model.id,stopReason:'stop'});
const results=[];
async function runCase(c) {
 const calls=[]; let debits=0;
 const registry={
  findOfType(type,provider,id){return {type,provider,id};},
  find(provider,id){const m=config.models.find(m=>m.provider===provider&&m.model===id);return m?{type:'chat',provider,id}:undefined;},
  async classify(model,context,options){
   const request={model:model.id,...context};
   if (context.questions.role) {
    const old = cached.get(c.dataset+'|'+c.id).calls[0];
    if (JSON.stringify(old.request)!==JSON.stringify(request)) throw Error('Recorded role payload differs; refusing reuse');
    calls.push({...old,reused:true});
    return native(old.response,model);
   }
   const start=Date.now();
   const res=await fetch('https://openrouter.ai/api/alpha/decisions',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(request),signal:options.signal});
   const text=await res.text();
   const response=JSON.parse(text);
   calls.push({request,response,httpStatus:res.status,latencyMs:Date.now()-start});
   if(!res.ok)throw Error('HTTP '+res.status+': '+JSON.stringify(response).replaceAll(key,'[REDACTED]'));
   return native(response,model);
  }
 };
 const row={id:c.id,name:c.task_name,dataset:c.dataset,chineseRatio:c.chineseRatio,baselineModel:comparison.get(c.dataset+'|'+c.id).model,expectedRole:c.expected_role??c.expectedRole??null,legacyExpectedModel:c.expected_model??c.expectedModel??null,calls};
 try {
  const assignment=c.delegated_assignment ?? (c.batch_context?.trim()?`# Batch context\n\n${c.batch_context}\n\n# Task\n\n${c.task}`:c.task);
  const routed=await routeSubagent({registry,task:assignment,config,signal:AbortSignal.timeout(45000),budget:{beginModelCall(){return {ok:true,sequence:++debits};}}});
  const selected=config.models.find(m=>m.provider===routed.model.provider&&m.model===routed.model.id);
  Object.assign(row,{role:routed.roleId,model:selected.id,provider:routed.model.provider,modelId:routed.model.id,thinking:routed.thinkingLevel,roleMatch:row.expectedRole===null?null:routed.roleId===row.expectedRole});
 } catch(e){row.error={code:e.code??null,message:String(e.message).replaceAll(key,'[REDACTED]')};}
 results.push(row);
 await fs.appendFile(path.join(output,'results.jsonl'),JSON.stringify(row)+'\n');
 console.log(JSON.stringify({...row,calls:row.calls.map(call=>({httpStatus:call.httpStatus,answers:call.response.answers,usage:call.response.usage,latencyMs:call.latencyMs}))}));
}
await fs.writeFile(path.join(output,'results.jsonl'),'');
let next=0;
await Promise.all(Array.from({length:8},async()=>{while(next<cases.length){const c=cases[next++];await runCase(c);}}));
results.sort((a,b)=>sets.indexOf(a.dataset)-sets.indexOf(b.dataset)||a.id.localeCompare(b.id));
await fs.writeFile(path.join(output,'results.json'),JSON.stringify(results,null,2));
const {randomBytes,createHash}=await import('node:crypto');
const seed=sampleSeed;
const sample=results.map(r=>({r,rank:createHash('sha256').update(seed+'|'+r.dataset+'|'+r.id).digest('hex')})).sort((a,b)=>a.rank.localeCompare(b.rank)).slice(0,20).map(({r})=>({...r,assignment:cases.find(c=>c.id===r.id&&c.dataset===r.dataset).delegated_assignment??cases.find(c=>c.id===r.id&&c.dataset===r.dataset).task}));
await fs.writeFile(path.join(output,'random-sample.json'),JSON.stringify({seed,sample},null,2));
const success=results.filter(r=>!r.error);
const summary={rawCases:rawCases.length,excludedCases:excluded.length,totalCases:cases.length,baselineModels:Object.fromEntries(config.models.map(m=>[m.id,cases.filter(c=>comparison.get(c.dataset+'|'+c.id).model===m.id).length])),changedModels:success.filter(r=>r.model!==r.baselineModel).length,attempted:results.length,completed:success.length,errors:results.filter(r=>r.error).length,roleMatches:success.filter(r=>r.roleMatch).length,labeledCases:success.filter(r=>r.expectedRole!==null).length,roleMismatches:success.filter(r=>r.roleMatch===false).map(r=>({id:r.id,expected:r.expectedRole,actual:r.role})),selectedModels:Object.fromEntries(config.models.map(m=>[m.id,success.filter(r=>r.model===m.id).length])),sampleSeed:seed,sampleSize:sample.length,newApiRequests:results.reduce((n,r)=>n+r.calls.filter(c=>!c.reused).length,0),reusedRoleResponses:results.reduce((n,r)=>n+r.calls.filter(c=>c.reused).length,0),apiRequests:results.reduce((n,r)=>n+r.calls.length,0),additionalCostUsd:results.reduce((n,r)=>n+r.calls.filter(c=>!c.reused).reduce((n,c)=>n+(c.response.usage?.cost??0),0),0),output};
await fs.writeFile(path.join(output,'summary.json'),JSON.stringify(summary,null,2));
console.log('SUMMARY '+JSON.stringify(summary));
if(summary.errors||summary.completed!==summary.totalCases)process.exitCode=1;
