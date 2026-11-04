import { useMemo, useState } from 'react';
import { useFriends, useSocialLoaded } from '../im/hooks';
import { groupByPinyin } from '../lib/pinyin';
import { Avatar } from './Avatar';
import { RowsSkeleton } from './RowsSkeleton';

/**
 * 好友多选（PRD-ui F-UI-35 规则 2、F-UI-39 规则 1）：按显示名或 userId 本地过滤（不区分大小写），分组同通讯录。
 * joined 里的人显示"已在群里"且不可选；errors 里的人标红。
 */
export function FriendPicker({
  selected,
  onToggle,
  joined,
  errors,
}: {
  selected: readonly string[];
  onToggle: (userId: string) => void;
  joined?: ReadonlySet<string>;
  errors?: ReadonlySet<string>;
}) {
  const friends = useFriends();
  const loaded = useSocialLoaded();
  const [query, setQuery] = useState('');
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? friends.filter((f) => f.displayName.toLowerCase().includes(q) || f.userId.toLowerCase().includes(q))
      : friends;
    return groupByPinyin(
      list,
      (f) => f.displayName,
      (f) => f.userId,
    );
  }, [friends, query]);
  const nameOf = (id: string) => friends.find((f) => f.userId === id);
  return (
    <>
      <div className="tt-form tt-pick-search">
        <input
          className="tt-input"
          type="search"
          aria-label="搜索好友"
          placeholder="搜索"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="pick-search"
        />
      </div>
      {selected.length > 0 && (
        <div className="tt-pick-strip" data-testid="pick-strip">
          {selected.map((id) => (
            <Avatar key={id} id={id} name={nameOf(id)?.displayName ?? id} size={36} src={nameOf(id)?.profile?.avatar} />
          ))}
        </div>
      )}
      <div className="tt-scroll" data-testid="pick-list">
        {!loaded ? (
          <RowsSkeleton testId="pick-skeleton" />
        ) : (
          groups.map((g) => (
            <section key={g.group}>
              <h2 className="tt-group-letter">{g.group}</h2>
              {g.items.map((f) => {
                const inGroup = joined?.has(f.userId) ?? false;
                const error = errors?.has(f.userId) ?? false;
                return (
                  <label
                    key={f.userId}
                    className={`tt-user-row tt-pick-row${error ? ' tt-pick-error' : ''}`}
                    data-testid="pick-row"
                    data-user={f.userId}
                    data-error={error || undefined}
                  >
                    <input
                      type="checkbox"
                      checked={inGroup || selected.includes(f.userId)}
                      disabled={inGroup}
                      onChange={() => onToggle(f.userId)}
                      aria-label={f.displayName}
                      data-testid="pick-check"
                    />
                    <Avatar id={f.userId} name={f.displayName} size={40} src={f.profile?.avatar} />
                    <span className="tt-ellipsis">{f.displayName}</span>
                    {inGroup && <span className="tt-tag">已在群里</span>}
                  </label>
                );
              })}
            </section>
          ))
        )}
      </div>
    </>
  );
}
