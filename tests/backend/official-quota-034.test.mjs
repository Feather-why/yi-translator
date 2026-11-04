import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const build = process.env.BACKEND_BUILD_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.compiled');
const { QuotaLedger } = require(path.join(build, 'backend/scheduler/quota.js'));
const firstAccount = 'a'.repeat(64), secondAccount = 'b'.repeat(64);
const official = (extra = {}) => ({ unit: 'char', amount: 1_000, period: 'cycle', account: firstAccount, windowEnd: null, ...extra });
const calendar = { unit: 'char', amount: 500, period: 'month' };
const scope = account => 'deepl@' + account;
function area(initial = {}) {
  const data = structuredClone(initial);
  return { data, async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[key])])); },
    async set(values) { Object.assign(data, structuredClone(values)); } };
}
async function setup(local = area(), now = () => Date.UTC(2026, 10, 29)) {
  globalThis.chrome = { storage: { local } }; const ledger = new QuotaLedger(now); await ledger.ready(); return { ledger, local };
}
const charged = async (ledger, quota, count) => { const lease = ledger.reserve('deepl', quota, count); await lease.prepare(); lease.dispatch(); await lease.release(); };

test('official-quota: 内部账户与未知截止时间不泄漏到前端信息', async () => {
  const { ledger, local } = await setup(); const quota = official();
  await charged(ledger, quota, 7);
  assert.deepEqual(ledger.info('deepl', quota), { unit: 'char', amount: 1000, period: 'cycle', used: 7 });
  assert.equal(local.data['backend.usage'][scope(firstAccount)].resetAt, Number.MAX_SAFE_INTEGER);
  assert.ok(!JSON.stringify(ledger.info('deepl', quota)).includes(firstAccount));
});

test('official-quota: 账户独立预留和计费，不继承旧账户及本地预算', async () => {
  const { ledger } = await setup(), a = official({ amount: 20 }), b = official({ amount: 20, account: secondAccount });
  await ledger.charge('deepl', calendar, 90);
  const first = ledger.reserve('deepl', a, 16), second = ledger.reserve('deepl', b, 20);
  assert.throws(() => ledger.reserve('deepl', a, 5), error => error.info.code === 'quota');
  await first.prepare(); await second.prepare(); first.dispatch([first, second]); await Promise.all([first.release(), second.release()]);
  assert.equal(ledger.info('deepl', a).used, 16); assert.equal(ledger.info('deepl', b).used, 20); assert.equal(ledger.info('deepl', calendar).used, 90);
});

test('official-quota: 官方零额严格阻止请求，错误仅包含服务ID', async () => {
  const { ledger } = await setup(), quota = official({ amount: 0 });
  assert.equal(ledger.available('deepl', quota), false);
  assert.throws(() => ledger.reserve('deepl', quota, 1), error => error.info.code === 'quota' && error.info.provider === 'deepl' && !JSON.stringify(error.info).includes(firstAccount));
});

for (const limit of [0, 5]) {
  test(`official-quota: 排队尚未prepare时上限100降到${limit}，旧lease不得写预备日志`, async () => {
    const { ledger, local } = await setup(), quota = official({ amount: 100 }), snapshot = ledger.snapshot('deepl', quota);
    const lease = ledger.reserve('deepl', quota, 10);
    await ledger.calibrateOfficial('deepl', official({ amount: limit }), 0, snapshot);
    await assert.rejects(lease.prepare(), error => error.info.code === 'quota');
    assert.equal(ledger.info('deepl', quota).amount, limit); assert.equal(ledger.info('deepl', quota).used, 0);
    assert.deepEqual(local.data['backend.usage.pending'], {}); await lease.release();
  });

  test(`official-quota: prepared等待请求槽时上限100降到${limit}，dispatch拒绝且不扣费`, async () => {
    const { ledger, local } = await setup(), quota = official({ amount: 100 }), snapshot = ledger.snapshot('deepl', quota);
    const lease = ledger.reserve('deepl', quota, 10); await lease.prepare();
    await ledger.calibrateOfficial('deepl', official({ amount: limit }), 0, snapshot);
    assert.throws(() => lease.dispatch(), error => error.info.code === 'quota');
    assert.equal(ledger.info('deepl', quota).used, 0); assert.equal(ledger.snapshot('deepl', quota).localSent, 0);
    assert.equal(local.data['backend.usage'][scope(firstAccount)].used, 0); await lease.release();
    const restarted = (await setup(local)).ledger;
    assert.equal(restarted.info('deepl', quota).amount, limit, '重启后旧策略副本不能恢复旧限额');
    assert.equal(restarted.info('deepl', quota).used, 0);
  });
}

test('official-quota: 预备日志持久化等待期间上限归零，prepare完成前重新校验', async () => {
  const { ledger, local } = await setup(), quota = official({ amount: 100 }), snapshot = ledger.snapshot('deepl', quota);
  let unblock, entered; const gate = new Promise(resolve => { unblock = resolve; }), waiting = new Promise(resolve => { entered = resolve; });
  const originalSet = local.set.bind(local); let blockOnce = true;
  local.set = async values => {
    if (blockOnce && Object.keys(values['backend.usage.pending'] ?? {}).length) { blockOnce = false; entered(); await gate; }
    return originalSet(values);
  };
  const lease = ledger.reserve('deepl', quota, 10), preparing = lease.prepare(); await waiting;
  const calibration = ledger.calibrateOfficial('deepl', official({ amount: 0 }), 0, snapshot);
  unblock(); await assert.rejects(preparing, error => error.info.code === 'quota'); await calibration;
  assert.equal(ledger.info('deepl', quota).used, 0); await lease.release();
  assert.deepEqual(local.data['backend.usage.pending'], {});
});

test('official-quota: 可信上调额度供新请求使用，旧lease仍保守遵守其原上限', async () => {
  const { ledger } = await setup(), oldQuota = official({ amount: 10 }), nextQuota = official({ amount: 100 });
  const lease = ledger.reserve('deepl', oldQuota, 8); await lease.prepare();
  await ledger.calibrateOfficial('deepl', nextQuota, 5, ledger.snapshot('deepl', oldQuota));
  assert.throws(() => lease.dispatch(), error => error.info.code === 'quota'); await lease.release();
  assert.equal(ledger.info('deepl', nextQuota).amount, 100); assert.equal(ledger.info('deepl', oldQuota).amount, 10);
  await charged(ledger, nextQuota, 20); assert.equal(ledger.info('deepl', nextQuota).used, 25);
});

test('official-quota: 未知账期跨月跨年不重置，重启保持官方基准', async () => {
  let now = Date.UTC(2026, 10, 29); const { ledger, local } = await setup(undefined, () => now), quota = official();
  await ledger.calibrateOfficial('deepl', quota, 700, ledger.snapshot('deepl', quota)); await charged(ledger, quota, 4);
  now = Date.UTC(2027, 2, 5); assert.equal(ledger.info('deepl', quota).used, 704);
  const restarted = (await setup(local, () => now)).ledger;
  assert.equal(restarted.info('deepl', quota).used, 704); assert.equal(restarted.info('deepl', quota).resetAt, undefined);
});

test('official-quota: 明确截止时间到期保留用量，可信usage才能重置基准', async () => {
  let now = 1_000; const { ledger } = await setup(undefined, () => now), quota = official({ windowEnd: 2_000 });
  await ledger.calibrateOfficial('deepl', quota, 700, ledger.snapshot('deepl', quota));
  assert.equal(ledger.info('deepl', quota).resetAt, 2_000);
  assert.equal(ledger.info('deepl', official()).resetAt, 2_000, '探测前未知窗口不会抹掉已有可信边界');
  now = 2_001; assert.equal(ledger.info('deepl', quota).used, 700); assert.equal(ledger.info('deepl', quota).resetAt, undefined);
  const next = official({ windowEnd: 3_000 }), snapshot = ledger.snapshot('deepl', official());
  await charged(ledger, official(), 3); await ledger.calibrateOfficial('deepl', next, 10, snapshot);
  assert.deepEqual(ledger.info('deepl', next), { unit: 'char', amount: 1000, period: 'cycle', used: 13, resetAt: 3_000 });
});

test('official-quota: 用量允许下降并保留探测之后的已发请求', async () => {
  const { ledger } = await setup(), quota = official();
  await ledger.calibrateOfficial('deepl', quota, 800, ledger.snapshot('deepl', quota));
  const snapshot = ledger.snapshot('deepl', quota); await charged(ledger, quota, 7); await charged(ledger, quota, 5);
  await ledger.calibrateOfficial('deepl', quota, 200, snapshot);
  assert.equal(ledger.info('deepl', quota).used, 212); assert.equal(ledger.snapshot('deepl', quota).localSent, 12);
});

test('official-quota: 取消未发预留不混进官方校准的并发增量', async () => {
  const { ledger } = await setup(), quota = official(), snapshot = ledger.snapshot('deepl', quota);
  const lease = ledger.reserve('deepl', quota, 8); await lease.prepare(); await lease.release();
  await ledger.calibrateOfficial('deepl', quota, 25, snapshot); assert.equal(ledger.info('deepl', quota).used, 25);
  assert.equal(ledger.snapshot('deepl', quota).localSent, 0);
});

test('official-quota: 账户或输入快照错误不会改写其他账户，也不暴露摘要', async () => {
  const { ledger, local } = await setup(), quota = official(), snapshot = ledger.snapshot('deepl', quota), before = JSON.stringify(local.data);
  for (const account of ['', 'A'.repeat(64), 'key:fx', '__proto__', 'a'.repeat(63), { toString: () => firstAccount }]) {
    assert.throws(() => ledger.info('deepl', official({ account })), error => error.info.code === 'bad_input' && !JSON.stringify(error.info).includes(firstAccount));
  }
  assert.throws(() => ledger.info('deepl', { ...calendar, windowEnd: null }), error => error.info.code === 'bad_input');
  for (const windowEnd of [-1, 1.5, Infinity, '2026-11-01']) assert.throws(() => ledger.info('deepl', official({ windowEnd })), error => error.info.code === 'bad_input');
  await assert.rejects(ledger.calibrateOfficial('deepl', official({ account: secondAccount }), 4, snapshot), error => error.info.code === 'bad_input');
  await assert.rejects(ledger.calibrateOfficial('deepl', quota, -1, snapshot), error => error.info.code === 'bad_input');
  assert.equal(JSON.stringify(local.data), before);
});

test('official-quota: 未知周期的prepared journal崩溃恢复只归账一次', async () => {
  const { ledger, local } = await setup(), quota = official();
  await ledger.calibrateOfficial('deepl', quota, 100, ledger.snapshot('deepl', quota)); const lease = ledger.reserve('deepl', quota, 8); await lease.prepare();
  const values = Object.values(local.data['backend.usage.pending']); assert.equal(values[0].provider, scope(firstAccount));
  const restarted = (await setup(local)).ledger; assert.equal(restarted.info('deepl', quota).used, 108); assert.equal(restarted.snapshot('deepl', quota).localSent, 8);
  assert.equal((await setup(local)).ledger.info('deepl', quota).used, 108); assert.deepEqual(local.data['backend.usage.pending'], {});
});

test('official-quota: 跨官方边界的crash journal也保守归账，等待可信探测校正', async () => {
  let now = 1_000; const { ledger, local } = await setup(undefined, () => now), quota = official({ windowEnd: 2_000 });
  await ledger.calibrateOfficial('deepl', quota, 90, ledger.snapshot('deepl', quota)); const lease = ledger.reserve('deepl', quota, 8); await lease.prepare();
  now = 2_001; const restarted = (await setup(local, () => now)).ledger;
  assert.equal(restarted.info('deepl', quota).used, 98); assert.equal(restarted.info('deepl', quota).resetAt, undefined);
});

test('official-quota: 用户预算与官方账户一次dispatch原子校验，任何一层失败都不计费', async () => {
  const { ledger } = await setup(), quota = official({ amount: 20 });
  const account = ledger.reserve('deepl', quota, 8), budget = ledger.reserve('deepl', calendar, 8);
  await account.prepare(); await budget.prepare(); await ledger.calibrateOfficial('deepl', quota, 18, ledger.snapshot('deepl', quota));
  assert.throws(() => budget.dispatch([budget, account]), error => error.info.code === 'quota');
  assert.equal(ledger.info('deepl', calendar).used, 0); assert.equal(ledger.info('deepl', quota).used, 18);
  await Promise.all([account.release(), budget.release()]);
});

test('official-quota: 官方周期改变使旧prepared失效，不能沿用过期journal', async () => {
  const { ledger } = await setup(undefined, () => 1_000), quota = official({ windowEnd: 2_000 });
  const lease = ledger.reserve('deepl', quota, 7); await lease.prepare();
  await ledger.calibrateOfficial('deepl', official({ windowEnd: 3_000 }), 8, ledger.snapshot('deepl', quota));
  assert.throws(() => lease.dispatch(), error => error.info.code === 'no_provider');
  assert.equal(ledger.info('deepl', quota).resetAt, 3_000, '旧副本读取不能倒写新账期');
  await lease.release(); assert.equal(ledger.info('deepl', official({ windowEnd: 3_000 })).used, 8);
});

test('official-quota: 官方耗尽信号不伪装成探测期间的新增发送', async () => {
  const { ledger } = await setup(), quota = official(), snapshot = ledger.snapshot('deepl', quota);
  await ledger.exhaust('deepl', quota); assert.equal(ledger.info('deepl', quota).used, quota.amount);
  await ledger.calibrateOfficial('deepl', quota, 300, snapshot); assert.equal(ledger.info('deepl', quota).used, 300);
});

test('official-quota: 下降校准及localSent重启保持，不接受外来账户sync计数', async () => {
  const { ledger, local } = await setup(), quota = official();
  await charged(ledger, quota, 50); await ledger.calibrateOfficial('deepl', quota, 5, ledger.snapshot('deepl', quota));
  await ledger.reload(); assert.equal(ledger.info('deepl', quota).used, 5);
  const restarted = (await setup(local)).ledger; assert.equal(restarted.info('deepl', quota).used, 5); assert.equal(restarted.snapshot('deepl', quota).localSent, 50);
  await restarted.mergeCounters({ [scope(firstAccount)]: { resetAt: Number.MAX_SAFE_INTEGER, used: 999, localSent: 999, devices: { remote: 999 } } });
  assert.equal(restarted.info('deepl', quota).used, 5);
});

test('official-quota: 删除服务清理所有账户分支及预留，保留其他服务', async () => {
  const { ledger, local } = await setup(), a = official(), b = official({ account: secondAccount });
  await charged(ledger, a, 3); await charged(ledger, b, 4); await ledger.charge('other', calendar, 9);
  const pending = ledger.reserve('deepl', a, 1); await pending.prepare(); await ledger.remove('deepl');
  assert.deepEqual(Object.keys(local.data['backend.usage']), ['other']); assert.deepEqual(local.data['backend.usage.pending'], {});
  assert.throws(() => pending.dispatch(), error => error.info.code === 'no_provider'); assert.equal(ledger.info('other', calendar).used, 9);
});

test('official-quota: 未设置账户的新旧本地月预算重置语义不变', async () => {
  let now = new Date(2026, 10, 29).getTime(); const { ledger } = await setup(undefined, () => now);
  await ledger.charge('deepl', calendar, 90); const reset = ledger.info('deepl', calendar).resetAt;
  now = reset; assert.equal(ledger.info('deepl', calendar).used, 0); assert.ok(ledger.info('deepl', calendar).resetAt > now);
});
