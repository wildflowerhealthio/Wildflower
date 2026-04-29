# Agent Strategies

Hard-won lessons from agents working in this codebase. Read this at the start of a session if you're picking up in-progress work or tackling a large task.

Agents SHOULD NOT edit this file directly. Record new learnings in the [Learnings Inbox](./Learnings%20Inbox.md) instead — the human promotes entries here during periodic review.

## Context is your scarcest resource

You have a fixed context window. Everything you read, every tool output, every exploration result — it all counts. Plan your context budget like you'd plan a memory budget in an embedded system.

### Exploration discipline

- **Read 2-3 representative files, not 30.** For a mechanical refactor, one example of the pattern is enough. You don't need an exhaustive inventory before you start.
- **Explore agents return massive outputs.** Each one can eat 5-10% of your context. Use them surgically — ask for specific things, not "tell me everything about this package."
- **Don't explore what you can infer.** If you've seen `LocationFromFhirR4` and `PatientFromFhirR4`, you can safely assume `EncounterFromFhirR4` follows the same pattern without reading it.

### Planning vs doing

- **Mechanical refactors**: understand the pattern from examples, then execute. Don't over-plan.
- **Architectural decisions**: plan thoroughly. The cost of getting it wrong is high.
- **The smell test**: if you're reading the 5th file and learning nothing new, stop exploring and start doing.

### Document failure modes, not just the happy path

The pattern section of a handoff doc should include _when the pattern breaks_, not just how it works. "Drop explicit type annotations" is incomplete — "Drop explicit type annotations — _unless_ the const has circular inference, in which case extract to a separate const with an annotation" is what the next agent actually needs.

If you discover a gotcha mid-execution, **update the TODO.md immediately** — don't wait for a cleanup pass. The next agent (or the user) may pick up before you get to it.

### Generate file lists from grep, not from memory

Don't enumerate files to refactor by hand — you'll miss some. Use `grep` or `glob` to find all matches of the pattern you're changing (e.g., `grep -r 'FromFhirR4' src/`), then turn the results into your file list. The Range.ts miss in this refactor is a textbook example.

### Keep the plan current as execution diverges

In multi-session refactors, execution plan sections in TODO.md become stale as implementation diverges from the plan (renamed functions, changed approaches, deleted files). At each phase completion, update or replace plan sections with "what was actually built" summaries. Also update file reference tables — stale entries (e.g., listing files as "DELETE in Phase X" that are already deleted) mislead the next agent.

### Reference files that actually exist

If you reference another doc (e.g., a plan file), make sure it still exists. Dead links waste the next agent's time. If a plan has been superseded by the TODO.md, say so explicitly rather than linking to a ghost.

## Delegate mechanical bulk work

Once a pattern is clear and proven on 2-3 files, use Task agents to apply it to batches. This keeps the mechanical grinding out of your main context window.

Good candidates for delegation:

- Applying the same rename/restructure across 10+ files
- Updating import references after a rename
- Creating mirrored file structures (copying schemas to a new package)

Bad candidates (keep in main context):

- Files with unique structure or special cases
- Anything requiring judgment calls about the design

## Circular imports in Vite SSR

### `Schema.suspend` does not prevent circular module loading

`Schema.suspend(() => X)` defers schema _evaluation_ but does NOT prevent module _loading_. In Vite SSR, `import { X } from './X'` eagerly triggers the module to load. If module A imports B and B imports A, Vite snapshots A's exports (which are `undefined`) before A finishes executing. Even though the `Schema.suspend` callback runs later, any code that calls `A.Foo()` at class-definition time (outside `Schema.suspend`) will crash with `TypeError: Foo is not a function`. The fix is to restructure so no import chain leads back to the originating module — co-locate circular types in one file or eliminate the cycle entirely.

### Circular dependency chains are often transitive

When debugging circular import errors, the cycle is often not between the two files you expect. A 4-hop chain (A -> B -> C -> D -> A) produces errors in D that look like A is undefined. Read Vite's stack trace bottom-to-top to trace the actual module loading chain. Break the cycle at the root cause, not at intermediate links.

## Effect Schema gotchas

### `.Type` and `.Encoded` on Schema.Class are phantom types

`.Type` and `.Encoded` on Effect `Schema.Class` exist only in TypeScript's type system — they are `undefined` at runtime. Tests must use type-level assertions: `expectTypeOf<(typeof MyClass)['Type']['field']>()` — NOT `expectTypeOf(MyClass.Type.field)`, which crashes with `Cannot read properties of undefined`.

### Arbitrary generation on recursive schemas can explode

`Arbitrary.make()` on schemas with recursive fields (e.g., `extension` arrays via `Schema.suspend`) generates deeply nested structures with many optional fields, causing test timeouts. Fix: annotate the recursive array field with `{ arbitrary: () => (fc) => fc.constant([]) }` so property tests generate empty arrays by default. Place the annotation on the base field definition so all subclasses inherit it automatically.

### Schema.Class instances cannot be reconstructed via Object.create + Object.assign

Effect's `Schema.Class` instances carry internal state from `Data.Class` (hash codes, `_tag`, structural equality metadata). Reconstructing via `Object.create(proto) + Object.assign(result, fields)` produces objects that pass `instanceof` but fail during `Schema.encode`. When you need a modified copy, either mutate in-place (if not frozen) or do a Schema encode -> modify -> decode round-trip through the plain encoded representation.

## Recursive object walkers

When recursively walking Effect Schema-generated values, native built-in objects (`URL`, `Date`, `ReadonlyUrl`, etc.) look like plain objects to `typeof v === 'object'` checks. If walked and reconstructed, they lose their prototypes and fail during encoding. Always add explicit guards (`if (v instanceof URL) return v`) for non-POJO built-in types that might appear in the schema tree.

## Transient advice

Entries here may become stale as tools and workflows evolve. Agents should periodically check whether these are still accurate and note in the [Learnings Inbox](./Learnings%20Inbox.md) if something is outdated.

### Write tool "File has not been read yet" false positives

The Write tool tracks which files you've read and refuses to write to a file it thinks you haven't read. This tracking can fail when:

- **Context compression** drops the earlier Read from the tool's tracking, even though the content was in your context
- **Multiple parallel tool calls** — if one sibling call fails, the Write tool may report "Sibling tool call errored" on all others in the batch
- **Large conversations** — as the conversation grows, earlier Reads may no longer register

**Workarounds**:

1. If Write fails, re-Read the file (even just `limit: 5` lines) immediately before retrying
2. For batch writes across many files, prefer sequential over parallel to avoid the sibling-error cascade
3. Use Edit instead of Write when possible — Edit is less prone to this issue since it verifies against the file content directly

### Parallel tool calls: sibling error cascade

When you make multiple tool calls in a single message and one fails, all siblings may also fail with "Sibling tool call errored". This wastes a turn. To mitigate:

- Only parallelize tool calls that are very likely to succeed
- For writes to files you haven't recently read, do the reads first, then the writes

## Communicate proactively with the user

- If a refactor is going to touch 30 files, say so upfront with a rough context budget estimate
- If you're 40% through context and 20% through the work, surface it — don't wait for the user to notice
- When you discover a non-obvious gotcha mid-execution, note it immediately in the handoff doc
