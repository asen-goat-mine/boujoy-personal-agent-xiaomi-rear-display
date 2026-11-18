import test from 'node:test';
import assert from 'node:assert/strict';
import {compactPriorTree} from '../src/core/model-tree-delta.mjs';

const baseId = 'call-later_4';
const header = 'window pkg=com.example.reader id=9 bounds=0,0,1080,1920';
const common = Array.from({length: 16}, (_, i) => '  TextView "同名 🔒 ' + i + '" bounds=10,12,43,98');
const meta = {type: 'text', text: '{"observationId":"screen-original","untrustedContent":true,"textTargets":[{"id":"t1"}]}'};
const image = {type: 'image', source: {type: 'base64', media_type: 'image/png', data: 'AA=='}};
function page(lines, attrs = {}) {
  const result = {display: 'main', windowPkg: 'com.example.reader', foreground: 'com.example.reader', window: 9,
    tree: lines.join('\n'), omittedOffscreenNodes: 7, untrustedContent: true, ...attrs};
  return [meta, {type: 'text', text: JSON.stringify({ok: true, result, nativeCounter: 3})}, image];
}
const value = content => JSON.parse(content[1].text);
const bytes = content => Buffer.byteLength(JSON.stringify(content));
function reconstruct(delta, fullTree) {
  assert.equal(delta.baseToolUseId, baseId);
  const lines = fullTree.split('\n');
  const copy = range => range ? lines.slice(range[0] - 1, range[1]) : [];
  return [...copy(delta.prefixLines1BasedInclusive), ...delta.literalLines, ...copy(delta.suffixLines1BasedInclusive)].join('\n');
}

test('exactly restores old lines, labels, blank lines, and all surrounding evidence', () => {
  const before = page([header, ...common, '  Price "¥12.30"', '  Action "付款前停止"', '', ...common, '']);
  const later = page([header, ...common, '  Price "¥98.00"', ...common, '']);
  const untouchedBefore = structuredClone(before), untouchedLater = structuredClone(later);
  const {content, bytesSaved} = compactPriorTree(before, later, baseId);
  assert.ok(bytesSaved > 0);
  assert.equal(bytesSaved, bytes(before) - bytes(content));
  const old = value(content), newer = value(later);
  assert.deepEqual(old.result.tree.literalLines, ['  Price "¥12.30"', '  Action "付款前停止"', '']);
  old.result.tree = reconstruct(old.result.tree, newer.result.tree);
  assert.deepEqual(old, value(before));
  assert.equal(content[0], meta); assert.equal(content[2], image);
  assert.deepEqual(before, untouchedBefore); assert.deepEqual(later, untouchedLater);
  assert.equal(compactPriorTree(later, content, 'another').bytesSaved, 0, 'a delta cannot become a base');
});

test('reconstructs identical, shorter and extended trees without overlapping ranges', () => {
  const seed = [header, ...common];
  for (const [a, b] of [[seed, seed], [[...seed, ''], seed], [seed, [...seed, '', 'extra']], [[...seed, ...common], seed]]) {
    const before = page(a), later = page(b);
    const {content, bytesSaved} = compactPriorTree(before, later, baseId);
    assert.ok(bytesSaved > 0);
    assert.equal(reconstruct(value(content).result.tree, value(later).result.tree), value(before).result.tree);
  }
});

test('ambiguous or changed identity, sensitive screens, custom block metadata and no gain are passed through', () => {
  const rows = [header, ...common], valid = page(rows);
  const annotated = page(rows); annotated[1].cache_control = {type: 'ephemeral'};
  const ambiguous = [...valid, {type: 'text', text: ' ' + valid[1].text}];
  const noncanonical = page(rows); noncanonical[1].text = noncanonical[1].text.replace('{"ok"', '{ "ok"');
  for (const bad of [annotated, ambiguous, noncanonical, page(rows, {window:10}), page(rows, {window:'main'}),
    page(rows, {foreground:'com.example.reader/Other'}), page(rows, {windowPkg:'com.other.app'}), page(rows, {display:'background'}),
    page(rows, {displaySession:{sessionId:'other',generation:1,displayId:2}}), page([header, ...common, ' EditText password']),
    page([header, ...common, 'contains\rCR']), page(['window elsewhere', ...common]), [image]]) {
    assert.equal(compactPriorTree(valid, bad, baseId).content, valid);
    assert.equal(compactPriorTree(bad, valid, baseId).content, bad);
  }
  const tiny = page([header, 'x']);
  assert.deepEqual(compactPriorTree(tiny, page([header, 'y']), baseId), {content:tiny,bytesSaved:0});
  assert.equal(compactPriorTree(valid, valid, 'unsafe\nreference').content, valid);
});

test('edits only the native JSON line in the real newline-coalesced MCP wire shape', () => {
  const before = page([header, ...common, '  Price "¥22.50"', ...common]);
  const later = page([header, ...common, '  Price "¥75.25"', ...common]);
  const evidence = '{"finishEvidenceRefs":["screen-original"],"instruction":"use own receipt"}';
  const prefix = evidence + '\n' + meta.text + '\n\n';
  const suffix = '\n \n{"nativeReceipt":"old"}\n';
  const handle = {type:'text',text:'[IMAGE_HANDLE] synthetic screen projection'};
  const packed = c => [{type:'text',text:prefix + c[1].text + suffix},handle,image];
  const lhs = packed(before), rhs = packed(later);
  const {content,bytesSaved} = compactPriorTree(lhs,rhs,baseId);
  assert.ok(bytesSaved>0);assert.equal(bytesSaved,bytes(lhs)-bytes(content));
  assert.equal(content[1],handle);assert.equal(content[2],image);
  assert.ok(content[0].text.startsWith(prefix));assert.ok(content[0].text.endsWith(suffix));
  const row = JSON.parse(content[0].text.slice(prefix.length,-suffix.length));
  row.result.tree = reconstruct(row.result.tree,value(later).result.tree);
  assert.equal(prefix+JSON.stringify(row)+suffix,lhs[0].text);
  for (const tail of ['\n[... tool result middle pruned ...]\n','\n{"ok":true,"result":{"tree":','\n  '+before[1].text]) {
    const malformed = [{type:'text',text:lhs[0].text+tail},handle,image];
    assert.equal(compactPriorTree(malformed,rhs,baseId).content,malformed);
    assert.equal(compactPriorTree(rhs,malformed,baseId).content,rhs);
  }
});
