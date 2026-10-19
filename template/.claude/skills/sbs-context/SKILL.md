---
name: sbs-context
description: Show model, context size and output tokens of the PM and every slow-but-sure subagent (lead-dev, dev, reviewer, lead-qa, qa) in this session. Only when the user runs /sbs-context.
argument-hint: "[--all]"
disable-model-invocation: true
allowed-tools: Bash(node .claude/skills/slow-but-sure/scripts/context.mjs:*)
---

!`node .claude/skills/slow-but-sure/scripts/context.mjs ${CLAUDE_SESSION_ID} $ARGUMENTS`

Print the table above to the user exactly as it is, inside a code block. Add nothing else.
