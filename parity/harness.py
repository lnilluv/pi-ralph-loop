#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shlex
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
FIXTURES_ROOT = Path(__file__).resolve().parent / "fixtures"
DEFAULT_MODEL = os.environ.get("PI_RALPH_PARITY_MODEL")
DEFAULT_LOOP_RPC_COMMAND = os.environ.get("PI_RALPH_PARITY_LOOP_RPC_COMMAND")
DEFAULT_RALPHIFY_RPC_COMMAND = os.environ.get("PI_RALPH_PARITY_RALPHIFY_RPC_COMMAND", "")
DEFAULT_LOOP_PROMPT_TEMPLATE = os.environ.get("PI_RALPH_PARITY_LOOP_PROMPT_TEMPLATE", "/ralph --path {ralph_path}")
DEFAULT_RALPHIFY_PROMPT_TEMPLATE = os.environ.get(
    "PI_RALPH_PARITY_RALPHIFY_PROMPT_TEMPLATE",
    "/ralph --path {ralph_path}",
)
TERMINAL_STATUSES = {
    "complete",
    "max-iterations",
    "no-progress-exhaustion",
    "stopped",
    "timeout",
    "error",
    "cancelled",
}
AGENT_FILE_NAMES = ["auth.json", "models.json", "agent-models.json"]


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def inventory(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not path.exists():
        return rows

    for entry in sorted(path.rglob("*")):
        if not entry.is_file():
            continue
        rel = entry.relative_to(path).as_posix()
        data = entry.read_bytes()
        rows.append({
            "path": rel,
            "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        })
    return rows


def write_inventory_tsv(path: Path, rows: list[dict[str, Any]]) -> None:
    lines = ["path\tsize\tsha256"]
    for row in rows:
        lines.append(f"{row['path']}\t{row['size']}\t{row['sha256']}")
    write_text(path, "\n".join(lines) + "\n")


def read_status(task_dir: Path, error_context: list[dict[str, str]] | None = None) -> dict[str, Any] | None:
    status_path = task_dir / ".ralph-runner" / "status.json"
    if not status_path.exists():
        return None
    try:
        payload = json.loads(read_text(status_path))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        if error_context is not None:
            entry = {"path": str(status_path), "error": f"{type(exc).__name__}: {exc}"}
            if not error_context or error_context[-1] != entry:
                error_context.append(entry)
        return None
    if isinstance(payload, dict):
        return payload
    return None


def ensure_agent_dir(bundle_root: Path) -> dict[str, Any]:
    agent_dir = bundle_root / "agent"
    agent_dir.mkdir(parents=True, exist_ok=True)

    source_dir = os.environ.get("PI_CODING_AGENT_DIR")
    if source_dir:
        source = Path(source_dir)
    else:
        source = Path.home() / ".pi" / "agent"

    copied: list[str] = []
    for file_name in AGENT_FILE_NAMES:
        src = source / file_name
        if src.exists():
            shutil.copy2(src, agent_dir / file_name)
            copied.append(file_name)

    return {
        "source": str(source),
        "destination": str(agent_dir),
        "copied_files": copied,
    }


def create_bundle_root(explicit_root: str | None) -> Path:
    if explicit_root:
        root = Path(explicit_root).expanduser().resolve()
        root.mkdir(parents=True, exist_ok=True)
        return root
    return Path(tempfile.mkdtemp(prefix="pi-ralph-parity-")).resolve()


def build_loop_rpc_command(model: str | None) -> list[str]:
    command = [
        "pi",
        "--mode",
        "rpc",
        "--no-extensions",
        "-e",
        str(REPO_ROOT / "src" / "index.ts"),
    ]
    if model:
        command.extend(["--model", model])
    return command


def run_git(args: list[str]) -> str:
    result = subprocess.run(
        ["git", *args],
        # Run the RPC session inside the copied task workspace so file writes stay
        # isolated from the repository checkout.
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    output = (result.stdout + result.stderr).strip()
    return output


def parse_command(text: str) -> list[str]:
    return shlex.split(text)


def task_prompt(prompt_template: str, ralph_path: Path) -> str:
    return prompt_template.format(
        ralph_path=shlex.quote(str(ralph_path)),
        task_dir=shlex.quote(str(ralph_path.parent)),
        fixture=ralph_path.parents[2].name,
        implementation=ralph_path.parents[1].name,
    )


def stream_reader(stream, file_obj, store: list[str], last_output: list[float]) -> None:
    try:
        for line in iter(stream.readline, ""):
            last_output[0] = time.time()
            store.append(line)
            file_obj.write(line)
            file_obj.flush()
    finally:
        try:
            stream.close()
        except (OSError, ValueError):
            pass


def run_rpc_session(
    command: list[str],
    prompt: str,
    cwd: Path,
    env: dict[str, str],
    stdout_path: Path,
    stderr_path: Path,
    task_dir: Path,
    run_timeout_seconds: int,
    quiet_kill_seconds: float,
) -> dict[str, Any]:
    stdout_path.parent.mkdir(parents=True, exist_ok=True)
    stderr_path.parent.mkdir(parents=True, exist_ok=True)

    proc = subprocess.Popen(
        command,
        cwd=str(cwd),
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    stdout_lines: list[str] = []
    stderr_lines: list[str] = []
    last_output = [time.time()]
    termination_reason = "timeout"
    cleanup_errors: list[dict[str, str]] = []
    status_errors: list[dict[str, str]] = []
    startup_grace_seconds = max(quiet_kill_seconds * 10, 30.0)

    stdout_file = stdout_path.open("w", encoding="utf-8")
    stderr_file = stderr_path.open("w", encoding="utf-8")
    threads = [
        threading.Thread(target=stream_reader, args=(proc.stdout, stdout_file, stdout_lines, last_output), daemon=True),
        threading.Thread(target=stream_reader, args=(proc.stderr, stderr_file, stderr_lines, last_output), daemon=True),
    ]
    for thread in threads:
        thread.start()

    payload = json.dumps({"type": "prompt", "id": f"parity-{int(time.time() * 1000)}", "message": prompt}) + "\n"
    if proc.stdin is not None:
        proc.stdin.write(payload)
        proc.stdin.flush()

    started_at = time.time()
    status_snapshot: dict[str, Any] | None = None

    try:
        while time.time() - started_at < run_timeout_seconds:
            if proc.poll() is not None:
                termination_reason = "process-exited"
                break

            status_snapshot = read_status(task_dir, status_errors)
            status_value = status_snapshot.get("status") if status_snapshot else None
            if status_value in TERMINAL_STATUSES:
                termination_reason = f"terminal-status:{status_value}"
                time.sleep(1.0)
                break

            status_is_active = isinstance(status_value, str) and status_value in {"initializing", "running"}
            if (
                quiet_kill_seconds > 0
                and time.time() - started_at >= startup_grace_seconds
                and time.time() - last_output[0] > quiet_kill_seconds
                and not status_is_active
            ):
                termination_reason = "idle-timeout:no-status"
                break

            time.sleep(0.25)
    finally:
        if proc.poll() is None:
            try:
                proc.terminate()
            except (ProcessLookupError, OSError) as exc:
                cleanup_errors.append({"action": "terminate", "error": f"{type(exc).__name__}: {exc}"})
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired as exc:
                cleanup_errors.append({"action": "wait-after-terminate", "error": f"{type(exc).__name__}: {exc}"})
                try:
                    proc.kill()
                except (ProcessLookupError, OSError) as kill_exc:
                    cleanup_errors.append({"action": "kill", "error": f"{type(kill_exc).__name__}: {kill_exc}"})
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired as wait_exc:
                    cleanup_errors.append({"action": "wait-after-kill", "error": f"{type(wait_exc).__name__}: {wait_exc}"})

        if proc.stdin is not None:
            try:
                proc.stdin.close()
            except (OSError, ValueError) as exc:
                cleanup_errors.append({"action": "close-stdin", "error": f"{type(exc).__name__}: {exc}"})

        for thread in threads:
            thread.join(timeout=2)
        stdout_file.close()
        stderr_file.close()

    return {
        "returncode": proc.returncode,
        "stdout_lines": stdout_lines,
        "stderr_lines": stderr_lines,
        "status": status_snapshot,
        "termination_reason": termination_reason,
        "cleanup_errors": cleanup_errors,
        "status_errors": status_errors,
        "command": command,
        "prompt": prompt,
    }


def run_verifier(task_dir: Path, env: dict[str, str], run_dir: Path) -> dict[str, Any]:
    verify_script = task_dir / "scripts" / "verify.sh"
    if not verify_script.exists():
        return {"skipped": True}

    verify_command = ["bash", str(verify_script)]
    result = subprocess.run(
        verify_command,
        cwd=str(task_dir),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    write_text(run_dir / "verify.command.txt", " ".join(shlex.quote(part) for part in verify_command) + "\n")
    write_text(run_dir / "verify.stdout.log", result.stdout)
    write_text(run_dir / "verify.stderr.log", result.stderr)
    payload = {
        "returncode": result.returncode,
        "command": verify_command,
        "cwd": str(task_dir),
        "passed": result.returncode == 0,
    }
    write_json(run_dir / "verify.json", payload)
    return payload


def implementation_plan(implementation: str, loop_command: list[str], loop_prompt_template: str, ralphify_command: list[str] | None) -> list[tuple[str, list[str], str]]:
    if implementation == "pi-ralph-loop":
        return [("pi-ralph-loop", loop_command, loop_prompt_template)]
    if implementation == "ralphify":
        if not ralphify_command:
            raise SystemExit("--implementation ralphify requires PI_RALPH_PARITY_RALPHIFY_RPC_COMMAND or --ralphify-rpc-command")
        return [("ralphify", ralphify_command, DEFAULT_RALPHIFY_PROMPT_TEMPLATE)]
    if implementation == "both":
        if not ralphify_command:
            raise SystemExit("--implementation both requires a Ralphify RPC command")
        return [
            ("pi-ralph-loop", loop_command, loop_prompt_template),
            ("ralphify", ralphify_command, DEFAULT_RALPHIFY_PROMPT_TEMPLATE),
        ]
    raise SystemExit(f"Unknown implementation: {implementation}")


def run_fixture(bundle_root: Path, fixture_name: str, implementation: str, rpc_command: list[str], prompt_template: str, env: dict[str, str], run_timeout_seconds: int, quiet_kill_seconds: float) -> dict[str, Any]:
    fixture_dir = FIXTURES_ROOT / fixture_name
    if not fixture_dir.exists():
        raise SystemExit(f"Missing fixture directory: {fixture_dir}")

    run_dir = bundle_root / "runs" / fixture_name / implementation
    task_dir = run_dir / "task"
    if run_dir.exists():
        shutil.rmtree(run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)

    shutil.copytree(fixture_dir, task_dir)

    before_rows = inventory(task_dir)
    write_inventory_tsv(run_dir / "inventory-before.tsv", before_rows)
    write_json(run_dir / "fixture-manifest.json", {
        "fixture": fixture_name,
        "implementation": implementation,
        "fixture_dir": str(fixture_dir),
        "task_dir": str(task_dir),
        "files": before_rows,
    })

    ralph_path = task_dir / "RALPH.md"
    prompt = task_prompt(prompt_template, ralph_path)
    write_text(run_dir / "command.txt", " ".join(shlex.quote(part) for part in rpc_command) + "\n")
    write_text(run_dir / "prompt.txt", prompt + "\n")

    started_at = utc_now()
    session_result = run_rpc_session(
        rpc_command,
        prompt,
        task_dir,
        env,
        run_dir / "top-level-rpc.jsonl",
        run_dir / "top-level-stderr.log",
        task_dir,
        run_timeout_seconds,
        quiet_kill_seconds,
    )

    after_rows = inventory(task_dir)
    write_inventory_tsv(run_dir / "inventory-after.tsv", after_rows)
    verifier_result = run_verifier(task_dir, env, run_dir)

    metadata = {
        "fixture": fixture_name,
        "implementation": implementation,
        "command": rpc_command,
        "prompt": prompt,
        "task_dir": str(task_dir),
        "started_at": started_at,
        "finished_at": utc_now(),
        "termination_reason": session_result["termination_reason"],
        "session": {
            "returncode": session_result["returncode"],
            "status": session_result["status"],
            "termination_reason": session_result["termination_reason"],
            "cleanup_errors": session_result["cleanup_errors"],
            "status_errors": session_result["status_errors"],
            "stdout_lines": len(session_result["stdout_lines"]),
            "stderr_lines": len(session_result["stderr_lines"]),
        },
        "verifier": verifier_result,
        "inventory": {
            "before_count": len(before_rows),
            "after_count": len(after_rows),
        },
    }
    write_json(run_dir / "run-metadata.json", metadata)

    return metadata


def main() -> int:
    parser = argparse.ArgumentParser(description="Replay parity fixtures and capture provenance bundles.")
    parser.add_argument(
        "--fixture",
        action="append",
        choices=("research", "migrate"),
        help="Fixture to run. May be provided more than once. Default: both fixtures.",
    )
    parser.add_argument(
        "--implementation",
        choices=("pi-ralph-loop", "ralphify", "both"),
        default="pi-ralph-loop",
        help="Which implementation to run.",
    )
    parser.add_argument(
        "--root",
        help="Reuse this artifact root instead of creating a fresh temp dir.",
    )
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help="Model to pin for the built-in pi-ralph-loop command. If omitted, pi uses the currently active model.",
    )
    parser.add_argument(
        "--loop-rpc-command",
        default=DEFAULT_LOOP_RPC_COMMAND,
        help="Full RPC command override for pi-ralph-loop. When set, this replaces the built-in pi command entirely.",
    )
    parser.add_argument(
        "--ralphify-rpc-command",
        default=DEFAULT_RALPHIFY_RPC_COMMAND,
        help="RPC command used for Ralphify.",
    )
    parser.add_argument(
        "--loop-prompt-template",
        default=DEFAULT_LOOP_PROMPT_TEMPLATE,
        help="Prompt template used for pi-ralph-loop.",
    )
    parser.add_argument(
        "--ralphify-prompt-template",
        default=DEFAULT_RALPHIFY_PROMPT_TEMPLATE,
        help="Prompt template used for Ralphify.",
    )
    parser.add_argument(
        "--run-timeout-seconds",
        type=int,
        default=900,
        help="Maximum wall-clock time per run.",
    )
    parser.add_argument(
        "--quiet-kill-seconds",
        type=float,
        default=3.0,
        help="How long to wait with no output before a non-status-aware process is considered idle. Processes that report initializing/running status are allowed to stay silent.",
    )
    args = parser.parse_args()

    fixtures = args.fixture if args.fixture else ["research", "migrate"]
    bundle_root = create_bundle_root(args.root or os.environ.get("PI_RALPH_PARITY_ROOT"))
    agent_info = ensure_agent_dir(bundle_root)

    env = os.environ.copy()
    env["PI_CODING_AGENT_DIR"] = agent_info["destination"]

    loop_command = (
        parse_command(args.loop_rpc_command)
        if args.loop_rpc_command
        else build_loop_rpc_command(args.model)
    )
    ralphify_command = parse_command(args.ralphify_rpc_command) if args.ralphify_rpc_command else None

    runs: list[dict[str, Any]] = []
    for fixture_name in fixtures:
        for impl_name, rpc_command, prompt_template in implementation_plan(args.implementation, loop_command, args.loop_prompt_template, ralphify_command):
            metadata = run_fixture(
                bundle_root,
                fixture_name,
                impl_name,
                rpc_command,
                prompt_template if impl_name == "pi-ralph-loop" else args.ralphify_prompt_template,
                env,
                args.run_timeout_seconds,
                args.quiet_kill_seconds,
            )
            runs.append(metadata)

    manifest = {
        "created_at": utc_now(),
        "repo_root": str(REPO_ROOT),
        "repo_head": run_git(["rev-parse", "HEAD"]),
        "repo_status": run_git(["status", "--short"]),
        "bundle_root": str(bundle_root),
        "agent": agent_info,
        "fixtures": fixtures,
        "implementation": args.implementation,
        "loop_rpc_command": loop_command,
        "ralphify_rpc_command": ralphify_command,
        "runs": runs,
    }
    write_json(bundle_root / "manifest.json", manifest)

    print(bundle_root)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
