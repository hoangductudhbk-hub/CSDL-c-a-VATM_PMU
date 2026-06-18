import { useState } from 'react'
import { useAI } from '../hooks/useAI'
import { useCloudinaryStorage } from '../hooks/useCloudinaryStorage'

const ST = [{ value:'done',label:'✅ Hoàn thành'},{ value:'pending',label:'🔄 Đang thực hiện'},{ value:'prep',label:'⬜ Chưa thực hiện'}]
const DT = ['Quyết định','Nghị quyết','Công văn','Tờ trình','Báo cáo','Hợp đồng','Biên bản','Thông báo','Hồ sơ','Bản vẽ','Khác']

const loadPdfJs = () => new Promise((res,rej) => {
  if (window.pdfjsLib){res(window.pdfjsLib);return}
  const s=document.createElement('script'); s.src='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
  s.onload=()=>{window.pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';res(window.pdfjsLib)}
  s.onerror=rej; document.head.appendChild(s)
})
const extractPdfText = async (buf) => {
  const lib=await loadPdfJs(); const pdf=await lib.getDocument({data:buf}).promise
  const maxPages = buf.byteLength > 10*1024*1024 ? 3 : Math.min(pdf.numPages, 15)
  let text=''
  for(let i=1;i<=maxPages;i++){
    const page=await pdf.getPage(i); const c=await page.getTextContent()
    text+=c.items.map(it=>it.str).join(' ')+'\n'
  }
  return text.trim().replace(/\s+/g,' ').slice(0,8000)
}
// ── Helper: ArrayBuffer → base64 ────────────────────────────────
const bufToBase64 = (buf) => {
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(binary)
}

// ── Gọi Gemini với 1 PDF (toàn bộ file, base64) ─────────────────
const callGeminiPdf = async (base64, prompt, gemKeys) => {
  for (let i = 0; i < gemKeys.length; i++) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${gemKeys[i]}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [
              { inline_data: { mime_type: 'application/pdf', data: base64 } },
              { text: prompt }
            ]}],
            generationConfig: { temperature: 0, maxOutputTokens: 8192 }
          })
        }
      )
      if (res.status === 429) { await new Promise(r => setTimeout(r, 2000)); continue }
      if (!res.ok) continue
      const text = (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text || ''
      if (text.length > 50) return text
    } catch { continue }
  }
  return null
}

// ── Gemini đọc PDF theo nhóm trang, lưu chunks vào Firestore ─────
// pageGroup: 30 trang/lần → tối đa 200 trang = 7 lần gọi
const extractPdfWithGemini = async (buf, fileName = '', docId = null, onStatus = null) => {
  const gemKeys = [
    import.meta.env.VITE_GEMINI_API_KEY,
    import.meta.env.VITE_GEMINI_API_KEY_2,
    import.meta.env.VITE_GEMINI_API_KEY_3,
  ].filter(Boolean)
  if (!gemKeys.length) return null

  // Đọc số trang bằng pdfjs (nhanh, không cần nội dung)
  const lib = await loadPdfJs()
  const pdf = await lib.getDocument({ data: buf.slice(0) }).promise
  const totalPages = pdf.numPages
  const PAGE_GROUP = 30 // trang/lần gọi Gemini

  if (onStatus) onStatus(`📄 PDF có ${totalPages} trang · Đang chia thành nhóm ${PAGE_GROUP} trang...`)

  const base64 = bufToBase64(buf)
  const allChunks = []
  let allText = ''

  const groups = Math.ceil(totalPages / PAGE_GROUP)
  for (let g = 0; g < groups; g++) {
    const fromPage = g * PAGE_GROUP + 1
    const toPage = Math.min((g + 1) * PAGE_GROUP, totalPages)
    if (onStatus) onStatus(`🤖 Gemini đọc trang ${fromPage}–${toPage} / ${totalPages}...`)

    const prompt = `Trích xuất nội dung từ trang ${fromPage} đến trang ${toPage} của PDF: "${fileName}".
Yêu cầu:
- Giữ nguyên 100% câu chữ, số liệu, tên người, ngày tháng
- Chuyển bảng biểu sang Markdown table (| cột | cột |)  
- Giữ heading (# ## ###), điều khoản (Điều 1, Khoản 2...)
- Bắt đầu bằng dòng: ## Trang ${fromPage}–${toPage}
- KHÔNG tóm tắt, chỉ trả về Markdown thuần túy`

    const chunkText = await callGeminiPdf(base64, prompt, gemKeys)
    if (chunkText) {
      allChunks.push({ fromPage, toPage, text: chunkText, index: g })
      allText += chunkText + '\n\n'
      if (onStatus) onStatus(`✅ Xong trang ${fromPage}–${toPage} (${chunkText.length.toLocaleString()} ký tự)`)
    } else {
      if (onStatus) onStatus(`⚠️ Bỏ qua trang ${fromPage}–${toPage} (rate limit)`)
    }

    // Delay giữa các nhóm tránh rate limit
    if (g < groups - 1) await new Promise(r => setTimeout(r, 1500))
  }

  // Lưu chunks vào Firestore nếu có docId
  if (docId && allChunks.length > 0) {
    try {
      const { collection, addDoc, serverTimestamp } = await import('firebase/firestore')
      const { db } = await import('../firebase')
      for (const chunk of allChunks) {
        await addDoc(collection(db, 'documentChunks'), {
          docId,
          fileName,
          fromPage: chunk.fromPage,
          toPage: chunk.toPage,
          chunkIndex: chunk.index,
          text: chunk.text,
          createdAt: serverTimestamp()
        })
      }
      if (onStatus) onStatus(`💾 Đã lưu ${allChunks.length} chunks vào Firestore`)
    } catch(e) {
      console.warn('Lưu chunks lỗi:', e.message)
    }
  }

  if (onStatus) onStatus(`✅ Hoàn thành! Đọc ${totalPages} trang · ${allText.length.toLocaleString()} ký tự`)
  return allText.slice(0, 200000) // lưu 200K vào extractedText
}

// ── Fallback: pdfjs đọc text thô ─────────────────────────────────
const extractPdfTextFull = async (buf) => {
  const lib = await loadPdfJs()
  const pdf = await lib.getDocument({ data: buf }).promise
  let text = ''
  for(let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const c = await page.getTextContent()
    text += c.items.map(it => it.str).join(' ') + '\n'
  }
  return text.trim().replace(/\s+/g, ' ').slice(0, 100000)
}

// ── Hàm chính: Gemini trước, pdfjs fallback ──────────────────────
const extractPdfFull = async (buf, fileName = '', docId = null, onStatus = null) => {
  const gemResult = await extractPdfWithGemini(buf.slice(0), fileName, docId, onStatus)
  if (gemResult) return gemResult
  if (onStatus) onStatus('📄 Gemini không khả dụng · Dùng pdfjs fallback...')
  return await extractPdfTextFull(buf.slice(0))
}

const renderPdfToImages = async (buf,max=3) => {
  const lib=await loadPdfJs(); const pdf=await lib.getDocument({data:buf}).promise
  const pages=Math.min(pdf.numPages,max); const imgs=[]
  for(let i=1;i<=pages;i++){
    const page=await pdf.getPage(i); const vp=page.getViewport({scale:1.2})
    const canvas=document.createElement('canvas'); canvas.width=vp.width; canvas.height=vp.height
    await page.render({canvasContext:canvas.getContext('2d'),viewport:vp}).promise
    imgs.push(canvas.toDataURL('image/jpeg',0.65).split(',')[1])
  }
  return imgs
}
const loadScript = (src,check) => new Promise((res,rej)=>{
  if(check()){res();return}
  const s=document.createElement('script'); s.src=src; s.onload=res; s.onerror=rej; document.head.appendChild(s)
})
const extractDocxText = async (buf) => {
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js',()=>window.mammoth)
  return (await window.mammoth.extractRawText({arrayBuffer:buf})).value.slice(0,8000)
}
const extractXlsxText = async (buf) => {
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',()=>window.XLSX)
  const wb=window.XLSX.read(buf,{type:'array'}); let text=''
  wb.SheetNames.slice(0,3).forEach(n=>{text+=`[${n}]\n`+window.XLSX.utils.sheet_to_txt(wb.Sheets[n])+'\n'})
  return text.slice(0,8000)
}
const parseJ = (s) => { try{const m=s.match(/\{[\s\S]*\}/);return JSON.parse(m?m[0]:s.replace(/```json|```/g,'').trim())}catch{return null} }

export default function DocModal({ doc, onSave, onClose }) {
  const isEdit = Boolean(doc?.id)
  const { ask, analyzeText, analyzeImages, getKey, saveKey, isReal } = useAI()
  const { uploadFile, uploading, getCloudName, saveCloudName } = useCloudinaryStorage()

  const [form, setForm] = useState({ code:'',date:'',org:'',subject:'',docType:'Công văn',status:'prep',detail:'',note:'', ...(doc||{}) })
  const [mode, setMode]     = useState('ai')
  const [aiTab, setAiTab]   = useState('file')
  const [rawText, setRaw]   = useState('')
  const [status, setSt]     = useState('')
  const [loading, setLoad]  = useState(false)
  const [fileQueue, setFQ]  = useState([])
  const [processing, setProc] = useState(false)
  const [pendingFile, setPF]  = useState(null)
  const [extractedText, setExtractedText] = useState('')

  const set = (k,v) => setForm(f=>({...f,[k]:v}))

  const sColor = status.startsWith('✅')?'#15803d':status.startsWith('❌')||status.startsWith('⚠️')?'#b91c1c':'#1d4ed8'
  const sBg    = status.startsWith('✅')?'#f0fdf4':status.startsWith('❌')||status.startsWith('⚠️')?'#fef2f2':'#eff6ff'

  const handleSave = async () => {
    if (!form.subject?.trim()) return alert('Nhập nội dung văn bản')
    let final = {...form, ...(extractedText ? { extractedText: extractedText.slice(0, 100000) } : {})}
    if (pendingFile) {
      setSt('⏳ Đang upload file...')
      setLoad(true)
      try {
        const fi = await uploadFile(pendingFile, pct => setSt(`⏳ Đang upload... ${pct}%`))
        if (!fi?.fileUrl) throw new Error('Không nhận được URL')
        // Lưu thêm tên file và kích thước
        final = {...final, ...fi, fileName: pendingFile.name, fileSize: pendingFile.size}
        setSt('✅ Upload xong!')
        await new Promise(r => setTimeout(r, 400))
      } catch(e) {
        alert('❌ Upload thất bại: ' + (e.message||'Lỗi không xác định'))
        setLoad(false)
        return
      } finally {
        setLoad(false)
      }
    }
    onSave(final)
  }

  const isRealContent = (text) => {
    if (text.length < 150) return false
    return /căn cứ|điều \d|khoản|quyết định|nghị quyết|tờ trình|báo cáo|cộng hòa|chương \d/i.test(text)
  }

  const processOnePdf = async (buf, fileName='') => {
    const text = await extractPdfText(buf.slice(0))
    if (isRealContent(text)) return await analyzeText(text, fileName)
    setSt('⏳ PDF scan — đang dùng vision AI...')
    const imgs = await renderPdfToImages(buf.slice(0))
    return await analyzeImages(imgs, fileName)
  }

  const handleFile = async (e) => {
    const files = Array.from(e.target.files)
    if (!files.length) return
    if (!getKey()) { alert('Chưa có Groq API key! Nhấn ⚙️ Cài key AI bên dưới.'); return }

    if (files.length === 1) {
      const file = files[0]; const ext = file.name.split('.').pop().toLowerCase()
      setPF(file)
      setLoad(true); setSt('⏳ Đang xử lý...')
      try {
        let result = ''
        let rawExtracted = ''
        const buf = await file.arrayBuffer()
        if (ext === 'pdf') {
          setSt('⏳ Đang đọc PDF...')
          rawExtracted = await extractPdfFull(buf.slice(0), file.name, null, setSt)
          result = isRealContent(rawExtracted)
            ? await analyzeText(rawExtracted.slice(0, 8000), file.name)
            : await (async () => { setSt('⏳ PDF scan — đang dùng vision AI...'); const imgs = await renderPdfToImages(buf.slice(0)); return await analyzeImages(imgs, file.name) })()
        } else if (['doc','docx'].includes(ext)) {
          rawExtracted = await extractDocxText(buf)
          result = await analyzeText(rawExtracted.slice(0, 8000), file.name)
          rawExtracted = rawExtracted.slice(0, 100000)
        } else if (['xls','xlsx'].includes(ext)) {
          rawExtracted = await extractXlsxText(buf)
          result = await analyzeText(rawExtracted.slice(0, 8000), file.name)
          rawExtracted = rawExtracted.slice(0, 100000)
        } else if (ext === 'txt') {
          const t = await new Promise((r)=>{const rd=new FileReader();rd.onload=ev=>r(ev.target.result.slice(0,100000));rd.readAsText(file,'utf-8')})
          setRaw(t.slice(0, 8000)); setExtractedText(t); setSt('✅ Đọc xong — nhấn AI phân tích'); setLoad(false); return
        } else { setSt('⚠️ Định dạng chưa hỗ trợ'); setLoad(false); return }
        setExtractedText(rawExtracted)
        const p = parseJ(result)
        if (p) { setForm(f=>({...f,...p,fileName:file.name})); setMode('manual'); setSt('✅ AI điền xong!') }
        else setSt('⚠️ Không phân tích được. Điền thủ công.')
      } catch(e) {
        if (e.message==='NO_KEY') alert('Chưa có API key!')
        else setSt(e.message === 'AI_QUOTA' ? '⚠️ AI đã hết lượt sử dụng hôm nay. Vui lòng quay lại sau!' : '❌ Lỗi: '+e.message)
      } finally { setLoad(false) }
      return
    }

    // Batch
    const queue = files.map(f=>({name:f.name,status:'⏳ Chờ',parsed:null}))
    setFQ(queue); setProc(true)
    for (let i=0;i<files.length;i++) {
      const file=files[i]; const ext=file.name.split('.').pop().toLowerCase()
      queue[i].status='🔄 Đang xử lý...'; setFQ([...queue])
      try {
        let result=''
        let batchExtracted = ''
        const bBuf = await file.arrayBuffer()
        if (ext==='pdf') {
          batchExtracted = await extractPdfFull(bBuf.slice(0), file.name, null, (msg) => { queue[i].status=msg; setFQ([...queue]) })
          result = isRealContent(batchExtracted) ? await analyzeText(batchExtracted.slice(0,8000),file.name) : await processOnePdf(bBuf,file.name)
        } else if (['doc','docx'].includes(ext)) {
          batchExtracted = (await extractDocxText(bBuf)).slice(0,100000)
          result = await analyzeText(batchExtracted.slice(0,8000),file.name)
        } else if (['xls','xlsx'].includes(ext)) {
          batchExtracted = (await extractXlsxText(bBuf)).slice(0,100000)
          result = await analyzeText(batchExtracted.slice(0,8000),file.name)
        } else { queue[i].status='⚠️ Không hỗ trợ'; setFQ([...queue]); continue }
        const p=parseJ(result)
        if (p) {
          queue[i].status='⏳ Đang upload... 0%'; setFQ([...queue])
          let fi={}
          try {
            fi = await uploadFile(file, pct => { queue[i].status=`⏳ Đang upload... ${pct}%`; setFQ([...queue]) })
          } catch(ue) {
            console.warn('Upload err:', ue.message)
            queue[i].status='⚠️ Lưu văn bản (không có file)'
          }
          // Lưu tên file, kích thước và extractedText
          onSave({...p, fileName:file.name, fileSize:file.size, extractedText: batchExtracted, ...fi}, true)
          queue[i].status='✅ Xong'
        } else queue[i].status='⚠️ Không đọc được'
      } catch(e) { queue[i].status='❌ '+(e.message||'Lỗi') }
      setFQ([...queue])
    }
    setProc(false); setSt(`✅ Xong ${queue.filter(q=>q.status==='✅ Xong').length}/${files.length} văn bản`)
  }

  const aiFill = async () => {
    if (!rawText.trim()) return
    setLoad(true); setSt('🤖 AI đang phân tích...')
    try {
      const r=await analyzeText(rawText); const p=parseJ(r)
      if (p) { setForm(f=>({...f,...p})); setMode('manual'); setSt('✅ Xong!') }
      else setSt('⚠️ Không phân tích được')
    } catch(e) { if(e.message==='NO_KEY') alert('Chưa có key!'); else setSt(e.message === 'AI_QUOTA' ? '⚠️ AI đã hết lượt sử dụng hôm nay. Vui lòng quay lại sau!' : '❌ Lỗi: '+e.message) }
    finally { setLoad(false) }
  }

  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.4)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:100,padding:20}} onClick={e=>e.target===e.currentTarget&&!processing&&onClose()}>
      <div style={{background:'#fff',borderRadius:14,padding:'24px 28px',width:'100%',maxWidth:600,maxHeight:'90vh',overflowY:'auto',boxShadow:'0 8px 32px rgba(0,0,0,.15)'}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
          <h3 style={{fontSize:15,fontWeight:600,margin:0}}>{isEdit?'Chỉnh sửa':'Thêm văn bản mới'}</h3>
          {!processing&&<button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',fontSize:18,color:'#888'}}>✕</button>}
        </div>

        {!processing&&<div style={{display:'flex',gap:8,marginBottom:16}}>
          {[['ai','✨ AI tự điền'],['manual','✏️ Nhập thủ công']].map(([v,l])=>(
            <button key={v} onClick={()=>setMode(v)} style={{flex:1,padding:'9px',borderRadius:8,fontSize:13,cursor:'pointer',border:mode===v?'2px solid #1a1a1a':'0.5px solid #ddd',background:mode===v?'#1a1a1a':'#fff',color:mode===v?'#fff':'#555',fontWeight:mode===v?600:400}}>{l}</button>
          ))}
        </div>}

        {fileQueue.length > 1 && (
          <div>
            <div style={{fontSize:13,fontWeight:600,marginBottom:10}}>{processing?'⏳ Đang xử lý hàng loạt...':'📋 Kết quả:'}</div>
            <div style={{maxHeight:260,overflowY:'auto',display:'flex',flexDirection:'column',gap:6}}>
              {fileQueue.map((f,i)=>(
                <div key={i} style={{padding:'8px 12px',borderRadius:8,fontSize:12,background:f.status.startsWith('✅')?'#f0fdf4':f.status.startsWith('❌')||f.status.startsWith('⚠️')?'#fef2f2':'#eff6ff',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <span style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:'70%'}}>{f.name}</span>
                  <span style={{color:f.status.startsWith('✅')?'#15803d':f.status.startsWith('❌')||f.status.startsWith('⚠️')?'#b91c1c':'#1d4ed8',flexShrink:0,marginLeft:8}}>{f.status}</span>
                </div>
              ))}
            </div>
            {!processing&&(
              <div style={{marginTop:12}}>
                <div style={{padding:'10px 14px',borderRadius:8,background:'#f0fdf4',border:'0.5px solid #bbf7d0',fontSize:13,color:'#15803d',marginBottom:10,textAlign:'center'}}>
                  ✅ Tất cả văn bản đã được <strong>lưu tự động</strong> vào hệ thống
                </div>
                <div style={{display:'flex',justifyContent:'flex-end'}}>
                  <button onClick={onClose} style={sBtn}>✓ Đóng</button>
                </div>
              </div>
            )}
            {status&&<div style={{marginTop:10,padding:'9px 12px',borderRadius:8,fontSize:12,background:sBg,color:sColor}}>{status}</div>}
          </div>
        )}

        {mode==='ai'&&fileQueue.length<=1&&!processing&&(
          <div>
            <div style={{display:'flex',gap:0,marginBottom:14,border:'0.5px solid #ddd',borderRadius:8,overflow:'hidden'}}>
              {[['file','📎 File'],['paste','📋 Dán text']].map(([v,l],i,arr)=>(
                <button key={v} onClick={()=>{setAiTab(v);setSt('');setRaw('')}} style={{flex:1,padding:'9px',fontSize:12,border:'none',borderRight:i<arr.length-1?'0.5px solid #ddd':'none',background:aiTab===v?'#1a1a1a':'#fff',color:aiTab===v?'#fff':'#555',fontWeight:aiTab===v?600:400,cursor:'pointer'}}>{l}</button>
              ))}
            </div>
            {aiTab==='file'&&(
              <label style={{display:'flex',flexDirection:'column',alignItems:'center',gap:8,padding:'28px 20px',border:'2px dashed #ddd',borderRadius:10,cursor:loading?'not-allowed':'pointer',background:'#fafaf8'}}>
                <input type="file" accept=".pdf,.txt,.doc,.docx,.xlsx,.xls,.pptx,.ppt" onChange={handleFile} style={{display:'none'}} disabled={loading} multiple/>
                {loading?<><span style={{fontSize:20}}>⏳</span><span style={{fontSize:13,color:'#555'}}>Đang xử lý...</span></>:<><span style={{fontSize:36}}>📎</span><span style={{fontSize:13,color:'#555',fontWeight:600}}>Nhấn để chọn file</span><span style={{fontSize:11,color:'#9b9b9b'}}>PDF, Word, Excel, TXT (Ctrl+Click nhiều file)</span></>}
              </label>
            )}
            {aiTab==='paste'&&<textarea value={rawText} onChange={e=>setRaw(e.target.value)} placeholder="Dán nội dung văn bản vào đây..." rows={8} style={{...iSt,resize:'vertical',minHeight:160}}/>}
            {status&&<div style={{margin:'10px 0 4px',padding:'9px 12px',borderRadius:8,fontSize:12,background:sBg,color:sColor}}>{status}</div>}
            {rawText.trim()&&!loading&&<button onClick={aiFill} style={{width:'100%',marginTop:8,padding:'12px',background:'#7F77DD',color:'#fff',border:'none',borderRadius:8,fontSize:13,fontWeight:600,cursor:'pointer'}}>✨ AI phân tích & điền tự động</button>}
          </div>
        )}

        {mode==='manual'&&!processing&&fileQueue.length<=1&&(
          <div>
            {status&&<div style={{marginBottom:12,padding:'9px 12px',borderRadius:8,fontSize:12,background:sBg,color:sColor}}>{status}</div>}
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 12px'}}>
              <div style={{marginBottom:12}}><label style={lSt}>Số ký hiệu</label><input value={form.code||''} onChange={e=>set('code',e.target.value)} placeholder="VD: 404/NQ-HĐTV" style={iSt}/></div>
              <div style={{marginBottom:12}}><label style={lSt}>Ngày ban hành</label><input value={form.date||''} onChange={e=>set('date',e.target.value)} placeholder="VD: 08/2025" style={iSt}/></div>
            </div>
            <div style={{marginBottom:12}}><label style={lSt}>Cơ quan ban hành</label><input value={form.org||''} onChange={e=>set('org',e.target.value)} placeholder="VD: Tổng công ty VATM" style={iSt}/></div>
            <div style={{marginBottom:12}}><label style={lSt}>Loại văn bản</label><select value={form.docType} onChange={e=>set('docType',e.target.value)} style={iSt}>{DT.map(t=><option key={t}>{t}</option>)}</select></div>
            <div style={{marginBottom:12}}><label style={lSt}>Nội dung / Về việc <span style={{color:'#e53e3e'}}>*</span></label><input value={form.subject||''} onChange={e=>set('subject',e.target.value)} placeholder="Tóm tắt nội dung chính" style={iSt}/></div>
            <div style={{marginBottom:12}}><label style={lSt}>Trích yếu chi tiết</label><textarea value={form.detail||''} onChange={e=>set('detail',e.target.value)} rows={3} style={{...iSt,resize:'vertical'}}/></div>
            <div style={{marginBottom:12}}><label style={lSt}>Ghi chú</label><textarea value={form.note||''} onChange={e=>set('note',e.target.value)} rows={2} style={{...iSt,resize:'vertical'}}/></div>
            <div style={{marginBottom:16}}>
              <label style={lSt}>Trạng thái</label>
              <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
                {ST.map(s=><button key={s.value} onClick={()=>set('status',s.value)} style={{padding:'6px 14px',borderRadius:20,fontSize:12,border:form.status===s.value?'2px solid #1a1a1a':'0.5px solid #ddd',background:form.status===s.value?'#1a1a1a':'#fff',color:form.status===s.value?'#fff':'#555',cursor:'pointer'}}>{s.label}</button>)}
              </div>
            </div>
            <div style={{marginBottom:16}}>
              <label style={lSt}>📎 Đính kèm file (PDF, Word, Excel...)</label>
              {pendingFile ? (
                <div style={{padding:'10px 12px',borderRadius:8,background:'#eff6ff',border:'0.5px solid #bfdbfe',fontSize:12,color:'#1d4ed8',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                  <span>📎 {pendingFile.name} ({(pendingFile.size/1024/1024).toFixed(1)} MB)</span>
                  <button onClick={()=>setPF(null)} style={{background:'none',border:'none',cursor:'pointer',color:'#e53e3e',fontSize:14}}>✕</button>
                </div>
              ) : (
                <label style={{display:'flex',alignItems:'center',gap:10,padding:'10px 14px',border:'1.5px dashed #ddd',borderRadius:8,cursor:'pointer',background:'#fafaf8'}}>
                  <input type="file" accept=".pdf,.doc,.docx,.xlsx,.xls,.pptx,.ppt,.txt" onChange={e=>{if(e.target.files[0]) setPF(e.target.files[0])}} style={{display:'none'}}/>
                  <span style={{fontSize:20}}>📎</span>
                  <span style={{fontSize:13,color:'#888'}}>Nhấn để chọn file đính kèm</span>
                </label>
              )}
            </div>
            <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
              <button onClick={onClose} style={cBtn}>Hủy</button>
              <button onClick={handleSave} disabled={loading} style={sBtn}>{loading?'⏳ Đang lưu...':(isEdit?'💾 Lưu':'➕ Thêm văn bản')}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
const iSt = {width:'100%',padding:'8px 10px',fontSize:13,border:'0.5px solid #ddd',borderRadius:8,outline:'none',boxSizing:'border-box',background:'#fff',color:'#1a1a1a'}
const lSt = {fontSize:12,color:'#6b6b6b',display:'block',marginBottom:4}
const cBtn = {padding:'8px 18px',border:'0.5px solid #ddd',borderRadius:8,cursor:'pointer',background:'#fff',color:'#555',fontSize:13}
const sBtn = {padding:'8px 20px',border:'none',borderRadius:8,cursor:'pointer',background:'#1a1a1a',color:'#fff',fontSize:13,fontWeight:500}
