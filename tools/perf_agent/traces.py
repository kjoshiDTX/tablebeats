"""Trace analysis for the TableBeats vision pipeline, on Perfetto's trace processor.

The app (js/perf.js) records every pipeline stage as a User Timing measure named "tb:<stage>",
which Chrome writes into the trace as a slice (category blink.user_timing). Everything here is
plain Perfetto SQL over those slices, plus Chrome's own main-thread slices for context
(garbage collection, layout, other tasks) when explaining a slow frame.

Trace files are named trace-<backend>[-label].json by tools/bench/run.mjs; several traces of the
same backend (repeated trials) are pooled.
"""
from __future__ import annotations

import random
import re
from dataclasses import dataclass, field
from pathlib import Path

from perfetto.trace_processor import TraceProcessor

STAGES = ["vision", "capture", "bgsub", "blobs", "learn", "track"]

# frames before the bench's "bench:measure" mark are warmup
MEASURED = """
with start as (select coalesce((select max(ts) from slice where name = 'bench:measure'), 0) as t0)
"""


def backend_of(path: str | Path) -> str:
    m = re.match(r"trace-([a-z]+(?:-async)?)", Path(path).name)
    return m.group(1) if m else Path(path).stem


@dataclass
class Trace:
    """One or more trace files of the same backend, opened in Perfetto's trace processor."""

    backend: str
    paths: list[str]
    _tps: list[TraceProcessor] = field(default_factory=list, repr=False)
    _cache: dict = field(default_factory=dict, repr=False)

    def open(self) -> "Trace":
        if not self._tps:
            self._tps = [TraceProcessor(trace=p) for p in self.paths]
        return self

    def close(self) -> None:
        for tp in self._tps:
            tp.close()
        self._tps = []

    def query(self, sql: str) -> list[dict]:
        """Run SQL on every file; rows get a 'trial' column (index of the file)."""
        rows = []
        for i, tp in enumerate(self.open()._tps):
            for r in tp.query(sql):
                d = r.__dict__.copy()
                d["trial"] = i
                rows.append(d)
        return rows

    def by_trial(self, stage: str) -> list[list[float]]:
        """Milliseconds per measured frame for one stage, one list per trace file."""
        if stage not in self._cache:
            sql = MEASURED + f"select dur / 1e6 as ms from slice, start where name = 'tb:{stage}' and ts >= start.t0"
            out: list[list[float]] = [[] for _ in self.paths]
            for r in self.query(sql):
                out[r["trial"]].append(r["ms"])
            self._cache[stage] = [t for t in out if t]
        return self._cache[stage]

    def durations(self, stage: str) -> list[float]:
        """Milliseconds per measured frame for one stage, all trials pooled."""
        return [x for t in self.by_trial(stage) for x in t]

    def stage_table(self) -> dict[str, dict]:
        return {s: summarize(v) for s in STAGES if (v := self.durations(s))}

    def slowest_frames(self, stage: str = "vision", n: int = 5) -> list[dict]:
        """The n slowest frames by `stage`, with each frame's stage breakdown."""
        sql = MEASURED + f"""
        select ts, dur / 1e6 as ms from slice, start
        where name = 'tb:{stage}' and ts >= start.t0 order by dur desc limit {int(n)}"""
        out = []
        for r in self.query(sql):
            out.append({"trial": r["trial"], "ts": r["ts"], "ms": round(r["ms"], 3),
                        "stages": self.frame_breakdown(r["trial"], r["ts"])})
        return out

    def frame_breakdown(self, trial: int, ts: int) -> dict[str, float]:
        """Stage times of the frame whose tb:vision slice contains ts."""
        tp = self.open()._tps[trial]
        frame = list(tp.query(f"""
            select ts, dur from slice where name = 'tb:vision' and ts <= {int(ts)} and ts + dur >= {int(ts)}
            order by ts desc limit 1"""))
        if not frame:
            return {}
        f = frame[0]
        rows = tp.query(f"""
            select substr(name, 4) as stage, dur / 1e6 as ms from slice
            where name like 'tb:%' and name != 'tb:vision' and ts >= {f.ts} and ts + dur <= {f.ts + f.dur}""")
        return {r.stage: round(r.ms, 3) for r in rows}

    def main_thread_during(self, trial: int, ts: int, dur_ms: float, top: int = 8) -> list[dict]:
        """Chrome's own slices overlapping a window (GC, layout, GPU, ...), longest first."""
        t0, t1 = int(ts), int(ts + dur_ms * 1e6)
        rows = self.open()._tps[trial].query(f"""
            select name, category, dur / 1e6 as ms from slice
            where ts < {t1} and ts + dur > {t0} and name not like 'tb:%' and dur > 0
            order by dur desc limit {int(top)}""")
        return [{"name": r.name, "category": r.category, "ms": round(r.ms, 3)} for r in rows]

    def sql(self, query: str, limit: int = 50) -> list[dict]:
        if not re.match(r"^\s*(with|select)\b", query, re.I) or ";" in query.strip().rstrip(";"):
            raise ValueError("only a single SELECT / WITH query is allowed")
        return self.query(f"select * from ({query.strip().rstrip(';')}) limit {int(limit)}")


def summarize(v: list[float]) -> dict:
    s = sorted(v)
    q = lambda p: s[min(len(s) - 1, int(p * len(s)))]
    return {"n": len(s), "mean": sum(s) / len(s), "p50": q(0.5), "p95": q(0.95), "max": s[-1]}


def load(paths: list[str]) -> dict[str, Trace]:
    """Group trace files by backend."""
    groups: dict[str, list[str]] = {}
    for p in paths:
        groups.setdefault(backend_of(p), []).append(str(p))
    return {b: Trace(b, sorted(ps)) for b, ps in groups.items()}


# ---------- regression test ----------

def quantile(v: list[float], p: float) -> float:
    s = sorted(v)
    return s[min(len(s) - 1, int(p * len(s)))]


def _resample(rng: random.Random, trials: list[list[float]]) -> list[float]:
    """Two-level bootstrap: pick runs with replacement, then frames within each run. Frames of one
    run share its conditions (machine load, thermal state), so resampling frames alone would make
    the interval far too narrow and flag run-to-run noise as a regression."""
    out: list[float] = []
    for t in rng.choices(trials, k=len(trials)):
        out += rng.choices(t, k=len(t))
    return out


def bootstrap_change(base: list[list[float]], head: list[list[float]], p: float = 0.5, iters: int = 1000, seed: int = 1):
    """Relative change of the p-quantile (head vs base) with a 95% bootstrap interval.
    base/head: frame times grouped by run (trace file)."""
    rng = random.Random(seed)
    b0 = quantile([x for t in base for x in t], p)
    h0 = quantile([x for t in head for x in t], p)
    deltas = []
    for _ in range(iters):
        b = quantile(_resample(rng, base), p)
        h = quantile(_resample(rng, head), p)
        deltas.append((h - b) / b if b else 0.0)
    deltas.sort()
    return {"base": b0, "head": h0, "change": (h0 - b0) / b0 if b0 else 0.0,
            "lo": deltas[int(0.025 * iters)], "hi": deltas[int(0.975 * iters)]}


@dataclass
class Thresholds:
    p50: float = 0.10     # +10% on the median frame ...
    p95: float = 0.20     # ... or +20% on the p95 frame ...
    min_ms: float = 0.10  # ... and at least this much slower in absolute terms


def compare(base: Trace, head: Trace, th: Thresholds = Thresholds()) -> dict:
    """Per stage: p50/p95 change with CIs. A stage regressed when the whole 95% interval is
    above the threshold (so noise alone can't fail the build) and the absolute change matters.
    With one run per side the interval only covers frame-to-frame noise: use 3+ runs in CI."""
    out = {}
    for stage in STAGES:
        b, h = base.by_trial(stage), head.by_trial(stage)
        if not b or not h:
            continue
        r = {"p50": bootstrap_change(b, h, 0.5), "p95": bootstrap_change(b, h, 0.95)}
        r["regressed"] = any(
            r[k]["lo"] > getattr(th, k) and r[k]["head"] - r[k]["base"] >= th.min_ms for k in ("p50", "p95"))
        r["improved"] = r["p50"]["hi"] < 0
        out[stage] = r
    return out
