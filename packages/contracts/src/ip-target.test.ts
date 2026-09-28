import { describe, expect, it } from 'vitest';
import { compileIpTarget, normalizeIpTarget } from './ip-target.js';

describe('IP target normalization and matching', () => {
	it.each([
		['192.0.2.129/24', '192.0.2.0/24'], ['192.0.2.1/32', '192.0.2.1'],
		['2001:0DB8:0:0:1::1234/64', '2001:db8::/64'], ['2001:db8::1/128', '2001:db8::1'],
		['::ffff:192.0.2.129/120', '192.0.2.0/24'], ['::FFFF:c000:201', '192.0.2.1'],
		['0.0.0.1/0', '0.0.0.0/0'], ['2001:db8::1/0', '::/0'],
	])('normalizes %s', (input, expected) => expect(normalizeIpTarget(input)).toBe(expected));
	it.each(['127.1', '127.00.0.1', '0x7f000001', '2130706433', '256.0.0.1', '1.2.3.4:80', '[::1]:80', 'localhost', '1.2.3.4/-1', '1.2.3.4/33', '::1/129', '::1/01', '::1/1/2', 'fe80::1%eth0', '::ffff:192.0.2.1/95', '::ffff:192.00.2.1', ''])('rejects %s', (input) => expect(() => normalizeIpTarget(input)).toThrow());
	it('checks both families at network boundaries, including mapped client addresses', () => {
		const v4 = compileIpTarget('192.0.2.129/25');
		for (const address of ['192.0.2.128', '192.0.2.255', '::ffff:192.0.2.255']) expect(v4(address)).toBe(true);
		for (const address of ['192.0.2.127', '192.0.3.0', '2001:db8::1']) expect(v4(address)).toBe(false);
		const v6 = compileIpTarget('2001:db8::2/127');
		expect(v6('2001:db8::2')).toBe(true);
		expect(v6('2001:db8::3')).toBe(true);
		expect(v6('2001:db8::1')).toBe(false);
		expect(v6('2001:db8::4')).toBe(false);
	});
});
