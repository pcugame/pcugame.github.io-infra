# Shared UI style audit — 2026-10-12

## Cause and policy

The universal reset removes margins/padding from every element. Complete form
styles previously required `.form-control`, a `.form-field` ancestor, or a
page-specific ancestor. Buttons required `.btn`. New semantic HTML could therefore
render with reset geometry, browser backgrounds, or inconsistent dark colors.
`ConnectionProfileForm` demonstrated this with textareas outside `.form-field`,
a plain checkbox label, and a section whose `.admin-card` padding only applied to
forms. The native dark fallback also had higher specificity than some explicit
component classes. Shared visual-check scripts were advertised but absent.

Ordinary native controls now receive zero-specificity baselines from the same
rules as the existing fields. Buttons receive a neutral fallback; semantic variants
still require explicit components/classes. Type-specific exclusions protect
checkbox, radio, range, color, hidden, and input-button controls. File inputs have
separate styling. Theme colors use existing tokens. `data-ui="unstyled"` opts a
control/subtree out of baselines, while explicit classes/reset/theme still apply.
No API contract changes or CSS framework migration are needed.

Layout remains explicit: `.ui-panel`, `.ui-stack`, `.ui-prose`, and
`.ui-table-scroll` provide reusable panel padding, vertical gaps, content rhythm,
and bounded table scrolling. Shared styled fieldsets also allow shrinking below
their content width, so a scroll wrapper can contain wide tables. External
connection examples use these structures
and existing accessible fields. Change request summaries/review use content rhythm;
the comparison table scrolls within its own container.

## Source inventory

Inspection covered all 116 non-test TSX sources, the router, all shared/feature CSS
imports, the UI primitives and lint convention, and the separate Unity guide entry.
Literal class lookup was used to find candidates, not to prove an element unstyled:
classes can be generated, inherited from ancestors, or used as structural hooks.

| Candidates without dedicated selectors | Resolution |
| --- | --- |
| External connection example labels/textareas and section | Converted to shared fields and panel/stack/prose structure. |
| Change request information, asset lists, and comparison table | Shared prose rhythm and a table scroll wrapper. |
| `admin-projects-page`, `admin-project-new-page`, `admin-settings-page`, `admin-banned-ips-page`, `admin-import-page` | Page identity hooks; headers, cards, controls, and layouts already use explicit shared styles. |
| `submission-file-fieldset`, `admin-project-edit-assets` | Structural hooks; styled by `.form-section` and editor ancestor rules. |
| `project-detail__description`, `project-detail__gallery`, `project-detail__attachments`, `modal-attachments` | Already styled by section, prose, gallery and shared project-materials rules. |
| `vote-upload`, `upload-file-rows` | Containers with styled form-field/row children. |
| `home-year-card__poster-text` | Groups explicitly styled year and year-label children within the poster layout. |
| `admin-exhibition-poster__actions` | Upload widget and button carry their own styles; does not require a new visual variant. |

The guide imports the shared stylesheet and its own feature stylesheet explicitly.
Its script also adds existing button variants. Uploaded games run inside their own
iframe documents and are intentionally outside the site's CSS boundary.

## Browser coverage and reproduction

Start `npm run dev:mock --workspace=apps/web -- --host 127.0.0.1 --port 5178`, then:

```sh
PLAYWRIGHT_MODULE_PATH=/path/to/playwright/index.mjs \
UI_ARTIFACT_DIR=/tmp/pcu-ui-styles node scripts/check-ui-styles.mjs
```

Use externally installed Playwright and its browser dependencies; no runtime
application dependency is added. The probe rejects remote targets and uses its own
browser context's local Mock store. It writes screenshots/report only when an
artifact directory is provided. Theme attributes are set explicitly because the
current application theme hook forces light mode.

| Screen family | Covered routes / states |
| --- | --- |
| Public archive | Home, years, year projects, exhibition projects, year/slug project alias, project details including long content/attachments |
| Authentication and student | Login, profile, own projects, submission form and studio, change-request editor/summary, external connections and service examples |
| Administration | Root redirect, project list/new/studio/edit, change-request list/review, exhibitions, settings, blocked IPs, import, external connection review, voting |
| Separate entries | Game player, Unity guide, public voting, records, draw |
| Baseline fixture | Classless controls, telephone/time, textarea, select/listbox, files, checkbox/radio/range/color/hidden, invalid/disabled, button variants, opt-out subtree, focus, forced colors |

The conditional checks also cover specific-port fields, invalid and long host
input, every service profile, existing-vote poster/settings controls, the public
vote confirmation dialog, and records after closing. A pending external request
is seeded through the local Mock API to expose admin review controls.

Each route/fixture is checked at 1440px and 390px in light and dark CSS. The probe
records titles, visible controls, alert text, unpadded controls, and viewport
overflow. Route screenshots support visual review; an automated pass alone is not
a claim that every conditional workflow or every browser engine is covered.

## Verification boundary

- Web suite: **80 files, 823 tests passed**, including shared primitives, external
  links, and network forms. Focused suite: **46 tests passed**.
- Web lint (including guide HTML validation) and production build: **passed**.
  Build retains the existing warning about a chunk larger than 500 kB.
- Chromium **153.0.8010.12**: initial **136** route/baseline cases found one mobile
  comparison-table overflow. The shared fieldset minimum-width fix resolved it;
  the affected routes and conditional UI then passed **52** cases. Seeded admin
  network review plus baselines passed another **8** cases. Combined final
  coverage is **152 distinct route/baseline/conditional cases**, with no unpadded
  ordinary controls or viewport overflow in the checked states.
- Existing network browser submission/review probe: **passed**, including all-port
  submission, invalid URL handling, WSS/subdomains, approval/overlap, and Photon
  example submission. This exercises the actual local Mock client/form boundary.
- Screenshots were inspected for the route overview, student network forms at
  desktop/mobile sizes, dark settings, and mobile vote confirmation. Detailed
  artifacts and machine reports were saved under `/tmp/pcu-ui-styles`,
  `/tmp/pcu-ui-states`, and `/tmp/pcu-ui-review`; the merged final report is
  `/tmp/pcu-ui-final-report.json`. These are local evidence, not committed assets.
- Browser coverage is Chromium only. Record pages include both the intended
  before-closing notice and closed records. The player shows the local graphics
  advisory; this audit does not certify a running uploaded game, external servers,
  or every upload/modal state. Remaining conditional behavior is source-inspected
  and covered by the existing component suite where available.
No commit, push, CI trigger, merge, or deployment is part of this work.
