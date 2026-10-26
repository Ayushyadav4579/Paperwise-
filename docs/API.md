# Paperwise API contract

## Health
`GET /health` returns `ok`, configured model id, whether model weights have been loaded, and maximum question count. A healthy process does not necessarily mean model weights are loaded; the first grading request loads them.

## Grade
`POST /api/grade` JSON example:
```json
{
  "board": "CBSE",
  "grade": "10",
  "questions": [{
    "id": 1,
    "prompt": "Explain photosynthesis.",
    "answer": "Plants use sunlight to make glucose from carbon dioxide and water.",
    "marks": 3,
    "criteria": "Uses sunlight; mentions carbon dioxide and water; states glucose/food is produced."
  }]
}
```
Response includes `results`, model id, and `review_required: true`. Each result has `id`, numeric `score`, `max`, and `rationale`. If output cannot be validated after one retry, the whole request fails safely with HTTP 422 instead of inventing a mark.

## Security
Do not expose an unauthenticated grading endpoint containing private student data to the public internet. Add an access token or an authenticated reverse proxy before real classroom use. Keep CORS narrow and rate-limit requests when connecting the dashboard.
