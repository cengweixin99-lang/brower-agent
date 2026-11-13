// Synthetic public test data only. No real accounts, addresses, or credentials.
export const offices = [
  { id: "north", name: "北城", hours: "09:00–17:00" },
  { id: "south", name: "南城", hours: "10:00–18:00" },
  { id: "east", name: "东城", hours: "08:30–16:30" },
  { id: "west", name: "西城", hours: "09:30–17:30" },
  { id: "lake", name: "湖畔", hours: "08:00–16:00" },
  { id: "hill", name: "山麓", hours: "11:00–19:00" },
  { id: "river", name: "江滨", hours: "09:00–18:00" },
  { id: "park", name: "公园", hours: "10:30–18:30" },
  { id: "bridge", name: "桥东", hours: "08:30–17:30" },
  { id: "harbor", name: "港湾", hours: "07:00–15:00" },
] as const;

export const categories = [
  "灯具",
  "桌椅",
  "书架",
  "收纳",
  "文具",
  "园艺",
  "厨具",
  "箱包",
  "钟表",
  "地毯",
] as const;
export interface Product {
  id: string;
  category: string;
  name: string;
  price: number;
  available: boolean;
}
export const products: Product[] = categories.flatMap((category, index) => [
  {
    id: `item-${index}-available`,
    category,
    name: `${category}标准款`,
    price: 100 + index * 10,
    available: true,
  },
  {
    id: `item-${index}-sold-out`,
    category,
    name: `${category}基础款`,
    price: 50 + index * 10,
    available: false,
  },
  {
    id: `item-${index}-premium`,
    category,
    name: `${category}高级款`,
    price: 300 + index * 10,
    available: true,
  },
]);

export interface FormValues {
  name: string;
  email: string;
  topic: string;
  note: string;
  newsletter: boolean;
}
export const formTopics = ["产品咨询", "预约演示", "技术支持"] as const;
