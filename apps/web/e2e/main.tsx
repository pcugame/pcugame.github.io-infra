import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import GameUploadWidget from '../src/components/GameUploadWidget';

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<GameUploadWidget projectId={7} uploadKind="WEBGL" />
		</QueryClientProvider>
	</StrictMode>,
);
