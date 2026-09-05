// Entirely invented data. No backend, filesystem sessions, or network mutations.
S.reduce=true;S.maxw=24;S.tasks.clear();S.foreign.clear();
const params=new URLSearchParams(location.search);
const stress='긴단일식별자_'+'OrderExportStateTransition'.repeat(6);
const statuses=['wait','run','run','queue','done','err','cancelled','closed','run','queue'];
if(!params.has('empty')){
for(let i=0;i<10;i++){
 const id='T-'+String(i+1).padStart(2,'0');
 const t={id,uuid:'synthetic-task-'+i,title:i===9?stress:['주문 내역 내보내기 검증','Review export state transitions','결제 오류 처리 테스트'][i%3]+' '+(i+1),status:statuses[i],statusLabel:STATUS_LABEL[statuses[i]],size:'normal',project:['sample-shop','sample-api','sample-dashboard'][i%3],model:'Claude',effort:'high',step:'Synthetic test activity',children:[],sub:false,branch:'test/export-state',sid:'synthetic-session-'+i,proc:'alive',gen:1,worktree:'/workspace/synthetic/projects/sample-shop/feature/export-state-transitions',startedAt:new Date(Date.now()-(i+1)*61000),endedAt:null,events:[],question:null};
 if(i===0)t.question={q:'주문 내역 export 형식으로 어느 쪽을 쓸까요?',chips:['JSON — Order 전체를 왕복 가능하게 직렬화 (`exportJson` / 파싱 검증 테스트)','CSV — history를 행 단위 표로 출력 (`exportCsv` / 이스케이프·빈 history 테스트)',stress]};
 S.tasks.set(id,t);
 if(i<3)for(let c=1;c<=4;c++){const child={...t,id:id+'.'+c,uuid:'synthetic-child-'+i+'-'+c,title:'검증 단계 '+c+' · Validate export',sub:true,parent:id,question:null,children:[],status:'run',statusLabel:'Running',agentType:'verify'};t.children.push(child.id);S.tasks.set(child.id,child);}
}
for(let i=0;i<4;i++)S.foreign.set('synthetic-foreign-'+i,{key:'synthetic-foreign-'+i,title:'sample-editor-'+(i+1),short:'—',kind:'interactive',stateLabel:i%2?'Idle':'Unknown',cwd:'/workspace/synthetic/projects/a-very-long-project-directory-name-'+i+'/packages/export-state-transitions',sid:'synthetic-session-outside-'+i,firstSeen:new Date(Date.now()-24000000),startedAt:new Date(Date.now()-24000000),lastSeen:new Date()});
const t=S.tasks.get('T-01');
LEDGER.push({id:'synthetic-request',text:'주문 내역 내보내기를 검증해 주세요.',bucket:'needs_you',st:'wait',state:'Needs input',disposition:'dispatched',dispositionLabel:'Sent to T-01',taskId:t.id,taskIds:[t.id],source:'user',answer:t.question.q,answerKind:'question',actions:['answer']});
chatQuestion(t);
}
function syncFixture(){
 for(const row of LEDGER){const t=S.tasks.get(row.taskId);if(!t)continue;row.st=t.status;row.state=t.statusLabel;row.bucket=t.status==='wait'?'needs_you':['done','closed','cancelled'].includes(t.status)?'settled':'in_flight';row.actions=t.question?['answer']:[];row.answer=t.question?.q||'Synthetic state: '+t.statusLabel;row.answerKind=t.question?'question':'summary';}
 document.querySelectorAll('.m-chips').forEach(box=>{const t=S.tasks.get(box.dataset.task);box.querySelectorAll('button').forEach(b=>b.disabled=t?.status!=='wait')});
 relayout();
}
window.relay={
 answer:(t,choice)=>{document.body.dataset.fixtureAnswer=choice;t.status='run';t.statusLabel='Running';t.question=null;chatNote('Synthetic answer accepted');syncFixture()},
 send:async(text,ask,task)=>{
  document.body.dataset.fixtureSend=JSON.stringify({text,ask,task});
  await new Promise(resolve=>setTimeout(resolve,params.has('slow')?1800:80));
  if(params.has('fail')){chatNote('Synthetic send failed. Draft retained.');return false}
  chatUser(text);chatNote(ask?'Synthetic transcript answer':'Synthetic request accepted');return true;
 },
 fetchDetail:async()=>{},attach:()=>chatNote('Synthetic attach'),
 stop:t=>{t.status='cancelled';t.statusLabel='Cancelled';t.question=null;syncFixture()},
 restart:t=>{t.status='run';t.statusLabel='Running';syncFixture()},
 archive:t=>{t.status='closed';t.statusLabel='Archived';syncFixture()},
 stopForeign:()=>chatNote('Synthetic outside stop requested'),
 pause:()=>{S.paused=!S.paused;refresh()},setMax:n=>{S.maxw=n;refresh()}
};
if(params.has('dark'))Theme.set('dark');else Theme.set('light');
if(params.has('missing')){const f=S.foreign.get('synthetic-foreign-0');if(f){f.cwd='—';f.directoryPath=null}}
if(params.has('root')){const f=S.foreign.get('synthetic-foreign-0');if(f){f.cwd='/';f.directoryPath='/'}}
relayout();
if(params.has('updates')){
 let update=0;
 setInterval(()=>{[renderSidebar,renderLedger,refresh][update++%3]()},1000);
}
