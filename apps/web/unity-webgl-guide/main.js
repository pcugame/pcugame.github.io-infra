import 'highlight.js/styles/vs2015.css';
import '../src/styles/index.css';
import '../src/styles/features/webgl-guide.css';
import './scripts/storage.js';
import './scripts/version-selector.js';
import './scripts/lightbox.js';
import './scripts/navigation.js';
import './scripts/code-highlighting.js';
import './scripts/code-copy.js';

document.querySelectorAll('button:not(.guide-code-copy)').forEach((button) => {
  button.classList.add('btn', 'btn--secondary');
});
