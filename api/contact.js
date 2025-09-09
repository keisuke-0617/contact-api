import sgMail from '@sendgrid/mail';

export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') {
      const origin = req.headers.origin || '';
      const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
      if (allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      return res.status(204).end();
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    const origin = req.headers.origin || '';
    const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
    if (!allowed.includes(origin)) return res.status(403).json({ error: 'Forbidden' });
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');

    const { name, email, message } = req.body || {};
    if (!name || !email || !message) return res.status(400).json({ error: 'Bad Request' });

    // Claude API呼び出し
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-latest',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: [{ type: 'text', text:
`問い合わせを要約し、カテゴリ（見積依頼/採用/サポート/その他）とスパム推定(0~1)をJSONで出力。
name: ${name}
email: ${email}
message: ${message}

出力JSON:
{"summary": "...", "category": "...", "spam_score": 0.0}`}
          ]
        }]
      })
    }).then(r => r.json()).catch(() => null);

    let summary = '', category = 'その他', spam_score = 0;
    try {
      const txt = claudeRes?.content?.[0]?.text || '{}';
      const parsed = JSON.parse(txt);
      summary = parsed.summary || '';
      category = parsed.category || 'その他';
      spam_score = Number(parsed.spam_score || 0);
    } catch {}

    // Supabaseへ保存
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/contact_submissions`, {
      method: 'POST',
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({
        name, email, message,
        ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '',
        user_agent: req.headers['user-agent'] || '',
        claude_summary: summary,
        claude_category: category,
        spam_score
      })
    });

    // SendGridでメール送信
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    await sgMail.send({
      to: 'piaget.1116@gmail.com',
      from: { email: 'noreply@piaget.co.jp', name: 'PIAGET 問い合わせ通知' },
      subject: `【新規問い合わせ】${category} - ${name}`,
      text:
`■お名前: ${name}
■メール: ${email}
■カテゴリ: ${category}
■スパムスコア: ${spam_score}
■要約: ${summary}

--- 原文 ---
${message}`
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server Error' });
  }
}
