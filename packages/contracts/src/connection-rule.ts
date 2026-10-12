import ipaddr from 'ipaddr.js';
import { parse } from 'tldts';

/** A canonical CSP connect source, never a URL to fetch on the server. */
export class ConnectionRule {
 private constructor(
  readonly origin: string, readonly mode: 'HTTPS' | 'WSS',
  readonly hostname: string, readonly subdomains: boolean, readonly port: number | '*',
 ) { Object.freeze(this); }
 static parse(value: string, mode?: 'HTTPS' | 'WSS'): ConnectionRule {
  // URL cannot parse CSP's wildcard port. Remove only a terminal :*, then
  // apply the same canonical URL and public-host checks as numeric rules.
  const allPorts = value.endsWith(':*');
  const canonicalOrigin = allPorts ? value.slice(0, -2) : value;
  const url = new URL(canonicalOrigin);
  const actualMode = url.protocol === 'https:' ? 'HTTPS' : url.protocol === 'wss:' ? 'WSS' : null;
  if (!actualMode || (mode && actualMode !== mode) || value.length > 512 || url.origin !== canonicalOrigin
   || (allPorts && url.port !== '')
   || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port === '0') throw new Error('Invalid connection rule');
  const subdomains = url.hostname.startsWith('*.');
  const hostname = subdomains ? url.hostname.slice(2) : url.hostname;
  const host = hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(host)) {
   const address = ipaddr.parse(host);
   if (subdomains || address.range() !== 'unicast' || (address instanceof ipaddr.IPv6
    && (!address.match(ipaddr.IPv6.parse('2000::'), 3) || address.match(ipaddr.IPv6.parse('3fff::'), 20)))) throw new Error('Non-public address');
  } else {
   if (host.length > 253 || host.split('.').some(label => label.length > 63)
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host)
    || /(?:^|\.)(?:localhost|local|internal|lan|home)$/.test(host) || host.endsWith('.home.arpa')) throw new Error('Invalid public hostname');
   if (subdomains) {
    const suffix = parse(host, { allowPrivateDomains: true });
    if (!suffix.domain || (!suffix.isIcann && !suffix.isPrivate)) throw new Error('Wildcard must be below a public/private suffix');
   }
  }
  return new ConnectionRule(value, actualMode, hostname, subdomains, allPorts ? '*' : Number(url.port || 443));
 }
 includesHostname(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, '');
  return this.subdomains ? normalized.endsWith('.' + this.hostname) : normalized === this.hostname;
 }
 overlaps(other: ConnectionRule): boolean {
  if (this.mode !== other.mode || (this.port !== '*' && other.port !== '*' && this.port !== other.port)) return false;
  if (this.subdomains && other.subdomains) return this.hostname === other.hostname
   || this.includesHostname(other.hostname) || other.includesHostname(this.hostname);
  if (this.subdomains) return this.includesHostname(other.hostname);
  if (other.subdomains) return other.includesHostname(this.hostname);
  return this.hostname === other.hostname;
 }
 toCsp(): string { return this.origin; }
}

export class ProjectConnectionPolicy {
 readonly rules: readonly ConnectionRule[];
 constructor(origins: readonly string[], protectedHosts: readonly string[] = []) {
  if (origins.length > 16) throw new Error('At most sixteen approved connection rules');
  const rules = origins.map(origin => ConnectionRule.parse(origin));
  for (const [index, rule] of rules.entries()) {
   if (protectedHosts.some(host => rule.includesHostname(host))) throw new Error('Site and storage hosts cannot be approved');
   if (rules.slice(0, index).some(previous => previous.overlaps(rule))) throw new Error('Connection rules overlap');
  }
  this.rules = Object.freeze(rules);
  Object.freeze(this);
 }
 connectSources(): readonly string[] { return this.rules.map(rule => rule.toCsp()); }
}
