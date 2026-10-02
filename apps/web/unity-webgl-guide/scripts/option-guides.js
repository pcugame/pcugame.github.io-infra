/** Shared option explanations, screenshot highlights and printable content. */
(() => {
  "use strict";
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  document.querySelectorAll("[data-option-guide]").forEach((guide) => {
    const options = window.PcuWebglGuide[guide.dataset.optionGuide];
    const controls = guide.querySelector("[data-controls]");
    const detail = guide.querySelector("[data-detail]");
    const spot = guide.querySelector("[data-spot]");
    const image = guide.querySelector("figure img");
    const printList = guide.querySelector("[data-print-options]");
    const initialImage = image.getAttribute("src");
    const initialAlt = image.alt;
    const optionGroupName = guide.dataset.optionGuide === "publishingOptions" ? "Publishing Settings 옵션" : "빌드 옵션";
    const dots = [];
    let selectedIndex = 0;
    let positionLabel;
    const visibleIndices = () => options.flatMap((option, index) =>
      !option.version || option.version === (document.documentElement.dataset.unityVersion || "6") ? [index] : [],
    );
    const selectOption = (index) => {
      selectedIndex = index;
      const option = options[index];
      controls.querySelectorAll("button").forEach((button) => {
        const active = Number(button.dataset.option) === index;
        button.classList.toggle("selected", active);
        button.setAttribute("aria-pressed", String(active));
      });
      dots.forEach((dot, dotIndex) => {
        dot.setAttribute("aria-pressed", String(dotIndex === index));
      });
      const visible = visibleIndices();
      if (positionLabel) positionLabel.textContent = `${visible.indexOf(index) + 1} / ${visible.length}`;
      image.src = option.image || initialImage;
      image.alt = option.imageAlt || initialAlt;
      spot.style.left = (option.left ?? 1.2) + "%";
      spot.style.width = (option.width ?? 97.6) + "%";
      spot.style.top = option.top + "%";
      spot.style.height = option.height + "%";
      detail.replaceChildren(
        element("span", option.tag, "tag"),
        element("h3", option.name + " → " + option.value),
        element("p", option.text),
        element("p", option.note, "note"),
      );
    };
    {
      const imageWrap = image.closest(".image-wrap");
      const navigation = element("div", "", "option-image-navigation");
      navigation.setAttribute("role", "group");
      navigation.setAttribute("aria-label", `${optionGroupName} 사진 탐색`);
      const selectFromImage = (index) => {
        selectOption((index + options.length) % options.length);
        const selected = controls.querySelector(".selected");
        // Scroll only the option list; keep the screenshot in view.
        if (selected) {
          const listRect = controls.getBoundingClientRect();
          const itemRect = selected.getBoundingClientRect();
          if (itemRect.top < listRect.top) controls.scrollTop += itemRect.top - listRect.top;
          else if (itemRect.bottom > listRect.bottom) controls.scrollTop += itemRect.bottom - listRect.bottom;
        }
      };
      for (const [direction, symbol, label] of [[-1, "‹", `이전 ${optionGroupName}`], [1, "›", `다음 ${optionGroupName}`]]) {
        const arrow = element("button", symbol, `option-image-arrow option-image-arrow--${direction === -1 ? "previous" : "next"}`);
        arrow.type = "button";
        arrow.setAttribute("aria-label", label);
        arrow.addEventListener("click", () => {
          const visible = visibleIndices();
          selectFromImage(visible[(visible.indexOf(selectedIndex) + direction + visible.length) % visible.length]);
        });
        navigation.append(arrow);
      }
      const pagination = element("div", "", "option-image-pagination");
      options.forEach((option, index) => {
        const dot = element("button", "", "option-image-dot");
        dot.type = "button";
        if (option.version) dot.dataset.versionContent = option.version;
        dot.setAttribute("aria-label", `${index + 1}. ${option.name} 위치 보기`);
        dot.addEventListener("click", () => selectFromImage(index));
        dots.push(dot);
        pagination.append(dot);
      });
      positionLabel = element("span", "", "option-image-position");
      positionLabel.setAttribute("aria-hidden", "true");
      pagination.append(positionLabel);
      navigation.append(pagination);
      imageWrap.append(navigation);
      controls.before(element("p", "사진의 화살표·점 또는 아래 번호 항목을 눌러 설정 위치와 설명을 확인하세요.", "option-selection-hint"));
    }
    options.forEach((option, index) => {
      const button = element("button", "", "option");
      button.type = "button";
      button.dataset.option = index;
      if (option.version) button.dataset.versionContent = option.version;
      button.setAttribute("aria-pressed", "false");
      const label = element("span", "");
      label.append(element("b", option.name), element("small", option.value));
      button.append(
        element("span", String(index + 1).padStart(2, "0"), "num"),
        label,
      );
      button.addEventListener("click", () => selectOption(index));
      controls.append(button);
      const item = element("li", "");
      if (option.version) item.dataset.versionContent = option.version;
      item.append(
        element("b", option.name + " → " + option.value),
        document.createElement("br"),
        document.createTextNode(option.text + " " + option.note),
      );
      printList.append(item);
    });
    selectOption(0);
    document.addEventListener("guide-version-change", () => selectOption(0));
  });
})();
