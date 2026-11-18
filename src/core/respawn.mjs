// "Restart" used to mean "exit and let launchd start us again". When the service was
// started by the desktop app or by hand there is nobody to do that, and it stayed down.
// Outside launchd the service now starts its own successor before it exits.
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {SERVICE_LABEL} from '../distribution.mjs';
export {SERVICE_LABEL};
export const supervised=(env=process.env)=>env.XPC_SERVICE_NAME===SERVICE_LABEL;
export function successorCommand(serverFile,{delayMs=1500}={}){
  return ['-e',`setTimeout(()=>import(${JSON.stringify(pathToFileURL(serverFile).href)}),${Number(delayMs)||0})`];
}
export function startSuccessor(serverFile,{env=process.env,cwd=process.cwd(),spawnImpl=spawn,delayMs}={}){
  if(supervised(env))return false;
  const child=spawnImpl(process.execPath,successorCommand(serverFile,{delayMs}),{cwd,env,detached:true,stdio:'ignore'});child.unref?.();return true;
}
