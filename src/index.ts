#!/usr/bin/env node
/**
 * eleata Claim Verifier MCP server
 * --------------------------------
 * A grounding / anti-hallucination guardrail for AI agents. Given a claim and
 * supporting evidence, it returns whether the evidence Supports / Refutes /
 * gives Not Enough Evidence for the claim (natural-language inference), plus a
 * confidence and an `abstained` flag for low-confidence cases.
 *
 * Wraps the hosted eleata Claim Verifier API (POST /verify).
 *
 * Tools:
 *   - verify_claim(claim, evidence)        -> POST /verify (balanced)
 *   - check_groundedness(answer, context)  -> POST /verify (RAG framing)
 *   - verify_strict(claim, evidence)       -> POST /verify (strict)
 *
 * Auth: set EVERIFY_API_KEY. By default it is sent as `Authorization: Bearer`
 * against the paid host (https://verify-pro.eleata.io). To use the RapidAPI
 * marketplace channel instead, set EVERIFY_RAPIDAPI=1 (sends X-RapidAPI-Key)
 * and EVERIFY_API_BASE to the RapidAPI host.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const API_BASE = (process.env.EVERIFY_API_BASE || "https://verify-pro.eleata.io").replace(/\/+$/, "");
const API_KEY = process.env.EVERIFY_API_KEY || "";
const USE_RAPIDAPI = process.env.EVERIFY_RAPIDAPI === "1";
const USER_AGENT = "eleata-verify-mcp/0.1.0";
const TIMEOUT_MS = 25_000;
const MAX_FIELD_CHARS = 16_000; // server caps fields at 16KB

const MODES = ["balanced", "strict"];

const TOOLS = [
  {
    name: "verify_claim",
    description:
      "Fact-check a claim against a piece of evidence using natural-language inference. " +
      "Returns a grounded verdict — Supported, Refuted, or Not Enough Evidence — with a confidence (0..1) " +
      "and an `abstained` flag. Use it to check whether a statement is actually backed by a source before " +
      "trusting or repeating it. If `abstained` is true, treat the result as 'cannot verify — do not rely'.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        claim: { type: "string", description: "The statement to check.", maxLength: MAX_FIELD_CHARS },
        evidence: { type: "string", description: "The source text the claim should be supported by.", maxLength: MAX_FIELD_CHARS },
      },
      required: ["claim", "evidence"],
    },
  },
  {
    name: "check_groundedness",
    description:
      "Hallucination guard for RAG / agent answers. Pass the model's generated answer and the retrieved " +
      "context; returns whether the answer is grounded in the context. Treat any verdict other than 'Supported', " +
      "or `abstained=true`, as 'ungrounded / likely hallucination' and have the agent retract or re-retrieve.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        answer: { type: "string", description: "The model-generated answer to check for grounding.", maxLength: MAX_FIELD_CHARS },
        context: { type: "string", description: "The retrieved context the answer should be grounded in.", maxLength: MAX_FIELD_CHARS },
      },
      required: ["answer", "context"],
    },
  },
  {
    name: "verify_strict",
    description:
      "Same as verify_claim but with a raised abstention threshold — abstains more readily. Use when a wrong " +
      "'Supported' is costly (compliance, legal, medical-adjacent) and the agent must not over-assert.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        claim: { type: "string", description: "The statement to check.", maxLength: MAX_FIELD_CHARS },
        evidence: { type: "string", description: "The source text the claim should be supported by.", maxLength: MAX_FIELD_CHARS },
      },
      required: ["claim", "evidence"],
    },
  },
];

async function callVerify(claim: string, evidence: string, mode: string): Promise<string> {
  if (!API_KEY) {
    return (
      "No API key configured. Set the EVERIFY_API_KEY environment variable. " +
      "Get a key at https://eleata.io/checkout?p=verifypro (paid channel) or via the RapidAPI listing."
    );
  }
  if (!claim || !evidence) return "Both claim/answer and evidence/context are required.";
  if (claim.length > MAX_FIELD_CHARS || evidence.length > MAX_FIELD_CHARS) {
    return `Input too large (max ${MAX_FIELD_CHARS} characters per field).`;
  }
  const m = MODES.includes(mode) ? mode : "balanced";
  const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": USER_AGENT };
  if (USE_RAPIDAPI) headers["X-RapidAPI-Key"] = API_KEY;
  else headers["Authorization"] = `Bearer ${API_KEY}`;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/verify`, {
      method: "POST",
      headers,
      body: JSON.stringify({ claim, evidence, mode: m }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError" || err.name === "AbortError") return `The verifier did not respond within ${TIMEOUT_MS / 1000}s.`;
    return `Could not reach the verifier at ${API_BASE}.`;
  }

  const text = await res.text();
  // Status-specific messages BEFORE attempting JSON (a gateway may return HTML on 5xx).
  if (res.status === 401 || res.status === 403) return "Authentication failed: the EVERIFY_API_KEY is missing, invalid, or for the wrong channel.";
  if (res.status === 413) return "Input too large for the verifier (field/body size limit exceeded).";
  if (res.status === 429) return "Rate limit reached (about 60 requests/min). Try again shortly.";
  if (res.status === 503) return "The verifier is temporarily unavailable (kill-switch or cold model).";
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return `The verifier returned an unexpected (non-JSON) response (HTTP ${res.status}). It may be down or rate-limiting.`;
  }
  if (res.status < 200 || res.status >= 300) {
    const msg = data?.error?.message || data?.detail || data?.message || `HTTP ${res.status}`;
    return `Verification failed: ${String(msg).slice(0, 300)}`;
  }

  const verdict = data.verdict ?? "(no verdict)";
  const confidence = typeof data.confidence === "number" ? data.confidence : null;
  const abstained = data.abstained === true;
  const calibrated = data.calibrated === true;

  const lines: string[] = [];
  lines.push(`Verdict: ${verdict}${abstained ? "  ⚠️ ABSTAINED (low confidence — do not rely)" : ""}`);
  if (confidence !== null) lines.push(`Confidence: ${confidence.toFixed(3)}${calibrated ? "" : " (uncalibrated — not a probability)"}`);
  lines.push(`Mode: ${m}`);
  if (data.model) lines.push(`Model: ${data.model}`);
  if (data.note) lines.push(`Note: ${String(data.note)}`);
  return lines.join("\n");
}

const server = new Server({ name: "eleata-verify", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: rawArgs } = req.params;
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  try {
    let text: string;
    if (name === "verify_claim") {
      text = await callVerify(String(args.claim ?? ""), String(args.evidence ?? ""), "balanced");
    } else if (name === "verify_strict") {
      text = await callVerify(String(args.claim ?? ""), String(args.evidence ?? ""), "strict");
    } else if (name === "check_groundedness") {
      text = await callVerify(String(args.answer ?? ""), String(args.context ?? ""), "balanced");
    } else {
      return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    }
    return { content: [{ type: "text", text }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: `Tool ${name} failed: ${(e as Error).message}` }] };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("eleata-verify MCP server running on stdio\n");
}

main().catch((e) => {
  process.stderr.write(`fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
