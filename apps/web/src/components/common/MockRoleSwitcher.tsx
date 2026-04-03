// Mock 모드에서만 표시되는 역할 전환 패널
// localStorage('mock-role')을 변경 후 페이지를 리로드한다.

import { useState } from 'react';

const ROLES = [
	{ key: 'ADMIN', label: '관리자', color: '#dc2626' },
	{ key: 'OPERATOR', label: '운영자', color: '#d97706' },
	{ key: 'USER', label: '학생', color: '#1a51af' },
] as const;

function getCurrent(): string {
	try {
		const v = localStorage.getItem('mock-role');
		if (v && ROLES.some((r) => r.key === v)) return v;
	} catch { /* noop */ }
	return 'ADMIN';
}

export function MockRoleSwitcher() {
	const [current, setCurrent] = useState(getCurrent);

	if (import.meta.env.VITE_MOCK !== 'true') return null;

	const handleChange = (role: string) => {
		localStorage.setItem('mock-role', role);
		setCurrent(role);
		window.location.reload();
	};

	return (
		<div className="mock-switcher">
			<span className="mock-switcher__label">Mock 역할</span>
			<div className="mock-switcher__btns">
				{ROLES.map((r) => (
					<button
						key={r.key}
						className={`mock-switcher__btn ${current === r.key ? 'mock-switcher__btn--active' : ''}`}
						style={current === r.key ? { background: r.color, color: '#fff' } : undefined}
						onClick={() => handleChange(r.key)}
					>
						{r.label}
					</button>
				))}
			</div>
		</div>
	);
}
