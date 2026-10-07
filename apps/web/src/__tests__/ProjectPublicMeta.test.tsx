/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ProjectPublicMeta } from '../components/project/ProjectPublicMeta';

describe('ProjectPublicMeta', () => {
	afterEach(() => {
		cleanup();
	});

	it('renders safe GitHub links and platform chips', () => {
		render(
			<ProjectPublicMeta
				githubUrl="https://github.com/pcugame/example"
				platforms={['PC', 'WEB']}
			/>,
		);

		const link = screen.getByRole('link', { name: 'GitHub 링크 열기' });
		expect(link.getAttribute('href')).toBe('https://github.com/pcugame/example');
		expect(link.getAttribute('target')).toBe('_blank');
		expect(link.getAttribute('rel')).toBe('noopener noreferrer');
		expect(screen.getByText('PC')).toBeTruthy();
		expect(screen.getByText('웹')).toBeTruthy();
	});

	it('renders hardware as plain multiline text and hides empty hardware', () => {
		const { rerender } = render(<ProjectPublicMeta hardwareRequirements={'VR 헤드셋\n<script>컨트롤러</script>'} />);
		const text = screen.getByText(/VR 헤드셋/);
		expect(text.textContent).toBe('VR 헤드셋\n<script>컨트롤러</script>');
		expect(text.style.whiteSpace).toBe('pre-wrap');
		expect(text.querySelector('script')).toBeNull();
		rerender(<ProjectPublicMeta hardwareRequirements="   " />);
		expect(screen.queryByLabelText('작품 메타 정보')).toBeNull();
	});

	it('does not render empty or unsafe GitHub URLs', () => {
		const { rerender } = render(
			<ProjectPublicMeta githubUrl="javascript:alert(1)" platforms={['MOBILE']} />,
		);

		expect(screen.queryByRole('link', { name: 'GitHub 링크 열기' })).toBeNull();
		expect(screen.getByText('모바일')).toBeTruthy();

		rerender(<ProjectPublicMeta githubUrl="" platforms={[]} />);
		expect(screen.queryByLabelText('작품 메타 정보')).toBeNull();
	});
});
