/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const sectionPositions = [1000, 2000, 3000];
let scrollPosition;
let animationFrames;

beforeEach(() => {
  vi.resetModules();
  scrollPosition = 2880;
  animationFrames = [];
  document.body.innerHTML = `
    <nav class="toc">
      <a href="#one">01</a>
      <a href="#two">02</a>
      <a href="#three">03</a>
    </nav>
    <section class="step" id="one"></section>
    <section class="step" id="two"></section>
    <section class="step" id="three"></section>
  `;

  document.querySelectorAll("section.step").forEach((section, index) => {
    vi.spyOn(section, "getBoundingClientRect").mockImplementation(() => ({
      top: sectionPositions[index] - scrollPosition,
    }));
  });
  vi.stubGlobal("requestAnimationFrame", (callback) => {
    animationFrames.push(callback);
    return animationFrames.length;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

it("keeps the clicked section active when jumping upward from a later section", async () => {
  await import("./navigation.js");
  expect(document.querySelector("a.active")?.hash).toBe("#three");

  document.querySelector('a[href="#two"]').click();
  expect(document.querySelector("a.active")?.hash).toBe("#two");

  // The browser performs the anchor jump after the click handlers have run.
  scrollPosition = 1880;
  animationFrames.shift()(0);
  window.dispatchEvent(new Event("scroll"));
  animationFrames.shift()(0);

  expect(document.querySelector("a.active")?.hash).toBe("#two");
  expect(document.querySelector('a[href="#two"]').getAttribute("aria-current"))
    .toBe("location");
  expect(document.querySelector('a[href="#one"]').hasAttribute("aria-current"))
    .toBe(false);
});
