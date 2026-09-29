/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ResponsiveImage } from '@pcu/contracts';
import { ProjectPosterPreview } from '../components/project/editor/ProjectPosterPreview';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const image: ResponsiveImage = {
	original: { url: 'https://images.test/poster.webp', width: 480, height: 672 },
	renditions: [{ profile: 'CARD_480', url: 'https://images.test/card.webp', width: 480, height: 672 }],
};

it('shows the local placeholder when no poster is registered', () => {
	render(<ProjectPosterPreview title="작품" />);
	expect(screen.getByRole('img').getAttribute('src')).toBe('/poster-placeholder.svg');
});

it('keeps the placeholder visible through failed renditions and original requests', () => {
	render(<ProjectPosterPreview title="작품" image={image} />);
	const poster = screen.getByAltText('작품 포스터');
	const placeholder = screen.getByRole('img', { name: '포스터 플레이스홀더' });
	Object.defineProperty(poster, 'currentSrc', { configurable: true, value: image.renditions[0]!.url });
	fireEvent.error(poster);
	expect(poster.getAttribute('srcset')).toBeNull();
	Object.defineProperty(poster, 'currentSrc', { value: image.original.url });
	fireEvent.error(poster);
	expect(placeholder.getAttribute('aria-hidden')).toBe('false');
	expect(poster.style.opacity).toBe('0');
	fireEvent.load(poster);
	expect(screen.getByRole('img', { name: '작품 포스터' })).toBe(poster);
	expect(poster.style.opacity).toBe('1');
	expect(placeholder.getAttribute('aria-hidden')).toBe('true');
});

it('shows the placeholder again while a replacement poster loads', () => {
	const { rerender } = render(<ProjectPosterPreview title="작품" image={image} />);
	fireEvent.load(screen.getByAltText('작품 포스터'));
	rerender(<ProjectPosterPreview title="작품" image={{ ...image, original: { ...image.original, url: 'https://images.test/new.webp' } }} />);
	expect(screen.getByRole('img', { name: '포스터 플레이스홀더' })).toBeTruthy();
	expect(screen.getByAltText('작품 포스터').style.opacity).toBe('0');
});


it('previews selected images, releases their URLs, and uses the placeholder for PDFs', () => {
	const createObjectURL = vi.fn(() => 'blob:poster-preview');
	const revokeObjectURL = vi.fn();
	vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
	const { rerender } = render(<ProjectPosterPreview title="새 작품" localFile={new File(['image'], 'poster.png')} />);
	const poster = screen.getByAltText('새 작품 포스터');
	expect(poster.getAttribute('src')).toBe('blob:poster-preview');
	fireEvent.load(poster);
	expect(screen.getByRole('img', { name: '새 작품 포스터' })).toBeTruthy();
	rerender(<ProjectPosterPreview title="새 작품" localFile={new File(['pdf'], 'poster.pdf')} />);
	expect(screen.getByRole('img', { name: '포스터 플레이스홀더' })).toBeTruthy();
	expect(revokeObjectURL).toHaveBeenCalledWith('blob:poster-preview');
});
