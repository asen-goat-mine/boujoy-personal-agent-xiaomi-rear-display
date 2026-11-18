(() => {
  const api=window.boujoyPet,pet=document.querySelector('#pet'),canvas=document.querySelector('#face'),ctx=canvas.getContext('2d'),robot=document.querySelector('#robot'),status=document.querySelector('#status'),bubble=document.querySelector('#bubble');
  const reduce=matchMedia('(prefers-reduced-motion: reduce)'),head=new Image();
  let gazeX=0,gazeY=0,lookX=0,lookY=0,hover=false,hoverAt=-Infinity;
  let ready=false,mode='idle',online=true,feedReadyAt=0,feedingAt=-Infinity,completedAt=-Infinity,noticeUntil=0,dragging=false,moved=false,startX=0,startY=0,lastPaint='',polling=false;
  // Drag physics: the head hangs from the cursor and swings like a pendulum.
  let dragAt=-Infinity,droppedAt=-Infinity,lastMoveX=0,lastMoveY=0,lastMoveAt=0,velX=0,velY=0,swing=0,swingV=0,stretch=0,stretchV=0,reversals=0,lastSign=0,dizzyAt=-Infinity,lastFrame=0;
  // Whole-screen cursor follow (from the main process); falls back to hover-only gaze.
  let cursor=null,cursorMovedAt=-Infinity,cursorPolling=false,leanX=0,emote=null,sleepyOn=false;
  const pose={x:0,y:0,tilt:0,sx:1,sy:1};
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const tanh=v=>{const e=Math.exp(2*clamp(v,-10,10));return (e-1)/(e+1);};
  const pulse=(time,start,duration)=>time>start&&time<start+duration?Math.sin((time-start)/duration*Math.PI):0;
  function idlePose(now){
    const t=now%18000;
    const glance=pulse(t,3200,2300)-pulse(t,6200,2500);
    const follow=pulse(t,3440,2300)-pulse(t,6440,2500);
    const perk=pulse(t,11800,900),settle=pulse(t,12700,750);
    return {eyeX:glance*2,eyeY:-perk,tilt:follow*4,y:-perk*3+settle*.7,sx:1+settle*.035,sy:1-settle*.045,curious:Math.abs(glance)>.75,cap:perk>.35?-1:0};
  }
  function notice(text,ms=2500){status.textContent=text;noticeUntil=performance.now()+ms;status.classList.add('visible');}
  // A small pixel bubble above the head ("!", "?", "♥", "z", "✦"), never task text.
  function pop(text,ms=1200){if(!bubble||reduce.matches)return;bubble.textContent=text;bubble.classList.remove('pop');void bubble.offsetWidth;bubble.classList.add('pop');bubble.style.animationDuration=ms+'ms';}
  function react(name,ms){emote={name,at:performance.now(),until:performance.now()+ms};}
  function apply(next){
    feedReadyAt=next.feedReadyAt||0;
    online=next.online!==false;
    if(mode==='working'&&next.mode==='idle'&&online){completedAt=performance.now();pop('✦',1400);}
    if(mode!=='waiting'&&next.mode==='waiting'&&online)pop('?',1400);
    mode=online?next.mode:'offline';
    pet.dataset.mode=mode;robot.setAttribute('aria-label',mode==='working'?'Boujoy 正在工作，脸部滚动代码；点击打开':mode==='offline'?'Boujoy 暂未连接；点击打开':'打开 Boujoy，可拖动桌宠');canvas.setAttribute('aria-label',mode==='working'?'正在执行任务，代码滚动中':'桌宠表情');
    robot.title=mode==='working'?'任务处理中 · 点击打开 Boujoy':mode==='waiting'?'有一步需要确认 · 点击打开 Boujoy':'点击打开 Boujoy · 右键喂食 · 拖动换位置';
  }
  async function poll(){if(polling||document.hidden)return;polling=true;try{apply(await api.status());}catch{online=false;mode='offline';pet.dataset.mode=mode;}finally{polling=false;}}
  async function pollCursor(){
    if(cursorPolling||document.hidden||!api?.cursor)return;cursorPolling=true;
    try{const next=await api.cursor();if(next&&Number.isFinite(next.x)){const now=performance.now();if(!cursor||Math.hypot(next.x-cursor.x,next.y-cursor.y)>1){cursorMovedAt=now;}cursor=next;}}catch{}finally{cursorPolling=false;}
  }
  api?.onStatus(apply);
  api?.onFed(result=>{
    apply(result);
    if(result.accepted){feedingAt=performance.now();pet.classList.remove('feeding');void pet.offsetWidth;pet.classList.add('feeding');notice('收到一枚 token');}
    else{notice(result.error?'这次没喂成功':'还在消化，稍后再喂');react('pout',1100);}
  });
  robot.addEventListener('pointerdown',e=>{if(e.button!==0)return;dragging=true;moved=false;startX=e.screenX;startY=e.screenY;lastMoveX=e.screenX;lastMoveY=e.screenY;lastMoveAt=performance.now();velX=velY=0;reversals=0;lastSign=0;robot.setPointerCapture(e.pointerId);void api.beginDrag();});
  robot.addEventListener('pointermove',e=>{
    if(!dragging)return;
    if(!moved&&Math.hypot(e.screenX-startX,e.screenY-startY)>4){moved=true;dragAt=performance.now();pop('!',800);}
    if(!moved)return;
    const now=performance.now(),dt=Math.max(8,now-lastMoveAt),vx=(e.screenX-lastMoveX)/dt,vy=(e.screenY-lastMoveY)/dt;
    velX=velX*.55+vx*.45;velY=velY*.55+vy*.45;lastMoveX=e.screenX;lastMoveY=e.screenY;lastMoveAt=now;
    const sign=Math.abs(velX)>.6?Math.sign(velX):0;if(sign&&lastSign&&sign!==lastSign)reversals++;if(sign)lastSign=sign;
    void api.moveDrag();
  });
  robot.addEventListener('pointerup',async e=>{
    if(!dragging)return;dragging=false;robot.releasePointerCapture(e.pointerId);
    if(moved){droppedAt=performance.now();if(reversals>=4){dizzyAt=droppedAt;pop('@',1500);}}
    const result=await api.endDrag();if(!moved&&!result.moved)void api.open();
  });
  robot.addEventListener('pointercancel',()=>{dragging=false;if(moved)droppedAt=performance.now();void api.endDrag();});
  robot.addEventListener('click',e=>{if(e.detail===0)void api.open();});
  // Hovering only draws the eyes to the cursor; the face itself changes for real events
  // (drag, drop, feeding, a finished task, sleep), never just because the mouse passed by.
  robot.addEventListener('pointerenter',()=>{if(!hover)hoverAt=performance.now();hover=true;});
  robot.addEventListener('pointerleave',()=>{hover=false;});
  robot.addEventListener('pointermove',e=>{const b=robot.getBoundingClientRect();gazeX=clamp((e.clientX-b.x-b.width/2)/(b.width/2),-1,1)*3;gazeY=clamp((e.clientY-b.y-b.height*.6)/(b.height/2),-1,1)*2;});
  // Pixel sprites centred on each eye; '#' is an eye-colour pixel.
  const SHAPES={
    wow:['.##.','####','####','####','####','####','.##.'],
    star:['..#..','..#..','#####','.###.','.#.#.'],
    heart:['##.##','#####','#####','.###.','..#..'],
    dizzy:['#...#','.#.#.','..#..','.#.#.','#...#'],
    squintL:['#...','.##.','...#','.##.','#...'],
    squintR:['...#','.##.','#...','.##.','...#'],
    sleepy:['####','.##.'],
    flat:['####']
  };
  const MOUTHS={o:['.#.','#.#','.#.'],wide:['#####','#...#','.###.'],cat:['#.#.#','.#.#.'],smile:['#...#','.###.'],pout:['.##.','#..#']};
  function sprite(shape,cx,cy,color){ctx.fillStyle=color;const h=shape.length,w=shape[0].length,x0=Math.round(cx-w/2),y0=Math.round(cy-h/2);shape.forEach((row,y)=>{for(let x=0;x<w;x++)if(row[x]==='#')ctx.fillRect(x0+x,y0+y,1,1);});return {x:x0,y:y0,w,h};}
  function blush(){ctx.fillStyle='#f3a3b1';ctx.fillRect(20,48,3,1);ctx.fillRect(43,48,3,1);}
  function eyes(expression){
    ctx.save();ctx.translate(Math.round(lookX),Math.round(lookY));
    ctx.fillStyle='#7952f1';
    const L=28.5,R=38.5,Y=43.5,shine=(a,b)=>{ctx.fillStyle='#bda4ff';ctx.fillRect(a,b,1,1);};
    if(expression==='happy'||expression==='shy'){for(const x of [25,36]){ctx.fillRect(x,43,2,2);ctx.fillRect(x+2,41,3,2);ctx.fillRect(x+5,43,2,2);}}
    else if(expression==='closed'){ctx.fillRect(26,44,4,1);ctx.fillRect(37,44,4,1);}
    else if(expression==='wink'){ctx.fillRect(27,40,3,7);shine(27,40);ctx.fillStyle='#7952f1';ctx.fillRect(36,43,2,2);ctx.fillRect(38,41,3,2);ctx.fillRect(41,43,2,2);}
    else if(expression==='wow'){const a=sprite(SHAPES.wow,L,Y-.5,'#7952f1'),b=sprite(SHAPES.wow,R,Y-.5,'#7952f1');shine(a.x+1,a.y+1);shine(b.x+1,b.y+1);}
    else if(['star','heart','dizzy'].includes(expression)){sprite(SHAPES[expression],L,Y,'#7952f1');sprite(SHAPES[expression],R,Y,'#7952f1');}
    else if(expression==='squint'){sprite(SHAPES.squintL,L,Y,'#7952f1');sprite(SHAPES.squintR,R,Y,'#7952f1');}
    else if(expression==='sleepy'){sprite(SHAPES.sleepy,L,Y+1.5,'#7952f1');sprite(SHAPES.sleepy,R,Y+1.5,'#7952f1');}
    else if(expression==='pout'){sprite(SHAPES.flat,L,Y,'#7952f1');sprite(SHAPES.flat,R,Y,'#7952f1');}
    else{ctx.fillRect(27,expression==='curious'?39:40,3,expression==='curious'?8:7);ctx.fillRect(37,expression==='curious'?42:40,3,expression==='curious'?5:7);shine(27,40);shine(37,40);}
    ctx.restore();
    const mouth={wow:'o',squint:'wide',dizzy:'o',heart:'cat',star:'smile',shy:'cat',wink:'smile',pout:'pout'}[expression];
    if(mouth){ctx.save();ctx.translate(Math.round(lookX*.6),Math.round(lookY*.5));sprite(MOUTHS[mouth],33.5,49,'rgba(60,44,52,.72)');ctx.restore();}
    if(['shy','heart','happy','star','wink','squint'].includes(expression))blush();
  }
  function terminal(frame){
    ctx.fillStyle='#102b27';ctx.fillRect(18,34,29,18);
    // Pixel terminal animation, not private task text. Rows move upwards.
    const glyphs=[[1,0,0,0,1,0,1,0,0],[0,1,1,1,0,0,0,1,1],[1,0,1,0,1,0,1,0,1],[1,1,0,0,1,0,1,1,0]];
    const offset=frame%5,line=Math.floor(frame/5);
    for(let row=0;row<5;row++){
      const y=35+row*5-offset;
      for(let col=0;col<6;col++){
        const seed=line+row+col*3;if(col>2&&seed%4===0)continue;
        const glyph=glyphs[seed%glyphs.length];ctx.fillStyle=row===3?'#c5ffcf':col===0?'#58cf9a':'#82dfad';
        for(let bit=0;bit<9;bit++){const py=y+Math.floor(bit/3);if(glyph[bit]&&py>=35&&py<51)ctx.fillRect(20+col*4+bit%3,py,1,1);}
      }
    }
    if(frame%8<4){ctx.fillStyle='#e4ffe9';ctx.fillRect(43,49,2,1);}
  }
  function cursorTarget(now){
    // Look at the cursor anywhere on screen; soft-saturating so far away still reads as "over there".
    if(!cursor||now-cursorMovedAt>8000)return null;
    const cx=cursor.bx+cursor.bw/2,cy=cursor.by+20+88*.55,dx=cursor.x-cx,dy=cursor.y-cy;
    return {eyeX:3*tanh(dx/260),eyeY:2*tanh(dy/220),lean:3*tanh(dx/420),tilt:5*tanh(dx/420),near:Math.hypot(dx,dy)<170};
  }
  function tick(now){
    const remain=Math.max(0,feedReadyAt-Date.now()),feeding=now-feedingAt<2300,age=now-feedingAt;
    const dt=clamp(now-(lastFrame||now-16),1,50),step=dt/16.7;lastFrame=now;
    if(now>noticeUntil)status.classList.remove('visible');
    if(ready&&!document.hidden){
      const follow=hover?null:cursorTarget(now);
      const sleeping=mode==='idle'&&!!api?.cursor&&cursor&&now-cursorMovedAt>90000&&!dragging;
      if(sleeping!==sleepyOn){sleepyOn=sleeping;pet.classList[sleeping?'add':'remove']('sleepy');}
      if(emote&&now>emote.until)emote=null;
      const dropAge=now-droppedAt,dizzy=now-dizzyAt<1600,landing=dropAge<700;
      const dragSpeed=Math.hypot(velX,velY);
      const idle=idlePose(now),blinkPhase=now%6800,blink=blinkPhase>6100&&blinkPhase<6220||blinkPhase>6400&&blinkPhase<6500;
      const eyeTarget=dragging&&moved?{x:clamp(-velX*2,-3,3),y:clamp(-velY*1.5,-2,2)}:hover?{x:gazeX,y:gazeY}:feeding?{x:0,y:0}:follow?{x:follow.eyeX,y:follow.eyeY}:{x:idle.eyeX,y:idle.eyeY};
      const ke=1-Math.exp(-dt/70);lookX+=(eyeTarget.x-lookX)*ke;lookY+=(eyeTarget.y-lookY)*ke;
      const terminalFrame=reduce.matches?0:Math.floor(now/90);
      const done=now-completedAt<1600,fedLove=feeding&&age>900;
      let expression=blink?'closed':idle.curious&&!feeding&&!hover&&!follow?'curious':'open';
      if(sleeping)expression='sleepy';
      if(emote)expression=emote.name;
      if(fedLove)expression='heart';else if(feeding&&age>650)expression='happy';
      if(done)expression='star';
      if(dizzy)expression='dizzy';else if(landing&&!dizzy)expression=dropAge<350?'wow':'happy';
      if(dragging&&moved)expression=now-dragAt<300?'wow':dragSpeed>1.1?'squint':dragSpeed>.25?'happy':'wow';
      const reacting=dragging&&moved||dizzy||landing;
      const code=mode==='working'&&!feeding&&!reacting;
      const mouth=feeding&&age>300&&age<900;
      const signature=[code?terminalFrame:expression,mouth,mode,idle.cap,Math.round(lookX),Math.round(lookY)].join(':');
      if(signature!==lastPaint){lastPaint=signature;ctx.clearRect(0,0,64,64);ctx.imageSmoothingEnabled=false;ctx.drawImage(head,159,123,936,936,4,4,56,56);
        ctx.fillStyle='#fff7e6';ctx.fillRect(18,34,29,18);ctx.fillStyle='#eadbbf';ctx.fillRect(18,34,29,1);ctx.fillRect(18,34,1,18);ctx.fillStyle='#fffdf7';ctx.fillRect(20,35,15,1);
        if(code)terminal(terminalFrame);else if(mouth){ctx.fillStyle='#39283f';ctx.fillRect(26,41,14,7);ctx.fillStyle='#9e7cc8';ctx.fillRect(29,46,8,1);}else eyes(expression);
        if(idle.cap&&!feeding&&mode==='idle'&&!reacting){ctx.clearRect(42,3,12,11);ctx.drawImage(head,159+(42-4)*936/56,123,12*936/56,10*936/56,42,4+idle.cap,12,10);}
        if(mode==='waiting'){ctx.fillStyle='#d7a23f';ctx.fillRect(44,5,4,4);}
      }
      // Pendulum swing while dragged; it keeps wobbling for a moment after release.
      if(!dragging){velX*=Math.pow(.8,step);velY*=Math.pow(.8,step);}
      const swingTarget=dragging&&moved?clamp(-velX*9,-15,15):0,stretchTarget=dragging&&moved?clamp(-velY*.07,-.11,.11):0;
      swingV=(swingV+(swingTarget-swing)*.16*step)*Math.pow(.86,step);swing=clamp(swing+swingV*step,-17,17);
      stretchV=(stretchV+(stretchTarget-stretch)*.2*step)*Math.pow(.8,step);stretch=clamp(stretch+stretchV*step,-.14,.14);
      leanX+=((follow&&!dragging?follow.lean:hover?gazeX*.5:0)-leanX)*.12*step;
      const t=clamp(age-720,0,1500),bounce=feeding?Math.abs(Math.sin(t/430*Math.PI))*Math.exp(-t/620)*13:0;
      const anticipation=feeding&&age<400?Math.sin(age/400*Math.PI):0;
      const hop=(emote?.name==='happy'?pulse(now-emote.at,0,420)*5:0)+(done?Math.abs(Math.sin((now-completedAt)/260*Math.PI))*Math.exp(-(now-completedAt)/700)*9:0);
      const land=landing?Math.sin(clamp(dropAge/700,0,1)*Math.PI*2)*Math.exp(-dropAge/260):0;
      const dizzyWobble=dizzy?Math.sin((now-dizzyAt)/110)*Math.exp(-(now-dizzyAt)/900)*9:0;
      const breath=sleeping?Math.sin(now/1900)*1.1:Math.sin(now/1250)*.65;
      const y=reduce.matches?0:breath+(feeding||follow?0:idle.y)-bounce+anticipation*3-hop+(dragging&&moved?-2:0);
      const x=reduce.matches?0:leanX;
      const tilt=reduce.matches?0:feeding?Math.sin(age/90)*Math.exp(-Math.max(0,age-700)/900)*4:swing+dizzyWobble+(dragging?0:hover?lookX*2:follow?follow.tilt:sleeping?-4:idle.tilt);
      const sx=reduce.matches?1:(feeding?1:idle.sx)+anticipation*.1-(bounce/13)*.055-stretch*.6+land*.1,sy=reduce.matches?1:(feeding?1:idle.sy)-anticipation*.13+(bounce/13)*.085+stretch-land*.12;
      // One last low-pass over the whole pose: switching between idle, follow and hover
      // targets, and the 50 ms cursor samples, no longer show up as small jumps.
      const k=1-Math.exp(-dt/(dragging?40:85));
      pose.x+=(x-pose.x)*k;pose.y+=(y-pose.y)*k;pose.tilt+=(tilt-pose.tilt)*k;pose.sx+=(sx-pose.sx)*k;pose.sy+=(sy-pose.sy)*k;
      canvas.style.transform=`translate(${pose.x.toFixed(2)}px,${pose.y.toFixed(2)}px) rotate(${pose.tilt.toFixed(2)}deg) scale(${pose.sx.toFixed(3)},${pose.sy.toFixed(3)})`;
    }
    requestAnimationFrame(tick);
  }
  head.onload=()=>{ready=true;};head.src='robot-head-base.png';head.onerror=()=>notice('头像暂时没有加载',10000);
  if(api){void poll();setInterval(poll,500);if(api.cursor){void pollCursor();setInterval(pollCursor,50);}document.addEventListener('visibilitychange',()=>{if(!document.hidden)void poll();});}
  else notice('请从 Boujoy 桌面端打开',10000);
  requestAnimationFrame(tick);
})();
