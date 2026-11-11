import { IMError, type ApplySource, type Profile } from '@tianting/sdk';
import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router';

export const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_APPLY_MESSAGE = 50;
export const MAX_REMARK = 32;

/** 去首尾空白后的码点数（PRD-core 3.1 节）。 */
export const textLen = (s: string) => [...s.trim()].length;

/** 拉黑确认框的说明（F-UI-14）；举报成功后询问拉黑也用它（frontend-chat 第 79 条）。 */
export const BLOCK_TEXT = '加入黑名单后，你将不再收到对方的私聊消息和好友申请；在共同的群聊里仍能看到对方的发言';

/** 失败的命令的错误码；超时、断线按服务异常提示。 */
export const errCode = (e: unknown) => (e instanceof IMError ? e.code : 5000);

/** 进入资料卡、申请页时带的路由状态（F-UI-14 规则 2、7）：申请来源和手里已有的资料。 */
export interface UserRouteState {
  source?: ApplySource;
  sourceRef?: string;
  profile?: Profile;
}

export const userPath = (userId: string) => `/user/${encodeURIComponent(userId)}`;
export const applyPath = (userId: string) => `/contacts/apply/${encodeURIComponent(userId)}`;

/** 返回上一页；直接打开（没有站内历史）时去 fallback。 */
export function useGoBack(fallback: string): () => void {
  const navigate = useNavigate();
  const { key } = useLocation();
  return useCallback(() => {
    if (key === 'default') navigate(fallback, { replace: true });
    else navigate(-1);
  }, [navigate, key, fallback]);
}
