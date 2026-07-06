# 006 - Web Pages Admin And Public

## Goal

Cover page-level user flows that are currently untested outside one admin list
page and login page.

## Work

- Admin years: loading, error, empty, create, edit, delete confirm, export modal.
- Admin project edit/new: form submit, status toggle, member operations, asset
  add/set poster/delete wiring.
- Admin settings/import/banned IP pages: success, validation errors, mutation
  wiring, empty states.
- Public/user pages: years, year projects, project detail, my projects, me page,
  loading/error/empty/success states.

## Acceptance

- `npm test -w apps/web` passes.
- Tests assert visible behavior and API calls, not implementation internals.
- Mobile-only behavior is covered where logic differs from desktop.
