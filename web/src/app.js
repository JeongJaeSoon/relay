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
const COL_FOREIGN=900, FOREIGN_ROW=104; /* column for sessions relay did not start: never joined to the gateway by an edge */
const S={tasks:new Map(),foreign:new Map(),sel:null,fsel:null,maxw:10, /* 기본 10, 상한 없음(초과 시 소프트 경고) */autofit:true,reduce:false,layout:"tree",paused:false,usage:0,conn:"ok"};
const STATUS_LABEL={run:"Running",wait:"Needs input",queue:"Queued",done:"Done",err:"Error",cancelled:"Cancelled",closed:"Archived"};

const tasksArr=()=>[...S.tasks.values()];
const foreignArr=()=>[...S.foreign.values()];

/* ================= chat ================= */
const msgs=$("#msgs");
function scrollChat(){msgs.scrollTop=msgs.scrollHeight}
function chatUser(text){msgs.append(el("div","m-user",text));scrollChat()}
function chatNote(text){msgs.append(el("div","m-note",text));scrollChat()}
function ttagBtn(t){
  const b=el("button","ttag st-"+t.status,t.id);
  b.addEventListener("click",()=>{select(t.id);centerOn(t)});
  return b;
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
const DLOG=[];
function renderDlog(){
  const list=$("#dlList");if(!list)return;
  list.textContent="";
  if(!DLOG.length){
    list.append(el("div","dl-empty","Send a message and its accept → decide → dispatch trail lands here"));
    return;
  }
  DLOG.forEach(en=>{
    const row=el("div","dl-row");
    row.append(el("div","dl-msg",en.text));
    const st=el("div","dl-st");
    if(en.status==="judging"){
      st.append(el("span","judging","deciding"));
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
        const b=el("button","nc-btn","Retry");
        b.addEventListener("click",()=>relay.redispatch(en.messageId));
        st.append(b);
      }
    }
    row.append(st);
    list.append(row);
  });
}

/* ================= server actions (window.relay, installed by web/src/adapter.ts) ================= */
function send(text){text=text.trim();if(!text)return;relay.send(text)}                     /* the server echoes the message as chat.message — no optimistic row */
function answerQuestion(t,choice){if(t.status!=="wait")return;relay.answer(t,choice)}
function stopTask(t){relay.stop(t)}
function restartTask(t){relay.restart(t)}
function archiveTask(t){relay.archive(t)}
function togglePause(){relay.pause()}                                                   /* banner/settings re-render when system.state arrives */
function runningCount(){return S.running??tasksArr().filter(t=>t.status==="run").length}  /* server count is authoritative */

/* ================= lifecycle ================= */
/* 대기열 순서: 답변 후 permit 재획득 대기(qhead)가 선두, 나머지는 큐 진입 시각 FIFO */
const queueOrder=(a,b)=>(b.qhead?1:0)-(a.qhead?1:0)||(a.queuedAt||0)-(b.queuedAt||0);
const queuedTasks=()=>tasksArr().filter(t=>t.status==="queue").sort(queueOrder);
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
  /* sessions outside relay: stacked in their own column, with no edge to anything */
  const fs=foreignArr();
  fs.forEach((f,i)=>{f.x=COL_FOREIGN;f.y=ROW_Y0+i*FOREIGN_ROW});
  const fl=document.getElementById("foreignLabel");
  fl.style.display=fs.length?"block":"none";
  fl.style.left=COL_FOREIGN+"px";fl.style.top=(ROW_Y0-19)+"px";
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
  if(t.status==="queue")return"Queued";
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
    let pillTxt=t.status==="run"&&S.paused?"Stopped":(t.statusLabel||STATUS_LABEL[t.status]);
    if(!t.sub&&t.status==="queue"){
      const qi=queuedTasks().filter(x=>!x.sub).indexOf(t);
      pillTxt="Queued "+(qi+1);
    }
    n.querySelector(".pill").textContent=pillTxt;
    n.querySelector(".n-meta").textContent=t.sub
      ?t.id+" · sub"
      :t.id+" · "+t.project+" · "+t.size;
    n.querySelector(".n-step").textContent=t.step;
    n.querySelector(".n-elapsed").textContent=elapsedText(t);
    n.querySelector(".br").textContent=t.sub?"":t.branch||"";
    n.setAttribute("aria-label",t.title+" — "+(t.statusLabel||STATUS_LABEL[t.status]));
  });
  renderForeignNodes();
  $("#emptyHint").style.display=tasksArr().some(t=>t.status!=="closed")?"none":"flex";
}
/* ---- sessions outside relay: observation-only nodes (dashed, no status colour, no gateway edge) ---- */
function foreignElapsed(f){
  const from=f.startedAt||f.firstSeen;
  return (f.startedAt?"":"≥")+dur(Date.now()-from); /* with no start time all relay can say is "at least this long", counted from when it first saw the session */
}
function foreignEl(f){
  let n=document.getElementById("fnode-"+f.key);
  if(!n){
    n=el("div","node foreign st-foreign");n.id="fnode-"+f.key;n.dataset.key=f.key;n.setAttribute("role","button");n.tabIndex=0;
    const top=el("div","n-top");top.append(el("span","n-title"),el("span","pill"));
    n.append(top,el("div","n-meta mono"),el("div","n-step mono"));
    const foot=el("div","n-foot");foot.append(el("span","n-elapsed mono"),el("span","br","watching only"));
    n.append(foot);
    n.addEventListener("click",e=>{e.stopPropagation();selectForeign(f.key)});
    n.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();selectForeign(f.key)}});
    nodesBox.append(n);
  }
  return n;
}
function renderForeignNodes(){
  foreignArr().forEach(f=>{
    const n=foreignEl(f);
    n.className="node foreign st-foreign"+(S.fsel===f.key?" sel":"");
    n.style.left=f.x+"px";n.style.top=f.y+"px";
    n.querySelector(".n-title").textContent=f.title;
    n.querySelector(".pill").textContent=f.stateLabel;
    n.querySelector(".n-meta").textContent=f.short+(f.kind?" · "+f.kind:"");
    n.querySelector(".n-step").textContent=f.cwd;
    const e2=n.querySelector(".n-elapsed");e2.textContent=foreignElapsed(f);e2.dataset.fel=f.key;
    n.setAttribute("aria-label",f.title+" — started outside relay, "+f.stateLabel);
  });
  nodesBox.querySelectorAll(".node.foreign").forEach(n=>{if(!S.foreign.has(n.dataset.key))n.remove()});
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
  {label:"Needs attention",match:t=>t.status==="wait"||t.status==="err"||t.status==="cancelled",cls:"attn"},
  {label:"Running",match:t=>t.status==="run"},
  {label:"Queued",match:t=>t.status==="queue"},
  {label:"Done · Archived",match:t=>t.status==="done"||t.status==="closed"},
];
const sideMeta=t=>t.id+" · "+t.project+" · "+(elapsedText(t)||"—");
function renderSidebar(){
  const fam=famOf(S.sel);
  const sb=$("#sidebar"),st=sb.scrollTop;sb.textContent="";
  const pool=el("div","pool"+(S.usage>(S.dailyCeiling||1e6)*.8?" warn":""));
  const r1=el("div");r1.append(el("b",null,"Agents "+runningCount()+"/"+S.maxw),el("span",null," · queued "+tasksArr().filter(t=>t.status==="queue").length+(S.paused?" · ⏸ paused":"")));
  const r2=el("div");r2.append(el("span",null,"Today ≈ "),el("b",null,Math.round(S.usage/1000)+"k tok"),el("span",null," (est.)"+(S.usage>(S.dailyCeiling||1e6)*.8?" · over the soft limit":"")));
  pool.append(r1,r2);sb.append(pool);
  GROUPS.forEach(g=>{
    const list=tasksArr().filter(t=>!t.sub&&g.match(t));
    const box=el("div","group");
    const h=el("div","group-h"+(g.cls&&list.length?" "+g.cls:""));
    h.append(el("span",null,g.label),el("span","cnt",String(list.length)));
    box.append(h);
    if(!list.length)box.append(el("div","group-empty","None"));
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
  /* never mixed into the task groups, and absent entirely when there are none */
  const fs=foreignArr();
  if(fs.length){
    const box=el("div","group");
    const h=el("div","group-h");
    h.append(el("span",null,"Outside relay"),el("span","cnt",String(fs.length)));
    box.append(h);
    fs.forEach(f=>{
      const it=el("button","s-item st-foreign"+(S.fsel===f.key?" sel":""));
      it.append(el("i","dot"));
      const txt=el("div","txt");
      txt.append(el("div","tt",f.title));
      const mm=el("div","mm mono",f.stateLabel+" · "+f.cwd);txt.append(mm);
      it.append(txt);
      it.addEventListener("click",()=>{selectForeign(f.key);centerOnBox(f)});
      box.append(it);
    });
    sb.append(box);
  }
  sb.scrollTop=st;
}

/* ================= detail ================= */
function renderDetail(){
  const body=$("#dBody"),t=S.sel?S.tasks.get(S.sel):null,f=S.fsel?S.foreign.get(S.fsel):null;
  $("#detail").classList.toggle("open",!!(t||f));
  $("#dHead").textContent=f?"Session detail · outside relay":"Task detail";
  const st=body.scrollTop,openSet=new Set([...body.querySelectorAll("details[open]")].map(d=>d.dataset.i)); /* 재구성 후 복원 */
  body.textContent="";
  if(f){renderForeignDetail(body,f);body.scrollTop=st;return}
  if(!t){body.append(el("div","d-empty","Pick a task in the graph or the sidebar to see its detail."));return}

  body.append(el("div","d-title",t.title));

  const rows=el("dl","d-rows");
  const row=(k,v,mono)=>{
    rows.append(el("dt",null,k));
    const dd=el("dd",mono?"mono":null);
    if(v instanceof Node)dd.append(v);else dd.textContent=v;
    rows.append(dd);return dd;
  };
  const pillWrap=el("span","st-"+t.status);
  pillWrap.append(el("span","pill",(t.statusLabel||STATUS_LABEL[t.status])));
  row("Status",pillWrap);
  row("ID",t.id,true);
  row("Project",t.project,true);
  row("Size",t.sub?"sub · "+t.agentType:t.size+" ("+t.model+"·"+t.effort+")");
  if(!t.sub)row("Branch",t.branch,true);
  row("Session",t.sid+" · "+t.proc+" · gen "+t.gen+(t.attached?" · attach("+t.attached+")":""),true);
  row("Started",t.startedAt?clock(t.startedAt):"—",true);
  row("Elapsed",elapsedText(t)||"—",true).dataset.el=t.id;
  const kin=(t.sub?[t.parent]:t.children).filter(id=>{const r=S.tasks.get(id);return r&&r.status!=="closed"});
  if(kin.length){ /* 같은 작업 단위 — 클릭하면 그쪽으로 이동 */
    const chips=el("div","chips");
    kin.forEach(id=>{const r=S.tasks.get(id);const b=el("button","chip",id+" · "+r.title);b.addEventListener("click",()=>{select(id);centerOn(r)});chips.append(b)});
    row(t.sub?"Parent":"Children",chips);
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
    const b1=el("button","act","Open in terminal");
    b1.addEventListener("click",()=>relay.attach(t));
    const b2=el("button","act","Copy worktree path");
    b2.addEventListener("click",()=>{const pth=t.worktree||"(no worktree)";navigator.clipboard&&navigator.clipboard.writeText(pth).catch(()=>{});chatNote("Copied to clipboard: "+pth)});
    btns.append(b1,b2);body.append(btns);
    const acts=el("div","d-actions");
    if(t.status==="run"||t.status==="wait"){
      const b=el("button","act danger","Stop");
      b.addEventListener("click",()=>stopTask(t));acts.append(b);
    }
    if(t.status==="err"||t.status==="cancelled"||t.statusLabel==="Needs review"){
      const b=el("button","act","Restart");
      b.addEventListener("click",()=>restartTask(t));acts.append(b);
    }
    if(["done","err","cancelled"].includes(t.status)||t.statusLabel==="Needs review"){
      const b=el("button","act","Archive");let armed=false; /* 2단계 확인 — worktree 정리는 되돌릴 수 없다 */
      b.addEventListener("click",()=>{
        if(!armed){armed=true;b.textContent="Confirm archive (clean worktree)";b.classList.add("danger");return}
        archiveTask(t);
      });
      acts.append(b);
    }
    if(acts.children.length)body.append(acts);
  }

  body.append(el("div","d-sec","Timeline"));
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
/* detail for a session relay did not start: only what is knowable, and "unknown" where it is not */
function renderForeignDetail(body,f){
  body.append(el("div","d-title",f.title));
  const rows=el("dl","d-rows wide");
  const row=(k,v,mono)=>{rows.append(el("dt",null,k));const dd=el("dd",mono?"mono":null);if(v instanceof Node)dd.append(v);else dd.textContent=v;rows.append(dd);return dd};
  const pillWrap=el("span","st-foreign");pillWrap.append(el("span","pill",f.stateLabel));
  row("State",pillWrap);
  row("Session",f.sid,true);
  row("Agent id",f.short+(f.kind?" · "+f.kind:""),true);
  row("Directory",f.cwd,true);
  row("PID",f.pid==null?"—":String(f.pid),true);
  row("Started",f.startedAt?clock(f.startedAt):"unknown",true);
  row("Elapsed",foreignElapsed(f),true).dataset.fel=f.key;
  row("First seen",clock(f.firstSeen),true);
  row("Last polled",clock(f.lastSeen),true);
  body.append(rows);
  body.append(el("div","d-note","Started outside relay. relay only watches it: no dispatch, no queue slot, no worktree, no usage attribution, and no automatic stop. Its tool activity and its answers are not visible here."));
  const acts=el("div","d-actions");
  const b=el("button","act","Stop this session");let armed=false; /* two-step confirm — this stops a session that is not relay's */
  b.addEventListener("click",()=>{
    if(!armed){armed=true;b.textContent="Confirm stop (not started by relay)";b.classList.add("danger");return}
    relay.stopForeign(f.key);
  });
  acts.append(b);body.append(acts);
}
function famOf(id){ /* 작업 단위 = 최상위 태스크 + 그 서브에이전트 */
  const s=new Set();const t=id&&S.tasks.get(id);if(!t||t.status==="closed")return s;
  const r=(t.sub&&S.tasks.get(t.parent))||t;s.add(r.id);r.children.forEach(c=>s.add(c));return s;
}
function select(id){S.sel=id;S.fsel=null;refresh()}
function selectForeign(key){S.fsel=key;S.sel=null;refresh()} /* mutually exclusive with a task selection — there is only one detail panel */
function clearSel(){S.sel=null;S.fsel=null;refresh()}
$("#dClose").addEventListener("click",clearSel);
document.addEventListener("keydown",e=>{
  if(e.key==="Escape"){
    if(PAL.open){closePalette();return}
    if(kedEl.classList.contains("open")){closeKeysEd();return}
    if(N.open||SET.open){N.open=false;SET.open=false;renderNotif();renderSettings()}
    else clearSel();
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
  foreignArr().forEach(f=>{
    const n=document.getElementById("fnode-"+f.key);
    if(n)boxes.push({x:f.x,y:f.y,w:n.offsetWidth,h:n.offsetHeight,st:"foreign"});
  });
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
function centerAt(n,p){
  if(!n)return;
  const cw=canvas.clientWidth,ch=canvas.clientHeight;
  view.x=cw/2-(p.x+n.offsetWidth/2)*view.k;
  view.y=ch/2-(p.y+n.offsetHeight/2)*view.k;
  touchView();applyView(true);
}
function centerOn(t){centerAt(document.getElementById("node-"+t.id),t)}
function centerOnBox(f){centerAt(document.getElementById("fnode-"+f.key),f)}
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
  if(pan&&!pan.moved)clearSel();
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
  const hasTasks=tasksArr().some(t=>t.status!=="closed")||S.foreign.size>0;
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
  document.querySelectorAll("[data-fel]").forEach(e=>{const f=S.foreign.get(e.dataset.fel);if(f)e.textContent=foreignElapsed(f)});
},1000);

/* ================= notifications (macOS 방식) ================= */
const N={items:[],dnd:false,open:false,expand:{}};
const NKIND={wait:"Needs input",err:"Stopped · errored",done:"Done"};
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
  const x=el("button","nx","✕");x.setAttribute("aria-label","Dismiss notification");
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
  if(!centerItems.length){body.append(el("div","nc-empty","No new notifications"));return}
  ["wait","err","done"].forEach(k=>{
    const list=centerItems.filter(i=>i.kind===k).sort((a,b)=>b.id-a.id);
    if(!list.length)return;
    const g=el("div","nc-group st-"+k);
    const gh=el("div","nc-gh");
    gh.append(el("i","dot"),el("span",null,NKIND[k]),el("span",null,String(list.length)),el("span","grow"));
    if(list.length>1){
      const fold=el("button","nc-btn",N.expand[k]?"Collapse":"Expand");
      fold.addEventListener("click",()=>{N.expand[k]=!N.expand[k];renderNotif()});
      gh.append(fold);
    }
    const clr=el("button","nc-btn","Clear");
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
      c.setAttribute("aria-label","Expand "+list.length+" "+NKIND[k]+" notifications");
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
  $("#connTxt").textContent=S.conn==="reconnecting"?"Reconnecting":S.conn==="replaying"?"Replaying events":"Connected";
  let msg="",cls="";
  if(S.conn==="reconnecting"){msg="Disconnected — reconnecting to the server… (last seq "+(S.lastSeq||0)+")";cls="err"}
  else if(S.conn==="replaying"){msg="Reconnected — replaying events"}
  else if(S.recovering){msg="relay is recovering — reconciling sessions before commands resume"}
  else if(S.paused){msg="⏸ Paused (kill switch) — no new dispatches or slots, running workers asked to stop"}
  const was=b.classList.contains("on");
  b.className=msg?"on "+cls:"";
  if(was!==!!msg&&S.autofit&&!view.manual)fit(); /* 배너 행이 캔버스 높이를 바꾸므로 */
  const setBh=()=>document.documentElement.style.setProperty("--bh",(msg?b.offsetHeight:0)+"px"); /* 리사이저 시작 높이 보정 */
  if(!msg){setBh();return}
  b.append(el("span",null,msg));
  if(S.paused&&S.conn==="ok"){const r=el("button","act","Resume");r.addEventListener("click",()=>togglePause());b.append(r)}
  setBh();
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
  const mh=$("#maxwHint");mh.textContent=S.maxw>10?"⚠ over the default":"";mh.title=S.maxw>10?"Above the default of 10 — watch for a spike in subscription usage":""; /* 한 줄 유지, 상세는 툴팁 */
  $("#setAutofit").checked=S.autofit;
  $("#setDnd").checked=N.dnd;
  $("#setReduce").checked=S.reduce;
  renderProjects();
  $("#setInfo").textContent="Gateway 127.0.0.1:"+(location.port||80)+" · relay v"+(S.version||"—")+" · delivery: "+(S.delivery||"—");
}
function renderProjects(){ /* S.projects는 어댑터가 서버 projects.updated로 채운다 */
  const box=$("#projList");box.textContent="";
  const list=S.projects||[];
  if(!list.length){box.append(el("div","group-empty","No projects registered"));return}
  list.forEach(p=>{
    const rowEl=el("div","set-proj");
    const txt=el("div","txt");txt.append(el("div","tt",p.name),el("div","mm mono",p.path));
    const x=el("button","nx","✕");x.setAttribute("aria-label","Remove "+p.name);
    x.addEventListener("click",()=>relay.removeProject(p.id));
    rowEl.append(txt,x);box.append(rowEl);
  });
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
$("#maxwDec").addEventListener("click",()=>relay.setMax(S.maxw-1));
$("#maxwInc").addEventListener("click",()=>relay.setMax(S.maxw+1));
$("#setAutofit").addEventListener("change",e=>{S.autofit=e.target.checked});
$("#setDnd").addEventListener("change",e=>{N.dnd=e.target.checked;renderNotif();renderSettings()});
$("#projAdd").addEventListener("click",()=>{
  const name=$("#projName").value.trim(),path=$("#projPath").value.trim();
  if(!name||!path){chatNote("Project registration failed: name and path are required");return}
  relay.registerProject({name,path,description:$("#projDesc").value.trim(),keywords:$("#projKw").value.split(",").map(k=>k.trim()).filter(Boolean)});
  ["#projName","#projPath","#projDesc","#projKw"].forEach(sel=>{$(sel).value=""});
});
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
    {t:"Fit to view",run:fit},
    {t:"Toggle sidebar",k:KEYS.toggleSidebar,run:()=>togglePanel("sb")},
    {t:"Toggle detail panel",k:KEYS.toggleDetail,run:()=>togglePanel("dt")},
    {t:"Toggle chat panel",k:KEYS.toggleChat,run:()=>togglePanel("ch")},
    {t:"Grow the chat panel",k:KEYS.chatGrow,run:()=>chatResize(40)},
    {t:"Shrink the chat panel",k:KEYS.chatShrink,run:()=>chatResize(-40)},
    {t:"Theme: auto",run:()=>Theme.set("system")},
    {t:"Theme: light",run:()=>Theme.set("light")},
    {t:"Theme: dark",run:()=>Theme.set("dark")},
    {t:"Graph layout: steps",run:()=>setGraphLayout("tree")},
    {t:"Graph layout: radial",run:()=>setGraphLayout("radial")},
    {t:"Panel alignment: justify",run:()=>setAlign("justify")},
    {t:"Panel alignment: center",run:()=>setAlign("center")},
    {t:"Panel alignment: left",run:()=>setAlign("left")},
    {t:"Panel alignment: right",run:()=>setAlign("right")},
    {t:"Open notifications",run:()=>{N.open=true;N.items.forEach(i=>{if(i.loc==="toast"){clearTimeout(i.timer);i.loc="center"}});renderNotif()}},
    {t:"Open settings",run:()=>{SET.open=true;renderSettings()}},
    {t:"Toggle do not disturb",run:()=>{N.dnd=!N.dnd;renderNotif();renderSettings()}},
    {t:"Clear all notifications",run:()=>{N.items.forEach(i=>clearTimeout(i.timer));N.items=[];renderNotif()}},
    {t:"Max concurrent agents +1",run:()=>relay.setMax(S.maxw+1)},
    {t:"Max concurrent agents −1",run:()=>relay.setMax(S.maxw-1)},
    {t:"Toggle auto-fit on new tasks",run:()=>{S.autofit=!S.autofit;renderSettings()}},
    {t:"Toggle reduce motion",run:()=>{S.reduce=!S.reduce;document.documentElement.classList.toggle("reduce",S.reduce);renderSettings()}},
    {t:"Toggle pause (kill switch)",run:togglePause},
    {t:"Register a project…",run:()=>{SET.open=true;renderSettings();$("#projPath").focus()}},
    {t:"Edit shortcuts JSON…",run:openKeysEd},
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
  PAL.list=commands().filter(c=>!q||q.split(/\s+/).every(n=>c.t.toLowerCase().includes(n)));
  if(PAL.idx>=PAL.list.length)PAL.idx=Math.max(0,PAL.list.length-1);
  palList.textContent="";
  if(!PAL.list.length){palList.append(el("div","pal-empty","No matching commands"));palInput.removeAttribute("aria-activedescendant");return}
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
    if(bad.length)throw new Error("Unknown action: "+bad.join(", "));
    KEYS=Object.assign({},KEY_DEFAULTS,v);
    localStorage.setItem("relay-keys",JSON.stringify(KEYS));
    closeKeysEd();
  }catch(err){$("#kedErr").textContent="Save failed: "+err.message}
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

/* ================= module bridge ================= */
/* 클래식 스크립트의 최상위 const는 window 속성이 아니다 — web/src/adapter.ts가 읽는 것만 노출한다
   (el, chatUser, notify, relayout, refresh, select 등 함수 선언은 이미 전역 객체에 올라간다). */
Object.assign(window,{S,N,DLOG,msgs,gwEl});

/* ================= boot ================= */
layout();refresh();fit();renderNotif();renderSettings();renderBanner(); /* 초기 화면도 태스크 있을 때와 같은 좌상단 앵커 */
