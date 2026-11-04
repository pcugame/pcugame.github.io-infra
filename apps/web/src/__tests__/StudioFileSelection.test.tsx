/* @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudioFileSelection } from '../features/project-submission/studio/StudioFileSelection';
import { useSubmissionFiles } from '../features/project-submission/useSubmissionFiles';
import { getClientUploadLimits } from '../lib/upload-limits';

const limits = { ...getClientUploadLimits('USER'), gameMaxMb: 1, videoMaxMb: 1, imageMaxMb: 1 };
const retry = vi.fn();
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
vi.mock('../features/auth', () => ({ useMe: () => ({ user: { id: 3, role: 'USER' } }) }));
function Harness({ configured = true, enabled = true }) {
	const materialLimits = configured ? { maxCount: 2, maxBytes: 1024 } : undefined;
	const files = useSubmissionFiles({ limits, materialLimits });
	return <QueryClientProvider client={client}><StudioFileSelection files={files} limits={limits} materialLimits={materialLimits} enabled={enabled} retryConfig={retry} /></QueryClientProvider>;
}
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const file = (name: string, size = 3) => new File([new Uint8Array(size)], name);
function area(name: string) { fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${name}`) })); return screen.getByRole('group', { name: new RegExp(`^${name} ·`) }); }
function remove(name: string) { fireEvent.click(screen.getByRole('button', { name: `${name} 더보기` })); fireEvent.click(screen.getByRole('menuitem', { name: '선택 취소' })); }
function choose(name: string, files: File[], drop = false) {
	const zone = area(name);
	if (drop) fireEvent.drop(zone, { dataTransfer: { files, types: ['Files'] } });
	else fireEvent.change(zone.querySelector('input')!, { target: { files } });
}
describe('studio file areas', () => {
	it.each(['네이티브', '웹 빌드'])('%s replaces only valid single ZIPs through selection and drop', name => {
		render(<Harness />);
		choose(name, [file('old.zip')]);
		choose('기타 자료', [file('keep.png')]);
		for (const invalid of [[file('bad.txt')], [file('one.zip'), file('two.zip')], [file('empty.zip', 0)], [file('huge.zip', 1024 * 1024 + 1)]]) {
			choose(name, invalid, true);
			expect(within(area(name)).getByText('old.zip', { selector: 'strong' })).toBeTruthy();
			expect(within(area(name)).getByRole('alert')).toBeTruthy();
		}
		choose(name, [file('new.zip')], true);
		expect(within(area(name)).queryByText('old.zip')).toBeNull();
		expect(within(area(name)).getByText('new.zip', { selector: 'strong' })).toBeTruthy();
		expect(screen.getByText('keep.png', { selector: 'strong' })).toBeTruthy();
		remove('new.zip');
		expect(within(area(name)).queryByText('new.zip')).toBeNull();
	});
	it('rejects entire video batches for type, size, empty files and cumulative count', () => {
		render(<Harness />);
		choose('동영상', [file('keep.mp4')], true);
		for (const invalid of [[file('good.mp4'), file('bad.txt')], [file('empty.mp4', 0)], [file('huge.mp4', 1024 * 1024 + 1)], Array.from({ length: 5 }, (_, i) => file(`${i}.mp4`))]) {
			choose('동영상', invalid);
			expect(area('동영상').querySelectorAll('.material-file')).toHaveLength(1);
			expect(within(area('동영상')).getByRole('alert')).toBeTruthy();
		}
		choose('동영상', [file('second.webm')], true);
		remove('keep.mp4');
		expect(screen.getByText('second.webm', { selector: 'strong' })).toBeTruthy();
	});
	it('rejects material batches atomically and shares document/attachment count', () => {
		render(<Harness />);
		choose('기타 자료', [file('keep.pdf')], true);
		for (const invalid of [[file('good.png'), file('wrong.mp4')], [file('good.png'), file('empty.txt', 0)], [file('good.png'), file('huge.zip', 1025)], [file('one.md'), file('two.zip')], [file('huge.png', 1024 * 1024 + 1)]]) {
			choose('기타 자료', invalid);
			expect(area('기타 자료').querySelectorAll('.material-file')).toHaveLength(1);
			expect(within(area('기타 자료')).getByRole('alert')).toBeTruthy();
		}
		choose('기타 자료', [file('readme.md'), file('image.png')]);
		expect(area('기타 자료').querySelectorAll('.material-file')).toHaveLength(3);
		remove('keep.pdf');
		choose('기타 자료', [file('source.zip')]);
		expect(screen.getByText('source.zip', { selector: 'strong' })).toBeTruthy();
	});
	it('allows builds, videos and images without material settings and retries settings', () => {
		const { rerender } = render(<Harness configured={false} />);
		choose('네이티브', [file('game.zip')]);
		choose('웹 빌드', [file('web.zip')]);
		choose('동영상', [file('video.mp4')]);
		choose('기타 자료', [file('image.png')]);
		choose('기타 자료', [file('rejected.png'), file('doc.pdf')]);
		expect(screen.queryByText('rejected.png')).toBeNull();
		expect(document.querySelectorAll('.material-file')).toHaveLength(4);
		fireEvent.click(screen.getByRole('button', { name: '설정 다시 불러오기' }));
		expect(retry).toHaveBeenCalledOnce();
		rerender(<Harness />);
		choose('기타 자료', [file('doc.pdf')]);
		expect(screen.getByText('doc.pdf', { selector: 'strong' })).toBeTruthy();
	});
	it('disables buttons and ignores drops when uploads are locked', () => {
		render(<Harness enabled={false} />);
		for (const name of ['네이티브', '웹 빌드', '동영상', '기타 자료']) {
			expect((within(area(name)).getByRole('button', { name: `${name} 파일 선택` }) as HTMLButtonElement).disabled).toBe(true);
			choose(name, [file('ignored.zip')], true);
		}
		expect(screen.queryByRole('listitem')).toBeNull();
	});
});
