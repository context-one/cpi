---
name: review
description: Review code changes for bugs, security issues, and quality problems. Use when the user asks to review a PR, diff, or set of changes.
---

# Code Review Skill

Review code changes with focus on correctness, security, and maintainability.

## Procedure

1. **Identify scope** — Determine what to review:
   - If a PR number is given: `git log main..HEAD --oneline` and `git diff main...HEAD`
   - If reviewing staged changes: `git diff --staged`
   - If reviewing recent work: `git diff HEAD~1`

2. **Read changed files** — Read the full context of each modified file, not just the diff. Understanding surrounding code is critical.

3. **Check for issues** — Evaluate changes against these categories:

   **Bugs & Logic Errors**
   - Off-by-one errors, null/undefined handling, race conditions
   - Incorrect boolean logic, missing edge cases
   - Broken error propagation

   **Security**
   - Command injection, XSS, SQL injection
   - Hardcoded secrets or credentials
   - Missing input validation at system boundaries
   - Insecure defaults

   **Code Quality**
   - Dead code, unused imports, unnecessary complexity
   - Missing error handling for external calls
   - Inconsistency with surrounding code patterns

4. **Report findings** — For each issue found:
   - State the file and line number
   - Describe the problem clearly
   - Explain the impact (bug, security risk, maintenance burden)
   - Suggest a specific fix
   - Rate confidence: high, medium, or low

5. **Summarize** — Provide an overall assessment:
   - Is this safe to merge?
   - What are the highest-priority issues?
   - Any positive observations worth noting

## Rules

- Only report issues you're confident about (medium or high confidence)
- Don't nitpick style if the project has no linter enforcing it
- Don't suggest adding comments, docstrings, or type annotations unless there's a real clarity problem
- Focus on what matters: correctness, security, and maintainability
