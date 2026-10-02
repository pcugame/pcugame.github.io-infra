/** Keep both editions in the document; show the reader's selected edition. */
(() => {
  "use strict";
  const storage = window.PcuWebglGuide.storage;
  const buttons = [...document.querySelectorAll("[data-select-version]")];
  const select = (version) => {
    const current = version === "2022" ? "2022" : "6";
    document.documentElement.dataset.unityVersion = current;
    document.querySelectorAll("[data-version-content]").forEach((node) => {
      node.hidden = node.dataset.versionContent !== current;
    });
    buttons.forEach((button) => {
      const active = button.dataset.selectVersion === current;
      button.setAttribute("aria-pressed", String(active));
      button.querySelector(".version-card-state").textContent = active
        ? "선택됨"
        : "안내 보기 →";
    });
    const name = current === "6" ? "Unity 6" : "Unity 2022 LTS";
    document.querySelector("#version-status").textContent =
      name +
      " 안내를 보고 있습니다. 다른 버전의 화면도 언제든 선택해서 볼 수 있습니다.";
    storage.write("unity-version", current);
    document.dispatchEvent(new Event("guide-version-change"));
  };
  buttons.forEach((button, index) => {
    button.addEventListener("click", () =>
      select(button.dataset.selectVersion),
    );
    button.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const next = buttons[1 - index];
      next.focus();
      select(next.dataset.selectVersion);
    });
  });
  select(storage.read("unity-version"));
})();
