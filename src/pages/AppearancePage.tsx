import { useState } from 'react';
import { TopBar } from '../components/TopBar';
import { getThemePref, setThemePref, type ThemePref } from '../lib/theme';

const OPTIONS: { value: ThemePref; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

/** 外观（PRD-ui F-UI-16、F-UI-22）：跟随系统（默认）/ 浅色 / 深色，存在 localStorage 的 ui.theme。 */
export function AppearancePage() {
  const [pref, setPref] = useState(getThemePref);
  return (
    <div className="tt-page">
      <TopBar title="外观" back="/me/settings" />
      <div className="tt-scroll" role="radiogroup" aria-label="外观">
        {OPTIONS.map((o) => (
          <label className="tt-row tt-row-between tt-clickable" key={o.value}>
            <span>{o.label}</span>
            <input
              className="tt-switch"
              type="radio"
              name="theme"
              checked={pref === o.value}
              onChange={() => {
                setPref(o.value);
                setThemePref(o.value);
              }}
              data-testid={`appearance-${o.value}`}
            />
          </label>
        ))}
      </div>
    </div>
  );
}
