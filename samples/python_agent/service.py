"""Service layer the handlers resolve into (high-confidence call steps)."""


def persist_user(name):
    db.add(name)        # db write -> tagged by the tracer
    db.commit()
    return {"name": name}
