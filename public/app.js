const state = { data: null, selected: null, actorId: getActorId() };
const $ = s => document.querySelector(s);

function getActorId(){let id=localStorage.getItem('hamkari_actor');if(!id){id=crypto.randomUUID();localStorage.setItem('hamkari_actor',id)}return id}
function level(score){if(score>=100)return 5;if(score>=78)return 4;if(score>=52)return 3;if(score>=28)return 2;if(score>0)return 1;return 0}
function fa(n){return new Intl.NumberFormat('fa-IR').format(n)}

async function request(url, options={}){
  const res=await fetch(url,{headers:{'Content-Type':'application/json','X-Actor-Id':state.actorId,...options.headers},...options});
  const data=await res.json();
  if(!res.ok)throw new Error(data.error||'خطا در ارتباط با سرور');
  return data;
}

async function load(){state.data=await request('/api/project');render()}

function render(){
  const {project,pieces}=state.data;
  $('#projectTitle').textContent=project.title;
  $('#projectSubtitle').textContent=project.subtitle;
  $('#projectLocation').textContent=project.location;
  const avg=Math.round(pieces.reduce((a,x)=>a+x.score,0)/pieces.length);
  $('#completion').textContent=`${fa(avg)}٪`;
  $('#completionBar').style.width=`${avg}%`;
  const committed=pieces.filter(x=>x.score===100).length;
  const serious=pieces.filter(x=>x.score>=52&&x.score<100).length;
  const open=pieces.filter(x=>x.score<28).length;
  $('#metrics').innerHTML=[['قطعات کل',pieces.length],['تعهد قطعی',committed],['در مذاکره جدی',serious],['فرصت‌های باز',open]].map(x=>`<div class="metric"><strong>${fa(x[1])}</strong><span>${x[0]}</span></div>`).join('');
  $('#puzzle').innerHTML=pieces.map(p=>`<button class="piece" data-id="${p.id}" data-level="${level(p.score)}"><div class="piece-top"><span class="category">${p.category}</span><span>${p.stage}</span></div><h3>${p.title}</h3><p>${p.description}</p><div class="piece-footer"><span>${fa(p.stats.followers)} دنبال‌کننده</span><span class="score">${fa(p.score)}٪</span></div></button>`).join('');
  document.querySelectorAll('.piece').forEach(el=>el.addEventListener('click',()=>openPiece(el.dataset.id)));
}

async function openPiece(id){
  state.selected=state.data.pieces.find(x=>x.id===id);
  await interact('view',false,true);
  fillDialog();
  $('#pieceDialog').showModal();
}

function fillDialog(){
  const p=state.selected;
  $('#detailCategory').textContent=p.category;
  $('#detailTitle').textContent=p.title;
  $('#detailDescription').textContent=p.description;
  $('#detailTarget').textContent=p.target_value;
  $('#detailStage').textContent=p.stage;
  $('#detailScore').textContent=`${fa(p.score)}٪ تثبیت`;
  $('#detailBar').style.width=`${p.score}%`;
  $('#detailStats').innerHTML=[['مشاهده',p.stats.views],['دنبال‌کننده',p.stats.followers],['اعلام آمادگی',p.stats.interests],['پیشنهاد جدی',p.stats.proposals]].map(x=>`<div class="detail-stat"><strong>${fa(x[1])}</strong><span>${x[0]}</span></div>`).join('');
}

async function interact(action,remove=false,silent=false){
  if(!state.selected)return;
  try{
    const updated=await request(`/api/pieces/${state.selected.id}/interactions`,{method:'POST',body:JSON.stringify({actorId:state.actorId,action,remove})});
    const index=state.data.pieces.findIndex(x=>x.id===updated.id);state.data.pieces[index]=updated;state.selected=updated;render();
    if(!silent){fillDialog();toast(action==='follow'?'این بخش به فهرست پیگیری شما اضافه شد.':'آمادگی شما ثبت شد.')}
  }catch(e){toast(e.message,true)}
}

function toast(text,error=false){const t=$('#toast');t.textContent=text;t.style.background=error?'#7a271a':'#172c24';t.classList.add('show');setTimeout(()=>t.classList.remove('show'),3000)}

$('#closeDialog').addEventListener('click',()=>$('#pieceDialog').close());
$('#closeCommit').addEventListener('click',()=>$('#commitDialog').close());
$('#followBtn').addEventListener('click',()=>interact('follow'));
$('#interestBtn').addEventListener('click',()=>interact('interest'));
$('#openCommitment').addEventListener('click',()=>{$('#pieceDialog').close();$('#commitDialog').showModal()});
$('#resetIdentity').addEventListener('click',()=>{localStorage.removeItem('hamkari_actor');location.reload()});
$('#commitForm').addEventListener('submit',async e=>{
  e.preventDefault();$('#formError').textContent='';
  try{
    const updated=await request(`/api/pieces/${state.selected.id}/commitments`,{method:'POST',body:JSON.stringify({actorId:state.actorId,actorName:$('#actorName').value,note:$('#commitNote').value})});
    const index=state.data.pieces.findIndex(x=>x.id===updated.id);state.data.pieces[index]=updated;state.selected=updated;render();
    $('#commitDialog').close();e.target.reset();toast('پیشنهاد شما ثبت شد و اکنون در مرحله بررسی است.');
  }catch(err){$('#formError').textContent=err.message}
});

load().catch(e=>toast(e.message,true));
