/**
 * Prompt-injection guard — pure.
 *
 * WHAT THIS FILE DOES
 * Scans the exact evidence packet a model is about to read for text that is
 * addressed to the model rather than describing the system: instructions to
 * ignore its rules, answers shaped like its output schema, or a sentence that
 * names a classifier and tells it what to conclude.
 *
 * WHY A DETERMINISTIC LAYER EXISTS AT ALL
 * The system prompt tells every agent that evidence is untrusted
 * (llm/untrusted.ts), and that measurably helps. But it asks the model to
 * behave, and the model is the thing under attack. Before that rule existed
 * the `prompt-injection` golden case was dismissed by one model 3 times in 3,
 * and made another fail to answer 3 times in 3 — and a failed classification
 * pages nobody either. So the guard's consequence does not depend on the
 * model: a flagged anomaly pages ("injection" reason, alerting/alerts.ts)
 * whatever verdict comes back, including none. The model can be talked out
 * of its judgement; it cannot be talked out of the page.
 *
 * WHAT IT SCANS, AND WHY THE PACKET
 * The rendered packet, not the raw logs. Text the sampler left out never
 * reaches a model and cannot steer it, and text that is in the packet is
 * exactly what the model sees, after truncation. Scanning anything else would
 * be guarding a different input.
 *
 * PRECISION OVER RECALL, DELIBERATELY
 * A false positive is a page, so the patterns are narrow:
 *
 *   strong      any one flags: the pipeline's own output field names (they
 *               appear in our prompts, never in a service's logs), "ignore
 *               previous instructions" and its relatives, "system prompt", and
 *               a JSON-shaped verdict
 *   addressed   both in one line: a name for an automated judge (classifier,
 *               language model, AI assistant…) AND a directive about the
 *               answer (classify this as…, respond with…, mark it benign…)
 *
 * Bare words like "LLM", "model" or "agent" are not enough. A service that IS
 * an AI product logs them all day ("LLM request failed, retrying"), and paging
 * on that would teach people to ignore this alert.
 *
 * LOOK-ALIKES ARE FOLDED FOR THE SCAN
 * Each line is matched as written, and again after NFKC folding (fullwidth
 * "ｉｇｎｏｒｅ" becomes "ignore"), with invisible characters removed (ingest
 * strips them already; this covers anything that reached a packet another
 * way), and reversed, for text laid out right-to-left. The excerpt is always
 * the line as the model saw it.
 *
 * THE LIMIT, STATED
 * A regex cannot recognise every phrasing, every language or an encoded
 * payload. A determined attacker who reads this file can write around it. That
 * is why it is one layer of three, not the defence: what it buys is that the
 * obvious attack — the one in the golden set — pages a human every time,
 * independent of which model is on duty.
 */

import { stripInvisible } from "@obs/shared";

export interface InjectionFinding {
  /** Which rule matched. Stable identifiers, for tests and the dashboard. */
  rule: string;
  /** The packet line it matched in, trimmed and bounded. */
  excerpt: string;
}

const MAX_EXCERPT = 240;

const STRONG: readonly { rule: string; pattern: RegExp }[] = [
  {
    rule: "output-field",
    pattern: /\b(isRealIncident|suspectedCommitSha|changedFilesImplicated|explainsTheFailure|affectedArea)\b/i,
  },
  {
    rule: "ignore-instructions",
    pattern:
      /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|preceding|all|any|your|the)\b[^.\n]{0,20}\b(instructions?|prompts?|rules|guidelines|directions)\b/i,
  },
  { rule: "system-prompt", pattern: /\bsystem[\s_-]?prompt\b/i },
  { rule: "role-reassignment", pattern: /\byou are (now )?(an?|the) (ai|assistant|language model|classifier|chatbot)\b/i },
  {
    rule: "json-verdict",
    pattern: /["']?(severity|is_?real_?incident)["']?\s*[:=]\s*["']?(low|medium|high|critical|true|false)\b/i,
  },
];

const ADDRESSEE =
  /\b(classifier|classification (stage|model|system)|language model|ai (model|assistant|system|agent|classifier)|automated (incident|triage|classif\w*|system|pipeline|analysis|monitor\w*|reviewer|judge)|incident (bot|classifier|triage)|(dear|hey|attention|note to the|notice to the) (ai|model|assistant|bot))\b/i;

const DIRECTIVE =
  /\b((respond|reply|answer|output|return) (with|only|that)|classify (this|it|these|them|the)|(mark|treat|label|rate|report|consider|set) (this|it|these|them|the|severity)\b[^.\n]{0,60}\b(benign|harmless|expected|low|false|resolved|not an? (incident|issue|problem)|noise)|(do not|don't|never) (page|alert|escalate|notify|wake))/i;

function matchOne(text: string): string | null {
  for (const candidate of STRONG) {
    if (candidate.pattern.test(text)) return candidate.rule;
  }
  return ADDRESSEE.test(text) && DIRECTIVE.test(text) ? "addressed-directive" : null;
}

/** The line as written, then folded, then reversed — first rule that matches any. */
function matchRule(line: string): string | null {
  // Unicode tag characters spell ASCII invisibly; decode them so hidden text is read, not dropped.
  const decoded = line.replace(/[\u{E0020}-\u{E007E}]/gu, (c) => String.fromCharCode((c.codePointAt(0) ?? 0) - 0xe0000));
  const folded = stripInvisible(decoded).normalize("NFKC");
  return matchOne(line) ?? matchOne(folded) ?? matchOne([...folded].reverse().join(""));
}

function excerpt(line: string): string {
  const trimmed = line.trim();
  return trimmed.length <= MAX_EXCERPT ? trimmed : `${trimmed.slice(0, MAX_EXCERPT - 1)}…`;
}

/**
 * Findings in a rendered packet, one per line at most, in packet order. Empty
 * when nothing looks addressed to the model.
 */
export function scanForInjection(packet: string): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  const seen = new Set<string>();

  for (const line of packet.split("\n")) {
    if (!line.trim()) continue;

    const rule = matchRule(line);
    if (rule === null) continue;

    // The same payload repeats across the sample and the signature table.
    const key = line.trim().replace(/^\S+\s+(INFO|WARN|ERROR|FATAL)\s+/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ rule, excerpt: excerpt(line) });
  }

  return findings;
}

/** What is stored on the anomaly: the first finding, which is enough for a human to judge. */
export function summariseFindings(findings: readonly InjectionFinding[]): string | null {
  const first = findings[0];
  if (!first) return null;
  const more = findings.length > 1 ? ` (+${findings.length - 1} more)` : "";
  return `[${first.rule}] ${first.excerpt}${more}`;
}
