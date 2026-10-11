import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const base='http://127.0.0.1:8080';
async function api(path,body,cookie,method=body?'POST':'GET'){
 const res=await fetch(base+path,{method,headers:{'content-type':'application/json',...(cookie?{cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const data=await res.json();assert(res.ok,`${path}: ${res.status}`);return{data,cookie:res.headers.get('set-cookie')?.split(';')[0]||cookie};
}
const admin=await api('/api/admin/auth/login',{key:process.env.ADMIN_KEY});
const existing=(await api('/api/articles',undefined,admin.cookie)).data.articles;
if(existing.length){console.log('测试数据已存在，保留所有体验记录。');process.exit(0)}
const fixtures=JSON.parse(readFileSync('/simulation/fixtures.json','utf8'));const articleIds=[];
for(const a of fixtures){
 const r=await api('/api/admin/articles',{title:a.title,text:a.pairs.map(p=>p.source).join('\n'),sourceLanguage:a.sourceLanguage,targetLanguage:a.targetLanguage,translatorSlots:a.translatorSlots},admin.cookie);
 articleIds.push(r.data.articleId);
}
let submitted=0;let selected;
for(let i=1;i<=3;i++){
 const u=await api('/api/auth/register',{realName:`示例译者${i}`,phone:`1000000000${i}`,idNumber:`TEST-ID-SEED-0${i}`,bankCardNo:`TEST-CARD-SEED-0${i}`});
 const tasks=(await api('/api/assignments/request',{userId:u.data.user.id,articleId:articleIds[0],count:2},u.cookie)).data.assignments;
 for(const a of tasks){
  // Explicit human test submissions, never labeled or stored as model output.
  await api(`/api/assignments/${a.id}/submit`,{userId:u.data.user.id,content:`【人工测试提交·译者${i}】这是一份用于体验审核和报表的示例译文，请根据原文进行修改。`},u.cookie);submitted++;
 }
}
const translations=(await api('/api/admin/translations?articleId='+articleIds[0],undefined,admin.cookie)).data.translations;
if(translations.length){selected=translations[0].id;await api(`/api/admin/translations/${selected}/review`,{decision:'accepted'},admin.cookie)}
console.log(JSON.stringify({seeded:true,articles:3,sentences:18,virtualTranslators:3,humanTestSubmissions:submitted,accepted:1,model:'plmf/glm-5.3-flash',modelSource:'real_provider'},null,2));
