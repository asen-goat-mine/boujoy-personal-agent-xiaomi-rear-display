// Derive authority from affirmative instructions, retaining literal quoted data.
// Mask quotes with equal-length spaces so a quoted comma/negative never changes
// the boundaries of an actual instruction. All structured effect parsers must
// see this same view; stripping negatives only during classification let a later
// schedule/file parser silently add the denied effect back.
// A source must actually be attributed a statement in the same clause. A later
// request to explain whether a webpage was readable is still the user's request.
export function attributedInstruction(value){
  const text=String(value||'').replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"|`[^`]*`/g,'[正文]');
  return /(?:网页|页面|广告|商家|模型|助理|知识库)[^，,。；;!！?？\n]{0,12}(?:[，,：:]\s*)?(?:说(?!明)|说明(?=[，,：:请应须])|表示|显示|要求|建议|指示)/.test(text);
}

export function affirmativeInstructions(value){
  const text=String(value||''),masked=text.replace(/“[^”]*”|「[^」]*」|"[^"]*"|`[^`]*`/g,part=>' '.repeat(part.length));
  const negatives=/(?:不要|不用|不必|无需|禁止|不允许|不得|不能|(?:别|不)(?=(?:再|帮我|替我|自动|直接)?(?:在|用|把|将|给|复用|恢复|重用|重做|重试|操作|访问|读取|读|保存|创建|新建|添加|安排|取消|移除|支付|付款|下单|提交|发送|发给|发|回复|发布|删除|清空|修改|更改|重命名|移动|整理|拨打|打电话|呼叫|购买|买|加购|开通|订阅|开启|打开|关闭|设置|设|调|拍照|拍|导航)))[^，,。；;!！?？\n]*?(?=[，,。；;!！?？\n]|而是|但是|但请|$)/g;
  let result='',last=0;
  for(const match of masked.matchAll(negatives)){result+=text.slice(last,match.index);last=match.index+match[0].length;}
  return result+text.slice(last);
}
