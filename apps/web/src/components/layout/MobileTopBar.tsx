import { Link } from 'react-router-dom';

export function MobileTopBar() {
	return (
		<div className="mobile-topbar">
			<Link to="/" className="mobile-topbar__logo">
				<img
					src="/pcu_signature.svg"
					alt="배재대학교"
					className="mobile-topbar__sig"
					draggable={false}
				/>
				<span className="mobile-topbar__divider" aria-hidden="true" />
				<span className="mobile-topbar__dept">소프트웨어공학부<br />게임공학전공</span>
			</Link>
		</div>
	);
}
