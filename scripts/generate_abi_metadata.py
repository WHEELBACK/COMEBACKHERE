#!/usr/bin/env python3
"""Emit deterministic ABI metadata JSON consumed by comebackhere-backend."""

from __future__ import annotations

import re
import sys
from pathlib import Path

# This script lives in COMEBACKHERE/scripts/.
# Contract sources live in the sibling COMEBACKHERE-contracts/ directory.
ROOT = Path(__file__).resolve().parents[1]
CONTRACTS_ROOT = ROOT.parent / "COMEBACKHERE-contracts"


def package_version(crate_dir: str) -> str:
    cargo = (CONTRACTS_ROOT / "contracts" / crate_dir / "Cargo.toml").read_text(encoding="utf-8")
    match = re.search(r'^version\s*=\s*"([^"]+)"', cargo, re.MULTILINE)
    if not match:
        raise SystemExit(f"version not found in COMEBACKHERE-contracts/contracts/{crate_dir}/Cargo.toml")
    return match.group(1)


def contractimpl_body(text: str) -> str:
    marker = "#[contractimpl]"
    start = text.find(marker)
    if start < 0:
        raise SystemExit("contractimpl block not found")
    brace = text.find("{", start)
    if brace < 0:
        raise SystemExit("contractimpl opening brace not found")
    depth = 0
    for index in range(brace, len(text)):
        char = text[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[brace + 1 : index]
    raise SystemExit("contractimpl closing brace not found")


def contract_public_functions(crate_dir: str) -> list[str]:
    lib = CONTRACTS_ROOT / "contracts" / crate_dir / "src" / "lib.rs"
    body = contractimpl_body(lib.read_text(encoding="utf-8"))
    return re.findall(r"^\s*pub\s+fn\s+([a-zA-Z0-9_]+)\s*\(", body, re.MULTILINE)


def invoice_events() -> list[str]:
    events_rs = (CONTRACTS_ROOT / "contracts" / "invoice" / "src" / "events.rs").read_text(
        encoding="utf-8"
    )
    return re.findall(r'Symbol::new\([^,]+,\s*"([^"]+)"\)', events_rs)


def format_invoice(payload: dict) -> str:
    functions = ",\n    ".join(f'"{name}"' for name in payload["functions"])
    events = ", ".join(f'"{name}"' for name in payload["events"])
    return (
        "{\n"
        f'  "contract": "{payload["contract"]}",\n'
        f'  "version": "{payload["version"]}",\n'
        f'  "functions": [\n    {functions}\n  ],\n'
        f'  "events": [{events}]\n'
        "}\n"
    )


def format_treasury(payload: dict) -> str:
    functions = ",\n    ".join(f'"{name}"' for name in payload["functions"])
    return (
        "{\n"
        f'  "contract": "{payload["contract"]}",\n'
        f'  "version": "{payload["version"]}",\n'
        f'  "functions": [\n    {functions}\n  ],\n'
        f'  "threshold": "{payload["threshold"]}"\n'
        "}\n"
    )


def compliance_errors(crate_dir: str) -> dict[str, str]:
    lib = CONTRACTS_ROOT / "contracts" / crate_dir / "src" / "lib.rs"
    text = lib.read_text(encoding="utf-8")
    enum_match = re.search(
        r"#\[contracterror\].*?pub enum ContractError \{([^}]+)\}", text, re.DOTALL
    )
    if not enum_match:
        return {}
    enum_body = enum_match.group(1)
    return {
        num: name
        for name, num in re.findall(r"([A-Za-z][A-Za-z0-9]+)\s*=\s*(\d+)", enum_body)
    }


def format_compliance(payload: dict) -> str:
    functions = ",\n    ".join(f'"{name}"' for name in payload["functions"])
    errors_items = ",\n    ".join(
        f'"{k}": "{v}"'
        for k, v in sorted(payload["errors"].items(), key=lambda x: int(x[0]))
    )
    return (
        "{\n"
        f'  "contract": "{payload["contract"]}",\n'
        f'  "version": "{payload["version"]}",\n'
        f'  "functions": [\n    {functions}\n  ],\n'
        f'  "errors": {{\n    {errors_items}\n  }}\n'
        "}\n"
    )


def main() -> None:
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "abis"
    out_dir.mkdir(parents=True, exist_ok=True)

    invoice = {
        "contract": "invoice",
        "version": package_version("invoice"),
        "functions": contract_public_functions("invoice"),
        "events": invoice_events(),
    }
    (out_dir / "invoice.json").write_text(format_invoice(invoice), encoding="utf-8")

    treasury = {
        "contract": "treasury",
        "version": package_version("treasury"),
        "functions": contract_public_functions("treasury"),
        "threshold": "2-of-3",
    }
    (out_dir / "treasury.json").write_text(format_treasury(treasury), encoding="utf-8")

    compliance = {
        "contract": "compliance",
        "version": package_version("compliance"),
        "functions": contract_public_functions("compliance"),
        "errors": compliance_errors("compliance"),
    }
    (out_dir / "compliance.json").write_text(format_compliance(compliance), encoding="utf-8")


if __name__ == "__main__":
    main()
