#!/usr/bin/env python3
"""
Offline consensus simulation for PredictionMarketResolver v2.

Loads the REAL contract source (contracts/prediction_market.py), swaps the
`genlayer` runtime for a deterministic mock, and drives the exact code
paths the contract uses on-chain (including the binding-excerpt check and
gl.eq_principle.prompt_comparative).

Covers the steward-review hardening:

  P1  permissionless lifecycle + deadline exit (funds can never lock):
      T5  resolve by a STRANGER after the staking deadline -> works
      T10 resolve_dispute by a stranger -> works
      T11 settle by a stranger after the window -> works
      T16 finalize by a stranger after final_deadline (unresolved) -> void + 1:1 refunds
      T15 finalize with a definite outcome + closed window -> settle, winners paid
      T17 finalize with an open dispute window -> fail-safe void + refunds
      T18 void (permissionless) of an unresolved market
      T19 void phase gate: early void while still open (pre-deadline) is
          rejected; permissionless void works after the staking deadline
  P2  immutable, independent, semantically bound sources:
      T1  creation validation: <2 sources, single domain, missing/short
          binding, bad deadlines -> rejected
      T2  config frozen at birth (no add_source exists at all)
      T6  binding excerpt absent from the page -> source EXCLUDED ->
          UNRESOLVED when nothing is admissible
      T7  one source fails its binding, the other passes -> only the
          admissible one counts
      T8  leader/validator divergence on binding verification -> consensus
          failure, no state change, no money moves

Run:  python sim_market.py   (no dependencies, stdlib only)
"""
import json
import os
import sys
import types
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
CONTRACT = os.path.join(HERE, "contracts", "prediction_market.py")

CREATOR = "0x" + "aa" * 20
ALICE = "0x" + "bb" * 20          # staker YES
BOB = "0x" + "cc" * 20            # staker NO
STRANGER = "0x" + "dd" * 20       # nobody special: proves permissionless

URL1 = "https://en.wikipedia.org/wiki/The_Merge"
URL1B = "https://en.m.wikipedia.org/wiki/The_Merge"   # same registrable host page
URL2 = "https://ethereum.org/en/roadmap/merge"
BIND1 = "Ethereum completed its transition to proof-of-stake"
BIND2 = "The Merge was the moment Ethereum moved to proof-of-stake"

NOW_ISO = "2026-09-07T12:00:00.000Z"
T0 = int(datetime(2026, 9, 7, 12, 0, 0, tzinfo=timezone.utc).timestamp())
STAKING_DL = T0 + 3600
FINAL_DL = T0 + 86400


def iso(t):
    return datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


# --------------------------------------------------------------------------
# Deterministic stand-in for the `genlayer` SDK surface used by the contract.
# --------------------------------------------------------------------------
class _Web:
    def render(self, url, mode="text"):
        view = GL.current_view
        if view is None:
            raise RuntimeError("render outside consensus context")
        page = view.get(url)
        if page is None:
            raise RuntimeError("simulated fetch failure: " + url)
        return page


class _Nondet:
    def __init__(self):
        self.web = _Web()

    def exec_prompt(self, prompt):
        # Deterministic mock model: the outcome follows from which sources
        # the DETERMINISTIC binding check marked ADMISSIBLE in the prompt.
        if "[ADMISSIBLE" in prompt:
            ans = GL.llm_outcome
            if callable(ans):
                ans = ans(GL.current_view)
        else:
            ans = "UNRESOLVED"
        return json.dumps({"outcome": str(ans)})


def _outcome_of(raw):
    try:
        return str(json.loads(raw).get("outcome", ""))
    except Exception:
        return ""


class _EqPrinciple:
    def prompt_comparative(self, fn, desc):
        GL.current_view = GL.leader_view
        leader_raw = fn()
        votes = []
        for vw in GL.validator_views:
            GL.current_view = vw
            try:
                votes.append(_outcome_of(fn()) == _outcome_of(leader_raw))
            except Exception:
                votes.append(False)
        GL.current_view = None
        GL.last_votes = votes
        if sum(1 for v in votes if v) * 2 <= len(votes):
            raise AssertionError(
                "simulated eq_principle failure: votes=" + json.dumps(votes))
        return leader_raw


class _Evm:
    def contract_interface(self, cls):
        return _MockAccount


class _Write:
    def __call__(self, fn):
        return fn

    def payable(self, fn):
        return fn


class _Public:
    def __init__(self):
        self.write = _Write()

    def view(self, fn):
        return fn


class _Message:
    def __init__(self):
        self.sender_address = CREATOR
        self.value = 0


class _MockAccount:
    TRANSFERS = []

    def __init__(self, address):
        self.address = str(address)

    def emit_transfer(self, value=0, on="finalized"):
        _MockAccount.TRANSFERS.append((self.address, int(value)))


class _InternalMsg:
    def __init__(self):
        self.message_raw = {"datetime": NOW_ISO}


class _Internal:
    def __init__(self):
        self.msg = _InternalMsg()


class _Gl:
    def __init__(self):
        self.nondet = _Nondet()
        self.eq_principle = _EqPrinciple()
        self.evm = _Evm()
        self.public = _Public()
        self.message = _Message()
        self.internal = _Internal()
        self.Contract = type("_ContractBase", (), {})
        self.leader_view = None
        self.validator_views = []
        self.current_view = None
        self.last_votes = None
        self.llm_outcome = "YES"


GL = _Gl()

# The contract reads chain time via `from genlayer._internal import msg`;
# route that import to the mock.
_internal_pkg = types.ModuleType("genlayer._internal")
_internal_pkg.msg = GL.internal.msg
sys.modules["genlayer._internal"] = _internal_pkg
sys.modules["genlayer._internal.msg"] = GL.internal.msg

with open(CONTRACT, encoding="utf-8") as f:
    src = f.read()
src = src.replace("from genlayer import *", "gl = GL", 1)
NS = {"GL": GL, "gl": GL, "u256": lambda x: int(x),
      "__name__": "market_under_test"}
exec(compile(src, CONTRACT, "exec"), NS)
PM = NS["PredictionMarketResolver"]

RESULTS = []


def check(cond, label):
    RESULTS.append((bool(cond), label))
    print(("  PASS  " if cond else "  FAIL  ") + label)


def set_now(t):
    GL.internal.msg.message_raw["datetime"] = iso(t)


def reset_net(pages, llm="YES"):
    """One identical web view for the leader and all validators."""
    GL.leader_view = dict(pages)
    GL.validator_views = [dict(pages) for _ in range(3)]
    GL.current_view = None
    GL.last_votes = None
    GL.llm_outcome = llm


def new_market(pages=None, s1=URL1, s2=URL2, s3="", b1=BIND1, b2=BIND2, b3="",
               q="Has Ethereum completed The Merge and runs on proof-of-stake?",
               r="Resolve YES if the evidence clearly states Ethereum completed The Merge and uses proof-of-stake.",
               sd=STAKING_DL, fd=FINAL_DL, w=600):
    if pages is None:
        pages = {}
    reset_net(pages)
    GL.message.sender_address = CREATOR
    GL.message.value = 0
    set_now(T0)
    return PM(q, r, s1, s2, s3, b1, b2, b3, "m1", w, sd, fd)


def expect_reject(label, fn):
    try:
        fn()
        check(False, label)
    except Exception:
        check(True, label)


def as_(addr):
    GL.message.sender_address = addr
    return addr


def state(c):
    return c.get_state()


print("PredictionMarketResolver v2 offline simulation")
print("contract under test:", CONTRACT)

# T1: creation validation ----------------------------------------------------
print("\n[T1] creation validation (steward point 2)")
expect_reject("single source rejected",
              lambda: new_market(s2=""))
expect_reject("single-domain sources rejected",
              lambda: new_market(s2=URL1B))
expect_reject("missing binding excerpt rejected",
              lambda: new_market(b2=""))
expect_reject("short binding excerpt rejected",
              lambda: new_market(b2="tiny"))
expect_reject("non-http source rejected",
              lambda: new_market(s2="ftp://x.example/y"))
expect_reject("staking deadline in the past rejected",
              lambda: new_market(sd=T0 - 1))
expect_reject("final deadline before staking deadline rejected",
              lambda: new_market(fd=STAKING_DL - 1))
expect_reject("empty question rejected",
              lambda: new_market(q="  "))
expect_reject("zero dispute window rejected",
              lambda: new_market(w=0))
c = new_market()
check(True, "valid market with 2 sources from 2 domains created")

# T2: config frozen at birth -------------------------------------------------
print("\n[T2] config immutable from birth")
st = state(c)
check(st["sources_frozen"] is True, "sources_frozen == True at creation")
check(json.loads(st["frozen_sources"]) == [URL1, URL2],
      "frozen_sources == both URLs")
check(len(st["frozen_config_hash"]) == 64, "frozen_config_hash set")
check("config_freeze" in st["history"], "history records config_freeze at birth")
check(not hasattr(c, "add_source"), "add_source does not exist (removed)")
check(st["staking_deadline"] == STAKING_DL and st["final_deadline"] == FINAL_DL,
      "deadlines stored on-chain")

# T3: staking gates ----------------------------------------------------------
print("\n[T3] staking gates")
as_(ALICE)
set_now(T0 + 10)
GL.message.value = 0
expect_reject("zero-value stake rejected",
              lambda: c.stake("YES"))
GL.message.value = 1000
expect_reject("invalid side rejected",
              lambda: c.stake("MAYBE"))
GL.message.value = 1000
c.stake("YES")
st = state(c)
check(st["staking_started"] is True and st["yes_pool"] == 1000,
      "stake YES recorded")
set_now(STAKING_DL + 5)
GL.message.value = 500
expect_reject("stake after staking deadline rejected",
              lambda: c.stake("NO"))
set_now(T0 + 60)
as_(BOB)
GL.message.value = 300
c.stake("NO")
st = state(c)
check(st["no_pool"] == 300 and st["total_pool"] == 1300, "second staker recorded")

# T4: resolve gates ----------------------------------------------------------
print("\n[T4] resolve gates")
as_(STRANGER)
set_now(T0 + 120)
expect_reject("resolve before staking deadline rejected",
              lambda: c.resolve())
c2 = new_market()  # nobody staked
as_(STRANGER)
set_now(STAKING_DL + 10)
expect_reject("resolve with no stakers rejected",
              lambda: c2.resolve())

# T5: PERMISSIONLESS resolve by a stranger ------------------------------------
print("\n[T5] permissionless resolve by a STRANGER (steward point 1)")
pages = {
    URL1: "Ethereum " + BIND1 + " in September 2022. Full history of the upgrade.",
    URL2: "Roadmap item: " + BIND2 + ", slashing replaced miners.",
}
reset_net(pages, llm="YES")
as_(STRANGER)
GL.message.value = 0
set_now(STAKING_DL + 10)
err = None
try:
    c.resolve()
except Exception as e:
    err = e
check(err is None, "resolve() by a non-creator stranger succeeds")
check(GL.last_votes == [True, True, True], "all validators agree (binding verified)")
st = state(c)
check(st["status"] == "dispute_window" and st["outcome"] == "YES",
      "resolved YES into dispute_window")
check(st["resolve_time"] == STAKING_DL + 10
      and st["dispute_deadline"] == STAKING_DL + 10 + 600,
      "mandatory dispute window armed")

# T6: binding absent -> EXCLUDED -> UNRESOLVED --------------------------------
print("\n[T6] binding excerpt absent -> source excluded -> UNRESOLVED")
c6 = new_market(pages={})
as_(ALICE)
GL.message.value = 1000
set_now(T0 + 10)
c6.stake("YES")
reset_net({
    URL1: "A page about something completely different, no relevant quote here.",
    URL2: "Another unrelated page without the anchored text.",
}, llm="YES")
as_(STRANGER)
set_now(STAKING_DL + 10)
c6.resolve()
st = state(c6)
check(st["status"] == "open" and st["outcome"] == "UNRESOLVED",
      "no admissible evidence -> UNRESOLVED, market stays open (retryable)")

# T7: one binding fails, the other passes -------------------------------------
print("\n[T7] one source fails its binding, the other passes")
c7 = new_market(pages={})
as_(ALICE)
GL.message.value = 1000
set_now(T0 + 10)
c7.stake("YES")
reset_net({
    URL1: "unrelated content without the first excerpt",
    URL2: "The Merge: " + BIND2 + " as planned.",
}, llm="NO")
as_(STRANGER)
set_now(STAKING_DL + 10)
c7.resolve()
st = state(c7)
check(st["status"] == "dispute_window" and st["outcome"] == "NO",
      "outcome derived only from the admissible source")

# T8: leader/validator divergence -> consensus failure ------------------------
print("\n[T8] binding divergence between nodes -> consensus failure, no state change")
c8 = new_market(pages={})
as_(ALICE)
GL.message.value = 1000
set_now(T0 + 10)
c8.stake("YES")
leader_pages = {URL1: "Ethereum " + BIND1 + " in 2022.", URL2: BIND2 + "."}
validator_pages = {
    URL1: "page changed, quote gone",
    URL2: "page changed, quote gone",
}
reset_net(leader_pages, llm="YES")
GL.validator_views = [dict(validator_pages) for _ in range(3)]
as_(STRANGER)
set_now(STAKING_DL + 10)
err = None
try:
    c8.resolve()
except Exception as e:
    err = e
check(err is not None and GL.last_votes == [False, False, False],
      "divergent binding verification rejected by validators")
check(state(c8)["status"] == "open", "state unchanged, funds safe")

# T9: dispute gates ------------------------------------------------------------
print("\n[T9] dispute gates (participant-only, window, max 2)")
as_(STRANGER)
set_now(STAKING_DL + 20)
expect_reject("non-staker dispute rejected",
              lambda: c.dispute("I disagree"))
as_(ALICE)
expect_reject("empty dispute reason rejected",
              lambda: c.dispute("   "))
c.dispute("Please re-check the cited sources.")
check(state(c)["status"] == "disputed", "staker dispute accepted")

# T10: PERMISSIONLESS resolve_dispute by a stranger ----------------------------
print("\n[T10] permissionless resolve_dispute by a STRANGER")
reset_net(pages, llm="YES")
as_(STRANGER)
set_now(STAKING_DL + 30)
c.resolve_dispute()
st = state(c)
check(st["status"] == "dispute_resolved" and st["dispute_outcome"] == "UPHELD",
      "dispute resolved by a stranger, outcome upheld, fresh window armed")

# T11: PERMISSIONLESS settle by a stranger ------------------------------------
print("\n[T11] permissionless settle by a STRANGER")
as_(STRANGER)
set_now(STAKING_DL + 40)
expect_reject("settle during the dispute window rejected",
              lambda: c.settle())
set_now(STAKING_DL + 40 + 600)
c.settle()
st = state(c)
check(st["status"] == "settled" and st["winning_side"] == "YES",
      "settled by a stranger after the window closed")

# T12: claims ------------------------------------------------------------------
print("\n[T12] claims (pari-mutuel)")
as_(BOB)
expect_reject("loser claim rejected", lambda: c.claim())
as_(ALICE)
payout = c.claim()
check(payout == 1300, "winner payout = 1300 (1000*1300//1000)")
check(_MockAccount.TRANSFERS[-1] == (ALICE, 1300), "transfer emitted to winner")
expect_reject("double claim rejected", lambda: c.claim())

# T13: recovery — empty winning side auto-void ---------------------------------
print("\n[T13] empty winning side -> auto-void -> 1:1 refunds")
c13 = new_market(pages)
as_(BOB)
GL.message.value = 700
set_now(T0 + 10)
c13.stake("NO")
reset_net(pages, llm="YES")
as_(STRANGER)
set_now(STAKING_DL + 10)
c13.resolve()
set_now(STAKING_DL + 10 + 600)
c13.settle()
st = state(c13)
check(st["status"] == "voided" and st["void_reason"] == "winning_side_empty",
      "auto-void when nobody backed the winning side")
as_(BOB)
amt = c13.refund()
check(amt == 700, "refund 1:1 after auto-void")
expect_reject("double refund rejected", lambda: c13.refund())

# T14/T15/T16/T17: finalize — the permissionless hard deadline exit ------------
print("\n[T14] finalize before final_deadline rejected")
cF = new_market(pages)
as_(ALICE)
GL.message.value = 400
set_now(T0 + 10)
cF.stake("YES")
as_(STRANGER)
set_now(FINAL_DL - 1)
expect_reject("finalize before final_deadline rejected", lambda: cF.finalize())

print("\n[T15] finalize with definite outcome + closed window -> settle, winners paid")
reset_net(pages, llm="YES")
as_(STRANGER)
set_now(STAKING_DL + 10)
cF.resolve()
set_now(FINAL_DL + 5)
cF.finalize()
st = state(cF)
check(st["status"] == "settled" and st["winning_side"] == "YES",
      "finalize settled the market, winners paid")
as_(ALICE)
check(cF.claim() == 400, "winner claims after finalize")

print("\n[T16] finalize with unresolved market -> deadline_void -> 1:1 refunds by a stranger path")
cG = new_market(pages={})
as_(ALICE)
GL.message.value = 250
set_now(T0 + 10)
cG.stake("YES")
reset_net({"url": "x"}, llm="YES")  # nothing admissible
as_(STRANGER)
set_now(STAKING_DL + 10)
cG.resolve()   # UNRESOLVED -> stays open
set_now(FINAL_DL + 5)
cG.finalize()
st = state(cG)
check(st["status"] == "voided" and st["void_reason"] == "deadline_void",
      "deadline_void: unresolved market voided at the final deadline")
as_(ALICE)
check(cG.refund() == 250, "staker refunds 1:1 after deadline_void")

print("\n[T17] finalize with definite outcome but OPEN dispute window -> fail-safe void")
cI = new_market(pages, sd=FINAL_DL - 100, fd=FINAL_DL + 100)
as_(ALICE)
GL.message.value = 600
set_now(FINAL_DL - 200)
cI.stake("YES")
reset_net(pages, llm="YES")
as_(STRANGER)
set_now(FINAL_DL - 50)
cI.resolve()   # YES, window closes at FINAL_DL-50+600 = FINAL_DL+550
set_now(FINAL_DL + 150)   # final_deadline passed, dispute window still open
cI.finalize()
stI = state(cI)
check(stI["status"] == "voided" and stI["void_reason"] == "deadline_void",
      "window still open at final deadline -> fail-safe void (no lock, no misallocation)")
as_(ALICE)
check(cI.refund() == 600, "refund 1:1 after fail-safe finalize")

# T18: permissionless void ------------------------------------------------------
print("\n[T18] permissionless void of an unresolved market")
cV = new_market(pages)
as_(ALICE)
GL.message.value = 100
set_now(T0 + 10)
cV.stake("YES")
as_(STRANGER)
set_now(STAKING_DL + 10)   # steward Sep 9: void is only valid after staking_deadline
cV.void()
st = state(cV)
check(st["status"] == "voided" and st["void_reason"] == "permissionless_void",
      "void by a stranger, unresolved market after the staking deadline")
expect_reject("double void rejected", lambda: cV.void())
reset_net(pages, llm="YES")
cW = new_market(pages)
as_(ALICE)
GL.message.value = 100
set_now(T0 + 10)
cW.stake("YES")
as_(STRANGER)
set_now(STAKING_DL + 10)
cW.resolve()   # YES
expect_reject("void with definite YES outcome rejected", lambda: cW.void())

# T19: void phase gate (steward Sep 9) -----------------------------------------
print("\n[T19] void phase gate: no void while the market is still open for staking")
reset_net(pages, llm="YES")
cX = new_market(pages)
as_(ALICE)
GL.message.value = 100
set_now(T0 + 20)
cX.stake("YES")            # funded, still open, BEFORE the staking deadline
as_(STRANGER)
set_now(T0 + 30)           # now < staking_deadline
expect_reject("early void before staking deadline rejected (griefing blocked)",
              lambda: cX.void())
check(state(cX)["status"] == "open",
      "funded market stays OPEN after a blocked early void")
set_now(STAKING_DL + 10)   # after the staking deadline
cX.void()                  # same stranger, now permitted
check(state(cX)["status"] == "voided"
      and state(cX)["void_reason"] == "permissionless_void",
      "permissionless void works once the staking deadline has passed")

# summary ----------------------------------------------------------------------
print("\n" + "=" * 72)
failed = [label for ok, label in RESULTS if not ok]
print("CHECKS:", len(RESULTS), " PASSED:", len(RESULTS) - len(failed),
      " FAILED:", len(failed))
if failed:
    print("FAILED:")
    for label in failed:
        print("  - " + label)
    sys.exit(1)
print("ALL CHECKS PASSED — permissionless lifecycle + bound sources verified.")
