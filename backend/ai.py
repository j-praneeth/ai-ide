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


def _sync_api_key_to_agent(provider: str, key: str) -> None:
    """Sync stored key to agent module so planner can use it for chat."""
    try:
        from agent.api_keys import set_key
        set_key(provider, key)
    except Exception:
        pass


def store_api_key(provider: str, key: str) -> None:
    """Store API key for a provider (used by route and by main.py explicit route)."""
    global _api_key_store
    provider = (provider or "ollama").strip().lower()
    key = (key or "").strip()
    if key:
        _api_key_store[provider] = key
    else:
        _api_key_store.pop(provider, None)
    _sync_api_key_to_agent(provider, key)


@router.post("/set-api-key")
async def set_api_key(request: Request):
    """Store API key for the given provider. Called when user clicks Connect in Settings."""
    try:
        body = await request.json()
        if isinstance(body, dict):
            store_api_key(
                body.get("provider") or "ollama",
                body.get("api_key") or "",
            )
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


# Kimi (NVIDIA) model id — key from env only, never exposed to frontend
KIMI_MODEL_ID = "moonshotai/kimi-k2.5"


@router.get("/models")
def get_models():
    """Return list of available models: Ollama models plus Kimi K2.5 (NVIDIA)."""
    models = []
    try:
        r = requests.get(OLLAMA_TAGS_URL, timeout=5)
        r.raise_for_status()
        data = r.json()
        for m in data.get("models", []):
            models.append({"name": m.get("name"), "modified": m.get("modified")})
    except requests.RequestException as e:
        logger.exception("Ollama /api/tags request failed: %s", e)
    except Exception as e:
        logger.exception("Error fetching Ollama models: %s", e)
    # Add Kimi K2.5 (API key from server env only)
    models.append({"name": KIMI_MODEL_ID, "modified": None, "provider": "kimi"})
    return {"models": models}


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


def _is_simple_greeting(prompt: str) -> bool:
    """True if the prompt is just a greeting/small talk (no codebase search or tools needed)."""
    if not prompt or not isinstance(prompt, str):
        return False
    text = prompt.strip()
    # If there's context (e.g. [Current file: ...]), use only the last part after double newline
    if "\n\n" in text:
        parts = text.split("\n\n")
        text = parts[-1].strip() if parts else text
    text_lower = text.lower()
    if len(text_lower) > 80:
        return False
    greetings = (
        "hello", "hi", "hey", "howdy", "hi there", "hello there",
        "good morning", "good afternoon", "good evening", "gm", "greetings",
        "what's up", "whats up", "sup", "yo ", "yo\n",
    )
    return text_lower in greetings or any(text_lower.rstrip(".!?") == g for g in greetings)


@router.get("/chat/stream")
def chat_stream(prompt: str, mode: str = "agent", model: str = None):
    """SSE streaming endpoint for real-time agent steps.
    
    Args:
        prompt: User's prompt/query
        mode: "agent" (can make changes) or "chat" (read-only, information only)
        model: Optional model id (e.g. moonshotai/kimi-k2.5). If provided, use it for this request.
    """
    if not agent_available:
        def fallback():
            yield f"data: {json_module.dumps({'type': 'done', 'answer': 'AI agent not configured. Install Ollama and pull a model.'})}\n\n"
        return StreamingResponse(fallback(), media_type="text/event-stream")

    # Validate mode
    if mode not in ["agent", "chat"]:
        mode = "agent"

    # Use model from request so frontend always controls which model (Kimi/OpenAI/Ollama) is used
    if model and isinstance(model, str) and model.strip():
        try:
            set_planner_model(model.strip())
        except Exception as e:
            logger.exception("Error setting model for request: %s", e)

    import file_manager
    set_project_root(file_manager.PROJECT_ROOT)

    def event_stream():
        try:
            from agent.orchestrator import run_agent_stream
            CONVERSATION_HISTORY.append({"role": "user", "content": prompt})

            # Emit user message to mobile so chat stays in sync on both desktop and mobile
            _emit_agent_event({"type": "chat_message", "role": "user", "content": prompt})

            # Simple greetings get a direct reply (no codebase search, no tools)
            if _is_simple_greeting(prompt):
                try:
                    from agent.planner import simple_chat
                    reply = simple_chat(prompt)
                    event = {"type": "done", "answer": reply or "Hello! How can I help you today?"}
                    yield f"data: {json_module.dumps(event)}\n\n"
                    _emit_agent_event(event)
                    CONVERSATION_HISTORY.append({"role": "assistant", "content": event["answer"]})
                    if len(CONVERSATION_HISTORY) > MAX_HISTORY_MESSAGES:
                        CONVERSATION_HISTORY[:] = CONVERSATION_HISTORY[-MAX_HISTORY_MESSAGES:]
                except Exception as e:
                    yield f"data: {json_module.dumps({'type': 'done', 'answer': f'Hello! (Model error: {e})'})}\n\n"
                return

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
