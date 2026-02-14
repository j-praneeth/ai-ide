"""Shared API key store for external providers. Set by backend ai.set_api_key, read by planner."""

_store: dict = {}


def set_key(provider: str, key: str) -> None:
    if not provider:
        return
    p = provider.strip().lower()
    if key and key.strip():
        _store[p] = key.strip()
    elif p in _store:
        del _store[p]


def get_key(provider: str) -> str:
    return (_store.get(provider.strip().lower()) or "").strip()
