const fs=require('node:fs');
const path=require('node:path');
const FEED_COOLDOWN_MS=60000;
function summarizeTasks(data){
  const tasks=Array.isArray(data?.tasks)?data.tasks:[];
  const running=tasks.filter(t=>['queued','running','waiting_children'].includes(t.status)).length;
  const waiting=tasks.filter(t=>t.status==='waiting_approval').length;
  return {mode:running?'working':waiting?'waiting':'idle',running,waiting};
}
class PetState{
  constructor(file){this.file=file;this.data={lastFedAt:0,feeds:0,position:null};try{const saved=JSON.parse(fs.readFileSync(file,'utf8'));if(Number.isFinite(saved.lastFedAt)&&saved.lastFedAt>=0)this.data.lastFedAt=saved.lastFedAt;if(Number.isSafeInteger(saved.feeds)&&saved.feeds>=0)this.data.feeds=saved.feeds;if(Number.isFinite(saved.position?.x)&&Number.isFinite(saved.position?.y))this.data.position=saved.position;}catch{}}
  status(now=Date.now()){return {feedReadyAt:this.data.lastFedAt?this.data.lastFedAt+FEED_COOLDOWN_MS:0,remainingMs:Math.max(0,(this.data.lastFedAt?this.data.lastFedAt+FEED_COOLDOWN_MS:0)-now),feeds:this.data.feeds};}
  save(next){fs.mkdirSync(path.dirname(this.file),{recursive:true});const temp=this.file+'.tmp';fs.writeFileSync(temp,JSON.stringify(next),{mode:0o600});fs.renameSync(temp,this.file);this.data=next;}
  feed(now=Date.now()){if(this.status(now).remainingMs>0)return {accepted:false,...this.status(now)};this.save({...this.data,lastFedAt:now,feeds:this.data.feeds+1});return {accepted:true,...this.status(now)};}
  position(x,y){this.save({...this.data,position:{x:Math.round(x),y:Math.round(y)}});}
}
module.exports={PetState,summarizeTasks,FEED_COOLDOWN_MS};
