// WCAG 2.1 对比度（PRD-ui 6.2 节的公式）。
export function luminance(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

export function hsl(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s, l };
}

// PRD-ui 6.2 节的组合清单：[编号, 前景 token, 背景 token, 要求, PRD 中的对比度]。
export const PAIRS = [
  ['01', 'on.brand', 'brand.fill', 4.5],
  ['02', 'on.brand', 'brand.fill.pressed', 4.5],
  ['03', 'brand', 'surface', 4.5],
  ['04', 'brand', 'bg', 4.5],
  ['05', 'brand', 'surface.selected', 4.5],
  ['06', 'text.primary', 'surface', 4.5],
  ['07', 'text.primary', 'bg', 4.5],
  ['08', 'text.secondary', 'surface', 4.5],
  ['09', 'text.secondary', 'bg', 4.5],
  ['10', 'text.secondary', 'chat.bg', 4.5],
  ['11', 'text.secondary', 'surface.selected', 4.5],
  ['12', 'text.tertiary', 'surface', 4.5],
  ['13', 'text.tertiary', 'bg', 4.5],
  ['14', 'text.tertiary', 'chat.bg', 4.5],
  ['15', 'text.tertiary', 'surface.selected', 4.5],
  ['16', 'bubble.self.text', 'bubble.self.bg', 4.5],
  ['17', 'bubble.other.text', 'bubble.other.bg', 4.5],
  ['18', 'text.secondary', 'bubble.other.bg', 4.5],
  ['19', 'danger', 'surface', 4.5],
  ['20', 'danger', 'chat.bg', 3],
  ['21', 'on.badge', 'badge.bg', 4.5],
  ['22', 'warning.text', 'warning.bg', 4.5],
  ['23', 'border.input', 'surface', 3],
  ['24', 'text.tertiary', 'chat.bg', 3],
  ['25', 'border.input', 'bg', 3],
  ['26', 'danger', 'bg', 4.5],
  // C5 置顶会话的背景（frontend-chat 第 57 条，FE-683）：会话项里的名字、摘要、时间和免打扰图标、"[草稿]"。
  ['27', 'text.primary', 'surface.pinned', 4.5],
  ['28', 'text.secondary', 'surface.pinned', 4.5],
  ['29', 'text.tertiary', 'surface.pinned', 4.5],
  ['30', 'danger', 'surface.pinned', 4.5],
];

// PRD 6.2 节表中的值（浅色 L、深色 D），CI 比对计算结果到两位小数。
export const EXPECTED = {
  L: [
    5.38, 7.11, 5.38, 4.85, 4.53, 16.87, 15.21, 6.05, 5.45, 5.32, 5.09, 5.5, 4.96, 4.84, 4.64, 5.38, 16.87, 6.05, 5.56,
    4.89, 4.83, 6.26, 3.73, 4.84, 3.37, 5.02, 15.34, 5.5, 5.0, 5.06,
  ],
  D: [
    5.38, 7.11, 6.55, 7.3, 5.18, 13.87, 15.45, 7.08, 7.89, 8.14, 5.6, 5.78, 6.44, 6.65, 4.58, 6.48, 12.11, 6.18, 5.49,
    6.31, 4.83, 9.05, 3.88, 6.65, 4.32, 6.12, 12.58, 6.42, 5.24, 4.98,
  ],
};

/** 检查 tokens，返回问题列表（空表示通过）。 */
export function checkTokens(tokens) {
  const problems = [];
  const rows = [];
  for (const [mode, key] of [
    ['L', 'light'],
    ['D', 'dark'],
  ]) {
    PAIRS.forEach(([id, fg, bg, need], i) => {
      const f = tokens.color[fg]?.[key];
      const b = tokens.color[bg]?.[key];
      if (!f || !b) {
        problems.push(`${mode}${id}: token ${!f ? fg : bg} is missing`);
        return;
      }
      const r = contrast(f, b);
      rows.push(`${mode}${id} ${fg} / ${bg}: ${r.toFixed(2)} (need ${need})`);
      if (r < need) problems.push(`${mode}${id} ${fg} / ${bg}: ${r.toFixed(2)} < ${need}`);
      if (r.toFixed(2) !== EXPECTED[mode][i].toFixed(2)) {
        problems.push(
          `${mode}${id} ${fg} / ${bg}: ${r.toFixed(2)} differs from PRD-ui 6.2 (${EXPECTED[mode][i].toFixed(2)})`,
        );
      }
    });
  }
  tokens.avatar.forEach((c, i) => {
    const r = contrast('#FFFFFF', c);
    rows.push(`avatar ${i} white / ${c}: ${r.toFixed(2)}`);
    if (r < 4.5) problems.push(`avatar ${i} ${c}: white text ${r.toFixed(2)} < 4.5`);
  });
  // 色相检查（AC-UI-90-5）：品牌色和自己气泡不能落在绿色区间（色相 120°～165° 且饱和度 > 40%）。
  for (const [k, v] of Object.entries(tokens.color)) {
    if (!k.startsWith('brand') && !k.startsWith('bubble.self')) continue;
    for (const hex of [v.light, v.dark]) {
      const { h, s } = hsl(hex);
      if (h >= 120 && h <= 165 && s > 0.4) problems.push(`${k} ${hex}: hue ${h.toFixed(0)}° is in the green range`);
    }
  }
  return { problems, rows };
}
