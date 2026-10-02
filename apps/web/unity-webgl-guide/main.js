import '../src/styles/index.css';
import '../src/styles/features/webgl-guide.css';
import './data/publishing-options.js';
import './data/build-options.js';
import './data/build-options-2022.js';
import './scripts/storage.js';
import './scripts/option-guides.js';
import './scripts/version-selector.js';
import './scripts/lightbox.js';
import './scripts/navigation.js';

document.querySelectorAll('button').forEach((button) => {
  button.classList.add('btn', 'btn--secondary');
});
