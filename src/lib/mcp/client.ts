/**
 * mcp/client.ts — MCP client supporting Streamable HTTP (primary) + SSE (legacy fallback).
 *
 * Connects to remote MCP servers and exposes a simple `callTool(name, args)` interface.
 * Connections are created on-demand and cached for the lifetime of the serverless
 * function instance.
 *
 * Robustness rules (every one of these was a real failure mode):
 * - The timeout is actually enforced (passed to the SDK request), and connecting is
 *   bounded too — a hung server can no longer stall an API route until the platform
 *   kills it.
 * - Tool-level errors (`isError: true`) throw with the server's message instead of
 *   being parsed as data and silently turning into `null`.
 * - Concurrent callers share one in-flight connection instead of racing N handshakes.
 * - A failed call evicts the cached connection and retries once on a fresh one
 *   (expired MCP sessions otherwise stay broken until the cache entry ages out).
 * - Arguments are coerced to the tool's declared JSON-schema types (from tools/list):
 *   deBridge, for instance, rejects numeric chain IDs and requires strings.
 *
 * Non-custodial: MCP servers return unsigned transactions or read-only data.
 * Signing always happens client-side via wagmi/viem.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

// ─── Types ────────────────────────────────────────────────────────────

export type McpTransportKind = "http" | "sse" | "auto";

export interface McpClientOptions {
  /** Which transport to use. "auto" (default) tries HTTP first, falls back to SSE. */
  transport?: McpTransportKind;
  /** Extra headers to send (e.g. API key). */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds. Defaults to 15 000. */
  timeoutMs?: number;
}

/** Thrown when the server answers a tool call with `isError: true`. Not retried. */
export class McpToolError extends Error {
  constructor(public readonly toolName: string, message: string) {
    super(`[mcp] ${toolName}: ${message}`);
    this.name = "McpToolError";
  }
}

interface ToolSchema {
  properties?: Record<string, { type?: string | string[] }>;
  required?: string[];
}

interface McpConnection {
  client: Client;
  transport: StreamableHTTPClientTransport | SSEClientTransport;
  connectedAt: number;
  /** tools/list result, fetched lazily once per connection. */
  tools?: Promise<Map<string, ToolSchema>>;
}

/** Cache of active MCP connections keyed by server URL + transport + headers. */
const connectionPool = new Map<string, McpConnection>();
/** In-flight connection attempts, so concurrent callers share one handshake. */
const pendingConnections = new Map<string, Promise<McpConnection>>();

/** Max age before reconnecting (5 minutes). */
const MAX_CONNECTION_AGE_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 10_000;

function cacheKeyFor(serverUrl: string, opts?: McpClientOptions): string {
  const headers = opts?.headers ? JSON.stringify(Object.entries(opts.headers).sort()) : "";
  return `${serverUrl}::${opts?.transport ?? "auto"}::${headers}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`[mcp] ${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function openConnection(serverUrl: string, name: string, opts?: McpClientOptions): Promise<McpConnection> {
  const kind = opts?.transport ?? "auto";
  const url = new URL(serverUrl);
  const requestInit: RequestInit | undefined = opts?.headers ? { headers: opts.headers } : undefined;
  const newClient = () => new Client({ name: `meridian-${name}`, version: "1.0.0" }, { capabilities: {} });

  let httpError: unknown;
  if (kind === "http" || kind === "auto") {
    const transport = new StreamableHTTPClientTransport(url, { requestInit });
    const client = newClient();
    try {
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connect ${serverUrl}`);
      return { client, transport, connectedAt: Date.now() };
    } catch (err) {
      httpError = err;
      try { await transport.close(); } catch { /* ignore */ }
      if (kind === "http") {
        throw new Error(`[mcp] HTTP transport failed for ${serverUrl}: ${errorMessage(err)}`);
      }
    }
  }

  const transport = new SSEClientTransport(url, { requestInit });
  const client = newClient();
  try {
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connect ${serverUrl} (sse)`);
  } catch (err) {
    try { await transport.close(); } catch { /* ignore */ }
    const http = httpError ? ` HTTP: ${errorMessage(httpError)};` : "";
    throw new Error(`[mcp] could not connect to ${serverUrl}.${http} SSE: ${errorMessage(err)}`);
  }
  return { client, transport, connectedAt: Date.now() };
}

async function getConnection(serverUrl: string, name: string, opts?: McpClientOptions): Promise<McpConnection> {
  const key = cacheKeyFor(serverUrl, opts);

  const existing = connectionPool.get(key);
  if (existing && Date.now() - existing.connectedAt < MAX_CONNECTION_AGE_MS) return existing;
  if (existing) await evictConnection(key);

  const pending = pendingConnections.get(key);
  if (pending) return pending;

  const attempt = openConnection(serverUrl, name, opts)
    .then((conn) => {
      connectionPool.set(key, conn);
      return conn;
    })
    .finally(() => pendingConnections.delete(key));
  pendingConnections.set(key, attempt);
  return attempt;
}

async function evictConnection(key: string): Promise<void> {
  const conn = connectionPool.get(key);
  connectionPool.delete(key);
  if (conn) {
    try { await conn.transport.close(); } catch { /* ignore */ }
  }
}

/**
 * Get or create an MCP client connection to a remote server.
 * Tries Streamable HTTP first, falls back to SSE for legacy servers.
 */
export async function getMcpClient(serverUrl: string, name: string, opts?: McpClientOptions): Promise<Client> {
  return (await getConnection(serverUrl, name, opts)).client;
}

function toolSchemas(conn: McpConnection, timeoutMs: number): Promise<Map<string, ToolSchema>> {
  if (!conn.tools) {
    conn.tools = conn.client
      .listTools(undefined, { timeout: timeoutMs })
      .then((res) => new Map(res.tools.map((t) => [t.name, t.inputSchema as ToolSchema])));
    // A failed listing must not be cached forever — let the next call try again.
    conn.tools.catch(() => { conn.tools = undefined; });
  }
  return conn.tools;
}

function schemaTypes(type: string | string[] | undefined): string[] {
  if (!type) return [];
  return Array.isArray(type) ? type : [type];
}

/**
 * Coerce argument primitives to the types a tool's input schema declares.
 * Only converts between string ↔ number/integer (and drops `undefined`);
 * anything else is passed through untouched for the server to validate.
 * Pure — exported for tests.
 */
export function coerceArgsToSchema(args: Record<string, unknown>, schema: ToolSchema | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const types = schemaTypes(schema?.properties?.[key]?.type);
    if (types.length === 0) {
      out[key] = value;
    } else if (typeof value === "number" && types.includes("string") && !types.includes("number") && !types.includes("integer")) {
      out[key] = String(value);
    } else if (
      typeof value === "string" &&
      (types.includes("number") || types.includes("integer")) &&
      !types.includes("string") &&
      value.trim() !== "" &&
      Number.isFinite(Number(value))
    ) {
      out[key] = Number(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function toolErrorText(content: unknown): string {
  if (Array.isArray(content)) {
    const texts = content
      .filter((b): b is { type: "text"; text: string } => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text);
    if (texts.length > 0) return texts.join(" ").slice(0, 500);
  }
  return "tool returned an error";
}

/**
 * Call an MCP tool on a remote server. Returns the tool result content or
 * throws on connection/tool errors.
 *
 * The 5th argument accepts either a timeout number (ms) or an options object.
 */
export async function callMcpTool(
  serverUrl: string,
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  optsOrTimeout?: number | McpClientOptions,
): Promise<unknown> {
  const opts: McpClientOptions =
    typeof optsOrTimeout === "number" ? { timeoutMs: optsOrTimeout } : optsOrTimeout ?? {};
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const key = cacheKeyFor(serverUrl, opts);

  const attempt = async (): Promise<unknown> => {
    const conn = await getConnection(serverUrl, serverName, opts);

    let schema: ToolSchema | undefined;
    try {
      const tools = await toolSchemas(conn, timeoutMs);
      if (!tools.has(toolName)) {
        throw new McpToolError(
          toolName,
          `unknown tool on ${serverUrl}. Available: ${[...tools.keys()].join(", ") || "(none)"}`,
        );
      }
      schema = tools.get(toolName);
    } catch (err) {
      if (err instanceof McpToolError) throw err;
      // tools/list unsupported or failed — call anyway with the args as given.
    }

    const result = await conn.client.callTool(
      { name: toolName, arguments: coerceArgsToSchema(args, schema) },
      undefined,
      { timeout: timeoutMs },
    );
    if (result.isError) throw new McpToolError(toolName, toolErrorText(result.content));
    // Prefer structured output when the server provides it (MCP 2025-06-18+).
    if (result.structuredContent !== undefined && result.structuredContent !== null) {
      return result.structuredContent;
    }
    return result.content;
  };

  try {
    return await attempt();
  } catch (err) {
    if (err instanceof McpToolError) throw err;
    // A timeout would most likely time out again — don't double the wait.
    if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) throw err;
    // Transport/session failure: drop the cached connection and retry once on a fresh one.
    await evictConnection(key);
    return attempt();
  }
}

/**
 * Parse an MCP tool result into a typed value. Accepts:
 * - structured content (a plain object/array, returned as-is),
 * - a content array `[{ type: "text", text: "<json>" }]` (first JSON text block),
 * - a raw JSON string.
 * Returns null when nothing parses.
 */
export function parseMcpToolResult<T>(content: unknown): T | null {
  if (content === null || content === undefined) return null;
  if (Array.isArray(content)) {
    const isContentBlocks = content.every((b) => b && typeof b === "object" && "type" in b);
    if (!isContentBlocks) return content as T;
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        try { return JSON.parse(block.text) as T; } catch { /* try the next text block */ }
      }
    }
    return null;
  }
  if (typeof content === "string") {
    try { return JSON.parse(content) as T; } catch { return null; }
  }
  return content as T;
}

/**
 * List available tools on an MCP server (useful for discovery/debugging and health checks).
 */
export async function listMcpTools(serverUrl: string, serverName: string, opts?: McpClientOptions) {
  const conn = await getConnection(serverUrl, serverName, opts);
  return conn.client.listTools(undefined, { timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS });
}

/**
 * Gracefully close all MCP connections (for cleanup).
 */
export async function closeAllMcpConnections() {
  for (const key of [...connectionPool.keys()]) await evictConnection(key);
}
