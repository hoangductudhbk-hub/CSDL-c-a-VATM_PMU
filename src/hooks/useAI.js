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

// ── ĐỌC TOÀN BỘ FILE TỪ GITHUB QUA PROXY ────────────────────────────────────
export const readFileViaProxy = async (fileUrl, fileName = '', onStep = null) => {
  const step = (msg) => { if (onStep) onStep(msg) }
  const ext = (fileName || fileUrl).split('.').pop().toLowerCase()

  step('📥 Đang tải file qua proxy...')

  const proxyUrl = `/api/read-file?url=${encodeURIComponent(fileUrl)}`
  const res = await fetch(proxyUrl)
  if (!res.ok) throw new Error(`Proxy lỗi ${res.status}`)
  const { base64, size } = await res.json()
  if (!base64) throw new Error('Proxy không trả về dữ liệu')

  step(`✅ Đã tải ${Math.round(size / 1024)}KB · Đang trích xuất text...`)

  // ── PDF → đọc TOÀN BỘ trang, không giới hạn ──
  if (ext === 'pdf') {
    try {
      if (!window.pdfjsLib) {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script')
          script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
          script.onload = resolve
          script.onerror = reject
          document.head.appendChild(script)
        })
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
      }

      const binary = atob(base64)
      const bytes  = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

      const pdf   = await window.pdfjsLib.getDocument({ data: bytes }).promise
      const total = pdf.numPages
      let text = ''

      // Đọc TẤT CẢ trang — không giới hạn
      for (let p = 1; p <= total; p++) {
        step(`📄 Đang đọc trang ${p}/${total}...`)
        const page    = await pdf.getPage(p)
        const content = await page.getTextContent()
        text += content.items.map(i => i.str).join(' ') + '\n'
      }

      if (text.trim().length < 100) {
        step('⚠️ PDF là file scan ảnh — không có text')
        return ''
      }
      step(`✅ Đọc xong toàn bộ ${total} trang · ${text.length} ký tự`)
      return text.trim()

    } catch(e) {
      step('⚠️ Lỗi đọc PDF: ' + e.message)
      return ''
    }
  }

  // ── DOCX → dùng mammoth, đọc toàn bộ ──
  if (ext === 'docx' || ext === 'doc') {
    try {
      if (!window.mammoth) {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script')
          script.src = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js'
          script.onload = resolve
          script.onerror = reject
          document.head.appendChild(script)
        })
      }
      const binary = atob(base64)
      const bytes  = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const result = await window.mammoth.extractRawText({ arrayBuffer: bytes.buffer })
      step(`✅ Đọc xong toàn bộ Word · ${result.value.length} ký tự`)
      return result.value.trim()
    } catch(e) {
      step('⚠️ Lỗi đọc Word: ' + e.message)
      return ''
    }
  }

  // ── TXT / CSV ──
  if (['txt','csv'].includes(ext)) {
    try {
      const text = decodeURIComponent(escape(atob(base64)))
      step(`✅ Đọc xong · ${text.length} ký tự`)
      return text
    } catch { return atob(base64) }
  }

  step('⚠️ Định dạng chưa hỗ trợ: ' + ext)
  return ''
}

// ── GỌI AI 1 CHUNK ────────────────────────────────────────────────────────────
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

  // Groq trước
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
      if (res.status === 429) { await new Promise(r => setTimeout(r, 3000)); continue }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const result = (await res.json()).choices?.[0]?.message?.content || ''
      if (result) return result
    } catch(e) { continue }
  }

  // Gemini fallback
  await new Promise(r => setTimeout(r, 5000))
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
      if (res.status === 429) { await new Promise(r => setTimeout(r, 3000)); continue }
      if (!res.ok) continue
      const result = (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text || ''
      if (result) return result
    } catch(e) { continue }
  }
  throw new Error('Tất cả AI đang bận!')
}

// ── PHÂN TÍCH TOÀN BỘ VĂN BẢN DÀI BẰNG CHUNKING ────────────────────────────
// Tự động chia chunk → AI đọc từng phần → gộp thành 1 bộ nhớ hoàn chỉnh
export const analyzeFullDocument = async (text, fileName = '', onStep = null) => {
  const step = (msg) => { if (onStep) onStep(msg) }
  const CHUNK_SIZE = 12000  // ~6 trang mỗi chunk
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{3,}/g, ' ')

  // Nếu text ngắn → phân tích thẳng, không cần chunk
  if (clean.length <= CHUNK_SIZE) {
    step('📝 Văn bản ngắn · Phân tích trực tiếp...')
    const prompt = buildDeepPrompt(clean, fileName)
    const result = await callAIWithText(prompt, 2000)
    return result
  }

  // Chia thành nhiều chunk
  const chunks = []
  for (let i = 0; i < clean.length; i += CHUNK_SIZE) {
    chunks.push(clean.slice(i, i + CHUNK_SIZE))
  }

  step(`📚 Văn bản dài ${Math.round(clean.length/1000)}K ký tự · Chia thành ${chunks.length} phần`)

  // AI đọc từng chunk → lấy tóm tắt ngắn
  const chunkSummaries = []
  for (let i = 0; i < chunks.length; i++) {
    step(`🔍 AI đang đọc phần ${i + 1}/${chunks.length}...`)
    try {
      const prompt = `Đây là PHẦN ${i+1}/${chunks.length} của văn bản "${fileName}".
Tóm tắt ngắn gọn phần này (3-5 điểm quan trọng, chỉ liệt kê, không giải thích dài):
---
${chunks[i]}
---
Trả về dạng JSON: {"points": ["điểm 1", "điểm 2", ...]}`

      const result = await callAIWithText(prompt, 800)
      // Parse điểm từ kết quả
      const match = result.match(/\{[\s\S]*\}/)
      if (match) {
        const parsed = JSON.parse(match[0])
        chunkSummaries.push(...(parsed.points || []))
      } else {
        chunkSummaries.push(`Phần ${i+1}: ${result.slice(0, 300)}`)
      }
      // Delay nhỏ giữa các chunk để không bị rate limit
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 1500))
    } catch(e) {
      step(`⚠️ Lỗi đọc phần ${i+1}: ${e.message}`)
      chunkSummaries.push(`Phần ${i+1}: Không đọc được`)
    }
  }

  // Gộp tất cả → AI tổng hợp thành bộ nhớ hoàn chỉnh
  step(`🧠 Đang tổng hợp ${chunks.length} phần thành bộ nhớ hoàn chỉnh...`)
  const allPoints = chunkSummaries.join('\n')
  const finalPrompt = `Bạn vừa đọc toàn bộ ${chunks.length} phần của văn bản hành chính Việt Nam: "${fileName}".

Đây là tổng hợp từng phần:
${allPoints}

Dựa vào toàn bộ thông tin trên, tạo bộ nhớ tổng hợp hoàn chỉnh. Trả về JSON (không giải thích thêm):
{
  "summary": "Tóm tắt đầy đủ 10-15 câu bao quát TOÀN BỘ nội dung văn bản",
  "keyPoints": ["điểm quan trọng nhất 1", "điểm 2", "...", "tối đa 15 điểm từ tất cả các phần"],
  "legalBasis": "tất cả căn cứ pháp lý được viện dẫn",
  "requirements": "tất cả yêu cầu kỹ thuật và điều khoản quan trọng",
  "risks": "rủi ro và điểm cần lưu ý",
  "keywords": ["từ khóa 1", "...", "tối đa 20 từ khóa"]
}`

  const finalResult = await callAIWithText(finalPrompt, 2500)
  step(`✅ Hoàn thành! Đã đọc và ghi nhớ toàn bộ văn bản ${chunks.length} phần`)
  return finalResult
}

const buildDeepPrompt = (text, fileName) => `Phân tích sâu văn bản hành chính Việt Nam và trả về JSON (không giải thích thêm):
{
  "summary": "Tóm tắt đầy đủ 8-12 câu về nội dung văn bản",
  "keyPoints": ["điểm quan trọng 1", "điểm 2", "tối đa 10 điểm"],
  "legalBasis": "căn cứ pháp lý chính được viện dẫn",
  "requirements": "yêu cầu kỹ thuật hoặc điều khoản quan trọng",
  "risks": "rủi ro hoặc điểm cần lưu ý",
  "keywords": ["từ khóa 1", "từ khóa 2", "tối đa 15 từ"]
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
      throw new Error('Tất cả AI hết quota.')
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
      throw new Error('Tất cả AI hết quota.')
    } finally { setLoading(false) }
  }

  // ── Phân tích SÂU → gọi analyzeFullDocument (có chunking) ──
  const analyzeDeepForMemory = async (text, fileName = '', onStep = null) => {
    setLoading(true)
    resetIdxIfNewDay()
    try {
      return await analyzeFullDocument(text, fileName, onStep)
    } finally { setLoading(false) }
  }

  const askDeep = async (question, memory, chatHistory = []) => {
    setLoading(true)
    resetIdxIfNewDay()
    const ctx = `BỘ NHỚ VĂN BẢN:
Tóm tắt: ${memory.summary || ''}
Điểm quan trọng: ${(memory.keyPoints || []).join('; ')}
Căn cứ pháp lý: ${memory.legalBasis || ''}
Yêu cầu kỹ thuật: ${memory.requirements || ''}
Rủi ro: ${memory.risks || ''}
Từ khóa: ${(memory.keywords || []).join(', ')}`

    const historyCtx = chatHistory.slice(-4).map(m =>
      `${m.role==='user'?'Hỏi':'Trả lời'}: ${m.content}`).join('\n')
    const prompt = `Bạn là chuyên gia phân tích văn bản pháp lý Việt Nam. Dựa vào bộ nhớ văn bản bên dưới để trả lời câu hỏi chi tiết.

${ctx}
${historyCtx ? '\nLỊCH SỬ:\n' + historyCtx : ''}

CÂU HỎI: ${question}
Trả lời tiếng Việt, chi tiết và chính xác:`

    try {
      return await callAIWithText(prompt, 1500)
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
      throw new Error('AI đang bận. Thử lại sau 1 phút!')
    } finally { setLoading(false) }
  }

  return {
    ask, analyzeText, analyzeImages, analyzeDeepForMemory, askDeep,
    getKey: () => getGroqKeys()[0] || getGemKeys()[0],
    saveKey, isReal: () => Boolean(getGroqKeys().length || getGemKeys().length),
    loading,
  }
}