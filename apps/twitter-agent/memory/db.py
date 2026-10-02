"""SQLite persistence layer. One file, stdlib sqlite3, WAL mode so the
scheduler loop and the dashboard's read queries never block each other.
Every other module goes through this — nobody else opens memory.sqlite3
directly."""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone

from core.config import settings

_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tweet_id TEXT UNIQUE,
    content_type TEXT NOT NULL,
    text TEXT NOT NULL,
    hashtags TEXT NOT NULL DEFAULT '[]',
    source_url TEXT,
    score_total REAL,
    score_breakdown TEXT,
    posted_at TEXT NOT NULL,
    hour_of_day INTEGER NOT NULL,
    day_of_week INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS post_embeddings (
    post_id INTEGER PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
    vector TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS engagement_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tweet_id TEXT NOT NULL,
    likes INTEGER NOT NULL,
    retweets INTEGER NOT NULL,
    replies INTEGER NOT NULL,
    quotes INTEGER NOT NULL,
    impressions INTEGER NOT NULL,
    captured_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_engagement_tweet ON engagement_snapshots(tweet_id);

CREATE TABLE IF NOT EXISTS processed_mentions (
    tweet_id TEXT PRIMARY KEY,
    author_username TEXT NOT NULL,
    replied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_memory (
    author_id TEXT PRIMARY KEY,
    history TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quoted_tweets (
    tweet_id TEXT PRIMARY KEY,
    quoted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS style_notes (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    notes TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ideas_used (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idea_fingerprint TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL
);
"""


def get_connection() -> sqlite3.Connection:
    """One connection per thread — APScheduler runs jobs on a small thread
    pool, and sqlite3 connections aren't safe to share across threads."""
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = sqlite3.connect(settings.db_path, check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.row_factory = sqlite3.Row
        _local.conn = conn
    return conn


def init_db() -> None:
    conn = get_connection()
    conn.executescript(SCHEMA)
    conn.execute(
        "INSERT OR IGNORE INTO style_notes (id, notes, updated_at) VALUES (1, '', ?)",
        (_now_iso(),),
    )
    conn.commit()


@contextmanager
def cursor():
    conn = get_connection()
    cur = conn.cursor()
    try:
        yield cur
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---- posts ----------------------------------------------------------------


def save_post(
    tweet_id: str | None,
    content_type: str,
    text: str,
    hashtags: list[str],
    source_url: str | None,
    score_total: float | None,
    score_breakdown: dict | None,
) -> int:
    now = datetime.now(timezone.utc)
    with cursor() as cur:
        cur.execute(
            """INSERT INTO posts
               (tweet_id, content_type, text, hashtags, source_url, score_total,
                score_breakdown, posted_at, hour_of_day, day_of_week)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                tweet_id,
                content_type,
                text,
                json.dumps(hashtags),
                source_url,
                score_total,
                json.dumps(score_breakdown or {}),
                now.isoformat(),
                now.hour,
                now.weekday(),
            ),
        )
        return cur.lastrowid


def recent_post_texts(limit: int = 200) -> list[str]:
    with cursor() as cur:
        cur.execute("SELECT text FROM posts ORDER BY id DESC LIMIT ?", (limit,))
        return [row["text"] for row in cur.fetchall()]


def all_posts() -> list[sqlite3.Row]:
    with cursor() as cur:
        cur.execute("SELECT * FROM posts ORDER BY id DESC")
        return cur.fetchall()


# ---- embeddings (local vector store) --------------------------------------


def save_embedding(post_id: int, vector: list[float]) -> None:
    with cursor() as cur:
        cur.execute(
            "INSERT OR REPLACE INTO post_embeddings (post_id, vector) VALUES (?, ?)",
            (post_id, json.dumps(vector)),
        )


def all_embeddings() -> list[tuple[int, list[float]]]:
    with cursor() as cur:
        cur.execute("SELECT post_id, vector FROM post_embeddings")
        return [(row["post_id"], json.loads(row["vector"])) for row in cur.fetchall()]


# ---- engagement -------------------------------------------------------------


def save_engagement_snapshot(
    tweet_id: str, likes: int, retweets: int, replies: int, quotes: int, impressions: int
) -> None:
    with cursor() as cur:
        cur.execute(
            """INSERT INTO engagement_snapshots
               (tweet_id, likes, retweets, replies, quotes, impressions, captured_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (tweet_id, likes, retweets, replies, quotes, impressions, _now_iso()),
        )


def latest_engagement_per_tweet() -> list[sqlite3.Row]:
    with cursor() as cur:
        cur.execute(
            """SELECT e.* FROM engagement_snapshots e
               WHERE e.id = (
                   SELECT id FROM engagement_snapshots e2
                   WHERE e2.tweet_id = e.tweet_id
                   ORDER BY e2.captured_at DESC LIMIT 1
               )"""
        )
        return cur.fetchall()


def tracked_tweet_ids(limit: int = 200) -> list[str]:
    with cursor() as cur:
        cur.execute(
            "SELECT tweet_id FROM posts WHERE tweet_id IS NOT NULL ORDER BY id DESC LIMIT ?",
            (limit,),
        )
        return [row["tweet_id"] for row in cur.fetchall()]


# ---- mentions ---------------------------------------------------------------


def has_processed_mention(tweet_id: str) -> bool:
    with cursor() as cur:
        cur.execute("SELECT 1 FROM processed_mentions WHERE tweet_id = ?", (tweet_id,))
        return cur.fetchone() is not None


def mark_mention_processed(tweet_id: str, author_username: str) -> None:
    with cursor() as cur:
        cur.execute(
            "INSERT OR IGNORE INTO processed_mentions (tweet_id, author_username, replied_at) "
            "VALUES (?, ?, ?)",
            (tweet_id, author_username, _now_iso()),
        )


def get_conversation_history(author_id: str) -> list[dict]:
    with cursor() as cur:
        cur.execute("SELECT history FROM conversation_memory WHERE author_id = ?", (author_id,))
        row = cur.fetchone()
        return json.loads(row["history"]) if row else []


def append_conversation_turn(author_id: str, role: str, text: str, max_turns: int = 6) -> None:
    history = get_conversation_history(author_id)
    history.append({"role": role, "text": text})
    history = history[-max_turns:]
    with cursor() as cur:
        cur.execute(
            """INSERT INTO conversation_memory (author_id, history, updated_at)
               VALUES (?, ?, ?)
               ON CONFLICT(author_id) DO UPDATE SET history = excluded.history,
                                                     updated_at = excluded.updated_at""",
            (author_id, json.dumps(history), _now_iso()),
        )


# ---- quote-tweet dedupe ------------------------------------------------------


def has_quoted(tweet_id: str) -> bool:
    with cursor() as cur:
        cur.execute("SELECT 1 FROM quoted_tweets WHERE tweet_id = ?", (tweet_id,))
        return cur.fetchone() is not None


def mark_quoted(tweet_id: str) -> None:
    with cursor() as cur:
        cur.execute(
            "INSERT OR IGNORE INTO quoted_tweets (tweet_id, quoted_at) VALUES (?, ?)",
            (tweet_id, _now_iso()),
        )


# ---- style notes / idea dedupe -----------------------------------------------


def get_style_notes() -> str:
    with cursor() as cur:
        cur.execute("SELECT notes FROM style_notes WHERE id = 1")
        row = cur.fetchone()
        return row["notes"] if row else ""


def set_style_notes(notes: str) -> None:
    with cursor() as cur:
        cur.execute(
            "UPDATE style_notes SET notes = ?, updated_at = ? WHERE id = 1",
            (notes, _now_iso()),
        )


def idea_already_used(fingerprint: str) -> bool:
    with cursor() as cur:
        cur.execute("SELECT 1 FROM ideas_used WHERE idea_fingerprint = ?", (fingerprint,))
        return cur.fetchone() is not None


def mark_idea_used(fingerprint: str) -> None:
    with cursor() as cur:
        cur.execute(
            "INSERT OR IGNORE INTO ideas_used (idea_fingerprint, created_at) VALUES (?, ?)",
            (fingerprint, _now_iso()),
        )
