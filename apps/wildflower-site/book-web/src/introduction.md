# How to Read This Book

This book reads the Wildflower code in the order its domain tells it. Each part takes one component, starts with a map of who is involved and how the code is layered, and then follows a story through it: one request, one decision, one rule. Where the story depends on the code, the code is right there.

Read a part top to bottom the first time. Afterwards, it works as a way into a change you are reviewing: find the story the change touches, and the excerpts show where it lands.

## The excerpts

Every excerpt is the real source, taken from the commit the book was built from. Nothing is copied by hand, so an excerpt can't drift from the code; when the code it names moves or is renamed, the book stops building until its chapter follows.

- An excerpt is a whole item (a function, a type, a method) or the part of one the story needs. A `// …` line marks where the excerpt skips lines.
- Doc comments and attributes are left out, because the prose around the excerpt does their job. Ordinary comments stay.
- The line under each excerpt links to those lines on GitHub, at the commit the book was built from, and to the item's package in the [code index](https://wildflowerhealth.io/code-index/), which shows what the package's files use and what uses them.

## Where the chapters live

Each chapter sits in a `docs/Book/` folder beside the code it explains, so a change to the code and to its chapter shows up in the same diff. This book only sets the reading order.
