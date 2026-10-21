import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

const blockedV4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function ipv4ToInt(address) {
  return address.split('.').reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}

export function isPublicIPv4(address) {
  if (isIP(address) !== 4) return false;
  const value = ipv4ToInt(address);
  return !blockedV4.some(([network, prefix]) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (value & mask) === (ipv4ToInt(network) & mask);
  });
}

export function normalizeMonitorUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('enter a valid public website URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('only HTTP(S) website URLs without credentials or fragments are supported');
  }
  if (url.port && !((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443'))) {
    throw new Error('website monitors only connect to standard HTTP(S) ports');
  }
  if (url.hostname.endsWith('.') || url.hostname.toLowerCase() === 'localhost') throw new Error('private and local hosts are not allowed');
  if (isIP(url.hostname) === 4 && !isPublicIPv4(url.hostname)) throw new Error('private and reserved IP addresses are not allowed');
  if (isIP(url.hostname) === 6) throw new Error('IPv6 literals are not supported by website monitors');
  url.hash = '';
  return url;
}

async function resolvePublicIPv4(hostname) {
  if (isIP(hostname) === 4) {
    if (!isPublicIPv4(hostname)) throw new Error('website resolves to a private or reserved address');
    return hostname;
  }
  let timer;
  const addresses = await Promise.race([
    dns.lookup(hostname, { all: true, family: 4, verbatim: true }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('website DNS lookup timed out')), 3_000);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
  if (!addresses.length || addresses.some(({ address }) => !isPublicIPv4(address))) {
    throw new Error('website resolves to a private or reserved address');
  }
  return addresses[0].address;
}

export async function validatePublicMonitorUrl(value) {
  const url = normalizeMonitorUrl(value);
  await resolvePublicIPv4(url.hostname);
  return url;
}

function requestOnce(url, pinnedAddress, timeoutMs) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, {
      method: 'GET',
      agent: false,
      maxHeaderSize: 16 * 1024,
      lookup: (_hostname, _options, callback) => callback(null, pinnedAddress, 4),
      servername: url.hostname,
      headers: {
        'User-Agent': 'WioBrowseCloud-Monitor/1.0',
        Range: 'bytes=0-0',
        Accept: '*/*',
      },
      timeout: timeoutMs,
    }, (response) => {
      const status = response.statusCode || 0;
      const location = response.headers.location;
      response.destroy();
      resolve({ status, location });
    });
    request.on('timeout', () => request.destroy(new Error('website check timed out')));
    request.on('error', reject);
    request.end();
  });
}

function requestTextOnce(url, pinnedAddress, timeoutMs, maxBytes) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, {
      method: 'GET',
      agent: false,
      maxHeaderSize: 16 * 1024,
      lookup: (_hostname, _options, callback) => callback(null, pinnedAddress, 4),
      servername: url.hostname,
      headers: { 'User-Agent': 'WioBrowseCloud/1.0', Accept: 'application/json,text/plain' },
      timeout: timeoutMs,
    }, (response) => {
      if ((response.statusCode || 0) >= 300 && (response.statusCode || 0) < 400) {
        response.destroy();
        reject(new Error('redirects are not allowed for this service check'));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy(new Error('service response exceeded the size limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('service check timed out')));
    request.on('error', reject);
    request.end();
  });
}

export async function fetchPublicText(rawUrl, { timeoutMs = 5_000, maxBytes = 256 } = {}) {
  const url = await validatePublicMonitorUrl(rawUrl);
  return requestTextOnce(url, await resolvePublicIPv4(url.hostname), timeoutMs, maxBytes);
}

export async function checkWebsite(rawUrl, { timeoutMs = 5_000, fetchRequest = requestOnce } = {}) {
  const startedAt = performance.now();
  let url = normalizeMonitorUrl(rawUrl);
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const address = await resolvePublicIPv4(url.hostname);
    const response = await fetchRequest(url, address, timeoutMs);
    if (response.status >= 300 && response.status < 400 && response.location) {
      if (redirect === 3) throw new Error('website redirected too many times');
      url = normalizeMonitorUrl(new URL(response.location, url).href);
      continue;
    }
    return { status: response.status, latencyMs: Math.round(performance.now() - startedAt) };
  }
  throw new Error('website redirected too many times');
}
