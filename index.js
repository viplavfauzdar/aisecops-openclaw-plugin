/**
 * AISecOps OpenClaw Plugin
 * Registers: aisecops_invoke
 *
 * Default target:
 *   http://localhost:8083/api/v1/tools/invoke
 *
 * Config precedence for baseUrl:
 *   1) plugin entry config (openclaw.json -> plugins.entries["aisecops-openclaw-plugin"].config.baseUrl)
 *   2) env AISECOPS_BASE_URL
 *   3) http://localhost:8083
 *
 * Optional env:
 *   AISECOPS_INVOKE_PATH   (default: /api/v1/tools/invoke)
 *   AISECOPS_TOKEN         (adds Authorization: Bearer ...)
 *   AISECOPS_API_KEY       (adds x-api-key: ...)
 *   AISECOPS_TIMEOUT_MS    (default: 15000)
 */

function normalizeBaseUrl(u) {
  if (!u) return "";
  return String(u).replace(/\/+$/, "");
}

function getPluginConfigBaseUrl(ctx) {
  // OpenClaw passes plugin config through various shapes depending on runtime.
  return (
    ctx?.pluginConfig?.baseUrl ||
    ctx?.config?.baseUrl ||
    ctx?.entryConfig?.baseUrl ||
    ctx?.plugin?.config?.baseUrl ||
    ""
  );
}

function getActor(ctx, actorArg) {
  return actorArg || ctx?.user || ctx?.actor || ctx?.identity?.user || "openclaw";
}

function getCorrelationId(ctx, correlationIdArg) {
  if (correlationIdArg) return correlationIdArg;
  if (ctx?.correlationId) return ctx.correlationId;
  if (ctx?.sessionId) return ctx.sessionId;
  const uuid = globalThis?.crypto?.randomUUID?.();
  return uuid || `cid-${Date.now()}`;
}

async function postJson(url, payload, headers, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const text = await res.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }

    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

export default function register(api) {
  api.registerTool({
    name: "aisecops_invoke",
    description:
      "Invoke enterprise-approved tools via AISecOps (policy + audit + sandboxed execution).",
    parameters: {
      type: "object",
      properties: {
        toolName: { type: "string", description: "Tool identifier (e.g., jira.create_issue)" },
        args: { type: "object", description: "Tool arguments object" },
        dryRun: { type: "boolean", description: "If true, request policy evaluation without execution" },
        actor: { type: "string", description: "End-user / operator identity (optional)" },
        correlationId: { type: "string", description: "Correlation id for tracing (optional)" }
      },
      required: ["toolName"]
    },

    async execute(_id, params, ctx) {
      const {
        toolName,
        args = {},
        dryRun = false,
        actor,
        correlationId
      } = params || {};

      if (!toolName) {
        return {
          content: [
            {
              type: "text",
              text: "Missing required parameter: toolName"
            }
          ]
        };
      }

      const baseUrl =
        normalizeBaseUrl(getPluginConfigBaseUrl(ctx)) ||
        normalizeBaseUrl(process.env.AISECOPS_BASE_URL) ||
        "http://localhost:8083";

      const invokePath = process.env.AISECOPS_INVOKE_PATH || "/api/v1/tools/invoke";
      const url = `${baseUrl}${invokePath}`;

      const cid = getCorrelationId(ctx, correlationId);
      const effectiveActor = getActor(ctx, actor);

      const headers = {
        "Content-Type": "application/json",
        "x-correlation-id": cid,
        "x-agent": "openclaw",
        "x-openclaw-session": ctx?.sessionId || ""
      };

      if (process.env.AISECOPS_TOKEN) {
        headers["Authorization"] = `Bearer ${process.env.AISECOPS_TOKEN}`;
      }
      if (process.env.AISECOPS_API_KEY) {
        headers["x-api-key"] = process.env.AISECOPS_API_KEY;
      }

      const payload = {
        toolName,
        args: args || {},
        actor: effectiveActor,
        correlationId: cid,
        dryRun: Boolean(dryRun)
      };

      // Log exactly what OpenClaw is sending (requested)
      console.log("[aisecops-openclaw-plugin] invoke payload:", JSON.stringify(payload));

      const timeoutMs = Number(process.env.AISECOPS_TIMEOUT_MS || 15000);
      const { ok, status, body } = await postJson(url, payload, headers, timeoutMs);

      if (!ok) {
        const reason =
          body?.reason || body?.error || body?.message || `AISecOps call failed (${status})`;

        return {
          content: [
            {
              type: "json",
              json: {
                status: "error",
                httpStatus: status,
                reason,
                response: body
              }
            }
          ]
        };
      }

      // Return a ToolResult with a human-readable text summary + full JSON (prevents NO_REPLY)
      const summary =
        typeof body === "object" && body
          ? `AISecOps OK: tool=${toolName} status=${body.status || "ok"} correlationId=${body.correlationId || cid}`
          : `AISecOps OK: tool=${toolName} correlationId=${cid}`;

      return {
        content: [
          { type: "text", text: summary },
          { type: "json", json: body }
        ]
      };
    }
  });
}
