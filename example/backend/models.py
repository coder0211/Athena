"""Request/response schemas for the chat backend."""

from __future__ import annotations

from pydantic import BaseModel


class ConversationCreate(BaseModel):
    title: str = "New chat"
    mode: str = "business"  # 'business' | 'technical'
    lang: str = "en"  # 'en' | 'vi'


class ConversationRename(BaseModel):
    title: str


class AskStreamRequest(BaseModel):
    """A chat turn. If `conversation_id` is omitted a new conversation is created
    and its id is returned in the first SSE `conversation` frame. Prior history is
    loaded from the store server-side, so the client need not resend it."""

    question: str
    conversation_id: str | None = None
    scope: dict = {}  # {repos: [...], symbols: [...]}
    mode: str = "business"
    lang: str = "en"
    regenerate: bool = False  # replace the last answer instead of adding a new turn
    edit: bool = False  # with regenerate: also rewrite the last user turn to `question`
