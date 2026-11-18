ObjC.import('Foundation');
ObjC.import('Vision');
ObjC.import('AppKit');
// These labels describe ordinary navigation only. They are geometry targets,
// not proof of clickability or authorization; the full source row is retained.
const NAVIGATION_WORDS=['淘宝闪购外卖','淘宝闪购','闪购外卖','闪购','外卖','搜索栏','搜索框','搜索','返回','取消'];
const SENSITIVE_ROW=/(支付|付款|下单|提交|购买|抢购|加购|加入|结算|确认|订阅|开通|领取|删除|发送|预订|密码|验证码|安全验证|身份验证|登录|收货地址|授权|同意|客服|聊天)/;
function pixelBounds(box,width,height){
  return [Math.round(box.origin.x*width),Math.round((1-box.origin.y-box.size.height)*height),Math.round((box.origin.x+box.size.width)*width),Math.round((1-box.origin.y)*height)];
}
function run(argv){
  const data=$.NSData.dataWithContentsOfFile(argv[0]);
  const image=$.NSBitmapImageRep.imageRepWithData(data);
  const width=Number(image.pixelsWide),height=Number(image.pixelsHigh);
  const request=$.VNRecognizeTextRequest.alloc.init;
  request.recognitionLevel=$.VNRequestTextRecognitionLevelAccurate;
  request.recognitionLanguages=$(['zh-Hans','en-US']);
  request.usesLanguageCorrection=false;
  const handler=$.VNImageRequestHandler.alloc.initWithDataOptions(data,$({}));
  const error=Ref();
  if(!handler.performRequestsError($([request]),error))throw Error('Local recognition failed');
  const results=request.results,lines=[],words=[];
  for(let i=0;i<results.count;i++){
    const observation=results.objectAtIndex(i),candidate=observation.topCandidates(1).firstObject;
    const text=ObjC.unwrap(candidate.string),bounds=pixelBounds(observation.boundingBox,width,height);
    const sourceRow=lines.length;
    lines.push({text,confidence:Number(candidate.confidence),bounds});
    if(SENSITIVE_ROW.test(text))continue;
    for(const term of NAVIGATION_WORDS){
      // JavaScript offsets and NSRange both count UTF-16 code units.
      for(let from=0;from<text.length;){
        const at=text.indexOf(term,from);if(at<0)break;from=at+term.length;
        if(text===term)continue;
        try{
          const rectangle=candidate.boundingBoxForRangeError($.NSMakeRange(at,term.length),Ref());
          if(!rectangle)continue;
          const wordBounds=pixelBounds(rectangle.boundingBox,width,height);
          // Accurate Vision recognition has word precision. Some language/model
          // combinations return the whole row for a substring: never guess a split.
          if(wordBounds[2]-wordBounds[0]>=bounds[2]-bounds[0]-2)continue;
          if(wordBounds[0]<bounds[0]-2||wordBounds[1]<bounds[1]-2||wordBounds[2]>bounds[2]+2||wordBounds[3]>bounds[3]+2)continue;
          words.push({text:term,confidence:Number(candidate.confidence),bounds:wordBounds,sourceRow,range:{location:at,length:term.length},geometrySource:'vision_subrange'});
        }catch{}
      }
    }
  }
  return JSON.stringify({width,height,lines,words});
}

