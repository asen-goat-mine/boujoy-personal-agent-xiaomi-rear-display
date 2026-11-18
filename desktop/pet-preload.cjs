const {contextBridge,ipcRenderer}=require('electron');
// Only the bundled pet receives this narrow bridge; the web app keeps no IPC access.
contextBridge.exposeInMainWorld('boujoyPet',Object.freeze({
  status:()=>ipcRenderer.invoke('pet:status'),
  onStatus:callback=>{const listener=(_event,result)=>callback(result);ipcRenderer.on('pet:status-updated',listener);return ()=>ipcRenderer.removeListener('pet:status-updated',listener);},
  onFed:callback=>{const listener=(_event,result)=>callback(result);ipcRenderer.on('pet:fed',listener);return ()=>ipcRenderer.removeListener('pet:fed',listener);},
  open:()=>ipcRenderer.invoke('pet:open'),
  beginDrag:()=>ipcRenderer.invoke('pet:drag-start'),moveDrag:()=>ipcRenderer.invoke('pet:drag-move'),endDrag:()=>ipcRenderer.invoke('pet:drag-end'),
  cursor:()=>ipcRenderer.invoke('pet:cursor')
}));
