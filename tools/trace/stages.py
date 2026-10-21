#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["perfetto>=0.11"]
# ///
"""Per-stage vision timings from Chrome traces, via Perfetto's trace processor.

The app (js/perf.js) records each pipeline stage as a User Timing measure named "tb:<stage>";
Chrome writes those into the trace as slices, which this script queries with Perfetto SQL.
Frames before the "bench:measure" mark (warmup) are skipped.

    uv run tools/trace/stages.py bench-out/trace-cpu.json bench-out/trace-gpu.json
"""
import sys
from perfetto.trace_processor import TraceProcessor

STAGE_SQL = """
with start as (
  select coalesce((select max(ts) from slice where name = 'bench:measure'), 0) as t0
)
select substr(name, 4) as stage, dur / 1e6 as ms
from slice, start
where name like 'tb:%' and ts >= start.t0
order by ts
"""


def percentile(values, p):
    v = sorted(values)
    return v[min(len(v) - 1, int(p * len(v)))] if v else 0.0


def stage_stats(trace_path):
    """{stage: {n, mean, p50, p95, max}} in milliseconds."""
    tp = TraceProcessor(trace=trace_path)
    try:
        samples = {}
        for row in tp.query(STAGE_SQL):
            samples.setdefault(row.stage, []).append(row.ms)
    finally:
        tp.close()
    return {
        stage: {
            "n": len(v),
            "mean": sum(v) / len(v),
            "p50": percentile(v, 0.5),
            "p95": percentile(v, 0.95),
            "max": max(v),
        }
        for stage, v in samples.items()
    }


def main(paths):
    for path in paths:
        stats = stage_stats(path)
        print(f"\n{path}\n  {'stage':<9}{'n':>6}{'mean':>9}{'p50':>9}{'p95':>9}{'max':>9}   (ms)")
        for stage, s in sorted(stats.items(), key=lambda kv: -kv[1]["mean"]):
            print(f"  {stage:<9}{s['n']:>6}{s['mean']:>9.3f}{s['p50']:>9.3f}{s['p95']:>9.3f}{s['max']:>9.3f}")


if __name__ == "__main__":
    main(sys.argv[1:] or ["bench-out/trace-cpu.json", "bench-out/trace-gpu.json"])
