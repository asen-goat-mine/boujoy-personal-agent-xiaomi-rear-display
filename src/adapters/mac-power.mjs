import {spawn} from 'node:child_process';
// -s applies only on AC power. -w binds the assertion to the service PID even
// if the JavaScript host dies before normal shutdown. No system setting changes.
export class MacPower{
 constructor({ownerPid=process.pid,platform=process.platform,spawnProcess=spawn}={}){Object.assign(this,{ownerPid,platform,spawnProcess});this.requested=false;this.child=null;this.error=null;this.closed=false;}
 setEnabled(value){this.requested=value===true;this.closed=false;if(!this.requested){this.stoppingChild=this.child;this.child?.kill('SIGTERM');return this.status();}if(this.platform!=='darwin'||this.child)return this.status();
  const child=this.spawnProcess('/usr/bin/caffeinate',['-s','-w',String(this.ownerPid)],{stdio:'ignore'});this.child=child;this.error=null;child.once('error',()=>{if(this.child===child){this.child=null;this.error='assertion_unavailable';}});child.once('exit',()=>{if(this.child!==child)return;this.child=null;const toggled=this.stoppingChild===child;this.stoppingChild=null;if(this.requested&&!this.closed){if(toggled)this.setEnabled(true);else this.error='assertion_exited';}});return this.status();
 }
 status(){return {enabled:this.requested,assertionActive:!!this.child?.pid,acOnly:true,supported:this.platform==='darwin',error:this.error,preventsLidClose:false};}
 close(){this.closed=true;this.requested=false;this.child?.kill('SIGTERM');}
}
