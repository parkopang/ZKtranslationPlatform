function updateNavigation(){
 for(const selector of ['.mobile-topbar .top-actions','.admin-topbar']){
  const header=document.querySelector(selector);
  if(header&&!header.querySelector('.workspace-entry')){const link=document.createElement('a');link.className='workspace-entry';link.href='/simulation/';link.textContent='工作空间';header.append(link)}
 }
}
new MutationObserver(updateNavigation).observe(document.getElementById('root'),{childList:true,subtree:true});updateNavigation();
