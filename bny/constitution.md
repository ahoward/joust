# Constitution

## Core Principles

### I. POD Only (Plain Old Data)
All data structures are Plain Old Data. No classes for data containers.
Types are interfaces or type aliases. Functions transform POD to POD.

### II. Antagonistic Testing
Tests are specifications. Claude designs, Gemini challenges, then implement.
Tests MUST exist before implementation. Tests lock after review.

### III. Unix-Clean
STDOUT = final markdown. STDERR = everything else. Exit codes matter.
null over undefined. Pipes and streams where appropriate.

### IV. Bomber Filesystem
The filesystem is the database. Atomic writes only (`.tmp` → `fsync` → `rename`).
Crash recovery via implicit resume. Read consistency survives `kill -9`.
Metadata lives inside files, never in filenames.

### V. Simplicity (YAGNI)
Start simple. Three similar lines > one premature abstraction.
Full rewrites > diffs. Structural integrity > token golfing.
Complexity MUST be justified.

### VI. Adversarial by Design
Conflict produces hardened output. Consensus produces mush.
Invariants are enforced, not suggested. Violations trigger retry, not compromise.

## Naming

| Thing | Style | Example |
|-------|-------|---------|
| Constants | SCREAMING_SNAKE | MAX_RETRIES |
| Types | PascalCase | Snowball |
| Variables/functions | snake_case | write_atomic |

## Workflow

1. Design interface
2. Design tests (Claude)
3. Review tests (Gemini)
4. Implement
5. Loop until green
6. If stuck — human checkpoint

Version: 1.0.0
