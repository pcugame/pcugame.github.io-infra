import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
	children: ReactNode;
}

interface State {
	error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
	state: State = { error: null };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		console.error('ErrorBoundary caught:', error, info.componentStack);
	}

	handleReload = () => {
		window.location.reload();
	};

	render() {
		if (!this.state.error) return this.props.children;

		return (
			<div className="error-box" role="alert" style={{ margin: '2rem auto', maxWidth: 480, textAlign: 'center' }}>
				<p className="error-box__message">페이지를 표시하는 중 문제가 발생했습니다.</p>
				<button className="btn btn--primary" onClick={this.handleReload}>
					새로고침
				</button>
			</div>
		);
	}
}
