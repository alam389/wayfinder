"""Flask entry: a /chat route that invokes the compiled LangGraph, a plain
health route, and a users Blueprint mounted under /api (prefix composition)."""
from flask import Flask, request

from graph import chat_graph
from routes import bp

app = Flask(__name__)
app.register_blueprint(bp, url_prefix="/api")


@app.route("/chat", methods=["POST"])
def chat():
    data = request.get_json()
    result = chat_graph.ainvoke({"message": data["message"]})   # triggers_graph
    return result


@app.route("/health")
def health():
    return {"status": "ok"}
