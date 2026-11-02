/**
 * Invisible-character stripping for text that will be shown to a model or a
 * person — pure.
 *
 * WHY
 * Log text reaches three readers: a model (in every prompt), a human (on the
 * dashboard and in Slack) and the injection guard (a regex). Some characters
 * are read by one and not the others, and that gap is an attack:
 *
 *   Unicode tags        U+E0000–E007F  render as nothing, yet a model reads
 *                                      them as text: an instruction no human
 *                                      reviewing the log can see
 *   zero-width          U+200B–200D, U+2060, U+FEFF   split a keyword so a
 *                                      regex misses it ("ign​ore")
 *   bidi controls       U+202A–202E, U+2066–2069, U+200E/F, U+061C   make a
 *                                      line display differently from what it
 *                                      says (the "Trojan Source" trick)
 *   C0 / C1 controls    except tab, newline and carriage return   terminal
 *                                      escape sequences, NULs
 *
 * All of these are removed when a log line is stored, so every reader sees the
 * same thing. Measured before this existed: the guard missed four of five
 * evasions of a phrase it catches in plain text.
 *
 * WHAT IT COSTS
 * A zero-width joiner is also what glues some emoji sequences together, so a
 * family emoji in a log line becomes its separate members. Logs are not the
 * place that matters. Visible text is never changed: no case folding, no
 * normalisation of the stored message, so error signatures and the golden
 * packets are unaffected. (The guard folds look-alikes for its own scan.)
 */

// Built from code points so the source file itself contains no invisible characters.
const INVISIBLE = new RegExp(
  [
    "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]",
    "[\\u061C\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]",
    "[\\u{E0000}-\\u{E007F}]",
  ].join("|"),
  "gu",
);

export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, "");
}

export function hasInvisible(text: string): boolean {
  INVISIBLE.lastIndex = 0;
  const found = INVISIBLE.test(text);
  INVISIBLE.lastIndex = 0;
  return found;
}
