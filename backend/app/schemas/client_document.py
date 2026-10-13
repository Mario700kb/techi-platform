from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

DocumentCategory = Literal["general", "network", "procedures", "contacts", "hardware", "software"]

# A documentation page, not a file store: generous for text, small for the database.
MAX_BODY_CHARS = 100_000


class ClientDocumentCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    category: DocumentCategory = "general"
    body: str = Field(default="", max_length=MAX_BODY_CHARS)
    pinned: bool = False


class ClientDocumentUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    category: Optional[DocumentCategory] = None
    body: Optional[str] = Field(default=None, max_length=MAX_BODY_CHARS)
    pinned: Optional[bool] = None


class ClientDocumentSummary(BaseModel):
    """A list row: everything but the body, plus its opening words."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    client_id: int
    title: str
    category: str
    pinned: bool
    excerpt: str = ""
    created_by: Optional[str] = None
    updated_by: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class ClientDocumentOut(ClientDocumentSummary):
    body: str
