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

## Tools

    safe_read            read a file, get its sha256 token
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

48 assertions, no todos. They run the real server over stdio against a
throwaway sandbox — nothing is stubbed.
