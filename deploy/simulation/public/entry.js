const adminKey='Simulation-Admin-2026-Local-Only-001';
const status=document.getElementById('status');
const translatorButton=document.getElementById('translator');
let working=false;
function currentUser(){try{return JSON.parse(localStorage.getItem('zk_user')||'null')}catch{return null}}
function saveUser(user){localStorage.setItem('zk_registered','1');localStorage.setItem('zk_user',JSON.stringify({id:user.id,name:user.name,realName:user.realName}))}
function clearUser(){localStorage.removeItem('zk_registered');localStorage.removeItem('zk_user')}
if(currentUser()?.id){translatorButton.querySelector('span').textContent='继续翻译';document.getElementById('translator-hint').textContent='回到你的工作台，继续上次的任务。'}
async function request(path,body){
 const response=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
 const data=await response.json();if(!response.ok){const error=new Error(data.error||'暂时无法连接，请稍后重试');error.status=response.status;throw error}return data;
}
async function run(message,work){
 if(working)return;working=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);status.dataset.error='false';status.textContent=message;
 try{await work()}catch(e){status.dataset.error='true';status.textContent=e.name==='TimeoutError'?'连接超时，请重试。已创建的账号和任务会保留。':e.message||'网络暂时不可用，请稍后重试';working=false;document.querySelectorAll('button').forEach(b=>b.disabled=false)}
}
async function enterTranslator(fresh=false){
 if(fresh){await request('/api/auth/logout',{});clearUser()}
 try{const session=await request('/api/auth/session');if(!session.authenticated||!session.user?.id)throw new Error('未确认登录身份，请重试');saveUser(session.user)}catch(e){if(e.status===401){clearUser();location.href='/?workspace=translator&register=1';return}else throw e}
 location.href='/?workspace=translator';
}
translatorButton.onclick=()=>run('正在打开翻译工作台…',()=>enterTranslator());
document.getElementById('new-translator').onclick=()=>run('正在打开志愿者注册…',()=>enterTranslator(true));
document.getElementById('admin').onclick=()=>run('正在打开管理工作台…',async()=>{
 await request('/api/admin/auth/login',{key:adminKey});location.href='/?workspace=admin';
});
