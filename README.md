# Paperwise — AI Exam Checker

Paperwise grades school answers against teacher-provided marking points. It is designed to fail safely: invalid model output is never silently converted into a mark.

## Components
- Existing Paperwise dashboard: https://paperwise-ai-exam-checker-p4b87k.v2.appdeploy.ai/
- `server/`: FastAPI grading API using an open-weight Hugging Face model.
- `kaggle/paperwise_gpu_test.ipynb`: Kaggle GPU smoke-test notebook. It loads and evaluates the pretrained model; it is **not** a fine-tuning/training run and does not save trained weights.
- `server/evaluate_live.py`: repeatable benchmark against a running API.
- `.lightning_studio/on_start.sh`: starts the API when a configured Lightning Studio launches.
- `.github/workflows/lightning-watchdog.yml`: best-effort health check and Studio start via Lightning SDK.

## Current deployment status and limitations
1. The API source and Kaggle test notebook are in this repository, but a persistent public model API is **not verified/deployed** by the repository alone.
2. The Lightning watchdog requires repository Actions secrets `LIGHTNING_API_KEY`, `LIGHTNING_TEAMSPACE`, `LIGHTNING_STUDIO`, and `PAPERWISE_HEALTH_URL`. Without these, it deliberately skips recovery. A green watchdog run with missing secrets does not mean an API is running.
3. Kaggle notebook execution is temporary; ending a Kaggle session does not leave a permanent endpoint.
4. The model is an assistant, not a certified examiner. Do not rely on marks without human review and a representative, teacher-verified benchmark.
5. Do not commit API keys, access tokens, student names, or exam papers containing personal information.

## Local API quick start
Python 3.11+ recommended:
```bash
cd server
pip install -r requirements.txt
export PAPERWISE_MODEL_ID=Qwen/Qwen2.5-1.5B-Instruct
uvicorn app:app --host 0.0.0.0 --port 8000
```
First start downloads model weights. Memory and speed depend on the machine. `GET /health` reports process/model status; `POST /api/grade` accepts a JSON grading request. See `docs/API.md`.

## Run the live grading regression benchmark
With the API running:
```bash
cd server
python evaluate_live.py --url http://127.0.0.1:8000
```
The report is saved to `paperwise-evaluation-report.json`. Its eight expected score ranges are a small regression smoke test, **not** a teacher-certified accuracy result. Review/replace the expected scores with teacher-approved values before using this as evidence of quality. A failed case returns exit code 2.

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
