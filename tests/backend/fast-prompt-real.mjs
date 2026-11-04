import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Run only during an exclusive GPU lease, against an externally started test server.
// SAMPLING_VARIANT labels that server's sampling backend; it does not change its flags.
// No service startup/shutdown, production requests, Core repair, or model downloads here.
const root = fileURLToPath(new URL('../../', import.meta.url));
const server = new URL(process.env.LLAMA_URL || 'http://127.0.0.1:8083');
assert.equal(server.protocol, 'http:', 'Only an isolated loopback HTTP test server is allowed');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(server.hostname), 'Remote model endpoints are forbidden');
assert.notEqual(server.port || '80', '8081', 'Production port 8081 is forbidden');
assert.ok(server.port && !server.username && !server.password && !server.search && !server.hash
  && ['/', '/v1', '/v1/'].includes(server.pathname), 'Use a loopback test port and root or /v1 URL');
const samplingVariant = process.env.SAMPLING_VARIANT || 'cpu';
assert.ok(['cpu', 'gpu'].includes(samplingVariant), 'SAMPLING_VARIANT must be cpu or gpu');
const reportDir = path.resolve(process.env.REPORT_DIR || path.join(root, 'work',
  `fast-prompt-${samplingVariant}-${new Date().toISOString().replace(/[:.]/g, '-')}`));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const require = createRequire(import.meta.url);
const adapterPath = path.join(root, 'tests/.compiled/backend/providers/llamacpp.js');
const sourcePath = path.join(root, 'src/backend/providers/llamacpp.ts');
const source = await readFile(sourcePath, 'utf8');
const provider = require(adapterPath).default;
const { validTranslation } = require('../.compiled/backend/validation.js');
const sourceVersion = source.match(/id:\s*'llamacpp'[\s\S]*?\bversion:\s*'([^']+)'/)?.[1];
const [sourceStat, adapterStat] = await Promise.all([stat(sourcePath), stat(adapterPath)]);
assert.equal(provider.id, 'llamacpp');
assert.equal(provider.version, sourceVersion, 'Compile the current adapter before running this benchmark');
assert.ok(adapterStat.mtimeMs >= sourceStat.mtimeMs, 'Compiled adapter predates its source; ask the owner to compile it');

const cases = [
  {
    id: 'short-opening', category: 'plain-short', sourceLang: 'en', targetLang: 'zh-CN',
    source: 'The library will reopen on Monday, but the western entrance will remain closed.',
    expectedFacts: ['The library reopens on Monday.', 'Only the western entrance is stated to remain closed; do not say the whole library stays closed.'],
  },
  {
    id: 'long-tour', category: 'plain-long', sourceLang: 'en', targetLang: 'zh-CN',
    source: 'At a public science centre, visitors may borrow a portable receiver for the guided tour. The receiver works inside the main building, but it does not receive a signal in the underground gallery. A ticket covers the tour only; it does not include the evening workshop. If the workshop is cancelled, the centre will refund the workshop fee without cancelling the tour booking. Groups with fewer than eight people should use the small entrance on the eastern side, rather than the larger door next to the café.',
    expectedFacts: ['Visitors may borrow a receiver for the tour.', 'It works in the main building, not in the underground gallery.', 'The tour ticket excludes the evening workshop.', 'Cancelling the workshop refunds its fee and leaves the tour booking intact.', 'Groups of fewer than eight use the small eastern entrance, not the larger café-side door.'],
  },
  {
    id: 'conditional-valve', category: 'plain-conditions-numbers', sourceLang: 'en', targetLang: 'zh-CN',
    source: 'If the outdoor temperature falls below -3°C, keep the red valve closed for 15 minutes. Otherwise, open it halfway; do not raise the pressure above 0.8 MPa. The backup pump must not start unless both sensors agree.',
    expectedFacts: ['Below negative three degrees Celsius means keep the red valve closed for fifteen minutes.', 'Otherwise open the valve halfway, not completely.', 'Pressure must not exceed 0.8 MPa.', 'The backup pump may start only when both sensors agree.'],
  },
  {
    id: 'two-parcel-labels', category: 'plain-multiple-sentences-repetition', sourceLang: 'en', targetLang: 'zh-CN',
    source: 'Each parcel has its own label. Label A reads “Handle with care.” Label B also reads “Handle with care.” These are two separate instructions, not a duplicated printing error. Neither label says that the parcel contains glass.',
    expectedFacts: ['There are two parcels with separate labels A and B.', 'Preserve both occurrences of the instruction Handle with care, one attributed to each label.', 'The repetition is intentional, not a printing error.', 'Neither label states that its parcel contains glass.'],
  },
  {
    id: 'zh-archive-copy', category: 'plain-zh-en', sourceLang: 'zh-CN', targetLang: 'en',
    source: '管理员只在核对两份清单后才交出钥匙。如果东侧阅览室已经关闭，请把副本放在门左边的柜子里，不要移动原件。预约时间是下午六点半，不是早上六点半。',
    expectedFacts: ['The administrator hands over the key only after checking both inventories.', 'If the eastern reading room is closed, put the copy in the cabinet to the left of the door.', 'Do not move the original.', 'The appointment is at 6:30 p.m., not 6:30 a.m.'],
  },
  {
    id: 'single-reading-link', category: 'single-g', sourceLang: 'en', targetLang: 'zh-CN',
    source: 'The <g4>northern reading room</g4> is open after 18:30, while the southern room is closed.',
    expectedFacts: ['The northern reading room is open after 18:30.', 'The southern room is closed; do not reverse the two rooms.'],
    expectedTagScopes: { g4: 'The complete northern reading room name or noun phrase, not the southern room or only the opening time.' },
  },
  {
    id: 'flat-route-links', category: 'parallel-g', sourceLang: 'en', targetLang: 'zh-CN',
    source: 'Take <g2>the coastal bus</g2> to <g11>Harbour Square</g11>, then walk to <g27>the east gate</g27>. Do not board the inland bus.',
    expectedFacts: ['Take the coastal bus to Harbour Square, then walk to the east gate.', 'Do not take the inland bus.', 'Harbour Square is a synthetic place name; a reasonable consistent translation is acceptable.'],
    expectedTagScopes: { g2: 'The coastal bus, not the inland bus.', g11: 'Harbour Square.', g27: 'The east gate.' },
  },
  {
    id: 'nested-record-control', category: 'nested-control-only', sourceLang: 'en', targetLang: 'zh-CN',
    source: 'Before copying <g3>the <g8>inspection record</g8> for March</g3>, close <x5/>. Keep the original record in the cabinet to the left of the door.',
    expectedFacts: ['Close the protected item before copying the March inspection record.', 'The original record stays in the cabinet to the left of the door.', 'Do not exchange the original with the copy or reverse the action order.'],
    expectedTagScopes: { g3: 'The complete inspection record for March.', g8: 'Inspection record inside g3, excluding the month.', x5: 'One unchanged opaque atom governed by close.' },
  },
];
const variants = {
  baseline: { appliesTo: 'all', prompt: null },
  P1: { appliesTo: 'plain', prompt: '将以下文本完整译为{target}，表达简练，只输出译文：\n{text}' },
  P2: { appliesTo: 'plain', prompt: '译成{target}，只输出译文：\n{text}' },
  P3: { appliesTo: 'non-nested-g', prompt: '译为{target}，只输出译文。XML标签原样保留，包住对应译词：\n{text}' },
};
const seeds = [42, 77];
const plan = [];
for (const [round, seed] of seeds.entries()) {
  const order = round % 2 ? [...cases].reverse() : cases;
  for (const sample of order) {
    const index = cases.indexOf(sample);
    assert.ok(sample.source.length <= provider.limits.maxChars, `${sample.id}: sample exceeds the adapter limit`);
    assert.ok(validTranslation(sample.source, sample.source), `${sample.id}: invalid source structure`);
    const eligible = sample.category.startsWith('plain') ? ['baseline', 'P1', 'P2']
      : sample.category === 'nested-control-only' ? ['baseline'] : ['baseline', 'P3'];
    const rotated = eligible.map((_, offset) => eligible[(offset + index + round) % eligible.length]);
    for (const [withinPairOrder, variant] of rotated.entries()) {
      plan.push({ order: plan.length + 1, round, seed, caseId: sample.id, variant, withinCaseOrder: withinPairOrder + 1 });
    }
  }
}
assert.equal(plan.length, 40);
assert.equal(cases.length, 8);
const salt = randomBytes(24).toString('hex');
const scriptPath = fileURLToPath(import.meta.url);
const manifest = {
  createdAt: new Date().toISOString(), server: server.href, samplingVariant,
  samplingBackendVerification: 'Label supplied by the operator; verify externally from the isolated server command/log. This script does not assert GPU sampling actually engaged.',
  scope: 'Raw compiled llama.cpp adapter and JSON transport only; no Core queue, retries, tag projection, streaming, DOM, or cloud calls. All inputs are newly fixed synthetic public-style text.',
  modelWarmth: 'Externally started server; device warm/cold state is not inferred or changed by this script. No extra warmup requests.',
  promptCache: 'Every measured POST explicitly uses cache_prompt:false. Actual cache_n is recorded; nonzero/missing cache counters cannot be described as proven cold KV.',
  adapterVersion: provider.version, adapterSourceSha256: hash(source), compiledAdapterSha256: hash(await readFile(adapterPath)),
  adapterSourceModifiedAt: sourceStat.mtime.toISOString(), compiledAdapterModifiedAt: adapterStat.mtime.toISOString(),
  scriptSha256: hash(await readFile(scriptPath)), fixturesSha256: hash(JSON.stringify(cases)),
  variants, cases, seeds, plan, plannedModelRequests: plan.length, hardModelRequestLimit: 40,
  samplingPolicy: 'Keep compiled adapter temperature/top_p/top_k/min_p/repeat_penalty/max_tokens unchanged; inject only seed, disable prompt cache, and substitute the selected candidate prompt. SAMPLING_VARIANT never changes request sampling parameters.',
  limitations: ['Two seeds and eight independent cases do not estimate general translation accuracy.', 'P3 has two flat-tag cases only; nested source is baseline control only.', 'Speed differences may follow different output token counts; compare model ms/token as well as wall time.', 'Structural validation does not establish meaning or correct link binding; review expected facts and tag scopes separately.'],
};
await mkdir(reportDir, { recursive: true });
await writeFile(path.join(reportDir, 'plan.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
const controller = new AbortController();
const stop = () => controller.abort(new DOMException('Benchmark interrupted', 'AbortError'));
process.once('SIGINT', stop); process.once('SIGTERM', stop);
const reports = [];
let httpCount = 0;
const finiteTimings = (value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).filter(([, number]) => typeof number === 'number' && Number.isFinite(number) && number >= 0)) : null;
try {
  for (const item of plan) {
    if (controller.signal.aborted) break;
    const sample = cases.find((row) => row.id === item.caseId);
    const row = { ...item, blindId: `fp-${hash(salt + ':' + item.order).slice(0, 14)}`, category: sample.category,
      samplingVariant, sourceLang: sample.sourceLang, targetLang: sample.targetLang, source: sample.source,
      sourceSha256: hash(sample.source), expectedFacts: sample.expectedFacts, expectedTagScopes: sample.expectedTagScopes ?? null,
      modelTimingCallbacks: [], http: [], structureValid: false };
    const started = performance.now();
    try {
      const ctx = {
        config: { url: server.href }, signal: controller.signal, log() {},
        recordTiming: (value) => row.modelTimingCallbacks.push(structuredClone(value)),
        fetch: async (url, init = {}) => {
          const destination = new URL(String(url));
          assert.equal(destination.origin, server.origin, 'Adapter attempted to leave the isolated test server');
          assert.equal(destination.pathname, '/v1/chat/completions', 'Only a measured translation POST is allowed');
          assert.equal(init.method, 'POST');
          assert.ok(++httpCount <= 40, 'Hard inference request limit exceeded');
          const body = JSON.parse(String(init.body));
          assert.equal(body.stream, false, 'This benchmark does not measure streaming transport');
          assert.equal(body.messages.length, 1); assert.equal(body.messages[0].role, 'user');
          assert.equal(body.temperature, 0.7); assert.equal(body.top_p, 0.6); assert.equal(body.top_k, 20);
          assert.equal(body.min_p, 0); assert.equal(body.repeat_penalty, 1.05);
          const originalPrompt = body.messages[0].content;
          if (item.variant !== 'baseline') {
            const target = new Intl.DisplayNames(['zh-CN'], { type: 'language' }).of(sample.targetLang) || sample.targetLang;
            body.messages[0].content = variants[item.variant].prompt.replace('{target}', target).replace('{text}', sample.source);
          }
          body.seed = item.seed; body.cache_prompt = false;
          const request = { number: httpCount, prompt: body.messages[0].content,
            promptSha256: hash(body.messages[0].content), originalAdapterPromptSha256: hash(originalPrompt),
            promptChars: body.messages[0].content.length, seed: body.seed,
            sampling: Object.fromEntries(['temperature', 'top_p', 'top_k', 'min_p', 'repeat_penalty', 'max_tokens', 'stream', 'cache_prompt'].map((key) => [key, body[key]])) };
          row.http.push(request);
          const { timeoutMs = 60_000, streamResponse: _streamResponse, signal: adapterSignal, ...fetchInit } = init;
          const signal = AbortSignal.any([controller.signal, ...(adapterSignal ? [adapterSignal] : []), AbortSignal.timeout(timeoutMs)]);
          const httpStarted = performance.now();
          try {
            const response = await fetch(destination, { ...fetchInit, credentials: 'omit', redirect: 'error', signal, body: JSON.stringify(body) });
            request.status = response.status;
            const bytes = await response.arrayBuffer(); request.httpMs = performance.now() - httpStarted;
            const rawText = new TextDecoder().decode(bytes);
            try {
              const json = JSON.parse(rawText);
              request.timings = finiteTimings(json.timings);
              request.usage = json.usage ?? null;
              request.finishReason = json.choices?.[0]?.finish_reason ?? null;
              request.rawOutput = json.choices?.[0]?.message?.content ?? null;
              if (json.error !== undefined) request.serverError = json.error;
            } catch { request.invalidJsonBody = rawText; }
            return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
          } catch (error) { request.httpMs ??= performance.now() - httpStarted; request.error = String(error); throw error; }
        },
      };
      const result = await provider.translate({ texts: [sample.source], sourceLang: sample.sourceLang, targetLang: sample.targetLang }, ctx);
      assert.equal(result.length, 1); row.output = result[0];
      row.structureValid = validTranslation(sample.source, row.output);
    } catch (error) {
      row.error = String(error);
      try { row.errorInfo = provider.classifyError(error); } catch { /* Keep the original error if classification itself fails. */ }
    }
    row.elapsedMs = performance.now() - started;
    row.httpCalls = row.http.length;
    row.semanticPass = null; row.tagScopePass = null;
    reports.push(row);
    await appendFile(path.join(reportDir, 'results.jsonl'), JSON.stringify(row) + '\n');
    console.log(JSON.stringify({ order: row.order, caseId: row.caseId, variant: row.variant, seed: row.seed,
      ms: Math.round(row.elapsedMs), http: row.httpCalls, valid: row.structureValid, error: row.error ?? null }));
  }
} finally {
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] : null;
  const summary = Object.keys(variants).map((variant) => {
    const rows = reports.filter((row) => row.variant === variant), calls = rows.flatMap((row) => row.http);
    const timings = calls.map((row) => row.timings).filter(Boolean);
    return { variant, completed: rows.length, errors: rows.filter((row) => row.error).length,
      structureValid: rows.filter((row) => row.structureValid).length,
      p50Ms: percentile(rows.map((row) => row.elapsedMs), 0.5), p95Ms: percentile(rows.map((row) => row.elapsedMs), 0.95),
      actualHttpCalls: calls.length, outputTokens: timings.reduce((sum, value) => sum + (value.predicted_n ?? 0), 0),
      evaluatedPromptTokens: timings.reduce((sum, value) => sum + (value.prompt_n ?? 0), 0),
      reportedCacheTokens: timings.reduce((sum, value) => sum + (value.cache_n ?? 0), 0),
      modelMsPerOutputTokenMedian: percentile(timings.filter((value) => value.predicted_n > 0 && value.predicted_ms !== undefined)
        .map((value) => value.predicted_ms / value.predicted_n), 0.5),
      note: 'Aggregate variants cover different case subsets. Use paired rows with the same caseId and seed; do not rank these aggregate latencies as equal-work throughput.' };
  });
  const paired = reports.filter((row) => row.variant !== 'baseline').map((row) => {
    const baseline = reports.find((other) => other.variant === 'baseline' && other.caseId === row.caseId && other.seed === row.seed);
    return { caseId: row.caseId, seed: row.seed, candidate: row.variant, baselineMs: baseline?.elapsedMs ?? null,
      candidateMs: row.elapsedMs, candidateMinusBaselineMs: baseline ? row.elapsedMs - baseline.elapsedMs : null,
      baselineStructureValid: baseline?.structureValid ?? null, candidateStructureValid: row.structureValid,
      baselineOutputTokens: baseline?.http[0]?.timings?.predicted_n ?? null, candidateOutputTokens: row.http[0]?.timings?.predicted_n ?? null,
      sameOutput: baseline?.output !== undefined && baseline.output === row.output };
  });
  const complete = reports.length === plan.length && httpCount === plan.length && reports.every((row) => row.httpCalls === 1);
  const result = { ...manifest, finishedAt: new Date().toISOString(), complete, interrupted: controller.signal.aborted,
    actualHttpCalls: httpCount, successfulRows: reports.filter((row) => !row.error).length,
    actualKvCacheColdVerified: reports.length > 0 && reports.flatMap((row) => row.http).every((row) => row.timings?.cache_n === 0),
    summary, paired, reports };
  const blind = { scope: 'Anonymous raw adapter outputs; AI or human review is still required. No candidate identities, sampling backend, seeds, timings, or structural pass labels are included.',
    rows: reports.filter((row) => typeof row.output === 'string' || typeof row.http[0]?.rawOutput === 'string').map((row) => ({
      blindId: row.blindId, sourceLang: row.sourceLang, targetLang: row.targetLang, source: row.source,
      output: row.output ?? row.http[0].rawOutput, checks: row.expectedFacts, tagScopes: row.expectedTagScopes,
    })).sort((a, b) => a.blindId.localeCompare(b.blindId)) };
  await writeFile(path.join(reportDir, 'results.json'), JSON.stringify(result, null, 2));
  await writeFile(path.join(reportDir, 'blind.json'), JSON.stringify(blind, null, 2));
  await writeFile(path.join(reportDir, 'blind-mapping.json'), JSON.stringify(reports.map((row) => ({ blindId: row.blindId,
    caseId: row.caseId, seed: row.seed, variant: row.variant, samplingVariant, order: row.order })), null, 2));
  console.log(JSON.stringify({ reportDir, complete, actualHttpCalls: httpCount, summary }));
  if (!complete || reports.some((row) => row.error)) process.exitCode = 1;
}
