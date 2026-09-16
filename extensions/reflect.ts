import { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentMessage } from "@earendil-works/pi-agent-core";
import { AgentsMemoConfig, PROJECT_MEMORY_DEFAULTS } from "./config";
import { Reflection } from "./core-management";
import { Model, Api, TextContent, Context } from "@earendil-works/pi-ai";
import {
  builtinModels,
  BuiltinProvider,
  getBuiltinModel,
} from "@earendil-works/pi-ai/providers/all";
import { withTimeout } from "./helpers";

const REFLECTION_MODEL_TIMEOUT_MS = 60_000;
const REFLECTION_MAX_TOKENS = 2000;

type RequestAuth =
  | { ok: true; apiKey?: string; headers?: Record<string, string> }
  | { ok: false; error: string };

// ─── Reflection engine ────────────────────────────────────────────────────────
// Per-project memory (docs/per-project-memory.md): on agent_end, distill the
// last messages into a mistake/fix reflection via an in-process complete()
// call and file it under wiki/projects/<slug>/ (daily + core.md). The call is
// bounded by withTimeout so a slow/hung model can never block the session
// (the previous spawned-pi-subprocess design froze the session for up to 60s
// and could hang forever when the provider child survived SIGTERM while
// holding the stdout pipe).

// Exported for the smoke test (pi only invokes the default export).
export function buildReflectionSystemPrompt(maxItems: number): string {
  return [
    "You are a coding session mistake-prevention reflection engine.",
    "Focus on what went wrong and how it was fixed.",
    'Return STRICT JSON only: {"mistakes":["..."],"fixes":["..."],"global":["..."]}',
    `- Keep each array short (max ${maxItems}).`,
    "- Prefer specific, actionable, prevention-oriented points.",
    "- Rewrite project-specific details into generic rules.",
    '- Put anything reusable across projects in "global": design patterns, non-trivial bug fixes, architecture decisions.',
    "- Write global items generically - no project names, paths, or other project-specific identifiers.",
    "",
    "Examples of good reflections:",
    '  {"mistakes":["Deleted import that was still used elsewhere, causing a build error"],',
    '   "fixes":["Use IDE find-references before deleting any export"],',
    '   "global":["Always run the full test suite after refactoring shared modules"]}',
    "",
    '  {"mistakes":["Changed a function signature without updating callers"],',
    '   "fixes":["Use TypeScript strict mode to catch signature mismatches at compile time"],',
    '   "global":["When changing a public API, grep the entire codebase for usages first"]}',
    "",
    "Self-check before responding:",
    "- Are all entries concrete and actionable (not vague like 'be more careful')?",
    "- Is each mistake paired with a corresponding prevention-oriented fix?",
    "- Are global items truly reusable across projects (no project-specific names)?",
  ].join("\n");
}

// Exported for the smoke test (pi only invokes the default export).
export function parseReflectionJson(text: string): Reflection | null {
  const parse = (candidate: string): Reflection | null => {
    try {
      const parsed = JSON.parse(candidate) as {
        mistakes?: unknown;
        fixes?: unknown;
        global?: unknown;
      };
      const mistakes = Array.isArray(parsed.mistakes)
        ? parsed.mistakes.filter((m): m is string => typeof m === "string")
        : [];
      const fixes = Array.isArray(parsed.fixes)
        ? parsed.fixes.filter((m): m is string => typeof m === "string")
        : [];
      const global = Array.isArray(parsed.global)
        ? parsed.global.filter((m): m is string => typeof m === "string")
        : [];
      // Valid when any bucket is non-empty: a global-only reflection (pure
      // reusable learnings, nothing went wrong) is a legitimate outcome.
      if (mistakes.length === 0 && fixes.length === 0 && global.length === 0) return null;
      return { mistakes, fixes, global };
    } catch {
      return null;
    }
  };
  const trimmed = text.trim();
  // Strip markdown fences if the model wrapped the JSON.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    const parsed = parse(fenced[1].trim());
    if (parsed) return parsed;
  }
  // Bare {...} block in otherwise-prose output.
  const bare = trimmed.match(/\{[\s\S]*\}/);
  return bare ? parse(bare[0]) : parse(trimmed);
}

// Resolve the reflection model + request auth: configured reflectModel first
// (via the session's model registry, with a getModel fallback), then the
// session's current model. No hardcoded defaults - must be explicitly configured.
// Best-effort — null skips the reflection silently.
async function pickReflectionModel(
  config: AgentsMemoConfig,
  ctx: ExtensionContext,
): Promise<{
  model: Model<Api>;
  apiKey?: string;
  headers?: Record<string, string>;
} | null> {
  // No hardcoded defaults - if no reflectModel is configured, skip reflection entirely
  if (!config.reflectModel && !config.fallbackToDefaultModel) return null;
  const registry = (ctx.modelRegistry ?? {}) as unknown as {
    find?: (provider: string, id: string) => Model<Api> | undefined;
    getApiKeyAndHeaders?: (model: Model<Api>) => Promise<RequestAuth>;
  };
  const findModel = <T extends BuiltinProvider>(
    provider: T,
    id: string,
  ): Model<Api> | undefined => {
    let model = registry.find?.(provider, id);
    if (!model) model = getBuiltinModel(provider, id as never);
    return model;
  };
  const candidates: Array<Model<Api>> = [];
  if (config.reflectModel) {
    const configured = findModel(config.reflectModel.provider, config.reflectModel.id);
    if (configured) candidates.push(configured);
  }
  // The session's current model is only a fallback when explicitly enabled:
  // a configured reflectModel whose auth fails must not silently switch models
  // unless fallbackToDefaultModel is on.
  if (config.fallbackToDefaultModel && ctx.model) candidates.push(ctx.model);
  const usable = candidates.filter(
    (m): m is Model<Api> =>
      !!m &&
      typeof (m as { provider?: unknown }).provider === "string" &&
      typeof (m as { id?: unknown }).id === "string",
  );
  for (const model of usable) {
    try {
      const auth = await registry.getApiKeyAndHeaders?.(model);
      if (auth?.ok === true) return { model, apiKey: auth.apiKey, headers: auth.headers };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// Distill the run into a reflection via an in-process complete() call wrapped
// in withTimeout — asynchronous and strictly bounded, so a slow or hung model
// can never freeze the session (the pre-fix spawned subprocess froze the
// event loop for up to 60s and could hang indefinitely). Best-effort: any
// failure yields null and the caller silently skips.
export async function runReflection(
  config: AgentsMemoConfig,
  ctx: ExtensionContext,
  messages: AgentMessage[],
): Promise<Reflection | null> {
  try {
    const picked = await pickReflectionModel(config, ctx);
    if (!picked) return null;

    const maxItems =
      config.projectMemory?.maxLearningsPerReflection ??
      PROJECT_MEMORY_DEFAULTS.maxLearningsPerReflection;

    const conversation = serializeMessages(messages);
    const prompt = `${buildReflectionSystemPrompt(maxItems)}\n\n<conversation>\n${conversation}\n</conversation>`;

    const controller = new AbortController();

    // Build a standard LLM context
    const context: Context = {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: prompt }],
          timestamp: Date.now(),
        },
      ],
    };
    const models = ctx.modelRegistry ?? builtinModels();
    const response = await withTimeout(
      models.complete(picked.model, context, {
        apiKey: picked.apiKey,
        headers: picked.headers,
        maxTokens: REFLECTION_MAX_TOKENS,
        signal: controller.signal,
      }),
      REFLECTION_MODEL_TIMEOUT_MS,
      "reflection model call",
      controller,
    );

    ctx.ui.notify(JSON.stringify({ response }, null, 2));

    // Response extraction stays the same (response still has a content array)
    const allText = response.content
      .filter(
        (part): part is TextContent | { type: "thinking"; thinking: string } =>
          part.type === "text" || part.type === "thinking",
      )
      .map((part) => {
        if (part.type === "text") return part.text ?? "";
        if (part.type === "thinking") return part.thinking ?? "";
        return "";
      })
      .join("\n")
      .trim();

    return allText ? parseReflectionJson(allText) : null;
  } catch (e) {
    ctx.ui.notify(String(e));
    return null;
  }
}

// Compact text transcript of the last messages, bounded per part and overall
// (keep the tail - the reflection focuses on what just happened).
function serializeMessages(messages: AgentMessage[]): string {
  const MAX_PART = 500;
  const MAX_TOTAL = 8000;
  const lines: string[] = [];
  for (const msg of messages) {
    let text = "";
    if ("content" in msg && typeof msg.content === "string") {
      text = msg.content;
    } else if ("content" in msg && Array.isArray(msg.content)) {
      text = (
        msg.content as Array<{ type?: string; text?: string; name?: string; arguments?: unknown }>
      )
        .map((part) => {
          if (part?.type === "text") return part.text ?? "";
          if (part?.type === "toolCall")
            return `[tool_call ${part.name}] ${JSON.stringify(part.arguments)}`;
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    text = text.trim();
    if (!text) continue;
    const truncated = text.length > MAX_PART ? text.slice(0, MAX_PART) + "…" : text;
    if (msg.role === "toolResult") lines.push(`[tool ${msg.toolName ?? "?"}] ${truncated}`);
    else lines.push(`${msg.role === "assistant" ? "Assistant" : "User"}: ${truncated}`);
  }
  const joined = lines.join("\n");
  return joined.length > MAX_TOTAL ? joined.slice(-MAX_TOTAL) : joined;
}
