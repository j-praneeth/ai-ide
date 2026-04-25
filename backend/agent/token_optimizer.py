import os
import re
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple


def estimate_tokens(text: str) -> int:
    """
    Cheap token estimate (provider-agnostic).
    - Works reasonably well for budgeting/truncation.
    - Intentionally does NOT require external tokenizers.
    """
    if not text:
        return 0
    # Heuristic: ~4 chars/token, with a small boost for lots of punctuation/whitespace.
    base = max(1, int(len(text) / 4))
    extra = int(len(re.findall(r"[^\w\s]", text)) / 40)
    return base + extra


def _collapse_blank_lines(text: str, max_blank_runs: int = 2) -> str:
    if not text:
        return ""
    # Replace 3+ consecutive newlines with 2 newlines by default.
    return re.sub(r"\n{" + str(max_blank_runs + 1) + r",}", "\n" * max_blank_runs, text)


def normalize_text(text: str) -> str:
    if not text:
        return ""
    # Trim trailing spaces on each line; keep newlines stable.
    text = "\n".join([line.rstrip() for line in text.splitlines()])
    return _collapse_blank_lines(text, max_blank_runs=2).strip()


def truncate_middle(text: str, max_chars: int, marker: str = "\n…(truncated)…\n") -> str:
    if not text or max_chars <= 0:
        return ""
    if len(text) <= max_chars:
        return text
    if max_chars < len(marker) + 20:
        return text[:max_chars]
    head = int((max_chars - len(marker)) * 0.6)
    tail = max_chars - len(marker) - head
    return text[:head] + marker + text[-tail:]


def compress_file_tree(tree: str, max_lines: int = 120) -> str:
    if not tree:
        return ""
    lines = tree.splitlines()
    if len(lines) <= max_lines:
        return tree
    kept = lines[:max_lines]
    kept.append(f"... (truncated file tree: showing {max_lines} of {len(lines)} lines)")
    return "\n".join(kept)


def compress_context_steps(context: str, keep_last_steps: int = 8, max_chars: int = 12000) -> Tuple[str, Dict[str, int]]:
    """
    Compresses orchestrator context (tool transcripts) to avoid runaway growth.
    Keeps the last N step blocks verbatim-ish, summarizes older blocks.
    """
    if not context:
        return "", {"dropped_steps": 0, "summarized_steps": 0}

    context = normalize_text(context)

    # Split by step markers produced by orchestrator: "[Step N] ..."
    parts = re.split(r"(?=\[Step\s+\d+\])", context)
    parts = [p for p in parts if p.strip()]
    if len(parts) <= keep_last_steps and len(context) <= max_chars:
        return context, {"dropped_steps": 0, "summarized_steps": 0}

    older = parts[:-keep_last_steps] if keep_last_steps > 0 else parts
    recent = parts[-keep_last_steps:] if keep_last_steps > 0 else []

    summaries: List[str] = []
    for block in older:
        # Extract a compact summary: step number + tool + any obvious path/command.
        step_m = re.search(r"\[Step\s+(\d+)\]", block)
        tool_m = re.search(r"Tool:\s*([a-zA-Z_]+)", block)
        path_m = re.search(r"\"path\"\\s*:\\s*\"([^\"]{1,160})\"", block)
        query_m = re.search(r"\"query\"\\s*:\\s*\"([^\"]{1,160})\"", block)
        cmd_m = re.search(r"\"command\"\\s*:\\s*\"([^\"]{1,160})\"", block)

        step_no = step_m.group(1) if step_m else "?"
        tool = tool_m.group(1) if tool_m else "tool"
        detail = ""
        if path_m:
            detail = f"path={path_m.group(1)}"
        elif cmd_m:
            detail = f"command={cmd_m.group(1)}"
        elif query_m:
            detail = f"query={query_m.group(1)}"
        summaries.append(f"[Step {step_no}] {tool} ({detail})".rstrip())

    compressed = "\n".join(
        [
            "[Context summary]",
            *summaries,
            "",
            "[Recent context]",
            *[truncate_middle(b, max_chars=2400) for b in recent],
        ]
    ).strip()

    if len(compressed) > max_chars:
        compressed = truncate_middle(compressed, max_chars=max_chars)

    return compressed, {"dropped_steps": 0, "summarized_steps": len(older)}


def truncate_history_messages(
    conversation_history: Optional[List[Dict]],
    max_messages: int = 16,
    max_chars_user: int = 800,
    max_chars_assistant: int = 600,
) -> Tuple[List[Dict], Dict[str, int]]:
    if not conversation_history:
        return [], {"trimmed_messages": 0, "truncated_messages": 0}

    trimmed_messages = 0
    truncated_messages = 0

    recent = conversation_history[-max_messages:] if max_messages > 0 else []
    trimmed_messages = max(0, len(conversation_history) - len(recent))

    out: List[Dict] = []
    for msg in recent:
        role = msg.get("role") or "user"
        content = msg.get("content") or ""
        limit = max_chars_user if role == "user" else max_chars_assistant
        if len(content) > limit:
            content = content[:limit] + "…"
            truncated_messages += 1
        out.append({"role": role, "content": content})

    return out, {"trimmed_messages": trimmed_messages, "truncated_messages": truncated_messages}


@dataclass
class TokenOptimizationReport:
    estimated_input_tokens_before: int
    estimated_input_tokens_after: int
    estimated_tokens_saved: int
    context_summarized_steps: int = 0
    history_trimmed_messages: int = 0
    history_truncated_messages: int = 0


def build_token_report(
    messages_before: List[Dict],
    messages_after: List[Dict],
    context_meta: Optional[Dict[str, int]] = None,
    history_meta: Optional[Dict[str, int]] = None,
) -> TokenOptimizationReport:
    before_tokens = sum(estimate_tokens(m.get("content", "")) for m in (messages_before or []))
    after_tokens = sum(estimate_tokens(m.get("content", "")) for m in (messages_after or []))
    saved = max(0, before_tokens - after_tokens)
    return TokenOptimizationReport(
        estimated_input_tokens_before=before_tokens,
        estimated_input_tokens_after=after_tokens,
        estimated_tokens_saved=saved,
        context_summarized_steps=int((context_meta or {}).get("summarized_steps") or 0),
        history_trimmed_messages=int((history_meta or {}).get("trimmed_messages") or 0),
        history_truncated_messages=int((history_meta or {}).get("truncated_messages") or 0),
    )


def get_planner_max_tokens() -> int:
    try:
        return max(256, int(os.environ.get("NEBULA_PLANNER_MAX_TOKENS", "4096")))
    except Exception:
        return 4096

