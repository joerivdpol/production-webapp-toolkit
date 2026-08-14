import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateE2EOrigin } from '../templates/playwright/validate-e2e-origin.mjs';

describe('E2E target origin safety', () => {
  it('accepts loopback and reserved test origins', () => {
    for (const value of [
      'http://localhost:4173',
      'http://127.0.0.1:3000',
      'http://127.12.34.56:8080',
      'http://[::1]:4173',
      'https://app.example.test',
      'http://preview.localhost:8080',
    ]) {
      assert.doesNotThrow(() => validateE2EOrigin(value), value);
    }
  });

  it('rejects production-looking and public origins', () => {
    for (const value of [
      'https://example.com',
      'https://production.example.org',
      'https://api.example.net',
      'http://192.168.1.10:4173',
    ]) {
      assert.throws(() => validateE2EOrigin(value), /Refusing/, value);
    }
  });

  it('rejects malformed, credentialed, and non-origin targets', () => {
    assert.throws(() => validateE2EOrigin('not a URL'), /absolute URL/);
    assert.throws(() => validateE2EOrigin('ftp://localhost/resource'), /HTTP/);
    assert.throws(() => validateE2EOrigin('http://user:secret@localhost:4173'), /credentials/);
    assert.throws(() => validateE2EOrigin('http://localhost:4173/admin'), /without a path/);
  });
});
