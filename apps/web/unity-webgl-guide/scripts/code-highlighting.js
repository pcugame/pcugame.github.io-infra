import hljs from 'highlight.js/lib/core';
import csharp from 'highlight.js/lib/languages/csharp';

hljs.registerLanguage('csharp', csharp);
document.querySelectorAll('pre code.language-csharp').forEach((block) => {
  hljs.highlightElement(block);
});
