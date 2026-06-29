// src/hooks/useMonthlyReport.js
// Tạo báo cáo (Word) theo đúng MẪU CHUẨN VATM (file "Báo cáo phục vụ đầu tư -
// gửi ban KHĐT") — AI đọc toàn văn các văn bản trong dự án, tự điền vào cấu
// trúc mẫu, xuất file .docx tải về trực tiếp từ trình duyệt (không qua server).
import { useState } from 'react'
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, BorderStyle, WidthType, Header, PageNumber,
} from 'docx'

// Trích đúng khối JSON {...} từ phản hồi AI.
// Cách cũ chỉ strip dấu ```json — nếu AI lỡ thêm 1 câu dẫn/giải thích trước hoặc
// sau JSON (hay gặp hơn khi rơi xuống Groq/OpenRouter fallback, tuân lệnh "chỉ
// trả JSON" kém nghiêm hơn Gemini) thì JSON.parse() fail ngay dù JSON bên trong
// vẫn hợp lệ. Lấy đúng từ dấu "{" đầu tới "}" cuối thì vẫn parse được.
const extractJson = (raw) => {
  if (!raw) return null
  const noFence = raw.replace(/```json|```/g, '').trim()
  const start = noFence.indexOf('{')
  const end = noFence.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try { return JSON.parse(noFence.slice(start, end + 1)) } catch { return null }
}

const buildReportPrompt = (projectName, fullCtx, packageNames = [], todayStr) => `Bạn là trợ lý lập báo cáo dự án. Dựa trên TOÀN VĂN các văn bản dưới đây, hãy điền vào đúng cấu trúc báo cáo theo mẫu chuẩn của Tổng công ty Quản lý bay Việt Nam (theo Công văn 7023/QLB-KHĐT ngày 8/10/2025).

Hôm nay là ngày ${todayStr}. Dùng ngày này để đánh giá tiến độ (đúng hạn / sắp quá hạn / đã quá hạn / đã hoàn thành) khi văn bản có nêu ngày ký hợp đồng + thời gian thực hiện hợp đồng.

CHỈ trả về JSON hợp lệ, KHÔNG kèm dấu \`\`\`, KHÔNG viết bất kỳ câu dẫn hay giải thích nào trước hoặc sau JSON. Đúng cấu trúc:

{
  "tenDuAn": "tên đầy đủ dự án",
  "tongMucDauTu": "số tiền + VNĐ, lấy từ Quyết định phê duyệt dự án — nếu văn bản không có ghi 'Chưa có thông tin'",
  "nguoiQuyetDinhDauTu": "...",
  "chuDauTu": "...",
  "hinhThucToChucQuanLy": "...",
  "nguonVon": "...",
  "thoiGianThucHien": "...",
  "mucTieuDauTu": ["điểm 1", "điểm 2"] hoặc null nếu văn bản không nêu mục tiêu rõ ràng,
  "goiThau": [
    { "ten": "tên gói thầu — PHẢI chép ĐÚNG NGUYÊN VĂN 1 tên trong DANH SÁCH GÓI THẦU dưới đây", "moc": ["mốc 1 (1 câu đầy đủ)", "mốc 2"], "danhGia": "1 câu đánh giá tiến độ CỦA RIÊNG gói thầu này" }
  ],
  "ketLuanTongThe": "1-2 câu đánh giá tiến độ TỔNG THỂ của CẢ dự án, tổng hợp từ tình hình tất cả gói thầu ở trên (vd: mấy gói đã/đang/chưa triển khai, có gói nào trễ hạn không)",
  "khoKhanVuongMac": "nêu khó khăn/vướng mắc/kiến nghị nếu văn bản có nhắc tới, không có thì để chuỗi rỗng"
}

DANH SÁCH GÓI THẦU CỦA DỰ ÁN (lấy đúng theo cây gói thầu thật bên thanh công cụ, KỂ CẢ gói thầu chưa có văn bản nào — BẮT BUỘC mảng "goiThau" có ĐÚNG ${packageNames.length} phần tử, mỗi phần tử ứng với ĐÚNG 1 gói thầu dưới đây, KHÔNG THIẾU KHÔNG THỪA, không tự thêm gói thầu nào ngoài danh sách này):
${packageNames.length ? packageNames.map((n, i) => `${i + 1}. ${n}`).join('\n') : '(dự án này chưa có gói thầu nào — để mảng "goiThau" rỗng [])'}

QUY TẮC CHO "goiThau":
- Nếu trong NỘI DUNG VĂN BẢN ghi rõ 1 gói thầu "CHƯA CÓ VĂN BẢN NÀO" → "moc": [], "danhGia": "Gói thầu chưa triển khai, chưa có văn bản/hoạt động nào được ghi nhận trong hệ thống."
- MỖI mốc/sự kiện riêng biệt (1 quyết định, 1 hợp đồng, 1 cột mốc tiến độ...) là 1 PHẦN TỬ RIÊNG trong "moc" — KHÔNG gộp nhiều mốc vào 1 câu dài, KHÔNG viết thành 1 đoạn văn liền mạch.
- BẮT BUỘC sắp xếp "moc" ĐÚNG THEO THỨ TỰ THỜI GIAN xảy ra trong thực tế (mốc nào diễn ra trước → đứng trước), không theo thứ tự xuất hiện trong văn bản nguồn nếu khác thứ tự thời gian thật.
- TUYỆT ĐỐI không lặp lại 1 sự kiện/thông tin đã nêu ở phần tử khác trong cùng "moc".
- Khi nhắc tới việc ký HỢP ĐỒNG hoặc quyết định có yếu tố tài chính, PHẢI nêu kèm ĐẦY ĐỦ trong cùng 1 câu (nếu văn bản có ghi): giá trị hợp đồng/quyết định + thời gian thực hiện hợp đồng — không chỉ nêu số hiệu/ngày ký mà bỏ sót giá trị và thời hạn.
- "danhGia": dựa vào ngày ký hợp đồng + thời gian thực hiện hợp đồng nêu trong văn bản, SO VỚI hôm nay (${todayStr}) để nhận định gói thầu đang đúng hạn/sắp quá hạn/đã quá hạn/đã hoàn thành — PHẢI tính toán cẩn thận (ngày ký + số ngày thực hiện = hạn hoàn thành), KHÔNG đoán bừa nếu văn bản không có đủ thông tin ngày.

QUY TẮC BẮT BUỘC — chống bịa/nhầm số liệu (đã từng xảy ra thực tế, là lỗi nghiêm trọng):
- Số tiền, ngày/tháng/năm, số hiệu văn bản/hợp đồng: PHẢI chép ĐÚNG NGUYÊN VĂN từng chữ số/chữ cái nhìn thấy trong NỘI DUNG VĂN BẢN dưới đây. KHÔNG tự diễn giải lại, KHÔNG làm tròn, KHÔNG đoán nếu không thấy rõ — sai 1 chữ số ngày/tháng hoặc 1 số trong mã hợp đồng là lỗi nghiêm trọng.
- Nếu 1 trường KHÔNG xuất hiện rõ ràng trong NỘI DUNG VĂN BẢN → để "Chưa có thông tin" (trường dạng chữ) hoặc null (mucTieuDauTu). TUYỆT ĐỐI không suy đoán hoặc lấy từ kiến thức chung/tên dự án để bịa ra.
- Nếu văn bản có NHIỀU số tiền khác nhau (vd: dự toán 1 gói thầu tư vấn riêng lẻ VS tổng mức đầu tư cả dự án) → "tongMucDauTu" CHỈ lấy đúng số được ghi rõ là "tổng mức đầu tư dự án" hoặc tại Quyết định PHÊ DUYỆT DỰ ÁN, không lấy nhầm dự toán của 1 gói thầu con.
- "hinhThucToChucQuanLy" (hình thức TỔ CHỨC QUẢN LÝ dự án, vd "Chủ đầu tư trực tiếp quản lý dự án", "Thuê tư vấn quản lý dự án") KHÁC HẲN với hình thức LỰA CHỌN NHÀ THẦU (đấu thầu rộng rãi/chỉ định thầu của 1 gói thầu cụ thể) — KHÔNG lấy nhầm 2 khái niệm này.

Dự án: ${projectName}

NỘI DUNG VĂN BẢN (đã chia theo từng gói thầu):
${fullCtx}`

export function useMonthlyReport() {
  const [generating, setGenerating] = useState(false)

  // askRaw: hàm gọi AI sạch (không qua system prompt mặc định) — truyền vào từ
  // useAI() ở component cha, để dùng chung 1 nguồn key/quota với phần còn lại.
  //
  // packageNames: tên ĐẦY ĐỦ tất cả gói thầu thật của dự án (lấy từ cây gói
  // thầu bên sidebar — App.jsx truyền vào), KỂ CẢ gói thầu chưa có văn bản nào.
  // Dùng để bắt AI tạo đủ từng gói thầu trong Mục II, không bỏ sót gói thầu
  // chưa triển khai (lỗi thực tế đã gặp: AI chỉ biết những gì đã được phân
  // tích, "quên" hẳn các gói thầu chưa có văn bản).
  //
  // investmentInfo: object "Thông tin chung dự án" (Mục I) Tony tự nhập/sửa tay
  // qua modal "ℹ️ Thông tin dự án" trong App.jsx, lưu ở Firestore (projects/{id}.
  // investmentInfo). 8 trường này hầu như KHÔNG đổi suốt đời dự án — nếu đã có,
  // ĐÈ LÊN kết quả AI cho từng trường tương ứng (đáng tin hơn AI tự dò lại từ
  // documentMemory mỗi lần, tránh lặp lại lỗi thực tế đã gặp: thiếu tổng mức đầu
  // tư/nguồn vốn vì văn bản gốc chưa từng được upload, hoặc AI đọc lẫn số tiền
  // của 1 gói thầu con với tổng mức đầu tư cả dự án). Nếu investmentInfo chưa có
  // (project chưa nhập) → giữ nguyên hành vi cũ, để AI tự điền như trước.
  const generateReport = async ({ projectName, fullCtx, askRaw, investmentInfo = null, packageNames = [] }) => {
    setGenerating(true)
    try {
      const todayStr = new Date().toLocaleDateString('vi-VN')
      const prompt = buildReportPrompt(projectName, fullCtx, packageNames, todayStr)

      // maxTokens=8000 (trước đây 3000 hay bị cắt cụt giữa chuỗi JSON với báo
      // cáo nhiều trường tường thuật dài) + thử tối đa 2 lần (đề phòng 1 lượt
      // rơi xuống provider fallback trả JSON lệch format).
      let data = null
      let lastRaw = ''
      for (let attempt = 0; attempt < 2 && !data; attempt++) {
        lastRaw = await askRaw(prompt, 8000)
        data = extractJson(lastRaw)
      }

      if (!data) {
        console.error(
          '[useMonthlyReport] AI không trả JSON hợp lệ sau 2 lần thử. Độ dài phản hồi cuối:',
          lastRaw?.length || 0,
          '\n200 ký tự cuối phản hồi:', lastRaw?.slice(-200)
        )
        throw new Error('AI trả về không đúng định dạng JSON sau 2 lần thử. Thử lại sau, hoặc thu hẹp phạm vi (chọn 1 gói thầu cụ thể thay vì cả dự án) nếu dự án có nhiều văn bản dài.')
      }

      // Đè dữ liệu nhập tay lên kết quả AI — chỉ đè trường nào Tony đã điền,
      // trường nào để trống vẫn để AI tự điền (không làm mất tính năng cũ).
      if (investmentInfo) {
        const OVERRIDE_FIELDS = ['tongMucDauTu', 'nguoiQuyetDinhDauTu', 'chuDauTu', 'hinhThucToChucQuanLy', 'nguonVon', 'thoiGianThucHien']
        OVERRIDE_FIELDS.forEach(f => {
          if (investmentInfo[f] && investmentInfo[f].trim()) data[f] = investmentInfo[f].trim()
        })
        if (investmentInfo.mucTieuDauTu?.length) data.mucTieuDauTu = investmentInfo.mucTieuDauTu.filter(Boolean)
      }

      await buildAndDownloadDocx(data, projectName)
    } finally {
      setGenerating(false)
    }
  }

  return { generateReport, generating }
}

// ── Layout dưới đây đã đối chiếu trực tiếp với file MẪU CHUẨN Tony cung cấp
// ("Báo cáo phục vụ đầu tư - gửi ban KHĐT.doc"):
//   - Khổ A4 chuẩn (11906x16838 DXA), margin top/right/bottom=1134 (2cm),
//     left=1701 (3cm)
//   - Font Times New Roman; quốc hiệu/tiêu ngữ (header) cỡ 12pt (24); thân và
//     tiêu đề cỡ 14pt (28)
//   - Tiêu đề là "BÁO CÁO" + "V/v: ..." (KHÔNG phải "BÁO CÁO THÁNG MM NĂM YYYY"
//     như bản trước)
//   - "1. Tình hình chuẩn bị đầu tư:" in đậm + nghiêng, nội dung "triển khai"
//     nối liền ngay dưới, KHÔNG tách riêng mục "2."
//   - "III. Khó khăn, vướng mắc, kiến nghị:" in đậm, KHÔNG nghiêng (đối chiếu
//     lại bản mẫu thật — bản trước lỡ để nghiêng luôn)
//   - Có số trang (giữa, từ trang 2) — trang 1 không hiện số trang
// Đã build thử bằng chính thư viện docx + LibreOffice render ảnh so khớp từng
// dòng với mẫu trước khi giao.
async function buildAndDownloadDocx(data, projectName) {
  const now = new Date()
  const thang = now.getMonth() + 1 // lấy đúng tháng/năm tại THỜI ĐIỂM bấm nút
  const nam = now.getFullYear()

  const noBorder = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }
  const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder, insideHorizontal: noBorder, insideVertical: noBorder }
  const FS = 28  // 14pt — thân báo cáo, tiêu đề
  const HFS = 24 // 12pt — quốc hiệu/tiêu ngữ (đúng mẫu chuẩn)

  // Gạch ngắn trang trí dưới dòng 2 mỗi cột header — xấp xỉ lại đường line gốc
  // (vốn là 1 shape vẽ tay trong mẫu, không phải border) bằng 1 đoạn rỗng có
  // border dưới, thu hẹp 2 bên qua indent để không kéo dài hết cột.
  const shortUnderline = (colWidth) => new Paragraph({
    indent: { left: Math.round(colWidth * 0.27), right: Math.round(colWidth * 0.27) },
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: '000000', space: 1 } },
    children: [new TextRun(' ')],
  })

  const twoColHeader = () => new Table({
    // Bảng header rộng HƠN vùng nội dung bình thường (10800 > 9071 trong margin)
    // + indent ÂM -1152 — ĐÚNG như mẫu gốc (tràn nhẹ ra 2 bên lề). Đây là lý do
    // 2 dòng dài ("TỔNG CÔNG TY..."/"CỘNG HOÀ...") nằm đúng 1 dòng trong mẫu —
    // bản trước dùng bề rộng = đúng margin (9072) nên bị xuống dòng.
    width: { size: 10800, type: WidthType.DXA },
    columnWidths: [5400, 5400],
    indent: { size: -1152, type: WidthType.DXA },
    borders: noBorders,
    rows: [new TableRow({ children: [
      new TableCell({
        width: { size: 5400, type: WidthType.DXA },
        margins: { top: 0, bottom: 0, left: 0, right: 60 },
        children: [
          new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'TỔNG CÔNG TY QUẢN LÝ BAY VIỆT NAM', size: HFS })] }),
          new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'BQL DỰ ÁN CHUYÊN NGÀNH QUẢN LÝ BAY', bold: true, size: HFS })] }),
          shortUnderline(5400),
          new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 60 }, children: [new TextRun({ text: 'Số:        /BC-QLDA', size: HFS })] }),
        ],
      }),
      new TableCell({
        width: { size: 5400, type: WidthType.DXA },
        margins: { top: 0, bottom: 0, left: 60, right: 0 },
        children: [
          new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'CỘNG HOÀ XÃ HỘI CHỦ NGHĨA VIỆT NAM', bold: true, size: HFS })] }),
          new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Độc lập - Tự do - Hạnh phúc', bold: true, size: HFS })] }),
          shortUnderline(5400),
          new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 60 }, children: [new TextRun({ text: `Hà Nội, ngày ${now.getDate()} tháng ${thang} năm ${nam}`, italics: true, size: HFS })] }),
        ],
      }),
    ] })],
  })

  // Đoạn thân chuẩn: thụt đầu dòng 567 DXA (~1cm) + 2 lề đều (justify).
  const bodyPara = (text, opts = {}) => new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    indent: { firstLine: 567 },
    spacing: { before: 120, after: 120 },
    children: [new TextRun({ text, size: FS, ...opts })],
  })

  // Mục 1-8 "Thông tin chung dự án": label hoa đậm + indent hanging (851/284).
  const infoLine = (num, label, value) => new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    indent: { left: 851, hanging: 284 },
    spacing: { before: 120, after: 120 },
    children: [
      new TextRun({ text: `${num}. ${label}: `, bold: true, size: FS }),
      new TextRun({ text: value || 'Chưa có thông tin', size: FS }),
    ],
  })

  const children = [
    twoColHeader(),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 120 }, children: [new TextRun({ text: ' ', bold: true, size: FS })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 120 }, children: [new TextRun({ text: 'BÁO CÁO', bold: true, size: FS })] }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [
        new TextRun({ text: 'V/v: ', bold: true, size: FS }),
        new TextRun({ text: 'Tình hình thực hiện dự án ', size: FS }),
        new TextRun({ text: `\u201C${data.tenDuAn || projectName}\u201D`, bold: true, size: FS }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [new TextRun({ text: 'Kính gửi: Ban Kế hoạch – Đầu tư', size: FS })],
    }),
    bodyPara('Căn cứ Công văn số 7023/QLB-KHĐT ngày 8/10/2025 của Tổng công ty về việc áp dụng mẫu báo cáo đánh giá tình hình triển khai các dự án/gói thầu phục vụ hội nghị giao ban về công tác kế hoạch, đầu tư;'),
    bodyPara(`Ban Quản lý dự án chuyên ngành Quản lý bay (QLDA) báo cáo tình hình thực hiện dự án \u201C${data.tenDuAn || projectName}\u201D đến nay như sau:`),
    new Paragraph({ spacing: { before: 120, after: 120 }, children: [new TextRun({ text: 'I. Thông tin chung dự án', bold: true, size: FS })] }),
    infoLine(1, 'Tên dự án', data.tenDuAn),
    infoLine(2, 'Tổng mức đầu tư', data.tongMucDauTu),
    infoLine(3, 'Người quyết định đầu tư', data.nguoiQuyetDinhDauTu),
    infoLine(4, 'Chủ đầu tư', data.chuDauTu),
    infoLine(5, 'Hình thức tổ chức quản lý dự án được áp dụng', data.hinhThucToChucQuanLy),
    infoLine(6, 'Nguồn vốn', data.nguonVon),
    infoLine(7, 'Thời gian thực hiện dự án', data.thoiGianThucHien),
  ]

  if (data.mucTieuDauTu?.length) {
    children.push(new Paragraph({
      indent: { left: 851, hanging: 284 },
      spacing: { before: 120, after: 120 },
      children: [new TextRun({ text: '8. Mục tiêu đầu tư:', bold: true, size: FS })],
    }))
    data.mucTieuDauTu.forEach(m => children.push(bodyPara(`- ${m}`)))
  }

  // "II. Tình hình thực hiện" → tách riêng theo TỪNG GÓI THẦU THẬT của dự án
  // (đúng cây gói thầu bên sidebar — kể cả gói thầu CHƯA có văn bản nào, để
  // không "quên" các gói thầu chưa triển khai như đã gặp thực tế). Mỗi gói
  // thầu: mốc thời gian (gạch đầu dòng, đúng thứ tự, không lặp) + 1 câu đánh
  // giá tiến độ RIÊNG của gói đó. Cuối mục: 1 Kết luận tiến độ TỔNG THỂ cả dự án.
  children.push(new Paragraph({ spacing: { before: 120, after: 120 }, children: [new TextRun({ text: 'II. Tình hình thực hiện', bold: true, size: FS })] }))

  const goiThauList = Array.isArray(data.goiThau) ? data.goiThau : []
  if (goiThauList.length) {
    goiThauList.forEach((g, idx) => {
      children.push(bodyPara(`${idx + 1}. Gói thầu ${g.ten || '—'}`, { bold: true, italics: true }))
      const mocs = Array.isArray(g.moc) ? g.moc.filter(Boolean) : []
      if (mocs.length) {
        mocs.forEach(m => children.push(bodyPara(`- ${m}`)))
      } else {
        children.push(bodyPara('Chưa có thông tin.'))
      }
      if (g.danhGia) {
        children.push(new Paragraph({
          alignment: AlignmentType.JUSTIFIED,
          indent: { firstLine: 567 },
          spacing: { before: 60, after: 160 },
          children: [
            new TextRun({ text: 'Đánh giá tiến độ: ', bold: true, size: FS }),
            new TextRun({ text: g.danhGia, size: FS }),
          ],
        }))
      }
    })
  } else {
    children.push(bodyPara('Dự án chưa có gói thầu nào.'))
  }

  if (data.ketLuanTongThe) {
    children.push(new Paragraph({
      alignment: AlignmentType.JUSTIFIED,
      indent: { firstLine: 567 },
      spacing: { before: 120, after: 120 },
      children: [
        new TextRun({ text: 'Kết luận: ', bold: true, size: FS }),
        new TextRun({ text: data.ketLuanTongThe, size: FS }),
      ],
    }))
  }

  if (data.khoKhanVuongMac) {
    children.push(
      new Paragraph({ spacing: { before: 120, after: 60 }, children: [new TextRun({ text: 'III. Khó khăn, vướng mắc, kiến nghị:', bold: true, size: FS })] }),
      bodyPara(`- ${data.khoKhanVuongMac}`),
    )
  }

  children.push(new Paragraph({
    indent: { firstLine: 851 },
    spacing: { before: 200, after: 200 },
    children: [new TextRun({ text: 'Kính báo cáo!', italics: true, size: FS })],
  }))

  const sigTable = new Table({
    width: { size: 9039, type: WidthType.DXA },
    columnWidths: [4248, 4791],
    borders: noBorders,
    rows: [new TableRow({ children: [
      new TableCell({
        width: { size: 4248, type: WidthType.DXA },
        children: [
          new Paragraph({ children: [new TextRun({ text: 'Nơi nhận:', bold: true, italics: true, size: FS })] }),
          new Paragraph({ children: [new TextRun({ text: '- Như trên;', size: 22 })] }),
          new Paragraph({ children: [new TextRun({ text: '- Lưu: VT, Tổ dự án.', size: 22 })] }),
        ],
      }),
      new TableCell({
        width: { size: 4791, type: WidthType.DXA },
        children: [
          new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'GIÁM ĐỐC', bold: true, size: FS })] }),
        ],
      }),
    ] })],
  })
  children.push(sigTable)

  const doc = new Document({
    styles: { default: { document: { run: { font: 'Times New Roman', size: FS } } } },
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 }, // A4 chuẩn
          margin: { top: 1134, right: 1134, bottom: 1134, left: 1701 }, // 2cm/2cm/2cm/3cm — đúng mẫu chuẩn
        },
        titlePage: true, // trang 1 KHÔNG hiện số trang, đúng mẫu
      },
      headers: {
        default: new Header({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], size: 22 })] })] }),
        first: new Header({ children: [new Paragraph({ children: [new TextRun(' ')] })] }),
      },
      children,
    }],
  })

  const blob = await Packer.toBlob(doc)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  // Đổi đúng tên "Báo cáo đầu tư" — bản trước lỡ quên dòng này khi đổi nội dung
  // sang mẫu mới, nên file tải về vẫn mang tên cũ "Bao_cao_thang_..." dù nội
  // dung bên trong đã đúng mẫu "BÁO CÁO" + "V/v" từ lâu.
  const dd = String(now.getDate()).padStart(2, '0')
  const mm = String(thang).padStart(2, '0')
  a.download = `Bao_cao_dau_tu_${(projectName || data.tenDuAn || 'duan').replace(/[^a-zA-Z0-9À-ỹ]/g, '_')}_${dd}-${mm}-${nam}.docx`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
