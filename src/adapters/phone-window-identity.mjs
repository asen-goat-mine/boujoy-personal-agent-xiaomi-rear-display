// Accessibility may still return a tree for the previous app beneath a system
// dialog. The IME can own focus while editing that app, and small system bars
// can be drawn above it. Neither alone contradicts the application's identity.
export function nativeWindowConflict(native) {
  if (!Number.isSafeInteger(native?.windowId) || !Array.isArray(native.windows)) return false;
  const displayId = native.display?.id ?? 0;
  const windows = native.windows.filter(window => window?.display_id === displayId);
  const target = windows.find(window => window.window_id === native.windowId);
  if (!target) return false;
  const rect = bounds => Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isFinite) &&
    bounds[2] > bounds[0] && bounds[3] > bounds[1];
  return windows.some(window => {
    if (window.window_id === target.window_id || window.type === 2 || window.active !== true || window.focused !== true) return false;
    const lostFocus = target.focused === false && target.active === false;
    if (window.type === 1 && lostFocus) return true;
    if (!lostFocus && !(window.layer > target.layer)) return false;
    if (!rect(target.bounds) || !rect(window.bounds)) return false;
    const [left, top, right, bottom] = target.bounds;
    const [x1, y1, x2, y2] = window.bounds;
    const centerX = (left + right) / 2, centerY = (top + bottom) / 2;
    return x1 <= centerX && centerX <= x2 && y1 <= centerY && centerY <= y2;
  });
}
