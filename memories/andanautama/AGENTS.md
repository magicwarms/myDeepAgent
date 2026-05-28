---
name: agents-index
description: Index for the agent's long-term memory. Always loaded.
---

# Agent Memory Index

User namespace: andanautama

This directory is the agent's persistent memory. Each file holds a category:

- [User profile](user_profile.md) — who the user is (role, expertise, goals)
- [Preferences](preferences.md) — workflow, tone, tooling, style preferences
- [Facts](facts.md) — specific facts the user has shared
- [Decisions](decisions.md) — technical decisions, conventions, choices made together

Keep entries terse. Lead with the fact, follow with **Why:** and **When:** lines when the reasoning matters.
