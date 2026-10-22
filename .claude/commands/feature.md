---
description: Run one task through the ReplayLab team pipeline (worker, QA, motherheads, commit)
argument-hint: <feature or task>
---
Run this task through the team flow in CLAUDE.md: $ARGUMENTS

1. Pick the owning worker(s) from the pod table in CLAUDE.md. If the task changes docs/SPEC.md or the engine's public API, get chief-motherhead's ruling first.
2. Run the worker subagent with the task and the SPEC sections it needs.
3. If the change touched packages/engine or services/data, run qa-tester on it.
4. Run the pod motherhead with the worker and QA reports. On FAIL, send the blocking issues back to the worker and repeat. After 3 failed rounds, stop and ask Arsh.
5. Run chief-motherhead with all reports. On HOLD, route bounced items the same way.
6. On SHIP, commit with a clear message and push to origin.
7. Tell Arsh in under 10 lines: what shipped, test results, anything waiting on him.
