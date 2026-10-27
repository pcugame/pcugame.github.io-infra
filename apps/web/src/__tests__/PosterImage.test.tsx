/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { PosterImage } from '../components/common/PosterImage';
afterEach(cleanup);

it('retains the original object capability on one-time vote image fallback', () => {
 const key = 'public/images/한 글 %.png';
 const encoded = Buffer.from(key).toString('base64url');
 const src = `https://images.test/img/v1/960/${encoded}?pcu_token=token`;
 render(<PosterImage src={src} alt="poster" />);
 const image = screen.getByRole('img');
 fireEvent.error(image);
 const original = `https://images.test/${key.split('/').map(encodeURIComponent).join('/')}?pcu_token=token`;
 expect(image.getAttribute('src')).toBe(original);
 fireEvent.error(image);
 expect(image.getAttribute('src')).toBe(original);
});
