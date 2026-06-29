// api/lookup-user.js
// Vercel Serverless Function — tra cứu user theo username/email KHÔNG CẦN
// đăng nhập. Rule Firestore /users/{userId} yêu cầu isAuth() để đọc (đúng,
// cần giữ để bảo mật) — nhưng có 3 luồng phải đọc TRƯỚC khi có auth:
//   - login() khi đăng nhập bằng email (cần tìm username tương ứng)
//   - register() kiểm tra username/email đã tồn tại chưa
//   - requestReset() (quên mật khẩu) tìm tài khoản theo username/email
// Trước đây 3 chỗ này gọi getDocs() thẳng từ client → bị Firestore chặn
// "permission-denied". Giải pháp: đọc bằng quyền admin server-side (Firestore
// REST API + service account, KHÔNG mở rule public cho client).
//
// mode='exists' (dùng cho register kiểm tra trùng): CHỈ trả {found}, không
// trả thông tin cá nhân của người khác (tránh lộ tên/đơn vị/email người lạ
// khi ai đó nhập trùng username/email lúc đăng ký).
// mode='full' (dùng cho login bằng email, quên mật khẩu): trả thêm
// uid/username/name/unit/email — vì 2 luồng này đang xác nhận ĐÚNG tài khoản
// của chính người gọi (cần dữ liệu để tiếp tục đăng nhập/tạo yêu cầu reset).
import { GoogleAuth } from 'google-auth-library'

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://pmuvatm.vercel.app')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { field, value, mode } = req.body || {}
  if (!field || !value || !['username', 'email'].includes(field)) {
    return res.status(400).json({ error: 'Thiếu field/value hợp lệ (username|email)' })
  }

  try {
    const auth = new GoogleAuth({
      credentials: {
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        private_key:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/datastore'],
    })
    const client = await auth.getClient()
    const token  = (await client.getAccessToken()).token

    const projectId = process.env.FIREBASE_PROJECT_ID
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`

    const body = {
      structuredQuery: {
        from:  [{ collectionId: 'users' }],
        where: {
          fieldFilter: {
            field: { fieldPath: field },
            op:    'EQUAL',
            value: { stringValue: String(value) },
          },
        },
        limit: 1,
      },
    }

    const r = await fetch(url, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    })
    const data = await r.json()
    if (!r.ok) throw new Error(data?.error?.message || `Firestore query lỗi (${r.status})`)

    const entry = (Array.isArray(data) ? data : [data]).find(d => d.document)
    if (!entry) return res.status(200).json({ found: false })

    if (mode === 'exists') return res.status(200).json({ found: true })

    const f = entry.document.fields || {}
    const get = (k) => f[k]?.stringValue ?? ''
    return res.status(200).json({
      found:    true,
      uid:      get('uid'),
      username: get('username'),
      name:     get('name'),
      unit:     get('unit'),
      email:    get('email'),
    })
  } catch (e) {
    console.error('[lookup-user] lỗi:', e.message)
    return res.status(500).json({ error: e.message })
  }
}
