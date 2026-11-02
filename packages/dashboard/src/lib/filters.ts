/**
 * Timeline filters, parsed from the URL — pure.
 *
 * Filters live in the query string, not in component state, so a filtered view
 * is a link: "every critical incident on orders-api this week" can be pasted
 * into a channel. It also means the page needs no client JavaScript; the form
 * is a plain GET.
 *
 * The URL is a boundary like any other, so every value is checked against an
 * allowlist and anything unrecognised is ignored rather than passed to a query.
 */

import { anomalyStatuses, severities, type AnomalyStatus, type Severity } from "@obs/shared";

export const verdicts = ["real", "dismissed", "unclassified", "silent", "injection"] as const;
export type Verdict = (typeof verdicts)[number];

export const sinceOptions = { "1h": 60, "24h": 1440, "7d": 10_080, all: null } as const;
export type Since = keyof typeof sinceOptions;

export interface AnomalyFilters {
  service: string | null;
  severity: Severity | null;
  verdict: Verdict | null;
  status: AnomalyStatus | null;
  since: Since;
  /** Free text over summary, service and id prefix. */
  q: string | null;
}

type Params = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined): string | null => {
  const v = Array.isArray(value) ? value[0] : value;
  return v && v.trim() ? v.trim() : null;
};

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

export function parseFilters(params: Params): AnomalyFilters {
  const since = first(params["since"]);
  const q = first(params["q"]);
  const service = first(params["service"]);
  return {
    service: service && service.length <= 64 ? service : null,
    severity: oneOf(first(params["severity"]), severities),
    verdict: oneOf(first(params["verdict"]), verdicts),
    status: oneOf(first(params["status"]), anomalyStatuses),
    since: since !== null && since in sinceOptions ? (since as Since) : "all",
    q: q ? q.slice(0, 100) : null,
  };
}

export function isFiltered(filters: AnomalyFilters): boolean {
  return (
    filters.service !== null ||
    filters.severity !== null ||
    filters.verdict !== null ||
    filters.status !== null ||
    filters.since !== "all" ||
    filters.q !== null
  );
}
