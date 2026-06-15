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

export function useAI() {
  const [loading, setLoading] = useState(false)

  // ── Gọi Gemini với maxTokens tuỳ chỉnh ──
  const callGemini = async (model, parts, maxOutputTokens = 1000) => {
    const keys = getGemKeys()
    if (!keys.length) throw new Error('QUOTA')
    for (let i = 0; i < keys.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 2000)) // delay 2s giữa các key
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

  // ── Phân tích trích xuất thông tin (dùng khi thêm văn bản) ──
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

  // ── Phân tích SÂU toàn bộ văn bản → tạo bộ nhớ (dùng 1 lần duy nhất) ──
  const analyzeDeepForMemory = async (text, fileName = '') => {
    setLoading(true)
    resetIdxIfNewDay()
    const clean = text.replace(/\r\n/g,'\n').replace(/\n{3,}/g,'\n\n').replace(/[ \t]{3,}/g,' ').slice(0, 12000)
    const prompt = `Phân tích sâu văn bản hành chính Việt Nam và trả về JSON (không giải thích thêm):
{
  "summary": "Tóm tắt đầy đủ 8-12 câu về nội dung văn bản",
  "keyPoints": ["điểm quan trọng 1", "điểm 2", "tối đa 10 điểm"],
  "legalBasis": "căn cứ pháp lý chính được viện dẫn",
  "requirements": "yêu cầu kỹ thuật hoặc điều khoản quan trọng",
  "risks": "rủi ro hoặc điểm cần lưu ý",
  "keywords": ["từ khóa 1", "từ khóa 2", "tối đa 15 từ"]
}

Tên file: ${fileName}
NỘI DUNG VĂN BẢN (đọc toàn bộ và phân tích chi tiết):
---
${clean}
---`
    try {
      // ── Groq làm CHÍNH (ổn định hơn, 30 RPM) ──
      for (const key of getGroqKeys()) {
        try {
          const res = await fetch(GROQ_URL, {
            method: 'POST',
            headers: { 'Content-Type':'application/json', Authorization:`Bearer ${key}` },
            body: JSON.stringify({
              model: 'llama-3.3-70b-versatile',
              max_tokens: 2000,
              temperature: 0.1,
              messages: [{ role:'user', content: prompt }],
            }),
          })
          if (res.status === 429) { await new Promise(r => setTimeout(r, 2000)); continue }
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const result = (await res.json()).choices?.[0]?.message?.content || ''
          if (result) return result
        } catch(e) { continue }
      }
      // ── Gemini làm FALLBACK (chờ 5s để tránh 429) ──
      await new Promise(r => setTimeout(r, 5000))
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
          if (res.status === 429) { await new Promise(r => setTimeout(r, 3000)); continue }
          if (!res.ok) continue
          const result = (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text || ''
          if (result) return result
        } catch(e) { continue }
      }
      throw new Error('Tất cả AI đang bận. Vui lòng thử lại sau 1 phút!')
    } finally { setLoading(false) }
  }

  // ── Hỏi đáp sâu dựa vào bộ nhớ đã lưu (tốn rất ít token) ──
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

    const historyCtx = chatHistory.slice(-4).map(m => `${m.role==='user'?'Hỏi':'Trả lời'}: ${m.content}`).join('\n')

    const prompt = `Bạn là chuyên gia phân tích văn bản pháp lý Việt Nam. Dựa vào bộ nhớ văn bản bên dưới để trả lời câu hỏi chi tiết. Nếu thông tin không có trong bộ nhớ, hãy nói rõ.

${ctx}
${historyCtx ? '\nLỊCH SỬ:\n' + historyCtx : ''}

CÂU HỎI: ${question}
Trả lời tiếng Việt, chi tiết và chính xác:`

    try {
      // ── Groq làm CHÍNH ──
      for (const key of getGroqKeys()) {
        try {
          const res = await fetch(GROQ_URL, {
            method: 'POST',
            headers: { 'Content-Type':'application/json', Authorization:`Bearer ${key}` },
            body: JSON.stringify({
              model: 'llama-3.3-70b-versatile',
              max_tokens: 1500, temperature: 0.1,
              messages: [{ role:'user', content: prompt }],
            }),
          })
          if (res.status === 429) { await new Promise(r => setTimeout(r, 1500)); continue }
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const result = (await res.json()).choices?.[0]?.message?.content || ''
          if (result) return result
        } catch(e) { continue }
      }
      // ── Gemini fallback (chờ 5s) ──
      await new Promise(r => setTimeout(r, 5000))
      for (const key of getGemKeys()) {
        try {
          const res = await fetch(GEM_URL('gemini-2.0-flash', key), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.1, maxOutputTokens: 1500 },
            }),
          })
          if (res.status === 429) { await new Promise(r => setTimeout(r, 3000)); continue }
          if (!res.ok) continue
          const result = (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text || ''
          if (result) return result
        } catch(e) { continue }
      }
      throw new Error('AI đang bận. Thử lại sau 1 phút!')
    } finally { setLoading(false) }
  }

  // ── Chat thông thường về dự án ──
  const ask = async (question, context = '') => {
    setLoading(true)
    resetIdxIfNewDay()
    const sys = `Bạn là trợ lý quản lý dự án VATM. Trả lời tiếng Việt, ngắn gọn.${context?'\n\nDữ liệu:\n'+context:''}`
    try {
      for (const model of GEMINI_MODELS) {
        try { return await callGemini(model, [{text:`${sys}\n\nCâu hỏi: ${question}`}]) }
        catch(e) { if(e.message !== 'QUOTA') throw e }
      }
      for (const key of getGroqKeys()) {
        for (const model of GROQ_TEXT_MODELS) {
          try {
            const res = await fetch(GROQ_URL, {
              method:'POST',
              headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${key}` },
              body:JSON.stringify({ model, max_tokens:800, temperature:0.1,
                messages:[{role:'system',content:sys},{role:'user',content:question}] }),
            })
            if (!res.ok) { if(res.status===429) continue; throw new Error(`HTTP ${res.status}`) }
            return (await res.json()).choices?.[0]?.message?.content || ''
          } catch(e) { continue }
        }
      }
      throw new Error('Tất cả AI hết quota.')
    } finally { setLoading(false) }
  }

  return {
    ask,
    analyzeText,
    analyzeImages,
    analyzeDeepForMemory,
    askDeep,
    getKey: () => getGroqKeys()[0] || getGemKeys()[0],
    saveKey,
    isReal: () => Boolean(getGroqKeys().length || getGemKeys().length),
    loading,
  }
}