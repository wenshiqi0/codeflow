import { canonicalJson, contentHash } from "../canonical";

export interface ContentShape {
	hash: string;
	chars: number;
}

export interface ToolSchemaShape extends ContentShape {
	count: number;
}

export interface ContextSectionShape extends ContentShape {
	kind: string;
}

export interface WorkerContextShape extends ContentShape {
	sections: ContextSectionShape[];
}

export interface RequestPromptShape {
	system_prompt: ContentShape;
	tool_schema: ToolSchemaShape;
	worker_context: WorkerContextShape;
	message_prefix: ContentShape;
}

export function textShape(value: string): ContentShape {
	return { hash: contentHash(value), chars: value.length };
}

export function canonicalShape(value: unknown): ContentShape {
	return textShape(canonicalJson(value));
}
