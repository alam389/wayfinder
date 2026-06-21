"""A LangGraph StateGraph compiled with a SQL-Server (MSSQL) checkpointer.

Static fixture only: langgraph need not be installed. Proves node/edge/
conditional-edge/entry-point/checkpointer extraction for Phase 5.
"""
from langgraph.graph import START, StateGraph
from langgraph.checkpoint.mssql import MSSQLSaver

from state import ChatState


def classify(state):
    return {"intent": "faq"}


def answer(state):
    return {"reply": "..."}


def escalate(state):
    return {"reply": "handing off"}


def route_intent(state):
    return "answer" if state["intent"] == "faq" else "escalate"


builder = StateGraph(ChatState)
builder.add_node("classify", classify)
builder.add_node("answer", answer)
builder.add_node("escalate", escalate)

builder.add_edge(START, "classify")
builder.add_conditional_edges(
    "classify",
    route_intent,
    {"answer": "answer", "escalate": "escalate"},
)
builder.set_entry_point("classify")

checkpointer = MSSQLSaver.from_conn_string("mssql+pyodbc://sqlserver/agent")
chat_graph = builder.compile(checkpointer=checkpointer)
