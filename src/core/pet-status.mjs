// The desk pet only needs three numbers. It used to read and parse the whole state
// file twice a second; the service now keeps a tiny file beside it, rewritten only
// when the summary changes.
import fs from 'node:fs';
import path from 'node:path';
export function summarizeTasks(tasks){
  let running=0,waiting=0;
  for(const t of tasks||[]){if(t.status==='waiting_approval')waiting++;else if(t.status==='queued'||t.status==='running'||t.status==='waiting_children')running++;}
  return {mode:running?'working':waiting?'waiting':'idle',running,waiting};
}
export function watchPetStatus(store,dataDir,{pid=process.pid}={}){
  const file=path.join(dataDir,'pet-status.json');let last='';
  const write=()=>{
    const summary=summarizeTasks(store.data?.tasks),key=JSON.stringify(summary);if(key===last)return;
    try{const temp=file+'.'+pid+'.tmp';fs.writeFileSync(temp,JSON.stringify({...summary,pid,at:Date.now()}),{mode:0o600});fs.renameSync(temp,file);last=key;}catch{}
  };
  write();store.on('change',write);
  return ()=>{store.off?.('change',write);try{fs.rmSync(file,{force:true});}catch{}};
}
