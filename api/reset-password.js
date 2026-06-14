// api/reset-password.js
// Vercel Serverless Function — reset Firebase Auth password
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', 'https://pmuvatm.vercel.app')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { uid, newPassword } = req.body
  if (!uid || !newPassword) return res.status(400).json({ error: 'Missing uid or newPassword' })

  try {
    const { GoogleAuth } = await import('google-auth-library')
    const auth = new GoogleAuth({
      credentials: {
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        private_key:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    })

    const token = await auth.getAccessToken()
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/accounts:update`,
      {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ localId: uid, password: newPassword }),
      }
    )

    const data = await response.json()
    if (!response.ok) throw new Error(data.error?.message || 'Reset failed')
    return res.status(200).json({ success: true })
  } catch (e) {
    console.error('Reset password error:', e)
    return res.status(500).json({ error: e.message })
  }
}
