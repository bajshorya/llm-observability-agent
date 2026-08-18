/**
 * Extracting a JSON object from a model response.
 *
 * WHAT THIS FILE DOES
 * Two pure functions. `extractJsonObject` finds the first balanced top-level
 * `{...}` in a string; `parseJsonObject` extracts and parses it, returning
 * `null` when there is nothing usable.
 *
 * WHY IT EXISTS AT ALL
 * Every provider is asked for JSON and told to return nothing else. They mostly
 * comply. The failures are consistent enough to be worth *handling* rather than
 * retrying: a ```json fence, or a sentence of preamble before the object. Both
 * cost one string operation to fix and a full extra API call to retry — so the
 * repair loop is reserved for responses that are WRONG, not ones that are
 * merely wrapped.
 *
 * WHY IT SCANS INSTEAD OF USING indexOf / lastIndexOf
 * The obvious implementation — first `{` to last `}` — breaks on exactly the
 * input this system exists to process:
 *
 *     {"summary":"Cannot read properties of null (reading '{}')","ok":true}
 *
 * A brace inside a quoted error message would end the object early. So the scan
 * tracks string state and escape sequences, and only counts braces that are
 * genuinely structural. Log messages contain braces constantly; this is not a
 * hypothetical.
 *
 * A truncated object — usually a `maxOutputTokens` cut-off — returns null
 * rather than a half-parse, which routes it into the repair loop where it
 * belongs.
 */

/**
 * Scan for a balanced top-level object, tracking string state so that a brace
 * inside a message — `"Cannot read properties of null (reading '{}')"` — does
 * not end the object early. A naive `indexOf("{")`/`lastIndexOf("}")` gets
 * this wrong precisely on the error text this system exists to handle.
 */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      if (inString) escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  // Unbalanced — truncated output, usually a maxOutputTokens cut-off.
  return null;
}

/** Extract and parse. Returns null when there is nothing usable in the text. */
export function parseJsonObject(text: string): unknown {
  const candidate = extractJsonObject(text);
  if (candidate === null) return null;

  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}
