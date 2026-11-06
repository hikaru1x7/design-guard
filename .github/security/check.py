#!/usr/bin/env python3
"""Run local static checks without printing source lines or credential values."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
SETTINGS = Path(__file__).resolve().parent
SCANNER_VERSION = "1.33.1"
SCANNER_URL = f"https://github.com/opengrep/opengrep/releases/download/v{SCANNER_VERSION}/opengrep_manylinux_x86"
SCANNER_SHA256 = "46e8133cc490f9f50518061590ce2f6be5a08afaeda034471c0ceda4b3899808"
SOURCE_SUFFIXES = {".py", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".sh", ".bash", ".html", ".htm", ".yml", ".yaml", ".json"}
# Collected responses and historical evidence are data, not application code.
# Added contents in these directories are still checked by the diff secret scan.
DATA_PREFIXES = ("loop/receipts/", "loop/state/", "reports/", "docs/archive/", "docs/chatgpt-archive/", "docs/history-analysis/", "docs/legacy/")
COOLDOWN_RULE = "package_managers.dependabot.dependabot-missing-cooldown.dependabot-missing-cooldown"
RULE_HASHES = {"ci.yaml": "aea875138aa7a42181cf1f8fec6ee3ec9470101cb08d9b10a676a5e669d4c4c5", "secrets.yaml": "d1afb323ed493cf9d3ee5044447b989debf033b2b7cc8208662a81b8c162c66a", "providers.yaml": "b7aa1868fb4d0623cde619f973c2093b6cd822d302979c708243745b37c3c202"}


def git(*args):
    return subprocess.check_output(["git", "-C", str(ROOT), *args])


def scanner():
    supplied = os.environ.get("SECURITY_SCANNER")
    if supplied:
        path = Path(supplied)
    else:
        path = Path(os.environ.get("RUNNER_TEMP", tempfile.gettempdir())) / f"opengrep-{SCANNER_VERSION}"
        if not path.exists():
            with urllib.request.urlopen(SCANNER_URL, timeout=60) as response:
                payload = response.read()
            if hashlib.sha256(payload).hexdigest() != SCANNER_SHA256:
                raise RuntimeError("Scanner download checksum mismatch")
            path.write_bytes(payload)
            path.chmod(0o700)
    if hashlib.sha256(path.read_bytes()).hexdigest() != SCANNER_SHA256:
        raise RuntimeError("Scanner executable checksum mismatch")
    return path


def sources():
    paths = git("ls-files", "--cached", "--others", "--exclude-standard", "-z").decode().split("\0")
    selected, skipped = [], []
    for name in sorted(set(filter(None, paths))):
        path = ROOT / name
        if not path.is_file() or path.is_symlink():
            continue
        if name.startswith(DATA_PREFIXES) or "/node_modules/" in f"/{name}" or "/.venv/" in f"/{name}":
            skipped.append({"path": name, "reason": "generated_or_archived_data"})
        elif path.suffix.lower() in SOURCE_SUFFIXES or path.name in {"Dockerfile", "Makefile"}:
            if path.stat().st_size > 2_000_000:
                skipped.append({"path": name, "reason": "source_larger_than_2MB"})
            else:
                selected.append(name)
    return selected, skipped


def changes(destination):
    event_path = os.environ.get("GITHUB_EVENT_PATH")
    event = json.loads(Path(event_path).read_text()) if event_path else {}
    pull_request = event.get("pull_request")
    if pull_request:
        base, head = pull_request["base"]["sha"], pull_request["head"]["sha"]
    else:
        head = git("rev-parse", "HEAD").decode().strip()
        base = event.get("before")
        if not base or set(base) == {"0"}:
            base = git("rev-parse", "HEAD^").decode().strip()
    if not all(re.fullmatch(r"[0-9a-f]{40,64}", ref) for ref in (base, head)):
        raise RuntimeError("Invalid change reference")
    # Scan each new commit, so adding and then deleting a key in one push is caught.
    patch = git("-c", "core.quotepath=false", "log", "--format=", "--no-ext-diff", "--no-textconv", "--full-history", "--patch", "--unified=0", f"{base}..{head}").decode("utf-8", errors="replace")
    added, mapping, filename, line_number = [], [], None, 0
    for line in patch.splitlines():
        if line.startswith("+++ b/"):
            filename = line[6:]
        elif line.startswith("@@"):
            match = re.search(r"\+(\d+)", line)
            line_number = int(match.group(1)) if match else 0
        elif line.startswith("+") and not line.startswith("+++"):
            added.append(line[1:])
            mapping.append({"path": filename, "line": line_number})
            line_number += 1
        elif line.startswith(" "):
            line_number += 1
    payload = ("\n".join(added) + "\n").encode() if added else b""
    destination.write_bytes(payload)
    return {"base": base, "head": head, "bytes": len(payload)}, mapping


def run_scan(binary, configs, targets, patch=False):
    if not targets:
        return {"results": [], "errors": [], "paths": {"scanned": []}, "exit_code": 0}
    command = [str(binary), "scan", "--json", "--no-git-ignore", "--no-rewrite-rule-ids", "--jobs", "2", "--timeout", "15", "--timeout-threshold", "3", "--max-target-bytes", "0" if patch else "2000000", "--exclude-rule", COOLDOWN_RULE]
    with tempfile.TemporaryDirectory(prefix="security-rules-") as folder:
        for config in configs:
            payload = gzip.decompress((SETTINGS / (config + ".gz")).read_bytes())
            if hashlib.sha256(payload).hexdigest() != RULE_HASHES[config]:
                raise RuntimeError("Security rule checksum mismatch")
            path = Path(folder) / config
            path.write_bytes(payload)
            command.extend(["--config", str(path)])
        command.append("--")
        command.extend(str(target) for target in targets)
        result = subprocess.run(command, cwd=ROOT, capture_output=True, timeout=360)
    try:
        raw = json.loads(result.stdout)
    except (ValueError, UnicodeDecodeError):
        raise RuntimeError(f"Scanner produced no usable result (exit {result.returncode})") from None
    if not raw.get("paths", {}).get("scanned") and not raw.get("errors"):
        raise RuntimeError("No requested targets were scanned")
    findings = []
    for item in raw.get("results", []):
        findings.append({"rule": item.get("check_id"), "path": item.get("path"), "line": item.get("start", {}).get("line"), "severity": item.get("extra", {}).get("severity")})
    errors = [{key: item.get(key) for key in ("type", "level", "path")} for item in raw.get("errors", [])]
    return {"exit_code": result.returncode, "version": raw.get("version"), "results": findings, "errors": errors, "paths": raw.get("paths", {})}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path)
    arguments = parser.parse_args()
    paths, skipped = sources()
    binary = scanner()
    code = run_scan(binary, ["ci.yaml", "secrets.yaml", "providers.yaml"], paths)
    with tempfile.TemporaryDirectory(prefix="security-diff-") as folder:
        patch = Path(folder) / "added-commits.txt"
        change_range, mapping = changes(patch)
        secrets = run_scan(binary, ["secrets.yaml", "providers.yaml"], [patch], patch=True) if change_range["bytes"] else {"exit_code": 0, "results": [], "errors": []}
        for finding in secrets["results"]:
            index = (finding["line"] or 0) - 1
            if 0 <= index < len(mapping):
                finding.update(mapping[index])
    report = {"code": code, "change_secrets": secrets, "change_range": change_range, "selected_sources": len(paths), "excluded_data_and_large_sources": skipped}
    failed = any(scan["exit_code"] != 0 or scan["errors"] or scan["results"] for scan in (code, secrets))
    report["passed"] = not failed
    if arguments.report:
        arguments.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    text = [f"Code security: {'FAILED' if failed else 'PASSED'}", f"Source files selected: {len(paths)}", f"Excluded archived/data/large files: {len(skipped)}"]
    for label, scan in (("code", code), ("change secrets", secrets)):
        text.append(f"{label}: {len(scan['results'])} findings; {len(scan['errors'])} scan errors")
        for item in scan["results"]:
            text.append(f"- {item['rule']} at {json.dumps(item['path'], ensure_ascii=False)}:{item['line']}")
        for item in scan["errors"]:
            text.append(f"- scan error {item['type']} at {item['path']}")
    output = "\n".join(text) + "\n"
    print(output)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as stream:
            stream.write(output)
    return int(failed)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, subprocess.SubprocessError, OSError, KeyError) as error:
        print(f"Security check could not finish: {type(error).__name__}", file=sys.stderr)
        raise SystemExit(2)
