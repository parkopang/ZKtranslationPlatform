import assert from 'node:assert/strict';
import {createServer} from 'node:http';
const bigmodel = process.env.TEST_MODEL_PROVIDER === 'bigmodel';
process.env.DOTENV_CONFIG_PATH = '/dev/null';
Object.assign(process.env, { NODE_ENV:'test', PORT:'0', DB_PATH:':memory:', SEED_DEMO:'false',
  ADMIN_KEY:'generated-test-admin-not-production', PII_ENCRYPTION_KEY:'generated-test-pii-not-production',
  LLM_PROVIDER:'minimax', MINIMAX_KEY_TYPE:'platform_api', MINIMAX_API_KEY:'synthetic-key',
  LLM_RETRY_ATTEMPTS:'1', LLM_RATE_LIMIT_DELAY_MS:'1', LLM_FAILURE_COOLDOWN_MS:'1' });
delete process.env.REDIS_URL;
if (bigmodel) Object.assign(process.env, {LLM_PROVIDER:'bigmodel', BIGMODEL_KEY_TYPE:'coding_plan', BIGMODEL_API_KEY:'synthetic-key'});
let calls = 0;
const mock = createServer((req,res) => {
  calls++;
  assert.equal(req.headers.authorization, 'Bearer synthetic-key');
  req.resume();
  if (bigmodel) assert.equal(req.url, '/api/coding/paas/v4/chat/completions');
  res.writeHead(bigmodel ? 429 : 200, {'Content-Type':'application/json',trace_id:'synthetic-trace'});
  // HTTP success with business quota failure must never become a translation.
  res.end(JSON.stringify(bigmodel ? {error:{code:'1113',message:'private upstream details'}} : {base_resp:{status_code:2056,status_msg:'private upstream details'},choices:[]}));
});
await new Promise<void>(resolve => mock.listen(0,'127.0.0.1',resolve));
const mockAddress = mock.address(); assert(mockAddress && typeof mockAddress !== 'string');
process.env.MINIMAX_BASE_URL = `http://127.0.0.1:${mockAddress.port}/v1/chat/completions`;
if (bigmodel) process.env.BIGMODEL_BASE_URL = `http://127.0.0.1:${mockAddress.port}/api/coding/paas/v4/chat/completions`;
const {server,db,suggestions} = await import('./server.js');
const addr = server.address(); assert(addr && typeof addr !== 'string');
const base = `http://127.0.0.1:${addr.port}`;
async function request(path: string, body?: unknown, cookie='') {
 const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',cookie},body:body?JSON.stringify(body):undefined});
 const data:any=await response.json(); assert(response.ok, JSON.stringify(data));
 return {response,data,cookie:response.headers.get('set-cookie')?.split(';')[0] || ''};
}
try {
 const health=await request('/api/readyz'); assert.equal(health.data.modelCheck,'configuration_only');
 if (bigmodel) assert.equal(health.data.modelUsageWarning,'coding_plan_custom_application_not_officially_supported');
 const admin=await request('/api/admin/auth/login',{key:process.env.ADMIN_KEY});
 const article=await request('/api/admin/articles',{title:'合成模型异常文章',text:'A test sentence.',targetLanguage:'中文',translatorSlots:2},admin.cookie);
 const user=await request('/api/auth/register',{realName:'模拟译者',phone:'13800000901',idNumber:'110101199001010011',bankCardNo:'6222000000000000000'});
 const assigned=await request('/api/assignments/request',{userId:user.data.user.id,count:1,articleId:article.data.articleId},user.cookie);
 const assignment=assigned.data.assignments[0];
 await request(`/api/users/${user.data.user.id}/tasks`,undefined,user.cookie);
 for(let i=0;i<50;i++) {
  const row:any=db.prepare('SELECT suggestion_status FROM sentences WHERE id=?').get(assignment.sentenceId);
  if(row.suggestion_status==='failed') break;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 const tasks=await request(`/api/users/${user.data.user.id}/tasks`,undefined,user.cookie);
 assert.equal(tasks.data.tasks[0].suggestionStatus,'failed');
 assert.equal(tasks.data.tasks[0].translationSuggestion,null);
 assert.equal(tasks.data.tasks[0].suggestionError,bigmodel ? 'provider_insufficient_balance' : 'provider_plan_quota_exhausted');
 await Promise.all(Array.from({length:10},()=>request(`/api/users/${user.data.user.id}/tasks`,undefined,user.cookie)));
 assert.equal(calls,1,'page polling must not retry fatal quota error');
 const retry=await fetch(`${base}/api/admin/sentences/${assignment.sentenceId}/pretranslate`,{method:'POST',headers:{cookie:admin.cookie}});
 assert.equal(retry.status,429);
 assert.equal((await retry.json() as any).accepted,false);
 assert.ok(Number(retry.headers.get('retry-after')) > 0);
 assert.equal(calls,1,'admin retry during cooldown must not ignore cooldown');
 const submitted=await request(`/api/assignments/${assignment.id}/submit`,{userId:user.data.user.id,content:'可以继续手工翻译。'},user.cookie);
 assert.equal(submitted.response.status,201);
 const metric=await request('/api/admin/metrics',undefined,admin.cookie);
 assert.equal(metric.data.model.failed,1);
 assert.equal(metric.data.suggestions[0].status,'failed');
 assert(!JSON.stringify(tasks.data).includes('private upstream details'));
 console.log(`model API integration passed: ${bigmodel ? 'Coding Plan HTTP429/1113' : 'MiniMax HTTP200/2056'} -> persisted failure -> no retry on 10 readers -> manual translation still submits`);
} finally {
 server.close(); await suggestions.close(); db.close(); mock.close();
}
