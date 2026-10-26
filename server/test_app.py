import pytest
from fastapi.testclient import TestClient
from app import app, _parse_grade

client = TestClient(app)


def test_health_is_available_without_loading_model():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["ok"] is True


@pytest.mark.parametrize("raw,maximum", [
    ('{"score":2,"rationale":"Correct definition and example."}', 5),
    ('Result: {"score": 0.5, "rationale": "One relevant point."}', 2),
])
def test_parse_valid_grades(raw, maximum):
    score, rationale = _parse_grade(raw, maximum)
    assert 0 <= score <= maximum
    assert len(rationale) >= 4


@pytest.mark.parametrize("raw,maximum", [
    ("not json", 5),
    ('{"score":"2","rationale":"looks right"}', 5),
    ('{"score":6,"rationale":"too many marks"}', 5),
    ('{"score":-1,"rationale":"negative"}', 5),
    ('{"score":1,"rationale":""}', 5),
    ('{"score":true,"rationale":"boolean is not a mark"}', 5),
])
def test_parse_rejects_unsafe_grades(raw, maximum):
    with pytest.raises(ValueError):
        _parse_grade(raw, maximum)


def test_grade_rejects_invalid_payload_before_model_load():
    response = client.post("/api/grade", json={"questions": [{
        "id": 1, "prompt": "Explain photosynthesis", "answer": "Plants make food",
        "marks": 0, "criteria": "chlorophyll; sunlight; carbon dioxide; water"
    }]})
    assert response.status_code == 422


def test_openai_compatible_endpoint_with_stub(monkeypatch):
    import app as app_module

    def fake_pipeline():
        def generate(messages, **kwargs):
            return [{"generated_text": '{"score":2,"rationale":"Mentions the core idea."}'}]
        return generate

    monkeypatch.setattr(app_module, "_get_pipeline", fake_pipeline)
    response = client.post("/chat/completions", json={
        "model": "paperwise-test",
        "messages": [{"role": "user", "content": '{"board":"CBSE","grade":"10","questions":[{"id":1,"question":"Define photosynthesis","student_answer":"Plants make food","maximum_marks":3,"marking_points":"states food is made"}]}'}]
    })
    assert response.status_code == 200
    body = response.json()
    parsed = __import__("json").loads(body["choices"][0]["message"]["content"])
    assert parsed["results"][0]["score"] == 2
