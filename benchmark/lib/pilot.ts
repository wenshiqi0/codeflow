/**
 * The fixed, auditable dev pilot (design §2).
 *
 * 正式结果必须覆盖完整 500 instances；开发期使用一份固定、可审计、不可按
 * 结果挑选的 20-instance pilot 清单验证链路。The pilot is a RULE, not a
 * hand-picked list: the first {@link PILOT_INSTANCE_COUNT} instances in the
 * pinned dataset's own order. Given a pinned revision the selection is
 * deterministic and auditable, and it cannot be chosen by results because it
 * is fixed before any attempt runs. Pilot results must not be presented as a
 * full SWE-bench Verified score.
 */

import type { BenchmarkDataset } from "./dataset";

export const PILOT_INSTANCE_COUNT = 20;

/**
 * The fixed pilot allowlist: first {@link PILOT_INSTANCE_COUNT} instance ids
 * in dataset order (fewer when the dataset itself is smaller).
 */
export function pilotAllowlist(dataset: BenchmarkDataset): string[] {
	return dataset.instances.slice(0, PILOT_INSTANCE_COUNT).map((instance) => instance.instance_id);
}
