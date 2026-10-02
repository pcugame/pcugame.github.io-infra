/** Storage restrictions must not break reading or interaction. */
(() => {
  "use strict";
  const namespace = "pcu-webgl-guide-v1-";
  window.PcuWebglGuide.storage = {
    read(key) {
      try {
        return window.localStorage.getItem(namespace + key);
      } catch {
        return null;
      }
    },
    write(key, value) {
      try {
        window.localStorage.setItem(namespace + key, String(value));
      } catch {
        /* The guide still works without persistent preferences. */
      }
    },
  };
})();
