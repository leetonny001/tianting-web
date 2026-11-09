// 换头像（PRD-chat F-ACC-06 规则 3、4，AC-ACC-06-6，FE-633）：选图 → 裁剪成正方形 → 缩放到 512 × 512 → 上传（kind=avatar）
// → PATCH /v1/account/profile。只收 jpeg、png、webp。上传、complete 失败时不改资料；改资料失败时提示头像没改成功。
import { AccountError, AccountNetworkError, UploadPutError, type AccountClient, type FileClient } from '@tianting/sdk';
import { useEffect, useRef, useState } from 'react';
import { Avatar } from '../components/Avatar';
import { Dialog } from '../components/Dialog';
import { useToast } from '../components/Toast';
import { useIm } from '../im/ImProvider';
import { useAttachments } from '../im/hooks';
import { accountErrorText, NETWORK_ERROR } from '../lib/accountText';
import {
  avatarSource,
  browserCodec,
  cropRect,
  ImageProcessError,
  renderAvatar,
  type Decoded,
  type ImageCodec,
} from '../lib/imageProcess';

let codec: ImageCodec = browserCodec;
/** 测试注入（jsdom 没有 canvas）。 */
export function setAvatarCodecForTest(c: ImageCodec | null) {
  codec = c ?? browserCodec;
}

/** 上传一张已经裁好的头像并绑定到资料（F-ACC-06 规则 4）。没完成的上传尽力取消（F-FILE-01 规则 6a）。 */
export async function uploadAvatar(files: FileClient, account: AccountClient, blob: Blob): Promise<void> {
  const up = await files.createUpload({ kind: 'avatar', name: 'avatar.jpg', size: blob.size, mime: blob.type });
  try {
    await files.put(up.put, blob);
    await files.complete(up.fileId);
  } catch (e) {
    void files.cancelUpload(up.fileId);
    throw e;
  }
  await account.updateProfile({ avatarFileId: up.fileId });
}

/** 头像失败的提示（F-ACC-06 异常：5032 时昵称照样能改，头像提示没改成功）。 */
export function avatarErrorText(e: unknown): string {
  if (e instanceof ImageProcessError) {
    return e.why === 'notAllowed' ? '请选择 JPG、PNG 或 WebP 图片' : '无法处理这张图片，请换一张';
  }
  if (e instanceof UploadPutError || e instanceof AccountNetworkError) return NETWORK_ERROR;
  if (e instanceof AccountError) {
    if (e.code === 5032) return '头像没有修改成功，请稍后重试';
    if (e.code === 4139) return '图片过大，最大 2 MB';
    if (e.code === 4150) return '不支持这种图片';
    if (e.code === 4292) return '今天的上传额度已用完';
    if (e.code === 4290 && e.reason === 'uploadPendingLimit') return '上传任务太多，请稍后再试';
  }
  return accountErrorText(e);
}

const VIEW = 240;

export function AvatarEditor({ userId, name, current }: { userId: string; name: string; current?: string }) {
  const { account } = useIm();
  const att = useAttachments();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [img, setImg] = useState<Decoded | null>(null);
  if (!att?.files) return null; // 没有文件接口（服务端关闭了 C2 或测试）：只能改昵称
  const files = att.files;
  return (
    <div className="tt-card tt-avatar-edit">
      <Avatar id={userId} name={name} size={64} src={current} local={att.ownAvatar} />
      <button className="tt-btn" onClick={() => input.current?.click()} data-testid="avatar-change">
        更换头像
      </button>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        data-testid="avatar-pick"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          try {
            setImg(await avatarSource(f, codec));
          } catch (err) {
            toast(avatarErrorText(err));
          }
        }}
      />
      {img && (
        <CropDialog
          img={img}
          onCancel={() => {
            img.close();
            setImg(null);
          }}
          onSave={async (rect) => {
            try {
              const blob = await renderAvatar(codec, img, rect);
              await uploadAvatar(files, account, blob);
              att.setOwnAvatar(blob);
              img.close();
              setImg(null);
              toast('头像已更新');
            } catch (err) {
              toast(avatarErrorText(err));
            }
          }}
        />
      )}
    </div>
  );
}

/** 裁剪：正方形框，拖动移动、滑块缩放；键盘方向键移动（AC-CHAT-90-9 键盘可用）。 */
function CropDialog({
  img,
  onCancel,
  onSave,
}: {
  img: Decoded;
  onCancel: () => void;
  onSave: (rect: ReturnType<typeof cropRect>) => Promise<void>;
}) {
  const [zoom, setZoom] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const rect = cropRect(img.width, img.height, zoom, off.x, off.y);
  // 偏移夹回图片里，免得拖出去之后要拖很久才回来
  const side = Math.min(img.width, img.height) / zoom;
  const clamp = (x: number, y: number) => ({
    x: Math.max(-(img.width - side) / 2 / side, Math.min((img.width - side) / 2 / side, x)),
    y: Math.max(-(img.height - side) / 2 / side, Math.min((img.height - side) / 2 / side, y)),
  });
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx || !img.source) return;
    ctx.clearRect(0, 0, VIEW, VIEW);
    ctx.drawImage(img.source as CanvasImageSource, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, VIEW, VIEW);
  }, [img, rect.sx, rect.sy, rect.sw, rect.sh]);
  return (
    <Dialog
      title="裁剪头像"
      testId="avatar-crop"
      onDismiss={busy ? undefined : onCancel}
      actions={
        <>
          <button className="tt-btn" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            className="tt-btn tt-btn-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onSave(rect);
              setBusy(false);
            }}
            data-testid="avatar-save"
          >
            {busy ? '保存中' : '保存'}
          </button>
        </>
      }
    >
      <div
        className="tt-crop"
        tabIndex={0}
        role="group"
        aria-label="裁剪区域，用方向键移动"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) setOff(clamp(d.ox - (e.clientX - d.x) / VIEW, d.oy - (e.clientY - d.y) / VIEW));
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onKeyDown={(e) => {
          const step = 0.05;
          const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
          if (!d) return;
          e.preventDefault();
          setOff(clamp(off.x + d[0]!, off.y + d[1]!));
        }}
        data-testid="avatar-crop-area"
      >
        <canvas ref={canvas} width={VIEW} height={VIEW} />
      </div>
      <input
        className="tt-crop-zoom"
        type="range"
        min={1}
        max={3}
        step={0.1}
        value={zoom}
        aria-label="缩放"
        onChange={(e) => setZoom(Number(e.target.value))}
        data-testid="avatar-zoom"
      />
    </Dialog>
  );
}
