"""Best-effort external watchdog for one configured Lightning Studio."""
import os
import sys
import time
import urllib.error
import urllib.request


def health_ok(url: str) -> bool:
    try:
        req = urllib.request.Request(url.rstrip("/") + "/health", headers={"User-Agent": "Paperwise-watchdog/1.0"})
        with urllib.request.urlopen(req, timeout=15) as response:
            return response.status == 200 and b'"ok":true' in response.read(4096).replace(b" ", b"")
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def main() -> int:
    api_key = os.environ.get("LIGHTNING_API_KEY")
    teamspace_name = os.environ.get("LIGHTNING_TEAMSPACE")
    studio_name = os.environ.get("LIGHTNING_STUDIO")
    health_url = os.environ.get("PAPERWISE_HEALTH_URL")
    missing = [key for key, val in {
        "LIGHTNING_API_KEY": api_key,
        "LIGHTNING_TEAMSPACE": teamspace_name,
        "LIGHTNING_STUDIO": studio_name,
        "PAPERWISE_HEALTH_URL": health_url,
    }.items() if not val]
    if missing:
        print(
            "Watchdog skipped (not configured). Add these GitHub Actions secrets to enable recovery: "
            + ", ".join(missing),
            file=sys.stderr,
        )
        # Missing optional infrastructure configuration is not a code/test failure.
        # The log remains explicit; no Studio is created and no recovery is claimed.
        return 0

    os.environ["LIGHTNING_API_KEY"] = api_key
    if health_ok(health_url):
        print("Paperwise health endpoint is healthy; no Studio action required.")
        return 0

    try:
        from lightning_sdk import Studio, Teamspace
        teamspace = Teamspace(teamspace_name)
        studio = Studio(name=studio_name, teamspace=teamspace, create_ok=False)
        print(f"Health check failed. Studio status before recovery: {studio.status}")
        studio.start()
        print(f"Studio start requested; current status: {studio.status}")
    except Exception as exc:
        print(f"Could not start configured Studio: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    deadline = time.monotonic() + int(os.getenv("PAPERWISE_HEALTH_WAIT_SECONDS", "600"))
    while time.monotonic() < deadline:
        if health_ok(health_url):
            print("Paperwise API health check passed after Studio recovery.")
            return 0
        time.sleep(10)
    print("Studio start returned but the public API did not become healthy before timeout.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
