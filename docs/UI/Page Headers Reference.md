# Page Headers Reference

The per-page header convention for `apps/wildflower-react`. The header itself is
the generic [`PageHeader`](../../global/react-tundraish/src/page-header.tsx) in
`react-tundraish`; this doc is the app-level rule for how every screen uses it.

## The rule

- **Exactly one `<PageHeader>` per page**, rendered as the **first child** of the
  page shell. A page never stacks two headings — `PageHeader` owns the page's
  single `<h1>`, so a child screen must not render its own `<h1>` on top of a
  layout that already renders one.
- **Top-level tab surfaces omit the back link.** The three tab destinations
  (`/home`, `/collector`, `/settings` — see `session/tabs.ts`) render a
  `PageHeader` with **no** `backHref`, because there is nowhere to go back to.
  **Every other screen sets `backHref`.**

## Props

- **`title`** — single line, ellipsis-truncates rather than wrapping. `ReactNode`, so a small inline chip can sit beside the text.
- **`subtitle?`** — optional secondary line: a machine string (a URL, a client id), mono, single-line. **Not** a heading, so the page keeps one `<h1>`.
- **`backHref?`** — absolute path to the page's **fixed logical parent**. Renders a leading back arrow. Omit only on the tab surfaces.
- **`backLabel?`** — accessible label for the back arrow (defaults to `Back`).
- **`actions?`** — optional trailing control (e.g. an overflow menu), aligned to the end of the bar.

## Why a fixed parent, not `history.back()`

`backHref` renders a TanStack `<Link>` to a **fixed logical parent path**, never a
history pop. A fixed parent is deterministic on a refreshed, deep-linked, or
OAuth-redirect landing — exactly the cases where there is no in-app history to
pop, so `history.back()` would dead-end or leave the app.

`react-tundraish` can write `<Link to={stringVar}>` because it compiles without
the app's router `Register` augmentation, so `to` stays `string` — no cast
needed. (`ItemList` reads `to` the same way.)

## Externally-published flows

A page that is reachable at an externally-published URL **and** wants an
owner-facing entry gets an inside-`/settings` **twin** route rather than moving —
the published route (headerless, no back link) and the `/settings/…` twin (with a
`backHref`) render the same header-less inner content. See the
[Settings Fragments How-To](./Settings%20Fragments%20How-To.md) for that pattern.

## See also

- [`PageHeader` component](../../global/react-tundraish/src/page-header.tsx) — the generic header this convention uses
- [Settings Fragments How-To](./Settings%20Fragments%20How-To.md) — the `/settings` surface and the outside/inside twin-route pattern
