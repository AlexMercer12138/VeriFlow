import json
import subprocess
import sys
from typing import Any, Dict, Optional, Tuple, Union


REQUEST = {
    "protocolVersion": 1,
    "requestId": "pyinstaller-probe",
    "type": "probe",
    "payload": {"source": "module packaged; endmodule"},
}


def _output_text(value: Optional[Union[bytes, str]]) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value


def _merge_output(
    partial: Optional[Union[bytes, str]], drained: Optional[Union[bytes, str]]
) -> str:
    partial_text = _output_text(partial)
    drained_text = _output_text(drained)
    if drained_text.startswith(partial_text):
        return drained_text
    if partial_text.endswith(drained_text):
        return partial_text
    return partial_text + drained_text


def _close_process_pipes(process: subprocess.Popen) -> None:
    for stream in (process.stdin, process.stdout, process.stderr):
        if stream is not None and not stream.closed:
            stream.close()


def _communicate_with_timeout(
    process: subprocess.Popen,
    request: str,
    timeout: float,
    cleanup_timeout: float = 5,
) -> Tuple[str, str]:
    try:
        return process.communicate(request, timeout=timeout)
    except subprocess.TimeoutExpired as timeout_error:
        if process.poll() is None:
            process.kill()

        drained_stdout: Optional[Union[bytes, str]] = None
        drained_stderr: Optional[Union[bytes, str]] = None
        cleanup_error: Optional[subprocess.TimeoutExpired] = None
        try:
            drained_stdout, drained_stderr = process.communicate(
                timeout=cleanup_timeout
            )
        except subprocess.TimeoutExpired as error:
            cleanup_error = error
            if process.poll() is None:
                process.kill()
        finally:
            if process.poll() is None:
                try:
                    process.wait(timeout=cleanup_timeout)
                except subprocess.TimeoutExpired as error:
                    _close_process_pipes(process)
                    raise RuntimeError(
                        "Parser worker timed out and could not be reaped after termination"
                    ) from error
            _close_process_pipes(process)

        stdout = _merge_output(
            timeout_error.output,
            drained_stdout if cleanup_error is None else cleanup_error.output,
        )
        stderr = _merge_output(
            timeout_error.stderr,
            drained_stderr if cleanup_error is None else cleanup_error.stderr,
        )
        raise RuntimeError(
            f"Parser worker timed out after {timeout} seconds; "
            f"stdout={stdout!r}; stderr={stderr!r}"
        ) from timeout_error


def run_probe() -> Dict[str, Any]:
    from veriflow_hdl_worker.runtime import runtime_paths, startup_info

    paths = runtime_paths()
    process = subprocess.Popen(
        [str(paths.executable)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        **startup_info(),
    )
    try:
        stdout, stderr = _communicate_with_timeout(
            process,
            json.dumps(REQUEST) + "\n",
            timeout=10,
        )
    except BaseException:
        if process.poll() is None:
            process.kill()
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                process.wait(timeout=5)
        raise

    if process.returncode != 0:
        raise RuntimeError(f"Parser worker exited with code {process.returncode}: {stderr}")
    if stderr != "":
        raise RuntimeError(f"Parser worker wrote unexpected stderr: {stderr}")

    lines = stdout.splitlines()
    if len(lines) != 1 or not lines[0]:
        raise RuntimeError(f"Expected exactly one JSON response line, received: {stdout!r}")
    try:
        response = json.loads(lines[0])
    except json.JSONDecodeError as error:
        raise RuntimeError(f"Parser worker returned invalid JSON: {error}") from error

    expected = {
        "protocolVersion": 1,
        "requestId": "pyinstaller-probe",
        "type": "probe",
        "ok": True,
        "payload": {
            "rootType": "source_file",
            "containsModule": True,
            "languageAbi": 15,
        },
    }
    if response != expected:
        raise RuntimeError(f"Parser worker returned an invalid probe response: {response!r}")
    return response


def main() -> int:
    try:
        run_probe()
    except Exception as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
