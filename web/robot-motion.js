/* Crisp bitmap expressions; continuous poses composited on the display refresh clock. */
(() => {
  const reduce=matchMedia('(prefers-reduced-motion: reduce)');
  const pointer={x:0,y:0,at:0,inside:false};
  const robots=new Map(),continuity=new Map(),images={};
  const eyes=[
    [[159,211,56,129],[303,211,57,129]],[[155,240,59,74],[300,240,59,75]],
    [[149,268,65,26],[297,268,65,26]],[[100,203,145,86],[274,203,145,86]],
    [[155,172,59,139],[300,202,59,87]],[[140,160,80,160],[290,160,80,160]]
  ];
  const eyeSizes=[[[3,7],[3,7]],[[3,4],[3,4]],[[4,1],[4,1]],[[8,5],[8,5]],[[3,8],[3,5]],[[4,9],[4,9]]];
  const expressions=['open','half','closed','happy','curious','attentive'];
  // Each bot has its own face: eye shape and mouth, picked once from its id
  // (boujoy keeps round eyes). Expressions (blink, happy, thinking…) derive from it.
  const FACES=[
    {open:['.###.','#####','#####','#####','#####','.###.']},                       // round
    {open:['.#.','###','.#.'],mouth:['#...#','.###.']},                             // button dots + smile
    {open:['.##.','####','####','####','####','.##.'],mouth:['#.#.#','.#.#.']},       // tall ovals + cat mouth
    {open:['..#..','.###.','#####','.###.','..#..'],mouth:['.#.','#.#','.#.']},       // sparkle + little o
    {open:['####','####','####','####']},                                            // square pixels
    {open:['#####','#####','.###.'],mouth:['#...#','.###.']},                       // sleepy-content
    {open:['.###.','#...#','#...#'],mouth:['#...#','.###.']},                       // always smiling
    {open:['##.##','#####','#####','.###.','..#..'],mouth:['#...#','.###.']},          // hearts
    {open:['#...','.##.','...#','.##.','#...'],right:['...#','.##.','#...','.##.','...#'],mouth:['#####','#...#','.###.']}, // >_< squeeze
    {open:['..#..','..#..','#####','.###.','.#.#.'],mouth:['#...#','.###.']},          // star eyes
    {open:['.##.','####','####','####','####','####','.##.'],mouth:['.#.','#.#','.#.']}, // wow
    {open:['#...#','.#.#.','..#..','.#.#.','#...#'],mouth:['.#.','#.#','.#.']},       // dizzy
    {open:['.###.','#####','#####','.###.'],right:['.###.','#...#'],mouth:['#...#','.###.']}, // wink
    {open:['####','.##.'],mouth:['#.#.#','.#.#.']}                                     // content cat
  ];
  const arc=w=>['.'+'#'.repeat(w-2)+'.','#'+'.'.repeat(w-2)+'#'];
  const cup=w=>['#'+'.'.repeat(w-2)+'#','.'+'#'.repeat(w-2)+'.'];
  function eyeShape(face,expression,side){
    const open=side&&face.right||face.open,w=open[0].length;
    if(expression===2)return cup(w);                                   // closed / blink
    if(expression===3)return open.length<=3?open:open.slice(0,Math.ceil(open.length/2)); // happy: its own eyes, squinted from below
    if(expression===1)return open.slice(Math.floor(open.length/2));    // half
    if(expression===5||expression===4&&!side)return open.length<5?['.'+'#'.repeat(w-2)+'.',...open]:open; // attentive / curious
    return open;
  }

  // The bitmap is painted at 4x so eyes and cap can glide in quarter-pixel steps
  // while every pixel stays crisp; at 1x they jumped a whole pixel at a time.
  const S=4;
  const q=v=>Math.round(v*S)/S;
  let measuredAt=0,ready=false,frame=0,last=0,dirty=true,typingAt=-Infinity,interactionAt=performance.now();
  const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
  const sequence=(items,time,ms=84)=>items[Math.min(items.length-1,Math.floor(Math.max(0,time)/ms))];
  const pose=(items,time,ms=84)=>{
    const t=clamp(time/ms,0,items.length-1),i=Math.floor(t),f=t-i,e=f*f*(3-2*f);
    return items[i]+(items[Math.min(i+1,items.length-1)]-items[i])*e;
  };
  function sync(){
    for(const [el] of robots)if(!el.isConnected)robots.delete(el);
    for(const el of document.querySelectorAll('canvas[data-robot]'))if(!robots.has(el)){
      el.width=64*S;el.height=64*S;
      const id=el.closest('[data-bot-id]')?.dataset.botId;
      const surface=el.closest('#role-nav')?'rail':el.closest('.robot-welcome')?'hero':el.closest('.robot-companion')?'task':el.closest('.chat-pill')?'pill':'dialog';
      const key=id?`${surface}:${id}`:null,now=performance.now();
      const r={born:now,blink:now+1800+Math.random()*3600,blinkAt:0,doubleBlink:false,poke:0,pokes:0,gx:0,gy:0,vx:0,vy:0,cap:0,capV:0,lastDy:0,hoverAt:0,wakeAt:0,poseX:0,poseY:0,poseSquash:0,poseCompression:0,poseTilt:0,phase:Math.random()*5000,
        ...(key?continuity.get(key):null),ctx:el.getContext('2d'),hover:false,rect:null,signature:'',surface};
      r.sprite=document.createElement('canvas');r.sprite.width=r.sprite.height=64*S;r.paint=r.sprite.getContext('2d');
      robots.set(el,r);if(key){continuity.set(key,r);if(continuity.size>100)continuity.delete(continuity.keys().next().value);}
    }
    dirty=true;
  }
  function bounds(){
    for(const [el,r] of robots){
      // Measure the layout box without our compositor pose, so gaze cannot chase its own motion.
      const transform=el.style.transform;el.style.transform='none';r.rect=el.getBoundingClientRect();el.style.transform=transform;
    }
    dirty=false;
  }
  function draw(el,r,now,dt){
    const box=r.rect;if(!box||!box.width||box.bottom<0||box.top>innerHeight)return;
    const ctx=r.paint,state=el.closest('[data-robot-state]')?.dataset.robotState||'idle';
    // A small sidebar robot keeps its own face after a finished task; the status dot says it's done.
    const mood=r.surface==='rail'&&state==='done'?'idle':state;
    const quiet=reduce.matches||['offline','rest'].includes(mood);
    const active=!!el.closest('.selected,.robot-welcome,.robot-companion,.bot-appearance-preview');
    const recent=pointer.inside&&now-pointer.at<6500;
    const tx=recent?clamp((pointer.x-box.x-box.width/2)/Math.max(150,innerWidth*.24),-1,1):0;
    const ty=recent?clamp((pointer.y-box.y-box.height*.64)/Math.max(130,innerHeight*.26),-1,1):0;
    if(quiet){r.gx=r.gy=r.vx=r.vy=0;}else{
      const step=dt/(1000/18),damping=Math.pow(.64,step);
      r.vx=(r.vx+(tx*4-r.gx)*.34*step)*damping;r.vy=(r.vy+(ty*3-r.gy)*.34*step)*damping;
      r.gx=clamp(r.gx+r.vx*step,-4,4);r.gy=clamp(r.gy+r.vy*step,-3,3);
    }
    let gx=q(r.gx),gy=q(r.gy),dx=0,dy=0,tilt=0,expression=0,wink=-1,lamp=0,squash=0,compression=0,motion='idle';
    const age=now-r.born,react=now-r.poke,idle=now-interactionAt;
    if(quiet){motion='still';}
    else{
      // Every bot breathes; the selected one a little deeper.
      const breath=Math.sin((age+r.phase)*Math.PI/2000);
      // The welcome robot keeps its own motion; the pill bot only breathes, so the pill stays level.
      if(r.surface==='hero')dy=-.85*breath;
      else if(r.surface==='pill')dy=-.9*breath;
      else{dy=(active?-1.7:-1.3)*breath;tilt=1.1*Math.sin((age+r.phase)*Math.PI/3300);}
      motion='breathing';
      if(mood==='working'){
        motion='thinking';lamp=Math.floor(now/500)%2;
        if(!recent){gx=q(pose([-2,-2,0,2,2,0,-2],(age+r.phase)%1800,300));gy=0;}
        if(active)dy=pose([0,-1,-1,0,0,0],age%1800,300);
      }else if(mood==='done'){motion='content';}
      else if(mood==='attention'){motion='attentive';}
      else if(mood==='error'){motion='resting';}
      if(active&&mood==='idle'&&!recent&&idle>22000){
        motion='sleepy';gx=0;gy=1;dy=pose([0,0,1,1],age%3200,800);
      }else if(mood==='idle'&&!recent&&idle>6000&&(age+r.phase)%11000<1700){
        motion='looking-around';const t=(age+r.phase)%11000;gx=q(pose([0,-2,-2,-1,0,1,2,2,0],t,190));dx=gx/2;
      }
      if(r.hover){motion='curious';dy=pose(r.surface==='hero'?[1,0,-1,-2,-1,-1]:[1,0,-2,-3.5,-3,-2.5],now-r.hoverAt,65);}
      // The head leans and turns toward the pointer, not just the eyes.
      if(recent&&r.surface!=='pill'&&['breathing','content','attentive','resting'].includes(motion)){dx=r.gx/(active?2:2.6);tilt=r.gx*(active?1.7:1.3);}
      if(active&&now-typingAt<2000){motion='listening';gx=0;gy=2;dy=-1;}
      if(active&&pointer.inside&&now-pointer.at>650&&now-pointer.at<1000&&r.stopAt!==pointer.at){r.stopAt=pointer.at;r.blinkAt=now;r.doubleBlink=false;r.blink=now+2800+Math.random()*4500;}
      if(now>r.blink){r.blinkAt=now;r.doubleBlink=Math.random()<.28;r.blink=now+3200+Math.random()*4500;}
      const blinkAge=now-r.blinkAt;
      if(r.blinkAt&&motion!=='sleepy'){
        if(blinkAge<252)expression=sequence([0,1,2,2,1,0],blinkAge,42);
        else if(r.doubleBlink&&blinkAge>390&&blinkAge<558)expression=sequence([1,2,2,1],blinkAge-390,42);
      }
      if(active&&age<700){motion='hello';dy=pose([2,1,-2,-3,-2,0,0,0],age);}
      if(mood==='done'&&el.closest('.robot-celebrate')&&age<1000){motion='celebrating';dy=pose([1,2,-3,-5,-3,0,-1,0,0,0,0,0],age);lamp=1;}
      if(r.lastMotion==='sleepy'&&motion!=='sleepy')r.wakeAt=now;
      if(r.wakeAt&&now-r.wakeAt<650){motion='waking';dy=pose([1,1,-1,-2,-1,0,0],now-r.wakeAt,90);lamp=1;}
      if(r.poke&&react<1350){
        gx=0;gy=0;dx=0;dy=0;lamp=1;
        const action=(r.pokes-1)%6;
        if(action===0){
          motion='greeting';dy=pose([1,2,1,-2,-3,-3,-2,0,1,0,0,0,0,0,0],react,90);
          compression=pose([1,2,1,-1,-1,0,0,2,1,0,0,0,0,0,0],react,90);squash=compression>0?1:0;expression=react>260?3:2;
        }
        if(action===1){motion='wink';expression=0;dy=-1;dx=pose([0,0,-1,-1,-1,0,0],react,150);if(react>180&&react<960)wink=1;gx=-1;}
        if(action===2){motion='nod';dy=pose([0,1,2,2,1,0,0,1,1,0,0,0,0,0,0],react,90);compression=dy>0?1:0;gy=dy>0?1:0;expression=3;}
        if(action===3){motion='playful';dx=pose([0,-1,-2,-2,-1,0,1,2,2,1,0,0,0,0,0],react,90);gx=sequence([-2,-2,-1,0,1,2,2,1,0,-1,0,0,0,0,0],react,90);expression=react<800?4:3;}
        if(action===4){motion='delighted';dy=pose([1,2,-2,-3,-2,0,1,-2,-3,-1,1,0,0,0,0],react,90);compression=dy>0?2:dy<0?-1:0;squash=dy>0?1:0;expression=3;}
        if(action===5){motion='peek';gx=sequence([0,2,3,3,2,0,-2,-3,-3,-2,0,0,0,0,0],react,90);dx=pose([0,0,1,1,1,0,0,-1,-1,-1,0,0,0,0,0],react,90);expression=react<930?5:3;gy=-1;}
      }
    }
    r.lastMotion=motion;
    // Move the complete bitmap on subpixels; never snap the head to its 64px paint grid.
    const blend=1-Math.exp(-dt/35);
    for(const [key,target] of [['poseX',dx],['poseY',dy],['poseSquash',squash],['poseCompression',compression],['poseTilt',tilt]])r[key]=quiet?0:r[key]+(target-r[key])*blend;
    const transform=`translate3d(${(r.poseX/64*100).toFixed(4)}%,${(r.poseY/64*100).toFixed(4)}%,0) rotate(${(r.poseTilt||0).toFixed(3)}deg) scale(${(1+r.poseSquash/32).toFixed(5)},${(1-r.poseCompression/64).toFixed(5)})`;
    if(el.style.transform!==transform)el.style.transform=transform;
    el.style.transformOrigin='50% 100%';
    if(el.parentElement.matches('.robot-hero'))el.parentElement.style.setProperty('--robot-shadow-scale',String(1+Math.min(0,r.poseY)*.065));
    if(quiet){r.cap=r.capV=0;}else{const step=dt/(1000/18),target=clamp(-r.poseX*.7-(r.poseY-r.lastDy)/step*.8,-1.3,1.3);r.capV=(r.capV+(target-r.cap)*.38*step)*Math.pow(.6,step);r.cap=clamp(r.cap+r.capV*step,-1.3,1.3);}
    r.lastDy=r.poseY;const capX=Math.round(r.cap),capY=lamp&&r.poseY<-.5?-1:0;
    dx=dy=0; // The raster stays stationary; only the compositor moves and stretches it.
    const style=getComputedStyle(el),hue=style.getPropertyValue('--robot-hue').trim()||'0deg',saturation=style.getPropertyValue('--robot-saturation').trim()||'1',brightness=style.getPropertyValue('--robot-brightness').trim()||'1';
    const signature=[hue,saturation,brightness,mood,gx,gy,expression,wink,lamp,motion,capX,capY,r.pokes,r.poke&&react<1350].join(',');
    if(r.signature===signature)return;r.signature=signature;
    ctx.setTransform(S,0,0,S,0,0);ctx.clearRect(0,0,64,64);ctx.imageSmoothingEnabled=false;ctx.filter='none';
    ctx.drawImage(images.head,159,123,936,936,4+dx,4+dy,56,56);
    // Preserve neutral shell colors; a shallow warm display sits inside the dark rim.
    ctx.save();ctx.globalCompositeOperation='source-atop';
    const sheen=ctx.createLinearGradient(8+gx,20+dy,54,59+dy);
    sheen.addColorStop(0,'rgba(255,255,255,.11)');sheen.addColorStop(.48,'rgba(255,255,255,.015)');sheen.addColorStop(1,'rgba(18,14,26,.12)');
    ctx.fillStyle=sheen;ctx.fillRect(0,0,64,64);ctx.restore();
    const glass=ctx.createLinearGradient(0,34+dy,0,52+dy);
    glass.addColorStop(0,'rgba(255,255,255,.28)');glass.addColorStop(.45,'rgba(255,255,255,.02)');glass.addColorStop(1,'rgba(198,163,97,.11)');
    ctx.fillStyle=glass;ctx.fillRect(18+dx,34+dy,29,18);
    ctx.fillStyle='rgba(42,31,29,.12)';ctx.fillRect(18+dx,34+dy,29,1);ctx.fillRect(18+dx,35+dy,1,16);
    ctx.fillStyle='rgba(255,255,255,.6)';ctx.fillRect(20+dx,35+dy,12,1);
    ctx.fillStyle='rgba(255,255,255,.25)';ctx.fillRect(20+dx,36+dy,6,1);ctx.fillRect(31+dx,51+dy,15,1);
    // The cap trails the head by one pixel instead of moving as a rigid sticker.
    ctx.clearRect(42+dx,3+dy,12,11);
    ctx.filter=`hue-rotate(${hue}) saturate(${saturation}) brightness(${brightness})`;
    ctx.drawImage(images.base,42,3,12,11,42+dx+capX,3+dy+capY,12,11);
    if(lamp){ctx.save();ctx.globalCompositeOperation='source-atop';ctx.fillStyle='rgba(255,255,255,.3)';ctx.fillRect(43+dx+capX,5+dy+capY,4,2);ctx.restore();}
    // At rest every bot has the original face. A click plays a reaction with one of
    // the pixel faces below (a different one each time), then it returns to default.
    const poking=!quiet&&r.poke&&react<1350;
    if(!poking){
      const faceX=33+dx,faceY=43+dy;
      for(let i=0;i<2;i++){
        const e=i===wink?2:expression,[sx,sy,sw,sh]=eyes[e][i],[w,h]=eyeSizes[e][i];
        const x=q(faceX+(i?5:-5)+gx-w/2),y=q(faceY+gy-h/2);
        ctx.drawImage(images.eyes,(e%3)*512+sx,Math.floor(e/3)*512+sy,sw,sh,x,y,w,h);
        if(e!==2){ctx.save();ctx.globalCompositeOperation='source-atop';ctx.fillStyle='rgba(255,255,255,.22)';ctx.fillRect(x,y,Math.min(2,w),1);ctx.restore();}
      }
    }else{
      const faceX=33+dx,faceY=42+dy,face=r.pokeFace||FACES[1];
      // Everything on the face stays inside the screen glass; nothing bleeds onto the rim.
      ctx.save();ctx.beginPath();ctx.rect(19+dx,35+dy,27,16);ctx.clip();
      const pixels=(shape,x,y,color)=>{ctx.fillStyle=color;shape.forEach((row,yy)=>{for(let xx=0;xx<row.length;xx++)if(row[xx]==='#')ctx.fillRect(x+xx,y+yy,1,1);});};
      for(let i=0;i<2;i++){
        const e=i===wink?2:expression,shape=eyeShape(face,e,i),h=shape.length,w=shape[0].length;
        const x=Math.round(faceX+(i?7:-7)+gx-w/2),y=Math.round(faceY+gy-h/2);
        pixels(shape,x,y,'#7046f2');
        if(![2,3].includes(e)&&h>=3&&shape[1][1]==='#'){ctx.save();ctx.filter='none';ctx.fillStyle='rgba(255,255,255,.8)';ctx.fillRect(x+1,y+1,1,1);ctx.restore();}
      }
      ctx.save();ctx.filter='none';
      if(face.mouth){const m=expression===3&&face.mouth.length<3?['#...#','.###.']:face.mouth;pixels(m,Math.round(faceX-m[0].length/2+gx),faceY+5+gy,'rgba(60,44,52,.72)');}
      ctx.fillStyle='rgba(240,138,150,.8)';const cheekX=Math.max(-1,Math.min(1,gx));
      ctx.fillRect(faceX-11+cheekX,faceY+5+gy,3,1);ctx.fillRect(faceX+9+cheekX,faceY+5+gy,3,1);ctx.restore();
      ctx.restore();
    }
    r.ctx.setTransform(1,0,0,1,0,0);r.ctx.clearRect(0,0,64*S,64*S);r.ctx.imageSmoothingEnabled=false;
    r.ctx.drawImage(r.sprite,0,0);
    el.dataset.antenna=String(capX);el.dataset.squash=`${squash},${compression}`;
    el.dataset.gaze=`${gx},${gy}`;el.dataset.expression=wink>=0?'wink':expressions[expression];el.dataset.motion=motion;
  }
  // Re-measure a few times a second: layout shifts (a new message, a panel opening) move bots
  // without a scroll or resize, and a stale box can freeze a bot that looks off screen.
  function tick(now){frame=0;if(document.hidden||!ready)return;const dt=clamp(now-last||1000/60,1,1000/30);last=now;if(now-measuredAt>700)dirty=true;if(dirty){bounds();measuredAt=now;}for(const [el,r] of robots)draw(el,r,now,dt);frame=requestAnimationFrame(tick);}
  function wake(){if(!frame&&ready&&!document.hidden)frame=requestAnimationFrame(tick);}
  document.addEventListener('pointermove',e=>{if(e.pointerType==='touch')return;pointer.x=e.clientX;pointer.y=e.clientY;pointer.at=performance.now();pointer.inside=true;interactionAt=pointer.at;},{passive:true});
  document.addEventListener('pointerleave',()=>pointer.inside=false);
  window.addEventListener('blur',()=>{pointer.inside=false;for(const r of robots.values())r.hover=false;});
  document.addEventListener('input',e=>{interactionAt=performance.now();if(e.target.closest('#composer'))typingAt=interactionAt;});
  document.addEventListener('keydown',()=>interactionAt=performance.now());
  document.addEventListener('pointerover',e=>{const target=e.target.closest('[data-robot-hit],.role-row,.bot-color-option');if(!target)return;interactionAt=performance.now();for(const el of target.querySelectorAll('canvas[data-robot]')){const r=robots.get(el);if(r&&!r.hover){r.hover=true;r.hoverAt=performance.now();}}},{passive:true});
  document.addEventListener('pointerout',e=>{const target=e.target.closest('[data-robot-hit],.role-row,.bot-color-option');if(!target||target.contains(e.relatedTarget))return;for(const el of target.querySelectorAll('canvas[data-robot]')){const r=robots.get(el);if(r)r.hover=false;}},{passive:true});
  document.addEventListener('click',e=>{interactionAt=performance.now();const target=e.target.closest('[data-robot-hit],.role-row');if(!target)return;for(const el of target.querySelectorAll('canvas[data-robot]')){const r=robots.get(el);if(r){r.poke=interactionAt;r.pokes++;r.pokeFace=FACES[1+Math.floor(Math.random()*(FACES.length-1))];}}});
  window.addEventListener('resize',()=>dirty=true);
  document.addEventListener('scroll',()=>dirty=true,{capture:true,passive:true});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(frame);frame=0;}else{dirty=true;interactionAt=performance.now();wake();}});
  reduce.addEventListener('change',()=>{for(const r of robots.values())r.signature='';});
  new MutationObserver(records=>{if(records.some(record=>[...record.addedNodes,...record.removedNodes].some(node=>node.nodeType===1&&(node.matches('canvas[data-robot]')||node.querySelector('canvas[data-robot]')))))sync();}).observe(document.body,{childList:true,subtree:true});
  Promise.all([['head','head-base'],['eyes','eyes-atlas']].map(([key,name])=>new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>{images[key]=img;resolve();};img.onerror=reject;img.src=`/robot-${name}.png`;}))).then(()=>{images.base=document.createElement('canvas');images.base.width=images.base.height=64;const base=images.base.getContext('2d');base.imageSmoothingEnabled=false;base.drawImage(images.head,159,123,936,936,4,4,56,56);ready=true;sync();wake();}).catch(()=>{
    for(const el of document.querySelectorAll('canvas[data-robot]')){const img=document.createElement('img');img.src='/robot-head-base.png';img.className='robot-image';img.alt='';el.replaceWith(img);}
  });
})();
