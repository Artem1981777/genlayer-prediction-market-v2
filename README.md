# GenLayer Prediction Market Resolver v2

An Intelligent Contract that resolves YES/NO prediction markets on GenLayer by having validators reach optimistic-democracy consensus over live web evidence, then binds that verdict to a verifiable market record and settles real stakes through it.

**v2 hardens the design against the three steward-review findings:**

1. **Permissionless lifecycle + hard deadline exit — funds can never lock.**
   `resolve()`, `resolve_dispute()`, `settle()`, `void()` and `finalize()`
   carry NO creator check: any account may drive the lifecycle once the phase
   gates pass. Trading is bounded by `staking_deadline`; resolution opens
   after it. `finalize()` is the permissionless hard exit: once
   `final_deadline` passes, ANY account can always finish the market —
   settling (paying the winners) when a definite outcome survived its
   dispute window, otherwise voiding it with 1:1 refunds open for everyone.
   No state of the world keeps a staker from exiting past `final_deadline.
2. **Immutable, independent, semantically bound sources.**
   The source set is fixed in the constructor (`add_source` no longer
   exists), must contain at least two URLs from at least two different
   registrable domains (deterministic last-two-labels check, conservative),
   and the whole config is hash-frozen at deployment. Every source must be
   submitted together with a BINDING EXCERPT — a verbatim quote that
   semantically anchors the source to the question. During resolution every
   node re-fetches each source and deterministically verifies the
   (whitespace-normalized) excerpt appears verbatim in the rendered page;
   sources that fail the binding check (or fail to load) are EXCLUDED from
   the evidence the resolver model may use. The model never decides which
   evidence is admissible — the deterministic check does, identically on
   every node.
3. **Phase-gated void — permissionless, but never mid-trading.**
   `void()` stays fully permissionless (any account, no creator check), but
   only once trading has closed: the contract reverts while
   `now < staking_deadline` and the market is still open
   (`prediction_market.py`, `void()`: `assert _chain_now() >=
   self.staking_deadline, "Market is still open for staking; void unlocks
   after the staking deadline (use finalize after final_deadline)"`). This
   closes the griefing path where any account could cancel a funded market
   during active staking. After the staking deadline, void remains the
   permissionless safety valve for unresolved markets exactly as before.

## Why it needs GenLayer

A prediction market must decide a real-world question from sources no single node can be trusted to read honestly. GenLayer validators independently fetch the cited web sources and must reach comparative consensus on the same outcome, so the verdict is trustless and reproducible, not the opinion of one oracle.

## Live deployment (v2, Bradbury testnet)

- Showcase market (open, live): `0x2dc09cDbb8319303eAc78E85D5d055BB53bdA6BE` —
  "Does HTCPCP define HTTP status code 418 as 'I'm a teapot'?" with
  immutable sources rfc-editor.org/rfc/rfc2324.txt and the Wikipedia HTCPCP
  article, each with a verbatim binding excerpt.
- Full-lifecycle test market (settled): `0x390CAd661cEf8e2bBAc9b6a1B8A152d9083F8ba0` —
  history `config_freeze -> first_stake -> initial -> dispute -> resolve_dispute -> settle -> claim`,
  where resolve / resolve_dispute / settle were executed by a non-creator
  account (`0x1858…F805`).
- Recovery-path market (voided): `0x757FcC7A1b1aB857A3517F9afB5C062b87f21C80` —
  `winning_side_empty` auto-void + 1:1 refund.
- Deploy parity: byte-for-byte identical to `contracts/prediction_market.py`
  (sha256 proof in `parity-proof.txt`).

## Lifecycle

    open --stake(until staking_deadline)--> open
        --resolve(anyone, after staking_deadline)--> dispute_window
        --settle(anyone, after window)--> settled --claim--> paid
    dispute_window --dispute(staker)--> disputed --resolve_dispute(anyone)--> dispute_resolved
    any non-terminal state --finalize(anyone, after final_deadline)--> settled|voided
    unresolved --void(anyone, only after staking_deadline)--> voided --refund--> refunded
    void(before staking_deadline) --> REVERTS "Market is still open for staking"

`finalize()` prefers settlement when a definite outcome survived its
dispute window; otherwise it voids with `void_reason = "deadline_void"` and
opens 1:1 refunds (fail-safe: nobody can be locked out, nobody is paid from
a contested outcome). Settlement also auto-voids (`winning_side_empty`)
when nobody backed the winning side.

## Contract API

Views:
- `get_state()` returns full market state plus computed `yes_pool` / `no_pool` / `total_pool`, both deadlines, bindings and the frozen config hash.
- `verify_question(q)` / `verify_rules(r)` prove the exact question/rules text by SHA-256.

Writes:
- `create` (constructor): question, rules, up to 3 sources + binding excerpts, market_id, dispute window, staking deadline, final deadline. Validates: ≥2 sources, ≥2 registrable domains, non-empty 8..400-char binding per source, `staking_deadline > now`, `final_deadline > staking_deadline`.
- `stake(side)` payable, anyone, while `now < staking_deadline`.
- `resolve()` anyone, after `staking_deadline`, with ≥1 staker. Consensus over binding-verified evidence; YES/NO opens a mandatory dispute window, UNRESOLVED stays open (retryable).
- `dispute(reason)` stakers only, inside the window, max 2 rounds.
- `resolve_dispute()` anyone; records UPHELD/OVERTURNED and opens a fresh window.
- `settle()` anyone, after the window; parimutuel payout pools.
- `finalize()` anyone, after `final_deadline` (settle-or-void hard exit).
- `void()` anyone, only without a definite YES/NO outcome AND only after `staking_deadline` (phase gate: reverts mid-trading with "Market is still open for staking").
- `claim()` winners after settlement: `payout = stake * total_pool // winning_pool`.
- `refund()` anyone with a position, after void: 1:1.

## Payout math

    payout = your_winning_stake * total_pool / winning_pool

## Files

| File | Purpose |
|---|---|
| `contracts/prediction_market.py` | The Intelligent Contract (GenVM lint clean, `lint_out.txt`) |
| `sim_market.py` | Offline consensus simulation: 59/59 checks (permissionless flows, phase-gated void regression T18, deadline exit, binding verification incl. tamper/divergence, domain independence, gates) |
| `deploy.mjs` | Deploy + open the showcase market (writes `contract.txt`, `deploy-tx.txt`) |
| `test-payable.mjs` | Deterministic on-chain tests: 20/20 PASS (`test-payable-results.txt`) — incl. finalize() by a STRANGER account -> deadline_void -> 1:1 refunds |
| `test.mjs` | Full on-chain AI lifecycle: 19/19 (`test-results.txt`) — stake -> stranger resolve (binding-verified YES) -> dispute -> stranger resolve_dispute -> stranger settle -> claim; recovery auto-void + refund; gating reverts |
| `verify.mjs` | Byte-for-byte deploy parity proof (sha256, `parity-proof.txt`) |
| `common.mjs`, `rpc-relay.mjs/html` | Client helpers + browser QUIC RPC relay (DPI workaround) |

The stranger account used for permissionless-call proofs was funded with a
plain EVM value transfer on the Bradbury EVM layer (chain 4221) — its
transactions are visible in the explorer for every market cited above.

## Quickstart

```bash
npm install
cp .env.example .env   # funded Bradbury PRIVATE_KEY
node --env-file=.env deploy.mjs
node --env-file=.env test-payable.mjs
node --env-file=.env test.mjs
node verify.mjs        # parity proof (no key needed)
```
