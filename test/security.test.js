import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from 'node:net';
import { checkWebsite, createPinnedLookup, isPublicIPv4, normalizeMonitorUrl } from '../server/security/safe-url.js';

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

test('pinned DNS lookup supports both single-address and all-address callback shapes', () => {
  const lookup = createPinnedLookup('1.1.1.1');
  const single = [];
  lookup('example.com', {}, (error, address, family) => single.push({ error, address, family }));
  assert.equal(single.length, 1);
  assert.equal(single[0].error, null);
  assert.equal(single[0].address, '1.1.1.1');
  assert.equal(single[0].family, 4);

  const all = [];
  lookup('example.com', { all: true }, (error, addresses) => all.push({ error, addresses }));
  assert.equal(all.length, 1);
  assert.equal(all[0].error, null);
  assert.deepEqual(all[0].addresses, [{ address: '1.1.1.1', family: 4 }]);
});

test('pinned DNS lookup performs a real request against a pinned public address', async () => {
  // The socket layer calls `lookup` with `options.all = true` on the autoSelectFamily
  // path. A lookup that only returns a bare string there makes Node fail with
  // ERR_INVALID_IP_ADDRESS, so exercise the real request path end to end.
  const server = createServer((socket) => {
    socket.on('data', () => {
      socket.end('HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n');
    });
  });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  try {
    const { port } = server.address();
    const response = await new Promise((resolve, reject) => {
      const request = http.request({
        hostname: 'localhost',
        port,
        path: '/',
        method: 'GET',
        agent: false,
        lookup: createPinnedLookup('127.0.0.1'),
      }, (res) => {
        res.resume();
        resolve(res);
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(response.statusCode, 204);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
