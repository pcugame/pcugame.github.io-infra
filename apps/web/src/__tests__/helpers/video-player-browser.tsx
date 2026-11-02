import { createRoot } from 'react-dom/client';
import '../../styles/index.css';
import { Preview } from './video-player-fixture';

const root = createRoot(document.getElementById('root')!);
root.render(<Preview />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
