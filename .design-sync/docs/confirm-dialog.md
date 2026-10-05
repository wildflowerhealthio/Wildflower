---
category: Feedback
keywords: confirm, dialog, modal, destructive, are you sure
---

# ConfirmDialog

A yes/no `Dialog`: a `title`, one question as `children` (rendered as the
dialog's paragraph), a confirm button labelled with the action's verb
(`confirmLabel`: "Disable", "Revoke"), and Cancel. The caller owns `open`.

- `destructive` paints the confirm button red (`accent-red`) for an action
  that takes something away.
- `pending` disables confirm while the action is in flight; Cancel stays live.
- `onCancel` receives Cancel, the ×, backdrop clicks, and ESC.

For anything beyond one question and two buttons, compose `Dialog` directly.
