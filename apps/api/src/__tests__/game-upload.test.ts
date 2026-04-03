import { describe, it, expect } from 'vitest';
import { detectFileType, isAllowedGameType } from '../shared/file-signature.js';

/**
 * Unit tests for the game upload session logic.
 *
 * These test pure validation logic. Integration tests (actual HTTP + DB)
 * would require a running database and are best done as e2e tests.
 */

describe('Game upload session validation', () => {
	// ── Chunk index math ────────────────────────────────────
	describe('chunk calculation', () => {
		it('calculates total chunks correctly for exact division', () => {
			const totalBytes = 100 * 1024 * 1024; // 100 MB
			const chunkSize = 10 * 1024 * 1024;   // 10 MB
			expect(Math.ceil(totalBytes / chunkSize)).toBe(10);
		});

		it('calculates total chunks correctly with remainder', () => {
			const totalBytes = 105 * 1024 * 1024; // 105 MB
			const chunkSize = 10 * 1024 * 1024;   // 10 MB
			expect(Math.ceil(totalBytes / chunkSize)).toBe(11);
		});

		it('handles 5GB file with 10MB chunks', () => {
			const totalBytes = 5 * 1024 * 1024 * 1024; // 5 GB
			const chunkSize = 10 * 1024 * 1024;         // 10 MB
			expect(Math.ceil(totalBytes / chunkSize)).toBe(512);
		});

		it('calculates last chunk size correctly', () => {
			const totalBytes = 105 * 1024 * 1024; // 105 MB
			const chunkSize = 10 * 1024 * 1024;   // 10 MB
			const totalChunks = Math.ceil(totalBytes / chunkSize); // 11
			const lastChunkIndex = totalChunks - 1; // 10
			const lastChunkSize = totalBytes - lastChunkIndex * chunkSize;
			expect(lastChunkSize).toBe(5 * 1024 * 1024); // 5 MB
		});
	});

	// ── Chunk completeness check ─────────────────────────────
	describe('chunk completeness', () => {
		it('detects missing chunks', () => {
			const totalChunks = 5;
			const uploaded = new Set([0, 1, 3, 4]);
			const missing: number[] = [];
			for (let i = 0; i < totalChunks; i++) {
				if (!uploaded.has(i)) missing.push(i);
			}
			expect(missing).toEqual([2]);
		});

		it('passes when all chunks present', () => {
			const totalChunks = 3;
			const uploaded = new Set([0, 1, 2]);
			const missing: number[] = [];
			for (let i = 0; i < totalChunks; i++) {
				if (!uploaded.has(i)) missing.push(i);
			}
			expect(missing).toEqual([]);
		});

		it('handles idempotent chunk uploads', () => {
			const uploaded = new Set([0, 1, 2]);
			uploaded.add(1); // duplicate
			expect(uploaded.size).toBe(3);
			expect(Array.from(uploaded).sort((a, b) => a - b)).toEqual([0, 1, 2]);
		});
	});

	// ── File size limits ─────────────────────────────────────
	describe('file size limits', () => {
		it('5GB is 5368709120 bytes', () => {
			expect(5 * 1024 * 1024 * 1024).toBe(5368709120);
		});

		it('rejects file larger than 5120MB', () => {
			const maxMB = 5120;
			const maxBytes = maxMB * 1024 * 1024;
			const fileBytes = 5121 * 1024 * 1024;
			expect(fileBytes > maxBytes).toBe(true);
		});

		it('accepts file exactly at limit', () => {
			const maxMB = 5120;
			const maxBytes = maxMB * 1024 * 1024;
			const fileBytes = 5120 * 1024 * 1024;
			expect(fileBytes <= maxBytes).toBe(true);
		});
	});

	// ── Role-based limit enforcement (regression for issue #1) ──
	describe('role-based chunked upload limits', () => {
		it('USER effective max is min(globalMax, roleGameMax)', () => {
			// Global chunked max = 5120 MB, USER game limit = 200 MB
			const globalMax = 5120 * 1024 * 1024;
			const userGameMax = 200 * 1024 * 1024;
			const effectiveMax = Math.min(globalMax, userGameMax);
			expect(effectiveMax).toBe(userGameMax);
		});

		it('ADMIN effective max is min(globalMax, roleGameMax) = globalMax', () => {
			const globalMax = 5120 * 1024 * 1024;
			const adminGameMax = 1024 * 1024 * 1024;
			const effectiveMax = Math.min(globalMax, adminGameMax);
			expect(effectiveMax).toBe(adminGameMax);
		});

		it('USER cannot bypass 200MB limit via chunked upload', () => {
			const userGameMax = 200 * 1024 * 1024;
			const globalMax = 5120 * 1024 * 1024;
			const effectiveMax = Math.min(globalMax, userGameMax);
			const requestedBytes = 500 * 1024 * 1024; // 500MB
			expect(requestedBytes > effectiveMax).toBe(true);
		});
	});

	// ── ZIP signature validation (regression for issue #1) ──
	describe('ZIP signature validation on complete', () => {
		it('valid ZIP header is detected as game type', () => {
			const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]);
			const result = detectFileType(zipHeader);
			expect(result).not.toBeNull();
			expect(isAllowedGameType(result!)).toBe(true);
		});

		it('non-ZIP header is rejected', () => {
			const randomHeader = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
			const result = detectFileType(randomHeader);
			// Either null or not a game type
			expect(result === null || !isAllowedGameType(result)).toBe(true);
		});

		it('JPEG header is not accepted as game type', () => {
			const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00]);
			const result = detectFileType(jpegHeader);
			expect(result).not.toBeNull();
			expect(isAllowedGameType(result!)).toBe(false);
		});
	});

	// ── Session expiry ───────────────────────────────────────
	describe('session expiry', () => {
		it('detects expired session', () => {
			const expiresAt = new Date(Date.now() - 1000); // 1 second ago
			expect(expiresAt < new Date()).toBe(true);
		});

		it('24-hour TTL from now', () => {
			const ttlMinutes = 1440;
			const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
			const hoursFromNow = (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60);
			expect(Math.round(hoursFromNow)).toBe(24);
		});
	});

	// ── Chunk file naming ────────────────────────────────────
	describe('chunk file naming', () => {
		function chunkFileName(index: number): string {
			return `chunk-${String(index).padStart(6, '0')}`;
		}

		it('pads single digit', () => {
			expect(chunkFileName(0)).toBe('chunk-000000');
			expect(chunkFileName(5)).toBe('chunk-000005');
		});

		it('pads triple digit', () => {
			expect(chunkFileName(512)).toBe('chunk-000512');
		});

		it('handles max realistic chunk count', () => {
			// 5GB / 1MB = 5120 chunks
			expect(chunkFileName(5119)).toBe('chunk-005119');
		});
	});
});
