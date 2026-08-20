import { describe, expect, it } from 'vitest';
import * as formDataUtils from '../lib/utils/formData';
import { buildAssetFormData, buildPosterReplaceFormData } from '../lib/utils/formData';

function fakeFile(name: string): File {
	return new File(['dummy'], name, { type: 'application/octet-stream' });
}

describe('inline asset FormData', () => {
	it('contains exactly the narrow kind and one file', () => {
		const fd = buildAssetFormData('IMAGE', fakeFile('photo.png'));
		expect(fd.get('kind')).toBe('IMAGE');
		expect(fd.get('file')).not.toBeNull();
		expect([...fd.entries()]).toHaveLength(2);
	});

	it('has no generic project submit FormData compatibility helper', () => {
		expect('buildSubmitFormData' in formDataUtils).toBe(false);
	});
});

describe('buildPosterReplaceFormData', () => {
	it('contains only the poster field', () => {
		const fd = buildPosterReplaceFormData(fakeFile('new-poster.png'));
		expect(fd.get('poster')).not.toBeNull();
		expect([...fd.entries()]).toHaveLength(1);
	});
});
