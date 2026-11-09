import { avatarColorIndex, avatarInitial } from '@tianting/sdk';
import { useState } from 'react';

/**
 * 头像（PRD-ui F-UI-21）：用户圆形，群圆角方形。有 https 图片地址时显示图片（加载失败回到占位）；
 * 其他地址一律不请求。
 */
export function Avatar({
  id,
  name,
  size,
  group = false,
  src,
  local,
}: {
  id: string;
  name: string;
  size: number;
  group?: boolean;
  src?: string;
  /** 自己刚换的头像（blob: 地址，只在这次登录里，F-ACC-06）：优先于 src。 */
  local?: string;
}) {
  const [failed, setFailed] = useState('');
  const image =
    local?.startsWith('blob:') && failed !== local ? local : src?.startsWith('https://') && failed !== src ? src : '';
  return (
    <span
      className={`tt-avatar${group ? ' tt-avatar-group' : ''}`}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: `var(--tt-avatar-${avatarColorIndex(id)})`,
      }}
      aria-hidden="true"
      data-testid="avatar"
    >
      {image ? (
        <img
          className="tt-avatar-img"
          src={image}
          alt=""
          referrerPolicy="no-referrer"
          loading="lazy"
          data-testid="avatar-img"
          onError={() => setFailed(image)}
        />
      ) : (
        avatarInitial(name)
      )}
    </span>
  );
}

/** "官方"标识（F-UI-14 规则 6）。 */
export function OfficialTag() {
  return (
    <span className="tt-official" data-testid="official">
      官方
    </span>
  );
}
