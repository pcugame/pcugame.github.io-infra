/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';

const mocks = vi.hoisted(() => ({
	useMe: vi.fn(),
	useLogin: vi.fn(),
	initializeGoogleSignIn: vi.fn(),
	mutate: vi.fn(),
}));

vi.mock('../features/auth', () => ({
	useMe: mocks.useMe,
	useLogin: mocks.useLogin,
}));

vi.mock('../lib/auth', () => ({
	initializeGoogleSignIn: mocks.initializeGoogleSignIn,
}));

import LoginPage from '../pages/LoginPage';

function renderLoginPage() {
	return render(
		<MemoryRouter>
			<LoginPage />
		</MemoryRouter>,
	);
}

describe('LoginPage', () => {
	afterEach(() => {
		cleanup();
		vi.unstubAllEnvs();
	});

	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv('VITE_DEV_AUTH_ENABLED', 'false');
		mocks.useMe.mockReturnValue({ isAuthenticated: false });
		mocks.useLogin.mockReturnValue({
			mutate: mocks.mutate,
			error: null,
			isPending: false,
		});
	});

	it('shows the school-domain guidance for backend domain error codes', () => {
		mocks.useLogin.mockReturnValue({
			mutate: mocks.mutate,
			isPending: false,
			error: new ApiError(401, 'Unauthorized', {
				ok: false,
				error: {
					code: 'EMAIL_DOMAIN_NOT_ALLOWED',
					message: 'Email domain not allowed',
				},
			}),
		});

		renderLoginPage();

		expect(screen.getByRole('alert').textContent).toContain(
			'배재대학교 계정(@pcu.ac.kr)으로만 로그인할 수 있습니다.',
		);
	});

	it('keeps the backend message for general login failures', () => {
		mocks.useLogin.mockReturnValue({
			mutate: mocks.mutate,
			isPending: false,
			error: new ApiError(401, 'Unauthorized', {
				ok: false,
				error: {
					code: 'UNAUTHORIZED',
					message: 'Invalid Google token',
				},
			}),
		});

		renderLoginPage();

		expect(screen.getByRole('alert').textContent).toContain('Invalid Google token');
	});

	it('shows dev auth controls instead of Google login when enabled outside production', () => {
		vi.stubEnv('VITE_DEV_AUTH_ENABLED', 'true');

		renderLoginPage();

		expect(screen.getByTestId('dev-auth-panel')).toBeTruthy();
		expect(screen.getByRole('button', { name: '학생' })).toBeTruthy();
		expect(screen.getByRole('button', { name: '운영자' })).toBeTruthy();
		expect(screen.getByRole('button', { name: '관리자' })).toBeTruthy();
		expect(mocks.initializeGoogleSignIn).not.toHaveBeenCalled();
	});

	it('uses the login mutation for dev role and failure simulation buttons', () => {
		vi.stubEnv('VITE_DEV_AUTH_ENABLED', 'true');

		renderLoginPage();

		fireEvent.click(screen.getByRole('button', { name: '관리자' }));
		expect(mocks.mutate).toHaveBeenCalledWith({ type: 'dev-role', role: 'ADMIN' });

		fireEvent.click(screen.getByRole('button', { name: '비정상 도메인' }));
		expect(mocks.mutate).toHaveBeenCalledWith({
			type: 'dev-error',
			scenario: 'domain-not-allowed',
		});
	});

	it('hides dev auth controls in production builds', () => {
		vi.stubEnv('VITE_DEV_AUTH_ENABLED', 'true');
		vi.stubEnv('PROD', true);

		renderLoginPage();

		expect(screen.queryByTestId('dev-auth-panel')).toBeNull();
		expect(mocks.initializeGoogleSignIn).toHaveBeenCalled();
	});
});
