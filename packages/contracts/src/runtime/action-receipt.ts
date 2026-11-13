import { type ActionResult, parseActionResult } from "./browser.ts";
import { ContractError, object, string } from "./validation.ts";

export interface ActionReceipt {
  result: ActionResult;
  extractedText: string | null;
}
export function parseActionReceipt(value: unknown): ActionReceipt {
  const row = object(value, ["result", "extractedText"], "actionReceipt");
  const result = parseActionResult(row.result);
  const extractedText =
    row.extractedText === null ? null : string(row.extractedText, "extractedText", 10_000, 0);
  if (extractedText !== null && result.outcome.status !== "succeeded")
    throw new ContractError("extractedText.outcome");
  return { result, extractedText };
}
