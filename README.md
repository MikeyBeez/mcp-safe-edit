# mcp-safe-edit

Deterministic file editing for MCP.

Built after an audit of this system found the same defect shape in server after
server: **an operation runs and never checks the result matched the intent.**
An edit whose target text was absent reported success. An edit replaced the
first of three occurrences and said nothing. A move overwrote its destination.
A path check compared strings and let a symlink out of the sandbox.

None of those are edge cases. They are the normal outcome of writing the
fluent line and never being burned by it.

So every operation here states a precondition, counts what it matched, writes
atomically, and reads the file back to prove what landed. Nothing returns
success on the strength of not having thrown.

## The five properties

**1. Compare-and-swap.** `safe_read` returns a sha256. Pass it back as
`expect_sha256` and an edit computed against a stale copy is refused instead of
applied. This is what makes a concurrent change safe rather than silent.

**2. Match counting is mandatory.** An edit matches exactly once by default.
Zero matches is an error. Three matches is an error that tells you the line
numbers and how to resolve it — `replace_all`, `expect_count`, or a longer
`old`. There is no path through this server where an ambiguous edit picks one
for you.

**3. Batches are all-or-nothing.** Every edit is planned against the original
content before anything is written, and overlapping edits are refused because
their result would depend on application order. One bad edit means none apply.

**4. Writes are atomic and verified.** Temp file, fsync, rename, then re-read
and compare. A partial file is not reachable, and a claim of success is a
measurement rather than an assumption.

**5. Everything is literal.** Matching is `indexOf`, not regex — nothing in
`old` is ever interpreted. Replacement is slicing, not `String.replace`, so
`$&` and `$1` in `new` are ordinary characters.

## When a match fails, it tells you why

The three things that actually go wrong get named:

    edit[0]: text not found (0 matches) — searched for "const x = 1;\n".
      Diagnosis: would match if trailing whitespace were ignored.

Also detected: CRLF versus LF, tabs versus spaces, and the case where the first
line of a block matches but the rest does not — which localises the mismatch
instead of leaving you to bisect it.

## Two gates after the text is right

Getting the text edit right is not the same as leaving the file working. So an
edit passes through two more gates before it is allowed to stand.

**The structural gate (on by default).** Before writing, the file's inventory is
taken — every function, class, method, export, import, JSON key path, markdown
heading. The edit is applied in memory, the inventory is taken again, and
anything that disappeared is a refusal. Nothing reaches the disk, so there is no
window where the file is broken.

    Refused: the edit would remove 1 thing this file provides —
    export.function:beta. Nothing was written. If that removal is
    intended, pass allow_removals with those names.

Deleting things is allowed — you just have to say so. `allow_removals` turns a
silent loss into a declared one. An edit that leaves the file unparseable is
refused outright.

`safe_inventory` shows you the contract for any file.

**The behavioural gate (opt-in).** Structure is not behaviour. Only you know
what proves a file still works, so you name it:

    verify_command: ["npm", "test"]

It runs after the write. If it fails, **the file is rolled back to exactly what
it was**, and the error carries the command output and the diff that was
reverted. It is an argv array executed directly, never a shell string, so
nothing in it is interpreted.

Together: the text is what you asked for, the file still provides what it
provided, and it still passes your own test for working — or it never changed
at all.

## The function tree

A file is not a bag of text, it is a set of things it can do. `safe_functions`
decomposes it into every callable — including the ones nested inside other
callables, which every exports-level check misses:

    24-24   arrow    noteCall
    56-69   function remember
    94-117  function recall
    105-105   arrow    recall.<anonymous@105>
   143-154  function forget
   147-151   arrow    forget.<anonymous@147>

That gives three things the text layer cannot. Presence checking at the
granularity that matters — deleting `outer.inner` is refused even though no
export changed. An unambiguous edit address: `safe_edit_function` replaces a
function by name, because the parser knows exactly where it starts and ends, so
there is no "which occurrence did you mean". And a unit for mutation probing.

## Which functions is anything watching?

Line coverage tells you a line ran. It does not tell you anyone would notice if
that line were wrong, which is the only question worth asking.
`safe_function_report` takes each function in turn, breaks it on purpose, runs
your verification command, and records whether it complains.

Run against this repo's own brain server with `npm test`:

    watched       recall        24L
    UNWATCHED     search        15L
    watched       remember      14L
    watched       forget        12L
    UNWATCHED     recent         7L
    watched       stats          7L
    UNWATCHED     init           6L

    3 of 12 probed functions are UNWATCHED — you could break them and
    your verification would still pass.

That is not a demand for a test per function. Most functions do not need one,
and auto-generating hundreds would just mass-produce assertions that cannot
fail — the disease, not the cure. It is a map of where a test would actually buy
something.

## The latency switch: how hard to verify

Verifying everything on every edit is correct and unaffordable — each probe is a
full run of your suite, so a 20-second suite times twenty functions is a
seven-minute wait to change one line. So `safe_edit` scales the effort to the
edit, on a ladder you can see and override:

    structural   0 runs   AST gate only. A comment, whitespace, a declared
                          no-op. Instant.
    smoke        1 run    Run the suite once, roll back on failure. "Did I
                          break anything." No probing.
    changed      1 + k    smoke, then probe only the functions this edit
                          touched. "...and is my change actually watched."
    full         1 + n    changed, but probe every function. "Everything."

`verify_effort: auto` (the default) reads the edit and picks: a comment is
structural, a small change is `changed`, a big or structure-altering change is
`full`. Pass an explicit level to force one.

And because a long run of small `changed` edits can accumulate an interaction
bug that only a full pass would catch — function A's edit quietly breaking
function B — `auto` **escalates to full** once enough small edits, or enough
time, have passed since the last full check. Cheap by default, thorough on a
schedule. That is the "test occasionally because of latency" rule, made
mechanical.

## Watch the unwatched

The most dangerous edit is a change to a function nothing tests: it passes,
because nothing was ever going to fail. So when an edit lands in a function the
suite does not actually check — proven by breaking it and watching the suite
stay green — `safe_edit` returns a loud flag:

    This edit changed `secret`, which your verification does not actually
    check — a deliberate break there passed the suite. The edit is applied,
    but it is UNVERIFIED. Write a test for `secret` if this code matters.

It does not refuse the edit. It refuses to let the edit look verified when it is
not.

## Verifying the verifier

A passing test is worth exactly as much as that test's ability to fail. So when
`verify_command` passes, safe-edit does not simply believe it. It breaks the
file on purpose and checks the command notices.

**Probe 0 — destruction.** Replace the file with a syntax error and run the
command. If it still passes, it never touches this file, and every finer
question is moot:

    Your verify_command PASSED on a file that had been replaced with
    garbage. It does not exercise this file at all, so its green
    result says nothing about this edit.

**Probes 1..n — targeted mutants.** Small behavioural changes confined to the
lines this edit touched: `+` to `-` and to `*`, `===` to `!==`, `&&` to `||`,
`true` to `false`, a numeric literal off by one, a return value nulled. Each
runs the command once. A mutant that survives means the command loads the file
but does not check this behaviour, so its pass does not confirm the edit.

Every probe restores the real content in a `finally`, and the restoration is
confirmed by hash before returning. A probe cannot leave a mutant on disk.

Results are reported, not enforced — a good edit is not punished for a weak
test suite. Set `require_trustworthy_verification: true` to roll back an edit
whose verification proved uninformative.

### Why two arithmetic mutants and not one

This feature exists because of a specific bug in this repo's own tests. A test
sabotaged `add(a,b)` to `a*b` and asserted `add(2, 2) === 4`. Both give 4. The
verification passed, the rollback never fired, and a broken guarantee reported
green.

When the probe was first written it swapped `+` for `-` only. That mutant dies
to `add(2, 2)` — `2 - 2` is `0` — so the probe would have declared that
assertion sound. It took adding the `*` mutant to reproduce the original
blindness. One mutant per operator, because a mutant you did not generate is a
question you did not ask.

## What can and cannot be checked

    .js .mjs .cjs   acorn        functions, classes, methods, exports, imports
    .ts .tsx        typescript   the above, plus interfaces, type aliases, enums
    .py             python ast   functions, classes, methods, imports
    .json           parse        every key path
    .md             scan         headings, unbalanced code fences

TypeScript uses the real compiler, never the JavaScript parser with the types
ignored — that would choke on an annotation and report a healthy file as broken.
Exported interfaces and type aliases count as part of the contract, because
deleting one breaks every consumer and no runtime check would ever notice.

Pinned to typescript 5.x deliberately: TypeScript 7 is the Go rewrite, and its
package no longer exports the classic compiler API from the main entry — the AST
now lives under `./unstable/*`. A path with "unstable" in its name is not where
a safety check belongs.

Anything else is edited textually and the result says so:

    NO STRUCTURAL GUARANTEE: no structural analyzer for ".rs" files.
    The text edit was applied exactly as asked, but nothing verified
    that this file still does what it did.

That sentence is the discipline of this server pointed at itself. An analyzer
that quietly returned "looks fine" for a file it could not parse would be the
same bug one level up.

## Before any number is believed

A probe reads "the suite failed" as "the mutant was caught". Three things break
that reading, and all three fail in the confident direction:

- the suite was **already red** — then every breakage fails and everything looks watched
- the suite is **flaky** — then caught mutants are manufactured at random
- the runner **crashed or timed out** — not starting is not the tests objecting

So `safe_baseline` runs the verification several times on the unmodified file
first, and a red, flaky or crashed baseline means no per-function claim is made
at all. A verification result is `passed / failed / timeout / crashed`, and only
`failed` counts as caught; the rest are recorded as inconclusive.

Caching follows one rule, learned the hard way when a stale hit reported an
unwatched function as watched: **if you cannot name what has not changed, you do
not get to cache it.** A probe depends on every file in the repo, not just the
one being probed, so the default is memoisation within a single sweep and a disk
cache requires an explicit `cache_scope` — a git SHA, a lockfile hash.

## Known limits

Written down because a tool that implies a guarantee it does not have is the
thing this project exists to stop. An adversarial review of three independent
attackers produced all of these; each is either fixed or listed here.

**Coverage is one-sided.** `UNWATCHED` is reliable - every attack that tried to
fake it failed. `watched` was fakeable four different ways and each is now
blocked (see below), but treat a positive coverage claim as weaker evidence
than a negative one. Absence of coverage is proven; presence of coverage is
inferred.

**`verify_command` is arbitrary code execution.** It has to be - tests are
arbitrary code - but it means the containment guarantee covers file operations
only. `["/bin/sh","-c","..."]` runs anything you can run. Do not pass a command
you would not run yourself.

**Hardlinks defeat containment.** `realpath` cannot see them: a hardlink inside
an allowed root to a file outside it is genuinely inside the root by every test
the filesystem offers. Symlinks, `..` and prefix tricks are all blocked.

**The structural gate protects named things, not shapes.** Covered: functions,
classes, methods, nested functions, top-level bindings, exports, JSON keys and
array elements, Python decorators and class attributes, TS interfaces and type
aliases by name. NOT covered: interface and enum MEMBERS, TS overload
signatures, function signatures in any language, generics, and
`Object.assign(module.exports, {...})`. Restated: if deleting it removes a name,
you are covered; if it removes a member of a type or a parameter, you are not.

**Fixed, with regression tests, after the review:**

- the probe cache omitted file identity, so a byte-identical untested copy
  inherited a tested file's result - four cache hits, zero runs, fully "watched"
- a checksum or snapshot suite objected to garbage without executing a line, so
  every mutant looked caught. A **null probe** - appending one comment, which
  cannot change behaviour - now detects a suite that checks bytes instead
- a suite that degraded as it ran passed the up-front baseline; the baseline is
  now re-run after the sweep and a change voids the whole result
- two concurrent sweeps interleaved their mutants and each read the other's
  breakage as its own; sweeps now take an exclusive lock
- `allow_removals: ["A.handler"]` silently authorised `B.handler` too
- `backup_id` was pasted into a path, so `../../..` read files outside every root

## Tools

    safe_read            read a file, get its sha256 token
    safe_inventory       what this file provides — the contract edits are checked against
    safe_analyzers       which file types get a guarantee, and which do not
    safe_baseline        is your verification green and stable enough to trust
    safe_spec_generate   write the spec: what must pass AND what must fail
    safe_spec_check      still meets it? catches tests quietly getting weaker
    safe_rebuild_function  rebuild one function, gated on it staying watched
    safe_functions       the function tree, including nested functions
    safe_edit_function   replace one function by name, not by text match
    safe_function_report which functions your tests would notice breaking
    safe_edit            exact-text edits, counted and verified
    safe_preview         what safe_edit would do, writing nothing
    safe_write           whole-file write; overwriting needs the hash
    safe_replace_lines   replace a line range, asserting what is there
    safe_verify          does this file still have the hash I expect
    safe_list_backups    every mutation takes one first
    safe_restore         restore a backup; the restore is itself reversible
    safe_allowed_roots   what this server may touch

## Containment

Allowed roots come from argv. Paths are resolved with `realpath` before the
check, including dangling symlinks — which `realpath` throws on, and which
would otherwise be a free pass out of the sandbox for a create. That specific
hole was found by a test, in a first version of this fix elsewhere in the
codebase, about an hour before this server was written.

## Testing

    npm test

149 assertions, no todos. They run the real server over stdio against a
throwaway sandbox — nothing is stubbed.
