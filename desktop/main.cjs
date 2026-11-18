const {app,BrowserWindow,Menu,shell,session,ipcMain,systemPreferences}=require('electron');
const {allowedAudio}=require('./media-permission.cjs');
const {probeService}=require('./service-identity.cjs');
const {pathToFileURL}=require('node:url');
const {PetState,summarizeTasks}=require('./pet-state.cjs');
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const config=require('./portable-runtime.cjs').resolveRuntime(require('./runtime.json'),__dirname,app.getPath('appData'),app.getPath('documents'));
const ORIGIN=config.origin;
let window,petWindow,petState,dragState,screen,petWatcher,petUpdateTimer,quitting=false;
app.setName(config.productName);
app.setPath('userData',path.join(config.data,'desktop-native'));
const local=url=>{try{return new URL(url).origin===ORIGIN;}catch{return false;}};
function openExternal(url){try{if(['https:','http:'].includes(new URL(url).protocol)&&!local(url))void shell.openExternal(url);}catch{}}
async function available(){return probeService({origin:ORIGIN,expectedIdentity:config.expectedIdentity});}
async function ensureService(){
  if(await available())return;
  if(config.portable){require('./portable-runtime.cjs').initializePortableMemory(config);const dest=path.join(config.data,'tools/phoneuse/1.3.0');fs.mkdirSync(dest,{recursive:true,mode:0o700});for(const name of ['phoneuse_client.py','LICENSE']){const target=path.join(dest,name);if(!fs.existsSync(target))fs.copyFileSync(path.join(__dirname,'phoneuse',name),target);}}
  fs.mkdirSync(path.join(config.data,'logs'),{recursive:true,mode:0o700});
  const log=fs.openSync(path.join(config.data,'logs/desktop-native.log'),'a',0o600);
  const child=spawn(config.node,[path.join(config.root,'src/server.mjs')],{cwd:config.data,env:{...process.env,BOUJOY_DATA:config.data,BOUJOY_PORT:String(config.port),...(config.portable?{PYTHONDONTWRITEBYTECODE:'1',BOUJOY_HARNESS:config.harness,BOUJOY_MEMORY_VAULT:config.memory,BOUJOY_PYTHON:config.python,PATH:[path.dirname(config.node),path.dirname(config.python),process.env.PATH||''].join(path.delimiter)}:{})},detached:true,stdio:['ignore',log,log]});child.unref();fs.closeSync(log);
  for(let i=0;i<60;i++){if(await available())return;await new Promise(resolve=>setTimeout(resolve,250));}
  throw Error('本机服务暂时未启动，请稍后重新打开。');
}
const PET_SIZE={width:120,height:126};
const PET_FILE=path.join(__dirname,'pet/pet.html');
let petSummaryFile=false;
function petStatus(){
  let taskStatus={mode:'offline',running:0,waiting:0},online=false;
  try{
    const pid=Number(fs.readFileSync(path.join(config.data,'service.lock/pid'),'utf8'));
    if(!Number.isSafeInteger(pid)||pid<=0)throw Error('No service');
    process.kill(pid,0);
    // The service keeps a tiny summary file; the whole state is parsed only when an older
    // service has not written one.
    let summary=null;
    try{const row=JSON.parse(fs.readFileSync(path.join(config.data,'pet-status.json'),'utf8'));if(row.pid===pid&&['working','waiting','idle'].includes(row.mode))summary={mode:row.mode,running:Number(row.running)||0,waiting:Number(row.waiting)||0};}catch{}
    petSummaryFile=!!summary;
    taskStatus=summary||summarizeTasks(JSON.parse(fs.readFileSync(path.join(config.data,'state.json'),'utf8')));online=true;
  }catch{}
  return {...taskStatus,online,...petState.status()};
}
function clampPet(x,y){
  const area=screen.getDisplayNearestPoint({x:Math.round(x+PET_SIZE.width/2),y:Math.round(y+PET_SIZE.height/2)}).workArea;
  return {x:Math.round(Math.max(area.x,Math.min(x,area.x+area.width-PET_SIZE.width))),y:Math.round(Math.max(area.y,Math.min(y,area.y+area.height-PET_SIZE.height)))};
}
function showMain(){
  if(!window||window.isDestroyed()){createWindow();return;}
  petWindow?.hide();if(window.isMinimized())window.restore();window.show();window.focus();
}
function showPet(){
  if(quitting)return;
  if(petWindow&&!petWindow.isDestroyed()){petWindow.showInactive();return;}
  const area=screen.getPrimaryDisplay().workArea,saved=petState.data.position;
  const position=clampPet(saved?.x??area.x+area.width-PET_SIZE.width-24,saved?.y??area.y+area.height-PET_SIZE.height-32);
  petWindow=new BrowserWindow({...PET_SIZE,...position,show:false,title:config.productName+' 桌宠',frame:false,transparent:true,backgroundColor:'#00000000',resizable:false,minimizable:false,maximizable:false,fullscreenable:false,hasShadow:false,alwaysOnTop:true,skipTaskbar:true,
    webPreferences:{preload:path.join(__dirname,'pet-preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
  petWindow.setAlwaysOnTop(true,'floating');
  petWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  petWindow.webContents.on('context-menu',()=>{
    const remaining=petState.status().remainingMs;
    Menu.buildFromTemplate([
      {label:remaining>0?`再等 ${Math.ceil(remaining/1000)} 秒可喂食`:'喂一枚 token 硬币',enabled:remaining<=0,click:()=>{try{petWindow.webContents.send('pet:fed',{...petStatus(),...petState.feed()});}catch{petWindow.webContents.send('pet:fed',{accepted:false,error:true,...petStatus()});}}},
      {label:'打开 Boujoy',click:showMain}
    ]).popup({window:petWindow});
  });
  petWindow.webContents.on('will-navigate',event=>event.preventDefault());
  petWindow.webContents.on('will-redirect',event=>event.preventDefault());
  petWindow.webContents.on('will-attach-webview',event=>event.preventDefault());
  petWindow.once('ready-to-show',()=>{if(!quitting&&(!window?.isVisible()||window?.isMinimized()))petWindow.showInactive();});
  petWindow.on('closed',()=>{petWindow=null;dragState=null;});
  void petWindow.loadFile(PET_FILE);
}
function setupPet(){
  petState=new PetState(path.join(app.getPath('userData'),'pet-state.json'));
  const allowed=event=>petWindow&&!petWindow.isDestroyed()&&event.sender===petWindow.webContents&&event.senderFrame===petWindow.webContents.mainFrame&&event.senderFrame.url===pathToFileURL(PET_FILE).href;
  function handle(name,fn){ipcMain.handle(name,(event,...args)=>{if(!allowed(event))throw Error('Pet window required');return fn(...args);});}
  handle('pet:status',petStatus);
  handle('pet:feed',()=>({...petStatus(),...petState.feed()}));
  handle('pet:open',()=>{showMain();return true;});
  // The pet's eyes follow the cursor anywhere on screen; only the point and the pet's own bounds leave main.
  handle('pet:cursor',()=>{const c=screen.getCursorScreenPoint(),b=petWindow.getBounds();return {x:c.x,y:c.y,bx:b.x,by:b.y,bw:b.width,bh:b.height};});
  handle('pet:drag-start',()=>{dragState={cursor:screen.getCursorScreenPoint(),bounds:petWindow.getBounds(),moved:false};return true;});
  handle('pet:drag-move',()=>{
    if(!dragState)return false;const cursor=screen.getCursorScreenPoint(),dx=cursor.x-dragState.cursor.x,dy=cursor.y-dragState.cursor.y;
    if(Math.hypot(dx,dy)>4)dragState.moved=true;
    if(dragState.moved){const p=clampPet(dragState.bounds.x+dx,dragState.bounds.y+dy);petWindow.setPosition(p.x,p.y);}return dragState.moved;
  });
  handle('pet:drag-end',()=>{const moved=!!dragState?.moved;dragState=null;if(moved){const p=petWindow.getBounds();petState.position(p.x,p.y);}return {moved};});
  // Push atomic task-state updates so even short replies do not fall between polls.
  petWatcher=fs.watch(config.data,(_event,file)=>{
    if(String(file)!==(petSummaryFile?'pet-status.json':'state.json')||petUpdateTimer)return;
    petUpdateTimer=setTimeout(()=>{petUpdateTimer=null;if(petWindow&&!petWindow.isDestroyed())petWindow.webContents.send('pet:status-updated',petStatus());},40);
  });
  petWatcher.on('error',()=>{}); // The pet also polls as a recovery path.
  screen.on('display-removed',()=>{if(petWindow){const p=petWindow.getBounds(),next=clampPet(p.x,p.y);petWindow.setPosition(next.x,next.y);}});
}
function createWindow(){
  window=new BrowserWindow({width:1240,height:850,minWidth:780,minHeight:600,show:false,title:config.productName,backgroundColor:'#ffffff',
    titleBarStyle:'hidden',...(process.platform==='darwin'?{trafficLightPosition:{x:18,y:28}}:{titleBarOverlay:{color:'#ffffff',symbolColor:'#666666',height:52}}),
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
  window.webContents.setWindowOpenHandler(({url})=>{openExternal(url);return {action:'deny'};});
  window.webContents.on('will-navigate',(event,url)=>{if(!local(url)){event.preventDefault();openExternal(url);}});
  window.webContents.on('will-redirect',(event,url)=>{if(!local(url))event.preventDefault();});
  window.webContents.on('will-attach-webview',event=>event.preventDefault());
  window.once('ready-to-show',()=>{petWindow?.hide();window.show();});
  window.on('show',()=>petWindow?.hide());
  window.on('restore',()=>petWindow?.hide());
  window.on('minimize',showPet);
  window.on('close',event=>{if(!quitting){event.preventDefault();window.hide();showPet();}});
  window.on('closed',()=>window=null);
  void window.loadURL(ORIGIN+'/#role/concierge');
}
if(!app.requestSingleInstanceLock())app.quit();
else{
  app.on('second-instance',()=>{if(app.isReady())showMain();});
  app.on('before-quit',()=>{quitting=true;petWatcher?.close();clearTimeout(petUpdateTimer);});
  app.whenReady().then(async()=>{
    screen=require('electron').screen;
    if(app.dock)app.dock.setIcon(path.join(config.root,'web/assets/robot-head-base.png'));
    app.setAboutPanelOptions({applicationName:config.productName,applicationVersion:app.getVersion()});
    session.defaultSession.setPermissionRequestHandler((contents,permission,callback,details)=>{
      const allowed=()=>allowedAudio({contents,mainContents:window?.webContents,permission,details,request:true,expectedOrigin:ORIGIN});
      if(!allowed())return callback(false);
      if(process.platform!=='darwin')return callback(true);
      systemPreferences.askForMediaAccess('microphone').then(granted=>callback(granted&&allowed()),()=>callback(false));
    });
    session.defaultSession.setPermissionCheckHandler((contents,permission,origin,details)=>allowedAudio({contents,mainContents:window?.webContents,permission,origin,details,expectedOrigin:ORIGIN}));
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {label:config.productName,submenu:[{role:'about'},{label:'打开主窗口',click:showMain},{label:'显示桌宠',click:()=>{window?.hide();showPet();}},{type:'separator'},{role:'hide'},{role:'hideOthers'},{role:'unhide'},{type:'separator'},{role:'quit'}]},
      {label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
      {label:'显示',submenu:[{role:'reload'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{type:'separator'},{role:'togglefullscreen'}]},
      {label:'窗口',submenu:[{role:'minimize'},{role:'zoom'},{role:'front'}]}
    ]));
    await ensureService();setupPet();createWindow();
    app.on('activate',()=>{if(!petWindow?.isVisible())showMain();});
  }).catch(error=>{require('electron').dialog.showErrorBox(config.productName,error.message);app.quit();});
  app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
}
