// Roster addressing is not a business object. Keep the authenticated message
// intact; this view is only for parsers that otherwise mistake role quotes for
// a message body, product name or screenshot filename.
function roleMentionView(value){
 const text=String(value??'');let output='',index=0,fence=null;const quotes=[],names=[];
 const pairs={'“':'”','「':'」','『':'』','‘':'’','"':'"',"'":"'"};
 while(index<text.length){
  if(index===0||text[index-1]==='\n'){
   const end=text.indexOf('\n',index),line=text.slice(index,end===-1?text.length:end+1),mark=line.match(/^\s*(`{3,}|~{3,})/);
   if(fence){output+=line;index+=line.length;if(mark&&mark[1][0]===fence[0]&&mark[1].length>=fence.length)fence=null;continue;}
   if(!quotes.length&&(mark||/^\s*>/.test(line))){if(mark)fence=mark[1];output+=line;index+=line.length;continue;}
  }
  const char=text[index];
  if(quotes.length){
   output+=char;
   if(char==='\\'&&index+1<text.length){output+=text[++index];}
   else if(char===quotes.at(-1))quotes.pop();
   else if(pairs[char])quotes.push(pairs[char]);
   index++;continue;
  }
  if(char==='`'){
   const ticks=text.slice(index).match(/^`+/)[0],end=text.indexOf(ticks,index+ticks.length);
   const stop=end===-1?text.length:end+ticks.length;output+=text.slice(index,stop);index=stop;continue;
  }
  if(char==='@'&&(index===0||/[\s，。；、:：(（]/.test(text[index-1]))){
   const rest=text.slice(index+1),quoted=rest.match(/^「([^」\n]{1,80})」/);
   const plain=rest.match(/^([^\s@，。；、:：!?！？()（）\[\]【】“”「」『』"'`<>]{1,80})(?=$|[\s@，。；、:：!?！？()（）])/);
   const mention=quoted||plain;
   if(mention){names.push(mention[1]);output+=' ';index+=mention[0].length+1;continue;}
  }
  if(pairs[char])quotes.push(pairs[char]);output+=char;index++;
 }
 return {text:output,names};
}
export function stripTopLevelRoleMentions(value){return roleMentionView(value).text;}
export function topLevelRoleMentionNames(value){return [...new Set(roleMentionView(value).names)];}

// Exact names win. A unique abbreviated name is convenient for native @ input;
// multiple matches remain ambiguous and must be selected by ID in the UI.
export function matchingMentionRoles(roles,name){
 const key=value=>String(value||'').normalize('NFKC').trim().toLocaleLowerCase();
 const query=key(name),exact=roles.filter(role=>key(role.name)===query);
 return exact.length?exact:query?roles.filter(role=>key(role.name).startsWith(query)):[];
}
