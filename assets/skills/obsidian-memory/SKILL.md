---
name: obsidian-memory
description: Recall project memory or save reusable lessons to Obsidian only when explicitly requested. Exclude automatic task closeout, raw transcripts, and secrets.
when_to_use: "obsidian-memory"
disable-model-invocation: true
---

# obsidian-memory

Bot entrypoint. The vault is optional. Keep authority in repo artifacts;
sync direction is repo → brain. A machine with no vault path set is a legitimate steady state.
The skill resolves the root fail-closed. Never guess or create one to complete a task.
No repo-harness command reads or writes the vault; only this skill does, and only when invoked.
Use `references/worker.md` for the assigned recall, formatting, write and index steps.

Exclusion-first write gate: anything already recorded by Git, CI, a registry,
or a re-runnable command gets only a pointer in the vault, never a restatement.
Save only reusable reasons or methods that have one authoritative home.
Exclude secrets and transient status. Verify recalled claims against current state.
An ordinary task does not require memory persistence.
