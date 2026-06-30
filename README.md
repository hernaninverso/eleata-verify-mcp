# eleata Claim Verifier — MCP server

A **grounding / hallucination guardrail** for AI agents. Give it a `claim` and supporting
`evidence`; it returns whether the evidence **Supports / Refutes / gives Not Enough Evidence**
for the claim (natural-language inference), with a confidence and an `abstained` flag for
low-confidence cases. Wraps the hosted [eleata](https://eleata.io) Claim Verifier.

> Use it as a fact-check / RAG hallucination guard: before an agent trusts or repeats a
> statement, check it against its source. Treat `abstained=true` (or any verdict other than
> *Supported*) as "do not rely".

## Tools

| Tool | What it does |
|------|--------------|
| `verify_claim(claim, evidence)` | Is the claim supported by the evidence? Verdict + confidence + `abstained`. |
| `check_groundedness(answer, context)` | RAG guard: is the model's answer grounded in the retrieved context? |
| `verify_strict(claim, evidence)` | Same, with a higher abstention threshold — for compliance/legal where a wrong "Supported" is costly. |

## Setup

```json
{
  "mcpServers": {
    "eleata-verify": {
      "command": "npx",
      "args": ["-y", "eleata-verify-mcp"],
      "env": { "EVERIFY_API_KEY": "your_key" }
    }
  }
}
```

Get a key at <https://eleata.io/checkout?p=verifypro> (paid channel, sent as `Authorization: Bearer`).
For the RapidAPI marketplace channel, set `EVERIFY_RAPIDAPI=1` and `EVERIFY_API_BASE` to the RapidAPI host
(the key is then sent as `X-RapidAPI-Key`).

## Notes

Confidence is **uncalibrated** on the public channels (not a probability) — rely on the verdict and the
`abstained` flag, not the raw number. The engine is a multilingual NLI model (mDeBERTa-v3-mnli-xnli).
`verify` sends your claim + evidence to the hosted API; see <https://eleata.io/privacy/>.

MIT licensed.
