import { isMaterialKind, MATERIAL_MAX_BYTES } from './material-policy.js';
import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { Writable } from 'node:stream';
import { fileTypeFromBuffer } from 'file-type';
import { materializeAndValidateCompletedSource } from '../admin/game-upload/source-identity.js';
import type { AssetUploadSessionRecord, AssetUploadValidationStorage } from './ports.js';

const DOCUMENT_MIMES: Record<string, string> = {
	pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
	rtf: 'application/rtf',
};
const OLE_DOCUMENTS: Record<string, { marker: string; mime: string }> = {
	doc: { marker: 'WordDocument', mime: 'application/msword' },
	xls: { marker: 'Workbook', mime: 'application/vnd.ms-excel' },
	ppt: { marker: 'PowerPoint Document', mime: 'application/vnd.ms-powerpoint' },
};

export async function validateMaterialContent(kind: 'DOCUMENT' | 'ATTACHMENT', originalName: string, bytes: Buffer): Promise<string> {
	if (bytes.length === 0 || bytes.length > MATERIAL_MAX_BYTES) throw new Error('Invalid material size');
	if (kind === 'ATTACHMENT') return 'application/octet-stream';
	const extension = extname(originalName).slice(1).toLowerCase();
	if (extension === 'txt' || extension === 'md' || extension === 'markdown') {
		if (await fileTypeFromBuffer(bytes)) throw new Error('Invalid text document content: binary format does not match extension');
		const encodings = bytes[0] === 0xff && bytes[1] === 0xfe ? ['utf-16le']
			: bytes[0] === 0xfe && bytes[1] === 0xff ? ['utf-16be'] : ['utf-8', 'euc-kr'];
		const isText = encodings.some((encoding) => {
			try { return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(new TextDecoder(encoding, { fatal: true }).decode(bytes)); }
			catch { return false; }
		});
		if (!isText) throw new Error('Invalid text document content');
		return extension === 'txt' ? 'text/plain' : 'text/markdown';
	}
	const ole = OLE_DOCUMENTS[extension];
	if (ole) {
		if (!bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex')) || !bytes.includes(Buffer.from(ole.marker + '\0', 'utf16le'))) throw new Error('Invalid Office document content for extension');
		return ole.mime;
	}
	const expected = DOCUMENT_MIMES[extension];
	if (!expected) throw new Error('Invalid document extension; use ATTACHMENT for supplementary files');
	const actual = await fileTypeFromBuffer(bytes);
	if (actual?.ext !== extension || (actual.mime !== expected && !(extension === 'rtf' && actual.mime === 'text/rtf')) ) throw new Error('Invalid document content for extension');
	return expected;
}

/** Reuses the completed-source identity verifier before inspecting any trusted content. */
export async function validateMaterialSource(input: {
	session: AssetUploadSessionRecord; source: Awaited<ReturnType<AssetUploadValidationStorage['stream']>>; signal?: AbortSignal;
}) {
	const { session } = input;
	if (!isMaterialKind(session.kind)) throw new Error('Invalid material kind');
	const chunks: Buffer[] = [];
	await materializeAndValidateCompletedSource({
		...session,
		sourceIdentityBlockManifest: (typeof session.sourceIdentityBlockManifest === 'string' ? Buffer.from(session.sourceIdentityBlockManifest, 'base64') : Buffer.concat((session.sourceIdentityBlockManifest as string[]).map((digest) => Buffer.from(digest, 'hex')))),
		source: input.source.body,
		destination: new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }),
		physicalByteLimit: MATERIAL_MAX_BYTES, signal: input.signal,
	});
	const bytes = Buffer.concat(chunks);
	return { mimeType: await validateMaterialContent(session.kind, session.originalName, bytes), checksum: createHash('sha256').update(bytes).digest('hex') };
}
