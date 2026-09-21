"""Every third-party import must be declared in backend/requirements.txt.

This is a deploy-time failure mode, not a style rule. A module that resolves in
the local dev environment but is missing from requirements.txt crashes the
container at import time, and because the imports are chained
(`main -> api -> abdm -> fidelius`), one absence takes the whole service down
with a `ModuleNotFoundError` that no test noticed.

It has now happened twice: `httpx` (FHIR/SMART/ABDM clients) and `cryptography`
(Fidelius). Both were found by reading a Railway deploy log rather than by CI.
"""
from __future__ import annotations

import ast
import importlib.metadata as md
import pathlib
import re
import sys

BACKEND = pathlib.Path(__file__).resolve().parents[1]
APP = BACKEND / "app"
REQUIREMENTS = BACKEND / "requirements.txt"


def _imported_modules() -> set[str]:
    """Top-level modules imported anywhere in the app package."""
    mods: set[str] = set()
    for path in APP.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                mods.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                mods.add(node.module.split(".")[0])
    return mods


def _declared_packages() -> set[str]:
    """Distribution names declared in requirements.txt, normalised."""
    names = set()
    for line in REQUIREMENTS.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        # "uvicorn[standard]>=0.30" -> "uvicorn"; "psycopg2-binary>=2.9" -> as-is
        name = re.split(r"[\[<>=!~;\s]", line, maxsplit=1)[0].strip()
        names.add(name.lower().replace("_", "-"))
    return names


def test_every_third_party_import_is_declared():
    local = {p.stem for p in APP.rglob("*.py")} | {"app"}
    provider = {
        module: dists[0].lower().replace("_", "-")
        for module, dists in md.packages_distributions().items()
        if dists
    }
    declared = _declared_packages()

    undeclared: list[str] = []
    unmappable: list[str] = []
    for module in sorted(_imported_modules() - set(sys.stdlib_module_names) - local):
        dist = provider.get(module)
        if dist is None:
            unmappable.append(module)
        elif dist not in declared:
            undeclared.append(f"{module} (package: {dist})")

    assert not undeclared, (
        "backend/app imports modules whose distribution is not in "
        "backend/requirements.txt, so the container will die with "
        f"ModuleNotFoundError: {undeclared}"
    )
    # An import we cannot resolve to a package means the check above is blind to
    # it -- fail loudly rather than passing vacuously.
    assert not unmappable, (
        f"could not map these imports to a distribution: {unmappable}"
    )
