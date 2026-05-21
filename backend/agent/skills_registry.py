import re
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple


@dataclass(frozen=True)
class Skill:
    id: str
    title: str
    applies: str  # "always" | "auto"
    keywords: Tuple[str, ...]
    description: str
    content: str


def _skills_path() -> Path:
    here = Path(__file__).resolve()
    # Dev:       <repo>/backend/agent/skills_registry.py  → 3 levels up = repo root
    # Packaged:  resources/backend-src/agent/             → 3 levels up = resources/
    # Both layouts put Skills.md three levels above this file.
    candidate = here.parent.parent.parent / "Skills.md"
    if candidate.exists():
        return candidate
    # PyInstaller frozen: sys._MEIPASS / Skills.md
    import sys
    if getattr(sys, "frozen", False):
        frozen_path = Path(sys._MEIPASS) / "Skills.md"
        if frozen_path.exists():
            return frozen_path
    return candidate  # return anyway; caller checks existence


def _parse_skill_block(title: str, meta: Dict[str, str], content_lines: List[str]) -> Skill:
    skill_id = (meta.get("id") or title).strip()
    applies = (meta.get("applies") or "auto").strip().lower()
    keywords_raw = (meta.get("keywords") or "").strip()
    keywords = tuple(k.strip().lower() for k in keywords_raw.split(",") if k.strip())
    description = (meta.get("description") or "").strip()
    content = "\n".join(content_lines).strip()
    return Skill(
        id=skill_id,
        title=title.strip(),
        applies="always" if applies == "always" else "auto",
        keywords=keywords,
        description=description,
        content=content,
    )


_skills_cache: List["Skill"] = []
_skills_mtime: float = -1.0


def load_skills() -> List["Skill"]:
    global _skills_cache, _skills_mtime
    path = _skills_path()
    if not path.exists():
        return []
    try:
        mtime = path.stat().st_mtime
        if mtime == _skills_mtime:
            return _skills_cache
    except OSError:
        pass

    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    skills: List[Skill] = []

    current_title: Optional[str] = None
    current_meta: Dict[str, str] = {}
    current_content: List[str] = []

    def flush():
        nonlocal current_title, current_meta, current_content
        if current_title:
            skills.append(_parse_skill_block(current_title, current_meta, current_content))
        current_title = None
        current_meta = {}
        current_content = []

    for line in lines:
        m = re.match(r"^##\s+Skill:\s+(.+?)\s*$", line)
        if m:
            flush()
            current_title = m.group(1)
            continue
        if current_title:
            meta_m = re.match(r"^\-\s*([a-zA-Z_]+)\s*:\s*(.+?)\s*$", line)
            if meta_m and not current_content:
                key = meta_m.group(1).strip().lower()
                val = meta_m.group(2).strip()
                current_meta[key] = val
                continue
            current_content.append(line)

    flush()
    try:
        _skills_mtime = path.stat().st_mtime
    except OSError:
        pass
    _skills_cache = skills
    return skills


def get_all_skills() -> List[Skill]:
    return list(load_skills())


def select_skills(user_prompt: str, mode: str = "agent") -> List[Skill]:
    prompt = (user_prompt or "").lower()
    skills = get_all_skills()
    if not skills:
        return []

    selected: List[Skill] = []
    for s in skills:
        if s.applies == "always":
            selected.append(s)

    for s in skills:
        if s.applies != "auto" or not s.keywords:
            continue
        if any(k in prompt for k in s.keywords):
            selected.append(s)

    # Chat mode: keep it compact.
    if mode == "chat":
        always = [s for s in selected if s.applies == "always"]
        auto = [s for s in selected if s.applies == "auto"][:2]
        selected = [*always, *auto]

    # Deduplicate while preserving order.
    seen = set()
    out: List[Skill] = []
    for s in selected:
        if s.id in seen:
            continue
        seen.add(s.id)
        out.append(s)
    return out


def render_skills_prompt(skills: List[Skill]) -> str:
    if not skills:
        return ""
    parts: List[str] = ["[Skills]"]
    for s in skills:
        parts.append(f"\n### {s.title} ({s.id})")
        if s.content:
            parts.append(s.content.strip())
    return "\n".join(parts).strip()

