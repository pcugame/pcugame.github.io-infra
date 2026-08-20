/* @vitest-environment jsdom */

import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GameUploadWidget from '../components/GameUploadWidget';
import {
	computeFileIdentityCore,
	SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
	type SourceFileIdentity,
} from '../lib/upload/file-identity-core';

const mocks = vi.hoisted(() => ({
	listGameUploadSessions: vi.fn(),
	getGameUploadStatus: vi.fn(),
	uploadGameFile: vi.fn(),
	createGameUploadSession: vi.fn(),
	cancelGameUploadSession: vi.fn(),
}));

vi.mock('../lib/api/game-upload', () => mocks);

type IdentitySession = {
	sessionId: string;
	chunkSizeBytes: number;
	totalChunks: number;
	expiresAt: string;
	uploadKind: 'GAME';
	originalName: string;
	totalBytes: number;
	uploadedChunks: number[];
	uploadedCount: number;
	status: string;
	sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1';
	sourceIdentity: string;
	sourceIdentityBlockSizeBytes: number;
};

class InlineIdentityWorker {
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: ErrorEvent) => void) | null = null;
	terminate = vi.fn();

	postMessage(message: { type: string; file: File }) {
		void computeFileIdentityCore(message.file, {
			digest: async (data) => webcrypto.subtle.digest('SHA-256', data),
		}).then((identity) => {
			this.onmessage?.({ data: { type: 'success', identity } } as MessageEvent);
		}).catch((error: unknown) => {
			this.onerror?.(error as ErrorEvent);
		});
	}
}

function makeFile(byte: number, name: string): File {
	const bytes = new Uint8Array(SOURCE_IDENTITY_BLOCK_SIZE_BYTES);
	bytes.fill(byte);
	return new File([bytes], name, { type: 'application/zip' });
}

async function identityOf(file: File): Promise<SourceFileIdentity> {
	return computeFileIdentityCore(file, {
		digest: async (data) => webcrypto.subtle.digest('SHA-256', data),
	});
}

function statusFor(file: File, identity: SourceFileIdentity): IdentitySession {
	return {
		sessionId: 'd3-web-session',
		chunkSizeBytes: SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
		totalChunks: 1,
		expiresAt: '2026-08-21T00:00:00.000Z',
		uploadKind: 'GAME',
		originalName: file.name,
		totalBytes: file.size,
		uploadedChunks: [],
		uploadedCount: 0,
		status: 'PENDING',
		sourceIdentityAlgorithm: identity.sourceIdentityAlgorithm,
		sourceIdentity: identity.sourceIdentity,
		sourceIdentityBlockSizeBytes: identity.sourceIdentityBlockSizeBytes,
	};
}

function renderWidget() {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<GameUploadWidget projectId={7} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.stubGlobal('Worker', InlineIdentityWorker);
	if (!Blob.prototype.arrayBuffer) {
		Object.defineProperty(Blob.prototype, 'arrayBuffer', {
			configurable: true,
			value(this: Blob) {
				return new Promise<ArrayBuffer>((resolve, reject) => {
					const reader = new FileReader();
					reader.onload = () => resolve(reader.result as ArrayBuffer);
					reader.onerror = () => reject(reader.error);
					reader.readAsArrayBuffer(this);
				});
			},
		});
	}
	mocks.uploadGameFile.mockReturnValue({
		start: vi.fn(async () => ({ assetId: 1 })),
		abort: vi.fn(),
	});
});

afterEach(() => {
	cleanup();
	const blobPrototype = Blob.prototype as unknown as { arrayBuffer?: unknown };
	delete blobPrototype.arrayBuffer;
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe('D3 game upload resume regression', () => {
	it('F1: resumes when the selected file has the persisted source identity', async () => {
		const fileA = makeFile(0x41, 'resume-a.zip');
		const identityA = await identityOf(fileA);
		const statusA = statusFor(fileA, identityA);
		mocks.listGameUploadSessions.mockResolvedValue({ items: [statusA] });
		mocks.getGameUploadStatus.mockResolvedValue(statusA);

		const view = renderWidget();
		const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
		fireEvent.change(input, { target: { files: [fileA] } });
		fireEvent.click(await screen.findByRole('button', { name: '이어올리기' }));

		await waitFor(() => expect(mocks.uploadGameFile).toHaveBeenCalledOnce());
		expect(mocks.getGameUploadStatus).toHaveBeenCalledWith(statusA.sessionId);
		expect(mocks.uploadGameFile.mock.calls[0]?.[0]).toBe(fileA);
	});

	it('F2: rejects same-size different bytes before the first chunk upload', async () => {
		const fileA = makeFile(0x41, 'resume-a.zip');
		const fileB = makeFile(0x42, 'resume-b.zip');
		const identityA = await identityOf(fileA);
		const identityB = await identityOf(fileB);
		expect(fileA.size).toBe(fileB.size);
		expect(identityA.sourceIdentity).not.toBe(identityB.sourceIdentity);

		const statusA = statusFor(fileA, identityA);
		mocks.listGameUploadSessions.mockResolvedValue({ items: [statusA] });
		mocks.getGameUploadStatus.mockResolvedValue(statusA);

		const view = renderWidget();
		const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
		fireEvent.change(input, { target: { files: [fileB] } });
		fireEvent.click(await screen.findByRole('button', { name: '이어올리기' }));

		await screen.findByText('선택한 파일이 이 업로드 세션을 시작한 파일과 다릅니다. 원래 파일을 선택하거나 새 업로드를 시작하세요.');
		expect(fileB.size).toBe(statusA.totalBytes);
		expect(mocks.uploadGameFile).not.toHaveBeenCalled();
	});
});
