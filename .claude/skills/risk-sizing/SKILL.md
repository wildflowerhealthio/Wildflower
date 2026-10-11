---
name: risk-sizing
description: Set the org Risk field (Snack / Mainline / Rabbit-hole) on open non-epic issues. Opus sizer subagents read only each issue's title and body and call S/M/L/XL blind; S → Snack, M → Mainline, L or XL → Rabbit-hole. Sizes issues with no Risk yet (or the ones named), shows the proposed values, then applies them on approval.
---

> **⚠️ Scope:** Wildflower only (`wildflowerhealthio/Wildflower`), open issues, **never epics**. By default only issues whose Risk is unset; re-size others only when the user names them or asks for all. **Propose, then apply** — don't write Risk until the user approves in Step 4.

**🏅 Main objective:** every open non-epic issue carries a Risk value, so tickets can be picked by appetite: Snacks to fill a gap, Rabbit-holes to shape or split before starting.

---

## What the values mean

Risk says how likely a ticket is to blow past its appetite, not how many hours it takes. Measured on 161 completed non-epic tickets (active hours = the PR activity trail with idle gaps capped at 1 h; "grew" = needed several PRs or rework, or took 10+ active hours):

| Risk | Sizer said | Share of tickets | Active hours, median (p80) | Grew |
|---|---|---|---|---|
| **Snack** | S | ~15% | 2.4 h (3.0 h) | 0% |
| **Mainline** | M | ~49% | 3.3 h (5.5 h) | ~1 in 9 |
| **Rabbit-hole** | L or XL | ~36% | 4.0 h (8.2 h) | ~3 in 10 |

- **Snack** — pick it up in a gap; done in an afternoon.
- **Mainline** — ordinary work.
- **Rabbit-hole** — often a normal ticket, but shape it, set a cutoff or split it before starting.

Hours barely separate below ~5 h, so don't read the values as hour buckets. Two sizing passes over the same tickets agreed on 86% and were never more than one size apart.

---

## Repo facts (load-bearing)

- **Risk** is an org-level issue field next to **Priority**, readable and writable with `repo` scope. Look up the field and option IDs by name at run time:

  ```bash
  gh api graphql -f query='{organization(login:"wildflowerhealthio"){issueFields(first:20){nodes{... on IssueFieldSingleSelect{id name options{id name}}}}}}' \
    --jq '.data.organization.issueFields.nodes[] | select(.name=="Risk")'
  ```

- **Epics** are issues of type `Epic` or titled `Epic: …`. Skip them — an epic is big by definition.
- **The sizer is pinned.** [`sizer-preamble.md`](sizer-preamble.md), the `opus` model alias, title + body only. The table above was measured with exactly that; changing any of them means re-measuring before trusting the values. Don't add hour anchors, definitions of the sizes, or repo access.

---

## Step 1 — Collect the issues

```bash
gh api graphql --paginate -f query='query($endCursor:String){repository(owner:"wildflowerhealthio",name:"Wildflower"){
  issues(states:OPEN,first:100,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{number title body issueType{name}
    issueFieldValues(first:10){nodes{... on IssueFieldSingleSelectValue{name field{... on IssueFieldSingleSelect{name}}}}}}}}}' \
  --jq '.data.repository.issues.nodes[]' > "$SCRATCH/open_issues.jsonl"
```

Keep issues that are not epics and (unless the user said otherwise) have no Risk value. Write them, shuffled, as JSON arrays of `{number, title, body}` in batches of ~35 to `$SCRATCH/risk_in/b<k>.json`. `$SCRATCH` is the session scratchpad, never the repo.

Nothing to size → say so and stop.

---

## Step 2 — Size blind

Spawn one sizer per batch, all in one message, with `subagent_type: "general-purpose"` and `model: "opus"`. The prompt, verbatim apart from the paths:

> You are a blind ticket sizer. Read exactly two files and nothing else: `<repo>/.claude/skills/risk-sizing/sizer-preamble.md` (your instructions) and `$SCRATCH/risk_in/b<k>.json` (the tickets). Do NOT open any other file, do not list directories, do not search GitHub or the web. Follow the preamble, then write your JSON object to `$SCRATCH/risk_out/b<k>.json`. Reply with just "done" and the count of tickets sized.

Check every input number came back with S, M, L or XL; re-run a batch that didn't.

---

## Step 3 — Map

| Size | Risk |
|---|---|
| S | Snack |
| M | Mainline |
| L, XL | Rabbit-hole |

---

## Step 4 — Propose, then apply

Report the counts per Risk and list the Snacks and Rabbit-holes (`#N [size] title`); Mainline as a count, unless the user asks. Flag a Snack that is really a decision only the maintainer can make — it is small for her, not agent work.

Ask with `AskUserQuestion` whether to apply. On yes, set each value with `setIssueFieldValue` (it leaves Priority and other fields untouched):

```bash
gh api graphql -F n=<N> -f query='query($n:Int!){repository(owner:"wildflowerhealthio",name:"Wildflower"){issue(number:$n){id}}}' --jq '.data.repository.issue.id'
gh api graphql -F id=<issue id> -f o=<option id> -f query='mutation($id:ID!,$o:ID!){setIssueFieldValue(input:{issueId:$id,
  issueFields:[{fieldId:"<Risk field id>",singleSelectOptionId:$o}]}){clientMutationId}}'
```

Then re-run the Step 1 query and confirm every targeted issue reads the intended Risk. Report any that failed.

---

## Anti-patterns

- 🚫 Sizing epics.
- 🚫 Letting a sizer see the repo, comments, linked PRs or anything beyond title + body.
- 🚫 Editing `sizer-preamble.md` or asking for a rationale "to help" — that's a different, unmeasured estimator.
- 🚫 Overwriting an existing Risk the user didn't ask to re-size; a human may have set it.
- 🚫 Presenting Risk as hours.
