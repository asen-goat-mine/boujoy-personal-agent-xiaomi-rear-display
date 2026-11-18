/** Explicit display projection for the authenticated owner's approval detail. Never copy arbitrary args. */
export function approvalView(approval){
 const {id,taskId,tool,summary,fingerprint,expiresAt,status}=approval;
 const fields=tool==='harness_native'?[['nativeTool','执行工具'],['command','完整命令'],['path','目标路径'],['file_path','目标路径'],['content','写入内容'],['old_string','原内容'],['new_string','新内容'],['url','目标地址']]:tool==='agent_run'?[['agent','执行助理'],['folder','工作目录'],['write','允许写入'],['prompt','完整任务指令']]:[['action','操作'],['path','目标路径'],['packageName','应用'],['text','操作内容'],['url','目标地址']];
 const details=fields.flatMap(([key,label])=>{const value=approval.args?.[key];return typeof value==='string'||typeof value==='boolean'||typeof value==='number'?[{label,value:String(value)}]:[];});
 return {id,taskId,tool,summary,fingerprint,expiresAt,status,details};
}
