---
name: claude-api
description: Build, debug, and optimize Claude API / Anthropic SDK applications. Triggers when code imports anthropic/@anthropic-ai/sdk, or user asks about Claude models, tool use, streaming, thinking, prompt caching, or Managed Agents.
---

DEFAULTS:
- Model: `claude-opus-4-7` unless specified
- Thinking: `{type: "adaptive"}` for complex reasoning tasks
- Streaming: enabled by default for high-token requests
- Always use official SDKs — never raw HTTP unless explicitly asked

CURRENT MODELS:
| Model | ID | Context | Input $/1M | Output $/1M |
|---|---|---|---|---|
| Opus 4.7 | `claude-opus-4-7` | 1M | $5 | $25 |
| Opus 4.6 | `claude-opus-4-6` | 1M | $5 | $25 |
| Sonnet 4.6 | `claude-sonnet-4-6` | 1M | $3 | $15 |
| Haiku 4.5 | `claude-haiku-4-5` | 200K | $1 | $5 |

SURFACE SELECTION:
- Single call (classify, extract, Q&A) → Claude API
- Multi-step workflow → Claude API + tool use
- Agent with custom tools → Claude API + tool use
- Server-managed stateful agent → Managed Agents

PYTHON SDK:
```python
import anthropic
client = anthropic.Anthropic()
response = client.messages.create(
    model="claude-opus-4-7",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}]
)
```

JS/TS SDK:
```typescript
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic();
const msg = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello" }],
});
```

SKIP THIS SKILL: code using `openai` or other provider SDKs, provider-neutral code.
