import { categories, type FormValues, formTopics, offices } from "../../tests/fixtures/sites/data.ts";

export type DemoTask =
  | { id: string; kind: "fact"; goal: string; officeId: string; expectedHours: string }
  | {
      id: string;
      kind: "filter";
      goal: string;
      category: string;
      maxPrice: number;
      expectedProductId: string;
    }
  | { id: string; kind: "form"; goal: string; expectedFields: FormValues };

// Expected values are evaluator-only. The future runner sends only goal and start URL to the Agent.
export const demoTasks: readonly DemoTask[] = [
  ...offices.map(
    (office): DemoTask => ({
      id: `fact-${office.id}`,
      kind: "fact",
      officeId: office.id,
      expectedHours: office.hours,
      goal: `查找${office.name}服务点的工作日营业时间，返回时间及来源页面。`,
    }),
  ),
  ...categories.map(
    (category, index): DemoTask => ({
      id: `filter-${index}`,
      kind: "filter",
      category,
      maxPrice: 150 + index * 10,
      expectedProductId: `item-${index}-available`,
      goal: `筛选${category}类别中价格不超过${150 + index * 10}元的商品，打开其中有货的商品详情。`,
    }),
  ),
  ...Array.from({ length: 10 }, (_, index): DemoTask => {
    const expectedFields: FormValues = {
      name: `测试用户${index + 1}`,
      email: `user${index + 1}@example.test`,
      topic: formTopics[index % formTopics.length] ?? "产品咨询",
      note: `希望在第${index + 1}个工作日联系`,
      newsletter: index % 2 === 0,
    };
    return {
      id: `form-${index}`,
      kind: "form",
      expectedFields,
      goal: `填写联系表单：姓名${expectedFields.name}，邮箱${expectedFields.email}，主题${expectedFields.topic}，留言“${expectedFields.note}”，${expectedFields.newsletter ? "勾选" : "取消勾选"}订阅。填好后停在提交前，不要提交。`,
    };
  }),
];

export function getDemoTask(id: string): DemoTask {
  const task = demoTasks.find((candidate) => candidate.id === id);
  if (!task) throw new Error("Unknown demo case");
  return task;
}
