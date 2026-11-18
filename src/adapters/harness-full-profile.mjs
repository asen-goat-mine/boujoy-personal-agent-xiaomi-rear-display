import path from 'node:path';
export function fullHarnessPatches({root,home,sessionId,personal,systemPrompt,sessionRoot=path.join(home,'full-sessions')}){
 const legacy=personal.find(p=>p.id==='llm-deepseek');const model={...legacy,config:{...legacy.config}};delete model.config.maxTokens;const bridge=personal.find(p=>p.insert)?.insert.find(p=>p.id==='personal-tools');
 return [model,
  {id:'system-prompt',config:{personaPrefix:systemPrompt}},
  {id:'session-persistence-jsonl',config:{root:sessionRoot,compression:'none'}},
  {id:'session-log-deepseek',disabled:true},
  {id:'tool-subagent',config:{provider:'spawn',toolName:'subagent',maxDepth:'provider-managed'}},
  {id:'tool-subagent-fork',config:{provider:'fork',toolName:'subagent_fork',maxDepth:'provider-managed'}},
  {insert:[bridge,{id:'boujoy-child-tools',name:path.join(root,'src/adapters/harness-child-tools.mjs'),config:{rootSessionId:sessionId,nativeGuidance:true}},{id:'boujoy-native-approval',name:path.join(root,'src/adapters/harness-native-approval.mjs')}]}
 ];
}
