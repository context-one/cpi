---
name: commit
description: Create a well-structured git commit with conventional commit messages. Use when the user asks to commit changes, create a commit, or save their work.
---

# Commit Skill

Create a git commit following best practices.

## Procedure

1. **Check status** — Run `git status` to see all changed files. Never use `-uall` flag.

2. **Review changes** — Run `git diff` and `git diff --staged` to understand what changed.

3. **Check recent history** — Run `git log --oneline -5` to match the project's commit style.

4. **Draft commit message** — Analyze the changes and write a message that:
   - Summarizes the nature of the change (feature, fix, refactor, test, docs)
   - Focuses on **why** rather than **what**
   - Is concise (1-2 sentences)
   - Uses conventional commit format if the project uses it

5. **Stage files** — Add specific files by name. Do NOT use `git add -A` or `git add .` which can accidentally include sensitive files.

6. **Check for secrets** — Do NOT commit files that may contain secrets (`.env`, `credentials.json`, API keys). Warn the user if they ask to commit such files.

7. **Commit** — Create the commit. Always pass the message via HEREDOC:
   ```bash
   git commit -m "$(cat <<'EOF'
   Commit message here
   EOF
   )"
   ```

8. **Verify** — Run `git status` to confirm the commit succeeded.

## Rules

- Never amend commits unless explicitly asked
- Never push unless explicitly asked
- Never use `--no-verify` or skip hooks unless explicitly asked
- If a pre-commit hook fails, fix the issue and create a NEW commit (do not amend)
- If there are no changes, do not create an empty commit
