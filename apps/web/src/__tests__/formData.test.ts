import { describe, it, expect } from 'vitest';
import {
	buildSubmitFormData,
	buildAssetFormData,
	buildPosterReplaceFormData,
} from '../lib/utils/formData';
import type { SubmitProjectPayloadInput } from '../contracts/schemas';

function fakePayload(): SubmitProjectPayloadInput {
	return {
		exhibitionId: 1,
		title: 'Test Game',
		summary: 'A test',
		members: [{ name: '홍길동', studentId: '20251234' }],
	};
}

function fakeFile(name: string): File {
	return new File(['dummy'], name, { type: 'application/octet-stream' });
}

// ── buildSubmitFormData ─────────────────────────────────────

describe('buildSubmitFormData', () => {
	it('appends payload as parseable JSON string', () => {
		const payload = fakePayload();
		const fd = buildSubmitFormData(payload, {});
		const raw = fd.get('payload') as string;
		expect(JSON.parse(raw)).toEqual(payload);
	});

	it('appends poster when provided', () => {
		const fd = buildSubmitFormData(fakePayload(), { poster: fakeFile('poster.png') });
		expect(fd.get('poster')).not.toBeNull();
	});

	it('does not append poster when not provided', () => {
		const fd = buildSubmitFormData(fakePayload(), {});
		expect(fd.get('poster')).toBeNull();
	});

	it('appends multiple images as images[]', () => {
		const images = [fakeFile('a.png'), fakeFile('b.png'), fakeFile('c.png')];
		const fd = buildSubmitFormData(fakePayload(), { images });
		expect(fd.getAll('images[]')).toHaveLength(3);
	});

	it('appends gameFile when provided', () => {
		const fd = buildSubmitFormData(fakePayload(), { gameFile: fakeFile('game.zip') });
		expect(fd.get('gameFile')).not.toBeNull();
	});

	it('appends videoFile when provided', () => {
		const fd = buildSubmitFormData(fakePayload(), { videoFile: fakeFile('demo.mp4') });
		expect(fd.get('videoFile')).not.toBeNull();
	});

	it('contains only payload when no files provided', () => {
		const fd = buildSubmitFormData(fakePayload(), {});
		const entries = [...fd.entries()];
		expect(entries).toHaveLength(1);
		expect(entries[0][0]).toBe('payload');
	});
});

// ── buildAssetFormData ──────────────────────────────────────

describe('buildAssetFormData', () => {
	it('contains kind and file fields', () => {
		const fd = buildAssetFormData('IMAGE', fakeFile('photo.png'));
		expect(fd.get('kind')).toBe('IMAGE');
		expect(fd.get('file')).not.toBeNull();
	});

	it('has exactly 2 entries', () => {
		const fd = buildAssetFormData('POSTER', fakeFile('poster.jpg'));
		expect([...fd.entries()]).toHaveLength(2);
	});
});

// ── buildPosterReplaceFormData ──────────────────────────────

describe('buildPosterReplaceFormData', () => {
	it('contains poster field', () => {
		const fd = buildPosterReplaceFormData(fakeFile('new-poster.png'));
		expect(fd.get('poster')).not.toBeNull();
	});

	it('has exactly 1 entry', () => {
		const fd = buildPosterReplaceFormData(fakeFile('poster.png'));
		expect([...fd.entries()]).toHaveLength(1);
	});
});
