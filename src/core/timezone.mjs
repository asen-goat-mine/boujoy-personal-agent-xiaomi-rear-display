// Times follow the Mac's own time zone unless the user picks one explicitly.
// The old default hard-coded Asia/Shanghai, so "明天" and every timestamp were
// wrong whenever the Mac (and the user) were elsewhere.
export function systemTimezone(){
  try{const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;if(validTimezone(zone))return zone;}catch{}
  return 'UTC';
}
export function validTimezone(zone){
  if(typeof zone!=='string'||!zone||zone.length>64)return false;
  try{new Intl.DateTimeFormat('en-US',{timeZone:zone});return true;}catch{return false;}
}
export const LEGACY_DEFAULT_TIMEZONE='Asia/Shanghai';
export function effectiveTimezone(settings={}){
  if(settings?.timezoneManual===false)return systemTimezone();
  const chosen=settings?.timezoneManual===true||settings?.timezone&&settings.timezone!==LEGACY_DEFAULT_TIMEZONE;
  return chosen&&validTimezone(settings.timezone)?settings.timezone:systemTimezone();
}
