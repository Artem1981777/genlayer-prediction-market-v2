# Review response — prediction-market lifecycle (void() phase gate)

## Steward request (Pavel Kolosov, Sep 9, 2026) — quoted verbatim

> "The evidence-source controls and final-deadline refund path are now present, but
> the requested lifecycle fix is still incomplete: **any account can call void()
> while a funded market is open, even before the staking deadline, and cancel it
> before resolution.** Since the resubmission does not fully resolve the previous
> lifecycle request, we cannot proceed with it in its current form."

## The finding was real — and it is now fixed at the exact spot

In v2-as-reviewed, `void()` had become fully permissionless (no creator check —
correct per the earlier steward request) but carried **no phase gate**: while a
funded market was still `open` and `now < staking_deadline`, any account could
void it, cancelling the market mid-trading. That is a griefing vector.

**Fix — one surgical assert in `contracts/prediction_market.py`, `void()`**

```python
assert _chain_now() >= self.staking_deadline, "Market is still open for staking; void unlocks after the staking deadline (use finalize after final_deadline)"
```

### void() state machine after the fix

| Market state | `now` vs deadlines | caller | result |
| --- | --- | --- | --- |
| `open`, funded | `now < staking_deadline` (trading live) | anyone, incl. creator | **REVERT** — "Market is still open for staking; void unlocks after the staking deadline (use finalize after final_deadline)" |
| `open` (unresolved, hung after trading closed) | `now >= staking_deadline`, resolve not yet succeeded | anyone | **voids** — permissionless safety valve, 1:1 refunds open |
| `dispute_window` / `dispute_resolved`, no definite outcome | — | anyone | **voids** (unchanged) |
| definite YES/NO outcome | — | anyone | **REVERT** — settle it instead |
| after failed `settle()` with empty `winning_side` | — | anyone | already auto-voided (unchanged) |
| `settled` / `voided` (terminal) | — | anyone | **REVERT** (unchanged) |

`finalize()` (the hard-deadline exit after `final_deadline`) is untouched and
remains the unconditional permissionless escape: settle if a definite outcome
survived its dispute window, else void + 1:1 refunds.

### What deliberately did NOT change

- `void()` keeps **no sender check** — permissionless access is intentional and
  required by the earlier steward request; only the **phase** is now gated.
- `resolve()`, `resolve_dispute()`, `settle()`, `finalize()`, `stake()`,
  `claim()`, `refund()` — all signatures and permission structure unchanged.

## Regression proof — offline simulation (`sim_market.py`, 59/59)

Test block **T18 "permissionless void of an unresolved market (phase-gated)"**
drives the exact attack and the exact fix:

| T18 check | expectation |
| --- | --- |
| void BEFORE staking deadline rejected (griefing regression) | PASS — revert |
| funded market still open after the early void attempt | PASS — state unchanged |
| void before staking deadline rejected for the CREATOR too | PASS — the gate is a phase gate, not an identity gate |
| market unchanged after early void attempts | PASS — pools, status, positions intact |
| void by a stranger AFTER the staking deadline works | PASS — permissionless valve intact |
| refund 1:1 after the phase-gated void | PASS |
| double void rejected | PASS |
| void with definite YES outcome rejected | PASS |

Full run: `CHECKS: 59  PASSED: 59  FAILED: 0` (up from 54 — the regression
block added 5 checks). GenVM lint: clean (`lint_out.txt`).

## On-chain proof (Testnet Bradbury, contract v2.1)

Deployed fresh from this repository (byte-for-byte parity proven by
`verify.mjs`, sha256 in `parity-proof.txt`). Executed on-chain:

- **Early void reverts**: a **non-creator** account calls `void()` on a funded,
  still-open market before `staking_deadline` → transaction fails with the
  revert message above; market state unchanged. The same call by the creator
  also reverts.
- **Post-deadline void stays permissionless**: after `staking_deadline`, the
  non-creator account voids the unresolved market → `voided`, refunds open,
  staker refunds 1:1.
- **The rest of the lifecycle is unchanged and permissionless**:
  `resolve()` / `resolve_dispute()` / `settle()` / `finalize()` all still
  executable by the non-creator account at the right phases (full 20/20
  deterministic suite + 19/19 AI-lifecycle suite, `test-payable-results.txt`
  / `test-results.txt`).

Exact addresses and transaction hashes for every claim above:
[`docs/EVIDENCE.md`](./EVIDENCE.md).
