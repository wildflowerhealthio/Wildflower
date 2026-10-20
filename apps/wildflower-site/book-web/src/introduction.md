# How to Read This Book

This book reads the Wildflower code in the order its domain tells it. Each part takes one component and starts with an introduction: who is involved, what they ask for, and how the code is layered. Then the part reads the code twice:

- **Bottom up**, one chapter per layer, from the domain's entities through the rules about who may write what, the operations, the HTTP surface and the wiring, down to the SQL. Each chapter needs only the ones before it.
- **Top down**, in **Integration Tests**. Each test gets a section: the promise it holds the server to, the test, and links to the items it relies on.

Read a part top to bottom the first time. Afterwards, it works as a way into a change you are reviewing: every item and test the part covers is shown once, so a change to one points to the place to reread.

## How a page reads

A page's headings follow the code: a module, then the types in it, then their methods. Under each heading, an item reads in the same order every time:

1. **Its doc comment, as prose.** What the item means in the domain, in the words the code itself carries.
2. **Its code**, under the prose. A struct or enum keeps its fields' and variants' doc comments in the code, so they document themselves.
3. **Its tests**, one after another, each captioned by its doc comment: the promise that test holds the item to.

The page's own prose sits between items and says what crosses them: the domain story, why things are as they are, and how the pieces relate. Names in the prose and the doc comments link to where the item they name is shown.

The helpers the tests share, the fixtures that build an entity or a server for a test, are on the **Test Fixtures** page at the end of each part. A test that first uses one links to it.

## The excerpts

Every excerpt is the real source, taken from the commit the book was built from. Nothing is copied by hand, so an excerpt can't drift from the code; when the code it names moves or is renamed, the book stops building until its chapter follows.

- An excerpt is a whole item (a function, a type, a method) or the part of one the story needs. A `// …` line marks where the excerpt skips lines.
- An item's doc comment shows as the prose above its code, not in it, and attributes are left out. Ordinary comments stay.
- The line under each excerpt links to those lines on GitHub, at the commit the book was built from, and to the item's package in the [code index](https://wildflowerhealth.io/code-index/), which shows what the package's files use and what uses them.

## Where the chapters live

Each chapter sits in a `docs/Book/` folder beside the code it explains, so a change to the code and to its chapter shows up in the same diff. This book only sets the reading order.
