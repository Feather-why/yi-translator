import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { encryptSecrets, decryptSecrets, exportVault, importVault } = require('../.compiled/backend/secrets-backup.js');

test('可移植密钥归档以PBKDF2+AES-GCM加密，随机salt/IV，相同口令能在另一实例解密', async () => {
  const data = { service: { key: 'synthetic-key-不会上传', region: 'east' } };
  const a = await encryptSecrets(data, 'long-fixture-passphrase'), b = await encryptSecrets(data, 'long-fixture-passphrase');
  assert.equal(a.iterations, 600000); assert.equal(a.kdf, 'PBKDF2-SHA256'); assert.notEqual(a.salt, b.salt); assert.notEqual(a.iv, b.iv);
  assert.equal(JSON.stringify(a).includes('synthetic-key'), false); assert.deepEqual(await decryptSecrets(a, 'long-fixture-passphrase'), data);
  await assert.rejects(decryptSecrets(a, 'wrong-password'));
  await assert.rejects(decryptSecrets({ ...a, ciphertext: b.ciphertext }, 'long-fixture-passphrase'));
});

test('导入先完整验证且坏口令不写任何服务，合法归档仅导入选择导出的服务', async () => {
  const values = { first: { key: 'fixture-one' }, second: { key: 'fixture-two' } }, written = [];
  const source = { get: async (id) => structuredClone(values[id] || {}) };
  const archive = await exportVault(source, 'fixture-password', ['first']);
  const target = { get: async () => ({}), set: async (id, data) => { written.push([id, data]); } };
  await assert.rejects(importVault(target, archive, 'incorrect-password')); assert.deepEqual(written, []);
  assert.deepEqual(await importVault(target, archive, 'fixture-password'), ['first']); assert.deepEqual(written, [['first', { key: 'fixture-one' }]]);
});

test('归档拒绝弱口令、超大派生参数及保留键，保存中途失败回滚已写服务', async () => {
  await assert.rejects(encryptSecrets({}, 'short'));
  await assert.rejects(decryptSecrets({ version: 1, kdf: 'PBKDF2-SHA256', iterations: 999999999 }, 'fixture-password'));
  await assert.rejects(encryptSecrets(JSON.parse('{"__proto__":{"key":"x"}}'), 'fixture-password'));
  const archive = await encryptSecrets({ first: { key: 'new-first' }, second: { key: 'new-second' } }, 'fixture-password');
  const values = { first: { key: 'old-first' }, second: { key: 'old-second' } };
  await assert.rejects(importVault({ get: async (id) => values[id], set: async (id, value) => { if (id === 'second') throw new Error('synthetic disk full'); values[id] = value; } }, archive, 'fixture-password'));
  assert.deepEqual(values.first, { key: 'old-first' });
});
