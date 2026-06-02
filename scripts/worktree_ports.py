#!/usr/bin/env python3
"""Emit stable local development ports for this git worktree."""

from __future__ import annotations

import hashlib
import os
import shlex
import subprocess
import sys
from pathlib import Path

BASE_PORT = 8800
SPAN = 1000
PORT_BLOCK_SIZE = 100
CONDUCTOR_PORT_RANGE_SIZE = 10
OFFSETS = {
    "API_PORT": 10,
    "WEB_PORT": 20,
}
CONDUCTOR_OFFSETS = {
    "API_PORT": 0,
    "WEB_PORT": 1,
}
WEB_RESTRICTED_PORTS = frozenset(
    {
        1,
        7,
        9,
        11,
        13,
        15,
        17,
        19,
        20,
        21,
        22,
        23,
        25,
        37,
        42,
        43,
        53,
        69,
        77,
        79,
        87,
        95,
        101,
        102,
        103,
        104,
        109,
        110,
        111,
        113,
        115,
        117,
        119,
        123,
        135,
        137,
        139,
        143,
        161,
        179,
        389,
        427,
        465,
        512,
        513,
        514,
        515,
        526,
        530,
        531,
        532,
        540,
        548,
        554,
        556,
        563,
        587,
        601,
        636,
        989,
        990,
        993,
        995,
        1719,
        1720,
        1723,
        2049,
        3659,
        4045,
        5060,
        5061,
        6000,
        6566,
        6665,
        6666,
        6667,
        6668,
        6669,
        6697,
        10080,
    }
)


def worktree_root() -> Path:
    try:
        output = subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
        return Path(output)
    except Exception:
        return Path.cwd().resolve()


def port_block(root: Path) -> int:
    digest = hashlib.sha256(str(root).encode("utf-8")).hexdigest()
    return BASE_PORT + ((int(digest[:8], 16) % (SPAN // PORT_BLOCK_SIZE)) * PORT_BLOCK_SIZE)


def allocate_web_port(base: int, reserved_ports: set[int], start_offset: int, block_size: int) -> int:
    for port in range(base + start_offset, base + block_size):
        if port in reserved_ports or port in WEB_RESTRICTED_PORTS:
            continue
        return port
    raise RuntimeError(f"no safe web port available in block starting at {base}")


def ports_for_base(base: int) -> dict[str, int]:
    values = {name: base + offset for name, offset in OFFSETS.items()}
    values["WEB_PORT"] = allocate_web_port(base, {values["API_PORT"]}, OFFSETS["WEB_PORT"], PORT_BLOCK_SIZE)
    return values


def ports_for_conductor_base(base: int) -> dict[str, int]:
    values = {name: base + offset for name, offset in CONDUCTOR_OFFSETS.items()}
    values["WEB_PORT"] = allocate_web_port(
        base,
        {values["API_PORT"]},
        CONDUCTOR_OFFSETS["WEB_PORT"],
        CONDUCTOR_PORT_RANGE_SIZE,
    )
    return values


def conductor_port_base() -> int | None:
    raw_value = os.environ.get("CONDUCTOR_PORT")
    if raw_value is None or raw_value == "":
        return None
    base = int(raw_value)
    if base < 1 or base + CONDUCTOR_PORT_RANGE_SIZE - 1 > 65535:
        raise RuntimeError(f"CONDUCTOR_PORT leaves no room for a 10-port range: {base}")
    return base


def ports() -> dict[str, int]:
    conductor_base = conductor_port_base()
    if conductor_base is not None:
        return ports_for_conductor_base(conductor_base)
    return ports_for_base(port_block(worktree_root()))


def env_values() -> dict[str, str]:
    values = ports()
    api = values["API_PORT"]
    web = values["WEB_PORT"]
    return {
        "API_PORT": str(api),
        "WEB_PORT": str(web),
        "PERSONAL_DASHBOARD_API_BASE_URL": f"http://127.0.0.1:{api}",
        "PERSONAL_DASHBOARD_WEB_BASE_URL": f"http://127.0.0.1:{web}",
    }


def print_env() -> None:
    for key, value in env_values().items():
        print(f"{key}={value}")


def print_export() -> None:
    for key, value in env_values().items():
        print(f"export {key}={shlex.quote(value)}")


def run_with_env(args: list[str]) -> int:
    env = os.environ.copy()
    env.update(env_values())
    index = 0
    while index < len(args):
        token = args[index]
        if "=" not in token or token.startswith("-"):
            break
        key, value = token.split("=", 1)
        env[key] = value
        index += 1
    if index >= len(args) or args[index] != "--":
        print("usage: python3 scripts/worktree_ports.py exec [KEY=VALUE ...] -- <command> [args...]", file=sys.stderr)
        return 2
    return subprocess.run(args[index + 1 :], env=env, check=False).returncode


def main() -> int:
    command = sys.argv[1] if len(sys.argv) > 1 else "env"
    if command == "env":
        print_env()
        return 0
    if command == "export":
        print_export()
        return 0
    if command == "exec":
        return run_with_env(sys.argv[2:])
    print(f"unknown command: {command}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
