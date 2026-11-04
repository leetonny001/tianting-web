/** 列表骨架屏（PRD-ui F-UI-20）：6 条占位。 */
export function RowsSkeleton({ testId }: { testId: string }) {
  return (
    <div data-testid={testId} aria-busy="true">
      {Array.from({ length: 6 }, (_, i) => (
        <div className="tt-user-row" key={i}>
          <span className="tt-skeleton-avatar tt-skeleton-small" />
          <span className="tt-skeleton-lines">
            <span />
          </span>
        </div>
      ))}
    </div>
  );
}
