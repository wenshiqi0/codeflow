/**
 * Model-round context classification.
 *
 * Every completed round counts in `model_rounds_total`; internal support-model
 * rounds are additionally single-listed. Project work is no longer classified
 * by identity, and an unknown entry is counted as project work — never
 * dropped.
 */

export const SUPPORT_MODEL_ROLES: readonly string[] = ["zipper"];

const SUPPORT = new Set<string>(SUPPORT_MODEL_ROLES);

export function classifyModelRole(role: string): "primary" | "support" {
	return SUPPORT.has(role) ? "support" : "primary";
}
