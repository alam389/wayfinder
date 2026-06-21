"""Pydantic request models for the Flask handlers."""
from pydantic import BaseModel


class ChatRequest(BaseModel):
    message: str


class UserRequest(BaseModel):
    name: str
