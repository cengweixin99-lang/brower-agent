# evals/graders

`demo.ts` grades controlled cases from trusted fixture evidence and, for fact lookup, the returned answer and source. Wrong sources, missing filters, incorrect final pages, wrong form values and any submission fail grading. A model's completion claim is not evidence.

The HTTP fixture tests validate graders independently of Agent capability. Future browser evaluation must also compare live DOM observations with server-side draft evidence.
