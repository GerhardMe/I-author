import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidPin, hashSecret, verifySecret } from './auth/pin.ts';
import { createToken, tokenExp, tokenKey, verifyToken } from './auth/device.ts';
import { isBlocked, recordFail, recordSuccess, forceSweep } from './auth/ratelimit.ts';
import { makeRecoveryCodes, findRecoveryEntry } from './auth/recovery.ts';

test('pin validation', () => {
  assert.ok(isValidPin('1234'));
  assert.ok(isValidPin('123456789012'));
  assert.ok(!isValidPin('123'));
  assert.ok(!isValidPin('1234567890123'));
  assert.ok(!isValidPin('12a4'));
  assert.ok(!isValidPin(''));
});

test('hashSecret / verifySecret round trip', () => {
  const rec = hashSecret('1234');
  assert.ok(verifySecret('1234', rec));
  assert.ok(!verifySecret('1235', rec));
  assert.ok(!verifySecret('1234', { salt: 'ab', hash: 'cd' }));
});

test('device token round trip and expiry', () => {
  const secret = 'a'.repeat(64);
  const { token, exp } = createToken(secret, 1000);
  assert.ok(verifyToken(token, secret));
  assert.equal(tokenExp(token), exp);
  assert.ok(!verifyToken(token, 'b'.repeat(64)));
  assert.ok(!verifyToken('tampered.token.sig', secret));
  assert.ok(!verifyToken(undefined, secret));
  const expired = createToken(secret, -1);
  assert.ok(!verifyToken(expired.token, secret));
  assert.ok(tokenKey(token).length === 64);
});

test('rate limit: 5 fails then block, success clears', () => {
  const key = `test-${Math.random()}`;
  for (let i = 0; i < 4; i++) recordFail(key);
  assert.ok(!isBlocked(key));
  recordFail(key);
  assert.ok(isBlocked(key));
  recordSuccess(key);
  assert.ok(!isBlocked(key));
});

test('rate limit: sweeps never wipe unlocked fail counters (regression)', () => {
  const key = `test-${Math.random()}`;
  for (let i = 0; i < 4; i++) recordFail(key);
  forceSweep(); // used to delete the counter (until=0 is "in the past")
  assert.ok(!isBlocked(key)); // 4 fails still free...
  recordFail(key); // ...but the history survived: this is the 5th
  assert.ok(isBlocked(key));
  assert.ok(!isBlocked(`${key}-other`));
});

test('recovery codes verify once (used flag)', () => {
  const { entries, codes } = makeRecoveryCodes(3);
  assert.equal(entries.length, 3);
  assert.ok(findRecoveryEntry(codes[0], entries));
  assert.ok(findRecoveryEntry(codes[0].toLowerCase(), entries));
  assert.ok(!findRecoveryEntry(codes[0], entries.slice(1)));
  assert.ok(!findRecoveryEntry('AAAA-BBBB', entries));
  assert.ok(!findRecoveryEntry('nonsense', entries));
  entries[0].used = true;
  assert.ok(!findRecoveryEntry(codes[0], entries));
});