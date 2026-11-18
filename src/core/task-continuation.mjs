// Only content-free resumes and bounded choice delegation retain the prior task.
// New objects, applications, transactions or payment instructions are new input.
export function isTaskContinuation(value){
 const text=String(value||'').replace(/[，,。.!！\s]/g,'');
 return /^(?:(?:换成|改成|改为|换一家|不要这家|可以加购|允许凑单|可以凑单|不凑单|不要了|算了(?:不要了)?|取消)(?:.{0,120}))$/.test(text)|| /^(?:继续(?:吧|执行|刚才的任务)?|接着(?:做|执行)?|好的?|可以(?:了|继续)?|嗯+|ok|收到)$/i.test(text)||
 /^(?:你)?(?:随便选(?:一)?个|随便挑(?:一)?个|帮我选(?:一)?个|你来选|你来决定|按你说的来)(?:就行|都行|即可|吧)?(?:继续(?:吧|执行)?|接着(?:做|执行)?)?$/.test(text);
}
