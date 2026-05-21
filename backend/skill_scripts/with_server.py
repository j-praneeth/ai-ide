"""
with_server.py — Start one or more servers, wait for their ports to be ready,
run a command, then shut everything down cleanly.

Usage:
    python with_server.py \
        --server "cd backend && python server.py" --port 3000 \
        --server "cd frontend && npm run dev" --port 5173 \
        -- python your_automation.py

Options:
    --server CMD   Shell command to start a server (repeatable)
    --port N       Port to wait for (paired with the preceding --server)
    --timeout N    Seconds to wait for each port (default 30)
    --            Everything after this is the command to run
"""
import argparse
import shlex
import signal
import socket
import subprocess
import sys
import time


def _port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            return True
    except OSError:
        return False


def _wait_for_port(port: int, timeout: int = 30) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _port_open(port):
            return True
        time.sleep(0.5)
    return False


def main():
    # Split argv on '--'
    try:
        sep = sys.argv.index("--")
        own_args = sys.argv[1:sep]
        run_args = sys.argv[sep + 1:]
    except ValueError:
        print("Usage: python with_server.py --server CMD --port N ... -- CMD [ARGS...]")
        sys.exit(1)

    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--server", action="append", default=[])
    parser.add_argument("--port", action="append", type=int, default=[])
    parser.add_argument("--timeout", type=int, default=30)
    opts, _ = parser.parse_known_args(own_args)

    if len(opts.server) != len(opts.port):
        print("Each --server must be paired with a --port")
        sys.exit(1)

    procs = []
    try:
        for cmd, port in zip(opts.server, opts.port):
            print(f"Starting: {cmd} (waiting for port {port})")
            p = subprocess.Popen(cmd, shell=True)
            procs.append(p)
            if not _wait_for_port(port, opts.timeout):
                print(f"Timed out waiting for port {port}")
                sys.exit(1)
            print(f"  port {port} ready.")

        result = subprocess.run(run_args)
        sys.exit(result.returncode)

    finally:
        for p in procs:
            try:
                p.send_signal(signal.SIGTERM)
                p.wait(timeout=5)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass


if __name__ == "__main__":
    main()
