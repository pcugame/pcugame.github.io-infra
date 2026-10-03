/** Highlight the section at the document's anchor offset in the table of contents. */
(() => {
  "use strict";

  const links = [...document.querySelectorAll(".toc a")];
  const sections = links
    .map((link) => document.getElementById(link.hash.slice(1)))
    .filter((section) => section?.matches("section.step"));

  if (!links.length || !sections.length) return;

  const setActiveLink = (sectionId) => {
    links.forEach((link) => {
      const active = link.hash === `#${sectionId}`;
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
  };

  const updateActiveLink = () => {
    const anchorOffset =
      Number.parseFloat(getComputedStyle(sections[0]).scrollMarginTop) || 120;
    let current = sections[0];

    for (const section of sections) {
      // Allow one pixel for sub-pixel anchor positioning and browser rounding.
      if (section.getBoundingClientRect().top > anchorOffset + 1) break;
      current = section;
    }

    setActiveLink(current.id);
  };

  let updateRequested = false;
  const requestUpdate = () => {
    if (updateRequested) return;
    updateRequested = true;
    requestAnimationFrame(() => {
      updateRequested = false;
      updateActiveLink();
    });
  };

  links.forEach((link) => {
    link.addEventListener("click", () => {
      // Keep the clicked item stable while the browser performs the anchor jump.
      setActiveLink(link.hash.slice(1));
      requestUpdate();
    });
  });

  window.addEventListener("scroll", requestUpdate, { passive: true });
  window.addEventListener("resize", requestUpdate);
  updateActiveLink();
})();
