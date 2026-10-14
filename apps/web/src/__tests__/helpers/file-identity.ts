import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, vi } from 'vitest';

/** Supply browser APIs absent in jsdom; keep the production identity algorithm. */
export function setupFileIdentityEnvironment() {
	let installedArrayBuffer = false;
	beforeEach(() => {
		vi.stubGlobal('crypto', webcrypto);
		if (!Blob.prototype.arrayBuffer) {
			installedArrayBuffer = true;
			Object.defineProperty(Blob.prototype, 'arrayBuffer', { configurable: true, value(this: Blob) {
				return new Promise<ArrayBuffer>((resolve, reject) => {
					const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer);
					reader.onerror = () => reject(reader.error); reader.readAsArrayBuffer(this);
				});
			} });
		}
	});
	afterEach(() => {
		if (installedArrayBuffer) { delete (Blob.prototype as Partial<Blob>).arrayBuffer; installedArrayBuffer = false; }
		vi.unstubAllGlobals(); vi.restoreAllMocks();
	});
}
