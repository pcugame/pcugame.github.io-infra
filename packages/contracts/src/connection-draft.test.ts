import { describe, expect, it } from 'vitest';
import { draftOrigin, emptyConnectionDraft } from './connection-draft.js';
import { CONNECTION_PROFILES } from './connection-profiles.js';
import { ConnectionRule, CreateWebglNetworkRequestSchema } from './webgl-network.js';

describe('new connection drafts', () => {
 it.each(['example.com', ' EXAMPLE.com '])('normalizes host %s with explicit all ports', host => {
  expect(draftOrigin({ ...emptyConnectionDraft, host })).toBe('https://example.com:*');
 });
 it.each(['443', ' 00443 '])('normalizes specific 443 without broadening %s', port => {
  expect(draftOrigin({ ...emptyConnectionDraft, host: 'example.com', ports: 'specific', port })).toBe('https://example.com');
 });
 it.each(['https://example.com', 'wss://example.com', 'example.com:443', 'example.com:*', '*.example.com', 'https://u:p@example.com', 'example.com/path', 'example.com?', 'example.com#', 'exa\nmple.com', '%65xample.com', 'example.com; connect-src *', 'localhost', '127.0.0.1'])('rejects misplaced syntax or non-public host %s in every scope', host => {
  for (const scope of ['exact', 'subdomains'] as const) {
   for (const ports of ['all', 'specific'] as const) {
    expect(() => draftOrigin({ ...emptyConnectionDraft, host, scope, ports })).toThrow();
   }
  }
 });
 it.each(['', '0', '65536', '-1', '1.5', '443abc', '*', '4e3'])('rejects invalid specific port %s', port => {
  expect(() => draftOrigin({ ...emptyConnectionDraft, host: 'example.com', ports: 'specific', port })).toThrow('특정 포트');
 });
 it('keeps modes, host scope and ports independent', () => {
  for (const mode of ['HTTPS', 'WSS'] as const) {
   for (const scope of ['exact', 'subdomains'] as const) {
    for (const port of ['1', '443', '8443', '65535', '*']) {
     const origin = draftOrigin({ host: 'example.com', mode, scope, ports: port === '*' ? 'all' : 'specific', port });
     const rule = ConnectionRule.parse(origin);
     expect(rule.mode).toBe(mode);
     expect(rule.port).toBe(port === '*' ? '*' : Number(port));
     expect(rule.includesHostname('example.com')).toBe(scope === 'exact');
     expect(rule.includesHostname('a.example.com')).toBe(scope === 'subdomains');
    }
   }
  }
 });
 it.each(['com', 'github.io'])('rejects wildcard suffix %s', host => {
  expect(() => draftOrigin({ ...emptyConnectionDraft, host, scope: 'subdomains' })).toThrow();
 });
 it('uses canonical request contracts for every service example without port duplicates', () => {
  for (const profile of CONNECTION_PROFILES) {
   expect(new Set(profile.examples).size).toBe(profile.examples.length);
   for (const origin of profile.examples) {
    const rule = ConnectionRule.parse(origin);
    expect(rule.port).toBe('*');
    expect(CreateWebglNetworkRequestSchema.safeParse({ origin, mode: rule.mode, purpose: 'Game', cors: 'Configured' }).success).toBe(true);
   }
  }
 });
});

it('never passes CSP host or port wildcard syntax into a platform URL parser', () => {
 const PlatformURL = globalThis.URL;
 class BrowserURL extends PlatformURL {
  constructor(input: string | URL, base?: string | URL) {
   if (String(input).includes('*')) throw new Error('CSP wildcard is not a URL');
   super(input, base);
  }
 }
 globalThis.URL = BrowserURL;
 try {
  for (const origin of ['https://*.example.com:*', 'wss://*.example.com:*', 'wss://*.example.com:8443']) {
   expect(ConnectionRule.parse(origin).origin).toBe(origin);
  }
 } finally { globalThis.URL = PlatformURL; }
});
