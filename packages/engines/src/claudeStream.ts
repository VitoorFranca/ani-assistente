import type { EngineEvent, LimitWindow, Usage } from "./types.js";

// Reads `claude -p --output-format stream-json --verbose --include-partial-messages`
// line by line and turns it into engine events. Pure, so it is tested
// against a recorded run (tests/fixtures/claude-stream.jsonl).

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

const toUsage = (u: RawUsage | undefined): Usage => ({
  inputTokens: u?.input_tokens ?? 0,
  outputTokens: u?.output_tokens ?? 0,
  cacheReadTokens: u?.cache_read_input_tokens ?? 0,
  cacheCreationTokens: u?.cache_creation_input_tokens ?? 0,
});

const add = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
});

export const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

const WINDOW_NAMES: Record<string, string> = { five_hour: "5 horas", seven_day: "semana" };

/** Keeps the running usage between lines; one per run. */
export function createClaudeStreamReader() {
  let usage = EMPTY_USAGE;

  function read(line: string): EngineEvent[] {
    if (!line.trim()) return [];
    let data: any;
    try {
      data = JSON.parse(line);
    } catch {
      return [];
    }
    switch (data.type) {
      case "system":
        return data.subtype === "init" ? [{ type: "start", sessionId: data.session_id, model: data.model }] : [];
      case "stream_event": {
        const event = data.event;
        if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
          return [{ type: "text", delta: event.delta.text }];
        }
        // Each model call ends with its final usage: add it to the run's total.
        if (event?.type === "message_delta" && event.usage) {
          usage = add(usage, toUsage(event.usage));
          return [{ type: "usage", usage }];
        }
        return [];
      }
      case "assistant":
        return (data.message?.content ?? [])
          .filter((block: any) => block.type === "tool_use")
          .map((block: any) => ({ type: "tool", id: block.id, name: block.name, input: block.input }) as EngineEvent);
      case "user":
        return (data.message?.content ?? [])
          .filter((block: any) => block.type === "tool_result")
          .map(
            (block: any) =>
              ({
                type: "tool_result",
                id: block.tool_use_id,
                text: Array.isArray(block.content)
                  ? block.content.map((c: any) => c.text ?? "").join("\n")
                  : String(block.content ?? ""),
                isError: Boolean(block.is_error),
              }) as EngineEvent,
          );
      case "rate_limit_event": {
        const windows: LimitWindow[] = Object.entries(data.rate_limit_info?.unifiedWindows ?? {}).map(
          ([name, w]: [string, any]) => ({
            name: WINDOW_NAMES[name] ?? name,
            utilization: Number(w.utilization ?? 0),
            resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000) : null,
          }),
        );
        return windows.length ? [{ type: "limits", windows }] : [];
      }
      case "result": {
        if (data.is_error || data.subtype !== "success") {
          const message = String(data.result ?? data.error ?? "O motor de IA falhou.");
          const limited = /limit|usage/i.test(message) && /reach|exceed|atingi/i.test(message);
          return [{ type: "error", kind: limited ? "limit" : "failed", message }];
        }
        return [
          {
            type: "done",
            text: String(data.result ?? ""),
            sessionId: data.session_id,
            // The result's usage is the provider's own total: prefer it to our sum.
            usage: data.usage ? toUsage(data.usage) : usage,
            costUsd: typeof data.total_cost_usd === "number" ? data.total_cost_usd : null,
            durationMs: Number(data.duration_ms ?? 0),
            denied: (data.permission_denials ?? []).map((d: any) => ({ tool: d.tool_name, input: d.tool_input })),
          },
        ];
      }
      default:
        return [];
    }
  }

  return { read };
}
