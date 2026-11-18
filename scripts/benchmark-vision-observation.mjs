import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {values} = parseArgs({options: {
  'baseline-root': {type: 'string'}, 'candidate-root': {type: 'string', default: scriptRoot},
  'rounds': {type: 'string', default: '4'}, 'output': {type: 'string'}
}});
assert.equal(process.platform, 'darwin', 'Requires the real macOS Vision backend');
assert.ok(values['baseline-root'], '--baseline-root is required; pass the original unmodified repo');
const rounds = Number(values.rounds);
assert.ok(Number.isSafeInteger(rounds) && rounds >= 4 && rounds <= 30 && rounds % 2 === 0, 'Use 4–30 even measured rounds');
const hash = value => createHash('sha256').update(value).digest('hex');
const implementations = {}, sources = {};
for (const [variant, directory] of Object.entries({baseline: values['baseline-root'], candidate: values['candidate-root']})) {
  const root = await fs.realpath(directory), modulePath = path.join(root, 'src/adapters/phone-ocr.mjs'), workerPath = path.join(root, 'scripts/phone-ocr.js');
  implementations[variant] = await import(pathToFileURL(modulePath).href);
  sources[variant] = {root, moduleSha256: hash(await fs.readFile(modulePath)), visionWorkerSha256: hash(await fs.readFile(workerPath))};
}
assert.notEqual(sources.baseline.root, sources.candidate.root, 'Choose distinct baseline and candidate repositories');
assert.equal(typeof implementations.baseline.recognizeWithinObservation, 'undefined', 'Expected original baseline');
assert.equal(typeof implementations.candidate.recognizeWithinObservation, 'function', 'Candidate wrapper missing');
assert.equal(sources.baseline.visionWorkerSha256, sources.candidate.visionWorkerSha256, 'Expected identical underlying Vision worker');
const markers = ['ALPHA', 'BRAVO', 'DELTA'];
const fixtureData = await Promise.all(markers.map(name => fs.readFile(path.join(scriptRoot, 'evidence', 'vision-fixtures', name + '.png'))));
const fixtures = fixtureData.map((bytes, index) => ({label: markers[index], size: bytes.length, sha256: hash(bytes)}));
assert.equal(new Set(fixtures.map(frame => frame.sha256)).size, fixtures.length);
const scenarios = {unchanged: [0, 0, 0], unique: [0, 1, 2]};
const reference = new Map(), rows = [];
async function measure(variant, scenario, round, order) {
  const fixtureIds = scenarios[scenario];
  const frames = fixtureIds.map(index => ({content: [{type: 'image', mimeType: 'image/png', data: fixtureData[index].toString('base64')}]}));
  const implementation = implementations[variant];
  let visionCalls = 0;
  const counted = async frame => {visionCalls++; return implementation.recognizePhoneImage(frame);};
  const results = [];
  const started = performance.now();
  const recognize = variant === 'baseline' ? counted : implementation.recognizeWithinObservation(counted);
  for (const frame of frames) results.push(await recognize(frame));
  const elapsedMs = performance.now() - started;
  assert.equal(visionCalls, variant === 'candidate' && scenario === 'unchanged' ? 1 : frames.length);
  for (const [frameIndex, output] of results.entries()) {
    const id = fixtureIds[frameIndex];
    assert.ok(output && output.width === 1080 && output.height === 1920, 'Actual macOS Vision recognition failed (' + variant + '/' + markers[id] + ')');
    assert.ok(output.lines.some(line => line.text.trim().toUpperCase() === markers[id]), 'Expected fixture marker in actual recognition');
    if (reference.has(id)) assert.deepEqual(output, reference.get(id), 'Normalized text/boxes differ for ' + markers[id]);
    else reference.set(id, structuredClone(output));
  }
  rows.push({round, order, scenario, variant, captures: frames.length, visionCalls, elapsedMs});
}
for (let round = 0; round <= rounds; round++) {
  for (const scenario of (round % 2 === 0 ? ['unchanged', 'unique'] : ['unique', 'unchanged'])) {
    const order = round % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
    for (const [orderIndex, variant] of order.entries()) await measure(variant, scenario, round, orderIndex);
  }
}
function median(values) {
  const sorted = [...values].sort((left, right) => left-right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle-1]+sorted[middle])/2;
}
const summary = {};
for (const scenario of Object.keys(scenarios)) {
  const entry = summary[scenario] = {};
  for (const variant of ['baseline','candidate']) {
    const subset = rows.filter(row => row.round > 0 && row.scenario === scenario && row.variant === variant);
    const times = subset.map(row => row.elapsedMs);
    entry[variant] = {observations: subset.length, captures: subset.reduce((sum, row) => sum + row.captures, 0), visionCalls: subset.reduce((sum, row) => sum + row.visionCalls, 0), medianMs: median(times), minMs: Math.min(...times), maxMs: Math.max(...times)};
  }
  entry.medianTimeReductionPct = (1 - entry.candidate.medianMs/entry.baseline.medianMs) * 100;
}
const report = {checkedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, osRelease: os.release(), node: process.version, sources, fixtures,
  equivalence: {allNormalizedOutputsMatch: true, recognized: [...reference].map(([index, value]) => ({label: markers[index], normalizedSha256: hash(JSON.stringify(value)), lines: value.lines.length}))},
  method: {rounds, warmupRoundExcluded: 0, capturesPerObservation: 3, measurement: 'One observation-scoped recognizer, fresh frame envelopes, serial real Vision calls. Excludes fixture generation, capture, network and post-run verification.'}, summary, rows};
const result = JSON.stringify(report, null, 2) + '\n';
if (values.output) await fs.writeFile(values.output, result); else process.stdout.write(result);
if (values.output) console.log(JSON.stringify({summary, output: path.resolve(values.output)}));
