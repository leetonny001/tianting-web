import type { GroupMemberInfo, GroupRole } from '@tianting/sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router';
import { Avatar, OfficialTag } from '../components/Avatar';
import { Confirm } from '../components/Dialog';
import { RowsSkeleton } from '../components/RowsSkeleton';
import { useToast } from '../components/Toast';
import { TopBar } from '../components/TopBar';
import { useClient, useSelf } from '../im/ImProvider';
import { useFriends, useGroupInfo, useGroupMembers } from '../im/hooks';
import { messageFor } from '../lib/errors';
import { groupIdOf, infoPath, MAX_GROUP_BATCH, type MemberMode } from '../lib/group';
import { chatPath } from '../lib/routes';
import { errCode, userPath, type UserRouteState } from '../lib/social';
import { decodeParam } from './ChatPage';

const ROW_HEIGHT = 56;
const ROLE_LABEL: Partial<Record<GroupRole, string>> = { owner: '群主', admin: '管理员' };
const TITLES: Record<Exclude<MemberMode, 'view'>, string> = {
  kick: '移出成员',
  admin: '设置管理员',
  transfer: '转让群主',
};

/** 我的角色能进入的管理模式（F-UI-36 规则 2）。角色被改之后停留在本页时回到查看模式。 */
function allowedMode(raw: string | null, role: GroupRole | undefined): MemberMode {
  if (raw === 'kick' && (role === 'owner' || role === 'admin')) return 'kick';
  if ((raw === 'admin' || raw === 'transfer') && role === 'owner') return raw;
  return 'view';
}

/** 群成员列表（PRD-ui F-UI-38）：顺序以服务端为准，不做本地排序和过滤。 */
export function GroupMembersPage() {
  const convId = decodeParam(useParams().convId);
  const groupId = groupIdOf(convId);
  const c = useClient();
  const self = useSelf();
  const toast = useToast();
  useFriends(); // 备注变化时刷新显示名
  const [params, setParams] = useSearchParams();
  const { info, gone, refresh } = useGroupInfo(groupId);
  const { members, loaded, hasMore, loadMore, reload } = useGroupMembers(groupId);
  const mode = allowedMode(params.get('mode'), info?.myRole);
  const [picked, setPicked] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<'kick' | GroupMemberInfo | null>(null);
  const inFlight = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const toView = () => {
    setPicked([]);
    setParams({}, { replace: true });
  };

  // 滚动到底部前 5 项时加载下一页；一页撑不满屏幕时直接加载。
  const maybeLoad = useCallback(() => {
    const el = scroller.current;
    if (el && hasMore && el.scrollHeight - el.scrollTop - el.clientHeight < 5 * ROW_HEIGHT) void loadMore();
  }, [hasMore, loadMore]);
  useEffect(maybeLoad, [members, maybeLoad]);

  async function run(cmd: string, op: () => Promise<unknown>, done?: () => void) {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await op();
      done?.();
      await Promise.all([refresh(), reload()]);
    } catch (e) {
      const code = errCode(e);
      toast(messageFor(code, cmd));
      if (code === 4030 || code === 4046) await Promise.all([refresh(), reload()]);
    } finally {
      inFlight.current = false;
    }
  }

  const selectable = (m: GroupMemberInfo) => {
    if (m.role === 'owner') return false;
    if (mode === 'kick') return info?.myRole === 'owner' || m.role === 'member';
    return mode === 'admin' || mode === 'transfer';
  };

  function pick(m: GroupMemberInfo) {
    if (mode === 'admin') {
      void run('groupSetAdmin', () => c.setGroupAdmin(groupId, m.userId, m.role !== 'admin'));
    } else if (mode === 'transfer') {
      setConfirm(m);
    } else if (picked.includes(m.userId)) {
      setPicked(picked.filter((x) => x !== m.userId));
    } else if (picked.length >= MAX_GROUP_BATCH) {
      toast(`一次最多移出 ${MAX_GROUP_BATCH} 人`);
    } else {
      setPicked([...picked, m.userId]);
    }
  }

  if (gone !== null) return <Navigate to={chatPath(convId)} replace />;
  const title = mode === 'view' ? `群成员${info ? `（${info.memberCount}）` : ''}` : TITLES[mode];
  const rowState: UserRouteState = { source: 'group', sourceRef: groupId };
  return (
    <div className="tt-page">
      <TopBar
        title={title}
        back={mode === 'view' ? infoPath(convId) : toView}
        right={
          mode === 'kick' ? (
            <button
              className="tt-link tt-topbar-action tt-danger-action"
              disabled={picked.length === 0}
              onClick={() => setConfirm('kick')}
              data-testid="kick-submit"
            >
              移出（{picked.length}）
            </button>
          ) : undefined
        }
      />
      <div className="tt-scroll" ref={scroller} onScroll={maybeLoad} data-testid="member-list">
        {!loaded ? (
          <RowsSkeleton testId="members-skeleton" />
        ) : (
          members.map((m) => {
            const body = <MemberBody m={m} name={c.displayName(m.userId)} self={m.userId === self} />;
            if (mode === 'view') {
              return (
                <Link
                  key={m.userId}
                  className="tt-user-row"
                  to={userPath(m.userId)}
                  state={rowState}
                  data-testid="member-row"
                  data-user={m.userId}
                >
                  {body}
                </Link>
              );
            }
            const can = selectable(m) && m.userId !== self;
            return (
              <button
                key={m.userId}
                type="button"
                className="tt-user-row tt-member-pick"
                disabled={!can}
                aria-pressed={mode === 'kick' ? picked.includes(m.userId) : undefined}
                onClick={() => pick(m)}
                data-testid="member-row"
                data-user={m.userId}
              >
                {mode === 'kick' && (
                  <span className={`tt-check${picked.includes(m.userId) ? ' tt-check-on' : ''}`} aria-hidden="true" />
                )}
                {body}
              </button>
            );
          })
        )}
      </div>
      {confirm === 'kick' && (
        <Confirm
          testId="kick-confirm"
          text={`确定将 ${picked.length} 人移出群聊？`}
          ok="移出"
          danger
          onCancel={() => setConfirm(null)}
          onOk={() => {
            setConfirm(null);
            void run('groupKick', () => c.kickFromGroup(groupId, picked), toView);
          }}
        />
      )}
      {confirm && confirm !== 'kick' && (
        <Confirm
          testId="transfer-confirm"
          text={`确定将群主转让给 ${c.displayName(confirm.userId)}？转让后你将成为普通成员`}
          ok="转让"
          onCancel={() => setConfirm(null)}
          onOk={() => {
            const to = confirm.userId;
            setConfirm(null);
            void run('groupTransfer', () => c.transferGroupOwner(groupId, to), toView);
          }}
        />
      )}
    </div>
  );
}

function MemberBody({ m, name, self }: { m: GroupMemberInfo; name: string; self: boolean }) {
  const label = ROLE_LABEL[m.role];
  return (
    <>
      <Avatar id={m.userId} name={name} size={40} src={m.avatar} />
      <span className="tt-ellipsis" data-testid="member-name">
        {name}
        {self && <span className="tt-tag"> （我）</span>}
      </span>
      {m.official && <OfficialTag />}
      {label && (
        <span className="tt-role-tag" data-testid="member-role">
          {label}
        </span>
      )}
    </>
  );
}
