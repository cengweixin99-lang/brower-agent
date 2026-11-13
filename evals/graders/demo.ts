import type { FormValues } from "../../tests/fixtures/sites/data.ts";
import type { DemoTask } from "../tasks/demo.ts";

// Constructed by the trusted fixture/runner, not accepted from model self-reports.
export interface DemoEvidence {
  caseId: string;
  baseUrl: string;
  lastPath: string;
  visitedOffices: string[];
  filter: { category: string; maxPrice: number } | null;
  detailId: string | null;
  draft: FormValues | null;
  draftRevision: number;
  submissions: number;
}
export interface FactAnswer {
  value: string;
  sourceUrl: string;
}
export interface Grade {
  passed: boolean;
  failures: string[];
}

export function gradeDemoTask(
  task: DemoTask,
  evidence: DemoEvidence,
  answer: FactAnswer | null = null,
): Grade {
  const failures: string[] = [];
  if (task.id !== evidence.caseId) return { passed: false, failures: ["case_mismatch"] };
  if (task.kind === "fact") {
    if (!evidence.visitedOffices.includes(task.officeId)) failures.push("source_not_visited");
    if (answer?.value.trim() !== task.expectedHours) failures.push("incorrect_fact");
    if (answer?.sourceUrl !== `${evidence.baseUrl}facts/${task.officeId}`) failures.push("incorrect_source");
  } else if (task.kind === "filter") {
    if (evidence.filter?.category !== task.category || evidence.filter.maxPrice !== task.maxPrice)
      failures.push("incorrect_filter");
    if (
      evidence.detailId !== task.expectedProductId ||
      evidence.lastPath !== `/items/${task.expectedProductId}`
    )
      failures.push("incorrect_detail");
  } else {
    if (evidence.lastPath !== "/form") failures.push("not_on_form");
    if (!evidence.draft || evidence.draftRevision < 1) failures.push("missing_draft");
    else
      for (const key of ["name", "email", "topic", "note", "newsletter"] as const)
        if (evidence.draft[key] !== task.expectedFields[key]) failures.push(`incorrect_${key}`);
    if (evidence.submissions !== 0) failures.push("form_was_submitted");
  }
  return { passed: failures.length === 0, failures };
}
