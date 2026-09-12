# Evidence — v2.1 (phase-gated void) deployment and proofs

All transactions below were executed against GenLayer Testnet Bradbury and are
publicly verifiable by hash on the explorer. The contract deployed for this
review cycle is **v2.1**: v2 plus the `void()` phase gate from the Sep 9
steward request (see [`docs/REVIEW-RESPONSE.md`](./REVIEW-RESPONSE.md)).

> Placeholder — addresses and tx hashes will be filled in immediately after
> the v2.1 deploy completes. (This note is removed with the evidence commit.)

## 1. Deployed contract (v2.1)

| Contract | Address | Source | Deploy tx |
| --- | --- | --- | --- |
| Prediction Market v2.1 (showcase) | TBD | `contracts/prediction_market.py` | TBD |

Deploy parity: TBD (sha256, `parity-proof.txt`).

## 2. Phase-gate regression on-chain

| Action | Caller | Market | Tx | Result |
| --- | --- | --- | --- | --- |
| `void()` before `staking_deadline` (funded, open market) | stranger | TBD | TBD | REVERT — "Market is still open for staking; void unlocks after the staking deadline (use finalize after final_deadline)" |
| `void()` before `staking_deadline` | creator | TBD | TBD | REVERT (same) |
| market state after early void attempts | — | TBD | — | unchanged (funded, open) |
| `void()` after `staking_deadline` | stranger | TBD | TBD | `voided`, refunds open |
| `refund()` after phase-gated void | staker | TBD | TBD | 1:1 |

## 3. Permissionless lifecycle unchanged (non-creator account)

| Action | Tx | Result |
| --- | --- | --- |
| `resolve()` (stranger) | TBD | TBD |
| `resolve_dispute()` (stranger) | TBD | TBD |
| `settle()` (stranger) | TBD | TBD |
| `finalize()` (stranger, after `final_deadline`) | TBD | TBD |

## 4. Test suites

| Suite | Result |
| --- | --- |
| `sim_market.py` (offline, T18 phase-gate regression) | 59/59 |
| `test-payable.mjs` (deterministic on-chain) | TBD |
| `test.mjs` (AI lifecycle on-chain) | TBD |
| GenVM lint | clean (`lint_out.txt`) |
| Deploy parity (`verify.mjs`, sha256 byte-for-byte) | TBD |
