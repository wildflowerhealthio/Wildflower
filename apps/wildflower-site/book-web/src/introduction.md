# How to Read This Book

This book reads the Wildflower code in the order its domain tells it. Each part takes one component and starts with an introduction: who is involved, what they ask for, and how the code is layered. Then come two chapters, each with a page per file:

- **Domain**, bottom up. Each entity gets a page: what it is and why it exists, then a section per method, saying what the method means in the domain, with the method and the unit tests that exercise it. The pages are ordered so that each concept is introduced before a later page needs it.
- **Integration Tests**, top down. Each test gets a section: the promise it holds the server to, the test, and links to the domain sections it relies on.

Read a part top to bottom the first time. Afterwards, it works as a way into a change you are reviewing: every method and test the part covers has one section, so a change to a method or a test points to the section to reread.

## The excerpts

Every excerpt is the real source, taken from the commit the book was built from. Nothing is copied by hand, so an excerpt can't drift from the code; when the code it names moves or is renamed, the book stops building until its chapter follows.

- An excerpt is a whole item (a function, a type, a method) or the part of one the story needs. A `// …` line marks where the excerpt skips lines.
- Doc comments and attributes are left out, because the prose around the excerpt does their job. Ordinary comments stay.
- The line under each excerpt links to those lines on GitHub, at the commit the book was built from, and to the item's package in the [code index](https://wildflowerhealth.io/code-index/), which shows what the package's files use and what uses them.

## Where the chapters live

Each chapter sits in a `docs/Book/` folder beside the code it explains, so a change to the code and to its chapter shows up in the same diff. This book only sets the reading order.
