# Web UI implementation

Use these conventions alongside the root repository instructions.

## Start with the existing UI

- Import `Button`, `FormSection`, `TextField`, `SelectField`, `TextareaField`, and
  `CheckboxField` from `src/components/ui` (use the appropriate relative path).
  Use these for ordinary forms in new features. They provide the shared classes,
  labels, descriptions, validation state, and native control behavior together.
- `Button` defaults to `type="button"`; specify `type="submit"` for form submission.
  Navigation remains a router `Link` or an anchor using `btn btn--secondary`
  (or the appropriate existing button variant).
- Keep native props, validation, refs, and events on form controls. Do not replace
  registered selects or checkboxes with custom elements that lose those behaviors.
- All dropdowns use native `SelectControl` (or labeled `SelectField`). Exhibition
  and visibility wrappers use the same primitive. Do not build another button/listbox
  or add a raw `<select>` in feature code; lint enforces the shared entry point.
- `forms.css` progressively styles the native picker inside
  `@supports (appearance: base-select) and selector(::picker(select))`.
  Unsupported browsers and forced-colors mode retain the native picker. Keep option
  text meaningful without rich markup. Native refs, events, validation, form reset,
  keyboard navigation, and mobile selection remain browser-owned.
- Multiple/size listboxes retain native rendering. Picker styling does not extend
  support to browsers that cannot run the Vite/React application itself.
- For specialized controls, reuse `.form-control`, `.form-field__label`,
  `.field-hint`, `.field-error`, and `.form-choice` explicitly. Check their CSS
  before changing markup. Legacy selectors remain for existing consumers.
- `FormSection` styles a real fieldset directly. A `project-form` ancestor is
  needed only by legacy fieldsets. Do not invent domain-specific parent classes
  to make a generic input or section receive styling.

```tsx
import { Button, FormSection, TextField } from '../../components/ui';

<form onSubmit={handleSubmit}>
  <FormSection legend="Project details">
    <TextField
      label="Title"
      name="title"
      value={title}
      onChange={(event) => setTitle(event.target.value)}
      hint="Shown in the exhibition."
      error={titleError}
      required
    />
  </FormSection>
  <div className="form-actions">
    <Button type="submit" disabled={pending}>Save</Button>
  </div>
</form>
```

## CSS constraints

- This app uses global handwritten CSS, not Tailwind or CSS Modules. Utility
  names such as `flex`, `p-4`, or `rounded-lg` have no effect unless defined here.
  Follow the existing feature class names and BEM modifiers.
- `src/styles/index.css` orders foundation, layout, shared components, then
  features. New feature files must be imported there. Scope new rules under a
  feature class; keep global control baselines in shared component CSS and avoid
  feature-level global `label`, `input`, `button`, or heading overrides.
- Shared CSS now supplies neutral styles for ordinary native inputs, textareas,
  selects, files, and buttons even without classes or form ancestors. These
  `:where()` selectors have zero specificity; explicit UI/feature classes win.
  Keep using the primitives above for labels, hints, errors, and semantic action
  variants. The baseline does not infer layout or whether an action is dangerous.
- Checkbox, radio, range, color, hidden, and input-button types are excluded from
  text-field geometry. Put `data-ui="unstyled"` on a custom control or subtree to
  opt out of native baselines; reset, theme tokens, and explicit classes still apply.
  Custom controls must define all geometry/background properties they need.
- The global reset removes default margins and padding. Use `.ui-stack` for
  vertical groups (`--ui-stack-gap` customizes the gap), `.ui-panel` for a padded
  themed panel, and `.ui-prose` for headings, paragraphs, and lists in content
  sections. Wrap wide tables in `.ui-table-scroll`. These are opt-in structures,
  not automatic global margins. `.prose` remains the existing preformatted project
  description style and is distinct from `.ui-prose`.
- Reuse tokens in `foundation/tokens.css`, including theme colors. Desktop root
  font size is 125% (normally 20px/rem); at `max-width: 50em` it is 100% (normally
  16px/rem). Media-query em boundaries use the browser's initial font size.
  Do not compensate with per-page root/font-size/zoom overrides.
- Admin tabs use `admin-page-header` with the title and any explanation together
  in `admin-page-header__text`. Use the shell’s `--admin-panel-padding` and
  `--admin-section-title-size` for admin panels; preserve smaller metadata and
  secondary button roles instead of scaling every text element alike.
- Preserve intentional page layouts. `ProjectEditorLayout` currently uses
  `admin-project-edit-*` classes on both student and admin screens; its stylesheet
  overrides descendant fieldsets. Check those overrides when changing its
  wrappers. Details and members precede the poster/files column in DOM order;
  actions belong after the grid. Keep optional content mounted when collapsed
  and keep WebGL display settings in their own form and save action.
- Do not delete CSS based only on literal class searches: some classes are
  constructed dynamically. Verify consumers and responsive/theme states first.

## Verify appearance as well as behavior

- Run the affected component tests, web lint, and web build.
- Check the actual screen at desktop and mobile widths in light and dark themes:
  spacing, text contrast, native select arrows, choice labels, focus, disabled and
  validation states, and horizontal overflow. DOM-only tests cannot verify CSS.
- `scripts/check-ui-styles.mjs` checks classless controls, explicit overrides,
  keyboard focus, disabled fieldsets, forced colors, and all route families at
  desktop/mobile widths in both themes. Run a local Vite mock server on port 5178
  and use external Playwright tooling, as described in that script. Set
  `UI_ARTIFACT_DIR` to save screenshots and the route report. The script resets
  only its isolated browser context's Mock data. It rejects non-local URLs.
  Screenshots still require visual review; DOM-only checks cannot certify layout.
  Dark CSS is checked by explicitly setting the theme attribute because the app's
  current theme hook forces light mode.

- Keep native select enhancement guarded by feature detection. Browser checks in
  this repository cover basic native selection and forced colors; a dedicated
  enhanced-picker compatibility suite is not currently present.

See [the shared UI audit](../../../../../docs/architecture/ui-style-audit.md) for
source inventory, route coverage, and verification limits.
