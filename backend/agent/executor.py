from .tools import TOOLS


def execute(action, input_data):
    if action not in TOOLS:
        return f"Unknown tool: {action}. Available tools: {', '.join(TOOLS.keys())}"
    try:
        return TOOLS[action](input_data or {})
    except Exception as e:
        return f"Tool '{action}' error: {str(e)}"
