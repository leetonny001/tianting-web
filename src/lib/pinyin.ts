// 通讯录拼音分组（PRD-ui F-UI-13 规则 4、R-UI-24）：不引入拼音库，用 Intl.Collator 的拼音排序 + 锚点汉字表。
// 锚点、期望结果见 protocol/vectors/pinyin-groups.json（lib.test 校验）。

const LETTERS = 'ABCDEFGHJKLMNOPQRSTWXYZ';
const ANCHORS = '吖丷嚓咑妸发旮哈丌咔垃呣拏喔妑七呥仨他屲夕丫帀';
const LOCALE = 'zh-Hans-CN-u-co-pinyin';

function collator(): Intl.Collator {
  return new Intl.Collator(LOCALE);
}

/** 运行环境是否支持拼音排序；不支持时汉字开头的名字一律归"#"，组内按码点排序，页面不报错。 */
export function pinyinSupported(): boolean {
  return collator().resolvedOptions().collation === 'pinyin';
}

/** 显示名的分组字母：A～Z 或 #。 */
export function pinyinGroup(name: string): string {
  const first = [...name][0];
  if (!first) return '#';
  const ascii = first.normalize('NFKC');
  if (/^[A-Za-z]$/.test(ascii)) return ascii.toUpperCase();
  if (!/^\p{Script=Han}$/u.test(first) || !pinyinSupported()) return '#';
  const c = collator();
  let group = '#';
  for (let i = 0; i < LETTERS.length; i++) {
    if (c.compare(first, ANCHORS[i]!) < 0) break;
    group = LETTERS[i]!;
  }
  return group;
}

const byteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const startsWithHan = (s: string) => /^\p{Script=Han}/u.test(s);

/**
 * 比较显示名：支持拼音时用拼音 Collator，否则按码点。
 * 中文排序规则默认把汉字排在拉丁字母前面，而 PRD 要求 "Alpha" 在 "周末球局" 前（AC-UI-32-1）：非汉字开头的先排。
 */
export function compareNames(): (a: string, b: string) => number {
  if (!pinyinSupported()) return byteOrder;
  const c = collator();
  return (a, b) => {
    const ha = startsWithHan(a);
    return ha === startsWithHan(b) ? c.compare(a, b) : ha ? 1 : -1;
  };
}

/** 按 A～Z 分组，"#"放最后；组内按显示名，相同时按 id 字节序。 */
export function groupByPinyin<T>(
  items: T[],
  name: (x: T) => string,
  id: (x: T) => string,
): { group: string; items: T[] }[] {
  const cmp = compareNames();
  const groups = new Map<string, T[]>();
  for (const x of items) {
    const g = pinyinGroup(name(x));
    const list = groups.get(g);
    if (list) list.push(x);
    else groups.set(g, [x]);
  }
  return [...groups.keys()]
    .sort((a, b) => (a === '#' ? 1 : b === '#' ? -1 : byteOrder(a, b)))
    .map((group) => ({
      group,
      items: groups.get(group)!.sort((a, b) => cmp(name(a), name(b)) || byteOrder(id(a), id(b))),
    }));
}
