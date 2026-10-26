"""Paperwise rubric-grounded grading API.

This API deliberately rejects malformed model responses instead of inventing marks.
It is an experimental marking aid; a teacher should review results.
"""
from __future__ import annotations

import json
import os
import re
import threading
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, field_validator

MODEL_ID = os.getenv("PAPERWISE_MODEL_ID", "Qwen/Qwen2.5-1.5B-Instruct")
MAX_QUESTIONS = int(os.getenv("PAPERWISE_MAX_QUESTIONS", "15"))
_model = None
_model_lock = threading.Lock()
app = FastAPI(title="Paperwise Grading API", version="0.1.0")


class Question(BaseModel):
    id: int = Field(ge=0)
    prompt: str = Field(min_length=1, max_length=6000)
    answer: str = Field(max_length=12000)
    marks: float = Field(gt=0, le=100)
    criteria: str = Field(default="", max_length=8000)


class GradeRequest(BaseModel):
    board: str = Field(default="Unknown", max_length=100)
    grade: str = Field(default="Unknown", max_length=50)
    questions: list[Question] = Field(min_length=1, max_length=MAX_QUESTIONS)

    @field_validator("questions")
    @classmethod
    def unique_ids(cls, values):
        ids = [q.id for q in values]
        if len(ids) != len(set(ids)):
            raise ValueError("Question ids must be unique")
        return values


class GradeItem(BaseModel):
    id: int
    score: float
    max: float
    rationale: str


def _get_pipeline():
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                try:
                    import torch
                    from transformers import pipeline
                    device = 0 if torch.cuda.is_available() else -1
                    _model = pipeline(
                        "text-generation",
                        model=MODEL_ID,
                        device=device,
                        model_kwargs={"torch_dtype": "auto"},
                    )
                except Exception as exc:
                    raise RuntimeError(f"Could not load model {MODEL_ID}: {exc}") from exc
    return _model


def _parse_grade(raw: str, maximum: float) -> tuple[float, str]:
    """Extract exactly one JSON object and validate all required fields."""
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("Model did not return a JSON object")
    try:
        data: dict[str, Any] = json.loads(raw[start:end + 1])
    except json.JSONDecodeError as exc:
        raise ValueError("Model returned malformed JSON") from exc
    score = data.get("score")
    rationale = data.get("rationale")
    if isinstance(score, bool) or not isinstance(score, (int, float)):
        raise ValueError("Model score must be a JSON number")
    if not (0 <= float(score) <= maximum):
        raise ValueError("Model score is outside the allowed range")
    if not isinstance(rationale, str) or len(rationale.strip()) < 4:
        raise ValueError("Model rationale is missing or too short")
    if not re.search(r"[A-Za-z0-9]", rationale):
        raise ValueError("Model rationale is not meaningful text")
    return round(float(score), 2), rationale.strip()[:1200]


def _prompt(board: str, grade: str, q: Question) -> str:
    return (
        "You are a cautious school exam marker. Award marks only for content supported "
        "by the student's answer and the provided rubric. Accept equivalent wording. "
        "Give partial credit only for correct relevant ideas. Do not reward irrelevant "
        "or fabricated claims. If the rubric is empty, say that confidence is limited. "
        "Return ONLY valid JSON with exactly these keys: score (JSON number between 0 "
        "and max_marks inclusive) and rationale (brief string explaining awarded/lost marks). "
        "No markdown or extra keys.\n"
        + json.dumps({
            "board": board, "class_level": grade, "question": q.prompt,
            "student_answer": q.answer, "max_marks": q.marks,
            "marking_points": q.criteria or "No marking points supplied; mark conservatively.",
        }, ensure_ascii=False)
    )


def _run_one(generator, req: GradeRequest, q: Question) -> GradeItem:
    prompt = _prompt(req.board, req.grade, q)
    last_error = None
    # One constrained-format retry is safer than silently accepting a broken response.
    for attempt in range(2):
        messages = [
            {"role": "system", "content": "Follow the grading instructions exactly. Output one JSON object only."},
            {"role": "user", "content": prompt + ("" if attempt == 0 else
                "\nYour previous response was invalid. Return a corrected JSON object with a numeric score in range and a non-empty rationale.")},
        ]
        output = generator(messages, max_new_tokens=180, do_sample=False, return_full_text=False)
        try:
            raw = output[0]["generated_text"]
            if isinstance(raw, list):
                raw = next((m.get("content", "") for m in reversed(raw)
                            if m.get("role") == "assistant"), "")
            score, rationale = _parse_grade(str(raw), q.marks)
            return GradeItem(id=q.id, score=score, max=q.marks, rationale=rationale)
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            last_error = exc
    raise ValueError(f"Question {q.id}: model failed output validation after retry ({last_error})")


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_ID, "model_loaded": _model is not None, "max_questions": MAX_QUESTIONS}


@app.post("/api/grade")
def grade(req: GradeRequest):
    try:
        generator = _get_pipeline()
        results = [_run_one(generator, req, q) for q in req.questions]
        return {"results": [r.model_dump() for r in results], "model": MODEL_ID, "review_required": True}
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        # Keep the server response useful but do not expose stack traces or secrets.
        raise HTTPException(status_code=500, detail=f"Grading failed safely: {type(exc).__name__}") from exc


@app.post("/chat/completions")
def openai_compatible_chat(payload: dict[str, Any]):
    """Small OpenAI-compatible adapter used by the existing Paperwise dashboard."""
    messages = payload.get("messages")
    if not isinstance(messages, list) or not messages:
        raise HTTPException(status_code=400, detail="messages must be a non-empty array")
    user_content = next((m.get("content") for m in reversed(messages)
                         if isinstance(m, dict) and m.get("role") == "user"
                         and isinstance(m.get("content"), str)), None)
    if not user_content:
        raise HTTPException(status_code=400, detail="A user message is required")
    try:
        data = json.loads(user_content)
        # The dashboard sends {board, grade, questions:[{id, question, student_answer,
        # maximum_marks, marking_points}]}; normalize to the validated API schema.
        questions = []
        for item in data.get("questions", []):
            questions.append({
                "id": item.get("id"),
                "prompt": item.get("question", item.get("prompt", "")),
                "answer": item.get("student_answer", item.get("answer", "")),
                "marks": item.get("maximum_marks", item.get("marks")),
                "criteria": item.get("marking_points", item.get("criteria", "")),
            })
        request = GradeRequest(board=data.get("board", "Unknown"),
                               grade=data.get("grade", "Unknown"),
                               questions=questions)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="User message must contain a valid grading JSON payload") from exc
    result = grade(request)
    content_text = json.dumps({"results": [
        {"id": item["id"], "score": item["score"], "rationale": item["rationale"]}
        for item in result["results"]
    ]})
    return {
        "id": "paperwise-local-completion",
        "object": "chat.completion",
        "model": payload.get("model", MODEL_ID),
        "choices": [{"index": 0, "message": {"role": "assistant", "content": content_text},
                     "finish_reason": "stop"}],
    }
