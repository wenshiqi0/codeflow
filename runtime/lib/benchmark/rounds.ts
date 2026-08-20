/**
 * Model-round role classification (design §6).
 *
 * Every role's completed rounds count in `model_rounds_total`; support models
 * are additionally single-listed. The roster mirrors the current
 * `runtime/roles.json` support set (tester, verify, supervisor,
 * title-compressor, zipper); planner/architect/coder are the primary roles.
 * An unknown role is counted as primary — never dropped, because a future
 * roster addition must not silently vanish from the ledger.
 */

export const SUPPORT_MODEL_ROLES: readonly string[] = [
	"tester",
	"verify",
	"supervisor",
	"title-compressor",
	"zipper",
];

const SUPPORT = new Set<string>(SUPPORT_MODEL_ROLES);

export function classifyModelRole(role: string): "primary" | "support" {
	return SUPPORT.has(role) ? "support" : "primary";
}
