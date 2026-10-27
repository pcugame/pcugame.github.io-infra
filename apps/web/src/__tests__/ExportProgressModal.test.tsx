// @vitest-environment jsdom
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ExportProgressModal } from '../components/admin/ExportProgressModal';

afterEach(cleanup);
describe('export completion report', () => {
	it('lists missing files without attributing their disappearance to a student', () => {
		render(<ExportProgressModal open year={2026} isRunning={false} status={undefined} error={null} onClose={() => {}}
			result={{ projects: 1, totalFiles: 2, downloaded: 1, skipped: 1, failed: 0, aborted: false,
				paths: ['ExportedAssets/job/Game/game.zip'], missingFiles: [{ projectId: 7, projectTitle: 'My Game',
					assetId: 9, originalName: 'source-video.mp4', path: 'ExportedAssets/job/Game/video.mp4', reason: 'SOURCE_MISSING' }] }} />);
		expect(screen.getByText(/내보내기 완료 \(일부 파일 누락\)/)).toBeTruthy();
		expect(screen.getByText('My Game')).toBeTruthy();
		expect(screen.getByText(/source-video.mp4/)).toBeTruthy();
		expect(screen.getByText(/export-report.json/)).toBeTruthy();
		expect(screen.getByText(/원본 파일 없음/)).toBeTruthy();
	});
	it('still displays successful results from an older worker without missingFiles', () => {
		render(<ExportProgressModal open year={2026} isRunning={false} status={undefined} error={null} onClose={() => {}}
			result={{ projects: 1, totalFiles: 1, downloaded: 1, skipped: 0, failed: 0, aborted: false, paths: ['video.mp4'] }} />);
		expect(screen.getByText('2026년도 내보내기 완료')).toBeTruthy();
		expect(screen.queryByText(/일부 파일 누락/)).toBeNull();
	});
});
