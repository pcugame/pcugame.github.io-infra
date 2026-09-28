import ipaddr from 'ipaddr.js';

/** Strict IP/CIDR input shared by admin preview and enforcement. */
export function normalizeIpTarget(input: string): string {
	const value = input.trim();
	if (!value || /[\s%[\]]/.test(value)) throw new Error('Invalid IP address or CIDR');
	const parts = value.split('/');
	if (parts.length > 2) throw new Error('Invalid CIDR');
	const literal = parts[0]!;
	// ipaddr accepts legacy octal/hex/shorthand IPv4; administrator input must not.
	const dotted = literal.includes('.') ? literal.slice(literal.lastIndexOf(':') + 1) : literal;
	if ((!literal.includes(':') || literal.includes('.')) && !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(dotted)) {
		throw new Error('Expected a four-part decimal IPv4 address');
	}
	let address = ipaddr.parse(literal);
	let width = address.kind() === 'ipv4' ? 32 : 128;
	let prefix = width;
	if (parts.length === 2) {
		if (!/^(?:0|[1-9]\d*)$/.test(parts[1]!)) throw new Error('Invalid CIDR prefix');
		prefix = Number(parts[1]);
		if (prefix > width) throw new Error('Invalid CIDR prefix');
	}
	if (address instanceof ipaddr.IPv6 && address.isIPv4MappedAddress()) {
		if (prefix < 96) throw new Error('Mapped IPv4 CIDR prefix must be at least 96');
		address = address.toIPv4Address();
		prefix -= 96;
		width = 32;
	}
	const bytes = address.toByteArray().map((byte, index) => {
		const bits = Math.max(0, Math.min(8, prefix - index * 8));
		return byte & (256 - 2 ** (8 - bits));
	});
	const network = ipaddr.fromByteArray(bytes).toString();
	return prefix === width ? network : `${network}/${prefix}`;
}

/** Compile once when installing a ban; client addresses use the same normalization. */
export function compileIpTarget(input: string): (address: string) => boolean {
	const normalized = normalizeIpTarget(input);
	const [network, prefix] = normalized.includes('/')
		? ipaddr.parseCIDR(normalized)
		: [ipaddr.parse(normalized), normalized.includes(':') ? 128 : 32] as const;
	return (inputAddress) => {
		const normalizedAddress = normalizeIpTarget(inputAddress);
		if (normalizedAddress.includes('/')) return false;
		const address = ipaddr.parse(normalizedAddress);
		return address.kind() === network.kind() && address.match(network, prefix);
	};
}
