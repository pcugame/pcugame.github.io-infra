# Video.js skin source

These components are the default video skin from `@videojs/react` **10.1.0**,
licensed under Apache-2.0 (included in `public/licenses/videojs.txt`). They retain
Video.js controls, gestures, hotkeys, error handling, and menu accessibility.
Imports use the public React, icon, core, and style utility exports.

The packaged skin has no slot for settings menu items. Following the upstream
[skin customization guide](https://videojs.org/docs/framework/react/guides/customize-skins),
we keep editable source and pass `settingsMenuItems` through the skin and control
bar to the settings menu. `ProjectVideo` supplies frame rate and resolution submenus for its
independent MP4 renditions. Selection still belongs to the application; it does
not enable adaptive streaming or change playback speed.

The local skin also adds a centered play button while paused so touch playback
starts directly from a button activation. Settings menus use the viewport as
their positioning boundary so narrow inline videos do not clip quality or frame
rate options. The project modal reserves a separate toolbar for dismissal.

The stylesheet is the matching, pinned `@videojs/react/video/skin.css`. The
project video styles use scoped `revert-layer` for spacing so the site reset
does not override the layered skin. When
upgrading Video.js, update this skin source alongside that package and rerun
`scripts/video-player-browser.mjs`, including touch input in the project modal, narrow/landscape screens, and error recovery.
