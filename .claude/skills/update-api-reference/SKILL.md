---
name: update-api-reference
description: Update docs/api/ when any public SDK surface in src/index.tsx or src/models.ts changes. Use after adding/modifying/removing any export, signature, type, error code, or default value. Trigger whenever facade-changed-reminder or nudge-api-doc-update hooks fire, when sdk-architect's plan-output includes a Docs/example section, or as part of the add-native-method skill's Step 7.
---

# Updating the API reference docs

`docs/api/` is the canonical, OpenAI-style reference for consumers of the SDK. It must stay in lockstep with the source. This skill walks the procedure.

## When to run this

Run whenever **any** of these changed:

- `src/index.tsx` — Engine class methods, exported types, error makers.
- `src/models.ts` — Models namespace methods, exported types.
- `src/NativeBitnet.ts` — Spec changes that surface through the JS facade.
- Any other `src/*.ts(x)` that adds or modifies an `export`.

If only internal-helper code changed (not exported), no doc update needed.

## The mapping

```
Source change                                  →  Doc file(s) to update
─────────────────────────────────────────────     ──────────────────────────────────────
New Engine method                              →  docs/api/engine.md (+ index in docs/api/README.md)
New chat.completions overload                  →  docs/api/chat-completions.md
New Models.* method                            →  docs/api/models.md (+ index)
New exported type                              →  docs/api/types.md (+ link from method that uses it)
New E_* error code or AbortError variant       →  docs/api/errors.md (+ link from method's Throws table)
New event shape                                →  docs/api/events.md
New streaming surface or pattern               →  docs/api/streaming.md
Changed default value, signature, or type      →  the same files listed above for that symbol
Removed/renamed export                         →  delete/rename + note at the bottom of the section ("Removed in vX.Y.Z")
```

## Procedure

### 1. Diff the source

```sh
git diff main...HEAD -- src/index.tsx src/models.ts src/NativeBitnet.ts
```

Note every:
- Added/removed/renamed `export`.
- Changed function/method signature (params, return type).
- Changed default value (look at `?? <default>` patterns in the JS facade).
- Added/removed `E_*` string literals.

### 2. Update method docs

For each affected method, update the section in the appropriate `docs/api/*.md`:

- **Signature** code block matches the current TS source.
- **Parameters table** — every param row matches the current signature, including the Default column. Required column reflects optionality (`yes` / `no` / `one of` for the `modelPath`/`modelRef` xor).
- **Returns** section reflects the resolved value's shape.
- **Throws table** — every error that can fire from this method has a row, linked to `errors.md`.
- **Examples** — at least one is updated to exercise the change. Make sure the example compiles (`yarn typecheck` would catch it if extracted, which it isn't currently — be careful).

### 3. Update `types.md`

If a new type was exported or an existing type changed:

- Add/update the section in `docs/api/types.md`.
- Inline the TS definition verbatim from source.
- Add a brief prose description.
- Cross-link from any method that uses it (relative `./types.md#typename` anchor).

### 4. Update `errors.md`

For each new `E_*` code:

- Add a section under either "Engine errors", "Download / cache errors", or "Generic errors".
- Document: throws-from-where, shape (`Error & { code: 'E_FOO' }`), recovery pattern, example try/catch.
- Cross-link from every method's Throws table that can now throw this code.

### 5. Update `docs/api/README.md` (index) if surface changed

The index page has a per-method table. If you added or removed a method, update the table.

### 6. Update README (if needed)

The main `README.md` API section is a "Quick reference" pointer. It mentions every public method at the per-name level (no signatures). If you added or removed a method, add/remove the bullet. Don't expand signatures back into the README — `docs/api/` is the canonical source.

### 7. Run the coverage check

```sh
# Symbols exported from src/
diff \
  <(grep -E "^export (class|function|const|interface|type)" src/index.tsx src/models.ts | awk '{print $3}' | sort -u) \
  <(grep -hE "^##+ \`[a-zA-Z]" docs/api/*.md | grep -oE '`[^`]+`' | sort -u)
```

Empty diff = every export has a matching doc section. Filter out non-public symbols if any false positives appear.

### 8. Sanity-check the cross-references

```sh
# Every relative link in docs/api/
grep -hoE '\]\(\./[^)]+\)' docs/api/*.md | sort -u
```

Manually confirm each target file + anchor exists. GitHub renders anchors as lowercase-kebab-case of the heading text (after stripping symbols).

### 9. Hand off

After your edits, hand off to `@doc-sync-auditor` for a final cross-check. They run the same greps + a wider audit (CLAUDE.md freshness, ADR references, etc.).

## Style rules

- **Defaults documented** for every optional parameter — in the table's Default column and again in the prose if non-obvious.
- **Single quotes** in TS examples (matches Prettier).
- **Real, runnable examples.** No pseudo-code or `...` placeholders unless explicitly labeled.
- **`.code` shape shown** in every throws table entry, e.g. `Error & { code: 'E_ENGINE_BUSY' }`.
- **Relative anchors only** — no full URLs to `docs/api/`. Anchors lowercase-kebab-case.
- **No marketing language.** Match the existing voice — technical, terse, factual.
- **No emoji.** Per repo convention.

## Common mistakes

- **Updating signatures in `engine.md` but forgetting the index table in `docs/api/README.md`.** The index is part of the contract.
- **Forgetting the type cross-link.** If a method now returns a new type, the method's Returns row should link to `./types.md#newtype`.
- **Documenting an `E_*` code in only one place.** Every code lives in `errors.md`. Throws tables in method docs **link** to that anchor; they don't redefine the code.
- **Documenting JSDoc that doesn't exist.** The repo currently has zero JSDoc blocks. If you add a JSDoc, also add the doc — but don't claim JSDoc exists when it doesn't.

## See also

- [`doc-sync-auditor`](../../agents/doc-sync-auditor.md) — runs after this skill for a final pass.
- [`sdk-api-reviewer`](../../agents/sdk-api-reviewer.md) — gates the public-surface change itself (breaking-change detection, semver).
- [`add-native-method`](../add-native-method/SKILL.md) — Step 7 lands here.
- [`facade-changed-reminder.sh`](../../hooks/facade-changed-reminder.sh) — the hook that points here.
- [`nudge-api-doc-update.sh`](../../hooks/nudge-api-doc-update.sh) — the Stop-hook nudge.
