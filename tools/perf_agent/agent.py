#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["perfetto>=0.11", "langgraph>=1.0,<2", "anthropic>=2.0,<3"]
# ///
"""Performance-trace agent for TableBeats.

Reads Chrome traces of the vision benchmark (tools/bench/run.mjs) with Perfetto's trace
processor, names the slowest pipeline stage, and checks head against a base commit for
regressions. A LangGraph graph:

    measure -> compare -> analyst <-> tools -> report
                           (Claude)

- measure / compare are deterministic: per-stage stats, and a bootstrap test per stage that
  only calls a regression when the whole 95% interval of the slowdown clears the threshold.
  The pass/fail verdict comes from here, never from the model, so CI is reproducible.
- analyst is Claude with read-only tools over the traces (stage table, slowest frames, what
  Chrome's main thread was doing during a frame, raw Perfetto SQL). It explains the bottleneck
  and any regression: which stage, which frames, and the likely cause.
- Without an Anthropic API key (or with --no-llm) the analyst is skipped and the report is the
  deterministic part only.

    uv run tools/perf_agent/agent.py --head bench-out/trace-*.json
    uv run tools/perf_agent/agent.py --base base/trace-*.json --head head/trace-*.json --report perf.md

Exit status: 1 if any stage of any backend regressed, else 0. Not just the total: the total is
noisier than its parts (a +0.5 ms blobs regression moved CPU vision p50 by +24%, but with an
interval of +3%..+41% it would not have failed on its own).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, TypedDict

sys.path.insert(0, str(Path(__file__).parent))
import traces as T  # noqa: E402
from langgraph.graph import END, START, StateGraph  # noqa: E402

MODEL = "claude-opus-5-5"


class State(TypedDict, total=False):
    head: dict[str, T.Trace]
    base: dict[str, T.Trace]
    tables: dict           # {"head": {backend: {stage: stats}}, "base": {...}}
    comparison: dict       # {backend: {stage: {...}}}
    bottleneck: dict       # {backend: stage}
    regressed: list        # ["cpu:vision", ...]
    messages: list         # analyst conversation (Anthropic message params)
    analysis: str
    report: str
    use_llm: bool


# ---------- deterministic nodes ----------

def measure(state: State) -> State:
    tables = {"head": {b: t.stage_table() for b, t in state["head"].items()}}
    if state.get("base"):
        tables["base"] = {b: t.stage_table() for b, t in state["base"].items()}
    # slowest stage = the biggest mean share of a frame, not counting the totals
    bottleneck = {b: max((s for s in tab if s not in T.TOTALS), key=lambda s: tab[s]["mean"])
                  for b, tab in tables["head"].items()}
    return {"tables": tables, "bottleneck": bottleneck}


def compare(state: State) -> State:
    base = state.get("base") or {}
    comparison, regressed = {}, []
    for b, head in state["head"].items():
        if b in base:
            comparison[b] = T.compare(base[b], head)
            regressed += [f"{b}:{s}" for s, r in comparison[b].items() if r["regressed"]]
    return {"comparison": comparison, "regressed": regressed}


# ---------- analyst (Claude + tools) ----------

TOOLS = [
    {
        "name": "stage_table",
        "description": "Per-stage frame times (ms: n, mean, p50, p95, max) for one backend's traces. "
                       "side is 'head' (the code under test) or 'base' (the comparison commit).",
        "input_schema": {"type": "object", "additionalProperties": False, "required": ["side", "backend"],
                         "properties": {"side": {"type": "string", "enum": ["head", "base"]},
                                        "backend": {"type": "string"}}},
        "strict": True,
    },
    {
        "name": "slowest_frames",
        "description": "The n slowest frames by a stage, each with its per-stage breakdown and its trial/ts "
                       "(nanoseconds) so you can look at what else ran then with main_thread_during.",
        "input_schema": {"type": "object", "additionalProperties": False,
                         "required": ["side", "backend", "stage", "n"],
                         "properties": {"side": {"type": "string", "enum": ["head", "base"]},
                                        "backend": {"type": "string"},
                                        "stage": {"type": "string", "enum": T.STAGES},
                                        "n": {"type": "integer"}}},
        "strict": True,
    },
    {
        "name": "main_thread_during",
        "description": "Chrome's own trace slices (GC, layout, GPU, tasks) overlapping a window that starts "
                       "at ts (ns) and lasts dur_ms. Use it on a slow frame to see if something else ran.",
        "input_schema": {"type": "object", "additionalProperties": False,
                         "required": ["side", "backend", "trial", "ts", "dur_ms"],
                         "properties": {"side": {"type": "string", "enum": ["head", "base"]},
                                        "backend": {"type": "string"}, "trial": {"type": "integer"},
                                        "ts": {"type": "integer"}, "dur_ms": {"type": "number"}}},
        "strict": True,
    },
    {
        "name": "perfetto_sql",
        "description": "Run one read-only Perfetto SQL query (SELECT/WITH) on a backend's traces; at most 50 "
                       "rows. Tables: slice(ts, dur, name, category, track_id, depth, ...), thread_track, "
                       "thread, process. Pipeline stages are slices named 'tb:<stage>'.",
        "input_schema": {"type": "object", "additionalProperties": False,
                         "required": ["side", "backend", "query"],
                         "properties": {"side": {"type": "string", "enum": ["head", "base"]},
                                        "backend": {"type": "string"}, "query": {"type": "string"}}},
        "strict": True,
    },
]

SYSTEM = """You analyse performance traces of TableBeats, a browser app that tracks fingertips in a
camera feed. Each camera frame runs a vision pipeline whose stages are recorded as trace slices:
capture (get the frame: canvas drawImage+getImageData on CPU, texture upload + downscale shader on
GPU), copy (wasm only: the frame into WebAssembly memory), bgsub (background subtraction; on the GPU
backend this includes the readPixels stall waiting for the GPU), blobs (connected components),
learn (background model update), track (fingertip tracking and strike detection); tracker is
everything after capture and vision is the whole frame. Backends: cpu (JavaScript tracker), wasm
(the same tracker in C++ compiled to WebAssembly), gpu, gpu-async.

You get the deterministic results (stage tables, and if there is a base commit, a bootstrap
comparison per stage). Use the tools to look at the traces themselves before concluding: check
the slowest frames and what else the main thread was doing then. Then write a short report in
Markdown for a pull request:
- Bottleneck: the slowest stage per backend, its share of the frame, and why it costs what it does.
- Regressions: for each regressed stage, how much slower (p50/p95), whether it's spread over all
  frames or concentrated in spikes, and the most likely cause you can support from the trace.
  If nothing regressed, say so in one line.
- One or two concrete next steps.
Quote numbers from tool results; don't invent any. Keep it under 300 words. The pass/fail verdict
is decided by the statistics, not by you."""


def _tool(state: State, name: str, args: dict) -> Any:
    side = state.get(args["side"]) or {}
    tr = side.get(args["backend"])
    if tr is None:
        return {"error": f"no {args['side']} traces for backend {args['backend']!r}; have {sorted(side)}"}
    if name == "stage_table":
        return tr.stage_table()
    if name == "slowest_frames":
        return tr.slowest_frames(args["stage"], max(1, min(args["n"], 20)))
    if name == "main_thread_during":
        return tr.main_thread_during(args["trial"], args["ts"], args["dur_ms"])
    if name == "perfetto_sql":
        return tr.sql(args["query"])
    return {"error": f"unknown tool {name}"}


def analyst(state: State) -> State:
    import anthropic

    messages = state.get("messages") or [{"role": "user", "content": _brief(state)}]
    client = anthropic.Anthropic()
    response = client.beta.messages.create(
        model=MODEL,
        max_tokens=16000,
        system=SYSTEM,
        tools=TOOLS,
        messages=messages,
        output_config={"effort": "medium"},
        # if a safety classifier declines, re-run on a suitable fallback model in the same call
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    )
    messages = messages + [{"role": "assistant", "content": [b.model_dump(exclude_none=True) for b in response.content]}]
    text = "\n".join(b.text for b in response.content if b.type == "text")
    if response.stop_reason == "refusal":
        text = "_The analysis was declined by the model; see the deterministic results above._"
    return {"messages": messages, "analysis": text}


def tools(state: State) -> State:
    last = state["messages"][-1]["content"]
    results = []
    for block in last:
        if block.get("type") != "tool_use":
            continue
        try:
            out, err = _tool(state, block["name"], block["input"]), False
        except Exception as e:  # bad SQL etc.: tell the model, let it retry
            out, err = {"error": str(e)}, True
        results.append({"type": "tool_result", "tool_use_id": block["id"],
                        "content": json.dumps(out, default=float)[:20000], "is_error": err})
    return {"messages": state["messages"] + [{"role": "user", "content": results}]}


def after_analyst(state: State) -> str:
    last = state["messages"][-1]["content"]
    calls = any(b.get("type") == "tool_use" for b in last)
    turns = sum(1 for m in state["messages"] if m["role"] == "assistant")
    return "tools" if calls and turns < 12 else "report"


def _brief(state: State) -> str:
    return ("Deterministic results (ms):\n```json\n" + json.dumps({
        "stage_tables": state["tables"], "bottleneck": state["bottleneck"],
        "comparison": _compact(state.get("comparison") or {}), "regressed": state.get("regressed") or [],
        "backends": {"head": sorted(state["head"]), "base": sorted(state.get("base") or {})},
    }, indent=1, default=float) + "\n```\nInvestigate with the tools, then write the report.")


def _compact(comparison: dict) -> dict:
    r = lambda x: round(x, 4)
    return {b: {s: {k: {kk: r(vv) for kk, vv in v[k].items()} for k in ("p50", "p95")} | {"regressed": v["regressed"]}
                for s, v in stages.items()} for b, stages in comparison.items()}


# ---------- report ----------

def report(state: State) -> State:
    L = ["## TableBeats vision performance", ""]
    reg = state.get("regressed") or []
    if state.get("comparison"):
        L += [f"**{'❌ Regression: ' + ', '.join(reg) if reg else '✅ No regression'}** "
              "(fails only when the whole 95% bootstrap interval is above +10% p50 / +20% p95 and >= 0.1 ms)", ""]
    for b, tab in state["tables"]["head"].items():
        bott = state["bottleneck"][b]
        share = tab[bott]["mean"] / tab["vision"]["mean"] if "vision" in tab else 0
        L += [f"### {b}: slowest stage **{bott}** ({share:.0%} of a frame)", ""]
        cmp = (state.get("comparison") or {}).get(b)
        if cmp:
            L += ["| stage | base p50 | head p50 | change (95% CI) | base p95 | head p95 | change (95% CI) | |",
                  "|---|---:|---:|---:|---:|---:|---:|---|"]
            for s, r in cmp.items():
                f = lambda q: f"{q['change']:+.1%} ({q['lo']:+.0%}…{q['hi']:+.0%})"
                L.append(f"| {s} | {r['p50']['base']:.3f} | {r['p50']['head']:.3f} | {f(r['p50'])} | "
                         f"{r['p95']['base']:.3f} | {r['p95']['head']:.3f} | {f(r['p95'])} | "
                         f"{'❌' if r['regressed'] else ''} |")
        else:
            L += ["| stage | n | mean | p50 | p95 | max |", "|---|---:|---:|---:|---:|---:|"]
            for s, v in tab.items():
                L.append(f"| {s} | {v['n']} | {v['mean']:.3f} | {v['p50']:.3f} | {v['p95']:.3f} | {v['max']:.3f} |")
        L.append("")
    if state.get("analysis"):
        L += ["### Analysis (Claude, from the traces)", "", state["analysis"], ""]
    elif not state.get("use_llm"):
        L += ["_LLM analysis skipped (no Anthropic credentials or --no-llm)._", ""]
    return {"report": "\n".join(L)}


def build() -> Any:
    g = StateGraph(State)
    g.add_node("measure", measure)
    g.add_node("compare", compare)
    g.add_node("analyst", analyst)
    g.add_node("tools", tools)
    g.add_node("report", report)
    g.add_edge(START, "measure")
    g.add_edge("measure", "compare")
    g.add_conditional_edges("compare", lambda s: "analyst" if s.get("use_llm") else "report")
    g.add_conditional_edges("analyst", after_analyst)
    g.add_edge("tools", "analyst")
    g.add_edge("report", END)
    return g.compile()


def has_credentials() -> bool:
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return True
    return (Path.home() / ".config" / "anthropic").exists()  # `ant auth login` profile


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--head", nargs="+", required=True, help="trace files of the code under test")
    ap.add_argument("--base", nargs="*", default=[], help="trace files of the commit to compare against")
    ap.add_argument("--report", help="write the Markdown report here (also appended to $GITHUB_STEP_SUMMARY)")
    ap.add_argument("--no-llm", action="store_true", help="skip the Claude analysis")
    a = ap.parse_args()

    head, base = T.load(a.head), T.load(a.base) if a.base else {}
    try:
        out = build().invoke({"head": head, "base": base, "use_llm": not a.no_llm and has_credentials()},
                             {"recursion_limit": 60})
    finally:
        for t in [*head.values(), *base.values()]:
            t.close()
    print(out["report"])
    if a.report:
        Path(a.report).write_text(out["report"])
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(out["report"] + "\n")
    return 1 if out.get("regressed") else 0


if __name__ == "__main__":
    sys.exit(main())
