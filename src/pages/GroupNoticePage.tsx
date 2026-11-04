import { useRef, useState } from 'react';
import { Navigate, useParams } from 'react-router';
import { RowsSkeleton } from '../components/RowsSkeleton';
import { useToast } from '../components/Toast';
import { TopBar } from '../components/TopBar';
import { useClient } from '../im/ImProvider';
import { useDisplayName, useGroupInfo } from '../im/hooks';
import { messageFor } from '../lib/errors';
import { groupIdOf, infoPath, MAX_NOTICE } from '../lib/group';
import { chatPath } from '../lib/routes';
import { errCode, textLen } from '../lib/social';
import { formatTime } from '../lib/time';
import { decodeParam } from './ChatPage';

/** 群公告（PRD-ui F-UI-37）：纯文本，保留换行；群主、管理员可编辑，空字符串表示清除。 */
export function GroupNoticePage() {
  const convId = decodeParam(useParams().convId);
  const groupId = groupIdOf(convId);
  const c = useClient();
  const toast = useToast();
  const { info, gone, refresh } = useGroupInfo(groupId);
  const [draft, setDraft] = useState<string | null>(null);
  const inFlight = useRef(false);
  const canEdit = info?.myRole === 'owner' || info?.myRole === 'admin';
  const len = draft === null ? 0 : textLen(draft);
  const tooLong = len > MAX_NOTICE;

  async function save() {
    if (inFlight.current || tooLong || draft === null) return;
    if (draft.trim() === info?.notice) return setDraft(null);
    inFlight.current = true;
    try {
      await c.updateGroup(groupId, { notice: draft.trim() });
      setDraft(null);
      await refresh();
    } catch (e) {
      const code = errCode(e);
      toast(messageFor(code, 'groupUpdate'));
      if (code === 4030) {
        setDraft(null);
        await refresh();
      }
    } finally {
      inFlight.current = false;
    }
  }

  if (gone !== null) return <Navigate to={chatPath(convId)} replace />;
  return (
    <div className="tt-page">
      <TopBar
        title="群公告"
        back={infoPath(convId)}
        right={
          !canEdit || !info ? undefined : draft === null ? (
            <button
              className="tt-link tt-topbar-action"
              onClick={() => setDraft(info.notice)}
              data-testid="notice-edit"
            >
              编辑
            </button>
          ) : (
            <button
              className="tt-link tt-topbar-action"
              disabled={tooLong}
              onClick={() => void save()}
              data-testid="notice-save"
            >
              完成
            </button>
          )
        }
      />
      <div className="tt-scroll">
        {!info ? (
          <RowsSkeleton testId="notice-skeleton" />
        ) : draft !== null ? (
          <div className="tt-form">
            <textarea
              className="tt-input tt-textarea tt-notice-input"
              aria-label="群公告"
              rows={10}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              data-testid="notice-input"
            />
            <span className={`tt-counter${tooLong ? ' tt-counter-over' : ''}`} data-testid="notice-count">
              已输入 {len} / {MAX_NOTICE}
            </span>
          </div>
        ) : (
          <div className="tt-notice">
            {info.notice ? (
              <>
                <p className="tt-notice-text" data-testid="notice-text">
                  {info.notice}
                </p>
                <p className="tt-secondary" data-testid="notice-meta">
                  <NoticeBy userId={info.noticeBy} /> {info.noticeAt > 0 && formatTime(info.noticeAt)}
                </p>
              </>
            ) : (
              <p className="tt-secondary tt-center" data-testid="notice-empty">
                暂无群公告
              </p>
            )}
            {!canEdit && (
              <p className="tt-secondary tt-center" data-testid="notice-readonly">
                仅群主和管理员可编辑
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function NoticeBy({ userId }: { userId: string }) {
  return <>{useDisplayName(userId)}</>;
}
