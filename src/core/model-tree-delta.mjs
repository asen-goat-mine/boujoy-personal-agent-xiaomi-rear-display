// Model-request copies only. The caller pairs adjacent verified observations and
// keeps the referenced tool result in full in this very request.
function nativeTree(content) {
  if (!Array.isArray(content)) return;
  let found;
  for (const [index, block] of content.entries()) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    if (block.text.includes('[... tool result middle pruned ...]')) return;
    // The pinned MCP client joins text-like blocks with LF. Native JSON escapes
    // newlines inside its strings, so an intact page occupies exactly one line.
    const fragments = block.text.split('\n');
    for (const [lineIndex, line] of fragments.entries()) {
      if (!line.trimStart().startsWith('{')) {
        if (/"tree"\s*:/.test(line)) return;
        continue;
      }
      let envelope;
      try { envelope = JSON.parse(line); } catch { return; }
      const page = envelope?.result;
      if (!page || !Object.hasOwn(page, 'tree')) continue;
      if (found || envelope.ok !== true || Object.keys(block).length !== 2 || typeof page.tree !== 'string') return;
      // Re-encoding must preserve every non-tree value, including numeric precision.
      try { if (JSON.stringify(envelope) !== line) return; } catch { return; }
      if (!['main', 'background'].includes(page.display) || !Number.isSafeInteger(page.window) || page.window < 0 ||
          typeof page.windowPkg !== 'string' || !/^[\w]+(?:\.[\w]+)+$/.test(page.windowPkg) ||
          typeof page.foreground !== 'string' || !(page.foreground === page.windowPkg || page.foreground.startsWith(page.windowPkg + '/'))) return;
      if (/[\r\u0000\u2028\u2029]/u.test(page.tree) || /\bpassword\b/i.test(page.tree)) return;
      const lines = page.tree.split('\n');
      const header = `window pkg=${page.windowPkg} id=${page.window}`;
      if (lines.length < 2 || !(lines[0] === header || lines[0].startsWith(header + ' '))) return;
      const identity = JSON.stringify([page.display, page.windowPkg, page.foreground, page.window, page.backend,
        page.displayId, page.displaySession]);
      found = {index, block, fragments, lineIndex, envelope, page, lines, identity};
    }
  }
  return found;
}

export function compactPriorTree(olderContent, newerContent, reference) {
  const unchanged = {content: olderContent, bytesSaved: 0};
  if (typeof reference !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(reference)) return unchanged;
  const older = nativeTree(olderContent), newer = nativeTree(newerContent);
  if (!older || !newer || older.identity !== newer.identity) return unchanged;
  const before = older.lines, base = newer.lines;
  let prefix = 0, suffix = 0;
  const limit = Math.min(before.length, base.length);
  while (prefix < limit && before[prefix] === base[prefix]) prefix++;
  while (suffix < limit - prefix && before.at(-suffix - 1) === base.at(-suffix - 1)) suffix++;
  if (!prefix && !suffix) return unchanged;

  const tree = {baseToolUseId: reference};
  if (prefix) tree.prefixLines1BasedInclusive = [1, prefix];
  tree.literalLines = before.slice(prefix, before.length - suffix);
  if (suffix) tree.suffixLines1BasedInclusive = [base.length - suffix + 1, base.length];
  const replacement = JSON.stringify({...older.envelope, result: {...older.page, tree}});
  // Only the page line changes inside a JSON-encoded wire string.
  const bytesSaved = Buffer.byteLength(JSON.stringify(older.fragments[older.lineIndex])) - Buffer.byteLength(JSON.stringify(replacement));
  if (bytesSaved <= 0) return unchanged;
  older.fragments[older.lineIndex] = replacement;
  const content = olderContent.slice();
  content[older.index] = {...older.block, text: older.fragments.join('\n')};
  return {content, bytesSaved};
}
