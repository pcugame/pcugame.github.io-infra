import '../src/styles/foundation/index.css';
import '../src/styles/layout/brand.css';
import '../src/styles/components/buttons.css';
import '../src/styles/features/webgl-guide.css';
import './scripts/storage.js';
import './scripts/version-selector.js';
import './scripts/lightbox.js';
import './scripts/navigation.js';

document.querySelectorAll('button').forEach((button) => {
  button.classList.add('btn', 'btn--secondary');
});
