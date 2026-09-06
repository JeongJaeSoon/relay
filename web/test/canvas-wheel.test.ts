import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const app=readFileSync(new URL("../src/app.js",import.meta.url),"utf8");
const code=app.slice(app.indexOf('canvas.addEventListener("wheel"'),app.indexOf('let pan=null;'));
function setup(){
  let wheel:(e:any)=>void=()=>{};
  const view={x:50,y:80,k:2};let touched=0,painted=0;
  runInNewContext(code,{canvas:{clientWidth:800,clientHeight:500,addEventListener:(_type:string,fn:any)=>wheel=fn,getBoundingClientRect:()=>({left:10,top:20})},view,MINZ:.01,MAXZ:3,touchView:()=>touched++,applyView:()=>painted++});
  return {view,counts:()=>[touched,painted],send:(patch:any)=>{let prevented=false;wheel({deltaX:0,deltaY:0,deltaMode:0,ctrlKey:false,metaKey:false,shiftKey:false,clientX:210,clientY:120,preventDefault:()=>prevented=true,...patch});expect(prevented).toBe(true)}};
}
test("horizontal and diagonal wheel gestures pan without changing zoom",()=>{
  const h=setup();h.send({deltaX:40});expect(h.view).toEqual({x:10,y:80,k:2});
  h.send({deltaX:-10,deltaY:12});expect(h.view).toEqual({x:20,y:68,k:2});expect(h.counts()).toEqual([2,2]);
});
test("Shift wheel handles both raw vertical and browser-translated horizontal deltas",()=>{
  for(const deltas of [{deltaY:30},{deltaX:30},{deltaX:30,deltaY:30}]){
    const h=setup();h.send({shiftKey:true,...deltas});expect(h.view).toEqual({x:20,y:80,k:2});
  }
});
test("line and page deltas normalize horizontal pan distance",()=>{
  const h=setup();h.send({deltaX:2,deltaMode:1});expect(h.view.x).toBe(18);
  h.send({deltaX:1,deltaY:1,deltaMode:2});expect(h.view).toEqual({x:-782,y:-420,k:2});
});
test("vertical wheel and pinch modifiers retain cursor-centered zoom",()=>{
  for(const modifier of [{},{ctrlKey:true,deltaX:20},{metaKey:true,deltaX:20}]){
    const h=setup();const anchor={x:(200-h.view.x)/h.view.k,y:(100-h.view.y)/h.view.k};
    h.send({deltaY:50,...modifier});expect(h.view.k).toBeLessThan(2);
    expect((200-h.view.x)/h.view.k).toBeCloseTo(anchor.x);expect((100-h.view.y)/h.view.k).toBeCloseTo(anchor.y);
  }
});
