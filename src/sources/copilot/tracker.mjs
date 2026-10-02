/**
 * Assigns every Copilot event to a turn.
 *
 * A turn is one user interaction: Copilot's interactionId, which runs from a
 * user.message through every model call and tool call it caused. (Copilot's
 * own turnId marks individual model calls and is far too fine-grained.)
 *
 * Not every event carries interactionId, so the tracker remembers the current
 * one, and records each tool call's interaction so completions and sub-agent
 * activity (linked by parentToolCallId) land on the turn that started them,
 * even when a background sub-agent finishes during a later turn.
 */
const TOP_LEVEL_TURN_EVENTS = new Set(['user.message', 'assistant.turn_start', 'assistant.message', 'system.message']);
const SUBAGENT_EVENTS = new Set(['subagent.started', 'subagent.completed', 'subagent.failed', 'subagent.selected']);

export class Tracker {
  constructor() {
    this.current = null;
    this.calls = new Map();
    this.last = null;
    this.lastPos = null;
  }

  /** Returns { interaction, sub, call } for a record. Safe to call twice on one record. */
  see(rec) {
    if (rec === this.last) return this.lastPos;
    const pos = this.#locate(rec);
    this.last = rec;
    this.lastPos = pos;
    return pos;
  }

  callOf(id) {
    return this.calls.get(id) ?? null;
  }

  #interactionOfCall(id) {
    return this.calls.get(id)?.interaction ?? null;
  }

  #locate(rec) {
    const x = rec.data ?? {};
    const parent = x.parentToolCallId ?? null;

    if (rec.type === 'tool.execution_start') {
      const interaction = parent
        ? (this.#interactionOfCall(parent) ?? this.current)
        : (x.interactionId ?? this.current);
      const call = {
        id: x.toolCallId,
        name: x.toolName,
        args: x.arguments,
        mcp: x.mcpServerName ? `${x.mcpServerName}.${x.mcpToolName}` : null,
        interaction,
        sub: Boolean(parent),
        ts: rec.timestamp ?? null,
      };
      this.calls.set(x.toolCallId, call);
      return { interaction, sub: call.sub, call };
    }

    if (rec.type === 'tool.execution_complete') {
      const call = this.calls.get(x.toolCallId) ?? null;
      return {
        interaction: call?.interaction ?? x.interactionId ?? this.current,
        sub: call?.sub ?? Boolean(parent),
        call,
      };
    }

    // Lifecycle of a sub-agent is reported on the main thread, keyed by the task call.
    if (SUBAGENT_EVENTS.has(rec.type)) {
      const call = this.calls.get(x.toolCallId) ?? null;
      return { interaction: call?.interaction ?? this.current, sub: false, call };
    }

    // The sub-agent's own messages and turns.
    if (parent || rec.agentId) {
      return { interaction: this.#interactionOfCall(parent ?? rec.agentId) ?? this.current, sub: true, call: null };
    }

    if (x.interactionId && TOP_LEVEL_TURN_EVENTS.has(rec.type)) this.current = x.interactionId;
    return { interaction: this.current, sub: false, call: null };
  }
}
