# Paperwise — AI Exam Checker

Paperwise grades school answers against teacher-provided marking points. It is designed to fail safely: invalid model output is never silently converted into a mark.

## Components
- Existing Paperwise dashboard: https://paperwise-ai-exam-checker-p4b87k.v2.appdeploy.ai/
- `server/`: self-hosted OpenAI-compatible grading API using an open-weight Hugging Face model.
- `.lightning_studio/on_start.sh`: starts the API when a Lightning Studio launches.
- `.github/workflows/lightning-watchdog.yml`: best-effort scheduled health check and Studio start via Lightning SDK.

## Important limitations
1. No model host or Lightning credentials are supplied in this repository. The watchdog stays disabled until repository Actions secrets are configured.
2. GitHub scheduled workflows are best-effort and can be delayed. This is not a 24/7 uptime guarantee.
3. The model is an assistant, not a certified examiner. Always review marks; test against a representative, teacher-verified answer set before relying on scores.
4. Do not commit API keys, access tokens, student names, or exam papers containing personal information.

## Local API quick start
Python 3.11+ recommended:
```bash
cd server
pip install -r requirements.txt
export PAPERWISE_MODEL_ID=Qwen/Qwen2.5-1.5B-Instruct
uvicorn app:app --host 0.0.0.0 --port 8000
```
First start downloads model weights. Memory and speed depend on the machine. `GET /health` reports readiness; `POST /api/grade` accepts a JSON grading request. See `docs/API.md`.

## Lightning setup (one-time)
1. Open the Lightning Studio that should host Paperwise.
2. Clone this repository into the Studio, or copy its `.lightning_studio/on_start.sh` and `server/` directory into the Studio home directory.
3. Configure the Studio's environment for `PAPERWISE_MODEL_ID`, then make the startup script executable.
4. Expose port 8000 using the port-sharing feature supported by your Lightning Studio and record its HTTPS URL.
5. Set GitHub repository Actions secrets: `LIGHTNING_API_KEY`, `LIGHTNING_TEAMSPACE` (owner/teamspace), `LIGHTNING_STUDIO`, and `PAPERWISE_HEALTH_URL` (the exact externally reachable HTTPS health URL).
6. Enable Actions and run the workflow manually once. Check the Actions logs and `/health`.

Lightning SDK uses the configured teamspace and Studio name; it cannot discover the intended Studio without these values. Never paste tokens into code or chat.

## Tests
```bash
cd server
pip install -r requirements.txt
pytest -q
```
