"""Graph state schema (a TypedDict in real LangGraph; plain class here)."""


class ChatState(dict):
    """message in, intent + reply out."""
