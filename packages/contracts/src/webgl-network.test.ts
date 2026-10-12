import { AllowWebglNetworkBatchSchema } from './webgl-network.js';
import { describe, expect, it } from 'vitest';
import { CreateWebglNetworkBatchSchema, ConnectionRule, ProjectConnectionPolicy, CreateWebglNetworkRequestSchema, validateWebglNetworkOrigin } from './webgl-network.js';

describe('exact browser connection origins', () => {
 it('accepts canonical public secure origins and transport-specific ports', () => {
  for (const origin of ['https://api.example.com', 'https://api.example.com:8443', 'https://8.8.8.8', 'https://[2606:4700:4700::1111]']) expect(validateWebglNetworkOrigin(origin, 'HTTPS'), origin).toBe(true);
  expect(validateWebglNetworkOrigin('wss://socket.example.com', 'WSS')).toBe(true);
 });
 it('rejects noncanonical, privileged-network and injection shapes without DNS', () => {
  for (const origin of [
   'http://api.example.com', 'wss://api.example.com', 'https://API.example.com', 'https://api.example.com/',
   'https://api.example.com:443', 'https://api.example.com/path', 'https://api.example.com?x=1', 'https://api.example.com#x',
   'https://user@api.example.com', "https://api.example.com; script-src *", 'https://api.example.com\n',
   'https://localhost', 'https://service.localhost', 'https://host.local', 'https://nas.internal', 'https://router.home.arpa',
   'https://127.0.0.1', 'https://10.0.0.1', 'https://172.16.0.1', 'https://192.168.1.1', 'https://169.254.1.1',
   'https://100.64.0.1', 'https://0.0.0.0', 'https://192.0.2.1', 'https://198.51.100.1', 'https://203.0.113.1',
   'https://224.0.0.1', 'https://240.0.0.1', 'https://[::]', 'https://[::1]', 'https://[fc00::1]', 'https://[fe80::1]',
   'https://[2001:db8::1]', 'https://[ff02::1]', 'https://[::ffff:8.8.8.8]', 'https://2130706433', 'https://0177.0.0.1',
   'https://[4000::1]', 'https://[3fff::1]', `https://${'a'.repeat(64)}.example.com`, `https://${Array(5).fill('a'.repeat(60)).join('.')}`,
  ]) expect(validateWebglNetworkOrigin(origin, 'HTTPS'), origin).toBe(false);
 });
 it('requires purpose and actual CORS/socket configuration description', () => {
  const input = { origin: 'https://api.example.com', mode: 'HTTPS', purpose: 'Scores', cors: 'Allow the game origin; anonymous read access' };
  expect(CreateWebglNetworkRequestSchema.parse(input)).toEqual(input);
  expect(CreateWebglNetworkRequestSchema.safeParse({ ...input, cors: '' }).success).toBe(false);
  expect(CreateWebglNetworkRequestSchema.safeParse({ ...input, cors: true }).success).toBe(false);
  expect(CreateWebglNetworkRequestSchema.safeParse({ ...input, unknown: true }).success).toBe(false);
 });
});

describe('subdomain policies', () => {
 it('keeps root, protocol, port and lookalike domains separate', () => {
  const rule = ConnectionRule.parse('wss://*.example.com:8443');
  expect(rule.includesHostname('game.example.com')).toBe(true);
  expect(rule.includesHostname('nested.game.example.com')).toBe(true);
  for (const host of ['example.com', 'notexample.com', 'example.com.evil.com']) expect(rule.includesHostname(host)).toBe(false);
  expect(() => new ProjectConnectionPolicy(['wss://*.example.com', 'wss://example.com', 'https://*.example.com', 'wss://*.example.com:8443'])).not.toThrow();
  expect(() => new ProjectConnectionPolicy(['wss://*.example.com', 'wss://a.example.com'])).toThrow(/overlap/);
  expect(() => new ProjectConnectionPolicy(['wss://*.example.com', 'wss://*.a.example.com'])).toThrow(/overlap/);
  expect(() => new ProjectConnectionPolicy(['wss://*.example.com'], ['api.example.com'])).toThrow(/storage/);
 });
 it('rejects public and private suffixes, invalid ports and arbitrary CSP syntax', () => {
  for (const origin of ['wss://*.com', 'wss://*.co.uk', 'wss://*.github.io', 'wss://*.appspot.com', 'wss://*.unknownsuffix', 'wss://*', 'wss://example.com:0', 'wss://example.com/*', 'wss://*.127.0.0.1', 'wss://foo.*.example.com', "wss://*.example.com; report-uri https://evil.com"]) expect(() => ConnectionRule.parse(origin), origin).toThrow();
  expect(ConnectionRule.parse('https://*.tenant.github.io').toCsp()).toBe('https://*.tenant.github.io');
 });
});


describe('explicit all-port policies', () => {
 it('preserves canonical input, transport and default/numeric port meanings', () => {
  for (const mode of ['HTTPS', 'WSS'] as const) {
   for (const host of ['example.com', '*.example.com', '8.8.8.8', '[2606:4700:4700::1111]']) {
    const origin = `${mode.toLowerCase()}://${host}:*`;
    const rule = ConnectionRule.parse(origin, mode);
    expect(rule.port).toBe('*'); expect(rule.toCsp()).toBe(origin);
    expect(CreateWebglNetworkRequestSchema.parse({ origin, mode, purpose: 'Game', cors: 'Configured' }).origin).toBe(origin);
   }
  }
  expect(ConnectionRule.parse('https://example.com').port).toBe(443);
  expect(ConnectionRule.parse('https://example.com:8443').port).toBe(8443);
 });
 it('rejects malformed all-port sources through the existing canonical/public-host boundary', () => {
  for (const origin of [
   'https://example.com:443:*', 'https://example.com:8443:*', 'https://example.com:**',
   'https://example.com:*/', 'https://example.com:*?x=1', 'https://example.com:*#x',
   'https://example.com/path:*', 'https://user@example.com:*', 'https://EXAMPLE.com:*',
   'https://example.com:*\n', 'https://example.com:*; script-src *', 'http://example.com:*',
   'https://127.0.0.1:*', 'https://[::1]:*', 'https://*.github.io:*', 'https://*.com:*',
   'https://foo.*.example.com:*', 'https://localhost:*', 'https://example.com:65536',
  ]) expect(validateWebglNetworkOrigin(origin, 'HTTPS'), origin).toBe(false);
  expect(validateWebglNetworkOrigin('wss://example.com:*', 'HTTPS')).toBe(false);
 });
 it('detects overlap symmetrically while preserving transport, root exclusion and disjoint ports', () => {
  for (const [a, b, overlaps] of [
   ['wss://example.com:*', 'wss://example.com', true],
   ['wss://example.com:*', 'wss://example.com:8443', true],
   ['wss://example.com:*', 'wss://example.com:*', true],
   ['wss://*.example.com:*', 'wss://a.example.com:8443', true],
   ['wss://*.example.com:*', 'wss://*.a.example.com', true],
   ['wss://*.example.com:8443', 'wss://*.example.com:*', true],
   ['wss://*.example.com:*', 'wss://example.com:*', false],
   ['wss://example.com:*', 'https://example.com:*', false],
   ['wss://example.com:*', 'wss://other.example.com:*', false],
   ['wss://example.com', 'wss://example.com:8443', false],
  ] as const) {
   expect(ConnectionRule.parse(a).overlaps(ConnectionRule.parse(b))).toBe(overlaps);
   expect(ConnectionRule.parse(b).overlaps(ConnectionRule.parse(a))).toBe(overlaps);
   if (overlaps) expect(() => new ProjectConnectionPolicy([a, b])).toThrow(/overlap/);
   else expect(() => new ProjectConnectionPolicy([a, b])).not.toThrow();
  }
  expect(() => new ProjectConnectionPolicy(['https://*.example.com:*'], ['api.example.com'])).toThrow(/storage/);
  expect(() => new ProjectConnectionPolicy(['wss://api.example.com:*'], ['api.example.com'])).toThrow(/storage/);
 });
});

describe('connection batches', () => {
 const item = (origin: string) => ({ origin, mode: 'HTTPS', purpose: 'Bundles', cors: 'Configured' });
 it('requires one to sixteen complete entries', () => {
  expect(CreateWebglNetworkBatchSchema.safeParse({ items: [] }).success).toBe(false);
  const items = Array.from({ length: 16 }, (_, i) => item(`https://host${i}.example.com:*`));
  expect(CreateWebglNetworkBatchSchema.parse({ items }).items).toHaveLength(16);
  expect(CreateWebglNetworkBatchSchema.safeParse({ items: [...items, item('https://extra.example.com')] }).success).toBe(false);
  expect(CreateWebglNetworkBatchSchema.safeParse({ items: [items[0], { ...items[1], cors: '' }] }).success).toBe(false);
 });
 it.each([['https://same.example.com', 'https://same.example.com'], ['https://*.example.com:*', 'https://game.example.com:8443']])('identifies both overlapping items: %s and %s', (a, b) => {
  const result = CreateWebglNetworkBatchSchema.safeParse({ items: [item(a), item(b)] });
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues.map(issue => issue.path)).toEqual([['items', 0, 'origin'], ['items', 1, 'origin']]);
 });
});

it('requires a direct-allow reason and retains batch overlap validation', () => {
 const item = { origin: 'https://game.example.com:*', mode: 'HTTPS', purpose: 'Game service', cors: 'Configured' };
 expect(AllowWebglNetworkBatchSchema.safeParse({ items: [item], reason: 'Verified service' }).success).toBe(true);
 for (const reason of ['', '   ', undefined]) expect(AllowWebglNetworkBatchSchema.safeParse({ items: [item], reason }).success).toBe(false);
 expect(AllowWebglNetworkBatchSchema.safeParse({ items: [item, item], reason: 'Reviewed' }).success).toBe(false);
});
