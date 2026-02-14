import logging
import traceback
import requests
import json as json_module
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

router = APIRouter()
logger = logging.getLogger(__name__)


def _emit_agent_event(event: dict):
    """Emit agent activity to connected mobile clients."""
    try:
        from mobile_bridge import emit_sync
        event_copy = {**event, "source": "desktop_agent"}
        emit_sync(event_copy)
    except Exception:
        pass

# In-memory conversation history: list of {"role": "user"|"assistant", "content": "..."}
CONVERSATION_HISTORY: list = []
MAX_HISTORY_MESSAGES = 50

OLLAMA_TAGS_URL = "http://localhost:11434/api/tags"

agent_available = False
try:
    from agent.orchestrator import run_agent
    from agent.tools import set_project_root
    from agent.planner import get_model as get_planner_model, set_model as set_planner_model
    agent_available = True
except ImportError as e:
    logger.warning("Agent module not available (%s). Chat will use fallback mode.", e)
except Exception as e:
    logger.warning("Agent initialization failed (%s). Chat will use fallback mode.", e)


@router.get("/model/current")
def get_current_model():
    """Return the current model name used by the planner."""
    if not agent_available:
        return {"model": None, "error": "Agent not available"}
    try:
        return {"model": get_planner_model()}
    except Exception as e:
        logger.exception("Error getting current model: %s", e)
        return {"model": None, "error": str(e)}


# Stored API key for external providers (OpenAI, Anthropic, etc.) — set via Settings "Connect"
_api_key_store: dict = {}


@router.post("/set-api-key")
async def set_api_key(request: Request):
    """Store API key for the given provider. Called when user clicks Connect in Settings."""
    global _api_key_store
    try:
        body = await request.json()
        if isinstance(body, dict):
            key = (body.get("api_key") or "").strip()
            provider = (body.get("provider") or "ollama").strip().lower()
            if key:
                _api_key_store[provider] = key
        return {"status": "ok", "message": "API key saved"}
    except Exception as e:
        logger.exception("set-api-key failed: %s", e)
        return {"status": "error", "message": str(e)}


@router.post("/model/set")
def set_current_model(model: str):
    """Set the model used by the planner. Query param: model=MODEL_NAME."""
    if not agent_available:
        return {"status": "error", "message": "Agent not available"}
    if not model or not model.strip():
        return {"status": "error", "message": "Model name is required"}
    try:
        set_planner_model(model.strip())
        return {"status": "ok", "model": get_planner_model()}
    except Exception as e:
        logger.exception("Error setting model: %s", e)
        return {"status": "error", "message": str(e)}


@router.get("/models")
def get_models():
    """Return list of available Ollama models."""
    try:
        r = requests.get(OLLAMA_TAGS_URL, timeout=5)
        r.raise_for_status()
        data = r.json()
        models = data.get("models", [])
        return {
            "models": [
                {"name": m.get("name"), "modified": m.get("modified")}
                for m in models
            ]
        }
    except requests.RequestException as e:
        logger.exception("Ollama /api/tags request failed: %s", e)
        return {"models": [], "error": str(e)}
    except Exception as e:
        logger.exception("Error fetching Ollama models: %s", e)
        return {"models": [], "error": str(e)}


@router.get("/chat/history")
def chat_history():
    """Return current conversation history (for desktop/mobile sync)."""
    return {"history": list(CONVERSATION_HISTORY)}


@router.post("/chat/clear")
def chat_clear():
    """Clear conversation history."""
    global CONVERSATION_HISTORY
    CONVERSATION_HISTORY = []
    return {"status": "cleared"}


@router.get("/chat/stream")
def chat_stream(prompt: str, mode: str = "agent"):
    """SSE streaming endpoint for real-time agent steps.
    
    Args:
        prompt: User's prompt/query
        mode: "agent" (can make changes) or "chat" (read-only, information only)
    """
    if not agent_available:
        def fallback():
            yield f"data: {json_module.dumps({'type': 'done', 'answer': 'AI agent not configured. Install Ollama and pull a model.'})}\n\n"
        return StreamingResponse(fallback(), media_type="text/event-stream")

    # Validate mode
    if mode not in ["agent", "chat"]:
        mode = "agent"

    import file_manager
    set_project_root(file_manager.PROJECT_ROOT)

    def event_stream():
        try:
            from agent.orchestrator import run_agent_stream
            CONVERSATION_HISTORY.append({"role": "user", "content": prompt})

            # Emit user message to mobile so chat stays in sync on both desktop and mobile
            _emit_agent_event({"type": "chat_message", "role": "user", "content": prompt})

            # Pass conversation history (excluding the just-added message) for context
            history_for_agent = list(CONVERSATION_HISTORY[:-1]) if len(CONVERSATION_HISTORY) > 1 else []

            final_answer = ""
            for event in run_agent_stream(prompt, conversation_history=history_for_agent, mode=mode):
                yield f"data: {json_module.dumps(event)}\n\n"
                _emit_agent_event(event)
                if event.get("type") == "done":
                    final_answer = event.get("answer", "")

            CONVERSATION_HISTORY.append({"role": "assistant", "content": final_answer})
            if len(CONVERSATION_HISTORY) > MAX_HISTORY_MESSAGES:
                CONVERSATION_HISTORY[:] = CONVERSATION_HISTORY[-MAX_HISTORY_MESSAGES:]
        except Exception as e:
            yield f"data: {json_module.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/command/approve")
def approve_command(command_id: str, approved: bool = True):
    """Approve or reject a pending command.
    
    Args:
        command_id: Unique ID for the pending command
        approved: True to approve and execute, False to reject
    """
    try:
        from agent.pending_commands import get_pending_command, remove_pending_command
        from agent.executor import execute
    except ImportError:
        return {"error": "Agent module not available"}
    
    pending = get_pending_command(command_id)
    if not pending:
        return {"error": "Command not found or already processed"}
    
    command = pending["command"]
    tool_input = pending["tool_input"].copy()  # Make a copy to avoid modifying original
    
    if not approved:
        remove_pending_command(command_id)
        return {"status": "rejected", "message": "Command was rejected by user"}
    
    # Execute the approved command
    try:
        tool_input["approved"] = True
        result = execute(pending["tool"], tool_input)
        remove_pending_command(command_id)
        
        if isinstance(result, dict):
            result_str = json_module.dumps(result, default=str)
        else:
            result_str = str(result)
        
        return {
            "status": "executed",
            "result": result_str,
            "command": command,
        }
    except Exception as e:
        remove_pending_command(command_id)
        logger.exception("Error executing approved command: %s", e)
        return {"status": "error", "error": str(e)}


@router.post("/chat")
def chat(prompt: str, mode: str = "agent"):
    """Chat endpoint for AI assistant.
    
    Args:
        prompt: User's prompt/query
        mode: "agent" (can make changes) or "chat" (read-only, information only)
    """
    # Validate mode
    if mode not in ["agent", "chat"]:
        mode = "agent"
    
    if agent_available:
        try:
            # Sync agent's project root with the file manager's current project root
            import file_manager
            set_project_root(file_manager.PROJECT_ROOT)

            CONVERSATION_HISTORY.append({"role": "user", "content": prompt})
            history_for_agent = list(CONVERSATION_HISTORY[:-1]) if len(CONVERSATION_HISTORY) > 1 else []
            response = run_agent(prompt, conversation_history=history_for_agent, mode=mode)
            CONVERSATION_HISTORY.append({"role": "assistant", "content": response})
            # Trim to last N messages
            if len(CONVERSATION_HISTORY) > MAX_HISTORY_MESSAGES:
                CONVERSATION_HISTORY[:] = CONVERSATION_HISTORY[-MAX_HISTORY_MESSAGES:]
            return {"response": response, "history": list(CONVERSATION_HISTORY)}
        except Exception as e:
            traceback.print_exc()
            logger.exception("Agent error: %s", e)
            return {"response": f"Agent error: {str(e)}. The AI backend may need configuration.", "history": list(CONVERSATION_HISTORY)}
    else:
        return {
            "response": (
                "The AI agent is not configured yet. To enable AI features:\n\n"
                "1. Install Ollama: https://ollama.ai\n"
                "2. Pull a model: `ollama pull qwen2.5-coder:7b`\n"
                "3. Install Python dependencies: `pip install sentence-transformers faiss-cpu`\n"
                "4. Restart the backend server\n\n"
                "The IDE editor, file explorer, terminal, and all other features work without AI."
            ),
            "history": list(CONVERSATION_HISTORY),
        }
