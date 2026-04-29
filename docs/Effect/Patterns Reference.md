# Effect Patterns Reference

Effect-TS conventions used in this codebase.

## Effect Generators

Use generator syntax for composition:

```typescript
export const createEncounter = (args: CreateEncounterArg) =>
  Effect.gen(function* () {
    const repo = yield* EncounterRepository
    return yield* repo.create(args)
  })
```

## See Also

- [Learnings Inbox](../Agents/Learnings%20Inbox.md) — Project-specific Effect/HttpApi gotchas discovered during recent work
