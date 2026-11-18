// Computer work vs phone work, from the user's own words. A quoted filename is
// an object to read, not a device instruction (e.g. 『Boujoy 手机端设计稿.html』).
export const isFileLiteral=value=>/\.(?:html?|pdf|docx?|xlsx?|pptx?|csv|tsv|txt|md|json|png|jpe?g|webp|mp3|wav|mp4)$/i.test(String(value||''));
export function isDesktopWork(text){
  const value=String(text||'').replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'|`[^`]*`/g,quoted=>/\.(?:html?|pdf|docx?|xlsx?|pptx?|csv|txt|md)[”」』"'`]$/i.test(quoted)?'[本机文档]':quoted);
  return /电脑|mac|浏览器|网页|网站|官网|https?:\/\/|文件夹|文稿|桌面|下载|documents|downloads|desktop|本机|代码|脚本|excel|word|ppt|表格|文档|pdf|csv/i.test(value)&&!/手机/.test(value);
}
export function isDesktopDocumentWork(text){
  return isDesktopWork(text)&&/\b(?:word|excel|ppt|pdf)\b|文档|表格|文件名|存成|存为|保存(?:为|成)|\.(?:html?|pdf|docx?|xlsx?|pptx?|csv|tsv|txt|md)\b/i.test(String(text||''));
}
