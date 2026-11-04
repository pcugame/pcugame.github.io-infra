# Web UI implementation

Use these conventions alongside the root repository instructions.

## Start with the existing UI

- Import `Button`, `FormSection`, `TextField`, `SelectField`, `TextareaField`, and
  `CheckboxField` from `src/components/ui` (use the appropriate relative path).
  Use these for ordinary forms in new features. They provide the shared classes,
  labels, descriptions, validation state, and native control behavior together.
- Use `DialogFrame`, `DialogHeader`, `DialogBody`, `DialogFooter`, `ProgressBar`,
  and `StatusBadge` for shared presentation. Domain decisions stay in features.
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
  before changing markup. File choosers use `.form-file`. Controls and labels
  must carry explicit classes; `.form-field` alone does not style its children.
- `FormSection` styles a real fieldset directly. A `project-form` ancestor is
  not needed to style fieldsets. `variant="panel"` is the default; use
  `variant="plain"` inside an existing editor surface. Do not cancel its border,
  background, padding, or shadow with page descendant selectors.

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
  features. `foundation/index.css` imports the font once, then tokens, reset and
  animations. The standalone WebGL guide imports foundation, brand, buttons and
  its own stylesheet; it does not load app feature styles. Import new app feature
  styles in `src/styles/index.css`. Scope new rules under a feature class; avoid
  global `label`, `input`, `button`, or heading overrides.
- The global reset removes default margins and padding. Content sections need
  explicit spacing and heading/list styles; semantic HTML alone supplies none.
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
  owns the column layout. Its sections explicitly use the plain variant. Details
  and members precede the poster/files column in DOM order;
  actions belong after the grid. Keep optional content mounted when collapsed
  and keep WebGL display settings in their own form and save action.
- Do not delete CSS based only on literal class searches: some classes are
  constructed dynamically. Verify consumers and responsive/theme states first.

## Verify appearance as well as behavior

- Run the affected component tests, web lint, and web build.
- Check the actual screen at desktop and mobile widths in light and dark themes:
  spacing, text contrast, native select arrows, choice labels, focus, disabled and
  validation states, and horizontal overflow. DOM-only tests cannot verify CSS.
- The optional `scripts/check-ui-styles.mjs` browser probe checks shared form CSS
  without an API. Run against the local Vite mock server using external Playwright
  tooling, as described in that script. Do not add a production preview route or
  perform production writes for visual verification.

- `scripts/check-select-controls.mjs` verifies picker rendering, native keyboard
  selection, required validation, FormData, reset, disabled fieldsets, listboxes,
  and forced-colors mode. Use `EXPECT_ENHANCEMENT=1` for a supporting browser and
  `EXPECT_ENHANCEMENT=0` for an actually unsupported engine (for example Firefox 141).
  It accepts the same external Playwright and browser-path settings as the CSS probe.
  See [customizable select progressive enhancement](https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Forms/Customizable_select).

## Presentation contracts

| Primitive | Options and ownership |
| --- | --- |
| `FormSection` | `variant="panel"` (default) or `"plain"`; forwards native fieldset props, ref and disabled semantics. |
| `DialogFrame` | Native dialog with `size="sm"` (32rem), `"md"` (34rem, default), or `"lg"` (62rem), capped by the viewport. Header/body/footer padding is 1.25rem, or 1rem at 50em and below. |
| `ProgressBar` | Native progress, `max={100}` by default. Omit `value` for indeterminate progress; `value={0}` means a known zero. `size="sm" \| "md"`, `tone="info" \| "success"`. Provide an accessible label. |
| `StatusBadge` | `tone="neutral" \| "info" \| "success" \| "warning" \| "danger"`, `size="sm" \| "md"`. Features own wording and status-to-tone mappings. Awards and year markers keep their own designs. |

The dialog frame never calls `showModal`/`close`, handles Escape/backdrop clicks,
locks scroll, restores focus, or unmounts children. The owning feature retains
those policies and effects, including upload recovery and unsaved form state.
WebGL display settings currently remain an inline form with a separate save action.

Form rhythm can be set at the feature root with `--form-field-gap`,
`--form-label-size`, `--form-label-gap`, `--form-section-title-size`,
`--form-section-title-weight`, `--form-section-heading-gap` (plain sections),
`--form-section-gap`, and `--form-section-padding` (panels). Omit them to retain
responsive defaults. Feature CSS owns grids, placement and domain decoration;
shared CSS owns the primitive surface. Do not restyle primitive internals through
page ancestors when a variant or variable expresses the requirement.

Upload widgets keep their existing `compact` prop and linear context behavior;
`game-upload--compact` and `game-upload--linear` own their undecorated surfaces.
Use `variant="plain"` to remove the surface without hiding the heading or chooser.
Reuse `FileUploadRows`/`UploadFileRows`; do not create another file manager for a
style change. Alerts use `.notice` with `--danger`, `--warning`, or `--success`;
repeated preserved prose uses `.preserve-lines`.

Measure authored styles with `node apps/web/scripts/measure-styles.mjs [git-ref]`
from the repository root. This reports parsed declarations, original UTF-8 bytes,
and JSX style attributes/object properties separately. It does not count moving
styles to JSX or removing whitespace as structural CSS reduction. Review dynamic
classes before removing candidate selectors, and preserve mixed selector lists,
responsive behavior, forced-colors and browser fallbacks.
