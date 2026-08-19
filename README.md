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

    .js .mjs .cjs   full parse (acorn) — functions, classes, methods, exports, imports
    .py             full parse (python ast) — functions, classes, methods, imports
    .json           every key path
    .md             headings, plus unbalanced code fences

TypeScript has deliberately **no** analyzer. Parsing `.ts` with a JavaScript
parser would choke on type annotations and report a healthy file as broken,
which is worse than admitting the gap. Any unlisted type is edited textually and
the result says so:

    NO STRUCTURAL GUARANTEE: no structural analyzer for ".ts" files.
    The text edit was applied exactly as asked, but nothing verified
    that this file still does what it did.

That sentence is the whole discipline of this server pointed at itself. An
analyzer that quietly returned "looks fine" for a file it could not parse would
be the same bug one level up.

## Tools

    safe_read            read a file, get its sha256 token
    safe_inventory       what this file provides — the contract edits are checked against
    safe_analyzers       which file types get a guarantee, and which do not
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

78 assertions, no todos. They run the real server over stdio against a
throwaway sandbox — nothing is stubbed.
