import { describe, expect, it } from 'vitest';
import {
	androidManifest,
	androidBundleManifest,
	protobufFields,
	dexStructure,
} from '../modules/build-package/android.js';
import { bundleExecutable } from '../modules/build-package/apple.js';

function binaryManifest() {
	const strings = ['manifest', 'application'];
	const text = Buffer.concat(
		strings.map((s) => Buffer.concat([Buffer.from([s.length, s.length]), Buffer.from(s), Buffer.from([0])])),
	);
	const pool = Buffer.alloc(36);
	pool.writeUInt16LE(1);
	pool.writeUInt16LE(28, 2);
	pool.writeUInt32LE(36 + text.length, 4);
	pool.writeUInt32LE(2, 8);
	pool.writeUInt32LE(0x100, 16);
	pool.writeUInt32LE(36, 20);
	pool.writeUInt32LE(11, 32);
	const node = (index: number, start: boolean) => {
		const bytes = Buffer.alloc(start ? 36 : 24);
		bytes.writeUInt16LE(start ? 0x102 : 0x103);
		bytes.writeUInt16LE(16, 2);
		bytes.writeUInt32LE(bytes.length, 4);
		bytes.writeUInt32LE(index, 20);
		if (start) {
			bytes.writeUInt16LE(20, 24);
			bytes.writeUInt16LE(20, 26);
		}
		return bytes;
	};
	const body = Buffer.concat([pool, text, node(0, true), node(1, true), node(1, false), node(0, false)]);
	const header = Buffer.alloc(8);
	header.writeUInt16LE(3);
	header.writeUInt16LE(8, 2);
	header.writeUInt32LE(8 + body.length, 4);
	return Buffer.concat([header, body]);
}
const field = (n: number, value: Buffer | string) => {
	const bytes = Buffer.from(value);
	return Buffer.concat([Buffer.from([(n << 3) | 2, bytes.length]), bytes]);
};
describe('bounded mobile application manifests', () => {
	it('parses Android binary XML and rejects truncated chunks', () => {
		const bytes = binaryManifest();
		expect(androidManifest(bytes)).toEqual({ application: true, unsupported: false });
		expect(() => androidManifest(bytes.subarray(0, bytes.length - 1))).toThrow('invalid');
		bytes.writeUInt32LE(0xffffffff, 12);
		expect(() => androidManifest(bytes)).toThrow('invalid');
	});
	it('parses AAPT2 protobuf XML and rejects invalid field ranges', () => {
		const application = field(1, field(3, 'application'));
		const manifest = field(1, Buffer.concat([field(3, 'manifest'), field(5, application)]));
		expect(androidBundleManifest(manifest)).toEqual({ application: true, unsupported: false });
		expect(() => protobufFields(Buffer.from([10, 20, 1]))).toThrow('invalid');
		expect(() => androidBundleManifest(field(1, field(3, 'video')))).toThrow('root');
	});
	it('distinguishes unsupported DEX versions from a fake DEX header', () => {
		const bytes = Buffer.alloc(160);
		bytes.write('dex\n039\0');
		bytes.writeUInt32LE(160, 32);
		bytes.writeUInt32LE(112, 36);
		bytes.writeUInt32LE(0x12345678, 40);
		bytes.writeUInt32LE(1, 96);
		bytes.writeUInt32LE(112, 100);
		bytes.writeUInt32LE(16, 104);
		bytes.writeUInt32LE(144, 108);
		expect(dexStructure(bytes, 160)).toBe('valid');
		expect(dexStructure(bytes, 100)).toBe('invalid');
		bytes.write('999', 4);
		expect(dexStructure(bytes, 160)).toBe('unsupported');
	});
	it('reads XML plist executable names without evaluating entities', () => {
		expect(
			bundleExecutable(
				Buffer.from(
					'<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>한글 Game</string></dict></plist>',
				),
			),
		).toBe('한글 Game');
		expect(
			bundleExecutable(
				Buffer.from('<plist><dict><key>CFBundleExecutable</key><string>../outside</string></dict></plist>'),
			),
		).toBeNull();
		expect(() => bundleExecutable(Buffer.from('<plist><dict>'))).toThrow('invalid');
	});
	it('ignores exporter indentation between plist keys and values', () => {
		expect(
			bundleExecutable(
				Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>English</string>
    <key>CFBundleExecutable</key>
    <string>한글 Game</string>
  </dict>
</plist>`),
			),
		).toBe('한글 Game');
	});
	it('reads a binary plist root dictionary and rejects an out-of-range object table', () => {
		const bytes = Buffer.from(
			'62706c6973743030d101025f1012434642756e646c6545786563757461626c655447616d65080b200000000000000101000000000000000300000000000000000000000000000025',
			'hex',
		);
		expect(bundleExecutable(bytes)).toBe('Game');
		bytes.writeBigUInt64BE(0xffffffffffffffffn, bytes.length - 8);
		expect(() => bundleExecutable(bytes)).toThrow('invalid');
	});
});
