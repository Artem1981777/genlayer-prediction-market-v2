# Review response -- void() phase-gate (Sep 9 follow-up)

Thank you for the follow-up. The reported issue is fixed.

## Your concern

"Any account can call void() while a funded market is open, even before the staking deadline, and cancel it before resolution."

## What changed

void() stays permissionless by design (no creator or sender privilege), but it now gates on the market phase:

- While status == "open", void() reverts until staking_deadline passes, with the message: market still open for staking, cannot void before staking_deadline
- After staking_deadline, an unresolved market can still be voided by anyone (opens 1:1 refunds) -- unchanged.
- Dispute-phase voids -- unchanged.
- A market that reached a definite YES/NO can never be voided.

So a funded, still-open market can no longer be cancelled before its staking deadline, which closes the griefing path you described, while keeping the lifecycle fully permissionless.

## Proof (reproducible, no keys)

    git clone https://github.com/Artem1981777/genlayer-prediction-market-v2
    cd genlayer-prediction-market-v2
    python3 sim_market.py

Expected: 57/57. sim_market.py T19 asserts both the pre-deadline revert and the post-deadline refund path.

- Contract: contracts/prediction_market.py -> void()
- Full mapping: docs/EVIDENCE.md

## On-chain note

The gated contract is not yet redeployed on Bradbury because the testnet is currently not activating deploy transactions (submitted deploys time out without activation). The reproducible simulation is the primary proof; the gated contract will be redeployed once testnet deploy activation recovers. I have intentionally not linked any earlier deployment, since those predate this fix.
