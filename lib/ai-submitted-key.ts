/**
 * The API key an `/api/ai/*` route uses for a request, from the key the
 * browser submitted.
 *
 * Settings never sends the stored key back to the browser: it shows
 * `__SET__` in its place, and the routes that test a connection, list
 * models or run the sample summary accept that placeholder to mean "the
 * key I saved". Those routes call the base URL in the request, though,
 * so the placeholder only resolves to the stored key when the request
 * targets the endpoint the key was saved for: the same provider as
 * `ai_provider`, and the same base URL as `ai_base_url` (or that
 * provider's default when none is saved), compared after both are
 * normalised the way the call itself is. Otherwise the caller has to
 * type the key, and the route answers 400 with `STORED_KEY_REFUSED`.
 *
 * `core/src/server/routes_ai.rs` (`submitted_api_key`) has the same rule
 * for the Rust server.
 */
import {
  type AIProvider,
  normalizeAiBaseUrl,
  normalizeAiProvider,
  resolveDefaultBaseUrl,
} from "./ai-config";
import { getSetting } from "./scheduler";

/** What Settings shows, and submits, in place of a stored key. */
export const MASKED_AI_API_KEY = "__SET__";

export const STORED_KEY_REFUSED =
  "The saved API key is only sent to the saved provider and base URL. Enter the key again to use a different one.";

export type SubmittedApiKey =
  | { ok: true; apiKey: string }
  | { ok: false; message: string };

/** A URL's serialised form, so `HTTP://Host:443` and `https://host` agree. */
function canonicalUrl(value: string): string {
  try {
    return new URL(value).href;
  } catch {
    return value;
  }
}

/**
 * @param raw the `apiKey` field of the request body
 * @param provider the normalised provider of the request
 * @param baseUrl the base URL the route is about to call, already
 *   through {@link normalizeAiBaseUrl}
 */
export function resolveSubmittedApiKey(
  raw: unknown,
  provider: Exclude<AIProvider, "disabled">,
  baseUrl: string
): SubmittedApiKey {
  const submitted = typeof raw === "string" ? raw.trim() : "";
  if (submitted !== MASKED_AI_API_KEY) {
    return { ok: true, apiKey: submitted };
  }
  const stored = getSetting("ai_api_key", "").trim();
  if (!stored) {
    // Nothing saved: the placeholder stands for no key at all.
    return { ok: true, apiKey: "" };
  }
  const storedProvider = normalizeAiProvider(
    getSetting("ai_provider", "disabled")
  );
  if (storedProvider !== provider) {
    return { ok: false, message: STORED_KEY_REFUSED };
  }
  const defaultBase = resolveDefaultBaseUrl(provider);
  const storedBase = normalizeAiBaseUrl(
    getSetting("ai_base_url", defaultBase) || defaultBase,
    provider
  );
  if (canonicalUrl(storedBase) !== canonicalUrl(baseUrl)) {
    return { ok: false, message: STORED_KEY_REFUSED };
  }
  return { ok: true, apiKey: stored };
}
