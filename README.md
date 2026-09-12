# GenLayer Prediction Market Resolver

A GenLayer Intelligent Contract that runs a full prediction-market lifecycle -- staking, permissionless resolution from cited immutable web sources, a mandatory dispute window, settlement, and a hard-deadline exit -- with a **phase-gated `void()`** that cannot cancel a market while it is still open for staking.

- **Chain:** GenLayer Testnet Bradbury (Chain ID 4221)
- **Contract:** `contracts/prediction_market.py`
- **Primary proof:** offline consensus simulation `sim_market.py` -- **57/57** checks pass (includes the `void()` phase-gate test, T19)

## Steward review -- what changed (Sep 9 follow-up)

**Concern:** "Any account can call `void()` while a funded market is open, even before the staking deadline, and cancel it before resolution."

**Fix:** `void()` stays permissionless (no sender check), but now **gates on phase**. While `status == "open"` it reverts until `staking_deadline` passes, with the guard message:

    market still open for staking, cannot void before staking_deadline

Post-deadline voids (an unresolved market after `staking_deadline`) and dispute-phase voids are unchanged. A market that reached a definite YES/NO can never be voided.

- Source: `contracts/prediction_market.py` -- see `void()` and the guard string above.
- Test: `sim_market.py` T19 -- a pre-deadline `void()` reverts; a post-deadline `void()` on an unresolved market opens 1:1 refunds.
- Reproduce: `python3 sim_market.py` -> `57/57`.

## Contract lifecycle

| Method | Access | Notes |
|---|---|---|
| `__init__(...)` | deploy | validates and freezes config (>=2 sources, >=2 domains, binding excerpts, future deadlines); status `open` |
| `stake(side)` | payable, anyone | records tx value on the chosen side while `now < staking_deadline`; value must be > 0 |
| `resolve()` | anyone | after `staking_deadline` with >=1 staker; comparative consensus over binding-verified evidence; opens a dispute window on YES/NO |
| `dispute()` / `resolve_dispute()` | anyone | bounded 2-round dispute window |
| `settle()` | anyone | after the window; pari-mutuel pools; auto-voids if the winning side is empty |
| `finalize()` | anyone | after `final_deadline`: settle-or-void hard exit (1:1 refunds) |
| `void()` | anyone | permissionless, **phase-gated**: never while open for staking, never on a decided market |
| `refund()` | stakers | single-use 1:1 refund on a voided market |

Every consensus-critical decision is computed and stored on-chain by the contract.

## Verify (no keys needed)

    git clone https://github.com/Artem1981777/genlayer-prediction-market-v2
    cd genlayer-prediction-market-v2
    python3 sim_market.py        # expect: 57/57

`sim_market.py` is a self-contained, deterministic simulation of the contract's consensus and lifecycle logic (staking, dispute, settle, finalize, refund, and the void phase-gate). It needs only Python 3.

## On-chain status (honest)

The **gated** contract in this repo is **not yet deployed** on Bradbury: the testnet is currently not activating deploy transactions (submitted deploys time out without activation). The reproducible simulation above is the primary, self-contained proof of the fix. Any earlier deployment predates this fix and is intentionally not linked here, so nobody is pointed at pre-fix behavior; the gated version will be redeployed once testnet deploy activation recovers.

Deploy tooling is included for when the testnet recovers:

    npm install
    node --env-file=.env deploy.mjs   # requires a funded PRIVATE_KEY in .env (see .env.example)

## Repo layout

    contracts/prediction_market.py   # the Intelligent Contract (phase-gated void)
    sim_market.py                    # offline consensus simulation (57/57)
    deploy.mjs / common.mjs          # deploy tooling (Bradbury)
    rpc-relay.mjs / rpc-relay.html   # browser RPC relay helper
    test.mjs / test-payable.mjs      # on-chain lifecycle tests (need a funded key)
    verify.mjs                       # sha256 parity check (deployed vs source)
    docs/                            # EVIDENCE.md, REVIEW-RESPONSE.md, SECURITY-AUDIT.md

## License

MIT -- see `LICENSE`.
