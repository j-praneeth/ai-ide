import difflib

def generate_diff(old_content, new_content, path):
    old_lines = old_content.splitlines(keepends=True)
    new_lines = new_content.splitlines(keepends=True)

    diff = difflib.unified_diff(
        old_lines,
        new_lines,
        fromfile=f"{path} (original)",
        tofile=f"{path} (modified)"
    )

    return "".join(diff)