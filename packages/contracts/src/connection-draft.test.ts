import { describe, expect, it } from 'vitest';
import { draftOrigin, emptyConnectionDraft } from './connection-draft.js';
import { CONNECTION_PROFILES } from './connection-profiles.js';
import { ConnectionRule, CreateWebglNetworkRequestSchema } from './webgl-network.js';

describe('new connection drafts', () => {
 it.each(['example.com', 'https://EXAMPLE.com', 'https://example.com/', 'https://example.com:*'])('defaults %s to explicit all ports', host => {
  expect(draftOrigin({ ...emptyConnectionDraft, host })).toBe('https://example.com:*');
 });
 it.each(['example.com:443', 'https://EXAMPLE.com:443/'])('normalizes matching explicit 443 without broadening %s', host => {
  expect(draftOrigin({ ...emptyConnectionDraft, host, ports: 'specific' })).toBe('https://example.com');
  expect(() => draftOrigin({ ...emptyConnectionDraft, host })).toThrow('포트 정책');
 });
 it.each(['https://u:p@example.com', 'https://@example.com', 'https://example.com/path', 'https://example.com/.', 'https://example.com?', 'https://example.com#', 'https://example.com\\', 'https://exa\nmple.com', 'https://%65xample.com', 'https://example.com:0', 'https://example.com:65536', 'localhost', '*.com', '*.github.io'])('does not sanitize forbidden input %s', host => {
  expect(() => draftOrigin({ ...emptyConnectionDraft, host })).toThrow();
 });
 it('keeps modes, host scope and ports independent', () => {
  expect(() => draftOrigin({ ...emptyConnectionDraft, host: 'wss://example.com:*' })).toThrow('방식');
  expect(() => draftOrigin({ ...emptyConnectionDraft, host: '*.example.com:*' })).toThrow('하위 도메인');
  const origin = draftOrigin({ ...emptyConnectionDraft, host: 'wss://*.example.com:8443', mode: 'WSS', scope: 'subdomains', ports: 'specific', port: '8443' });
  expect(origin).toBe('wss://*.example.com:8443');
  expect(ConnectionRule.parse(origin).includesHostname('example.com')).toBe(false);
  expect(() => draftOrigin({ ...emptyConnectionDraft, host: 'https://example.com:*', ports: 'specific' })).toThrow('포트 정책');
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
