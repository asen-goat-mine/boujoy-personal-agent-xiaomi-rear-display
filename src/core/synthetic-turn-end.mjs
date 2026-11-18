export function syntheticTurnEnd(res,stream){
  const message={id:'msg_boujoy_turn_end',type:'message',role:'assistant',model:'deepseek-flash',content:[{type:'text',text:'已完成。'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:0,output_tokens:0}};
  if(!stream){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(message));return;}
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});
  const send=(event,data)=>res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start',{type:'message_start',message:{...message,content:[],stop_reason:null}});
  send('content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}});
  send('content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'已完成。'}});
  send('content_block_stop',{type:'content_block_stop',index:0});
  send('message_delta',{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:0}});
  send('message_stop',{type:'message_stop'});res.end();
}
