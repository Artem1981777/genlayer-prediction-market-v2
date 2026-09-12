# Evidence -- GenLayer Prediction Market Resolver

This document maps the steward's concern to the exact fix, source location, and reproducible test.

## Claim addressed (Sep 9 follow-up, Pavel Kolosov)

"Any account can call void() while a funded market is open, even before the staking deadline, and cancel it before resolution."

## Fix

void() remains permissionless (no sender check) but is now phase-gated. While status == "open", void() reverts until staking_deadline passes:

    market still open for staking, cannot void before staking_deadline

- Post-deadline voids (unresolved market after staking_deadline): unchanged, open 1:1 refunds.
- Dispute-phase voids: unchanged.
- Decided market (definite YES/NO): can never be voided.

## Where

| Item | Location |
|---|---|
| Contract method | contracts/prediction_market.py -> void() |
| Guard message | market still open for staking, cannot void before staking_deadline |
| Simulation | sim_market.py -> T19 |

## How to reproduce (no keys, no network)

    git clone https://github.com/Artem1981777/genlayer-prediction-market-v2
    cd genlayer-prediction-market-v2
    python3 sim_market.py

Expected output: 57/57 checks pass. T19 specifically asserts:
1. A void() call while the market is still open for staking (now < staking_deadline) reverts with the guard message.
2. A void() call on an unresolved market after staking_deadline succeeds and opens 1:1 refunds.

## On-chain status

The gated contract is not yet deployed on Bradbury (testnet is not activating deploy transactions; submitted deploys time out without activation). The reproducible simulation above is the primary, self-contained proof. The gated version will be redeployed once testnet deploy activation recovers. No pre-fix contract is linked, to avoid pointing anyone at pre-fix behavior.
