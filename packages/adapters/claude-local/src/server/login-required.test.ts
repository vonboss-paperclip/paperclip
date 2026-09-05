import { describe, expect, it } from "vitest";
import { detectClaudeLoginRequired } from "./parse.js";

const code = "// espace (public, not logged in) -> Espace client";
const tool = {
  type: "user",
  message: { content: [{ type: "tool_result", content: code }] },
};
const success = { type: "result", subtype: "success", is_error: false, result: "Done." };
const stream = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");
const detect = (parsed: Record<string, unknown> | null, stdout = "", stderr = "") =>
  detectClaudeLoginRequired({ parsed, stdout, stderr }).requiresLogin;

describe("Claude login diagnostic provenance", () => {
  it("does not turn successful tool output into an authentication failure", () => {
    expect(detect(success, stream(tool, success))).toBe(false);
  });

  it("treats the successful terminal as authoritative over text in all channels", () => {
    const result = { ...success, result: "Documented: not logged in; please run /login." };
    expect(detect(result, stream(tool, result), "Not logged in. Please run /login")).toBe(false);
  });

  it("also recognizes a successful terminal when parsed is absent", () => {
    expect(detect(null, stream(tool, success), "Not logged in")).toBe(false);
  });

  it.each([tool, { type: "assistant", message: { content: [{ type: "text", text: code }] } }])(
    "ignores non-diagnostic stream events without a terminal: %j",
    (event) => expect(detect(null, stream(event))).toBe(false),
  );

  it("ignores a tool result even if the caller parsed a single event", () => {
    expect(detect(tool, stream(tool))).toBe(false);
  });

  it("ignores code comments and prose in plain fallback output", () => {
    expect(detect(null, code, "Displayed code: " + code)).toBe(false);
  });

  it("does not promote code output when a terminal fails for another reason", () => {
    const result = { type: "result", subtype: "error_max_turns", is_error: true, result: "Maximum turns reached." };
    expect(detect(result, stream(tool, result))).toBe(false);
  });

  it.each([
    { type: "result", subtype: "error_during_execution", is_error: true, result: "Not logged in. Please run /login" },
    { type: "result", subtype: "success", is_error: true, result: "Unauthorized" },
    { type: "result", subtype: "error_during_execution", errors: [{ message: "Authentication required" }] },
    { type: "error", error: { type: "authentication_error", message: "Unauthorized" } },
    { type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text: "Please log in." }] } },
  ])("preserves structured provider auth failures: %j", (result) => {
    expect(detect(result, stream(result))).toBe(true);
    expect(detect(null, stream(result))).toBe(true);
  });

  it.each([
    "Not logged in · Please run /login",
    "Please log in. Run `claude login` first.",
    "Invalid API key · Please run /login",
    "Error: Authentication required",
    "API Error: 401 Unauthorized",
  ])("preserves a standalone CLI diagnostic: %s", (message) => {
    expect(detect(null, message)).toBe(true);
    expect(detect(null, "", message)).toBe(true);
  });

  it("does not classify a bare invalid API key as the Claude login flow", () => {
    expect(detect(null, "", "Invalid API key")).toBe(false);
  });

  it("keeps the login command URL available even without a failure", () => {
    expect(detectClaudeLoginRequired({ parsed: null, stdout: "Open https://claude.ai/oauth/authorize", stderr: "" }).loginUrl)
      .toBe("https://claude.ai/oauth/authorize");
  });
});
