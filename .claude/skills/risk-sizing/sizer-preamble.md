# Ticket T-shirt sizer — preamble v1

## Context you may assume
Wildflower is a health-data monorepo (Effect-TS + React web/Tauri apps, Rust servers/relay, SMART on FHIR apps, a Pebble
watch app, CI/release workflows). One maintainer does the work, directing Claude Code agents that write most of the code;
the maintainer specs, reviews, tests and merges. Work lands as GitHub pull requests with CI.

## Task
Give each ticket a T-shirt size — **S**, **M**, **L** or **XL** — for how much effort the whole job will take, from
starting work to the final PR merged. Use your own sense of what those sizes mean.

## Rules
- Use ONLY the ticket title and body you are given. Do not look anything up, read the repository, or search GitHub.
- Size each ticket on its own merits.
- No explanation, no rationale.

## Output
A JSON object mapping ticket number to size, e.g. {"123": "M", "456": "S"}.
