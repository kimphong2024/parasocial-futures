// Anthropic client — forced-tool-use helper for structured extraction, plus
// raw client access for streaming chat. Gated on ANTHROPIC_API_KEY.
import Anthropic from "@anthropic-ai/sdk";

export const MODEL = process.env.LLM_MODEL || "claude-opus-4-8";
// Adaptive thinking only on models that support it.
const THINK = /opus-4-[678]|sonnet-4-6|fable-5|opus-5|sonnet-5/.test(MODEL) ? { type: "adaptive" } : undefined;

export const llmEnabled = () => !!process.env.ANTHROPIC_API_KEY;
export const client = llmEnabled() ? new Anthropic() : null;

// Force Claude to answer via a single tool call with a strict input schema.
// Returns the validated-by-API tool input object, or throws.
export async function askTool({ system, prompt, toolName, schema, maxTokens = 8000, effort = "medium" }) {
  if (!client) throw new Error("ANTHROPIC_API_KEY unset");
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    ...(THINK ? { thinking: THINK, output_config: { effort } } : {}),
    system,
    messages: [{ role: "user", content: prompt }],
    tools: [{ name: toolName, description: `Return the ${toolName} result.`, input_schema: schema }],
    tool_choice: { type: "tool", name: toolName },
  });
  const use = msg.content.find((b) => b.type === "tool_use");
  if (!use) throw new Error("no tool_use block in response");
  return use.input;
}
