/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResponsiveImage as ResponsiveImageData } from '@pcu/contracts';

import { ResponsiveImage } from '../components/common/ResponsiveImage';

afterEach(cleanup);

const image: ResponsiveImageData = {
	original: {
		url: 'https://images.test/original.webp',
		width: 1200,
		height: 675,
	},
	renditions: [{
		profile: 'CARD_480',
		url: 'https://images.test/card.webp',
		width: 480,
		height: 270,
	}],
};

describe('ResponsiveImage', () => {
	it('renders browser candidates while preserving caller img semantics', () => {
		render(
			<ResponsiveImage
				image={image}
				alt="작품 포스터"
				sizes="(max-width: 640px) 100vw, 480px"
				loading="lazy"
				decoding="async"
				className="poster"
			/>,
		);

		const element = screen.getByRole('img', { name: '작품 포스터' });
		expect(element.getAttribute('src')).toBe(image.original.url);
		expect(element.getAttribute('srcset')).toBe(
			`${image.renditions[0]?.url} 480w, ${image.original.url} 1200w`,
		);
		expect(element.getAttribute('sizes')).toBe('(max-width: 640px) 100vw, 480px');
		expect(element.getAttribute('loading')).toBe('lazy');
		expect(element.getAttribute('decoding')).toBe('async');
		expect(element.className).toBe('poster');
	});

	it('falls back from a failed responsive candidate to the original only once', () => {
		const onError = vi.fn();
		const { rerender } = render(
			<ResponsiveImage image={image} alt="작품 포스터" sizes="480px" onError={onError} />,
		);
		const element = screen.getByRole('img', { name: '작품 포스터' });
		Object.defineProperty(element, 'currentSrc', {
			configurable: true,
			value: image.renditions[0]?.url,
		});

		fireEvent.error(element);
		expect(element.getAttribute('src')).toBe(image.original.url);
		expect(element.getAttribute('srcset')).toBeNull();
		expect(element.getAttribute('sizes')).toBeNull();

		Object.defineProperty(element, 'currentSrc', {
			configurable: true,
			value: image.original.url,
		});
		fireEvent.error(element);
		expect(element.getAttribute('srcset')).toBeNull();
		expect(onError).toHaveBeenCalledTimes(2);

		const nextImage: ResponsiveImageData = {
			...image,
			original: { ...image.original, url: 'https://images.test/next-original.webp' },
		};
		rerender(<ResponsiveImage image={nextImage} alt="다음 포스터" sizes="480px" />);
		expect(screen.getByRole('img', { name: '다음 포스터' }).getAttribute('srcset')).not.toBeNull();
	});

	it('leaves an original-only failure in the normal error state without retry state', () => {
		const legacy: ResponsiveImageData = {
			original: { url: 'https://images.test/legacy.webp' },
			renditions: [],
		};
		const onError = vi.fn();
		render(<ResponsiveImage image={legacy} alt="레거시 이미지" onError={onError} />);

		const element = screen.getByRole('img', { name: '레거시 이미지' });
		fireEvent.error(element);
		fireEvent.error(element);

		expect(element.getAttribute('src')).toBe(legacy.original.url);
		expect(element.getAttribute('srcset')).toBeNull();
		expect(onError).toHaveBeenCalledTimes(2);
	});
});
