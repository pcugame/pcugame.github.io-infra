/** Reuse the figure's image and highlight, without a duplicated image registry. */
(() => {
  "use strict";
  const dialog = document.querySelector("#image-dialog");
  const dialogImage = document.querySelector("#dialog-image");
  const dialogSpot = document.querySelector("#dialog-spot");
  let opener = null;
  document.querySelectorAll("[data-zoom]").forEach((button) => {
    button.addEventListener("click", async () => {
      opener = button;
      const figure = button.closest("figure");
      const image = figure.querySelector("img");
      const sourceWrap = figure.querySelector(".image-wrap");
      const sourceSpot = figure.querySelector(".spot");
      dialogImage.src = image.src;
      dialogImage.alt = image.alt + " (확대)";
      dialogSpot.hidden = !sourceSpot;
      if (sourceSpot) {
        const width = sourceWrap.clientWidth;
        const height = sourceWrap.clientHeight;
        dialogSpot.style.left =
          sourceSpot.style.left || (sourceSpot.offsetLeft / width) * 100 + "%";
        dialogSpot.style.top =
          sourceSpot.style.top || (sourceSpot.offsetTop / height) * 100 + "%";
        dialogSpot.style.width =
          sourceSpot.style.width ||
          (sourceSpot.offsetWidth / width) * 100 + "%";
        dialogSpot.style.height =
          sourceSpot.style.height ||
          (sourceSpot.offsetHeight / height) * 100 + "%";
      }
      await dialogImage.decode().catch(() => {});
      dialog.showModal();
      requestAnimationFrame(() => {
        const body = dialog.querySelector(".dialog-body");
        body.scrollTop = sourceSpot
          ? Math.max(0, dialogSpot.offsetTop - body.clientHeight / 2)
          : 0;
        body.scrollLeft = 0;
      });
    });
  });
  document
    .querySelector("#close-dialog")
    .addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => opener?.focus());
})();
