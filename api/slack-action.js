/**
 * slack-action.js
 * 슬랙 "답장하기" 버튼 클릭 처리 → 채널톡에 메시지 발송
 *
 * Slack App > Interactivity & Shortcuts > Request URL 에 아래 URL 등록 필요:
 * https://homesinkorea-faq.vercel.app/api/slack-action
 */

async function ctPost(path, body) {
  const res = await fetch(`https://api.channel.io${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-access-key': process.env.CHANNELTALK_ACCESS_KEY,
      'x-access-secret': process.env.CHANNELTALK_ACCESS_SECRET,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`CT API ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function slackPost(endpoint, body) {
  const res = await fetch(`https://slack.com/api/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Slack은 application/x-www-form-urlencoded 로 payload 전송
  let payload;
  try {
    if (req.body?.payload) {
      payload = typeof req.body.payload === 'string'
        ? JSON.parse(req.body.payload)
        : req.body.payload;
    } else if (typeof req.body === 'string') {
      const params = new URLSearchParams(req.body);
      payload = JSON.parse(params.get('payload') || '{}');
    } else {
      payload = req.body;
    }
  } catch (e) {
    console.error('payload 파싱 오류:', e);
    return res.status(400).json({ error: 'Bad payload' });
  }

  const { type, trigger_id, actions, view } = payload;

  // ── 버튼 클릭 → 답장 모달 열기 ──
  if (type === 'block_actions' && actions?.[0]?.action_id === 'reply_to_ct') {
    const convId = actions[0].value;

    const modalRes = await slackPost('views.open', {
      trigger_id,
      view: {
        type: 'modal',
        callback_id: 'send_reply',
        private_metadata: convId,
        title: { type: 'plain_text', text: '채널톡 답장', emoji: true },
        submit: { type: 'plain_text', text: '📤 전송', emoji: true },
        close: { type: 'plain_text', text: '취소', emoji: true },
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `💬 *채널톡 대화에 직접 답장*됩니다.\n고객에게 보낼 메시지를 입력해주세요.` },
          },
          {
            type: 'input',
            block_id: 'reply_block',
            label: { type: 'plain_text', text: '답장 내용', emoji: true },
            element: {
              type: 'plain_text_input',
              action_id: 'reply_text',
              multiline: true,
              min_length: 1,
              placeholder: {
                type: 'plain_text',
                text: '예) 안녕하세요! 문의 주셔서 감사합니다...',
              },
            },
          },
        ],
      },
    });

    if (!modalRes.ok) {
      console.error('모달 열기 실패:', modalRes.error);
    }

    return res.status(200).end();
  }

  // ── 모달 제출 → 채널톡으로 전송 ──
  if (type === 'view_submission' && view?.callback_id === 'send_reply') {
    const convId = view.private_metadata;
    const replyText = view.state?.values?.reply_block?.reply_text?.value?.trim();

    if (!replyText || !convId) {
      return res.status(200).json({ response_action: 'clear' });
    }

    try {
      await ctPost(`/open/v1/conversations/${convId}/messages`, {
        plainText: replyText,
      });

      // 슬랙에서 모달 닫기 + 성공 알림
      return res.status(200).json({ response_action: 'clear' });

    } catch (e) {
      console.error('채널톡 전송 오류:', e);
      // 에러 시 모달에 에러 메시지 표시
      return res.status(200).json({
        response_action: 'errors',
        errors: {
          reply_block: `전송 실패: ${e.message}`,
        },
      });
    }
  }

  return res.status(200).end();
};
