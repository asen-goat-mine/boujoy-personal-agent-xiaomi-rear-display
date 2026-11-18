export class AppError extends Error {
  constructor(code, message, status=400) { super(message); this.code=code; this.status=status; }
}
export function requireValue(value, message, code='invalid_input') { if (!value) throw new AppError(code,message); }
// A message the user types or pastes may be long (articles, meeting notes, logs).
export const USER_MESSAGE_MAX=60000;
export function shortText(value, field='内容', max=8000) {
  requireValue(typeof value==='string' && value.trim() && value.length<=max,`${field}不能为空且不能超过 ${max} 字符`);
  return value.trim();
}
export const now = () => new Date().toISOString();
export function safeError(e) { return {code:e.code || 'internal_error',message:e instanceof AppError ? e.message : '操作未完成，请查看本机运行记录。'}; }
