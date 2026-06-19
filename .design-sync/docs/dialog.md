---
category: Feedback
keywords: dialog, modal, confirm, overlay
---

# Dialog

Modal overlay over the native `<dialog>` element. Controlled by `open`;
`onClose` fires on dismissal (× button, ESC, backdrop). `title` is a separate
prop; the modal body is the children — typically a sentence plus an action row
of `button-2` controls.

For a confirmation the user must answer, set `dismissable={false}` (no ×, ESC
and backdrop swallowed). Destructive confirmations pair an
`accent-red filled` button with an `outline` cancel.
