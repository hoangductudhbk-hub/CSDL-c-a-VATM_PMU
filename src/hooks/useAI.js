// src/hooks/useAI.js
import { useState } from 'react'

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const OPENROUTER_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemma-3-27b-it:free',
  'qwen/qwen-2.5-72b-instruct:free',
  'mistralai/mistral-7b-instruct:free',
]
const GROQ_VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct'
const GEMINI_MODELS = ['gemini-2.0-flash', 'gemini-2.0-flash-lite']
const GEM_URL = (model, key) =>
  `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${key}`

// ── Lấy keys ────────────────────────────────────────────────────
const getGroqKeys = () => {
  const fromEnv = [
    import.meta.env.VITE_GROQ_API_KEY,
    import.meta.env.VITE_GROQ_API_KEY_2,
    import.meta.env.VITE_GROQ_API_KEY_3,
  ].filter(Boolean)
  if (fromEnv.length) return fromEnv
  return (localStorage.getItem('groq_key') || '').split(/[,\n]/).map(k => k.trim()).filter(Boolean)
}

const getGemKeys = () => {
  const fromEnv = [
    import.meta.env.VITE_GEMINI_API_KEY,
    import.meta.env.VITE_GEMINI_API_KEY_2,
    import.meta.env.VITE_GEMINI_API_KEY_3,
  ].filter(Boolean)
  if (fromEnv.length) return fromEnv
  return (localStorage.getItem('gemini_key') || '').split(/[,\n]/).map(k => k.trim()).filter(Boolean)
}

const getOpenRouterKey = () =>
  import.meta.env.VITE_OPENROUTER_API_KEY || localStorage.getItem('openrouter_key') || ''

const saveKey = (k) => {
  k = k.trim()
  if (k.startsWith('gsk_')) {
    const existing = (localStorage.getItem('groq_key') || '').split(',').map(x => x.trim()).filter(Boolean)
    if (!existing.includes(k)) existing.push(k)
    localStorage.setItem('groq_key', existing.join(','))
  } else {
    localStorage.setItem('gemini_key', k)
  }
}

const resetIdxIfNewDay = () => {
  const today = new Date().toDateString()
  if (localStorage.getItem('ai_day') !== today) {
    localStorage.setItem('ai_day', today)
    localStorage.setItem('ai_groq_idx', '0')
    localStorage.setItem('ai_gem_idx', '0')
  }
}

const SYSTEM = `Bạn là chuyên gia phân tích văn bản hành chính Việt Nam.
Đọc nội dung (3 trang đầu) và trả về JSON duy nhất, không giải thích thêm.
- "code": số ký hiệu dạng "404/NQ-HĐTV"
- "date": CHỈ dạng số D/M/YYYY hoặc M/YYYY
- "org": cơ quan BAN HÀNH
- "docType": Quyết định|Nghị quyết|Công văn|Tờ trình|Báo cáo|Hợp đồng|Biên bản|Thông báo|Hồ sơ|Bản vẽ|Khác
- "subject": câu mô tả NỘI DUNG VỀ VIỆC GÌ
- "detail": tóm tắt 2-3 điểm quan trọng
- "note": 1 câu nhận xét ý nghĩa
- "status": "done" nếu đã ban hành, "prep" nếu chưa
{"code":"","date":"","org":"","docType":"","subject":"","detail":"","note":"","status":"done"}`

// ── Gọi Gemini ──────────────────────────────────────────────────
const callGemini = async (prompt, maxTokens = 1000) => {
  const keys = getGemKeys()
  for (const key of keys) {
    for (const model of GEMINI_MODELS) {
      try {
        const res = await fetch(GEM_URL(model, key), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: maxTokens },
          }),
        })
        if (res.status === 429) continue
        if (!res.ok) continue
        const result = (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text || ''
        if (result) return result
      } catch { continue }
    }
  }
  return null
}

// ── Gọi Groq ────────────────────────────────────────────────────
const callGroq = async (prompt, maxTokens = 1000, system = null) => {
  const keys = getGroqKeys()
  for (const key of keys) {
    try {
      const messages = system
        ? [{ role: 'system', content: system }, { role: 'user', content: prompt }]
        : [{ role: 'user', content: prompt }]
      const res = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: maxTokens, temperature: 0.1, messages }),
      })
      if (res.status === 429) continue
      if (!res.ok) continue
      const result = (await res.json()).choices?.[0]?.message?.content || ''
      if (result) return result
    } catch { continue }
  }
  return null
}

// ── Gọi OpenRouter ──────────────────────────────────────────────
const callOpenRouter = async (prompt, maxTokens = 1000) => {
  const key = getOpenRouterKey()
  if (!key) return null
  for (const model of OPENROUTER_MODELS) {
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`,
          'HTTP-Referer': 'https://pmuvatm.vercel.app',
          'X-Title': 'VATM-PMU',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature: 0.1,
          messages: [{ role: 'user', content: prompt }],
        }),
      })
      if (res.status === 429) continue
      if (!res.ok) continue
      const result = (await res.json()).choices?.[0]?.message?.content || ''
      if (result) return result
    } catch { continue }
  }
  return null
}

// ── Gọi AI: Gemini → OpenRouter → Groq (tránh rate limit) ─────
const callAI = async (prompt, maxTokens = 1000) => {
  // Gemini trước — ít rate limit
  const gem = await callGemini(prompt, maxTokens)
  if (gem) return gem
  // OpenRouter fallback — nhiều model free
  const or = await callOpenRouter(prompt, maxTokens)
  if (or) return or
  // Groq cuối cùng
  const groq = await callGroq(prompt, maxTokens)
  if (groq) return groq
  const err = new Error('AI_RATE_LIMIT')
  err.waitSeconds = 30
  throw err
}

// ── Prompt chunk trích xuất chi tiết ────────────────────────────
const buildChunkPrompt = (chunk, idx, total, fileName) => `
Bạn là chuyên gia trích xuất thông tin văn bản hành chính Việt Nam.
Đây là PHẦN ${idx}/${total} của văn bản: "${fileName}"
Trích xuất TẤT CẢ thông tin, GIỮ NGUYÊN số liệu. Trả về JSON:
{
  "summary": "mô tả ngắn phần này",
  "keyPoints": ["điểm quan trọng với số liệu cụ thể"],
  "members": ["Họ tên - chức vụ/vai trò"],
  "technicalSpecs": ["tên thiết bị: thông số đầy đủ"],
  "financial": ["hạng mục: số tiền + đơn vị"],
  "legal": ["văn bản pháp lý - số hiệu"],
  "deadlines": ["công việc: thời hạn cụ thể"],
  "otherData": ["dữ kiện quan trọng khác"]
}
NỘI DUNG PHẦN ${idx}:
---
${chunk}
---`

const buildFinalPrompt = (allData, fileName, total) => `
Bạn vừa đọc xong TOÀN BỘ ${total} phần của văn bản: "${fileName}"
Tổng hợp thành bộ nhớ hoàn chỉnh. Trả về JSON:
{
  "summary": "Tóm tắt tổng quan 10-15 câu bao quát TOÀN BỘ văn bản",
  "keyPoints": ["điểm quan trọng với số liệu cụ thể - không giới hạn"],
  "members": ["Họ tên đầy đủ - chức vụ/vai trò/đơn vị - TẤT CẢ"],
  "technicalSpecs": ["Tên thiết bị: thông số đầy đủ - TẤT CẢ"],
  "financial": ["Hạng mục: số tiền + đơn vị - TẤT CẢ"],
  "legal": ["Văn bản pháp lý - số hiệu - TẤT CẢ"],
  "deadlines": ["Công việc: thời hạn cụ thể - TẤT CẢ"],
  "requirements": "yêu cầu và điều kiện đầy đủ",
  "risks": "rủi ro và điểm cần lưu ý",
  "otherData": ["dữ kiện quan trọng khác"],
  "keywords": ["từ khóa đặc trưng - tối đa 20"]
}
DỮ LIỆU TỪ TỪNG PHẦN:
${allData}`

const buildSinglePrompt = (text, fileName) => `
Phân tích chi tiết văn bản hành chính Việt Nam. Trả về JSON:
{
  "summary": "Tóm tắt tổng quan 8-12 câu",
  "keyPoints": ["điểm quan trọng với số liệu"],
  "members": ["Họ tên - chức vụ/vai trò"],
  "technicalSpecs": ["Tên thiết bị: thông số đầy đủ"],
  "financial": ["Hạng mục: số tiền + đơn vị"],
  "legal": ["Văn bản pháp lý - số hiệu"],
  "deadlines": ["Công việc: thời hạn cụ thể"],
  "requirements": "yêu cầu và điều kiện",
  "risks": "rủi ro và điểm lưu ý",
  "otherData": ["dữ kiện khác"],
  "keywords": ["từ khóa - tối đa 20"]
}
Tên file: ${fileName}
NỘI DUNG:
---
${text}
---`

// ── Phân tích toàn bộ văn bản với chunking ──────────────────────
export const analyzeFullDocument = async (text, fileName = '', onStep = null) => {
  const step = (msg) => { if (onStep) onStep(msg) }
  const CHUNK_SIZE = 10000
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{3,}/g, ' ')

  if (clean.length <= CHUNK_SIZE) {
    step('🤖 Đang phân tích văn bản...')
    return await callAI(buildSinglePrompt(clean, fileName), 3000)
  }

  const chunks = []
  for (let i = 0; i < clean.length; i += CHUNK_SIZE) {
    chunks.push(clean.slice(i, i + CHUNK_SIZE))
  }
  step(`📚 Văn bản ${Math.round(clean.length / 1000)}K ký tự · Chia ${chunks.length} phần`)

  const results = []
  for (let i = 0; i < chunks.length; i++) {
    step(`🔍 Đang đọc phần ${i + 1}/${chunks.length}...`)
    try {
      const result = await callAI(buildChunkPrompt(chunks[i], i + 1, chunks.length, fileName), 1500)
      results.push(`=== PHẦN ${i + 1}/${chunks.length} ===\n${result}`)
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 1000))
    } catch (e) {
      results.push(`=== PHẦN ${i + 1}/${chunks.length} ===\n{"error": "Không đọc được"}`)
    }
  }

  step(`🧠 Đang tổng hợp ${chunks.length} phần...`)
  const final = await callAI(buildFinalPrompt(results.join('\n\n'), fileName, chunks.length), 3000)
  step(`✅ Hoàn thành! Đã đọc ${chunks.length} phần`)
  return final
}

// ── RAG: Tìm đoạn văn bản liên quan ────────────────────────────
export const findRelevantChunks = (text, question) => {
  if (!text || !question) return ''
  const stopWords = new Set(['là','gì','có','của','và','các','cho','trong','được','không','về','này','đó','với','những','theo','từ','khi','hay','hoặc','như','thì','mà','để','tôi','bạn','hãy','cần','phải','làm','nào','ai'])
  const keywords = question.toLowerCase().replace(/[?.,!;:]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !stopWords.has(w))
  if (!keywords.length) return text.slice(0, 3000)

  const chunks = []
  for (let i = 0; i < text.length; i += 300) chunks.push({ text: text.slice(i, i + 400), pos: i })

  const scored = chunks.map(c => {
    const lower = c.text.toLowerCase()
    let score = keywords.reduce((s, kw) => s + (lower.includes(kw) ? 3 : 0), 0)
    return { ...c, score }
  }).filter(c => c.score > 0).sort((a, b) => b.score - a.score).slice(0, 8).sort((a, b) => a.pos - b.pos)

  return scored.length ? scored.map(c => c.text).join('\n---\n').slice(0, 3000) : text.slice(0, 2000)
}

export function useAI() {
  const [loading, setLoading] = useState(false)

  // ── analyzeText (dùng khi thêm văn bản) ──
  const analyzeText = async (text, fileName = '') => {
    setLoading(true)
    resetIdxIfNewDay()
    const hint = fileName ? `\nTên file: ${fileName}` : ''
    const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{3,}/g, ' ').slice(0, 6000)
    const prompt = `${SYSTEM}\n\nPhân tích văn bản:${hint}\n---\n${clean}\n---`
    try {
      // Groq trước cho analyzeText — nhanh hơn khi thêm nhiều văn bản cùng lúc
      const groq = await callGroq(prompt, 1000, SYSTEM)
      if (groq) return groq
      // Gemini fallback khi Groq 429
      return await callGemini(prompt, 1000) || ''
    } finally { setLoading(false) }
  }

  // ── analyzeImages ──
  const analyzeImages = async (base64Images, fileName = '') => {
    setLoading(true)
    resetIdxIfNewDay()
    const hint = fileName ? ` (${fileName})` : ''
    try {
      // Groq Vision
      const keys = getGroqKeys()
      for (const key of keys) {
        try {
          const res = await fetch(GROQ_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify({
              model: GROQ_VISION_MODEL, max_tokens: 1000, temperature: 0.05,
              messages: [{ role: 'user', content: [
                ...base64Images.slice(0, 3).map(b64 => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } })),
                { type: 'text', text: `${SYSTEM}\n\nĐọc ảnh scan văn bản Việt Nam${hint} và trả về JSON.` }
              ]}],
            }),
          })
          if (!res.ok) { if (res.status === 429) continue; throw new Error(`HTTP ${res.status}`) }
          const result = (await res.json()).choices?.[0]?.message?.content || ''
          if (result) return result
        } catch { continue }
      }
      // Gemini fallback
      const parts = [
        { text: `${SYSTEM}\n\nĐọc ảnh scan văn bản Việt Nam${hint} và trả về JSON.` },
        ...base64Images.slice(0, 3).map(b64 => ({ inline_data: { mime_type: 'image/jpeg', data: b64 } }))
      ]
      return await callGemini(parts.map(p => p.text || '').join('\n'), 1000) || ''
    } finally { setLoading(false) }
  }

  // ── analyzeDeepForMemory ──
  const analyzeDeepForMemory = async (text, fileName = '', onStep = null) => {
    setLoading(true)
    resetIdxIfNewDay()
    try {
      return await analyzeFullDocument(text, fileName, onStep)
    } finally { setLoading(false) }
  }

  // ── askDeep: hỏi đáp sâu với RAG ──
  const askDeep = async (question, memory, chatHistory = [], relevantText = '') => {
    setLoading(true)
    resetIdxIfNewDay()

    const ctx = `BỘ NHỚ VĂN BẢN:
📋 Tóm tắt: ${memory.summary || ''}
📌 Điểm quan trọng: ${(memory.keyPoints || []).join('; ')}
👥 Thành viên: ${(memory.members || []).join('; ')}
⚙️ Thông số kỹ thuật: ${(memory.technicalSpecs || []).join('; ')}
💰 Tài chính: ${(memory.financial || []).join('; ')}
⚖️ Pháp lý: ${(memory.legal || []).join('; ')}
📅 Tiến độ: ${(memory.deadlines || []).join('; ')}
📋 Yêu cầu: ${memory.requirements || ''}
⚠️ Rủi ro: ${memory.risks || ''}
📊 Dữ liệu khác: ${(memory.otherData || []).join('; ')}`

    const ragSection = relevantText
      ? `\n📄 ĐOẠN VĂN BẢN GỐC LIÊN QUAN:\n---\n${relevantText}\n---`
      : ''

    const historyCtx = chatHistory.slice(-4).map(m =>
      `${m.role === 'user' ? 'Hỏi' : 'Trả lời'}: ${m.content}`).join('\n')

    const prompt = `Bạn là trợ lý tra cứu văn bản hành chính Việt Nam.

NGUYÊN TẮC:
- Ưu tiên dùng ĐOẠN VĂN BẢN GỐC (nếu có) — chính xác nhất
- Bổ sung từ BỘ NHỚ TỔNG HỢP nếu cần
- Trích dẫn NGUYÊN VĂN câu chữ từ văn bản
- KHÔNG bịa thêm thông tin
- Nếu không có thông tin → nói: "Văn bản không có thông tin này"
${ragSection}

${ctx}
${historyCtx ? '\nLỊCH SỬ:\n' + historyCtx : ''}

CÂU HỎI: ${question}
Trả lời tiếng Việt, chính xác, trích dẫn từ văn bản:`

    try {
      // Gemini → OpenRouter → Groq
      const gem = await callGemini(prompt, 2000)
      if (gem) return gem
      const or = await callOpenRouter(prompt, 2000)
      if (or) return or
      const groq = await callGroq(prompt, 2000)
      if (groq) return groq
      const err = new Error('AI_RATE_LIMIT')
      err.waitSeconds = 30
      throw err
    } finally { setLoading(false) }
  }

  // ── ask: chat thông thường về dự án ──
  const ask = async (question, context = '') => {
    setLoading(true)
    resetIdxIfNewDay()
    const sys = `Bạn là trợ lý quản lý dự án VATM. Trả lời tiếng Việt, chi tiết và hữu ích.${context ? '\n\nDỮ LIỆU DỰ ÁN:\n' + context : ''}`
    try {
      const gem = await callGemini(`${sys}\n\nCâu hỏi: ${question}`, 1200)
      if (gem) return gem
      const or = await callOpenRouter(`${sys}\n\nCâu hỏi: ${question}`, 1200)
      if (or) return or
      const groq = await callGroq(question, 1200, sys)
      if (groq) return groq
      const err = new Error('AI_RATE_LIMIT')
      err.waitSeconds = 30
      throw err
    } finally { setLoading(false) }
  }

  return {
    ask, analyzeText, analyzeImages, analyzeDeepForMemory, askDeep,
    getKey: () => getGroqKeys()[0] || getGemKeys()[0],
    saveKey,
    isReal: () => Boolean(getGroqKeys().length || getGemKeys().length),
    loading,
  }
}