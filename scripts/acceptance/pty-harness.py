#!/usr/bin/env python3
"""Bounded manual PTY acceptance harness for an installed Revo/TUI command."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import pty
import re
import selectors
import signal
import subprocess
import sys
import termios
import time
from pathlib import Path
from urllib.parse import urlsplit


DEFAULT_TIMEOUT_SECONDS = 30.0
MAX_TRANSCRIPT_BYTES = 1024 * 1024
READ_CHUNK_BYTES = 4096
POLL_SECONDS = 0.1
EXIT_TIMEOUT_SECONDS = 5.0
PRIVATE_DIRECTORY_MODE = 0o700
PRIVATE_FILE_MODE = 0o600
SIGNAL_EXIT_BASE = 128
ANSI_PATTERN = re.compile(
    r"\x1b\][^\x1b\x07]*(?:\x07|\x1b\\)"
    r"|\x1b[PX^_][^\x1b]*\x1b\\"
    r"|\x1b\[[0-?]*[ -/]*[@-~]"
    r"|\x1b[()][0-2A-Z]"
)


class AcceptanceFailure(RuntimeError):
    pass


def main() -> int:
    arguments = parse_arguments()
    validate_arguments(arguments)
    evidence_directory = prepare_evidence_directory(arguments.evidence_dir)
    original_terminal = terminal_state()
    environment = acceptance_environment(arguments)
    command = command_for(arguments)
    report: dict[str, object] = {
        "schemaVersion": 1,
        "label": arguments.label,
        "scenario": arguments.scenario,
        "command": command,
        "platform": sys.platform,
        "architecture": os.uname().machine,
        "python": sys.version.split()[0],
        "checks": {},
    }

    try:
        no_tty = run_no_tty(command, environment, arguments.timeout)
        write_evidence(evidence_directory / "no-tty.json", no_tty)
        no_tty_output = f'{no_tty["stdout"]}\n{no_tty["stderr"]}'.lower()
        if no_tty["returncode"] == 0 or "tty" not in no_tty_output:
            raise AcceptanceFailure("no-TTY invocation was not rejected clearly")
        report["checks"]["noTty"] = "passed"

        first = run_pty(
            command,
            environment,
            arguments.timeout,
            arguments.expect,
            evidence_directory / "connected-1.log",
        )
        report["checks"]["connected"] = "passed"
        report["connectedExit"] = first["returncode"]

        if arguments.scenario == "recovery":
            killed = run_and_kill(
                command,
                environment,
                arguments.timeout,
                arguments.expect,
                evidence_directory,
            )
            report["checks"]["sigkill"] = killed
            second = run_pty(
                command,
                environment,
                arguments.timeout,
                arguments.expect,
                evidence_directory / "recovery.log",
            )
            report["checks"]["recovery"] = "passed"
            report["recoveryExit"] = second["returncode"]
        elif arguments.scenario == "contention":
            contention = run_contention(
                command,
                environment,
                arguments.timeout,
                arguments.expect,
                evidence_directory,
            )
            report["checks"]["contention"] = contention
    except Exception as error:
        report["status"] = "failed"
        report["error"] = str(error)
        write_evidence(evidence_directory / "report.json", report)
        raise
    finally:
        restore_terminal(original_terminal)

    report["status"] = "passed"
    write_evidence(evidence_directory / "report.json", report)
    print(json.dumps(report, sort_keys=True))
    return 0


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--executable", required=True, type=absolute_path)
    parser.add_argument("--node-executable", type=absolute_path)
    parser.add_argument("--api-url", required=True)
    parser.add_argument("--data-dir", required=True, type=absolute_path)
    parser.add_argument("--evidence-dir", required=True, type=absolute_path)
    parser.add_argument(
        "--scenario", choices=("connected", "recovery", "contention"), default="connected"
    )
    parser.add_argument("--expect", action="append", default=[])
    parser.add_argument("--label", default="tui")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("command_args", nargs=argparse.REMAINDER)
    return parser.parse_args()


def validate_arguments(arguments: argparse.Namespace) -> None:
    if not arguments.executable.is_file() or not os.access(arguments.executable, os.X_OK):
        raise AcceptanceFailure(f"installed executable is not executable: {arguments.executable}")
    if arguments.node_executable is not None and (
        not arguments.node_executable.is_file()
        or not os.access(arguments.node_executable, os.X_OK)
    ):
        raise AcceptanceFailure(
            f"installed Node executable is not executable: {arguments.node_executable}"
        )
    if arguments.timeout <= 0 or arguments.timeout > 300:
        raise AcceptanceFailure("timeout must be greater than zero and at most 300 seconds")
    if not arguments.expect or any(not value for value in arguments.expect):
        raise AcceptanceFailure("at least one non-empty --expect value is required")
    parsed = urlsplit(arguments.api_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise AcceptanceFailure("api URL must be an absolute HTTP(S) URL")
    if parsed.username or parsed.password:
        raise AcceptanceFailure("api URL must not contain credentials")


def absolute_path(value: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise argparse.ArgumentTypeError("path must be absolute")
    return path


def prepare_evidence_directory(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=False, mode=PRIVATE_DIRECTORY_MODE)
    os.chmod(path, PRIVATE_DIRECTORY_MODE)
    return path


def acceptance_environment(arguments: argparse.Namespace) -> dict[str, str]:
    environment = os.environ.copy()
    environment.update(
        {
            "REVO_TUI_API_URL": arguments.api_url,
            "REVO_TUI_DATA_DIR": str(arguments.data_dir),
            "NO_COLOR": "1",
            "TERM": "xterm-256color",
        }
    )
    return environment


def command_for(arguments: argparse.Namespace) -> list[str]:
    command_args = list(arguments.command_args)
    if command_args and command_args[0] == "--":
        command_args = command_args[1:]
    prefix = [] if arguments.node_executable is None else [str(arguments.node_executable)]
    if command_args:
        return [*prefix, str(arguments.executable), *command_args]
    return [
        *prefix,
        str(arguments.executable),
        "--api-url",
        arguments.api_url,
        "--data-dir",
        str(arguments.data_dir),
    ]


def terminal_state() -> list[int] | None:
    if not sys.stdin.isatty():
        return None
    return termios.tcgetattr(sys.stdin.fileno())


def restore_terminal(state: list[int] | None) -> None:
    if state is not None and sys.stdin.isatty():
        termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, state)


def run_no_tty(command: list[str], environment: dict[str, str], timeout: float) -> dict[str, object]:
    started = time.monotonic()
    try:
        result = subprocess.run(
            command,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise AcceptanceFailure("no-TTY invocation timed out") from error
    return {
        "returncode": result.returncode,
        "stdout": bounded_text(result.stdout),
        "stderr": bounded_text(result.stderr),
        "durationSeconds": round(time.monotonic() - started, 3),
    }


def run_pty(
    command: list[str],
    environment: dict[str, str],
    timeout: float,
    expected: list[str],
    log_path: Path,
) -> dict[str, object]:
    master, slave = pty.openpty()
    set_nonblocking(master)
    process = subprocess.Popen(
        command,
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        start_new_session=True,
        close_fds=True,
    )
    os.close(slave)
    transcript = bytearray()
    try:
        wait_for_output(process, master, transcript, expected, timeout)
        os.write(master, b"q")
        returncode = wait_for_exit(process, master, transcript, timeout)
        if returncode != 0:
            raise AcceptanceFailure(f"PTY command exited with {returncode}")
        result = {"returncode": returncode, "transcriptBytes": len(transcript)}
        write_text(log_path, bounded_text(transcript.decode(errors="replace")))
        return result
    except Exception:
        terminate_process_group(process, master, transcript)
        write_text(log_path, bounded_text(transcript.decode(errors="replace")))
        raise
    finally:
        os.close(master)


def run_and_kill(
    command: list[str],
    environment: dict[str, str],
    timeout: float,
    expected: list[str],
    evidence_directory: Path,
) -> dict[str, object]:
    master, slave = pty.openpty()
    set_nonblocking(master)
    process = subprocess.Popen(
        command,
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        start_new_session=True,
        close_fds=True,
    )
    os.close(slave)
    transcript = bytearray()
    try:
        wait_for_output(process, master, transcript, expected, timeout)
        os.killpg(process.pid, signal.SIGKILL)
        returncode = wait_for_exit(process, master, transcript, timeout)
        expected_code = SIGNAL_EXIT_BASE + signal.SIGKILL
        if returncode not in (-signal.SIGKILL, expected_code):
            raise AcceptanceFailure(f"SIGKILL process exited unexpectedly: {returncode}")
        result = {"signal": "SIGKILL", "returncode": returncode}
        write_text(evidence_directory / "sigkill.log", bounded_text(transcript.decode(errors="replace")))
        return result
    finally:
        if process.poll() is None:
            terminate_process_group(process, master, transcript)
        os.close(master)


def run_contention(
    command: list[str],
    environment: dict[str, str],
    timeout: float,
    expected: list[str],
    evidence_directory: Path,
) -> str:
    first_master, first_slave = pty.openpty()
    set_nonblocking(first_master)
    first = subprocess.Popen(
        command,
        env=environment,
        stdin=first_slave,
        stdout=first_slave,
        stderr=first_slave,
        start_new_session=True,
        close_fds=True,
    )
    os.close(first_slave)
    second_master: int | None = None
    second: subprocess.Popen[bytes] | None = None
    first_transcript = bytearray()
    second_transcript = bytearray()
    try:
        wait_for_output(first, first_master, first_transcript, expected, timeout)
        second_master, second_slave = pty.openpty()
        set_nonblocking(second_master)
        second = subprocess.Popen(
            command,
            env=environment,
            stdin=second_slave,
            stdout=second_slave,
            stderr=second_slave,
            start_new_session=True,
            close_fds=True,
        )
        os.close(second_slave)
        wait_for_exit(second, second_master, second_transcript, timeout)
        second_display = normalized_transcript(second_transcript).lower()
        if second.returncode == 0 or (
            "lock" not in second_display and "already open" not in second_display
        ):
            raise AcceptanceFailure(
                "second concurrent invocation was not rejected by command storage lock"
            )
        os.write(first_master, b"q")
        first_code = wait_for_exit(first, first_master, first_transcript, timeout)
        if first_code != 0:
            raise AcceptanceFailure("first contention PTY command did not exit cleanly")
        write_text(
            evidence_directory / "contention.log",
            bounded_text(
                "--- first ---\n"
                + first_transcript.decode(errors="replace")
                + "\n--- second ---\n"
                + second_transcript.decode(errors="replace")
            ),
        )
        return "passed"
    finally:
        if first.poll() is None:
            terminate_process_group(first, first_master, first_transcript)
        if second is not None and second.poll() is None:
            terminate_process_group(second, second_master, second_transcript)
        os.close(first_master)
        if second_master is not None:
            os.close(second_master)


def wait_for_output(
    process: subprocess.Popen[bytes],
    master: int,
    transcript: bytearray,
    expected: list[str],
    timeout: float,
) -> None:
    selector = selectors.DefaultSelector()
    selector.register(master, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout
    required = [value for value in expected]
    try:
        while True:
            if process.poll() is not None:
                raise AcceptanceFailure(
                    f"PTY command exited before readiness: {process.returncode}"
                )
            display = normalized_transcript(transcript)
            if all(value in display for value in required):
                return
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AcceptanceFailure("PTY readiness timeout")
            for key, _ in selector.select(min(POLL_SECONDS, remaining)):
                read_transcript(key.fileobj, transcript)
    finally:
        selector.close()


def wait_for_exit(
    process: subprocess.Popen[bytes],
    master: int,
    transcript: bytearray,
    timeout: float,
) -> int:
    deadline = time.monotonic() + timeout
    while process.poll() is None:
        read_transcript(master, transcript)
        if time.monotonic() >= deadline:
            raise AcceptanceFailure("PTY command did not exit before timeout")
        time.sleep(POLL_SECONDS)
    read_transcript(master, transcript)
    return process.returncode


def read_transcript(master: int, transcript: bytearray) -> None:
    try:
        value = os.read(master, READ_CHUNK_BYTES)
    except OSError:
        return
    if len(transcript) + len(value) > MAX_TRANSCRIPT_BYTES:
        raise AcceptanceFailure("PTY transcript exceeded the evidence bound")
    transcript.extend(value)


def set_nonblocking(master: int) -> None:
    flags = fcntl.fcntl(master, fcntl.F_GETFL)
    fcntl.fcntl(master, fcntl.F_SETFL, flags | os.O_NONBLOCK)


def terminate_process_group(
    process: subprocess.Popen[bytes], master: int, transcript: bytearray
) -> None:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGKILL)
    try:
        wait_for_exit(process, master, transcript, EXIT_TIMEOUT_SECONDS)
    except AcceptanceFailure:
        raise AcceptanceFailure("PTY child cleanup could not be confirmed")


def bounded_text(value: str) -> str:
    if len(value.encode()) <= MAX_TRANSCRIPT_BYTES:
        return value
    encoded = value.encode()[:MAX_TRANSCRIPT_BYTES]
    return encoded.decode(errors="replace")


def normalized_transcript(transcript: bytearray) -> str:
    return ANSI_PATTERN.sub("", transcript.decode(errors="replace"))


def write_text(path: Path, value: str) -> None:
    path.write_text(value, encoding="utf-8")
    os.chmod(path, PRIVATE_FILE_MODE)


def write_evidence(path: Path, value: object) -> None:
    write_text(path, json.dumps(value, sort_keys=True) + "\n")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AcceptanceFailure as error:
        print(f"acceptance failure: {error}", file=sys.stderr)
        raise SystemExit(1) from error
