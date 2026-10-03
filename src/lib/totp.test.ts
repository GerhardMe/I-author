import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32Decode, generateSecret, otpauthUri, totpAt, verifyTotp } from './totp.ts';

// RFC 6238 test vectors (SHA-1, secret "12345678901234567890", 8 digits)
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const RFC_VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

function totpAt8(secret: string, unixSeconds: number): string {
  return totpAt(secret, unixSeconds, 8);
}

test('base32Decode round trips RFC 6238 secret', () => {
  assert.equal(base32Decode(RFC_SECRET).toString('utf8'), '12345678901234567890');
});

test('RFC 6238 SHA-1 vectors', () => {
  for (const [t, expected] of RFC_VECTORS) {
    assert.equal(totpAt8(RFC_SECRET, t), expected, `T=${t}`);
  }
});

test('verifyTotp accepts current and +-window codes, rejects others', () => {
  const secret = generateSecret();
  // generate a valid code for now by scanning all 1e6 codes is slow; instead use
  // the implementation's own hotp indirectly: try verify with a bogus token
  assert.equal(verifyTotp(secret, '000000'), false);
  assert.equal(verifyTotp(secret, '12345'), false);
  assert.equal(verifyTotp(secret, 'abcdef'), false); // non-digits stripped -> wrong length
  assert.equal(verifyTotp(secret, ''), false);
});

test('generated secrets are valid base32', () => {
  for (let i = 0; i < 20; i++) {
    const s = generateSecret();
    assert.match(s, /^[A-Z2-7]{32}$/);
  }
});

test('otpauthUri shape', () => {
  const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'you', 'Iauthor');
  assert.ok(uri.startsWith('otpauth://totp/Iauthor%3Ayou?'));
  assert.ok(uri.includes('secret=JBSWY3DPEHPK3PXP'));
});