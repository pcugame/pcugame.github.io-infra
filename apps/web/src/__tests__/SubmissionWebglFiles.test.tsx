/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SubmissionFileFieldset } from '../features/project-submission/SubmissionFileFieldset';
import { useSubmissionFiles } from '../features/project-submission/useSubmissionFiles';
import type { ClientUploadLimits } from '../lib/upload-limits';

const limits: ClientUploadLimits = {
	imageMaxMb: 10,
	imagePdfMaxMb: 100,
	posterMaxMb: 10,
	posterPdfMaxMb: 50,
	videoMaxMb: 200,
	gameMaxMb: 5120,
	requestMaxMb: 250,
	maxFiles: 10,
};

function FileFields() {
	const files = useSubmissionFiles({ limits });
	return (
		<SubmissionFileFieldset
			files={files}
			gameUploadHint="게임 ZIP 안내"
			webglUploadHint="WebGL ZIP 안내"
			limits={limits}
		/>
	);
}

afterEach(cleanup);

describe('submission ZIP fields', () => {
	it('accepts GAME and WEBGL as two simultaneous, independent file inputs', () => {
		render(<FileFields />);
		const gameInput = screen.getByLabelText(/^게임 파일/) as HTMLInputElement;
		const webglInput = screen.getByLabelText(/^WebGL 빌드 파일/) as HTMLInputElement;
		const game = new File(['game'], 'game.zip', { type: 'application/zip' });
		const webgl = new File(['webgl'], 'webgl.zip', { type: 'application/zip' });

		fireEvent.change(gameInput, { target: { files: [game] } });
		fireEvent.change(webglInput, { target: { files: [webgl] } });

		expect(screen.getByText(/game\.zip/)).toBeTruthy();
		expect(screen.getByText(/webgl\.zip/)).toBeTruthy();
		expect(gameInput).not.toBe(webglInput);
	});
});
