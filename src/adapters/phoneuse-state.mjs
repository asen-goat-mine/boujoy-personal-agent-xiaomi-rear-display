import {AppError} from '../core/errors.mjs';

const PACKAGE=/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const PATH=/^0(?:\.(?:0|[1-9]\d*)){0,40}$/;
const STATES=['enabled','visible','editable','password','focused','checkable','checked','selected','content_invalid'];
const TEXT_FIELDS=['text','description','hint','label','error','state_description'];
const OBJECT=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function invalid(message,code='phoneuse_invalid_observation'){throw new AppError(code,message,409);}
function check(condition,message,code){if(!condition)invalid(message,code);}
function identifier(value){return typeof value==='string'&&value.length>0&&value.length<=255&&!/[\s\u0000-\u001f\u007f]/.test(value);}
function coordinates(value){return Array.isArray(value)&&value.length===4&&value.every(n=>Number.isSafeInteger(n)&&Math.abs(n)<=2147483647);}
function bounds(value){return coordinates(value)&&value[2]>=value[0]&&value[3]>=value[1];}
function time(value){return Number.isSafeInteger(value)&&value>0;}
function parseRaw(raw){
 check(OBJECT(raw),'Phone Use 没有返回有效观察');
 if(!Array.isArray(raw.content))return {value:raw,images:[]};
 check(raw.isError!==true,'Phone Use 观察包含失败或不完整结果','phoneuse_incomplete_observation');
 const texts=raw.content.filter(block=>block?.type==='text');
 check(texts.length===1,'Phone Use 观察正文不唯一');
 let value;try{value=JSON.parse(texts[0].text);}catch{invalid('Phone Use 观察正文格式无效');}
 check(OBJECT(value),'Phone Use 观察正文格式无效');
 return {value,images:raw.content.filter(block=>block?.type==='image')};
}
function availableChannel(channel,name,required){
 if(!OBJECT(channel)||channel.available!==true){
  check(!required,`Phone Use ${name}不可用`,'phoneuse_incomplete_observation');return null;
 }
 check(time(channel.started_at_ms)&&time(channel.finished_at_ms)&&channel.finished_at_ms>=channel.started_at_ms,`Phone Use ${name}缺少有效采集时间`);
 return channel;
}
function clone(value){return JSON.parse(JSON.stringify(value));}
function normalizeElements(tree,{partialOk=false}={}){
 check(tree.output==='legacy'&&tree.compact===false&&tree.scope_clipped===false,'Phone Use 需要完整 legacy 原生树','phoneuse_incomplete_observation');
 check((tree.collection_complete===true||partialOk)&&tree.collection_truncated===false&&tree.truncated===false,'Phone Use 原生树采集不完整','phoneuse_incomplete_observation');
 check(Array.isArray(tree.elements)&&tree.elements.length>0&&tree.elements.length<=1500,'Phone Use 原生树节点无效');
 check(tree.output_nodes===tree.elements.length&&tree.collected_nodes===tree.elements.length&&tree.merged_nodes===0,'Phone Use 原生树节点被省略','phoneuse_incomplete_observation');
 const elements=[],ids=new Set();
 for(const source of tree.elements){
  check(OBJECT(source)&&typeof source.element_id==='string'&&PATH.test(source.element_id)&&!ids.has(source.element_id),'Phone Use 原生节点编号无效');
  // Samsung can export inverted clipped rectangles for explicitly invisible
  // list children. Preserve these as offscreen evidence, never action targets.
  // An inverted rectangle is how Android reports a child clipped out of view
  // (seen on Samsung lists and on video feeds in a background display). Such a
  // node is kept as offscreen evidence and never becomes an action target; one
  // clipped child must not throw away the whole page.
  const clipped=!bounds(source.bounds);
  check(!clipped||source.element_id!=='0'&&coordinates(source.bounds),'Phone Use 原生节点坐标无效');
  check(source.class===null||typeof source.class==='string'&&source.class.length>0&&source.class.length<=255&&/^[A-Za-z_$][A-Za-z0-9_.$]*$/.test(source.class),'Phone Use 缺少真实原生控件类型');
  check(Array.isArray(source.actions)&&source.actions.every(action=>typeof action==='string'&&/^(?:tap|long_press|set_text|scroll_forward|scroll_backward|\d+)$/.test(action)),'Phone Use 原生节点动作无效');
  check(STATES.every(key=>typeof source[key]==='boolean'),'Phone Use legacy 原生节点状态不完整','phoneuse_incomplete_observation');
  check(source.parent_id===null||typeof source.parent_id==='string'&&PATH.test(source.parent_id),'Phone Use 原生节点父级无效');
  for(const field of TEXT_FIELDS)check(source[field]===undefined||source[field]===null||typeof source[field]==='string',`Phone Use ${field}字段无效`);
  const node=clone(source);
  if(clipped)node.visible=false;
  // Android already omits password text. Also remove other label channels so a
  // provider's description/hint cannot put password contents into the old tree.
  if(node.password)for(const field of TEXT_FIELDS)if(Object.hasOwn(node,field))node[field]=null;
  elements.push(node);ids.add(node.element_id);
 }
 check(ids.has('0'),'Phone Use 缺少原生根节点','phoneuse_incomplete_observation');
 for(const node of elements){
  const expected=node.element_id==='0'?null:node.element_id.slice(0,node.element_id.lastIndexOf('.'));
  check(node.parent_id===expected&&(expected===null||ids.has(expected)),'Phone Use 原生节点层级不完整','phoneuse_incomplete_observation');
 }
 const passwordRoots=elements.filter(node=>node.password).map(node=>node.element_id);
 for(const node of elements)if(passwordRoots.some(id=>node.element_id.startsWith(id+'.')))for(const field of TEXT_FIELDS)if(Object.hasOwn(node,field))node[field]=null;
 return elements;
}
function quoted(value){
 // Existing Pony consumers use a quoted-label grammar rather than a JSON string
 // parser. Unicode escapes keep quotes/control characters inside that grammar.
 return '"'+value.replace(/[\\"\u0000-\u001f\u007f\u2028\u2029]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'))+'"';
}
function renderTree(value,elements,physical){
 const diagnostics=Array.isArray(value.windows)?value.windows:[];
 const active=diagnostics.find(window=>window?.window_id===value.window_id&&window.display_id===value.display.id);
 if(active)check(bounds(active.bounds),'Phone Use 当前窗口坐标无效');
 const root=elements.find(node=>node.element_id==='0'),windowBounds=active?.bounds||root.bounds;
 const windowBoundsSource=active?'window_diagnostics':'root_element';
 const layer=active&&Number.isSafeInteger(active.layer)?` layer=${active.layer}`:'';
 const out=[`window pkg=${value.package_name} id=${value.window_id}${layer} bounds=${windowBounds.join(',')}`];
 const children=new Map();for(const node of elements){const key=node.parent_id;if(!children.has(key))children.set(key,[]);children.get(key).push(node);}
 const visit=(node,depth)=>{
  const tags=[],actions=new Set(node.actions);
  if(actions.has('tap'))tags.push('clickable');
  if(actions.has('long_press'))tags.push('long_clickable');
  if(node.editable)tags.push('editable');
  if(node.focused)tags.push('focused');
  if(node.selected)tags.push('selected');
  if(node.password)tags.push('password');
  if(node.checkable||node.checked)tags.push(node.checked?'checked':'unchecked');
  if(actions.has('scroll_forward')||actions.has('scroll_backward'))tags.push('scrollable');
  if(!node.enabled)tags.push('disabled');
  const b=node.bounds;if(!node.visible||b[2]<=b[0]||b[3]<=b[1]||b[2]<=0||b[3]<=0||b[0]>=physical.width||b[1]>=physical.height)tags.push('offscreen');
  const labels=node.password?'[password]':[...new Set(['text','description','hint'].map(field=>node[field]).filter(label=>typeof label==='string'&&label.trim()))].map(quoted).join(' ');
  const type=node.class===null?'[unknown]':node.class.split('.').at(-1);
  out.push('  '.repeat(depth)+type+(labels?` ${labels}`:'')+(tags.length?` ${tags.join(' ')}`:'')+` bounds=${b.join(',')}`);
  for(const child of children.get(node.element_id)||[])visit(child,depth+1);
 };
 visit(root,0);return {text:out.join('\n'),windowBoundsSource};
}
function imageMapping(value,screenshot,images){
 const physical=value.display;
 if(!screenshot)return {image:null,mapping:{physicalWidth:physical.width,physicalHeight:physical.height,imageWidth:null,imageHeight:null,scaleX:null,scaleY:null,offsetX:null,offsetY:null}};
 check(Number.isSafeInteger(screenshot.width)&&Number.isSafeInteger(screenshot.height)&&screenshot.width>0&&screenshot.height>0&&Math.max(screenshot.width,screenshot.height)<=2048,'Phone Use 截图尺寸无效');
 const sx=screenshot.scale_x,sy=screenshot.scale_y,ox=screenshot.offset_x,oy=screenshot.offset_y;
 check([sx,sy,ox,oy].every(Number.isFinite)&&sx>=1&&sy>=1&&ox===0&&oy===0&&Math.abs(screenshot.width*sx-physical.width)<1e-6&&Math.abs(screenshot.height*sy-physical.height)<1e-6,'Phone Use 截图与物理显示坐标不一致','phoneuse_invalid_mapping');
 check(screenshot.mime_type==='image/jpeg','Phone Use 截图类型无效');
 check(images.length<=1,'Phone Use 当前截图不唯一','phoneuse_incomplete_observation');
 const supplied=images[0],data=supplied?.data??screenshot.data_base64;
 if(supplied)check(supplied.mimeType===screenshot.mime_type&&(!screenshot.data_base64||screenshot.data_base64===data),'Phone Use 图片与观察不匹配');
 check(typeof data==='string'&&data.length>0&&data.length<=24*1024*1024&&data.length%4===0&&/^[A-Za-z0-9+/]+={0,2}$/.test(data),'Phone Use 截图数据不可用','phoneuse_incomplete_observation');
 return {image:{content:[{type:'image',mimeType:screenshot.mime_type,data}]},mapping:{physicalWidth:physical.width,physicalHeight:physical.height,imageWidth:screenshot.width,imageHeight:screenshot.height,scaleX:sx,scaleY:sy,offsetX:ox,offsetY:oy}};
}

// displaySession: only for the background-display backend. The observation must
// come from exactly that session, generation and display; Phone Use stays display 0.
export function normalizePhoneUseObservation(rawMcpResult,{requireTree=true,requireScreenshot=true,now=Date.now(),displaySession=null}={}){
 check(typeof requireTree==='boolean'&&typeof requireScreenshot==='boolean'&&Number.isFinite(now),'Phone Use 观察选项无效');
 const {value,images}=parseRaw(rawMcpResult);
 check(!value.error&&value.observation_status==='complete'&&!value.last_observation&&!value.observation&&!value.recovery_observation&&!value.request,'Phone Use 没有返回本次完整观察','phoneuse_incomplete_observation');
 check(!value.stale&&!value.degraded&&!value.tree?.stale&&!value.tree?.degraded&&!value.screenshot?.stale&&!value.screenshot?.degraded,'Phone Use 返回过期或降级观察','phoneuse_stale_observation');
 check(!value.condition||value.condition.status==='satisfied'&&value.condition.timed_out===false,'Phone Use 观察条件尚未满足','phoneuse_incomplete_observation');
 check(identifier(value.device_id)&&identifier(value.service_instance_id)&&identifier(value.observation_id)&&value.observation_id.startsWith(value.service_instance_id+':'),'Phone Use 缺少有效手机或服务观察身份');
 check(time(value.captured_at_ms)&&now-value.captured_at_ms>=-5000&&now-value.captured_at_ms<=30000,'Phone Use 观察已过期','phoneuse_stale_observation');
 check(typeof value.package_name==='string'&&PACKAGE.test(value.package_name)&&Number.isSafeInteger(value.window_id)&&value.window_id>=0&&Number.isSafeInteger(value.ui_version)&&value.ui_version>=0,'Phone Use 缺少当前应用窗口身份');
 const display=value.display;
 const expectedDisplay=displaySession?displaySession.displayId:0;
 check(!displaySession||OBJECT(value.display_session)&&value.display_session.sessionId===displaySession.sessionId&&value.display_session.generation===displaySession.generation&&value.display_session.displayId===displaySession.displayId,'后台显示会话已变化','display_session_stale');
 check(displaySession||value.display_session===undefined,'Phone Use 返回了未协商的显示会话');
 check(OBJECT(display)&&display.id===expectedDisplay&&Number.isSafeInteger(display.width)&&Number.isSafeInteger(display.height)&&display.width>0&&display.height>0&&display.width<=10000&&display.height<=10000&&[0,90,180,270].includes(display.rotation)&&display.coordinates==='physical_pixels'&&display.origin==='top_left'&&display.includes_system_bars_and_ime===true,'Phone Use 显示坐标信息无效');
 const sourceTree=availableChannel(value.tree,'原生树',requireTree),screenshot=availableChannel(value.screenshot,'截图',requireScreenshot);
 for(const channel of [sourceTree,screenshot].filter(Boolean))check(channel.finished_at_ms<=value.captured_at_ms,'Phone Use 观察采集时间不一致');
 // Busy apps (feeds, carousels) mutate content while the tree is walked, so
 // Phone Use never reports collection_complete there. Accept such a tree only
 // when nothing was cut off and the window and package held for every capture.
 const captures=value.diagnostics?.captures;
 const partialOk=Array.isArray(captures)&&captures.length>0&&value.diagnostics.capture_diagnostics_truncated===false&&captures.every(c=>OBJECT(c)&&c.inconsistency_reason==null&&c.before_window_id===value.window_id&&c.after_window_id===value.window_id&&c.before_package_name===value.package_name&&c.after_package_name===value.package_name);
 const elements=sourceTree?normalizeElements(sourceTree,{partialOk}):[];
 const treePartial=!!sourceTree&&sourceTree.collection_complete!==true;
 const rendered=sourceTree?renderTree(value,elements,display):null;
 const {image,mapping}=imageMapping(value,screenshot,images);
 // Local legacy guards retain their logical view label. The model boundary uses
 // this validated physical display/session metadata to report background execution.
 const tree=rendered?{content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',...(displaySession?{backend:'display',displayId:display.id,displaySession:{sessionId:displaySession.sessionId,generation:displaySession.generation,displayId:displaySession.displayId}}:{}),foreground:value.package_name,windowPkg:value.package_name,window:value.window_id,tree:rendered.text}})}]}:null;
 const result={tree,image,mapping,at:value.captured_at_ms};
 const native={observationId:value.observation_id,deviceId:value.device_id,serviceInstanceId:value.service_instance_id,windowId:value.window_id,packageName:value.package_name,uiVersion:value.ui_version,elements,display:clone(display),at:value.captured_at_ms,windows:Array.isArray(value.windows)?clone(value.windows):[],windowBoundsSource:rendered?.windowBoundsSource||null,treePartial,...(displaySession?{displaySession:{sessionId:displaySession.sessionId,generation:displaySession.generation,displayId:displaySession.displayId}}:{})};
 Object.defineProperty(result,'native',{value:native,enumerable:false});return result;
}

export function mapPhoneUseOcr(ocr,mapping){
 if(ocr===null||ocr===undefined)return null;
 check(OBJECT(ocr)&&OBJECT(mapping)&&Array.isArray(ocr.lines),'Phone Use OCR 结果无效','phoneuse_invalid_mapping');
 const {physicalWidth,physicalHeight,imageWidth,imageHeight,scaleX,scaleY,offsetX,offsetY}=mapping;
 check([physicalWidth,physicalHeight,scaleX,scaleY,offsetX,offsetY].every(Number.isFinite)&&physicalWidth>0&&physicalHeight>0&&scaleX>0&&scaleY>0,'Phone Use OCR 缺少坐标映射','phoneuse_invalid_mapping');
 check(Number.isFinite(ocr.width)&&Number.isFinite(ocr.height)&&ocr.width>0&&ocr.height>0&&(!Number.isFinite(imageWidth)||ocr.width===imageWidth)&&(!Number.isFinite(imageHeight)||ocr.height===imageHeight),'Phone Use OCR 与原始截图尺寸不匹配','phoneuse_invalid_mapping');
 const x=value=>value*scaleX+offsetX,y=value=>value*scaleY+offsetY;
 const lines=ocr.lines.map(line=>{
  check(OBJECT(line)&&typeof line.text==='string'&&Array.isArray(line.bounds)&&line.bounds.length===4&&line.bounds.every(Number.isFinite)&&line.bounds[2]>line.bounds[0]&&line.bounds[3]>line.bounds[1]&&Number.isFinite(line.center?.x)&&Number.isFinite(line.center?.y),'Phone Use OCR 目标坐标无效','phoneuse_invalid_mapping');
  const mapped=[x(line.bounds[0]),y(line.bounds[1]),x(line.bounds[2]),y(line.bounds[3])],center={x:x(line.center.x),y:y(line.center.y)};
  check(mapped[0]>=0&&mapped[1]>=0&&mapped[2]<=physicalWidth+1e-6&&mapped[3]<=physicalHeight+1e-6&&center.x>=0&&center.x<=physicalWidth&&center.y>=0&&center.y<=physicalHeight,'Phone Use OCR 目标超出物理显示范围','phoneuse_invalid_mapping');
  return {...line,bounds:mapped,center};
 });
 return {...ocr,width:physicalWidth,height:physicalHeight,lines};
}
