"""OpenAI embeddings — the vector half of the local vector database
(memory/vector_store.py). Small model, cheap, no local GPU/torch dependency
needed on a small deployment box."""

from __future__ import annotations

from openai import OpenAI

from core.config import settings

_client = OpenAI(api_key=settings.openai_api_key)
EMBEDDING_MODEL = "text-embedding-3-small"


def embed_text(text: str) -> list[float]:
    response = _client.embeddings.create(model=EMBEDDING_MODEL, input=text[:8000])
    return response.data[0].embedding
