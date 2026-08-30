"use strict";
/* ================= helpers ================= */
const $=s=>document.querySelector(s);
function el(tag,cls,txt){const n=document.createElement(tag);if(cls)n.className=cls;if(txt!=null)n.textContent=txt;return n}
const pad=n=>String(n).padStart(2,"0");
const clock=d=>pad(d.getHours())+":"+pad(d.getMinutes())+":"+pad(d.getSeconds());
function dur(ms){const s=Math.floor(ms/1000);return pad(Math.floor(s/60))+":"+pad(s%60)}

/* ================= theme ================= */
const Theme={
  KEY:"relay-theme",mode:"system",
  init(){
    const m=localStorage.getItem(this.KEY);
    this.mode=["system","light","dark"].includes(m)?m:"system";
    this.apply(true);
  },
  set(m){this.mode=m;localStorage.setItem(this.KEY,m);this.apply(false);renderSettings()},
  apply(initial){
    const r=document.documentElement;
    if(this.mode==="system"){if(!initial)r.removeAttribute("data-theme")}
    else r.setAttribute("data-theme",this.mode);
  },
};
Theme.init();

/* ================= state ================= */
const ROW_H=128, SUB_ROW=102, COL_TASK=312, COL_SUB=596, ROW_Y0=40;
const S={tasks:new Map(),seq:0,sel:null,maxw:10, /* 기본 10, 상한 없음(초과 시 소프트 경고) */autofit:true,reduce:false,layout:"tree",paused:false,usage:0,conn:"ok"};
const USAGE={small:40000,normal:120000,epic:400000,sub:60000,dispatch:25000};
const STATUS_LABEL={run:"실행 중",wait:"응답 대기",queue:"대기열",done:"완료",err:"오류",cancelled:"중단됨",closed:"보관됨"};
const SIZE_EFFORT={small:"opus·high",normal:"opus·xhigh",epic:"opus·xhigh"};

function makeTask(o){
  S.seq++;
  const t=Object.assign({
    id:"T-"+pad(S.seq),num:S.seq,title:"",project:"workspace",size:"normal",
    status:"queue",step:"",events:[],timers:[],startedAt:null,endedAt:null,
    pending:null,question:null,sub:false,parent:null,children:[],tags:[],
    answered:false,scenario:null,onAnswer:null,x:0,y:0,
    sid:Math.random().toString(16).slice(2,10),pendingAnswer:null,ms:0,msgUntil:0,bornAt:Date.now(),
  },o);
  S.tasks.set(t.id,t);
  return t;
}
const tasksArr=()=>[...S.tasks.values()];
const runningCount=()=>tasksArr().filter(t=>t.status==="run").length; /* 서브에이전트도 permit 소비 */

function ev(t,txt,payload){t.events.push({id:(t.evSeq=(t.evSeq||0)+1),at:new Date(),txt,payload});if(t.events.length>60)t.events.shift()}
function after(t,ms,fn){const h={left:ms,fn};arm(t,h);t.timers.push(h)}
function arm(t,h){h.at=Date.now()+h.left;h.id=setTimeout(()=>{t.timers=t.timers.filter(x=>x!==h);h.fn()},h.left)}
function stopTimers(t){t.timers.forEach(h=>clearTimeout(h.id));t.timers=[]}
function pauseTimers(t){t.timers.forEach(h=>{clearTimeout(h.id);h.left=Math.max(0,h.at-Date.now())})} /* kill switch: 남은 시간 보존 */
function resumeTimers(t){t.timers.forEach(h=>arm(t,h))}
function setStep(t,txt){t.step=txt;ev(t,txt);refresh()}
function runSteps(t,steps,onDone){
  let i=0;
  const next=()=>{
    if(t.status!=="run")return;
    if(i>=steps.length){onDone&&onDone();return}
    const st=steps[i++];setStep(t,st[0]);after(t,st[1],next);
  };
  next();
}

/* ================= chat ================= */
const msgs=$("#msgs");
function scrollChat(){msgs.scrollTop=msgs.scrollHeight}
function chatUser(text){msgs.append(el("div","m-user",text));scrollChat()}
function chatNote(text){msgs.append(el("div","m-note",text));scrollChat()}
function chatAck(){chatNote("✓ 접수 · "+clock(new Date()))}
function ttagBtn(t){
  const b=el("button","ttag st-"+t.status,t.id);
  b.addEventListener("click",()=>{select(t.id);centerOn(t)});
  return b;
}
function chatBadges(parts,kind){
  const row=el("div","m-badges");
  row.append(el("span","badge k",kind||"dispatcher"));
  parts.forEach(p=>row.append(el("span","badge",p)));
  const wrap=el("div","m-row");wrap.append(row);msgs.append(wrap);scrollChat();
}
function chatMsg(t,text){
  const wrap=el("div","m-row");
  if(t)wrap.append(ttagBtn(t));
  wrap.append(el("div","m-sys",text));
  msgs.append(wrap);scrollChat();
}
function chatQuestion(t){
  const wrap=el("div","m-row");
  wrap.append(ttagBtn(t));
  wrap.append(el("div","m-sys",t.question.q));
  const chips=el("div","m-chips");chips.dataset.task=t.id;
  t.question.chips.forEach(c=>{
    const b=el("button","chip",c);
    b.addEventListener("click",()=>answerQuestion(t,c));
    chips.append(b);
  });
  wrap.append(chips);
  msgs.append(wrap);scrollChat();
}

/* ================= dispatch log (채팅 우측 레일) ================= */
const DLOG=[];let dlogSeq=0;
function dlogAdd(text){
  const e={id:++dlogSeq,text,status:"judging",result:null};
  DLOG.unshift(e);if(DLOG.length>20)DLOG.pop();
  renderDlog();return e;
}
function dlogDone(e,result){e.status="done";e.result=result;renderDlog()}
function renderDlog(){
  const list=$("#dlList");if(!list)return;
  list.textContent="";
  if(!DLOG.length){
    list.append(el("div","dl-empty","메시지를 보내면 접수 → 판단 → 배치 과정이 여기에 기록됩니다"));
    return;
  }
  DLOG.forEach(en=>{
    const row=el("div","dl-row");
    row.append(el("div","dl-msg",en.text));
    const st=el("div","dl-st");
    if(en.status==="judging"){
      st.append(el("span","judging","판단 중"));
    }else{
      const r=en.result||{};
      if(r.action)st.append(el("span","mono"+(r.action==="failed"?" fail":r.action==="fast-path"?" fast":""),r.action));
      if(r.ids&&r.ids.length){
        st.append(el("span",null,"→"));
        r.ids.forEach(id=>{const t=S.tasks.get(id);if(t)st.append(ttagBtn(t))});
        if(r.action==="route_to_task")st.append(el("span",null,"· accepted"));
      }else if(r.note){
        st.append(el("span",null,r.note));
      }
      if(r.action==="failed"){
        const b=el("button","nc-btn","재시도");
        b.addEventListener("click",()=>{en.status="judging";renderDlog();setTimeout(()=>{const t=spawnGeneric(r.retryText||en.text);dlogDone(en,{action:"new_task (재시도)",ids:[t.id]})},900)});
        st.append(b);
      }
    }
    row.append(st);
    list.append(row);
  });
}

/* ================= dispatcher (simulated) ================= */
function statusSummary(){
  const g=st=>tasksArr().filter(t=>!t.sub&&t.status===st);
  const run=g("run"),wait=g("wait"),q=g("queue"),done=g("done");
  if(!S.tasks.size)return"현재 태스크가 없습니다. 새 작업을 보내보세요.";
  const part=[];
  if(run.length)part.push("실행 중 "+run.length+"건("+run.map(t=>t.id).join(", ")+")");
  if(wait.length)part.push("응답 대기 "+wait.length+"건");
  if(q.length)part.push("대기열 "+q.length+"건");
  if(done.length)part.push("완료 "+done.length+"건");
  return part.length?part.join(", ")+"입니다.":"모든 태스크가 정리된 상태입니다.";
}
function decide(text){
  const authTask=tasksArr().find(t=>!t.sub&&t.tags.includes("auth")&&t.status!=="closed");
  if(/테스트/.test(text)&&authTask)
    return{badge:["route_to_task",authTask.id],run(){routeFollowup(authTask,"테스트 추가");return{ids:[authTask.id]}}};
  if(/테스트/.test(text))
    return{badge:["answer_directly","확인 필요"],run(){chatMsg(null,"라우팅할 대상 태스크가 없습니다. 먼저 ① 일반 작업으로 태스크를 만들어보세요.");return{note:"확인 필요"}}};
  if(/전면|개편|시스템/.test(text))
    return{badge:["new_task","epic","commerce"],run(){const t=spawnEpic(text);return{ids:[t.id]}}};
  if(/리팩토링|auth|인증/.test(text))
    return{badge:["new_task","normal","api-server"],run(){const t=spawnNormal(text);return{ids:[t.id]}}};
  if(/오타|typo/.test(text))
    return{badge:["new_task ×2","small","docs"],run(){return{ids:spawnSmalls().map(t=>t.id)}}};
  return{badge:["new_task","small","workspace"],run(){const t=spawnGeneric(text);return{ids:[t.id]}}};
}
function send(text){
  text=text.trim();if(!text)return;
  chatUser(text);chatAck();
  const dl=dlogAdd(text);
  if(/상태|현황|상황|어때/.test(text)){ /* 게이트웨이 fast-path: LLM 0회 즉답 */
    chatBadges(["fast-path","DB 스냅샷"],"gateway");
    chatMsg(null,statusSummary());
    dlogDone(dl,{action:"fast-path",note:"즉답 (LLM 0회)"});
    return;
  }
  if(text.startsWith("(시뮬) 판단 실패")){
    gwEl.classList.add("judging");
    gwEl.querySelector(".gw-s").textContent="dispatcher 판단 중 (fable)";
    setTimeout(()=>{
      gwEl.classList.remove("judging");gwEl.querySelector(".gw-s").textContent=":8787 · 상시 수신";
      chatBadges(["failed","fable timeout 60s"]);
      chatMsg(null,"판단 실패(fable timeout). 디스패치 로그에서 재시도할 수 있습니다.");
      dlogDone(dl,{action:"failed",note:"fable timeout — 재시도 가능",retryText:"README 오타 수정해줘"});
    },1200);
    return;
  }
  S.usage+=USAGE.dispatch;
  gwEl.classList.add("judging");
  gwEl.querySelector(".gw-s").textContent="dispatcher 판단 중 (fable)";
  setTimeout(()=>{
    gwEl.classList.remove("judging");
    gwEl.querySelector(".gw-s").textContent=":8787 · 상시 수신";
    const d=decide(text);chatBadges(d.badge);
    const res=d.run()||{};
    if(res.ids&&res.ids.length){const row=el("div","m-badges");row.append(el("span","m-note","→ 전달"));res.ids.forEach(id=>{const t=S.tasks.get(id);if(t)row.append(ttagBtn(t))});msgs.append(row);scrollChat()}
    dlogDone(dl,{action:d.badge[0],ids:res.ids,note:res.note});
  },700);
}

/* ================= lifecycle ================= */
function spawnTask(o){
  const t=makeTask(o);
  ev(t,"티켓 생성 ("+t.size+")");
  if(S.paused){
    t.status="queue";t.queuedAt=Date.now();t.step="전역 일시정지 — 큐 대기";ev(t,"kill switch 활성: 큐 대기");
  }else if(runningCount()>=S.maxw){
    t.status="queue";t.queuedAt=Date.now();t.step="슬롯 대기 중 ("+runningCount()+"/"+S.maxw+" 사용)";ev(t,"슬롯 대기열 진입");
  }else{
    startRun(t);
  }
  relayout();
  return t;
}
function startRun(t){
  t.status="run";t.startedAt=t.startedAt||new Date();
  ev(t,"워커 세션 시작 ("+SIZE_EFFORT[t.size]+")");
  if(t.scenario)t.scenario(t);
}
function finish(t,summary){
  t.status="done";t.endedAt=new Date();t.step="완료";ev(t,"턴 종료 (Stop) — last_assistant_message 승격");S.usage+=USAGE[t.size]||USAGE.small;
  if(summary)chatMsg(t,summary);
  notify("done",t,summary||"작업 완료");
  refresh();pumpQueue();
  if(t.pending){
    const p=t.pending;t.pending=null;
    after(t,1000,()=>{
      chatMsg(t,"턴 종료 — 큐잉된 지시를 이어서 처리합니다: "+p);
      resumeWith(t,p);
    });
  }
}
/* 대기열 순서: 답변 후 permit 재획득 대기(qhead)가 선두, 나머지는 큐 진입 시각 FIFO */
const queueOrder=(a,b)=>(b.qhead?1:0)-(a.qhead?1:0)||(a.queuedAt||0)-(b.queuedAt||0);
const queuedTasks=()=>tasksArr().filter(t=>t.status==="queue").sort(queueOrder);
function pumpQueue(){
  while(!S.paused&&runningCount()<S.maxw){
    const q=queuedTasks()[0];
    if(!q)break;
    ev(q,"슬롯 확보");
    if(q.sub)runSub(q);
    else if(q.pendingAnswer){const a=q.pendingAnswer;q.pendingAnswer=null;q.qhead=false;q.status="run";q.onAnswer&&q.onAnswer(a)}
    else if(q.pendingRun){const f=q.pendingRun;q.pendingRun=null;q.qhead=false;f()}
    else startRun(q);
  }
  relayout(); /* 대기열 레인 → 트리 행으로 이동 (트랜지션) */
}
function ask(t,q,chips){
  t.status="wait";t.question={q,chips};t.step="사용자 응답 대기";
  ev(t,"질문: "+q);
  chatQuestion(t);
  notify("wait",t,q);
  refresh();pumpQueue(); /* 대기는 슬롯 반납 */
}
function answerQuestion(t,choice){
  if(t.status!=="wait")return;
  t.question=null;
  withdrawNotif(t.id,"wait");
  document.querySelectorAll('.m-chips[data-task="'+t.id+'"] .chip').forEach(b=>b.disabled=true);
  ev(t,"응답 수신: "+choice);
  chatNote("→ "+t.id+" 응답 전달: accepted");
  if(S.paused||runningCount()>=S.maxw){ /* 답변 후 permit 재획득 — 없으면 큐 선두 */
    t.status="queue";t.queuedAt=Date.now();t.qhead=true;t.step="답변 수신 — 슬롯 대기";t.pendingAnswer=choice;ev(t,"permit 없음 → 대기열 선두");
    relayout();return;
  }
  t.status="run";
  if(t.onAnswer)t.onAnswer(choice);
  refresh();
}
/* 후속 실행 게이트: kill switch 중이거나 permit이 없으면 대기열 선두에 보류하고 슬롯 확보 시 pumpQueue가 이어감 */
function gateRun(t,label,fn){
  if(!S.paused&&runningCount()<S.maxw)return true;
  t.status="queue";t.queuedAt=Date.now();t.qhead=true;t.pendingRun=fn;t.endedAt=null;
  t.step=(S.paused?"전역 일시정지":"슬롯 대기")+" — "+label;ev(t,label+" 보류 ("+(S.paused?"kill switch":"permit 없음")+") → 대기열 선두");
  relayout();return false;
}
function resumeWith(t,label){
  if(!gateRun(t,"후속 지시",()=>resumeWith(t,label)))return;
  t.status="run";t.endedAt=null;
  ev(t,"세션 재개(resume) — 컨텍스트 복원");
  runSteps(t,[["추가 지시 처리: "+label,1600],["테스트 작성 중",2600],["테스트 실행 중",2200]],
    ()=>finish(t,"테스트 12개 추가 — 전체 46개 통과. 커밋 1건 추가."));
  refresh();
}
function stopTask(t){
  stopTimers(t);withdrawNotif(t.id,"wait");t.question=null; /* 답 못 받을 질문 알림 철회 */
  t.children.forEach(id=>{const c=S.tasks.get(id);if(c&&(c.status==="run"||c.status==="queue")){stopTimers(c);c.status="cancelled";c.step="상위 태스크 중단"}});
  t.status="cancelled";t.step="claude stop — 프로세스 정지";t.endedAt=new Date();
  ev(t,"사용자 중단 (claude stop) — worktree·transcript 보존");
  chatMsg(t,"중단했습니다. worktree는 보존되며 --resume으로 재시작할 수 있습니다.");
  notify("err",t,"사용자가 중단함 — 재시작할 수 있습니다");
  refresh();pumpQueue();
}
function restartTask(t){
  withdrawNotif(t.id,"err");
  if(!gateRun(t,"재시작",()=>restartTask(t)))return;
  t.status="run";t.endedAt=null;ev(t,"재시작 (claude --resume)");
  runSteps(t,[["세션 재개(resume) — 이전 컨텍스트 로드",1800],["중단 지점부터 계속",2600]],
    ()=>finish(t,"재시작 후 작업 완료."));
  refresh();
}
function archiveTask(t){
  t.status="closed";t.step="보관됨";withdrawNotif(t.id);ev(t,"보관");
  if(S.sel===t.id)S.sel=null;
  t.children.forEach(id=>{const c=S.tasks.get(id);if(c)c.status="closed"});
  relayout();
}

/* ================= scenarios ================= */
function spawnNormal(){
  return spawnTask({title:"auth 모듈 리팩토링",project:"api-server",size:"normal",tags:["auth"],
    scenario(t){
      runSteps(t,[
        ["worktree 생성: relay-"+t.id.toLowerCase(),1400],
        ["코드 탐색 중 (explore·sonnet)",2800],
        ["리팩토링 구현 중",3400],
        ["테스트 실행 중",2600],
      ],()=>finish(t,"auth 모듈 리팩토링 완료 — 12개 파일 수정, 테스트 34개 통과. PR 준비됨."));
      after(t,5400,()=>{if(t.status==="run")ev(t,"PostToolUse Bash · 2.1s","$ npm test\n  34 passed, 0 failed (2.1s)")});
    }});
}
function routeFollowup(t,label){
  if(t.status==="run"||t.status==="queue"){
    t.pending=label;
    ev(t,"후속 지시 큐잉: "+label);
    chatMsg(t,"실행 중이라 현재 턴이 끝나면 이어서 처리합니다 — 큐잉됨.");
    refresh();
  }else if(t.status==="done"){
    chatMsg(t,"완료된 세션을 재개해 이어서 처리합니다.");
    resumeWith(t,label);
  }else{
    t.pending=label;chatMsg(t,"응답 대기 중 — 재개 시 이어서 처리합니다.");refresh();
  }
}
function spawnEpic(){
  return spawnTask({title:"결제 시스템 전면 개편",project:"commerce",size:"epic",
    scenario(t){
      t.onAnswer=choice=>{
        setStep(t,"PG 연동 구현 중 ("+choice+")");
        t.answered=true;checkEpicDone(t);
      };
      runSteps(t,[
        ["worktree 생성: relay-"+t.id.toLowerCase(),1400],
        ["계획 수립 중 — 서브 티켓 분해",2600],
      ],()=>{
        setStep(t,"서브에이전트 2건 병렬 실행 중");
        spawnSub(t,"결제 API 설계",7000);
        spawnSub(t,"DB 마이그레이션 초안",9000);
        after(t,3000,()=>{
          if(t.status!=="run")return;
          ask(t,"PG사 선택이 필요합니다. 어느 쪽으로 진행할까요?",["토스페이먼츠","스트라이프","보류(모의 구현)"]);
        });
      });
    }});
}
function spawnSub(parent,title,ms){
  const c=makeTask({title,project:parent.project,size:"small",sub:true,parent:parent.id,status:"queue",ms});
  parent.children.push(c.id);
  ev(c,"서브에이전트 요청 (Agent 도구 PreToolUse → permit 확인)");
  if(!S.paused&&runningCount()<S.maxw)runSub(c);
  else{c.step="permit 대기 (슬롯 없음)";ev(c,"permit 없음 — 순차 대기")}
  relayout();
}
function runSub(c){
  const parent=S.tasks.get(c.parent);
  c.status="run";c.startedAt=c.startedAt||new Date();c.step="진행 중";
  ev(c,"permit 획득 — 서브에이전트 시작 (탐색 sonnet·low → 구현 opus)");
  after(c,c.ms,()=>{
    if(c.status!=="run")return;
    c.status="done";c.endedAt=new Date();c.step="완료";ev(c,"완료");S.usage+=USAGE.sub;
    ev(parent,"← "+c.id+" SendMessage: 「"+c.title+"」 완료 보고",'{"from":"'+c.id+'","to":"'+parent.id+'","outcome":"accepted"}');
    c.msgUntil=Date.now()+2200;animateEdges();setTimeout(refresh,2300);
    checkEpicDone(parent);refresh();pumpQueue();
  });
}
function checkEpicDone(t){
  const kids=t.children.map(id=>S.tasks.get(id));
  if(t.answered&&kids.length&&kids.every(c=>c&&c.status==="done")&&t.status==="run"){
    after(t,1800,()=>{
      if(t.status!=="run")return;
      finish(t,"결제 개편 1단계 완료 — 서브 티켓 2건 병합, PR 3건 생성. 다음 단계는 티켓으로 등록했습니다.");
    });
  }
}
function spawnSmalls(){
  return[spawnGeneric("README 오타 수정"),spawnGeneric("CHANGELOG 오타 수정")];
}
function spawnGeneric(text){
  const title=text.length>22?text.slice(0,22)+"…":text;
  return spawnTask({title,project:"docs",size:"small",
    scenario(t){
      runSteps(t,[
        ["worktree 생성: relay-"+t.id.toLowerCase(),1200],
        ["수정 적용 중",2400],
        ["검증 중",1800],
      ],()=>finish(t,"「"+t.title+"」 완료 — 커밋 1건."));
    }});
}

/* ================= layout & graph ================= */
const world=$("#world"),nodesBox=$("#nodes"),edgesSvg=$("#edges"),gwEl=$("#gw"),canvas=$("#canvas");
function layout(){
  const notSub=tasksArr().filter(t=>!t.sub&&t.status!=="closed");
  const active=notSub.filter(t=>t.status!=="queue");
  const queued=notSub.filter(t=>t.status==="queue").sort(queueOrder);
  const kidsOf=t=>t.children.map(id=>S.tasks.get(id)).filter(c=>c&&c.status!=="closed");
  if(S.layout==="tree"){
    /* 계단: 게이트웨이 좌상단 고정, 태스크는 아래로 적층, 서브는 부모 행에서 시작해 적층 */
    gwEl.style.left="32px";gwEl.style.top=ROW_Y0+"px";
    let cursor=ROW_Y0;
    active.forEach(t=>{
      t.x=COL_TASK;t.y=cursor;
      const kids=kidsOf(t);
      if(kids.length){
        let sy=cursor;
        kids.forEach(c=>{c.x=COL_SUB;c.y=sy;sy+=SUB_ROW});
        cursor=Math.max(cursor+ROW_H,sy+26);
      }else{
        cursor+=ROW_H;
      }
    });
  }else{
    /* 방사: 게이트웨이가 세로 중앙에서 곡선으로 퍼져나가는 형태 */
    active.forEach((t,i)=>{t.x=COL_TASK;t.y=ROW_Y0+i*ROW_H});
    active.forEach(t=>{
      kidsOf(t).forEach((c,i)=>{c.x=COL_SUB;c.y=t.y+(i===0?-58:66)});
    });
    const ys=active.map(t=>t.y);
    const gy=ys.length?ys.reduce((a,b)=>a+b,0)/ys.length+22:ROW_Y0;
    gwEl.style.left="40px";gwEl.style.top=gy+"px";
  }
  /* 대기열 레인: 게이트웨이 아래 FIFO 스택 */
  const laneX=parseFloat(gwEl.style.left)||32;
  const laneY0=(parseFloat(gwEl.style.top)||ROW_Y0)+gwEl.offsetHeight+40;
  queued.forEach((t,i)=>{t.x=laneX;t.y=laneY0+i*76});
  const eh=document.getElementById("emptyHint");
  eh.style.top=((parseFloat(gwEl.style.top)||ROW_Y0)+6)+"px";eh.style.left=(parseFloat(gwEl.style.left)+gwEl.offsetWidth+36)+"px";
  const ll=document.getElementById("laneLabel");
  ll.style.display=queued.length?"block":"none";
  ll.style.left=(laneX+34)+"px";ll.style.top=(laneY0-19)+"px";
}
function nodeEl(t){
  let n=document.getElementById("node-"+t.id);
  if(!n){
    n=el("div","node");n.id="node-"+t.id;n.setAttribute("role","button");n.tabIndex=0;
    const top=el("div","n-top");
    top.append(el("span","n-title"),el("span","pill"));
    n.append(top,el("div","n-meta mono"),el("div","n-step"));
    const foot=el("div","n-foot");
    foot.append(el("span","n-elapsed mono"),el("span","br mono"));
    n.append(foot);
    n.addEventListener("click",e=>{e.stopPropagation();select(t.id)});
    n.addEventListener("keydown",e=>{
      if(e.key==="Enter"||e.key===" "){e.preventDefault();select(t.id)}
    });
    nodesBox.append(n);
    n.dataset.fresh="1"; /* 첫 프레임: 이동 트랜지션 없이 페이드-인 */
    requestAnimationFrame(()=>requestAnimationFrame(()=>{delete n.dataset.fresh;n.classList.remove("fresh")}));
  }
  return n;
}
function elapsedText(t){
  if(t.status==="queue")return"대기 중";
  if(!t.startedAt)return"";
  return dur((t.endedAt||new Date())-t.startedAt);
}
function renderNodes(){
  const fam=famOf(S.sel);canvas.classList.toggle("focus",fam.size>0);canvas.classList.toggle("paused",S.paused);
  tasksArr().forEach(t=>{
    if(t.status==="closed"){
      const dead=document.getElementById("node-"+t.id);
      if(dead)dead.remove();
      return;
    }
    const n=nodeEl(t);
    n.className="node st-"+t.status+(t.sub?" sub":"")+(!t.sub&&t.status==="queue"?" queued":"")+(S.sel===t.id?" sel":"")+(fam.has(t.id)?" rel":"")+(n.dataset.fresh?" fresh":"");
    n.style.left=t.x+"px";n.style.top=t.y+"px";
    n.querySelector(".n-title").textContent=t.title;
    let pillTxt=t.status==="run"&&S.paused?"정지됨":STATUS_LABEL[t.status];
    if(!t.sub&&t.status==="queue"){
      const qi=queuedTasks().filter(x=>!x.sub).indexOf(t);
      pillTxt="대기 "+(qi+1);
    }
    n.querySelector(".pill").textContent=pillTxt;
    n.querySelector(".n-meta").textContent=t.sub
      ?t.id+" · sub"
      :t.id+" · "+t.project+" · "+t.size;
    n.querySelector(".n-step").textContent=t.step;
    n.querySelector(".n-elapsed").textContent=elapsedText(t);
    n.querySelector(".br").textContent=t.sub?"":"relay-"+t.id.toLowerCase();
    n.setAttribute("aria-label",t.title+" — "+STATUS_LABEL[t.status]);
  });
  $("#emptyHint").style.display=tasksArr().some(t=>t.status!=="closed")?"none":"flex";
}
function edgeCls(t){
  if(t.msgUntil&&t.msgUntil>Date.now())return"edge msg";
  if(t.status==="run"||t.status==="wait")return"edge run";
  if(t.status==="queue")return"edge queue";
  return"edge";
}
function drawIn(path,t){ /* 새 노드의 엣지를 부모→자식 방향으로 그려 넣기 */
  if(S.reduce)return;
  const p=Math.min(1,(Date.now()-t.bornAt)/450);
  if(p>=1)return;
  const len=path.getTotalLength();
  path.style.strokeDasharray=len+"";path.style.strokeDashoffset=(len*(1-p))+"";
  path.style.animation="none";
}
function renderEdges(){
  edgesSvg.textContent="";const fam=famOf(S.sel);
  const tree=S.layout==="tree", A=22; /* tree: 노드 상단(제목 행) 기준 앵커 — 첫 행은 수평선 */
  tasksArr().forEach(t=>{
    if(t.status==="closed")return;
    if(!t.sub&&t.status==="queue")return; /* 대기열은 아래 체인으로 */
    const n=document.getElementById("node-"+t.id);if(!n)return;
    let x1,y1;
    if(t.sub){
      const p=S.tasks.get(t.parent),pn=p&&document.getElementById("node-"+p.id);
      if(!pn||p.status==="closed")return;
      x1=pn.offsetLeft+pn.offsetWidth;
      y1=tree?pn.offsetTop+A:pn.offsetTop+pn.offsetHeight/2;
    }else{
      x1=gwEl.offsetLeft+gwEl.offsetWidth;
      y1=tree?gwEl.offsetTop+A:gwEl.offsetTop+gwEl.offsetHeight/2;
    }
    const x2=n.offsetLeft;
    const y2=tree?n.offsetTop+A:n.offsetTop+n.offsetHeight/2;
    const path=document.createElementNS("http://www.w3.org/2000/svg","path");
    const cx=Math.round((x1+x2)/2); /* 두 레이아웃 모두 S-베지어 곡선 — 첫 행은 y1==y2라 자연히 수평선 */
    path.setAttribute("d","M"+x1+" "+y1+" C"+cx+" "+y1+" "+cx+" "+y2+" "+x2+" "+y2);
    path.setAttribute("class",edgeCls(t)+(fam.has(t.id)?" rel":""));
    edgesSvg.append(path);drawIn(path,t);
  });
  /* 대기열 체인: 게이트웨이 아래로 FIFO 세로 연결 */
  const qs=queuedTasks().filter(t=>!t.sub);
  qs.forEach((t,i)=>{
    const n=document.getElementById("node-"+t.id);if(!n)return;
    const x=n.offsetLeft+22;
    let y1=gwEl.offsetTop+gwEl.offsetHeight;
    if(i>0){
      const p=document.getElementById("node-"+qs[i-1].id);
      if(p)y1=p.offsetTop+p.offsetHeight;
    }
    const path=document.createElementNS("http://www.w3.org/2000/svg","path");
    path.setAttribute("d","M"+x+" "+y1+" V"+n.offsetTop);
    path.setAttribute("class","edge queue");
    edgesSvg.append(path);drawIn(path,t);
  });
}
let edgeAnimUntil=0;
function animateEdges(){ /* 노드 위치 전환(300ms) 동안 엣지가 따라붙도록 */
  edgeAnimUntil=performance.now()+650;
  requestAnimationFrame(function loop(){
    renderEdges();
    if(performance.now()<edgeAnimUntil)requestAnimationFrame(loop);
  });
}

/* ================= sidebar ================= */
const GROUPS=[
  {label:"조치 필요",match:t=>t.status==="wait"||t.status==="err"||t.status==="cancelled",cls:"attn"},
  {label:"실행 중",match:t=>t.status==="run"},
  {label:"대기열",match:t=>t.status==="queue"},
  {label:"완료 · 보관",match:t=>t.status==="done"||t.status==="closed"},
];
const sideMeta=t=>t.id+" · "+t.project+" · "+(elapsedText(t)||"—");
function renderSidebar(){
  const fam=famOf(S.sel);
  const sb=$("#sidebar"),st=sb.scrollTop;sb.textContent="";
  const pool=el("div","pool"+(S.usage>800000?" warn":""));
  const r1=el("div");r1.append(el("b",null,"에이전트 "+runningCount()+"/"+S.maxw),el("span",null," · 대기 "+tasksArr().filter(t=>t.status==="queue").length+(S.paused?" · ⏸ 일시정지":"")));
  const r2=el("div");r2.append(el("span",null,"오늘 사용량 ≈ "),el("b",null,Math.round(S.usage/1000)+"k 토큰"),el("span",null," (추정)"+(S.usage>800000?" · 소프트 한도 초과":"")));
  pool.append(r1,r2);sb.append(pool);
  GROUPS.forEach(g=>{
    const list=tasksArr().filter(t=>!t.sub&&g.match(t));
    const box=el("div","group");
    const h=el("div","group-h"+(g.cls&&list.length?" "+g.cls:""));
    h.append(el("span",null,g.label),el("span","cnt",String(list.length)));
    box.append(h);
    if(!list.length)box.append(el("div","group-empty","없음"));
    list.forEach(t=>{
      const it=el("button","s-item st-"+t.status+(S.sel===t.id?" sel":fam.has(t.id)?" rel":"")+(t.status==="closed"?" closed":""));
      it.append(el("i","dot"));
      const txt=el("div","txt");
      txt.append(el("div","tt",t.title));
      const mm=el("div","mm mono",sideMeta(t));mm.dataset.el=t.id;mm.dataset.fmt="side";txt.append(mm);
      it.append(txt);
      it.addEventListener("click",()=>{select(t.id);centerOn(t)});
      box.append(it);
    });
    sb.append(box);
  });
  sb.scrollTop=st;
}

/* ================= detail ================= */
function renderDetail(){
  const body=$("#dBody"),t=S.sel?S.tasks.get(S.sel):null;
  $("#detail").classList.toggle("open",!!t);
  const st=body.scrollTop,openSet=new Set([...body.querySelectorAll("details[open]")].map(d=>d.dataset.i)); /* 재구성 후 복원 */
  body.textContent="";
  if(!t){body.append(el("div","d-empty","그래프나 사이드바에서 태스크를 선택하면 상세가 표시됩니다."));return}

  body.append(el("div","d-title",t.title));

  const rows=el("dl","d-rows");
  const row=(k,v,mono)=>{
    rows.append(el("dt",null,k));
    const dd=el("dd",mono?"mono":null);
    if(v instanceof Node)dd.append(v);else dd.textContent=v;
    rows.append(dd);return dd;
  };
  const pillWrap=el("span","st-"+t.status);
  pillWrap.append(el("span","pill",STATUS_LABEL[t.status]));
  row("상태",pillWrap);
  row("ID",t.id,true);
  row("프로젝트",t.project,true);
  row("크기",t.sub?"sub":t.size+" ("+SIZE_EFFORT[t.size]+")");
  if(!t.sub)row("브랜치","worktree-relay-"+t.id.toLowerCase(),true);
  row("세션",t.sid+(t.status==="run"||t.status==="wait"?" · 실행 중":t.status==="queue"?" · 대기":t.status==="done"?" · 유휴":" · 정지"),true);
  row("시작",t.startedAt?clock(t.startedAt):"—",true);
  row("경과",elapsedText(t)||"—",true).dataset.el=t.id;
  if(t.pending)row("큐잉됨",t.pending);
  const kin=(t.sub?[t.parent]:t.children).filter(id=>{const r=S.tasks.get(id);return r&&r.status!=="closed"});
  if(kin.length){ /* 같은 작업 단위 — 클릭하면 그쪽으로 이동 */
    const chips=el("div","chips");
    kin.forEach(id=>{const r=S.tasks.get(id);const b=el("button","chip",id+" · "+r.title);b.addEventListener("click",()=>{select(id);centerOn(r)});chips.append(b)});
    row(t.sub?"상위":"하위",chips);
  }
  body.append(rows);

  if(t.status==="wait"&&t.question){
    const q=el("div","d-q st-wait");
    q.append(el("div","qt",t.question.q));
    const chips=el("div","chips");
    t.question.chips.forEach(c=>{
      const b=el("button","chip",c);
      b.addEventListener("click",()=>answerQuestion(t,c));
      chips.append(b);
    });
    q.append(chips);body.append(q);
  }

  if(!t.sub){
    const btns=el("div","d-btns");
    const b1=el("button","act","터미널에서 열기");
    b1.addEventListener("click",()=>{const cmd=(t.status==="run"||t.status==="wait")?"claude attach "+t.sid:"claude --resume "+t.sid;navigator.clipboard&&navigator.clipboard.writeText(cmd).catch(()=>{});chatNote("클립보드에 복사: "+cmd)});
    const b2=el("button","act","worktree 경로 복사");
    b2.addEventListener("click",()=>{const pth="~/projects/"+t.project+"/.claude/worktrees/relay-"+t.id.toLowerCase();navigator.clipboard&&navigator.clipboard.writeText(pth).catch(()=>{});chatNote("클립보드에 복사: "+pth)});
    btns.append(b1,b2);body.append(btns);
    const acts=el("div","d-actions");
    if(t.status==="run"||t.status==="wait"){
      const b=el("button","act danger","중단");
      b.addEventListener("click",()=>stopTask(t));acts.append(b);
    }
    if(t.status==="err"||t.status==="cancelled"){
      const b=el("button","act","재시작");
      b.addEventListener("click",()=>restartTask(t));acts.append(b);
    }
    if(t.status==="done"||t.status==="err"||t.status==="cancelled"){
      const b=el("button","act","보관");
      b.addEventListener("click",()=>archiveTask(t));acts.append(b);
    }
    if(acts.children.length)body.append(acts);
  }

  body.append(el("div","d-sec","타임라인"));
  const tl=el("div","tl");
  t.events.slice(-30).forEach(e2=>{
    const r=el("div","tl-row");
    r.append(el("time","mono",clock(e2.at)));
    if(e2.payload){
      const d=el("details");d.dataset.i=String(e2.id);if(openSet.has(d.dataset.i))d.open=true;d.append(el("summary",null,e2.txt),el("pre",null,e2.payload));r.append(d);
    }else r.append(el("p",null,e2.txt));
    tl.append(r);
  });
  body.append(tl);body.scrollTop=st;
}
function famOf(id){ /* 작업 단위 = 최상위 태스크 + 그 서브에이전트 */
  const s=new Set();const t=id&&S.tasks.get(id);if(!t||t.status==="closed")return s;
  const r=(t.sub&&S.tasks.get(t.parent))||t;s.add(r.id);r.children.forEach(c=>s.add(c));return s;
}
function select(id){S.sel=id;refresh()}
$("#dClose").addEventListener("click",()=>{S.sel=null;refresh()});
document.addEventListener("keydown",e=>{
  if(e.key==="Escape"){
    if(PAL.open){closePalette();return}
    if(kedEl.classList.contains("open")){closeKeysEd();return}
    if(N.open||SET.open){N.open=false;SET.open=false;renderNotif();renderSettings()}
    else{S.sel=null;refresh()}
  }
});

/* ================= pan / zoom ================= */
const MINZ=.2,MAXZ=2;
const view={x:24,y:20,k:1,manual:false}; /* manual: 사용자가 뷰를 만진 뒤엔 자동 맞춤 보류, ⤢(맞춤)으로 재개 */
function touchView(){view.manual=true;$("#zfit").classList.add("manual")}
function applyView(smooth){
  world.style.transition=(smooth&&!S.reduce)?"transform .35s cubic-bezier(.22,.61,.36,1)":"none";
  world.style.transform="translate("+view.x+"px,"+view.y+"px) scale("+view.k+")";
  updateMinimap();
}
function graphBoxes(){
  const boxes=tasksArr().filter(t=>t.status!=="closed").map(t=>{
    const n=document.getElementById("node-"+t.id);
    return n?{x:t.x,y:t.y,w:n.offsetWidth,h:n.offsetHeight,st:t.status}:null;
  }).filter(Boolean);
  boxes.push({x:gwEl.offsetLeft,y:gwEl.offsetTop,w:gwEl.offsetWidth,h:gwEl.offsetHeight,st:"gw"});
  return boxes;
}
function fit(){
  view.manual=false;$("#zfit").classList.remove("manual");
  const boxes=graphBoxes();
  const minX=Math.min(...boxes.map(b=>b.x)),minY=Math.min(...boxes.map(b=>b.y));
  const maxX=Math.max(...boxes.map(b=>b.x+b.w)),maxY=Math.max(...boxes.map(b=>b.y+b.h));
  const cw=canvas.clientWidth,ch=canvas.clientHeight;
  view.k=Math.max(MINZ,Math.min(1,(cw-64)/(maxX-minX),(ch-64)/(maxY-minY)));
  if(S.layout==="tree"){ /* 좌상단 앵커 */
    view.x=28-minX*view.k;
    view.y=24-minY*view.k;
  }else{ /* 방사: 중앙 정렬 */
    view.x=(cw-(maxX-minX)*view.k)/2-minX*view.k;
    view.y=(ch-(maxY-minY)*view.k)/2-minY*view.k;
  }
  applyView(true);
}
function maybeFit(){if(S.autofit&&!view.manual)fit()}
function relayout(){layout();refresh();maybeFit();animateEdges()}
function centerOn(t){
  const n=document.getElementById("node-"+t.id);if(!n)return;
  const cw=canvas.clientWidth,ch=canvas.clientHeight;
  view.x=cw/2-(t.x+n.offsetWidth/2)*view.k;
  view.y=ch/2-(t.y+n.offsetHeight/2)*view.k;
  touchView();applyView(true);
}
canvas.addEventListener("wheel",e=>{
  e.preventDefault();
  const rect=canvas.getBoundingClientRect();
  const cx=e.clientX-rect.left,cy=e.clientY-rect.top;
  const k2=Math.min(MAXZ,Math.max(MINZ,view.k*(1-e.deltaY*.0012)));
  view.x=cx-(cx-view.x)*(k2/view.k);
  view.y=cy-(cy-view.y)*(k2/view.k);
  view.k=k2;touchView();applyView();
},{passive:false});
let pan=null;
canvas.addEventListener("pointerdown",e=>{
  if(e.target.closest(".node")||e.target.closest(".gw")||e.target.closest("button")||e.target.closest("#minimap"))return;
  pan={sx:e.clientX,sy:e.clientY,ox:view.x,oy:view.y,moved:false};
  canvas.classList.add("panning");canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove",e=>{
  if(!pan)return;
  const dx=e.clientX-pan.sx,dy=e.clientY-pan.sy;
  if(Math.abs(dx)+Math.abs(dy)>3){pan.moved=true;touchView()}
  view.x=pan.ox+dx;view.y=pan.oy+dy;applyView();
});
canvas.addEventListener("pointerup",()=>{
  if(pan&&!pan.moved){S.sel=null;refresh()}
  pan=null;canvas.classList.remove("panning");
});
function zoomBy(f){ /* 캔버스 중심 고정 줌 */
  const cx=canvas.clientWidth/2,cy=canvas.clientHeight/2,k2=Math.min(MAXZ,Math.max(MINZ,view.k*f));
  view.x=cx-(cx-view.x)*(k2/view.k);view.y=cy-(cy-view.y)*(k2/view.k);view.k=k2;touchView();applyView(true);
}
$("#zin").addEventListener("click",()=>zoomBy(1.25));
$("#zout").addEventListener("click",()=>zoomBy(1/1.25));
$("#zfit").addEventListener("click",fit);
let rzT;window.addEventListener("resize",()=>{clearTimeout(rzT);rzT=setTimeout(()=>{if(S.autofit&&!view.manual)fit();else updateMinimap()},120)});

/* ================= minimap ================= */
const mmEl=$("#minimap");
let mmMap=null;
function updateMinimap(){
  const hasTasks=tasksArr().some(t=>t.status!=="closed");
  mmEl.style.display=hasTasks?"":"none";
  if(!hasTasks)return;
  const boxes=graphBoxes();
  const pad=44;
  /* 범위 = 노드 영역 ∪ 현재 뷰포트 → 화면 비율과 동일하게 보이도록 */
  const vpx=-view.x/view.k, vpy=-view.y/view.k, vpw=canvas.clientWidth/view.k, vph=canvas.clientHeight/view.k;
  const minX=Math.min(vpx,...boxes.map(b=>b.x))-pad,minY=Math.min(vpy,...boxes.map(b=>b.y))-pad;
  const maxX=Math.max(vpx+vpw,...boxes.map(b=>b.x+b.w))+pad,maxY=Math.max(vpy+vph,...boxes.map(b=>b.y+b.h))+pad;
  const MW=mmEl.clientWidth,MH=mmEl.clientHeight;
  const mk=Math.min(MW/(maxX-minX),MH/(maxY-minY));
  const offx=(MW-(maxX-minX)*mk)/2-minX*mk;
  const offy=(MH-(maxY-minY)*mk)/2-minY*mk;
  mmMap={mk,offx,offy};
  mmEl.textContent="";
  boxes.forEach(b=>{
    const d=el("div",b.st==="gw"?"mm-gw":"mm-node st-"+b.st);
    d.style.left=(b.x*mk+offx)+"px";d.style.top=(b.y*mk+offy)+"px";
    d.style.width=Math.max(4,b.w*mk)+"px";d.style.height=Math.max(3,b.h*mk)+"px";
    mmEl.append(d);
  });
  const vw=el("div","mm-view");
  vw.style.left=((-view.x/view.k)*mk+offx)+"px";
  vw.style.top=((-view.y/view.k)*mk+offy)+"px";
  vw.style.width=((canvas.clientWidth/view.k)*mk)+"px";
  vw.style.height=((canvas.clientHeight/view.k)*mk)+"px";
  mmEl.append(vw);
}
function mmJump(e){
  if(!mmMap)return;
  const r=mmEl.getBoundingClientRect();
  const wx=(e.clientX-r.left-mmMap.offx)/mmMap.mk;
  const wy=(e.clientY-r.top-mmMap.offy)/mmMap.mk;
  view.x=canvas.clientWidth/2-wx*view.k;
  view.y=canvas.clientHeight/2-wy*view.k;
  touchView();applyView();
}
mmEl.addEventListener("pointerdown",e=>{e.stopPropagation();mmEl.setPointerCapture(e.pointerId);mmJump(e)});
mmEl.addEventListener("pointermove",e=>{if(e.buttons)mmJump(e)});

/* ================= refresh & tick ================= */
function refresh(){
  renderNodes();renderEdges();renderSidebar();renderDetail();updateMinimap();renderDlog();
}
setInterval(()=>{
  tasksArr().forEach(t=>{
    const n=document.getElementById("node-"+t.id);
    if(n){const e2=n.querySelector(".n-elapsed");if(e2)e2.textContent=elapsedText(t)}
  });
  /* 사이드바·상세는 재구성하지 않고 경과 텍스트만 갱신 → 스크롤·포커스·펼침 상태 유지 */
  document.querySelectorAll("[data-el]").forEach(e=>{const t=S.tasks.get(e.dataset.el);if(t)e.textContent=e.dataset.fmt==="side"?sideMeta(t):(elapsedText(t)||"—")});
},1000);

/* ================= notifications (macOS 방식) ================= */
const N={items:[],dnd:false,open:false,expand:{}};
const NKIND={wait:"응답 대기",err:"중단·오류",done:"완료"};
let nseq=0;
const toastsBox=$("#toasts"),ncEl=$("#notifCenter"),notifBtn=$("#notifBtn");
function notify(kind,t,body){
  const it={id:++nseq,kind,taskId:t.id,title:t.title,body,at:new Date(),loc:N.dnd?"center":"toast",timer:null};
  N.items.push(it);
  renderNotif();
  if(it.loc==="toast")armToast(it);
}
function armToast(it){clearTimeout(it.timer);it.timer=setTimeout(()=>hideToast(it),5000)}
function hideToast(it){ /* 자동 숨김: 삭제가 아니라 보관함으로 이동 */
  it.loc="center";
  const c=document.getElementById("toast-"+it.id);
  if(c){c.classList.add("out");setTimeout(()=>{c.remove();renderNotif()},250)}
  else renderNotif();
}
function dropNotif(it){clearTimeout(it.timer);N.items=N.items.filter(x=>x!==it)}
function withdrawNotif(taskId,kind){ /* 다른 경로로 해소된 알림은 자동 철회 */
  N.items.filter(i=>i.taskId===taskId&&(!kind||i.kind===kind)).forEach(dropNotif);
  renderNotif();
}
function openFromNotif(it){ /* 클릭 = 해당 노드 확인 = 읽음 처리 */
  const t=S.tasks.get(it.taskId);
  dropNotif(it);N.open=false;renderNotif();
  if(t){select(t.id);centerOn(t)}
}
function ncard(it){
  const c=el("div","ncard st-"+it.kind);
  c.setAttribute("role","button");c.tabIndex=0;
  c.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();c.click()}});
  const nt=el("div","nt");
  nt.append(el("b",null,it.title),el("time","mono",clock(it.at)));
  const x=el("button","nx","✕");x.setAttribute("aria-label","알림 삭제");
  x.addEventListener("click",e=>{e.stopPropagation();dropNotif(it);renderNotif()});
  c.append(nt,el("div","nb2",it.body),x);
  return c;
}
function renderToasts(){
  const live=N.items.filter(i=>i.loc==="toast");
  while(live.length>3)hideToast(live.shift()); /* 초과분도 동일한 슬라이드-아웃 경로 */
  [...toastsBox.children].forEach(c=>{
    if(!live.some(i=>"toast-"+i.id===c.id)&&!c.classList.contains("out"))c.remove();
  });
  live.slice().reverse().forEach(it=>{
    if(!document.getElementById("toast-"+it.id)){
      const c=ncard(it);c.id="toast-"+it.id;c.classList.add("toast","in");
      c.addEventListener("click",()=>openFromNotif(it));
      c.addEventListener("mouseenter",()=>clearTimeout(it.timer));
      c.addEventListener("mouseleave",()=>armToast(it));
      toastsBox.prepend(c);
      requestAnimationFrame(()=>requestAnimationFrame(()=>c.classList.remove("in")));
    }
  });
}
function renderCenter(){
  notifBtn.classList.toggle("has",N.items.length>0);
  notifBtn.querySelector(".nb").textContent=String(N.items.length);
  notifBtn.classList.toggle("dnd",N.dnd);
  $("#ncDnd").checked=N.dnd;
  ncEl.classList.toggle("open",N.open);
  if(!N.open)return;
  const body=ncEl.querySelector(".nc-body");body.textContent="";
  const centerItems=N.items.filter(i=>i.loc==="center");
  if(!centerItems.length){body.append(el("div","nc-empty","새 알림이 없습니다"));return}
  ["wait","err","done"].forEach(k=>{
    const list=centerItems.filter(i=>i.kind===k).sort((a,b)=>b.id-a.id);
    if(!list.length)return;
    const g=el("div","nc-group st-"+k);
    const gh=el("div","nc-gh");
    gh.append(el("i","dot"),el("span",null,NKIND[k]),el("span",null,String(list.length)),el("span","grow"));
    if(list.length>1){
      const fold=el("button","nc-btn",N.expand[k]?"접기":"펼치기");
      fold.addEventListener("click",()=>{N.expand[k]=!N.expand[k];renderNotif()});
      gh.append(fold);
    }
    const clr=el("button","nc-btn","지우기");
    clr.addEventListener("click",()=>{list.forEach(dropNotif);renderNotif()});
    gh.append(clr);
    g.append(gh);
    const expanded=N.expand[k]||list.length===1;
    if(expanded){
      list.forEach(it=>{
        const c=ncard(it);
        c.addEventListener("click",()=>openFromNotif(it));
        g.append(c);
      });
    }else{ /* macOS식 스택: 최신 1장(본문 유지) + 뒤 카드 겹침, 클릭하면 펼침. 삭제는 헤더 '지우기' 한 곳으로 */
      const w=el("div","stack"),c=ncard(list[0]);
      c.querySelector(".nx").remove();
      c.setAttribute("aria-label",NKIND[k]+" 알림 "+list.length+"건 펼치기");
      c.addEventListener("click",()=>{N.expand[k]=true;renderNotif()});
      w.append(c);g.append(w);
    }
    body.append(g);
  });
}
function renderNotif(){renderToasts();renderCenter()}
function renderBanner(){
  const b=$("#banner");b.textContent="";
  const conn=$("#conn");conn.className="conn"+(S.conn==="reconnecting"?" off":S.conn==="replaying"?" sync":"");
  $("#connTxt").textContent=S.conn==="reconnecting"?"재연결 중":S.conn==="replaying"?"이벤트 재생 중":"연결됨";
  let msg="",cls="";
  if(S.conn==="reconnecting"){msg="연결 끊김 — 서버에 재연결 중… (마지막 seq 120)";cls="err"}
  else if(S.conn==="replaying"){msg="재연결됨 — 이벤트 재생 중 (from_seq 120 → 134)"}
  else if(S.paused){msg="⏸ 전역 일시정지 (kill switch) — 새 디스패치·슬롯 배정 중단, 실행 중 워커는 정지 요청됨"}
  const was=b.classList.contains("on");
  b.className=msg?"on "+cls:"";
  if(was!==!!msg&&S.autofit&&!view.manual)fit(); /* 배너 행이 캔버스 높이를 바꾸므로 */
  const setBh=()=>document.documentElement.style.setProperty("--bh",(msg?b.offsetHeight:0)+"px"); /* 리사이저 시작 높이 보정 */
  if(!msg){setBh();return}
  b.append(el("span",null,msg));
  if(S.paused&&S.conn==="ok"){const r=el("button","act","재개");r.addEventListener("click",()=>togglePause());b.append(r)}
  setBh();
}
function togglePause(){ /* §5.4: 새 dispatch 중단 + 전 워커 claude stop, 해제 시 --resume으로 이어서 */
  S.paused=!S.paused;
  tasksArr().filter(t=>t.status==="run").forEach(t=>{
    if(S.paused){pauseTimers(t);ev(t,"claude stop (kill switch)")}
    else{resumeTimers(t);ev(t,"claude --resume (kill switch 해제)")}
  });
  if(!S.paused)pumpQueue();
  refresh();renderBanner();chatNote(S.paused?"kill switch ON — 전역 일시정지":"kill switch OFF — 재개");
}
function simulateDisconnect(){
  if(S.conn!=="ok")return;
  S.conn="reconnecting";renderBanner();
  setTimeout(()=>{S.conn="replaying";renderBanner();setTimeout(()=>{S.conn="ok";renderBanner();chatNote("재동기화 완료 — 누락 이벤트 14건 재생")},1300)},2500);
}
ncEl.addEventListener("click",e=>e.stopPropagation()); /* 패널 내부 클릭이 외부클릭 판정으로 새지 않게 */
notifBtn.addEventListener("click",e=>{
  e.stopPropagation();
  N.open=!N.open;
  SET.open=false;renderSettings();
  if(N.open)N.items.forEach(i=>{if(i.loc==="toast"){clearTimeout(i.timer);i.loc="center"}});
  renderNotif();if(N.open)ncEl.focus();
});
ncEl.tabIndex=-1;$("#settings").tabIndex=-1; /* 열릴 때 포커스를 패널 안으로 */
$("#ncClear").addEventListener("click",()=>{N.items.forEach(i=>clearTimeout(i.timer));N.items=[];renderNotif()});
$("#ncDnd").addEventListener("change",e=>{N.dnd=e.target.checked;renderNotif();renderSettings()});
document.addEventListener("click",e=>{
  if(N.open&&!e.target.closest("#notifCenter")&&!e.target.closest("#notifBtn")){N.open=false;renderNotif()}
  if(SET.open&&!e.target.closest("#settings")&&!e.target.closest("#gearBtn")){SET.open=false;renderSettings()}
});

/* ================= settings ================= */
const SET={open:false};
function renderSettings(){
  $("#settings").classList.toggle("open",SET.open);
  document.querySelectorAll("#segTheme button").forEach(b=>b.classList.toggle("on",b.dataset.m===Theme.mode));
  document.querySelectorAll("#segLayout button").forEach(b=>b.classList.toggle("on",b.dataset.l===S.layout));
  document.querySelectorAll("#segAlign button").forEach(b=>b.classList.toggle("on",b.dataset.a===RZ.align));
  $("#maxwVal").textContent=String(S.maxw);
  const mh=$("#maxwHint");mh.textContent=S.maxw>10?"⚠ 기본값 초과":"";mh.title=S.maxw>10?"기본값 10 초과 — 구독 사용량 급증 주의":""; /* 한 줄 유지, 상세는 툴팁 */
  $("#setAutofit").checked=S.autofit;
  $("#setDnd").checked=N.dnd;
  $("#setReduce").checked=S.reduce;
}
$("#gearBtn").addEventListener("click",e=>{
  e.stopPropagation();
  SET.open=!SET.open;
  if(SET.open&&N.open){N.open=false;renderNotif()}
  renderSettings();if(SET.open)$("#settings").focus();
});
$("#settings").addEventListener("click",e=>e.stopPropagation());
document.querySelectorAll("#segTheme button").forEach(b=>b.addEventListener("click",()=>Theme.set(b.dataset.m)));
document.querySelectorAll("#segLayout button").forEach(b=>b.addEventListener("click",()=>setGraphLayout(b.dataset.l)));
$("#maxwDec").addEventListener("click",()=>{S.maxw=Math.max(1,S.maxw-1);renderSettings()});
$("#maxwInc").addEventListener("click",()=>{S.maxw+=1;renderSettings();pumpQueue()});
$("#setAutofit").addEventListener("change",e=>{S.autofit=e.target.checked});
$("#setDnd").addEventListener("change",e=>{N.dnd=e.target.checked;renderNotif();renderSettings()});
$("#setReduce").addEventListener("change",e=>{
  S.reduce=e.target.checked;
  document.documentElement.classList.toggle("reduce",S.reduce);
  renderSettings();
});

/* ================= layout shell (VSCode식): 리사이즈·정렬·패널 토글 ================= */
const RZ=Object.assign(
  {sbw:248,dw:296,chh:232,align:"justify",sb:true,dt:true,ch:true},
  JSON.parse(localStorage.getItem("relay-sizes")||"{}")
);
const clampNum=(v,a,b)=>Math.max(a,Math.min(b,v));
const appEl=document.getElementById("app");
function saveRZ(){localStorage.setItem("relay-sizes",JSON.stringify(RZ))}
function applySizes(){
  const st=document.documentElement.style;
  st.setProperty("--sbw",RZ.sbw+"px");
  st.setProperty("--dw",RZ.dw+"px");
  st.setProperty("--chh",RZ.chh+"px");
  updateMinimap();
}
function applyAlign(){
  appEl.classList.remove("pa-left","pa-right","pa-center");
  if(RZ.align!=="justify")appEl.classList.add("pa-"+RZ.align);
  updateMinimap();
}
function applyPanels(){
  appEl.classList.toggle("hide-sb",!RZ.sb);
  appEl.classList.toggle("hide-dt",!RZ.dt);
  appEl.classList.toggle("hide-ch",!RZ.ch);
  updateMinimap();
}
function togglePanel(which){RZ[which]=!RZ[which];applyPanels();fit();saveRZ()}
function setAlign(a){RZ.align=a;applyAlign();fit();saveRZ();renderSettings()}
function setGraphLayout(m){S.layout=m;layout();refresh();fit();animateEdges();renderSettings()}
function makeResizer(sel,onMove,onReset){
  const h=document.querySelector(sel);
  h.addEventListener("pointerdown",e=>{e.preventDefault();h.setPointerCapture(e.pointerId);h.classList.add("drag")});
  h.addEventListener("pointermove",e=>{if(h.classList.contains("drag")){onMove(e);applySizes()}});
  h.addEventListener("pointerup",()=>{h.classList.remove("drag");saveRZ()});
  h.addEventListener("dblclick",()=>{onReset();applySizes();saveRZ()});
}
makeResizer(".rz-sb",e=>{RZ.sbw=clampNum(e.clientX-appEl.getBoundingClientRect().left,180,380)},()=>{RZ.sbw=248});
makeResizer(".rz-dt",e=>{RZ.dw=clampNum(appEl.getBoundingClientRect().right-e.clientX,240,430)},()=>{RZ.dw=296});
makeResizer(".rz-ch",e=>{RZ.chh=clampNum(document.documentElement.clientHeight-e.clientY,150,460)},()=>{RZ.chh=232});
document.querySelectorAll("#segAlign button").forEach(b=>b.addEventListener("click",()=>setAlign(b.dataset.a)));
applySizes();applyAlign();applyPanels();

/* ================= 단축키 (JSON 커스텀) ================= */
const KEY_DEFAULTS={
  palette:"mod+shift+p",
  toggleSidebar:"mod+b",
  toggleDetail:"mod+alt+b",
  toggleChat:"mod+j",
  chatGrow:"mod+ctrl+arrowup",
  chatShrink:"mod+ctrl+arrowdown",
};
let KEYS=Object.assign({},KEY_DEFAULTS,JSON.parse(localStorage.getItem("relay-keys")||"{}"));
const IS_MAC=/Mac/i.test(navigator.platform);
function normCombo(s){return String(s).toLowerCase().split("+").map(x=>x.trim()).sort().join("+")}
function eventCombo(e){
  const p=[];
  if(e.metaKey)p.push(IS_MAC?"mod":"meta");
  if(e.ctrlKey)p.push(IS_MAC?"ctrl":"mod");
  if(e.altKey)p.push("alt");
  if(e.shiftKey)p.push("shift");
  const k=e.key.toLowerCase();
  if(!["meta","control","alt","shift"].includes(k))p.push(k);
  return p.sort().join("+");
}
const matchKey=(e,c)=>c&&eventCombo(e)===normCombo(c);
function fmtKey(c){
  if(!c)return"";
  const M={mod:IS_MAC?"⌘":"Ctrl+",ctrl:"⌃",alt:"⌥",shift:"⇧",arrowup:"↑",arrowdown:"↓",arrowleft:"←",arrowright:"→"};
  return String(c).split("+").map(x=>M[x]||x.toUpperCase()).join("");
}
function chatResize(d){RZ.chh=clampNum(RZ.chh+d,150,460);if(!RZ.ch)togglePanel("ch");applySizes();saveRZ()}
document.addEventListener("keydown",e=>{
  if(matchKey(e,KEYS.palette)){e.preventDefault();togglePalette();return}
  if(PAL.open)return;
  if(matchKey(e,KEYS.toggleSidebar)){e.preventDefault();togglePanel("sb")}
  else if(matchKey(e,KEYS.toggleDetail)){e.preventDefault();togglePanel("dt")}
  else if(matchKey(e,KEYS.toggleChat)){e.preventDefault();togglePanel("ch")}
  else if(matchKey(e,KEYS.chatGrow)){e.preventDefault();chatResize(40)}
  else if(matchKey(e,KEYS.chatShrink)){e.preventDefault();chatResize(-40)}
});

/* ================= 명령 팔레트 ================= */
const PAL={open:false,idx:0,list:[]};
const palEl=$("#palette"),palInput=$("#palInput"),palList=$("#palList");
function commands(){
  return [
    {t:"① 일반 작업 실행",run:()=>send(PRESETS[1])},
    {t:"② 후속 지시 실행",run:()=>send(PRESETS[2])},
    {t:"③ 질문 실행",run:()=>send(PRESETS[3])},
    {t:"④ 에픽 실행",run:()=>send(PRESETS[4])},
    {t:"⑤ 소작업 ×2 실행",run:()=>send(PRESETS[5])},
    {t:"전체 보기 (fit)",run:fit},
    {t:"사이드바 토글",k:KEYS.toggleSidebar,run:()=>togglePanel("sb")},
    {t:"상세 패널 토글",k:KEYS.toggleDetail,run:()=>togglePanel("dt")},
    {t:"채팅 패널 토글",k:KEYS.toggleChat,run:()=>togglePanel("ch")},
    {t:"채팅 높이 키우기",k:KEYS.chatGrow,run:()=>chatResize(40)},
    {t:"채팅 높이 줄이기",k:KEYS.chatShrink,run:()=>chatResize(-40)},
    {t:"테마: 자동",run:()=>Theme.set("system")},
    {t:"테마: 라이트",run:()=>Theme.set("light")},
    {t:"테마: 다크",run:()=>Theme.set("dark")},
    {t:"그래프 레이아웃: 계단",run:()=>setGraphLayout("tree")},
    {t:"그래프 레이아웃: 방사",run:()=>setGraphLayout("radial")},
    {t:"패널 정렬: 전체",run:()=>setAlign("justify")},
    {t:"패널 정렬: 중앙",run:()=>setAlign("center")},
    {t:"패널 정렬: 왼쪽",run:()=>setAlign("left")},
    {t:"패널 정렬: 오른쪽",run:()=>setAlign("right")},
    {t:"알림 센터 열기",run:()=>{N.open=true;N.items.forEach(i=>{if(i.loc==="toast"){clearTimeout(i.timer);i.loc="center"}});renderNotif()}},
    {t:"설정 열기",run:()=>{SET.open=true;renderSettings()}},
    {t:"방해 금지 토글",run:()=>{N.dnd=!N.dnd;renderNotif();renderSettings()}},
    {t:"알림 모두 지우기",run:()=>{N.items.forEach(i=>clearTimeout(i.timer));N.items=[];renderNotif()}},
    {t:"동시 실행 상한 +1",run:()=>{S.maxw+=1;renderSettings();pumpQueue()}},
    {t:"동시 실행 상한 −1",run:()=>{S.maxw=Math.max(1,S.maxw-1);renderSettings();renderSidebar()}},
    {t:"새 태스크 자동 맞춤 토글",run:()=>{S.autofit=!S.autofit;renderSettings()}},
    {t:"애니메이션 감소 토글",run:()=>{S.reduce=!S.reduce;document.documentElement.classList.toggle("reduce",S.reduce);renderSettings()}},
    {t:"전역 일시정지 (kill switch) 토글",run:togglePause},
    {t:"시뮬레이션: 연결 끊김 → 재동기화",run:simulateDisconnect},
    {t:"시뮬레이션: 판단 실패 (fable timeout)",run:()=>send("(시뮬) 판단 실패 — 이 메시지는 dispatcher timeout을 재현합니다")},
    {t:"단축키 JSON 편집…",run:openKeysEd},
  ];
}
function togglePalette(){PAL.open?closePalette():openPalette()}
function openPalette(){
  PAL.open=true;palEl.classList.add("open");
  N.open=false;SET.open=false;renderNotif();renderSettings();
  palInput.value="";PAL.idx=0;renderPal();palInput.focus();
}
$("#palBtn").addEventListener("click",e=>{e.stopPropagation();togglePalette()});
function closePalette(){PAL.open=false;palEl.classList.remove("open");palInput.blur()}
function renderPal(){
  const q=palInput.value.trim().toLowerCase();
  PAL.list=commands().filter(c=>!q||c.t.toLowerCase().includes(q));
  if(PAL.idx>=PAL.list.length)PAL.idx=Math.max(0,PAL.list.length-1);
  palList.textContent="";
  if(!PAL.list.length){palList.append(el("div","pal-empty","일치하는 명령이 없습니다"));palInput.removeAttribute("aria-activedescendant");return}
  PAL.list.forEach((c,i)=>{
    const it=el("div","pal-item"+(i===PAL.idx?" act":""));it.id="pal-"+i;it.setAttribute("role","option");it.setAttribute("aria-selected",i===PAL.idx?"true":"false");
    it.append(el("span",null,c.t));
    if(c.k)it.append(el("kbd",null,fmtKey(c.k)));
    it.addEventListener("click",()=>runPal(c));
    palList.append(it);
  });
  palInput.setAttribute("aria-activedescendant","pal-"+PAL.idx);
  const act=palList.querySelector(".act");
  if(act)act.scrollIntoView({block:"nearest"});
}
function runPal(c){closePalette();c.run()}
palInput.addEventListener("input",()=>{PAL.idx=0;renderPal()});
palInput.addEventListener("keydown",e=>{
  if(e.key==="ArrowDown"){e.preventDefault();PAL.idx=Math.min(PAL.list.length-1,PAL.idx+1);renderPal()}
  else if(e.key==="ArrowUp"){e.preventDefault();PAL.idx=Math.max(0,PAL.idx-1);renderPal()}
  else if(e.key==="Enter"){e.preventDefault();if(PAL.list[PAL.idx])runPal(PAL.list[PAL.idx])}
  else if(e.key==="Escape"){e.preventDefault();e.stopPropagation();closePalette()}
});
palEl.addEventListener("click",e=>{if(e.target===palEl)closePalette()});

/* ================= 단축키 JSON 편집기 ================= */
const kedEl=$("#keysEd");
function openKeysEd(){
  kedEl.classList.add("open");
  $("#kedText").value=JSON.stringify(KEYS,null,2);
  $("#kedErr").textContent="";
  $("#kedText").focus();
}
function closeKeysEd(){kedEl.classList.remove("open")}
$("#keysBtn").addEventListener("click",()=>{SET.open=false;renderSettings();openKeysEd()});
$("#kedSave").addEventListener("click",()=>{
  try{
    const v=JSON.parse($("#kedText").value);
    const bad=Object.keys(v).filter(k=>!(k in KEY_DEFAULTS));
    if(bad.length)throw new Error("알 수 없는 동작: "+bad.join(", "));
    KEYS=Object.assign({},KEY_DEFAULTS,v);
    localStorage.setItem("relay-keys",JSON.stringify(KEYS));
    closeKeysEd();
  }catch(err){$("#kedErr").textContent="저장 실패: "+err.message}
});
$("#kedReset").addEventListener("click",()=>{
  $("#kedText").value=JSON.stringify(KEY_DEFAULTS,null,2);
  $("#kedErr").textContent="";
});
$("#kedClose").addEventListener("click",closeKeysEd);
kedEl.addEventListener("click",e=>{if(e.target===kedEl)closeKeysEd()});

/* ================= input ================= */
const input=$("#input");
$("#chatForm").addEventListener("submit",e=>{
  e.preventDefault(); /* IME 조합 중 Enter 가드는 아래 keydown이 담당 */
  send(input.value);input.value="";
});
input.addEventListener("keydown",e=>{
  if(e.key==="Enter"&&(e.isComposing||e.keyCode===229)){e.preventDefault()}
});
const PRESETS={
  1:"auth 모듈 리팩토링 해줘",
  2:"테스트도 추가해줘",
  3:"지금 상태 어때?",
  4:"결제 시스템 전면 개편 진행해줘",
  5:"README랑 CHANGELOG 오타 수정해줘",
};
document.querySelectorAll(".preset").forEach(b=>{
  b.addEventListener("click",()=>send(PRESETS[b.dataset.p]));
});

/* ================= boot ================= */
chatNote("relay 시뮬레이션 — 실제 에이전트는 실행되지 않습니다");
chatMsg(null,"안녕하세요. 상단 프리셋 ①〜⑤를 누르거나 메시지를 보내면 접수 → 판단 → 실행 흐름을 볼 수 있습니다. ⌘⇧P(또는 헤더 ⌘ 버튼)로 명령 팔레트가 열립니다.");
layout();refresh();fit();renderNotif();renderSettings();renderBanner(); /* 초기 화면도 태스크 있을 때와 같은 좌상단 앵커 */
