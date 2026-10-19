import type { LanguageId } from '../storage/language-schema.ts';

/** The few pages the server writes itself (outside the screens), in the display language chosen in the settings. */
const TEXT = {
  ja: { back: 'Niwaの画面に戻る', tailnet: 'このNiwaは、Tailscale Serve を通した接続だけを受け付けます。<br>自分のTailscaleのネットワークにつないだ端末から開いてください。',
    loggedIn: 'MCPの接続先にログインしました。Niwaの画面に戻って「接続を確認」を押してください。', refused: 'ログインが取り消されたか、拒否されました。Niwaの設定から、もう一度ログインしてください。',
    failed: 'ログインを完了できませんでした。Niwaの設定から、もう一度ログインしてください。' },
  en: { back: 'Back to Niwa', tailnet: 'This Niwa only accepts connections through Tailscale Serve.<br>Open it from a device connected to your own Tailscale network.',
    loggedIn: 'You’re signed in to the MCP connection. Go back to Niwa and select “Check connection”.', refused: 'The sign-in was canceled or refused. Sign in again from Niwa’s settings.',
    failed: 'The sign-in couldn’t be completed. Sign in again from Niwa’s settings.' },
  ko: { back: 'Niwa 화면으로 돌아가기', tailnet: '이 Niwa는 Tailscale Serve를 거친 연결만 받아요.<br>내 Tailscale 네트워크에 연결된 기기에서 열어 주세요.',
    loggedIn: 'MCP 연결에 로그인했어요. Niwa 화면으로 돌아가 ‘연결 확인’을 눌러 주세요.', refused: '로그인이 취소되었거나 거부되었어요. Niwa 설정에서 다시 로그인해 주세요.',
    failed: '로그인을 마치지 못했어요. Niwa 설정에서 다시 로그인해 주세요.' },
  'zh-CN': { back: '返回 Niwa', tailnet: '这个 Niwa 只接受通过 Tailscale Serve 的连接。<br>请在连接到你自己的 Tailscale 网络的设备上打开。',
    loggedIn: '已登录 MCP 连接。请回到 Niwa，点击“检查连接”。', refused: '登录已取消或被拒绝。请在 Niwa 的设置中重新登录。',
    failed: '未能完成登录。请在 Niwa 的设置中重新登录。' },
} satisfies Record<LanguageId, Record<string, string>>;

export type NoticeText = typeof TEXT.ja;
export function noticeText(language: string): NoticeText & { lang: string } {
  const lang = (language in TEXT ? language : 'ja') as LanguageId;
  return { ...TEXT[lang], lang };
}
