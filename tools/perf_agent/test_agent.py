#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["perfetto>=0.11", "langgraph>=1.0,<2", "anthropic>=2.0,<3"]
# ///
"""Exercises the agent graph end to end with a stubbed Anthropic client (no API key needed):
the analyst asks for a tool, gets real Perfetto results back, then writes its report.

    uv run tools/perf_agent/test_agent.py bench-out/trace-cpu.json
"""
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parent))
import anthropic  # noqa: E402

import agent  # noqa: E402
import traces as T  # noqa: E402


class Block(SimpleNamespace):
    def model_dump(self, exclude_none=False):
        return {k: v for k, v in vars(self).items() if not (exclude_none and v is None)}


class FakeMessages:
    def __init__(self):
        self.calls = []

    def create(self, **kw):
        self.calls.append(kw)
        if len(self.calls) == 1:  # first turn: look at the slowest frames
            assert kw["model"] == agent.MODEL and kw["tools"] and "fallbacks" in kw
            return SimpleNamespace(stop_reason="tool_use", content=[
                Block(type="tool_use", id="t1", name="slowest_frames",
                      input={"side": "head", "backend": next(iter(BACKENDS)), "stage": "vision", "n": 3})])
        result = kw["messages"][-1]["content"][0]  # second turn: the tool result must be real data
        assert result["type"] == "tool_result" and result["tool_use_id"] == "t1" and not result["is_error"], result
        assert '"stages"' in result["content"], result["content"][:200]
        return SimpleNamespace(stop_reason="end_turn", content=[Block(type="text", text="Bottleneck: capture.")])


fake = FakeMessages()
anthropic.Anthropic = lambda: SimpleNamespace(beta=SimpleNamespace(messages=fake))

head = T.load(sys.argv[1:])
BACKENDS = head
out = agent.build().invoke({"head": head, "base": {}, "use_llm": True}, {"recursion_limit": 20})
for t in head.values():
    t.close()

assert len(fake.calls) == 2, len(fake.calls)
assert "Bottleneck: capture." in out["report"] and "slowest stage" in out["report"]
print(out["report"])
print("ok  analyst -> tools -> analyst -> report")
