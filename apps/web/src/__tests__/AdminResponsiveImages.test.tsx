/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type {
	AdminExhibitionItem,
	ResponsiveImage,
} from '@pcu/contracts';

import { YearPosterControls } from '../features/admin/exhibitions/ExhibitionRows';

const image: ResponsiveImage = {
	original: {
		url: 'https://images.test/admin-original.webp',
		width: 1200,
		height: 800,
	},
	renditions: [{
		profile: 'CARD_480',
		url: 'https://images.test/admin-card.webp',
		width: 480,
		height: 320,
	}],
};

afterEach(cleanup);

function withQueryClient(ui: React.ReactNode) {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<MemoryRouter>{ui}</MemoryRouter>
		</QueryClientProvider>,
	);
}

describe('admin responsive image previews', () => {
	it('renders an exhibition poster through the shared responsive component', () => {
		const exhibition: AdminExhibitionItem = {
	visibility: 'PUBLIC',
			id: 1,
			year: 2026,
			title: '졸업 전시',
			isUploadEnabled: true,
			sortOrder: 0,
			projectCount: 1,
			poster: image,
		};
		withQueryClient(
			<YearPosterControls
				year={exhibition}
				compact
			/>,
		);

		const preview = screen.getByRole('img', { name: '졸업 전시 전시회 포스터' });
		expect(preview.getAttribute('srcset')).toContain(`${image.renditions[0]?.url} 480w`);
		expect(preview.getAttribute('sizes')).toBe('72px');
	});

});
