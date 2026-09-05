"use strict";
/* ================= helpers ================= */
const $=s=>document.querySelector(s);
function el(tag,cls,txt){const n=document.createElement(tag);if(cls)n.className=cls;if(txt!=null)n.textContent=txt;return n}
/* Only paired single backticks are presentation markup. Never interpret HTML,
   alter the source answer, or consume unmatched/multiline/backtick runs. */
function inlineText(node,text){
  const source=String(text??""),pattern=/(?<!`)`([^`\n]+)`(?!`)/g;
  let end=0;
  for(const match of source.matchAll(pattern)){
    node.append(document.createTextNode(source.slice(end,match.index)),el("code",null,match[1]));
    end=match.index+match[0].length;
  }
  node.append(document.createTextNode(source.slice(end)));
  return node;
}
function questionOption(t,choice){
  const b=inlineText(el("button","chip question-option"),choice);
  b.addEventListener("click",()=>answerQuestion(t,choice));
  return b;
}
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
const COL_FOREIGN=900, NODE_GAP=18; /* outside sessions have no gateway edge; measured heights keep the cards apart */
const S={tasks:new Map(),foreign:new Map(),sel:null,fsel:null,maxw:10, /* default 10, no hard cap — going over is a soft warning */autofit:true,reduce:false,layout:"tree",paused:false,usage:0,conn:"ok"};
const STATUS_LABEL={run:"Running",wait:"Needs input",queue:"Queued",done:"Done",err:"Error",cancelled:"Cancelled",closed:"Archived"};

const tasksArr=()=>[...S.tasks.values()];
const foreignArr=()=>[...S.foreign.values()];
// Subagents belong to their parent's active graph group. History stays in S.tasks,
// but archived/missing parents and compressed queue cards have no child lane.
function graphTaskVisible(t){
  if(!t||t.status==="closed")return false;
  if(!t.sub)return true;
  const p=S.tasks.get(t.parent);
  return !!p&&p.status!=="closed"&&p.status!=="queue";
}
const graphTasks=()=>tasksArr().filter(graphTaskVisible);

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
  wrap.append(inlineText(el("div","m-sys"),text));
  msgs.append(wrap);scrollChat();
}
function chatQuestion(t){
  const wrap=el("div","m-row");
  wrap.append(ttagBtn(t));
  wrap.append(inlineText(el("div","m-sys"),t.question.q));
  const chips=el("div","m-chips");chips.dataset.task=t.id;
  t.question.chips.forEach(c=>{
    chips.append(questionOption(t,c));
  });
  wrap.append(chips);
  msgs.append(wrap);scrollChat();
}

/* ================= request ledger (the rail right of the chat) =================
   Rows come from requestRows() in web/src/ledger.ts. This only draws that pure result and attaches the action buttons. */
const LEDGER=[];                                                                          /* filled by the adapter, needs-you first */
let ledgerFilter="open";                                                                  /* open = only requests not yet settled, all = everything */
const LEDGER_ACTS={
  redispatch:{label:"Retry",run:r=>relay.redispatch(r.id)},
  retry_cleanup:{label:"Retry cleanup",run:r=>{const t=S.tasks.get(r.taskId);if(t)relay.retryCleanup(t)}},
  restart:{label:"Restart",run:r=>{const t=S.tasks.get(r.taskId);if(t)relay.restart(t)}},
  close:{label:"Close",run:r=>{const t=S.tasks.get(r.taskId);if(t)relay.archive(t)}},
};
function ledgerRowEl(r){
  const row=el("div","lg-row"+(r.bucket==="needs_you"?" attn":""));
  const text=el("div","lg-msg",r.text);text.title=r.text;
  text.addEventListener("click",()=>row.classList.toggle("open"));                        /* truncated by default, full text on click */
  row.append(text);
  const st=el("div","lg-st");
  const pill=el("span","pill st-"+r.st+(r.disposition==="deciding"?" pulse":""));
  pill.append(el("i","dot"),el("span",null,r.state));
  st.append(pill,el("span","lg-disp",r.dispositionLabel));
  const t=r.taskId?S.tasks.get(r.taskId):null;
  r.taskIds.forEach(id=>{const tt=S.tasks.get(id);if(tt)st.append(ttagBtn(tt))});                 /* a split made several — name every one */
  if(r.source!=="user")st.append(el("span","lg-src",r.source));
  row.append(st);
  if(r.answer)row.append(inlineText(el("div","lg-ans "+(r.answerKind||"")),r.answer));
  const acts=el("div","lg-acts");
  r.actions.forEach(a=>{
    if(a==="answer"){                                                                     /* the task's own options — the same chips the chat offers */
      if(t&&t.question)t.question.chips.forEach(c=>acts.append(questionOption(t,c)));
      return;
    }
    const spec=LEDGER_ACTS[a];if(!spec)return;
    const b=el("button","chip",spec.label);b.addEventListener("click",()=>spec.run(r));acts.append(b);
  });
  if(acts.childElementCount)row.append(acts);
  return row;
}
function renderLedger(){
  const list=$("#lgList");if(!list)return;
  const attn=LEDGER.filter(r=>r.bucket==="needs_you").length;
  const count=$("#lgCount");count.hidden=!attn;count.textContent=attn+" need"+(attn===1?"s":"")+" you";
  document.querySelectorAll("#segLedger button").forEach(b=>b.classList.toggle("on",b.dataset.f===ledgerFilter));
  const rows=ledgerFilter==="all"?LEDGER:LEDGER.filter(r=>r.bucket!=="settled");
  list.textContent="";
  if(!rows.length){
    const empty=el("div","lg-empty",LEDGER.length?"Nothing open — every request you sent has landed.":"Every message you send is a request. What happened to it shows up here.");
    if(LEDGER.length&&ledgerFilter==="open"){
      const b=el("button","act","Show all "+LEDGER.length);
      b.addEventListener("click",()=>setLedgerFilter("all"));
      empty.append(b);
    }
    list.append(empty);
    return;
  }
  rows.forEach(r=>list.append(ledgerRowEl(r)));
}
function setLedgerFilter(f){ledgerFilter=f;renderLedger()}

/* ================= server actions (window.relay, installed by web/src/adapter.ts) ================= */
function send(text){text=text.trim();if(!text||(askActive()&&!text.replace(ASK_RE,"").trim()))return Promise.resolve(false);return relay.send(text,askActive(),askTask&&askTask.uuid)}  /* resolve only after the server acknowledges the message */
function answerQuestion(t,choice){if(t.status!=="wait")return;relay.answer(t,choice)}
function stopTask(t){relay.stop(t)}
function restartTask(t){relay.restart(t)}
function archiveTask(t){relay.archive(t)}
function togglePause(){relay.pause()}                                                   /* banner/settings re-render when system.state arrives */
function runningCount(){return S.running??tasksArr().filter(t=>t.status==="run").length}  /* server count is authoritative */

/* ================= lifecycle ================= */
/* queue order: a task waiting to re-acquire a permit after it was answered (qhead) goes first, the rest FIFO by the time they entered the queue */
const queueOrder=(a,b)=>(b.qhead?1:0)-(a.qhead?1:0)||(a.queuedAt||0)-(b.queuedAt||0);
const queuedTasks=()=>tasksArr().filter(t=>t.status==="queue").sort(queueOrder);
/* ================= layout & graph ================= */
const world=$("#world"),nodesBox=$("#nodes"),edgesSvg=$("#edges"),gwEl=$("#gw"),canvas=$("#canvas");
function layout(){
  // Populate text and classes before measuring: fonts, status and long metadata can change card height.
  renderNodes();
  const height=t=>document.getElementById("node-"+t.id).offsetHeight;
  const notSub=graphTasks().filter(t=>!t.sub);
  const active=notSub.filter(t=>t.status!=="queue");
  const queued=notSub.filter(t=>t.status==="queue").sort(queueOrder);
  const kidsOf=t=>t.children.map(id=>S.tasks.get(id)).filter(graphTaskVisible);
  if(S.layout==="tree"){
    /* steps: the gateway is pinned top-left, tasks stack downwards, subs stack from their parent's row */
    gwEl.style.left="32px";gwEl.style.top=ROW_Y0+"px";
    let cursor=ROW_Y0;
    active.forEach(t=>{
      t.x=COL_TASK;t.y=cursor;
      const kids=kidsOf(t);
      if(kids.length){
        let sy=cursor;
        kids.forEach(c=>{c.x=COL_SUB;c.y=sy;sy+=Math.max(SUB_ROW,height(c)+NODE_GAP)});
        cursor=Math.max(cursor+ROW_H,cursor+height(t)+NODE_GAP,sy+26);
      }else{
        cursor+=Math.max(ROW_H,height(t)+NODE_GAP);
      }
    });
  }else{
    /* radial: the gateway sits at the vertical centre and everything curves outwards from it */
    let cursor=ROW_Y0;
    active.forEach(t=>{
      const kids=kidsOf(t);
      const groupHeight=Math.max(height(t),kids.reduce((sum,c)=>sum+height(c)+NODE_GAP,0)-NODE_GAP);
      t.x=COL_TASK;t.y=cursor+(groupHeight-height(t))/2;
      let sy=cursor;
      kids.forEach(c=>{c.x=COL_SUB;c.y=sy;sy+=height(c)+NODE_GAP});
      cursor+=Math.max(ROW_H,groupHeight+NODE_GAP);
    });
    const ys=active.map(t=>t.y);
    const gy=ys.length?ys.reduce((a,b)=>a+b,0)/ys.length+22:ROW_Y0;
    gwEl.style.left="40px";gwEl.style.top=gy+"px";
  }
  /* queue lane: a FIFO stack below the gateway */
  const laneX=parseFloat(gwEl.style.left)||32;
  const laneY0=(parseFloat(gwEl.style.top)||ROW_Y0)+gwEl.offsetHeight+40;
  queued.forEach((t,i)=>{t.x=laneX;t.y=laneY0+i*76});
  const ll=document.getElementById("laneLabel");
  ll.style.display=queued.length?"block":"none";
  ll.style.left=(laneX+34)+"px";ll.style.top=(laneY0-19)+"px";
  /* sessions outside relay: stacked in their own column, with no edge to anything */
  const fs=foreignArr();
  let fy=ROW_Y0;
  fs.forEach(f=>{f.x=COL_FOREIGN;f.y=fy;fy+=document.getElementById("fnode-"+f.key).offsetHeight+NODE_GAP});
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
    n.dataset.fresh="1"; /* first frame: fade in, with no move transition */
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
    if(!graphTaskVisible(t)){
      const dead=document.getElementById("node-"+t.id);
      if(dead)dead.remove();
      return;
    }
    const n=nodeEl(t);
    n.className="node st-"+t.status+(t.sub?" sub":"")+(!t.sub&&t.status==="queue"?" queued":"")+(S.sel===t.id?" sel":"")+(fam.has(t.id)?" rel":"")+(n.dataset.fresh?" fresh":"");
    n.style.left=t.x+"px";n.style.top=t.y+"px";
    n.querySelector(".n-title").textContent=t.title;
    n.querySelector(".n-title").title=t.title;
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
    n.querySelector(".br").title=t.branch||"";
    n.setAttribute("aria-label",t.title+" — "+(t.statusLabel||STATUS_LABEL[t.status]));
  });
  // A replacement snapshot can omit a parent entirely; remove its old DOM too.
  nodesBox.querySelectorAll(".node:not(.foreign)").forEach(n=>{
    if(!graphTaskVisible(S.tasks.get(n.id.slice(5))))n.remove();
  });
  renderForeignNodes();
  $("#emptyHint").style.display=graphTasks().length?"none":"flex";
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
function drawIn(path,t){ /* draw a new node's edge in, parent → child */
  if(S.reduce)return;
  const p=Math.min(1,(Date.now()-t.bornAt)/450);
  if(p>=1)return;
  const len=path.getTotalLength();
  path.style.strokeDasharray=len+"";path.style.strokeDashoffset=(len*(1-p))+"";
  path.style.animation="none";
}
function renderEdges(){
  edgesSvg.textContent="";const fam=famOf(S.sel);
  const tree=S.layout==="tree", A=22; /* tree: anchored on the node's top (its title row) — the first row comes out horizontal */
  graphTasks().forEach(t=>{
    if(!t.sub&&t.status==="queue")return; /* queued tasks are chained below instead */
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
    const cx=Math.round((x1+x2)/2); /* the same S-bezier in both layouts — the first row has y1==y2, so it falls out horizontal */
    path.setAttribute("d","M"+x1+" "+y1+" C"+cx+" "+y1+" "+cx+" "+y2+" "+x2+" "+y2);
    path.setAttribute("class",edgeCls(t)+(fam.has(t.id)?" rel":""));
    edgesSvg.append(path);drawIn(path,t);
  });
  /* queue chain: vertical FIFO links running down from the gateway */
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
function animateEdges(){ /* keeps the edges glued to the nodes through the 300ms position transition */
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
  const overSoft=S.dailyCeiling!=null&&S.usage>S.dailyCeiling*.8;   // no ceiling configured means no limit to be over — the old 1e6 default invented one and warned forever
  const pool=el("div","pool"+(overSoft?" warn":""));
  const r1=el("div");r1.append(el("b",null,"Agents "+runningCount()+"/"+S.maxw),el("span",null," · queued "+tasksArr().filter(t=>t.status==="queue").length+(S.paused?" · ⏸ paused":"")));
  const r2=el("div");r2.append(el("span",null,"Today ≈ "),el("b",null,Math.round(S.usage/1000)+"k tok"),el("span",null," (est.)"+(overSoft?" · over the soft limit":"")));
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
  const st=body.scrollTop,openSet=new Set([...body.querySelectorAll("details[open]")].map(d=>d.dataset.i)); /* restored after the rebuild */
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
  if(kin.length){ /* the same unit of work — click to jump there */
    const chips=el("div","chips");
    kin.forEach(id=>{const r=S.tasks.get(id);const b=el("button","chip",id+" · "+r.title);b.addEventListener("click",()=>{select(id);centerOn(r)});chips.append(b)});
    row(t.sub?"Parent":"Children",chips);
  }
  body.append(rows);

  if(t.status==="wait"&&t.question){
    const q=el("div","d-q st-wait");
    q.append(inlineText(el("div","qt"),t.question.q));
    const chips=el("div","chips");
    t.question.chips.forEach(c=>{
      chips.append(questionOption(t,c));
    });
    q.append(chips);body.append(q);
  }

  if(!t.sub){
    const btns=el("div","d-btns");
    const b1=el("button","act","Open in terminal");
    b1.addEventListener("click",()=>relay.attach(t));
    const bAsk=el("button","act","Ask about this task");   /* relay tasks only — a session relay does not own has no transcript it was given */
    bAsk.addEventListener("click",()=>askAbout(t));
    const b2=el("button","act","Copy worktree path");
    b2.addEventListener("click",()=>{const pth=t.worktree||"(no worktree)";navigator.clipboard&&navigator.clipboard.writeText(pth).catch(()=>{});chatNote("Copied to clipboard: "+pth)});
    btns.append(b1,bAsk,b2);body.append(btns);
    const acts=el("div","d-actions");
    if(t.status==="run"||t.status==="wait"){
      const b=el("button","act danger","Stop");
      b.addEventListener("click",()=>stopTask(t));acts.append(b);
    }
    if(t.status==="err"||t.status==="cancelled"||t.statusLabel==="Needs review"){
      const b=el("button","act",t.cleanup?"Retry cleanup":"Restart");
      b.addEventListener("click",()=>t.cleanup?relay.retryCleanup(t):restartTask(t));acts.append(b);
    }
    if(["done","err","cancelled"].includes(t.status)||t.statusLabel==="Needs review"){
      const b=el("button","act","Archive");let armed=false; /* two-step confirm — cleaning the worktree cannot be undone */
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
function famOf(id){ /* a unit of work = the top-level task plus its subagents */
  const s=new Set();const t=id&&S.tasks.get(id);if(!graphTaskVisible(t))return s;
  const r=(t.sub&&S.tasks.get(t.parent))||t;s.add(r.id);r.children.forEach(c=>s.add(c));return s;
}
function select(id){S.sel=id;S.fsel=null;closeCompactSidebar();refresh()}
function selectForeign(key){S.fsel=key;S.sel=null;closeCompactSidebar();refresh()} /* mutually exclusive with a task selection — there is only one detail panel */
function clearSel(){S.sel=null;S.fsel=null;refresh()}
$("#dClose").addEventListener("click",()=>clearSel());
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
const view={x:24,y:20,k:1,manual:false}; /* manual: once the user moves the view, auto-fit holds off until ⤢ (fit) resumes it */
function touchView(){view.manual=true;$("#zfit").classList.add("manual")}
function applyView(smooth){
  world.style.transition=(smooth&&!S.reduce)?"transform .35s cubic-bezier(.22,.61,.36,1)":"none";
  world.style.transform="translate("+view.x+"px,"+view.y+"px) scale("+view.k+")";
  updateMinimap();
}
function graphBoxes(){
  const boxes=graphTasks().map(t=>{
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
/* Empty guidance is part of the fitted scene, below the gateway and clear of zoom controls. */
function emptyHintBox(){
  if(graphTasks().length)return null;
  const hint=$("#emptyHint");
  hint.style.left=gwEl.offsetLeft+"px";
  hint.style.top=(gwEl.offsetTop+gwEl.offsetHeight+20)+"px";
  hint.style.width=Math.max(160,Math.min(400,canvas.clientWidth-96))+"px";
  return {x:hint.offsetLeft,y:hint.offsetTop,w:hint.offsetWidth,h:hint.offsetHeight};
}
function fit(){
  view.manual=false;$("#zfit").classList.remove("manual");
  const boxes=graphBoxes();const hint=emptyHintBox();if(hint)boxes.push(hint);
  const minX=Math.min(...boxes.map(b=>b.x)),minY=Math.min(...boxes.map(b=>b.y));
  const maxX=Math.max(...boxes.map(b=>b.x+b.w)),maxY=Math.max(...boxes.map(b=>b.y+b.h));
  const cw=canvas.clientWidth,ch=canvas.clientHeight;
  // Reserve the right toolbar column, including when the outside lane is the rightmost content.
  const left=28,right=60,top=24,bottom=64;
  view.k=Math.max(MINZ,Math.min(1,(cw-left-right)/(maxX-minX),(ch-top-bottom)/(maxY-minY)));
  if(S.layout==="tree"){ /* top-left anchor */
    view.x=left-minX*view.k;
    view.y=top-minY*view.k;
  }else{ /* radial: centred */
    view.x=left+(cw-left-right-(maxX-minX)*view.k)/2-minX*view.k;
    view.y=top+(ch-top-bottom-(maxY-minY)*view.k)/2-minY*view.k;
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
  if(e.target.closest(".node,.gw,button,#minimap,#toasts"))return;
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
function zoomBy(f){ /* zoom about the canvas centre */
  const cx=canvas.clientWidth/2,cy=canvas.clientHeight/2,k2=Math.min(MAXZ,Math.max(MINZ,view.k*f));
  view.x=cx-(cx-view.x)*(k2/view.k);view.y=cy-(cy-view.y)*(k2/view.k);view.k=k2;touchView();applyView(true);
}
$("#zin").addEventListener("click",()=>zoomBy(1.25));
$("#zout").addEventListener("click",()=>zoomBy(1/1.25));
$("#zfit").addEventListener("click",fit);
let rzT;window.addEventListener("resize",()=>{clearTimeout(rzT);rzT=setTimeout(()=>{renderAsk();if(S.autofit&&!view.manual)fit();else updateMinimap()},120)});

/* ================= minimap ================= */
const mmEl=$("#minimap");
let mmMap=null;
function updateMinimap(){
  const hasTasks=graphTasks().length>0||S.foreign.size>0;
  mmEl.style.display=hasTasks?"":"none";
  if(!hasTasks){mmEl.textContent="";mmMap=null;return;}
  const boxes=graphBoxes();
  const pad=44;
  /* extent = the node area ∪ the current viewport, so the minimap keeps the screen's proportions */
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
  renderNodes();renderEdges();renderSidebar();renderDetail();updateMinimap();renderLedger();
}
setInterval(()=>{
  tasksArr().forEach(t=>{
    const n=document.getElementById("node-"+t.id);
    if(n){const e2=n.querySelector(".n-elapsed");if(e2)e2.textContent=elapsedText(t)}
  });
  /* the sidebar and detail are not rebuilt, only their elapsed text — scroll, focus and open sections survive */
  document.querySelectorAll("[data-el]").forEach(e=>{const t=S.tasks.get(e.dataset.el);if(t)e.textContent=e.dataset.fmt==="side"?sideMeta(t):(elapsedText(t)||"—")});
  document.querySelectorAll("[data-fel]").forEach(e=>{const f=S.foreign.get(e.dataset.fel);if(f)e.textContent=foreignElapsed(f)});
},1000);

/* ================= notifications (macOS style) ================= */
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
function hideToast(it){ /* auto-hide moves it to the centre; it does not drop it */
  it.loc="center";
  const c=document.getElementById("toast-"+it.id);
  if(c){c.classList.add("out");setTimeout(()=>{c.remove();renderNotif()},250)}
  else renderNotif();
}
function dropNotif(it){clearTimeout(it.timer);N.items=N.items.filter(x=>x!==it)}
function withdrawNotif(taskId,kind){ /* a notification resolved through some other path withdraws itself */
  N.items.filter(i=>i.taskId===taskId&&(!kind||i.kind===kind)).forEach(dropNotif);
  renderNotif();
}
function openFromNotif(it){ /* a click means the node has been looked at, which means read */
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
  while(live.length>3)hideToast(live.shift()); /* the overflow leaves by the same slide-out path */
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
    }else{ /* macOS-style stack: the newest card in full, the rest peeking out behind it, click to expand. Dismissing lives in one place, the header's Clear */
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
  if(was!==!!msg&&S.autofit&&!view.manual)fit(); /* the banner row changes the canvas height */
  const setBh=()=>document.documentElement.style.setProperty("--bh",(msg?b.offsetHeight:0)+"px"); /* corrects the resizer's starting height */
  if(!msg){setBh();return}
  b.append(el("span",null,msg));
  if(S.paused&&S.conn==="ok"){const r=el("button","act","Resume");r.addEventListener("click",()=>togglePause());b.append(r)}
  setBh();
}
ncEl.addEventListener("click",e=>e.stopPropagation()); /* keeps a click inside the panel from counting as a click outside it */
notifBtn.addEventListener("click",e=>{
  e.stopPropagation();
  N.open=!N.open;
  SET.open=false;renderSettings();
  if(N.open)N.items.forEach(i=>{if(i.loc==="toast"){clearTimeout(i.timer);i.loc="center"}});
  renderNotif();if(N.open)ncEl.focus();
});
ncEl.tabIndex=-1;$("#settings").tabIndex=-1; /* focus moves into the panel when it opens */
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
  const mh=$("#maxwHint");mh.textContent=S.maxw>10?"⚠ over the default":"";mh.title=S.maxw>10?"Above the default of 10 — watch for a spike in subscription usage":""; /* stays one line; the detail goes in the tooltip */
  $("#setAutofit").checked=S.autofit;
  $("#setDnd").checked=N.dnd;
  $("#setReduce").checked=S.reduce;
  renderProjects();
  $("#setInfo").textContent="Gateway 127.0.0.1:"+(location.port||80)+" · relay v"+(S.version||"—")+" · delivery: "+(S.delivery||"—");
  const dr=$("#setDrift");dr.textContent=S.cliDrift?"⚠ claude CLI changed since capabilities were measured ("+S.cliDrift+") — relay doctor --probe re-checks the --bg --resume gate against it":"";dr.hidden=!S.cliDrift;
}
function renderProjects(){ /* S.projects is filled by the adapter from the server's projects.updated */
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
document.querySelectorAll("#segLedger button").forEach(b=>b.addEventListener("click",()=>setLedgerFilter(b.dataset.f)));
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

/* ================= layout shell (VSCode style): resize, alignment, panel toggles ================= */
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
function closeCompactSidebar(){appEl.classList.remove("compact-sb-open");$("#sidebarBtn").setAttribute("aria-expanded","false")}
function togglePanel(which){
  if(which==="sb"&&window.matchMedia("(max-width:640px)").matches){
    const open=appEl.classList.toggle("compact-sb-open");$("#sidebarBtn").setAttribute("aria-expanded",String(open));return;
  }
  RZ[which]=!RZ[which];applyPanels();fit();saveRZ();
}
$("#sidebarBtn").addEventListener("click",()=>togglePanel("sb"));
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

/* ================= shortcuts (customised as JSON) ================= */
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

/* ================= command palette ================= */
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

/* ================= shortcuts JSON editor ================= */
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
const input=$("#input"),chatForm=$("#chatForm"),DRAFT="relay-draft";
const askBtn=$("#askBtn"),sendBtn=$("#sendBtn");
let sending=false;
const PH={msg:"Type a message — Enter to send, Shift+Enter for a new line",ask:"Ask a question — answered here, never turned into a task"};
let askTask=null;   /* the task an Ask is about — a question, never a message to the worker */
/* The toggle and a typed `?` are the same declaration; the canonical marker lives in shared/ask.ts, the server decides. */
const ASK_RE=/^\?+\s*/;
let askOn=false;
const askActive=()=>askOn||!!askTask||ASK_RE.test(input.value);
function renderAsk(){
  const a=askActive();
  askBtn.setAttribute("aria-pressed",a?"true":"false");
  const compact=input.clientWidth>0&&input.clientWidth<360;
  input.placeholder=askTask?"Ask about "+askTask.id+(compact?"…":" — read from its transcript, never sent to the worker"):compact?(a?"Ask a question…":"Message…"):a?PH.ask:PH.msg;
  autogrow();
}
function askAbout(t){if(sending)return;askTask={uuid:t.uuid,id:t.id};askOn=true;renderAsk();input.focus()}
askBtn.addEventListener("click",()=>{
  if(askActive()){askOn=false;askTask=null;input.value=input.value.replace(ASK_RE,"");autogrow()}else askOn=true;
  renderAsk();input.focus();
});
function autogrow(){input.style.height="auto";if(input.value)input.style.height=input.scrollHeight+(input.offsetHeight-input.clientHeight)+"px"} /* empty drafts stay one row; placeholder wrapping must not enlarge the composer */
chatForm.addEventListener("submit",async e=>{
  e.preventDefault(); /* the keydown below is what guards Enter mid-IME-composition */
  if(sending||!input.value.trim())return;
  sending=true;sendBtn.disabled=true;askBtn.disabled=true;input.readOnly=true;
  sendBtn.textContent="Sending…";
  try{
    if(await send(input.value)){
      input.value="";askTask=null;localStorage.removeItem(DRAFT); /* preserve draft and scope on failure */
    }
  }finally{
    sending=false;sendBtn.disabled=false;askBtn.disabled=false;input.readOnly=false;sendBtn.textContent="Send";
    autogrow();renderAsk();input.focus();
  }
});
input.addEventListener("input",()=>{autogrow();renderAsk();localStorage.setItem(DRAFT,input.value)});
input.addEventListener("keydown",e=>{
  if(e.key!=="Enter")return;
  if(e.isComposing||e.keyCode===229)return; /* an Enter mid-composition commits the candidate: never send it, never swallow it either */
  if(e.shiftKey)return;                     /* Shift+Enter inserts a newline; a textarea has no implicit submit, so sending is explicit below */
  e.preventDefault();chatForm.requestSubmit();
});
input.value=localStorage.getItem(DRAFT)||"";autogrow(); /* a long message survives a reload */

/* ================= module bridge ================= */
/* A classic script's top-level const is not a window property — expose only what web/src/adapter.ts reads
   (function declarations such as el, chatUser, notify, relayout, refresh and select are already on the global object). */
Object.assign(window,{S,N,LEDGER,msgs,gwEl});

/* ================= boot ================= */
layout();refresh();fit();renderNotif();renderSettings();renderBanner();renderAsk(); /* the empty screen anchors top-left the same way a populated one does */
