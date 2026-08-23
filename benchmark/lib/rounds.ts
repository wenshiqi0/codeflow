/**
 * Model-round execution-kind classification.
 */

export function classifyWorkerKind(kind: string): "worker" | "service" {
	return kind === "service" ? "service" : "worker";
}
