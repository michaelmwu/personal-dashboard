"""Hermes plugin shell for the Personal Dashboard dashboard extension.

The dashboard UI and its API router live under ``dashboard/``.  This module is
intentionally a no-op so Hermes can discover the directory as a normal trusted
plugin without adding tools, hooks, or mutating capabilities to the agent.
"""


def register(ctx: object) -> None:
    """Register no agent-facing capabilities for this read-only dashboard plugin."""

    del ctx
