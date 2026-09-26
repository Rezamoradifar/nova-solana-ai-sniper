"""Local vector database (requirement #13): embeddings live in SQLite
(memory/db.py), similarity search runs in-process with numpy. No external
vector DB server — this is small enough (thousands of posts at most) that
a linear cosine-similarity scan is instant, and it keeps the whole agent
deployable on a single small container."""

from __future__ import annotations

import numpy as np

from llm.embeddings import embed_text
from memory import db

DUPLICATE_SIMILARITY_THRESHOLD = 0.90


def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    denom = np.linalg.norm(a) * np.linalg.norm(b)
    if denom == 0:
        return 0.0
    return float(np.dot(a, b) / denom)


def index_post(post_id: int, text: str) -> None:
    vector = embed_text(text)
    db.save_embedding(post_id, vector)


def most_similar(text: str, top_k: int = 3) -> list[tuple[int, float]]:
    """Returns [(post_id, similarity)] for the most similar previously-posted
    ideas, most similar first. Empty list if nothing is indexed yet."""
    query_vector = np.array(embed_text(text))
    scored: list[tuple[int, float]] = []
    for post_id, vector in db.all_embeddings():
        similarity = _cosine_similarity(query_vector, np.array(vector))
        scored.append((post_id, similarity))
    scored.sort(key=lambda pair: pair[1], reverse=True)
    return scored[:top_k]


def is_duplicate(text: str) -> bool:
    """Requirement #11: never duplicate previous content. A near-duplicate
    by meaning (not just exact string match) is caught via embedding
    similarity — paraphrasing the same idea doesn't slip through."""
    matches = most_similar(text, top_k=1)
    if not matches:
        return False
    _, similarity = matches[0]
    return similarity >= DUPLICATE_SIMILARITY_THRESHOLD
