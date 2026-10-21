import test from 'node:test';
import assert from 'node:assert/strict';
import { checkWebsite, isPublicIPv4, normalizeMonitorUrl } from '../server/security/safe-url.js';

test('public IPv4 validation rejects loopback, private, link-local and reserved ranges', () => {
  for (const address of ['127.0.0.1', '10.0.0.4', '172.16.0.1', '192.168.1.1', '169.254.169.254', '224.0.0.1']) {
    assert.equal(isPublicIPv4(address), false, `${address} must be blocked`);
  }
  assert.equal(isPublicIPv4('1.1.1.1'), true);
  assert.equal(isPublicIPv4('::1'), false);
});

test('monitor URLs accept only credential-free standard HTTP(S)', () => {
  assert.equal(normalizeMonitorUrl('https://example.org/status').href, 'https://example.org/status');
  for (const value of [
    'file:///etc/passwd',
    'ftp://example.org',
    'http://user:pass@example.org',
    'http://localhost',
    'http://127.0.0.1',
    'https://example.org:8443',
    'https://example.org/#fragment',
  ]) {
    assert.throws(() => normalizeMonitorUrl(value), undefined, value);
  }
});

test('monitor checks pin public IPs and reject a redirect to a private address', async () => {
  const result = await checkWebsite('https://1.1.1.1/health', {
    fetchRequest: async (_url, address) => {
      assert.equal(address, '1.1.1.1');
      return { status: 204 };
    },
  });
  assert.equal(result.status, 204);
  let requests = 0;
  await assert.rejects(() => checkWebsite('https://1.1.1.1/', {
    fetchRequest: async () => {
      requests += 1;
      return { status: 302, location: 'http://127.0.0.1/admin' };
    },
  }), /private and reserved/);
  assert.equal(requests, 1);
});
