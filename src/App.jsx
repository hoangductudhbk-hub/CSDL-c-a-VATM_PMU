import { useState } from 'react'
import { useAuth } from './context/AuthContext'
import { useProjects } from './hooks/useProjects'
import { useDocuments } from './hooks/useDocuments'
import { useAI } from './hooks/useAI'
import DocModal from './components/DocModal'
import DocDetail from './components/DocDetail'

const SM = {
  done:    { label:'Da xong',   bg:'#f0fdf4', color:'#15803d', dot:'#22c55e' },
  pending: { label:'Dang cho',  bg:'#fffbeb', color:'#b45309', dot:'#f59e0b' },
  urgent:  { label:'Can gap',   bg:'#fef2f2', color:'#b91c1c', dot:'#ef4444' },
  prep:    { label:'Chuan bi',  bg:'#eff6ff', color:'#1d4ed8', dot:'#93c5fd' },
}

function KeyModal({ onClose, getKey, saveKey }) {
  const [val, setVal] = useState(getKey())
  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.5)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:9999}}>
      <div style={{background:'#fff',borderRadius:14,padding:'28px',width:440,boxShadow:'0 8px 32px rgba(0,0,0,.2)'}}>
        <h3 style={{fontSize:15,fontWeight:600,marginBottom:8}}>Cai Groq API Key</h3>
        <p style={{fontSize:12,color:'#888',marginBottom:4,lineHeight:1.6}}>
          Lay key mien phi tai console.groq.com
        </p>
        <p style={{fontSize:12,color:'#888',marginBottom:16}}>
          Dang ky → API Keys → Create API Key → copy key bat dau bang gsk_...
        </p>
        <input
          value={val}
          onChange={e => setVal(e.target.value)}
          placeholder="gsk_..."
          autoFocus
          style={{width:'100%',padding:'10px 12px',border:'0.5px solid #ddd',borderRadius:8,fontSize:13,outline:'none',boxSizing:'border-box',marginBottom:16,fontFamily:'monospace'}}
        />
        <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
          <button onClick={onClose} style={{padding:'8px 16px',border:'0.5px solid #ddd',borderRadius:8,cursor:'pointer',background:'#fff',fontSize:13}}>Huy</button>
          <button onClick={() => { saveKey(val.trim()); onClose() }} style={{padding:'8px 20px',background:'#1a1a1a',color:'#fff',border:'none',borderRadius:8,cursor:'pointer',fontSize:13,fontWeight:600}}>Luu key</button>
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const { user, loginWithGoogle, logout } = useAuth()
  const { projects, loading: pLoad, addProject } = useProjects(user?.uid)
  const [selProj, setSelProj]   = useState(null)
  const proj = projects.find(p => p.id === selProj) || projects[0]
  const { docs, addDocument, updateDocument, deleteDocument } = useDocuments(proj?.id, user?.uid)
  const { ask, getKey, saveKey } = useAI()

  const [tab, setTab]         = useState('docs')
  const [search, setSearch]   = useState('')
  const [filter, setFilter]   = useState('all')
  const [modal, setModal]     = useState(null)
  const [editDoc, setEditDoc] = useState(null)
  const [detailDoc, setDetailDoc] = useState(null)
  const [chat, setChat]       = useState([])
  const [chatInput, setChatInput] = useState('')
  const [aiLoading, setAiLoad]    = useState(false)
  const [showAddProj, setShowAddProj] = useState(false)
  const [newProjName, setNewProjName] = useState('')
  const [showKeyModal, setShowKeyModal] = useState(false)

  if (!user && user !== undefined) return <Login onLogin={loginWithGoogle} />
  if (user === undefined || pLoad) {
    return (
      <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'100vh',fontSize:14,color:'#888'}}>
        Dang tai...
      </div>
    )
  }

  const filtered = docs.filter(d => {
    const q = search.toLowerCase()
    const matchSearch = !q || (d.code||'').toLowerCase().includes(q) || (d.subject||'').toLowerCase().includes(q)
    const matchFilter = filter === 'all' || d.status === filter
    return matchSearch && matchFilter
  })

  const stats = {
    total:   docs.length,
    done:    docs.filter(d => d.status === 'done').length,
    pending: docs.filter(d => d.status === 'pending').length,
    urgent:  docs.filter(d => d.status === 'urgent').length,
  }
  const progress = stats.total ? Math.round((stats.done / stats.total) * 100) : 0

  const handleSave = async (data, silent = false) => {
    if (editDoc) await updateDocument(editDoc.id, data)
    else         await addDocument(data, silent)
    if (!silent) { setModal(null); setEditDoc(null) }
  }

  const handleAsk = async (q) => {
    if (!q.trim() || aiLoading) return
    if (!getKey()) { setShowKeyModal(true); return }
    const ctx = `Du an: ${proj?.name} (${proj?.code})\nTong van ban: ${stats.total}, Hoan thanh: ${stats.done}, Dang cho: ${stats.pending}\nDanh sach: ${docs.slice(0,8).map(d => d.code + ': ' + d.subject + '(' + d.status + ')').join('; ')}`
    setChat(c => [...c, { role:'user', content:q }])
    setChatInput('')
    setAiLoad(true)
    try {
      const res = await ask(q, ctx)
      setChat(c => [...c, { role:'ai', content:res }])
    } catch {
      setChat(c => [...c, { role:'ai', content:'Loi ket noi AI. Kiem tra API key.' }])
    } finally {
      setAiLoad(false)
    }
  }

  const exportReport = () => {
    const lines = [
      'BAO CAO DU AN: ' + (proj?.name || ''),
      'Ngay: ' + new Date().toLocaleDateString('vi-VN'),
      'Tien do: ' + progress + '% (' + stats.done + '/' + stats.total + ')',
      '',
      'DANH SACH VAN BAN:',
      ...docs.map(d => '- [' + (SM[d.status]||SM.prep).label + '] ' + (d.code||'N/A') + ' | ' + (d.subject||'')),
    ]
    const blob = new Blob([lines.join('\n')], { type:'text/plain;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'BaoCao_' + (proj?.code||'') + '_' + Date.now() + '.txt'
    a.click()
  }

  return (
    <div style={{display:'flex',height:'100vh',overflow:'hidden',fontFamily:'Times New Roman,serif'}}>

      {/* Sidebar */}
      <div style={{width:200,background:'#fff',borderRight:'0.5px solid #e5e4e0',display:'flex',flexDirection:'column',flexShrink:0}}>
        <div style={{padding:'20px 16px 12px'}}>
          <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
            <span style={{fontSize:22}}>📁</span>
            <div>
              <div style={{fontSize:13,fontWeight:700}}>VATM-PMU</div>
              <div style={{fontSize:10,color:'#888'}}>QUAN LY CAC DU AN</div>
            </div>
          </div>
        </div>
        <div style={{padding:'0 8px',flex:1,overflowY:'auto'}}>
          <div style={{fontSize:10,color:'#9b9b9b',padding:'4px 8px',marginBottom:4}}>DU AN</div>
          {projects.map(p => (
            <button key={p.id} onClick={() => { setSelProj(p.id); setTab('docs') }}
              style={{width:'100%',textAlign:'left',padding:'8px 10px',borderRadius:8,border:'none',cursor:'pointer',background:proj?.id===p.id?'#f0f0ec':'transparent',color:'#1a1a1a',fontSize:13,fontWeight:proj?.id===p.id?600:400,display:'flex',alignItems:'center',gap:6,marginBottom:2}}>
              <span style={{fontSize:14}}>📋</span>
              <span style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{p.name}</span>
            </button>
          ))}
          <button onClick={() => setShowAddProj(true)}
            style={{width:'100%',textAlign:'left',padding:'8px 10px',borderRadius:8,border:'none',cursor:'pointer',background:'transparent',color:'#888',fontSize:12,marginTop:4}}>
            + Them du an
          </button>
        </div>
        <div style={{padding:'12px 16px',borderTop:'0.5px solid #e5e4e0'}}>
          <div style={{fontSize:12,fontWeight:500}}>{user?.displayName||'Nguoi dung'}</div>
          <div style={{fontSize:11,color:'#888',marginBottom:8,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{user?.email}</div>
          <button onClick={logout} style={{fontSize:11,color:'#888',background:'none',border:'0.5px solid #ddd',borderRadius:6,cursor:'pointer',padding:'4px 10px'}}>Dang xuat</button>
        </div>
      </div>

      {/* Main content */}
      <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',minWidth:0}}>

        {/* Top bar */}
        <div style={{padding:'16px 24px 12px',borderBottom:'0.5px solid #e5e4e0',background:'#fff',display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
          <div>
            <div style={{fontSize:17,fontWeight:700}}>{proj?.name||'Chon du an'}</div>
            <div style={{fontSize:12,color:'#888'}}>Dang lap · {proj?.period}</div>
          </div>
          <div style={{display:'flex',gap:8}}>
            <button onClick={() => { setEditDoc(null); setModal('add') }}
              style={{padding:'8px 16px',background:'#fff',border:'0.5px solid #ddd',borderRadius:8,cursor:'pointer',fontSize:13}}>
              + Them van ban
            </button>
            <button onClick={exportReport}
              style={{padding:'8px 16px',background:'#1a1a1a',color:'#fff',border:'none',borderRadius:8,cursor:'pointer',fontSize:13}}>
              Xuat bao cao
            </button>
          </div>
        </div>

        {/* Stats */}
        <div style={{padding:'12px 24px',background:'#fff',borderBottom:'0.5px solid #e5e4e0',display:'flex',gap:12}}>
          {[['Tong van ban', stats.total, '#1a1a1a'], ['Hoan thanh', stats.done + ' (' + progress + '%)', '#15803d'], ['Dang cho', stats.pending, '#b45309'], ['Can lam gap', stats.urgent, '#b91c1c']].map(([l,v,c]) => (
            <div key={l} style={{flex:1,padding:'10px 14px',background:'#fafaf8',borderRadius:10,border:'0.5px solid #e5e4e0'}}>
              <div style={{fontSize:11,color:'#888',marginBottom:2}}>{l}</div>
              <div style={{fontSize:18,fontWeight:700,color:c}}>{v}</div>
            </div>
          ))}
          <div style={{flex:2,padding:'10px 14px',background:'#fafaf8',borderRadius:10,border:'0.5px solid #e5e4e0'}}>
            <div style={{display:'flex',justifyContent:'space-between',fontSize:11,color:'#888',marginBottom:6}}>
              <span>Tien do tong the</span>
              <span style={{fontWeight:600,color:'#1a1a1a'}}>{progress}%</span>
            </div>
            <div style={{height:8,background:'#e5e4e0',borderRadius:4,overflow:'hidden'}}>
              <div style={{height:'100%',width:progress+'%',background:'#22c55e',borderRadius:4,transition:'width .3s'}}/>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div style={{padding:'0 24px',background:'#fff',borderBottom:'0.5px solid #e5e4e0',display:'flex'}}>
          {[['docs','Van ban'],['progress','Tien do phap ly'],['report','Xuat bao cao']].map(([v,l]) => (
            <button key={v} onClick={() => setTab(v)}
              style={{padding:'12px 16px',border:'none',borderBottom:tab===v?'2px solid #1a1a1a':'2px solid transparent',background:'transparent',cursor:'pointer',fontSize:13,fontWeight:tab===v?600:400,color:tab===v?'#1a1a1a':'#888'}}>
              {l}
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={{flex:1,overflowY:'auto',padding:'16px 24px'}}>

          {tab === 'docs' && (
            <div>
              <div style={{display:'flex',gap:10,marginBottom:16}}>
                <div style={{flex:1,position:'relative'}}>
                  <span style={{position:'absolute',left:12,top:'50%',transform:'translateY(-50%)',color:'#aaa'}}>🔍</span>
                  <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Tim van ban..."
                    style={{width:'100%',padding:'9px 12px 9px 36px',border:'0.5px solid #ddd',borderRadius:8,fontSize:13,outline:'none',boxSizing:'border-box'}}/>
                </div>
                <select value={filter} onChange={e => setFilter(e.target.value)}
                  style={{padding:'9px 12px',border:'0.5px solid #ddd',borderRadius:8,fontSize:13,outline:'none',background:'#fff'}}>
                  <option value="all">Tat ca trang thai</option>
                  <option value="done">Da xong</option>
                  <option value="pending">Dang cho</option>
                  <option value="urgent">Can gap</option>
                  <option value="prep">Chuan bi</option>
                </select>
              </div>
              <table style={{width:'100%',borderCollapse:'collapse'}}>
                <thead>
                  <tr style={{borderBottom:'0.5px solid #e5e4e0'}}>
                    {['So KH','Ngay','Loai','Noi dung / Ve viec','Trang thai',''].map(h => (
                      <th key={h} style={{textAlign:'left',padding:'8px 12px',fontSize:11,color:'#888',fontWeight:500}}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 && (
                    <tr><td colSpan={6} style={{padding:'40px',textAlign:'center',color:'#888',fontSize:13}}>Chua co van ban nao</td></tr>
                  )}
                  {filtered.map(d => {
                    const s = SM[d.status] || SM.prep
                    return (
                      <tr key={d.id} onClick={() => setDetailDoc(d)}
                        style={{borderBottom:'0.5px solid #f0f0ec',cursor:'pointer'}}
                        onMouseEnter={e => e.currentTarget.style.background='#fafaf8'}
                        onMouseLeave={e => e.currentTarget.style.background=''}>
                        <td style={{padding:'10px 12px',fontSize:13,fontWeight:600,whiteSpace:'nowrap'}}>{d.code||'(Chua co so)'}</td>
                        <td style={{padding:'10px 12px',fontSize:12,color:'#888',whiteSpace:'nowrap'}}>{d.date||'—'}</td>
                        <td style={{padding:'10px 12px'}}>
                          <span style={{fontSize:11,padding:'3px 8px',borderRadius:12,background:'#f0f0ec',color:'#555'}}>{d.docType||'Khac'}</span>
                        </td>
                        <td style={{padding:'10px 12px',fontSize:13,maxWidth:320}}>
                          <span style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',display:'block'}}>{d.subject||''}</span>
                          {(d.fileUrl||d.downloadUrl) && <span style={{fontSize:10,color:'#22c55e'}}>✦ co file</span>}
                        </td>
                        <td style={{padding:'10px 12px'}}>
                          <span style={{fontSize:11,padding:'4px 10px',borderRadius:20,background:s.bg,color:s.color,display:'inline-flex',alignItems:'center',gap:5,whiteSpace:'nowrap'}}>
                            <span style={{width:6,height:6,borderRadius:'50%',background:s.dot,display:'inline-block'}}/>
                            {s.label}
                          </span>
                        </td>
                        <td style={{padding:'10px 8px',whiteSpace:'nowrap'}} onClick={e => e.stopPropagation()}>
                          <button onClick={() => { setEditDoc(d); setModal('edit') }}
                            style={{background:'none',border:'none',cursor:'pointer',fontSize:15,padding:'2px 6px',color:'#888'}}>✏️</button>
                          <button onClick={() => { if(confirm('Xoa van ban nay?')) deleteDocument(d.id) }}
                            style={{background:'none',border:'none',cursor:'pointer',fontSize:15,padding:'2px 6px',color:'#e53e3e'}}>🗑️</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'progress' && (
            <div style={{maxWidth:700}}>
              <h3 style={{fontSize:15,fontWeight:600,marginBottom:16}}>Tien do phap ly — {proj?.name}</h3>
              {[
                ['Giai doan 1','Chu truong & so lieu dau vao',['Phe duyet chu truong dau tu','Khao sat dia hinh','Lap bao cao danh gia hien trang']],
                ['Giai doan 2','Lap & phe duyet QH 1/500',['Lap quy hoach 1/500','Tham dinh quy hoach','Phe duyet quy hoach']],
                ['Giai doan 3','Lap du an dau tu',['Lap bao cao kinh te ky thuat','Tham dinh du an','Phe duyet du an']],
              ].map(([phase, desc, items]) => (
                <div key={phase} style={{marginBottom:16,padding:'16px',background:'#fff',border:'0.5px solid #e5e4e0',borderRadius:12}}>
                  <div style={{fontWeight:600,marginBottom:4}}>{phase}</div>
                  <div style={{fontSize:12,color:'#888',marginBottom:12}}>{desc}</div>
                  {items.map(item => {
                    const related = docs.find(d => (d.subject||'').toLowerCase().includes(item.split(' ').slice(0,3).join(' ').toLowerCase()))
                    return (
                      <div key={item} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 0',borderBottom:'0.5px solid #f0f0ec'}}>
                        <span style={{fontSize:16}}>{related ? '✅' : '⬜'}</span>
                        <span style={{fontSize:13,flex:1}}>{item}</span>
                        {related && <span style={{fontSize:11,color:'#15803d'}}>{related.code}</span>}
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          )}

          {tab === 'report' && (
            <div style={{maxWidth:600}}>
              <h3 style={{fontSize:15,fontWeight:600,marginBottom:16}}>Xuat bao cao</h3>
              <div style={{padding:'20px',background:'#fff',border:'0.5px solid #e5e4e0',borderRadius:12}}>
                <p style={{fontSize:13,color:'#555',marginBottom:16}}>
                  Xuat bao cao tong hop toan bo van ban cua du an <strong>{proj?.name}</strong> ({stats.total} van ban, tien do {progress}%).
                </p>
                <button onClick={exportReport}
                  style={{padding:'10px 20px',background:'#1a1a1a',color:'#fff',border:'none',borderRadius:8,cursor:'pointer',fontSize:13,fontWeight:500}}>
                  Tai bao cao (.txt)
                </button>
              </div>
            </div>
          )}
        </div>

        {/* AI Chat */}
        <div style={{borderTop:'0.5px solid #e5e4e0',background:'#fff',padding:'10px 24px'}}>
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:8,flexWrap:'wrap'}}>
            <span style={{fontSize:12,color:'#888'}}>Tro ly AI</span>
            <span style={{fontSize:11,padding:'2px 8px',background:'#f0fdf4',color:'#15803d',borderRadius:20,border:'0.5px solid #bbf7d0'}}>Groq Llama - Mien phi</span>
            <button onClick={() => setShowKeyModal(true)}
              style={{fontSize:11,padding:'3px 10px',background:getKey()?'#f0fdf4':'#fef2f2',border:getKey()?'0.5px solid #bbf7d0':'0.5px solid #fecaca',borderRadius:6,cursor:'pointer',color:getKey()?'#15803d':'#b91c1c',fontWeight:600}}>
              {getKey() ? 'Da co key AI' : 'Chua co key AI - Nhan de cai'}
            </button>
            {chat.length > 0 && (
              <button onClick={() => setChat([])}
                style={{fontSize:11,color:'#888',background:'none',border:'0.5px solid #ddd',borderRadius:6,cursor:'pointer',padding:'2px 8px',marginLeft:'auto'}}>
                Xoa chat
              </button>
            )}
          </div>

          <div style={{display:'flex',gap:6,marginBottom:8,flexWrap:'wrap'}}>
            {[
              ['Tom tat phap ly','Tom tat tinh trang phap ly hien tai cua du an'],
              ['Viec can gap','Liet ke cac van ban can xu ly gap'],
              ['Tao bao cao','Tao bao cao tinh trang du an'],
              ['Rui ro','Phan tich rui ro phap ly du an'],
            ].map(([l, q]) => (
              <button key={l} onClick={() => handleAsk(q)}
                style={{fontSize:11,padding:'5px 10px',background:'#f5f5f3',border:'0.5px solid #e5e4e0',borderRadius:20,cursor:'pointer',color:'#555'}}>
                {l}
              </button>
            ))}
          </div>

          {chat.length > 0 && (
            <div style={{maxHeight:160,overflowY:'auto',marginBottom:8,display:'flex',flexDirection:'column',gap:6}}>
              {chat.map((m, i) => (
                <div key={i} style={{display:'flex',justifyContent:m.role==='user'?'flex-end':'flex-start'}}>
                  <div style={{maxWidth:'80%',padding:'8px 12px',borderRadius:10,fontSize:12,lineHeight:1.5,background:m.role==='user'?'#1a1a1a':'#f5f5f3',color:m.role==='user'?'#fff':'#1a1a1a'}}>
                    {m.content}
                  </div>
                </div>
              ))}
              {aiLoading && (
                <div style={{display:'flex'}}>
                  <div style={{padding:'8px 12px',borderRadius:10,fontSize:12,background:'#f5f5f3',color:'#888'}}>Dang tra loi...</div>
                </div>
              )}
            </div>
          )}

          <div style={{display:'flex',gap:8}}>
            <input value={chatInput} onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => e.key==='Enter' && !e.shiftKey && handleAsk(chatInput)}
              placeholder="Hoi ve du an... (Enter de gui)"
              style={{flex:1,padding:'9px 14px',border:'0.5px solid #ddd',borderRadius:8,fontSize:13,outline:'none'}}/>
            <button onClick={() => handleAsk(chatInput)} disabled={aiLoading || !chatInput.trim()}
              style={{padding:'9px 16px',background:'#1a1a1a',color:'#fff',border:'none',borderRadius:8,cursor:'pointer',fontSize:13}}>
              ▶
            </button>
          </div>
        </div>
      </div>

      {/* Modals */}
      {(modal==='add'||modal==='edit') && (
        <DocModal doc={editDoc} onSave={handleSave} onClose={() => { setModal(null); setEditDoc(null) }}/>
      )}
      {detailDoc && (
        <DocDetail doc={detailDoc}
          onEdit={() => { setEditDoc(detailDoc); setDetailDoc(null); setModal('edit') }}
          onClose={() => setDetailDoc(null)}/>
      )}
      {showAddProj && (
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.4)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:100}}>
          <div style={{background:'#fff',borderRadius:14,padding:'24px 28px',width:400,boxShadow:'0 8px 32px rgba(0,0,0,.15)'}}>
            <h3 style={{fontSize:15,fontWeight:600,marginBottom:16}}>Them du an moi</h3>
            <input value={newProjName} onChange={e => setNewProjName(e.target.value)}
              placeholder="Ten du an" autoFocus
              style={{width:'100%',padding:'9px 12px',border:'0.5px solid #ddd',borderRadius:8,fontSize:13,outline:'none',marginBottom:12,boxSizing:'border-box'}}/>
            <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
              <button onClick={() => setShowAddProj(false)}
                style={{padding:'8px 16px',border:'0.5px solid #ddd',borderRadius:8,cursor:'pointer',background:'#fff',fontSize:13}}>Huy</button>
              <button onClick={async () => {
                if (newProjName.trim()) {
                  await addProject({ name:newProjName.trim(), code:'', budget:'Dang lap', period:'2026-2030', address:'' })
                  setNewProjName('')
                  setShowAddProj(false)
                }
              }} style={{padding:'8px 16px',background:'#1a1a1a',color:'#fff',border:'none',borderRadius:8,cursor:'pointer',fontSize:13}}>Them</button>
            </div>
          </div>
        </div>
      )}
      {showKeyModal && (
        <KeyModal onClose={() => setShowKeyModal(false)} getKey={getKey} saveKey={saveKey}/>
      )}
    </div>
  )
}

function Login({ onLogin }) {
  return (
    <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'100vh',background:'#f5f5f3'}}>
      <div style={{background:'#fff',borderRadius:20,padding:'48px 40px',textAlign:'center',boxShadow:'0 8px 32px rgba(0,0,0,.1)',maxWidth:380,width:'90%'}}>
        <div style={{fontSize:48,marginBottom:12}}>✈️</div>
        <h1 style={{fontSize:20,fontWeight:700,marginBottom:4}}>VATM-PMU</h1>
        <p style={{fontSize:13,color:'#888',marginBottom:32}}>Phan mem quan ly du an thong minh AI</p>
        <button onClick={onLogin}
          style={{width:'100%',padding:'12px 20px',background:'#1a1a1a',color:'#fff',border:'none',borderRadius:10,cursor:'pointer',fontSize:14,fontWeight:600}}>
          Dang nhap bang Google
        </button>
        <p style={{fontSize:11,color:'#aaa',marginTop:16}}>Du lieu duoc dong bo tren moi thiet bi</p>
      </div>
    </div>
  )
}
