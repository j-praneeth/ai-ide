import os

# Optional: FAISS + sentence_transformers for semantic search
INDEX = None
FILE_CHUNKS = []
_USE_SEMANTIC = False
_model = None


def _init_semantic():
    global _USE_SEMANTIC, _model
    if _USE_SEMANTIC and _model is not None:
        return True
    try:
        import faiss  # noqa: F401
        import numpy as np  # noqa: F401
        from sentence_transformers import SentenceTransformer
        _model = SentenceTransformer("all-MiniLM-L6-v2")
        _USE_SEMANTIC = True
        return True
    except Exception:
        _USE_SEMANTIC = False
        _model = None
        return False


def chunk_text(text, size=500):
    return [text[i : i + size] for i in range(0, len(text), size)]


def index_codebase(root="."):
    global INDEX, FILE_CHUNKS
    if not _init_semantic():
        FILE_CHUNKS = []
        INDEX = None
        return

    import faiss
    import numpy as np

    FILE_CHUNKS = []
    embeddings = []

    for root_dir, _, files in os.walk(root):
        for file in files:
            if file.endswith((".py", ".js", ".ts", ".java")):
                path = os.path.join(root_dir, file)
                try:
                    with open(path, "r", encoding="utf-8", errors="ignore") as f:
                        content = f.read()
                        chunks = chunk_text(content)
                        for chunk in chunks:
                            FILE_CHUNKS.append((path, chunk))
                            embeddings.append(_model.encode(chunk))
                except Exception:
                    continue

    if not embeddings:
        INDEX = None
        return
    embeddings = np.array(embeddings).astype("float32")
    INDEX = faiss.IndexFlatL2(embeddings.shape[1])
    INDEX.add(embeddings)


def _keyword_search_codebase(query, k=5, root=None):
    """Fallback: basic keyword search. Returns list of (path, chunk) like semantic search."""
    words = [w.lower() for w in query.split() if len(w) > 1]
    if not words:
        return []
    search_root = root or "."
    results = []
    for root_dir, _, files in os.walk(search_root):
        for file in files:
            if file.endswith((".py", ".js", ".ts", ".java", ".tsx", ".jsx", ".json", ".css", ".html", ".md")):
                path = os.path.join(root_dir, file)
                try:
                    with open(path, "r", encoding="utf-8", errors="ignore") as f:
                        content = f.read()
                        chunks = chunk_text(content)
                        for chunk in chunks:
                            c_lower = chunk.lower()
                            score = sum(1 for w in words if w in c_lower)
                            if score > 0:
                                results.append((score, path, chunk))
                except Exception:
                    continue
    results.sort(key=lambda x: -x[0])
    return [(path, chunk) for _, path, chunk in results[:k]]


def search_codebase(query, k=5, root=None):
    global INDEX, FILE_CHUNKS

    if _init_semantic() and INDEX is not None and FILE_CHUNKS:
        import numpy as np
        query_vector = _model.encode(query).astype("float32")
        D, I = INDEX.search(np.array([query_vector]), min(k, len(FILE_CHUNKS)))
        return [FILE_CHUNKS[idx] for idx in I[0]]
    return _keyword_search_codebase(query, k=k, root=root)
