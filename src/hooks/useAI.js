// src/hooks/useAI.js
import { useState } from 'react'

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_TEXT_MODELS  = ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile']
const GROQ_VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct'
const GEMINI_MODELS     = ['gemini-2.0-flash', 'gemini-2.0-flash-lite']
const GEM_URL = (model, key) =>
  `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${key}`

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

const saveKey = (k) => {
  k = k.trim()
  if (k.startsWith('gsk_')) {
    const existing = (localStorage.getItem('groq_key') || '').split(',').map(x=>x.trim()).filter(Boolean)
    if (!existing.includes(k)) existing.push(k)
    localStorage.setItem('groq_key', existing.join(','))
  } else {
    localStorage.setItem('gemini_key', k)
  }
}

const resetIdxIfNewDay = () => {
  const today = new Date().toDateString()
  if (localStorage.getItem('ai_day') !== today) {
    localStorage.setItem('ai_day',      today)
    localStorage.setItem('ai_groq_idx', '0')
    localStorage.setItem('ai_gem_idx',  '0')
  }
}

const SYSTEM = `Bạn là chuyên gia phân tích văn bản hành chính Việt Nam.
Đọc nội dung (3 trang đầu) và trả về JSON duy nhất, không giải thích thêm.
- "code": số ký hiệu dạng "404/NQ-HĐTV"
- "date": CHỈ dạng số D/M/YYYY hoặc M/YYYY (KHÔNG viết chữ, KHÔNG kèm địa danh)
- "org": cơ quan BAN HÀNH
- "docType": Quyết định|Nghị quyết|Công văn|Tờ trình|Báo cáo|Hợp đồng|Biên bản|Thông báo|Hồ sơ|Bản vẽ|Khác
- "subject": câu mô tả NỘI DUNG VỀ VIỆC GÌ
- "detail": tóm tắt 2-3 điểm quan trọng
- "note": 1 câu nhận xét ý nghĩa
- "status": "done" nếu đã ban hành, "prep" nếu chưa
{"code":"","date":"","org":"","docType":"","subject":"","detail":"","note":"","status":"done"}`

// ── GỌI AI ───────────────────────────────────────────────────────────────────
const callAIWithText = async (prompt, maxTokens = 2000) => {
  const groqKeys = (() => {
    const fromEnv = [
      import.meta.env.VITE_GROQ_API_KEY,
      import.meta.env.VITE_GROQ_API_KEY_2,
      import.meta.env.VITE_GROQ_API_KEY_3,
    ].filter(Boolean)
    if (fromEnv.length) return fromEnv
    return (localStorage.getItem('groq_key') || '').split(/[,\n]/).map(k => k.trim()).filter(Boolean)
  })()
  const gemKeys = (() => {
    const fromEnv = [
      import.meta.env.VITE_GEMINI_API_KEY,
      import.meta.env.VITE_GEMINI_API_KEY_2,
      import.meta.env.VITE_GEMINI_API_KEY_3,
    ].filter(Boolean)
    if (fromEnv.length) return fromEnv
    return (localStorage.getItem('gemini_key') || '').split(/[,\n]/).map(k => k.trim()).filter(Boolean)
  })()

  let maxWait = 0
  for (const key of groqKeys) {
    try {
      const res = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: maxTokens, temperature: 0.1,
          messages: [{ role: 'user', content: prompt }],
        }),
      })
      if (res.status === 429) {
        // Lấy thời gian chờ từ header Groq
        const retryAfter = res.headers.get('retry-after') || res.headers.get('x-ratelimit-reset-requests')
        const wait = retryAfter ? Math.ceil(parseFloat(retryAfter)) : 60
        maxWait = Math.max(maxWait, wait)
        continue
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const result = (await res.json()).choices?.[0]?.message?.content || ''
      if (result) return result
    } catch(e) { continue }
  }

  // Thử Gemini fallback
  for (const key of gemKeys) {
    try {
      const res = await fetch(GEM_URL('gemini-2.0-flash', key), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: maxTokens },
        }),
      })
      if (res.status === 429) { await new Promise(r => setTimeout(r, 2000)); continue }
      if (!res.ok) continue
      const result = (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text || ''
      if (result) return result
    } catch(e) { continue }
  }

  // Tất cả đều 429 — throw kèm thời gian chờ
  const waitSecs = maxWait || 60
  const err = new Error('AI_RATE_LIMIT')
  err.waitSeconds = waitSecs
  throw err
}

// ── PROMPT TRÍCH XUẤT CHI TIẾT TỪNG CHUNK ────────────────────────────────────
// Giữ nguyên số liệu, không tóm tắt chung chung
const buildChunkPrompt = (chunk, chunkIdx, totalChunks, fileName) => `
Bạn là chuyên gia trích xuất thông tin văn bản hành chính Việt Nam.
Đây là PHẦN ${chunkIdx}/${totalChunks} của văn bản: "${fileName}"

NHIỆM VỤ: Trích xuất TẤT CẢ thông tin quan trọng trong phần này, GIỮ NGUYÊN số liệu cụ thể, KHÔNG tóm tắt chung chung.

Trả về JSON:
{
  "summary": "mô tả ngắn nội dung phần này (2-3 câu)",
  "keyPoints": ["điểm quan trọng với số liệu cụ thể", "..."],
  "members": ["Họ tên - chức vụ/vai trò", "..."],
  "technicalSpecs": ["thông số kỹ thuật ĐẦY ĐỦ: tên thiết bị + số liệu + đơn vị + tiêu chuẩn", "..."],
  "financial": ["số tiền/chi phí/giá trị ĐẦY ĐỦ với đơn vị + mục đích", "..."],
  "legal": ["điều khoản/quy định/văn bản pháp lý được viện dẫn", "..."],
  "deadlines": ["thời hạn/tiến độ cụ thể + mốc thời gian", "..."],
  "otherData": ["số liệu/dữ kiện quan trọng khác chưa được phân loại ở trên", "..."]
}

Lưu ý quan trọng:
- Giữ NGUYÊN số liệu: "công suất 500KVA" không được viết thành "có quy định về máy phát"
- Giữ NGUYÊN tên người: "Nguyễn Văn A - Tổ trưởng" không được bỏ qua
- Giữ NGUYÊN số tiền: "1.234.567.890 đồng" không được viết thành "có quy định tài chính"
- Nếu không có thông tin cho field nào, để mảng rỗng []

NỘI DUNG PHẦN ${chunkIdx}:
---
${chunk}
---`

// ── PROMPT TỔNG HỢP CUỐI CÙNG ─────────────────────────────────────────────
const buildFinalPrompt = (allChunkData, fileName, totalChunks) => `
Bạn là chuyên gia phân tích văn bản hành chính Việt Nam.
Bạn vừa đọc xong TOÀN BỘ ${totalChunks} phần của văn bản: "${fileName}"

Dưới đây là dữ liệu đã trích xuất từ từng phần (GIỮ NGUYÊN số liệu, không được bỏ bất kỳ thông tin nào):
${allChunkData}

Tổng hợp thành bộ nhớ hoàn chỉnh. Trả về JSON (không giải thích thêm):
{
  "summary": "Tóm tắt tổng quan 10-15 câu bao quát TOÀN BỘ văn bản, đề cập mục tiêu, phạm vi, các nội dung chính",

  "keyPoints": [
    "điểm quan trọng 1 với số liệu cụ thể nếu có",
    "điểm quan trọng 2...",
    "liệt kê TẤT CẢ điểm quan trọng, không giới hạn số lượng"
  ],

  "members": [
    "Họ tên đầy đủ - chức vụ/vai trò/đơn vị",
    "liệt kê TẤT CẢ cá nhân/tổ chức được đề cập"
  ],

  "technicalSpecs": [
    "Tên thiết bị/hệ thống: thông số đầy đủ (công suất, kích thước, tiêu chuẩn, model...)",
    "liệt kê TẤT CẢ thông số kỹ thuật từ toàn bộ văn bản, GIỮ NGUYÊN số liệu"
  ],

  "financial": [
    "Hạng mục: số tiền cụ thể + đơn vị + điều kiện thanh toán",
    "liệt kê TẤT CẢ thông tin tài chính, chi phí, giá trị hợp đồng"
  ],

  "legal": [
    "Tên văn bản pháp lý - số hiệu - nội dung liên quan",
    "liệt kê TẤT CẢ căn cứ pháp lý, điều khoản, quy định được viện dẫn"
  ],

  "deadlines": [
    "Công việc/Hạng mục: thời hạn/ngày cụ thể",
    "liệt kê TẤT CẢ mốc thời gian, tiến độ"
  ],

  "requirements": "Mô tả đầy đủ các yêu cầu, điều kiện, tiêu chuẩn phải đáp ứng",

  "risks": "Rủi ro, điểm cần lưu ý, điều kiện đặc biệt",

  "otherData": [
    "Dữ kiện/số liệu quan trọng khác chưa phân loại ở trên"
  ],

  "keywords": ["từ khóa 1", "từ khóa 2", "tối đa 20 từ khóa đặc trưng của văn bản"]
}`

// ── PHÂN TÍCH TOÀN BỘ VĂN BẢN (CHUNKING + GIỮ NGUYÊN SỐ LIỆU) ──────────────
export const analyzeFullDocument = async (text, fileName = '', onStep = null) => {
  const step = (msg) => { if (onStep) onStep(msg) }
  const CHUNK_SIZE = 10000  // nhỏ hơn để AI đọc kỹ hơn mỗi phần
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{3,}/g, ' ')

  // Văn bản ngắn → phân tích thẳng 1 lần
  if (clean.length <= CHUNK_SIZE) {
    step('🤖 Đang phân tích văn bản...')
    const prompt = buildSingleDocPrompt(clean, fileName)
    return await callAIWithText(prompt, 3000)
  }

  // Chia chunks
  const chunks = []
  for (let i = 0; i < clean.length; i += CHUNK_SIZE) {
    chunks.push(clean.slice(i, i + CHUNK_SIZE))
  }
  step(`📚 Văn bản ${Math.round(clean.length/1000)}K ký tự · Chia thành ${chunks.length} phần · Bắt đầu đọc...`)

  // Đọc từng chunk — giữ nguyên toàn bộ dữ liệu
  const chunkResults = []
  for (let i = 0; i < chunks.length; i++) {
    step(`🔍 Đang đọc và trích xuất phần ${i + 1}/${chunks.length}...`)
    try {
      const prompt = buildChunkPrompt(chunks[i], i + 1, chunks.length, fileName)
      const result = await callAIWithText(prompt, 1500)
      // Giữ kết quả thô — không parse để tránh mất dữ liệu
      chunkResults.push(`=== PHẦN ${i+1}/${chunks.length} ===\n${result}`)
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 1500))
    } catch(e) {
      step(`⚠️ Lỗi phần ${i+1}: ${e.message}`)
      chunkResults.push(`=== PHẦN ${i+1}/${chunks.length} ===\n{"error": "${e.message}"}`)
    }
  }

  // Tổng hợp tất cả thành bộ nhớ hoàn chỉnh
  step(`🧠 Đang tổng hợp dữ liệu từ ${chunks.length} phần thành bộ nhớ hoàn chỉnh...`)
  const allData = chunkResults.join('\n\n')
  const finalPrompt = buildFinalPrompt(allData, fileName, chunks.length)
  const finalResult = await callAIWithText(finalPrompt, 3000)
  step(`✅ Hoàn thành! Đã ghi nhớ toàn bộ ${chunks.length} phần văn bản`)
  return finalResult
}

// ── PROMPT CHO VĂN BẢN NGẮN (1 LẦN) ─────────────────────────────────────────
const buildSingleDocPrompt = (text, fileName) => `
Bạn là chuyên gia phân tích văn bản hành chính Việt Nam.
Phân tích chi tiết và trả về JSON đầy đủ (không giải thích thêm):
{
  "summary": "Tóm tắt tổng quan 8-12 câu",
  "keyPoints": ["điểm quan trọng với số liệu cụ thể", "..."],
  "members": ["Họ tên - chức vụ/vai trò", "..."],
  "technicalSpecs": ["Tên thiết bị: thông số đầy đủ", "..."],
  "financial": ["Hạng mục: số tiền + đơn vị", "..."],
  "legal": ["Văn bản pháp lý - số hiệu - nội dung", "..."],
  "deadlines": ["Công việc: thời hạn cụ thể", "..."],
  "requirements": "yêu cầu và điều kiện đầy đủ",
  "risks": "rủi ro và điểm cần lưu ý",
  "otherData": ["dữ kiện quan trọng khác", "..."],
  "keywords": ["từ khóa 1", "...", "tối đa 20 từ"]
}

Tên file: ${fileName}
NỘI DUNG:
---
${text}
---`

export function useAI() {
  const [loading, setLoading] = useState(false)

  const callGemini = async (model, parts, maxOutputTokens = 1000) => {
    const keys = getGemKeys()
    if (!keys.length) throw new Error('QUOTA')
    for (let i = 0; i < keys.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 2000))
      try {
        const res = await fetch(GEM_URL(model, keys[i]), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: { temperature: 0.1, maxOutputTokens },
          }),
        })
        if (!res.ok) {
          const e = await res.json().catch(() => ({}))
          if (res.status === 429 || res.status === 503 || res.status === 404) continue
          throw new Error(e?.error?.message || `HTTP ${res.status}`)
        }
        return (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text || ''
      } catch(e) { if (!['QUOTA','429','503'].some(s => e.message.includes(s))) throw e }
    }
    throw new Error('QUOTA')
  }

  const callGroqText = async (model, userText) => {
    const keys = getGroqKeys()
    if (!keys.length) throw new Error('QUOTA')
    for (const key of keys) {
      try {
        const res = await fetch(GROQ_URL, {
          method: 'POST',
          headers: { 'Content-Type':'application/json', Authorization:`Bearer ${key}` },
          body: JSON.stringify({
            model, max_tokens:1000, temperature:0.05,
            messages:[{ role:'system', content:SYSTEM },{ role:'user', content:userText }],
          }),
        })
        if (!res.ok) {
          const e = await res.json().catch(() => ({}))
          const msg = e?.error?.message || ''
          if (res.status === 429 || msg.includes('decommissioned') || msg.includes('rate')) continue
          throw new Error(msg || `HTTP ${res.status}`)
        }
        return (await res.json()).choices?.[0]?.message?.content || ''
      } catch(e) { if(e.message !== 'QUOTA') throw e }
    }
    throw new Error('QUOTA')
  }

  const callGroqVision = async (base64Images, hint) => {
    const keys = getGroqKeys()
    if (!keys.length) throw new Error('QUOTA')
    for (const key of keys) {
      try {
        const res = await fetch(GROQ_URL, {
          method: 'POST',
          headers: { 'Content-Type':'application/json', Authorization:`Bearer ${key}` },
          body: JSON.stringify({
            model: GROQ_VISION_MODEL, max_tokens:1000, temperature:0.05,
            messages:[{ role:'user', content:[
              ...base64Images.slice(0,3).map(b64 => ({
                type:'image_url', image_url:{ url:`data:image/jpeg;base64,${b64}` }
              })),
              { type:'text', text:`${SYSTEM}\n\nĐọc ảnh scan văn bản Việt Nam${hint} và trả về JSON.` }
            ]}],
          }),
        })
        if (!res.ok) { if (res.status === 429) continue; throw new Error(`HTTP ${res.status}`) }
        return (await res.json()).choices?.[0]?.message?.content || ''
      } catch(e) { if(e.message !== 'QUOTA') throw e }
    }
    throw new Error('QUOTA')
  }

  const analyzeText = async (text, fileName = '') => {
    setLoading(true)
    resetIdxIfNewDay()
    const hint  = fileName ? `\nTên file: ${fileName}` : ''
    const clean = text.replace(/\r\n/g,'\n').replace(/\n{3,}/g,'\n\n').replace(/[ \t]{3,}/g,' ').slice(0,6000)
    const prompt = `Phân tích văn bản (3 trang đầu):${hint}\n\n---\n${clean}\n---`
    try {
      for (const model of GEMINI_MODELS) {
        try { return await callGemini(model, [{ text:`${SYSTEM}\n\n${prompt}` }]) } catch(e) { if(e.message !== 'QUOTA') throw e }
      }
      for (const model of GROQ_TEXT_MODELS) {
        try { return await callGroqText(model, prompt) } catch(e) { if(e.message !== 'QUOTA') throw e }
      }
      throw new Error('AI_QUOTA')
    } finally { setLoading(false) }
  }

  const analyzeImages = async (base64Images, fileName = '') => {
    setLoading(true)
    resetIdxIfNewDay()
    const hint = fileName ? ` (${fileName})` : ''
    try {
      if (getGroqKeys().length) {
        try { return await callGroqVision(base64Images, hint) } catch(e) { if(e.message !== 'QUOTA') throw e }
      }
      for (const model of GEMINI_MODELS) {
        try {
          const parts = [
            { text:`${SYSTEM}\n\nĐọc ảnh scan văn bản Việt Nam${hint} và trả về JSON.` },
            ...base64Images.slice(0,3).map(b64 => ({ inline_data:{ mime_type:'image/jpeg', data:b64 } }))
          ]
          return await callGemini(model, parts)
        } catch(e) { if(e.message !== 'QUOTA') throw e }
      }
      throw new Error('AI_QUOTA')
    } finally { setLoading(false) }
  }

  const analyzeDeepForMemory = async (text, fileName = '', onStep = null) => {
    setLoading(true)
    resetIdxIfNewDay()
    try {
      return await analyzeFullDocument(text, fileName, onStep)
    } finally { setLoading(false) }
  }

  // ── Hỏi đáp sâu — dùng toàn bộ bộ nhớ mở rộng ──
  const askDeep = async (question, memory, chatHistory = [], relevantText = '') => {
    setLoading(true)
    resetIdxIfNewDay()

    const ctx = `BỘ NHỚ VĂN BẢN ĐẦY ĐỦ:
📋 Tóm tắt: ${memory.summary || ''}
📌 Điểm quan trọng: ${(memory.keyPoints || []).join('; ')}
👥 Thành viên/Đơn vị: ${(memory.members || []).join('; ')}
⚙️ Thông số kỹ thuật: ${(memory.technicalSpecs || []).join('; ')}
💰 Tài chính: ${(memory.financial || []).join('; ')}
⚖️ Pháp lý: ${(memory.legal || []).join('; ')}
📅 Tiến độ/Thời hạn: ${(memory.deadlines || []).join('; ')}
📋 Yêu cầu: ${memory.requirements || ''}
⚠️ Rủi ro: ${memory.risks || ''}
📊 Dữ liệu khác: ${(memory.otherData || []).join('; ')}
🔑 Từ khóa: ${(memory.keywords || []).join(', ')}`

    const historyCtx = chatHistory.slice(-4).map(m =>
      `${m.role==='user'?'Hỏi':'Trả lời'}: ${m.content}`).join('\n')

    const ragSection = relevantText
      ? `\n📄 ĐOẠN VĂN BẢN GỐC LIÊN QUAN ĐẾN CÂU HỎI (ưu tiên dùng):
---
${relevantText}
---`
      : ''

    const prompt = `Bạn là trợ lý tra cứu văn bản hành chính Việt Nam.

NGUYÊN TẮC:
- Ưu tiên dùng ĐOẠN VĂN BẢN GỐC bên dưới (nếu có) — đây là nội dung CHÍNH XÁC nhất
- Bổ sung từ BỘ NHỚ TỔNG HỢP nếu cần thêm thông tin
- Trích dẫn NGUYÊN VĂN câu chữ từ văn bản gốc
- KHÔNG bịa thêm thông tin ngoài 2 nguồn trên
- Nếu cả 2 nguồn đều không có → nói: "Văn bản không có thông tin này"
${ragSection}

${ctx}
${historyCtx ? '\nLỊCH SỬ HỘI THOẠI:\n' + historyCtx : ''}

CÂU HỎI: ${question}
Trả lời tiếng Việt, chính xác, trích dẫn từ văn bản:`

    try {
      // Thử Groq trước, nếu 429 → chuyển Gemini ngay không chờ
      for (const key of getGroqKeys()) {
        try {
          const res = await fetch(GROQ_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify({
              model: 'llama-3.3-70b-versatile',
              max_tokens: 2000, temperature: 0.1,
              messages: [{ role: 'user', content: prompt }],
            }),
          })
          if (res.status === 429) continue // thử key khác ngay
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const result = (await res.json()).choices?.[0]?.message?.content || ''
          if (result) return result
        } catch(e) { continue }
      }

      // Groq đều 429 → Gemini ngay (không delay 5s)
      for (const key of getGemKeys()) {
        try {
          const res = await fetch(GEM_URL('gemini-2.0-flash', key), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.1, maxOutputTokens: 2000 },
            }),
          })
          if (res.status === 429) continue
          if (!res.ok) continue
          const result = (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text || ''
          if (result) return result
        } catch(e) { continue }
      }

      const err = new Error('AI_RATE_LIMIT')
      err.waitSeconds = 30
      throw err
    } finally { setLoading(false) }
  }

  const ask = async (question, context = '') => {
    setLoading(true)
    resetIdxIfNewDay()
    const sys = `Bạn là trợ lý quản lý dự án VATM. Trả lời tiếng Việt, chi tiết và hữu ích.${context?'\n\nDỮ LIỆU DỰ ÁN:\n'+context:''}`
    try {
      for (const key of getGroqKeys()) {
        try {
          const res = await fetch(GROQ_URL, {
            method:'POST',
            headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${key}` },
            body:JSON.stringify({ model:'llama-3.3-70b-versatile', max_tokens:1200, temperature:0.1,
              messages:[{role:'system',content:sys},{role:'user',content:question}] }),
          })
          if (res.status===429) { await new Promise(r=>setTimeout(r,1500)); continue }
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return (await res.json()).choices?.[0]?.message?.content || ''
        } catch(e) { continue }
      }
      await new Promise(r => setTimeout(r, 5000))
      for (const key of getGemKeys()) {
        try {
          const res = await fetch(GEM_URL('gemini-2.0-flash', key), {
            method:'POST', headers:{'Content-Type':'application/json'},
            body:JSON.stringify({ contents:[{parts// src/hooks/useAI.js
import { useState } from 'react'

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_TEXT_MODELS  = ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile']
const GROQ_VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct'
const GEMINI_MODELS     = ['gemini-2.0-flash', 'gemini-2.0-flash-lite']
const GEM_URL = (model, key) =>
  `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${key}`

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

const saveKey = (k) => {
  k = k.trim()
  if (k.startsWith('gsk_')) {
    const existing = (localStorage.getItem('groq_key') || '').split(',').map(x=>x.trim()).filter(Boolean)
    if (!existing.includes(k)) existing.push(k)
    localStorage.setItem('groq_key', existing.join(','))
  } else {
    localStorage.setItem('gemini_key', k)
  }
}

const resetIdxIfNewDay = () => {
  const today = new Date().toDateString()
  if (localStorage.getItem('ai_day') !== today) {
    localStorage.setItem('ai_day',      today)
    localStorage.setItem('ai_groq_idx', '0')
    localStorage.setItem('ai_gem_idx',  '0')
  }
}

const SYSTEM = `Bạn là chuyên gia phân tích văn bản hành chính Việt Nam.
Đọc nội dung (3 trang đầu) và trả về JSON duy nhất, không giải thích thêm.
- "code": số ký hiệu dạng "404/NQ-HĐTV"
- "date": CHỈ dạng số D/M/YYYY hoặc M/YYYY (KHÔNG viết chữ, KHÔNG kèm địa danh)
- "org": cơ quan BAN HÀNH
- "docType": Quyết định|Nghị quyết|Công văn|Tờ trình|Báo cáo|Hợp đồng|Biên bản|Thông báo|Hồ sơ|Bản vẽ|Khác
- "subject": câu mô tả NỘI DUNG VỀ VIỆC GÌ
- "detail": tóm tắt 2-3 điểm quan trọng
- "note": 1 câu nhận xét ý nghĩa
- "status": "done" nếu đã ban hành, "prep" nếu chưa
{"code":"","date":"","org":"","docType":"","subject":"","detail":"","note":"","status":"done"}`

// ── GỌI AI ───────────────────────────────────────────────────────────────────
const callAIWithText = async (prompt, maxTokens = 2000, preferGemini = false) => {
  const groqKeys = (() => {
    const fromEnv = [
      import.meta.env.VITE_GROQ_API_KEY,
      import.meta.env.VITE_GROQ_API_KEY_2,
      import.meta.env.VITE_GROQ_API_KEY_3,
    ].filter(Boolean)
    if (fromEnv.length) return fromEnv
    return (localStorage.getItem('groq_key') || '').split(/[,\n]/).map(k => k.trim()).filter(Boolean)
  })()
  const gemKeys = (() => {
    const fromEnv = [
      import.meta.env.VITE_GEMINI_API_KEY,
      import.meta.env.VITE_GEMINI_API_KEY_2,
      import.meta.env.VITE_GEMINI_API_KEY_3,
    ].filter(Boolean)
    if (fromEnv.length) return fromEnv
    return (localStorage.getItem('gemini_key') || '').split(/[,\n]/).map(k => k.trim()).filter(Boolean)
  })()

  // Nếu ưu tiên Gemini (chunking) → thử Gemini trước
  if (preferGemini) {
    for (const key of gemKeys) {
      try {
        const res = await fetch(GEM_URL('gemini-2.0-flash', key), {
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
      } catch(e) { continue }
    }
  }

  let maxWait = 0
  for (const key of groqKeys) {
    try {
      const res = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: maxTokens, temperature: 0.1,
          messages: [{ role: 'user', content: prompt }],
        }),
      })
      if (res.status === 429) {
        // Lấy thời gian chờ từ header Groq
        const retryAfter = res.headers.get('retry-after') || res.headers.get('x-ratelimit-reset-requests')
        const wait = retryAfter ? Math.ceil(parseFloat(retryAfter)) : 60
        maxWait = Math.max(maxWait, wait)
        continue
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const result = (await res.json()).choices?.[0]?.message?.content || ''
      if (result) return result
    } catch(e) { continue }
  }

  // Thử Gemini fallback
  for (const key of gemKeys) {
    try {
      const res = await fetch(GEM_URL('gemini-2.0-flash', key), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: maxTokens },
        }),
      })
      if (res.status === 429) { await new Promise(r => setTimeout(r, 2000)); continue }
      if (!res.ok) continue
      const result = (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text || ''
      if (result) return result
    } catch(e) { continue }
  }

  // Tất cả đều 429 — throw kèm thời gian chờ
  const waitSecs = maxWait || 60
  const err = new Error('AI_RATE_LIMIT')
  err.waitSeconds = waitSecs
  throw err
}

// ── PROMPT TRÍCH XUẤT CHI TIẾT TỪNG CHUNK ────────────────────────────────────
// Giữ nguyên số liệu, không tóm tắt chung chung
const buildChunkPrompt = (chunk, chunkIdx, totalChunks, fileName) => `
Bạn là chuyên gia trích xuất thông tin văn bản hành chính Việt Nam.
Đây là PHẦN ${chunkIdx}/${totalChunks} của văn bản: "${fileName}"

NHIỆM VỤ: Trích xuất TẤT CẢ thông tin quan trọng trong phần này, GIỮ NGUYÊN số liệu cụ thể, KHÔNG tóm tắt chung chung.

Trả về JSON:
{
  "summary": "mô tả ngắn nội dung phần này (2-3 câu)",
  "keyPoints": ["điểm quan trọng với số liệu cụ thể", "..."],
  "members": ["Họ tên - chức vụ/vai trò", "..."],
  "technicalSpecs": ["thông số kỹ thuật ĐẦY ĐỦ: tên thiết bị + số liệu + đơn vị + tiêu chuẩn", "..."],
  "financial": ["số tiền/chi phí/giá trị ĐẦY ĐỦ với đơn vị + mục đích", "..."],
  "legal": ["điều khoản/quy định/văn bản pháp lý được viện dẫn", "..."],
  "deadlines": ["thời hạn/tiến độ cụ thể + mốc thời gian", "..."],
  "otherData": ["số liệu/dữ kiện quan trọng khác chưa được phân loại ở trên", "..."]
}

Lưu ý quan trọng:
- Giữ NGUYÊN số liệu: "công suất 500KVA" không được viết thành "có quy định về máy phát"
- Giữ NGUYÊN tên người: "Nguyễn Văn A - Tổ trưởng" không được bỏ qua
- Giữ NGUYÊN số tiền: "1.234.567.890 đồng" không được viết thành "có quy định tài chính"
- Nếu không có thông tin cho field nào, để mảng rỗng []

NỘI DUNG PHẦN ${chunkIdx}:
---
${chunk}
---`

// ── PROMPT TỔNG HỢP CUỐI CÙNG ─────────────────────────────────────────────
const buildFinalPrompt = (allChunkData, fileName, totalChunks) => `
Bạn là chuyên gia phân tích văn bản hành chính Việt Nam.
Bạn vừa đọc xong TOÀN BỘ ${totalChunks} phần của văn bản: "${fileName}"

Dưới đây là dữ liệu đã trích xuất từ từng phần (GIỮ NGUYÊN số liệu, không được bỏ bất kỳ thông tin nào):
${allChunkData}

Tổng hợp thành bộ nhớ hoàn chỉnh. Trả về JSON (không giải thích thêm):
{
  "summary": "Tóm tắt tổng quan 10-15 câu bao quát TOÀN BỘ văn bản, đề cập mục tiêu, phạm vi, các nội dung chính",

  "keyPoints": [
    "điểm quan trọng 1 với số liệu cụ thể nếu có",
    "điểm quan trọng 2...",
    "liệt kê TẤT CẢ điểm quan trọng, không giới hạn số lượng"
  ],

  "members": [
    "Họ tên đầy đủ - chức vụ/vai trò/đơn vị",
    "liệt kê TẤT CẢ cá nhân/tổ chức được đề cập"
  ],

  "technicalSpecs": [
    "Tên thiết bị/hệ thống: thông số đầy đủ (công suất, kích thước, tiêu chuẩn, model...)",
    "liệt kê TẤT CẢ thông số kỹ thuật từ toàn bộ văn bản, GIỮ NGUYÊN số liệu"
  ],

  "financial": [
    "Hạng mục: số tiền cụ thể + đơn vị + điều kiện thanh toán",
    "liệt kê TẤT CẢ thông tin tài chính, chi phí, giá trị hợp đồng"
  ],

  "legal": [
    "Tên văn bản pháp lý - số hiệu - nội dung liên quan",
    "liệt kê TẤT CẢ căn cứ pháp lý, điều khoản, quy định được viện dẫn"
  ],

  "deadlines": [
    "Công việc/Hạng mục: thời hạn/ngày cụ thể",
    "liệt kê TẤT CẢ mốc thời gian, tiến độ"
  ],

  "requirements": "Mô tả đầy đủ các yêu cầu, điều kiện, tiêu chuẩn phải đáp ứng",

  "risks": "Rủi ro, điểm cần lưu ý, điều kiện đặc biệt",

  "otherData": [
    "Dữ kiện/số liệu quan trọng khác chưa phân loại ở trên"
  ],

  "keywords": ["từ khóa 1", "từ khóa 2", "tối đa 20 từ khóa đặc trưng của văn bản"]
}`

// ── PHÂN TÍCH TOÀN BỘ VĂN BẢN (CHUNKING + GIỮ NGUYÊN SỐ LIỆU) ──────────────
export const analyzeFullDocument = async (text, fileName = '', onStep = null) => {
  const step = (msg) => { if (onStep) onStep(msg) }
  const CHUNK_SIZE = 10000  // nhỏ hơn để AI đọc kỹ hơn mỗi phần
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{3,}/g, ' ')

  // Văn bản ngắn → phân tích thẳng 1 lần
  if (clean.length <= CHUNK_SIZE) {
    step('🤖 Đang phân tích văn bản...')
    const prompt = buildSingleDocPrompt(clean, fileName)
    return await callAIWithText(prompt, 3000, true) // Gemini ưu tiên
  }

  // Chia chunks
  const chunks = []
  for (let i = 0; i < clean.length; i += CHUNK_SIZE) {
    chunks.push(clean.slice(i, i + CHUNK_SIZE))
  }
  step(`📚 Văn bản ${Math.round(clean.length/1000)}K ký tự · Chia thành ${chunks.length} phần · Bắt đầu đọc...`)

  // Đọc từng chunk — giữ nguyên toàn bộ dữ liệu
  const chunkResults = []
  for (let i = 0; i < chunks.length; i++) {
    step(`🔍 Đang đọc và trích xuất phần ${i + 1}/${chunks.length}...`)
    try {
      const prompt = buildChunkPrompt(chunks[i], i + 1, chunks.length, fileName)
      const result = await callAIWithText(prompt, 1500, true) // Gemini cho chunk
      // Giữ kết quả thô — không parse để tránh mất dữ liệu
      chunkResults.push(`=== PHẦN ${i+1}/${chunks.length} ===\n${result}`)
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 2000))
    } catch(e) {
      step(`⚠️ Lỗi phần ${i+1}: ${e.message}`)
      chunkResults.push(`=== PHẦN ${i+1}/${chunks.length} ===\n{"error": "${e.message}"}`)
    }
  }

  // Tổng hợp tất cả thành bộ nhớ hoàn chỉnh
  step(`🧠 Đang tổng hợp dữ liệu từ ${chunks.length} phần thành bộ nhớ hoàn chỉnh...`)
  const allData = chunkResults.join('\n\n')
  const finalPrompt = buildFinalPrompt(allData, fileName, chunks.length)
  const finalResult = await callAIWithText(finalPrompt, 3000, true) // Gemini cho tổng hợp
  step(`✅ Hoàn thành! Đã ghi nhớ toàn bộ ${chunks.length} phần văn bản`)
  return finalResult
}

// ── PROMPT CHO VĂN BẢN NGẮN (1 LẦN) ─────────────────────────────────────────
const buildSingleDocPrompt = (text, fileName) => `
Bạn là chuyên gia phân tích văn bản hành chính Việt Nam.
Phân tích chi tiết và trả về JSON đầy đủ (không giải thích thêm):
{
  "summary": "Tóm tắt tổng quan 8-12 câu",
  "keyPoints": ["điểm quan trọng với số liệu cụ thể", "..."],
  "members": ["Họ tên - chức vụ/vai trò", "..."],
  "technicalSpecs": ["Tên thiết bị: thông số đầy đủ", "..."],
  "financial": ["Hạng mục: số tiền + đơn vị", "..."],
  "legal": ["Văn bản pháp lý - số hiệu - nội dung", "..."],
  "deadlines": ["Công việc: thời hạn cụ thể", "..."],
  "requirements": "yêu cầu và điều kiện đầy đủ",
  "risks": "rủi ro và điểm cần lưu ý",
  "otherData": ["dữ kiện quan trọng khác", "..."],
  "keywords": ["từ khóa 1", "...", "tối đa 20 từ"]
}

Tên file: ${fileName}
NỘI DUNG:
---
${text}
---`

export function useAI() {
  const [loading, setLoading] = useState(false)

  const callGemini = async (model, parts, maxOutputTokens = 1000) => {
    const keys = getGemKeys()
    if (!keys.length) throw new Error('QUOTA')
    for (let i = 0; i < keys.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 2000))
      try {
        const res = await fetch(GEM_URL(model, keys[i]), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: { temperature: 0.1, maxOutputTokens },
          }),
        })
        if (!res.ok) {
          const e = await res.json().catch(() => ({}))
          if (res.status === 429 || res.status === 503 || res.status === 404) continue
          throw new Error(e?.error?.message || `HTTP ${res.status}`)
        }
        return (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text || ''
      } catch(e) { if (!['QUOTA','429','503'].some(s => e.message.includes(s))) throw e }
    }
    throw new Error('QUOTA')
  }

  const callGroqText = async (model, userText) => {
    const keys = getGroqKeys()
    if (!keys.length) throw new Error('QUOTA')
    for (const key of keys) {
      try {
        const res = await fetch(GROQ_URL, {
          method: 'POST',
          headers: { 'Content-Type':'application/json', Authorization:`Bearer ${key}` },
          body: JSON.stringify({
            model, max_tokens:1000, temperature:0.05,
            messages:[{ role:'system', content:SYSTEM },{ role:'user', content:userText }],
          }),
        })
        if (!res.ok) {
          const e = await res.json().catch(() => ({}))
          const msg = e?.error?.message || ''
          if (res.status === 429 || msg.includes('decommissioned') || msg.includes('rate')) continue
          throw new Error(msg || `HTTP ${res.status}`)
        }
        return (await res.json()).choices?.[0]?.message?.content || ''
      } catch(e) { if(e.message !== 'QUOTA') throw e }
    }
    throw new Error('QUOTA')
  }

  const callGroqVision = async (base64Images, hint) => {
    const keys = getGroqKeys()
    if (!keys.length) throw new Error('QUOTA')
    for (const key of keys) {
      try {
        const res = await fetch(GROQ_URL, {
          method: 'POST',
          headers: { 'Content-Type':'application/json', Authorization:`Bearer ${key}` },
          body: JSON.stringify({
            model: GROQ_VISION_MODEL, max_tokens:1000, temperature:0.05,
            messages:[{ role:'user', content:[
              ...base64Images.slice(0,3).map(b64 => ({
                type:'image_url', image_url:{ url:`data:image/jpeg;base64,${b64}` }
              })),
              { type:'text', text:`${SYSTEM}\n\nĐọc ảnh scan văn bản Việt Nam${hint} và trả về JSON.` }
            ]}],
          }),
        })
        if (!res.ok) { if (res.status === 429) continue; throw new Error(`HTTP ${res.status}`) }
        return (await res.json()).choices?.[0]?.message?.content || ''
      } catch(e) { if(e.message !== 'QUOTA') throw e }
    }
    throw new Error('QUOTA')
  }

  const analyzeText = async (text, fileName = '') => {
    setLoading(true)
    resetIdxIfNewDay()
    const hint  = fileName ? `\nTên file: ${fileName}` : ''
    const clean = text.replace(/\r\n/g,'\n').replace(/\n{3,}/g,'\n\n').replace(/[ \t]{3,}/g,' ').slice(0,6000)
    const prompt = `Phân tích văn bản (3 trang đầu):${hint}\n\n---\n${clean}\n---`
    try {
      for (const model of GEMINI_MODELS) {
        try { return await callGemini(model, [{ text:`${SYSTEM}\n\n${prompt}` }]) } catch(e) { if(e.message !== 'QUOTA') throw e }
      }
      for (const model of GROQ_TEXT_MODELS) {
        try { return await callGroqText(model, prompt) } catch(e) { if(e.message !== 'QUOTA') throw e }
      }
      throw new Error('AI_QUOTA')
    } finally { setLoading(false) }
  }

  const analyzeImages = async (base64Images, fileName = '') => {
    setLoading(true)
    resetIdxIfNewDay()
    const hint = fileName ? ` (${fileName})` : ''
    try {
      if (getGroqKeys().length) {
        try { return await callGroqVision(base64Images, hint) } catch(e) { if(e.message !== 'QUOTA') throw e }
      }
      for (const model of GEMINI_MODELS) {
        try {
          const parts = [
            { text:`${SYSTEM}\n\nĐọc ảnh scan văn bản Việt Nam${hint} và trả về JSON.` },
            ...base64Images.slice(0,3).map(b64 => ({ inline_data:{ mime_type:'image/jpeg', data:b64 } }))
          ]
          return await callGemini(model, parts)
        } catch(e) { if(e.message !== 'QUOTA') throw e }
      }
      throw new Error('AI_QUOTA')
    } finally { setLoading(false) }
  }

  const analyzeDeepForMemory = async (text, fileName = '', onStep = null) => {
    setLoading(true)
    resetIdxIfNewDay()
    try {
      return await analyzeFullDocument(text, fileName, onStep)
    } finally { setLoading(false) }
  }

  // ── Hỏi đáp sâu — dùng toàn bộ bộ nhớ mở rộng ──
  const askDeep = async (question, memory, chatHistory = [], relevantText = '') => {
    setLoading(true)
    resetIdxIfNewDay()

    const ctx = `BỘ NHỚ VĂN BẢN ĐẦY ĐỦ:
📋 Tóm tắt: ${memory.summary || ''}
📌 Điểm quan trọng: ${(memory.keyPoints || []).join('; ')}
👥 Thành viên/Đơn vị: ${(memory.members || []).join('; ')}
⚙️ Thông số kỹ thuật: ${(memory.technicalSpecs || []).join('; ')}
💰 Tài chính: ${(memory.financial || []).join('; ')}
⚖️ Pháp lý: ${(memory.legal || []).join('; ')}
📅 Tiến độ/Thời hạn: ${(memory.deadlines || []).join('; ')}
📋 Yêu cầu: ${memory.requirements || ''}
⚠️ Rủi ro: ${memory.risks || ''}
📊 Dữ liệu khác: ${(memory.otherData || []).join('; ')}
🔑 Từ khóa: ${(memory.keywords || []).join(', ')}`

    const historyCtx = chatHistory.slice(-4).map(m =>
      `${m.role==='user'?'Hỏi':'Trả lời'}: ${m.content}`).join('\n')

    const ragSection = relevantText
      ? `\n📄 ĐOẠN VĂN BẢN GỐC LIÊN QUAN ĐẾN CÂU HỎI (ưu tiên dùng):
---
${relevantText}
---`
      : ''

    const prompt = `Bạn là trợ lý tra cứu văn bản hành chính Việt Nam.

NGUYÊN TẮC:
- Ưu tiên dùng ĐOẠN VĂN BẢN GỐC bên dưới (nếu có) — đây là nội dung CHÍNH XÁC nhất
- Bổ sung từ BỘ NHỚ TỔNG HỢP nếu cần thêm thông tin
- Trích dẫn NGUYÊN VĂN câu chữ từ văn bản gốc
- KHÔNG bịa thêm thông tin ngoài 2 nguồn trên
- Nếu cả 2 nguồn đều không có → nói: "Văn bản không có thông tin này"
${ragSection}

${ctx}
${historyCtx ? '\nLỊCH SỬ HỘI THOẠI:\n' + historyCtx : ''}

CÂU HỎI: ${question}
Trả lời tiếng Việt, chính xác, trích dẫn từ văn bản:`

    try {
      // Thử Groq trước, nếu 429 → chuyển Gemini ngay không chờ
      for (const key of getGroqKeys()) {
        try {
          const res = await fetch(GROQ_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify({
              model: 'llama-3.3-70b-versatile',
              max_tokens: 2000, temperature: 0.1,
              messages: [{ role: 'user', content: prompt }],
            }),
          })
          if (res.status === 429) continue // thử key khác ngay
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const result = (await res.json()).choices?.[0]?.message?.content || ''
          if (result) return result
        } catch(e) { continue }
      }

      // Groq đều 429 → Gemini ngay (không delay 5s)
      for (const key of getGemKeys()) {
        try {
          const res = await fetch(GEM_URL('gemini-2.0-flash', key), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.1, maxOutputTokens: 2000 },
            }),
          })
          if (res.status === 429) continue
          if (!res.ok) continue
          const result = (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text || ''
          if (result) return result
        } catch(e) { continue }
      }

      const err = new Error('AI_RATE_LIMIT')
      err.waitSeconds = 30
      throw err
    } finally { setLoading(false) }
  }

  const ask = async (question, context = '') => {
    setLoading(true)
    resetIdxIfNewDay()
    const sys = `Bạn là trợ lý quản lý dự án VATM. Trả lời tiếng Việt, chi tiết và hữu ích.${context?'\n\nDỮ LIỆU DỰ ÁN:\n'+context:''}`
    try {
      for (const key of getGroqKeys()) {
        try {
          const res = await fetch(GROQ_URL, {
            method:'POST',
            headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${key}` },
            body:JSON.stringify({ model:'llama-3.3-70b-versatile', max_tokens:1200, temperature:0.1,
              messages:[{role:'system',content:sys},{role:'user',content:question}] }),
          })
          if (res.status===429) { await new Promise(r=>setTimeout(r,1500)); continue }
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return (await res.json()).choices?.[0]?.message?.content || ''
        } catch(e) { continue }
      }
      await new Promise(r => setTimeout(r, 5000))
      for (const key of getGemKeys()) {
        try {
          const res = await fetch(GEM_URL('gemini-2.0-flash', key), {
            method:'POST', headers:{'Content-Type':'application/json'},
            body:JSON.stringify({ contents:[{parts:[{text:`${sys}\n\nCâu hỏi: ${question}`}]}],
              generationConfig:{temperature:0.1,maxOutputTokens:1200} }),
          })
          if (res.status===429) { await new Promise(r=>setTimeout(r,3000)); continue }
          if (!res.ok) continue
          return (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text || ''
        } catch(e) { continue }
      }
      throw new Error('AI_QUOTA')
    } finally { setLoading(false) }
  }

  return {
    ask, analyzeText, analyzeImages, analyzeDeepForMemory, askDeep,
    getKey: () => getGroqKeys()[0] || getGemKeys()[0],
    saveKey, isReal: () => Boolean(getGroqKeys().length || getGemKeys().length),
    loading,
  }
}:[{text:`${sys}\n\nCâu hỏi: ${question}`}]}],
              generationConfig:{temperature:0.1,maxOutputTokens:1200} }),
          })
          if (res.status===429) { await new Promise(r=>setTimeout(r,3000)); continue }
          if (!res.ok) continue
          return (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text || ''
        } catch(e) { continue }
      }
      throw new Error('AI_QUOTA')
    } finally { setLoading(false) }
  }

  return {
    ask, analyzeText, analyzeImages, analyzeDeepForMemory, askDeep,
    getKey: () => getGroqKeys()[0] || getGemKeys()[0],
    saveKey, isReal: () => Boolean(getGroqKeys().length || getGemKeys().length),
    loading,
  }
}