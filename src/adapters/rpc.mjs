import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { AppError } from '../core/errors.mjs';

export class LineRPC extends EventEmitter {
  constructor(command,args,{cwd,env,stderr}={}){
    super();this.pending=new Map();this.sequence=0;this.dead=false;this.closing=false;this.killTimer=null;
    this.child=spawn(command,args,{cwd,env,stdio:['pipe','pipe','pipe']});
    this.child.on('error',e=>this.fail(e));this.child.on('exit',()=>{clearTimeout(this.killTimer);this.fail(new AppError('runtime_exited','执行引擎已退出',502));});
    this.child.stdin.on('error',e=>this.fail(e));
    this.child.stderr.on('data',b=>stderr?.(b.toString()));
    const reader=createInterface({input:this.child.stdout});reader.on('line',line=>{
      if(this.dead)return;
      if(Buffer.byteLength(line)>24*1024*1024)return this.close();
      let m;try{m=JSON.parse(line);}catch{return;}
      if(m.id!==undefined&&this.pending.has(m.id)){
        const p=this.pending.get(m.id);this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new AppError('rpc_error',String(m.error.message).slice(0,1500),502)):p.resolve(m.result);
      } else if(m.method)this.emit('notification',m);
    });
  }
  write(message){
    if(this.dead)return;
    try{this.child.stdin.write(JSON.stringify(message)+'\n',e=>{if(e)this.fail(e);});}catch(e){this.fail(e);}
  }
  request(method,params={},timeout=60000){
    if(this.dead)return Promise.reject(new AppError('runtime_exited','执行引擎不可用',502));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=Number.isFinite(timeout)?setTimeout(()=>{this.pending.delete(id);reject(new AppError('rpc_timeout',`${method} 等待超时`,504));},timeout):null;
      this.pending.set(id,{resolve,reject,timer});this.write({jsonrpc:'2.0',id,method,params});
    });
  }
  notify(method,params={}){this.write({jsonrpc:'2.0',method,params});}
  fail(e){if(this.dead)return;this.dead=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(e);}this.pending.clear();this.emit('closed');}
  close(){
    if(this.closing)return;this.closing=true;
    // Prevent dispose() from writing shutdown while this process is being terminated.
    this.fail(new AppError('runtime_exited','执行引擎连接已关闭',502));
    this.child.kill('SIGTERM');
    this.killTimer=setTimeout(()=>{if(this.child.exitCode===null&&!this.child.signalCode)this.child.kill('SIGKILL');},2500);this.killTimer.unref();
  }
}
