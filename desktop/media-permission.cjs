// Only the main local chat may request the microphone. Never camera or embeds.
function allowedAudio({contents,mainContents,permission,origin,details={},request=false,expectedOrigin}){
  const local=value=>{try{return typeof expectedOrigin==='string'&&new URL(value).origin===expectedOrigin;}catch{return false;}};
  return !!contents&&contents===mainContents&&!contents.isDestroyed()&&permission==='media'&&details.isMainFrame===true&&local(contents.getURL())&&local(details.requestingUrl)&&local(origin||details.securityOrigin||details.requestingUrl)&&(request?Array.isArray(details.mediaTypes)&&details.mediaTypes.length===1&&details.mediaTypes[0]==='audio':details.mediaType==='audio');
}
module.exports={allowedAudio};
