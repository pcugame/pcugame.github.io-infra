/** Highlight the current section in the table of contents. */
(() => {
  "use strict";
  if (!("IntersectionObserver" in window)) return;
  const links = [...document.querySelectorAll(".toc a")];
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        links.forEach((link) => {
          const active = link.hash === "#" + entry.target.id;
          link.classList.toggle("active", active);
          if (active) link.setAttribute("aria-current", "location");
          else link.removeAttribute("aria-current");
        });
      });
    },
    { rootMargin: "-100px 0px -60% 0px", threshold: 0 },
  );
  document
    .querySelectorAll("section.step")
    .forEach((section) => observer.observe(section));
})();
